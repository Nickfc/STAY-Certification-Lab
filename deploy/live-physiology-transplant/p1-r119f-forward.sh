#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

EXPECTED_PRIVATE_IPV4='172.26.9.207'
SOURCE_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r118f-chrono-repair-934069400d62'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
SOCKET='/run/stay/resident-control.sock'
RUNTIME_DROPIN='/etc/systemd/system/stay.service.d/p1-b0-resident-runtime.conf'
ONE_SHOT_DROPIN='/etc/systemd/system/stay.service.d/p1-r119-chronobiology-repair-once.conf'
SERVICE_CGROUP='/sys/fs/cgroup/system.slice/stay.service'
BWRAP='/usr/local/libexec/stay-bwrap-sandbox'
EVIDENCE_ROOT='/var/lib/stay/evidence/production-hardening'
RECOVERY_MARKER='/run/stay-r119f-forward-recovery.env'
SCRIPT_DIRECTORY="$(dirname -- "$(readlink -f -- "$0")")"
STAGE_ROOT="$(readlink -f -- "$SCRIPT_DIRECTORY/../..")"
REPAIR_HELPER="$SCRIPT_DIRECTORY/p1-r119f-chronobiology-bounded-catchup-repair.js"
ENTRY_PREFLIGHT="$SCRIPT_DIRECTORY/p1-r119f-entry-preflight.js"
LIVE_PROOF="$SCRIPT_DIRECTORY/p1-r119f-live-proof.js"
FINALIZE="$SCRIPT_DIRECTORY/p1-r119f-finalize.sh"
SOURCE_MANIFEST="$SCRIPT_DIRECTORY/P1_PRODUCTION_HARDENING_R118_TO_R119F.sha256"
SOURCE_RELEASE_MANIFEST_RELATIVE='deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R116_TO_R118F.sha256'
SOURCE_RELEASE_MANIFEST_SHA256='129dd8aa818f211444cddcf79665745d2490718e45cc1b2aba32a375c0dfddd0'
TARGET_RELEASE_MANIFEST_RELATIVE='deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R118_TO_R119F.sha256'
SOURCE_RELEASE_MANIFEST_RECORD_COUNT=188
SOURCE_RELEASE_PRESENT_RECORD_COUNT=181
SOURCE_RELEASE_FILE_COUNT=184
TARGET_RELEASE_MANIFEST_RECORD_COUNT=221
TARGET_CANDIDATE_FILE_COUNT=224
TARGET_RELEASE_FILE_COUNT=225

SOURCE_RELEASE_ABSENT_RECORDS=(
  'bc21dd1aded8cf68eb60f630fe9f6c8afdcb4e8a6bf8c928184b85e8258dcc37  ./deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R110F_TO_R111F.md'
  '259341d04759ee74550d5d3fe34aa869c15b2e2cea4efe2e637a8f700804472f  ./deploy/live-physiology-transplant/P1_SNTSS_I4G_REHEARSAL_R105F.md'
  '7b5370cd244b427bbdac062b9be09af1e853ece9a416dd22a72e220e03789fcc  ./deploy/live-physiology-transplant/P1_SNTSS_I4G_REHEARSAL_R105F.sha256'
  '433430f1e360d1183e29e016978c9610fd1b2d1070aab5415facb39aab8896df  ./deploy/live-physiology-transplant/p1-sntss-i4g-rehearsal.js'
  '386da10cf952cd448ffc8315e797165c292208561246e47a223565825a922d52  ./deploy/live-physiology-transplant/p1-sntss-i4g-rehearsal.sh'
  '048bdec2ab67e2a2ff0114e8d5fecec1c81879addbfe9b13a53b70b7c263602c  ./docs/sntss/R13_CONTINUITY_GENESIS_SHADOW.md'
  '42aae340f5dfc8a43dc8c3f38855df1b3e681e51102d0ab1b5be14ebfb456404  ./test/p1-r118f-release-contract.test.js'
)
SOURCE_RELEASE_METADATA_FILES=(
  "$SOURCE_RELEASE_MANIFEST_RELATIVE"
  'P1_PRODUCTION_HARDENING_RELEASE.env'
  'P1_R118F_RELEASE.env'
)

: "${STAY_R119F_RELEASE_TAG:?}"
: "${STAY_R119F_RELEASE_COMMIT:?}"
: "${STAY_R119F_RELEASE_TREE:?}"
: "${STAY_R119F_ARCHIVE_SHA256:?}"
: "${STAY_R119F_MANIFEST_SHA256:?}"
: "${STAY_R119F_CONTROLLER_SHA256:?}"

