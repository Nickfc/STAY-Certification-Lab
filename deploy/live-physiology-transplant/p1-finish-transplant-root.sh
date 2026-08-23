#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

EXPECTED_PRIVATE_IPV4='172.26.9.207'
RELEASE='/opt/stay/releases/0.8.11.3-p1a1-resident-control-7d040592ccf1f149'
DROPIN='/etc/systemd/system/stay.service.d/p1-b0-resident-runtime.conf'
HELPER='/usr/local/libexec/stay-bwrap-sandbox'
FINAL_SEAL='/etc/stay/p1-b0-sandbox-final.env'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
SOCKET='/run/stay/resident-control.sock'
CAPABILITIES='CAP_SETGID CAP_SETUID CAP_NET_ADMIN CAP_SYS_CHROOT CAP_SYS_PTRACE CAP_SYS_ADMIN'
CAP_BOUND_HEX='00000000002c10c0'
ZERO_CAP_HEX='0000000000000000'
WORK="$(mktemp -d /run/stay-p1-final-transplant.XXXXXX)"
DROPIN_CHANGED=0
ATTACH_STARTED=0

abort() { echo "FINAL_TRANSPLANT_ABORT=$1" >&2; exit "${2:-1}"; }
field() {
  node -e 'const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],JSON.parse(process.argv[1]));process.stdout.write(String(v??""))' "$1" "$2"
}
status_value() { awk -v key="$2" '$1 == key ":" { print $2 }' "/proc/$1/status"; }
resident_count() {
  node - "$DATABASE" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
db.exec('PRAGMA query_only=ON');
const row = db.prepare("SELECT COUNT(*) AS n FROM resident_instances WHERE residency_id='resident:sntss'").get();
db.close();
process.stdout.write(String(Number(row.n)));
NODE
}
restore_pre_attach() {
  local status=$?
  trap - ERR EXIT
  set +e
  if [[ "$status" -ne 0 && "$DROPIN_CHANGED" -eq 1 && "$ATTACH_STARTED" -eq 0 && "$(resident_count 2>/dev/null)" == 0 ]]; then
    install -o root -g root -m 0644 "$WORK/dropin.before" "$DROPIN"
    systemctl daemon-reload
    systemctl restart stay.service
    rm -f -- "$HELPER"
    echo 'FINAL_TRANSPLANT_REPAIR_ROLLBACK=PASS' >&2
  fi
  rm -rf --one-file-system -- "$WORK"
  exit "$status"
}
trap restore_pre_attach ERR EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 101
observed_ip="$(ip -o -4 addr show scope global | awk '{a=$4; sub(/\/.*/, "", a); print a}' | sort -u)"
[[ "$observed_ip" == "$EXPECTED_PRIVATE_IPV4" ]] || abort host-identity-mismatch 102
[[ "$(readlink -f /opt/stay/current)" == "$RELEASE" ]] || abort release-pointer-mismatch 103
[[ -f "$DROPIN" && ! -L "$DROPIN" ]] || abort dropin-invalid 104
[[ ! -e "$HELPER" && ! -L "$HELPER" ]] || abort helper-already-exists 105
[[ ! -e "$FINAL_SEAL" && ! -L "$FINAL_SEAL" ]] || abort final-seal-already-exists 106
[[ -S "$SOCKET" && ! -L "$SOCKET" ]] || abort resident-control-unavailable 107

pre_health="$(curl -fsS --max-time 5 http://127.0.0.1:8787/healthz)" || abort pre-health 108
[[ "$(field "$pre_health" ok)" == true && "$(field "$pre_health" version)" == 0.8.11.3 ]] || abort pre-health-contract 109
pre_revision="$(field "$pre_health" revision)"
pre_pid="$(systemctl show stay.service -p MainPID --value)"
pre_restarts="$(systemctl show stay.service -p NRestarts --value)"
pre_pointer="$(readlink -f /opt/stay/current)"
[[ "$(resident_count)" == 0 ]] || abort sntss-already-present 110

node - "$DATABASE" <<'NODE' || exit 111
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
db.exec('PRAGMA query_only=ON');
const authority = Number(db.prepare("SELECT COUNT(*) AS n FROM authority WHERE core_id IN ('sntss','chronobiology')").get().n);
const residents = Number(db.prepare("SELECT COUNT(*) AS n FROM resident_instances").get().n);
db.close();
if (authority !== 0 || residents !== 0) process.exit(1);
NODE

