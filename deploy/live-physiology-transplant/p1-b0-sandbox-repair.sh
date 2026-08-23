#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"
[[ "${STAY_B0_SANDBOX_REPAIR_AUTHORIZED:-NO}" == YES ]] || {
  echo "B0_SANDBOX_REPAIR_ABORT=authorization-missing" >&2
  exit 340
}

A1_RELEASE="/opt/stay/releases/0.8.11.3-p1a1-resident-control-7d040592ccf1f149"
DATABASE="/var/lib/stay/data/continuity.sqlite3"
SOCKET="/run/stay/resident-control.sock"
DROPIN="/etc/systemd/system/stay.service.d/p1-b0-resident-runtime.conf"
BASELINE_SEAL="/etc/stay/p1-b0-baseline.env"
REPAIR_SEAL="/etc/stay/p1-b0-sandbox-repair.env"
BASELINE_EVIDENCE="/var/lib/stay/evidence/live-physiology-transplant/p1-b0-20260823T115636Z"
KEY="/etc/stay/release-authority.pub"
CERT_DIR="/etc/stay/resident-promotions"
CERT="$CERT_DIR/resident-sntss.json"
EVIDENCE_PARENT="${1:-/var/lib/stay/evidence/live-physiology-transplant}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE_DIR="$EVIDENCE_PARENT/b0-sandbox-repair-$STAMP"
NODE_BIN="$(command -v node)"
TEMP_DROPIN=""
TEMP_SEAL=""
CAPABILITIES="CAP_SETGID CAP_SETUID CAP_NET_ADMIN CAP_SYS_CHROOT CAP_SYS_PTRACE CAP_SYS_ADMIN"
CAP_INH_HEX="0000000000200000"
CAP_BOUND_HEX="00000000002c10c0"

abort() { echo "B0_SANDBOX_REPAIR_ABORT=$1" >&2; exit "${2:-341}"; }
json_field() { "$NODE_BIN" -e 'const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],JSON.parse(process.argv[1]));process.stdout.write(String(v??""))' "$1" "$2"; }
root_regular() { [[ -f "$1" && ! -L "$1" && "$(stat -Lc '%U:%G:%h' "$1")" == root:root:1 ]]; }
status_value() { awk -v key="$2" '$1 == key ":" { print $2 }' "/proc/$1/status"; }
write_repaired_dropin() {
  cat > "$1" <<EOF
[Service]
CapabilityBoundingSet=$CAPABILITIES
Environment=STAY_REQUIRE_OS_CORE_SANDBOX=1
Environment=STAY_BWRAP=/usr/bin/bwrap
Environment=STAY_REQUIRE_CORE_PACKAGE_POLICY=1
Environment=STAY_REQUIRE_CORE_PROMOTION_CERT=1
Environment=STAY_CORE_PROMOTION_PUBLIC_KEY=/etc/stay/release-authority.pub
Environment=STAY_CORE_PROMOTION_CERT_DIR=/etc/stay/core-promotions
Environment=STAY_RESIDENT_PROMOTION_CERT_DIR=/etc/stay/resident-promotions
Environment=STAY_TRUSTED_TIME_PULSE_INTERVAL_MS=25
EOF
}
run_live_user_probe() {
  /usr/sbin/runuser -u staydeploy -- /usr/bin/env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_ENV=production \
    STAY_REQUIRE_OS_CORE_SANDBOX=1 \
    STAY_BWRAP=/usr/bin/bwrap \
    STAY_REQUIRE_CORE_PACKAGE_POLICY=1 \
    STAY_REQUIRE_CORE_PROMOTION_CERT=1 \
    STAY_CORE_PROMOTION_PUBLIC_KEY="$KEY" \
    STAY_RESIDENT_PROMOTION_CERT_DIR="$CERT_DIR" \
    "$NODE_BIN" "$SCRIPT_DIR/p1-b0-live-user-probe.js" \
    "$A1_RELEASE" "$DATABASE" "$KEY" "$CERT_DIR"
}
cleanup() { rm -f -- "$TEMP_DROPIN" "$TEMP_SEAL" 2>/dev/null || true; }
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 342
[[ "$EVIDENCE_PARENT" == /var/lib/stay/evidence/live-physiology-transplant ]] || abort evidence-parent-invalid 343
[[ ! -e "$REPAIR_SEAL" && ! -L "$REPAIR_SEAL" ]] || abort repair-already-sealed 344
[[ "$(readlink -f /opt/stay/current)" == "$A1_RELEASE" ]] || abort current-release-mismatch 345
[[ "$(systemctl show stay.service -p ActiveState --value)" == active &&
   "$(systemctl show stay.service -p SubState --value)" == running &&
   "$(systemctl show stay.service -p NRestarts --value)" == 0 ]] || abort service-precondition-failed 346
