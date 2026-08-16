#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE="/opt/stay/source"
BRANCH="${STAY_DEPLOY_BRANCH:-agent/living-runtime-0.7.0}"
INCOMING="/opt/stay/incoming"
NODE="/usr/local/bin/node"
STAY_USER="staydeploy"

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run with sudo/root." >&2
  exit 1
fi

if [[ ! -d "$SOURCE/.git" ]]; then
  echo "ERROR: $SOURCE is not configured. Run the one-time GitHub source setup first." >&2
  exit 2
fi

echo "== Fetching STAY from GitHub =="
sudo -u "$STAY_USER" git -C "$SOURCE" fetch --prune origin "$BRANCH"

if [[ -n "${1:-}" ]]; then
  COMMIT="$1"
  if [[ ! "$COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ERROR: optional commit must be a full 40-character SHA." >&2
    exit 2
  fi
  sudo -u "$STAY_USER" git -C "$SOURCE" cat-file -e "${COMMIT}^{commit}"
else
  COMMIT="$(sudo -u "$STAY_USER" git -C "$SOURCE" rev-parse FETCH_HEAD)"
fi

PACKAGE_JSON="$(sudo -u "$STAY_USER" git -C "$SOURCE" show "${COMMIT}:package.json")"
VERSION="$(printf '%s' "$PACKAGE_JSON" | "$NODE" -e '
let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => {
  const p=JSON.parse(s); process.stdout.write(String(p.stayVersion || p.version || ""));
});
')"

if [[ -z "$VERSION" ]]; then
  echo "ERROR: could not determine STAY version from commit $COMMIT." >&2
  exit 2
fi

install -d -o "$STAY_USER" -g "$STAY_USER" -m 0750 "$INCOMING"
ARCHIVE="$INCOMING/stay-${VERSION}-${COMMIT}.tar.gz"
BUILD_DIR="$(mktemp -d "$INCOMING/.git-release-${VERSION}-XXXXXX")"
chown "$STAY_USER:$STAY_USER" "$BUILD_DIR"
chmod 0700 "$BUILD_DIR"
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "Building immutable release:"
echo "  STAY   $VERSION"
echo "  commit $COMMIT"

sudo -u "$STAY_USER" git -C "$SOURCE" archive --format=tar --output="$BUILD_DIR/source.tar" "$COMMIT"
sudo -u "$STAY_USER" tar -xf "$BUILD_DIR/source.tar" -C "$BUILD_DIR"
rm "$BUILD_DIR/source.tar"
rm -rf "$BUILD_DIR/data" "$BUILD_DIR/.stay-data" "$BUILD_DIR/release-output"

RELEASE_CONTROL="$BUILD_DIR/runtime/release/sntss-release-control.js"
if [[ ! -f "$RELEASE_CONTROL" ]]; then
  echo "ERROR: R10 release-control module is missing from candidate." >&2
  exit 2
fi

sudo -u "$STAY_USER" "$NODE" "$RELEASE_CONTROL" emit --root "$BUILD_DIR" --version "$VERSION" --commit "$COMMIT" --builder stay-deploy-git --branch "$BRANCH"
sudo -u "$STAY_USER" "$NODE" "$RELEASE_CONTROL" verify --root "$BUILD_DIR"

sudo -u "$STAY_USER" bash -c "tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner -C '$BUILD_DIR' -cf - . | gzip -n > '$ARCHIVE.tmp'"
chown "$STAY_USER:$STAY_USER" "$ARCHIVE.tmp"
chmod 0600 "$ARCHIVE.tmp"
mv "$ARCHIVE.tmp" "$ARCHIVE"
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
chown "$STAY_USER:$STAY_USER" "$ARCHIVE.sha256"
chmod 0600 "$ARCHIVE.sha256"

if [[ "${STAY_STAGE_ONLY:-0}" == "1" ]]; then
  echo "STAGE ONLY: archive and sidecar created; live deployment was not invoked."
  echo "$ARCHIVE"
  exit 0
fi

exec /usr/local/sbin/stay-deploy "$ARCHIVE"
