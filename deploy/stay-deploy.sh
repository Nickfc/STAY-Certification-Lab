#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SERVICE="stay"
BASE="/opt/stay"
RELEASES="$BASE/releases"
INCOMING="$BASE/incoming"
CURRENT="$BASE/current"
DATA_ROOT="/var/lib/stay/data"
BACKUP_ROOT="/var/backups/stay"
NODE="/usr/local/bin/node"
STAY_USER="staydeploy"
STAY_GROUP="staydeploy"

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run with sudo/root." >&2
  exit 1
fi

ARCHIVE="${1:-}"
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "Usage: sudo stay-deploy /path/to/stay-X.Y.Z.R-<40-char-sha>.tar.gz" >&2
  exit 2
fi

ARCHIVE="$(readlink -f "$ARCHIVE")"
BASE_NAME="$(basename "$ARCHIVE")"
CHECKSUM_FILE="$ARCHIVE.sha256"

if [[ ! "$BASE_NAME" =~ ^stay-([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)-([0-9a-f]{40})\.tar\.gz$ ]]; then
  echo "ERROR: archive name must be stay-X.Y.Z.R-<40-char-sha>.tar.gz" >&2
  exit 2
fi

NAME_VERSION="${BASH_REMATCH[1]}"
COMMIT_SHA="${BASH_REMATCH[2]}"
ARCHIVE_SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"

if [[ ! -f "$CHECKSUM_FILE" ]]; then
  echo "ERROR: required archive checksum sidecar is missing: $CHECKSUM_FILE" >&2
  exit 2
fi
EXPECTED_SHA="$(awk 'NF {print $1; exit}' "$CHECKSUM_FILE")"
if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-f]{64}$ || "$EXPECTED_SHA" != "$ARCHIVE_SHA" ]]; then
  echo "ERROR: archive checksum sidecar does not match the archive." >&2
  exit 2
fi

mkdir -p "$RELEASES" "$INCOMING" "$BACKUP_ROOT"

WORK="$(mktemp -d "$RELEASES/.candidate-${NAME_VERSION}-XXXXXX")"
STOPPED=0
SWITCHED=0
PREVIOUS_RELEASE=""
BACKUP_DIR=""
STATE_STARTED=0
FAILED_STATE_DIR=""

