#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

EXPECTED_REPOSITORY="Nickfc/STAY-Certification-Lab"
[[ "${GITHUB_REPOSITORY:-}" == "${EXPECTED_REPOSITORY}" ]] || exit 64
[[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]] || exit 64
[[ -n "${RUNNER_TEMP:-}" && "${RUNNER_TEMP}" = /* ]] || exit 64

PRIVATE_ROOT="$(mktemp -d "${RUNNER_TEMP}/stay-chronobiology-c3c.XXXXXX")"
PRIVATE_DRIVER_LOG="${PRIVATE_ROOT}/driver.private.log"
RESULT="${PRIVATE_ROOT}/COMPUTE_RESULT.sanitized.json"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  chmod -R u+rwX "${PRIVATE_ROOT}" 2>/dev/null || true
  rm -rf -- "${PRIVATE_ROOT}"
  exit "${status}"
}
trap cleanup EXIT INT TERM

# Preserve one clean public descriptor. Everything else, including failures and
# stack traces, is redirected into the ephemeral private root and then destroyed.
exec 3>&1
exec >"${PRIVATE_DRIVER_LOG}" 2>&1

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bash "${SCRIPT_DIR}/RUN.sh" \
  --candidate-sha "${1:-}" \
  --output-root "${PRIVATE_ROOT}" \
  --lab-repository "${EXPECTED_REPOSITORY}"

[[ -f "${RESULT}" ]]
cat "${RESULT}" >&3