PRE_PID="$(systemctl show stay.service -p MainPID --value)"
[[ "$PRE_PID" == 77214 ]] || abort live-incarnation-mismatch 347
PRE_POINTER="$(readlink -f /opt/stay/current)"
PRE_HEALTH="$($NODE_BIN "$SCRIPT_DIR/p1-b0-runtime-ready.js")" || abort pre-runtime-not-ready 348
[[ "$(json_field "$PRE_HEALTH" revision)" == 54 ]] || abort pre-runtime-revision-not-54 349
[[ -f "$BASELINE_SEAL" && ! -L "$BASELINE_SEAL" && "$(stat -Lc '%U:%G:%a:%h' "$BASELINE_SEAL")" == root:root:444:1 ]] || abort baseline-seal-invalid 350
grep -Fx 'P1_B0_BASELINE_FORMAT=stay-p1-b0-baseline-v1' "$BASELINE_SEAL" >/dev/null || abort baseline-seal-format 350
grep -Fx 'RUNTIME_REVISION=54' "$BASELINE_SEAL" >/dev/null || abort baseline-seal-revision 350
[[ -f "$DROPIN" && ! -L "$DROPIN" && "$(stat -Lc '%U:%G:%a:%h' "$DROPIN")" == root:root:644:1 ]] || abort runtime-dropin-invalid 351
cmp -s "$BASELINE_EVIDENCE/dropin.expected" "$DROPIN" || abort sealed-dropin-precondition-mismatch 352
root_regular "$KEY" && [[ "$(stat -Lc '%a' "$KEY")" == 444 ]] || abort public-key-invalid 353
root_regular "$CERT" && [[ "$(stat -Lc '%a' "$CERT")" == 444 ]] || abort resident-certificate-invalid 354
KEY_HASH_BEFORE="$(sha256sum "$KEY" | awk '{print $1}')"
CERT_HASH_BEFORE="$(sha256sum "$CERT" | awk '{print $1}')"

install -d -o root -g root -m 0700 "$EVIDENCE_DIR" || abort evidence-directory-create 355
printf '%s\n' "$PRE_HEALTH" > "$EVIDENCE_DIR/health-before.json"
"$NODE_BIN" "$SCRIPT_DIR/p1-surgery-a1-state.js" capture "$DATABASE" > "$EVIDENCE_DIR/state-before.json" || abort pre-state-capture 356
"$NODE_BIN" "$SCRIPT_DIR/p1-surgery-b-state.js" baseline "$DATABASE" > "$EVIDENCE_DIR/physiology-before.json" || abort physiology-precondition 357
systemctl show stay.service -p MainPID,NRestarts,ActiveState,SubState,Result,ExecStart --no-pager > "$EVIDENCE_DIR/service-before.txt"
install -o root -g root -m 0400 "$DROPIN" "$EVIDENCE_DIR/dropin-before.conf"

set +e
run_live_user_probe > "$EVIDENCE_DIR/live-user-probe-before.txt" 2>&1
PRE_PROBE_STATUS=$?
set -e
[[ "$PRE_PROBE_STATUS" -ne 0 ]] || abort live-user-probe-unexpectedly-passed 358
grep -Fq 'ERROR_CODE=CORE_WORKER_EXIT' "$EVIDENCE_DIR/live-user-probe-before.txt" || abort live-user-probe-error-class-changed 359
grep -Fq 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' "$EVIDENCE_DIR/live-user-probe-before.txt" || abort live-user-probe-root-cause-changed 360

TEMP_DROPIN="$(mktemp "$(dirname "$DROPIN")/.p1-b0-resident-runtime.XXXXXX")" || abort dropin-temp-create 361
write_repaired_dropin "$TEMP_DROPIN" || abort dropin-write 362
chown root:root "$TEMP_DROPIN" && chmod 0644 "$TEMP_DROPIN" || abort dropin-permissions 363
NEW_DROPIN_HASH="$(sha256sum "$TEMP_DROPIN" | awk '{print $1}')"
mv -fT "$TEMP_DROPIN" "$DROPIN" || abort dropin-publish 364
TEMP_DROPIN=""
systemctl daemon-reload || abort daemon-reload 365
systemctl restart stay.service || abort service-restart 366

