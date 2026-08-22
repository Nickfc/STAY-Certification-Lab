#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/../../.." && pwd -P)"
EXPECTED_MIGRATION_SHA256="b2582a4a8f4fc5d82f5241c6a2309426709c8906be76c572fe44f1d305d9f12b"
MIGRATION_ZIP="${1:-}"
ENCRYPTED_OUTPUT="${2:-}"
FIXTURE_PASSPHRASE="${STAY_LEGACY_0_6_FIXTURE_PASSPHRASE:-}"

[[ -f "${MIGRATION_ZIP}" && "${ENCRYPTED_OUTPUT}" = /* ]] || exit 64
[[ "${#FIXTURE_PASSPHRASE}" -ge 20 ]] || exit 64
MIGRATION_ZIP="$(realpath -- "${MIGRATION_ZIP}")"
ENCRYPTED_OUTPUT="$(realpath -m -- "${ENCRYPTED_OUTPUT}")"

# Fixture material must originate from the sealed non-live migration source,
# never from an installed organism tree or its StateStore.
case "${MIGRATION_ZIP}" in
  /opt/stay/*|/var/lib/stay/*) exit 64 ;;
esac
[[ "${ENCRYPTED_OUTPUT}" == *.gpg ]]
[[ "$(sha256sum -- "${MIGRATION_ZIP}" | awk '{print $1}')" == "${EXPECTED_MIGRATION_SHA256}" ]]

mkdir -p -- "$(dirname -- "${ENCRYPTED_OUTPUT}")"
TEMP_OUTPUT="${ENCRYPTED_OUTPUT}.tmp.$$"
PRIVATE_ROOT="$(mktemp -d)"
INVENTORY="${PRIVATE_ROOT}/SOURCE_FILES.json"
TRANSPORT="${PRIVATE_ROOT}/source.tar.gz"
cleanup() {
  local status=$?
  rm -f -- "${TEMP_OUTPUT}"
  rm -rf -- "${PRIVATE_ROOT}"
  exit "${status}"
}
trap cleanup EXIT INT TERM

node -e "const {SOURCE_FILES}=require(process.argv[1]); process.stdout.write(JSON.stringify(SOURCE_FILES));" \
  "${REPO_DIR}/cores/fetus-legacy-0.6" >"${INVENTORY}"
chmod 600 "${INVENTORY}"
TRANSPORT_SHA256="$(python3 "${SCRIPT_DIR}/legacy-fixture-transport.py" build \
  --inventory "${INVENTORY}" --input "${MIGRATION_ZIP}" --output "${TRANSPORT}")"
[[ "${TRANSPORT_SHA256}" =~ ^[0-9a-f]{64}$ ]]

printf '%s\n' "${FIXTURE_PASSPHRASE}" | \
  gpg --quiet --batch --yes --pinentry-mode loopback --passphrase-fd 0 \
    --symmetric --cipher-algo AES256 --output "${TEMP_OUTPUT}" "${TRANSPORT}"
chmod 600 "${TEMP_OUTPUT}"
mv -f -- "${TEMP_OUTPUT}" "${ENCRYPTED_OUTPUT}"
printf 'DETERMINISTIC_ARCHIVE_SHA256=%s\n' "${TRANSPORT_SHA256}"
rm -rf -- "${PRIVATE_ROOT}"
trap - EXIT INT TERM
