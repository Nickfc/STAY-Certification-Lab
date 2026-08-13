STAY 0.7.1.6 — GPU Compute Foundation

What this release adds
----------------------
1. Compute engine selector in the live top-right panel:
   Auto / GPU / CPU / Hybrid

2. Real WebGPU candidate search:
   - candidate genome mutations run on a WebGPU compute shader
   - neural forward passes and fitness scoring run on the GPU
   - only candidate scores are read back
   - the GPU-selected winner is re-scored with the canonical JavaScript cognitive core
     before submission so the existing server-side 1e-7 winner verification remains valid

3. Auto mode:
   - HTTPS + WebGPU available -> GPU
   - otherwise -> CPU fallback

4. GPU mode:
   - uses GPU search only when available
   - safely falls back to CPU if WebGPU initialization fails

5. Hybrid mode:
   - default 80% of the user's selected contribution goes to GPU
   - 20% goes to CPU
   - the GPU share is adjustable from 10–90%

6. Existing contribution slider still represents the user's total requested contribution.

7. One-time HTTPS helper:
   deploy/enable-ip-https.sh
   WebGPU requires a secure context. The helper obtains a short-lived Let's Encrypt
   IP certificate and converts nginx to HTTPS while retaining /runtime/ blocking.

Important
---------
The preserved 0.6 source remains byte-for-byte untouched on disk.
The Living Kernel transforms the served browser client and injects the GPU engine.

Suggested commit:
STAY 0.7.1.6 add WebGPU compute engine and hybrid selector

Normal code deployment after push:
sudo stay-deploy-git

Then, once, on Lightsail for WebGPU:
sudo /opt/stay/current/deploy/enable-ip-https.sh 35.157.242.167

The HTTPS helper requires Certbot 5.4+.