POST_HEALTH="$($NODE_BIN "$SCRIPT_DIR/p1-b0-runtime-ready.js")" || abort post-runtime-not-ready 367
POST_REVISION="$(json_field "$POST_HEALTH" revision)"
[[ "$POST_REVISION" =~ ^[0-9]+$ ]] && (( POST_REVISION > 54 )) || abort post-runtime-revision-not-forward 368
POST_PID="$(systemctl show stay.service -p MainPID --value)"
[[ "$POST_PID" =~ ^[1-9][0-9]*$ && "$POST_PID" != "$PRE_PID" ]] || abort service-incarnation-not-replaced 369
[[ "$(systemctl show stay.service -p ActiveState --value)" == active &&
   "$(systemctl show stay.service -p SubState --value)" == running &&
   "$(systemctl show stay.service -p NRestarts --value)" == 0 &&
   "$(systemctl show stay.service -p Result --value)" == success ]] || abort service-postcondition-failed 370
[[ "$(readlink -f /opt/stay/current)" == "$PRE_POINTER" ]] || abort current-pointer-changed 371
[[ "$(sha256sum "$DROPIN" | awk '{print $1}')" == "$NEW_DROPIN_HASH" ]] || abort repaired-dropin-hash-mismatch 372
[[ "$(sha256sum "$KEY" | awk '{print $1}')" == "$KEY_HASH_BEFORE" &&
   "$(sha256sum "$CERT" | awk '{print $1}')" == "$CERT_HASH_BEFORE" ]] || abort trust-material-changed 373

[[ "$(status_value "$POST_PID" CapInh)" == "$CAP_INH_HEX" ]] || abort service-CapInh-mismatch 374
for field in CapPrm CapEff CapAmb; do
  [[ "$(status_value "$POST_PID" "$field")" == 0000000000000000 ]] || abort "service-${field}-not-empty" 374
done
[[ "$(status_value "$POST_PID" CapBnd)" == "$CAP_BOUND_HEX" ]] || abort capability-bounding-set-mismatch 375
[[ "$(status_value "$POST_PID" NoNewPrivs)" == 1 ]] || abort no-new-privileges-disabled 375

run_live_user_probe > "$EVIDENCE_DIR/live-user-probe-after.txt" 2>&1 || abort live-user-probe-failed 376
grep -Fx 'LIVE_USER_CORE_INSPECT=PASS' "$EVIDENCE_DIR/live-user-probe-after.txt" >/dev/null || abort live-user-inspect-marker-missing 377
grep -Fx 'LIVE_USER_PROMOTION=PASS' "$EVIDENCE_DIR/live-user-probe-after.txt" >/dev/null || abort live-user-promotion-marker-missing 378
grep -Fx 'LABORATORY_BYPASS=NO' "$EVIDENCE_DIR/live-user-probe-after.txt" >/dev/null || abort laboratory-bypass-detected 379

SNTSS="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:sntss)" || abort sntss-status-failed 380
CHRONO="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:chronobiology)" || abort chronobiology-status-failed 381
[[ "$(json_field "$SNTSS" resident.present)" == false && "$(json_field "$CHRONO" resident.present)" == false ]] || abort resident-activated 382
printf '%s\n' "$SNTSS" > "$EVIDENCE_DIR/sntss-status.json"
printf '%s\n' "$CHRONO" > "$EVIDENCE_DIR/chronobiology-status.json"
printf '%s\n' "$POST_HEALTH" > "$EVIDENCE_DIR/health-after.json"
"$NODE_BIN" "$SCRIPT_DIR/p1-surgery-a1-state.js" capture "$DATABASE" > "$EVIDENCE_DIR/state-after.json" || abort post-state-capture 383
COMPARE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-a1-state.js" compare "$EVIDENCE_DIR/state-before.json" "$EVIDENCE_DIR/state-after.json")" || abort forward-continuity-failed 384
printf '%s\n' "$COMPARE" > "$EVIDENCE_DIR/continuity.json"
systemctl show stay.service -p MainPID,NRestarts,ActiveState,SubState,Result,ExecStart --no-pager > "$EVIDENCE_DIR/service-after.txt"
install -o root -g root -m 0400 "$DROPIN" "$EVIDENCE_DIR/dropin-after.conf"