install -o root -g root -m 0600 "$DROPIN" "$WORK/dropin.before"
bwrap_source="$(readlink -f /usr/bin/bwrap)"
[[ -f "$bwrap_source" && ! -L "$bwrap_source" && -x "$bwrap_source" && "$(stat -Lc '%U:%G:%h' "$bwrap_source")" == root:root:1 ]] || abort bwrap-source-invalid 112
bwrap_hash="$(sha256sum "$bwrap_source" | awk '{print $1}')"
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g staydeploy -m 4750 "$bwrap_source" "$HELPER"
[[ "$(sha256sum "$HELPER" | awk '{print $1}')" == "$bwrap_hash" ]] || abort helper-hash-mismatch 113
[[ "$(stat -Lc '%U:%G:%a:%h' "$HELPER")" == root:staydeploy:4750:1 ]] || abort helper-permissions 114

cat > "$WORK/dropin.next" <<EOF
[Service]
NoNewPrivileges=false
CapabilityBoundingSet=$CAPABILITIES
Environment=STAY_REQUIRE_OS_CORE_SANDBOX=1
Environment=STAY_BWRAP=$HELPER
Environment=STAY_REQUIRE_CORE_PACKAGE_POLICY=1
Environment=STAY_REQUIRE_CORE_PROMOTION_CERT=1
Environment=STAY_CORE_PROMOTION_PUBLIC_KEY=/etc/stay/release-authority.pub
Environment=STAY_CORE_PROMOTION_CERT_DIR=/etc/stay/core-promotions
Environment=STAY_RESIDENT_PROMOTION_CERT_DIR=/etc/stay/resident-promotions
Environment=STAY_TRUSTED_TIME_PULSE_INTERVAL_MS=25
EOF
install -o root -g root -m 0644 "$WORK/dropin.next" "$DROPIN"
DROPIN_CHANGED=1
dropin_hash="$(sha256sum "$DROPIN" | awk '{print $1}')"

systemctl daemon-reload
systemctl restart stay.service
for _ in $(seq 1 90); do
  post_health="$(curl -fsS --max-time 2 http://127.0.0.1:8787/healthz 2>/dev/null || true)"
  [[ -n "$post_health" && "$(field "$post_health" ok 2>/dev/null || true)" == true ]] && break
  sleep 1
done
[[ -n "${post_health:-}" && "$(field "$post_health" ok)" == true ]] || abort repaired-service-health 115
post_pid="$(systemctl show stay.service -p MainPID --value)"
[[ "$post_pid" =~ ^[1-9][0-9]*$ && "$post_pid" != "$pre_pid" ]] || abort repaired-service-incarnation 116
[[ "$(systemctl show stay.service -p ActiveState --value)" == active &&
   "$(systemctl show stay.service -p SubState --value)" == running &&
   "$(systemctl show stay.service -p NRestarts --value)" == 0 &&
   "$(systemctl show stay.service -p NoNewPrivileges --value)" == no ]] || abort repaired-service-contract 117
for capability_field in CapPrm CapEff CapAmb; do
  [[ "$(status_value "$post_pid" "$capability_field")" == "$ZERO_CAP_HEX" ]] || abort "service-${capability_field}-not-empty" 118
done
[[ "$(status_value "$post_pid" CapBnd)" == "$CAP_BOUND_HEX" && "$(status_value "$post_pid" NoNewPrivs)" == 0 ]] || abort repaired-capability-envelope 119
[[ "$(readlink -f /opt/stay/current)" == "$pre_pointer" ]] || abort pointer-changed-during-repair 120

probe="$(runuser -u staydeploy -- env -i \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  NODE_ENV=production STAY_REQUIRE_OS_CORE_SANDBOX=1 STAY_BWRAP="$HELPER" \
  STAY_REQUIRE_CORE_PACKAGE_POLICY=1 \
  node - "$RELEASE" <<'NODE'
'use strict';
const root = process.argv[2];
require(root + '/runtime/kernel/core-loader.js')
  .inspectCoreModule(root + '/cores/sntss/i3d/index.js')
  .then(result => console.log('LIVE_USER_CORE_INSPECT=PASS\nVERSION=' + result.manifest.version))
  .catch(error => {
    console.error('ERROR_CODE=' + String(error?.code || 'UNKNOWN'));
    console.error('ERROR_MESSAGE=' + String(error?.message || error).replace(/\r?\n/g, ' | ').slice(0, 2048));
    process.exitCode = 1;
  });
