#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"
[[ "${STAY_A1_ENTRYPOINT_WRITE_AUTHORIZED:-NO}" == "YES" ]] || {
  echo "A1_ENTRYPOINT_ABORT=authorization-missing" >&2; exit 170;
}

A1_RELEASE="/opt/stay/releases/0.8.11.3-p1a1-resident-control-7d040592ccf1f149"
DATABASE="/var/lib/stay/data/continuity.sqlite3"
DROPIN_DIR="/etc/systemd/system/stay.service.d"
DROPIN="$DROPIN_DIR/p1-a1-resident-control.conf"
DROPIN_SHA256="cbf8dba3a63f14ebf56ea884ad5cbbf98b8887997d226a0eccee55df7ce5c830"
EVIDENCE_PARENT="${1:-/var/lib/stay/evidence/live-physiology-transplant}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE_DIR="$EVIDENCE_PARENT/a1-entrypoint-$STAMP"
NODE_BIN="$(command -v node)"
TEMP_DROPIN=""

abort() { echo "A1_ENTRYPOINT_ABORT=$1" >&2; exit "${2:-171}"; }
json_field() { "$NODE_BIN" -e 'const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],JSON.parse(process.argv[1]));process.stdout.write(String(v??""))' "$1" "$2"; }
execstart() { systemctl show stay.service --property=ExecStart --value; }
write_dropin() {
  cat > "$1" <<'DROPIN'
[Service]
ExecStart=
ExecStart=/usr/bin/env node --disable-sigusr1 /opt/stay/current/server-secure.js
DROPIN
}
cleanup() { [[ -z "$TEMP_DROPIN" ]] || rm -f -- "$TEMP_DROPIN"; }
trap cleanup EXIT

[[ "$(readlink -f /opt/stay/current)" == "$A1_RELEASE" ]] || abort unexpected-current-release 172
ENTRYPOINT_BEFORE_RAW="$(execstart)"
grep -Fq '/opt/stay/current/server.js' <<<"$ENTRYPOINT_BEFORE_RAW" || abort legacy-entrypoint-not-loaded 173
grep -Fq '/opt/stay/current/server-secure.js' <<<"$ENTRYPOINT_BEFORE_RAW" && abort secure-entrypoint-already-loaded 174
[[ ! -e "$DROPIN" && ! -L "$DROPIN" ]] || abort dropin-already-present 175

install -d -o root -g root -m 0700 "$EVIDENCE_DIR"
PRE_STATE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-a1-state.js" capture "$DATABASE")" || abort pre-state-capture 176
printf '%s\n' "$PRE_STATE" > "$EVIDENCE_DIR/state-before.json"
systemctl show stay.service --property=MainPID,NRestarts,ActiveState,SubState,ExecStart --no-pager > "$EVIDENCE_DIR/service-before.txt"
printf '%s\n' "$A1_RELEASE" > "$EVIDENCE_DIR/release.txt"
PRE_HEALTH="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/healthz)" || abort pre-health 177
printf '%s\n' "$PRE_HEALTH" > "$EVIDENCE_DIR/health-before.json"

