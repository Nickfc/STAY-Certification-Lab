#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"

EXPECTED_CANDIDATE_SHA="7d040592ccf1f149f0f0a170f79cf76bb5f05d92"
EXPECTED_CANDIDATE_TREE="450cc22f70b7abf3b5733fe882049d88cd52de74"
EXPECTED_COMPUTE_RECORD_SHA256="sha256:384f3f2e27232b555fe52185c775562d31cf7fac349dfb95ae93968225c83ec1"
EXPECTED_PREVIOUS_RELEASE="/opt/stay/releases/0.8.11.3-bdf868421601f49a95e1175097d73c95c9dc5ea2"
EXPECTED_CANDIDATE_ID="0.8.11.3-p1a-surgery-a-candidate-${EXPECTED_CANDIDATE_SHA}"
EXPECTED_ROLLBACK_ID="0.8.11.3-p1a-forward-compatible-rollback-${EXPECTED_CANDIDATE_SHA}"

STAGED_CANDIDATE="${1:-}"
STAGED_ROLLBACK="${2:-}"
EVIDENCE_PARENT="${3:-/var/lib/stay/evidence/live-physiology-transplant}"
DATA_ROOT="/var/lib/stay/data"
DATABASE="$DATA_ROOT/continuity.sqlite3"
CURRENT="/opt/stay/current"
RELEASES="/opt/stay/releases"
SERVICE="stay.service"
STAY_USER="staydeploy"
if [[ -x /usr/local/bin/node ]]; then
  NODE_BIN="$(readlink -f /usr/local/bin/node)"
elif [[ -x /usr/bin/node ]]; then
  NODE_BIN="$(readlink -f /usr/bin/node)"
else
  NODE_BIN=""
fi
ROLLBACK_DROPIN_DIR="/etc/systemd/system/stay.service.d"
ROLLBACK_DROPIN="$ROLLBACK_DROPIN_DIR/p1-forward-compatible-rollback.conf"

fail() {
  echo "SURGERY_A_ABORT=$1" >&2
  return "${2:-60}"
}

[[ "${EUID}" -eq 0 ]] || fail "root-required" 61
[[ -x "$NODE_BIN" ]] || fail "trusted-node-runtime-missing" 61
[[ ! -e "$ROLLBACK_DROPIN" ]] || fail "stale-forward-rollback-systemd-dropin" 61
[[ "${STAY_SURGERY_A_WRITE_AUTHORIZED:-NO}" == "YES" ]] ||
  fail "explicit-write-authorization-missing" 62
[[ -d "$STAGED_CANDIDATE" && -d "$STAGED_ROLLBACK" ]] ||
  fail "staged-release-pair-missing" 63
[[ -f "$DATABASE" ]] || fail "continuity-database-missing" 64

STAGED_CANDIDATE="$(readlink -f "$STAGED_CANDIDATE")"
STAGED_ROLLBACK="$(readlink -f "$STAGED_ROLLBACK")"

manifest_field() {
  "$NODE_BIN" -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const keys=process.argv[2].split(".");let v=p;for(const k of keys)v=v?.[k];process.stdout.write(String(v??""));' \
    "$1/P1_SURGERY_A_MANIFEST.json" "$2"
}

[[ "$(manifest_field "$STAGED_CANDIDATE" sourceSha)" == "$EXPECTED_CANDIDATE_SHA" ]] ||
  fail "candidate-sha-mismatch" 65
[[ "$(manifest_field "$STAGED_CANDIDATE" sourceTree)" == "$EXPECTED_CANDIDATE_TREE" ]] ||
  fail "candidate-tree-mismatch" 66
[[ "$(manifest_field "$STAGED_CANDIDATE" releaseId)" == "$EXPECTED_CANDIDATE_ID" ]] ||
  fail "candidate-release-id-mismatch" 67
[[ "$(manifest_field "$STAGED_CANDIDATE" releaseRole)" == "surgery-a-candidate" ]] ||
  fail "candidate-role-mismatch" 68
[[ "$(manifest_field "$STAGED_ROLLBACK" sourceSha)" == "$EXPECTED_CANDIDATE_SHA" ]] ||
  fail "rollback-sha-mismatch" 69
[[ "$(manifest_field "$STAGED_ROLLBACK" sourceTree)" == "$EXPECTED_CANDIDATE_TREE" ]] ||
  fail "rollback-tree-mismatch" 70
[[ "$(manifest_field "$STAGED_ROLLBACK" releaseId)" == "$EXPECTED_ROLLBACK_ID" ]] ||
  fail "rollback-release-id-mismatch" 71
[[ "$(manifest_field "$STAGED_ROLLBACK" releaseRole)" == "forward-compatible-rollback" ]] ||
  fail "rollback-role-mismatch" 72

