#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH LC_ALL=C

EXPECTED_PRIVATE_IPV4='172.26.9.207'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
FREEZE_DIR='/var/lib/stay/evidence/runtime-freezes'
EVIDENCE_ROOT='/var/lib/stay/evidence/production-hardening'
MARKER='/run/stay-r128-metab-shadow-recovery.env'
DROPIN='/etc/systemd/system/stay.service.d/r128-metab-shadow-once.conf'
SOCKET='/run/stay/resident-control.sock'
PROOF='deploy/live-physiology-transplant/p1-r128-metab-shadow-live-proof.js'
CLIENT='deploy/live-physiology-transplant/p1-resident-control-client.js'

: "${STAY_R128_RECOVERY_AUTHORIZATION:?}"
: "${STAY_R128_SOURCE_RELEASE:?}"
: "${STAY_R128_TARGET_RELEASE:?}"
: "${STAY_R128_RELEASE_TAG:?}"
: "${STAY_R128_RELEASE_COMMIT:?}"
: "${STAY_R128_RELEASE_TREE:?}"
: "${STAY_R128_ARCHIVE_SHA256:?}"
: "${STAY_R128_MANIFEST_SHA256:?}"
: "${STAY_R128_CONTROLLER_SHA256:?}"

WORK=''
VERIFY_META=''
COMPLETED=0
START_COMMANDS=0
abort() { printf 'R128_METAB_SHADOW_RECOVERY_ABORT=%s\n' "$1" >&2; exit "${2:-1}"; }
sha256_file() { sha256sum "$1" | awk '{print $1}'; }
marker_value() {
  local key="$1"
  awk -F= -v key="$key" '$1==key {sub(/^[^=]*=/, ""); print; found=1}
    END {if (!found) exit 1}' "$MARKER"
}
durable_runtime_revision() {
  STAY_DATABASE="$DATABASE" /usr/local/bin/node <<'NODE'
'use strict'; const crypto=require('node:crypto'); const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.STAY_DATABASE,{open:true,readOnly:true});
try { db.exec('PRAGMA query_only=ON'); const row=db.prepare("SELECT json,sha256 FROM metadata WHERE key='life:runtime-revision'").get();
if(!row||crypto.createHash('sha256').update(row.json).digest('hex')!==row.sha256)process.exit(2);
const revision=Number(JSON.parse(row.json).revision); if(!Number.isSafeInteger(revision))process.exit(3);
process.stdout.write(String(revision)); } finally { db.close(); }
NODE
}
metab_version() {
  STAY_DATABASE="$DATABASE" /usr/local/bin/node <<'NODE'
'use strict'; const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.env.STAY_DATABASE,{open:true,readOnly:true});
try { db.exec('PRAGMA query_only=ON'); const row=db.prepare("SELECT version FROM resident_instances WHERE residency_id='resident:metab'").get();
process.stdout.write(String(row?.version||'')); } finally { db.close(); }
NODE
}
install_atomic() {
  local source="$1" target="$2" mode="$3" temporary
  temporary="$(mktemp "$(dirname "$target")/.r128-recovery.XXXXXX")"
  install -o root -g root -m "$mode" "$source" "$temporary"
  mv -fT "$temporary" "$target"
}
capture_quiescent_database() {
  local output="$1" temporary="$1.new" attempt
  for attempt in $(seq 1 20); do
    /usr/local/bin/node "$STAY_R128_TARGET_RELEASE/$PROOF" capture "$DATABASE" > "$temporary"
    if /usr/local/bin/node - "$temporary" <<'NODE'
'use strict'; const value=JSON.parse(require('node:fs').readFileSync(process.argv[2],'utf8'));
if(!(value.quickCheck==='ok'&&value.queryOnly===true&&value.pendingDeliveries===0&&
value.pendingOutboxIntents===0&&value.capacitySource?.pending===null&&
value.capacitySource?.lastCommittedFrame===value.metabCheckpointState?.lastAcceptedFrame))process.exit(1);
NODE
    then mv -fT "$temporary" "$output"; printf '%s\n' "$attempt" > "$output.attempts"; return 0; fi
    sleep 0.25
  done
  mv -fT "$temporary" "$output"; return 1
}
cleanup() {
  local status=$? failed
  trap - EXIT
  set +e
  if [[ -n "$VERIFY_META" ]]; then rm -f -- "$VERIFY_META"; fi
  if [[ "$COMPLETED" -eq 0 && -n "$WORK" && -d "$WORK" ]]; then
    failed="$(mktemp -d "$EVIDENCE_ROOT/FAILED-R128-METAB-RECOVERY-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
    rmdir -- "$failed"; mv -T "$WORK" "$failed"; chmod -R a-w "$failed"
    printf 'R128_METAB_SHADOW_RECOVERY_FAILURE_EVIDENCE=%s\n' "$failed" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 2851
[[ "$STAY_R128_RECOVERY_AUTHORIZATION" == 'AUTHORIZE_R128_METAB_OUTPUT_FIREWALLED_SHADOW_RECOVERY_ONLY' ]] ||
  abort authorization-required 2852
[[ -f "$MARKER" && ! -L "$MARKER" && "$(stat -Lc '%U:%G:%a' "$MARKER")" == root:root:400 &&
  "$(ip -4 -o addr show scope global | awk '{split($4,a,"/");print a[1]}' | sort -u)" == "$EXPECTED_PRIVATE_IPV4" ]] ||
  abort recovery-marker-or-host-invalid 2853
failure="$(marker_value R128_FAILURE_EVIDENCE)"
[[ "$failure" =~ ^/var/lib/stay/evidence/production-hardening/FAILED-R128-METAB-SHADOW-[0-9TZ]+\.[A-Za-z0-9]+$ &&
  -d "$failure" && ! -L "$failure" &&
  "$(marker_value R128_SOURCE_RELEASE)" == "$STAY_R128_SOURCE_RELEASE" &&
  "$(marker_value R128_TARGET_RELEASE)" == "$STAY_R128_TARGET_RELEASE" &&
  "$(marker_value R128_RELEASE_TAG)" == "$STAY_R128_RELEASE_TAG" &&
  "$(marker_value R128_RELEASE_COMMIT)" == "$STAY_R128_RELEASE_COMMIT" &&
  "$(marker_value R128_RELEASE_TREE)" == "$STAY_R128_RELEASE_TREE" &&
  "$(marker_value R128_ARCHIVE_SHA256)" == "$STAY_R128_ARCHIVE_SHA256" &&
  "$(marker_value R128_MANIFEST_SHA256)" == "$STAY_R128_MANIFEST_SHA256" &&
  "$(marker_value R128_CONTROLLER_SHA256)" == "$STAY_R128_CONTROLLER_SHA256" ]] ||
  abort recovery-cohort-invalid 2854
for file in "$failure/before.proof.json" "$failure/service.before.json" \
  "$failure/R127.freeze.json" "$STAY_R128_TARGET_RELEASE/$PROOF" \
  "$STAY_R128_TARGET_RELEASE/$CLIENT" "$STAY_R128_TARGET_RELEASE/P1_R128_RELEASE.env"; do
  [[ -f "$file" && ! -L "$file" ]] || abort recovery-evidence-invalid 2855
done
boundary_revision="$(durable_runtime_revision)"
[[ "$(readlink -f /opt/stay/current)" == "$STAY_R128_TARGET_RELEASE" &&
  "$(metab_version)" == '0.2.0-p1r0-shadow.1' &&
  "$boundary_revision" =~ ^12[89]$ ]] || abort durable-recovery-boundary-invalid 2856
if [[ -e "$DROPIN" || -L "$DROPIN" ]]; then
  [[ -f "$DROPIN" && ! -L "$DROPIN" ]] || abort promotion-dropin-unsafe 2857
  rm -f -- "$DROPIN"; systemctl daemon-reload
fi

existing_freeze="$FREEZE_DIR/R${boundary_revision}.json"
if [[ -e "$existing_freeze" || -L "$existing_freeze" ]]; then
  [[ -f "$existing_freeze" && ! -L "$existing_freeze" ]] ||
    abort existing-freeze-unsafe 2858
  /usr/local/bin/node - "$STAY_R128_TARGET_RELEASE/runtime/revision-freeze.js" \
    "$existing_freeze" "$boundary_revision" "$STAY_R128_TARGET_RELEASE" \
    "$STAY_R128_RELEASE_TAG" "$STAY_R128_RELEASE_COMMIT" "$STAY_R128_RELEASE_TREE" \
    "$STAY_R128_ARCHIVE_SHA256" "$STAY_R128_MANIFEST_SHA256" \
    "$STAY_R128_CONTROLLER_SHA256" <<'NODE'
'use strict';
const fs = require('node:fs');
const [helper, file, revisionText, releasePath, tag, commit, tree, archiveSha256,
  manifestSha256, controllerSha256] = process.argv.slice(2);
const revision = Number(revisionText);
const { validateRevisionFreeze } = require(helper);
const record = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!(validateRevisionFreeze(record, revision) &&
  record.release?.path === releasePath && record.release?.tag === tag &&
  record.release?.commit === commit && record.release?.tree === tree &&
  record.release?.archiveSha256 === archiveSha256 &&
  record.release?.manifestSha256 === manifestSha256 &&
  record.release?.controllerSha256 === controllerSha256 &&
  record.metab?.residencyId === 'resident:metab' &&
  record.metab?.instanceId === 'd424c722-ef31-44b0-8201-ba68c418d14a' &&
  record.metab?.version === '0.2.0-p1r0-shadow.1' &&
  record.metab?.mode === 'SHADOW' && record.metab?.authorityOwned === false &&
  record.metab?.observedOutputs === 0 &&
  record.continuity?.inventedBiologicalTime === false &&
  record.recovery?.pointerRewound === false)) process.exit(1);