NODE
)" || abort setuid-bwrap-probe-failed 121
grep -Fx 'LIVE_USER_CORE_INSPECT=PASS' <<<"$probe" >/dev/null || abort setuid-bwrap-probe-marker 122
grep -Fx 'VERSION=0.4.0-i3d3' <<<"$probe" >/dev/null || abort setuid-bwrap-probe-version 123

control() {
  node - "$1" "$2" <<'NODE'
'use strict';
const net = require('node:net');
const operation = process.argv[2];
const residencyId = process.argv[3];
const socket = net.createConnection('/run/stay/resident-control.sock');
socket.setEncoding('utf8');
let body = '';
let done = false;
let keepalive;
const deadline = setTimeout(() => socket.destroy(Object.assign(new Error('deadline'), { code: 'RESIDENT_CONTROL_DEADLINE' })), 120000);
function finish(error) {
  if (done) return;
  done = true;
  clearTimeout(deadline);
  clearInterval(keepalive);
  if (!error) {
    try {
      const response = JSON.parse(body);
      if (response.ok !== true) throw Object.assign(new Error('denied'), { code: response.code || 'RESIDENT_CONTROL_DENIED' });
      process.stdout.write(JSON.stringify(response) + '\n');
      return;
    } catch (caught) { error = caught; }
  }
  console.error('RESIDENT_CONTROL_CLIENT_ABORT=' + String(error?.code || 'FAILED'));
  process.exitCode = 1;
}
socket.once('connect', () => {
  socket.write(JSON.stringify({ format: 'stay-resident-control-v1', operation, residencyId }) + '\n');
  keepalive = setInterval(() => { if (!socket.destroyed && socket.writable) socket.write(' '); }, 750);
});
socket.on('data', chunk => { body += chunk; });
socket.once('end', () => finish());
socket.once('error', finish);
NODE
}

before_sntss="$(control status resident:sntss)" || abort sntss-status-before 124
before_chrono="$(control status resident:chronobiology)" || abort chronobiology-status-before 125
[[ "$(field "$before_sntss" resident.present)" == false && "$(field "$before_chrono" resident.present)" == false ]] || abort resident-precondition-changed 126

ATTACH_STARTED=1
attach="$(control attach resident:sntss)" || abort attach-failed 127
[[ "$(field "$attach" resident.residencyId)" == resident:sntss ]] || abort attach-residency 128
initial_generation="$(field "$attach" resident.checkpointGeneration)"
initial_events="$(field "$attach" resident.handledEvents)"
sntss="$attach"
for _ in $(seq 1 240); do
  sntss="$(control status resident:sntss)" || true
  if [[ -n "$sntss" && "$(field "$sntss" resident.running)" == true ]] &&
     (( $(field "$sntss" resident.checkpointGeneration) >= initial_generation + 3 )) &&
     (( $(field "$sntss" resident.handledEvents) >= initial_events + 3 )); then
    break
  fi
  sleep 1
done

[[ "$(field "$sntss" resident.version)" == 0.4.0-i3d3 &&
   "$(field "$sntss" resident.stateSchema)" == 4 &&
   "$(field "$sntss" resident.status)" == RUNNING &&
   "$(field "$sntss" resident.running)" == true &&
   "$(field "$sntss" resident.signalling)" == FORBIDDEN &&
   "$(field "$sntss" resident.productionEligible)" == false &&
   "$(field "$sntss" resident.declaredOutputs)" == 0 &&
   "$(field "$sntss" resident.observedOutputs)" == 0 &&
   "$(field "$sntss" resident.authorityOwned)" == false &&
   "$(field "$sntss" resident.health.ok)" == true ]] || abort resident-contract 129
(( $(field "$sntss" resident.checkpointGeneration) >= initial_generation + 3 )) || abort checkpoint-smoke 130
(( $(field "$sntss" resident.handledEvents) >= initial_events + 3 )) || abort pulse-smoke 131

chrono="$(control status resident:chronobiology)" || abort chronobiology-status-after 132
[[ "$(field "$chrono" resident.present)" == false && "$(field "$chrono" resident.authorityOwned)" == false ]] || abort chronobiology-activated 133

db_result="$(node - "$DATABASE" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
db.exec('PRAGMA query_only=ON');
const authority = Number(db.prepare("SELECT COUNT(*) AS n FROM authority WHERE core_id IN ('sntss','chronobiology')").get().n);
const resident = Number(db.prepare("SELECT COUNT(*) AS n FROM resident_instances WHERE residency_id='resident:sntss' AND core_id='sntss' AND version='0.4.0-i3d3' AND state_schema=4 AND status='RUNNING'").get().n);
db.close();
console.log(JSON.stringify({ authority, resident }));
NODE
)"
[[ "$(field "$db_result" authority)" == 0 && "$(field "$db_result" resident)" == 1 ]] || abort durable-state-contract 134

