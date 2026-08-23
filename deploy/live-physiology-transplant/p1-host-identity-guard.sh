#!/usr/bin/env bash
set -Eeuo pipefail

EXPECTED_PRIVATE_IPV4="172.26.9.207"

if command -v ip >/dev/null 2>&1; then
  OBSERVED_PRIVATE_IPV4="$({
    ip -o -4 addr show scope global |
      awk '{address=$4; sub(/\/.*/, "", address); print address}' |
      sort -u
  } || true)"
else
  echo "HOST_IDENTITY_GUARD=FAIL" >&2
  echo "HOST_IDENTITY_REASON=ip-command-unavailable" >&2
  exit 40
fi

if [[ "$OBSERVED_PRIVATE_IPV4" != "$EXPECTED_PRIVATE_IPV4" ]]; then
  echo "LIVE_HOST_EXPECTED_PRIVATE_IPV4=$EXPECTED_PRIVATE_IPV4" >&2
  echo "OBSERVED_PRIVATE_IPV4=${OBSERVED_PRIVATE_IPV4:-NONE}" >&2
  echo "HOST_IDENTITY_GUARD=FAIL" >&2
  exit 41
fi

echo "LIVE_HOST_EXPECTED_PRIVATE_IPV4=$EXPECTED_PRIVATE_IPV4"
echo "OBSERVED_PRIVATE_IPV4=$OBSERVED_PRIVATE_IPV4"
echo "OBSERVED_HOSTNAME=$(hostname)"
echo "HOST_IDENTITY_GUARD=PASS"
echo "HOST_CLASSIFICATION=LIVE_PRODUCTION"