TEMP_SEAL="$(mktemp /etc/stay/.p1-b0-sandbox-repair.env.XXXXXX)" || abort repair-seal-temp-create 385
cat > "$TEMP_SEAL" <<EOF
P1_B0_SANDBOX_REPAIR_FORMAT=stay-p1-b0-sandbox-repair-v2
BASELINE_RUNTIME_REVISION=54
RUNTIME_REVISION_AFTER=$POST_REVISION
SERVICE_MAIN_PID=$POST_PID
CAPABILITY_BOUNDING_SET=$CAPABILITIES
CAPABILITY_BOUNDING_HEX=$CAP_BOUND_HEX
SERVICE_INHERITABLE_CAPABILITIES_HEX=$CAP_INH_HEX
SERVICE_PERMITTED_CAPABILITIES=NONE
SERVICE_EFFECTIVE_CAPABILITIES=NONE
SERVICE_AMBIENT_CAPABILITIES=NONE
NO_NEW_PRIVILEGES=YES
DROPIN_SHA256=$NEW_DROPIN_HASH
PUBLIC_KEY_SHA256=$KEY_HASH_BEFORE
RESIDENT_CERTIFICATE_SHA256=$CERT_HASH_BEFORE
ORGANISM_IDENTITY_HASH=$(json_field "$COMPARE" organismIdentityHash)
AUTHORITY_IDENTITY_HASH=$(json_field "$COMPARE" authorityIdentityHash)
LIVE_USER_INSPECT=PASS
LIVE_USER_PROMOTION=PASS
LABORATORY_BYPASS=NO
EOF
chown root:root "$TEMP_SEAL" && chmod 0444 "$TEMP_SEAL" || abort repair-seal-permissions 386
mv -nT "$TEMP_SEAL" "$REPAIR_SEAL" || abort repair-seal-publish 387
TEMP_SEAL=""

EVIDENCE_DIGEST="sha256:$(find "$EVIDENCE_DIR" -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort | while read -r file; do sha256sum "$EVIDENCE_DIR/$file"; done | sha256sum | awk '{print $1}')"
printf '%s\n' "$EVIDENCE_DIGEST" > "$EVIDENCE_DIR/evidence-digest.txt"
chmod 0400 "$EVIDENCE_DIR"/*

echo "B0_SANDBOX_REPAIR_RESULT=PASS"
echo "ROOT_CAUSE=EMPTY_CAPABILITY_BOUNDING_SET_BLOCKED_BWRAP_NAMESPACE_SETUP"
echo "CURRENT_RELEASE=$A1_RELEASE"
echo "CURRENT_POINTER_CHANGE=NO"
echo "TRUST_MATERIAL_CHANGE=NO"
echo "STATESTORE_SCHEMA=4"
echo "STATESTORE_FORWARD_RESTART_WRITE=YES"
echo "RESIDENT_OPERATION=NO"
echo "AUTHORITY_CHANGE=NO"
echo "SERVICE_RESTARTED=YES"
echo "DAEMON_RELOAD=YES"
echo "RUNTIME_REVISION_BEFORE=54"
echo "RUNTIME_REVISION_AFTER=$POST_REVISION"
echo "SERVICE_INHERITABLE_CAPABILITIES_HEX=$CAP_INH_HEX"
echo "SERVICE_PERMITTED_CAPABILITIES=NONE"
echo "SERVICE_EFFECTIVE_CAPABILITIES=NONE"
echo "SERVICE_AMBIENT_CAPABILITIES=NONE"
echo "NO_NEW_PRIVILEGES=YES"
echo "CAPABILITY_BOUNDING_SET=$CAPABILITIES"
echo "LIVE_USER_CORE_INSPECT=PASS"
echo "LIVE_USER_PROMOTION=PASS"
echo "SNTSS_ATTACHED=NO"
echo "CHRONOBIOLOGY_ATTACHED=NO"
echo "FORWARD_RESTART_CONTINUITY=PASS"
echo "B0_SANDBOX_REPAIR_SEAL=WRITTEN"
echo "READY_FOR_SURGERY_B_PREFLIGHT=YES"
echo "B0_SANDBOX_REPAIR_EVIDENCE_DIGEST=$EVIDENCE_DIGEST"
echo "EVIDENCE_DIR=$EVIDENCE_DIR"
