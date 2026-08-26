#!/bin/bash
set -Eeuo pipefail

if [[ "${STAY_P1_SNTSS_I4G_REHEARSAL_AUTHORIZATION:-}" != "REHEARSE_R105F_CHECKPOINT_WITHOUT_LIVE_MUTATION" ]]; then
  echo "P1_SNTSS_I4G_REHEARSAL_ABORT=authorization" >&2
  exit 64
fi

if [[ "$(id -u)" != 0 ]]; then
  echo "P1_SNTSS_I4G_REHEARSAL_ABORT=root-required" >&2
  exit 77
fi

root="$(cd "$(dirname "$0")/../.." && pwd -P)"
runner="$root/deploy/live-physiology-transplant/p1-sntss-i4g-rehearsal.js"
node_bin="$(command -v node || true)"

[[ -n "$node_bin" && -x "$node_bin" ]] || {
  echo "P1_SNTSS_I4G_REHEARSAL_ABORT=node-unavailable" >&2
  exit 69
}

[[ -f "$runner" && ! -L "$runner" ]] || {
  echo "P1_SNTSS_I4G_REHEARSAL_ABORT=runner-invalid" >&2
  exit 74
}

export NODE_ENV=production
export STAY_REQUIRE_OS_CORE_SANDBOX=1
export STAY_BWRAP=/usr/local/libexec/stay-bwrap-sandbox
export STAY_REQUIRE_CORE_PACKAGE_POLICY=1
export STAY_REQUIRE_CGROUPS=0
export STAY_CGROUP_ROOT=/dev/null

exec "$node_bin" "$runner"
