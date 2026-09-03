#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH LC_ALL=C

AUTHORIZATION='AUTHORIZE_R129_NEUTRAL_ENTRY_FORWARD_RECOVERY_ONLY'
TARGET='/opt/stay/releases/0.8.11.3-p1m-r128-metab-shadow-70b7e3055a78'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
PROOF='deploy/live-physiology-transplant/p1-r128-metab-shadow-live-proof.js'
CLIENT='deploy/live-physiology-transplant/p1-resident-control-client.js'
MARKER='/run/stay-r128-metab-shadow-recovery.env'
PROMOTION_DROPIN='/etc/systemd/system/stay.service.d/r128-metab-shadow-once.conf'
EXPECTED_MANIFEST_SHA256='70b7e3055a789adc91cfe46f6e25ff1fc7662d88d2c642da580e4d46e554a34d'
EXPECTED_CONTROLLER_SHA256='df7172ea545bb882450f81326765ea165dc90c6a3a15349bb88035b1a52925c6'
RESTART_COMMITTED=0
COMPLETED=0
WORK=''

abort() { printf 'R129_NEUTRAL_ENTRY_RECOVERY_ABORT=%s\n' "$1" >&2; exit "$2"; }
revision() {
  STAY_DATABASE="$DATABASE" /usr/local/bin/node <<'NODE'
'use strict';const crypto=require('node:crypto');const{DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.STAY_DATABASE,{open:true,readOnly:true});
try{db.exec('PRAGMA query_only=ON');const row=db.prepare("SELECT json,sha256 FROM metadata WHERE key='life:runtime-revision'").get();
if(!row||crypto.createHash('sha256').update(row.json).digest('hex')!==row.sha256)process.exit(2);
const value=Number(JSON.parse(row.json).revision);if(!Number.isSafeInteger(value))process.exit(3);process.stdout.write(String(value));}finally{db.close();}
NODE
}
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ -n "$WORK" && -d "$WORK" ]]; then rm -rf --one-file-system -- "$WORK"; fi
  if [[ "$status" -ne 0 && "$RESTART_COMMITTED" -eq 1 && "$COMPLETED" -eq 0 ]]; then
    printf 'R129_NEUTRAL_ENTRY_FORWARD_RECOVERY_REQUIRED=YES\n' >&2
  fi
  exit "$status"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 2901
[[ "${STAY_R129_NEUTRAL_ENTRY_RECOVERY_AUTHORIZATION:-}" == "$AUTHORIZATION" ]] || abort authorization-required 2902
[[ "$(ip -4 -o addr show scope global | awk '{split($4,a,"/");print a[1]}' | sort -u)" == '172.26.9.207' ]] || abort host-identity-mismatch 2903
[[ "$(readlink -f /opt/stay/current)" == "$TARGET" && -d "$TARGET" && ! -L "$TARGET" ]] || abort target-boundary-invalid 2904
[[ "$(find "$TARGET" -type f | wc -l)" -eq 659 &&
  -z "$(find -P "$TARGET" -xdev \( -type l -o -type f -links +1 -o ! -type d ! -type f -o ! -user root -o ! -group root -o -perm /022 \) -print -quit)" ]] || abort target-tree-invalid 2905
[[ "$(sha256sum "$TARGET/deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R127F_TO_R128.sha256" | awk '{print $1}')" == "$EXPECTED_MANIFEST_SHA256" ]] || abort target-manifest-invalid 2905
(cd "$TARGET" && sha256sum -c deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R127F_TO_R128.sha256 >/dev/null) || abort target-files-invalid 2905
[[ -f "$TARGET/P1_R128_RELEASE.env" && ! -L "$TARGET/P1_R128_RELEASE.env" ]] || abort target-identity-invalid 2906
grep -Fx "CONTROLLER_SHA256=sha256:$EXPECTED_CONTROLLER_SHA256" "$TARGET/P1_R128_RELEASE.env" >/dev/null || abort target-controller-invalid 2907
[[ -f "$MARKER" && ! -L "$MARKER" && "$(stat -Lc '%U:%G:%a' "$MARKER")" == 'root:root:400' ]] || abort recovery-marker-invalid 2908
[[ "$(wc -l < "$MARKER")" -eq 9 ]] || abort recovery-marker-shape-invalid 2908
for exact in \
  'R128_TARGET_RELEASE=/opt/stay/releases/0.8.11.3-p1m-r128-metab-shadow-70b7e3055a78' \
  'R128_RELEASE_COMMIT=92d60d0a650b5d43b39957563e0eb0e1de9c22a9' \
  'R128_MANIFEST_SHA256=sha256:70b7e3055a789adc91cfe46f6e25ff1fc7662d88d2c642da580e4d46e554a34d' \
  'R128_CONTROLLER_SHA256=sha256:df7172ea545bb882450f81326765ea165dc90c6a3a15349bb88035b1a52925c6'; do
  grep -Fx "$exact" "$MARKER" >/dev/null || abort recovery-marker-cohort-invalid 2909
done
[[ ! -e "$PROMOTION_DROPIN" && ! -L "$PROMOTION_DROPIN" && "$(revision)" == 129 ]] || abort durable-r129-boundary-invalid 2910
[[ "$(systemctl show stay.service -p ActiveState --value)" == active && "$(systemctl show stay.service -p SubState --value)" == running ]] || abort service-boundary-invalid 2911
if curl --fail --silent --max-time 1 http://127.0.0.1:8787/healthz >/dev/null; then abort entry-already-healthy 2912; fi

