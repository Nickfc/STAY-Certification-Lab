#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

EXPECTED_PRIVATE_IPV4="172.26.9.207"
EXPECTED_WRAPPER_SHA256="1792803754a068775c244a4a56e6197349032dfbecf158db3cfa828d2f76ec3b"
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_WRAPPER="$SCRIPT_DIR/stay-p1-production-controller"
TARGET_WRAPPER="/usr/local/sbin/stay-p1-production-controller"
TARGET_SUDOERS="/etc/sudoers.d/stay-p1-production-controller"

[[ "${EUID}" -eq 0 ]] || {
  echo "P1_BOOTSTRAP_ABORT=root-required" >&2
  exit 60
}
command -v ip >/dev/null 2>&1 || {
  echo "P1_BOOTSTRAP_ABORT=ip-command-unavailable" >&2
  exit 61
}
OBSERVED_PRIVATE_IPV4="$(
  ip -o -4 addr show scope global |
    awk '{address=$4; sub(/\/.*/, "", address); print address}' |
    sort -u
)"
[[ "$OBSERVED_PRIVATE_IPV4" == "$EXPECTED_PRIVATE_IPV4" ]] || {
  echo "LIVE_HOST_EXPECTED_PRIVATE_IPV4=$EXPECTED_PRIVATE_IPV4" >&2
  echo "OBSERVED_PRIVATE_IPV4=${OBSERVED_PRIVATE_IPV4:-NONE}" >&2
  echo "P1_BOOTSTRAP_ABORT=host-identity-mismatch" >&2
  exit 62
}
[[ -f "$SOURCE_WRAPPER" && ! -L "$SOURCE_WRAPPER" ]] || {
  echo "P1_BOOTSTRAP_ABORT=wrapper-source-invalid" >&2
  exit 63
}
[[ "$(sha256sum "$SOURCE_WRAPPER" | awk '{print $1}')" == "$EXPECTED_WRAPPER_SHA256" ]] || {
  echo "P1_BOOTSTRAP_ABORT=wrapper-source-hash-mismatch" >&2
  exit 64
}
command -v visudo >/dev/null 2>&1 || {
  echo "P1_BOOTSTRAP_ABORT=visudo-unavailable" >&2
  exit 65
}
id staydeploy >/dev/null 2>&1 || {
  echo "P1_BOOTSTRAP_ABORT=staydeploy-user-missing" >&2
  exit 66
}

STAGING="$(mktemp -d /run/stay-p1-bootstrap.XXXXXX)"
trap 'rm -rf -- "$STAGING"' EXIT
SUDOERS_STAGED="$STAGING/stay-p1-production-controller.sudoers"
cat > "$SUDOERS_STAGED" <<'SUDOERS'
Defaults!/usr/local/sbin/stay-p1-production-controller env_reset
Defaults!/usr/local/sbin/stay-p1-production-controller !setenv
staydeploy ALL=(root) NOPASSWD: /usr/local/sbin/stay-p1-production-controller
SUDOERS
chmod 0440 "$SUDOERS_STAGED"
visudo -cf "$SUDOERS_STAGED" >/dev/null

install -d -o root -g root -m 0755 /usr/local/sbin
install -o root -g root -m 0555 "$SOURCE_WRAPPER" "$STAGING/stay-p1-production-controller"
install -o root -g root -m 0555 \
  "$STAGING/stay-p1-production-controller" "$TARGET_WRAPPER"
install -o root -g root -m 0440 "$SUDOERS_STAGED" "$TARGET_SUDOERS"

[[ "$(stat -c '%U:%G:%a' "$TARGET_WRAPPER")" == "root:root:555" ]] || {
  echo "P1_BOOTSTRAP_ABORT=installed-wrapper-mode-invalid" >&2
  exit 67
}
[[ "$(sha256sum "$TARGET_WRAPPER" | awk '{print $1}')" == "$EXPECTED_WRAPPER_SHA256" ]] || {
  echo "P1_BOOTSTRAP_ABORT=installed-wrapper-hash-invalid" >&2
  exit 68
}
[[ "$(stat -c '%U:%G:%a' "$TARGET_SUDOERS")" == "root:root:440" ]] || {
  echo "P1_BOOTSTRAP_ABORT=installed-sudoers-mode-invalid" >&2
  exit 69
}
visudo -cf "$TARGET_SUDOERS" >/dev/null

echo "P1_PRIVILEGED_BRIDGE_BOOTSTRAP=PASS"
echo "HOST_IDENTITY_GUARD=PASS"
echo "OBSERVED_PRIVATE_IPV4=$OBSERVED_PRIVATE_IPV4"
echo "ROOT_WRAPPER=$TARGET_WRAPPER"
echo "ROOT_WRAPPER_SHA256=sha256:$EXPECTED_WRAPPER_SHA256"
echo "SUDOERS_SCOPE=STAYDEPLOY_TO_PINNED_P1_CONTROLLER_ONLY"
echo "SURGERY_A_AUTHORIZED=NO"
echo "ROLLBACK_A_AUTHORIZED=NO"
echo "SURGERY_A1_AUTHORIZED=NO"
echo "ROLLBACK_A1_AUTHORIZED=NO"
echo "A1_ENTRYPOINT_CORRECTION_AUTHORIZED=NO"
echo "A1_ENTRYPOINT_ROLLBACK_AUTHORIZED=NO"
echo "SURGERY_B_AUTHORIZED=NO"
echo "ROLLBACK_B_AUTHORIZED=NO"
echo "B0_CONFIGURE_AUTHORIZED=NO"
echo "B0_COMPLETE_AUTHORIZED=NO"
echo "B0_SANDBOX_REPAIR_AUTHORIZED=NO"
echo "B0_SANDBOX_REPAIR_COMPLETION_AUTHORIZED=NO"
echo "B0_ROLLBACK_AUTHORIZED=NO"
echo "R111F_FORWARD_AUTHORIZED=NO"
echo "R111F_RECOVERY_AUTHORIZED=NO"
