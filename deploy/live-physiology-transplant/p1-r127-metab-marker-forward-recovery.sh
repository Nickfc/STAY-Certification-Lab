#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

EXPECTED_PRIVATE_IPV4='172.26.9.207'
ACTIVE_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r127-metab-final-7b649384afdf'
ACTIVE_MANIFEST='deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R123F_TO_R124.sha256'
ACTIVE_MANIFEST_SHA256='7b649384afdf5152b49d608cb36902fad042168274d4200a2d72a481d44a0979'
ACTIVE_RELEASE_ENV_SHA256='122ec82740207d8aead50a6e46130b6400dd38109397897cbe718e740e6aeea9'
ACTIVE_RELEASE_TAG='r127-metab-final-recovery-v3'
ACTIVE_RELEASE_COMMIT='38ae95f43c32c7234a31fa13eb78e6706a49054e'
ACTIVE_RELEASE_TREE='f43d4bb0bb770f340c9b8d4a5351f4be3a8199a0'
ACTIVE_ARCHIVE_SHA256='sha256:b1e86eb09014d762f0149f0d509543f60f36f9a052f9dbfcedeee3fcb2256eaa'
ACTIVE_FILE_COUNT=645
TARGET_FILE_COUNT=646
ACTIVE_TREE_SHA256='5108d022880238934d8fd40ab88a5ece1493e7e6b46bad4e2ff698991a54ec76'
TARGET_MANIFEST='deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R123F_TO_R124.sha256'
TARGET_RELEASE_ENV='P1_R124_RELEASE.env'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
SOCKET='/run/stay/resident-control.sock'
RECOVERY_MARKER='/run/stay-r124-metab-neutral-recovery.env'
RECOVERY_MARKER_SHA256='933b128f24d4898550add86f4b34174f18b42e942391ec479f8956689624bb5e'
BIRTH_DROPIN='/etc/systemd/system/stay.service.d/p1-r124-metab-neutral-birth-once.conf'
BIRTH_DROPIN_SHA256='b8cec7f42ed34dcd2e438fc4ad1c4e54e6d50ef4bc66153ddc0fe16284d0c360'
ACTIVE_CERTIFICATE='/etc/stay/resident-promotions/resident-metab-neutral-birth.json'
ACTIVE_CERTIFICATE_SHA256='5fde5160f4a6dac8f97b546ef9b3458b64185465944c07e6c89a915912d2b4a6'
ACTIVE_PUBLIC_KEY='/etc/stay/metab-neutral-birth-authority.pub'
ACTIVE_PUBLIC_KEY_SHA256='754f949e67c31bc25b3bdf66e74a9b69ad44f781d43606b7a46ac69531e0551e'
TARGET_FREEZE='/var/lib/stay/evidence/runtime-freezes/R127.json'
PARENT_FREEZE_SHA256='161b5fe340ef01836447e21c0e77167cac86033973f8a06b3c1af1d7b44fa3cc'
FAILED_R124_EVIDENCE='/var/lib/stay/evidence/production-hardening/FAILED-R124-20260902T144307Z.eMKkA2'
FAILED_R127_EVIDENCE='/var/lib/stay/evidence/production-hardening/FAILED-R127-PRESERVE-20260902T185222Z.rHU3XL'
FAILED_R127_FILE_COUNT=17
FAILED_R127_TREE_SHA256='cda199f86533aed8217b84a76bbf9744b58a2611e6b84ec7211001b221809dba'
EXPECTED_STRANDED_PID=0
EXPECTED_STRANDED_PENDING_DELIVERIES=2
EVIDENCE_ROOT='/var/lib/stay/evidence/production-hardening'
SCRIPT_DIRECTORY="$(dirname -- "$(readlink -f -- "$0")")"
STAGE_ROOT="$(readlink -f -- "$SCRIPT_DIRECTORY/../..")"
LIVE_PROOF="$SCRIPT_DIRECTORY/p1-r124-metab-neutral-live-proof.js"
CONTROL_CLIENT="$SCRIPT_DIRECTORY/p1-resident-control-client.js"

: "${STAY_R127_MARKER_RECOVERY_AUTHORIZATION:?}"
: "${STAY_R127_RECOVERY_ARTIFACT_TAG:?}"
: "${STAY_R127_RECOVERY_ARTIFACT_COMMIT:?}"
: "${STAY_R127_RECOVERY_ARTIFACT_TREE:?}"
: "${STAY_R127_RECOVERY_ARTIFACT_ARCHIVE_SHA256:?}"
: "${STAY_R127_RECOVERY_ARTIFACT_MANIFEST_SHA256:?}"
: "${STAY_R127_RECOVERY_CONTROLLER_SHA256:?}"
: "${STAY_R127_TARGET_RELEASE:?}"
: "${STAY_R127_BIRTH_DOSSIER_FILE:?}"
: "${STAY_R127_BIRTH_DOSSIER_SHA256:?}"

WORK=''
CANDIDATE=''
REHEARSAL_DATA=''
NEW_RELEASE=''
TARGET_CREATED=0
POINTER_CHANGED=0
DROPIN_CHANGED=0
RESTART_COMMITTED=0
COMPLETED=0

phase() { printf '===== %s =====\n' "$1"; }
abort() { printf 'R127_MARKER_RECOVERY_ABORT=%s\n' "$1" >&2; exit "${2:-1}"; }
sha256_file() { sha256sum "$1" | awk '{print $1}'; }

tree_digest() {
  local root="$1" relative="$2"
  (cd "$root" && find "$relative" -type f -print0 | sort -z | xargs -0 sha256sum |
    sha256sum | awk '{print $1}')
}

release_inventory_digest() {
  (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum |
    sha256sum | awk '{print $1}')
}

install_atomic() {
  local source="$1" target="$2" mode="$3" temporary
  temporary="$(mktemp "$(dirname "$target")/.r127-preserve.XXXXXX")"
  install -o root -g root -m "$mode" "$source" "$temporary"
  mv -fT "$temporary" "$target"
}

point_current() {
  local release="$1" temporary="/opt/stay/.current-r127-preserve.$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
  ln -s "$release" "$temporary"
  mv -Tf "$temporary" /opt/stay/current
}

