#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"
[[ "${STAY_A1_ENTRYPOINT_ROLLBACK_AUTHORIZED:-NO}" == "YES" ]] || {
  echo "ROLLBACK_A1_ENTRYPOINT_ABORT=authorization-missing" >&2; exit 200;
}

A1_RELEASE="/opt/stay/releases/0.8.11.3-p1a1-resident-control-7d040592ccf1f149"
DATABASE="/var/lib/stay/data/continuity.sqlite3"
DROPIN="/etc/systemd/system/stay.service.d/p1-a1-resident-control.conf"
DROPIN_SHA256="cbf8dba3a63f14ebf56ea884ad5cbbf98b8887997d226a0eccee55df7ce5c830"
NODE_BIN="$(command -v node)"

abort() { echo "ROLLBACK_A1_ENTRYPOINT_ABORT=$1" >&2; exit "${2:-201}"; }
[[ "$(readlink -f /opt/stay/current)" == "$A1_RELEASE" ]] || abort unexpected-current-release 202
[[ -f "$DROPIN" && ! -L "$DROPIN" ]] || abort exact-dropin-missing 203
[[ "$(stat -Lc '%U:%G:%a' "$DROPIN")" == "root:root:644" ]] || abort dropin-metadata-mismatch 204
[[ "$(sha256sum "$DROPIN" | awk '{print $1}')" == "$DROPIN_SHA256" ]] || abort dropin-content-mismatch 205

BEFORE="$(mktemp /run/stay-a1-entrypoint-rollback-before.XXXXXX)"
AFTER="$(mktemp /run/stay-a1-entrypoint-rollback-after.XXXXXX)"
trap 'rm -f -- "$BEFORE" "$AFTER"' EXIT
$NODE_BIN "$SCRIPT_DIR/p1-surgery-a1-state.js" capture "$DATABASE" > "$BEFORE" || abort pre-state-capture 206
PRE_PID="$(systemctl show stay.service --property=MainPID --value)"
rm -- "$DROPIN" || abort dropin-remove 207
systemctl daemon-reload || abort daemon-reload 208
ENTRYPOINT="$(systemctl show stay.service --property=ExecStart --value)"
grep -Fq '/opt/stay/current/server.js' <<<"$ENTRYPOINT" || abort legacy-entrypoint-not-restored 209
grep -Fq '/opt/stay/current/server-secure.js' <<<"$ENTRYPOINT" && abort secure-entrypoint-still-loaded 210
[[ "$(systemctl show stay.service --property=MainPID --value)" == "$PRE_PID" ]] || abort service-process-changed 211
$NODE_BIN "$SCRIPT_DIR/p1-surgery-a1-state.js" capture "$DATABASE" > "$AFTER" || abort post-state-capture 212
$NODE_BIN "$SCRIPT_DIR/p1-surgery-a1-state.js" compare "$BEFORE" "$AFTER" >/dev/null || abort continuity-compare 213

echo "ROLLBACK_A1_ENTRYPOINT_RESULT=PASS"
echo "CURRENT_RELEASE=$A1_RELEASE"
echo "ENTRYPOINT_AFTER=server.js"
echo "DROPIN_REMOVED=YES"
echo "DAEMON_RELOAD=PASS"
echo "SERVICE_RESTARTED=NO"
echo "CANONICAL_FORWARD_STATE_PRESERVED=YES"
echo "BIOLOGICAL_STATE_RESTORED=NO"
echo "STATESTORE_SCHEMA=4"
