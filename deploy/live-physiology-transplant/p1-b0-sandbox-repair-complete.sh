#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"
[[ "${STAY_B0_SANDBOX_REPAIR_COMPLETE_AUTHORIZED:-NO}" == YES ]] || {
  echo "B0_SANDBOX_REPAIR_COMPLETION_ABORT=authorization-missing" >&2
  exit 390
}

A1_RELEASE="/opt/stay/releases/0.8.11.3-p1a1-resident-control-7d040592ccf1f149"
DATABASE="/var/lib/stay/data/continuity.sqlite3"
SOCKET="/run/stay/resident-control.sock"
DROPIN="/etc/systemd/system/stay.service.d/p1-b0-resident-runtime.conf"
BASELINE_SEAL="/etc/stay/p1-b0-baseline.env"
REPAIR_SEAL="/etc/stay/p1-b0-sandbox-repair.env"
BASELINE_EVIDENCE="/var/lib/stay/evidence/live-physiology-transplant/p1-b0-20260823T115636Z"
EVIDENCE_PARENT="${1:-/var/lib/stay/evidence/live-physiology-transplant}"
KEY="/etc/stay/release-authority.pub"
CERT_DIR="/etc/stay/resident-promotions"
CERT="$CERT_DIR/resident-sntss.json"
NODE_BIN="$(command -v node)"
EXPECTED_PID="82673"
EXPECTED_REVISION="56"
EXPECTED_DROPIN_SHA256="6225ba2a5b89031cf73fa12ff7fd959a798c3e8518db3c5be9c970983f29f71f"
CAPABILITIES="CAP_SETGID CAP_SETUID CAP_NET_ADMIN CAP_SYS_CHROOT CAP_SYS_PTRACE CAP_SYS_ADMIN"
CAP_INH_HEX="0000000000200000"
CAP_BOUND_HEX="00000000002c10c0"
ZERO_CAP_HEX="0000000000000000"
TEMP_COMPLETION=""
TEMP_SEAL=""

