#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH LC_ALL=C

EXPECTED_PRIVATE_IPV4='172.26.9.207'
EXPECTED_WRAPPER_SHA256='f6e90413bcfbbb6c09c9bf7716c62915f05ce8b455542fd48bbfbed677ab65a0'
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_WRAPPER="$SCRIPT_DIR/stay-p1-r133-metab-shadow-production-controller"
TARGET_WRAPPER='/usr/local/sbin/stay-p1-production-controller'
TARGET_SUDOERS='/etc/sudoers.d/stay-p1-production-controller'

[[ "$EUID" -eq 0 ]] || {
  echo 'R133_BOOTSTRAP_ABORT=root-required' >&2
  exit 60
}
observed_private_ipv4="$({
  ip -o -4 addr show scope global |
    awk '{address=$4; sub(/\/.*/, "", address); print address}' |
    sort -u
})"
[[ "$observed_private_ipv4" == "$EXPECTED_PRIVATE_IPV4" ]] || {
  echo 'R133_BOOTSTRAP_ABORT=host-identity-mismatch' >&2
  exit 61
}
[[ -f "$SOURCE_WRAPPER" && ! -L "$SOURCE_WRAPPER" ]] || {
  echo 'R133_BOOTSTRAP_ABORT=wrapper-source-invalid' >&2
  exit 62
}
[[ "$(sha256sum "$SOURCE_WRAPPER" | awk '{print $1}')" == "$EXPECTED_WRAPPER_SHA256" ]] || {
  echo 'R133_BOOTSTRAP_ABORT=wrapper-source-hash-mismatch' >&2
  exit 63
}
command -v visudo >/dev/null 2>&1 || {
  echo 'R133_BOOTSTRAP_ABORT=visudo-unavailable' >&2
  exit 64
}
id staydeploy >/dev/null 2>&1 || {
  echo 'R133_BOOTSTRAP_ABORT=staydeploy-user-missing' >&2
  exit 65
}

staging="$(mktemp -d /run/stay-r133-metab-shadow-recovery-v1-bootstrap.XXXXXX)"
cleanup() {
  local status=$?
  trap - EXIT
  [[ "$staging" =~ ^/run/stay-r133-metab-shadow-recovery-v1-bootstrap\.[A-Za-z0-9]+$ &&
    -d "$staging" && ! -L "$staging" ]] || exit 66
  rm -rf --one-file-system -- "$staging"
  exit "$status"
}
trap cleanup EXIT

sudoers_staged="$staging/stay-p1-production-controller.sudoers"
cat > "$sudoers_staged" <<'SUDOERS'
Defaults!/usr/local/sbin/stay-p1-production-controller env_reset
Defaults!/usr/local/sbin/stay-p1-production-controller !setenv
staydeploy ALL=(root) NOPASSWD: /usr/local/sbin/stay-p1-production-controller
SUDOERS
chmod 0440 "$sudoers_staged"
visudo -cf "$sudoers_staged" >/dev/null

install -d -o root -g root -m 0755 /usr/local/sbin
install -o root -g root -m 0555 "$SOURCE_WRAPPER" "$staging/stay-p1-production-controller"
[[ "$(sha256sum "$staging/stay-p1-production-controller" | awk '{print $1}')" == \
  "$EXPECTED_WRAPPER_SHA256" ]]
install -o root -g root -m 0555 "$staging/stay-p1-production-controller" "$TARGET_WRAPPER"
install -o root -g root -m 0440 "$sudoers_staged" "$TARGET_SUDOERS"

[[ "$(stat -c '%U:%G:%a' "$TARGET_WRAPPER")" == 'root:root:555' ]]
[[ "$(sha256sum "$TARGET_WRAPPER" | awk '{print $1}')" == "$EXPECTED_WRAPPER_SHA256" ]]
[[ "$(stat -c '%U:%G:%a' "$TARGET_SUDOERS")" == 'root:root:440' ]]
visudo -cf "$TARGET_SUDOERS" >/dev/null

echo 'P1_PRIVILEGED_BRIDGE_BOOTSTRAP=PASS'
echo 'HOST_IDENTITY_GUARD=PASS'
echo "OBSERVED_PRIVATE_IPV4=$observed_private_ipv4"
echo "ROOT_WRAPPER=$TARGET_WRAPPER"
echo "ROOT_WRAPPER_SHA256=sha256:$EXPECTED_WRAPPER_SHA256"
echo 'SUDOERS_SCOPE=STAYDEPLOY_TO_PINNED_P1_CONTROLLER_ONLY'
echo 'R133_FORWARD_AUTHORIZED=NO'
echo 'R133_RECOVERY_AUTHORIZED=NO'
