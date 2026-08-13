STAY 0.7.1.11 — GPU Throughput Scaling

Why:
0.7.1.10 proved the GPU path stable, but live testing showed ~3.7–4.0M kernel candidates/s
while the actual candidate search stayed around ~126K/s and GPU utilization was only ~13%.

Root bottleneck:
The GPU job size was hard-capped at 131,072 candidates. At ~4M candidates/s the Radeon
finished that batch in only a few tens of milliseconds, then sat idle waiting for the next epoch.
The contribution slider therefore could not increase real GPU duty once the cap was reached.

Changes:
- Raises absolute batch ceiling from 131,072 to 4,194,304 candidates.
- Runtime-clamps the ceiling to the browser/device WebGPU buffer limits.
- Adds 2D WebGPU dispatch so batches larger than 65,535 workgroups remain legal.
- Slider now targets approximately 8–850 ms of GPU work per one-second epoch.
- Candidate count self-calibrates from measured GPU throughput.
- Leaves ~150 ms headroom at 100% for readback, canonical winner verification, network and UI.
- Live panel shows kernel candidates/s, actual batch size, job milliseconds and job count.

Expected on the currently observed ~3.7–4.0M candidates/s device:
  5%  -> roughly 0.18M candidates / ~45 ms target
  10% -> roughly 0.36M candidates / ~90 ms target
  35% -> roughly 1.2–1.3M candidates / ~315 ms target
  50% -> roughly 1.7–1.8M candidates / ~450 ms target
 100% -> roughly 3.1–3.4M candidates / ~850 ms target

This should make the contribution slider materially affect GPU utilization and actual accepted
candidate throughput instead of hitting the old 131K ceiling almost immediately.

This patch intentionally does NOT yet replace full-score readback with a GPU-side reduction.
That is the next performance tier after measuring this scaling change on real hardware.

No preserved 0.6 source/state is modified.

Suggested commit:
STAY 0.7.1.11 scale GPU batches with real contribution budget

Deploy:
sudo stay-deploy-git
