#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

EXPECTED_PRIVATE_IPV4='172.26.9.207'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
SOURCE_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r119f-chrono-repair-2961f9a48173'
TARGET_MANIFEST='deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R123F_TO_R124.sha256'
TARGET_RELEASE_ENV='P1_R124_RELEASE.env'
ACTIVE_CERTIFICATE='/etc/stay/resident-promotions/resident-metab-neutral-birth.json'
ACTIVE_PUBLIC_KEY='/etc/stay/metab-neutral-birth-authority.pub'
BIRTH_DROPIN='/etc/systemd/system/stay.service.d/p1-r124-metab-neutral-birth-once.conf'
RECOVERY_MARKER='/run/stay-r124-metab-neutral-recovery.env'
EVIDENCE_ROOT='/var/lib/stay/evidence/production-hardening'
SCRIPT_DIRECTORY="$(dirname -- "$(readlink -f -- "$0")")"
STAGE_ROOT="$(readlink -f -- "$SCRIPT_DIRECTORY/../..")"

: "${STAY_R124_RELEASE_TAG:?}"
: "${STAY_R124_RELEASE_COMMIT:?}"
: "${STAY_R124_RELEASE_TREE:?}"
: "${STAY_R124_ARCHIVE_SHA256:?}"
: "${STAY_R124_MANIFEST_SHA256:?}"
: "${STAY_R124_CONTROLLER_SHA256:?}"
: "${STAY_R124_TARGET_RELEASE:?}"
: "${STAY_R124_BIRTH_CERTIFICATE_FILE:?}"
: "${STAY_R124_BIRTH_CERTIFICATE_SHA256:?}"
: "${STAY_R124_BIRTH_DOSSIER_FILE:?}"
: "${STAY_R124_BIRTH_DOSSIER_SHA256:?}"
: "${STAY_R124_BIRTH_PUBLIC_KEY_FILE:?}"
: "${STAY_R124_BIRTH_PUBLIC_KEY_SHA256:?}"

WORK=''
COMPLETED=0

abort() { printf 'R124_METAB_RECOVERY_ABORT=%s\n' "$1" >&2; exit "${2:-1}"; }
sha256_file() { sha256sum "$1" | awk '{print $1}'; }