OVERLAY_FILES=(
  'cores/chronobiology/c3r5/aggregate.js'
  'cores/chronobiology/c3r5/calibration-profile.js'
  'cores/chronobiology/c3r5/coarse-free-run.js'
  'cores/chronobiology/c3r5/entrainment.js'
  'cores/chronobiology/c3r5/fixed-point.js'
  'cores/chronobiology/c3r5/founder.js'
  'cores/chronobiology/c3r5/index.js'
  'cores/chronobiology/c3r5/local-ring-kernel.js'
  'cores/chronobiology/c3r5/long-gap.js'
  'cores/chronobiology/c3r5/oscillator.js'
  'cores/chronobiology/c3r5/package-policy.json'
  'cores/chronobiology/c3r5/phase-response.js'
  'cores/chronobiology/c3r5/photic-calibration-profile.js'
  'cores/chronobiology/c3r5/photic-transducer.js'
  'cores/chronobiology/c3r5/schemas/phase-summary.schema.json'
  'cores/chronobiology/c3r5/schemas/photic-evidence.schema.json'
  'cores/chronobiology/c3r5/schemas/state.schema.json'
  'cores/chronobiology/c3r5/state.js'
  'cores/chronobiology/c3r5/summary.js'
  'cores/chronobiology/c3r5/trig-table.js'
  'cores/chronobiology/c3r5/validation.js'
  'runtime/kernel/chronobiology-resident-contracts.js'
  'runtime/kernel/living-kernel.js'
  'deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R110F_TO_R111F.md'
  'deploy/live-physiology-transplant/P1_SNTSS_I4G_REHEARSAL_R105F.md'
  'deploy/live-physiology-transplant/P1_SNTSS_I4G_REHEARSAL_R105F.sha256'
  'deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R118_TO_R119F.sha256'
  'deploy/live-physiology-transplant/p1-sntss-i4g-rehearsal.js'
  'deploy/live-physiology-transplant/p1-sntss-i4g-rehearsal.sh'
  'deploy/live-physiology-transplant/p1-r119f-chronobiology-bounded-catchup-repair.js'
  'deploy/live-physiology-transplant/p1-r119f-entry-preflight.js'
  'deploy/live-physiology-transplant/p1-r119f-live-proof.js'
  'deploy/live-physiology-transplant/p1-r119f-freeze.js'
  'deploy/live-physiology-transplant/p1-r119f-finalize.sh'
  'deploy/live-physiology-transplant/p1-r119f-forward.sh'
  'deploy/live-physiology-transplant/p1-r119f-forward-recovery.sh'
  'test/chronobiology-c3r5-bounded-catchup-repair.test.js'
  'test/p1-r119f-chronobiology-bounded-catchup-repair.test.js'
  'test/p1-r119f-entry-path.test.js'
  'test/p1-r119f-release-contract.test.js'
  'test/p1-r118f-release-contract.test.js'
  'docs/sntss/R13_CONTINUITY_GENESIS_SHADOW.md'
)

WORK=''
CANDIDATE=''
NEW_RELEASE=''
TARGET_CREATED=0
POINTER_CHANGED=0
RESTART_COMMITTED=0
ONE_SHOT_CREATED=0
COMPLETED=0
FAILURE_EVIDENCE=''

phase() { echo "===== $1 ====="; }

abort() {
  echo "R119F_FORWARD_ABORT=$1" >&2
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
  const row = database.prepare("SELECT json, sha256 FROM metadata WHERE key='life:runtime-revision'").get();
  if (!row || crypto.createHash('sha256').update(row.json).digest('hex') !== row.sha256) process.exit(2);
  const revision = Number(JSON.parse(row.json).revision);
  if (!Number.isSafeInteger(revision)) process.exit(3);
  process.stdout.write(String(revision));
} finally { database.close(); }
NODE
}

resident_version() {
  STAY_DATABASE="$DATABASE" node <<'NODE'
'use strict';
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(process.env.STAY_DATABASE, { readOnly: true });
try {
  process.stdout.write(String(database.prepare(
    "SELECT version FROM resident_instances WHERE residency_id='resident:chronobiology'"
  ).get()?.version || ''));
} finally { database.close(); }
NODE
}

proc_value() {
  tr '\0' '\n' < "/proc/$1/environ" |
    awk -F= -v key="$2" '$1==key {sub(/^[^=]*=/,"");print;found=1} END{if(!found)exit 1}'
}

install_atomic() {
  local source="$1" target="$2" mode="$3" temporary
  temporary="$(mktemp "$(dirname "$target")/.r119f-forward.XXXXXX")"
  install -o root -g root -m "$mode" "$source" "$temporary"
  mv -fT "$temporary" "$target"
}

point_current() {
  local release="$1" temporary="/opt/stay/.current-r119f.$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
  ln -s "$release" "$temporary"
  mv -Tf "$temporary" /opt/stay/current
}

