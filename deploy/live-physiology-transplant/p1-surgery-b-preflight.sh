#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"
A1_RELEASE="/opt/stay/releases/0.8.11.3-p1a1-resident-control-7d040592ccf1f149"
DATABASE="/var/lib/stay/data/continuity.sqlite3"
SOCKET="/run/stay/resident-control.sock"
ENTRYPOINT_DROPIN="/etc/systemd/system/stay.service.d/p1-a1-resident-control.conf"
ENTRYPOINT_DROPIN_SHA256="cbf8dba3a63f14ebf56ea884ad5cbbf98b8887997d226a0eccee55df7ce5c830"
RUNTIME_DROPIN="/etc/systemd/system/stay.service.d/p1-b0-resident-runtime.conf"
SNTSS_TREE="5efc31371cfdca9e650ad3c8bc6d749f8f4df618"
NODE_BIN="$(command -v node)"
BASELINE_SEAL="/etc/stay/p1-b0-baseline.env"
REPAIR_SEAL="/etc/stay/p1-b0-sandbox-repair.env"
CAPABILITIES="CAP_SETGID CAP_SETUID CAP_NET_ADMIN CAP_SYS_CHROOT CAP_SYS_PTRACE CAP_SYS_ADMIN"
CAP_INH_HEX="0000000000200000"
CAP_BOUND_HEX="00000000002c10c0"
abort() { echo "PREFLIGHT_B_ABORT=$1" >&2; exit "${2:-220}"; }
json_field() { "$NODE_BIN" -e 'const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],JSON.parse(process.argv[1]));process.stdout.write(String(v??""))' "$1" "$2"; }
proc_value() { tr '\0' '\n' < "/proc/$1/environ" | awk -F= -v key="$2" '$1==key {sub(/^[^=]*=/,""); print; found=1} END{if(!found)exit 1}'; }
seal_value() { awk -F= -v key="$2" '$1==key {sub(/^[^=]*=/,""); print; found=1} END{if(!found)exit 1}' "$1"; }
status_value() { awk -v key="$2" '$1 == key ":" { print $2 }' "/proc/$1/status"; }
[[ "$(readlink -f /opt/stay/current)" == "$A1_RELEASE" ]] || abort unexpected-current-release 221
[[ "$(systemctl show stay.service -p ActiveState --value)" == active && "$(systemctl show stay.service -p SubState --value)" == running ]] || abort service-not-running 222
PID="$(systemctl show stay.service -p MainPID --value)"
[[ "$PID" =~ ^[1-9][0-9]*$ ]] || abort service-pid-invalid 223
EXECSTART="$(systemctl show stay.service -p ExecStart --value)"
grep -Fq '/opt/stay/current/server-secure.js' <<<"$EXECSTART" || abort secure-entrypoint-not-loaded 224
grep -Fq '/opt/stay/current/server.js' <<<"$EXECSTART" && abort legacy-entrypoint-loaded 225
[[ -f "$ENTRYPOINT_DROPIN" && ! -L "$ENTRYPOINT_DROPIN" && "$(sha256sum "$ENTRYPOINT_DROPIN" | awk '{print $1}')" == "$ENTRYPOINT_DROPIN_SHA256" ]] || abort entrypoint-dropin-invalid 226
[[ -S "$SOCKET" && ! -L "$SOCKET" ]] || abort resident-control-unavailable 227
HEALTH="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/healthz)" || abort health-failed 228
[[ -f "$BASELINE_SEAL" && ! -L "$BASELINE_SEAL" && "$(stat -Lc '%U:%G:%a' "$BASELINE_SEAL")" == root:root:444 ]] || abort b0-baseline-seal-invalid 229
grep -Fx 'P1_B0_BASELINE_FORMAT=stay-p1-b0-baseline-v1' "$BASELINE_SEAL" >/dev/null || abort b0-baseline-seal-format 229
grep -Fx 'RUNTIME_REVISION=54' "$BASELINE_SEAL" >/dev/null || abort b0-baseline-revision-unfrozen 229
[[ -f "$REPAIR_SEAL" && ! -L "$REPAIR_SEAL" && "$(stat -Lc '%U:%G:%a:%h' "$REPAIR_SEAL")" == root:root:444:1 ]] || abort b0-sandbox-repair-seal-invalid 229
grep -Fx 'P1_B0_SANDBOX_REPAIR_FORMAT=stay-p1-b0-sandbox-repair-v3' "$REPAIR_SEAL" >/dev/null || abort b0-sandbox-repair-seal-format 229
grep -Fx 'BASELINE_RUNTIME_REVISION=54' "$REPAIR_SEAL" >/dev/null || abort b0-sandbox-repair-baseline-mismatch 229
grep -Fx "CAPABILITY_BOUNDING_SET=$CAPABILITIES" "$REPAIR_SEAL" >/dev/null || abort b0-sandbox-repair-capabilities-mismatch 229
grep -Fx "CAPABILITY_BOUNDING_HEX=$CAP_BOUND_HEX" "$REPAIR_SEAL" >/dev/null || abort b0-sandbox-repair-capability-mask-mismatch 229
grep -Fx "SERVICE_INHERITABLE_CAPABILITIES_HEX=$CAP_INH_HEX" "$REPAIR_SEAL" >/dev/null || abort b0-sandbox-repair-inheritable-mask-mismatch 229
grep -Fx 'SERVICE_PERMITTED_CAPABILITIES=NONE' "$REPAIR_SEAL" >/dev/null || abort b0-sandbox-repair-permitted-capabilities-unsealed 229
grep -Fx 'LIVE_SERVICE_SANDBOX_CONTEXT=PASS' "$REPAIR_SEAL" >/dev/null || abort b0-sandbox-repair-service-context-unsealed 229
grep -Fx 'OUT_OF_PROCESS_SANDBOX_PROBE=NOT_APPLICABLE' "$REPAIR_SEAL" >/dev/null || abort b0-sandbox-repair-probe-contract-unsealed 229
grep -Fx 'SIGNED_PROMOTION=PASS' "$REPAIR_SEAL" >/dev/null || abort b0-sandbox-repair-promotion-unsealed 229
grep -Fx 'SERVICE_EFFECTIVE_CAPABILITIES=NONE' "$REPAIR_SEAL" >/dev/null || abort b0-sandbox-repair-service-capabilities-unsealed 229
grep -Fx 'SERVICE_AMBIENT_CAPABILITIES=NONE' "$REPAIR_SEAL" >/dev/null || abort b0-sandbox-repair-ambient-capabilities-unsealed 229
grep -Fx 'NO_NEW_PRIVILEGES=YES' "$REPAIR_SEAL" >/dev/null || abort b0-sandbox-repair-no-new-privileges-unsealed 229
grep -Fx 'LABORATORY_BYPASS=NO' "$REPAIR_SEAL" >/dev/null || abort b0-sandbox-repair-laboratory-bypass 229
REPAIRED_REVISION="$(seal_value "$REPAIR_SEAL" RUNTIME_REVISION_AFTER 2>/dev/null || true)"
[[ "$REPAIRED_REVISION" =~ ^[0-9]+$ ]] && (( REPAIRED_REVISION > 54 )) || abort b0-sandbox-repair-revision-invalid 229
[[ "$(json_field "$HEALTH" revision)" == "$REPAIRED_REVISION" ]] || abort runtime-revision-mismatch 229
[[ "$(seal_value "$REPAIR_SEAL" SERVICE_MAIN_PID 2>/dev/null || true)" == "$PID" ]] || abort repaired-service-incarnation-mismatch 229
REPAIRED_DROPIN_HASH="$(seal_value "$REPAIR_SEAL" DROPIN_SHA256 2>/dev/null || true)"
[[ "$REPAIRED_DROPIN_HASH" =~ ^[0-9a-f]{64}$ && -f "$RUNTIME_DROPIN" && ! -L "$RUNTIME_DROPIN" &&
   "$(stat -Lc '%U:%G:%a:%h' "$RUNTIME_DROPIN")" == root:root:644:1 &&
   "$(sha256sum "$RUNTIME_DROPIN" | awk '{print $1}')" == "$REPAIRED_DROPIN_HASH" ]] || abort repaired-runtime-dropin-invalid 229
