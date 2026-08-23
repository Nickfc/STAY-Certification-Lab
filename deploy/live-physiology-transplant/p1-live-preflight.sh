#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"

CANDIDATE_ROOT="${1:-}"
ROLLBACK_ROOT="${2:-}"
if [[ -z "$CANDIDATE_ROOT" || -z "$ROLLBACK_ROOT" ]]; then
  echo "Usage: p1-live-preflight.sh /opt/stay/releases/<surgery-a-candidate> /opt/stay/releases/<forward-rollback>" >&2
  exit 42
fi

EXPECTED_CANDIDATE_SHA="7d040592ccf1f149f0f0a170f79cf76bb5f05d92"
EXPECTED_PREVIOUS_RELEASE="/opt/stay/releases/0.8.11.3-bdf868421601f49a95e1175097d73c95c9dc5ea2"
EXPECTED_CANDIDATE_ID="0.8.11.3-p1a-surgery-a-candidate-${EXPECTED_CANDIDATE_SHA}"
EXPECTED_ROLLBACK_ID="0.8.11.3-p1a-forward-compatible-rollback-${EXPECTED_CANDIDATE_SHA}"
if [[ -x /usr/local/bin/node ]]; then
  NODE_BIN="$(readlink -f /usr/local/bin/node)"
elif [[ -x /usr/bin/node ]]; then
  NODE_BIN="$(readlink -f /usr/bin/node)"
else
  NODE_BIN=""
fi
CURRENT_POINTER="$(readlink -f /opt/stay/current)"
DATABASE="/var/lib/stay/data/continuity.sqlite3"
ROLLBACK_DROPIN="/etc/systemd/system/stay.service.d/p1-forward-compatible-rollback.conf"

[[ -x "$NODE_BIN" ]] || { echo "PREFLIGHT_ABORT=trusted-node-runtime-missing" >&2; exit 43; }
[[ ! -e "$ROLLBACK_DROPIN" ]] || { echo "PREFLIGHT_ABORT=stale-forward-rollback-systemd-dropin" >&2; exit 43; }
[[ "$CURRENT_POINTER" == "$EXPECTED_PREVIOUS_RELEASE" ]] || {
  echo "PREFLIGHT_ABORT=unexpected-current-release:${CURRENT_POINTER}" >&2
  exit 44
}
[[ "$(basename "$(readlink -f "$CANDIDATE_ROOT")")" == "$EXPECTED_CANDIDATE_ID" ]] || {
  echo "PREFLIGHT_ABORT=candidate-release-id-mismatch" >&2
  exit 45
}
[[ "$(basename "$(readlink -f "$ROLLBACK_ROOT")")" == "$EXPECTED_ROLLBACK_ID" ]] || {
  echo "PREFLIGHT_ABORT=rollback-release-id-mismatch" >&2
  exit 46
}
[[ "$(systemctl show stay.service --property=ActiveState --value)" == "active" ]] || {
  echo "PREFLIGHT_ABORT=service-not-active" >&2
  exit 47
}
[[ "$(systemctl show stay.service --property=SubState --value)" == "running" ]] || {
  echo "PREFLIGHT_ABORT=service-not-running" >&2
  exit 48
}

echo
echo "=== P1 PRE-WRITE LIVE SENTINEL ==="
systemctl show stay.service \
  --property=MainPID,NRestarts,ActiveState,SubState,FragmentPath,NeedDaemonReload \
  --no-pager
echo "CURRENT_POINTER=$CURRENT_POINTER"
echo "CANDIDATE_ROOT=$(readlink -f "$CANDIDATE_ROOT")"
echo "ROLLBACK_ROOT=$(readlink -f "$ROLLBACK_ROOT")"
sha256sum \
  "$CANDIDATE_ROOT/runtime/kernel/biological-signalling-fabric.js" \
  "$CANDIDATE_ROOT/runtime/kernel/resident-manager.js" \
  "$CANDIDATE_ROOT/runtime/kernel/state-store.js" \
  "$ROLLBACK_ROOT/runtime/kernel/state-store.js"

runuser -u staydeploy -- "$NODE_BIN" "$CANDIDATE_ROOT/scripts/p1-state-store-gate.js" \
  --database "$DATABASE" \
  --candidate-root "$CANDIDATE_ROOT" \
  --rollback-root "$ROLLBACK_ROOT" \
  --phase pre

echo "PRE_WRITE_LIVE_SENTINEL=PASS"
echo "PREFLIGHT_RESULT=PASS"
echo "EXPECTED_CANDIDATE_SHA=$EXPECTED_CANDIDATE_SHA"
echo "STATESTORE_PRE_SCHEMA=3"
echo "SNTSS_NEW_ACTIVATION=NO"
echo "CHRONOBIOLOGY_ACTIVATED=NO"
echo "BIOLOGICAL_AUTHORITY_CHANGED=NO"
echo "STATESTORE_WRITE_PERFORMED=NO"
echo "SERVICE_OPERATION_PERFORMED=NO"
echo "RELEASE_POINTER_CHANGED=NO"
echo "WRITE_PHASE_AUTHORIZED=NO"
