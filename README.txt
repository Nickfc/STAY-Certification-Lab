STAY 0.7.1.3 — per-browser compute slider

Files to replace:
- package.json
- server.js
- runtime/ui/live-badge.js

What changes:
- STAY release/display version: 0.7.1.3
- Top-right live panel gains a 1–100% compute contribution slider.
- Default contribution is 5%.
- Setting is stored locally in that browser.
- Changing it restarts only that browser's Worker pool; the server/organism does not restart.
- Low percentages use fewer Workers and smaller real CPU-time budgets.
- Requested and effective contribution are shown separately.
- Legacy 0.6 source files on disk are untouched; the Living Kernel transforms served client.js/worker.js responses in transit.
- Includes the 0.7.1.2 Content-Length/Transfer-Encoding framing fix.

Suggested manual commit (Actions disabled):
STAY 0.7.1.3 add live compute contribution slider
