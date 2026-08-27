# P1 production hardening: R110F to contained R114F repair

The historical filename is retained because it is part of the immutable V8
release lineage. The original R111F target was not attained and must never be
reported as attained. The guarded V8 rollout produced one durable Kernel start
at R111, then the required `fetus-legacy` boot install advanced the runtime to
R112. The R111 recovery correctly refused another restart because that would
have falsified the revision lineage.

## Sealed production findings

The failed forward and recovery evidence is immutable and SHA-256 fenced. Its
durable journal proves:

- R111 was created by the single `kernel.start` at 2026-08-27T22:55:29.649Z;
- R112 was created by the required `core.install` of `fetus-legacy` at
  2026-08-27T22:55:30.866Z;
- SNTSS resynchronized at R111 with zero abandoned deliveries and no invented
  biological time, then entered a restart storm when its trusted supervisor
  reached 67.8 MiB against the unchanged 64 MiB hard ceiling;
- Chronobiology remained quarantined after a short-lived Bubblewrap setup PID
  disappeared during the pre-initialization cgroup tree move;
- BSF, SQLite, the public entry path, and fetus continuity stayed live, while
  both residents retained authority `NONE` and produced zero live outputs.

R110F remains the last accepted frozen revision and its failed 72-hour
benchmark remains immutable diagnostic evidence. R112 is an honest, unfrozen,
contained intermediate generation.

## Repair target

The repair creates a new immutable release from the exact live R112 release,
installs a one-shot cold-recovery contract for R113, and performs exactly one
deliberate service restart. `kernel.start` creates R113, both quarantined
residents recover at that fenced revision, and the required fetus boot install
creates the final R114 generation. Only R114 may be frozen as R114F.

R114F is accepted only when:

- BSF is live and SQLite quick-check is `ok`;
- SNTSS I4-G1 and Chronobiology C3 are running, healthy shadow residents;
- both resident instance identities and checkpoint lineages are preserved;
- both cold resynchronizations report zero abandoned deliveries and no
  invented biological time;
- SNTSS and Chronobiology authority remains `NONE` and SNTSS outputs remain 0;
- fetus continuity and the real public entry path remain healthy;
- a 130-second zero-transition live progression gate passes;
- `/var/lib/stay/evidence/runtime-freezes/R114.json` verifies immutably; and
- a clean R114F v3 72-hour zero-fault benchmark is running.

## Resource and deadline invariants

No payload limit or biological deadline changes:

- payload `memory.high` remains 67,108,864 bytes;
- payload `memory.max` remains 100,663,296 bytes;
- payload `pids.max` remains 16;
- payload `cpu.max` remains `20000 100000`;
- SNTSS worker transition time remains 250 ms;
- the trusted supervisor hard ceiling remains 64 MiB.

The trusted supervisor is made smaller under that ceiling by disabling JIT and
tightening its V8 old/semi-space bounds to 12/1 MiB. This does not change the
biological worker budget. The sustained read-only Linux preflight must measure
the trusted supervisor below 64 MiB with no hard resource action before any
production mutation. The pre-init cgroup move tolerates a disappeared
setup PID only after proving that every surviving observed payload PID is in
the exact target cgroup. A live uncontained PID, empty surviving tree, PID
limit, memory event, or containment mismatch still fails closed.

An authority-free resident with an empty outbox is now treated as already
drained. If even one pending output intent exists without a valid authority
epoch, the same path remains a hard `BIOLOGICAL_OUTBOX_DRAIN_AUTHORITY`
failure.

## Release gates

Before production mutation, the release must pass:

1. focused containment, cold-recovery, outbox, resource, deadline, BSF, SNTSS,
   Chronobiology, fetus-continuity, and workflow regressions;
2. the complete test suite;
3. SHA-256 verification of every staged release file;
4. validation from a clean extracted archive;
5. the real secure loader and real entry-path preflight;
6. the full 5,000-pulse I4-G1 proof at its unchanged cadence and acceleration
   bound; and
7. immutable hosted-archive download and checksum verification.

The production script additionally fences the exact live R112 release, R110F
closure, failed-forward evidence, failed-recovery evidence, host identity,
systemd restart counter, freeze ancestry, runtime configuration, resident
status, authority rows, output rows, and database integrity.

## Rollback and recovery

Any failure before the committed service restart restores the R112 pointer and
removes the unreferenced candidate. After the restart, the script never rolls
the organism back across a committed revision. It leaves the live generation
contained and archives exact failure evidence.

The recovery script normally finishes proof, freeze, and benchmark work only
when the same R114 process is already live. One retry is permitted solely when
the failed start committed no revision and durable state is still exactly R112;
the original R113 one-shot contract is reinstalled and the retry must reach
R114. At R113, R114 with an unhealthy generation, or any other durable
revision, another restart is forbidden because it would advance the lineage
and requires a new explicitly fenced release.

## Success markers

```text
P1_PRODUCTION_HARDENING_FORWARD_RESULT=PASS
RUNTIME_REVISION_BEFORE=112
COLD_RECOVERY_REVISION=113
RUNTIME_REVISION_AFTER=114
REVISION_LABEL=R114F
SNTSS_BIOLOGICAL_PACKAGE_CHANGED=NO
SNTSS_RESOURCE_CONTRACT_CHANGED=NO
BENCHMARK_CONTRACT=V3_ZERO_FAULT_ZERO_TRANSITION
BENCHMARK_SERVICE=ACTIVE
```

The recovery-only completion marker is
`P1_PRODUCTION_HARDENING_FORWARD_RECOVERY_RESULT=PASS` with the same R114F
contract.
