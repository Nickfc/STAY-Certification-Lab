#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo/root." >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -o root -g root -m 0755 "$HERE/stay-deploy.sh" /usr/local/sbin/stay-deploy
install -o root -g root -m 0755 "$HERE/stay-deploy-git.sh" /usr/local/sbin/stay-deploy-git

echo "Installed:"
echo "  /usr/local/sbin/stay-deploy"
echo "  /usr/local/sbin/stay-deploy-git"
echo
echo "Archive path workflow is ready immediately."
echo "Git workflow needs the one-time read-only GitHub source setup described in deploy/DEPLOYMENT_AUTOMATION.md."
