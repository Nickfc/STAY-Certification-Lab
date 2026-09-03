#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH LC_ALL=C

EXPECTED_PRIVATE_IPV4='172.26.9.207'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
FREEZE_DIR='/var/lib/stay/evidence/runtime-freezes'
EVIDENCE_ROOT='/var/lib/stay/evidence/production-hardening'
SOURCE_R141='/opt/stay/releases/0.8.11.3-p1m-r141-metab-shadow-recovery-6a1e6a9ffbfd'
SOURCE_R141_MANIFEST='deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R139_TO_R141.sha256'
SOURCE_R141_MANIFEST_SHA256='6a1e6a9ffbfd484c3d0623bd5ec20e922b34bfe79fd74562c11cda59a0fa5107'
DROPIN_DIR='/etc/systemd/system/stay.service.d'
ACTIVE_PUBLIC_KEY='/etc/stay/p1-r0-expansion-birth-authority.pub'
SOCKET='/run/stay/resident-control.sock'
MANIFEST='deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R141F_TO_R150.sha256'
PROOF='deploy/live-physiology-transplant/p1-r150-homeos-intero-live-proof.js'
VERIFY='deploy/live-physiology-transplant/p1-r150-verify-birth-certificate.js'
FREEZER='deploy/live-physiology-transplant/p1-r150-homeos-intero-freeze.js'
CLIENT='deploy/live-physiology-transplant/p1-resident-control-client.js'

: "${STAY_R150_STAGE:?}"
: "${STAY_R150_FORWARD_AUTHORIZATION:?}"
: "${STAY_R150_TARGET_RELEASE:?}"
: "${STAY_R150_RELEASE_TAG:?}"
: "${STAY_R150_RELEASE_COMMIT:?}"
: "${STAY_R150_RELEASE_TREE:?}"
: "${STAY_R150_ARCHIVE_SHA256:?}"
: "${STAY_R150_MANIFEST_SHA256:?}"
: "${STAY_R150_CONTROLLER_SHA256:?}"
: "${STAY_R150_CERTIFICATE_FILE:?}"
: "${STAY_R150_CERTIFICATE_SHA256:?}"
: "${STAY_R150_DOSSIER_SHA256:?}"
: "${STAY_R150_EXPANSION_PUBLIC_KEY_SHA256:?}"

WORK=''
COMPLETED=0
RESTART_COMMITTED=0
POINTER_SWITCHED=0
DROPIN_INSTALLED=0
CERTIFICATE_INSTALLED=0

abort() { printf 'R150_%s_FORWARD_ABORT=%s\n' "${STAY_R150_STAGE^^}" "$1" >&2; exit "${2:-1}"; }
sha256_file() { sha256sum "$1" | awk '{print $1}'; }

durable_runtime_revision() {
  STAY_DATABASE="$DATABASE" /usr/local/bin/node <<'NODE'
'use strict';
const crypto=require('node:crypto'); const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.STAY_DATABASE,{open:true,readOnly:true});
try { db.exec('PRAGMA query_only=ON');
  const row=db.prepare("SELECT json,sha256 FROM metadata WHERE key='life:runtime-revision'").get();
  if(!row||crypto.createHash('sha256').update(row.json).digest('hex')!==row.sha256)process.exit(2);
  const revision=Number(JSON.parse(row.json).revision);if(!Number.isSafeInteger(revision))process.exit(3);
  process.stdout.write(String(revision));
} finally { db.close(); }
NODE
}

point_current() {
  local target="$1" temporary="/opt/stay/.current-r150-$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]]
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" /opt/stay/current
}

install_atomic() {
  local source="$1" target="$2" mode="$3" temporary
  temporary="$(mktemp "$(dirname "$target")/.r150-expansion.XXXXXX")"
  install -o root -g root -m "$mode" "$source" "$temporary"
  mv -fT "$temporary" "$target"
}

