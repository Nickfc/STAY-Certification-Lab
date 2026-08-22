#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/../../.." && pwd -P)"
CANDIDATE_SHA=""
CANDIDATE_TREE=""
COMPUTE_RESULT=""
OUTPUT_ROOT="${STAY_C3C_LIVE_ROOT:-}"

usage() {
  echo "Usage: RUN.sh --candidate-sha <40-hex> --candidate-tree <40-hex> --compute-result <sanitized-json> --output-root <private-path>" >&2
}

while (($#)); do
  case "$1" in
    --candidate-sha) CANDIDATE_SHA="${2:-}"; shift 2 ;;
    --candidate-tree) CANDIDATE_TREE="${2:-}"; shift 2 ;;
    --compute-result) COMPUTE_RESULT="${2:-}"; shift 2 ;;
    --output-root) OUTPUT_ROOT="${2:-}"; shift 2 ;;
    *) usage; exit 64 ;;
  esac
done

[[ "${CANDIDATE_SHA}" =~ ^[0-9a-f]{40}$ ]] || { usage; exit 64; }
[[ "${CANDIDATE_TREE}" =~ ^[0-9a-f]{40}$ ]] || { usage; exit 64; }
[[ -f "${COMPUTE_RESULT}" ]] || { usage; exit 64; }
[[ -n "${OUTPUT_ROOT}" && "${OUTPUT_ROOT}" = /* ]] || { usage; exit 64; }

OUTPUT_ROOT="$(realpath -m -- "${OUTPUT_ROOT}")"
case "${OUTPUT_ROOT}/" in
  "${REPO_DIR}/"*) echo "private evidence root must be outside the source checkout" >&2; exit 64 ;;
esac

RAW_ROOT="${OUTPUT_ROOT}/raw"
LIVE_RESULT="${OUTPUT_ROOT}/LIVE_RESULT.sanitized.json"
mkdir -p -- "${RAW_ROOT}"
chmod 700 "${OUTPUT_ROOT}" "${RAW_ROOT}"

capture_sentinel() {
  local destination="$1"
  {
    systemctl show stay.service \
      -p MainPID -p NRestarts -p ActiveState -p SubState --no-pager
    printf '/opt/stay/current='
    readlink -f /opt/stay/current
  } >"${destination}"
}

cd -- "${REPO_DIR}"
[[ "$(git rev-parse HEAD)" == "${CANDIDATE_SHA}" ]]
[[ "$(git rev-parse HEAD^{tree})" == "${CANDIDATE_TREE}" ]]
[[ -z "$(git status --porcelain=v1)" ]]

COMPUTE_PATH="$(realpath -- "${COMPUTE_RESULT}")" EXPECTED_SHA="${CANDIDATE_SHA}" \
  EXPECTED_TREE="${CANDIDATE_TREE}" node <<'NODE'
const fs = require('node:fs');
const evidence = require('./certification/chronobiology-c3c/split-evidence');
const record = JSON.parse(fs.readFileSync(process.env.COMPUTE_PATH, 'utf8'));
evidence.validateComputeResult(record);
if (record.candidate.sha !== process.env.EXPECTED_SHA
  || record.candidate.tree !== process.env.EXPECTED_TREE) {
  throw Object.assign(new Error('compute evidence identifies a different candidate'), {
    code: 'C3C_SPLIT_CANDIDATE_MISMATCH',
  });
}
NODE

capture_sentinel "${RAW_ROOT}/live-before.txt"
pgrep -x node | sort -n >"${RAW_ROOT}/node-pids-before.txt" || true
ps -eo pid=,ppid=,lstart=,args= >"${RAW_ROOT}/processes-before.txt"

# This lane observes source identity and the live sentinel only. It neither runs
# compute tests nor mutates, restarts, deploys, switches, or emulates the organism.
git show -s --format=fuller HEAD >"${RAW_ROOT}/source-identity.txt"
git ls-tree -r HEAD >"${RAW_ROOT}/source-tree.txt"

capture_sentinel "${RAW_ROOT}/live-after.txt"
pgrep -x node | sort -n >"${RAW_ROOT}/node-pids-after.txt" || true
comm -13 "${RAW_ROOT}/node-pids-before.txt" "${RAW_ROOT}/node-pids-after.txt" \
  >"${RAW_ROOT}/new-node-pids.txt"
[[ ! -s "${RAW_ROOT}/new-node-pids.txt" ]]
ps -eo pid=,ppid=,lstart=,args= >"${RAW_ROOT}/processes-after.txt"
cmp -s "${RAW_ROOT}/live-before.txt" "${RAW_ROOT}/live-after.txt"
[[ "$(git rev-parse HEAD)" == "${CANDIDATE_SHA}" ]]
[[ "$(git rev-parse HEAD^{tree})" == "${CANDIDATE_TREE}" ]]
[[ -z "$(git status --porcelain=v1)" ]]

COMPUTE_PATH="$(realpath -- "${COMPUTE_RESULT}")" RESULT_PATH="${LIVE_RESULT}" \
  RESULT_SHA="${CANDIDATE_SHA}" RESULT_TREE="${CANDIDATE_TREE}" \
  RESULT_RAW="${RAW_ROOT}" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const evidence = require('./certification/chronobiology-c3c/split-evidence');
const raw = process.env.RESULT_RAW;
const record = evidence.buildLiveResult({
  candidateSha: process.env.RESULT_SHA,
  candidateTree: process.env.RESULT_TREE,
  compute: JSON.parse(fs.readFileSync(process.env.COMPUTE_PATH, 'utf8')),
  beforeFile: path.join(raw, 'live-before.txt'),
  afterFile: path.join(raw, 'live-after.txt'),
  processBeforeFile: path.join(raw, 'processes-before.txt'),
  processAfterFile: path.join(raw, 'processes-after.txt'),
});
evidence.writePrivateJson(process.env.RESULT_PATH, record);
NODE

cat "${LIVE_RESULT}"
