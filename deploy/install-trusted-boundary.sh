#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# SECOND-STAGE INSTALLER ONLY.
# This file is not a root of trust. Before invoking it as root, the operator must
# independently authenticate the release-authority public-key fingerprint and
# verify the detached Ed25519 signature over the bootstrap SHA256 manifest using
# host/system tooling as specified in R10_5_TRUST_BOOTSTRAP_CEREMONY.md.
if [[ "${EUID}" -ne 0 ]]; then echo "ERROR: run with sudo/root only after external bootstrap verification." >&2; exit 1; fi
if [[ "${STAY_BOOTSTRAP_PREVERIFIED:-0}" != "1" ]]; then
  echo "ERROR: trust bootstrap has not been externally preverified. Follow docs/sntss/R10_5_TRUST_BOOTSTRAP_CEREMONY.md first." >&2
  exit 2
fi

PUBLIC_KEY=""
PUBLIC_KEY_SHA256=""
MANIFEST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-key) PUBLIC_KEY="${2:-}"; shift 2 ;;
    --public-key-sha256) PUBLIC_KEY_SHA256="${2:-}"; shift 2 ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$PUBLIC_KEY" || -z "$PUBLIC_KEY_SHA256" || -z "$MANIFEST" || ! -f "$PUBLIC_KEY" || ! -f "$MANIFEST" ]]; then
  echo "Usage after external verification: sudo env STAY_BOOTSTRAP_PREVERIFIED=1 ./deploy/install-trusted-boundary.sh --public-key <release-authority-public.pem> --public-key-sha256 <64-hex> --manifest <verified-bootstrap.sha256>" >&2
  exit 2
fi
if [[ ! "$PUBLIC_KEY_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "ERROR: --public-key-sha256 must be a lowercase 64-hex SHA256 fingerprint." >&2
  exit 2
fi
if [[ ! -x /usr/bin/bwrap ]]; then
  echo "ERROR: /usr/bin/bwrap is required. Install the distro bubblewrap package, then rerun this installer." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC_KEY="$(readlink -f "$PUBLIC_KEY")"
MANIFEST="$(readlink -f "$MANIFEST")"
ACTUAL_PUBLIC_KEY_SHA256="$(/usr/bin/sha256sum "$PUBLIC_KEY" | awk '{print $1}')"
if [[ "$ACTUAL_PUBLIC_KEY_SHA256" != "$PUBLIC_KEY_SHA256" ]]; then
  echo "ERROR: release-authority public-key fingerprint differs from the independently verified fingerprint." >&2
  exit 3
fi

EXPECTED_FILES=(
  "deploy/install-trusted-boundary.sh"
  "deploy/trusted-release-verifier.js"
  "deploy/stay-deploy.sh"
)
if [[ "$(/usr/bin/awk 'NF {count++} END {print count+0}' "$MANIFEST")" -ne "${#EXPECTED_FILES[@]}" ]]; then
  echo "ERROR: bootstrap manifest must contain exactly ${#EXPECTED_FILES[@]} non-empty entries." >&2
  exit 3
fi
for relative in "${EXPECTED_FILES[@]}"; do
  escaped="${relative//\//\\/}"
  if ! /usr/bin/grep -Eq "^[0-9a-f]{64}  ${escaped}$" "$MANIFEST"; then
    echo "ERROR: bootstrap manifest is missing exact trusted-boundary entry: $relative" >&2
    exit 3
  fi
done
while IFS= read -r line; do
  [[ -z "${line//[[:space:]]/}" ]] && continue
  file="${line#*  }"
  case "$file" in
    deploy/install-trusted-boundary.sh|deploy/trusted-release-verifier.js|deploy/stay-deploy.sh) ;;
    *) echo "ERROR: bootstrap manifest contains an unexpected path: $file" >&2; exit 3 ;;
  esac
done < "$MANIFEST"

(
  cd "$ROOT"
  /usr/bin/sha256sum -c "$MANIFEST"
)

install -d -o root -g root -m 0755 /usr/local/lib/stay /etc/stay /etc/stay/core-promotions
install -o root -g root -m 0555 "$ROOT/deploy/trusted-release-verifier.js" /usr/local/lib/stay/trusted-release-verifier.js
install -o root -g root -m 0555 "$ROOT/deploy/stay-deploy.sh" /usr/local/sbin/stay-deploy
install -o root -g root -m 0444 "$PUBLIC_KEY" /etc/stay/release-authority.pub
chown root:root /usr/local/lib/stay/trusted-release-verifier.js /usr/local/sbin/stay-deploy /etc/stay/release-authority.pub

for target in /usr/local/lib/stay/trusted-release-verifier.js /usr/local/sbin/stay-deploy /etc/stay/release-authority.pub; do
  uid="$(stat -Lc '%u' "$target")"; mode="$(stat -Lc '%a' "$target")"
  if [[ "$uid" != "0" ]] || (( (8#$mode & 022) != 0 )); then
    echo "ERROR: trusted-boundary permissions are unsafe: $target" >&2
    exit 4
  fi
done

INSTALLED_KEY_SHA256="$(/usr/bin/sha256sum /etc/stay/release-authority.pub | awk '{print $1}')"
if [[ "$INSTALLED_KEY_SHA256" != "$PUBLIC_KEY_SHA256" ]]; then
  echo "ERROR: installed trust key fingerprint changed during installation." >&2
  exit 4
fi

echo "Trusted STAY boundary installed from externally authenticated bytes."
echo "No release was activated and no StateStore was touched."
