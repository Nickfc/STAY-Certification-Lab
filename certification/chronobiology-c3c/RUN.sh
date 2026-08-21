#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
CERT_ROOT="${STAY_CHRONOBIOLOGY_CERT_ROOT:-/var/tmp/stay-chronobiology-c3c}"
STATUS_FILE="${CERT_ROOT}/STATUS.json"
LOG_DIR="${CERT_ROOT}/logs"
EVIDENCE_DIR="${CERT_ROOT}/evidence"
EXPECTED_BRANCH="feature/chronobiology"
EXPECTED_POLICY_HASH="sha256:9ab15c27c69494c6ce3156255ed06d2f57887934928a85b13ff58d578add7820"

mkdir -p -- "${LOG_DIR}" "${EVIDENCE_DIR}"

write_status() {
  local result="$1" stage="$2" detail="$3"
  RESULT_VALUE="${result}" STAGE_VALUE="${stage}" DETAIL_VALUE="${detail}" \
  STATUS_PATH="${STATUS_FILE}" REPO_PATH="${REPO_DIR}" node <<'NODE'
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const env = process.env;
let head = null;
try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.REPO_PATH, encoding: 'utf8' }).trim(); } catch {}
const record = {
  schema: 'stay.chronobiology.c3c-server-status/v1',
  result: env.RESULT_VALUE,
  stage: env.STAGE_VALUE,
  detail: env.DETAIL_VALUE,
  heartbeat_utc: new Date().toISOString(),
  head,
  release_sealed: false,
};
fs.writeFileSync(env.STATUS_PATH, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
NODE
}

sentinel() {
  local destination="$1"
  {
    systemctl show stay.service \
      -p MainPID -p NRestarts -p ActiveState -p SubState --no-pager
    printf '/opt/stay/current='
    readlink -f /opt/stay/current
  } >"${destination}"
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
  [[ -n "${tests}" && "${tests}" == "${pass}" ]] || {
    echo "${label}: TAP tests/pass mismatch (${tests:-missing}/${pass:-missing})" >&2
    return 1
  }
  [[ "${fail:-0}" == 0 && "${skipped:-0}" == 0 && "${todo:-0}" == 0 && "${cancelled:-0}" == 0 ]] || {
    echo "${label}: non-zero fail/skip/todo/cancelled (${fail:-missing}/${skipped:-missing}/${todo:-missing}/${cancelled:-missing})" >&2
    return 1
  }
}

failure_trap() {
  local exit_code=$?
  set +e
  sentinel "${EVIDENCE_DIR}/live-after-failure.txt"
  ps -eo pid=,ppid=,lstart=,args= >"${EVIDENCE_DIR}/processes-after-failure.txt"
  write_status FAILED "${CURRENT_STAGE:-UNKNOWN}" "Certification failed with exit ${exit_code}; inspect logs and failure evidence."
  exit "${exit_code}"
}
trap failure_trap ERR INT TERM

exec 9>"${CERT_ROOT}/RUN.lock"
flock -n 9 || { write_status FAILED LOCK "Another certification run holds ${CERT_ROOT}/RUN.lock"; exit 1; }

CURRENT_STAGE=PRECHECK
write_status RUNNING "${CURRENT_STAGE}" "Validating source identity, environment and live safety baseline."
cd -- "${REPO_DIR}"

[[ "$(git branch --show-current)" == "${EXPECTED_BRANCH}" ]]
[[ -z "$(git status --porcelain=v1)" ]]
git fetch --quiet origin "${EXPECTED_BRANCH}"
LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse "origin/${EXPECTED_BRANCH}")"
[[ "${LOCAL_HEAD}" == "${REMOTE_HEAD}" ]]

ACTUAL_POLICY_HASH="$(node -e "const p=require('./cores/chronobiology/c3/package-policy.json'); process.stdout.write(p.policyHash)")"
[[ "${ACTUAL_POLICY_HASH}" == "${EXPECTED_POLICY_HASH}" ]]
[[ -d /opt/stay/legacy/0.6.0 ]]