abort() { echo "B0_SANDBOX_REPAIR_COMPLETION_ABORT=$1" >&2; exit "${2:-391}"; }
json_field() { "$NODE_BIN" -e 'const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],JSON.parse(process.argv[1]));process.stdout.write(String(v??""))' "$1" "$2"; }
seal_value() { awk -F= -v key="$2" '$1==key {sub(/^[^=]*=/,""); print; found=1} END{if(!found)exit 1}' "$1"; }
status_value() { awk -v key="$2" '$1 == key ":" { print $2 }' "/proc/$1/status"; }
proc_value() { tr '\0' '\n' < "/proc/$1/environ" | awk -F= -v key="$2" '$1==key {sub(/^[^=]*=/,""); print; found=1} END{if(!found)exit 1}'; }
root_regular() { [[ -f "$1" && ! -L "$1" && "$(stat -Lc '%U:%G:%h' "$1")" == root:root:1 ]]; }
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
cleanup() {
  rm -f -- "$TEMP_SEAL" 2>/dev/null || true
  if [[ -n "$TEMP_COMPLETION" && "$TEMP_COMPLETION" == "$EVIDENCE_PARENT"/.b0-sandbox-repair-completion.* &&
        -d "$TEMP_COMPLETION" && ! -L "$TEMP_COMPLETION" ]]; then
    rm -rf --one-file-system -- "$TEMP_COMPLETION" 2>/dev/null || true
  fi
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || abort root-required 392
[[ "$EVIDENCE_PARENT" == /var/lib/stay/evidence/live-physiology-transplant ]] || abort evidence-parent-invalid 393
[[ ! -e "$REPAIR_SEAL" && ! -L "$REPAIR_SEAL" ]] || abort repair-already-sealed 394
[[ "$(readlink -f /opt/stay/current)" == "$A1_RELEASE" ]] || abort current-release-mismatch 395

mapfile -d '' PARTIAL_DIRS < <(
  find -P "$EVIDENCE_PARENT" -mindepth 1 -maxdepth 1 -type d \
    -name 'b0-sandbox-repair-20260823T1636??Z' -print0
)
[[ "${#PARTIAL_DIRS[@]}" -eq 1 ]] || abort partial-evidence-directory-not-unique 396
EVIDENCE_DIR="${PARTIAL_DIRS[0]}"
EVIDENCE_DIR_MODE="$(stat -Lc '%a' "$EVIDENCE_DIR")" || abort partial-evidence-directory-invalid 397
[[ "$EVIDENCE_DIR" =~ ^/var/lib/stay/evidence/live-physiology-transplant/b0-sandbox-repair-20260823T1636[0-9]{2}Z$ &&
   -d "$EVIDENCE_DIR" && ! -L "$EVIDENCE_DIR" &&
   "$(stat -Lc '%U:%G' "$EVIDENCE_DIR")" == root:root &&
   ( "$EVIDENCE_DIR_MODE" == 700 || "$EVIDENCE_DIR_MODE" == 2700 ) ]] || abort partial-evidence-directory-invalid 397

EXPECTED_INITIAL_FILES=$'dropin-before.conf\nhealth-before.json\nlive-user-probe-before.txt\nphysiology-before.json\nservice-before.txt\nstate-before.json'
OBSERVED_INITIAL_FILES="$(find -P "$EVIDENCE_DIR" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort)"
[[ "$OBSERVED_INITIAL_FILES" == "$EXPECTED_INITIAL_FILES" ]] || abort partial-evidence-file-set-changed 398
[[ -z "$(find -P "$EVIDENCE_DIR" -mindepth 1 -maxdepth 1 \( ! -type f \) -print -quit)" ]] || abort partial-evidence-special-entry 399
while IFS= read -r file; do
  root_regular "$EVIDENCE_DIR/$file" || abort "partial-evidence-${file}-invalid" 400
done <<< "$EXPECTED_INITIAL_FILES"

PRE_HEALTH="$(<"$EVIDENCE_DIR/health-before.json")"
[[ "$(json_field "$PRE_HEALTH" revision)" == 54 ]] || abort partial-evidence-pre-revision-invalid 401
grep -Fx 'MainPID=77214' "$EVIDENCE_DIR/service-before.txt" >/dev/null || abort partial-evidence-pre-pid-invalid 402
grep -Fx 'NRestarts=0' "$EVIDENCE_DIR/service-before.txt" >/dev/null || abort partial-evidence-pre-restarts-invalid 403
grep -Fq 'ERROR_CODE=CORE_WORKER_EXIT' "$EVIDENCE_DIR/live-user-probe-before.txt" || abort partial-evidence-error-class-changed 404
grep -Fq 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' "$EVIDENCE_DIR/live-user-probe-before.txt" || abort partial-evidence-root-cause-changed 405
cmp -s "$BASELINE_EVIDENCE/dropin.expected" "$EVIDENCE_DIR/dropin-before.conf" || abort partial-evidence-old-dropin-mismatch 406
[[ "$(json_field "$(<"$EVIDENCE_DIR/physiology-before.json")" status)" == PASS ]] || abort partial-evidence-physiology-invalid 407

[[ "$(systemctl show stay.service -p ActiveState --value)" == active &&
   "$(systemctl show stay.service -p SubState --value)" == running &&
   "$(systemctl show stay.service -p NRestarts --value)" == 0 &&
   "$(systemctl show stay.service -p Result --value)" == success ]] || abort service-precondition-failed 408
PID="$(systemctl show stay.service -p MainPID --value)"
[[ "$PID" == "$EXPECTED_PID" ]] || abort live-incarnation-mismatch 409
POINTER="$(readlink -f /opt/stay/current)"
HEALTH="$($NODE_BIN "$SCRIPT_DIR/p1-b0-runtime-ready.js")" || abort runtime-not-ready 410
[[ "$(json_field "$HEALTH" revision)" == "$EXPECTED_REVISION" ]] || abort runtime-revision-mismatch 411
[[ -S "$SOCKET" && ! -L "$SOCKET" ]] || abort resident-control-unavailable 412

[[ -f "$BASELINE_SEAL" && ! -L "$BASELINE_SEAL" && "$(stat -Lc '%U:%G:%a:%h' "$BASELINE_SEAL")" == root:root:444:1 ]] || abort baseline-seal-invalid 413
grep -Fx 'P1_B0_BASELINE_FORMAT=stay-p1-b0-baseline-v1' "$BASELINE_SEAL" >/dev/null || abort baseline-seal-format 414
grep -Fx 'RUNTIME_REVISION=54' "$BASELINE_SEAL" >/dev/null || abort baseline-seal-revision 415
[[ -f "$DROPIN" && ! -L "$DROPIN" && "$(stat -Lc '%U:%G:%a:%h' "$DROPIN")" == root:root:644:1 &&
   "$(sha256sum "$DROPIN" | awk '{print $1}')" == "$EXPECTED_DROPIN_SHA256" ]] || abort repaired-dropin-invalid 416
root_regular "$KEY" && [[ "$(stat -Lc '%a' "$KEY")" == 444 ]] || abort public-key-invalid 417
root_regular "$CERT" && [[ "$(stat -Lc '%a' "$CERT")" == 444 ]] || abort resident-certificate-invalid 418
KEY_HASH="$(sha256sum "$KEY" | awk '{print $1}')"
CERT_HASH="$(sha256sum "$CERT" | awk '{print $1}')"
[[ "$(seal_value "$BASELINE_SEAL" PUBLIC_KEY_SHA256 2>/dev/null || true)" == "$KEY_HASH" ]] || abort public-key-baseline-mismatch 419

[[ "$(status_value "$PID" CapInh)" == "$CAP_INH_HEX" ]] || abort service-CapInh-mismatch 420
for field in CapPrm CapEff CapAmb; do
  [[ "$(status_value "$PID" "$field")" == "$ZERO_CAP_HEX" ]] || abort "service-${field}-not-empty" 421
done
[[ "$(status_value "$PID" CapBnd)" == "$CAP_BOUND_HEX" ]] || abort service-CapBnd-mismatch 422
[[ "$(status_value "$PID" NoNewPrivs)" == 1 ]] || abort no-new-privileges-disabled 423
[[ "$(systemctl show stay.service -p NoNewPrivileges --value)" == yes ]] || abort systemd-no-new-privileges-disabled 424
for pair in STAY_REQUIRE_OS_CORE_SANDBOX=1 STAY_BWRAP=/usr/bin/bwrap STAY_REQUIRE_CORE_PACKAGE_POLICY=1 STAY_REQUIRE_CORE_PROMOTION_CERT=1 STAY_CORE_PROMOTION_PUBLIC_KEY=/etc/stay/release-authority.pub STAY_CORE_PROMOTION_CERT_DIR=/etc/stay/core-promotions STAY_RESIDENT_PROMOTION_CERT_DIR=/etc/stay/resident-promotions STAY_TRUSTED_TIME_PULSE_INTERVAL_MS=25; do
  key="${pair%%=*}"; expected="${pair#*=}"
  [[ "$(proc_value "$PID" "$key" 2>/dev/null || true)" == "$expected" ]] || abort runtime-environment-mismatch 425
done

LIVE_USER_PROBE="$(run_live_user_probe 2>&1)" || abort live-user-probe-failed 426
grep -Fx 'LIVE_USER_CORE_INSPECT=PASS' <<<"$LIVE_USER_PROBE" >/dev/null || abort live-user-inspect-marker-missing 427
grep -Fx 'LIVE_USER_PROMOTION=PASS' <<<"$LIVE_USER_PROBE" >/dev/null || abort live-user-promotion-marker-missing 428
grep -Fx 'LABORATORY_BYPASS=NO' <<<"$LIVE_USER_PROBE" >/dev/null || abort laboratory-bypass-detected 429
PROMOTION="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-b-state.js" promotion "$A1_RELEASE" "$DATABASE" "$KEY" "$CERT_DIR")" || abort signed-promotion-invalid 430
[[ "$(json_field "$PROMOTION" laboratoryBypass)" == false ]] || abort promotion-bypass-forbidden 431
PHYSIOLOGY="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-b-state.js" baseline "$DATABASE")" || abort physiology-baseline-invalid 432
SNTSS="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:sntss)" || abort sntss-status-failed 433
CHRONO="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:chronobiology)" || abort chronobiology-status-failed 434
[[ "$(json_field "$SNTSS" resident.present)" == false && "$(json_field "$CHRONO" resident.present)" == false ]] || abort resident-activated 435

