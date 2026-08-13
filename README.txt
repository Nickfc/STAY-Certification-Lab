STAY 0.7.1.7 — Strict GPU-only semantics

Fixes two confusing behaviors in 0.7.1.6:

1. Selecting GPU no longer silently falls back to CPU.
   - GPU selected + GPU ready: CPU share = 0%, GPU gets the selected contribution.
   - GPU selected + GPU unavailable/not secure: CPU share = 0%, GPU work pauses.
   - The panel explicitly says GPU ONLY / CPU fallback OFF.

2. Auto remains the fallback mode.
   - Auto + GPU ready -> GPU
   - Auto + GPU unavailable -> CPU

3. Hybrid no longer reallocates the missing GPU share to CPU.
   Example: Hybrid 80/20 with GPU unavailable keeps only the CPU 20% portion active;
   the GPU 80% portion is paused until WebGPU is available.

IMPORTANT:
WebGPU itself still requires a secure context. If STAY is opened over plain HTTP,
GPU-only mode will correctly show 0% CPU and 0% GPU rather than pretending GPU mode works.

After push:
  sudo stay-deploy-git

If HTTPS has not yet been enabled:
  certbot --version
  sudo /opt/stay/current/deploy/enable-ip-https.sh 35.157.242.167

Suggested commit:
STAY 0.7.1.7 make GPU mode strict with zero CPU fallback