remove_authorization() {
  local changed=0
  if [[ -e "$DROPIN" || -L "$DROPIN" ]]; then
    [[ -f "$DROPIN" && ! -L "$DROPIN" ]] || return 1
    rm -f -- "$DROPIN"; changed=1
  fi
  if [[ -e "$ACTIVE_CERTIFICATE" || -L "$ACTIVE_CERTIFICATE" ]]; then
    [[ -f "$ACTIVE_CERTIFICATE" && ! -L "$ACTIVE_CERTIFICATE" ]] || return 1
    rm -f -- "$ACTIVE_CERTIFICATE"
  fi
  DROPIN_INSTALLED=0; CERTIFICATE_INSTALLED=0
  if [[ "$changed" -eq 1 ]]; then systemctl daemon-reload; fi
}

capture_database() {
  local output="$1" temporary="$1.new" attempt
  for attempt in $(seq 1 20); do
    /usr/local/bin/node "$STAY_R150_TARGET_RELEASE/$PROOF" capture "$DATABASE" > "$temporary"
    if /usr/local/bin/node - "$temporary" <<'NODE'
'use strict';const v=JSON.parse(require('node:fs').readFileSync(process.argv[2],'utf8'));
if(!(v.quickCheck==='ok'&&v.queryOnly===true&&v.pendingDeliveries===0&&
v.pendingOutboxIntents===0&&v.failedDeliveries===0&&v.capacitySource?.pending===null))process.exit(1);
NODE
    then mv -fT "$temporary" "$output"; printf '%s\n' "$attempt" > "$output.attempts"; return 0; fi
    sleep 0.25
  done
  mv -fT "$temporary" "$output"; return 1
}

capture_statuses() {
  local suffix="$1" id
  for id in sntss chronobiology metab; do
    /usr/local/bin/node "$STAY_R150_TARGET_RELEASE/$CLIENT" status "resident:$id" > "$WORK/$id.$suffix.json"
  done
  if [[ "$STAY_R150_STAGE" == intero || "$suffix" == after ]]; then
    /usr/local/bin/node "$STAY_R150_TARGET_RELEASE/$CLIENT" status resident:homeos > "$WORK/homeos.$suffix.json"
  fi
  if [[ "$STAY_R150_STAGE" == intero && "$suffix" == after ]]; then
    /usr/local/bin/node "$STAY_R150_TARGET_RELEASE/$CLIENT" status resident:intero > "$WORK/intero.$suffix.json"
  fi
}

