STAY 0.7.1.12 — Fetus Memory Guardian

Why
---
The overnight endurance run exposed a real production failure: the preserved 0.6 fetus
reached the Node/V8 heap limit after several hours of high-throughput distributed compute.
The Living Kernel survived, but the legacy child exited with SIGABRT and was not restarted.

This release protects continuity without modifying any preserved 0.6 source bytes.

What changes
------------
1. Memory guardian around the immutable 0.6 child
   - samples Linux /proc/<pid>/status every 15 seconds
   - warning threshold defaults to 512 MiB RSS
   - controlled recycle threshold defaults to 700 MiB RSS
   - requires 2 consecutive high samples before recycling
   - thresholds are configurable with environment variables

2. Graceful continuity-preserving recycle
   - creates a pre-recycle copy of the last durable genesis-state.json
   - sends SIGTERM so 0.6 can persist its active state normally
   - verifies whether state mtime advanced
   - respawns the same preserved 0.6 source against the same state path
   - retains only the 3 newest guardian backup copies

3. Unexpected crash recovery
   - if the fetus exits unexpectedly, Living Kernel automatically respawns it
   - exponential backoff prevents rapid restart loops
   - restart-storm protection delays retries after repeated failures

4. Bounded memory telemetry
   - stores current status in /var/lib/stay/data/legacy-0.6.0/memory-guardian.json
   - keeps up to 720 one-minute samples (about 12 hours) for leak/slope diagnosis
   - reports RSS, peak RSS, recycle count, crash restart count and last events

5. Live UI telemetry
   - the runtime panel shows fetus RSS / guard threshold
   - G<n> = proactive guardian recycles
   - R<n> = unexpected crash restarts

Important
---------
This is a containment + diagnostic fix, not a claim that the underlying 0.6 allocation
growth has already been identified. It prevents another hard V8 OOM while collecting the
memory curve we need to identify the actual retained objects later.

The immutable 0.6 source hashes and the original hibernation-state contract are unchanged.

Defaults
--------
STAY_FETUS_GUARDIAN_INTERVAL_MS=15000
STAY_FETUS_GUARDIAN_HISTORY_MS=60000
STAY_FETUS_WARN_RSS_MIB=512
STAY_FETUS_RECYCLE_RSS_MIB=700
STAY_FETUS_RECYCLE_CONFIRMATIONS=2
STAY_FETUS_GRACEFUL_STOP_MS=8000
STAY_FETUS_CRASH_WINDOW_MS=600000
STAY_FETUS_MAX_CRASH_RESTARTS=5

Suggested commit
----------------
STAY 0.7.1.12 add fetus memory guardian and crash recovery

Deploy
------
sudo stay-deploy-git