NODE
  if [[ "$(systemctl show stay.service -p ActiveState --value)" == active &&
    "$(systemctl show stay.service -p SubState --value)" == running ]]; then
    VERIFY_META="$(mktemp /run/stay-r128-existing-freeze-meta.XXXXXX)"
    curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$VERIFY_META"
    /usr/local/bin/node - "$VERIFY_META" "$boundary_revision" <<'NODE'
'use strict';
const fs=require('node:fs'); const [file,revisionText]=process.argv.slice(2);
const revision=Number(revisionText); const meta=JSON.parse(fs.readFileSync(file,'utf8'));
const chip=id=>meta.chipProjection?.lifecycle?.find(value=>value.coreId===id);
if(!(meta.ok===true&&meta.revision===revision&&meta.revisionFrozen===true&&
meta.revisionLabel===`R${revision}F`&&chip('bsf')?.state==='LIVE'&&
chip('sntss')?.state==='SHADOW'&&chip('chronobiology')?.state==='SHADOW'&&
chip('metab')?.state==='SHADOW'))process.exit(1);
NODE
    rm -f -- "$VERIFY_META"
    VERIFY_META=''
    rm -f -- "$MARKER"
    COMPLETED=1
    printf '%s\n' 'R128_METAB_SHADOW_RECOVERY=PASS' \
      "RUNTIME_REVISION=$boundary_revision" "REVISION_LABEL=R${boundary_revision}F" \
      "CURRENT_RELEASE=$STAY_R128_TARGET_RELEASE" 'ALREADY_FROZEN=YES' \
      'BSF_MODE=LIVE' 'SNTSS_MODE=SHADOW' 'SNTSS_OUTPUTS=0' \
      'CHRONOBIOLOGY_MODE=SHADOW' 'METAB_MODE=SHADOW' 'METAB_OUTPUTS=0' \
      'METAB_AUTHORITY=NONE' 'FETUS_CONTINUITY=PASS' "FREEZE_FILE=$existing_freeze"
    exit 0
  fi
