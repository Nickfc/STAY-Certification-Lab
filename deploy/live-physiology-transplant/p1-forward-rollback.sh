#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
"$SCRIPT_DIR/p1-host-identity-guard.sh"

if [[ "${STAY_ROLLBACK_A_WRITE_AUTHORIZED:-NO}" != "YES" ]]; then
  echo "ROLLBACK_A_ABORT=separate-rollback-authorization-missing" >&2
  exit 50
fi

ROLLBACK_RELEASE="${1:-}"
EVIDENCE_PARENT="${2:-/var/lib/stay/evidence/live-physiology-transplant}"
if [[ -z "$ROLLBACK_RELEASE" || ! -d "$ROLLBACK_RELEASE" ]]; then
  echo "ROLLBACK_A_ABORT=forward-compatible-rollback-release-missing" >&2
  exit 51
fi
[[ "${EUID}" -eq 0 ]] || { echo "ROLLBACK_A_ABORT=root-required" >&2; exit 51; }
EXPECTED_CANDIDATE_SHA="7d040592ccf1f149f0f0a170f79cf76bb5f05d92"
EXPECTED_CANDIDATE_ID="0.8.11.3-p1a-surgery-a-candidate-${EXPECTED_CANDIDATE_SHA}"
EXPECTED_ROLLBACK_ID="0.8.11.3-p1a-forward-compatible-rollback-${EXPECTED_CANDIDATE_SHA}"
EXPECTED_CANDIDATE_RELEASE="/opt/stay/releases/$EXPECTED_CANDIDATE_ID"
EXPECTED_ROLLBACK_RELEASE="/opt/stay/releases/$EXPECTED_ROLLBACK_ID"
DATABASE="/var/lib/stay/data/continuity.sqlite3"
if [[ -x /usr/local/bin/node ]]; then
  NODE_BIN="$(readlink -f /usr/local/bin/node)"
elif [[ -x /usr/bin/node ]]; then
  NODE_BIN="$(readlink -f /usr/bin/node)"
else
  NODE_BIN=""
fi
ROLLBACK_DROPIN_DIR="/etc/systemd/system/stay.service.d"
ROLLBACK_DROPIN="$ROLLBACK_DROPIN_DIR/p1-forward-compatible-rollback.conf"
ROLLBACK_RELEASE="$(readlink -f "$ROLLBACK_RELEASE")"
[[ "$ROLLBACK_RELEASE" == "$EXPECTED_ROLLBACK_RELEASE" ]] || {
  echo "ROLLBACK_A_ABORT=rollback-release-identity-mismatch" >&2; exit 52;
}
[[ "$(readlink -f /opt/stay/current)" == "$EXPECTED_CANDIDATE_RELEASE" ]] || {
  echo "ROLLBACK_A_ABORT=current-release-is-not-surgery-a-candidate" >&2; exit 52;
}
[[ -x "$NODE_BIN" && -f "$DATABASE" ]] || {
  echo "ROLLBACK_A_ABORT=trusted-runtime-or-database-missing" >&2; exit 52;
}

ROLE="$($NODE_BIN -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(p.releaseRole||""))' "$ROLLBACK_RELEASE/P1_SURGERY_A_MANIFEST.json")"
SOURCE_SHA="$($NODE_BIN -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(p.sourceSha||""))' "$ROLLBACK_RELEASE/P1_SURGERY_A_MANIFEST.json")"
if [[ "$ROLE" != "forward-compatible-rollback" || "$SOURCE_SHA" != "$EXPECTED_CANDIDATE_SHA" ]]; then
  echo "ROLLBACK_A_ABORT=rollback-manifest-identity-mismatch" >&2
  exit 53
fi
runuser -u staydeploy -- "$NODE_BIN" \
  "$ROLLBACK_RELEASE/runtime/release/sntss-release-control.js" verify \
  --root "$ROLLBACK_RELEASE" >/dev/null

capture_state() {
  "$NODE_BIN" - "$DATABASE" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
db.exec('PRAGMA query_only=ON');
const has = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const rows = (name, sql) => has(name) ? db.prepare(sql).all() : [];
const one = (name, sql) => has(name) ? db.prepare(sql).get() : null;
const result = {
  quickCheck: db.prepare('PRAGMA quick_check').get()?.quick_check || null,
  schema: Number(one('schema_versions', "SELECT version FROM schema_versions WHERE name='continuity'")?.version || 0),
  identity: one('metadata', "SELECT sha256 FROM metadata WHERE key='life:identity'")?.sha256 || null,
  authority: rows('authority', 'SELECT core_id, instance_id, version, epoch, barrier_sequence FROM authority ORDER BY core_id'),
  residents: rows('resident_instances', 'SELECT residency_id, core_id, version, state_schema, status FROM resident_instances ORDER BY residency_id')
};
db.close();
process.stdout.write(JSON.stringify(result));
NODE
}