cleanup() {
  local status=$? failed='' marker_tmp
  trap - EXIT
  set +e
  if [[ "$COMPLETED" -eq 0 ]]; then
    if [[ "$DROPIN_INSTALLED" -eq 1 || "$CERTIFICATE_INSTALLED" -eq 1 ]]; then remove_authorization; fi
    if [[ "$RESTART_COMMITTED" -eq 0 && "$POINTER_SWITCHED" -eq 1 &&
      "$(readlink -f /opt/stay/current 2>/dev/null)" == "$STAY_R150_TARGET_RELEASE" ]]; then
      point_current "$SOURCE_RELEASE"
    fi
    if [[ -n "$WORK" && -d "$WORK" ]]; then
      failed="$(mktemp -d "$EVIDENCE_ROOT/FAILED-R${TARGET_REVISION}-${STAY_R150_STAGE^^}-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
      rmdir -- "$failed"; mv -T "$WORK" "$failed"; WORK=''; chmod -R a-w "$failed"
      printf 'R150_%s_FAILURE_EVIDENCE=%s\n' "${STAY_R150_STAGE^^}" "$failed" >&2
    fi
    if [[ "$RESTART_COMMITTED" -eq 1 ]]; then
      marker_tmp="$(mktemp "/run/.stay-r150-${STAY_R150_STAGE}-recovery.XXXXXX")"
      printf '%s\n' \
        "R150_STAGE=$STAY_R150_STAGE" "R150_FAILURE_EVIDENCE=$failed" \
        "R150_TARGET_RELEASE=$STAY_R150_TARGET_RELEASE" "R150_RELEASE_TAG=$STAY_R150_RELEASE_TAG" \
        "R150_RELEASE_COMMIT=$STAY_R150_RELEASE_COMMIT" "R150_RELEASE_TREE=$STAY_R150_RELEASE_TREE" \
        "R150_ARCHIVE_SHA256=$STAY_R150_ARCHIVE_SHA256" "R150_MANIFEST_SHA256=$STAY_R150_MANIFEST_SHA256" \
        "R150_CONTROLLER_SHA256=$STAY_R150_CONTROLLER_SHA256" \
        "R150_CERTIFICATE_SHA256=$STAY_R150_CERTIFICATE_SHA256" > "$marker_tmp"
      install_atomic "$marker_tmp" "$RECOVERY_MARKER" 0400; rm -f -- "$marker_tmp"
      printf 'R150_%s_FORWARD_RECOVERY_REQUIRED=YES\n' "${STAY_R150_STAGE^^}" >&2
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

case "$STAY_R150_STAGE" in
  homeos)
    CORE='HOMEOS'; SOURCE_RELEASE="$SOURCE_R141"; SOURCE_REVISION=141; TARGET_REVISION=145
    PARENT_FREEZE="$FREEZE_DIR/R141.json"; TARGET_FREEZE="$FREEZE_DIR/R145.json"
    DROPIN="$DROPIN_DIR/r145-homeos-shadow-once.conf"
    ACTIVE_CERTIFICATE='/etc/stay/resident-promotions/resident-homeos-neutral-birth.json'
    RECOVERY_MARKER='/run/stay-r145-homeos-shadow-recovery.env'
    AUTHORIZATION='AUTHORIZE_R145_HOMEOS_OUTPUT_FIREWALLED_SHADOW_FORWARD_ONLY'
    ;;
  intero)
    CORE='INTERO'; SOURCE_RELEASE="$STAY_R150_TARGET_RELEASE"; SOURCE_REVISION=145; TARGET_REVISION=150
    PARENT_FREEZE="$FREEZE_DIR/R145.json"; TARGET_FREEZE="$FREEZE_DIR/R150.json"
    DROPIN="$DROPIN_DIR/r150-intero-shadow-once.conf"
    ACTIVE_CERTIFICATE='/etc/stay/resident-promotions/resident-intero-neutral-birth.json'
    RECOVERY_MARKER='/run/stay-r150-intero-shadow-recovery.env'
    AUTHORIZATION='AUTHORIZE_R150_INTERO_PERCEPTION_ONLY_SHADOW_FORWARD_ONLY'
    ;;
  *) abort invalid-stage 3501 ;;
esac