fi

WORK="$(mktemp -d "$EVIDENCE_ROOT/.R128-METAB-RECOVERY-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
install -o root -g root -m 0400 "$failure/before.proof.json" "$WORK/before.proof.json"
install -o root -g root -m 0400 "$failure/service.before.json" "$WORK/service.before.json"
install -o root -g root -m 0400 "$failure/R127.freeze.json" "$WORK/R127.freeze.json"
before_pid="$(/usr/local/bin/node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1])).mainPid))' "$WORK/service.before.json")"
before_restarts="$(/usr/local/bin/node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1])).nRestarts))' "$WORK/service.before.json")"
active="$(systemctl show stay.service -p ActiveState --value)"
sub="$(systemctl show stay.service -p SubState --value)"
if [[ "$active" != active || "$sub" != running ]]; then
  [[ "$boundary_revision" == 128 ]] || abort second-recovery-restart-forbidden 2860
  systemctl start stay.service
  START_COMMANDS=1
fi
expected_revision=$((boundary_revision + START_COMMANDS))
target_freeze="$FREEZE_DIR/R${expected_revision}.json"
[[ ! -e "$target_freeze" && ! -L "$target_freeze" ]] ||
  abort target-recovery-freeze-already-present 2861
ready=0
for attempt in $(seq 1 20); do
  after_pid="$(systemctl show stay.service -p MainPID --value)"
  after_restarts="$(systemctl show stay.service -p NRestarts --value)"
  if [[ "$after_pid" =~ ^[1-9][0-9]*$ && "$after_pid" != "$before_pid" &&
    "$after_restarts" == "$before_restarts" &&
    "$(systemctl show stay.service -p ActiveState --value)" == active &&
    "$(systemctl show stay.service -p SubState --value)" == running &&
    "$(durable_runtime_revision)" == "$expected_revision" && -S "$SOCKET" && ! -L "$SOCKET" ]] &&
    curl --fail --silent --max-time 1 http://127.0.0.1:8787/healthz |
      grep -q "\"revision\":$expected_revision"; then
    ready=1; printf '%s\n' "$attempt" > "$WORK/recovery-readiness.attempts"; break
  fi
  sleep 0.25
