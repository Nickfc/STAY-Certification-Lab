#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"
[[ "${STAY_B0_COMPLETE_AUTHORIZED:-NO}" == YES ]] || { echo "B0_COMPLETION_ABORT=authorization-missing" >&2; exit 300; }

A1_RELEASE="/opt/stay/releases/0.8.11.3-p1a1-resident-control-7d040592ccf1f149"
DATABASE="/var/lib/stay/data/continuity.sqlite3"
SOCKET="/run/stay/resident-control.sock"
DROPIN="/etc/systemd/system/stay.service.d/p1-b0-resident-runtime.conf"
KEY="/etc/stay/release-authority.pub"
CERT_DIR="/etc/stay/resident-promotions"
CERT="$CERT_DIR/resident-sntss.json"
BASELINE_SEAL="/etc/stay/p1-b0-baseline.env"
EVIDENCE_DIR="/var/lib/stay/evidence/live-physiology-transplant/p1-b0-20260823T115636Z"
FINGERPRINT_FILE="${1:-}"
NODE_BIN="$(command -v node)"
TEMP_AFTER=""
TEMP_COMPARE=""
TEMP_BASELINE=""
TEMP_SUMMARY=""
TEMP_DIGEST=""
BASELINE_TEMP=""

abort() { echo "B0_COMPLETION_ABORT=$1" >&2; exit "${2:-301}"; }
json_field() { "$NODE_BIN" -e 'const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],JSON.parse(process.argv[1]));process.stdout.write(String(v??""))' "$1" "$2"; }
proc_value() { tr '\0' '\n' < "/proc/$1/environ" | awk -F= -v key="$2" '$1==key {sub(/^[^=]*=/,"");print;found=1} END{if(!found)exit 1}'; }
root_regular() { [[ -f "$1" && ! -L "$1" && "$(stat -Lc '%U:%G:%h' "$1")" == root:root:1 ]]; }
cleanup_temps() { rm -f -- "$TEMP_AFTER" "$TEMP_COMPARE" "$TEMP_BASELINE" "$TEMP_SUMMARY" "$TEMP_DIGEST" "$BASELINE_TEMP" 2>/dev/null || true; }
trap cleanup_temps EXIT

[[ "$FINGERPRINT_FILE" =~ ^/opt/stay/incoming/p1-actions-[0-9]+/b0-completion-fingerprint.txt$ ]] || abort fingerprint-path-invalid 302
[[ -f "$FINGERPRINT_FILE" && ! -L "$FINGERPRINT_FILE" && "$(stat -Lc '%U:%G:%h' "$FINGERPRINT_FILE")" == staydeploy:staydeploy:1 ]] || abort fingerprint-file-invalid 303
FINGERPRINT="$(tr -d '\r\n' < "$FINGERPRINT_FILE")"
[[ "$FINGERPRINT" =~ ^[0-9a-f]{64}$ ]] || abort fingerprint-format-invalid 304

[[ -d "$EVIDENCE_DIR" && ! -L "$EVIDENCE_DIR" && "$(stat -Lc '%U:%G' "$EVIDENCE_DIR")" == root:root ]] || abort evidence-directory-invalid 305
for file in before-state.json certificate-verification.json dropin.expected; do
  root_regular "$EVIDENCE_DIR/$file" || abort "partial-evidence-${file}-invalid" 306
done
[[ ! -e "$EVIDENCE_DIR/after-state.json" ]] || abort after-state-already-exists 307
for file in completion-compare.json baseline.env completion-summary.env B0_EVIDENCE_DIGEST.txt; do
  [[ ! -e "$EVIDENCE_DIR/$file" ]] || abort "completion-evidence-${file}-already-exists" 307
done
[[ ! -e "$BASELINE_SEAL" ]] || abort baseline-seal-already-exists 308

[[ "$(readlink -f /opt/stay/current)" == "$A1_RELEASE" ]] || abort current-release-mismatch 309
[[ "$(systemctl show stay.service -p ActiveState --value)" == active && "$(systemctl show stay.service -p SubState --value)" == running ]] || abort service-not-running 310
[[ "$(systemctl show stay.service -p NRestarts --value)" == 0 ]] || abort current-incarnation-restarted 311
[[ "$(systemctl show stay.service -p Result --value)" == success ]] || abort service-result-not-success 312
PID="$(systemctl show stay.service -p MainPID --value)"; [[ "$PID" =~ ^[1-9][0-9]*$ ]] || abort service-pid-invalid 313
EXECSTART="$(systemctl show stay.service -p ExecStart --value)"
grep -Fq '/opt/stay/current/server-secure.js' <<<"$EXECSTART" || abort secure-entrypoint-not-loaded 314
grep -Fq '/opt/stay/current/server.js' <<<"$EXECSTART" && abort legacy-entrypoint-loaded 315
[[ -S "$SOCKET" && ! -L "$SOCKET" ]] || abort resident-control-unavailable 316

