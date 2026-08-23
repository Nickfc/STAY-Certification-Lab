#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"
[[ "${STAY_SURGERY_A1_WRITE_AUTHORIZED:-NO}" == "YES" ]] || { echo "SURGERY_A1_ABORT=authorization-missing" >&2; exit 120; }

EXPECTED_SHA="7d040592ccf1f149f0f0a170f79cf76bb5f05d92"
BASE_RELEASE="/opt/stay/releases/0.8.11.3-p1a-surgery-a-candidate-${EXPECTED_SHA}"
A1_ID="0.8.11.3-p1a1-resident-control-7d040592ccf1f149"
STAGED="${1:-}"
EVIDENCE_PARENT="${2:-/var/lib/stay/evidence/live-physiology-transplant}"
DATABASE="/var/lib/stay/data/continuity.sqlite3"
RELEASES="/opt/stay/releases"
FINAL="$RELEASES/$A1_ID"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE_DIR="$EVIDENCE_PARENT/a1-$STAMP"
NODE_BIN="$(command -v node)"

fail() { echo "SURGERY_A1_ABORT=$1" >&2; exit "${2:-121}"; }
json_field() { "$NODE_BIN" -e 'const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],JSON.parse(process.argv[1]));process.stdout.write(String(v??""))' "$1" "$2"; }

[[ "$(readlink -f /opt/stay/current)" == "$BASE_RELEASE" ]] || fail unexpected-current-release 122
[[ -d "$STAGED" && ! -L "$STAGED" && "$(basename "$STAGED")" == "$A1_ID" ]] || fail staged-release-invalid 123
install -d -o root -g root -m 0700 "$EVIDENCE_DIR"

PRE_STATE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-a1-state.js" capture "$DATABASE")" || fail pre-state-capture 124
printf '%s\n' "$PRE_STATE" > "$EVIDENCE_DIR/state-before.json"
systemctl show stay.service --property=MainPID,NRestarts,ActiveState,SubState --no-pager > "$EVIDENCE_DIR/service-before.txt"
printf '%s\n' "$BASE_RELEASE" > "$EVIDENCE_DIR/release-before.txt"

if [[ -e "$FINAL" ]]; then
  [[ -d "$FINAL" && ! -L "$FINAL" ]] || fail existing-a1-release-invalid 125
  FINAL_MANIFEST_HASH="$(sha256sum "$FINAL/P1_SURGERY_A1_MANIFEST.json" | awk '{print $1}')"
  STAGED_MANIFEST_HASH="$(sha256sum "$STAGED/P1_SURGERY_A1_MANIFEST.json" | awk '{print $1}')"
  [[ "$FINAL_MANIFEST_HASH" == "$STAGED_MANIFEST_HASH" ]] || fail existing-a1-release-mismatch 126
else
  INCOMING="$RELEASES/.${A1_ID}.incoming-$STAMP"
  [[ ! -e "$INCOMING" ]] || fail release-incoming-exists 127
  cp -a "$STAGED" "$INCOMING" || fail release-copy 128
  chown -R root:root "$INCOMING" || fail release-chown 129
  find -P "$INCOMING" -type d -exec chmod 0555 {} + || fail release-chmod-dirs 130
  find -P "$INCOMING" -type f -exec chmod 0444 {} + || fail release-chmod-files 131
  mv "$INCOMING" "$FINAL" || fail release-atomic-publish 132
fi

systemctl stop stay.service || fail service-stop 133
[[ "$(systemctl show stay.service --property=ActiveState --value)" == "inactive" ]] || fail service-not-inactive 134
ln -s "$FINAL" "/opt/stay/.current-a1-$STAMP" || fail pointer-stage 135
mv -Tf "/opt/stay/.current-a1-$STAMP" /opt/stay/current || fail pointer-switch 136
systemctl start stay.service || fail service-start 137

for _ in $(seq 1 60); do
  if [[ "$(systemctl show stay.service --property=ActiveState --value)" == "active" ]] &&
     curl --fail --silent --max-time 2 http://127.0.0.1:8787/healthz | grep -q '"ok":true' &&
     [[ -S /run/stay/resident-control.sock ]]; then break; fi
  sleep 1