manifest_paths() {
  awk '
    !/^[0-9a-f]{64}  \.\/[A-Za-z0-9._\/-]+$/ { exit 2 }
    { sub(/^\.\//, "", $2); print $2 }
  ' "$STAGE_ROOT/$TARGET_MANIFEST"
}

safe_relative_path() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9._/-]+$ \
    && "$value" != /* && "$value" != '.' && "$value" != '..' \
    && "/$value/" != *'/../'* && "/$value/" != *'/./'* \
    && "$value" != *//* ]]
}

durable_runtime_revision() {
  STAY_DATABASE="$DATABASE" /usr/local/bin/node <<'NODE'
'use strict';
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(process.env.STAY_DATABASE, { open: true, readOnly: true });
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

capture_quiescent_database() {
  local output="$1" temporary="$1.new" attempt
  for attempt in $(seq 1 20); do
    /usr/local/bin/node "$LIVE_PROOF" capture "$DATABASE" > "$temporary"
    if /usr/local/bin/node - "$temporary" <<'NODE'
'use strict';
const value = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (!(value.quickCheck === 'ok' && value.queryOnly === true &&
  value.pendingDeliveries === 0 && value.pendingOutboxIntents === 0)) process.exit(1);
NODE
    then
      mv -fT "$temporary" "$output"
      printf '%s\n' "$attempt" > "$output.attempts"
      return 0
    fi
    sleep 0.25
  done
  mv -fT "$temporary" "$output"
  return 1
}

install_freeze_atomic() {
  local source="$1" temporary
  temporary="$(mktemp /var/lib/stay/evidence/runtime-freezes/.R127.XXXXXX)"
  install -o root -g root -m 0444 "$source" "$temporary"
  mv -fT "$temporary" "$TARGET_FREEZE"
}

archive_failure_work() {
  if [[ -n "$WORK" && -d "$WORK" ]]; then
    local failed
    failed="$(mktemp -d "$EVIDENCE_ROOT/FAILED-R127-PRESERVE-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
    rmdir -- "$failed"
    if mv -T "$WORK" "$failed"; then
      WORK=''
      chmod -R a-w "$failed" || true
      printf 'R127_PRESERVATION_FAILURE_EVIDENCE=%s\n' "$failed" >&2
    fi
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$COMPLETED" -eq 0 && "$RESTART_COMMITTED" -eq 0 ]]; then
    if [[ "$POINTER_CHANGED" -eq 1 ]]; then
      point_current "$ACTIVE_RELEASE" || true
    fi
    if [[ "$DROPIN_CHANGED" -eq 1 && -f "$WORK/birth-dropin.before.conf" ]]; then
      install_atomic "$WORK/birth-dropin.before.conf" "$BIRTH_DROPIN" 0644 || true
      systemctl daemon-reload || true
    fi
    if [[ "$TARGET_CREATED" -eq 1 && -n "$NEW_RELEASE" \
      && "$NEW_RELEASE" == /opt/stay/releases/0.8.11.3-p1m-r127-metab-final-* \
      && -d "$NEW_RELEASE" && ! -L "$NEW_RELEASE" ]]; then
      chmod -R u+w "$NEW_RELEASE" || true
      rm -rf --one-file-system -- "$NEW_RELEASE" || true
    fi
  fi
  if [[ "$COMPLETED" -eq 0 ]]; then
    archive_failure_work
    if [[ "$RESTART_COMMITTED" -eq 1 ]]; then
      printf 'R127_PRESERVATION_POST_RESTART=LEFT_REVISION_FENCED_FOR_FORWARD_RECOVERY\n' >&2
    else
      printf 'R127_PRESERVATION_ROLLBACK=PRE_RESTART_STATE_RESTORED\n' >&2
    fi
  fi
  if [[ -n "$REHEARSAL_DATA" \
    && "$REHEARSAL_DATA" == /var/lib/stay/.r127-continuity-rehearsal.* \
    && -d "$REHEARSAL_DATA" && ! -L "$REHEARSAL_DATA" ]]; then
    rm -rf --one-file-system -- "$REHEARSAL_DATA"
  fi
  [[ -n "$CANDIDATE" && -d "$CANDIDATE" ]] && rm -rf --one-file-system -- "$CANDIDATE"
  [[ -n "$WORK" && -d "$WORK" ]] && rm -rf --one-file-system -- "$WORK"
  exit "$status"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 2501
[[ "$STAY_R127_MARKER_RECOVERY_AUTHORIZATION" == \
  'AUTHORIZE_R127_POST_RESTART_FETUS_SNTSS_CHRONOBIOLOGY_CONTINUITY_ONLY' ]] ||
  abort authorization-required 2502
[[ "$STAY_R127_RECOVERY_ARTIFACT_TAG" =~ ^r127-metab-final-recovery-v[0-9]+$ \
  && "$STAY_R127_RECOVERY_ARTIFACT_COMMIT" =~ ^[0-9a-f]{40}$ \
  && "$STAY_R127_RECOVERY_ARTIFACT_TREE" =~ ^[0-9a-f]{40}$ \
  && "$STAY_R127_RECOVERY_ARTIFACT_ARCHIVE_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R127_RECOVERY_ARTIFACT_MANIFEST_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R127_RECOVERY_CONTROLLER_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R127_TARGET_RELEASE" =~ ^/opt/stay/releases/0\.8\.11\.3-p1m-r127-metab-final-[0-9a-f]{12}$ \
  && "$STAY_R127_BIRTH_DOSSIER_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  abort artifact-identity-invalid 2503
[[ "$(ip -o -4 addr show scope global | awk '{address=$4; sub(/\/.*/, "", address); print address}' | sort -u)" == \
  "$EXPECTED_PRIVATE_IPV4" ]] || abort host-identity-mismatch 2504

phase 'EXACT READ-ONLY R127 STRANDED REVISION PREFLIGHT'
[[ "$(readlink -f /opt/stay/current)" == "$ACTIVE_RELEASE" \
  && -d "$ACTIVE_RELEASE" && ! -L "$ACTIVE_RELEASE" \
  && "$(sha256_file "$ACTIVE_RELEASE/$ACTIVE_MANIFEST")" == "$ACTIVE_MANIFEST_SHA256" \
  && "$(sha256_file "$ACTIVE_RELEASE/P1_R124_RELEASE.env")" == "$ACTIVE_RELEASE_ENV_SHA256" \
  && "$(find "$ACTIVE_RELEASE" -type f | wc -l)" -eq "$ACTIVE_FILE_COUNT" \
  && "$(release_inventory_digest "$ACTIVE_RELEASE")" == "$ACTIVE_TREE_SHA256" ]] ||
  abort active-release-identity-invalid 2505
(cd "$ACTIVE_RELEASE" && sha256sum -c "$ACTIVE_MANIFEST" >/dev/null) ||
  abort active-release-manifest-invalid 2505
[[ ! -e "$TARGET_FREEZE" && ! -L "$TARGET_FREEZE" ]] || abort freeze-already-present 2506
[[ -d "$FAILED_R127_EVIDENCE" && ! -L "$FAILED_R127_EVIDENCE" \
  && "$(find "$FAILED_R127_EVIDENCE" -type f | wc -l)" -eq "$FAILED_R127_FILE_COUNT" \
  && "$(find "$FAILED_R127_EVIDENCE" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')" == \
    "$FAILED_R127_TREE_SHA256" ]] || abort stranded-evidence-invalid 2507
[[ -f "$RECOVERY_MARKER" && ! -L "$RECOVERY_MARKER" \
  && "$(stat -Lc '%U:%G:%a' "$RECOVERY_MARKER")" == 'root:staydeploy:440' \
  && "$(sha256_file "$RECOVERY_MARKER")" == "$RECOVERY_MARKER_SHA256" \
  && -f "$BIRTH_DROPIN" && ! -L "$BIRTH_DROPIN" \
  && "$(sha256_file "$BIRTH_DROPIN")" == "$BIRTH_DROPIN_SHA256" \
  && -f "$ACTIVE_CERTIFICATE" && ! -L "$ACTIVE_CERTIFICATE" \
  && "$(sha256_file "$ACTIVE_CERTIFICATE")" == "$ACTIVE_CERTIFICATE_SHA256" \
  && -f "$ACTIVE_PUBLIC_KEY" && ! -L "$ACTIVE_PUBLIC_KEY" \
  && "$(sha256_file "$ACTIVE_PUBLIC_KEY")" == "$ACTIVE_PUBLIC_KEY_SHA256" \
  && -f "$STAY_R127_BIRTH_DOSSIER_FILE" && ! -L "$STAY_R127_BIRTH_DOSSIER_FILE" \
  && "sha256:$(sha256_file "$STAY_R127_BIRTH_DOSSIER_FILE")" == "$STAY_R127_BIRTH_DOSSIER_SHA256" ]] ||
  abort one-shot-cohort-invalid 2508

before_pid="$(systemctl show stay.service -p MainPID --value)"
before_restarts="$(systemctl show stay.service -p NRestarts --value)"
[[ "$before_pid" -eq "$EXPECTED_STRANDED_PID" && "$before_restarts" -eq 0 \
  && "$(systemctl show stay.service -p User --value)" == staydeploy \
  && "$(systemctl show stay.service -p Group --value)" == staydeploy \
  && "$(systemctl show stay.service -p ActiveState --value)" == inactive \
  && "$(systemctl show stay.service -p SubState --value)" == dead \
  && "$(durable_runtime_revision)" == 127 ]] || abort stranded-service-fence-invalid 2509
if curl --fail --silent --max-time 1 http://127.0.0.1:8787/healthz >/dev/null; then
  abort stranded-health-unexpectedly-ready 2509
fi
before_database_sha256="$(sha256_file "$DATABASE")"

WORK="$(mktemp -d "$EVIDENCE_ROOT/.R127-preserving-forward.XXXXXX")"
chmod 0700 "$WORK"
/usr/local/bin/node "$LIVE_PROOF" capture "$DATABASE" > "$WORK/database.stranded.json"
/usr/local/bin/node - "$WORK/database.stranded.json" "$DATABASE" \
  > "$WORK/before.proof.json" <<'NODE'
