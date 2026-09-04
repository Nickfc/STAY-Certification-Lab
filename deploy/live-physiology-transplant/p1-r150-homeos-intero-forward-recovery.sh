#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH LC_ALL=C

EXPECTED_PRIVATE_IPV4='172.26.9.207'
DATABASE='/var/lib/stay/data/continuity.sqlite3'
FREEZE_DIR='/var/lib/stay/evidence/runtime-freezes'
EVIDENCE_ROOT='/var/lib/stay/evidence/production-hardening'
DROPIN_DIR='/etc/systemd/system/stay.service.d'
ACTIVE_PUBLIC_KEY='/etc/stay/p1-r0-expansion-birth-authority.pub'
SOCKET='/run/stay/resident-control.sock'
MANIFEST='deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R141F_TO_R150.sha256'
PROOF='deploy/live-physiology-transplant/p1-r150-homeos-intero-live-proof.js'
VERIFY='deploy/live-physiology-transplant/p1-r150-verify-birth-certificate.js'
FREEZER='deploy/live-physiology-transplant/p1-r150-homeos-intero-freeze.js'
CLIENT='deploy/live-physiology-transplant/p1-resident-control-client.js'
METAB_REPAIR='deploy/live-physiology-transplant/p1-r146-metab-q48-implementation-repair.js'
PREVIOUS_HOMEOS_TARGET='/opt/stay/releases/0.8.11.3-p1r0-r150-homeos-intero-8421f172c6f8'
PREVIOUS_HOMEOS_TAG='r150-homeos-intero-shadow-v11'
PREVIOUS_HOMEOS_COMMIT='10618886fb1cf20fb4a0b69171a8e0f191a2f7fe'
PREVIOUS_HOMEOS_TREE='ccd673eeecef8a7c95842129ce455120eeabbf9b'
PREVIOUS_HOMEOS_ARCHIVE_SHA256='sha256:748c43093083f35c0ff91bf9199cb966486ecafa79d48c510fc28e6009d01d3b'
PREVIOUS_HOMEOS_MANIFEST_SHA256='sha256:8421f172c6f84f69bd5ff9ad746cc931baa1d22c0866037e3ca5b89d52a956e0'
PREVIOUS_HOMEOS_CONTROLLER_SHA256='sha256:de0bab3adc6f0cc37e10b7ac420570017b18959fac3f1bad40f7d6afbebff753'
ORIGINAL_HOMEOS_FAILURE_TARGET='/opt/stay/releases/0.8.11.3-p1r0-r150-homeos-intero-418c80c33029'
ORIGINAL_HOMEOS_FAILURE_TAG='r150-homeos-intero-shadow-v3'
ORIGINAL_HOMEOS_FAILURE_COMMIT='b21e56776be8a0954ef1af34bd28c13d6e03dd5d'
ORIGINAL_HOMEOS_FAILURE_TREE='3f4864991e8454cdc2fedae11fe448677c84d706'
ORIGINAL_HOMEOS_FAILURE_ARCHIVE_SHA256='sha256:183887ece2eec09358e13c8a8effa80d98551d76e0b208ae5f90272e34f07e5e'
ORIGINAL_HOMEOS_FAILURE_MANIFEST_SHA256='sha256:418c80c33029f9e2e2920c999e262cf3fea259630a2b378e4258f13833d3735d'
ORIGINAL_HOMEOS_FAILURE_CONTROLLER_SHA256='sha256:f70cb15c890d396ba6013e3747e464d8a297bd3add5eb958b9c3d693a1a6d404'
ORIGINAL_HOMEOS_FAILURE_EVIDENCE='/var/lib/stay/evidence/production-hardening/FAILED-R145-HOMEOS-20260903T201401Z.qIMbPE'
ORIGINAL_HOMEOS_FAILURE_CERTIFICATE_SHA256='sha256:a4a4c8d215d625cf5694a33f246a1953049846ad60e08959c65463fbb03ec31c'
R147_HOMEOS_FAILURE_EVIDENCE='/var/lib/stay/evidence/production-hardening/FAILED-R146-HOMEOS-RECOVERY-20260904T181405Z.FyuzQM'
R147_HOMEOS_FAILURE_BEFORE_SHA256='92b0aabcabb95c29f0a706f3ed7bbfa3f498d6a007af1cd6cce847a7327b8623'
R147_HOMEOS_FAILURE_CERTIFICATE_SHA256='a4a4c8d215d625cf5694a33f246a1953049846ad60e08959c65463fbb03ec31c'

