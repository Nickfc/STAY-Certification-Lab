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
PRIVATE_STATUS="${PRIVATE_ROOT}/PRIVATE_STATUS.json"

destroy_private_material() {
  chmod -R u+rwX "${PRIVATE_ROOT}" 2>/dev/null || true
  rm -rf -- "${PRIVATE_ROOT}"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  destroy_private_material
  exit "${status}"
}
trap cleanup EXIT INT TERM

# Preserve one clean public descriptor. Everything else, including failures and
# stack traces, is redirected into the ephemeral private root and then destroyed.
exec 3>&1
exec >"${PRIVATE_DRIVER_LOG}" 2>&1

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/../../.." && pwd -P)"
CANDIDATE_SHA="${1:-}"
CANDIDATE_TREE="$(git -C "${REPO_DIR}" rev-parse "${CANDIDATE_SHA}^{tree}")"

set +e
bash "${SCRIPT_DIR}/RUN.sh" \
  --candidate-sha "${CANDIDATE_SHA}" \
  --output-root "${PRIVATE_ROOT}" \
  --lab-repository "${EXPECTED_REPOSITORY}"
COMPUTE_EXIT_CODE=$?
set -e

if [[ "${COMPUTE_EXIT_CODE}" -ne 0 ]]; then
  PRIVATE_STATUS_PATH="${PRIVATE_STATUS}" \
  CANDIDATE_SHA="${CANDIDATE_SHA}" \
  CANDIDATE_TREE="${CANDIDATE_TREE}" \
  COMPUTE_EXIT_CODE="${COMPUTE_EXIT_CODE}" \
    node "${SCRIPT_DIR}/public-failure-record.js" >&3
  destroy_private_material
  trap - EXIT INT TERM
  exit "${COMPUTE_EXIT_CODE}"
fi

[[ -f "${RESULT}" ]]
cat "${RESULT}" >&3