'use strict';
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const database = new DatabaseSync(process.argv[3], { open: true, readOnly: true });
database.exec('PRAGMA query_only=ON');
const row = id => value.residents.find(entry => entry.residency_id === id);
const consumer = id => value.consumers.find(entry => entry.consumer_id === id);
const sntss = row('resident:sntss');
const chrono = row('resident:chronobiology');
const metab = row('resident:metab');
const sntssConsumer = consumer('resident:sntss');
const chronoConsumer = consumer('resident:chronobiology');
const metabConsumer = consumer('resident:metab');
const fetusConsumer = consumer('core:fetus-legacy');
const authority = database.prepare("SELECT * FROM authority ORDER BY core_id").all();
const fetusCheckpoint = database.prepare(
  "SELECT * FROM checkpoints WHERE core_id='fetus-legacy' ORDER BY generation DESC LIMIT 1"
).get();
const recovery = id => {
  const found = database.prepare(
    'SELECT id, type, core_id, detail_json FROM recovery_records WHERE id=?'
  ).get(id);
  return found && { ...found, detail: JSON.parse(found.detail_json) };
};
const fetusDemotion = recovery(116);
const chronoRewind = recovery(119);
const sntssRewind = recovery(120);
const pending = database.prepare(`
  SELECT d.consumer_id, d.sequence, d.status, e.topic, e.deduplication_key,
         e.envelope_json
  FROM biological_deliveries d JOIN biological_events e ON e.sequence=d.sequence
  WHERE d.status='PENDING' ORDER BY d.consumer_id
`).all();
const highWater = Number(database.prepare(
  'SELECT COALESCE(MAX(sequence), 0) value FROM biological_events'
).get().value);
const cohort = database.prepare(`
  SELECT sequence, event_id, topic, event_class, envelope_json, deduplication_key
  FROM biological_events WHERE sequence BETWEEN 3652769 AND 3654057 ORDER BY sequence
`).all();
const pulseCounts = new Map([
  ['runtime.time.pulse', 0],
  ['runtime.trusted-organism-time.pulse', 0]
]);
let cohortValid = cohort.length === 1289;
for (const event of cohort) {
  let envelope;
  try { envelope = JSON.parse(event.envelope_json); } catch { cohortValid = false; break; }
  if (!pulseCounts.has(event.topic)) { cohortValid = false; break; }
  const pulseSequence = pulseCounts.get(event.topic) + 1;
  if (!(event.event_class === 'durable' && envelope.id === event.event_id &&
    envelope.sequence === Number(event.sequence) && envelope.topic === event.topic &&
    envelope.payload?.runtimeRevision === 127 &&
    envelope.payload?.pulseSequence === pulseSequence &&
    envelope.meta?.sourceCore === 'living-kernel' &&
    event.deduplication_key === `${event.topic}:127:${pulseSequence}`)) {
    cohortValid = false;
    break;
  }
  pulseCounts.set(event.topic, pulseSequence);
}
if (!(value.quickCheck === 'ok' && value.queryOnly === true && value.runtimeRevision === 127 &&
  value.pendingDeliveries === 2 &&
  value.pendingOutboxIntents === 0 && value.failedDeliveries === 0 &&
  value.abandonedDeliveries === 0 &&
  value.p1Authority === 0 && value.sntssAuthority === 0 &&
  value.chronobiologyAuthority === 0 && value.founders.length === 1 &&
  value.dossiers.length === 1 && value.chips.length === 1 &&
  value.metabCheckpoints === 1 && value.metabChipHistory === 1 &&
  value.residents.length === 3 && value.consumers.length === 4 &&
  sntss?.instance_id === '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f' &&
  sntss?.version === '0.5.0-i4g1' && sntss?.status === 'RESYNC_REQUIRED' &&
  Number(sntss?.checkpoint_generation) === 2449921 &&
  sntss?.checkpoint_hash === 'dd5921a4b98c054b463daf6216dddb39789773f890db464d0434809c55677acc' &&
  chrono?.instance_id === 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a' &&
  chrono?.version === '1.0.0-c3rc.5' && chrono?.status === 'RESYNC_REQUIRED' &&
  Number(chrono?.checkpoint_generation) === 10049 &&
  chrono?.checkpoint_hash === '49f3a88b1b811757879e4cdddd25496f2bd4f3f3e4927d9b30d71c4b91c5efc9' &&
  metab?.instance_id === 'd424c722-ef31-44b0-8201-ba68c418d14a' &&
  metab?.version === '0.1.0-p1r0-neutral.1' && metab?.status === 'RUNNING' &&
  Number(metab?.checkpoint_generation) === 1 &&
  metab?.checkpoint_hash === '4a16fc393b9846d1dd6f2f9849920053e3d2b5235c066dde3c5cd72699595107' &&
  Number(sntssConsumer?.active) === 0 && Number(sntssConsumer?.required) === 0 &&
  Number(sntssConsumer?.cursor) === 3652769 && Number(sntssConsumer?.authority_epoch) === 0 &&
  sntssConsumer?.topics_sha256 === 'b752d8eebb09ac925c4c193810d31f5527315e42e36fbedafa1f30ef25a97501' &&
  Number(chronoConsumer?.active) === 0 && Number(chronoConsumer?.required) === 0 &&
  Number(chronoConsumer?.cursor) === 3652768 && Number(chronoConsumer?.authority_epoch) === 0 &&
  chronoConsumer?.topics_sha256 === 'a0897ae1c2f0bdf9f94e5491cf681820cda4a0126afcb47511cc4a538d5a281e' &&
  Number(metabConsumer?.active) === 1 && Number(metabConsumer?.required) === 0 &&
  Number(metabConsumer?.cursor) === 3654057 && Number(metabConsumer?.authority_epoch) === 0 &&
  Number(fetusConsumer?.active) === 0 && Number(fetusConsumer?.required) === 0 &&
  Number(fetusConsumer?.cursor) === 3620902 && Number(fetusConsumer?.authority_epoch) === 1 &&
  fetusConsumer?.topics_json === '[]' && fetusConsumer?.checkpoint_hash === null &&
  authority.length === 1 && authority[0]?.core_id === 'fetus-legacy' &&
  authority[0]?.instance_id === '82202211-8dd6-44d4-a4ec-8f2553d8dc6f' &&
  authority[0]?.version === '0.6.0' && Number(authority[0]?.epoch) === 1 &&
  authority[0]?.checkpoint_hash === 'dc65f0fff624e08df092620697f230ea28521e8db34614c455f7473e6ed91b7b' &&
  Number(fetusCheckpoint?.generation) === 185 &&
  fetusCheckpoint?.blob_hash === 'dc65f0fff624e08df092620697f230ea28521e8db34614c455f7473e6ed91b7b' &&
  fetusDemotion?.type === 'biological.consumer-demoted' &&
  fetusDemotion?.detail?.consumerId === 'core:fetus-legacy' &&
  fetusDemotion?.detail?.cursor === 3620902 && fetusDemotion?.detail?.pending === 16464 &&
  fetusDemotion?.detail?.maximumDebt === 16384 &&
  fetusDemotion?.detail?.resynchronizationRequired === true &&
  chronoRewind?.type === 'resident.resync-required' &&
  chronoRewind?.detail?.sequence === 3652769 &&
  chronoRewind?.detail?.code === 'CHRONOBIOLOGY_TIME_REWIND' &&
  sntssRewind?.type === 'resident.resync-required' &&
  sntssRewind?.detail?.sequence === 3652770 &&
  sntssRewind?.detail?.code === 'SNTSS_TIME_REWIND' &&
  pending.length === 2 &&
  pending.some(entry => entry.consumer_id === 'resident:chronobiology' &&
    Number(entry.sequence) === 3652769) &&
  pending.some(entry => entry.consumer_id === 'resident:sntss' &&
    Number(entry.sequence) === 3652770) &&
  highWater === 3654057 && cohortValid &&
  pulseCounts.get('runtime.time.pulse') === 1283 &&
  pulseCounts.get('runtime.trusted-organism-time.pulse') === 6)) process.exit(1);
database.close();
process.stdout.write(`${JSON.stringify({ result: 'PASS', runtimeRevision: 127,
  pendingDeliveries: value.pendingDeliveries,
  abandonedDeliveries: value.abandonedDeliveries,
  ledgerHighWater: highWater,
  fetusCheckpointGeneration: Number(fetusCheckpoint.generation),
  fetusCheckpointHash: fetusCheckpoint.blob_hash,
  sntssCheckpointGeneration: Number(sntss.checkpoint_generation),
  sntssCheckpointHash: sntss.checkpoint_hash,
  chronobiologyCheckpointGeneration: Number(chrono.checkpoint_generation),
  chronobiologyCheckpointHash: chrono.checkpoint_hash,
  metabCheckpointGeneration: Number(metab.checkpoint_generation),
  metabCheckpointHash: metab.checkpoint_hash })}\n`);