: "${STAY_R150_STAGE:?}"
: "${STAY_R150_RECOVERY_AUTHORIZATION:?}"
: "${STAY_R150_TARGET_RELEASE:?}"
: "${STAY_R150_RELEASE_TAG:?}"
: "${STAY_R150_RELEASE_COMMIT:?}"
: "${STAY_R150_RELEASE_TREE:?}"
: "${STAY_R150_ARCHIVE_SHA256:?}"
: "${STAY_R150_MANIFEST_SHA256:?}"
: "${STAY_R150_CONTROLLER_SHA256:?}"
: "${STAY_R150_EXPANSION_PUBLIC_KEY_SHA256:?}"

WORK=''
COMPLETED=0
AUTHORIZATION_INSTALLED=0
RECOVERY_RESTART_COMMANDS=0

abort() { printf 'R150_%s_RECOVERY_ABORT=%s\n' "${STAY_R150_STAGE^^}" "$1" >&2; exit "${2:-1}"; }
sha256_file() { sha256sum "$1" | awk '{print $1}'; }
marker_value() { sed -n "s/^$1=//p" "$RECOVERY_MARKER"; }

durable_runtime_revision() {
  STAY_DATABASE="$DATABASE" /usr/local/bin/node <<'NODE'
'use strict';const crypto=require('node:crypto');const{DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.STAY_DATABASE,{open:true,readOnly:true});try{db.exec('PRAGMA query_only=ON');
const row=db.prepare("SELECT json,sha256 FROM metadata WHERE key='life:runtime-revision'").get();
if(!row||crypto.createHash('sha256').update(row.json).digest('hex')!==row.sha256)process.exit(2);
const value=Number(JSON.parse(row.json).revision);if(!Number.isSafeInteger(value))process.exit(3);process.stdout.write(String(value));}finally{db.close();}
NODE
}

install_atomic() {
  local source="$1" target="$2" mode="$3" temporary
  temporary="$(mktemp "$(dirname "$target")/.r150-recovery.XXXXXX")"
  install -o root -g root -m "$mode" "$source" "$temporary"; mv -fT "$temporary" "$target"
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
  AUTHORIZATION_INSTALLED=0
  if [[ "$changed" -eq 1 ]]; then systemctl daemon-reload; fi
}

capture_database() {
  local output="$1" temporary="$1.new" attempt
  for attempt in $(seq 1 20); do
    /usr/local/bin/node "$STAY_R150_TARGET_RELEASE/$PROOF" capture "$DATABASE" > "$temporary"
    if /usr/local/bin/node - "$temporary" <<'NODE'
'use strict';const v=JSON.parse(require('node:fs').readFileSync(process.argv[2],'utf8'));
if(!(v.quickCheck==='ok'&&v.queryOnly===true&&v.pendingDeliveries===0&&v.pendingOutboxIntents===0&&
v.failedDeliveries===0&&v.capacitySource?.pending===null))process.exit(1);
NODE
    then mv -fT "$temporary" "$output"; printf '%s\n' "$attempt" > "$output.attempts"; return 0; fi
    sleep 0.25
  done
  mv -fT "$temporary" "$output"; return 1
}