[[ "$(status_value "$PID" CapInh)" == "$CAP_INH_HEX" ]] || abort service-CapInh-mismatch 229
for field in CapPrm CapEff CapAmb; do
  [[ "$(status_value "$PID" "$field")" == 0000000000000000 ]] || abort "service-${field}-not-empty" 229
done
[[ "$(status_value "$PID" CapBnd)" == "$CAP_BOUND_HEX" ]] || abort service-capability-bounding-set-mismatch 229
[[ "$(status_value "$PID" NoNewPrivs)" == 1 ]] || abort service-no-new-privileges-disabled 229
[[ "$(systemctl show stay.service -p NoNewPrivileges --value)" == yes ]] || abort systemd-no-new-privileges-disabled 229
[[ "$(seal_value "$REPAIR_SEAL" PUBLIC_KEY_SHA256 2>/dev/null || true)" == "$(sha256sum /etc/stay/release-authority.pub | awk '{print $1}')" ]] || abort repaired-public-key-mismatch 229
[[ "$(seal_value "$REPAIR_SEAL" RESIDENT_CERTIFICATE_SHA256 2>/dev/null || true)" == "$(sha256sum /etc/stay/resident-promotions/resident-sntss.json | awk '{print $1}')" ]] || abort repaired-resident-certificate-mismatch 229
META="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/__stay/meta)" || abort meta-failed 230
"$NODE_BIN" -e 'const m=JSON.parse(process.argv[1]);const f=m.cores?.find(x=>x.id==="fetus-legacy");if(m.ok!==true||!f||f.ok!==true||f.version!=="0.6.0")process.exit(1)' "$META" || abort fetus-health-mismatch 231