for release in "$STAGED_CANDIDATE" "$STAGED_ROLLBACK"; do
  runuser -u "$STAY_USER" -- "$NODE_BIN" \
    "$release/runtime/release/sntss-release-control.js" verify --root "$release" >/dev/null
  runuser -u "$STAY_USER" -- "$NODE_BIN" \
    "$release/scripts/p1-state-store-gate.js" \
    --database "$DATABASE" \
    --candidate-root "$STAGED_CANDIDATE" \
    --rollback-root "$STAGED_ROLLBACK" \
    --phase pre >/dev/null
done

CURRENT_BEFORE="$(readlink -f "$CURRENT")"
[[ "$CURRENT_BEFORE" == "$EXPECTED_PREVIOUS_RELEASE" ]] ||
  fail "unexpected-current-release:${CURRENT_BEFORE}" 73
[[ "$(systemctl show "$SERVICE" --property=ActiveState --value)" == "active" ]] ||
  fail "service-not-active-before-surgery" 74
[[ "$(systemctl show "$SERVICE" --property=SubState --value)" == "running" ]] ||
  fail "service-not-running-before-surgery" 75

capture_state() {
  "$NODE_BIN" - "$DATABASE" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
db.exec('PRAGMA query_only=ON');
const has = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const all = (name, sql) => has(name) ? db.prepare(sql).all() : [];
const one = (name, sql) => has(name) ? db.prepare(sql).get() : null;
const result = {
  quickCheck: db.prepare('PRAGMA quick_check').get()?.quick_check || null,
  schemas: all('schema_versions', 'SELECT name, version FROM schema_versions ORDER BY name'),
  identity: one('metadata', "SELECT sha256, updated_at FROM metadata WHERE key='life:identity'"),
  authority: all('authority', 'SELECT core_id, instance_id, version, epoch, barrier_sequence, checkpoint_hash FROM authority ORDER BY core_id'),
  residents: all('resident_instances', 'SELECT residency_id, core_id, version, state_schema, status, checkpoint_hash, checkpoint_generation FROM resident_instances ORDER BY residency_id'),
  latestCheckpoints: all('checkpoints', `SELECT c.core_id, c.instance_id, c.version, c.authority_epoch, c.state_schema, c.generation, c.blob_hash, c.byte_length
    FROM checkpoints c JOIN (SELECT core_id, MAX(generation) generation FROM checkpoints GROUP BY core_id) x
      ON x.core_id=c.core_id AND x.generation=c.generation ORDER BY c.core_id`),
  biologicalEventCount: Number(one('biological_events', 'SELECT COUNT(*) count FROM biological_events')?.count || 0)
};
db.close();
process.stdout.write(JSON.stringify(result));
NODE
}

PRE_STATE="$(capture_state)"
PRE_SERVICE="$(systemctl show "$SERVICE" --property=MainPID,NRestarts,ActiveState,SubState,FragmentPath,NeedDaemonReload --no-pager)"

"$NODE_BIN" - "$PRE_STATE" <<'NODE'
const state = JSON.parse(process.argv[2]);
const continuity = state.schemas.find(row => row.name === 'continuity');
if (state.quickCheck !== 'ok') throw new Error('pre-surgery SQLite quick_check failed');
if (Number(continuity?.version) !== 3) throw new Error('pre-surgery continuity schema is not 3');
if (state.residents.some(row => ['sntss', 'chronobiology'].includes(row.core_id))) throw new Error('pre-surgery physiology resident is present');
if (state.authority.some(row => ['sntss', 'chronobiology'].includes(row.core_id))) throw new Error('pre-surgery physiology authority is present');
const fetus = state.authority.find(row => row.core_id === 'fetus-legacy');
if (!fetus || fetus.instance_id !== '82202211-8dd6-44d4-a4ec-8f2553d8dc6f' || fetus.version !== '0.6.0' || Number(fetus.epoch) !== 1) {
  throw new Error('pre-surgery fetus authority identity differs from P1 assumptions');
}
NODE

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE_DIR="$EVIDENCE_PARENT/surgery-a-$STAMP"
mkdir -p "$EVIDENCE_DIR"
printf '%s\n' "$EXPECTED_COMPUTE_RECORD_SHA256" > "$EVIDENCE_DIR/compute-record.sha256"
printf '%s\n' "$PRE_STATE" > "$EVIDENCE_DIR/state-before.json"
printf '%s\n' "$PRE_SERVICE" > "$EVIDENCE_DIR/service-before.txt"
printf '%s\n' "$CURRENT_BEFORE" > "$EVIDENCE_DIR/release-before.txt"