meta="$(curl -fsS --max-time 5 http://127.0.0.1:8787/__stay/meta)" || abort final-meta 135
fetus="$(node -e 'const m=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(m.cores?.find(x=>x.id==="fetus-legacy")||null))' "$meta")"
[[ "$(field "$fetus" ok)" == true && "$(field "$fetus" version)" == 0.6.0 ]] || abort fetus-continuity 136
final_health="$(curl -fsS --max-time 5 http://127.0.0.1:8787/healthz)" || abort final-health 137
[[ "$(field "$final_health" ok)" == true && "$(readlink -f /opt/stay/current)" == "$pre_pointer" ]] || abort final-runtime-contract 138
[[ "$(systemctl show stay.service -p MainPID --value)" == "$post_pid" && "$(systemctl show stay.service -p NRestarts --value)" == 0 ]] || abort service-changed-after-attach 139

seal_tmp="$(mktemp /etc/stay/.p1-b0-sandbox-final.XXXXXX)"
cat > "$seal_tmp" <<EOF
P1_B0_SANDBOX_FINAL_FORMAT=stay-p1-b0-sandbox-final-v1
HELPER=$HELPER
HELPER_SHA256=$bwrap_hash
DROPIN_SHA256=$dropin_hash
SERVICE_MAIN_PID=$post_pid
RUNTIME_REVISION=$(field "$final_health" revision)
SERVICE_PERMITTED_CAPABILITIES=NONE
SERVICE_EFFECTIVE_CAPABILITIES=NONE
SERVICE_AMBIENT_CAPABILITIES=NONE
NO_NEW_PRIVILEGES=NO_SETUID_BWRAP_BOUNDARY
CAPABILITY_BOUNDING_HEX=$CAP_BOUND_HEX
SNTSS_RESIDENCY_ID=resident:sntss
SNTSS_VERSION=0.4.0-i3d3
SNTSS_STATE_SCHEMA=4
SNTSS_AUTHORITY=NONE
CHRONOBIOLOGY_ACTIVATED=NO
EOF
chown root:root "$seal_tmp"
chmod 0444 "$seal_tmp"
mv -nT "$seal_tmp" "$FINAL_SEAL"

result_path='/var/lib/stay/evidence/live-physiology-transplant/p1-final-transplant-result.env'
result_tmp="$(mktemp /var/lib/stay/evidence/live-physiology-transplant/.p1-final-transplant-result.XXXXXX)"
cat > "$result_tmp" <<EOF
FINAL_TRANSPLANT_RESULT=PASS
SURGERY_B_RESULT=PASS
RUNTIME_REVISION_BEFORE=$pre_revision
RUNTIME_REVISION_AFTER=$(field "$final_health" revision)
SANDBOX_REPAIR=SETUID_BWRAP_GROUP_RESTRICTED
BWRAP_HELPER_SHA256=sha256:$bwrap_hash
SERVICE_RESTARTED=YES_SANDBOX_REPAIR_ONLY
CURRENT_POINTER_CHANGE=NO
SNTSS_RESIDENCY_ID=resident:sntss
SNTSS_VERSION=0.4.0-i3d3
SNTSS_STATE_SCHEMA=4
SNTSS_STATUS=ACTIVE_NEUTRAL_RESIDENT
SNTSS_OUTPUT_COUNT=0
SNTSS_SIGNALLING=FORBIDDEN
SNTSS_AUTHORITY=NONE
SNTSS_PRODUCTION_ELIGIBLE=NO
CHECKPOINT_GENERATION=$(field "$sntss" resident.checkpointGeneration)
HANDLED_EVENTS=$(field "$sntss" resident.handledEvents)
FETUS_CONTINUITY=PASS
CHRONOBIOLOGY_ACTIVATED=NO
BIOLOGICAL_AUTHORITY_CHANGED=NO
EOF
chown root:staydeploy "$result_tmp"
chmod 0440 "$result_tmp"
mv -fT "$result_tmp" "$result_path"

trap - ERR EXIT
rm -rf --one-file-system -- "$WORK"
cat "$result_path"
script_dir="$(dirname -- "$(readlink -f -- "$0")")"
if [[ "$script_dir" =~ ^/opt/stay/incoming/p1-final-transplant-[0-9]+$ && -d "$script_dir" && ! -L "$script_dir" ]]; then
  rm -rf --one-file-system -- "$script_dir"
fi
