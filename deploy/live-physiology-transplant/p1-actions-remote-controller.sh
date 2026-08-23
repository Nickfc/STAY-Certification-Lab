#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"

OPERATION="${1:-}"
RUN_ROOT="${2:-}"
EXPECTED_CANDIDATE_SHA="7d040592ccf1f149f0f0a170f79cf76bb5f05d92"
CANDIDATE_ID="0.8.11.3-p1a-surgery-a-candidate-${EXPECTED_CANDIDATE_SHA}"
ROLLBACK_ID="0.8.11.3-p1a-forward-compatible-rollback-${EXPECTED_CANDIDATE_SHA}"
A1_ID="0.8.11.3-p1a1-resident-control-7d040592ccf1f149"
EVIDENCE_PARENT="/var/lib/stay/evidence/live-physiology-transplant"

[[ "${EUID}" -eq 0 ]] || { echo "P1_CONTROLLER_ABORT=root-required" >&2; exit 80; }
[[ "$RUN_ROOT" =~ ^/opt/stay/incoming/p1-actions-[0-9]+$ ]] || {
  echo "P1_CONTROLLER_ABORT=invalid-fixed-run-root" >&2; exit 81;
}
[[ -d "$RUN_ROOT" ]] || { echo "P1_CONTROLLER_ABORT=run-root-missing" >&2; exit 82; }