cleanup() {
  local status=$? failed
  trap - EXIT; set +e
  if [[ "$COMPLETED" -eq 0 ]]; then
    if [[ "$AUTHORIZATION_INSTALLED" -eq 1 ]]; then remove_authorization; fi
    if [[ -n "$WORK" && -d "$WORK" ]]; then
      failed="$(mktemp -d "$EVIDENCE_ROOT/FAILED-R${TARGET_REVISION}-${STAY_R150_STAGE^^}-RECOVERY-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
      rmdir -- "$failed"; mv -T "$WORK" "$failed"; WORK=''; chmod -R a-w "$failed"
      printf 'R150_%s_RECOVERY_FAILURE_EVIDENCE=%s\n' "${STAY_R150_STAGE^^}" "$failed" >&2
    fi
    printf 'R150_%s_FORWARD_RECOVERY_STILL_REQUIRED=YES\n' "${STAY_R150_STAGE^^}" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

case "$STAY_R150_STAGE" in
  homeos)
    CORE='HOMEOS'; PARENT_REVISION=141; BIRTH_PREDECESSOR=142; TARGET_REVISION=146
    PARENT_FREEZE="$FREEZE_DIR/R141.json"; TARGET_FREEZE="$FREEZE_DIR/R146.json"
    DROPIN="$DROPIN_DIR/r146-metab-q48-homeos-shadow-once.conf"
    ACTIVE_CERTIFICATE='/etc/stay/resident-promotions/resident-homeos-neutral-birth.json'
    RECOVERY_MARKER='/run/stay-r145-homeos-shadow-recovery.env'
    AUTHORIZATION='AUTHORIZE_R146_METAB_Q48_HOMEOS_OUTPUT_FIREWALLED_SHADOW_FORWARD_RECOVERY_ONLY'
    EVIDENCE_NAME='homeos'
    ;;
  homeos-r147)
    CORE='HOMEOS'; PARENT_REVISION=141; BIRTH_PREDECESSOR=142; TARGET_REVISION=147
    PARENT_FREEZE="$FREEZE_DIR/R141.json"; TARGET_FREEZE="$FREEZE_DIR/R147.json"
    DROPIN="$DROPIN_DIR/r147-homeos-shadow-recovery-once.conf"
    ACTIVE_CERTIFICATE='/etc/stay/resident-promotions/resident-homeos-neutral-birth.json'
    RECOVERY_MARKER='/run/stay-r147-homeos-shadow-recovery.env'
    AUTHORIZATION='AUTHORIZE_R147_HOMEOS_OUTPUT_FIREWALLED_SHADOW_FORWARD_RECOVERY_ONLY'
    EVIDENCE_NAME='homeos'
    ;;
  intero)
    CORE='INTERO'; PARENT_REVISION=145; BIRTH_PREDECESSOR=146; TARGET_REVISION=150
    PARENT_FREEZE="$FREEZE_DIR/R145.json"; TARGET_FREEZE="$FREEZE_DIR/R150.json"
    DROPIN="$DROPIN_DIR/r150-intero-shadow-once.conf"
    ACTIVE_CERTIFICATE='/etc/stay/resident-promotions/resident-intero-neutral-birth.json'
    RECOVERY_MARKER='/run/stay-r150-intero-shadow-recovery.env'
    AUTHORIZATION='AUTHORIZE_R150_INTERO_PERCEPTION_ONLY_SHADOW_FORWARD_RECOVERY_ONLY'
    EVIDENCE_NAME='intero'
    ;;
  *) abort invalid-stage 3601 ;;
esac