durable_runtime_revision() {
  STAY_DATABASE="$DATABASE" node <<'NODE'
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

read_marker() {
  local key="$1" value
  value="$(awk -F= -v key="$key" '$1==key {sub(/^[^=]*=/, ""); print; found=1}
    END {if (!found) exit 1}' "$RECOVERY_MARKER")" || return 1
  printf '%s' "$value"
}

install_atomic() {
  local source="$1" target="$2" mode="$3" temporary
  temporary="$(mktemp "$(dirname "$target")/.r124-metab-recovery.XXXXXX")"
  install -o root -g root -m "$mode" "$source" "$temporary"
  mv -fT "$temporary" "$target"
}

capture_quiescent_database() {
  local output="$1" helper="$2" temporary attempt
  temporary="$output.new"
  for attempt in $(seq 1 20); do
    node "$helper" capture "$DATABASE" > "$temporary"
    if node - "$temporary" <<'NODE'
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

remove_active_birth_material() {
  local file
  for file in "$BIRTH_DROPIN" "$ACTIVE_CERTIFICATE" "$ACTIVE_PUBLIC_KEY"; do
    if [[ -e "$file" || -L "$file" ]]; then
      [[ -f "$file" && ! -L "$file" ]] || return 1
      rm -f -- "$file"
    fi
  done
  systemctl daemon-reload
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$COMPLETED" -eq 0 && -n "$WORK" && -d "$WORK" ]]; then
    local failed
    failed="$(mktemp -d "$EVIDENCE_ROOT/FAILED-R124-RECOVERY-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
    rmdir -- "$failed"
    mv -T "$WORK" "$failed" && chmod -R a-w "$failed"
    printf 'R124_RECOVERY_FAILURE_EVIDENCE=%s\n' "$failed" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 2501
[[ "${STAY_R124_RECOVERY_AUTHORIZATION:-}" == 'AUTHORIZE_R124_METAB_NEUTRAL_FORWARD_RECOVERY_ONLY' ]] ||
  abort authorization-required 2502
[[ "$STAY_R124_RELEASE_TAG" =~ ^r124-metab-neutral-v[0-9]+$ \
  && "$STAY_R124_RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ \
  && "$STAY_R124_RELEASE_TREE" =~ ^[0-9a-f]{40}$ \
  && "$STAY_R124_ARCHIVE_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R124_MANIFEST_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R124_CONTROLLER_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R124_TARGET_RELEASE" =~ ^/opt/stay/releases/0\.8\.11\.3-p1m-r124-metab-neutral-[0-9a-f]{12}$ \
  && "$STAY_R124_BIRTH_CERTIFICATE_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R124_BIRTH_DOSSIER_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R124_BIRTH_PUBLIC_KEY_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  abort immutable-identity-invalid 2503
for file in "$DATABASE" "$RECOVERY_MARKER" "$STAY_R124_BIRTH_CERTIFICATE_FILE" \
  "$STAY_R124_BIRTH_DOSSIER_FILE" "$STAY_R124_BIRTH_PUBLIC_KEY_FILE"; do
  [[ -f "$file" && ! -L "$file" ]] || abort recovery-input-invalid 2504
done
[[ "$(sha256_file "$STAY_R124_BIRTH_CERTIFICATE_FILE")" == "${STAY_R124_BIRTH_CERTIFICATE_SHA256#sha256:}" \
  && "$(sha256_file "$STAY_R124_BIRTH_DOSSIER_FILE")" == "${STAY_R124_BIRTH_DOSSIER_SHA256#sha256:}" \
  && "$(sha256_file "$STAY_R124_BIRTH_PUBLIC_KEY_FILE")" == "${STAY_R124_BIRTH_PUBLIC_KEY_SHA256#sha256:}" ]] ||
  abort birth-material-hash-invalid 2505
observed_ip="$(ip -4 -o addr show scope global | awk '{split($4,a,"/"); print a[1]}' | sort -u)"
[[ "$observed_ip" == "$EXPECTED_PRIVATE_IPV4" ]] || abort host-identity-mismatch 2506

failure_evidence="$(read_marker R124_FAILURE_EVIDENCE)"
marker_release="$(read_marker R124_RELEASE)"
[[ "$failure_evidence" =~ ^/var/lib/stay/evidence/production-hardening/FAILED-R124-[0-9TZ]+\.[A-Za-z0-9]+$ \
  && -d "$failure_evidence" && ! -L "$failure_evidence" \
  && "$marker_release" == "$STAY_R124_TARGET_RELEASE" \
  && "$(read_marker R124_RELEASE_TAG)" == "$STAY_R124_RELEASE_TAG" \
  && "$(read_marker R124_RELEASE_COMMIT)" == "$STAY_R124_RELEASE_COMMIT" \
  && "$(read_marker R124_RELEASE_TREE)" == "$STAY_R124_RELEASE_TREE" \
  && "$(read_marker R124_ARCHIVE_SHA256)" == "$STAY_R124_ARCHIVE_SHA256" \
  && "$(read_marker R124_MANIFEST_SHA256)" == "$STAY_R124_MANIFEST_SHA256" \
  && "$(read_marker R124_CONTROLLER_SHA256)" == "$STAY_R124_CONTROLLER_SHA256" \
  && "$(read_marker R124_BIRTH_CERTIFICATE_SHA256)" == "$STAY_R124_BIRTH_CERTIFICATE_SHA256" \
  && "$(read_marker R124_BIRTH_DOSSIER_SHA256)" == "$STAY_R124_BIRTH_DOSSIER_SHA256" \
  && "$(read_marker R124_BIRTH_PUBLIC_KEY_SHA256)" == "$STAY_R124_BIRTH_PUBLIC_KEY_SHA256" ]] ||
  abort recovery-marker-invalid 2507
for file in before.proof.json service.before.json R123.freeze.json benchmark.proof.json; do
  [[ -f "$failure_evidence/$file" && ! -L "$failure_evidence/$file" ]] ||
    abort prior-evidence-invalid 2508
done
[[ -d "$STAY_R124_TARGET_RELEASE" && ! -L "$STAY_R124_TARGET_RELEASE" \
  && "$(readlink -f /opt/stay/current)" == "$STAY_R124_TARGET_RELEASE" \
  && -f "$STAY_R124_TARGET_RELEASE/$TARGET_MANIFEST" \
  && ! -L "$STAY_R124_TARGET_RELEASE/$TARGET_MANIFEST" \
  && "$(sha256_file "$STAY_R124_TARGET_RELEASE/$TARGET_MANIFEST")" == "${STAY_R124_MANIFEST_SHA256#sha256:}" \
  && -f "$STAY_R124_TARGET_RELEASE/$TARGET_RELEASE_ENV" \
  && ! -L "$STAY_R124_TARGET_RELEASE/$TARGET_RELEASE_ENV" \
  && -z "$(find -P "$STAY_R124_TARGET_RELEASE" -xdev \
    \( -type l -o -type f -links +1 -o ! -type d ! -type f \) -print -quit)" ]] ||
  abort target-release-invalid 2509
(cd "$STAY_R124_TARGET_RELEASE" && sha256sum -c "$TARGET_MANIFEST" >/dev/null) ||
  abort target-release-manifest-invalid 2509

before_pid="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1])).mainPid))' "$failure_evidence/service.before.json")"
before_restarts="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1])).nRestarts))' "$failure_evidence/service.before.json")"
[[ "$before_pid" =~ ^[1-9][0-9]*$ && "$before_restarts" =~ ^[0-9]+$ ]] ||
  abort prior-service-evidence-invalid 2510

revision="$(durable_runtime_revision)"
active="$(systemctl show stay.service -p ActiveState --value)"
sub="$(systemctl show stay.service -p SubState --value)"
if [[ "$active" != active || "$sub" != running ]]; then
  [[ "$revision" == 124 ]] || abort inactive-recovery-cohort-invalid 2511
  has_metab="$(STAY_DATABASE="$DATABASE" node <<'NODE'
'use strict';
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(process.env.STAY_DATABASE, { open: true, readOnly: true });
database.exec('PRAGMA query_only=ON');
const resident = database.prepare("SELECT status FROM resident_instances WHERE residency_id='resident:metab'").get();
const dossier = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='p1_birth_dossiers'").get()
  ? database.prepare("SELECT 1 AS present FROM p1_birth_dossiers WHERE residency_id='resident:metab'").get()
  : null;
process.stdout.write(resident && dossier ? 'yes' : 'no');
database.close();
NODE
)"
  [[ "$has_metab" == yes ]] || abort inactive-r124-has-no-durable-birth 2511
  systemctl start stay.service
  revision="$(durable_runtime_revision)"
  [[ "$revision" == 125 \
    && "$(systemctl show stay.service -p ActiveState --value)" == active \
    && "$(systemctl show stay.service -p SubState --value)" == running ]] ||
    abort r125-start-recovery-failed 2512
fi
[[ "$revision" == 124 || "$revision" == 125 ]] || abort recovery-cohort-invalid 2513

WORK="$(mktemp -d "$EVIDENCE_ROOT/.R124-recovery-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
for file in before.proof.json service.before.json R123.freeze.json benchmark.proof.json; do
  install -o root -g root -m 0400 "$failure_evidence/$file" "$WORK/$file"
done

if [[ "$revision" == 124 ]]; then
  [[ ! -L "$ACTIVE_PUBLIC_KEY" && ! -L "$ACTIVE_CERTIFICATE" ]] ||
    abort active-birth-material-unsafe 2514
  if [[ ! -f "$ACTIVE_PUBLIC_KEY" || -L "$ACTIVE_PUBLIC_KEY" \
    || "$(sha256_file "$ACTIVE_PUBLIC_KEY")" != "${STAY_R124_BIRTH_PUBLIC_KEY_SHA256#sha256:}" ]]; then
    install_atomic "$STAY_R124_BIRTH_PUBLIC_KEY_FILE" "$ACTIVE_PUBLIC_KEY" 0444
  fi
  if [[ ! -f "$ACTIVE_CERTIFICATE" || -L "$ACTIVE_CERTIFICATE" \
    || "$(sha256_file "$ACTIVE_CERTIFICATE")" != "${STAY_R124_BIRTH_CERTIFICATE_SHA256#sha256:}" ]]; then
    install_atomic "$STAY_R124_BIRTH_CERTIFICATE_FILE" "$ACTIVE_CERTIFICATE" 0444
  fi
  node "$STAY_R124_TARGET_RELEASE/deploy/live-physiology-transplant/p1-resident-control-client.js" \
    birth resident:metab > "$WORK/metab.birth.json" || abort r124-birth-retry-failed 2514
fi

after_pid="$(systemctl show stay.service -p MainPID --value)"
after_restarts="$(systemctl show stay.service -p NRestarts --value)"
[[ "$after_pid" =~ ^[1-9][0-9]*$ && "$after_pid" != "$before_pid" \
  && "$after_restarts" =~ ^[0-9]+$ ]] || abort recovered-service-invalid 2515
proof="$STAY_R124_TARGET_RELEASE/deploy/live-physiology-transplant/p1-r124-metab-neutral-live-proof.js"
client="$STAY_R124_TARGET_RELEASE/deploy/live-physiology-transplant/p1-resident-control-client.js"
capture_quiescent_database "$WORK/database.after.json" "$proof" ||
  abort recovered-database-not-quiescent 2515
node "$client" status resident:sntss > "$WORK/sntss.after.json"
node "$client" status resident:chronobiology > "$WORK/chronobiology.after.json"
node "$client" status resident:metab > "$WORK/metab.after.json"
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.after.json"
node - "$before_pid" "$after_pid" "$before_restarts" "$after_restarts" \
  > "$WORK/service.after.json" <<'NODE'
'use strict';
const [beforePid, afterPid, beforeRestarts, afterRestarts] = process.argv.slice(2).map(Number);
process.stdout.write(`${JSON.stringify({ beforePid, afterPid, beforeRestarts, afterRestarts,
  restartCommands: 1 })}\n`);
NODE
node - "$proof" "$WORK" > "$WORK/after.proof.json" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [helper, root] = process.argv.slice(2);
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const result = require(helper).validateAfter({
  before: read('before.proof.json'), database: read('database.after.json'),
  sntssStatus: read('sntss.after.json'),
  chronobiologyStatus: read('chronobiology.after.json'),
  metabStatus: read('metab.after.json'), meta: read('meta.after.json'),
  service: read('service.after.json')
});
process.stdout.write(`${JSON.stringify(result)}\n`);
NODE
install -o root -g root -m 0400 "$STAY_R124_BIRTH_CERTIFICATE_FILE" \
  "$WORK/metab-neutral-birth-certificate.json"
install -o root -g root -m 0400 "$STAY_R124_BIRTH_DOSSIER_FILE" \
  "$WORK/metab-neutral-founder-dossier.json"
install -o root -g root -m 0444 "$STAY_R124_BIRTH_PUBLIC_KEY_FILE" \
  "$WORK/metab-neutral-birth-authority.pub"
install -o root -g root -m 0444 "$STAY_R124_TARGET_RELEASE/$TARGET_RELEASE_ENV" \
  "$WORK/P1_R124_RELEASE.env"

remove_active_birth_material || abort birth-authority-revocation-failed 2516
target_freeze="/var/lib/stay/evidence/runtime-freezes/R${revision}.json"
if [[ ! -e "$target_freeze" && ! -L "$target_freeze" ]]; then
  node - "$STAY_R124_TARGET_RELEASE" "$WORK" "$revision" > "$WORK/R${revision}.freeze.json" <<'NODE'
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [releaseRoot, evidenceRoot, revisionText] = process.argv.slice(2);
const revision = Number(revisionText);
const { sealRevisionFreeze, validateRevisionFreeze } = require(
  path.join(releaseRoot, 'runtime/revision-freeze.js'));
const read = name => JSON.parse(fs.readFileSync(path.join(evidenceRoot, name), 'utf8'));
const hash = name => `sha256:${crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(evidenceRoot, name))).digest('hex')}`;
const before = read('before.proof.json');
const after = read('after.proof.json');
const service = read('service.after.json');
const release = Object.fromEntries(fs.readFileSync(path.join(evidenceRoot,
  'P1_R124_RELEASE.env'), 'utf8').trim().split('\n').map(line => {
  const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
}));
if (!([124, 125].includes(revision) && after.result === 'PASS' &&
  after.runtimeRevision === revision && after.authorityOwned === false &&
  after.observedOutputs === 0 && after.chipState === 'NEUTRAL')) process.exit(2);
const record = sealRevisionFreeze({
  format: 'stay-runtime-revision-freeze-v1', result: 'PASS', acceptance: 'ACCEPTED',
  freezeType: revision === 124 ? 'R124_METAB_NEUTRAL_ZERO_AUTHORITY_BIRTH' :
    'R125_METAB_NEUTRAL_FORWARD_RECOVERY',
  runtime: { revision, revisionLabel: `R${revision}F`,
    progression: revision === 124 ? [123, 124] : [123, 124, 125],
    serviceMainPid: service.afterPid, serviceNRestarts: service.afterRestarts,
    restartCommands: 1 },
  parentFreeze: { revision: 123,
    recordSha256: 'sha256:161b5fe340ef01836447e21c0e77167cac86033973f8a06b3c1af1d7b44fa3cc' },
  benchmark: { result: 'PASS', samples: 4312,
    adjudicationSha256: 'sha256:a78cd8281d246d851e3476f8da50964bc7e9556a8760439099dd727ecadfc6e4',
    witnessSha256: 'sha256:80c383e7b9b15c3da64b29e14d2ca4800d8ad64f19b63dd44ec401afa8564cfc' },
  release: { path: releaseRoot, tag: release.RELEASE_TAG, commit: release.RELEASE_COMMIT,
    tree: release.RELEASE_TREE, archiveSha256: release.ARCHIVE_SHA256,
    manifestSha256: release.MANIFEST_SHA256 },
  metab: { residencyId: 'resident:metab', version: '0.1.0-p1r0-neutral.1',
    mode: 'NEUTRAL', founderId: after.founderId, instanceId: after.instanceId,
    checkpointGeneration: after.checkpointGeneration, authorityOwned: false,
    observedOutputs: 0, signalling: 'FORBIDDEN', productionEligible: false },
  continuity: { sntssCheckpointGenerationBefore: before.sntssCheckpointGeneration,
    chronobiologyCheckpointGenerationBefore: before.chronobiologyCheckpointGeneration,
    pendingDeliveries: 0, pendingOutboxIntents: 0, inventedBiologicalTime: false },
  recovery: { revisionFenced: true, pointerRewound: false },
  birthAuthority: { active: false, certificateSha256: release.BIRTH_CERTIFICATE_SHA256,
    dossierSha256: release.BIRTH_DOSSIER_SHA256,
    publicKeySha256: release.BIRTH_PUBLIC_KEY_SHA256 },
  evidence: Object.fromEntries([
    'benchmark.proof.json', 'before.proof.json', 'after.proof.json',
    'database.after.json', 'sntss.after.json', 'chronobiology.after.json',
    'metab.after.json', 'meta.after.json', 'service.after.json',
    'metab-neutral-birth-certificate.json', 'metab-neutral-founder-dossier.json',
    'metab-neutral-birth-authority.pub'
  ].map(name => [name, hash(name)])),
  capturedAt: new Date().toISOString()
});
if (!validateRevisionFreeze(record, revision)) process.exit(3);
process.stdout.write(`${JSON.stringify(record)}\n`);
NODE
  install_atomic "$WORK/R${revision}.freeze.json" "$target_freeze" 0444
elif [[ -f "$target_freeze" && ! -L "$target_freeze" ]]; then
  install -o root -g root -m 0400 "$target_freeze" "$WORK/R${revision}.freeze.json"
else
  abort target-freeze-unsafe 2517
fi
node - "$STAY_R124_TARGET_RELEASE/runtime/revision-freeze.js" "$target_freeze" "$revision" \
  "$STAY_R124_TARGET_RELEASE" "$STAY_R124_RELEASE_TAG" "$STAY_R124_RELEASE_COMMIT" \
  "$STAY_R124_RELEASE_TREE" "$STAY_R124_ARCHIVE_SHA256" "$STAY_R124_MANIFEST_SHA256" \
  "$STAY_R124_BIRTH_CERTIFICATE_SHA256" "$STAY_R124_BIRTH_DOSSIER_SHA256" \
  "$STAY_R124_BIRTH_PUBLIC_KEY_SHA256" "$after_pid" <<'NODE'
'use strict';
const fs = require('node:fs');
const [helper, file, revisionText, releaseRoot, tag, commit, tree, archiveSha256,
  manifestSha256, certificateSha256, dossierSha256, publicKeySha256, pidText] =
  process.argv.slice(2);
const revision = Number(revisionText);
const record = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!(require(helper).validateRevisionFreeze(record, revision) &&
  record.freezeType === (revision === 124 ? 'R124_METAB_NEUTRAL_ZERO_AUTHORITY_BIRTH' :
    'R125_METAB_NEUTRAL_FORWARD_RECOVERY') &&
  record.runtime?.serviceMainPid === Number(pidText) && record.runtime?.restartCommands === 1 &&
  record.parentFreeze?.recordSha256 ===
    'sha256:161b5fe340ef01836447e21c0e77167cac86033973f8a06b3c1af1d7b44fa3cc' &&
  record.benchmark?.result === 'PASS' && record.benchmark?.samples === 4312 &&
  record.release?.path === releaseRoot && record.release?.tag === tag &&
  record.release?.commit === commit && record.release?.tree === tree &&
  record.release?.archiveSha256 === archiveSha256 &&
  record.release?.manifestSha256 === manifestSha256 &&
  record.metab?.mode === 'NEUTRAL' && record.metab?.authorityOwned === false &&
  record.metab?.observedOutputs === 0 && record.metab?.signalling === 'FORBIDDEN' &&
  record.birthAuthority?.active === false &&
  record.birthAuthority?.certificateSha256 === certificateSha256 &&
  record.birthAuthority?.dossierSha256 === dossierSha256 &&
  record.birthAuthority?.publicKeySha256 === publicKeySha256)) process.exit(1);
NODE

curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.frozen.json"
node - "$WORK/meta.frozen.json" "$revision" <<'NODE'
'use strict';
const fs = require('node:fs');
const [file, revisionText] = process.argv.slice(2);
const revision = Number(revisionText);
const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
const chip = id => meta.chipProjection?.lifecycle?.find(value => value.coreId === id);
if (!(meta.ok === true && meta.revision === revision && meta.revisionFrozen === true &&
  meta.revisionLabel === `R${revision}F` && chip('bsf')?.state === 'LIVE' &&
  chip('sntss')?.state === 'SHADOW' && chip('chronobiology')?.state === 'SHADOW' &&
  chip('metab')?.state === 'NEUTRAL' && chip('metab')?.born === true)) process.exit(1);
NODE

[[ "$(durable_runtime_revision)" == "$revision" \
  && "$(readlink -f /opt/stay/current)" == "$STAY_R124_TARGET_RELEASE" \
  && "$(systemctl show stay.service -p MainPID --value)" == "$after_pid" \
  && "$(systemctl show stay.service -p NRestarts --value)" == "$after_restarts" ]] ||
  abort final-recovery-fence-failed 2518

final_evidence="$EVIDENCE_ROOT/R${revision}F-METAB-RECOVERY-$(date -u +'%Y%m%dT%H%M%SZ')"
[[ ! -e "$final_evidence" && ! -L "$final_evidence" ]] || abort evidence-target-present 2519
mv -T "$WORK" "$final_evidence"
WORK=''
chmod -R a-w "$final_evidence"
rm -f -- "$RECOVERY_MARKER"
COMPLETED=1

printf '%s\n' \
  'R124_METAB_NEUTRAL_RECOVERY=PASS' \
  "RUNTIME_REVISION_AFTER=$revision" \
  "REVISION_LABEL=R${revision}F" \
  "CURRENT_RELEASE=$STAY_R124_TARGET_RELEASE" \
  "SERVICE_PID=$after_pid" \
  "SERVICE_NRESTARTS=$after_restarts" \
  'BSF_MODE=LIVE' \
  'SNTSS_MODE=SHADOW' \
  'SNTSS_AUTHORITY=NONE' \
  'SNTSS_OUTPUTS=0' \
  'CHRONOBIOLOGY_MODE=SHADOW' \
  'CHRONOBIOLOGY_AUTHORITY=NONE' \
  'METAB_MODE=NEUTRAL' \
  'METAB_STATUS=RUNNING' \
  'METAB_AUTHORITY=NONE' \
  'METAB_OUTPUTS=0' \
  'FETUS_CONTINUITY=PASS' \
  'BIRTH_AUTHORITY_ACTIVE=NO' \
  "FREEZE_FILE=$target_freeze" \
  "EVIDENCE_ROOT=$final_evidence"