done
[[ "$(systemctl show stay.service --property=ActiveState --value)" == "active" ]] || fail post-service-inactive 138
curl --fail --silent --max-time 5 http://127.0.0.1:8787/healthz | grep -q '"ok":true' || fail post-health 139
[[ -S /run/stay/resident-control.sock ]] || fail resident-control-socket-missing 140

SNTSS_STATUS="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:sntss)" || fail sntss-status 141
CHRONO_STATUS="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:chronobiology)" || fail chronobiology-status 142
[[ "$(json_field "$SNTSS_STATUS" resident.present)" == "false" &&
   "$(json_field "$CHRONO_STATUS" resident.present)" == "false" ]] || fail unexpected-resident 143
printf '%s\n' "$SNTSS_STATUS" > "$EVIDENCE_DIR/sntss-status.json"
printf '%s\n' "$CHRONO_STATUS" > "$EVIDENCE_DIR/chronobiology-status.json"

POST_STATE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-a1-state.js" capture "$DATABASE")" || fail post-state-capture 144
printf '%s\n' "$POST_STATE" > "$EVIDENCE_DIR/state-after.json"
COMPARE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-a1-state.js" compare \
  "$EVIDENCE_DIR/state-before.json" "$EVIDENCE_DIR/state-after.json")" || fail continuity-compare 145
printf '%s\n' "$COMPARE" > "$EVIDENCE_DIR/continuity.json"
systemctl show stay.service --property=MainPID,NRestarts,ActiveState,SubState --no-pager > "$EVIDENCE_DIR/service-after.txt"
printf '%s\n' "$(readlink -f /opt/stay/current)" > "$EVIDENCE_DIR/release-after.txt"

EVIDENCE_DIGEST="sha256:$(cd "$EVIDENCE_DIR" && sha256sum ./*.json ./*.txt | LC_ALL=C sort | sha256sum | awk '{print $1}')"
printf '%s\n' "$EVIDENCE_DIGEST" > "$EVIDENCE_DIR/evidence-digest.txt"

echo "A1_RESULT=PASS"
echo "POST_A1_RELEASE=$(readlink -f /opt/stay/current)"
echo "SERVICE_ACTIVE=YES"
echo "HEALTH=PASS"
echo "STATESTORE_SCHEMA=$(json_field "$COMPARE" schema)"
echo "RESIDENT_CONTROL=READY"
echo "SNTSS_RESIDENT_PRESENT=NO"
echo "CHRONOBIOLOGY_RESIDENT_PRESENT=NO"
echo "SNTSS_AUTHORITY=NONE"
echo "CHRONOBIOLOGY_AUTHORITY=NONE"
echo "EXISTING_FETUS_IDENTITY_CONTINUITY=PASS"
echo "ORGANISM_IDENTITY_CONTINUITY=PASS"
echo "CHECKPOINT_FORWARD_ONLY=PASS"
echo "BIOLOGICAL_AUTHORITY_OWNERSHIP_CHANGED=NO"
echo "FETUS_INSTANCE_ID=$(json_field "$COMPARE" fetus.instance_id)"
echo "FETUS_VERSION=$(json_field "$COMPARE" fetus.version)"
echo "FETUS_AUTHORITY_EPOCH=$(json_field "$COMPARE" fetus.epoch)"
echo "FETUS_BARRIER_SEQUENCE=$(json_field "$COMPARE" fetus.barrier_sequence)"
echo "FETUS_CHECKPOINT_GENERATION=$(json_field "$COMPARE" fetusCheckpointGeneration)"
echo "FETUS_CHECKPOINT_HASH=$(json_field "$COMPARE" fetusCheckpointHash)"
echo "FETUS_CHECKPOINT_HASH_CHANGED=$(json_field "$COMPARE" fetusCheckpointHashChanged)"
echo "ORGANISM_IDENTITY_HASH=$(json_field "$COMPARE" organismIdentityHash)"
echo "A1_EVIDENCE_DIGEST=$EVIDENCE_DIGEST"
echo "READY_FOR_SURGERY_B=YES"
echo "EVIDENCE_DIR=$EVIDENCE_DIR"
