STAY 0.7.1.4 — UI placement + deployment automation

Changes:
- STAY release/display version -> 0.7.1.4
- live runtime badge no longer sits on top of the original top-right presence/user UI
- badge anchors dynamically 8px below `.presence`, including resize/mobile changes
- adds permanent controlled deployment engine
- adds optional private-GitHub read-only deployment path
- adds Windows release builder fallback

Files:
- package.json
- runtime/ui/live-badge.js
- deploy/stay-deploy.sh
- deploy/stay-deploy-git.sh
- deploy/install-deployer.sh
- deploy/DEPLOYMENT_AUTOMATION.md
- tools/build-release.ps1

No 0.6 source file is modified.
server.js remains the 0.7.1.3 version with the compute slider and framing fix.

Suggested commit:
STAY 0.7.1.4 fix runtime badge placement and automate deployment
