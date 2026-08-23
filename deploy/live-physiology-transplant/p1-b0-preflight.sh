#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"
A1_RELEASE="/opt/stay/releases/0.8.11.3-p1a1-resident-control-7d040592ccf1f149"
DATABASE="/var/lib/stay/data/continuity.sqlite3"
SOCKET="/run/stay/resident-control.sock"
B0_DROPIN="/etc/systemd/system/stay.service.d/p1-b0-resident-runtime.conf"
NODE_BIN="$(command -v node)"
abort() { echo "PREFLIGHT_B0_ABORT=$1" >&2; exit "${2:-240}"; }
json_field() { "$NODE_BIN" -e 'const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],JSON.parse(process.argv[1]));process.stdout.write(String(v??""))' "$1" "$2"; }

[[ "$(readlink -f /opt/stay/current)" == "$A1_RELEASE" ]] || abort unexpected-current-release 241
[[ "$(systemctl show stay.service -p ActiveState --value)" == active && "$(systemctl show stay.service -p SubState --value)" == running ]] || abort service-not-running 242
PID="$(systemctl show stay.service -p MainPID --value)"; [[ "$PID" =~ ^[1-9][0-9]*$ ]] || abort service-pid-invalid 243
EXECSTART="$(systemctl show stay.service -p ExecStart --value)"
grep -Fq '/opt/stay/current/server-secure.js' <<<"$EXECSTART" || abort secure-entrypoint-not-loaded 244
[[ -S "$SOCKET" && ! -L "$SOCKET" ]] || abort resident-control-unavailable 245
HEALTH="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/healthz)" || abort health-failed 246
[[ "$(json_field "$HEALTH" revision)" == 52 ]] || abort runtime-revision-mismatch 247
[[ ! -e "$B0_DROPIN" && ! -e /etc/stay/release-authority.pub && ! -e /etc/stay/resident-promotions/resident-sntss.json ]] || abort b0-target-already-present 248
[[ -x /usr/bin/bwrap && ! -L /usr/bin/bwrap && "$(stat -Lc '%U:%G' /usr/bin/bwrap)" == root:root ]] || abort bwrap-unavailable-or-untrusted 249
BASELINE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-b-state.js" baseline "$DATABASE")" || abort state-baseline-mismatch 250
REQUEST="$($NODE_BIN "$SCRIPT_DIR/p1-b0-state.js" request "$A1_RELEASE" "$DATABASE")" || abort certificate-request-failed 251
SNTSS="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:sntss)" || abort sntss-status-failed 252
CHRONO="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:chronobiology)" || abort chronobiology-status-failed 253
[[ "$(json_field "$SNTSS" resident.present)" == false && "$(json_field "$CHRONO" resident.present)" == false ]] || abort resident-present 254

echo "PREFLIGHT_B0_RESULT=PASS"
echo "CURRENT_RELEASE=$A1_RELEASE"
echo "ENTRYPOINT=server-secure.js"
echo "RUNTIME_REVISION=52"
echo "STATESTORE_SCHEMA=4"
echo "TRUSTED_TIME_PULSE_INTERVAL_MS=25"
echo "RESIDENT_CERTIFICATE_REQUEST=$REQUEST"
echo "SNTSS_RESIDENT_PRESENT=NO"
echo "CHRONOBIOLOGY_RESIDENT_PRESENT=NO"
echo "SNTSS_AUTHORITY=NONE"
echo "CHRONOBIOLOGY_AUTHORITY=NONE"
echo "SERVICE_OPERATION=NO"
echo "CURRENT_POINTER_CHANGE=NO"
echo "STATESTORE_WRITE=NO"
echo "RESIDENT_OPERATION=NO"
echo "AUTHORITY_CHANGE=NO"