WORK="$(mktemp -d /run/stay-r129-neutral-entry-recovery.XXXXXX)"
/usr/local/bin/node "$TARGET/$PROOF" capture "$DATABASE" > "$WORK/before.json"
/usr/local/bin/node - "$WORK/before.json" <<'NODE'
'use strict';const v=JSON.parse(require('node:fs').readFileSync(process.argv[2],'utf8'));
const resident=id=>v.residents.find(row=>row.residency_id===id);
const metab=resident('resident:metab'),sntss=resident('resident:sntss'),chrono=resident('resident:chronobiology');
if(!(v.quickCheck==='ok'&&v.queryOnly===true&&v.runtimeRevision===129&&v.pendingDeliveries===0&&v.pendingOutboxIntents===0&&
v.failedDeliveries===0&&v.abandonedDeliveries===0&&v.p1Authority===0&&v.sntssAuthority===0&&v.chronobiologyAuthority===0&&v.metabOutboxIntents===0&&
metab?.instance_id==='d424c722-ef31-44b0-8201-ba68c418d14a'&&metab?.version==='0.1.0-p1r0-neutral.1'&&metab?.status==='RUNNING'&&
sntss?.instance_id==='8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f'&&sntss?.version==='0.5.0-i4g1'&&sntss?.status==='RUNNING'&&
chrono?.instance_id==='f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a'&&chrono?.version==='1.0.0-c3rc.5'&&chrono?.status==='RUNNING'))process.exit(1);
NODE
before_pid="$(systemctl show stay.service -p MainPID --value)"
before_restarts="$(systemctl show stay.service -p NRestarts --value)"
[[ "$before_pid" =~ ^[1-9][0-9]*$ && "$before_restarts" =~ ^[0-9]+$ ]] || abort service-identity-invalid 2913

RESTART_COMMITTED=1
systemctl restart stay.service
ready=0
for attempt in $(seq 1 20); do
  after_pid="$(systemctl show stay.service -p MainPID --value)"
  after_restarts="$(systemctl show stay.service -p NRestarts --value)"
  if [[ "$after_pid" =~ ^[1-9][0-9]*$ && "$after_pid" != "$before_pid" && "$after_restarts" == "$before_restarts" &&
    "$(systemctl show stay.service -p ActiveState --value)" == active && "$(systemctl show stay.service -p SubState --value)" == running &&
    "$(revision)" == 131 && "$(readlink -f /opt/stay/current)" == "$TARGET" && -S /run/stay/resident-control.sock && ! -L /run/stay/resident-control.sock ]] &&
    curl --fail --silent --max-time 1 http://127.0.0.1:8787/healthz | grep -q '"revision":131'; then
    ready=1; printf '%s\n' "$attempt" > "$WORK/readiness.attempts"; break
  fi
  sleep 0.25
done
[[ "$ready" -eq 1 ]] || abort r131-entry-readiness-failed 2914

/usr/local/bin/node "$TARGET/$PROOF" capture "$DATABASE" > "$WORK/after.json"
/usr/local/bin/node "$TARGET/$CLIENT" status resident:sntss > "$WORK/sntss.json"
/usr/local/bin/node "$TARGET/$CLIENT" status resident:chronobiology > "$WORK/chronobiology.json"
/usr/local/bin/node "$TARGET/$CLIENT" status resident:metab > "$WORK/metab.json"
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.json"
/usr/local/bin/node - "$WORK" <<'NODE'
'use strict';const fs=require('node:fs'),path=require('node:path');const root=process.argv[2],read=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const v=read('after.json'),s=read('sntss.json').resident,c=read('chronobiology.json').resident,m=read('metab.json').resident,meta=read('meta.json');
const fetus=meta.cores?.find(row=>row.id==='fetus-legacy'),chip=meta.chipProjection?.lifecycle?.find(row=>row.coreId==='metab');
if(!(v.quickCheck==='ok'&&v.runtimeRevision===131&&v.pendingDeliveries===0&&v.pendingOutboxIntents===0&&v.failedDeliveries===0&&v.abandonedDeliveries===0&&
v.p1Authority===0&&v.sntssAuthority===0&&v.chronobiologyAuthority===0&&v.metabOutboxIntents===0&&s?.running===true&&s?.version==='0.5.0-i4g1'&&s?.observedOutputs===0&&s?.authorityOwned===false&&
c?.running===true&&c?.version==='1.0.0-c3rc.5'&&c?.authorityOwned===false&&m?.running===true&&m?.instanceId==='d424c722-ef31-44b0-8201-ba68c418d14a'&&
m?.version==='0.1.0-p1r0-neutral.1'&&m?.health?.mode==='NEUTRAL'&&m?.observedOutputs===0&&m?.authorityOwned===false&&fetus?.version==='0.6.0'&&fetus?.mode==='active'&&chip?.state==='NEUTRAL'))process.exit(1);
NODE
[[ -f "$MARKER" && ! -L "$MARKER" && ! -e "$PROMOTION_DROPIN" ]] || abort recovery-fence-not-preserved 2915
COMPLETED=1
printf 'R129_NEUTRAL_ENTRY_RECOVERY=PASS\nRUNTIME_REVISION=131\nCURRENT_RELEASE=%s\nBSF_MODE=LIVE\nSNTSS_MODE=SHADOW\nCHRONOBIOLOGY_MODE=SHADOW\nMETAB_MODE=NEUTRAL\nMETAB_OUTPUTS=0\nMETAB_AUTHORITY=NONE\nFETUS_CONTINUITY=PASS\n' "$TARGET"
