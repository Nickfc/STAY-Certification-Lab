#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"
[[ "${STAY_B0_CONFIGURE_AUTHORIZED:-NO}" == YES ]] || { echo "B0_ABORT=authorization-missing" >&2; exit 260; }
TRUST_DIR="${1:-}"; EVIDENCE_PARENT="${2:-/var/lib/stay/evidence/live-physiology-transplant}"
A1_RELEASE="/opt/stay/releases/0.8.11.3-p1a1-resident-control-7d040592ccf1f149"
DATABASE="/var/lib/stay/data/continuity.sqlite3"
DROPIN="/etc/systemd/system/stay.service.d/p1-b0-resident-runtime.conf"
KEY="/etc/stay/release-authority.pub"; CERT_DIR="/etc/stay/resident-promotions"; CERT="$CERT_DIR/resident-sntss.json"
BASELINE_SEAL="/etc/stay/p1-b0-baseline.env"; SOCKET="/run/stay/resident-control.sock"; NODE_BIN="$(command -v node)"
abort() { echo "B0_ABORT=$1" >&2; exit "${2:-261}"; }
json_field() { "$NODE_BIN" -e 'const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],JSON.parse(process.argv[1]));process.stdout.write(String(v??""))' "$1" "$2"; }
proc_value() { tr '\0' '\n' < "/proc/$1/environ" | awk -F= -v key="$2" '$1==key {sub(/^[^=]*=/,"");print;found=1} END{if(!found)exit 1}'; }
install_atomic() { local source="$1" target="$2" mode="$3" temp; temp="$(mktemp "$(dirname "$target")/.p1-b0.XXXXXX")"; install -o root -g root -m "$mode" "$source" "$temp"; mv -fT "$temp" "$target"; }

"$SCRIPT_DIR/p1-b0-preflight.sh" >/dev/null || abort preflight-failed 262
[[ "$TRUST_DIR" =~ ^/opt/stay/incoming/p1-actions-[0-9]+/b0-trust-material$ && -d "$TRUST_DIR" && ! -L "$TRUST_DIR" ]] || abort trust-path-invalid 263
[[ -z "$(find -P "$TRUST_DIR" -xdev \( -type l -o -type b -o -type c -o -type p -o -type s \) -print -quit)" ]] || abort trust-special-file 264
[[ -z "$(find -P "$TRUST_DIR" -xdev -type f -links +1 -print -quit)" ]] || abort trust-hardlink 265
EXPECTED=$'INDEPENDENT_FINGERPRINT.txt\nP1_B0_TRUST_MATERIAL.sha256\nP1_B0_TRUST_MATERIAL.sha256.sig\nrelease-authority-public.pem\nresident-sntss.json'
[[ "$(find -P "$TRUST_DIR" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort)" == "$EXPECTED" ]] || abort trust-file-set-invalid 266
FINGERPRINT="$(tr -d '\r\n' < "$TRUST_DIR/INDEPENDENT_FINGERPRINT.txt")"
[[ "$FINGERPRINT" =~ ^[0-9a-f]{64}$ && "$(sha256sum "$TRUST_DIR/release-authority-public.pem" | awk '{print $1}')" == "$FINGERPRINT" ]] || abort independent-fingerprint-mismatch 267
/usr/bin/openssl pkeyutl -verify -pubin -rawin -inkey "$TRUST_DIR/release-authority-public.pem" -in "$TRUST_DIR/P1_B0_TRUST_MATERIAL.sha256" -sigfile "$TRUST_DIR/P1_B0_TRUST_MATERIAL.sha256.sig" >/dev/null 2>&1 || abort detached-signature-invalid 268
[[ "$(awk 'NF==2 {print $2}' "$TRUST_DIR/P1_B0_TRUST_MATERIAL.sha256" | LC_ALL=C sort)" == $'release-authority-public.pem\nresident-sntss.json' ]] || abort trust-manifest-scope-invalid 269
(cd "$TRUST_DIR" && sha256sum -c P1_B0_TRUST_MATERIAL.sha256 >/dev/null) || abort trust-manifest-hash-invalid 270
"$NODE_BIN" "$SCRIPT_DIR/p1-surgery-b-state.js" promotion "$A1_RELEASE" "$DATABASE" "$TRUST_DIR/release-authority-public.pem" "$TRUST_DIR" >/dev/null || abort resident-certificate-invalid 271

