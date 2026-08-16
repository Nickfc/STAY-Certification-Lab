#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ "${EUID}" -ne 0 ]]; then echo "ERROR: run with sudo/root" >&2; exit 1; fi
PUBLIC_KEY="${1:-}"
if [[ -z "$PUBLIC_KEY" || ! -f "$PUBLIC_KEY" ]]; then echo "Usage: sudo ./deploy/install-trusted-boundary.sh /path/to/release-authority-public.pem" >&2; exit 2; fi
if [[ ! -x /usr/bin/bwrap ]]; then
  echo "ERROR: /usr/bin/bwrap is required. Install the distro bubblewrap package, then rerun this installer." >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install -d -o root -g root -m 0755 /usr/local/lib/stay /etc/stay /etc/stay/core-promotions
install -o root -g root -m 0555 "$ROOT/deploy/trusted-release-verifier.js" /usr/local/lib/stay/trusted-release-verifier.js
install -o root -g root -m 0555 "$ROOT/deploy/stay-deploy.sh" /usr/local/sbin/stay-deploy
install -o root -g root -m 0444 "$PUBLIC_KEY" /etc/stay/release-authority.pub
chown root:root /usr/local/lib/stay/trusted-release-verifier.js /usr/local/sbin/stay-deploy /etc/stay/release-authority.pub
for target in /usr/local/lib/stay/trusted-release-verifier.js /usr/local/sbin/stay-deploy /etc/stay/release-authority.pub; do
  uid="$(stat -Lc '%u' "$target")"; mode="$(stat -Lc '%a' "$target")"
  if [[ "$uid" != "0" ]] || (( (8#$mode & 022) != 0 )); then
    echo "ERROR: trusted-boundary permissions are unsafe: $target" >&2; exit 3
  fi
done
echo "Trusted STAY boundary installed. No release was activated and no StateStore was touched."
