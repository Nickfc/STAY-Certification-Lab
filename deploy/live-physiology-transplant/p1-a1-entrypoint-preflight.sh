#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"

A1_RELEASE="/opt/stay/releases/0.8.11.3-p1a1-resident-control-7d040592ccf1f149"
DATABASE="/var/lib/stay/data/continuity.sqlite3"
DROPIN="/etc/systemd/system/stay.service.d/p1-a1-resident-control.conf"
NODE_BIN="$(command -v node)"

abort() { echo "PREFLIGHT_A1_ENTRYPOINT_ABORT=$1" >&2; exit "${2:-160}"; }
execstart() { systemctl show stay.service --property=ExecStart --value; }

[[ "$(readlink -f /opt/stay/current)" == "$A1_RELEASE" ]] || abort unexpected-current-release 161
[[ "$(systemctl show stay.service --property=ActiveState --value)" == "active" &&
   "$(systemctl show stay.service --property=SubState --value)" == "running" ]] || abort service-not-running 162
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/healthz | grep -q '"ok":true' || abort health-failed 163
ENTRYPOINT="$(execstart)"
grep -Fq '/opt/stay/current/server.js' <<<"$ENTRYPOINT" || abort legacy-entrypoint-not-loaded 164
grep -Fq '/opt/stay/current/server-secure.js' <<<"$ENTRYPOINT" && abort secure-entrypoint-already-loaded 165
[[ ! -e "$DROPIN" && ! -L "$DROPIN" ]] || abort dropin-already-present 166
[[ ! -S /run/stay/resident-control.sock ]] || abort resident-control-socket-unexpected 167

STATE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-a1-state.js" capture "$DATABASE")" || abort state-capture-failed 168
"$NODE_BIN" -e '
const s=JSON.parse(process.argv[1]);
if(s.quickCheck!=="ok"||s.schema!==4||!s.fetusAuthority||s.sntssResidentPresent||s.chronobiologyResidentPresent||s.sntssAuthorityPresent||s.chronobiologyAuthorityPresent)process.exit(1)
' "$STATE" || abort baseline-mismatch 169

echo "PREFLIGHT_A1_ENTRYPOINT_RESULT=PASS"
echo "CURRENT_RELEASE=$A1_RELEASE"
echo "ENTRYPOINT_BEFORE=server.js"
echo "RESIDENT_CONTROL_SOCKET=MISSING"
echo "STATESTORE_SCHEMA=4"
echo "SNTSS_RESIDENT_PRESENT=NO"
echo "CHRONOBIOLOGY_RESIDENT_PRESENT=NO"
echo "SNTSS_AUTHORITY=NONE"
echo "CHRONOBIOLOGY_AUTHORITY=NONE"
echo "SERVICE_OPERATION=NO"
echo "CURRENT_POINTER_CHANGE=NO"
echo "STATESTORE_WRITE=NO"
echo "RESIDENT_OPERATION=NO"
echo "AUTHORITY_CHANGE=NO"