NODE
install -o root -g root -m 0400 "$RECOVERY_MARKER" "$WORK/r124-failed-birth-recovery.env"
install -o root -g root -m 0400 "$ACTIVE_CERTIFICATE" "$WORK/metab-neutral-birth-certificate.json"
install -o root -g root -m 0400 "$STAY_R127_BIRTH_DOSSIER_FILE" "$WORK/metab-neutral-founder-dossier.json"
install -o root -g root -m 0444 "$ACTIVE_PUBLIC_KEY" "$WORK/metab-neutral-birth-authority.pub"
install -o root -g root -m 0444 "$ACTIVE_RELEASE/P1_R124_RELEASE.env" "$WORK/source.P1_R124_RELEASE.env"
install -o root -g root -m 0400 "$BIRTH_DROPIN" "$WORK/birth-dropin.before.conf"

phase 'BUILD SOURCE-SEALED R127 REVISION-PRESERVING CANDIDATE'
mapfile -t overlay_files < <(manifest_paths)
missing_active_overlay_files=()
[[ "${#overlay_files[@]}" -gt 0 \
  && "$(printf '%s\n' "${overlay_files[@]}" | LC_ALL=C sort -u | wc -l)" -eq "${#overlay_files[@]}" \
  && "$(printf '%s\n' "${overlay_files[@]}" | LC_ALL=C sort)" == "$(printf '%s\n' "${overlay_files[@]}")" ]] ||
  abort manifest-path-set-invalid 2510
for file in "${overlay_files[@]}"; do
  safe_relative_path "$file" || abort manifest-path-unsafe 2510
  [[ "$file" != "$TARGET_MANIFEST" && "$file" != "$TARGET_RELEASE_ENV" \
    && -f "$STAGE_ROOT/$file" && ! -L "$STAGE_ROOT/$file" ]] ||
    abort manifest-input-invalid 2510
  [[ -e "$ACTIVE_RELEASE/$file" ]] || missing_active_overlay_files+=("$file")
done
[[ "${#missing_active_overlay_files[@]}" -eq 1 \
  && "${missing_active_overlay_files[0]}" == \
    'test/p1-r127-post-restart-continuity.test.js' ]] ||
  abort active-overlay-delta-invalid 2510
[[ "sha256:$(sha256_file "$STAGE_ROOT/$TARGET_MANIFEST")" == \
  "$STAY_R127_RECOVERY_ARTIFACT_MANIFEST_SHA256" ]] || abort stage-manifest-identity-invalid 2510
(cd "$STAGE_ROOT" && sha256sum -c "$TARGET_MANIFEST" >/dev/null) ||
  abort stage-manifest-verification-failed 2510

CANDIDATE="$(mktemp -d /opt/stay/releases/.p1m-r127-metab-final.XXXXXX)"
cp -a --reflink=auto "$ACTIVE_RELEASE/." "$CANDIDATE/"
source_sntss_digest="$(tree_digest "$ACTIVE_RELEASE" cores/sntss/i4g)"
source_chrono_c3_digest="$(tree_digest "$ACTIVE_RELEASE" cores/chronobiology/c3)"
source_chrono_c3r4_digest="$(tree_digest "$ACTIVE_RELEASE" cores/chronobiology/c3r4)"
source_chrono_c3r5_digest="$(tree_digest "$ACTIVE_RELEASE" cores/chronobiology/c3r5)"
for file in "${overlay_files[@]}"; do
  install -D -o root -g root -m 0644 "$STAGE_ROOT/$file" "$CANDIDATE/$file"
done
install -D -o root -g root -m 0644 "$STAGE_ROOT/$TARGET_MANIFEST" \
  "$CANDIDATE/$TARGET_MANIFEST"
(cd "$CANDIDATE" && sha256sum -c "$TARGET_MANIFEST" >/dev/null) ||
  abort candidate-manifest-verification-failed 2510
[[ "$(tree_digest "$CANDIDATE" cores/sntss/i4g)" == "$source_sntss_digest" \
  && "$(tree_digest "$CANDIDATE" cores/chronobiology/c3)" == "$source_chrono_c3_digest" \
  && "$(tree_digest "$CANDIDATE" cores/chronobiology/c3r4)" == "$source_chrono_c3r4_digest" \
  && "$(tree_digest "$CANDIDATE" cores/chronobiology/c3r5)" == "$source_chrono_c3r5_digest" ]] ||
  abort protected-biological-tree-changed 2510
for relative in cores/sntss/i4g cores/chronobiology/c3 cores/chronobiology/c3r4 \
  cores/chronobiology/c3r5; do
  diff -qr "$ACTIVE_RELEASE/$relative" "$CANDIDATE/$relative" > \
    "$WORK/$(basename "$relative").diff" || abort protected-biological-tree-diff 2510
done
for file in "${overlay_files[@]}"; do
  [[ "$file" == *.js ]] && /usr/local/bin/node --check "$CANDIDATE/$file" >/dev/null
  [[ "$file" == *.sh ]] && /bin/bash -n "$CANDIDATE/$file"
done

phase 'FOCUSED REGRESSION AND REAL ENTRY PATHS'
if ! /usr/local/bin/node --test --test-concurrency=1 \
  "$CANDIDATE/test/p1-r124-metab-neutral-birth.test.js" \
  "$CANDIDATE/test/p1-r124-metab-founder-dossier.test.js" \
  "$CANDIDATE/test/p1-r124-metab-neutral-production-proof.test.js" \
  "$CANDIDATE/test/p1-r127-post-restart-continuity.test.js" \
  "$CANDIDATE/test/p1-resident-control-socket.test.js" \
  "$CANDIDATE/test/server.test.js" > "$WORK/focused-tests.tap" 2>&1; then
  cat "$WORK/focused-tests.tap" >&2
  abort candidate-focused-tests-failed 2510
fi
cat "$WORK/focused-tests.tap"
if ! systemd-run --wait --pipe --collect --quiet \
  --property=User=staydeploy --property=Delegate=yes \
  --property=CPUAccounting=yes --property=MemoryAccounting=yes \
  /usr/bin/env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_ENV=production STAY_REQUIRE_OS_CORE_SANDBOX=1 \
    STAY_BWRAP=/usr/local/libexec/stay-bwrap-sandbox \
    STAY_REQUIRE_CORE_PACKAGE_POLICY=1 STAY_REQUIRE_CGROUPS=1 \
    /usr/local/bin/node --disable-sigusr1 --test --test-isolation=none \
    --test-concurrency=1 --test-name-pattern='^R127-METAB-RECOVERY-05' \
    "$CANDIDATE/test/p1-r124-metab-neutral-birth.test.js" \
    > "$WORK/real-metab-entry.tap" 2>&1; then
  cat "$WORK/real-metab-entry.tap" >&2
  abort real-metab-entry-failed 2510
fi
cat "$WORK/real-metab-entry.tap"

REHEARSAL_DATA="$(mktemp -d /var/lib/stay/.r127-continuity-rehearsal.XXXXXX)"
[[ "$REHEARSAL_DATA" == /var/lib/stay/.r127-continuity-rehearsal.* \
  && -d "$REHEARSAL_DATA" && ! -L "$REHEARSAL_DATA" ]] ||
  abort rehearsal-data-target-invalid 2510