[[ "$EUID" -eq 0 ]] || abort root-required 3502
[[ "$STAY_R150_FORWARD_AUTHORIZATION" == "$AUTHORIZATION" ]] || abort authorization-required 3503
[[ "$STAY_R150_TARGET_RELEASE" =~ ^/opt/stay/releases/0\.8\.11\.3-p1r0-r150-homeos-intero-[0-9a-f]{12}$ &&
  "$STAY_R150_RELEASE_TAG" =~ ^r150-homeos-intero-shadow-v[0-9]+$ &&
  "$STAY_R150_RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ && "$STAY_R150_RELEASE_TREE" =~ ^[0-9a-f]{40}$ &&
  "$STAY_R150_ARCHIVE_SHA256" =~ ^sha256:[0-9a-f]{64}$ &&
  "$STAY_R150_MANIFEST_SHA256" =~ ^sha256:[0-9a-f]{64}$ &&
  "$STAY_R150_CONTROLLER_SHA256" =~ ^sha256:[0-9a-f]{64}$ &&
  "$STAY_R150_CERTIFICATE_SHA256" =~ ^sha256:[0-9a-f]{64}$ &&
  "$STAY_R150_DOSSIER_SHA256" =~ ^sha256:[0-9a-f]{64}$ &&
  "$STAY_R150_EXPANSION_PUBLIC_KEY_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]] || abort immutable-identity-invalid 3504
[[ "$(ip -4 -o addr show scope global | awk '{split($4,a,"/");print a[1]}' | sort -u)" == "$EXPECTED_PRIVATE_IPV4" ]] || abort host-identity-mismatch 3505
for directory in "$SOURCE_RELEASE" "$STAY_R150_TARGET_RELEASE" "$EVIDENCE_ROOT" "$FREEZE_DIR"; do
  [[ -d "$directory" && ! -L "$directory" ]] || abort release-or-evidence-root-invalid 3506
done
for file in "$DATABASE" "$PARENT_FREEZE" "$STAY_R150_CERTIFICATE_FILE" "$ACTIVE_PUBLIC_KEY" \
  "$STAY_R150_TARGET_RELEASE/$MANIFEST" "$STAY_R150_TARGET_RELEASE/$PROOF" \
  "$STAY_R150_TARGET_RELEASE/$VERIFY" "$STAY_R150_TARGET_RELEASE/$FREEZER" \
  "$STAY_R150_TARGET_RELEASE/$CLIENT" "$STAY_R150_TARGET_RELEASE/P1_R150_RELEASE.env"; do
  [[ -f "$file" && ! -L "$file" ]] || abort release-input-invalid 3507
done
if [[ "$STAY_R150_STAGE" == homeos ]]; then
  [[ -f "$SOURCE_RELEASE/$SOURCE_R141_MANIFEST" && ! -L "$SOURCE_RELEASE/$SOURCE_R141_MANIFEST" &&
    "$(sha256_file "$SOURCE_RELEASE/$SOURCE_R141_MANIFEST")" == "$SOURCE_R141_MANIFEST_SHA256" ]] ||
    abort r141-source-release-hash-invalid 3508
fi
[[ "$(sha256_file "$STAY_R150_CERTIFICATE_FILE")" == "${STAY_R150_CERTIFICATE_SHA256#sha256:}" &&
  "$(sha256_file "$ACTIVE_PUBLIC_KEY")" == "${STAY_R150_EXPANSION_PUBLIC_KEY_SHA256#sha256:}" &&
  "$(sha256_file "$STAY_R150_TARGET_RELEASE/$MANIFEST")" == "${STAY_R150_MANIFEST_SHA256#sha256:}" ]] || abort immutable-input-hash-invalid 3508
(cd "$STAY_R150_TARGET_RELEASE" && sha256sum -c "$MANIFEST" >/dev/null) || abort target-manifest-invalid 3509
[[ ! -e "$TARGET_FREEZE" && ! -L "$TARGET_FREEZE" && ! -e "$RECOVERY_MARKER" && ! -L "$RECOVERY_MARKER" &&
  ! -e "$DROPIN" && ! -L "$DROPIN" && ! -e "$ACTIVE_CERTIFICATE" && ! -L "$ACTIVE_CERTIFICATE" &&
  "$(readlink -f /opt/stay/current)" == "$SOURCE_RELEASE" && "$(durable_runtime_revision)" == "$SOURCE_REVISION" &&
  "$(systemctl show stay.service -p ActiveState --value)" == active &&
  "$(systemctl show stay.service -p SubState --value)" == running &&
  "$(systemctl show stay.service -p User --value)" == staydeploy &&
  "$(systemctl show stay.service -p Group --value)" == staydeploy && -S "$SOCKET" && ! -L "$SOCKET" &&
  "$(systemctl is-active stay-physiology-benchmark-v3.service 2>/dev/null || true)" == inactive ]] || abort source-boundary-invalid 3510

WORK="$(mktemp -d "$EVIDENCE_ROOT/.R${TARGET_REVISION}-${STAY_R150_STAGE^^}-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
install -o root -g root -m 0400 "$PARENT_FREEZE" "$WORK/parent.freeze.json"
install -o root -g root -m 0400 "$STAY_R150_CERTIFICATE_FILE" "$WORK/$STAY_R150_STAGE.birth-certificate.json"
install -o root -g root -m 0444 "$ACTIVE_PUBLIC_KEY" "$WORK/expansion-birth-authority.pub"
install -o root -g root -m 0400 "$STAY_R150_TARGET_RELEASE/P1_R150_RELEASE.env" "$WORK/P1_R150_RELEASE.env"
before_pid="$(systemctl show stay.service -p MainPID --value)"
before_restarts="$(systemctl show stay.service -p NRestarts --value)"
[[ "$before_pid" =~ ^[1-9][0-9]*$ && "$before_restarts" =~ ^[0-9]+$ ]] || abort service-fence-invalid 3511
capture_database "$WORK/database.before.json" || abort database-before-not-quiescent 3512
capture_statuses before
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.before.json"

/usr/local/bin/node - "$STAY_R150_TARGET_RELEASE/$PROOF" "$WORK" "$STAY_R150_STAGE" "$SOURCE_RELEASE" "$before_pid" "$before_restarts" > "$WORK/before.proof.json" <<'NODE'
'use strict';const fs=require('node:fs'),path=require('node:path');
const[helper,root,stage,currentRelease,pid,restarts]=process.argv.slice(2),read=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const statuses={sntss:read('sntss.before.json'),chronobiology:read('chronobiology.before.json'),metab:read('metab.before.json')};
if(stage==='intero')statuses.homeos=read('homeos.before.json');
const api=require(helper),args={database:read('database.before.json'),statuses,meta:read('meta.before.json'),freeze:read('parent.freeze.json'),service:{pid:Number(pid),restarts:Number(restarts),currentRelease},currentRelease};
const result=stage==='homeos'?api.validateR141Before(args):api.validateR145Current(args);
process.stdout.write(JSON.stringify(result)+'\n');
NODE

/usr/local/bin/node "$STAY_R150_TARGET_RELEASE/$VERIFY" "$CORE" "$STAY_R150_TARGET_RELEASE" "$DATABASE" \
  "$PARENT_FREEZE" "$STAY_R150_CERTIFICATE_FILE" "$ACTIVE_PUBLIC_KEY" > "$WORK/certificate.preflight.json"
/usr/local/bin/node - "$WORK/certificate.preflight.json" "$STAY_R150_DOSSIER_SHA256" <<'NODE'
'use strict';const fs=require('node:fs');const v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(!(v.result==='PASS'&&v.founderDossierSha256===process.argv[3]))process.exit(1);
NODE
[[ "$(systemctl show stay.service -p MainPID --value)" == "$before_pid" &&
  "$(systemctl show stay.service -p NRestarts --value)" == "$before_restarts" &&
  "$(durable_runtime_revision)" == "$SOURCE_REVISION" && "$(readlink -f /opt/stay/current)" == "$SOURCE_RELEASE" ]] || abort read-only-preflight-mutated-production 3513

install -d -o root -g root -m 0755 "$DROPIN_DIR" /etc/stay/resident-promotions
install_atomic "$STAY_R150_CERTIFICATE_FILE" "$ACTIVE_CERTIFICATE" 0444; CERTIFICATE_INSTALLED=1
dropin_tmp="$(mktemp "/run/stay-r150-${STAY_R150_STAGE}-once.XXXXXX")"
if [[ "$STAY_R150_STAGE" == homeos ]]; then
  cat > "$dropin_tmp" <<DROPIN
[Service]
Environment=STAY_HOMEOS_NEUTRAL_BIRTH_AUTHORIZATION=AUTHORIZE_R143_HOMEOS_NEUTRAL_BIRTH_ONLY
Environment=STAY_METAB_HOMEOS_ROUTE_AUTHORIZATION=AUTHORIZE_R144_METAB_HOMEOS_ROUTE_ONLY
Environment=STAY_HOMEOS_SHADOW_PROMOTION_AUTHORIZATION=AUTHORIZE_R145_HOMEOS_OUTPUT_FIREWALLED_SHADOW_ONLY
Environment=STAY_HOMEOS_NEUTRAL_BIRTH_CERTIFICATE=$ACTIVE_CERTIFICATE
Environment=STAY_HOMEOS_NEUTRAL_BIRTH_PUBLIC_KEY=$ACTIVE_PUBLIC_KEY
DROPIN
else
  cat > "$dropin_tmp" <<DROPIN
[Service]
Environment=STAY_INTERO_NEUTRAL_BIRTH_AUTHORIZATION=AUTHORIZE_R147_INTERO_NEUTRAL_BIRTH_ONLY
Environment=STAY_METAB_INTERO_ROUTE_AUTHORIZATION=AUTHORIZE_R148_METAB_INTERO_ROUTE_ONLY
Environment=STAY_HOMEOS_INTERO_ROUTE_AUTHORIZATION=AUTHORIZE_R149_HOMEOS_INTERO_ROUTE_ONLY
Environment=STAY_INTERO_SHADOW_PROMOTION_AUTHORIZATION=AUTHORIZE_R150_INTERO_PERCEPTION_ONLY_SHADOW_ONLY
Environment=STAY_INTERO_NEUTRAL_BIRTH_CERTIFICATE=$ACTIVE_CERTIFICATE
Environment=STAY_INTERO_NEUTRAL_BIRTH_PUBLIC_KEY=$ACTIVE_PUBLIC_KEY
DROPIN
fi
install_atomic "$dropin_tmp" "$DROPIN" 0644; rm -f -- "$dropin_tmp"; DROPIN_INSTALLED=1
if [[ "$SOURCE_RELEASE" != "$STAY_R150_TARGET_RELEASE" ]]; then point_current "$STAY_R150_TARGET_RELEASE"; POINTER_SWITCHED=1; fi
systemctl daemon-reload

RESTART_COMMITTED=1
systemctl restart stay.service
ready=0
for attempt in $(seq 1 20); do
  after_pid="$(systemctl show stay.service -p MainPID --value)"
  after_restarts="$(systemctl show stay.service -p NRestarts --value)"
  if [[ "$after_pid" =~ ^[1-9][0-9]*$ && "$after_pid" != "$before_pid" && "$after_restarts" == "$before_restarts" &&
    "$(systemctl show stay.service -p ActiveState --value)" == active &&
    "$(systemctl show stay.service -p SubState --value)" == running &&
    "$(durable_runtime_revision)" == "$TARGET_REVISION" &&
    "$(readlink -f /opt/stay/current)" == "$STAY_R150_TARGET_RELEASE" && -S "$SOCKET" && ! -L "$SOCKET" ]] &&
    curl --fail --silent --max-time 1 http://127.0.0.1:8787/healthz | grep -q "\"revision\":$TARGET_REVISION"; then
    ready=1; printf '%s\n' "$attempt" > "$WORK/restart-readiness.attempts"; break
  fi
  sleep 0.25
done
[[ "$ready" -eq 1 ]] || abort restart-readiness-failed 3514

capture_database "$WORK/database.after.json" || abort database-after-not-quiescent 3515
capture_statuses after
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.after.json"
/usr/local/bin/node - "$before_pid" "$after_pid" "$before_restarts" "$after_restarts" "$STAY_R150_TARGET_RELEASE" > "$WORK/service.after.json" <<'NODE'
'use strict';const[a,b,c,d,currentRelease]=process.argv.slice(2);process.stdout.write(JSON.stringify({beforePid:Number(a),afterPid:Number(b),beforeRestarts:Number(c),afterRestarts:Number(d),restartCommands:1,currentRelease})+'\n');
NODE
/usr/local/bin/node - "$STAY_R150_TARGET_RELEASE/$PROOF" "$WORK" "$STAY_R150_STAGE" "$STAY_R150_TARGET_RELEASE" > "$WORK/after.proof.json" <<'NODE'
'use strict';const fs=require('node:fs'),path=require('node:path');
const[helper,root,stage,targetRelease]=process.argv.slice(2),read=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const statuses={sntss:read('sntss.after.json'),chronobiology:read('chronobiology.after.json'),metab:read('metab.after.json'),homeos:read('homeos.after.json')};
if(stage==='intero')statuses.intero=read('intero.after.json');
const api=require(helper),args={before:read('before.proof.json'),database:read('database.after.json'),statuses,meta:read('meta.after.json'),service:read('service.after.json'),targetRelease};
const result=stage==='homeos'?api.validateR145After(args):api.validateR150After(args);
process.stdout.write(JSON.stringify(result)+'\n');
NODE

remove_authorization || abort authorization-revocation-failed 3516
[[ ! -e "$DROPIN" && ! -L "$DROPIN" && ! -e "$ACTIVE_CERTIFICATE" && ! -L "$ACTIVE_CERTIFICATE" ]] || abort authorization-still-active 3517
/usr/local/bin/node "$STAY_R150_TARGET_RELEASE/$FREEZER" "$STAY_R150_STAGE" "$WORK" > "$WORK/target.freeze.json"
install_atomic "$WORK/target.freeze.json" "$TARGET_FREEZE" 0444
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.frozen.json"
/usr/local/bin/node - "$WORK/meta.frozen.json" "$TARGET_REVISION" "$STAY_R150_STAGE" <<'NODE'
'use strict';const fs=require('node:fs');const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),r=Number(process.argv[3]),stage=process.argv[4];
const chips=m.chipProjection?.lifecycle||[],chip=id=>chips.find(v=>v.coreId===id),ids=chips.map(v=>v.coreId).filter(id=>['bsf','sntss','chronobiology','metab','homeos','intero'].includes(id));
const expected=stage==='homeos'?['bsf','sntss','chronobiology','metab','homeos']:['bsf','sntss','chronobiology','metab','homeos','intero'];
if(!(m.ok===true&&m.revision===r&&m.revisionFrozen===true&&m.revisionLabel===`R${r}F`&&
expected.every((id,index)=>ids[index]===id)&&chip('bsf')?.state==='LIVE'&&expected.slice(1).every(id=>chip(id)?.state==='SHADOW')&&
m.chipProjection?.observationOnly===true&&m.chipProjection?.mutationEndpoints?.length===0))process.exit(1);
NODE
[[ "$(durable_runtime_revision)" == "$TARGET_REVISION" &&
  "$(readlink -f /opt/stay/current)" == "$STAY_R150_TARGET_RELEASE" &&
  "$(systemctl show stay.service -p MainPID --value)" == "$after_pid" &&
  "$(systemctl show stay.service -p NRestarts --value)" == "$after_restarts" &&
  "$(systemctl is-active stay-physiology-benchmark-v3.service 2>/dev/null || true)" == inactive ]] || abort final-fence-failed 3518

final_evidence="$EVIDENCE_ROOT/R${TARGET_REVISION}F-${STAY_R150_STAGE^^}-SHADOW-$(date -u +'%Y%m%dT%H%M%SZ')"
[[ ! -e "$final_evidence" && ! -L "$final_evidence" ]]
mv -T "$WORK" "$final_evidence"; WORK=''; chmod -R a-w "$final_evidence"; COMPLETED=1
printf '%s\n' "R150_${STAY_R150_STAGE^^}_SHADOW=PASS" "RUNTIME_REVISION=$TARGET_REVISION" \
  "REVISION_LABEL=R${TARGET_REVISION}F" "CURRENT_RELEASE=$STAY_R150_TARGET_RELEASE" \
  "SERVICE_PID=$after_pid" 'BSF_MODE=LIVE' 'SNTSS_MODE=SHADOW' 'SNTSS_OUTPUTS=0' \
  'CHRONOBIOLOGY_MODE=SHADOW' 'METAB_MODE=SHADOW' 'HOMEOS_MODE=SHADOW' \
  "INTERO_MODE=$([[ "$STAY_R150_STAGE" == intero ]] && echo SHADOW || echo ABSENT)" \
  'P1_AUTHORITY=NONE' 'FETUS_CONTINUITY=PASS' 'PROMOTION_AUTHORITY_ACTIVE=NO' \
  'BENCHMARK_ACTIVE=NO' "FREEZE_FILE=$TARGET_FREEZE" "EVIDENCE_ROOT=$final_evidence"
