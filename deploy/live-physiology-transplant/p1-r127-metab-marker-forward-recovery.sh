#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

EXPECTED_PRIVATE_IPV4='172.26.9.207'
ACTIVE_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r127-metab-repair-fb8d675114b4'
ACTIVE_MANIFEST='deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R123F_TO_R124.sha256'
ACTIVE_MANIFEST_SHA256='fb8d675114b4d35a8d478c69b547910014234e63df1b928876fed7c49cbf2dcf'
ACTIVE_RELEASE_ENV_SHA256='c82a2454d50ca1602dbdab0b3db532963a17e8913b3ff2475182eb7b004f921d'
ACTIVE_RELEASE_TAG='r127-metab-repair-v3'
ACTIVE_RELEASE_COMMIT='32285612ec0d9fedf783c2773e724ead70484e19'
ACTIVE_RELEASE_TREE='cc7fc03edb43781ad35a1fb7a25cffa8453cabfd'
ACTIVE_ARCHIVE_SHA256='sha256:aa4924851dba2b5cca30f66af607f9d6d5db31af133b41f69c61a0e0afe60fff'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
SOCKET='/run/stay/resident-control.sock'
RECOVERY_MARKER='/run/stay-r124-metab-neutral-recovery.env'
RECOVERY_MARKER_SHA256='933b128f24d4898550add86f4b34174f18b42e942391ec479f8956689624bb5e'
BIRTH_DROPIN='/etc/systemd/system/stay.service.d/p1-r124-metab-neutral-birth-once.conf'
BIRTH_DROPIN_SHA256='3b1e2604b9cdc22c841f26145f8be8e705682a450898c3ff54abf964de98564d'
ACTIVE_CERTIFICATE='/etc/stay/resident-promotions/resident-metab-neutral-birth.json'
ACTIVE_CERTIFICATE_SHA256='5fde5160f4a6dac8f97b546ef9b3458b64185465944c07e6c89a915912d2b4a6'
ACTIVE_PUBLIC_KEY='/etc/stay/metab-neutral-birth-authority.pub'
ACTIVE_PUBLIC_KEY_SHA256='754f949e67c31bc25b3bdf66e74a9b69ad44f781d43606b7a46ac69531e0551e'
TARGET_FREEZE='/var/lib/stay/evidence/runtime-freezes/R127.json'
PARENT_FREEZE_SHA256='161b5fe340ef01836447e21c0e77167cac86033973f8a06b3c1af1d7b44fa3cc'
FAILED_R124_EVIDENCE='/var/lib/stay/evidence/production-hardening/FAILED-R124-20260902T144307Z.eMKkA2'
FAILED_R127_EVIDENCE='/var/lib/stay/evidence/production-hardening/FAILED-R127-20260902T163941Z.Mgo5vp'
FAILED_R127_FILE_COUNT=18
FAILED_R127_TREE_SHA256='4ad25c8997996399919841b2b5d31059665ebd28fc0a026ac7a97b46cb8f03b4'
EXPECTED_STRANDED_PID=434252
EVIDENCE_ROOT='/var/lib/stay/evidence/production-hardening'
SCRIPT_DIRECTORY="$(dirname -- "$(readlink -f -- "$0")")"
LIVE_PROOF="$SCRIPT_DIRECTORY/p1-r124-metab-neutral-live-proof.js"
CONTROL_CLIENT="$SCRIPT_DIRECTORY/p1-resident-control-client.js"

: "${STAY_R127_MARKER_RECOVERY_AUTHORIZATION:?}"
: "${STAY_R127_RECOVERY_ARTIFACT_TAG:?}"
: "${STAY_R127_RECOVERY_ARTIFACT_COMMIT:?}"
: "${STAY_R127_RECOVERY_ARTIFACT_TREE:?}"
: "${STAY_R127_RECOVERY_ARTIFACT_ARCHIVE_SHA256:?}"
: "${STAY_R127_RECOVERY_ARTIFACT_MANIFEST_SHA256:?}"
: "${STAY_R127_RECOVERY_CONTROLLER_SHA256:?}"
: "${STAY_R127_BIRTH_DOSSIER_FILE:?}"
: "${STAY_R127_BIRTH_DOSSIER_SHA256:?}"

WORK=''
MARKER_REPAIRED=0
RESTART_COMMITTED=0
COMPLETED=0

