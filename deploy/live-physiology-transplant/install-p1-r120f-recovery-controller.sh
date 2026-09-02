#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
EXPECTED_PRIVATE_IPV4='172.26.9.207'
EXPECTED_WRAPPER_SHA256='491cb2217af45589113e3b135c4ed677e04dbc49e3f20f64aeca77095a2e0b6b'
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_WRAPPER="$SCRIPT_DIR/stay-p1-r120f-recovery-controller"
TARGET_WRAPPER='/usr/local/sbin/stay-p1-production-controller'
TARGET_SUDOERS='/etc/sudoers.d/stay-p1-production-controller'
[[ "$EUID" -eq 0 ]] || { echo 'R120F_BOOTSTRAP_ABORT=root-required' >&2; exit 60; }
[[ "$(ip -4 -o addr show scope global | awk '{split($4,a,"/");print a[1]}' | sort -u)" == "$EXPECTED_PRIVATE_IPV4" ]] ||
  { echo 'R120F_BOOTSTRAP_ABORT=host-identity-mismatch' >&2; exit 61; }
[[ -f "$SOURCE_WRAPPER" && ! -L "$SOURCE_WRAPPER" \
  && "$(sha256sum "$SOURCE_WRAPPER" | awk '{print $1}')" == "$EXPECTED_WRAPPER_SHA256" ]] ||
  { echo 'R120F_BOOTSTRAP_ABORT=wrapper-source-invalid' >&2; exit 62; }
command -v visudo >/dev/null && id staydeploy >/dev/null 2>&1 ||
  { echo 'R120F_BOOTSTRAP_ABORT=host-contract-invalid' >&2; exit 63; }
staging="$(mktemp -d /run/stay-r120f-recovery-bootstrap.XXXXXX)"
trap 'rm -rf -- "$staging"' EXIT
cat > "$staging/sudoers" <<'SUDOERS'
Defaults!/usr/local/sbin/stay-p1-production-controller env_reset
Defaults!/usr/local/sbin/stay-p1-production-controller !setenv
staydeploy ALL=(root) NOPASSWD: /usr/local/sbin/stay-p1-production-controller
SUDOERS
chmod 0440 "$staging/sudoers"
visudo -cf "$staging/sudoers" >/dev/null
install -o root -g root -m 0555 "$SOURCE_WRAPPER" "$TARGET_WRAPPER"
install -o root -g root -m 0440 "$staging/sudoers" "$TARGET_SUDOERS"
[[ "$(sha256sum "$TARGET_WRAPPER" | awk '{print $1}')" == "$EXPECTED_WRAPPER_SHA256" \
  && "$(stat -Lc '%U:%G:%a' "$TARGET_WRAPPER")" == root:root:555 \
  && "$(stat -Lc '%U:%G:%a' "$TARGET_SUDOERS")" == root:root:440 ]]
visudo -cf "$TARGET_SUDOERS" >/dev/null
echo 'P1_PRIVILEGED_BRIDGE_BOOTSTRAP=PASS'
echo 'HOST_IDENTITY_GUARD=PASS'
echo "OBSERVED_PRIVATE_IPV4=$EXPECTED_PRIVATE_IPV4"
echo "ROOT_WRAPPER=$TARGET_WRAPPER"
echo "ROOT_WRAPPER_SHA256=sha256:$EXPECTED_WRAPPER_SHA256"
echo 'SUDOERS_SCOPE=STAYDEPLOY_TO_PINNED_P1_CONTROLLER_ONLY'
echo 'R120F_RECOVERY_AUTHORIZED=NO'
