#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH LC_ALL=C

EXPECTED_PRIVATE_IPV4='172.26.9.207'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
FREEZE_DIR='/var/lib/stay/evidence/runtime-freezes'
PARENT_FREEZE="$FREEZE_DIR/R127.json"
TARGET_FREEZE="$FREEZE_DIR/R141.json"
EVIDENCE_ROOT='/var/lib/stay/evidence/production-hardening'
SOURCE_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r139-metab-shadow-recovery-6a343c91a536'
SOURCE_MANIFEST='deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R137_TO_R139.sha256'
SOURCE_MANIFEST_SHA256='6a343c91a536d9fab8147f9a214d05654e15f0221622b063477f53ea3212c981'
SOURCE_MARKER='/run/stay-r139-metab-shadow-recovery.env'
R141_MARKER='/run/stay-r141-metab-shadow-recovery.env'
SOCKET='/run/stay/resident-control.sock'
PROOF='deploy/live-physiology-transplant/p1-r128-metab-shadow-live-proof.js'
CLIENT='deploy/live-physiology-transplant/p1-resident-control-client.js'
AUTHORIZATION='AUTHORIZE_R141_METAB_OUTPUT_FIREWALLED_SHADOW_FORWARD_RECOVERY_ONLY'

: "${STAY_R141_RECOVERY_AUTHORIZATION:?}"
: "${STAY_R141_TARGET_RELEASE:?}"
: "${STAY_R141_RELEASE_TAG:?}"
: "${STAY_R141_RELEASE_COMMIT:?}"
: "${STAY_R141_RELEASE_TREE:?}"
: "${STAY_R141_ARCHIVE_SHA256:?}"
: "${STAY_R141_MANIFEST_SHA256:?}"
: "${STAY_R141_CONTROLLER_SHA256:?}"

WORK=''
COMPLETED=0
RESTART_COMMITTED=0
POINTER_SWITCHED=0

abort() { printf 'R141_METAB_SHADOW_RECOVERY_ABORT=%s\n' "$1" >&2; exit "${2:-1}"; }
sha256_file() { sha256sum "$1" | awk '{print $1}'; }

durable_runtime_revision() {
  STAY_DATABASE="$DATABASE" /usr/local/bin/node <<'NODE'
'use strict';
const crypto=require('node:crypto');const{DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.STAY_DATABASE,{open:true,readOnly:true});
try{db.exec('PRAGMA query_only=ON');const row=db.prepare("SELECT json,sha256 FROM metadata WHERE key='life:runtime-revision'").get();
if(!row||crypto.createHash('sha256').update(row.json).digest('hex')!==row.sha256)process.exit(2);
const value=Number(JSON.parse(row.json).revision);if(!Number.isSafeInteger(value))process.exit(3);process.stdout.write(String(value));}
finally{db.close();}
NODE
}

point_current() {
  local target="$1" temporary="/opt/stay/.current-r141-$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]]
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" /opt/stay/current
}

install_atomic() {
  local source="$1" target="$2" mode="$3" temporary
  temporary="$(mktemp "$(dirname "$target")/.r141-metab.XXXXXX")"
  install -o root -g root -m "$mode" "$source" "$temporary"
  mv -fT "$temporary" "$target"
}

capture_quiescent() {
  local output="$1" temporary="$1.new" attempt
  for attempt in $(seq 1 20); do
    /usr/local/bin/node "$STAY_R141_TARGET_RELEASE/$PROOF" capture "$DATABASE" > "$temporary"
    if /usr/local/bin/node - "$temporary" <<'NODE'
'use strict';const v=JSON.parse(require('node:fs').readFileSync(process.argv[2],'utf8'));
const settled=v.capacitySource?.pending===null&&
v.capacitySource?.lastCommittedFrame===v.metabCheckpointState?.lastAcceptedFrame;
if(!(v.quickCheck==='ok'&&v.queryOnly===true&&v.pendingDeliveries===0&&
v.pendingOutboxIntents===0&&v.failedDeliveries===0&&settled))process.exit(1);
NODE
    then mv -fT "$temporary" "$output"; printf '%s\n' "$attempt" > "$output.attempts"; return 0; fi
    sleep 0.25
  done
  mv -fT "$temporary" "$output"
  return 1
}

