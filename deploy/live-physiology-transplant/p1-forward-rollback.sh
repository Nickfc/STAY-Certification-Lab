#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"

if [[ "${STAY_SURGERY_A_WRITE_AUTHORIZED:-NO}" != "YES" ]]; then
  echo "ROLLBACK_REFUSED=production-write-not-explicitly-authorized" >&2
  exit 50
fi

ROLLBACK_RELEASE="${1:-}"
if [[ -z "$ROLLBACK_RELEASE" || ! -d "$ROLLBACK_RELEASE" ]]; then
  echo "Usage: STAY_SURGERY_A_WRITE_AUTHORIZED=YES p1-forward-rollback.sh /opt/stay/releases/<forward-compatible-rollback>" >&2
  exit 51
fi
ROLLBACK_RELEASE="$(readlink -f "$ROLLBACK_RELEASE")"
case "$ROLLBACK_RELEASE" in
  /opt/stay/releases/*) ;;
  *) echo "ROLLBACK_REFUSED=release-outside-immutable-root" >&2; exit 52 ;;
esac

ROLE="$(node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(p.releaseRole||""))' "$ROLLBACK_RELEASE/P1_SURGERY_A_MANIFEST.json")"
if [[ "$ROLE" != "forward-compatible-rollback" ]]; then
  echo "ROLLBACK_REFUSED=wrong-release-role" >&2
  exit 53
fi

# This path changes code authority only.  It contains no copy, extraction,
# deletion, replacement, or restoration operation against /var/lib/stay.
systemctl stop stay.service
ln -s "$ROLLBACK_RELEASE" /opt/stay/current.p1-rollback
mv -Tf /opt/stay/current.p1-rollback /opt/stay/current
systemctl reset-failed stay.service || true
systemctl start stay.service

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null; then
    echo "FORWARD_COMPATIBLE_ROLLBACK=PASS"
    echo "BIOLOGICAL_STATE_RESTORED=NO"
    echo "CANONICAL_FORWARD_STATE_PRESERVED=YES"
    exit 0
  fi
  sleep 1
done

echo "FORWARD_COMPATIBLE_ROLLBACK=FAILED_HEALTH" >&2
echo "CANONICAL_FORWARD_STATE_PRESERVED=YES" >&2
exit 54