BEFORE_STATE="$(capture_state)"
"$NODE_BIN" - "$BEFORE_STATE" <<'NODE'
const state = JSON.parse(process.argv[2]);
if (state.quickCheck !== 'ok' || state.schema !== 4) throw new Error('rollback requires intact forward schema 4');
if (state.residents.some(row => ['sntss', 'chronobiology'].includes(row.core_id))) throw new Error('rollback refuses active physiology resident');
if (state.authority.some(row => ['sntss', 'chronobiology'].includes(row.core_id))) throw new Error('rollback refuses active physiology authority');
NODE
[[ "$(systemctl is-active stay.service)" == "active" ]] || {
  echo "ROLLBACK_A_ABORT=service-not-active-before-rollback" >&2; exit 53;
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE_DIR="$EVIDENCE_PARENT/rollback-a-$STAMP"
mkdir -p "$EVIDENCE_DIR"
printf '%s\n' "$BEFORE_STATE" > "$EVIDENCE_DIR/state-before.json"
readlink -f /opt/stay/current > "$EVIDENCE_DIR/release-before.txt"
systemctl show stay.service --property=MainPID,NRestarts,ActiveState,SubState --no-pager > "$EVIDENCE_DIR/service-before.txt"

# This path changes code authority only.  It contains no copy, extraction,
# deletion, replacement, or restoration operation against /var/lib/stay.
systemctl stop stay.service
ln -s "$ROLLBACK_RELEASE" /opt/stay/current.p1-rollback
mv -Tf /opt/stay/current.p1-rollback /opt/stay/current
install -d -o root -g root -m 0755 "$ROLLBACK_DROPIN_DIR"
{
  echo '[Service]'
  echo 'ExecStart='
  printf 'ExecStart=%s --disable-sigusr1 /opt/stay/current/server-surgery-a-rollback.js\n' "$NODE_BIN"
} > "$ROLLBACK_DROPIN.tmp"
chown root:root "$ROLLBACK_DROPIN.tmp"
chmod 0444 "$ROLLBACK_DROPIN.tmp"
mv -f "$ROLLBACK_DROPIN.tmp" "$ROLLBACK_DROPIN"
systemctl daemon-reload
systemctl reset-failed stay.service || true
systemctl start stay.service

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null; then
    break
  fi
  sleep 1
done
[[ "$(systemctl is-active stay.service)" == "active" ]] || {
  echo "ROLLBACK_A_ABORT=forward-rollback-health-failed" >&2; exit 54;
}
curl -fsS http://127.0.0.1:8787/healthz > "$EVIDENCE_DIR/health-after.json"
AFTER_STATE="$(capture_state)"
printf '%s\n' "$AFTER_STATE" > "$EVIDENCE_DIR/state-after.json"
readlink -f /opt/stay/current > "$EVIDENCE_DIR/release-after.txt"
systemctl show stay.service --property=MainPID,NRestarts,ActiveState,SubState --no-pager > "$EVIDENCE_DIR/service-after.txt"

"$NODE_BIN" - "$BEFORE_STATE" "$AFTER_STATE" <<'NODE'
const before = JSON.parse(process.argv[2]);
const after = JSON.parse(process.argv[3]);
if (after.quickCheck !== 'ok' || after.schema !== 4) throw new Error('forward schema was not preserved');
if (after.identity !== before.identity) throw new Error('organism identity changed during rollback');
if (JSON.stringify(after.authority) !== JSON.stringify(before.authority)) throw new Error('biological authority changed during rollback');
if (JSON.stringify(after.residents) !== JSON.stringify(before.residents)) throw new Error('resident identity changed during rollback');
NODE

find "$EVIDENCE_DIR" -type f ! -name ROLLBACK_A_EVIDENCE_DIGEST.sha256 -print0 |
  sort -z | xargs -0 sha256sum | sha256sum |
  awk '{print "sha256:" $1}' > "$EVIDENCE_DIR/ROLLBACK_A_EVIDENCE_DIGEST.sha256"

echo "ROLLBACK_A_RESULT=PASS"
echo "HOST_IDENTITY_GUARD=PASS"
echo "FORWARD_COMPATIBLE_ROLLBACK=PASS"
echo "STATESTORE_POST_SCHEMA=4"
echo "STATESTORE_CONTINUITY=PASS"
echo "BIOLOGICAL_STATE_RESTORED=NO"
echo "CANONICAL_FORWARD_STATE_PRESERVED=YES"
echo "SNTSS_NEW_ACTIVATION=NO"
echo "CHRONOBIOLOGY_ACTIVATED=NO"
echo "BIOLOGICAL_AUTHORITY_CHANGED=NO"
echo "ROLLBACK_A_EVIDENCE_DIGEST=$(cat "$EVIDENCE_DIR/ROLLBACK_A_EVIDENCE_DIGEST.sha256")"
echo "EVIDENCE_DIR=$EVIDENCE_DIR"