tar --exclude='./snapshots' -C /var/lib/stay/data -cf - . | tar -C "$REHEARSAL_DATA" -xf -
chown -R staydeploy:staydeploy "$REHEARSAL_DATA"
if ! systemd-run --wait --pipe --collect --quiet \
  --property=User=staydeploy --property=Delegate=yes \
  --property=CPUAccounting=yes --property=MemoryAccounting=yes \
  /usr/bin/env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_ENV=production STAY_REQUIRE_OS_CORE_SANDBOX=1 \
    STAY_BWRAP=/usr/local/libexec/stay-bwrap-sandbox \
    STAY_REQUIRE_CORE_PACKAGE_POLICY=1 STAY_REQUIRE_CGROUPS=1 \
    STAY_REQUIRE_CORE_PROMOTION_CERT=1 \
    STAY_R127_POST_RESTART_REHEARSAL_DATA_DIR="$REHEARSAL_DATA" \
    STAY_DATA_DIR="$REHEARSAL_DATA" \
    STAY_RUNTIME_FREEZE_DIR=/var/lib/stay/evidence/runtime-freezes \
    STAY_ALLOW_METAB_NEUTRAL_BIRTH=1 STAY_ALLOW_METAB_NEUTRAL_RECOVERY=1 \
    STAY_ALLOW_METAB_NEUTRAL_RECOVERY_REVISION_PRESERVATION=1 \
    STAY_ALLOW_R127_POST_RESTART_CONTINUITY_RECOVERY=\
AUTHORIZE_R127_POST_RESTART_FETUS_SNTSS_CHRONOBIOLOGY_CONTINUITY_ONLY \
    STAY_METAB_NEUTRAL_RECOVERY_MARKER="$RECOVERY_MARKER" \
    STAY_METAB_NEUTRAL_RECOVERY_MARKER_SHA256="sha256:$RECOVERY_MARKER_SHA256" \
    STAY_LEGACY_SOURCE_DIR=/opt/stay/legacy/0.6.0 STAY_LEGACY_PORT=18788 \
    STAY_REQUIRE_HIBERNATION_STATE=1 \
    STAY_EXPECTED_HIBERNATION_SHA256=b45d6addd70b13bfa684f53c075edb3ca6a76bae7d7384849f84a1df2d7d073d \
    STAY_ENABLE_TRUSTED_ORGANISM_TIME=1 STAY_TRUSTED_TIME_PULSE_INTERVAL_MS=250 \
    STAY_TRUSTED_ORGANISM_TIME_PULSE_INTERVAL_MS=60000 \
    /usr/local/bin/node --disable-sigusr1 --test --test-isolation=none \
    --test-concurrency=1 --test-name-pattern='^R127-POST-RESTART-ENTRY-05' \
    "$CANDIDATE/test/p1-r127-post-restart-continuity.test.js" \
    > "$WORK/real-r127-post-restart-entry.tap" 2>&1; then
  cat "$WORK/real-r127-post-restart-entry.tap" >&2
  abort real-r127-post-restart-entry-failed 2510
fi
cat "$WORK/real-r127-post-restart-entry.tap"
rm -rf --one-file-system -- "$REHEARSAL_DATA"
REHEARSAL_DATA=''

if ! systemd-run --wait --pipe --collect --quiet \
  --property=User=staydeploy --property=Delegate=yes \
  --property=CPUAccounting=yes --property=MemoryAccounting=yes \
  /usr/bin/env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_ENV=production STAY_REQUIRE_OS_CORE_SANDBOX=1 \
    STAY_BWRAP=/usr/local/libexec/stay-bwrap-sandbox \
    STAY_REQUIRE_CORE_PACKAGE_POLICY=1 STAY_REQUIRE_CGROUPS=1 \
    /usr/local/bin/node "$CANDIDATE/deploy/live-physiology-transplant/p1-r119f-entry-preflight.js" \
    > "$WORK/chronobiology-entry.proof.json"; then
  abort real-chronobiology-entry-failed 2510
fi
/usr/local/bin/node - "$WORK/chronobiology-entry.proof.json" <<'NODE'
'use strict';
const value = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (!(value.result === 'PASS' && value.version === '1.0.0-c3rc.5' &&
  value.hardCpuPercent === 20 && value.payloadSandboxed === true &&
  value.payloadAttachedBeforeInit === true)) process.exit(1);
NODE
[[ "$(systemctl show stay.service -p MainPID --value)" == "$before_pid" \
  && "$(systemctl show stay.service -p NRestarts --value)" == "$before_restarts" \
  && "$(durable_runtime_revision)" == 127 \
  && "$(readlink -f /opt/stay/current)" == "$ACTIVE_RELEASE" \
  && "$(sha256_file "$DATABASE")" == "$before_database_sha256" ]] ||
  abort candidate-tests-mutated-production 2510

manifest_digest="$(sha256_file "$STAGE_ROOT/$TARGET_MANIFEST")"
NEW_RELEASE="/opt/stay/releases/0.8.11.3-p1m-r127-metab-final-${manifest_digest:0:12}"
[[ "$NEW_RELEASE" == "$STAY_R127_TARGET_RELEASE" \
  && ! -e "$NEW_RELEASE" && ! -L "$NEW_RELEASE" ]] ||
  abort target-release-identity-invalid 2510
cat > "$CANDIDATE/$TARGET_RELEASE_ENV" <<EOF
P1_R127_FINAL_RECOVERY=PASS
P1_R127_POST_RESTART_CONTINUITY_RECOVERY=PASS
SOURCE_RELEASE=$ACTIVE_RELEASE
SOURCE_RUNTIME_REVISION=R127_FAILED_POST_RESTART_CONTINUITY
TARGET_RUNTIME_REVISION=R127F
RELEASE_TAG=$STAY_R127_RECOVERY_ARTIFACT_TAG
RELEASE_COMMIT=$STAY_R127_RECOVERY_ARTIFACT_COMMIT
RELEASE_TREE=$STAY_R127_RECOVERY_ARTIFACT_TREE
ARCHIVE_SHA256=$STAY_R127_RECOVERY_ARTIFACT_ARCHIVE_SHA256
MANIFEST_SHA256=$STAY_R127_RECOVERY_ARTIFACT_MANIFEST_SHA256
SOURCE_RELEASE_TREE_SHA256=sha256:$ACTIVE_TREE_SHA256
PARENT_FREEZE_RECORD_SHA256=sha256:$PARENT_FREEZE_SHA256
RECOVERY_MARKER_SHA256=sha256:$RECOVERY_MARKER_SHA256
FAILED_R124_EVIDENCE=$FAILED_R124_EVIDENCE
STRANDED_R127_EVIDENCE=$FAILED_R127_EVIDENCE
STRANDED_R127_EVIDENCE_TREE_SHA256=sha256:$FAILED_R127_TREE_SHA256
BIRTH_CERTIFICATE_SHA256=sha256:$ACTIVE_CERTIFICATE_SHA256
BIRTH_DOSSIER_SHA256=$STAY_R127_BIRTH_DOSSIER_SHA256
BIRTH_PUBLIC_KEY_SHA256=sha256:$ACTIVE_PUBLIC_KEY_SHA256
METAB_VERSION=0.1.0-p1r0-neutral.1
METAB_MODE=NEUTRAL
METAB_AUTHORITY=NONE
METAB_OUTPUTS=0
EOF
chown root:root "$CANDIDATE/$TARGET_RELEASE_ENV"
chmod 0444 "$CANDIDATE/$TARGET_RELEASE_ENV"
[[ "$(find "$CANDIDATE" -type f | wc -l)" -eq "$TARGET_FILE_COUNT" \
  && -z "$(find -P "$CANDIDATE" -xdev \
    \( -type l -o -type f -links +1 -o ! -type d ! -type f \) -print -quit)" ]] ||
  abort candidate-tree-invalid 2510
mv -T "$CANDIDATE" "$NEW_RELEASE"
CANDIDATE=''
TARGET_CREATED=1
chmod -R a-w "$NEW_RELEASE"
install -o root -g root -m 0444 "$NEW_RELEASE/$TARGET_RELEASE_ENV" "$WORK/P1_R124_RELEASE.env"

phase 'STAGE EXACT R127 PRESERVATION FENCE AND COMMIT ONE FORWARD START'
cp "$WORK/birth-dropin.before.conf" "$WORK/birth-dropin.preserved.conf"
printf '%s\n' \
  'Environment=STAY_ALLOW_R127_POST_RESTART_CONTINUITY_RECOVERY=AUTHORIZE_R127_POST_RESTART_FETUS_SNTSS_CHRONOBIOLOGY_CONTINUITY_ONLY' \
  >> "$WORK/birth-dropin.preserved.conf"