[[ "$EUID" -eq 0 ]] || abort root-required 3602
[[ "$STAY_R150_RECOVERY_AUTHORIZATION" == "$AUTHORIZATION" ]] || abort authorization-required 3603
[[ "$(ip -4 -o addr show scope global | awk '{split($4,a,"/");print a[1]}' | sort -u)" == "$EXPECTED_PRIVATE_IPV4" ]] || abort host-identity-mismatch 3604
[[ "$STAY_R150_TARGET_RELEASE" =~ ^/opt/stay/releases/0\.8\.11\.3-p1r0-r150-homeos-intero-[0-9a-f]{12}$ &&
  "$STAY_R150_RELEASE_TAG" =~ ^r150-homeos-intero-shadow-v[0-9]+$ &&
  "$STAY_R150_RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ && "$STAY_R150_RELEASE_TREE" =~ ^[0-9a-f]{40}$ &&
  "$STAY_R150_ARCHIVE_SHA256" =~ ^sha256:[0-9a-f]{64}$ && "$STAY_R150_MANIFEST_SHA256" =~ ^sha256:[0-9a-f]{64}$ &&
  "$STAY_R150_CONTROLLER_SHA256" =~ ^sha256:[0-9a-f]{64}$ &&
  "$STAY_R150_EXPANSION_PUBLIC_KEY_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]] || abort immutable-identity-invalid 3605
for directory in "$STAY_R150_TARGET_RELEASE" "$EVIDENCE_ROOT" "$FREEZE_DIR"; do
  [[ -d "$directory" && ! -L "$directory" ]] || abort release-or-evidence-root-invalid 3606
done
for file in "$DATABASE" "$PARENT_FREEZE" "$RECOVERY_MARKER" "$ACTIVE_PUBLIC_KEY" \
  "$STAY_R150_TARGET_RELEASE/$MANIFEST" "$STAY_R150_TARGET_RELEASE/$PROOF" \
  "$STAY_R150_TARGET_RELEASE/$VERIFY" "$STAY_R150_TARGET_RELEASE/$FREEZER" \
  "$STAY_R150_TARGET_RELEASE/$CLIENT" "$STAY_R150_TARGET_RELEASE/$METAB_REPAIR" \
  "$STAY_R150_TARGET_RELEASE/P1_R150_RELEASE.env"; do
  [[ -f "$file" && ! -L "$file" ]] || abort recovery-input-invalid 3607
done
marker_cohort='INVALID'
if [[ "$(marker_value R150_TARGET_RELEASE)" == "$STAY_R150_TARGET_RELEASE" &&
  "$(marker_value R150_RELEASE_TAG)" == "$STAY_R150_RELEASE_TAG" &&
  "$(marker_value R150_RELEASE_COMMIT)" == "$STAY_R150_RELEASE_COMMIT" &&
  "$(marker_value R150_RELEASE_TREE)" == "$STAY_R150_RELEASE_TREE" &&
  "$(marker_value R150_ARCHIVE_SHA256)" == "$STAY_R150_ARCHIVE_SHA256" &&
  "$(marker_value R150_MANIFEST_SHA256)" == "$STAY_R150_MANIFEST_SHA256" &&
  "$(marker_value R150_CONTROLLER_SHA256)" == "$STAY_R150_CONTROLLER_SHA256" ]]; then
  marker_cohort='CURRENT'
elif [[ "$STAY_R150_STAGE" == homeos &&
  "$(marker_value R150_TARGET_RELEASE)" == "$PREVIOUS_HOMEOS_TARGET" &&
  "$(marker_value R150_RELEASE_TAG)" == "$PREVIOUS_HOMEOS_TAG" &&
  "$(marker_value R150_RELEASE_COMMIT)" == "$PREVIOUS_HOMEOS_COMMIT" &&
  "$(marker_value R150_RELEASE_TREE)" == "$PREVIOUS_HOMEOS_TREE" &&
  "$(marker_value R150_ARCHIVE_SHA256)" == "$PREVIOUS_HOMEOS_ARCHIVE_SHA256" &&
  "$(marker_value R150_MANIFEST_SHA256)" == "$PREVIOUS_HOMEOS_MANIFEST_SHA256" &&
  "$(marker_value R150_CONTROLLER_SHA256)" == "$PREVIOUS_HOMEOS_CONTROLLER_SHA256" ]]; then
  marker_cohort='EXACT_PREVIOUS_HOMEOS_FAILURE'
elif [[ "$STAY_R150_STAGE" == homeos &&
  "$(marker_value R150_TARGET_RELEASE)" == "$ORIGINAL_HOMEOS_FAILURE_TARGET" &&
  "$(marker_value R150_RELEASE_TAG)" == "$ORIGINAL_HOMEOS_FAILURE_TAG" &&
  "$(marker_value R150_RELEASE_COMMIT)" == "$ORIGINAL_HOMEOS_FAILURE_COMMIT" &&
  "$(marker_value R150_RELEASE_TREE)" == "$ORIGINAL_HOMEOS_FAILURE_TREE" &&
  "$(marker_value R150_ARCHIVE_SHA256)" == "$ORIGINAL_HOMEOS_FAILURE_ARCHIVE_SHA256" &&
  "$(marker_value R150_MANIFEST_SHA256)" == "$ORIGINAL_HOMEOS_FAILURE_MANIFEST_SHA256" &&
  "$(marker_value R150_CONTROLLER_SHA256)" == "$ORIGINAL_HOMEOS_FAILURE_CONTROLLER_SHA256" &&
  "$(marker_value R150_FAILURE_EVIDENCE)" == "$ORIGINAL_HOMEOS_FAILURE_EVIDENCE" &&
  "$(marker_value R150_CERTIFICATE_SHA256)" == "$ORIGINAL_HOMEOS_FAILURE_CERTIFICATE_SHA256" ]]; then
  marker_cohort='EXACT_ORIGINAL_HOMEOS_FAILURE'
fi
[[ "$(stat -Lc '%U:%G:%a' "$RECOVERY_MARKER")" == root:root:400 &&
  "$(marker_value R150_STAGE)" == "$STAY_R150_STAGE" && "$marker_cohort" != INVALID ]] ||
  abort recovery-marker-cohort-invalid 3608
FAILURE_EVIDENCE="$(marker_value R150_FAILURE_EVIDENCE)"
CERTIFICATE_SHA256="$(marker_value R150_CERTIFICATE_SHA256)"
failure_revision_pattern="$TARGET_REVISION"
if [[ "$STAY_R150_STAGE" == homeos ]]; then failure_revision_pattern='(145|146)'; fi
if [[ "$STAY_R150_STAGE" == homeos-r147 ]]; then
  [[ "$FAILURE_EVIDENCE" == "$R147_HOMEOS_FAILURE_EVIDENCE" ]] || abort failure-evidence-invalid 3609
else
  [[ "$FAILURE_EVIDENCE" =~ ^/var/lib/stay/evidence/production-hardening/FAILED-R${failure_revision_pattern}-${STAY_R150_STAGE^^}-[A-Za-z0-9TZ.-]+$ ]] || abort failure-evidence-invalid 3609
fi
[[
  -d "$FAILURE_EVIDENCE" && ! -L "$FAILURE_EVIDENCE" && "$CERTIFICATE_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]] || abort failure-evidence-invalid 3609
CERTIFICATE="$FAILURE_EVIDENCE/$EVIDENCE_NAME.birth-certificate.json"
for file in "$CERTIFICATE" "$FAILURE_EVIDENCE/before.proof.json"; do
  [[ -f "$file" && ! -L "$file" ]] || abort failure-evidence-incomplete 3610
done
if [[ "$STAY_R150_STAGE" == homeos-r147 ]]; then
  [[ "$(sha256_file "$FAILURE_EVIDENCE/before.proof.json")" == "$R147_HOMEOS_FAILURE_BEFORE_SHA256" &&
    "$(sha256_file "$CERTIFICATE")" == "$R147_HOMEOS_FAILURE_CERTIFICATE_SHA256" ]] ||
    abort failure-evidence-hash-invalid 3610
fi
[[ "$(sha256_file "$CERTIFICATE")" == "${CERTIFICATE_SHA256#sha256:}" &&
  "$(sha256_file "$ACTIVE_PUBLIC_KEY")" == "${STAY_R150_EXPANSION_PUBLIC_KEY_SHA256#sha256:}" &&
  "$(sha256_file "$STAY_R150_TARGET_RELEASE/$MANIFEST")" == "${STAY_R150_MANIFEST_SHA256#sha256:}" &&
  "$(readlink -f /opt/stay/current)" == "$STAY_R150_TARGET_RELEASE" && ! -e "$TARGET_FREEZE" && ! -L "$TARGET_FREEZE" &&
  "$(systemctl is-active stay-physiology-benchmark-v3.service 2>/dev/null || true)" == inactive ]] || abort recovery-boundary-invalid 3611
(cd "$STAY_R150_TARGET_RELEASE" && sha256sum -c "$MANIFEST" >/dev/null) || abort target-manifest-invalid 3612
CURRENT_REVISION="$(durable_runtime_revision)"
[[ "$CURRENT_REVISION" =~ ^[0-9]+$ && "$CURRENT_REVISION" -ge "$PARENT_REVISION" && "$CURRENT_REVISION" -le "$TARGET_REVISION" ]] || abort durable-revision-outside-recovery-fence 3613

WORK="$(mktemp -d "$EVIDENCE_ROOT/.R${TARGET_REVISION}-${STAY_R150_STAGE^^}-RECOVERY-$(date -u +'%Y%m%dT%H%M%SZ').XXXXXX")"
install -o root -g root -m 0400 "$PARENT_FREEZE" "$WORK/parent.freeze.json"
install -o root -g root -m 0400 "$CERTIFICATE" "$WORK/$EVIDENCE_NAME.birth-certificate.json"
install -o root -g root -m 0444 "$ACTIVE_PUBLIC_KEY" "$WORK/expansion-birth-authority.pub"
install -o root -g root -m 0400 "$FAILURE_EVIDENCE/before.proof.json" "$WORK/before.proof.json"
install -o root -g root -m 0400 "$STAY_R150_TARGET_RELEASE/P1_R150_RELEASE.env" "$WORK/P1_R150_RELEASE.env"
recovery_before_pid="$(systemctl show stay.service -p MainPID --value)"
recovery_before_restarts="$(systemctl show stay.service -p NRestarts --value)"
original_before_pid="$(/usr/local/bin/node -e "process.stdout.write(String(require('$WORK/before.proof.json').servicePid))")"
original_before_restarts="$(/usr/local/bin/node -e "process.stdout.write(String(require('$WORK/before.proof.json').serviceRestarts))")"

if [[ "$CURRENT_REVISION" -le "$BIRTH_PREDECESSOR" ]]; then
  /usr/local/bin/node "$STAY_R150_TARGET_RELEASE/$VERIFY" "$CORE" "$STAY_R150_TARGET_RELEASE" "$DATABASE" \
    "$PARENT_FREEZE" "$CERTIFICATE" "$ACTIVE_PUBLIC_KEY" > "$WORK/certificate.recovery-preflight.json"
fi
if [[ "$STAY_R150_STAGE" == homeos && "$CURRENT_REVISION" -eq 146 ]]; then
  /usr/local/bin/node "$STAY_R150_TARGET_RELEASE/$METAB_REPAIR" preflight \
    "$DATABASE" "$STAY_R150_TARGET_RELEASE" > "$WORK/metab-q48-repair.preflight.json"
fi

need_restart=1
if [[ "$CURRENT_REVISION" -eq "$TARGET_REVISION" && "$recovery_before_pid" =~ ^[1-9][0-9]*$ &&
  "$(systemctl show stay.service -p ActiveState --value)" == active &&
  "$(systemctl show stay.service -p SubState --value)" == running && -S "$SOCKET" && ! -L "$SOCKET" ]] &&
  curl --fail --silent --max-time 1 http://127.0.0.1:8787/healthz |
    grep -q "\"revision\":$TARGET_REVISION"; then
  need_restart=0
fi
if [[ "$need_restart" -eq 1 ]]; then
  install -d -o root -g root -m 0755 "$DROPIN_DIR" /etc/stay/resident-promotions
  install_atomic "$CERTIFICATE" "$ACTIVE_CERTIFICATE" 0444
  dropin_tmp="$(mktemp "/run/stay-r150-${STAY_R150_STAGE}-recovery.XXXXXX")"
  if [[ "$STAY_R150_STAGE" == homeos ]]; then
    cat > "$dropin_tmp" <<DROPIN
[Service]
Environment=STAY_HOMEOS_NEUTRAL_BIRTH_AUTHORIZATION=AUTHORIZE_R143_HOMEOS_NEUTRAL_BIRTH_ONLY
Environment=STAY_METAB_HOMEOS_ROUTE_AUTHORIZATION=AUTHORIZE_R144_METAB_HOMEOS_ROUTE_ONLY
Environment=STAY_HOMEOS_SHADOW_PROMOTION_AUTHORIZATION=AUTHORIZE_R145_HOMEOS_OUTPUT_FIREWALLED_SHADOW_ONLY
Environment=STAY_HOMEOS_STRANDED_R146_RECOVERY_AUTHORIZATION=AUTHORIZE_STRANDED_R146_METAB_Q48_HOMEOS_FORWARD_RECOVERY_ONLY
Environment=STAY_RECOVER_COLD_RESIDENTS_AT_REVISION=146
Environment=STAY_HOMEOS_NEUTRAL_BIRTH_CERTIFICATE=$ACTIVE_CERTIFICATE
Environment=STAY_HOMEOS_NEUTRAL_BIRTH_PUBLIC_KEY=$ACTIVE_PUBLIC_KEY
ExecStartPre=/usr/local/bin/node $STAY_R150_TARGET_RELEASE/$METAB_REPAIR apply $DATABASE $STAY_R150_TARGET_RELEASE
DROPIN
  elif [[ "$STAY_R150_STAGE" == homeos-r147 ]]; then
    cat > "$dropin_tmp" <<DROPIN
[Service]
Environment=STAY_HOMEOS_NEUTRAL_BIRTH_AUTHORIZATION=AUTHORIZE_R143_HOMEOS_NEUTRAL_BIRTH_ONLY
Environment=STAY_METAB_HOMEOS_ROUTE_AUTHORIZATION=AUTHORIZE_R144_METAB_HOMEOS_ROUTE_ONLY
Environment=STAY_HOMEOS_SHADOW_PROMOTION_AUTHORIZATION=AUTHORIZE_R145_HOMEOS_OUTPUT_FIREWALLED_SHADOW_ONLY
Environment=STAY_HOMEOS_STRANDED_R147_RECOVERY_AUTHORIZATION=AUTHORIZE_STRANDED_R147_HOMEOS_FORWARD_RECOVERY_ONLY
Environment=STAY_RECOVER_COLD_RESIDENTS_AT_REVISION=147
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
  install_atomic "$dropin_tmp" "$DROPIN" 0644; rm -f -- "$dropin_tmp"; AUTHORIZATION_INSTALLED=1
  systemctl daemon-reload; RECOVERY_RESTART_COMMANDS=1; systemctl restart stay.service
fi

ready=0
for attempt in $(seq 1 100); do
  after_pid="$(systemctl show stay.service -p MainPID --value)"; after_restarts="$(systemctl show stay.service -p NRestarts --value)"
  if [[ "$after_pid" =~ ^[1-9][0-9]*$ && "$(systemctl show stay.service -p ActiveState --value)" == active &&
    "$(systemctl show stay.service -p SubState --value)" == running && "$(durable_runtime_revision)" == "$TARGET_REVISION" &&
    "$(readlink -f /opt/stay/current)" == "$STAY_R150_TARGET_RELEASE" && -S "$SOCKET" && ! -L "$SOCKET" ]] &&
    curl --fail --silent --max-time 1 http://127.0.0.1:8787/healthz | grep -q "\"revision\":$TARGET_REVISION"; then
    ready=1; printf '%s\n' "$attempt" > "$WORK/recovery-readiness.attempts"; break
  fi
  sleep 0.75
done
[[ "$ready" -eq 1 ]] || abort recovery-readiness-failed 3614

capture_database "$WORK/database.after.json" || abort database-after-not-quiescent 3615
for id in sntss chronobiology metab homeos; do
  /usr/local/bin/node "$STAY_R150_TARGET_RELEASE/$CLIENT" status "resident:$id" > "$WORK/$id.after.json"
done
if [[ "$STAY_R150_STAGE" == intero ]]; then
  /usr/local/bin/node "$STAY_R150_TARGET_RELEASE/$CLIENT" status resident:intero > "$WORK/intero.after.json"
fi
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.after.json"
/usr/local/bin/node - "$original_before_pid" "$original_before_restarts" "$recovery_before_pid" "$after_pid" \
  "$recovery_before_restarts" "$after_restarts" "$RECOVERY_RESTART_COMMANDS" "$STAY_R150_TARGET_RELEASE" > "$WORK/service.after.json" <<'NODE'
'use strict';const[a,b,c,d,e,f,g,currentRelease]=process.argv.slice(2);process.stdout.write(JSON.stringify({recovery:true,originalBeforePid:Number(a),originalBeforeRestarts:Number(b),recoveryBeforePid:Number(c),afterPid:Number(d),recoveryBeforeRestarts:Number(e),afterRestarts:Number(f),recoveryRestartCommands:Number(g),restartCommands:1+Number(g),currentRelease})+'\n');
NODE
/usr/local/bin/node - "$STAY_R150_TARGET_RELEASE/$PROOF" "$WORK" "$STAY_R150_STAGE" "$STAY_R150_TARGET_RELEASE" > "$WORK/after.proof.json" <<'NODE'
'use strict';const fs=require('node:fs'),path=require('node:path');const[helper,root,stage,targetRelease]=process.argv.slice(2),read=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const statuses={sntss:read('sntss.after.json'),chronobiology:read('chronobiology.after.json'),metab:read('metab.after.json'),homeos:read('homeos.after.json')};if(stage==='intero')statuses.intero=read('intero.after.json');
const api=require(helper),args={before:read('before.proof.json'),database:read('database.after.json'),statuses,meta:read('meta.after.json'),service:read('service.after.json'),targetRelease};
process.stdout.write(JSON.stringify(stage==='intero'?api.validateR150After(args):stage==='homeos-r147'?api.validateR147After(args):api.validateR146After(args))+'\n');
NODE

if [[ "$AUTHORIZATION_INSTALLED" -eq 1 ]]; then remove_authorization || abort authorization-revocation-failed 3616; fi
[[ ! -e "$DROPIN" && ! -L "$DROPIN" && ! -e "$ACTIVE_CERTIFICATE" && ! -L "$ACTIVE_CERTIFICATE" ]] || abort authorization-still-active 3617
/usr/local/bin/node "$STAY_R150_TARGET_RELEASE/$FREEZER" "$STAY_R150_STAGE" "$WORK" > "$WORK/target.freeze.json"
install_atomic "$WORK/target.freeze.json" "$TARGET_FREEZE" 0444
curl --fail --silent --max-time 3 http://127.0.0.1:8787/__stay/meta > "$WORK/meta.frozen.json"
/usr/local/bin/node - "$WORK/meta.frozen.json" "$TARGET_REVISION" "$STAY_R150_STAGE" <<'NODE'
'use strict';const fs=require('node:fs');const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),r=Number(process.argv[3]),stage=process.argv[4],chips=m.chipProjection?.lifecycle||[],chip=id=>chips.find(v=>v.coreId===id);const expected=stage==='intero'?['bsf','sntss','chronobiology','metab','homeos','intero']:['bsf','sntss','chronobiology','metab','homeos'];if(!(m.ok===true&&m.revision===r&&m.revisionFrozen===true&&chip('bsf')?.state==='LIVE'&&expected.slice(1).every(id=>chip(id)?.state==='SHADOW')))process.exit(1);
NODE
rm -f -- "$RECOVERY_MARKER"
final_evidence="$EVIDENCE_ROOT/R${TARGET_REVISION}F-${STAY_R150_STAGE^^}-SHADOW-RECOVERED-$(date -u +'%Y%m%dT%H%M%SZ')"
[[ ! -e "$final_evidence" && ! -L "$final_evidence" ]]; mv -T "$WORK" "$final_evidence"; WORK=''; chmod -R a-w "$final_evidence"; COMPLETED=1
printf '%s\n' "R150_${STAY_R150_STAGE^^}_SHADOW_RECOVERY=PASS" "RUNTIME_REVISION=$TARGET_REVISION" \
  "REVISION_LABEL=R${TARGET_REVISION}F" "CURRENT_RELEASE=$STAY_R150_TARGET_RELEASE" \
  "RECOVERY_RESTART_COMMANDS=$RECOVERY_RESTART_COMMANDS" 'P1_AUTHORITY=NONE' 'FETUS_CONTINUITY=PASS' \
  'PROMOTION_AUTHORITY_ACTIVE=NO' 'BENCHMARK_ACTIVE=NO' "FREEZE_FILE=$TARGET_FREEZE" "EVIDENCE_ROOT=$final_evidence"
