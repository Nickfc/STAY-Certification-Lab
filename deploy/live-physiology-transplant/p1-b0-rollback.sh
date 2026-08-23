#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"; "$SCRIPT_DIR/p1-host-identity-guard.sh"
[[ "${STAY_B0_ROLLBACK_AUTHORIZED:-NO}" == YES ]] || { echo "ROLLBACK_B0_ABORT=authorization-missing" >&2; exit 290; }
DATABASE=/var/lib/stay/data/continuity.sqlite3; A1_RELEASE=/opt/stay/releases/0.8.11.3-p1a1-resident-control-7d040592ccf1f149
[[ "$(readlink -f /opt/stay/current)" == "$A1_RELEASE" ]] || { echo "ROLLBACK_B0_ABORT=current-release-mismatch" >&2; exit 291; }
"$SCRIPT_DIR/p1-b0-state.js" capture "$DATABASE" > /run/stay-p1-b0-rollback-before.json
SNTSS="$($SCRIPT_DIR/p1-resident-control-client.js status resident:sntss)"; CHRONO="$($SCRIPT_DIR/p1-resident-control-client.js status resident:chronobiology)"
node -e 'for(const x of process.argv.slice(1)){if(JSON.parse(x).resident.present)process.exit(1)}' "$SNTSS" "$CHRONO" || { echo "ROLLBACK_B0_ABORT=resident-present" >&2; exit 292; }
rm -f -- /etc/systemd/system/stay.service.d/p1-b0-resident-runtime.conf /etc/stay/p1-b0-baseline.env /etc/stay/resident-promotions/resident-sntss.json /etc/stay/release-authority.pub
systemctl daemon-reload; systemctl restart stay.service
for _ in $(seq 1 80); do [[ "$(systemctl is-active stay.service 2>/dev/null || true)" == active && -S /run/stay/resident-control.sock ]] && break; sleep 0.25; done
[[ "$(systemctl is-active stay.service)" == active && -S /run/stay/resident-control.sock ]] || { echo "ROLLBACK_B0_ABORT=restart-failed" >&2; exit 293; }
"$SCRIPT_DIR/p1-b0-state.js" capture "$DATABASE" > /run/stay-p1-b0-rollback-after.json
"$SCRIPT_DIR/p1-b0-state.js" compare /run/stay-p1-b0-rollback-before.json /run/stay-p1-b0-rollback-after.json >/dev/null || { echo "ROLLBACK_B0_ABORT=forward-continuity-failed" >&2; exit 294; }
rm -f /run/stay-p1-b0-rollback-before.json /run/stay-p1-b0-rollback-after.json
echo "ROLLBACK_B0_RESULT=PASS"
echo "CANONICAL_FORWARD_STATE_PRESERVED=YES"
echo "BIOLOGICAL_STATE_RESTORED=NO"
echo "SNTSS_ATTACHED=NO"
echo "CHRONOBIOLOGY_ATTACHED=NO"