if [[ -e "$DROPIN_DIR" || -L "$DROPIN_DIR" ]]; then
  [[ -d "$DROPIN_DIR" && ! -L "$DROPIN_DIR" && "$(stat -Lc '%U:%G' "$DROPIN_DIR")" == "root:root" ]] || abort dropin-directory-invalid 178
  DROPIN_DIR_MODE="$(stat -Lc '%a' "$DROPIN_DIR")"
  (( (8#$DROPIN_DIR_MODE & 8#022) == 0 )) || abort dropin-directory-writable 178
else
  install -d -o root -g root -m 0755 "$DROPIN_DIR" || abort dropin-directory-create 178
fi
TEMP_DROPIN="$(mktemp "$DROPIN_DIR/.p1-a1-resident-control.XXXXXX")" || abort dropin-temp-create 178
write_dropin "$TEMP_DROPIN" || abort dropin-write 179
chown root:root "$TEMP_DROPIN" || abort dropin-chown 180
chmod 0644 "$TEMP_DROPIN" || abort dropin-chmod 181
[[ "$(sha256sum "$TEMP_DROPIN" | awk '{print $1}')" == "$DROPIN_SHA256" ]] || abort dropin-hash-mismatch 182
mv -fT "$TEMP_DROPIN" "$DROPIN" || abort dropin-atomic-publish 183
TEMP_DROPIN=""

systemctl daemon-reload || abort daemon-reload 184
ENTRYPOINT_LOADED="$(execstart)"
grep -Fq '/opt/stay/current/server-secure.js' <<<"$ENTRYPOINT_LOADED" || abort secure-entrypoint-not-loaded 185
grep -Fq '/opt/stay/current/server.js' <<<"$ENTRYPOINT_LOADED" && abort legacy-entrypoint-still-loaded 186
systemctl restart stay.service || abort service-restart 187

for _ in $(seq 1 60); do
  if [[ "$(systemctl show stay.service --property=ActiveState --value)" == "active" ]] &&
     curl --fail --silent --max-time 2 http://127.0.0.1:8787/healthz | grep -q '"ok":true' &&
     [[ -S /run/stay/resident-control.sock ]]; then break; fi
  sleep 1
done
[[ "$(systemctl show stay.service --property=ActiveState --value)" == "active" ]] || abort post-service-inactive 188
POST_HEALTH="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/healthz)" || abort post-health 189
[[ -S /run/stay/resident-control.sock && ! -L /run/stay/resident-control.sock ]] || abort resident-control-socket-missing 190

SNTSS_STATUS="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:sntss)" || abort sntss-status 191
CHRONO_STATUS="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:chronobiology)" || abort chronobiology-status 192
[[ "$(json_field "$SNTSS_STATUS" resident.present)" == "false" &&
   "$(json_field "$CHRONO_STATUS" resident.present)" == "false" ]] || abort unexpected-resident 193
printf '%s\n' "$SNTSS_STATUS" > "$EVIDENCE_DIR/sntss-status.json"
printf '%s\n' "$CHRONO_STATUS" > "$EVIDENCE_DIR/chronobiology-status.json"
printf '%s\n' "$POST_HEALTH" > "$EVIDENCE_DIR/health-after.json"

POST_STATE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-a1-state.js" capture "$DATABASE")" || abort post-state-capture 194
printf '%s\n' "$POST_STATE" > "$EVIDENCE_DIR/state-after.json"
COMPARE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-a1-state.js" compare "$EVIDENCE_DIR/state-before.json" "$EVIDENCE_DIR/state-after.json")" || abort continuity-compare 195
printf '%s\n' "$COMPARE" > "$EVIDENCE_DIR/continuity.json"
systemctl show stay.service --property=MainPID,NRestarts,ActiveState,SubState,ExecStart --no-pager > "$EVIDENCE_DIR/service-after.txt"
sha256sum "$DROPIN" > "$EVIDENCE_DIR/dropin.sha256"

EVIDENCE_DIGEST="sha256:$(cd "$EVIDENCE_DIR" && sha256sum ./*.json ./*.txt ./*.sha256 | LC_ALL=C sort | sha256sum | awk '{print $1}')"
printf '%s\n' "$EVIDENCE_DIGEST" > "$EVIDENCE_DIR/evidence-digest.txt"

echo "A1_ENTRYPOINT_RESULT=PASS"
echo "CURRENT_RELEASE=$A1_RELEASE"
echo "ENTRYPOINT_BEFORE=server.js"
echo "ENTRYPOINT_AFTER=server-secure.js"
echo "RESIDENT_CONTROL=READY"
echo "SERVICE_ACTIVE=YES"
echo "HEALTH=PASS"
echo "STATESTORE_SCHEMA=$(json_field "$COMPARE" schema)"
echo "SNTSS_RESIDENT_PRESENT=NO"
echo "CHRONOBIOLOGY_RESIDENT_PRESENT=NO"
echo "SNTSS_AUTHORITY=NONE"
echo "CHRONOBIOLOGY_AUTHORITY=NONE"
echo "EXISTING_FETUS_IDENTITY_CONTINUITY=PASS"
echo "ORGANISM_IDENTITY_CONTINUITY=PASS"
echo "CHECKPOINT_FORWARD_ONLY=PASS"
echo "BIOLOGICAL_AUTHORITY_OWNERSHIP_CHANGED=NO"
echo "RUNTIME_REVISION_BEFORE=$(json_field "$PRE_HEALTH" revision)"
echo "RUNTIME_REVISION_AFTER=$(json_field "$POST_HEALTH" revision)"
echo "FETUS_INSTANCE_ID=$(json_field "$COMPARE" fetus.instance_id)"
echo "FETUS_VERSION=$(json_field "$COMPARE" fetus.version)"
echo "FETUS_AUTHORITY_EPOCH=$(json_field "$COMPARE" fetus.epoch)"
echo "FETUS_BARRIER_SEQUENCE=$(json_field "$COMPARE" fetus.barrier_sequence)"
echo "FETUS_CHECKPOINT_GENERATION=$(json_field "$COMPARE" fetusCheckpointGeneration)"
echo "FETUS_CHECKPOINT_HASH=$(json_field "$COMPARE" fetusCheckpointHash)"
echo "FETUS_CHECKPOINT_HASH_CHANGED=$(json_field "$COMPARE" fetusCheckpointHashChanged)"
echo "ORGANISM_IDENTITY_HASH=$(json_field "$COMPARE" organismIdentityHash)"
echo "A1_ENTRYPOINT_EVIDENCE_DIGEST=$EVIDENCE_DIGEST"
echo "READY_FOR_SURGERY_B=YES"
echo "EVIDENCE_DIR=$EVIDENCE_DIR"
