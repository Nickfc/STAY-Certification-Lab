STAY 0.7.1.5 — Quiet Distributed Compute

Purpose:
Keep the user's selected compute contribution as the TOTAL amount of donated CPU time,
but deliver it much more gently across the machine.

At 2% on a 24-thread machine:
- target remains about 480 CPU-ms per second total
- Quiet Spread uses up to 12 workers at low loads
- each worker receives a much smaller budget (about 40 ms at 2%)
- worker starts are staggered across most of the one-second cognitive epoch
- each worker's budget is split into short 5–20 ms active slices with scheduler yields
- this reduces long single-core boost bursts and should reduce temperature/fan spikes

The browser still controls actual thread placement; Web Workers cannot pin themselves to
specific CPU cores. The OS/browser scheduler decides which cores execute each worker.

Also included:
- STAY release/display version 0.7.1.5
- .gitattributes forces Linux shell scripts to LF line endings
- top-right panel reports Quiet Spread worker count, slice size and spread window

Changed files:
- package.json
- server.js
- runtime/ui/live-badge.js
- .gitattributes

No preserved 0.6 source file is modified on disk.

Suggested commit:
STAY 0.7.1.5 add quiet distributed compute scheduler

After pushing, deploy with:
sudo stay-deploy-git