install_atomic "$WORK/birth-dropin.preserved.conf" "$BIRTH_DROPIN" 0644
DROPIN_CHANGED=1
systemctl daemon-reload
point_current "$NEW_RELEASE"
POINTER_CHANGED=1
[[ "$(stat -Lc '%U:%G:%a' "$RECOVERY_MARKER")" == 'root:staydeploy:440' \
  && "$(sha256_file "$RECOVERY_MARKER")" == "$RECOVERY_MARKER_SHA256" \
  && "$(systemctl show stay.service -p MainPID --value)" == "$before_pid" \
  && "$(durable_runtime_revision)" == 127 \
  && "$(readlink -f /opt/stay/current)" == "$NEW_RELEASE" ]] ||
  abort pre-restart-preservation-fence-failed 2510

RESTART_COMMITTED=1
systemctl start stay.service
ready=0
for attempt in $(seq 1 20); do
  after_pid="$(systemctl show stay.service -p MainPID --value)"
  after_restarts="$(systemctl show stay.service -p NRestarts --value)"
  if [[ "$after_pid" =~ ^[1-9][0-9]*$ \
    && "$after_restarts" == "$before_restarts" \
    && "$(systemctl show stay.service -p ActiveState --value)" == active \
    && "$(systemctl show stay.service -p SubState --value)" == running \
    && "$(durable_runtime_revision)" == 127 \
    && "$(readlink -f /opt/stay/current)" == "$NEW_RELEASE" \
    && -S "$SOCKET" && ! -L "$SOCKET" ]] \
    && curl --fail --silent --max-time 1 http://127.0.0.1:8787/healthz | grep -q '"revision":127'; then
    ready=1
    printf '%s\n' "$attempt" > "$WORK/restart-readiness.attempts"
    break
  fi
  sleep 0.25
done
[[ "$ready" -eq 1 ]] || abort r127-preserving-restart-readiness-failed 2511

phase 'PROVE CONTAINED METAB BIRTH AND PRESERVED RESIDENTS'
capture_quiescent_database "$WORK/database.after.json" || abort database-after-not-quiescent 2512
/usr/local/bin/node "$CONTROL_CLIENT" status resident:sntss > "$WORK/sntss.after.json"
/usr/local/bin/node "$CONTROL_CLIENT" status resident:chronobiology > "$WORK/chronobiology.after.json"
/usr/local/bin/node "$CONTROL_CLIENT" status resident:metab > "$WORK/metab.after.json"
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.after.json"
/usr/local/bin/node - "$before_pid" "$after_pid" "$before_restarts" "$after_restarts" \
  > "$WORK/service.after.json" <<'NODE'
'use strict';
const [beforePid, afterPid, beforeRestarts, afterRestarts] = process.argv.slice(2).map(Number);
process.stdout.write(`${JSON.stringify({ beforePid, afterPid, beforeRestarts, afterRestarts,
  startCommands: 1, restartCommands: 0 })}\n`);
NODE
/usr/local/bin/node - "$NEW_RELEASE" "$DATABASE" "$WORK" > "$WORK/after.proof.json" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [releaseRoot, databasePath, root] = process.argv.slice(2);
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const fail = message => { throw new Error(message); };
const assert = (value, message) => { if (!value) fail(message); };
const before = read('before.proof.json');
const database = read('database.after.json');
const sntssStatus = read('sntss.after.json').resident;
const chronobiologyStatus = read('chronobiology.after.json').resident;
const metabStatus = read('metab.after.json').resident;
const meta = read('meta.after.json');
const service = read('service.after.json');
const db = new DatabaseSync(databasePath, { open: true, readOnly: true });
db.exec('PRAGMA query_only=ON');
const resident = id => database.residents.find(row => row.residency_id === id);
const consumer = id => database.consumers.find(row => row.consumer_id === id);
const sntss = resident('resident:sntss');
const chrono = resident('resident:chronobiology');
const metab = resident('resident:metab');
const fetusConsumer = consumer('core:fetus-legacy');
const authority = db.prepare('SELECT * FROM authority ORDER BY core_id').all();
const fetusCheckpoint = db.prepare(
  "SELECT * FROM checkpoints WHERE core_id='fetus-legacy' ORDER BY generation DESC LIMIT 1"
).get();
const recoveryRow = type => db.prepare(
  'SELECT id, detail_json FROM recovery_records WHERE type=? ORDER BY id DESC LIMIT 1'
).get(type);
const continuity = recoveryRow('runtime.r127-post-restart-continuity-recovered');
const continuityDetail = JSON.parse(continuity?.detail_json || 'null');
const fetusResync = recoveryRow('biological.consumer-resynchronized');
const fetusResyncDetail = JSON.parse(fetusResync?.detail_json || 'null');
const superseded = db.prepare(`
  SELECT core_id, detail_json FROM recovery_records
  WHERE type='resident.restart-pulse-superseded' ORDER BY id
`).all().map(row => ({ coreId: row.core_id, detail: JSON.parse(row.detail_json) }));
const laterRewinds = Number(db.prepare(`
  SELECT COUNT(*) count FROM recovery_records
  WHERE id>120 AND type='resident.resync-required'
`).get().count);
const highWater = Number(db.prepare(
  'SELECT COALESCE(MAX(sequence), 0) value FROM biological_events'
).get().value);
const newPulses = db.prepare(`
  SELECT topic, deduplication_key, envelope_json FROM biological_events
  WHERE sequence>3654057 AND topic IN (
    'runtime.time.pulse', 'runtime.trusted-organism-time.pulse'
  ) ORDER BY sequence
`).all();
const firstPulse = topic => newPulses.find(row => row.topic === topic);
const parsePulse = row => row && JSON.parse(row.envelope_json);
const firstTimePulse = firstPulse('runtime.time.pulse');
const firstTrustedPulse = firstPulse('runtime.trusted-organism-time.pulse');
const firstTimeEnvelope = parsePulse(firstTimePulse);
const firstTrustedEnvelope = parsePulse(firstTrustedPulse);
const { recordHash, validateFounderRecord, validateChipRecord } = require(
  path.join(releaseRoot, 'runtime/p1-r0/records.js')
);
const founder = validateFounderRecord(JSON.parse(database.founders[0]?.record_json || 'null'));
const chip = validateChipRecord(JSON.parse(database.chips[0]?.record_json || 'null'));
const contained = (status, label) => {
  const policy = status?.host?.resourceGovernor?.policy;
  const limits = status?.host?.osContainment?.limits;
  assert(status?.status === 'RUNNING' && status?.running === true &&
    status?.authorityOwned === false && status?.host?.quarantined === false &&
    status?.host?.osContainment?.required === true &&
    status?.host?.osContainment?.available === true &&
    status?.host?.osContainment?.payloadSandboxed === true &&
    status?.host?.osContainment?.payloadAttachedBeforeInit === true &&
    status?.host?.osContainment?.supervisorChargedToKernel === true &&
    policy?.softRamBytes === 64 * 1024 * 1024 &&
    policy?.hardRamBytes === 96 * 1024 * 1024 && policy?.hardCpuDuty === 0.2 &&
    policy?.queueCapacity === 256 && policy?.handlerTimeoutMs === 250 &&
    policy?.pidsMax === 16 && limits?.['memory.high'] === String(64 * 1024 * 1024) &&
    limits?.['memory.max'] === String(96 * 1024 * 1024) && limits?.['pids.max'] === '16' &&
    limits?.['cpu.max'] === '20000 100000', `${label} containment changed`);
};
contained(sntssStatus, 'SNTSS');
contained(chronobiologyStatus, 'Chronobiology');
contained(metabStatus, 'METAB');
assert(before.result === 'PASS' && before.runtimeRevision === 127 &&
  before.pendingDeliveries === 2 && before.abandonedDeliveries === 0,
  'before proof is not the exact stopped cohort');
assert(database.quickCheck === 'ok' && database.queryOnly === true &&
  database.runtimeRevision === 127 && database.pendingDeliveries === 0 &&
  database.pendingOutboxIntents === 0 && database.failedDeliveries === 0 &&
  database.abandonedDeliveries === 0 && database.p1Authority === 0 &&
  database.sntssAuthority === 0 && database.chronobiologyAuthority === 0 &&
  database.residents.length === 3 && database.consumers.length === 4 &&
  database.founders.length === 1 && database.dossiers.length === 1 &&
  database.chips.length === 1 && database.metabCheckpoints >= 2 &&
  database.metabChipHistory >= 2, 'database acceptance failed');
