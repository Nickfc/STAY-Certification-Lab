STAY 0.7.1.2 public HTML proxy framing fix

Changes only:
- package.json: STAY display/release version 0.7.1.1 -> 0.7.1.2
- server.js: removes upstream Transfer-Encoding before setting the injected HTML Content-Length

Why:
Nginx rejected GET / with:
  upstream sent "Content-Length" and "Transfer-Encoding" headers at the same time

Kernel/core code is unchanged. The Living Kernel remains 0.7.1.1.
The preserved 0.6 source is unchanged.

Copy these two code files into the existing repo root, commit and push manually with Actions disabled.
Suggested commit:
  STAY 0.7.1.2 fix injected HTML response framing
