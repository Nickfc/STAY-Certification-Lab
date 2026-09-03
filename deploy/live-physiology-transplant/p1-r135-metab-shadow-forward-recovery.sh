#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH LC_ALL=C

EXPECTED_PRIVATE_IPV4='172.26.9.207'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
FREEZE_DIR='/var/lib/stay/evidence/runtime-freezes'
PARENT_FREEZE="$FREEZE_DIR/R127.json"
TARGET_FREEZE="$FREEZE_DIR/R135.json"
EVIDENCE_ROOT='/var/lib/stay/evidence/production-hardening'
SOURCE_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r133-metab-shadow-recovery-087a96cd77b6'
SOURCE_MANIFEST='deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R131_TO_R133.sha256'
SOURCE_MANIFEST_SHA256='087a96cd77b65b15ce68bebbfc7cfdc02b6beed013d0e507f396a6eba8daa949'
SOURCE_MARKER='/run/stay-r133-metab-shadow-recovery.env'
R135_MARKER='/run/stay-r135-metab-shadow-recovery.env'
DROPIN_DIR='/etc/systemd/system/stay.service.d'
DROPIN="$DROPIN_DIR/r135-metab-shadow-recovery-once.conf"
SOCKET='/run/stay/resident-control.sock'
PROOF='deploy/live-physiology-transplant/p1-r128-metab-shadow-live-proof.js'
CLIENT='deploy/live-physiology-transplant/p1-resident-control-client.js'
AUTHORIZATION='AUTHORIZE_R135_METAB_OUTPUT_FIREWALLED_SHADOW_FORWARD_RECOVERY_ONLY'
PROMOTION_AUTHORIZATION='AUTHORIZE_R135_METAB_NEUTRAL_TO_OUTPUT_FIREWALLED_SHADOW_RECOVERY_ONLY'

: "${STAY_R135_RECOVERY_AUTHORIZATION:?}"
: "${STAY_R135_TARGET_RELEASE:?}"
: "${STAY_R135_RELEASE_TAG:?}"
: "${STAY_R135_RELEASE_COMMIT:?}"
: "${STAY_R135_RELEASE_TREE:?}"
: "${STAY_R135_ARCHIVE_SHA256:?}"
: "${STAY_R135_MANIFEST_SHA256:?}"
: "${STAY_R135_CONTROLLER_SHA256:?}"

WORK=''
COMPLETED=0
RESTART_COMMITTED=0
POINTER_SWITCHED=0
DROPIN_INSTALLED=0

abort() { printf 'R135_METAB_SHADOW_RECOVERY_ABORT=%s\n' "$1" >&2; exit "${2:-1}"; }
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
  local target="$1" temporary="/opt/stay/.current-r135-$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]]
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" /opt/stay/current
}

install_atomic() {
  local source="$1" target="$2" mode="$3" temporary
  temporary="$(mktemp "$(dirname "$target")/.r135-metab.XXXXXX")"
  install -o root -g root -m "$mode" "$source" "$temporary"
  mv -fT "$temporary" "$target"
}

remove_dropin() {
  if [[ -e "$DROPIN" || -L "$DROPIN" ]]; then
    [[ -f "$DROPIN" && ! -L "$DROPIN" ]] || return 1
    rm -f -- "$DROPIN"
  fi
  DROPIN_INSTALLED=0
  systemctl daemon-reload
}

