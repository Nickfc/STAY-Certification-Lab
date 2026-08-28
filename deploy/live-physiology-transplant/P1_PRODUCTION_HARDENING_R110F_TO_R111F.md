# P1 production hardening: R114 to bounded R116F recovery

The historical filename is retained because it is part of the immutable
production-hardening lineage. The original R111F target was not attained and
must never be reported as attained. R114 is the current contained generation:
BSF is live, SNTSS I4-G1 is a healthy zero-output shadow resident, and the exact
Chronobiology C3 identity is quarantined with an active optional consumer and a
bounded pending-delivery debt.

## Repair target

The guarded repair creates a candidate from the exact live R114 release and
performs exactly one deliberate service restart. `kernel.start` creates R115,
the one-shot cold-recovery contract admits only the quarantined Chronobiology
identity, and the required fetus boot install creates R116. Only R116 may be
frozen as R116F.

The Chronobiology admission transaction requires all of the following:

- residency `resident:chronobiology` and core `chronobiology`;
- resident status `QUARANTINED`;
- an exact resident and consumer checkpoint match;
- an active optional consumer with authority epoch zero;
- no authority row and no pending biological output intent; and
- between 1 and 8,192 pending deliveries, inclusive.

The replay reads unchanged 1,024-record database pages. Ordinary resident
replay retains its existing 1,024-record fail-closed boundary. Only successfully
processed deliveries are acknowledged. Admission and replay invent no
biological time, abandon no deliveries, grant no authority, and preserve the
checkpoint, active consumer, pending debt and quarantine identity on failure.

SNTSS remains version `0.5.0-i4g1` with its existing instance lineage,
checkpoint continuity, zero-output contract, resource contract and shadow-only
authority. Its production package is not changed by this release.

## Observation-only web compatibility

R116F adds a read-only chip projection over existing validated runtime metadata.
It adds no database migration, biological route, checkpoint writer, resident
attachment, mode control or authority endpoint.

Lifecycle state precedence is:

`QUARANTINED -> OFFLINE -> RECOVERING -> DEGRADED -> LIVE -> SHADOW -> NEUTRAL`

The compact rail retains every known resident. Before repair it shows BSF as
`LIVE`, SNTSS as `SHADOW`, and Chronobiology as `QUARANTINED`. After successful
recovery the same persistent Chronobiology chip becomes `SHADOW`; no new
identity is created. Symbols, text labels and colors distinguish states without
depending on color alone. The expanded view retains version, mode, lifecycle,
checkpoint generation, handled events, outputs and a coarse health reason.

METAB, HOMEOS and INTERO appear only in a separate non-live roadmap rail with
release-controlled `PLANNED`, `LAB BUILD` or `LAB QUALIFIED` stages. A roadmap
label has no health dot, checkpoint or biological status, and disappears when a
real lifecycle resident of the same identity is accepted.

## Acceptance contract

R116F is accepted only when:

- SQLite quick-check succeeds and BSF is `LIVE · RUNNING`;
- SNTSS is `SHADOW · RUNNING`, advances the same checkpoint lineage, emits zero
  production outputs and owns no authority;
- Chronobiology is `SHADOW · RUNNING` on the exact quarantined identity and
  checkpoint lineage;
- replay count equals the pre-restart baseline debt with zero abandonment and
  no invented biological time;
- fetus identity, acquired continuity and resource contracts are unchanged;
- revision progression is exactly R114 to R115 cold recovery to R116;
- the real public and Bubblewrap entry paths pass;
- `/var/lib/stay/evidence/runtime-freezes/R116.json` verifies immutably; and
- one V3 72-hour zero-fault benchmark collector starts with immutable evidence.

## Resource and deadline invariants

No payload limit or biological deadline changes:

- payload `memory.high` remains 67,108,864 bytes;
- payload `memory.max` remains 100,663,296 bytes;
- payload `pids.max` remains 16;
- payload `cpu.max` remains `20000 100000`;
- SNTSS worker transition time remains 250 ms; and
- the trusted supervisor hard ceiling remains 64 MiB.

The trusted supervisor remains below that ceiling with the previously reviewed
12 MiB old-space and 1 MiB semi-space bounds. This does not change the
biological worker budget. A live uncontained PID, empty surviving payload tree,
PID limit, memory event, deadline violation or containment mismatch still fails
closed.

## Release gates

Before production mutation, the release must pass:

1. exact cold-admission, identity, bounded replay, failure preservation, chip,
   resource, BSF, SNTSS, Chronobiology and fetus-continuity regressions;
2. the complete test suite;
3. SHA-256 verification of every staged release file and the binary archive;
4. exact inventory and unsafe path/link validation from a clean extraction;
5. JavaScript and shell syntax validation;
6. the real secure loader and Bubblewrap entry-path preflight; and
7. immutable hosted-archive download and checksum verification.

The production preflight additionally fences the exact live R114 pointer,
service PID and restart counters, SQLite state, resident identities,
checkpoints, bounded Chronobiology debt, authority rows, output rows, fetus
continuity and all resource contracts without mutation.

## Rollback and recovery

Any failure before durable revision advancement restores the R114 pointer and
removes the unreferenced candidate. After advancement, the operation never
rewinds organism state. It leaves the candidate and evidence available for the
revision-fenced forward recovery path.

The recovery operation is completion-only. It accepts only the exact already
running R116 generation, performs no second service restart, verifies the
single-restart evidence, removes only the exact hash-matched one-shot drop-in,
freezes R116F and starts the benchmark. R115, unhealthy R116 or any other
durable revision remains fail-closed and requires a separately reviewed path.

## Success markers

```text
P1_PRODUCTION_HARDENING_FORWARD_RESULT=PASS
RUNTIME_REVISION_BEFORE=114
COLD_RECOVERY_REVISION=115
RUNTIME_REVISION_AFTER=116
REVISION_LABEL=R116F
CHRONOBIOLOGY_PENDING_REPLAY=BOUNDED_ZERO_ABANDONMENT
SNTSS_BIOLOGICAL_PACKAGE_CHANGED=NO
SNTSS_RESOURCE_CONTRACT_CHANGED=NO
WEB_CHIP_PROJECTION=OBSERVATION_ONLY
BENCHMARK_CONTRACT=V3_ZERO_FAULT_ZERO_TRANSITION
BENCHMARK_SERVICE=ACTIVE
```

The completion-only marker is
`P1_PRODUCTION_HARDENING_FORWARD_RECOVERY_RESULT=PASS` with the same R116F
contract.
