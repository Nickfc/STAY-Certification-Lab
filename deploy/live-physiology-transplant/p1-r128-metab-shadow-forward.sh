#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH LC_ALL=C

EXPECTED_PRIVATE_IPV4='172.26.9.207'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
FREEZE_DIR='/var/lib/stay/evidence/runtime-freezes'
PARENT_FREEZE="$FREEZE_DIR/R127.json"
TARGET_FREEZE="$FREEZE_DIR/R128.json"
EVIDENCE_ROOT='/var/lib/stay/evidence/production-hardening'
DROPIN_DIR='/etc/systemd/system/stay.service.d'
DROPIN="$DROPIN_DIR/r128-metab-shadow-once.conf"
SOCKET='/run/stay/resident-control.sock'
RECOVERY_MARKER='/run/stay-r128-metab-shadow-recovery.env'
MANIFEST='deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R127F_TO_R128.sha256'
PROOF='deploy/live-physiology-transplant/p1-r128-metab-shadow-live-proof.js'
CLIENT='deploy/live-physiology-transplant/p1-resident-control-client.js'

: "${STAY_R128_FORWARD_AUTHORIZATION:?}"
: "${STAY_R128_SOURCE_RELEASE:?}"
: "${STAY_R128_TARGET_RELEASE:?}"
: "${STAY_R128_RELEASE_TAG:?}"
: "${STAY_R128_RELEASE_COMMIT:?}"
: "${STAY_R128_RELEASE_TREE:?}"
: "${STAY_R128_ARCHIVE_SHA256:?}"
: "${STAY_R128_MANIFEST_SHA256:?}"
: "${STAY_R128_CONTROLLER_SHA256:?}"

WORK=''
COMPLETED=0
RESTART_COMMITTED=0
POINTER_SWITCHED=0
DROPIN_INSTALLED=0

abort() { printf 'R128_METAB_SHADOW_ABORT=%s\n' "$1" >&2; exit "${2:-1}"; }
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

point_current() {
  local target="$1" temporary
  temporary="/opt/stay/.current-r128-$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]]
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" /opt/stay/current
}

install_atomic() {
  local source="$1" target="$2" mode="$3" temporary
  temporary="$(mktemp "$(dirname "$target")/.r128-metab.XXXXXX")"
  install -o root -g root -m "$mode" "$source" "$temporary"
  mv -fT "$temporary" "$target"
}