case "$OPERATION" in
  preflight)
    exec "$SCRIPT_DIR/p1-live-preflight.sh" \
      "$RUN_ROOT/releases/$CANDIDATE_ID" \
      "$RUN_ROOT/releases/$ROLLBACK_ID"
    ;;
  surgery-a)
    [[ "${STAY_SURGERY_A_WRITE_AUTHORIZED:-NO}" == "YES" ]] || {
      echo "P1_CONTROLLER_ABORT=surgery-authorization-missing" >&2; exit 83;
    }
    exec "$SCRIPT_DIR/p1-surgery-a-execute.sh" \
      "$RUN_ROOT/releases/$CANDIDATE_ID" \
      "$RUN_ROOT/releases/$ROLLBACK_ID" \
      "$EVIDENCE_PARENT"
    ;;
  rollback-a)
    [[ "${STAY_ROLLBACK_A_WRITE_AUTHORIZED:-NO}" == "YES" ]] || {
      echo "P1_CONTROLLER_ABORT=rollback-authorization-missing" >&2; exit 84;
    }
    exec "$SCRIPT_DIR/p1-forward-rollback.sh" \
      "/opt/stay/releases/$ROLLBACK_ID" \
      "$EVIDENCE_PARENT"
    ;;
  preflight-a1)
    exec "$SCRIPT_DIR/p1-surgery-a1-preflight.sh" \
      "$RUN_ROOT/releases/$A1_ID"
    ;;
  surgery-a1)
    [[ "${STAY_SURGERY_A1_WRITE_AUTHORIZED:-NO}" == "YES" ]] || {
      echo "P1_CONTROLLER_ABORT=surgery-a1-authorization-missing" >&2; exit 86;
    }
    exec "$SCRIPT_DIR/p1-surgery-a1-execute.sh" \
      "$RUN_ROOT/releases/$A1_ID" \
      "$EVIDENCE_PARENT"
    ;;
  rollback-a1)
    [[ "${STAY_ROLLBACK_A1_WRITE_AUTHORIZED:-NO}" == "YES" ]] || {
      echo "P1_CONTROLLER_ABORT=rollback-a1-authorization-missing" >&2; exit 87;
    }
    exec "$SCRIPT_DIR/p1-surgery-a1-rollback.sh"
    ;;
  preflight-a1-entrypoint)
    exec "$SCRIPT_DIR/p1-a1-entrypoint-preflight.sh"
    ;;
  correct-a1-entrypoint)
    [[ "${STAY_A1_ENTRYPOINT_WRITE_AUTHORIZED:-NO}" == "YES" ]] || {
      echo "P1_CONTROLLER_ABORT=a1-entrypoint-authorization-missing" >&2; exit 88;
    }
    exec "$SCRIPT_DIR/p1-a1-entrypoint-correct.sh" "$EVIDENCE_PARENT"
    ;;
  rollback-a1-entrypoint)
    [[ "${STAY_A1_ENTRYPOINT_ROLLBACK_AUTHORIZED:-NO}" == "YES" ]] || {
      echo "P1_CONTROLLER_ABORT=a1-entrypoint-rollback-authorization-missing" >&2; exit 89;
    }
    exec "$SCRIPT_DIR/p1-a1-entrypoint-rollback.sh"
    ;;
  preflight-b0)
    exec "$SCRIPT_DIR/p1-b0-preflight.sh"
    ;;
  configure-b0)
    [[ "${STAY_B0_CONFIGURE_AUTHORIZED:-NO}" == "YES" ]] || {
      echo "P1_CONTROLLER_ABORT=b0-configure-authorization-missing" >&2; exit 92;
    }
    exec "$SCRIPT_DIR/p1-b0-configure.sh" "$RUN_ROOT/b0-trust-material" "$EVIDENCE_PARENT"
    ;;
  complete-b0)
    [[ "${STAY_B0_COMPLETE_AUTHORIZED:-NO}" == "YES" ]] || {
      echo "P1_CONTROLLER_ABORT=b0-completion-authorization-missing" >&2; exit 94;
    }
    exec "$SCRIPT_DIR/p1-b0-complete.sh" "$RUN_ROOT/b0-completion-fingerprint.txt"
    ;;
  repair-b0-sandbox)
    [[ "${STAY_B0_SANDBOX_REPAIR_AUTHORIZED:-NO}" == "YES" ]] || {
      echo "P1_CONTROLLER_ABORT=b0-sandbox-repair-authorization-missing" >&2; exit 95;
    }
    exec "$SCRIPT_DIR/p1-b0-sandbox-repair.sh" "$EVIDENCE_PARENT"
    ;;
  complete-b0-sandbox-repair)
    [[ "${STAY_B0_SANDBOX_REPAIR_COMPLETE_AUTHORIZED:-NO}" == "YES" ]] || {
      echo "P1_CONTROLLER_ABORT=b0-sandbox-repair-completion-authorization-missing" >&2; exit 96;
    }
    exec "$SCRIPT_DIR/p1-b0-sandbox-repair-complete.sh" "$EVIDENCE_PARENT"
    ;;
  rollback-b0)
    [[ "${STAY_B0_ROLLBACK_AUTHORIZED:-NO}" == "YES" ]] || {
      echo "P1_CONTROLLER_ABORT=b0-rollback-authorization-missing" >&2; exit 93;
    }
    exec "$SCRIPT_DIR/p1-b0-rollback.sh"
    ;;
  preflight-b)
    exec "$SCRIPT_DIR/p1-surgery-b-preflight.sh"
    ;;
  surgery-b)
    [[ "${STAY_SURGERY_B_AUTHORIZED:-NO}" == "YES" ]] || {
      echo "P1_CONTROLLER_ABORT=surgery-b-authorization-missing" >&2; exit 90;
    }
    exec "$SCRIPT_DIR/p1-surgery-b-execute.sh" "$EVIDENCE_PARENT"
    ;;
  rollback-b)
    [[ "${STAY_ROLLBACK_B_AUTHORIZED:-NO}" == "YES" ]] || {
      echo "P1_CONTROLLER_ABORT=rollback-b-authorization-missing" >&2; exit 91;
    }
    exec "$SCRIPT_DIR/p1-surgery-b-rollback.sh" "$EVIDENCE_PARENT"
    ;;
  *)
    echo "P1_CONTROLLER_ABORT=unsupported-operation" >&2
    exit 85
    ;;
esac