rollback() {
  local exit_code="${1:-1}"
  trap - ERR INT TERM
  echo
  echo "!! DEPLOYMENT FAILED — attempting automatic rollback"
  local rollback_failed=0
  local rollback_healthy=0

  if [[ "$STOPPED" -eq 1 ]]; then
    systemctl stop "$SERVICE" >/dev/null 2>&1 || true

    if [[ "$SWITCHED" -eq 1 && -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
      if ln -sfn "$PREVIOUS_RELEASE" "$CURRENT.rollback" \
        && mv -Tf "$CURRENT.rollback" "$CURRENT"; then
        echo "Restored release pointer: $PREVIOUS_RELEASE"
      else
        rollback_failed=1
        echo "CRITICAL: failed to restore release pointer to $PREVIOUS_RELEASE" >&2
      fi
    fi

    if [[ "$STATE_STARTED" -eq 1 && -n "$BACKUP_DIR" && -f "$BACKUP_DIR/stay-data.tar.gz" ]]; then
      FAILED_STATE_DIR="/var/lib/stay/failed-state-$(date -u +%Y%m%dT%H%M%SZ)"
      if mv "$DATA_ROOT" "$FAILED_STATE_DIR" \
        && mkdir -p "$DATA_ROOT" \
        && tar --no-same-owner --no-same-permissions -xzf "$BACKUP_DIR/stay-data.tar.gz" -C /var/lib/stay \
        && chown -R "$STAY_USER:$STAY_GROUP" "$DATA_ROOT"; then
        echo "Restored pre-deployment state; failed candidate state retained at: $FAILED_STATE_DIR"
      else
        rollback_failed=1
        echo "CRITICAL: automatic state restore failed; inspect $BACKUP_DIR and $FAILED_STATE_DIR" >&2
      fi
    fi

    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || true
    systemctl start "$SERVICE" >/dev/null 2>&1 || true

    for _ in $(seq 1 20); do
      if curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
        echo "Rollback health: OK"
        rollback_healthy=1
        break
      fi
      sleep 1
    done
    if [[ "$rollback_healthy" -ne 1 ]]; then
      rollback_failed=1
      echo "CRITICAL: rollback service did not become healthy." >&2
    fi
  fi

  rm -rf "$WORK" >/dev/null 2>&1 || true

  if [[ -n "$BACKUP_DIR" ]]; then
    echo "Safety backup retained: $BACKUP_DIR"
  fi

  if [[ "$rollback_failed" -ne 0 ]]; then
    echo "CRITICAL: automatic rollback was incomplete; manual recovery is required." >&2
    exit 125
  fi

  exit "$exit_code"
}

trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

echo "== STAY controlled deployment =="
echo "Archive: $ARCHIVE"
echo "SHA256 : $ARCHIVE_SHA"
echo "Sidecar: verified"
echo "Commit : $COMMIT_SHA"

python3 - "$ARCHIVE" <<'PY'
import pathlib, sys, tarfile
archive = pathlib.Path(sys.argv[1])
with tarfile.open(archive, 'r:gz') as tf:
    members = tf.getmembers()
    if not members:
        raise SystemExit('ERROR: release archive is empty')
    if len(members) > 100000:
        raise SystemExit('ERROR: release archive contains too many members')
    if sum(member.size for member in members) > 2 * 1024 * 1024 * 1024:
        raise SystemExit('ERROR: release archive expands beyond the 2 GiB safety limit')
    for member in members:
        name = pathlib.PurePosixPath(member.name)
        if member.size > 512 * 1024 * 1024:
            raise SystemExit(f'ERROR: archive member exceeds the 512 MiB safety limit: {member.name!r}')
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise SystemExit(f'ERROR: unsupported archive member type: {member.name!r}')
        if name.is_absolute() or '..' in name.parts or member.isdev() or member.isfifo():
            raise SystemExit(f'ERROR: unsafe archive member: {member.name!r}')
        if member.issym() or member.islnk():
            target = pathlib.PurePosixPath(member.linkname)
            resolved = name.parent.joinpath(target)
            if target.is_absolute() or '..' in resolved.parts:
                raise SystemExit(f'ERROR: unsafe archive link: {member.name!r} -> {member.linkname!r}')
PY
tar --no-same-owner --no-same-permissions -xzf "$ARCHIVE" -C "$WORK"

if [[ ! -f "$WORK/package.json" || ! -f "$WORK/server.js" ]]; then
  echo "ERROR: archive is not a STAY release." >&2
  false
fi

RELEASE_VERSION="$("$NODE" -e "const p=require(process.argv[1]); process.stdout.write(String(p.stayVersion || p.version || ''))" "$WORK/package.json")"
if [[ "$RELEASE_VERSION" != "$NAME_VERSION" ]]; then
  echo "ERROR: filename version $NAME_VERSION does not match package stayVersion $RELEASE_VERSION." >&2
  false
fi

if [[ ! -f "$WORK/RELEASE_PROVENANCE.json" ]]; then
  echo "ERROR: release provenance manifest is missing." >&2
  false
fi
PROVENANCE_COMMIT="$("$NODE" -e "const p=require(process.argv[1]); process.stdout.write(String(p.commit || ''))" "$WORK/RELEASE_PROVENANCE.json")"
PROVENANCE_VERSION="$("$NODE" -e "const p=require(process.argv[1]); process.stdout.write(String(p.version || ''))" "$WORK/RELEASE_PROVENANCE.json")"
if [[ "$PROVENANCE_COMMIT" != "$COMMIT_SHA" || "$PROVENANCE_VERSION" != "$RELEASE_VERSION" ]]; then
  echo "ERROR: release provenance does not match archive filename/package." >&2
  false
fi

RELEASE_CHANNEL="$("$NODE" -e "const p=require(process.argv[1]); process.stdout.write(String(p.releaseChannel || 'unknown'))" "$WORK/package.json")"
if [[ "$RELEASE_CHANNEL" != "certified" && "${STAY_ALLOW_PRECERTIFICATION:-0}" != "1" ]]; then
  echo "ERROR: release channel '$RELEASE_CHANNEL' is not certified; set STAY_ALLOW_PRECERTIFICATION=1 only for an explicit staging exercise." >&2
  false
fi

FINAL_RELEASE="$RELEASES/${RELEASE_VERSION}-${COMMIT_SHA}"

echo "-- Preflight syntax"
while IFS= read -r -d '' source_file; do
  "$NODE" --check "$source_file"
done < <(find "$WORK/runtime" "$WORK/scripts" -type f -name '*.js' -print0)
"$NODE" --check "$WORK/server.js"

# Make candidate readable to staydeploy before isolated testing.
chown -R root:root "$WORK"
find "$WORK" -type d -exec chmod 0555 {} \;
find "$WORK" -type f -exec chmod 0444 {} \;

echo "-- Isolated continuity test"
sudo -u "$STAY_USER" "$NODE" "$WORK/scripts/continuity-check.js"

if [[ -e "$FINAL_RELEASE" ]]; then
  echo "ERROR: immutable release already exists: $FINAL_RELEASE" >&2
  false
fi
mv "$WORK" "$FINAL_RELEASE"
WORK=""

PREVIOUS_RELEASE="$(readlink -f "$CURRENT" 2>/dev/null || true)"
if [[ -z "$PREVIOUS_RELEASE" || ! -d "$PREVIOUS_RELEASE" ]]; then
  echo "ERROR: current release pointer is invalid." >&2
  false
fi

IDENTITY_FILE="$DATA_ROOT/life/identity.json"
BRAIN_FILE="$DATA_ROOT/legacy-0.6.0/genesis-state.json"

IDENTITY_SHA_BEFORE="$(sha256sum "$IDENTITY_FILE" | awk '{print $1}')"
BRAIN_MTIME_BEFORE="$(stat -c %Y "$BRAIN_FILE")"

echo "-- Current release: $PREVIOUS_RELEASE"
echo "-- Identity SHA : $IDENTITY_SHA_BEFORE"

echo "-- Clean stop"
STOPPED=1
systemctl stop "$SERVICE"

if ss -ltn | grep -Eq ':(8787|8788)([[:space:]]|$)'; then
  echo "ERROR: STAY ports are still listening after stop." >&2
  false
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/pre-${RELEASE_VERSION}-${STAMP}"
mkdir -p "$BACKUP_DIR"

echo "-- Safety backup: $BACKUP_DIR"
tar -C /var/lib/stay -czf "$BACKUP_DIR/stay-data.tar.gz" data
sha256sum "$BACKUP_DIR/stay-data.tar.gz" > "$BACKUP_DIR/stay-data.tar.gz.sha256"
sha256sum -c "$BACKUP_DIR/stay-data.tar.gz.sha256"
cp "$IDENTITY_FILE" "$BACKUP_DIR/identity.json"
sha256sum "$BRAIN_FILE" > "$BACKUP_DIR/live-brain.sha256"
readlink -f "$CURRENT" > "$BACKUP_DIR/previous-release.txt"
"$NODE" - "$DATA_ROOT/continuity.sqlite3" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const row = db.prepare('PRAGMA quick_check').get();
  if (String(row?.quick_check || '').toLowerCase() !== 'ok') throw new Error('continuity SQLite quick_check failed');
} finally { db.close(); }
NODE

echo "-- Atomic release switch"
ln -sfn "$FINAL_RELEASE" "$CURRENT.new"
mv -Tf "$CURRENT.new" "$CURRENT"
SWITCHED=1

systemctl daemon-reload
systemctl reset-failed "$SERVICE" || true
STATE_STARTED=1
systemctl start "$SERVICE"

echo "-- Waiting for health"
HEALTH=""
for _ in $(seq 1 30); do
  if HEALTH="$(curl -fsS http://127.0.0.1:8787/healthz 2>/dev/null)"; then
    break
  fi
  sleep 1
done

if [[ -z "$HEALTH" ]]; then
  echo "ERROR: health endpoint did not recover." >&2
  false
fi

echo "$HEALTH"

"$NODE" -e '
const h = JSON.parse(process.argv[1]);
const expected = process.argv[2];
if (h.ok !== true) throw new Error("health is not OK");
if (h.version !== expected) throw new Error(`expected STAY ${expected}, got ${h.version}`);
' "$HEALTH" "$RELEASE_VERSION"

IDENTITY_SHA_AFTER="$(sha256sum "$IDENTITY_FILE" | awk '{print $1}')"
if [[ "$IDENTITY_SHA_AFTER" != "$IDENTITY_SHA_BEFORE" ]]; then
  echo "ERROR: organism identity changed during release switch." >&2
  false
fi
echo "-- Identity continuity: OK"

echo "-- Public HTML framing test"
HTTP_CODE="$(curl -sS -o /tmp/stay-deploy-page.html -w '%{http_code}' http://127.0.0.1/)"
if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "308" ]]; then
  echo "ERROR: Nginx GET / returned HTTP $HTTP_CODE." >&2
  false
