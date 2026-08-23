#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"
EXPECTED_SHA="7d040592ccf1f149f0f0a170f79cf76bb5f05d92"
EXPECTED_CURRENT="/opt/stay/releases/0.8.11.3-p1a-surgery-a-candidate-${EXPECTED_SHA}"
DATABASE="/var/lib/stay/data/continuity.sqlite3"
A1_STAGED="${1:-}"

[[ -n "$A1_STAGED" && -d "$A1_STAGED" && ! -L "$A1_STAGED" ]] || { echo "PREFLIGHT_A1_ABORT=staged-release-missing" >&2; exit 110; }
[[ "$(readlink -f /opt/stay/current)" == "$EXPECTED_CURRENT" ]] || { echo "PREFLIGHT_A1_ABORT=unexpected-current-release" >&2; exit 111; }
[[ "$(systemctl show stay.service --property=ActiveState --value)" == "active" &&
   "$(systemctl show stay.service --property=SubState --value)" == "running" ]] || { echo "PREFLIGHT_A1_ABORT=service-not-running" >&2; exit 112; }
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/healthz | grep -q '"ok":true' || { echo "PREFLIGHT_A1_ABORT=health-failed" >&2; exit 113; }

STATE="$($(command -v node) "$SCRIPT_DIR/p1-surgery-a1-state.js" capture "$DATABASE")" || { echo "PREFLIGHT_A1_ABORT=state-capture-failed" >&2; exit 114; }
"$(command -v node)" -e '
const s=JSON.parse(process.argv[1]);
if(s.quickCheck!=="ok"||s.schema!==4||!s.fetusAuthority||s.sntssResidentPresent||s.chronobiologyResidentPresent||s.sntssAuthorityPresent||s.chronobiologyAuthorityPresent)process.exit(1)
' "$STATE" || { echo "PREFLIGHT_A1_ABORT=baseline-mismatch" >&2; exit 115; }

echo "PREFLIGHT_A1_RESULT=PASS"
echo "CURRENT_RELEASE=$EXPECTED_CURRENT"
echo "STATESTORE_SCHEMA=4"
echo "SERVICE_ACTIVE=YES"
echo "HEALTH=PASS"
echo "SNTSS_RESIDENT_PRESENT=NO"
echo "CHRONOBIOLOGY_RESIDENT_PRESENT=NO"
echo "SNTSS_AUTHORITY=NONE"
echo "CHRONOBIOLOGY_AUTHORITY=NONE"
echo "SERVICE_OPERATION=NO"
echo "CURRENT_POINTER_CHANGE=NO"
echo "STATESTORE_WRITE=NO"
echo "RESIDENT_OPERATION=NO"
echo "AUTHORITY_CHANGE=NO"
