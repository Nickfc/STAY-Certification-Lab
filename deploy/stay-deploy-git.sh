#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE="/opt/stay/source"
BRANCH="${STAY_DEPLOY_BRANCH:-agent/living-runtime-0.7.0}"
INCOMING="/opt/stay/incoming"
NODE="/usr/local/bin/node"
BWRAP="/usr/bin/bwrap"
STAY_USER="staydeploy"

if [[ "${EUID}" -ne 0 ]]; then echo "ERROR: run with sudo/root." >&2; exit 1; fi
if [[ ! -d "$SOURCE/.git" ]]; then echo "ERROR: $SOURCE is not configured." >&2; exit 2; fi
if [[ ! -x "$BWRAP" ]]; then echo "ERROR: bubblewrap is required for isolated candidate build." >&2; exit 2; fi

echo "== Fetching STAY source for ISOLATED STAGING ONLY =="
sudo -u "$STAY_USER" git -C "$SOURCE" fetch --prune origin "$BRANCH"
if [[ -n "${1:-}" ]]; then
  COMMIT="$1"; [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "ERROR: commit must be full SHA" >&2; exit 2; }
  sudo -u "$STAY_USER" git -C "$SOURCE" cat-file -e "${COMMIT}^{commit}"
else COMMIT="$(sudo -u "$STAY_USER" git -C "$SOURCE" rev-parse FETCH_HEAD)"; fi
PACKAGE_JSON="$(sudo -u "$STAY_USER" git -C "$SOURCE" show "${COMMIT}:package.json")"
VERSION="$(printf '%s' "$PACKAGE_JSON" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write(String(p.stayVersion||p.version||""));});')"
[[ -n "$VERSION" ]] || { echo "ERROR: could not determine version" >&2; exit 2; }

install -d -o "$STAY_USER" -g "$STAY_USER" -m 0750 "$INCOMING"
ARCHIVE="$INCOMING/stay-${VERSION}-${COMMIT}.tar.gz"
BUILD_DIR="$(mktemp -d "$INCOMING/.git-release-${VERSION}-XXXXXX")"
chown "$STAY_USER:$STAY_USER" "$BUILD_DIR"; chmod 0700 "$BUILD_DIR"
trap 'rm -rf "$BUILD_DIR"' EXIT

sudo -u "$STAY_USER" git -C "$SOURCE" archive --format=tar --output="$BUILD_DIR/source.tar" "$COMMIT"
sudo -u "$STAY_USER" tar -xf "$BUILD_DIR/source.tar" -C "$BUILD_DIR"
rm "$BUILD_DIR/source.tar"; rm -rf "$BUILD_DIR/data" "$BUILD_DIR/.stay-data" "$BUILD_DIR/release-output"

# Candidate release tooling is never executed in the host namespace. It gets a
# writable copy of its own build tree, no network, and no /var/lib/stay mount.
sudo -u "$STAY_USER" "$BWRAP" \
  --die-with-parent --new-session --unshare-all --unshare-user --disable-userns --cap-drop ALL \
  --proc /proc --dev /dev --dir /tmp --dir /var --dir /run \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/sbin /sbin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --bind "$BUILD_DIR" /build --chdir /build --clearenv --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv NODE_ENV test \
  /usr/local/bin/node /build/runtime/release/sntss-release-control.js emit \
    --root /build --version "$VERSION" --commit "$COMMIT" --builder stay-deploy-git-isolated --branch "$BRANCH"

sudo -u "$STAY_USER" "$BWRAP" \
  --die-with-parent --new-session --unshare-all --unshare-user --disable-userns --cap-drop ALL \
  --proc /proc --dev /dev --dir /tmp --dir /var --dir /run \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/sbin /sbin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --bind "$BUILD_DIR" /build --chdir /build --clearenv --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv NODE_ENV test \
  /usr/local/bin/node /build/runtime/release/sntss-release-control.js verify --root /build

sudo -u "$STAY_USER" bash -c "tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner -C '$BUILD_DIR' -cf - . | gzip -n > '$ARCHIVE.tmp'"
chown "$STAY_USER:$STAY_USER" "$ARCHIVE.tmp"; chmod 0600 "$ARCHIVE.tmp"; mv "$ARCHIVE.tmp" "$ARCHIVE"
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"; chown "$STAY_USER:$STAY_USER" "$ARCHIVE.sha256"; chmod 0600 "$ARCHIVE.sha256"

echo "STAGING COMPLETE: $ARCHIVE"
echo "Activation was NOT invoked. The archive now requires an external .authorization.json signature before stay-deploy will accept it."
