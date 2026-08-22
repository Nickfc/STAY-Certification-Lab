#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"

CANDIDATE_ROOT="${1:-}"
ROLLBACK_ROOT="${2:-}"
if [[ -z "$CANDIDATE_ROOT" || -z "$ROLLBACK_ROOT" ]]; then
  echo "Usage: p1-live-preflight.sh /opt/stay/releases/<surgery-a-candidate> /opt/stay/releases/<forward-rollback>" >&2
  exit 42
fi

NODE_BIN="$(command -v node)"
CURRENT_POINTER="$(readlink -f /opt/stay/current)"
DATABASE="/var/lib/stay/data/continuity.sqlite3"

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

"$NODE_BIN" "$CANDIDATE_ROOT/scripts/p1-state-store-gate.js" \
  --database "$DATABASE" \
  --candidate-root "$CANDIDATE_ROOT" \
  --rollback-root "$ROLLBACK_ROOT" \
  --phase pre

echo "PRE_WRITE_LIVE_SENTINEL=PASS"
echo "STATESTORE_WRITE_PERFORMED=NO"
echo "SERVICE_OPERATION_PERFORMED=NO"
echo "RELEASE_POINTER_CHANGED=NO"
echo "WRITE_PHASE_AUTHORIZED=NO"