cleanup() {
  local status=$? failed marker_tmp
  trap - EXIT
  set +e
  if [[ "$COMPLETED" -eq 0 ]]; then
    if [[ "$RESTART_COMMITTED" -eq 0 && "$POINTER_SWITCHED" -eq 1 &&
      "$(readlink -f /opt/stay/current 2>/dev/null)" == "$STAY_R141_TARGET_RELEASE" ]]; then
      point_current "$SOURCE_RELEASE"
    fi
    if [[ -n "$WORK" && -d "$WORK" ]]; then
      failed="$(mktemp -d "$EVIDENCE_ROOT/FAILED-R141-METAB-SHADOW-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
      rmdir -- "$failed"; mv -T "$WORK" "$failed"; WORK=''; chmod -R a-w "$failed"
      printf 'R141_METAB_SHADOW_FAILURE_EVIDENCE=%s\n' "$failed" >&2
    fi
    if [[ "$RESTART_COMMITTED" -eq 1 ]]; then
      marker_tmp="$(mktemp /run/.stay-r141-metab-shadow-recovery.XXXXXX)"
      printf '%s\n' \
        "R141_FAILURE_EVIDENCE=$failed" \
        "R141_SOURCE_RELEASE=$SOURCE_RELEASE" \
        "R141_TARGET_RELEASE=$STAY_R141_TARGET_RELEASE" \
        "R141_RELEASE_TAG=$STAY_R141_RELEASE_TAG" \
        "R141_RELEASE_COMMIT=$STAY_R141_RELEASE_COMMIT" \
        "R141_RELEASE_TREE=$STAY_R141_RELEASE_TREE" \
        "R141_ARCHIVE_SHA256=$STAY_R141_ARCHIVE_SHA256" \
        "R141_MANIFEST_SHA256=$STAY_R141_MANIFEST_SHA256" \
        "R141_CONTROLLER_SHA256=$STAY_R141_CONTROLLER_SHA256" > "$marker_tmp"
      install_atomic "$marker_tmp" "$R141_MARKER" 0400
      rm -f -- "$marker_tmp"
      printf 'R141_METAB_SHADOW_FORWARD_RECOVERY_REQUIRED=YES\n' >&2
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 3301
[[ "$STAY_R141_RECOVERY_AUTHORIZATION" == "$AUTHORIZATION" ]] || abort authorization-required 3302
[[ "$(ip -4 -o addr show scope global | awk '{split($4,a,"/");print a[1]}' | sort -u)" == "$EXPECTED_PRIVATE_IPV4" ]] || abort host-identity-mismatch 3303
[[ "$STAY_R141_TARGET_RELEASE" =~ ^/opt/stay/releases/0\.8\.11\.3-p1m-r141-metab-shadow-recovery-[0-9a-f]{12}$ &&
  "$STAY_R141_RELEASE_TAG" =~ ^r141-metab-shadow-recovery-v[0-9]+$ &&
  "$STAY_R141_RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ && "$STAY_R141_RELEASE_TREE" =~ ^[0-9a-f]{40}$ &&
  "$STAY_R141_ARCHIVE_SHA256" =~ ^sha256:[0-9a-f]{64}$ &&
  "$STAY_R141_MANIFEST_SHA256" =~ ^sha256:[0-9a-f]{64}$ &&
  "$STAY_R141_CONTROLLER_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]] || abort immutable-identity-invalid 3304
for directory in "$SOURCE_RELEASE" "$STAY_R141_TARGET_RELEASE" "$EVIDENCE_ROOT" "$FREEZE_DIR"; do
  [[ -d "$directory" && ! -L "$directory" ]] || abort release-or-evidence-root-invalid 3305
done
for file in "$DATABASE" "$PARENT_FREEZE" "$SOURCE_MARKER" \
  "$SOURCE_RELEASE/$SOURCE_MANIFEST" "$STAY_R141_TARGET_RELEASE/$PROOF" \
  "$STAY_R141_TARGET_RELEASE/$CLIENT" "$STAY_R141_TARGET_RELEASE/P1_R141_RELEASE.env"; do
  [[ -f "$file" && ! -L "$file" ]] || abort release-input-invalid 3306
done
[[ "$(readlink -f /opt/stay/current)" == "$SOURCE_RELEASE" &&
  "$(sha256_file "$SOURCE_RELEASE/$SOURCE_MANIFEST")" == "$SOURCE_MANIFEST_SHA256" &&
  "$(durable_runtime_revision)" == 139 && ! -e "$TARGET_FREEZE" && ! -L "$TARGET_FREEZE" &&
  ! -e "$R141_MARKER" && ! -L "$R141_MARKER" ]] ||
  abort r139-source-boundary-invalid 3307
for revision in 128 129 130 131 132 133 134 135 136 137 138 139 140; do
  [[ ! -e "$FREEZE_DIR/R${revision}.json" && ! -L "$FREEZE_DIR/R${revision}.json" ]] ||
    abort unexpected-intermediate-freeze 3308
done
[[ "$(stat -Lc '%U:%G:%a' "$SOURCE_MARKER")" == 'root:root:400' &&
  "$(wc -l < "$SOURCE_MARKER")" -eq 9 ]] || abort r139-marker-trust-invalid 3309
for exact in \
  'R139_TARGET_RELEASE=/opt/stay/releases/0.8.11.3-p1m-r139-metab-shadow-recovery-6a343c91a536' \
  'R139_RELEASE_COMMIT=532467bf2b46f6a992df5c5ea63de57dfd39b156' \
  'R139_MANIFEST_SHA256=sha256:6a343c91a536d9fab8147f9a214d05654e15f0221622b063477f53ea3212c981' \
  'R139_CONTROLLER_SHA256=sha256:13949ecef06065571296d34848cb54c50d01c741bfd5b5053b47c9fe807426f7'; do
  grep -Fx "$exact" "$SOURCE_MARKER" >/dev/null || abort r139-marker-cohort-invalid 3310
done
r139_failure="$(sed -n 's/^R139_FAILURE_EVIDENCE=//p' "$SOURCE_MARKER")"
[[ "$(grep -c '^R139_FAILURE_EVIDENCE=' "$SOURCE_MARKER")" -eq 1 &&
  "$r139_failure" =~ ^/var/lib/stay/evidence/production-hardening/FAILED-R139-METAB-SHADOW-[A-Za-z0-9TZ.-]+$ &&
  -d "$r139_failure" && ! -L "$r139_failure" && "$(stat -Lc '%U:%G' "$r139_failure")" == root:root &&
  -z "$(find -P "$r139_failure" -xdev \( -type l -o ! -type d ! -type f -o ! -user root -o ! -group root -o -perm /022 \) -print -quit)" ]] ||
  abort r139-failure-evidence-invalid 3311
prior_files=(R127.freeze.json R137.failure-marker.env before.proof.json database.before.json \
  database.before.json.attempts sntss.before.json chronobiology.before.json metab.before.json fetus.before.html)
[[ "$(find "$r139_failure" -maxdepth 1 -type f | wc -l)" -eq "${#prior_files[@]}" ]] ||
  abort r139-failure-evidence-inventory-invalid 3311
for prior in "${prior_files[@]}"; do
  [[ -f "$r139_failure/$prior" && ! -L "$r139_failure/$prior" ]] ||
    abort r139-failure-evidence-inventory-invalid 3311
done
before_pid="$(systemctl show stay.service -p MainPID --value)"
before_restarts="$(systemctl show stay.service -p NRestarts --value)"
[[ "$before_pid" =~ ^[1-9][0-9]*$ && "$before_restarts" =~ ^[0-9]+$ &&
  -S "$SOCKET" && ! -L "$SOCKET" &&
  "$(stat -Lc '%U:%G:%a' "$SOCKET")" == 'staydeploy:staydeploy:600' &&
  "$(systemctl show stay.service -p ActiveState --value)" == active &&
  "$(systemctl show stay.service -p SubState --value)" == running &&
  "$(systemctl show stay.service -p User --value)" == staydeploy &&
  "$(systemctl show stay.service -p Group --value)" == staydeploy ]] &&
  ss -xlpn | awk -v socket="$SOCKET" -v pid="$before_pid" \
    'index($0,socket) && index($0,"pid=" pid ",") {found=1} END {exit !found}' &&
  ! curl --fail --silent --max-time 1 http://127.0.0.1:8787/healthz >/dev/null 2>&1 ||
  abort exact-r139-failed-http-live-control-preflight-invalid 3312

WORK="$(mktemp -d "$EVIDENCE_ROOT/.R141-METAB-SHADOW-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
install -o root -g root -m 0400 "$PARENT_FREEZE" "$WORK/R127.freeze.json"
install -o root -g root -m 0400 "$SOURCE_MARKER" "$WORK/R139.failure-marker.env"
for prior in "${prior_files[@]}"; do
  install -o root -g root -m 0400 "$r139_failure/$prior" "$WORK/R139.$prior"
done
/usr/local/bin/node "$STAY_R141_TARGET_RELEASE/$CLIENT" status resident:sntss > "$WORK/sntss.before.current.json"
/usr/local/bin/node "$STAY_R141_TARGET_RELEASE/$CLIENT" status resident:chronobiology > "$WORK/chronobiology.before.current.json"
/usr/local/bin/node "$STAY_R141_TARGET_RELEASE/$CLIENT" status resident:metab > "$WORK/metab.before.current.json"
/usr/local/bin/node "$STAY_R141_TARGET_RELEASE/$PROOF" capture "$DATABASE" > "$WORK/database.before.json" ||
  abort database-before-unreadable 3314
curl --fail --silent --max-time 3 http://127.0.0.1:8788/ > "$WORK/fetus.before.html"
/usr/local/bin/node - "$WORK" "$SOURCE_RELEASE" > "$WORK/before.proof.json" <<'NODE'
'use strict';const fs=require('node:fs'),path=require('node:path');const[root,current]=process.argv.slice(2),read=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const db=read('database.before.json'),prior=read('R139.before.proof.json'),s=read('sntss.before.current.json').resident,c=read('chronobiology.before.current.json').resident,m=read('metab.before.current.json').resident;
const row=id=>db.residents.find(v=>v.residency_id===id),consumer=id=>db.consumers.find(v=>v.consumer_id===id),state=db.metabCheckpointState,source=db.capacitySource,fetusAuthority=db.authorities?.find(v=>v.core_id==='fetus-legacy');
const {validateCapacitySourceState}=require(path.join(current,'runtime/p1-r0/metab-capacity-source'));
const validatedSource=validateCapacitySourceState(source,{instanceId:'d424c722-ef31-44b0-8201-ba68c418d14a',residentVersion:'0.2.0-p1r0-shadow.1'}),checkpointFrame=Number(state?.lastAcceptedFrame),allowedFrames=validatedSource.pending?[validatedSource.lastCommittedFrame,validatedSource.pending.sampleFrame]:[validatedSource.lastCommittedFrame];
const contained=v=>v?.status==='RUNNING'&&v.running===true&&v.authorityOwned===false&&v.host?.quarantined===false&&v.host?.osContainment?.required===true&&v.host?.osContainment?.available===true&&v.host?.osContainment?.payloadSandboxed===true&&v.host?.osContainment?.payloadAttachedBeforeInit===true&&v.host?.osContainment?.supervisorChargedToKernel===true&&v.host?.resourceGovernor?.policy?.softRamBytes===67108864&&v.host?.resourceGovernor?.policy?.hardRamBytes===100663296&&v.host?.resourceGovernor?.policy?.hardCpuDuty===0.2&&v.host?.resourceGovernor?.policy?.handlerTimeoutMs===250&&v.host?.resourceGovernor?.policy?.pidsMax===16&&v.host?.osContainment?.limits?.['memory.high']==='67108864'&&v.host?.osContainment?.limits?.['memory.max']==='100663296'&&v.host?.osContainment?.limits?.['pids.max']==='16'&&v.host?.osContainment?.limits?.['cpu.max']==='20000 100000';
if(!(current==='/opt/stay/releases/0.8.11.3-p1m-r139-metab-shadow-recovery-6a343c91a536'&&db.quickCheck==='ok'&&db.runtimeRevision===139&&
prior?.result==='PASS'&&prior?.runtimeRevision===137&&db.pendingDeliveries>=0&&db.pendingDeliveries<=8&&db.pendingOutboxIntents===0&&db.failedDeliveries===0&&db.abandonedDeliveries===0&&db.p1Authority===0&&db.sntssAuthority===0&&db.chronobiologyAuthority===0&&db.metabOutboxIntents===0&&
row('resident:metab')?.instance_id==='d424c722-ef31-44b0-8201-ba68c418d14a'&&row('resident:metab')?.version==='0.2.0-p1r0-shadow.1'&&row('resident:metab')?.state_schema===2&&row('resident:metab')?.module_relative_path==='cores/p1-r0/metab-shadow/index.js'&&row('resident:metab')?.status==='RUNNING'&&
state?.activation?.instanceId==='d424c722-ef31-44b0-8201-ba68c418d14a'&&state?.activation?.runtimeRevision===139&&state?.activation?.sourceCheckpointHash==='sha256:4a16fc393b9846d1dd6f2f9849920053e3d2b5235c066dde3c5cd72699595107'&&state?.lastAcceptedFrame>=1&&state?.engineState?.outputSequence==='0'&&allowedFrames.includes(checkpointFrame)&&
validatedSource.runtimeRevision===128&&validatedSource.instanceId==='d424c722-ef31-44b0-8201-ba68c418d14a'&&validatedSource.residentVersion==='0.2.0-p1r0-shadow.1'&&
row('resident:sntss')?.instance_id==='8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f'&&row('resident:sntss')?.version==='0.5.0-i4g1'&&
row('resident:chronobiology')?.instance_id==='f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a'&&row('resident:chronobiology')?.version==='1.0.0-c3rc.5'&&
contained(s)&&s?.host?.instanceId==='8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f'&&s?.version==='0.5.0-i4g1'&&s?.observedOutputs===0&&
contained(c)&&c?.host?.instanceId==='f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a'&&c?.version==='1.0.0-c3rc.5'&&c?.health?.mode==='NEUTRAL'&&
contained(m)&&m?.host?.instanceId==='d424c722-ef31-44b0-8201-ba68c418d14a'&&m?.version==='0.2.0-p1r0-shadow.1'&&m?.health?.mode==='SHADOW'&&m?.declaredOutputs===0&&m?.observedOutputs===0&&m?.health?.outputPolicy==='FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT'&&
consumer('resident:metab')?.active===1&&consumer('resident:metab')?.required===0&&consumer('resident:metab')?.authority_epoch===0&&consumer('resident:sntss')?.active===1&&consumer('resident:chronobiology')?.active===1&&
db.authorities?.length===1&&fetusAuthority?.instance_id==='82202211-8dd6-44d4-a4ec-8f2553d8dc6f'&&fetusAuthority?.version==='0.6.0'))process.exit(1);
process.stdout.write(JSON.stringify({result:'PASS',runtimeRevision:139,pendingDeliveries:db.pendingDeliveries,capacityPendingFrame:validatedSource.pending?.sampleFrame||null,sntssCheckpointGeneration:Number(row('resident:sntss').checkpoint_generation),chronobiologyCheckpointGeneration:Number(row('resident:chronobiology').checkpoint_generation),metabCheckpointGeneration:Number(row('resident:metab').checkpoint_generation),fetusInstanceId:fetusAuthority.instance_id,metabInstanceId:row('resident:metab').instance_id,metabActivationSourceCheckpointHash:state.activation.sourceCheckpointHash,metabAcceptedFrame:state.lastAcceptedFrame,abandonedDeliveries:db.abandonedDeliveries,founder:state.founder,metabChipHistory:db.metabChipHistory})+'\n');
NODE

point_current "$STAY_R141_TARGET_RELEASE"; POINTER_SWITCHED=1

RESTART_COMMITTED=1
systemctl restart stay.service
ready=0
for attempt in $(seq 1 20); do
  after_pid="$(systemctl show stay.service -p MainPID --value)"
  after_restarts="$(systemctl show stay.service -p NRestarts --value)"
  if [[ "$after_pid" =~ ^[1-9][0-9]*$ && "$after_pid" != "$before_pid" && "$after_restarts" == "$before_restarts" &&
    "$(systemctl show stay.service -p ActiveState --value)" == active && "$(systemctl show stay.service -p SubState --value)" == running &&
    "$(durable_runtime_revision)" == 141 && "$(readlink -f /opt/stay/current)" == "$STAY_R141_TARGET_RELEASE" && -S "$SOCKET" && ! -L "$SOCKET" ]] &&
    curl --fail --silent --max-time 1 http://127.0.0.1:8787/healthz | grep -q '"revision":141'; then
    ready=1; printf '%s\n' "$attempt" > "$WORK/readiness.attempts"; break
  fi
  sleep 0.25
done
[[ "$ready" -eq 1 ]] || abort r141-restart-readiness-failed 3315

capture_quiescent "$WORK/database.after.json" || abort database-after-not-quiescent 3316
/usr/local/bin/node "$STAY_R141_TARGET_RELEASE/$CLIENT" status resident:sntss > "$WORK/sntss.after.json"
/usr/local/bin/node "$STAY_R141_TARGET_RELEASE/$CLIENT" status resident:chronobiology > "$WORK/chronobiology.after.json"
/usr/local/bin/node "$STAY_R141_TARGET_RELEASE/$CLIENT" status resident:metab > "$WORK/metab.after.json"
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.after.json"
/usr/local/bin/node - "$WORK" "$STAY_R141_TARGET_RELEASE" "$before_pid" "$after_pid" "$before_restarts" "$after_restarts" > "$WORK/after.proof.json" <<'NODE'
'use strict';const fs=require('node:fs'),path=require('node:path');const[root,current,beforePid,afterPid,beforeRestarts,afterRestarts]=process.argv.slice(2),read=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const before=read('before.proof.json'),db=read('database.after.json'),s=read('sntss.after.json').resident,c=read('chronobiology.after.json').resident,m=read('metab.after.json').resident,meta=read('meta.after.json');
const row=id=>db.residents.find(v=>v.residency_id===id),chip=id=>meta.chipProjection?.lifecycle?.find(v=>v.coreId===id),metab=row('resident:metab'),state=db.metabCheckpointState,source=db.capacitySource,fetus=meta.cores?.find(v=>v.id==='fetus-legacy');
const contained=v=>v?.status==='RUNNING'&&v.running===true&&v.authorityOwned===false&&v.host?.quarantined===false&&v.host?.osContainment?.required===true&&v.host?.osContainment?.available===true&&v.host?.osContainment?.payloadSandboxed===true&&v.host?.osContainment?.payloadAttachedBeforeInit===true&&v.host?.osContainment?.supervisorChargedToKernel===true&&v.host?.resourceGovernor?.policy?.softRamBytes===67108864&&v.host?.resourceGovernor?.policy?.hardRamBytes===100663296&&v.host?.resourceGovernor?.policy?.hardCpuDuty===0.2&&v.host?.resourceGovernor?.policy?.handlerTimeoutMs===250&&v.host?.resourceGovernor?.policy?.pidsMax===16&&v.host?.osContainment?.limits?.['memory.high']==='67108864'&&v.host?.osContainment?.limits?.['memory.max']==='100663296'&&v.host?.osContainment?.limits?.['pids.max']==='16'&&v.host?.osContainment?.limits?.['cpu.max']==='20000 100000';
if(!(before.result==='PASS'&&current===process.env.STAY_R141_TARGET_RELEASE&&Number(beforePid)>0&&Number(afterPid)>0&&beforePid!==afterPid&&beforeRestarts===afterRestarts&&
db.quickCheck==='ok'&&db.runtimeRevision===141&&db.pendingDeliveries===0&&db.pendingOutboxIntents===0&&db.failedDeliveries===0&&db.abandonedDeliveries===before.abandonedDeliveries&&db.p1Authority===0&&db.sntssAuthority===0&&db.chronobiologyAuthority===0&&db.metabOutboxIntents===0&&
metab?.instance_id===before.metabInstanceId&&metab?.version==='0.2.0-p1r0-shadow.1'&&metab?.state_schema===2&&metab?.module_relative_path==='cores/p1-r0/metab-shadow/index.js'&&metab?.status==='RUNNING'&&
state?.activation?.instanceId===before.metabInstanceId&&state?.activation?.runtimeRevision===139&&state?.activation?.sourceCheckpointHash===before.metabActivationSourceCheckpointHash&&state?.lastAcceptedFrame>=before.metabAcceptedFrame&&state?.engineState?.outputSequence==='0'&&
source?.runtimeRevision===128&&source?.instanceId===before.metabInstanceId&&source?.residentVersion==='0.2.0-p1r0-shadow.1'&&source?.pending===null&&source?.lastCommittedFrame===state.lastAcceptedFrame&&
Number(metab?.checkpoint_generation)>=before.metabCheckpointGeneration&&
Number(row('resident:sntss')?.checkpoint_generation)>=before.sntssCheckpointGeneration&&Number(row('resident:chronobiology')?.checkpoint_generation)>=before.chronobiologyCheckpointGeneration&&
contained(s)&&s?.version==='0.5.0-i4g1'&&s?.observedOutputs===0&&contained(c)&&c?.version==='1.0.0-c3rc.5'&&c?.health?.mode==='NEUTRAL'&&contained(m)&&
m?.host?.instanceId===before.metabInstanceId&&m?.version==='0.2.0-p1r0-shadow.1'&&m?.health?.mode==='SHADOW'&&m?.health?.outputPolicy==='FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT'&&m?.declaredOutputs===0&&m?.observedOutputs===0&&
fetus?.version==='0.6.0'&&fetus?.mode==='active'&&fetus?.ok===true&&fetus?.memoryGuardian?.status==='healthy'&&fetus?.memoryGuardian?.warnAtMiB===192&&fetus?.memoryGuardian?.recycleAtMiB===256&&meta.ok===true&&meta.revision===141&&meta.revisionFrozen===false&&chip('bsf')?.state==='LIVE'&&chip('sntss')?.state==='SHADOW'&&chip('chronobiology')?.state==='SHADOW'&&chip('metab')?.state==='SHADOW'&&!meta.chipProjection?.roadmap?.some(v=>v.coreId==='metab'))){process.exit(1);}
process.stdout.write(JSON.stringify({result:'PASS',runtimeRevision:141,instanceId:metab.instance_id,version:metab.version,checkpointGeneration:Number(metab.checkpoint_generation),acceptedFrame:state.lastAcceptedFrame,activationRuntimeRevision:state.activation.runtimeRevision,capacitySourceRuntimeRevision:source.runtimeRevision,authorityOwned:false,observedOutputs:0,chipState:'SHADOW',sourceBoundaryRevision:139})+'\n');
NODE

install -o root -g root -m 0444 "$STAY_R141_TARGET_RELEASE/P1_R141_RELEASE.env" "$WORK/P1_R141_RELEASE.env"
STAY_R141_AFTER_PID="$after_pid" STAY_R141_AFTER_RESTARTS="$after_restarts" \
  /usr/local/bin/node - "$STAY_R141_TARGET_RELEASE/runtime/revision-freeze.js" "$WORK" > "$WORK/R141.freeze.json" <<'NODE'
'use strict';const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');const[helper,root]=process.argv.slice(2),{sealRevisionFreeze,validateRevisionFreeze}=require(helper),read=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8')),hash=n=>`sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root,n))).digest('hex')}`;
const before=read('before.proof.json'),after=read('after.proof.json'),parent=read('R127.freeze.json');
const release=Object.fromEntries(fs.readFileSync(path.join(root,'P1_R141_RELEASE.env'),'utf8').trim().split('\n').map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
if(!(before.result==='PASS'&&after.result==='PASS'&&after.runtimeRevision===141&&after.instanceId===before.metabInstanceId))process.exit(2);
const names=['R127.freeze.json','R139.failure-marker.env','R139.R127.freeze.json','R139.R137.failure-marker.env','R139.before.proof.json','R139.database.before.json','R139.database.before.json.attempts','R139.sntss.before.json','R139.chronobiology.before.json','R139.metab.before.json','R139.fetus.before.html','sntss.before.current.json','chronobiology.before.current.json','metab.before.current.json','before.proof.json','after.proof.json','database.before.json','database.after.json','sntss.after.json','chronobiology.after.json','metab.after.json','fetus.before.html','meta.after.json','P1_R141_RELEASE.env'];
const record=sealRevisionFreeze({format:'stay-runtime-revision-freeze-v1',result:'PASS',acceptance:'ACCEPTED',freezeType:'R141_METAB_OUTPUT_FIREWALLED_SHADOW_FORWARD_RECOVERY',runtime:{revision:141,revisionLabel:'R141F',progression:[123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141],serviceMainPid:Number(process.env.STAY_R141_AFTER_PID),serviceNRestarts:Number(process.env.STAY_R141_AFTER_RESTARTS),restartCommands:1},parentFreeze:{revision:127,recordSha256:parent.recordSha256},recoveryBoundary:{revision:139,r139FailureMarkerSha256:hash('R139.failure-marker.env'),pointerRewound:false},release:{path:release.RELEASE_PATH,tag:release.RELEASE_TAG,commit:release.RELEASE_COMMIT,tree:release.RELEASE_TREE,archiveSha256:release.ARCHIVE_SHA256,manifestSha256:release.MANIFEST_SHA256,controllerSha256:release.CONTROLLER_SHA256},metab:{residencyId:'resident:metab',instanceId:after.instanceId,version:after.version,mode:'SHADOW',checkpointGeneration:after.checkpointGeneration,acceptedFrame:after.acceptedFrame,activationRuntimeRevision:after.activationRuntimeRevision,capacitySourceRuntimeRevision:after.capacitySourceRuntimeRevision,authorityOwned:false,observedOutputs:0,outputPolicy:'FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT'},continuity:{sntssCheckpointGenerationBefore:before.sntssCheckpointGeneration,chronobiologyCheckpointGenerationBefore:before.chronobiologyCheckpointGeneration,pendingDeliveriesBefore:before.pendingDeliveries,pendingDeliveries:0,pendingOutboxIntents:0,abandonedDeliveries:before.abandonedDeliveries,inventedBiologicalTime:false,fetusContinuity:true},recovery:{revisionFenced:true,pointerRewound:false,repeatedPromotion:false,stagedCapacityFrameBefore:before.capacityPendingFrame,recoveredPendingToZero:true},evidence:Object.fromEntries(names.map(n=>[n,hash(n)])),capturedAt:new Date().toISOString()});
if(!validateRevisionFreeze(record,141))process.exit(3);process.stdout.write(JSON.stringify(record)+'\n');
NODE
install_atomic "$WORK/R141.freeze.json" "$TARGET_FREEZE" 0444
rm -f -- "$SOURCE_MARKER"
rm -f -- "$R141_MARKER"
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.frozen.json"
/usr/local/bin/node - "$WORK/meta.frozen.json" <<'NODE'
'use strict';const m=JSON.parse(require('node:fs').readFileSync(process.argv[2],'utf8')),chip=id=>m.chipProjection?.lifecycle?.find(v=>v.coreId===id);
if(!(m.ok===true&&m.revision===141&&m.revisionFrozen===true&&m.revisionLabel==='R141F'&&chip('bsf')?.state==='LIVE'&&chip('sntss')?.state==='SHADOW'&&chip('chronobiology')?.state==='SHADOW'&&chip('metab')?.state==='SHADOW'))process.exit(1);
NODE
[[ "$(durable_runtime_revision)" == 141 && "$(readlink -f /opt/stay/current)" == "$STAY_R141_TARGET_RELEASE" &&
  "$(systemctl show stay.service -p MainPID --value)" == "$after_pid" &&
  "$(systemctl show stay.service -p NRestarts --value)" == "$after_restarts" ]] || abort final-r141-fence-failed 3318

final_evidence="$EVIDENCE_ROOT/R141F-METAB-SHADOW-$(date -u +'%Y%m%dT%H%M%SZ')"
[[ ! -e "$final_evidence" && ! -L "$final_evidence" ]]
mv -T "$WORK" "$final_evidence"; WORK=''; chmod -R a-w "$final_evidence"; COMPLETED=1
printf '%s\n' 'R141_METAB_SHADOW_RECOVERY=PASS' 'RUNTIME_REVISION=141' 'REVISION_LABEL=R141F' \
  "CURRENT_RELEASE=$STAY_R141_TARGET_RELEASE" "SERVICE_PID=$after_pid" 'BSF_MODE=LIVE' \
  'SNTSS_MODE=SHADOW' 'SNTSS_OUTPUTS=0' 'CHRONOBIOLOGY_MODE=SHADOW' \
  'METAB_MODE=SHADOW' 'METAB_OUTPUTS=0' 'METAB_AUTHORITY=NONE' 'FETUS_CONTINUITY=PASS' \
  'PROMOTION_AUTHORITY_ACTIVE=NO' "FREEZE_FILE=$TARGET_FREEZE" "EVIDENCE_ROOT=$final_evidence"
