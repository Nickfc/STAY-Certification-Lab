STAY 0.7.1.8 — WebGPU compile fix

Observed on real Chrome/WebGPU hardware:
  secureContext: true
  supported: true
  ready: false
  lastError: "'target' is a reserved keyword"

Fixes:
- WGSL variable `target` renamed to `expectedValue`.
- Live runtime panel now shows the real WebGPU `lastError`.
- Strict GPU-only mode no longer repeatedly restarts an intentionally zero-sized
  CPU worker pool when the legacy server reports "no verified candidate work".

No preserved 0.6 source file is changed on disk.

Suggested commit:
STAY 0.7.1.8 fix WebGPU shader compile and GPU-only watchdog

Deploy after push:
sudo stay-deploy-git

Then hard-refresh the HTTPS page and select GPU.