assert(sntss?.instance_id === '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f' &&
  sntss?.version === '0.5.0-i4g1' && sntss?.status === 'RUNNING' &&
  Number(sntss?.checkpoint_generation) > before.sntssCheckpointGeneration &&
  chrono?.instance_id === 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a' &&
  chrono?.version === '1.0.0-c3rc.5' && chrono?.status === 'RUNNING' &&
  Number(chrono?.checkpoint_generation) > before.chronobiologyCheckpointGeneration &&
  metab?.instance_id === 'd424c722-ef31-44b0-8201-ba68c418d14a' &&
  metab?.version === '0.1.0-p1r0-neutral.1' && metab?.status === 'RUNNING' &&
  Number(metab?.checkpoint_generation) >= 2 &&
  metab?.checkpoint_hash === before.metabCheckpointHash,
  'resident continuity changed');
for (const id of ['resident:sntss', 'resident:chronobiology', 'resident:metab']) {
  const current = consumer(id);
  assert(Number(current?.active) === 1 && Number(current?.required) === 0 &&
    Number(current?.authority_epoch) === 0 && Number(current?.cursor) >= 3654057,
    `${id} consumer containment changed`);
}
assert(Number(fetusConsumer?.active) === 1 && Number(fetusConsumer?.required) === 1 &&
  fetusConsumer?.topics_json === '[]' && Number(fetusConsumer?.authority_epoch) === 1 &&
  Number(fetusConsumer?.cursor) >= 3654057 && authority.length === 1 &&
  authority[0]?.core_id === 'fetus-legacy' &&
  authority[0]?.instance_id === '82202211-8dd6-44d4-a4ec-8f2553d8dc6f' &&
  authority[0]?.version === '0.6.0' && Number(authority[0]?.epoch) === 1 &&
  authority[0]?.checkpoint_hash === fetusCheckpoint?.blob_hash &&
  Number(fetusCheckpoint?.generation) >= before.fetusCheckpointGeneration,
  'fetus continuity changed');
assert(continuityDetail?.cohort === 'r127-post-restart-continuity-v1' &&
  continuityDetail?.runtimeRevision === 127 &&
  continuityDetail?.fetusDemotionId === 116 &&
  continuityDetail?.acknowledgedPendingDeliveryCount === 2 &&
  continuityDetail?.supersededInputPulseCount === 1289 &&
  continuityDetail?.nonInputEventCount === 1288 &&
  continuityDetail?.abandonedCount === 0 &&
  continuityDetail?.inventedBiologicalTime === false &&
  continuityDetail?.authorityChanged === false &&
  fetusResyncDetail?.demotionId === 116 && fetusResyncDetail?.physiologyApplied === 0 &&
  fetusResyncDetail?.abandonedCount === 0 &&
  superseded.length === 2 && superseded.every(row =>
    row.detail?.checkpointBytesChanged === false &&
    row.detail?.biologicalStateChanged === false &&
    row.detail?.abandonedCount === 0 && row.detail?.inventedBiologicalTime === false &&
    row.detail?.authorityChanged === false) && laterRewinds === 0,
  'recovery evidence is not exact');
assert(firstTimeEnvelope?.payload?.runtimeRevision === 127 &&
  firstTimeEnvelope?.payload?.pulseSequence === 23829 &&
  firstTimePulse?.deduplication_key === 'runtime.time.pulse:127:23829' &&
  firstTrustedEnvelope?.payload?.runtimeRevision === 127 &&
  firstTrustedEnvelope?.payload?.pulseSequence === 101 &&
  firstTrustedPulse?.deduplication_key === 'runtime.trusted-organism-time.pulse:127:101' &&
  highWater > 3654057, 'trusted pulse continuity did not resume');
assert(sntssStatus.observedOutputs === 0 && sntssStatus.health?.biologicalOutputs === 0 &&
  sntssStatus.health?.trustedPulseSequence >= 23829 &&
  sntssStatus.health?.runtimeRevision === 127 &&
  metabStatus.productionEligible === false && metabStatus.signalling === 'FORBIDDEN' &&
  metabStatus.declaredOutputs === 0 && metabStatus.observedOutputs === 0 &&
  metabStatus.handledEvents === 0 && metabStatus.health?.mode === 'NEUTRAL' &&
  metabStatus.health?.biologicalOutputs === 0, 'shadow or neutral containment changed');
assert(database.founders[0].record_hash === recordHash(founder) &&
  founder.organismId === database.identity.organismId && founder.coreId === 'METAB' &&
  database.chips[0].record_hash === recordHash(chip) && chip.currentState === 'NEUTRAL' &&
  chip.mode === 'NEUTRAL' && chip.historyHeadHash === database.chips[0].history_head_hash,
  'founder or chip custody changed');
const lifecycleChip = id => meta?.chipProjection?.lifecycle?.find(row => row.coreId === id);
const bsf = meta?.systems?.find(row => row.id === 'bsf');
const fetus = meta?.cores?.find(row => row.id === 'fetus-legacy');
assert(meta?.ok === true && meta?.revision === 127 && meta?.revisionFrozen === false &&
  lifecycleChip('bsf')?.state === 'LIVE' && lifecycleChip('sntss')?.state === 'SHADOW' &&
  lifecycleChip('chronobiology')?.state === 'SHADOW' &&
  lifecycleChip('metab')?.state === 'NEUTRAL' && lifecycleChip('metab')?.born === true &&
  bsf?.mode === 'LIVE' && bsf?.status === 'RUNNING' && bsf?.healthOk === true &&
  fetus?.ok === true && fetus?.memoryGuardian?.status === 'healthy' &&
  fetus?.memoryGuardian?.warnAtMiB === 192 && fetus?.memoryGuardian?.recycleAtMiB === 256,
  'live metadata acceptance failed');
assert(service.beforePid === 0 && service.afterPid > 0 &&
  service.beforeRestarts === 0 && service.afterRestarts === 0 &&
  service.startCommands === 1 && service.restartCommands === 0,
  'service start evidence changed');
db.close();
const proof = Object.freeze({
  result: 'PASS', runtimeRevision: 127, startCommands: 1, restartCommands: 0,
  founderId: founder.founderId, instanceId: metab.instance_id,
  checkpointGeneration: Number(metab.checkpoint_generation), authorityOwned: false,
  observedOutputs: 0, chipState: 'NEUTRAL', abandonedDeliveries: 0,
  sntssCheckpointGeneration: Number(sntss.checkpoint_generation),
  chronobiologyCheckpointGeneration: Number(chrono.checkpoint_generation),
  fetusCheckpointGeneration: Number(fetusCheckpoint.generation),
  ledgerHighWater: highWater
});
process.stdout.write(`${JSON.stringify(proof)}\n`);
NODE

phase 'REVOKE ONE-SHOT AUTHORITY AND FREEZE R127'
rm -f -- "$BIRTH_DROPIN" "$ACTIVE_CERTIFICATE" "$ACTIVE_PUBLIC_KEY"
systemctl daemon-reload
rm -f -- "$RECOVERY_MARKER"
[[ ! -e "$BIRTH_DROPIN" && ! -L "$BIRTH_DROPIN" \
  && ! -e "$ACTIVE_CERTIFICATE" && ! -L "$ACTIVE_CERTIFICATE" \
  && ! -e "$ACTIVE_PUBLIC_KEY" && ! -L "$ACTIVE_PUBLIC_KEY" \
  && ! -e "$RECOVERY_MARKER" && ! -L "$RECOVERY_MARKER" ]] ||
  abort one-shot-authority-revocation-failed 2513