PROMOTION_REQUIRED="$(proc_value "$PID" STAY_REQUIRE_CORE_PROMOTION_CERT 2>/dev/null || true)"
[[ "$PROMOTION_REQUIRED" == 1 ]] || abort signed-promotion-not-required 232
PULSE_INTERVAL="$(proc_value "$PID" STAY_TRUSTED_TIME_PULSE_INTERVAL_MS 2>/dev/null || true)"
[[ "$PULSE_INTERVAL" == 25 ]] || abort trusted-pulse-scheduler-disabled 233
for pair in STAY_REQUIRE_OS_CORE_SANDBOX=1 STAY_BWRAP=/usr/bin/bwrap STAY_REQUIRE_CORE_PACKAGE_POLICY=1 STAY_REQUIRE_CORE_PROMOTION_CERT=1 STAY_CORE_PROMOTION_PUBLIC_KEY=/etc/stay/release-authority.pub STAY_CORE_PROMOTION_CERT_DIR=/etc/stay/core-promotions STAY_RESIDENT_PROMOTION_CERT_DIR=/etc/stay/resident-promotions; do
  key="${pair%%=*}"; expected="${pair#*=}"
  [[ "$(proc_value "$PID" "$key" 2>/dev/null || true)" == "$expected" ]] || abort b0-runtime-environment-mismatch 233
done
PUBLIC_KEY="$(proc_value "$PID" STAY_CORE_PROMOTION_PUBLIC_KEY 2>/dev/null || true)"; PUBLIC_KEY="${PUBLIC_KEY:-/etc/stay/release-authority.pub}"
CERT_DIR="$(proc_value "$PID" STAY_RESIDENT_PROMOTION_CERT_DIR 2>/dev/null || true)"; CERT_DIR="${CERT_DIR:-/etc/stay/resident-promotions}"
[[ "$PUBLIC_KEY" == /etc/stay/release-authority.pub && "$CERT_DIR" == /etc/stay/resident-promotions ]] || abort promotion-path-not-pinned 234