capture_quiescent_database() {
  local output="$1" temporary="$1.new" attempt
  for attempt in $(seq 1 20); do
    /usr/local/bin/node "$STAY_R128_TARGET_RELEASE/$PROOF" capture "$DATABASE" > "$temporary"
    if /usr/local/bin/node - "$temporary" <<'NODE'
'use strict';
const value = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
const sourceSettled = value.runtimeRevision === 127 ||
  (value.capacitySource?.pending === null &&
   value.capacitySource?.lastCommittedFrame === value.metabCheckpointState?.lastAcceptedFrame);
if (!(value.quickCheck === 'ok' && value.queryOnly === true &&
  value.pendingDeliveries === 0 && value.pendingOutboxIntents === 0 && sourceSettled)) process.exit(1);
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

write_service_before() {
  local pid="$1" restarts="$2" active="$3" sub="$4" output="$5"
  /usr/local/bin/node - "$pid" "$restarts" "$active" "$sub" > "$output" <<'NODE'
'use strict';
const [pid, restarts, activeState, subState] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify({ mainPid: Number(pid), nRestarts: Number(restarts),
  activeState, subState })}\n`);
NODE
}

remove_dropin() {
  if [[ -e "$DROPIN" || -L "$DROPIN" ]]; then
    [[ -f "$DROPIN" && ! -L "$DROPIN" ]] || return 1
    rm -f -- "$DROPIN"
  fi
  DROPIN_INSTALLED=0
  systemctl daemon-reload
}

cleanup() {
  local status=$? failed marker_tmp
  trap - EXIT
  set +e
  if [[ "$COMPLETED" -eq 0 ]]; then
    if [[ "$DROPIN_INSTALLED" -eq 1 ]]; then remove_dropin; fi
    if [[ "$RESTART_COMMITTED" -eq 0 && "$POINTER_SWITCHED" -eq 1 &&
      "$(readlink -f /opt/stay/current 2>/dev/null)" == "$STAY_R128_TARGET_RELEASE" ]]; then
      point_current "$STAY_R128_SOURCE_RELEASE"
    fi
    if [[ -n "$WORK" && -d "$WORK" ]]; then
      failed="$(mktemp -d "$EVIDENCE_ROOT/FAILED-R128-METAB-SHADOW-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
      rmdir -- "$failed"
      mv -T "$WORK" "$failed"
      WORK=''
      chmod -R a-w "$failed"
      printf 'R128_METAB_SHADOW_FAILURE_EVIDENCE=%s\n' "$failed" >&2
      if [[ "$RESTART_COMMITTED" -eq 1 ]]; then
        marker_tmp="$(mktemp /run/.stay-r128-metab-shadow-recovery.XXXXXX)"
        printf '%s\n' \
          "R128_FAILURE_EVIDENCE=$failed" \
          "R128_SOURCE_RELEASE=$STAY_R128_SOURCE_RELEASE" \
          "R128_TARGET_RELEASE=$STAY_R128_TARGET_RELEASE" \
          "R128_RELEASE_TAG=$STAY_R128_RELEASE_TAG" \
          "R128_RELEASE_COMMIT=$STAY_R128_RELEASE_COMMIT" \
          "R128_RELEASE_TREE=$STAY_R128_RELEASE_TREE" \
          "R128_ARCHIVE_SHA256=$STAY_R128_ARCHIVE_SHA256" \
          "R128_MANIFEST_SHA256=$STAY_R128_MANIFEST_SHA256" \
          "R128_CONTROLLER_SHA256=$STAY_R128_CONTROLLER_SHA256" > "$marker_tmp"
        install_atomic "$marker_tmp" "$RECOVERY_MARKER" 0400
        rm -f -- "$marker_tmp"
        printf 'R128_METAB_SHADOW_RECOVERY_REQUIRED=YES\n' >&2
      fi
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 2801
[[ "$STAY_R128_FORWARD_AUTHORIZATION" == 'AUTHORIZE_R128_METAB_OUTPUT_FIREWALLED_SHADOW_FORWARD_ONLY' ]] ||
  abort authorization-required 2802
[[ "$STAY_R128_SOURCE_RELEASE" == '/opt/stay/releases/0.8.11.3-p1m-r127-metab-final-fb27ce309f77' &&
  "$STAY_R128_TARGET_RELEASE" =~ ^/opt/stay/releases/0\.8\.11\.3-p1m-r128-metab-shadow-[0-9a-f]{12}$ &&
  "$STAY_R128_RELEASE_TAG" =~ ^r128-metab-shadow-v[0-9]+$ &&
  "$STAY_R128_RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ &&
  "$STAY_R128_RELEASE_TREE" =~ ^[0-9a-f]{40}$ &&
  "$STAY_R128_ARCHIVE_SHA256" =~ ^sha256:[0-9a-f]{64}$ &&
  "$STAY_R128_MANIFEST_SHA256" =~ ^sha256:[0-9a-f]{64}$ &&
  "$STAY_R128_CONTROLLER_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  abort immutable-identity-invalid 2803
observed_ip="$(ip -4 -o addr show scope global | awk '{split($4,a,"/"); print a[1]}' | sort -u)"
[[ "$observed_ip" == "$EXPECTED_PRIVATE_IPV4" ]] || abort host-identity-mismatch 2804
for directory in "$STAY_R128_SOURCE_RELEASE" "$STAY_R128_TARGET_RELEASE" "$EVIDENCE_ROOT" "$FREEZE_DIR"; do
  [[ -d "$directory" && ! -L "$directory" ]] || abort release-or-evidence-root-invalid 2805
done
for file in "$DATABASE" "$PARENT_FREEZE" \
  "$STAY_R128_TARGET_RELEASE/$MANIFEST" "$STAY_R128_TARGET_RELEASE/$PROOF" \
  "$STAY_R128_TARGET_RELEASE/$CLIENT" "$STAY_R128_TARGET_RELEASE/P1_R128_RELEASE.env"; do
  [[ -f "$file" && ! -L "$file" ]] || abort release-input-invalid 2806
done
[[ ! -e "$TARGET_FREEZE" && ! -L "$TARGET_FREEZE" &&
  ! -e "$RECOVERY_MARKER" && ! -L "$RECOVERY_MARKER" &&
  "$(readlink -f /opt/stay/current)" == "$STAY_R128_SOURCE_RELEASE" &&
  "$(sha256_file "$STAY_R128_TARGET_RELEASE/$MANIFEST")" == "${STAY_R128_MANIFEST_SHA256#sha256:}" ]] ||
  abort source-boundary-invalid 2807
(cd "$STAY_R128_TARGET_RELEASE" && sha256sum -c "$MANIFEST" >/dev/null) ||
  abort target-manifest-invalid 2808
[[ "$(durable_runtime_revision)" == 127 &&
  "$(systemctl show stay.service -p ActiveState --value)" == active &&
  "$(systemctl show stay.service -p SubState --value)" == running &&
  "$(systemctl show stay.service -p User --value)" == staydeploy &&
  "$(systemctl show stay.service -p Group --value)" == staydeploy &&
  -S "$SOCKET" && ! -L "$SOCKET" ]] || abort live-service-preflight-invalid 2809

WORK="$(mktemp -d "$EVIDENCE_ROOT/.R128-METAB-SHADOW-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
install -o root -g root -m 0400 "$PARENT_FREEZE" "$WORK/R127.freeze.json"
before_pid="$(systemctl show stay.service -p MainPID --value)"
before_restarts="$(systemctl show stay.service -p NRestarts --value)"
write_service_before "$before_pid" "$before_restarts" active running "$WORK/service.before.json"
capture_quiescent_database "$WORK/database.before.json" || abort database-before-not-quiescent 2810
/usr/local/bin/node "$STAY_R128_SOURCE_RELEASE/$CLIENT" status resident:sntss > "$WORK/sntss.before.json"
/usr/local/bin/node "$STAY_R128_SOURCE_RELEASE/$CLIENT" status resident:chronobiology > "$WORK/chronobiology.before.json"
/usr/local/bin/node "$STAY_R128_SOURCE_RELEASE/$CLIENT" status resident:metab > "$WORK/metab.before.json"
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.before.json"
/usr/local/bin/node - "$STAY_R128_TARGET_RELEASE/$PROOF" "$WORK" "$STAY_R128_SOURCE_RELEASE" \
  > "$WORK/before.proof.json" <<'NODE'
'use strict';
const fs = require('node:fs'); const path = require('node:path');
const [helper, root, currentRelease] = process.argv.slice(2);
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const value = require(helper).validateBefore({ database: read('database.before.json'),
  freeze: read('R127.freeze.json'), sntssStatus: read('sntss.before.json'),
  chronobiologyStatus: read('chronobiology.before.json'), metabStatus: read('metab.before.json'),
  meta: read('meta.before.json'), service: read('service.before.json'), currentRelease });
process.stdout.write(`${JSON.stringify(value)}\n`);
NODE

install -d -o root -g root -m 0755 "$DROPIN_DIR"
dropin_tmp="$(mktemp /run/stay-r128-metab-shadow-once.XXXXXX)"
cat > "$dropin_tmp" <<'DROPIN'
[Service]
Environment=STAY_ALLOW_METAB_SHADOW_PROMOTION=1
Environment=STAY_METAB_SHADOW_PROMOTION_AUTHORIZATION=AUTHORIZE_R128_METAB_NEUTRAL_TO_OUTPUT_FIREWALLED_SHADOW_ONLY
DROPIN
install_atomic "$dropin_tmp" "$DROPIN" 0644
rm -f -- "$dropin_tmp"
DROPIN_INSTALLED=1
point_current "$STAY_R128_TARGET_RELEASE"
POINTER_SWITCHED=1
systemctl daemon-reload

RESTART_COMMITTED=1
systemctl restart stay.service
ready=0
for attempt in $(seq 1 20); do
  after_pid="$(systemctl show stay.service -p MainPID --value)"
  after_restarts="$(systemctl show stay.service -p NRestarts --value)"
  if [[ "$after_pid" =~ ^[1-9][0-9]*$ && "$after_pid" != "$before_pid" &&
    "$after_restarts" == "$before_restarts" &&
    "$(systemctl show stay.service -p ActiveState --value)" == active &&
    "$(systemctl show stay.service -p SubState --value)" == running &&
    "$(durable_runtime_revision)" == 128 &&
    "$(readlink -f /opt/stay/current)" == "$STAY_R128_TARGET_RELEASE" &&
    -S "$SOCKET" && ! -L "$SOCKET" ]] &&
    curl --fail --silent --max-time 1 http://127.0.0.1:8787/healthz | grep -q '"revision":128'; then
    ready=1
    printf '%s\n' "$attempt" > "$WORK/restart-readiness.attempts"
    break
  fi
  sleep 0.25
done
[[ "$ready" -eq 1 ]] || abort r128-restart-readiness-failed 2811

capture_quiescent_database "$WORK/database.after.json" || abort database-after-not-quiescent 2812
/usr/local/bin/node "$STAY_R128_TARGET_RELEASE/$CLIENT" status resident:sntss > "$WORK/sntss.after.json"
/usr/local/bin/node "$STAY_R128_TARGET_RELEASE/$CLIENT" status resident:chronobiology > "$WORK/chronobiology.after.json"
/usr/local/bin/node "$STAY_R128_TARGET_RELEASE/$CLIENT" status resident:metab > "$WORK/metab.after.json"
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.after.json"
/usr/local/bin/node - "$before_pid" "$after_pid" "$before_restarts" "$after_restarts" \
  > "$WORK/service.after.json" <<'NODE'
'use strict';
const [beforePid, afterPid, beforeRestarts, afterRestarts] = process.argv.slice(2).map(Number);
process.stdout.write(`${JSON.stringify({ beforePid, afterPid, beforeRestarts, afterRestarts,
  restartCommands: 1 })}\n`);
NODE
/usr/local/bin/node - "$STAY_R128_TARGET_RELEASE/$PROOF" "$WORK" "$STAY_R128_TARGET_RELEASE" \
  > "$WORK/after.proof.json" <<'NODE'
'use strict';
const fs = require('node:fs'); const path = require('node:path');
const [helper, root, targetRelease] = process.argv.slice(2);
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const value = require(helper).validateAfter({ before: read('before.proof.json'),
  database: read('database.after.json'), sntssStatus: read('sntss.after.json'),
  chronobiologyStatus: read('chronobiology.after.json'), metabStatus: read('metab.after.json'),
  meta: read('meta.after.json'), service: read('service.after.json'),
  currentRelease: targetRelease, targetRelease });
process.stdout.write(`${JSON.stringify(value)}\n`);
NODE

remove_dropin || abort promotion-authority-revocation-failed 2813
install -o root -g root -m 0444 "$STAY_R128_TARGET_RELEASE/P1_R128_RELEASE.env" \
  "$WORK/P1_R128_RELEASE.env"
/usr/local/bin/node - "$STAY_R128_TARGET_RELEASE/runtime/revision-freeze.js" "$WORK" \
  > "$WORK/R128.freeze.json" <<'NODE'
'use strict';
const crypto = require('node:crypto'); const fs = require('node:fs'); const path = require('node:path');
const [helper, root] = process.argv.slice(2); const { sealRevisionFreeze, validateRevisionFreeze } = require(helper);
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const hash = name => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')}`;
const before = read('before.proof.json'); const after = read('after.proof.json');
const service = read('service.after.json'); const parent = read('R127.freeze.json');
const release = Object.fromEntries(fs.readFileSync(path.join(root, 'P1_R128_RELEASE.env'), 'utf8')
  .trim().split('\n').map(line => { const at=line.indexOf('='); return [line.slice(0,at),line.slice(at+1)]; }));
if (!(after.result === 'PASS' && after.runtimeRevision === 128 && after.authorityOwned === false &&
  after.observedOutputs === 0 && after.chipState === 'SHADOW' && service.restartCommands === 1)) process.exit(2);
const evidenceNames = ['R127.freeze.json','before.proof.json','after.proof.json','database.before.json',
  'database.after.json','sntss.after.json','chronobiology.after.json','metab.after.json',
  'meta.after.json','service.after.json','P1_R128_RELEASE.env'];
const record = sealRevisionFreeze({ format: 'stay-runtime-revision-freeze-v1', result: 'PASS',
  acceptance: 'ACCEPTED', freezeType: 'R128_METAB_OUTPUT_FIREWALLED_SHADOW',
  runtime: { revision: 128, revisionLabel: 'R128F', progression: [123,124,125,126,127,128],
    serviceMainPid: service.afterPid, serviceNRestarts: service.afterRestarts, restartCommands: 1 },
  parentFreeze: { revision: 127, recordSha256: parent.recordSha256 },
  release: { path: release.RELEASE_PATH, tag: release.RELEASE_TAG, commit: release.RELEASE_COMMIT,
    tree: release.RELEASE_TREE, archiveSha256: release.ARCHIVE_SHA256,
    manifestSha256: release.MANIFEST_SHA256, controllerSha256: release.CONTROLLER_SHA256 },
  metab: { residencyId: 'resident:metab', instanceId: after.instanceId, version: after.version,
    mode: 'SHADOW', checkpointGeneration: after.checkpointGeneration,
    acceptedFrame: after.acceptedFrame, authorityOwned: false, observedOutputs: 0,
    outputPolicy: 'FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT' },
  continuity: { sntssCheckpointGenerationBefore: before.sntssCheckpointGeneration,
    chronobiologyCheckpointGenerationBefore: before.chronobiologyCheckpointGeneration,
    pendingDeliveries: 0, pendingOutboxIntents: 0, abandonedDeliveries: before.abandonedDeliveries,
    inventedBiologicalTime: false, fetusContinuity: true },
  recovery: { revisionFenced: true, pointerRewound: false },
  promotionAuthority: { startupOnly: true, revokedFromUnit: true },
  evidence: Object.fromEntries(evidenceNames.map(name => [name, hash(name)])),
  capturedAt: new Date().toISOString() });
if (!validateRevisionFreeze(record, 128)) process.exit(3);
process.stdout.write(`${JSON.stringify(record)}\n`);
NODE
install_atomic "$WORK/R128.freeze.json" "$TARGET_FREEZE" 0444

curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.frozen.json"
/usr/local/bin/node - "$WORK/meta.frozen.json" <<'NODE'
'use strict'; const fs=require('node:fs'); const meta=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const chip=id=>meta.chipProjection?.lifecycle?.find(value=>value.coreId===id);
if (!(meta.ok===true && meta.revision===128 && meta.revisionFrozen===true && meta.revisionLabel==='R128F' &&
  chip('bsf')?.state==='LIVE' && chip('sntss')?.state==='SHADOW' &&
  chip('chronobiology')?.state==='SHADOW' && chip('metab')?.state==='SHADOW')) process.exit(1);
NODE
[[ "$(durable_runtime_revision)" == 128 &&
  "$(readlink -f /opt/stay/current)" == "$STAY_R128_TARGET_RELEASE" &&
  "$(systemctl show stay.service -p MainPID --value)" == "$after_pid" &&
  "$(systemctl show stay.service -p NRestarts --value)" == "$after_restarts" ]] ||
  abort final-r128-fence-failed 2814

final_evidence="$EVIDENCE_ROOT/R128F-METAB-SHADOW-$(date -u +'%Y%m%dT%H%M%SZ')"
[[ ! -e "$final_evidence" && ! -L "$final_evidence" ]]
mv -T "$WORK" "$final_evidence"
WORK=''
chmod -R a-w "$final_evidence"
COMPLETED=1

printf '%s\n' \
  'R128_METAB_SHADOW=PASS' \
  'RUNTIME_REVISION=128' \
  'REVISION_LABEL=R128F' \
  "CURRENT_RELEASE=$STAY_R128_TARGET_RELEASE" \
  "SERVICE_PID=$after_pid" \
  'BSF_MODE=LIVE' \
  'SNTSS_MODE=SHADOW' \
  'SNTSS_OUTPUTS=0' \
  'CHRONOBIOLOGY_MODE=SHADOW' \
  'METAB_MODE=SHADOW' \
  'METAB_OUTPUTS=0' \
  'METAB_AUTHORITY=NONE' \
  'FETUS_CONTINUITY=PASS' \
  'PROMOTION_AUTHORITY_ACTIVE=NO' \
  "FREEZE_FILE=$TARGET_FREEZE" \
  "EVIDENCE_ROOT=$final_evidence"
