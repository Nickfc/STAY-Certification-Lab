#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-${STAY_C3C_COMPUTE_ROOT:-}}"
[[ -n "${ROOT}" ]] || { echo "usage: WATCH.sh <private-output-root>" >&2; exit 64; }
STATUS="${ROOT}/PRIVATE_STATUS.json"
if [[ ! -r "${STATUS}" ]]; then
  echo '{"result":"NOT_STARTED"}'
  exit 0
fi
cat "${STATUS}"
