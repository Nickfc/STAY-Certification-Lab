#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"
[[ "${STAY_ROLLBACK_B_AUTHORIZED:-NO}" == YES ]] || { echo "ROLLBACK_B_ABORT=authorization-missing" >&2; exit 280; }
A1_RELEASE="/opt/stay/releases/0.8.11.3-p1a1-resident-control-7d040592ccf1f149"
DATABASE="/var/lib/stay/data/continuity.sqlite3"
NODE_BIN="$(command -v node)"
EVIDENCE_PARENT="${1:-/var/lib/stay/evidence/live-physiology-transplant}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE_DIR="$EVIDENCE_PARENT/rollback-b-$STAMP"
abort() { echo "ROLLBACK_B_ABORT=$1" >&2; exit "${2:-281}"; }
json_field() { "$NODE_BIN" -e 'const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],JSON.parse(process.argv[1]));process.stdout.write(String(v??""))' "$1" "$2"; }

[[ "$(readlink -f /opt/stay/current)" == "$A1_RELEASE" ]] || abort unexpected-current-release 282
[[ "$(systemctl show stay.service -p ActiveState --value)" == active && -S /run/stay/resident-control.sock ]] || abort service-or-socket-unavailable 283
install -d -o root -g root -m 0700 "$EVIDENCE_DIR"
PRE_STATE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-b-state.js" capture "$DATABASE")" || abort pre-state-capture 284
printf '%s\n' "$PRE_STATE" > "$EVIDENCE_DIR/state-before.json"
PRE_STATUS="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:sntss)" || abort pre-status 285
[[ "$(json_field "$PRE_STATUS" resident.present)" == true && "$(json_field "$PRE_STATUS" resident.running)" == true && "$(json_field "$PRE_STATUS" resident.authorityOwned)" == false ]] || abort sntss-not-running-neutral 286
CHRONO="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:chronobiology)" || abort chronobiology-status 287
[[ "$(json_field "$CHRONO" resident.present)" == false ]] || abort chronobiology-present 288
PRE_PID="$(systemctl show stay.service -p MainPID --value)"; PRE_RESTARTS="$(systemctl show stay.service -p NRestarts --value)"; PRE_REVISION="$(curl -fsS http://127.0.0.1:8787/healthz | "$NODE_BIN" -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>process.stdout.write(String(JSON.parse(s).revision)))')"

DETACH="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" detach resident:sntss)" || abort detach-failed 289
printf '%s\n' "$DETACH" > "$EVIDENCE_DIR/detach.json"
[[ "$(json_field "$DETACH" statePreserved)" == true && "$(json_field "$DETACH" resident.present)" == true &&
   "$(json_field "$DETACH" resident.status)" == DETACHED && "$(json_field "$DETACH" resident.running)" == false ]] || abort detach-contract-mismatch 290
POST_STATE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-b-state.js" capture "$DATABASE")" || abort post-state-capture 291
printf '%s\n' "$POST_STATE" > "$EVIDENCE_DIR/state-after.json"
COMPARE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-b-state.js" compare-rollback "$EVIDENCE_DIR/state-before.json" "$EVIDENCE_DIR/state-after.json")" || abort continuity-failed 292
printf '%s\n' "$COMPARE" > "$EVIDENCE_DIR/continuity.json"
[[ "$(readlink -f /opt/stay/current)" == "$A1_RELEASE" && "$(systemctl show stay.service -p MainPID --value)" == "$PRE_PID" && "$(systemctl show stay.service -p NRestarts --value)" == "$PRE_RESTARTS" ]] || abort service-or-pointer-changed 293
POST_HEALTH="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/healthz)" || abort health-failed 294
[[ "$(json_field "$POST_HEALTH" revision)" == "$PRE_REVISION" ]] || abort runtime-revision-changed 295
printf '%s\n' "$POST_HEALTH" > "$EVIDENCE_DIR/health-after.json"
EVIDENCE_DIGEST="sha256:$(cd "$EVIDENCE_DIR" && sha256sum ./*.json | LC_ALL=C sort | sha256sum | awk '{print $1}')"
printf '%s\n' "$EVIDENCE_DIGEST" > "$EVIDENCE_DIR/evidence-digest.txt"

echo "ROLLBACK_B_RESULT=PASS"
echo "CURRENT_RELEASE=$A1_RELEASE"
echo "SNTSS_STATUS=DETACHED_STATE_PRESERVED"
echo "LATEST_SNTSS_CHECKPOINT_HASH=$(json_field "$COMPARE" checkpointHash)"
echo "LATEST_SNTSS_CHECKPOINT_GENERATION=$(json_field "$COMPARE" checkpointGeneration)"
echo "CANONICAL_FORWARD_STATE_PRESERVED=YES"
echo "BIOLOGICAL_STATE_RESTORED=NO"
echo "STATESTORE_SCHEMA=4"
echo "SURGERY_A_BSF_PRESERVED=YES"
echo "SERVICE_RESTARTED=NO"
echo "CURRENT_POINTER_CHANGE=NO"
echo "FETUS_AUTHORITY_CHANGED=NO"
echo "CHRONOBIOLOGY_ACTIVATED=NO"
echo "BIOLOGICAL_AUTHORITY_CHANGED=NO"
echo "HEALTH=PASS"
echo "ROLLBACK_B_EVIDENCE_DIGEST=$EVIDENCE_DIGEST"
echo "EVIDENCE_DIR=$EVIDENCE_DIR"