install_release() {
  local staged="$1"
  local release_id="$2"
  local final="$RELEASES/$release_id"
  local incoming
  install_stage_fail() {
    local stage="$1" code="$2"
    echo "RELEASE_INSTALL_STAGE=$stage" >&2
    fail "release-install-$stage" "$code"
  }

  echo "RELEASE_INSTALL_STAGE=destination-precheck"
  if [[ -e "$final" ]]; then
    [[ -d "$final" ]] || install_stage_fail "destination-precheck" 76
    echo "RELEASE_INSTALL_STAGE=existing-release-verify"
    cmp -s "$staged/RELEASE_INVENTORY.json" "$final/RELEASE_INVENTORY.json" ||
      install_stage_fail "existing-release-verify" 77
    runuser -u "$STAY_USER" -- "$NODE_BIN" \
      "$final/runtime/release/sntss-release-control.js" verify --root "$final" >/dev/null ||
      install_stage_fail "existing-release-verify" 77
    return
  fi
  incoming="$RELEASES/.install-${release_id}-${STAMP}"
  [[ ! -e "$incoming" ]] || install_stage_fail "destination-precheck" 78
  echo "RELEASE_INSTALL_STAGE=copy"
  cp -a "$staged" "$incoming" || install_stage_fail "copy" 85
  echo "RELEASE_INSTALL_STAGE=chown"
  chown -R root:root "$incoming" || install_stage_fail "chown" 86
  echo "RELEASE_INSTALL_STAGE=chmod-dirs"
  find "$incoming" -type d -exec chmod 0555 {} + || install_stage_fail "chmod-dirs" 87
  echo "RELEASE_INSTALL_STAGE=chmod-files"
  find "$incoming" -type f -exec chmod 0444 {} + || install_stage_fail "chmod-files" 88
  echo "RELEASE_INSTALL_STAGE=atomic-publish"
  mv "$incoming" "$final" || install_stage_fail "atomic-publish" 89
}

install_release "$STAGED_CANDIDATE" "$EXPECTED_CANDIDATE_ID"
install_release "$STAGED_ROLLBACK" "$EXPECTED_ROLLBACK_ID"

FINAL_CANDIDATE="$RELEASES/$EXPECTED_CANDIDATE_ID"
FINAL_ROLLBACK="$RELEASES/$EXPECTED_ROLLBACK_ID"
printf '%s\n' "$FINAL_CANDIDATE" > "$EVIDENCE_DIR/candidate-release.txt"
printf '%s\n' "$FINAL_ROLLBACK" > "$EVIDENCE_DIR/rollback-release.txt"

STOPPED=0
SWITCHED=0
rollback_forward() {
  local code="${1:-1}" healthy=0
  trap - ERR INT TERM
  if [[ "$STOPPED" -eq 1 ]]; then
    systemctl stop "$SERVICE" >/dev/null 2>&1 || true
    ln -sfn "$FINAL_ROLLBACK" "$CURRENT.p1-forward-rollback"
    mv -Tf "$CURRENT.p1-forward-rollback" "$CURRENT"
    install -d -o root -g root -m 0755 "$ROLLBACK_DROPIN_DIR"
    {
      echo '[Service]'
      echo 'ExecStart='
      printf 'ExecStart=%s --disable-sigusr1 /opt/stay/current/server-surgery-a-rollback.js\n' "$NODE_BIN"
    } > "$ROLLBACK_DROPIN.tmp"
    chown root:root "$ROLLBACK_DROPIN.tmp"
    chmod 0444 "$ROLLBACK_DROPIN.tmp"
    mv -f "$ROLLBACK_DROPIN.tmp" "$ROLLBACK_DROPIN"
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || true
    systemctl start "$SERVICE" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
      if curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then healthy=1; break; fi
      sleep 1
    done
    printf 'rollback_health=%s\ncanonical_forward_state_preserved=YES\n' "$healthy" > "$EVIDENCE_DIR/rollback-result.txt"
  fi
  echo "SURGERY_A_RESULT=ROLLED_BACK_FORWARD" >&2
  echo "ROLLBACK_READY=$healthy" >&2
  echo "EVIDENCE_DIR=$EVIDENCE_DIR" >&2
  exit "$code"
}
trap 'rollback_forward $?' ERR
trap 'rollback_forward 130' INT
trap 'rollback_forward 143' TERM

systemctl stop "$SERVICE"
STOPPED=1
if ss -ltn | grep -Eq ':(8787|8788)([[:space:]]|$)'; then
  fail "stay-ports-still-listening-after-stop" 79
fi

ln -s "$FINAL_CANDIDATE" "$CURRENT.p1-surgery-a"
mv -Tf "$CURRENT.p1-surgery-a" "$CURRENT"
SWITCHED=1
systemctl reset-failed "$SERVICE" || true
systemctl start "$SERVICE"

