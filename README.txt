STAY 0.7.1.9 — GPU genome contract fix

Observed on real GPU-only execution:
  GPU task genome has unexpected size

Root cause:
The canonical 0.6 cognitive network is:
  31 inputs
  8 hidden neurons
  12 outputs

Genome size is therefore:
  (31 + 1) * 8 + (8 + 1) * 12 = 364

The 0.6 cognitive core computes this correctly, but an old comment said 308.
The first WebGPU engine copied that stale comment into a hard-coded constant.

Fixes:
- WebGPU GENOME_SIZE is now derived from INPUTS/HIDDEN/OUTPUTS, yielding 364.
- Runtime verifies GPU GENOME_SIZE matches GenesisCognitive.GENOME_SIZE.
- Genome-size failures now report both actual and expected sizes.
- Repository deploy/stay-deploy.sh is synchronized with the HTTPS-aware production deployer:
  HTTP 308 redirect is healthy, and browser-surface checks use the kernel directly on 8787.

No preserved 0.6 source/state is modified.

Suggested commit:
STAY 0.7.1.9 fix GPU genome contract and sync HTTPS deployer

Deploy after push:
sudo stay-deploy-git
