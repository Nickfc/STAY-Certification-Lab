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
"$NODE" -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({format:'stay-release-provenance-v1',version:process.argv[2],commit:process.argv[3],builder:'stay-deploy-git',branch:process.argv[4]}, null, 2) + '\n')" "$BUILD_DIR/RELEASE_PROVENANCE.json" "$VERSION" "$COMMIT" "$BRANCH"
chown -R "$STAY_USER:$STAY_USER" "$BUILD_DIR"
sudo -u "$STAY_USER" tar -C "$BUILD_DIR" --exclude='./source.tar' -czf "$ARCHIVE.tmp" .
chown "$STAY_USER:$STAY_USER" "$ARCHIVE.tmp"
chmod 0600 "$ARCHIVE.tmp"
mv "$ARCHIVE.tmp" "$ARCHIVE"
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
chown "$STAY_USER:$STAY_USER" "$ARCHIVE.sha256"
chmod 0600 "$ARCHIVE.sha256"

exec /usr/local/sbin/stay-deploy "$ARCHIVE"
