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

mkdir -p "$INCOMING"
ARCHIVE="$INCOMING/stay-${VERSION}-${COMMIT}.tar.gz"

echo "Building immutable release:"
echo "  STAY   $VERSION"
echo "  commit $COMMIT"

sudo -u "$STAY_USER" git -C "$SOURCE" archive --format=tar.gz --output="$ARCHIVE.tmp" "$COMMIT"
chown "$STAY_USER:$STAY_USER" "$ARCHIVE.tmp"
chmod 0600 "$ARCHIVE.tmp"
mv "$ARCHIVE.tmp" "$ARCHIVE"

exec /usr/local/sbin/stay-deploy "$ARCHIVE"
