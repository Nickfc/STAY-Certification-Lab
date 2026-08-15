# STAY 0.8.11.1 Validation Report

> Superseded by `VALIDATION_REPORT_0.8.11.2.md`. This historical report does not describe the hardened repair candidate and must not be used as current release evidence.

## Baseline

- source baseline: `Nickfc/STAY-Genesis`, branch `agent/living-runtime-0.7.0`
- baseline commit: `41f7c5fabfae10de398b63f1ca7b5f2bc694264b`
- all 48 baseline blobs were reconstructed and hash-verified before modification
- fetus compatibility wrapper and 0.6 fingerprint files remain byte-identical

## Completed verification

- JavaScript syntax checks for server, runtime, CoreHost, compute and browser files
- 19 automated tests covering continuity, native permission isolation, authority, StateStore, bounds, compute and immutable legacy artifacts
- standalone continuity closure check
- crash and hang failure-injection lab
- short endurance harness smoke run
- SQLite WAL/FULL and snapshot-integrity verification

## Explicitly not claimed

- real WebGPU compilation on every target adapter
- measured GPU duty tolerance on physical hardware
- physically quiet 5% CPU behavior on the Ryzen PC
- multi-hour desktop/mobile browser memory stability
- required 24-hour and 72-hour heterogeneous certification

Those items are empirical certification gates, not unit-test claims. See `ENDURANCE_CERTIFICATION_0.8.md`.
