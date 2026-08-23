#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"
[[ "${STAY_SURGERY_B_AUTHORIZED:-NO}" == YES ]] || { echo "SURGERY_B_ABORT=authorization-missing" >&2; exit 250; }
A1_RELEASE="/opt/stay/releases/0.8.11.3-p1a1-resident-control-7d040592ccf1f149"
DATABASE="/var/lib/stay/data/continuity.sqlite3"
NODE_BIN="$(command -v node)"
EVIDENCE_PARENT="${1:-/var/lib/stay/evidence/live-physiology-transplant}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE_DIR="$EVIDENCE_PARENT/surgery-b-$STAMP"
abort() { echo "SURGERY_B_ABORT=$1" >&2; exit "${2:-251}"; }
json_field() { "$NODE_BIN" -e 'const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],JSON.parse(process.argv[1]));process.stdout.write(String(v??""))' "$1" "$2"; }

"$SCRIPT_DIR/p1-surgery-b-preflight.sh" || abort preflight-failed 252
install -d -o root -g root -m 0700 "$EVIDENCE_DIR"
PRE_STATE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-b-state.js" capture "$DATABASE")" || abort pre-state-capture 253
printf '%s\n' "$PRE_STATE" > "$EVIDENCE_DIR/state-before.json"
PRE_PID="$(systemctl show stay.service -p MainPID --value)"
PRE_RESTARTS="$(systemctl show stay.service -p NRestarts --value)"
PRE_POINTER="$(readlink -f /opt/stay/current)"
PRE_HEALTH="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/healthz)" || abort pre-health 254
printf '%s\n' "$PRE_HEALTH" > "$EVIDENCE_DIR/health-before.json"
systemctl show stay.service -p MainPID,NRestarts,ActiveState,SubState,ExecStart --no-pager > "$EVIDENCE_DIR/service-before.txt"

ATTACH="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" attach resident:sntss)" || abort attach-failed 255
printf '%s\n' "$ATTACH" > "$EVIDENCE_DIR/attach.json"
[[ "$(json_field "$ATTACH" resident.residencyId)" == resident:sntss &&
   "$(json_field "$ATTACH" resident.version)" == 0.4.0-i3d3 &&
   "$(json_field "$ATTACH" resident.stateSchema)" == 4 &&
   "$(json_field "$ATTACH" resident.status)" == RUNNING &&
   "$(json_field "$ATTACH" resident.running)" == true &&
   "$(json_field "$ATTACH" resident.declaredOutputs)" == 0 &&
   "$(json_field "$ATTACH" resident.observedOutputs)" == 0 &&
   "$(json_field "$ATTACH" resident.authorityOwned)" == false ]] || abort attach-contract-mismatch 256
INITIAL_CHECKPOINT_HASH="$(json_field "$ATTACH" resident.checkpointHash)"
INITIAL_CHECKPOINT_GENERATION="$(json_field "$ATTACH" resident.checkpointGeneration)"

STATUS=""
for _ in $(seq 1 240); do
  STATUS="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:sntss 2>/dev/null || true)"
  if [[ -n "$STATUS" ]] &&
     [[ "$(json_field "$STATUS" resident.present)" == true && "$(json_field "$STATUS" resident.running)" == true ]] &&
     (( $(json_field "$STATUS" resident.handledEvents) >= 3 )) &&
     (( $(json_field "$STATUS" resident.checkpointGeneration) >= INITIAL_CHECKPOINT_GENERATION + 3 )); then break; fi
  sleep 1
done
[[ -n "$STATUS" ]] || abort smoke-status-missing 257
[[ "$(json_field "$STATUS" resident.running)" == true && "$(json_field "$STATUS" resident.status)" == RUNNING ]] || abort resident-not-running 258
(( $(json_field "$STATUS" resident.handledEvents) >= 3 )) || abort pulse-smoke-insufficient 259
[[ "$(json_field "$STATUS" resident.declaredOutputs)" == 0 && "$(json_field "$STATUS" resident.observedOutputs)" == 0 && "$(json_field "$STATUS" resident.authorityOwned)" == false ]] || abort neutrality-violation 260
[[ "$(json_field "$STATUS" resident.health.ok)" == true ]] || abort resident-unhealthy 261
printf '%s\n' "$STATUS" > "$EVIDENCE_DIR/sntss-final-status.json"
CHRONO="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:chronobiology)" || abort chronobiology-status 262
[[ "$(json_field "$CHRONO" resident.present)" == false ]] || abort chronobiology-present 263
printf '%s\n' "$CHRONO" > "$EVIDENCE_DIR/chronobiology-status.json"

