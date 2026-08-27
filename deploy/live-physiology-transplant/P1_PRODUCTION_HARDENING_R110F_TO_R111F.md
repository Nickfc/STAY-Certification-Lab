# P1 production hardening: R110F to R111F

## Purpose

R110F remains immutable failure evidence. Its 12-hour milestone recorded six SNTSS CoreHost faults, four deadline crossings, four SNTSS process transitions, and a terminal non-running SNTSS resident. This forward release repairs the runtime and its evidence contract without changing the frozen SNTSS I4-G1 biological package or resource declaration.

R111F is accepted only when BSF is live, SNTSS I4-G1 and Chronobiology C3 are healthy shadow residents with no authority, the recovered SNTSS instance and lineage are preserved, the final runtime is frozen, and a new 72-hour zero-fault benchmark is running.

## Non-negotiable invariants

- One actor owns one biological event until it is durably committed or the resident enters terminal resynchronization.
- A deadline observes slowness; it does not make an unsettled stateful transition safe to replay.
- Event handling and checkpoint creation are one worker operation.
- Resident checkpoint, input acknowledgement, and output intent cross one SQLite transaction boundary.
- Biological outputs are released only from committed outbox intents.
- Recovery starts only from the last database-committed checkpoint and cannot advance its generation before the failed supervisor has exited.
- Terminal resident status, consumer deactivation, and recovery evidence commit atomically.
- A failed persistence write remains a process-lifetime health fault.
- Public `running` requires a live, healthy resident unit; a stale `RUNNING` database row is insufficient.
- Payload PIDs must exactly match one cgroup leaf, supervisors stay in `stay-kernel`, and SNTSS and Chronobiology payload sets are disjoint.
- The declared 20% SNTSS CPU ceiling remains the exact kernel `cpu.max` quota. Cgroup throttling is observable failure evidence, not a reason for a second userspace limiter to destroy the resident; on non-cgroup test hosts, CPU recycling requires a complete four-sample rolling window and the existing two hard confirmations.
- The SNTSS I4-G1 source tree, version `0.5.0-i4g1`, state schema 5, package policy, individuality, authority `NONE`, outputs 0, and declared resource envelope do not change.

## Pre-restart proof

Before stopping the R110F collector or changing `/opt/stay/current`, the forward script:

1. verifies the host, active R110F release, R108F/R110F freeze chain, R110F 12-hour evidence digest, runtime drop-in, sandbox helper, resident socket, and all staged hashes;
2. captures the R110F resident and durable recovery baseline read-only;
3. builds an immutable candidate and proves the I4-G1 tree is byte-identical to the source release;
4. promotes the complete CoreHost client, wrapper, supervisor, worker, sandbox, protocol, package-policy, cgroup and resource-governor cohort atomically, copies the exact forward recipe into the candidate for self-audit, and rejects any release recipe that omits a cohort member;
5. runs the full hardening suite and preserves its complete TAP output as immutable failure evidence if any pre-restart assertion fails;
6. invokes the exact production preflight entry as `staydeploy` for a separately recorded I4-G1 package-policy and Bubblewrap inspection before the full proof, so loader/bootstrap failures cannot be hidden by API-only tests;
7. runs the full real OS-sandbox preflight as `staydeploy`, including 5,000 deterministic I4-G1 pulses uniformly paced at no more than 5x biological time, with the resource governor left active and every successful combined checkpoint explicitly committed into the recovery watermark, plus forced uncommitted-transition recovery with zero speculative output.

The isolated proof must remain in CoreHost generation 1 with no hard resource action. Its resource tests separately prove that a sustained non-cgroup CPU violator is still contained, while a cgroup-contained payload retains the exact kernel quota and reports throttle deltas without destructive duplicate enforcement. Advancing the recovery watermark does not excuse a recycle; it proves that even an unexpected recovery could only reconstruct database-committed physiology rather than an empty prenatal state.

Any failure before the committed service restart restores the original pointer and restarts the R110F collector.

## Forward transition

The transition closes the failed R110F benchmark with immutable evidence, installs a one-shot R111 cold-resynchronization contract, points to the candidate, and performs one deliberate `stay.service` restart. It then removes the one-shot drop-in without another restart, proves SNTSS and Chronobiology recovery, runs a 130-second live progression gate, creates and verifies `/var/lib/stay/evidence/runtime-freezes/R111.json`, verifies `R111F` public metadata, and starts a clean v3 72-hour collector.

If a failure occurs after the committed restart, the script does not pretend that rollback preserved the organism. It leaves the forward generation running and archives exact evidence for the recovery script.

## Revision-fenced recovery

The recovery script never blindly restarts an R111 process:

- If R111 is already the live durable revision, a restart would advance to R112 and is refused.
- A second R111 start is allowed only when the durable revision is still 110, proving the first start never committed R111.
- An existing R111 freeze is accepted only after cryptographic verification.
- An existing R111 benchmark is reused only when its script, control client, systemd unit, live process, environment, state ledger, and collector identity all match exactly.

## R111F benchmark acceptance

At 15 minutes, 12 hours, and 72 hours the milestone is `PASS` only if all of the following remain true:

- BSF live and healthy, SQLite quick-check `ok`, zero sticky write failures;
- SNTSS I4-G1 and Chronobiology C3 running in shadow with zero authority;
- SNTSS outputs remain zero and Chronobiology durable shadow output advances;
- both checkpoint generations advance;
- zero CoreHost faults, deadlines, resynchronizations, delivery retries, teardown failures, maintenance failures, failed deliveries, or pending outbox intents;
- zero main, SNTSS, Chronobiology, or collector process transitions;
- zero cgroup memory pressure, OOM, PID-limit, or CPU-throttle events;
- exact live/declarative payload PID agreement, distinct resident leaves, correct supervisor placement, and unchanged memory/PID/CPU limits;
- append-only sample ledger and canonical state agree, with fsync-backed milestone/state writes;
- retention-aware recovery-record watermarks cannot hide a new fault when row counts shrink.

The collector never promotes authority after 72 hours. A passing 72-hour record is evidence for a separate, explicit decision. Any observed failure keeps BSF/SNTSS/Chronobiology in their existing safe modes and requires a new forward revision.

## Success markers

The forward path ends with:

```text
P1_PRODUCTION_HARDENING_FORWARD_RESULT=PASS
RUNTIME_REVISION_AFTER=111
REVISION_LABEL=R111F
SNTSS_BIOLOGICAL_PACKAGE_CHANGED=NO
SNTSS_RESOURCE_CONTRACT_CHANGED=NO
BENCHMARK_CONTRACT=V3_ZERO_FAULT_ZERO_TRANSITION
BENCHMARK_SERVICE=ACTIVE
```

The recovery path, when needed, ends with `P1_PRODUCTION_HARDENING_FORWARD_RECOVERY_RESULT=PASS` and the same R111F benchmark contract.