TEMP_COMPLETION="$(mktemp -d "$EVIDENCE_PARENT/.b0-sandbox-repair-completion.XXXXXX")" || abort completion-temp-create 436
[[ ! -e "$EVIDENCE_DIR/completion" && ! -L "$EVIDENCE_DIR/completion" ]] || abort completion-evidence-already-exists 437
printf '%s\n' "$HEALTH" > "$TEMP_COMPLETION/health-after.json"
"$NODE_BIN" "$SCRIPT_DIR/p1-surgery-a1-state.js" capture "$DATABASE" > "$TEMP_COMPLETION/state-after.json" || abort post-state-capture 438
COMPARE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-a1-state.js" compare "$EVIDENCE_DIR/state-before.json" "$TEMP_COMPLETION/state-after.json")" || abort forward-continuity-failed 439
printf '%s\n' "$COMPARE" > "$TEMP_COMPLETION/continuity.json"
printf '%s\n' "$PHYSIOLOGY" > "$TEMP_COMPLETION/physiology-after.json"
printf '%s\n' "$PROMOTION" > "$TEMP_COMPLETION/promotion-after.json"
printf '%s\n' "$SNTSS" > "$TEMP_COMPLETION/sntss-status.json"
printf '%s\n' "$CHRONO" > "$TEMP_COMPLETION/chronobiology-status.json"
printf '%s\n' "$LIVE_USER_PROBE" > "$TEMP_COMPLETION/live-user-probe-after.txt"
systemctl show stay.service -p MainPID,NRestarts,ActiveState,SubState,Result,ExecStart,CapabilityBoundingSet,AmbientCapabilities,NoNewPrivileges --no-pager > "$TEMP_COMPLETION/service-after.txt"
cp --preserve=mode,timestamps "$DROPIN" "$TEMP_COMPLETION/dropin-after.conf"
for field in CapInh CapPrm CapEff CapBnd CapAmb NoNewPrivs; do
  printf '%s=%s\n' "$field" "$(status_value "$PID" "$field")"