done
[[ "$ready" -eq 1 ]] || abort recovery-readiness-failed 2858

capture_quiescent_database "$WORK/database.after.json" || abort recovery-database-not-quiescent 2859
/usr/local/bin/node "$STAY_R128_TARGET_RELEASE/$CLIENT" status resident:sntss > "$WORK/sntss.after.json"
/usr/local/bin/node "$STAY_R128_TARGET_RELEASE/$CLIENT" status resident:chronobiology > "$WORK/chronobiology.after.json"
/usr/local/bin/node "$STAY_R128_TARGET_RELEASE/$CLIENT" status resident:metab > "$WORK/metab.after.json"
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.after.json"
/usr/local/bin/node - "$before_pid" "$after_pid" "$before_restarts" "$after_restarts" \
  "$expected_revision" > "$WORK/service.after.json" <<'NODE'
'use strict'; const [beforePid,afterPid,beforeRestarts,afterRestarts,revision]=process.argv.slice(2).map(Number);
process.stdout.write(`${JSON.stringify({beforePid,afterPid,beforeRestarts,afterRestarts,
restartCommands:revision===128?1:2})}\n`);
NODE
/usr/local/bin/node - "$STAY_R128_TARGET_RELEASE/$PROOF" "$WORK" "$STAY_R128_TARGET_RELEASE" \
  > "$WORK/after.proof.json" <<'NODE'
'use strict'; const fs=require('node:fs'); const path=require('node:path');
const [helper,root,targetRelease]=process.argv.slice(2); const read=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const value=require(helper).validateAfter({before:read('before.proof.json'),database:read('database.after.json'),
sntssStatus:read('sntss.after.json'),chronobiologyStatus:read('chronobiology.after.json'),
metabStatus:read('metab.after.json'),meta:read('meta.after.json'),service:read('service.after.json'),
currentRelease:targetRelease,targetRelease}); process.stdout.write(`${JSON.stringify(value)}\n`);
NODE
install -o root -g root -m 0444 "$STAY_R128_TARGET_RELEASE/P1_R128_RELEASE.env" "$WORK/P1_R128_RELEASE.env"

parent_revision=127
parent_name='R127.freeze.json'
if [[ "$expected_revision" == 129 && -f "$FREEZE_DIR/R128.json" &&
  ! -L "$FREEZE_DIR/R128.json" ]]; then
  /usr/local/bin/node - "$STAY_R128_TARGET_RELEASE/runtime/revision-freeze.js" \
    "$FREEZE_DIR/R128.json" <<'NODE'
'use strict'; const fs=require('node:fs'); const [helper,file]=process.argv.slice(2);
const {validateRevisionFreeze}=require(helper); const record=JSON.parse(fs.readFileSync(file,'utf8'));
if(!validateRevisionFreeze(record,128))process.exit(1);
NODE
  install -o root -g root -m 0400 "$FREEZE_DIR/R128.json" "$WORK/R128.freeze.json"
  parent_revision=128
  parent_name='R128.freeze.json'
fi
/usr/local/bin/node - "$STAY_R128_TARGET_RELEASE/runtime/revision-freeze.js" "$WORK" "$expected_revision" \
  "$parent_revision" "$parent_name" \
  > "$WORK/R${expected_revision}.freeze.json" <<'NODE'