BASELINE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-b-state.js" baseline "$DATABASE")" || abort state-baseline-mismatch 235
PACKAGE="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-b-state.js" tree "$A1_RELEASE/cores/sntss/i3d")" || abort sntss-package-invalid 236
[[ "$(json_field "$PACKAGE" tree)" == "$SNTSS_TREE" ]] || abort sntss-package-tree-mismatch 237
PROMOTION="$($NODE_BIN "$SCRIPT_DIR/p1-surgery-b-state.js" promotion "$A1_RELEASE" "$DATABASE" "$PUBLIC_KEY" "$CERT_DIR")" || abort promotion-certificate-invalid 238
[[ "$(json_field "$PROMOTION" laboratoryBypass)" == false ]] || abort promotion-bypass-forbidden 239
SNTSS="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:sntss)" || abort sntss-status-failed 240
CHRONO="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:chronobiology)" || abort chronobiology-status-failed 241
[[ "$(json_field "$SNTSS" resident.present)" == false && "$(json_field "$CHRONO" resident.present)" == false ]] || abort resident-already-present 242
[[ "$(json_field "$SNTSS" resident.version)" == 0.4.0-i3d3 &&
   "$(json_field "$SNTSS" resident.stateSchema)" == 4 &&
   "$(json_field "$SNTSS" resident.productionEligible)" == false &&
   "$(json_field "$SNTSS" resident.signalling)" == FORBIDDEN &&
   "$(json_field "$SNTSS" resident.declaredOutputs)" == 0 &&
   "$(json_field "$SNTSS" resident.authorityOwned)" == false ]] || abort live-service-resident-contract-invalid 242

echo "PREFLIGHT_B_RESULT=PASS"
echo "CURRENT_RELEASE=$A1_RELEASE"
echo "ENTRYPOINT=server-secure.js"
echo "STATESTORE_SCHEMA=4"
echo "SERVICE_ACTIVE=YES"
echo "HEALTH=PASS"
echo "RUNTIME_REVISION=$REPAIRED_REVISION"
echo "FETUS_INSTANCE_ID=82202211-8dd6-44d4-a4ec-8f2553d8dc6f"
echo "FETUS_VERSION=0.6.0"
echo "FETUS_AUTHORITY_EPOCH=1"
echo "FETUS_BARRIER_SEQUENCE=0"
echo "FETUS_CHECKPOINT_GENERATION_MINIMUM=48"
echo "SNTSS_PACKAGE_TREE=$SNTSS_TREE"
echo "SIGNED_PROMOTION=PASS"
echo "LIVE_SERVICE_SANDBOX_CONTEXT=PASS"
echo "OUT_OF_PROCESS_SANDBOX_PROBE=NOT_APPLICABLE"
echo "SERVICE_INHERITABLE_CAPABILITIES_HEX=$CAP_INH_HEX"
echo "SERVICE_PERMITTED_CAPABILITIES=NONE"
echo "SERVICE_EFFECTIVE_CAPABILITIES=NONE"
echo "SERVICE_AMBIENT_CAPABILITIES=NONE"
echo "NO_NEW_PRIVILEGES=YES"
echo "CAPABILITY_BOUNDING_SET=$CAPABILITIES"
echo "TRUSTED_TIME_PULSE_INTERVAL_MS=$PULSE_INTERVAL"
echo "RESIDENT_SNTSS_PRESENT=NO"
echo "SNTSS_AUTHORITY_PRESENT=NO"
echo "CHRONOBIOLOGY_RESIDENT_PRESENT=NO"
echo "CHRONOBIOLOGY_AUTHORITY_PRESENT=NO"
echo "SERVICE_OPERATION=NO"
echo "CURRENT_POINTER_CHANGE=NO"
echo "STATESTORE_WRITE=NO"
echo "RESIDENT_OPERATION=NO"
echo "AUTHORITY_CHANGE=NO"
