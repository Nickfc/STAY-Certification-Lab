#!/usr/bin/env bash
set -euo pipefail

CERT_ROOT="${STAY_CHRONOBIOLOGY_CERT_ROOT:-/var/tmp/stay-chronobiology-c3c}"
STATUS_FILE="${CERT_ROOT}/STATUS.json"

if [[ ! -f "${STATUS_FILE}" ]]; then
  echo "RESULT=NOT_STARTED"
  echo "DETAIL=Run certification/chronobiology-c3c/RUN.sh"
  exit 0
fi

cat "${STATUS_FILE}"
echo
for log in direct.tap targeted.tap full.tap; do
  if [[ -f "${CERT_ROOT}/logs/${log}" ]]; then
    echo "== ${log} =="
    tail -n 20 "${CERT_ROOT}/logs/${log}"
  fi
done