fi

echo "-- Browser runtime surfaces"
curl -fsS http://127.0.0.1:8787/__stay/meta >/tmp/stay-deploy-meta.json
curl -fsS http://127.0.0.1:8787/client.js >/tmp/stay-deploy-client.js
if [[ -f "$FINAL_RELEASE/runtime/ui/live-badge.js" ]]; then
  curl -fsS http://127.0.0.1:8787/__stay/live-badge.js >/tmp/stay-deploy-badge.js
fi

echo "-- Waiting for legacy brain persistence"
BRAIN_SAVED=0
for _ in $(seq 1 20); do
  sleep 1
  BRAIN_MTIME_AFTER="$(stat -c %Y "$BRAIN_FILE")"
  if [[ "$BRAIN_MTIME_AFTER" -gt "$BRAIN_MTIME_BEFORE" ]]; then
    BRAIN_SAVED=1
    break
  fi
done

if [[ "$BRAIN_SAVED" -ne 1 ]]; then
  echo "ERROR: legacy brain did not produce a new persistent save after restart." >&2
  false
fi

echo "-- Legacy persistence: OK"
echo
echo "DEPLOYMENT ACCEPTED"
echo "STAY     : $RELEASE_VERSION"
echo "Commit   : $COMMIT_SHA"
echo "Release  : $FINAL_RELEASE"
echo "Backup   : $BACKUP_DIR"
echo "SHA256   : $ARCHIVE_SHA"
echo
echo "No manual rollback is required."
