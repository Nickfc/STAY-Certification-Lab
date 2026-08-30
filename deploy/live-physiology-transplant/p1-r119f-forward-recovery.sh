#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

EXPECTED_PRIVATE_IPV4='172.26.9.207'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
RECOVERY_MARKER='/run/stay-r119f-forward-recovery.env'
RECOVERY_DROPIN='/etc/systemd/system/stay.service.d/p1-r119-chronobiology-recovery-once.conf'
EVIDENCE_ROOT='/var/lib/stay/evidence/production-hardening'

: "${STAY_R119F_RELEASE_TAG:?}"
: "${STAY_R119F_RELEASE_COMMIT:?}"
: "${STAY_R119F_RELEASE_TREE:?}"
: "${STAY_R119F_ARCHIVE_SHA256:?}"
: "${STAY_R119F_MANIFEST_SHA256:?}"
: "${STAY_R119F_CONTROLLER_SHA256:?}"

WORK=''
DROPIN_CREATED=0
COMPLETED=0

abort() {
  echo "R119F_FORWARD_RECOVERY_ABORT=$1" >&2
  exit "${2:-1}"
}

json_field() {
  node -e 'const value=process.argv[2].split(".").reduce((object,key)=>object?.[key],JSON.parse(process.argv[1]));process.stdout.write(String(value??""))' "$1" "$2"
}

durable_runtime_revision() {
  STAY_DATABASE="$DATABASE" node <<'NODE'
'use strict';
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(process.env.STAY_DATABASE, { readOnly: true });
try {
  database.exec('PRAGMA query_only=ON');
  const row = database.prepare("SELECT json, sha256 FROM metadata WHERE key='life:runtime-revision'").get();
  if (!row || crypto.createHash('sha256').update(row.json).digest('hex') !== row.sha256) process.exit(2);
  const revision = Number(JSON.parse(row.json).revision);
  if (!Number.isSafeInteger(revision)) process.exit(3);
  process.stdout.write(String(revision));
} finally { database.close(); }
NODE
}

