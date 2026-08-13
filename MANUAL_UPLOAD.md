# STAY 0.7.1.1 — manual upload

This patch avoids GitHub Actions and automated deployment.

## Result
Top-right badge:
`● LIVE · v0.7.1.1 · R<n>`

Click it to see core versions. It polls every second, so it updates without F5. If the kernel restarts, it shows reconnecting and then resumes automatically.

## Versioning
- npm/tooling version stays `0.7.1` because npm expects three-part SemVer.
- STAY's own version is `stayVersion: 0.7.1.1`.
- Future tiny revisions: `0.7.1.2`, `0.7.1.3`, ...
- New milestone: `0.7.2.0`.
- Major developmental runtime: e.g. `0.8.0.0`.

## Files
Replace:
- package.json
- server.js
- runtime/kernel/living-kernel.js

Add:
- runtime/ui/live-badge.js

The preserved 0.6 source is not modified.

## Stop the email flood first
On GitHub:
1. Repository -> Actions
2. Open `Stage STAY 0.7 on Lightsail`
3. `...` -> Disable workflow
4. If desired, also disable `Test STAY`

## Upload
Most reliable: GitHub Desktop.
1. Clone/open `Nickfc/STAY-Genesis`.
2. Switch to `agent/living-runtime-0.7.0`.
3. Extract this ZIP.
4. Copy the four code files into the repo, preserving their paths.
5. Commit: `STAY 0.7.1.1 live version UI`
6. Push.

Do not deploy to Lightsail yet. Verify the commit first, then install it as one immutable release.