/usr/local/bin/node - "$NEW_RELEASE" "$WORK" > "$WORK/R127.freeze.json" <<'NODE'
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [releaseRoot, evidenceRoot] = process.argv.slice(2);
const { sealRevisionFreeze, validateRevisionFreeze } = require(path.join(releaseRoot, 'runtime/revision-freeze.js'));
const read = name => JSON.parse(fs.readFileSync(path.join(evidenceRoot, name), 'utf8'));
const hash = name => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(evidenceRoot, name))).digest('hex')}`;
const before = read('before.proof.json');
const after = read('after.proof.json');
const service = read('service.after.json');
const release = Object.fromEntries(fs.readFileSync(path.join(evidenceRoot, 'P1_R124_RELEASE.env'), 'utf8')
  .trim().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
if (!(before.result === 'PASS' && before.runtimeRevision === 127 &&
  before.pendingDeliveries === 2 && before.abandonedDeliveries === 0 && after.result === 'PASS' &&
  after.runtimeRevision === 127 && after.startCommands === 1 && after.restartCommands === 0 &&
  after.authorityOwned === false && after.observedOutputs === 0 &&
  after.chipState === 'NEUTRAL' && after.abandonedDeliveries === 0)) process.exit(2);
const evidenceNames = [
  'before.proof.json', 'after.proof.json', 'database.stranded.json', 'database.after.json',
  'sntss.after.json', 'chronobiology.after.json', 'metab.after.json', 'meta.after.json',
  'service.after.json', 'restart-readiness.attempts', 'r124-failed-birth-recovery.env',
  'metab-neutral-birth-certificate.json', 'metab-neutral-founder-dossier.json',
  'metab-neutral-birth-authority.pub', 'P1_R124_RELEASE.env',
  'source.P1_R124_RELEASE.env', 'birth-dropin.before.conf', 'birth-dropin.preserved.conf',
  'focused-tests.tap', 'real-metab-entry.tap', 'real-r127-post-restart-entry.tap',
  'chronobiology-entry.proof.json'
];
const record = sealRevisionFreeze({
  format: 'stay-runtime-revision-freeze-v1', result: 'PASS', acceptance: 'ACCEPTED',
  freezeType: 'R127_POST_RESTART_CONTINUITY_FORWARD_RECOVERY',
  runtime: { revision: 127, revisionLabel: 'R127F', progression: [123, 124, 125, 126, 127],
    serviceMainPid: service.afterPid, serviceNRestarts: service.afterRestarts,
    startCommands: service.startCommands, restartCommands: service.restartCommands },
  parentFreeze: { revision: 123,
    recordSha256: 'sha256:161b5fe340ef01836447e21c0e77167cac86033973f8a06b3c1af1d7b44fa3cc' },
  benchmark: { result: 'PASS', samples: 4312,
    adjudicationSha256: 'sha256:a78cd8281d246d851e3476f8da50964bc7e9556a8760439099dd727ecadfc6e4',
    witnessSha256: 'sha256:80c383e7b9b15c3da64b29e14d2ca4800d8ad64f19b63dd44ec401afa8564cfc' },
  release: { path: releaseRoot, tag: release.RELEASE_TAG, commit: release.RELEASE_COMMIT,
    tree: release.RELEASE_TREE, archiveSha256: release.ARCHIVE_SHA256,
    manifestSha256: release.MANIFEST_SHA256 },
  metab: { residencyId: 'resident:metab', version: '0.1.0-p1r0-neutral.1', mode: 'NEUTRAL',
    founderId: after.founderId, instanceId: after.instanceId,
    checkpointGeneration: after.checkpointGeneration, authorityOwned: false,
    observedOutputs: 0, signalling: 'FORBIDDEN', productionEligible: false },
  continuity: { sntssCheckpointGenerationBefore: before.sntssCheckpointGeneration,
    sntssCheckpointHashBefore: before.sntssCheckpointHash,
    chronobiologyCheckpointGenerationBefore: before.chronobiologyCheckpointGeneration,
    chronobiologyCheckpointHashBefore: before.chronobiologyCheckpointHash,
    fetusCheckpointGenerationBefore: before.fetusCheckpointGeneration,
    fetusCheckpointHashBefore: before.fetusCheckpointHash,
    sntssCheckpointGeneration: after.sntssCheckpointGeneration,
    chronobiologyCheckpointGeneration: after.chronobiologyCheckpointGeneration,
    fetusCheckpointGeneration: after.fetusCheckpointGeneration,
    pendingDeliveriesBefore: before.pendingDeliveries, pendingDeliveries: 0,
    pendingOutboxIntents: 0, abandonedDeliveries: after.abandonedDeliveries,
    acknowledgedPendingDeliveries: 2, supersededRestartPulses: 1289,
    inventedBiologicalTime: false, authorityChanged: false },
  recovery: { sourceRevision: 127, birthRevision: 127, acceptedRevision: 127,
    failureMarkerSha256: release.RECOVERY_MARKER_SHA256,
    failureEvidence: release.FAILED_R124_EVIDENCE,
    strandedR127Evidence: release.STRANDED_R127_EVIDENCE,
    strandedR127EvidenceTreeSha256: release.STRANDED_R127_EVIDENCE_TREE_SHA256,
    markerAccessRepaired: true, kernelRevisionPreserved: true,
    fetusInstallRevisionPreserved: true, revisionFenced: true, pointerRewound: false },
  birthAuthority: { active: false, certificateSha256: release.BIRTH_CERTIFICATE_SHA256,
    dossierSha256: release.BIRTH_DOSSIER_SHA256,
    publicKeySha256: release.BIRTH_PUBLIC_KEY_SHA256 },
  evidence: Object.fromEntries(evidenceNames.map(name => [name, hash(name)])),
  capturedAt: new Date().toISOString()
});
if (!validateRevisionFreeze(record, 127)) process.exit(3);
process.stdout.write(`${JSON.stringify(record)}\n`);
NODE
install_freeze_atomic "$WORK/R127.freeze.json"

curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.frozen.json"
/usr/local/bin/node - "$WORK/meta.frozen.json" <<'NODE'
'use strict';
const fs = require('node:fs');
const meta = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const chip = id => meta.chipProjection?.lifecycle?.find(value => value.coreId === id);
if (!(meta.ok === true && meta.revision === 127 && meta.revisionFrozen === true &&
  meta.revisionLabel === 'R127F' && chip('bsf')?.state === 'LIVE' &&
  chip('sntss')?.state === 'SHADOW' && chip('chronobiology')?.state === 'SHADOW' &&
  chip('metab')?.state === 'NEUTRAL' && chip('metab')?.born === true)) process.exit(1);
NODE
[[ "$(systemctl show stay.service -p MainPID --value)" == "$after_pid" \
  && "$(systemctl show stay.service -p NRestarts --value)" == "$after_restarts" \
  && "$(durable_runtime_revision)" == 127 \
  && "$(readlink -f /opt/stay/current)" == "$NEW_RELEASE" ]] ||
  abort final-live-fence-failed 2514

final_evidence="$EVIDENCE_ROOT/R127F-REVISION-PRESERVING-RECOVERY-$(date -u +'%Y%m%dT%H%M%SZ')"
[[ ! -e "$final_evidence" && ! -L "$final_evidence" ]] || abort evidence-target-present 2515
mv -T "$WORK" "$final_evidence"
WORK=''
chmod -R a-w "$final_evidence"
COMPLETED=1

printf '%s\n' \
  'R127_METAB_REVISION_PRESERVING_FORWARD_RECOVERY=PASS' \
  'RUNTIME_REVISION_AFTER=127' \
  'REVISION_LABEL=R127F' \
  "CURRENT_RELEASE=$NEW_RELEASE" \
  "SERVICE_PID=$after_pid" \
  "SERVICE_NRESTARTS=$after_restarts" \
  'START_COMMANDS=1' \
  'RESTART_COMMANDS=0' \
  'BSF_MODE=LIVE' \
  'SNTSS_MODE=SHADOW' \
  'SNTSS_AUTHORITY=NONE' \
  'SNTSS_OUTPUTS=0' \
  'CHRONOBIOLOGY_MODE=SHADOW' \
  'CHRONOBIOLOGY_STATUS=RUNNING' \
  'CHRONOBIOLOGY_AUTHORITY=NONE' \
  'METAB_MODE=NEUTRAL' \
  'METAB_STATUS=RUNNING' \
  'METAB_AUTHORITY=NONE' \
  'METAB_OUTPUTS=0' \
  'METAB_SIGNALLING=FORBIDDEN' \
  'FETUS_CONTINUITY=PASS' \
  'WEB_CHIP_BSF=LIVE' \
  'WEB_CHIP_SNTSS=SHADOW' \
  'WEB_CHIP_CHRONOBIOLOGY=SHADOW' \
  'WEB_CHIP_METAB=NEUTRAL' \
  'BIRTH_AUTHORITY_ACTIVE=NO' \
  "FREEZE_FILE=$TARGET_FREEZE" \
  "EVIDENCE_ROOT=$final_evidence"
