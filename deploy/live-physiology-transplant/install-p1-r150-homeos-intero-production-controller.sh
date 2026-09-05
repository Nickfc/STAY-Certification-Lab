#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH LC_ALL=C

EXPECTED_PRIVATE_IPV4='172.26.9.207'
EXPECTED_WRAPPER_SHA256='671f2c4b2b949ef979e6d97aa2af75e310fa879a7129088bfb880042fcc788fc'
EXPECTED_PUBLIC_KEY_SHA256='f02405d0f62529c35f34c43c0a349f88c7906aa460ce36111585577b119457dc'
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_WRAPPER="$SCRIPT_DIR/stay-p1-r150-homeos-intero-production-controller"
SOURCE_PUBLIC_KEY="$SCRIPT_DIR/p1-r150-expansion-birth-authority.pub"
TARGET_WRAPPER='/usr/local/sbin/stay-p1-production-controller'
TARGET_PUBLIC_KEY='/etc/stay/p1-r0-expansion-birth-authority.pub'
TARGET_SUDOERS='/etc/sudoers.d/stay-p1-production-controller'

abort(){ printf 'R150_BOOTSTRAP_ABORT=%s\n' "$1" >&2;exit "$2"; }
[[ "$EUID" -eq 0 ]]||abort root-required 60
observed_private_ipv4="$(ip -o -4 addr show scope global|awk '{a=$4;sub(/\/.*/,"",a);print a}'|sort -u)"
[[ "$observed_private_ipv4" == "$EXPECTED_PRIVATE_IPV4" ]]||abort host-identity-mismatch 61
[[ -f "$SOURCE_WRAPPER" && ! -L "$SOURCE_WRAPPER" && -f "$SOURCE_PUBLIC_KEY" && ! -L "$SOURCE_PUBLIC_KEY" ]]||abort source-invalid 62
[[ "$(sha256sum "$SOURCE_WRAPPER"|awk '{print $1}')" == "$EXPECTED_WRAPPER_SHA256" &&
  "$(sha256sum "$SOURCE_PUBLIC_KEY"|awk '{print $1}')" == "$EXPECTED_PUBLIC_KEY_SHA256" ]]||abort source-hash-mismatch 63
command -v visudo >/dev/null 2>&1||abort visudo-unavailable 64
id staydeploy >/dev/null 2>&1||abort staydeploy-user-missing 65
if [[ -e "$TARGET_PUBLIC_KEY" || -L "$TARGET_PUBLIC_KEY" ]]; then
  [[ -f "$TARGET_PUBLIC_KEY" && ! -L "$TARGET_PUBLIC_KEY" &&
    "$(sha256sum "$TARGET_PUBLIC_KEY"|awk '{print $1}')" == "$EXPECTED_PUBLIC_KEY_SHA256" ]]||
    abort existing-expansion-public-key-conflict 67
fi

staging="$(mktemp -d /run/stay-r150-controller-v27-bootstrap.XXXXXX)"
cleanup(){ local status=$?;trap - EXIT;[[ "$staging" =~ ^/run/stay-r150-controller-v27-bootstrap\.[A-Za-z0-9]+$ && -d "$staging" && ! -L "$staging" ]]||exit 66;rm -rf --one-file-system -- "$staging";exit "$status"; }
trap cleanup EXIT
sudoers_staged="$staging/stay-p1-production-controller.sudoers"
cat > "$sudoers_staged" <<'SUDOERS'
Defaults!/usr/local/sbin/stay-p1-production-controller env_reset
Defaults!/usr/local/sbin/stay-p1-production-controller !setenv
staydeploy ALL=(root) NOPASSWD: /usr/local/sbin/stay-p1-production-controller
SUDOERS
chmod 0440 "$sudoers_staged";visudo -cf "$sudoers_staged" >/dev/null
install -d -o root -g root -m 0755 /usr/local/sbin /etc/stay
install -o root -g root -m 0555 "$SOURCE_WRAPPER" "$staging/stay-p1-production-controller"
install -o root -g root -m 0444 "$SOURCE_PUBLIC_KEY" "$staging/p1-r0-expansion-birth-authority.pub"
[[ "$(sha256sum "$staging/stay-p1-production-controller"|awk '{print $1}')" == "$EXPECTED_WRAPPER_SHA256" &&
  "$(sha256sum "$staging/p1-r0-expansion-birth-authority.pub"|awk '{print $1}')" == "$EXPECTED_PUBLIC_KEY_SHA256" ]]
install -o root -g root -m 0555 "$staging/stay-p1-production-controller" "$TARGET_WRAPPER"
install -o root -g root -m 0444 "$staging/p1-r0-expansion-birth-authority.pub" "$TARGET_PUBLIC_KEY"
install -o root -g root -m 0440 "$sudoers_staged" "$TARGET_SUDOERS"
[[ "$(stat -c '%U:%G:%a' "$TARGET_WRAPPER")" == root:root:555 &&
  "$(sha256sum "$TARGET_WRAPPER"|awk '{print $1}')" == "$EXPECTED_WRAPPER_SHA256" &&
  "$(stat -c '%U:%G:%a' "$TARGET_PUBLIC_KEY")" == root:root:444 &&
  "$(sha256sum "$TARGET_PUBLIC_KEY"|awk '{print $1}')" == "$EXPECTED_PUBLIC_KEY_SHA256" &&
  "$(stat -c '%U:%G:%a' "$TARGET_SUDOERS")" == root:root:440 ]]
visudo -cf "$TARGET_SUDOERS" >/dev/null
printf '%s\n' 'P1_PRIVILEGED_BRIDGE_BOOTSTRAP=PASS' 'HOST_IDENTITY_GUARD=PASS' \
  "OBSERVED_PRIVATE_IPV4=$observed_private_ipv4" "ROOT_WRAPPER=$TARGET_WRAPPER" \
  "ROOT_WRAPPER_SHA256=sha256:$EXPECTED_WRAPPER_SHA256" \
  "EXPANSION_PUBLIC_KEY_SHA256=sha256:$EXPECTED_PUBLIC_KEY_SHA256" \
  'SUDOERS_SCOPE=STAYDEPLOY_TO_PINNED_P1_CONTROLLER_ONLY' \
  'R148_HOMEOS_POST_FINALIZATION_RESTART_AUTHORIZED=NO' \
  'BENCHMARK_START_AUTHORIZED=NO'