'use strict'; const crypto=require('node:crypto'); const fs=require('node:fs'); const path=require('node:path');
const [helper,root,revisionText,parentRevisionText,parentName]=process.argv.slice(2);
const revision=Number(revisionText),parentRevision=Number(parentRevisionText);
const {sealRevisionFreeze,validateRevisionFreeze}=require(helper); const read=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const hash=n=>`sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root,n))).digest('hex')}`;
const before=read('before.proof.json'),after=read('after.proof.json'),service=read('service.after.json'),parent=read(parentName);
const release=Object.fromEntries(fs.readFileSync(path.join(root,'P1_R128_RELEASE.env'),'utf8').trim().split('\n').map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
if(!(after.result==='PASS'&&after.runtimeRevision===revision&&[128,129].includes(revision)&&
after.authorityOwned===false&&after.observedOutputs===0))process.exit(2);
const names=['R127.freeze.json','before.proof.json','after.proof.json','database.after.json',
'sntss.after.json','chronobiology.after.json','metab.after.json','meta.after.json','service.after.json','P1_R128_RELEASE.env'];
const record=sealRevisionFreeze({format:'stay-runtime-revision-freeze-v1',result:'PASS',acceptance:'ACCEPTED',
freezeType:revision===128?'R128_METAB_OUTPUT_FIREWALLED_SHADOW_RECOVERY':'R129_METAB_SHADOW_FORWARD_RECOVERY',
runtime:{revision,revisionLabel:`R${revision}F`,progression:[123,124,125,126,127,128,...(revision===129?[129]:[])],
serviceMainPid:service.afterPid,serviceNRestarts:service.afterRestarts,restartCommands:service.restartCommands},
parentFreeze:{revision:parentRevision,recordSha256:parent.recordSha256},release:{path:release.RELEASE_PATH,tag:release.RELEASE_TAG,
commit:release.RELEASE_COMMIT,tree:release.RELEASE_TREE,archiveSha256:release.ARCHIVE_SHA256,
manifestSha256:release.MANIFEST_SHA256,controllerSha256:release.CONTROLLER_SHA256},
metab:{residencyId:'resident:metab',instanceId:after.instanceId,version:after.version,mode:'SHADOW',
checkpointGeneration:after.checkpointGeneration,acceptedFrame:after.acceptedFrame,authorityOwned:false,
observedOutputs:0,outputPolicy:'FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT'},
continuity:{sntssCheckpointGenerationBefore:before.sntssCheckpointGeneration,
chronobiologyCheckpointGenerationBefore:before.chronobiologyCheckpointGeneration,pendingDeliveries:0,
pendingOutboxIntents:0,abandonedDeliveries:before.abandonedDeliveries,inventedBiologicalTime:false,fetusContinuity:true},
recovery:{revisionFenced:true,pointerRewound:false,forwardRecovery:revision===129},
promotionAuthority:{startupOnly:true,revokedFromUnit:true},evidence:Object.fromEntries(
  [...new Set([...names,parentName])].map(n=>[n,hash(n)])),
capturedAt:new Date().toISOString()}); if(!validateRevisionFreeze(record,revision))process.exit(3);
process.stdout.write(`${JSON.stringify(record)}\n`);
NODE
install_atomic "$WORK/R${expected_revision}.freeze.json" "$target_freeze" 0444
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.frozen.json"
/usr/local/bin/node - "$WORK/meta.frozen.json" "$expected_revision" <<'NODE'
'use strict'; const fs=require('node:fs'); const [file,revisionText]=process.argv.slice(2); const revision=Number(revisionText);
const meta=JSON.parse(fs.readFileSync(file,'utf8')); const chip=id=>meta.chipProjection?.lifecycle?.find(v=>v.coreId===id);
if(!(meta.ok===true&&meta.revision===revision&&meta.revisionFrozen===true&&meta.revisionLabel===`R${revision}F`&&
chip('bsf')?.state==='LIVE'&&chip('sntss')?.state==='SHADOW'&&chip('chronobiology')?.state==='SHADOW'&&
chip('metab')?.state==='SHADOW'))process.exit(1);
NODE
final="$EVIDENCE_ROOT/R${expected_revision}F-METAB-SHADOW-RECOVERY-$(date -u +'%Y%m%dT%H%M%SZ')"
mv -T "$WORK" "$final"; WORK=''; chmod -R a-w "$final"; rm -f -- "$MARKER"; COMPLETED=1
printf '%s\n' 'R128_METAB_SHADOW_RECOVERY=PASS' "RUNTIME_REVISION=$expected_revision" \
  "REVISION_LABEL=R${expected_revision}F" "CURRENT_RELEASE=$STAY_R128_TARGET_RELEASE" \
  'BSF_MODE=LIVE' 'SNTSS_MODE=SHADOW' 'SNTSS_OUTPUTS=0' \
  'CHRONOBIOLOGY_MODE=SHADOW' 'METAB_MODE=SHADOW' 'METAB_OUTPUTS=0' \
  'METAB_AUTHORITY=NONE' 'FETUS_CONTINUITY=PASS' "FREEZE_FILE=$target_freeze" "EVIDENCE_ROOT=$final"