node <<'NODE'
const fs = require('node:fs');
const net = require('node:net');
const path = '/var/tmp/stay-chronobiology-c3c-socket-preflight.sock';
try { fs.unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const server = net.createServer();
server.once('error', error => { throw error; });
server.listen(path, () => server.close(() => fs.unlinkSync(path)));
NODE

sentinel "${EVIDENCE_DIR}/live-before.txt"
ps -eo pid=,ppid=,lstart=,args= >"${EVIDENCE_DIR}/processes-before.txt"
pgrep -x node | sort -n >"${EVIDENCE_DIR}/node-pids-before.txt" || true
git status --short --branch >"${EVIDENCE_DIR}/source-before.txt"
git show -s --format=fuller HEAD >>"${EVIDENCE_DIR}/source-before.txt"
git ls-tree -r HEAD >>"${EVIDENCE_DIR}/source-tree.txt"

CURRENT_STAGE=DIRECT
write_status RUNNING "${CURRENT_STAGE}" "Running all Chronobiology direct and hostile tests in a fresh Node process."
node --test --test-concurrency=1 test/chronobiology*.test.js 2>&1 | tee "${LOG_DIR}/direct.tap"
require_zero_tap DIRECT "${LOG_DIR}/direct.tap"

CURRENT_STAGE=TARGETED
write_status RUNNING "${CURRENT_STAGE}" "Running targeted residency, BSF, CoreHost, trusted-time and frozen-SNTSS regressions."
TARGETED_TESTS=(
  test/durable-residency-manager.test.js
  test/durable-residency-state-store.test.js
  test/durable-residency-lifecycle.test.js
  test/durable-residency-living-kernel.test.js
  test/durable-residency-promotion.test.js
  test/resident-signalling-outbox.test.js
  test/corehost.test.js
  test/trusted-organism-time.test.js
  test/kernel-trusted-time-evidence.test.js
  test/trusted-time-pulse-scheduler.test.js
  test/biological-acceptance.test.js
  test/biological-acceptance-state-store.test.js
  test/biological-bsf-policy.test.js
  test/biological-bsf-laboratory.test.js
  test/biological-bsf-containment.test.js
  test/biological-producer-idempotency.test.js
  test/biological-producer-outbox.test.js
  test/biological-route-lifecycle.test.js
  test/biological-stream-progress.test.js
  test/biological-stream-sequencing.test.js
  test/biological-cutover-spool.test.js
  test/biological-envelope-v2.test.js
  test/biological-envelope-v2-persistence.test.js
  test/sntss-i3d-runtime-package.test.js
  test/sntss-i3d-durable-state.test.js
  test/sntss-live-attachment.test.js
  test/sntss-biological-fabric-ingress.test.js
  test/sntss-containment.test.js
  test/audit-regressions.test.js
  test/hostile-closure.test.js
)
node --test --test-concurrency=1 "${TARGETED_TESTS[@]}" 2>&1 | tee "${LOG_DIR}/targeted.tap"
require_zero_tap TARGETED "${LOG_DIR}/targeted.tap"

CURRENT_STAGE=FULL
write_status RUNNING "${CURRENT_STAGE}" "Running the complete repository suite in a fresh Node process."
npm test 2>&1 | tee "${LOG_DIR}/full.tap"
require_zero_tap FULL "${LOG_DIR}/full.tap"

CURRENT_STAGE=SAFETY
write_status RUNNING "${CURRENT_STAGE}" "Checking leaked processes and unchanged live sentinels."
pgrep -x node | sort -n >"${EVIDENCE_DIR}/node-pids-after.txt" || true
comm -13 "${EVIDENCE_DIR}/node-pids-before.txt" "${EVIDENCE_DIR}/node-pids-after.txt" \
  >"${EVIDENCE_DIR}/new-node-pids.txt"
[[ ! -s "${EVIDENCE_DIR}/new-node-pids.txt" ]]
ps -eo pid=,ppid=,lstart=,args= >"${EVIDENCE_DIR}/processes-after.txt"
sentinel "${EVIDENCE_DIR}/live-after.txt"
cmp -s "${EVIDENCE_DIR}/live-before.txt" "${EVIDENCE_DIR}/live-after.txt"
[[ -z "$(git status --porcelain=v1)" ]]
[[ "$(git rev-parse HEAD)" == "${LOCAL_HEAD}" ]]

CURRENT_STAGE=EVIDENCE
write_status RUNNING "${CURRENT_STAGE}" "Hashing immutable candidate and server execution evidence."
sha256sum \
  cores/chronobiology/c3/*.js \
  cores/chronobiology/c3/package-policy.json \
  cores/chronobiology/c3/schemas/*.json \
  runtime/kernel/resident-manager.js \
  runtime/kernel/state-store.js \
  runtime/kernel/biological-signalling-fabric.js \
  test/chronobiology*.test.js \
  >"${EVIDENCE_DIR}/candidate-source-sha256.txt"
find "${LOG_DIR}" "${EVIDENCE_DIR}" -type f ! -name SHA256SUMS.txt -print0 \
  | sort -z | xargs -0 sha256sum >"${CERT_ROOT}/SHA256SUMS.txt"

trap - ERR INT TERM
write_status CANDIDATE_CERTIFIED_UNSEALED COMPLETE \
  "Zero-failure/zero-skip direct, targeted and full suites passed; no leaked Node process; live sentinels unchanged. Final seal still requires evidence review and an explicit seal step."
echo "Chronobiology candidate certified but NOT sealed. Evidence: ${CERT_ROOT}"