done > "$TEMP_COMPLETION/capability-status.env"
cat > "$TEMP_COMPLETION/completion-summary.env" <<EOF
B0_SANDBOX_REPAIR_COMPLETION_RESULT=PASS
ROOT_CAUSE=EMPTY_CAPABILITY_BOUNDING_SET_BLOCKED_BWRAP_NAMESPACE_SETUP
PARTIAL_REPAIR_ABORT=service-CapInh-not-empty
RUNTIME_REVISION_BEFORE=54
RUNTIME_REVISION_AFTER=$EXPECTED_REVISION
SERVICE_MAIN_PID=$EXPECTED_PID
SERVICE_RESTARTED_DURING_COMPLETION=NO
DAEMON_RELOAD_DURING_COMPLETION=NO
CURRENT_POINTER_CHANGE=NO
STATESTORE_WRITE=NO
RESIDENT_OPERATION=NO
AUTHORITY_CHANGE=NO
EOF
chown -R root:root "$TEMP_COMPLETION"
find -P "$TEMP_COMPLETION" -type f -exec chmod 0400 {} +
chmod 0700 "$TEMP_COMPLETION"

[[ "$(systemctl show stay.service -p MainPID --value)" == "$PID" &&
   "$(systemctl show stay.service -p NRestarts --value)" == 0 &&
   "$(readlink -f /opt/stay/current)" == "$POINTER" ]] || abort live-incarnation-changed 440
FINAL_HEALTH="$($NODE_BIN "$SCRIPT_DIR/p1-b0-runtime-ready.js")" || abort final-runtime-not-ready 441
[[ "$(json_field "$FINAL_HEALTH" revision)" == "$EXPECTED_REVISION" ]] || abort final-runtime-revision-changed 442

mv -nT "$TEMP_COMPLETION" "$EVIDENCE_DIR/completion" || abort completion-evidence-publish 443
TEMP_COMPLETION=""
EVIDENCE_DIGEST="sha256:$(cd "$EVIDENCE_DIR" && find -P . -type f ! -path './completion/evidence-digest.txt' -printf '%P\n' | LC_ALL=C sort | while read -r file; do sha256sum "$file"; done | sha256sum | awk '{print $1}')"
printf '%s\n' "$EVIDENCE_DIGEST" > "$EVIDENCE_DIR/completion/evidence-digest.txt"
chown root:root "$EVIDENCE_DIR/completion/evidence-digest.txt"
chmod 0400 "$EVIDENCE_DIR/completion/evidence-digest.txt"