capture_quiescent() {
  local output="$1" temporary="$1.new" attempt
  for attempt in $(seq 1 20); do
    /usr/local/bin/node "$STAY_R135_TARGET_RELEASE/$PROOF" capture "$DATABASE" > "$temporary"
    if /usr/local/bin/node - "$temporary" <<'NODE'
'use strict';const v=JSON.parse(require('node:fs').readFileSync(process.argv[2],'utf8'));
const settled=v.runtimeRevision===133||(v.capacitySource?.pending===null&&
v.capacitySource?.lastCommittedFrame===v.metabCheckpointState?.lastAcceptedFrame);
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
    if [[ "$DROPIN_INSTALLED" -eq 1 ]]; then remove_dropin; fi
    if [[ "$RESTART_COMMITTED" -eq 0 && "$POINTER_SWITCHED" -eq 1 &&
      "$(readlink -f /opt/stay/current 2>/dev/null)" == "$STAY_R135_TARGET_RELEASE" ]]; then
      point_current "$SOURCE_RELEASE"
    fi
    if [[ -n "$WORK" && -d "$WORK" ]]; then
      failed="$(mktemp -d "$EVIDENCE_ROOT/FAILED-R135-METAB-SHADOW-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
      rmdir -- "$failed"; mv -T "$WORK" "$failed"; WORK=''; chmod -R a-w "$failed"
      printf 'R135_METAB_SHADOW_FAILURE_EVIDENCE=%s\n' "$failed" >&2
    fi
    if [[ "$RESTART_COMMITTED" -eq 1 ]]; then
      marker_tmp="$(mktemp /run/.stay-r135-metab-shadow-recovery.XXXXXX)"
      printf '%s\n' \
        "R135_FAILURE_EVIDENCE=$failed" \
        "R135_SOURCE_RELEASE=$SOURCE_RELEASE" \
        "R135_TARGET_RELEASE=$STAY_R135_TARGET_RELEASE" \
        "R135_RELEASE_TAG=$STAY_R135_RELEASE_TAG" \
        "R135_RELEASE_COMMIT=$STAY_R135_RELEASE_COMMIT" \
        "R135_RELEASE_TREE=$STAY_R135_RELEASE_TREE" \
        "R135_ARCHIVE_SHA256=$STAY_R135_ARCHIVE_SHA256" \
        "R135_MANIFEST_SHA256=$STAY_R135_MANIFEST_SHA256" \
        "R135_CONTROLLER_SHA256=$STAY_R135_CONTROLLER_SHA256" > "$marker_tmp"
      install_atomic "$marker_tmp" "$R135_MARKER" 0400
      rm -f -- "$marker_tmp"
      printf 'R135_METAB_SHADOW_FORWARD_RECOVERY_REQUIRED=YES\n' >&2
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 3301
[[ "$STAY_R135_RECOVERY_AUTHORIZATION" == "$AUTHORIZATION" ]] || abort authorization-required 3302
[[ "$(ip -4 -o addr show scope global | awk '{split($4,a,"/");print a[1]}' | sort -u)" == "$EXPECTED_PRIVATE_IPV4" ]] || abort host-identity-mismatch 3303
[[ "$STAY_R135_TARGET_RELEASE" =~ ^/opt/stay/releases/0\.8\.11\.3-p1m-r135-metab-shadow-recovery-[0-9a-f]{12}$ &&
  "$STAY_R135_RELEASE_TAG" =~ ^r135-metab-shadow-recovery-v[0-9]+$ &&
  "$STAY_R135_RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ && "$STAY_R135_RELEASE_TREE" =~ ^[0-9a-f]{40}$ &&
  "$STAY_R135_ARCHIVE_SHA256" =~ ^sha256:[0-9a-f]{64}$ &&
  "$STAY_R135_MANIFEST_SHA256" =~ ^sha256:[0-9a-f]{64}$ &&
  "$STAY_R135_CONTROLLER_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]] || abort immutable-identity-invalid 3304
for directory in "$SOURCE_RELEASE" "$STAY_R135_TARGET_RELEASE" "$EVIDENCE_ROOT" "$FREEZE_DIR"; do
  [[ -d "$directory" && ! -L "$directory" ]] || abort release-or-evidence-root-invalid 3305
done
for file in "$DATABASE" "$PARENT_FREEZE" "$SOURCE_MARKER" \
  "$SOURCE_RELEASE/$SOURCE_MANIFEST" "$STAY_R135_TARGET_RELEASE/$PROOF" \
  "$STAY_R135_TARGET_RELEASE/$CLIENT" "$STAY_R135_TARGET_RELEASE/P1_R135_RELEASE.env"; do
  [[ -f "$file" && ! -L "$file" ]] || abort release-input-invalid 3306
done
[[ "$(readlink -f /opt/stay/current)" == "$SOURCE_RELEASE" &&
  "$(sha256_file "$SOURCE_RELEASE/$SOURCE_MANIFEST")" == "$SOURCE_MANIFEST_SHA256" &&
  "$(durable_runtime_revision)" == 133 && ! -e "$TARGET_FREEZE" && ! -L "$TARGET_FREEZE" &&
  ! -e "$R135_MARKER" && ! -L "$R135_MARKER" ]] ||
  abort r133-source-boundary-invalid 3307
for revision in 128 129 130 131 132 133 134; do
  [[ ! -e "$FREEZE_DIR/R${revision}.json" && ! -L "$FREEZE_DIR/R${revision}.json" ]] ||
    abort unexpected-intermediate-freeze 3308
done
[[ "$(stat -Lc '%U:%G:%a' "$SOURCE_MARKER")" == 'root:root:400' &&
  "$(wc -l < "$SOURCE_MARKER")" -eq 9 ]] || abort r133-marker-trust-invalid 3309
for exact in \
  'R133_TARGET_RELEASE=/opt/stay/releases/0.8.11.3-p1m-r133-metab-shadow-recovery-087a96cd77b6' \
  'R133_RELEASE_COMMIT=fd31ee496022e8e27c2c1dcbc7f424b314dce44f' \
  'R133_MANIFEST_SHA256=sha256:087a96cd77b65b15ce68bebbfc7cfdc02b6beed013d0e507f396a6eba8daa949' \
  'R133_CONTROLLER_SHA256=sha256:f6e90413bcfbbb6c09c9bf7716c62915f05ce8b455542fd48bbfbed677ab65a0'; do
  grep -Fx "$exact" "$SOURCE_MARKER" >/dev/null || abort r133-marker-cohort-invalid 3310
done
r133_failure="$(sed -n 's/^R133_FAILURE_EVIDENCE=//p' "$SOURCE_MARKER")"
[[ "$(grep -c '^R133_FAILURE_EVIDENCE=' "$SOURCE_MARKER")" -eq 1 &&
  "$r133_failure" =~ ^/var/lib/stay/evidence/production-hardening/FAILED-R133-METAB-SHADOW-[A-Za-z0-9TZ.-]+$ &&
  -d "$r133_failure" && ! -L "$r133_failure" && "$(stat -Lc '%U:%G' "$r133_failure")" == root:root &&
  -z "$(find -P "$r133_failure" -xdev \( -type l -o ! -type d ! -type f -o ! -user root -o ! -group root -o -perm /022 \) -print -quit)" ]] ||
  abort r133-failure-evidence-invalid 3311
[[ ! -e "$DROPIN" && ! -L "$DROPIN" && -S "$SOCKET" && ! -L "$SOCKET" &&
  "$(systemctl show stay.service -p ActiveState --value)" == active &&
  "$(systemctl show stay.service -p SubState --value)" == running &&
  "$(systemctl show stay.service -p User --value)" == staydeploy &&
  "$(systemctl show stay.service -p Group --value)" == staydeploy ]] || abort live-service-preflight-invalid 3312

WORK="$(mktemp -d "$EVIDENCE_ROOT/.R135-METAB-SHADOW-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
install -o root -g root -m 0400 "$PARENT_FREEZE" "$WORK/R127.freeze.json"
install -o root -g root -m 0400 "$SOURCE_MARKER" "$WORK/R133.failure-marker.env"
before_pid="$(systemctl show stay.service -p MainPID --value)"
before_restarts="$(systemctl show stay.service -p NRestarts --value)"
[[ "$before_pid" =~ ^[1-9][0-9]*$ && "$before_restarts" =~ ^[0-9]+$ ]] || abort service-identity-invalid 3313
capture_quiescent "$WORK/database.before.json" || abort database-before-not-quiescent 3314
/usr/local/bin/node "$SOURCE_RELEASE/$CLIENT" status resident:sntss > "$WORK/sntss.before.json"
/usr/local/bin/node "$SOURCE_RELEASE/$CLIENT" status resident:chronobiology > "$WORK/chronobiology.before.json"
/usr/local/bin/node "$SOURCE_RELEASE/$CLIENT" status resident:metab > "$WORK/metab.before.json"
curl --fail --silent --max-time 3 http://127.0.0.1:8788/ > "$WORK/fetus.before.html"
/usr/local/bin/node - "$WORK" "$SOURCE_RELEASE" > "$WORK/before.proof.json" <<'NODE'
'use strict';const fs=require('node:fs'),path=require('node:path');const[root,current]=process.argv.slice(2),read=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const db=read('database.before.json'),s=read('sntss.before.json').resident,c=read('chronobiology.before.json').resident,m=read('metab.before.json').resident;
const row=id=>db.residents.find(v=>v.residency_id===id),fetusAuthority=db.authorities?.find(v=>v.core_id==='fetus-legacy');
const contained=v=>v?.status==='RUNNING'&&v.running===true&&v.authorityOwned===false&&v.host?.quarantined===false&&v.host?.osContainment?.required===true&&v.host?.osContainment?.available===true&&v.host?.osContainment?.payloadSandboxed===true&&v.host?.osContainment?.payloadAttachedBeforeInit===true&&v.host?.osContainment?.supervisorChargedToKernel===true&&v.host?.resourceGovernor?.policy?.softRamBytes===67108864&&v.host?.resourceGovernor?.policy?.hardRamBytes===100663296&&v.host?.resourceGovernor?.policy?.hardCpuDuty===0.2&&v.host?.resourceGovernor?.policy?.handlerTimeoutMs===250&&v.host?.resourceGovernor?.policy?.pidsMax===16&&v.host?.osContainment?.limits?.['memory.high']==='67108864'&&v.host?.osContainment?.limits?.['memory.max']==='100663296'&&v.host?.osContainment?.limits?.['pids.max']==='16'&&v.host?.osContainment?.limits?.['cpu.max']==='20000 100000';
if(!(current==='/opt/stay/releases/0.8.11.3-p1m-r133-metab-shadow-recovery-087a96cd77b6'&&db.quickCheck==='ok'&&db.runtimeRevision===133&&
db.pendingDeliveries===0&&db.pendingOutboxIntents===0&&db.failedDeliveries===0&&db.p1Authority===0&&db.sntssAuthority===0&&db.chronobiologyAuthority===0&&db.metabOutboxIntents===0&&
row('resident:metab')?.instance_id==='d424c722-ef31-44b0-8201-ba68c418d14a'&&row('resident:metab')?.version==='0.1.0-p1r0-neutral.1'&&row('resident:metab')?.state_schema===1&&row('resident:metab')?.checkpoint_hash==='4a16fc393b9846d1dd6f2f9849920053e3d2b5235c066dde3c5cd72699595107'&&
row('resident:sntss')?.instance_id==='8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f'&&row('resident:sntss')?.version==='0.5.0-i4g1'&&
row('resident:chronobiology')?.instance_id==='f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a'&&row('resident:chronobiology')?.version==='1.0.0-c3rc.5'&&
contained(s)&&s?.observedOutputs===0&&contained(c)&&c?.health?.mode==='NEUTRAL'&&contained(m)&&m?.health?.mode==='NEUTRAL'&&m?.observedOutputs===0&&
db.authorities?.length===1&&fetusAuthority?.instance_id==='82202211-8dd6-44d4-a4ec-8f2553d8dc6f'&&fetusAuthority?.version==='0.6.0'))process.exit(1);
process.stdout.write(JSON.stringify({result:'PASS',runtimeRevision:133,sntssCheckpointGeneration:Number(row('resident:sntss').checkpoint_generation),chronobiologyCheckpointGeneration:Number(row('resident:chronobiology').checkpoint_generation),fetusInstanceId:fetusAuthority.instance_id,metabInstanceId:row('resident:metab').instance_id,metabCheckpointHash:row('resident:metab').checkpoint_hash,abandonedDeliveries:db.abandonedDeliveries,founder:db.metabCheckpointState.founder,metabChipHistory:db.metabChipHistory})+'\n');
NODE

install -d -o root -g root -m 0755 "$DROPIN_DIR"
dropin_tmp="$(mktemp /run/stay-r135-metab-shadow-recovery-once.XXXXXX)"
printf '%s\n' '[Service]' \
  'Environment=STAY_ALLOW_METAB_SHADOW_PROMOTION=1' \
  'Environment=STAY_METAB_SHADOW_PROMOTION_AUTHORIZATION=' \
  "Environment=STAY_METAB_SHADOW_RECOVERY_AUTHORIZATION=$PROMOTION_AUTHORIZATION" > "$dropin_tmp"
install_atomic "$dropin_tmp" "$DROPIN" 0644; rm -f -- "$dropin_tmp"; DROPIN_INSTALLED=1
point_current "$STAY_R135_TARGET_RELEASE"; POINTER_SWITCHED=1
systemctl daemon-reload

RESTART_COMMITTED=1
systemctl restart stay.service
ready=0
for attempt in $(seq 1 20); do
  after_pid="$(systemctl show stay.service -p MainPID --value)"
  after_restarts="$(systemctl show stay.service -p NRestarts --value)"
  if [[ "$after_pid" =~ ^[1-9][0-9]*$ && "$after_pid" != "$before_pid" && "$after_restarts" == "$before_restarts" &&
    "$(systemctl show stay.service -p ActiveState --value)" == active && "$(systemctl show stay.service -p SubState --value)" == running &&
    "$(durable_runtime_revision)" == 135 && "$(readlink -f /opt/stay/current)" == "$STAY_R135_TARGET_RELEASE" && -S "$SOCKET" && ! -L "$SOCKET" ]] &&
    curl --fail --silent --max-time 1 http://127.0.0.1:8787/healthz | grep -q '"revision":135'; then
    ready=1; printf '%s\n' "$attempt" > "$WORK/readiness.attempts"; break
  fi
  sleep 0.25
done
[[ "$ready" -eq 1 ]] || abort r135-restart-readiness-failed 3315

capture_quiescent "$WORK/database.after.json" || abort database-after-not-quiescent 3316
/usr/local/bin/node "$STAY_R135_TARGET_RELEASE/$CLIENT" status resident:sntss > "$WORK/sntss.after.json"
/usr/local/bin/node "$STAY_R135_TARGET_RELEASE/$CLIENT" status resident:chronobiology > "$WORK/chronobiology.after.json"
/usr/local/bin/node "$STAY_R135_TARGET_RELEASE/$CLIENT" status resident:metab > "$WORK/metab.after.json"
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.after.json"
/usr/local/bin/node - "$WORK" "$STAY_R135_TARGET_RELEASE" "$before_pid" "$after_pid" "$before_restarts" "$after_restarts" > "$WORK/after.proof.json" <<'NODE'
'use strict';const fs=require('node:fs'),path=require('node:path');const[root,current,beforePid,afterPid,beforeRestarts,afterRestarts]=process.argv.slice(2),read=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const before=read('before.proof.json'),db=read('database.after.json'),s=read('sntss.after.json').resident,c=read('chronobiology.after.json').resident,m=read('metab.after.json').resident,meta=read('meta.after.json');
const row=id=>db.residents.find(v=>v.residency_id===id),chip=id=>meta.chipProjection?.lifecycle?.find(v=>v.coreId===id),metab=row('resident:metab'),state=db.metabCheckpointState,source=db.capacitySource,fetus=meta.cores?.find(v=>v.id==='fetus-legacy');
const contained=v=>v?.status==='RUNNING'&&v.running===true&&v.authorityOwned===false&&v.host?.quarantined===false&&v.host?.osContainment?.required===true&&v.host?.osContainment?.available===true&&v.host?.osContainment?.payloadSandboxed===true&&v.host?.osContainment?.payloadAttachedBeforeInit===true&&v.host?.osContainment?.supervisorChargedToKernel===true&&v.host?.resourceGovernor?.policy?.softRamBytes===67108864&&v.host?.resourceGovernor?.policy?.hardRamBytes===100663296&&v.host?.resourceGovernor?.policy?.hardCpuDuty===0.2&&v.host?.resourceGovernor?.policy?.handlerTimeoutMs===250&&v.host?.resourceGovernor?.policy?.pidsMax===16&&v.host?.osContainment?.limits?.['memory.high']==='67108864'&&v.host?.osContainment?.limits?.['memory.max']==='100663296'&&v.host?.osContainment?.limits?.['pids.max']==='16'&&v.host?.osContainment?.limits?.['cpu.max']==='20000 100000';
if(!(before.result==='PASS'&&current===process.env.STAY_R135_TARGET_RELEASE&&Number(beforePid)>0&&Number(afterPid)>0&&beforePid!==afterPid&&beforeRestarts===afterRestarts&&
db.quickCheck==='ok'&&db.runtimeRevision===135&&db.pendingDeliveries===0&&db.pendingOutboxIntents===0&&db.failedDeliveries===0&&db.abandonedDeliveries===before.abandonedDeliveries&&db.p1Authority===0&&db.sntssAuthority===0&&db.chronobiologyAuthority===0&&db.metabOutboxIntents===0&&
metab?.instance_id===before.metabInstanceId&&metab?.version==='0.2.0-p1r0-shadow.1'&&metab?.state_schema===2&&metab?.module_relative_path==='cores/p1-r0/metab-shadow/index.js'&&metab?.status==='RUNNING'&&
state?.activation?.instanceId===before.metabInstanceId&&state?.activation?.runtimeRevision===135&&state?.activation?.sourceCheckpointHash===`sha256:${before.metabCheckpointHash}`&&state?.lastAcceptedFrame>=1&&state?.engineState?.outputSequence==='0'&&
source?.runtimeRevision===135&&source?.instanceId===before.metabInstanceId&&source?.residentVersion==='0.2.0-p1r0-shadow.1'&&source?.pending===null&&source?.lastCommittedFrame===state.lastAcceptedFrame&&
Number(row('resident:sntss')?.checkpoint_generation)>=before.sntssCheckpointGeneration&&Number(row('resident:chronobiology')?.checkpoint_generation)>=before.chronobiologyCheckpointGeneration&&
contained(s)&&s?.version==='0.5.0-i4g1'&&s?.observedOutputs===0&&contained(c)&&c?.version==='1.0.0-c3rc.5'&&c?.health?.mode==='NEUTRAL'&&contained(m)&&
m?.instanceId===before.metabInstanceId&&m?.version==='0.2.0-p1r0-shadow.1'&&m?.health?.mode==='SHADOW'&&m?.health?.outputPolicy==='FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT'&&m?.declaredOutputs===0&&m?.observedOutputs===0&&
fetus?.version==='0.6.0'&&fetus?.mode==='active'&&fetus?.ok===true&&fetus?.memoryGuardian?.status==='healthy'&&fetus?.memoryGuardian?.warnAtMiB===192&&fetus?.memoryGuardian?.recycleAtMiB===256&&meta.ok===true&&meta.revision===135&&meta.revisionFrozen===false&&chip('bsf')?.state==='LIVE'&&chip('sntss')?.state==='SHADOW'&&chip('chronobiology')?.state==='SHADOW'&&chip('metab')?.state==='SHADOW'&&!meta.chipProjection?.roadmap?.some(v=>v.coreId==='metab'))){process.exit(1);}
process.stdout.write(JSON.stringify({result:'PASS',runtimeRevision:135,instanceId:metab.instance_id,version:metab.version,checkpointGeneration:Number(metab.checkpoint_generation),acceptedFrame:state.lastAcceptedFrame,authorityOwned:false,observedOutputs:0,chipState:'SHADOW',sourceBoundaryRevision:133,parentFreezeRecordSha256:before.parentFreezeRecordSha256||null})+'\n');
NODE

remove_dropin || abort promotion-authority-revocation-failed 3317
install -o root -g root -m 0444 "$STAY_R135_TARGET_RELEASE/P1_R135_RELEASE.env" "$WORK/P1_R135_RELEASE.env"
STAY_R135_AFTER_PID="$after_pid" STAY_R135_AFTER_RESTARTS="$after_restarts" \
  /usr/local/bin/node - "$STAY_R135_TARGET_RELEASE/runtime/revision-freeze.js" "$WORK" > "$WORK/R135.freeze.json" <<'NODE'
'use strict';const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');const[helper,root]=process.argv.slice(2),{sealRevisionFreeze,validateRevisionFreeze}=require(helper),read=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8')),hash=n=>`sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root,n))).digest('hex')}`;
const before=read('before.proof.json'),after=read('after.proof.json'),parent=read('R127.freeze.json');
const release=Object.fromEntries(fs.readFileSync(path.join(root,'P1_R135_RELEASE.env'),'utf8').trim().split('\n').map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
if(!(before.result==='PASS'&&after.result==='PASS'&&after.runtimeRevision===135&&after.instanceId===before.metabInstanceId))process.exit(2);
const names=['R127.freeze.json','R133.failure-marker.env','before.proof.json','after.proof.json','database.before.json','database.after.json','sntss.before.json','sntss.after.json','chronobiology.before.json','chronobiology.after.json','metab.before.json','metab.after.json','fetus.before.html','meta.after.json','P1_R135_RELEASE.env'];
const record=sealRevisionFreeze({format:'stay-runtime-revision-freeze-v1',result:'PASS',acceptance:'ACCEPTED',freezeType:'R135_METAB_OUTPUT_FIREWALLED_SHADOW_FORWARD_RECOVERY',runtime:{revision:135,revisionLabel:'R135F',progression:[123,124,125,126,127,128,129,130,131,132,133,134,135],serviceMainPid:Number(process.env.STAY_R135_AFTER_PID),serviceNRestarts:Number(process.env.STAY_R135_AFTER_RESTARTS),restartCommands:1},parentFreeze:{revision:127,recordSha256:parent.recordSha256},recoveryBoundary:{revision:133,r133FailureMarkerSha256:hash('R133.failure-marker.env'),pointerRewound:false},release:{path:release.RELEASE_PATH,tag:release.RELEASE_TAG,commit:release.RELEASE_COMMIT,tree:release.RELEASE_TREE,archiveSha256:release.ARCHIVE_SHA256,manifestSha256:release.MANIFEST_SHA256,controllerSha256:release.CONTROLLER_SHA256},metab:{residencyId:'resident:metab',instanceId:after.instanceId,version:after.version,mode:'SHADOW',checkpointGeneration:after.checkpointGeneration,acceptedFrame:after.acceptedFrame,authorityOwned:false,observedOutputs:0,outputPolicy:'FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT'},continuity:{sntssCheckpointGenerationBefore:before.sntssCheckpointGeneration,chronobiologyCheckpointGenerationBefore:before.chronobiologyCheckpointGeneration,pendingDeliveries:0,pendingOutboxIntents:0,abandonedDeliveries:before.abandonedDeliveries,inventedBiologicalTime:false,fetusContinuity:true},recovery:{revisionFenced:true,pointerRewound:false},promotionAuthority:{startupOnly:true,revokedFromUnit:true},evidence:Object.fromEntries(names.map(n=>[n,hash(n)])),capturedAt:new Date().toISOString()});
if(!validateRevisionFreeze(record,135))process.exit(3);process.stdout.write(JSON.stringify(record)+'\n');
NODE
install_atomic "$WORK/R135.freeze.json" "$TARGET_FREEZE" 0444
rm -f -- "$SOURCE_MARKER"
rm -f -- "$R135_MARKER"
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.frozen.json"
/usr/local/bin/node - "$WORK/meta.frozen.json" <<'NODE'
'use strict';const m=JSON.parse(require('node:fs').readFileSync(process.argv[2],'utf8')),chip=id=>m.chipProjection?.lifecycle?.find(v=>v.coreId===id);
if(!(m.ok===true&&m.revision===135&&m.revisionFrozen===true&&m.revisionLabel==='R135F'&&chip('bsf')?.state==='LIVE'&&chip('sntss')?.state==='SHADOW'&&chip('chronobiology')?.state==='SHADOW'&&chip('metab')?.state==='SHADOW'))process.exit(1);
NODE
[[ "$(durable_runtime_revision)" == 135 && "$(readlink -f /opt/stay/current)" == "$STAY_R135_TARGET_RELEASE" &&
  "$(systemctl show stay.service -p MainPID --value)" == "$after_pid" &&
  "$(systemctl show stay.service -p NRestarts --value)" == "$after_restarts" ]] || abort final-r135-fence-failed 3318

final_evidence="$EVIDENCE_ROOT/R135F-METAB-SHADOW-$(date -u +'%Y%m%dT%H%M%SZ')"
[[ ! -e "$final_evidence" && ! -L "$final_evidence" ]]
mv -T "$WORK" "$final_evidence"; WORK=''; chmod -R a-w "$final_evidence"; COMPLETED=1
printf '%s\n' 'R135_METAB_SHADOW_RECOVERY=PASS' 'RUNTIME_REVISION=135' 'REVISION_LABEL=R135F' \
  "CURRENT_RELEASE=$STAY_R135_TARGET_RELEASE" "SERVICE_PID=$after_pid" 'BSF_MODE=LIVE' \
  'SNTSS_MODE=SHADOW' 'SNTSS_OUTPUTS=0' 'CHRONOBIOLOGY_MODE=SHADOW' \
  'METAB_MODE=SHADOW' 'METAB_OUTPUTS=0' 'METAB_AUTHORITY=NONE' 'FETUS_CONTINUITY=PASS' \
  'PROMOTION_AUTHORITY_ACTIVE=NO' "FREEZE_FILE=$TARGET_FREEZE" "EVIDENCE_ROOT=$final_evidence"
