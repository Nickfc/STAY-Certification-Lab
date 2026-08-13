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

if [[ ! "$BASE_NAME" =~ ^stay-([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)-([0-9a-f]{40})\.tar\.gz$ ]]; then
  echo "ERROR: archive name must be stay-X.Y.Z.R-<40-char-sha>.tar.gz" >&2
  exit 2
fi

NAME_VERSION="${BASH_REMATCH[1]}"
COMMIT_SHA="${BASH_REMATCH[2]}"
ARCHIVE_SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"

mkdir -p "$RELEASES" "$INCOMING" "$BACKUP_ROOT"

WORK="$(mktemp -d "$RELEASES/.candidate-${NAME_VERSION}-XXXXXX")"
STOPPED=0
SWITCHED=0
PREVIOUS_RELEASE=""
BACKUP_DIR=""

rollback() {
  local exit_code="${1:-1}"
  trap - ERR INT TERM
  echo
  echo "!! DEPLOYMENT FAILED — attempting automatic rollback"

  if [[ "$STOPPED" -eq 1 ]]; then
    systemctl stop "$SERVICE" >/dev/null 2>&1 || true

    if [[ "$SWITCHED" -eq 1 && -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
      ln -sfn "$PREVIOUS_RELEASE" "$CURRENT.rollback"
      mv -Tf "$CURRENT.rollback" "$CURRENT"
      echo "Restored release pointer: $PREVIOUS_RELEASE"
    fi

    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || true
    systemctl start "$SERVICE" >/dev/null 2>&1 || true

    for _ in $(seq 1 20); do
      if curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
        echo "Rollback health: OK"
        break
      fi
      sleep 1
    done
  fi

  rm -rf "$WORK" >/dev/null 2>&1 || true

  if [[ -n "$BACKUP_DIR" ]]; then
    echo "Safety backup retained: $BACKUP_DIR"
  fi

  exit "$exit_code"
}

trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

echo "== STAY controlled deployment =="
echo "Archive: $ARCHIVE"
echo "SHA256 : $ARCHIVE_SHA"
echo "Commit : $COMMIT_SHA"

tar -tzf "$ARCHIVE" >/dev/null
tar -xzf "$ARCHIVE" -C "$WORK"

if [[ ! -f "$WORK/package.json" || ! -f "$WORK/server.js" ]]; then
  echo "ERROR: archive is not a STAY release." >&2
  false
fi

RELEASE_VERSION="$("$NODE" -e "const p=require(process.argv[1]); process.stdout.write(String(p.stayVersion || p.version || ''))" "$WORK/package.json")"
if [[ "$RELEASE_VERSION" != "$NAME_VERSION" ]]; then
  echo "ERROR: filename version $NAME_VERSION does not match package stayVersion $RELEASE_VERSION." >&2
  false
fi

FINAL_RELEASE="$RELEASES/${RELEASE_VERSION}-${COMMIT_SHA}"

echo "-- Preflight syntax"
"$NODE" --check "$WORK/server.js"
if [[ -f "$WORK/runtime/kernel/living-kernel.js" ]]; then
  "$NODE" --check "$WORK/runtime/kernel/living-kernel.js"
fi
if [[ -f "$WORK/runtime/ui/live-badge.js" ]]; then
  "$NODE" --check "$WORK/runtime/ui/live-badge.js"
fi

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
systemctl stop "$SERVICE"
STOPPED=1

if ss -ltn | grep -Eq ':(8787|8788)([[:space:]]|$)'; then
  echo "ERROR: STAY ports are still listening after stop." >&2
  false
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/pre-${RELEASE_VERSION}-${STAMP}"
mkdir -p "$BACKUP_DIR"

echo "-- Safety backup: $BACKUP_DIR"
tar -C /var/lib/stay -czf "$BACKUP_DIR/stay-data.tar.gz" data
cp "$IDENTITY_FILE" "$BACKUP_DIR/identity.json"
sha256sum "$BRAIN_FILE" > "$BACKUP_DIR/live-brain.sha256"
readlink -f "$CURRENT" > "$BACKUP_DIR/previous-release.txt"

echo "-- Atomic release switch"
ln -sfn "$FINAL_RELEASE" "$CURRENT.new"
mv -Tf "$CURRENT.new" "$CURRENT"
SWITCHED=1

systemctl daemon-reload
systemctl reset-failed "$SERVICE" || true
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
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "ERROR: Nginx GET / returned HTTP $HTTP_CODE." >&2
  false
fi

echo "-- Browser runtime surfaces"
curl -fsS http://127.0.0.1/__stay/meta >/tmp/stay-deploy-meta.json
curl -fsS http://127.0.0.1/client.js >/tmp/stay-deploy-client.js
if [[ -f "$FINAL_RELEASE/runtime/ui/live-badge.js" ]]; then
  curl -fsS http://127.0.0.1/__stay/live-badge.js >/tmp/stay-deploy-badge.js
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