phase() { printf '===== %s =====\n' "$1"; }
abort() { printf 'R127_MARKER_RECOVERY_ABORT=%s\n' "$1" >&2; exit "${2:-1}"; }
sha256_file() { sha256sum "$1" | awk '{print $1}'; }

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

install_marker_atomic() {
  local temporary
  temporary="$(mktemp /run/.stay-r127-marker.XXXXXX)"
  install -o root -g staydeploy -m 0440 "$RECOVERY_MARKER" "$temporary"
  [[ "$(sha256_file "$temporary")" == "$RECOVERY_MARKER_SHA256" ]]
  mv -fT "$temporary" "$RECOVERY_MARKER"
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
    failed="$(mktemp -d "$EVIDENCE_ROOT/FAILED-R127-MARKER-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
    rmdir -- "$failed"
    if mv -T "$WORK" "$failed"; then
      WORK=''
      chmod -R a-w "$failed" || true
      printf 'R127_MARKER_FAILURE_EVIDENCE=%s\n' "$failed" >&2
    fi
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$COMPLETED" -eq 0 && "$RESTART_COMMITTED" -eq 0 && "$MARKER_REPAIRED" -eq 1 ]]; then
    chown root:root "$RECOVERY_MARKER" || true
    chmod 0600 "$RECOVERY_MARKER" || true
  fi
  if [[ "$COMPLETED" -eq 0 ]]; then
    archive_failure_work
    if [[ "$RESTART_COMMITTED" -eq 1 ]]; then
      printf 'R127_MARKER_POST_RESTART=LEFT_REVISION_FENCED_FOR_FORWARD_RECOVERY\n' >&2
    else
      printf 'R127_MARKER_ROLLBACK=PRE_RESTART_MARKER_STATE_RESTORED\n' >&2
    fi
  fi
  [[ -n "$WORK" && -d "$WORK" ]] && rm -rf --one-file-system -- "$WORK"
  exit "$status"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 2501
[[ "$STAY_R127_MARKER_RECOVERY_AUTHORIZATION" == \
  'AUTHORIZE_R127_METAB_MARKER_FORWARD_RECOVERY_ONLY' ]] || abort authorization-required 2502
[[ "$STAY_R127_RECOVERY_ARTIFACT_TAG" =~ ^r127-metab-marker-recovery-v[0-9]+$ \
  && "$STAY_R127_RECOVERY_ARTIFACT_COMMIT" =~ ^[0-9a-f]{40}$ \
  && "$STAY_R127_RECOVERY_ARTIFACT_TREE" =~ ^[0-9a-f]{40}$ \
  && "$STAY_R127_RECOVERY_ARTIFACT_ARCHIVE_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R127_RECOVERY_ARTIFACT_MANIFEST_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R127_RECOVERY_CONTROLLER_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R127_BIRTH_DOSSIER_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  abort artifact-identity-invalid 2503
[[ "$(ip -o -4 addr show scope global | awk '{address=$4; sub(/\/.*/, "", address); print address}' | sort -u)" == \
  "$EXPECTED_PRIVATE_IPV4" ]] || abort host-identity-mismatch 2504

phase 'EXACT READ-ONLY R126 STRANDED MARKER PREFLIGHT'
[[ "$(readlink -f /opt/stay/current)" == "$ACTIVE_RELEASE" \
  && -d "$ACTIVE_RELEASE" && ! -L "$ACTIVE_RELEASE" \
  && "$(sha256_file "$ACTIVE_RELEASE/$ACTIVE_MANIFEST")" == "$ACTIVE_MANIFEST_SHA256" \
  && "$(sha256_file "$ACTIVE_RELEASE/P1_R124_RELEASE.env")" == "$ACTIVE_RELEASE_ENV_SHA256" ]] ||
  abort active-release-identity-invalid 2505
(cd "$ACTIVE_RELEASE" && sha256sum -c "$ACTIVE_MANIFEST" >/dev/null) ||
  abort active-release-manifest-invalid 2505
[[ ! -e "$TARGET_FREEZE" && ! -L "$TARGET_FREEZE" ]] || abort freeze-already-present 2506
[[ -d "$FAILED_R127_EVIDENCE" && ! -L "$FAILED_R127_EVIDENCE" \
  && "$(find "$FAILED_R127_EVIDENCE" -type f | wc -l)" -eq "$FAILED_R127_FILE_COUNT" \
  && "$(find "$FAILED_R127_EVIDENCE" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')" == \
    "$FAILED_R127_TREE_SHA256" ]] || abort stranded-evidence-invalid 2507
[[ -f "$RECOVERY_MARKER" && ! -L "$RECOVERY_MARKER" \
  && "$(stat -Lc '%U:%G:%a' "$RECOVERY_MARKER")" == 'root:root:600' \
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
[[ "$before_pid" -eq "$EXPECTED_STRANDED_PID" && "$before_restarts" =~ ^[0-9]+$ \
  && "$(systemctl show stay.service -p User --value)" == staydeploy \
  && "$(systemctl show stay.service -p Group --value)" == staydeploy \
  && "$(systemctl show stay.service -p ActiveState --value)" == active \
  && "$(systemctl show stay.service -p SubState --value)" == running \
  && "$(durable_runtime_revision)" == 126 ]] || abort stranded-service-fence-invalid 2509
if curl --fail --silent --max-time 1 http://127.0.0.1:8787/healthz >/dev/null; then
  abort stranded-health-unexpectedly-ready 2509
fi

WORK="$(mktemp -d "$EVIDENCE_ROOT/.R127-marker-forward.XXXXXX")"
chmod 0700 "$WORK"
/usr/local/bin/node "$LIVE_PROOF" capture "$DATABASE" > "$WORK/database.stranded.json"
/usr/local/bin/node - "$WORK/database.stranded.json" > "$WORK/before.proof.json" <<'NODE'
'use strict';
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const row = id => value.residents.find(entry => entry.residency_id === id);
const sntss = row('resident:sntss');
const chrono = row('resident:chronobiology');
if (!(value.quickCheck === 'ok' && value.queryOnly === true && value.runtimeRevision === 126 &&
  value.pendingOutboxIntents === 0 && value.p1Authority === 0 && value.sntssAuthority === 0 &&
  value.chronobiologyAuthority === 0 && value.founders.length === 0 && value.dossiers.length === 0 &&
  value.chips.length === 0 && value.metabCheckpoints === 0 && value.metabChipHistory === 0 &&
  !row('resident:metab') && sntss?.instance_id === '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f' &&
  sntss?.version === '0.5.0-i4g1' && chrono?.instance_id === 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a' &&
  chrono?.version === '1.0.0-c3rc.5')) process.exit(1);
process.stdout.write(`${JSON.stringify({ result: 'PASS', runtimeRevision: 126,
  sntssCheckpointGeneration: Number(sntss.checkpoint_generation),
  chronobiologyCheckpointGeneration: Number(chrono.checkpoint_generation) })}\n`);
NODE
install -o root -g root -m 0400 "$RECOVERY_MARKER" "$WORK/r124-failed-birth-recovery.env"
install -o root -g root -m 0400 "$ACTIVE_CERTIFICATE" "$WORK/metab-neutral-birth-certificate.json"
install -o root -g root -m 0400 "$STAY_R127_BIRTH_DOSSIER_FILE" "$WORK/metab-neutral-founder-dossier.json"
install -o root -g root -m 0444 "$ACTIVE_PUBLIC_KEY" "$WORK/metab-neutral-birth-authority.pub"
install -o root -g root -m 0444 "$ACTIVE_RELEASE/P1_R124_RELEASE.env" "$WORK/P1_R124_RELEASE.env"

phase 'ATOMically REPAIR EXACT MARKER ACCESS AND COMMIT ONE FORWARD RESTART'
install_marker_atomic
MARKER_REPAIRED=1
[[ "$(stat -Lc '%U:%G:%a' "$RECOVERY_MARKER")" == 'root:staydeploy:440' \
  && "$(sha256_file "$RECOVERY_MARKER")" == "$RECOVERY_MARKER_SHA256" \
  && "$(systemctl show stay.service -p MainPID --value)" == "$before_pid" \
  && "$(durable_runtime_revision)" == 126 \
  && "$(readlink -f /opt/stay/current)" == "$ACTIVE_RELEASE" ]] ||
  abort pre-restart-marker-fence-failed 2510

RESTART_COMMITTED=1
systemctl restart stay.service
ready=0
for attempt in $(seq 1 20); do
  after_pid="$(systemctl show stay.service -p MainPID --value)"
  after_restarts="$(systemctl show stay.service -p NRestarts --value)"
  if [[ "$after_pid" =~ ^[1-9][0-9]*$ && "$after_pid" != "$before_pid" \
    && "$after_restarts" == "$before_restarts" \
    && "$(systemctl show stay.service -p ActiveState --value)" == active \
    && "$(systemctl show stay.service -p SubState --value)" == running \
    && "$(durable_runtime_revision)" == 127 \
    && "$(readlink -f /opt/stay/current)" == "$ACTIVE_RELEASE" \
    && -S "$SOCKET" && ! -L "$SOCKET" ]] \
    && curl --fail --silent --max-time 1 http://127.0.0.1:8787/healthz | grep -q '"revision":127'; then
    ready=1
    printf '%s\n' "$attempt" > "$WORK/restart-readiness.attempts"
    break
  fi
  sleep 0.25
done
[[ "$ready" -eq 1 ]] || abort r127-marker-restart-readiness-failed 2511

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
  restartCommands: 3 })}\n`);
NODE
/usr/local/bin/node - "$LIVE_PROOF" "$WORK" > "$WORK/after.proof.json" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [helper, root] = process.argv.slice(2);
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const proof = require(helper).validateMarkerRecoveryAfter({
  before: read('before.proof.json'), database: read('database.after.json'),
  sntssStatus: read('sntss.after.json'), chronobiologyStatus: read('chronobiology.after.json'),
  metabStatus: read('metab.after.json'), meta: read('meta.after.json'),
  service: read('service.after.json')
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

/usr/local/bin/node - "$ACTIVE_RELEASE" "$WORK" > "$WORK/R127.freeze.json" <<'NODE'
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
if (!(before.result === 'PASS' && before.runtimeRevision === 126 && after.result === 'PASS' &&
  after.runtimeRevision === 127 && after.restartCommands === 3 && after.authorityOwned === false &&
  after.observedOutputs === 0 && after.chipState === 'NEUTRAL')) process.exit(2);
const evidenceNames = [
  'before.proof.json', 'after.proof.json', 'database.stranded.json', 'database.after.json',
  'sntss.after.json', 'chronobiology.after.json', 'metab.after.json', 'meta.after.json',
  'service.after.json', 'restart-readiness.attempts', 'r124-failed-birth-recovery.env',
  'metab-neutral-birth-certificate.json', 'metab-neutral-founder-dossier.json',
  'metab-neutral-birth-authority.pub', 'P1_R124_RELEASE.env'
];
const record = sealRevisionFreeze({
  format: 'stay-runtime-revision-freeze-v1', result: 'PASS', acceptance: 'ACCEPTED',
  freezeType: 'R127_METAB_NEUTRAL_MARKER_FORWARD_RECOVERY',
  runtime: { revision: 127, revisionLabel: 'R127F', progression: [123, 124, 125, 126, 127],
    serviceMainPid: service.afterPid, serviceNRestarts: service.afterRestarts,
    restartCommands: service.restartCommands },
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
    chronobiologyCheckpointGenerationBefore: before.chronobiologyCheckpointGeneration,
    pendingDeliveries: 0, pendingOutboxIntents: 0, inventedBiologicalTime: false },
  recovery: { sourceRevision: 125, birthRevision: 126, acceptedRevision: 127,
    failureMarkerSha256: release.RECOVERY_MARKER_SHA256,
    failureEvidence: release.FAILED_R124_EVIDENCE,
    markerFailureEvidence: '/var/lib/stay/evidence/production-hardening/FAILED-R127-20260902T163941Z.Mgo5vp',
    markerAccessRepaired: true, revisionFenced: true, pointerRewound: false },
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
  && "$(readlink -f /opt/stay/current)" == "$ACTIVE_RELEASE" ]] ||
  abort final-live-fence-failed 2514

final_evidence="$EVIDENCE_ROOT/R127F-MARKER-RECOVERY-$(date -u +'%Y%m%dT%H%M%SZ')"
[[ ! -e "$final_evidence" && ! -L "$final_evidence" ]] || abort evidence-target-present 2515
mv -T "$WORK" "$final_evidence"
WORK=''
chmod -R a-w "$final_evidence"
COMPLETED=1

printf '%s\n' \
  'R127_METAB_MARKER_FORWARD_RECOVERY=PASS' \
  'RUNTIME_REVISION_AFTER=127' \
  'REVISION_LABEL=R127F' \
  "CURRENT_RELEASE=$ACTIVE_RELEASE" \
  "SERVICE_PID=$after_pid" \
  "SERVICE_NRESTARTS=$after_restarts" \
  'RESTART_COMMANDS=3' \
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
