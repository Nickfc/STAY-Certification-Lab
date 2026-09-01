# R123F benchmark V3 observation audit and V4 adjudication contract

Status: laboratory implementation in progress. Production and the running R123F collector are untouched.

## Immutable production facts

- R123F benchmark start: `2026-08-30T09:55:32.018Z`.
- Exact 72-hour due time: `2026-09-02T09:55:32.018Z` (`2026-09-02 11:55:32.018 Europe/Copenhagen`).
- 15-minute milestone: PASS, SHA-256 `39e6e62493a2ec6cd662d8b55287b222812efc693219a1ee3ebe04e6ae793458`.
- 12-hour milestone: PASS, SHA-256 `c63a62f709ad8c52440715a079df533938dfd2bde135e24604fc577667b4192e`.
- The collector has one start, zero restarts, a stable `stay.service` PID, and continuing SNTSS and Chronobiology checkpoint progress.
- BSF is LIVE/RUNNING. SNTSS and Chronobiology are SHADOW/RUNNING, healthy, and authority-free. SNTSS output remains zero. The fetus continuity checks and SQLite quick-check remain healthy.

The read-only state peek captured on `2026-08-31T18:16:36Z` had SHA-256 `14119df825f701de5ac8df674685d1b2c346d24432e040742ed02c8ca4d98c6f`. It recorded 1,938 samples and one cumulative V3 failure. Every cumulative fault, timeout, recovery, cgroup, process-transition, and failed-delivery counter was zero.

The sole V3-failed sample is ledger line 1,280 at `2026-08-31T07:17:10.456Z`:

- health OK, revision 123, SQLite quick-check OK, service PID 395571;
- one pending outbox intent and one pending delivery;
- zero failed deliveries;
- SNTSS RUNNING/SHADOW, checkpoint generation 1,594,304, zero outputs, zero authority;
- Chronobiology RUNNING/SHADOW, checkpoint generation 6,466, 89 observed outputs, zero authority.

No evidence may be rewritten, removed, reset, or relabelled to change these facts.

## Root cause in repository source

The V3 collector captures HTTP and resident-control state before it opens a separate SQLite read and then treats any sampled `PENDING` outbox intent as an immediate physiology failure.

The runtime deliberately performs the following guarded sequence:

1. Commit checkpoint, consumer acknowledgement, and outbox intent atomically.
2. Publish only from that committed intent.
3. Bind the exact Fabric sequence and event ID and change the intent to `PUBLISHED`.

This creates a legitimate, bounded committed-before-published interval. V3 can observe that interval because its endpoint and database reads are not one transaction. The current evidence is consistent with this measurement race, but consistency alone is not certification.

## V4 fail-closed rule

V4 never changes V3 evidence. It may adjudicate one sampled pending observation as `COMMITTED_IN_FLIGHT_PUBLISHED` only when all of these are proven:

1. The pending count and pending-delivery count are exactly one.
2. The immediately preceding and following samples have zero pending intent, zero pending delivery, and zero failed delivery.
3. Both adjacent gaps are at most 75 seconds; no collector restart or missing sample is accepted.
4. Health, frozen revision, service PID, resident versions/instances, modes, authority containment, SNTSS zero-output state, and recovery counters are unchanged across the three samples.
5. Chronobiology cumulative output rows increase by exactly one at the observation and do not increase again in the following sample.
6. A query-only durable witness identifies exactly one Chronobiology outbox row in that bounded interval.
7. The row is `PUBLISHED`, has a complete producer/stream/transition identity, has a positive Fabric sequence and event ID, and binds an advancing Chronobiology checkpoint.
8. The row creation/publication timestamps are ordered and publication completes before the next sample.
9. The witness hashes the exact observation and both adjacent samples and is bound to the exact complete sample ledger and frozen revision label.

Any repeated pending observation, count above one, failed delivery, SNTSS producer, identity change, checkpoint mismatch, recovery counter advance, ambiguous row set, missing witness, substituted input, or incomplete adjacency remains `OBSERVED_FAILURES` or `EVIDENCE_INCOMPLETE`.

## Immutable input and output binding

Formal V4 PASS additionally requires:

- the complete V3 `samples.jsonl`, `state.json`, `collector-attempts.json`, and `72h.json`;
- exact SHA-256 identities for every input;
- a deterministic replay whose counters match the canonical V3 state;
- exactly one collector start and zero restarts;
- at least 72 hours between first and final ledger timestamps;
- exact final-sample identity and positive SNTSS/Chronobiology checkpoint progress;
- an exclusive, mode-0400 V4 report carrying its own canonical evidence hash.

The source V3 result is always retained in the V4 report. A V4 PASS cannot be presented as a V3 PASS.

## Query-only witness command

From the exact reviewed Git checkout on the production host, after verifying the script hash, capture the durable witness without opening a write-capable database connection:

```sh
/usr/local/bin/node scripts/p1-physiology-benchmark-v4.js witness \
  --samples /var/lib/stay/evidence/physiology-benchmark/R123F/samples.jsonl \
  --database /var/lib/stay/data/continuity.sqlite3 \
  --revision-label R123F \
  --output /var/lib/stay/evidence/physiology-benchmark/R123F/outbox-witness-v1.json
```

The tool uses SQLite `readOnly` plus `PRAGMA query_only=ON`. It writes only the new exclusive evidence file and refuses to overwrite an existing path.

## Post-72-hour adjudication command

```sh
/usr/local/bin/node scripts/p1-physiology-benchmark-v4.js adjudicate \
  --samples /var/lib/stay/evidence/physiology-benchmark/R123F/samples.jsonl \
  --state /var/lib/stay/evidence/physiology-benchmark/R123F/state.json \
  --attempts /var/lib/stay/evidence/physiology-benchmark/R123F/collector-attempts.json \
  --milestone /var/lib/stay/evidence/physiology-benchmark/R123F/72h.json \
  --witness /var/lib/stay/evidence/physiology-benchmark/R123F/outbox-witness-v1.json \
  --output /var/lib/stay/evidence/physiology-benchmark/R123F/adjudication-v4.json
```

This command is not authorized for use until its focused tests, complete suite, clean extracted-archive verification, immutable SHA-256 verification, and real Linux entry-path preflight have passed.
