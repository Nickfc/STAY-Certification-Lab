#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/../../.." && pwd -P)"
EXPECTED_LAB_REPOSITORY="Nickfc/STAY-Certification-Lab"
EXPECTED_POLICY_HASH="sha256:9ab15c27c69494c6ce3156255ed06d2f57887934928a85b13ff58d578add7820"
MAX_CPU_STEAL_PERCENT=5
CANDIDATE_SHA=""
LAB_REPOSITORY="${GITHUB_REPOSITORY:-}"
OUTPUT_ROOT="${STAY_C3C_COMPUTE_ROOT:-}"

usage() {
  echo "Usage: RUN.sh --candidate-sha <40-hex> --output-root <private-path> [--lab-repository Nickfc/STAY-Certification-Lab]" >&2
}

while (($#)); do
  case "$1" in
    --candidate-sha) CANDIDATE_SHA="${2:-}"; shift 2 ;;
    --output-root) OUTPUT_ROOT="${2:-}"; shift 2 ;;
    --lab-repository) LAB_REPOSITORY="${2:-}"; shift 2 ;;
    *) usage; exit 64 ;;
  esac
done

[[ "${CANDIDATE_SHA}" =~ ^[0-9a-f]{40}$ ]] || { usage; exit 64; }
[[ "${LAB_REPOSITORY}" == "${EXPECTED_LAB_REPOSITORY}" ]] || {
  echo "compute certification is restricted to ${EXPECTED_LAB_REPOSITORY}" >&2
  exit 64
}
[[ -n "${OUTPUT_ROOT}" && "${OUTPUT_ROOT}" = /* ]] || { usage; exit 64; }

OUTPUT_ROOT="$(realpath -m -- "${OUTPUT_ROOT}")"
case "${OUTPUT_ROOT}/" in
  "${REPO_DIR}/"*) echo "private evidence root must be outside the source checkout" >&2; exit 64 ;;
esac

RAW_ROOT="${OUTPUT_ROOT}/raw"
LOG_ROOT="${RAW_ROOT}/logs"
STATUS_FILE="${OUTPUT_ROOT}/PRIVATE_STATUS.json"
SANITIZED_RESULT="${OUTPUT_ROOT}/COMPUTE_RESULT.sanitized.json"
mkdir -p -- "${LOG_ROOT}"
chmod 700 "${OUTPUT_ROOT}" "${RAW_ROOT}" "${LOG_ROOT}"

write_status() {
  RESULT_VALUE="$1" STAGE_VALUE="$2" STATUS_PATH="${STATUS_FILE}" node <<'NODE'
const fs = require('node:fs');
fs.writeFileSync(process.env.STATUS_PATH, `${JSON.stringify({
  schema: 'stay.chronobiology.c3c-compute-private-status/v1',
  result: process.env.RESULT_VALUE,
  stage: process.env.STAGE_VALUE,
}, null, 2)}\n`, { mode: 0o600 });
NODE
}

tap_value() {
  local key="$1" file="$2"
  awk -v key="${key}" '($1 == "#" || $1 == "ℹ") && $2 == key { value=$3 } END { print value }' "${file}"
}

require_zero_tap() {
  local label="$1" file="$2"
  local tests pass fail skipped todo cancelled
  tests="$(tap_value tests "${file}")"
  pass="$(tap_value pass "${file}")"
  fail="$(tap_value fail "${file}")"
  skipped="$(tap_value skipped "${file}")"
  todo="$(tap_value todo "${file}")"
  cancelled="$(tap_value cancelled "${file}")"
  [[ -n "${tests}" && "${tests}" == "${pass}" \
    && "${fail:-0}" == 0 && "${skipped:-0}" == 0 \
    && "${todo:-0}" == 0 && "${cancelled:-0}" == 0 ]] || {
    echo "${label} is not zero-failure/zero-skip" >&2
    return 1
  }
}

capture_environment() {
  local destination="$1"
  {
    uname -a
    node --version
    uptime
    lscpu
    free -b
    cat /proc/pressure/cpu 2>/dev/null || true
    cat /proc/pressure/memory 2>/dev/null || true
    cat /sys/fs/cgroup/cpu.max 2>/dev/null || true
    cat /sys/fs/cgroup/cpu.stat 2>/dev/null || true
  } >"${destination}"
}

failure_trap() {
  local exit_code=$?
  set +e
  capture_environment "${RAW_ROOT}/environment-after-failure.txt"
  ps -eo pid=,ppid=,lstart=,args= >"${RAW_ROOT}/processes-after-failure.txt"
  write_status FAILED "${CURRENT_STAGE:-UNKNOWN}"
  exit "${exit_code}"
}
trap failure_trap ERR INT TERM

exec 9>"${OUTPUT_ROOT}/RUN.lock"
flock -n 9 || { write_status FAILED LOCK; exit 1; }

CURRENT_STAGE=SOURCE
write_status RUNNING "${CURRENT_STAGE}"
cd -- "${REPO_DIR}"
[[ -z "$(git symbolic-ref -q --short HEAD || true)" ]] || {
  echo "compute certification requires a detached HEAD" >&2
  exit 1
}
[[ "$(git rev-parse HEAD)" == "${CANDIDATE_SHA}" ]]
[[ -z "$(git status --porcelain=v1)" ]]
CANDIDATE_TREE="$(git rev-parse HEAD^{tree})"
ACTUAL_POLICY_HASH="$(node -e "const p=require('./cores/chronobiology/c3/package-policy.json'); process.stdout.write(p.policyHash)")"
[[ "${ACTUAL_POLICY_HASH}" == "${EXPECTED_POLICY_HASH}" ]]
[[ -d /opt/stay/legacy/0.6.0 ]]
git status --short --branch >"${RAW_ROOT}/source-status.txt"
git show -s --format=fuller HEAD >>"${RAW_ROOT}/source-status.txt"
git ls-tree -r HEAD >"${RAW_ROOT}/source-tree.txt"

CURRENT_STAGE=ENVIRONMENT
write_status RUNNING "${CURRENT_STAGE}"
capture_environment "${RAW_ROOT}/environment-before.txt"
cat /proc/stat >"${RAW_ROOT}/cpu-stat-preflight-before.txt"
sleep 2
cat /proc/stat >"${RAW_ROOT}/cpu-stat-preflight-after.txt"
PREFLIGHT_STEAL="$(node -e "const e=require('${SCRIPT_DIR}/../split-evidence'); const v=e.cpuStealPercent(process.argv[1],process.argv[2]); if(v===null) process.exit(2); process.stdout.write(String(v));" "${RAW_ROOT}/cpu-stat-preflight-before.txt" "${RAW_ROOT}/cpu-stat-preflight-after.txt")"
node -e "const value=Number(process.argv[1]); if(!Number.isFinite(value)||value>${MAX_CPU_STEAL_PERCENT}) process.exit(1);" "${PREFLIGHT_STEAL}"

node <<'NODE'
const fs = require('node:fs');
const net = require('node:net');
const path = `/var/tmp/stay-c3c-compute-${process.pid}.sock`;
function unlinkIfPresent(target) {
  try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
unlinkIfPresent(path);
const server = net.createServer();
server.once('error', error => { throw error; });
server.listen(path, () => server.close(() => unlinkIfPresent(path)));
NODE

pgrep -x node | sort -n >"${RAW_ROOT}/node-pids-before.txt" || true
ps -eo pid=,ppid=,lstart=,args= >"${RAW_ROOT}/processes-before.txt"
cat /proc/stat >"${RAW_ROOT}/cpu-stat-before.txt"

CURRENT_STAGE=PERFORMANCE
write_status RUNNING "${CURRENT_STAGE}"
node "${SCRIPT_DIR}/performance-probe.js" "${RAW_ROOT}/performance.json" \
  >"${LOG_ROOT}/performance.stdout" 2>"${LOG_ROOT}/performance.stderr"

CURRENT_STAGE=DIRECT
write_status RUNNING "${CURRENT_STAGE}"
node --test --test-concurrency=1 test/chronobiology*.test.js \
  >"${LOG_ROOT}/direct.tap" 2>&1
require_zero_tap DIRECT "${LOG_ROOT}/direct.tap"

CURRENT_STAGE=TARGETED
write_status RUNNING "${CURRENT_STAGE}"
TARGETED_TESTS=(
  test/durable-residency-*.test.js
  test/resident-contract-registry.test.js
  test/resident-signalling-outbox.test.js
  test/corehost.test.js
  test/core-host-supervisor-permissions.test.js
  test/core-sandbox-plan.test.js
  test/systemd-core-sandbox-contract.test.js
  test/trusted-organism-time.test.js
  test/kernel-trusted-time-evidence.test.js
  test/trusted-time-pulse-scheduler.test.js
  test/biological-*.test.js
  test/sntss-*.test.js
  test/audit-regressions.test.js
  test/hostile-closure.test.js
)
node --test --test-concurrency=1 "${TARGETED_TESTS[@]}" \
  >"${LOG_ROOT}/targeted.tap" 2>&1
require_zero_tap TARGETED "${LOG_ROOT}/targeted.tap"

CURRENT_STAGE=FULL
write_status RUNNING "${CURRENT_STAGE}"
npm test >"${LOG_ROOT}/full.tap" 2>&1
require_zero_tap FULL "${LOG_ROOT}/full.tap"

CURRENT_STAGE=SAFETY
write_status RUNNING "${CURRENT_STAGE}"
cat /proc/stat >"${RAW_ROOT}/cpu-stat-after.txt"
capture_environment "${RAW_ROOT}/environment-after.txt"
pgrep -x node | sort -n >"${RAW_ROOT}/node-pids-after.txt" || true
comm -13 "${RAW_ROOT}/node-pids-before.txt" "${RAW_ROOT}/node-pids-after.txt" \
  >"${RAW_ROOT}/new-node-pids.txt"
[[ ! -s "${RAW_ROOT}/new-node-pids.txt" ]]
ps -eo pid=,ppid=,lstart=,args= >"${RAW_ROOT}/processes-after.txt"
[[ -z "$(git status --porcelain=v1)" ]]
[[ "$(git rev-parse HEAD)" == "${CANDIDATE_SHA}" ]]
[[ "$(git rev-parse HEAD^{tree})" == "${CANDIDATE_TREE}" ]]

CURRENT_STAGE=SANITIZE
write_status RUNNING "${CURRENT_STAGE}"
RESULT_PATH="${SANITIZED_RESULT}" RESULT_ROOT="${OUTPUT_ROOT}" \
  RESULT_SHA="${CANDIDATE_SHA}" RESULT_TREE="${CANDIDATE_TREE}" node <<'NODE'
const evidence = require('./certification/chronobiology-c3c/split-evidence');
const record = evidence.buildComputeResult({
  root: process.env.RESULT_ROOT,
  candidateSha: process.env.RESULT_SHA,
  candidateTree: process.env.RESULT_TREE,
});
evidence.writePrivateJson(process.env.RESULT_PATH, record);
NODE

trap - ERR INT TERM
write_status PASS COMPLETE
cat "${SANITIZED_RESULT}"