POST_STATE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-b-state.js" capture "$DATABASE")" || abort post-state-capture 264
printf '%s\n' "$POST_STATE" > "$EVIDENCE_DIR/state-after.json"
COMPARE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-b-state.js" compare-surgery "$EVIDENCE_DIR/state-before.json" "$EVIDENCE_DIR/state-after.json")" || abort continuity-failed 265
printf '%s\n' "$COMPARE" > "$EVIDENCE_DIR/continuity.json"
POST_HEALTH="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/healthz)" || abort post-health 266
POST_META="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/__stay/meta)" || abort post-meta 267
"$NODE_BIN" -e 'const m=JSON.parse(process.argv[1]);const f=m.cores?.find(x=>x.id==="fetus-legacy");if(m.ok!==true||!f||f.ok!==true||f.version!=="0.6.0")process.exit(1)' "$POST_META" || abort fetus-health-failed 268
printf '%s\n' "$POST_HEALTH" > "$EVIDENCE_DIR/health-after.json"
printf '%s\n' "$POST_META" > "$EVIDENCE_DIR/meta-after.json"
[[ "$(readlink -f /opt/stay/current)" == "$PRE_POINTER" && "$PRE_POINTER" == "$A1_RELEASE" ]] || abort pointer-changed 269
[[ "$(systemctl show stay.service -p MainPID --value)" == "$PRE_PID" && "$(systemctl show stay.service -p NRestarts --value)" == "$PRE_RESTARTS" ]] || abort service-restarted 270
systemctl show stay.service -p MainPID,NRestarts,ActiveState,SubState,ExecStart --no-pager > "$EVIDENCE_DIR/service-after.txt"
EVIDENCE_DIGEST="sha256:$(cd "$EVIDENCE_DIR" && sha256sum ./*.json ./*.txt | LC_ALL=C sort | sha256sum | awk '{print $1}')"
printf '%s\n' "$EVIDENCE_DIGEST" > "$EVIDENCE_DIR/evidence-digest.txt"

echo "SURGERY_B_RESULT=PASS"
echo "CURRENT_RELEASE=$A1_RELEASE"
echo "SERVICE_RESTARTED=NO"
echo "CURRENT_POINTER_CHANGE=NO"
echo "STATESTORE_SCHEMA=4"
echo "SNTSS_RESIDENCY_ID=resident:sntss"
echo "SNTSS_VERSION=0.4.0-i3d3"
echo "SNTSS_STATE_SCHEMA=4"
echo "SNTSS_PACKAGE_POLICY_HASH=sha256:5708b07f711f4d681c67c518e34450d57559b6fe51316060d1c83bd2c8a46765"
echo "SNTSS_STATUS=ACTIVE_NEUTRAL_RESIDENT"
echo "SNTSS_OUTPUT_COUNT=0"
echo "SNTSS_SIGNALLING=FORBIDDEN"
echo "SNTSS_AUTHORITY=NONE"
echo "SNTSS_PRODUCTION_ELIGIBLE=NO"
echo "INITIAL_CHECKPOINT_HASH=$INITIAL_CHECKPOINT_HASH"
echo "FINAL_SMOKE_CHECKPOINT_HASH=$(json_field "$STATUS" resident.checkpointHash)"
echo "CHECKPOINT_GENERATION=$(json_field "$STATUS" resident.checkpointGeneration)"
echo "RESIDENT_TRANSITION_SEQUENCE=$(json_field "$COMPARE" residentTransitionSequence)"
echo "PULSE_ACK_COUNT=$(json_field "$COMPARE" pulseAckCount)"
echo "AUTHORITY_BEFORE_HASH=$(json_field "$COMPARE" authorityBeforeHash)"
echo "AUTHORITY_AFTER_HASH=$(json_field "$COMPARE" authorityAfterHash)"
echo "FETUS_CONTINUITY=PASS"
echo "SERVICE_ACTIVE=YES"
echo "HEALTH=PASS"
echo "CHRONOBIOLOGY_ACTIVATED=NO"
echo "BIOLOGICAL_AUTHORITY_CHANGED=NO"
echo "SURGERY_B_EVIDENCE_DIGEST=$EVIDENCE_DIGEST"
echo "EVIDENCE_DIR=$EVIDENCE_DIR"
