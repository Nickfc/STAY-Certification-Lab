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
TRUSTED_VERIFIER="/usr/local/lib/stay/trusted-release-verifier.js"
RELEASE_AUTHORITY_KEY="/etc/stay/release-authority.pub"
BWRAP="/usr/bin/bwrap"

sqlite_quick_check() {
  local database_path="$1"
  "$NODE" - "$database_path" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const row = db.prepare('PRAGMA quick_check').get();
  if (String(row?.quick_check || '').toLowerCase() !== 'ok') throw new Error('continuity SQLite quick_check failed');
} finally { db.close(); }
NODE
}

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
AUTHORIZATION_FILE="$ARCHIVE.authorization.json"

if [[ ! "$BASE_NAME" =~ ^stay-([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)-([0-9a-f]{40})\.tar\.gz$ ]]; then
  echo "ERROR: archive name must be stay-X.Y.Z.R-<40-char-sha>.tar.gz" >&2
  exit 2
fi
NAME_VERSION="${BASH_REMATCH[1]}"
COMMIT_SHA="${BASH_REMATCH[2]}"
ARCHIVE_SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"

for required in "$CHECKSUM_FILE" "$AUTHORIZATION_FILE" "$TRUSTED_VERIFIER" "$RELEASE_AUTHORITY_KEY" "$BWRAP"; do
  if [[ ! -e "$required" ]]; then
    echo "ERROR: required trusted deployment artifact is missing: $required" >&2
    exit 2
  fi
done
if [[ ! -x "$BWRAP" ]]; then echo "ERROR: bubblewrap is not executable: $BWRAP" >&2; exit 2; fi
assert_root_trust_file() {
  local target="$1" label="$2" uid mode
  uid="$(stat -Lc '%u' "$target")"
  mode="$(stat -Lc '%a' "$target")"
  if [[ "$uid" != "0" ]] || (( (8#$mode & 022) != 0 )); then
    echo "ERROR: trusted $label must be root-owned and not group/world writable: $target" >&2
    exit 2
  fi
}
assert_root_trust_file "$TRUSTED_VERIFIER" "release verifier"
assert_root_trust_file "$RELEASE_AUTHORITY_KEY" "release authority public key"

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
STATE_ROLLBACK_POLICY="preserve-forward-state"
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
      if ln -sfn "$PREVIOUS_RELEASE" "$CURRENT.rollback" && mv -Tf "$CURRENT.rollback" "$CURRENT"; then
        echo "Restored release pointer: $PREVIOUS_RELEASE"
      else
        rollback_failed=1
        echo "CRITICAL: failed to restore release pointer to $PREVIOUS_RELEASE" >&2
      fi
    fi
    if [[ "$STATE_STARTED" -eq 1 ]]; then
      if [[ "$STATE_ROLLBACK_POLICY" != "preserve-forward-state" ]]; then
        rollback_failed=1
        echo "CRITICAL: refusing automatic state rollback without preserve-forward-state policy." >&2
      elif [[ -n "$BACKUP_DIR" ]]; then
        FAILED_STATE_DIR="$BACKUP_DIR/failed-forward-state-$(date -u +%Y%m%dT%H%M%SZ)"
        if mkdir -p "$FAILED_STATE_DIR" \
          && tar -C /var/lib/stay -czf "$FAILED_STATE_DIR/stay-data-forward.tar.gz" data \
          && sha256sum "$FAILED_STATE_DIR/stay-data-forward.tar.gz" > "$FAILED_STATE_DIR/stay-data-forward.tar.gz.sha256" \
          && sha256sum -c "$FAILED_STATE_DIR/stay-data-forward.tar.gz.sha256"; then
          echo "Canonical forward StateStore preserved in place; failed-forward-state evidence retained at: $FAILED_STATE_DIR"
        else
          rollback_failed=1
          echo "CRITICAL: failed to retain forward-state evidence; canonical StateStore was not overwritten." >&2
        fi
      fi
    fi
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || true
    systemctl start "$SERVICE" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      if curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then rollback_healthy=1; echo "Rollback health: OK"; break; fi
      sleep 1
    done
    if [[ "$rollback_healthy" -ne 1 ]]; then rollback_failed=1; echo "CRITICAL: rollback code did not become healthy against the preserved forward state." >&2; fi
  fi
  [[ -n "$WORK" ]] && rm -rf "$WORK" >/dev/null 2>&1 || true
  [[ -n "$BACKUP_DIR" ]] && echo "Safety backup retained as emergency recovery evidence: $BACKUP_DIR"
  if [[ "$rollback_failed" -ne 0 ]]; then
    echo "CRITICAL: automatic rollback was incomplete; manual recovery is required. Preserve all evidence and follow the recovery runbook." >&2
    exit 125
  fi
  exit "$exit_code"
}
trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

echo "== STAY controlled deployment / trusted boundary v1 =="
echo "Archive: $ARCHIVE"
echo "SHA256 : $ARCHIVE_SHA"
echo "Commit : $COMMIT_SHA"

python3 - "$ARCHIVE" <<'PY'
import pathlib, sys, tarfile
archive = pathlib.Path(sys.argv[1])
with tarfile.open(archive, 'r:gz') as tf:
    members = tf.getmembers()
    if not members: raise SystemExit('ERROR: release archive is empty')
    if len(members) > 100000: raise SystemExit('ERROR: release archive contains too many members')
    if sum(member.size for member in members) > 2 * 1024 * 1024 * 1024: raise SystemExit('ERROR: release archive expands beyond the 2 GiB safety limit')
    for member in members:
        name = pathlib.PurePosixPath(member.name)
        if member.size > 512 * 1024 * 1024: raise SystemExit(f'ERROR: archive member exceeds 512 MiB: {member.name!r}')
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()): raise SystemExit(f'ERROR: unsupported archive member type: {member.name!r}')
        if name.is_absolute() or '..' in name.parts or member.isdev() or member.isfifo(): raise SystemExit(f'ERROR: unsafe archive member: {member.name!r}')
        if member.issym() or member.islnk():
            target = pathlib.PurePosixPath(member.linkname)
            resolved = name.parent.joinpath(target)
            if target.is_absolute() or '..' in resolved.parts: raise SystemExit(f'ERROR: unsafe archive link: {member.name!r} -> {member.linkname!r}')
PY

tar --no-same-owner --no-same-permissions -xzf "$ARCHIVE" -C "$WORK"
if [[ ! -f "$WORK/package.json" || ! -f "$WORK/server.js" || ! -f "$WORK/RELEASE_PROVENANCE.json" || ! -f "$WORK/RELEASE_INVENTORY.json" ]]; then
  echo "ERROR: archive is not a complete STAY release." >&2; false
fi
RELEASE_VERSION="$("$NODE" -e "const p=require(process.argv[1]); process.stdout.write(String(p.stayVersion || p.version || ''))" "$WORK/package.json")"
if [[ "$RELEASE_VERSION" != "$NAME_VERSION" ]]; then echo "ERROR: filename/package version mismatch" >&2; false; fi

# CRITICAL TRUST ORDER: no candidate JavaScript has executed before this point.
# Historical R10 compatibility marker only: sntss-release-control.js" verify is NOT executed by this deployer.
# This verifier is installed root-owned outside /opt/stay and contains no imports
# from the candidate. Its Ed25519 public key is also host-owned.
echo "-- Host-owned signature, provenance and byte-inventory verification"
"$NODE" "$TRUSTED_VERIFIER" verify \
  --root "$WORK" --archive "$ARCHIVE" --authorization "$AUTHORIZATION_FILE" \
  --public-key "$RELEASE_AUTHORITY_KEY" --expected-version "$RELEASE_VERSION" \
  --expected-commit "$COMMIT_SHA" --action activate

PROVENANCE_FORMAT="$("$NODE" -e "const p=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(String(p.format||''))" "$WORK/RELEASE_PROVENANCE.json")"
STATE_ROLLBACK_POLICY="$("$NODE" -e "const p=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(String(p.stateRollbackPolicy||''))" "$WORK/RELEASE_PROVENANCE.json")"
if [[ "$PROVENANCE_FORMAT" != "stay-release-provenance-v2" || "$STATE_ROLLBACK_POLICY" != "preserve-forward-state ]]; then echo "ERROR: R10 provenance contract missing" >&2; false; fi

# Parsing candidate JS is non-executing. Executable preflight happens only inside
# a disposable bubblewrap namespace with no /var/lib/stay, no network and a
# read-only candidate filesystem.
echo "-- Preflight syntax"
while IFS= read -r -d '' source_file; do "$NODE" --check "$source_file"; done < <(find "$WORK/runtime" "$WORK/scripts" "$WORK/cores" -type f -name '*.js' -print0)
"$NODE" --check "$WORK/server.js"

echo "-- Isolated continuity test (candidate has no live-StateStore view)"
sudo -u "$STAY_USER" "$BWRAP" \
  --die-with-parent --new-session --unshare-all --disable-userns --cap-drop ALL \
  --proc /proc --dev /dev --dir /tmp --dir /var --dir /run \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/sbin /sbin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --ro-bind "$WORK" /stay-release --chdir /stay-release --clearenv \
  --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv NODE_ENV test \
  /usr/local/bin/node --disable-sigusr1 /stay-release/scripts/continuity-check.js

chown -R root:root "$WORK"
find "$WORK" -type d -exec chmod 0555 {} \;
find "$WORK" -type f -exec chmod 0444 {} \;
FINAL_RELEASE="$RELEASES/${RELEASE_VERSION}-${COMMIT_SHA}"
if [[ -e "$FINAL_RELEASE" ]]; then echo "ERROR: immutable release already exists: $FINAL_RELEASE" >&2; false; fi
mv "$WORK" "$FINAL_RELEASE"; WORK=""

PREVIOUS_RELEASE="$(readlink -f "$CURRENT" 2>/dev/null || true)"
if [[ -z "$PREVIOUS_RELEASE" || ! -d "$PREVIOUS_RELEASE" ]]; then echo "ERROR: current release pointer is invalid." >&2; false; fi
IDENTITY_FILE="$DATA_ROOT/life/identity.json"
BRAIN_FILE="$DATA_ROOT/legacy-0.6.0/genesis-state.json"
CONTINUITY_DB="$DATA_ROOT/continuity.sqlite3"
IDENTITY_SHA_BEFORE="$(sha256sum "$IDENTITY_FILE" | awk '{print $1}')"
BRAIN_MTIME_BEFORE="$(stat -c %Y "$BRAIN_FILE")"

echo "-- Current release: $PREVIOUS_RELEASE"
echo "-- Identity SHA : $IDENTITY_SHA_BEFORE"
echo "-- Clean stop"
STOPPED=1
systemctl stop "$SERVICE"
if ss -ltn | grep -Eq ':(8787|8788)([[:space:]]|$)'; then echo "ERROR: STAY ports still listening after stop." >&2; false; fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/pre-${RELEASE_VERSION}-${STAMP}"
mkdir -p "$BACKUP_DIR"
tar -C /var/lib/stay -czf "$BACKUP_DIR/stay-data.tar.gz" data
sha256sum "$BACKUP_DIR/stay-data.tar.gz" > "$BACKUP_DIR/stay-data.tar.gz.sha256"
sha256sum -c "$BACKUP_DIR/stay-data.tar.gz.sha256"
cp "$IDENTITY_FILE" "$BACKUP_DIR/identity.json"
cp "$AUTHORIZATION_FILE" "$BACKUP_DIR/release-authorization.json"
sha256sum "$BRAIN_FILE" > "$BACKUP_DIR/live-brain.sha256"
readlink -f "$CURRENT" > "$BACKUP_DIR/previous-release.txt"
printf '%s\n' "$STATE_ROLLBACK_POLICY" > "$BACKUP_DIR/state-rollback-policy.txt"

if [[ -f "$CONTINUITY_DB" ]]; then
  echo "-- Existing StateStore quick check"; sqlite_quick_check "$CONTINUITY_DB"
else
  echo "-- Pre-v3 dataset detected; validating migration inputs"
  "$NODE" - "$IDENTITY_FILE" "$BRAIN_FILE" <<'NODE'
const fs = require('node:fs');
const identity = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const brain = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (!identity || typeof identity !== 'object' || !identity.organismId || !identity.createdAt || identity.lineage !== 'STAY/Genesis') throw new Error('pre-v3 organism identity is incomplete or invalid');
if (!brain || typeof brain !== 'object' || Array.isArray(brain)) throw new Error('pre-v3 legacy brain state is missing or invalid');
console.log('Pre-v3 identity and legacy brain: OK');
NODE
fi

echo "-- Atomic release switch"
ln -sfn "$FINAL_RELEASE" "$CURRENT.new"; mv -Tf "$CURRENT.new" "$CURRENT"; SWITCHED=1
systemctl daemon-reload; systemctl reset-failed "$SERVICE" || true; STATE_STARTED=1; systemctl start "$SERVICE"

echo "-- Waiting for health"
HEALTH=""
for _ in $(seq 1 30); do if HEALTH="$(curl -fsS http://127.0.0.1:8787/healthz 2>/dev/null)"; then break; fi; sleep 1; done
if [[ -z "$HEALTH" ]]; then echo "ERROR: health endpoint did not recover." >&2; false; fi
echo "$HEALTH"
"$NODE" -e 'const h=JSON.parse(process.argv[1]);const expected=process.argv[2];if(h.ok!==true)throw new Error("health is not OK");if(h.version!==expected)throw new Error(`expected STAY ${expected}, got ${h.version}`);' "$HEALTH" "$RELEASE_VERSION"

IDENTITY_SHA_AFTER="$(sha256sum "$IDENTITY_FILE" | awk '{print $1}')"
if [[ "$IDENTITY_SHA_AFTER" != "$IDENTITY_SHA_BEFORE" ]]; then echo "ERROR: organism identity changed during release switch." >&2; false; fi
echo "-- Identity continuity: OK"
if [[ ! -f "$CONTINUITY_DB" ]]; then echo "ERROR: StateStore v3 database was not created by the candidate." >&2; false; fi
sqlite_quick_check "$CONTINUITY_DB"; echo "-- StateStore v3 migration/integrity: OK"

curl -fsS http://127.0.0.1:8787/__stay/meta >/tmp/stay-deploy-meta.json
curl -fsS http://127.0.0.1:8787/client.js >/tmp/stay-deploy-client.js

echo "-- Waiting for legacy brain persistence"
BRAIN_SAVED=0
for _ in $(seq 1 20); do sleep 1; BRAIN_MTIME_AFTER="$(stat -c %Y "$BRAIN_FILE")"; if [[ "$BRAIN_MTIME_AFTER" -gt "$BRAIN_MTIME_BEFORE" ]]; then BRAIN_SAVED=1; break; fi; done
if [[ "$BRAIN_SAVED" -ne 1 ]]; then echo "ERROR: legacy brain did not produce a new persistent save after restart." >&2; false; fi
echo "-- Legacy persistence: OK"

echo
echo "DEPLOYMENT ACCEPTED"
echo "STAY     : $RELEASE_VERSION"
echo "Commit   : $COMMIT_SHA"
echo "Release  : $FINAL_RELEASE"
echo "Backup   : $BACKUP_DIR"
echo "SHA256   : $ARCHIVE_SHA"
echo "State rollback policy: $STATE_ROLLBACK_POLICY"
echo "No manual rollback is required."