validate_repair_state() {
  STAY_DATABASE="$DATABASE" STAY_RELEASE="$R119F_RELEASE" node <<'NODE'
'use strict';
const { DatabaseSync } = require('node:sqlite');
const { BASELINE, REPAIR } = require(
  process.env.STAY_RELEASE + '/deploy/live-physiology-transplant/p1-r119f-chronobiology-bounded-catchup-repair.js');
const database = new DatabaseSync(process.env.STAY_DATABASE, { readOnly: true });
try {
  database.exec('PRAGMA query_only=ON');
  if (String(database.prepare('PRAGMA quick_check').get()?.quick_check || '').toLowerCase() !== 'ok') process.exit(1);
  const resident = database.prepare('SELECT * FROM resident_instances WHERE residency_id=?')
    .get(BASELINE.residencyId);
  const consumer = database.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?')
    .get(BASELINE.residencyId);
  const checkpoint = database.prepare(`
    SELECT * FROM resident_checkpoints WHERE residency_id=? AND generation=?
  `).get(BASELINE.residencyId, REPAIR.checkpointGeneration);
  const count = sql => Number(database.prepare(sql).get()?.value || 0);
  if (!(resident?.instance_id === BASELINE.instanceId
    && resident?.version === REPAIR.version
    && Number(resident?.state_schema) === REPAIR.stateSchema
    && resident?.module_relative_path === REPAIR.moduleRelativePath
    && resident?.module_hash === REPAIR.moduleHash
    && resident?.manifest_hash === REPAIR.manifestHash
    && resident?.package_policy_hash === REPAIR.packagePolicyHash
    && Number(resident?.checkpoint_generation) >= REPAIR.checkpointGeneration
    && ['RESYNC_REQUIRED', 'RUNNING'].includes(resident?.status)
    && consumer?.consumer_id === BASELINE.residencyId
    && Number(consumer?.required) === 0
    && Number(consumer?.authority_epoch) === 0
    && checkpoint?.checkpoint_id === REPAIR.checkpointId
    && checkpoint?.instance_id === BASELINE.instanceId
    && checkpoint?.version === REPAIR.version
    && checkpoint?.blob_hash === BASELINE.checkpointHash
    && Number(checkpoint?.byte_length) === BASELINE.checkpointByteLength
    && Number(checkpoint?.input_cursor) === BASELINE.checkpointInputCursor
    && count("SELECT COUNT(*) value FROM biological_deliveries WHERE consumer_id='resident:chronobiology' AND status='PENDING'") === 0
    && count("SELECT COUNT(*) value FROM biological_outbox_intents WHERE status='PENDING'") === 0
    && count("SELECT COUNT(*) value FROM authority WHERE core_id='chronobiology'") === 0)) process.exit(1);
} finally { database.close(); }
NODE
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$DROPIN_CREATED" -eq 1 && -f "$RECOVERY_DROPIN" && ! -L "$RECOVERY_DROPIN" ]]; then
    rm -f -- "$RECOVERY_DROPIN"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  [[ -n "$WORK" && -d "$WORK" ]] && rm -rf --one-file-system -- "$WORK"
  exit "$status"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 1901
[[ "${STAY_R119F_RECOVERY_AUTHORIZATION:-}" == \
  'COMPLETE_REVISION_FENCED_R119F_WITH_AT_MOST_ONE_START' ]] ||
  abort authorization-required 1902
[[ -f "$RECOVERY_MARKER" && ! -L "$RECOVERY_MARKER" \
  && "$(stat -Lc '%U:%G:%a' "$RECOVERY_MARKER")" == root:root:600 ]] ||
  abort recovery-marker-invalid 1903
# shellcheck disable=SC1090
source "$RECOVERY_MARKER"
[[ "$R119F_FAILURE_EVIDENCE" == /var/lib/stay/evidence/production-hardening/FAILED-R119F-* \
  && -d "$R119F_FAILURE_EVIDENCE" && ! -L "$R119F_FAILURE_EVIDENCE" \
  && "$R119F_RELEASE" == /opt/stay/releases/0.8.11.3-p1m-r119f-chrono-repair-* \
  && -d "$R119F_RELEASE" && ! -L "$R119F_RELEASE" \
  && "$(readlink -f /opt/stay/current)" == "$R119F_RELEASE" ]] ||
  abort recovery-identity-invalid 1904
[[ "$R119F_RELEASE_TAG" == "$STAY_R119F_RELEASE_TAG" \
  && "$R119F_RELEASE_COMMIT" == "$STAY_R119F_RELEASE_COMMIT" \
  && "$R119F_RELEASE_TREE" == "$STAY_R119F_RELEASE_TREE" \
  && "$R119F_ARCHIVE_SHA256" == "$STAY_R119F_ARCHIVE_SHA256" \
  && "$R119F_MANIFEST_SHA256" == "$STAY_R119F_MANIFEST_SHA256" \
  && "$R119F_CONTROLLER_SHA256" == "$STAY_R119F_CONTROLLER_SHA256" ]] ||
  abort recovery-release-binding-invalid 1905
for file in before.database.json service.before.json entry-quota.proof.json repair.preflight.json; do
  [[ -f "$R119F_FAILURE_EVIDENCE/$file" && ! -L "$R119F_FAILURE_EVIDENCE/$file" ]] ||
    abort recovery-evidence-missing 1906
done
[[ ! -e "$RECOVERY_DROPIN" && ! -L "$RECOVERY_DROPIN" ]] ||
  abort recovery-dropin-already-exists 1906
observed_ip="$(ip -4 -o addr show scope global | awk '{split($4,a,"/"); print a[1]}' | sort -u)"
[[ "$observed_ip" == "$EXPECTED_PRIVATE_IPV4" ]] || abort host-identity-mismatch 1907
WORK="$(mktemp -d "$EVIDENCE_ROOT/.R119F-RECOVERY-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"

revision="$(durable_runtime_revision)" || abort runtime-revision-invalid 1908
recovery_start_commands=0
if [[ "$revision" == 118 ]]; then
  [[ "$(systemctl show stay.service -p ActiveState --value)" != active \
    && "$(systemctl show stay.service -p MainPID --value)" == 0 ]] ||
    abort r118-service-must-be-stopped 1908
  if ! STAY_REQUIRE_CORE_PACKAGE_POLICY=1 node \
    "$R119F_RELEASE/deploy/live-physiology-transplant/p1-r119f-chronobiology-bounded-catchup-repair.js" \
    preflight "$DATABASE" "$R119F_RELEASE" >/dev/null 2>&1; then
    validate_repair_state || abort r118-repair-state-invalid 1908
  fi
  cat > "$WORK/p1-r119-recovery-once.conf" <<EOF
[Service]
Environment=STAY_RECOVER_COLD_RESIDENTS_AT_REVISION=119
ExecStartPre=/usr/local/bin/node $R119F_RELEASE/deploy/live-physiology-transplant/p1-r119f-chronobiology-bounded-catchup-repair.js apply $DATABASE $R119F_RELEASE
EOF
  install -o root -g root -m 0644 \
    "$WORK/p1-r119-recovery-once.conf" "$RECOVERY_DROPIN"
  DROPIN_CREATED=1
  systemctl daemon-reload || abort recovery-daemon-reload-failed 1908
  systemd-analyze verify stay.service >/dev/null || abort recovery-systemd-contract-invalid 1908
  systemctl start stay.service || abort recovery-start-failed 1908
  recovery_start_commands=1
elif [[ "$revision" != 119 ]]; then
  abort revision-fence-refused 1908
fi

health=''
for _ in $(seq 1 120); do
  health="$(curl --fail --silent --max-time 3 http://127.0.0.1:8787/healthz 2>/dev/null || true)"
  if [[ "$(json_field "$health" ok 2>/dev/null || true)" == true \
    && "$(json_field "$health" revision 2>/dev/null || true)" == 119 ]]; then break; fi
  sleep 1
done
[[ "$(json_field "$health" ok 2>/dev/null || true)" == true \
  && "$(json_field "$health" revision 2>/dev/null || true)" == 119 \
  && "$(systemctl show stay.service -p ActiveState --value)" == active \
  && "$(systemctl show stay.service -p SubState --value)" == running ]] ||
  abort running-r119-required 1908
validate_repair_state || abort running-r119-repair-state-invalid 1908

if [[ "$DROPIN_CREATED" -eq 1 ]]; then
  rm -f -- "$RECOVERY_DROPIN"
  DROPIN_CREATED=0
  systemctl daemon-reload || abort recovery-dropin-removal-failed 1908
fi

before_pid="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).beforePid))' "$R119F_FAILURE_EVIDENCE/service.before.json")"
before_restarts="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).beforeRestarts))' "$R119F_FAILURE_EVIDENCE/service.before.json")"
after_pid="$(systemctl show stay.service -p MainPID --value)"
after_restarts="$(systemctl show stay.service -p NRestarts --value)"
[[ "$before_pid" =~ ^[1-9][0-9]*$ && "$after_pid" =~ ^[1-9][0-9]*$ \
  && "$before_pid" != "$after_pid" && "$after_restarts" == "$before_restarts" ]] ||
  abort service-generation-changed 1909

for file in before.database.json service.before.json entry-quota.proof.json repair.preflight.json; do
  cp --reflink=auto --preserve=mode,timestamps "$R119F_FAILURE_EVIDENCE/$file" "$WORK/$file"
done
node - "$before_pid" "$after_pid" "$before_restarts" "$after_restarts" \
  "$recovery_start_commands" > "$WORK/service.proof.json" <<'NODE'
'use strict';
const [beforePid, afterPid, beforeRestarts, afterRestarts, recoveryStartCommands] =
  process.argv.slice(2).map(Number);
process.stdout.write(`${JSON.stringify({
  beforePid, afterPid, beforeRestarts, afterRestarts,
  restartCommands: 1, recoveryStartCommands,
})}\n`);
NODE

STAY_R119F_WORK="$WORK" \
STAY_R119F_BEFORE_DATABASE="$WORK/before.database.json" \
STAY_R119F_SERVICE_PROOF="$WORK/service.proof.json" \
STAY_R119F_ENTRY_PROOF="$WORK/entry-quota.proof.json" \
STAY_R119F_PREFLIGHT_PROOF="$WORK/repair.preflight.json" \
STAY_R119F_RELEASE="$R119F_RELEASE" \
STAY_R119F_RELEASE_TAG="$STAY_R119F_RELEASE_TAG" \
STAY_R119F_RELEASE_COMMIT="$STAY_R119F_RELEASE_COMMIT" \
STAY_R119F_RELEASE_TREE="$STAY_R119F_RELEASE_TREE" \
STAY_R119F_ARCHIVE_SHA256="$STAY_R119F_ARCHIVE_SHA256" \
STAY_R119F_MANIFEST_SHA256="$STAY_R119F_MANIFEST_SHA256" \
STAY_R119F_CONTROLLER_SHA256="$STAY_R119F_CONTROLLER_SHA256" \
STAY_R119F_PRIVATE_IPV4="$observed_ip" \
bash "$R119F_RELEASE/deploy/live-physiology-transplant/p1-r119f-finalize.sh" > "$WORK/finalize.output" ||
  abort finalization-failed 1910

final_evidence="$EVIDENCE_ROOT/R119F-RECOVERY-$(date -u +'%Y%m%dT%H%M%SZ')"
mv -T "$WORK" "$final_evidence"
WORK=''
chmod -R a-w "$final_evidence"
rm -f -- "$RECOVERY_MARKER"
COMPLETED=1
trap - EXIT
cat "$final_evidence/finalize.output"
echo 'R119F_FORWARD_RECOVERY_RESULT=PASS'
echo 'REVISION_LABEL=R119F'
echo "CURRENT_RELEASE=$R119F_RELEASE"
echo "R119F_EVIDENCE=$final_evidence"