EVIDENCE_DIR="$EVIDENCE_PARENT/p1-b0-$(date -u +%Y%m%dT%H%M%SZ)"; install -d -o root -g root -m 0700 "$EVIDENCE_DIR"
"$NODE_BIN" "$SCRIPT_DIR/p1-b0-state.js" capture "$DATABASE" > "$EVIDENCE_DIR/before-state.json"
BEFORE_HEALTH="$(curl -fsS --max-time 5 http://127.0.0.1:8787/healthz)" || abort pre-restart-health-failed 272
BEFORE_REVISION="$(json_field "$BEFORE_HEALTH" revision)"; [[ "$BEFORE_REVISION" == 52 ]] || abort revision-raced 272
cat > "$EVIDENCE_DIR/dropin.expected" <<'EOF'
[Service]
CapabilityBoundingSet=CAP_SETGID CAP_SETUID CAP_NET_ADMIN CAP_SYS_CHROOT CAP_SYS_PTRACE CAP_SYS_ADMIN
Environment=STAY_REQUIRE_OS_CORE_SANDBOX=1
Environment=STAY_BWRAP=/usr/bin/bwrap
Environment=STAY_REQUIRE_CORE_PACKAGE_POLICY=1
Environment=STAY_REQUIRE_CORE_PROMOTION_CERT=1
Environment=STAY_CORE_PROMOTION_PUBLIC_KEY=/etc/stay/release-authority.pub
Environment=STAY_CORE_PROMOTION_CERT_DIR=/etc/stay/core-promotions
Environment=STAY_RESIDENT_PROMOTION_CERT_DIR=/etc/stay/resident-promotions
Environment=STAY_TRUSTED_TIME_PULSE_INTERVAL_MS=25
EOF
install -d -o root -g root -m 0755 /etc/stay /etc/stay/core-promotions /etc/stay/resident-promotions /etc/systemd/system/stay.service.d
install_atomic "$TRUST_DIR/release-authority-public.pem" "$KEY" 0444
install_atomic "$TRUST_DIR/resident-sntss.json" "$CERT" 0444
install_atomic "$EVIDENCE_DIR/dropin.expected" "$DROPIN" 0644
systemctl daemon-reload || abort daemon-reload-failed 273
systemctl restart stay.service || abort restart-failed 274
HEALTH="$($NODE_BIN "$SCRIPT_DIR/p1-b0-runtime-ready.js")" || abort service-socket-or-http-health-not-ready 275
[[ "$(systemctl is-active stay.service)" == active && -S "$SOCKET" && ! -L "$SOCKET" ]] || abort service-or-socket-failed 275
PID="$(systemctl show stay.service -p MainPID --value)"; EXECSTART="$(systemctl show stay.service -p ExecStart --value)"
grep -Fq '/opt/stay/current/server-secure.js' <<<"$EXECSTART" || abort secure-entrypoint-lost 276
for item in STAY_REQUIRE_OS_CORE_SANDBOX=1 STAY_BWRAP=/usr/bin/bwrap STAY_REQUIRE_CORE_PACKAGE_POLICY=1 STAY_REQUIRE_CORE_PROMOTION_CERT=1 STAY_CORE_PROMOTION_PUBLIC_KEY=/etc/stay/release-authority.pub STAY_CORE_PROMOTION_CERT_DIR=/etc/stay/core-promotions STAY_RESIDENT_PROMOTION_CERT_DIR=/etc/stay/resident-promotions STAY_TRUSTED_TIME_PULSE_INTERVAL_MS=25; do key="${item%%=*}"; value="${item#*=}"; [[ "$(proc_value "$PID" "$key")" == "$value" ]] || abort runtime-environment-mismatch 277; done
"$NODE_BIN" "$SCRIPT_DIR/p1-surgery-b-state.js" promotion "$A1_RELEASE" "$DATABASE" "$KEY" "$CERT_DIR" > "$EVIDENCE_DIR/certificate-verification.json" || abort installed-certificate-invalid 278
SNTSS="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:sntss)"; CHRONO="$($NODE_BIN "$SCRIPT_DIR/p1-resident-control-client.js" status resident:chronobiology)"
[[ "$(json_field "$SNTSS" resident.present)" == false && "$(json_field "$CHRONO" resident.present)" == false ]] || abort resident-activated 279
AFTER_REVISION="$(json_field "$HEALTH" revision)"
[[ "$AFTER_REVISION" =~ ^[0-9]+$ && "$BEFORE_REVISION" =~ ^[0-9]+$ ]] || abort post-restart-revision-invalid 280
(( AFTER_REVISION > BEFORE_REVISION )) || abort post-restart-revision-not-forward 280
"$NODE_BIN" "$SCRIPT_DIR/p1-b0-state.js" capture "$DATABASE" > "$EVIDENCE_DIR/after-state.json"
COMPARE="$($NODE_BIN "$SCRIPT_DIR/p1-b0-state.js" compare "$EVIDENCE_DIR/before-state.json" "$EVIDENCE_DIR/after-state.json")" || abort forward-continuity-failed 281
AUTH_HASH="$(json_field "$COMPARE" authorityIdentityHash)"; ID_HASH="$(json_field "$COMPARE" organismIdentityHash)"
cat > "$EVIDENCE_DIR/baseline.env" <<EOF
P1_B0_BASELINE_FORMAT=stay-p1-b0-baseline-v1
RUNTIME_REVISION=$AFTER_REVISION
ORGANISM_IDENTITY_HASH=$ID_HASH
AUTHORITY_IDENTITY_HASH=$AUTH_HASH
TRUSTED_TIME_PULSE_INTERVAL_MS=25
PUBLIC_KEY_SHA256=$FINGERPRINT
EOF
install_atomic "$EVIDENCE_DIR/baseline.env" "$BASELINE_SEAL" 0444
EVIDENCE_DIGEST="sha256:$(find "$EVIDENCE_DIR" -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort | while read -r f; do sha256sum "$EVIDENCE_DIR/$f"; done | sha256sum | awk '{print $1}')"
echo "B0_RESULT=PASS"
echo "CURRENT_RELEASE=$A1_RELEASE"
echo "ENTRYPOINT=server-secure.js"
echo "RUNTIME_REVISION_BEFORE=$BEFORE_REVISION"
echo "RUNTIME_REVISION_AFTER=$AFTER_REVISION"
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
echo "B0_EVIDENCE_DIGEST=$EVIDENCE_DIGEST"