TEMP_SEAL="$(mktemp /etc/stay/.p1-b0-sandbox-repair.env.XXXXXX)" || abort repair-seal-temp-create 444
cat > "$TEMP_SEAL" <<EOF
P1_B0_SANDBOX_REPAIR_FORMAT=stay-p1-b0-sandbox-repair-v2
BASELINE_RUNTIME_REVISION=54
RUNTIME_REVISION_AFTER=$EXPECTED_REVISION
SERVICE_MAIN_PID=$EXPECTED_PID
CAPABILITY_BOUNDING_SET=$CAPABILITIES
CAPABILITY_BOUNDING_HEX=$CAP_BOUND_HEX
SERVICE_INHERITABLE_CAPABILITIES_HEX=$CAP_INH_HEX
SERVICE_PERMITTED_CAPABILITIES=NONE
SERVICE_EFFECTIVE_CAPABILITIES=NONE
SERVICE_AMBIENT_CAPABILITIES=NONE
NO_NEW_PRIVILEGES=YES
DROPIN_SHA256=$EXPECTED_DROPIN_SHA256
PUBLIC_KEY_SHA256=$KEY_HASH
RESIDENT_CERTIFICATE_SHA256=$CERT_HASH
ORGANISM_IDENTITY_HASH=$(json_field "$COMPARE" organismIdentityHash)
AUTHORITY_IDENTITY_HASH=$(json_field "$COMPARE" authorityIdentityHash)
LIVE_USER_INSPECT=PASS
LIVE_USER_PROMOTION=PASS
LABORATORY_BYPASS=NO
REPAIR_COMPLETION_SERVICE_OPERATION=NO
REPAIR_EVIDENCE_DIR=$EVIDENCE_DIR
REPAIR_EVIDENCE_DIGEST=$EVIDENCE_DIGEST
EOF
chown root:root "$TEMP_SEAL" && chmod 0444 "$TEMP_SEAL" || abort repair-seal-permissions 445
mv -nT "$TEMP_SEAL" "$REPAIR_SEAL" || abort repair-seal-publish 446
TEMP_SEAL=""

echo "B0_SANDBOX_REPAIR_COMPLETION_RESULT=PASS"
echo "ROOT_CAUSE=EMPTY_CAPABILITY_BOUNDING_SET_BLOCKED_BWRAP_NAMESPACE_SETUP"
echo "CURRENT_RELEASE=$A1_RELEASE"
echo "CURRENT_POINTER_CHANGE=NO"
echo "TRUST_MATERIAL_CHANGE=NO"
echo "STATESTORE_SCHEMA=4"
echo "STATESTORE_WRITE=NO"
echo "RESIDENT_OPERATION=NO"
echo "AUTHORITY_CHANGE=NO"
echo "SERVICE_RESTARTED=NO"
echo "DAEMON_RELOAD=NO"
echo "RUNTIME_REVISION_BEFORE=54"
echo "RUNTIME_REVISION_AFTER=$EXPECTED_REVISION"
echo "SERVICE_INHERITABLE_CAPABILITIES_HEX=$CAP_INH_HEX"
echo "SERVICE_PERMITTED_CAPABILITIES=NONE"
echo "SERVICE_EFFECTIVE_CAPABILITIES=NONE"
echo "SERVICE_AMBIENT_CAPABILITIES=NONE"
echo "NO_NEW_PRIVILEGES=YES"
echo "CAPABILITY_BOUNDING_SET=$CAPABILITIES"
echo "LIVE_USER_CORE_INSPECT=PASS"
echo "LIVE_USER_PROMOTION=PASS"
echo "LABORATORY_BYPASS=NO"
echo "SNTSS_ATTACHED=NO"
echo "CHRONOBIOLOGY_ATTACHED=NO"
echo "FORWARD_RESTART_CONTINUITY=PASS"
echo "B0_SANDBOX_REPAIR_SEAL=WRITTEN"
echo "READY_FOR_SURGERY_B_PREFLIGHT=YES"
echo "B0_SANDBOX_REPAIR_EVIDENCE_DIGEST=$EVIDENCE_DIGEST"
echo "EVIDENCE_DIR=$EVIDENCE_DIR"
