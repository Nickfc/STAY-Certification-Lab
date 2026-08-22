#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/../../.." && pwd -P)"
SOURCE_ARCHIVE="${1:-}"
ENCRYPTED_OUTPUT="${2:-}"
FIXTURE_PASSPHRASE="${STAY_LEGACY_0_6_FIXTURE_PASSPHRASE:-}"

[[ -f "${SOURCE_ARCHIVE}" && "${ENCRYPTED_OUTPUT}" = /* ]] || exit 64
[[ "${#FIXTURE_PASSPHRASE}" -ge 20 ]] || exit 64
SOURCE_ARCHIVE="$(realpath -- "${SOURCE_ARCHIVE}")"
ENCRYPTED_OUTPUT="$(realpath -m -- "${ENCRYPTED_OUTPUT}")"

# Fixture material must originate from the sealed non-live migration source,
# never from an installed organism tree or its StateStore.
case "${SOURCE_ARCHIVE}" in
  /opt/stay/*|/var/lib/stay/*) exit 64 ;;
esac
[[ "${ENCRYPTED_OUTPUT}" == *.gpg ]]

EXPECTED="$(awk 'NF { print $1; exit }' "${REPO_DIR}/legacy/0.6.0/SOURCE_ARCHIVE_SHA256")"
ACTUAL="$(sha256sum -- "${SOURCE_ARCHIVE}" | awk '{print $1}')"
[[ "${ACTUAL}" == "${EXPECTED}" ]]

mkdir -p -- "$(dirname -- "${ENCRYPTED_OUTPUT}")"
TEMP_OUTPUT="${ENCRYPTED_OUTPUT}.tmp.$$"
cleanup() {
  local status=$?
  rm -f -- "${TEMP_OUTPUT}"
  exit "${status}"
}
trap cleanup EXIT INT TERM

printf '%s\n' "${FIXTURE_PASSPHRASE}" | \
  gpg --quiet --batch --yes --pinentry-mode loopback --passphrase-fd 0 \
    --symmetric --cipher-algo AES256 --output "${TEMP_OUTPUT}" "${SOURCE_ARCHIVE}"
chmod 600 "${TEMP_OUTPUT}"
mv -f -- "${TEMP_OUTPUT}" "${ENCRYPTED_OUTPUT}"
trap - EXIT INT TERM