HEALTH_JSON=""
for _ in $(seq 1 30); do
  if HEALTH_JSON="$(curl -fsS http://127.0.0.1:8787/healthz 2>/dev/null)"; then break; fi
  sleep 1
done
[[ -n "$HEALTH_JSON" ]] || fail "candidate-health-timeout" 80

POST_STATE="$(capture_state)"
POST_SERVICE="$(systemctl show "$SERVICE" --property=MainPID,NRestarts,ActiveState,SubState,FragmentPath,NeedDaemonReload --no-pager)"
POST_RELEASE="$(readlink -f "$CURRENT")"
POST_META="$(curl -fsS http://127.0.0.1:8787/__stay/meta)"

"$NODE_BIN" - "$PRE_STATE" "$POST_STATE" "$HEALTH_JSON" "$POST_META" "$FINAL_CANDIDATE" "$POST_RELEASE" <<'NODE'
const [before, after, health, meta] = process.argv.slice(2, 6).map(JSON.parse);
const expectedRelease = process.argv[6];
const observedRelease = process.argv[7];
const schema = after.schemas.find(row => row.name === 'continuity');
if (observedRelease !== expectedRelease) throw new Error('post-surgery release pointer mismatch');
if (after.quickCheck !== 'ok' || Number(schema?.version) !== 4) throw new Error('post-surgery schema/integrity gate failed');
if (health.ok !== true || meta.ok !== true) throw new Error('post-surgery health failed');
if (after.identity?.sha256 !== before.identity?.sha256) throw new Error('organism identity changed');
if (after.residents.some(row => ['sntss', 'chronobiology'].includes(row.core_id))) throw new Error('physiology resident activated');
if (after.authority.some(row => ['sntss', 'chronobiology'].includes(row.core_id))) throw new Error('new physiology authority activated');
const tuple = row => [row.core_id, row.instance_id, row.version, Number(row.epoch), Number(row.barrier_sequence)];
if (JSON.stringify(after.authority.map(tuple)) !== JSON.stringify(before.authority.map(tuple))) throw new Error('biological authority identity changed');
const oldFetus = before.latestCheckpoints.find(row => row.core_id === 'fetus-legacy');
const newFetus = after.latestCheckpoints.find(row => row.core_id === 'fetus-legacy');
if (!oldFetus || !newFetus || Number(newFetus.generation) < Number(oldFetus.generation)) throw new Error('fetus checkpoint continuity regressed');
if ((meta.cores || []).some(core => ['sntss', 'chronobiology'].includes(core.id))) throw new Error('physiology core became active');
NODE

printf '%s\n' "$POST_STATE" > "$EVIDENCE_DIR/state-after.json"
printf '%s\n' "$POST_SERVICE" > "$EVIDENCE_DIR/service-after.txt"
printf '%s\n' "$POST_RELEASE" > "$EVIDENCE_DIR/release-after.txt"
printf '%s\n' "$HEALTH_JSON" > "$EVIDENCE_DIR/health-after.json"
printf '%s\n' "$POST_META" > "$EVIDENCE_DIR/meta-after.json"

find "$EVIDENCE_DIR" -type f ! -name SURGERY_A_EVIDENCE_DIGEST.sha256 -print0 |
  sort -z |
  xargs -0 sha256sum |
  sha256sum |
  awk '{print "sha256:" $1}' > "$EVIDENCE_DIR/SURGERY_A_EVIDENCE_DIGEST.sha256"

trap - ERR INT TERM
echo "SURGERY_A_RESULT=PASS"
echo "HOST_IDENTITY_GUARD=PASS"
echo "PRE_SURGERY_RELEASE=$CURRENT_BEFORE"
echo "POST_SURGERY_RELEASE=$POST_RELEASE"
echo "STATESTORE_PRE_SCHEMA=3"
echo "STATESTORE_POST_SCHEMA=4"
echo "STATESTORE_CONTINUITY=PASS"
echo "BSF_STATUS=INSTALLED_NO_AUTHORITY"
echo "RESIDENT_MANAGER_STATUS=INSTALLED_NO_RESIDENT"
echo "SERVICE_ACTIVE=YES"
echo "HEALTH=PASS"
echo "EXISTING_FETUS_CONTINUITY=PASS"
echo "SNTSS_NEW_ACTIVATION=NO"
echo "CHRONOBIOLOGY_ACTIVATED=NO"
echo "BIOLOGICAL_AUTHORITY_CHANGED=NO"
echo "ROLLBACK_READY=YES"
echo "SURGERY_A_EVIDENCE_DIGEST=$(cat "$EVIDENCE_DIR/SURGERY_A_EVIDENCE_DIGEST.sha256")"
echo "READY_FOR_SURGERY_B=AWAITING_REVIEW"
echo "EVIDENCE_DIR=$EVIDENCE_DIR"