HEALTH="$($NODE_BIN "$SCRIPT_DIR/p1-b0-runtime-ready.js")" || abort socket-or-http-health-not-ready 317
[[ "$(json_field "$HEALTH" revision)" == 54 ]] || abort runtime-revision-not-54 318

[[ -f "$DROPIN" && ! -L "$DROPIN" && "$(stat -Lc '%U:%G:%a:%h' "$DROPIN")" == root:root:644:1 ]] || abort runtime-dropin-invalid 319
cmp -s "$EVIDENCE_DIR/dropin.expected" "$DROPIN" || abort runtime-dropin-content-mismatch 320
root_regular "$KEY" && [[ "$(stat -Lc '%a' "$KEY")" == 444 ]] || abort public-key-install-invalid 321
root_regular "$CERT" && [[ "$(stat -Lc '%a' "$CERT")" == 444 ]] || abort resident-certificate-install-invalid 322
[[ "$(sha256sum "$KEY" | awk '{print $1}')" == "$FINGERPRINT" ]] || abort installed-public-key-fingerprint-mismatch 323
[[ -x /usr/bin/bwrap && ! -L /usr/bin/bwrap && "$(stat -Lc '%U:%G' /usr/bin/bwrap)" == root:root ]] || abort bwrap-unavailable-or-untrusted 324
BWRAP_MODE="$(stat -Lc '%a' /usr/bin/bwrap)"; (( (8#$BWRAP_MODE & 8#022) == 0 )) || abort bwrap-writable 325

for item in STAY_REQUIRE_OS_CORE_SANDBOX=1 STAY_BWRAP=/usr/bin/bwrap STAY_REQUIRE_CORE_PACKAGE_POLICY=1 STAY_REQUIRE_CORE_PROMOTION_CERT=1 STAY_CORE_PROMOTION_PUBLIC_KEY=/etc/stay/release-authority.pub STAY_CORE_PROMOTION_CERT_DIR=/etc/stay/core-promotions STAY_RESIDENT_PROMOTION_CERT_DIR=/etc/stay/resident-promotions STAY_TRUSTED_TIME_PULSE_INTERVAL_MS=25; do
  key="${item%%=*}"; value="${item#*=}"
  [[ "$(proc_value "$PID" "$key" 2>/dev/null || true)" == "$value" ]] || abort "runtime-environment-${key}-mismatch" 326
done
"$NODE_BIN" "$SCRIPT_DIR/p1-surgery-b-state.js" promotion "$A1_RELEASE" "$DATABASE" "$KEY" "$CERT_DIR" >/dev/null || abort resident-certificate-invalid 327
SNTSS="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:sntss)" || abort sntss-status-failed 328
CHRONO="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:chronobiology)" || abort chronobiology-status-failed 329
[[ "$(json_field "$SNTSS" resident.present)" == false && "$(json_field "$CHRONO" resident.present)" == false ]] || abort resident-present 330

TEMP_AFTER="$(mktemp "$EVIDENCE_DIR/.after-state.json.XXXXXX")"
TEMP_COMPARE="$(mktemp "$EVIDENCE_DIR/.completion-compare.json.XXXXXX")"
TEMP_BASELINE="$(mktemp "$EVIDENCE_DIR/.baseline.env.XXXXXX")"
TEMP_SUMMARY="$(mktemp "$EVIDENCE_DIR/.completion-summary.env.XXXXXX")"
TEMP_DIGEST="$(mktemp "$EVIDENCE_DIR/.B0_EVIDENCE_DIGEST.txt.XXXXXX")"
"$NODE_BIN" "$SCRIPT_DIR/p1-b0-state.js" capture "$DATABASE" > "$TEMP_AFTER" || abort state-capture-failed 331
COMPARE="$($NODE_BIN "$SCRIPT_DIR/p1-b0-state.js" compare "$EVIDENCE_DIR/before-state.json" "$TEMP_AFTER")" || abort forward-continuity-failed 332
printf '%s\n' "$COMPARE" > "$TEMP_COMPARE"
AUTH_HASH="$(json_field "$COMPARE" authorityIdentityHash)"; ID_HASH="$(json_field "$COMPARE" organismIdentityHash)"
[[ "$(readlink -f /opt/stay/current)" == "$A1_RELEASE" && "$(systemctl show stay.service -p MainPID --value)" == "$PID" && "$(systemctl show stay.service -p NRestarts --value)" == 0 && "$(systemctl is-active stay.service)" == active ]] || abort preseal-live-incarnation-changed 332
FINAL_HEALTH="$($NODE_BIN "$SCRIPT_DIR/p1-b0-runtime-ready.js")" || abort preseal-runtime-not-ready 332
[[ "$(json_field "$FINAL_HEALTH" revision)" == 54 ]] || abort preseal-runtime-revision-changed 332
cat > "$TEMP_BASELINE" <<EOF
P1_B0_BASELINE_FORMAT=stay-p1-b0-baseline-v1
RUNTIME_REVISION=54
ORGANISM_IDENTITY_HASH=$ID_HASH
AUTHORITY_IDENTITY_HASH=$AUTH_HASH
TRUSTED_TIME_PULSE_INTERVAL_MS=25
PUBLIC_KEY_SHA256=$FINGERPRINT
EOF
cat > "$TEMP_SUMMARY" <<'EOF'
B0_COMPLETION_RESULT=PASS
B0_PROVISIONING_ALREADY_LIVE=YES
SERVICE_RESTARTED=NO
DAEMON_RELOAD=NO
CURRENT_POINTER_CHANGE=NO
STATESTORE_WRITE=NO
RESIDENT_OPERATION=NO
AUTHORITY_CHANGE=NO
RUNTIME_REVISION=54
STATESTORE_SCHEMA=4
EOF
chmod 0400 "$TEMP_AFTER" "$TEMP_COMPARE" "$TEMP_BASELINE" "$TEMP_SUMMARY" "$TEMP_DIGEST"

BASELINE_TEMP="$(mktemp /etc/stay/.p1-b0-baseline.env.XXXXXX)"
install -o root -g root -m 0444 "$TEMP_BASELINE" "$BASELINE_TEMP" || abort baseline-stage-failed 333
mv -nT "$BASELINE_TEMP" "$BASELINE_SEAL" || abort baseline-publish-failed 334
[[ ! -e "$BASELINE_TEMP" ]] || abort baseline-seal-race 334
BASELINE_TEMP=""
mv -fT "$TEMP_AFTER" "$EVIDENCE_DIR/after-state.json"; TEMP_AFTER=""
mv -fT "$TEMP_COMPARE" "$EVIDENCE_DIR/completion-compare.json"; TEMP_COMPARE=""
mv -fT "$TEMP_BASELINE" "$EVIDENCE_DIR/baseline.env"; TEMP_BASELINE=""
mv -fT "$TEMP_SUMMARY" "$EVIDENCE_DIR/completion-summary.env"; TEMP_SUMMARY=""
EVIDENCE_DIGEST="sha256:$(find "$EVIDENCE_DIR" -maxdepth 1 -type f ! -name '.*' ! -name B0_EVIDENCE_DIGEST.txt -printf '%f\n' | LC_ALL=C sort | while read -r f; do sha256sum "$EVIDENCE_DIR/$f"; done | sha256sum | awk '{print $1}')"
printf '%s\n' "$EVIDENCE_DIGEST" > "$TEMP_DIGEST"
mv -fT "$TEMP_DIGEST" "$EVIDENCE_DIR/B0_EVIDENCE_DIGEST.txt"; TEMP_DIGEST=""

echo "B0_COMPLETION_RESULT=PASS"
echo "B0_PROVISIONING_ALREADY_LIVE=YES"
echo "SERVICE_RESTARTED=NO"
echo "DAEMON_RELOAD=NO"
echo "CURRENT_POINTER_CHANGE=NO"
echo "STATESTORE_WRITE=NO"
echo "RESIDENT_OPERATION=NO"
echo "AUTHORITY_CHANGE=NO"
echo "CURRENT_RELEASE=$A1_RELEASE"
echo "ENTRYPOINT=server-secure.js"
echo "RUNTIME_REVISION=54"
echo "STATESTORE_SCHEMA=4"
echo "SIGNED_PROMOTION_ENFORCED=YES"
echo "PACKAGE_POLICY_ENFORCED=YES"
echo "OS_SANDBOX_ENFORCED=YES"
echo "TRUSTED_TIME_PULSE_INTERVAL_MS=25"
echo "RESIDENT_CERTIFICATE=VERIFIED"
echo "PRIVATE_KEY_ON_PRODUCTION=NO"
echo "SNTSS_ATTACHED=NO"
echo "CHRONOBIOLOGY_ATTACHED=NO"
echo "FORWARD_RESTART_CONTINUITY=PASS"
echo "B0_BASELINE_SEAL=WRITTEN"
echo "READY_FOR_SURGERY_B_PREFLIGHT=YES"
echo "B0_EVIDENCE_DIGEST=$EVIDENCE_DIGEST"