tree_digest() {
  local root="$1" relative="$2"
  (cd "$root" && find "$relative" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')
}

source_release_records_present() {
  local record absent
  while IFS= read -r record; do
    for absent in "${SOURCE_RELEASE_ABSENT_RECORDS[@]}"; do
      [[ "$record" == "$absent" ]] && continue 2
    done
    printf '%s\n' "$record"
  done < "$SOURCE_RELEASE/$SOURCE_RELEASE_MANIFEST_RELATIVE"
}

archive_failure_work() {
  if [[ -n "$WORK" && -d "$WORK" ]]; then
    local failed
    failed="$(mktemp -d "$EVIDENCE_ROOT/FAILED-R119F-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
    rmdir -- "$failed"
    if mv -T "$WORK" "$failed"; then
      WORK=''
      FAILURE_EVIDENCE="$failed"
      chmod -R a-w "$failed" || true
      echo "R119F_FAILURE_EVIDENCE=$failed" >&2
    fi
  fi
}

write_recovery_marker() {
  [[ -n "$FAILURE_EVIDENCE" ]] || return 0
  local temporary
  temporary="$(mktemp /run/.stay-r119f-forward-recovery.XXXXXX)"
  cat > "$temporary" <<EOF
R119F_FAILURE_EVIDENCE=$FAILURE_EVIDENCE
R119F_RELEASE=$NEW_RELEASE
R119F_RELEASE_TAG=$STAY_R119F_RELEASE_TAG
R119F_RELEASE_COMMIT=$STAY_R119F_RELEASE_COMMIT
R119F_RELEASE_TREE=$STAY_R119F_RELEASE_TREE
R119F_ARCHIVE_SHA256=$STAY_R119F_ARCHIVE_SHA256
R119F_MANIFEST_SHA256=$STAY_R119F_MANIFEST_SHA256
R119F_CONTROLLER_SHA256=$STAY_R119F_CONTROLLER_SHA256
EOF
  install -o root -g root -m 0600 "$temporary" "$RECOVERY_MARKER"
  rm -f -- "$temporary"
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$ONE_SHOT_CREATED" -eq 1 && -f "$ONE_SHOT_DROPIN" && ! -L "$ONE_SHOT_DROPIN" ]]; then
    rm -f -- "$ONE_SHOT_DROPIN"
    systemctl daemon-reload >/dev/null 2>&1 || true
    ONE_SHOT_CREATED=0
  fi
  if [[ "$COMPLETED" -eq 0 && "$RESTART_COMMITTED" -eq 0 ]]; then
    [[ "$POINTER_CHANGED" -eq 1 ]] && point_current "$SOURCE_RELEASE" || true
    if [[ "$TARGET_CREATED" -eq 1 && "$NEW_RELEASE" == /opt/stay/releases/0.8.11.3-p1m-r119f-chrono-repair-* && -d "$NEW_RELEASE" && ! -L "$NEW_RELEASE" ]]; then
      rm -rf --one-file-system -- "$NEW_RELEASE"
    fi
    archive_failure_work
    echo 'R119F_FORWARD_ROLLBACK=PRE_RESTART_STATE_RESTORED' >&2
  elif [[ "$COMPLETED" -eq 0 ]]; then
    archive_failure_work
    write_recovery_marker
    echo 'R119F_FORWARD_POST_RESTART=LEFT_REVISION_FENCED_FOR_FORWARD_RECOVERY' >&2
  fi
  if [[ -n "$CANDIDATE" && "$CANDIDATE" == /opt/stay/releases/.p1m-r119f-chrono-repair.* && -d "$CANDIDATE" ]]; then
    rm -rf --one-file-system -- "$CANDIDATE"
  fi
  [[ -n "$WORK" && -d "$WORK" ]] && rm -rf --one-file-system -- "$WORK"
  exit "$status"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 1701
[[ "${STAY_R119F_AUTHORIZATION:-}" == 'REPAIR_R118_CHRONOBIOLOGY_CPU_TO_R119F_AND_BENCHMARK_72H' ]] ||
  abort authorization-required 1702
[[ "$STAY_R119F_RELEASE_TAG" =~ ^r119f-v[0-9]+$ \
  && "$STAY_R119F_RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ \
  && "$STAY_R119F_RELEASE_TREE" =~ ^[0-9a-f]{40}$ \
  && "$STAY_R119F_ARCHIVE_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R119F_MANIFEST_SHA256" =~ ^sha256:[0-9a-f]{64}$ \
  && "$STAY_R119F_CONTROLLER_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  abort immutable-identity-invalid 1703
[[ ! -e "$RECOVERY_MARKER" && ! -L "$RECOVERY_MARKER" ]] || abort recovery-marker-already-exists 1704
[[ ! -e "$ONE_SHOT_DROPIN" && ! -L "$ONE_SHOT_DROPIN" ]] || abort one-shot-dropin-already-exists 1705
for file in "$DATABASE" "$RUNTIME_DROPIN" "$BWRAP" "$SOURCE_MANIFEST" \
  "$REPAIR_HELPER" "$ENTRY_PREFLIGHT" "$LIVE_PROOF" "$FINALIZE"; do
  [[ -f "$file" && ! -L "$file" ]] || abort immutable-input-invalid 1706
done
[[ -d "$SOURCE_RELEASE" && ! -L "$SOURCE_RELEASE" \
  && "$(readlink -f /opt/stay/current)" == "$SOURCE_RELEASE" ]] || abort source-release-invalid 1707
[[ -f "$SOURCE_RELEASE/$SOURCE_RELEASE_MANIFEST_RELATIVE" \
  && ! -L "$SOURCE_RELEASE/$SOURCE_RELEASE_MANIFEST_RELATIVE" \
  && "$(sha256sum "$SOURCE_RELEASE/$SOURCE_RELEASE_MANIFEST_RELATIVE" | awk '{print $1}')" == \
    "$SOURCE_RELEASE_MANIFEST_SHA256" \
  && -z "$(find -P "$SOURCE_RELEASE" -xdev \( -type l -o -type f -links +1 -o ! -type d ! -type f \) -print -quit)" ]] ||
  abort source-release-inventory-invalid 1707
[[ "$(wc -l < "$SOURCE_RELEASE/$SOURCE_RELEASE_MANIFEST_RELATIVE")" -eq \
  "$SOURCE_RELEASE_MANIFEST_RECORD_COUNT" ]] || abort source-release-record-count-invalid 1707
for record in "${SOURCE_RELEASE_ABSENT_RECORDS[@]}"; do
  grep -Fx "$record" "$SOURCE_RELEASE/$SOURCE_RELEASE_MANIFEST_RELATIVE" >/dev/null ||
    abort source-release-absent-record-invalid 1707
  relative="${record#*  ./}"
  [[ ! -e "$SOURCE_RELEASE/$relative" && ! -L "$SOURCE_RELEASE/$relative" ]] ||
    abort source-release-absent-file-present 1707
done
[[ "$(source_release_records_present | wc -l)" -eq "$SOURCE_RELEASE_PRESENT_RECORD_COUNT" ]] ||
  abort source-release-present-record-count-invalid 1707
(cd "$SOURCE_RELEASE" && sha256sum -c <(source_release_records_present) >/dev/null) ||
  abort source-release-hash-invalid 1707
cmp \
  <({ source_release_records_present | awk '{sub(/^\.\//,"",$2); print $2}';
      printf '%s\n' "${SOURCE_RELEASE_METADATA_FILES[@]}"; } | LC_ALL=C sort) \
  <(cd "$SOURCE_RELEASE" && find . -type f -printf '%P\n' | LC_ALL=C sort) >/dev/null ||
  abort source-release-file-set-invalid 1707
[[ "$(find "$SOURCE_RELEASE" -type f | wc -l)" -eq "$SOURCE_RELEASE_FILE_COUNT" ]] ||
  abort source-release-file-count-invalid 1707
[[ -S "$SOCKET" && ! -L "$SOCKET" ]] || abort resident-socket-invalid 1708
[[ "$(systemctl show stay-p1-physiology-benchmark.service -p ActiveState --value 2>/dev/null || true)" != active ]] ||
  abort prior-benchmark-still-active 1709
[[ ! -e /var/lib/stay/evidence/runtime-freezes/R119.json \
  && ! -L /var/lib/stay/evidence/runtime-freezes/R119.json \
  && ! -e /var/lib/stay/evidence/physiology-benchmark/R119F \
  && ! -L /var/lib/stay/evidence/physiology-benchmark/R119F ]] || abort target-evidence-already-exists 1710

observed_ip="$(ip -4 -o addr show scope global | awk '{split($4,a,"/"); print a[1]}' | sort -u)"
[[ "$observed_ip" == "$EXPECTED_PRIVATE_IPV4" ]] || abort host-identity-mismatch 1711
before_pid="$(systemctl show stay.service -p MainPID --value)"
before_restarts="$(systemctl show stay.service -p NRestarts --value)"
before_active="$(systemctl show stay.service -p ActiveState --value)"
before_sub="$(systemctl show stay.service -p SubState --value)"
[[ "$before_pid" =~ ^[1-9][0-9]*$ && "$before_active" == active && "$before_sub" == running ]] ||
  abort source-service-invalid 1712

WORK="$(mktemp -d "$EVIDENCE_ROOT/.R119F-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
node - "$before_pid" "$before_restarts" > "$WORK/service.before.json" <<'NODE'
'use strict';
const [beforePid, beforeRestarts] = process.argv.slice(2).map(Number);
process.stdout.write(`${JSON.stringify({ beforePid, beforeRestarts })}\n`);
NODE
phase 'READ-ONLY EXACT R118 PREFLIGHT'
STAY_DATABASE="$DATABASE" node "$LIVE_PROOF" capture > "$WORK/before.database.json" || abort database-capture-failed 1713
node - "$WORK/before.database.json" "$LIVE_PROOF" <<'NODE'
'use strict';
const fs = require('node:fs');
const [file, helper] = process.argv.slice(2);
require(helper).validateBefore(JSON.parse(fs.readFileSync(file, 'utf8')));
NODE
before_sntss="$(STAY_RESIDENT_CONTROL_TIMEOUT_MS=30000 node "$SCRIPT_DIRECTORY/p1-resident-control-client.js" status resident:sntss)"
before_chrono="$(STAY_RESIDENT_CONTROL_TIMEOUT_MS=30000 node "$SCRIPT_DIRECTORY/p1-resident-control-client.js" status resident:chronobiology)"
before_meta="$(curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta)"
printf '%s\n' "$before_sntss" > "$WORK/sntss.before.json"
printf '%s\n' "$before_chrono" > "$WORK/chronobiology.before.json"
printf '%s\n' "$before_meta" > "$WORK/meta.before.json"
node - "$WORK/sntss.before.json" "$WORK/chronobiology.before.json" "$WORK/meta.before.json" <<'NODE'
'use strict';
const fs = require('node:fs');
const [sFile, cFile, mFile] = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(sFile)).resident;
const c = JSON.parse(fs.readFileSync(cFile)).resident;
const m = JSON.parse(fs.readFileSync(mFile));
const fetus = m.cores?.find(value => value.id === 'fetus-legacy');
const bsf = m.systems?.find(value => value.id === 'bsf');
if (!(m.ok === true && m.revision === 118 && m.revisionFrozen === false
  && m.revisionLabel === 'R118' && fetus?.ok === true
  && fetus?.memoryGuardian?.status === 'healthy'
  && fetus?.memoryGuardian?.warnAtMiB === 192
  && fetus?.memoryGuardian?.recycleAtMiB === 256
  && bsf?.mode === 'LIVE' && bsf?.status === 'RUNNING' && bsf?.healthOk === true
  && s?.version === '0.5.0-i4g1'
  && s?.host?.instanceId === '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f'
  && s?.status === 'RUNNING' && s?.running === true && s?.authorityOwned === false
  && s?.observedOutputs === 0 && s?.health?.biologicalOutputs === 0
  && c?.version === '1.0.0-c3rc.4'
  && c?.host?.instanceId === 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a'
  && c?.status === 'RESYNC_REQUIRED' && c?.running === false
  && c?.authorityOwned === false && c?.observedOutputs === 0)) process.exit(1);
NODE
[[ "$(systemctl show stay.service -p MainPID --value)" == "$before_pid" \
  && "$(systemctl show stay.service -p NRestarts --value)" == "$before_restarts" ]] ||
  abort preflight-mutated-service 1714

phase 'BUILD SOURCE-SEALED CANDIDATE'
CANDIDATE="$(mktemp -d /opt/stay/releases/.p1m-r119f-chrono-repair.XXXXXX)"
cp -a --reflink=auto "$SOURCE_RELEASE/." "$CANDIDATE/"
chmod --reference="$SOURCE_RELEASE" "$CANDIDATE"
chown --reference="$SOURCE_RELEASE" "$CANDIDATE"
source_sntss_digest="$(tree_digest "$SOURCE_RELEASE" cores/sntss/i4g)"
source_c3_digest="$(tree_digest "$SOURCE_RELEASE" cores/chronobiology/c3)"
source_c3r4_digest="$(tree_digest "$SOURCE_RELEASE" cores/chronobiology/c3r4)"
for file in "${OVERLAY_FILES[@]}"; do
  install -D -o root -g root -m 0644 "$STAGE_ROOT/$file" "$CANDIDATE/$file"
  [[ "$(sha256sum "$CANDIDATE/$file" | awk '{print $1}')" == \
    "$(sha256sum "$STAGE_ROOT/$file" | awk '{print $1}')" ]] || abort candidate-overlay-mismatch 1715
done
[[ "$(wc -l < "$CANDIDATE/$TARGET_RELEASE_MANIFEST_RELATIVE")" -eq \
  "$TARGET_RELEASE_MANIFEST_RECORD_COUNT" \
  && "$(sha256sum "$CANDIDATE/$TARGET_RELEASE_MANIFEST_RELATIVE" | awk '{print $1}')" == \
    "${STAY_R119F_MANIFEST_SHA256#sha256:}" ]] || abort candidate-manifest-invalid 1715
(cd "$CANDIDATE" && sha256sum -c "$TARGET_RELEASE_MANIFEST_RELATIVE" >/dev/null) ||
  abort candidate-manifest-hash-invalid 1715
cmp \
  <({ awk '{sub(/^\.\//,"",$2); print $2}' "$CANDIDATE/$TARGET_RELEASE_MANIFEST_RELATIVE";
      echo "$TARGET_RELEASE_MANIFEST_RELATIVE";
      printf '%s\n' "${SOURCE_RELEASE_METADATA_FILES[@]}"; } | LC_ALL=C sort) \
  <(cd "$CANDIDATE" && find . -type f -printf '%P\n' | LC_ALL=C sort) >/dev/null ||
  abort candidate-file-set-invalid 1715
[[ "$(find "$CANDIDATE" -type f | wc -l)" -eq "$TARGET_CANDIDATE_FILE_COUNT" ]] ||
  abort candidate-file-count-invalid 1715
[[ "$(tree_digest "$CANDIDATE" cores/sntss/i4g)" == "$source_sntss_digest" \
  && "$(tree_digest "$CANDIDATE" cores/chronobiology/c3)" == "$source_c3_digest" \
  && "$(tree_digest "$CANDIDATE" cores/chronobiology/c3r4)" == "$source_c3r4_digest" ]] ||
  abort historical-biology-changed 1716
diff -qr "$SOURCE_RELEASE/cores/sntss/i4g" "$CANDIDATE/cores/sntss/i4g" > "$WORK/sntss.diff" ||
  abort sntss-tree-changed 1717
diff -qr "$SOURCE_RELEASE/cores/chronobiology/c3" "$CANDIDATE/cores/chronobiology/c3" > "$WORK/chronobiology-c3.diff" ||
  abort historical-chronobiology-tree-changed 1718
diff -qr "$SOURCE_RELEASE/cores/chronobiology/c3r4" "$CANDIDATE/cores/chronobiology/c3r4" > "$WORK/chronobiology-c3r4.diff" ||
  abort historical-chronobiology-r4-tree-changed 1718

for file in "${OVERLAY_FILES[@]}"; do
  [[ "$file" == *.js ]] && node --check "$CANDIDATE/$file" >/dev/null
  [[ "$file" == *.sh ]] && bash -n "$CANDIDATE/$file"
done
node - "$CANDIDATE" <<'NODE'
'use strict';
const path = require('node:path');
const root = process.argv[2];
const policy = require(path.join(root, 'runtime/kernel/package-policy.js'));
for (const relative of ['cores/sntss/i4g/index.js', 'cores/chronobiology/c3/index.js',
  'cores/chronobiology/c3r2/index.js', 'cores/chronobiology/c3r3/index.js',
  'cores/chronobiology/c3r4/index.js', 'cores/chronobiology/c3r5/index.js']) {
  const modulePath = path.join(root, relative);
  const manifest = require(modulePath).manifest;
  const record = policy.enforcePackagePolicy(modulePath);
  policy.verifyManifestAgainstPackagePolicy(record, manifest);
}
NODE

phase 'NON-PRODUCTION C3R3 HISTORICAL IDENTITY AND BIOLOGY'
if ! STAY_BWRAP="$BWRAP" node --test --test-concurrency=1 \
  --test-name-pattern='^C3R3-(?:ID|BIO)-01' \
  "$CANDIDATE/test/chronobiology-c3r3-jitless-performance-repair.test.js" \
  > "$WORK/c3r3-historical-tests.tap" 2>&1; then
  cat "$WORK/c3r3-historical-tests.tap" >&2
  abort candidate-c3r3-historical-tests-failed 1719
fi
cat "$WORK/c3r3-historical-tests.tap"

if ! STAY_BWRAP="$BWRAP" node --test --test-concurrency=1 \
  "$CANDIDATE/test/chronobiology-c3r2-performance-repair.test.js" \
  "$CANDIDATE/test/chronobiology-c3r3-jitless-performance-repair.test.js" \
  "$CANDIDATE/test/chronobiology-c3r4-performance-lab.test.js" \
  "$CANDIDATE/test/chronobiology-c3r4-topology-performance-repair.test.js" \
  "$CANDIDATE/test/chronobiology-c3r5-bounded-catchup-repair.test.js" \
  "$CANDIDATE/test/core-host-supervisor-permissions.test.js" \
  "$CANDIDATE/test/core-loader-diagnostics.test.js" \
  "$CANDIDATE/test/p1-r119f-chronobiology-bounded-catchup-repair.test.js" \
  "$CANDIDATE/test/p1-r119f-entry-path.test.js" \
  "$CANDIDATE/test/p1-r119f-release-contract.test.js" \
  "$CANDIDATE/test/production-hardening-entry-path.test.js" \
  "$CANDIDATE/test/production-hardening.test.js" > "$WORK/focused-tests.tap" 2>&1; then
  cat "$WORK/focused-tests.tap" >&2
  abort candidate-focused-tests-failed 1719
fi

phase 'REAL BUBBLEWRAP ENTRY PATH AT INDEPENDENT 20-PERCENT PAYLOAD CPU QUOTA'
if ! systemd-run --wait --pipe --collect --quiet \
  --property=User=staydeploy --property=Delegate=yes \
  --property=CPUAccounting=yes --property=MemoryAccounting=yes \
  /usr/bin/env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_ENV=production STAY_REQUIRE_OS_CORE_SANDBOX=1 STAY_BWRAP="$BWRAP" \
    STAY_REQUIRE_CORE_PACKAGE_POLICY=1 STAY_REQUIRE_CGROUPS=1 \
    /usr/local/bin/node "$CANDIDATE/deploy/live-physiology-transplant/p1-r119f-entry-preflight.js" \
    > "$WORK/entry-quota.proof.json"; then
  abort quota-entry-preflight-failed 1720
fi
[[ "$(json_field "$(<"$WORK/entry-quota.proof.json")" result)" == PASS \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" version)" == '1.0.0-c3rc.5' \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" committedThroughUs)" == 176401500000 \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" hardCpuPercent)" == 20 \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" inspectorSandboxed)" == true \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" payloadSandboxed)" == true \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" cgroupRequired)" == true \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" payloadCgroupRequired)" == true \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" payloadCgroupAvailable)" == true \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" payloadCpuMax)" == '20000 100000' \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" payloadMemoryHigh)" == 67108864 \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" payloadMemoryMax)" == 100663296 \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" payloadPidsMax)" == 16 \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" supervisorChargedToKernel)" == true \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" payloadAttachedBeforeInit)" == true \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" payloadProcessCount)" -ge 1 \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" declaredHandlerTimeoutMs)" == 250 \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" workerTransitionTimeoutMs)" == 250 \
  && "$(json_field "$(<"$WORK/entry-quota.proof.json")" ipcTransitionTimeoutMs)" == 1000 ]] ||
  abort quota-entry-preflight-invalid 1721
node - "$WORK/entry-quota.proof.json" <<'NODE' || abort quota-entry-slice-deadline-invalid 1721
'use strict';
const proof = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (!(Number.isFinite(proof.elapsedMs) && proof.elapsedMs < 250
  && Array.isArray(proof.elapsedSlicesMs) && proof.elapsedSlicesMs.length === 7
  && proof.elapsedSlicesMs.every(value => Number.isFinite(value) && value < 250))) process.exit(1);
NODE

runuser -u staydeploy -- env -i \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  NODE_ENV=production STAY_REQUIRE_CORE_PACKAGE_POLICY=1 \
  /usr/local/bin/node \
  "$CANDIDATE/deploy/live-physiology-transplant/p1-r119f-chronobiology-bounded-catchup-repair.js" \
  preflight "$DATABASE" "$CANDIDATE" > "$WORK/repair.preflight.json" ||
  abort exact-repair-preflight-failed 1722
[[ "$(json_field "$(<"$WORK/repair.preflight.json")" result)" == PASS ]] ||
  abort exact-repair-preflight-invalid 1723
[[ "$(systemctl show stay.service -p MainPID --value)" == "$before_pid" \
  && "$(systemctl show stay.service -p NRestarts --value)" == "$before_restarts" \
  && "$(durable_runtime_revision)" == 118 \
  && "$(readlink -f /opt/stay/current)" == "$SOURCE_RELEASE" ]] ||
  abort candidate-preflight-mutated-production 1724

overlay_digest="$(
  cd "$STAGE_ROOT"
  for file in "${OVERLAY_FILES[@]}"; do
    sha256sum "$file"
  done | sha256sum | awk '{print $1}'
)"
NEW_RELEASE="/opt/stay/releases/0.8.11.3-p1m-r119f-chrono-repair-${overlay_digest:0:12}"
[[ ! -e "$NEW_RELEASE" && ! -L "$NEW_RELEASE" ]] || abort target-release-already-exists 1725
cat > "$CANDIDATE/P1_R119F_RELEASE.env" <<EOF
P1_R119F_RELEASE=PASS
SOURCE_RELEASE=$SOURCE_RELEASE
SOURCE_RUNTIME_REVISION=R118
RECOVERY_RUNTIME_REVISION=R119
TARGET_RUNTIME_REVISION=R119F
RELEASE_TAG=$STAY_R119F_RELEASE_TAG
RELEASE_COMMIT=$STAY_R119F_RELEASE_COMMIT
RELEASE_TREE=$STAY_R119F_RELEASE_TREE
ARCHIVE_SHA256=$STAY_R119F_ARCHIVE_SHA256
MANIFEST_SHA256=$STAY_R119F_MANIFEST_SHA256
PRODUCTION_OVERLAY_SHA256=sha256:$overlay_digest
SNTSS_TREE_SHA256=sha256:$source_sntss_digest
HISTORICAL_CHRONOBIOLOGY_TREE_SHA256=sha256:$source_c3_digest
HISTORICAL_CHRONOBIOLOGY_R4_TREE_SHA256=sha256:$source_c3r4_digest
CHRONOBIOLOGY_REPAIR_VERSION=1.0.0-c3rc.5
CHRONOBIOLOGY_RESOURCE_LIMITS_CHANGED=NO
CHRONOBIOLOGY_BIOLOGICAL_STATE_CHANGED=NO
CHRONOBIOLOGY_ABANDONED_COUNT=0
CHRONOBIOLOGY_INVENTED_BIOLOGICAL_TIME=NO
EOF
chown root:root "$CANDIDATE/P1_R119F_RELEASE.env"
chmod 0444 "$CANDIDATE/P1_R119F_RELEASE.env"
cmp \
  <({ awk '{sub(/^\.\//,"",$2); print $2}' "$CANDIDATE/$TARGET_RELEASE_MANIFEST_RELATIVE";
      echo "$TARGET_RELEASE_MANIFEST_RELATIVE";
      printf '%s\n' "${SOURCE_RELEASE_METADATA_FILES[@]}";
      echo 'P1_R119F_RELEASE.env'; } | LC_ALL=C sort) \
  <(cd "$CANDIDATE" && find . -type f -printf '%P\n' | LC_ALL=C sort) >/dev/null ||
  abort target-release-file-set-invalid 1725
[[ "$(find "$CANDIDATE" -type f | wc -l)" -eq "$TARGET_RELEASE_FILE_COUNT" ]] ||
  abort target-release-file-count-invalid 1725
mv -T "$CANDIDATE" "$NEW_RELEASE"
CANDIDATE=''
TARGET_CREATED=1
chmod -R a-w "$NEW_RELEASE"

phase 'OFFLINE CAS, R119 RESYNCHRONIZATION, AND EXACTLY ONE RESTART'
cat > "$WORK/p1-r119-chronobiology-repair-once.conf" <<EOF
[Service]
Environment=STAY_RECOVER_COLD_RESIDENTS_AT_REVISION=119
ExecStartPre=/usr/local/bin/node $NEW_RELEASE/deploy/live-physiology-transplant/p1-r119f-chronobiology-bounded-catchup-repair.js apply $DATABASE $NEW_RELEASE
EOF
install_atomic "$WORK/p1-r119-chronobiology-repair-once.conf" "$ONE_SHOT_DROPIN" 0644
ONE_SHOT_CREATED=1
point_current "$NEW_RELEASE"
POINTER_CHANGED=1
systemctl daemon-reload || abort daemon-reload-failed 1726
systemd-analyze verify stay.service >/dev/null 2>"$WORK/systemd-verify.stderr" ||
  abort systemd-contract-invalid 1727
RESTART_COMMITTED=1
systemctl restart stay.service || abort restart-failed 1728

after_health=''
for _ in $(seq 1 120); do
  after_health="$(curl --fail --silent --max-time 3 http://127.0.0.1:8787/healthz 2>/dev/null || true)"
  if [[ "$(json_field "$after_health" ok 2>/dev/null || true)" == true \
    && "$(json_field "$after_health" revision 2>/dev/null || true)" == 119 \
    && -S "$SOCKET" ]]; then break; fi
  sleep 1
done
after_pid="$(systemctl show stay.service -p MainPID --value)"
after_restarts="$(systemctl show stay.service -p NRestarts --value)"
[[ "$(json_field "$after_health" ok 2>/dev/null || true)" == true \
  && "$(json_field "$after_health" revision 2>/dev/null || true)" == 119 \
  && "$after_pid" =~ ^[1-9][0-9]*$ && "$after_pid" != "$before_pid" \
  && "$after_restarts" == "$before_restarts" \
  && "$(readlink -f /opt/stay/current)" == "$NEW_RELEASE" \
  && "$(proc_value "$after_pid" STAY_RECOVER_COLD_RESIDENTS_AT_REVISION)" == 119 ]] ||
  abort restarted-r119-runtime-invalid 1729

rm -f -- "$ONE_SHOT_DROPIN"
ONE_SHOT_CREATED=0
systemctl daemon-reload || abort one-shot-removal-daemon-reload-failed 1730
[[ ! -e "$ONE_SHOT_DROPIN" && ! -L "$ONE_SHOT_DROPIN" ]] || abort one-shot-not-removed 1731
node - "$before_pid" "$after_pid" "$before_restarts" "$after_restarts" > "$WORK/service.proof.json" <<'NODE'
'use strict';
const [beforePid, afterPid, beforeRestarts, afterRestarts] = process.argv.slice(2).map(Number);
process.stdout.write(JSON.stringify({
  beforePid, afterPid, beforeRestarts, afterRestarts, restartCommands: 1,
}) + '\n');
NODE

STAY_R119F_WORK="$WORK" \
STAY_R119F_BEFORE_DATABASE="$WORK/before.database.json" \
STAY_R119F_SERVICE_PROOF="$WORK/service.proof.json" \
STAY_R119F_ENTRY_PROOF="$WORK/entry-quota.proof.json" \
STAY_R119F_PREFLIGHT_PROOF="$WORK/repair.preflight.json" \
STAY_R119F_RELEASE="$NEW_RELEASE" \
STAY_R119F_RELEASE_TAG="$STAY_R119F_RELEASE_TAG" \
STAY_R119F_RELEASE_COMMIT="$STAY_R119F_RELEASE_COMMIT" \
STAY_R119F_RELEASE_TREE="$STAY_R119F_RELEASE_TREE" \
STAY_R119F_ARCHIVE_SHA256="$STAY_R119F_ARCHIVE_SHA256" \
STAY_R119F_MANIFEST_SHA256="$STAY_R119F_MANIFEST_SHA256" \
STAY_R119F_CONTROLLER_SHA256="$STAY_R119F_CONTROLLER_SHA256" \
STAY_R119F_PRIVATE_IPV4="$observed_ip" \
bash "$NEW_RELEASE/deploy/live-physiology-transplant/p1-r119f-finalize.sh" > "$WORK/finalize.output" ||
  abort finalization-failed 1732

final_evidence="$EVIDENCE_ROOT/R119F-$(date -u +'%Y%m%dT%H%M%SZ')"
mv -T "$WORK" "$final_evidence"
WORK=''
chmod -R a-w "$final_evidence"
rm -f -- "$RECOVERY_MARKER"
COMPLETED=1
trap - EXIT
cat "$final_evidence/finalize.output"
echo 'R119F_FORWARD_RESULT=PASS'
echo 'REVISION_LABEL=R119F'
echo "CURRENT_RELEASE=$NEW_RELEASE"
echo "R119F_EVIDENCE=$final_evidence"
echo "R119F_EVIDENCE_SHA256=sha256:$(find "$final_evidence" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
