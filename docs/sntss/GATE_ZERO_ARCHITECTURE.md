# Gate Zero Durable Biological Event Plane

Status: P0-EF1 SEALED at 1973376820a9ae319ade2321d1ad1cf2c7d3ef67; no live physiology authority

## Authoritative transition

1. The Event Fabric validates the topic, payload class and trusted integer time.
2. StateStore allocates the next sequence and inserts the complete canonical envelope, payload hash, provenance hash and delivery rows in one `BEGIN IMMEDIATE` transaction.
3. Only after commit does the Event Fabric deliver the envelope.
4. A CoreHost handles one ordered event and returns a pure snapshot candidate. The client does not adopt that snapshot as recovery state yet.
5. StateStore writes the content-addressed checkpoint, moves the authority checkpoint pointer, acknowledges the delivery and advances the stable consumer cursor in one transaction.
6. Only after that commit does the client adopt the snapshot as recoverable state.
7. If step 5 fails, the CoreHost is killed without snapshotting and restarted from the last committed checkpoint. The event remains pending.

## Causal output boundary

Each authoritative CoreHost emission receives a trusted per-cause output index. The Kernel derives a stable `producer_event_id` from producer core, authority epoch, originating transition identity and output index **independently of output content**. The proposal content is committed separately. Reusing the stable producer identity with different content therefore fails closed instead of silently manufacturing a second cause.

The producer checkpoint, incorporated input ACK and every authoritative output obligation commit in one SQLite transaction. Transport begins only after that transaction commits. A failed transport leaves a durable pending obligation and may never roll the producer transition back.

Outbox producer streams have their own durable stream heads. Future compaction of already-published outbox rows therefore cannot rewind producer stream sequence. Physiological outbox payloads are bounded to 8 KiB per emission.

## Producer-event acceptance idempotency

Envelope v2 acceptance commits a canonical producer-proposal hash and enforces one `(organism_id, producer_core_id, producer_event_id)` identity. Retrying the exact producer proposal returns the original accepted `signal_id`, Fabric sequence and durable event without allocating another sequence. Kernel acceptance time may advance between attempts without changing the already-accepted biological fact.

Reusing a producer event identity with changed proposal content, producer instance, version, authority epoch, authority mode or derived causal semantics fails closed.

## Stream progress and explicit silence

Absence of a signal is not evidence by itself. A producer may explicitly finalize one stream through trusted organism time `T` using a Kernel-minted `STREAM_PROGRESS` capability.

Progress is durable, hash-bound, scoped by organism + stream + authority epoch and strictly monotonic. It records the cumulative count and last stream sequence of signals whose biological order time is at or before the finalized boundary. Once `T` is finalized, a later acceptance cannot insert a signal at or before `T`.

Silence may be inferred only from durable progress evidence. An unchanged finalized signal count between a lower and covering progress boundary proves silence for the enclosed interval. If evidence has been compacted and the retained progress bounds cannot prove the requested sub-window, the result remains UNKNOWN rather than fabricating silence.

## Authority cutover spool

Authority promotion is a biological barrier, not merely a CoreHost mode switch. `commitUpgrade()` now seals every committed pending old-epoch producer obligation into a Kernel-owned `biological_cutover_spool` in the **same SQLite transaction** that advances authority. If spool creation fails, authority remains on the old epoch. There is no durable state in which the old epoch is revoked while one of its committed outputs has become ownerless.

A spooled obligation keeps its original `producer_event_id`, producer instance/version, `authority_epoch`, producer stream, stream sequence, proposal commitment and intent commitment. The new CoreHost never re-authors it. Recovery may drain a revoked epoch only when that exact obligation has a verified `SPOOLED` record. Future-epoch output is never drainable by older authority, and an unspooled revoked-epoch output fails closed.

When Event Fabric publication succeeds, outbox completion and spool completion bind to the same durable Fabric event identity. An ambiguous publish acknowledgement therefore retries the same durable event rather than creating a replacement fact. Startup recovery binds persisted authority first, then attempts spool/outbox drain, then replays pending consumer input. Promotion/rollback releases the in-memory cutover hold before post-commit spool draining so recursive durable publication cannot deadlock on its own barrier.

## Required route lifecycle and completeness barriers

Required biological routes are durable infrastructure records with explicit states: `ACTIVE`, `DEGRADED`, `EVIDENCE_GAP`, `CLOSED`, and terminal `RETIRED`. Route heads, append-only transitions and consumer boundary acknowledgements are independently hash-bound.

`ACTIVE` routes contribute their explicit `STREAM_PROGRESS` frontier to consumer safe completeness. Missing progress is a blocker; traffic silence never advances completeness. When a required route leaves `ACTIVE`, the transition records the last known-complete `route_barrier_us`. `EVIDENCE_GAP` additionally binds the exact unavailable interval. Until the consumer durably acknowledges that boundary against one of its content-addressed checkpoints, the route continues to pin safe completeness at the barrier.

A degraded/gap route can reactivate only at an explicit forward boundary strictly beyond the consumer-committed unavailable interval and without authority-epoch rewind. A `CLOSED` route requires a `COMPLETE_END` acknowledgement before it can become `RETIRED`; retired anatomy cannot silently reactivate. After a valid boundary acknowledgement, the failed route may stop pinning the minimum frontier, while the acknowledgement preserves `UNKNOWN_INPUT` or `COMPLETE_END` provenance instead of fabricating a biological zero.

## Resident recovery replay closure

Resident reconstruction treats a CoreHost request timeout/exit as a failed **attempt**, not as an acknowledged biological transition. The original CoreHost event watchdog remains unchanged on every attempt. Because resident recovery state advances only after checkpoint + delivery ACK commit, a timed-out attempt has no durable biological effect and the exact pending ledger event may be retried from the last committed resident checkpoint.

Recovery replay is bounded to three attempts per durable event. A retry is permitted only for `COREHOST_TIMEOUT` / `COREHOST_EXIT`, only while the delivery is still durably `PENDING`, and only after the CoreHost has reconstructed from committed recovery state. A successful retry explicitly resolves the prior retryable actor failure; non-retryable failure, recovery failure, retry exhaustion or any delivery-state ambiguity marks the resident `RESYNC_REQUIRED` and fails closed.

While reconstruction is retiring replay debt, live resident enqueue is held. Newly arriving durable events remain owned by the StateStore delivery ledger and are caught by a bounded tail replay before the hold is released. This prevents a newer live event from overtaking older pending biology during manager reconstruction without inventing a second queue, cursor or chronology.

## Durable tables

- `biological_events`: canonical envelopes, hashes and deterministic keys.
- `biological_envelopes_v2`: exact accepted Envelope v2 plus producer-proposal commitment.
- `biological_stream_heads`: durable accepted-signal stream sequencing.
- `biological_stream_progress`: append-only stream finalization history and cumulative finalized signal counts.
- `biological_stream_progress_heads`: hash-bound latest finalization per stream/epoch.
- `biological_outbox_intents`: transactional authoritative producer output obligations.
- `biological_outbox_stream_heads`: durable outbox sequencing that survives row compaction.
- `biological_cutover_spool`: immutable old-epoch obligations transferred atomically before authority revocation.
- `biological_routes`: hash-bound required-route heads and current lifecycle/barrier state.
- `biological_route_transitions`: append-only route lifecycle history.
- `biological_route_boundary_acks`: checkpoint-bound consumer acknowledgement of unknown/end boundaries.
- `biological_consumers`: stable consumer identity, topic profile, cursor, authority epoch and checkpoint link.
- `biological_deliveries`: pending/acknowledged event-consumer pairs, transition IDs and checkpoint hashes.
- `checkpoints.input_cursor`: event boundary represented by the checkpoint transition.

## Failure posture

| Failure boundary | Authoritative result |
| --- | --- |
| before envelope transaction commits | no event and no sequence becomes authoritative |
| after envelope commit, before handler | pending event replays |
| during handler | old checkpoint remains; pending event replays |
| producer checkpoint/outbox transaction fails | neither transition ACK nor output obligation becomes authoritative |
| checkpoint/ack/outbox transaction commits, transport fails | producer state remains committed; output obligation stays pending and retries exact identity |
| exact producer event is retried | original accepted signal/event is returned; no new sequence is allocated |
| stream progress finalized through T, later signal claims time <= T | fail closed |
| authority promotion with pending old-epoch output | spool every obligation atomically before authority changes, or abort cutover |
| restart after authority cutover but before old output delivery | drain only verified old-epoch spool identities; never impersonate old authority |
| required route leaves ACTIVE | pin completeness at exact barrier until consumer checkpoint acknowledges unknown/end semantics |
| replay horizon is exhausted | record EVIDENCE_GAP interval; never infer silence/zero from missing history |
| envelope/dedup content conflict | fail closed |

## Evidence currently present

- G0-01: append-before-delivery and hash presence.
- G0-02: deterministic exact deduplication and conflict rejection.
- G0-03: checkpoint, transition ID, delivery ACK and cursor agreement.
- G0-04: injected producer commit failure, CoreHost recovery, Kernel restart, deterministic replay and exactly-once downstream effect.
- EF1-G: authority-cutover spool atomicity, revoked/future epoch drain policy, route barriers, evidence gaps, forward-only reactivation and checkpoint-bound route release.
- EF1-H: crash-before-seal, restart-after-seal, ambiguous publish retry, spool corruption and recovery ordering hostile closure.

## P0-EF1 certification disposition

P0-EF1 is sealed at commit `1973376820a9ae319ade2321d1ad1cf2c7d3ef67` (`Add durable cutover routes and close EF1`). The closure evidence is 25/25 EF1-G/H direct hostile tests, 14/14 targeted regression files and 545/545 tests across all 69 repository test files, with zero failures, skips, cancellations or todos. The source-only certification did not deploy, restart the living service, switch the live release, mutate the live StateStore, push or merge.

## P0-B0 / P0-B1 / P0-B2 implementation tranche

The next infrastructure layer is the Kernel-enforced Biological Signalling Fabric policy, deliberately implemented as protocol/policy rather than a biological CoreHost or a second transport. The tranche adds manifested producer capabilities and consumer route leases, evidence-role ownership, authority-mode effect eligibility, canonical delivery ordering, live-lateness clipping, recovery-replay interval reconstruction, bounded producer rate admission, lag degradation, bounded observer telemetry and direct binding to the already-sealed StateStore route/progress machinery.

LABORATORY, SHADOW and AUTHORITATIVE submissions continue to use the same Universal Biological Envelope and Kernel acceptance boundary. Authority mode changes effect eligibility, not protocol. Observer telemetry remains a sink and is asynchronously bounded so it cannot become physiology backpressure. Required-route completeness continues to come from StateStore route lifecycle plus explicit `STREAM_PROGRESS`; the BSF does not infer silence or invent a second cursor/watermark system.

This B0/B1/B2 code remains a candidate until its direct policy/laboratory/containment tests, pinned EF1 targeted regressions and the complete repository suite pass on the Node 24 server baseline. No live physiological authority is granted by the candidate.


## Resident durable delivery recovery boundary

The resident CoreHost execution watchdog and the resident durability/recovery
barrier are separate bounded mechanisms.

A CoreHost `event` attempt remains bounded by the manifest resource policy
(current frozen SNTSS: 250 ms). If that attempt times out or the host exits
before the resident checkpoint + ledger ACK transaction commits, the durable
delivery remains `PENDING`. The actor queue retains the same sequence as its
active barrier while CoreHost reconstruction occurs outside the handler
deadline, then retries the exact event from the last committed resident
recovery image. Newer queued biology cannot overtake that sequence.

A timeout during the durable post-event `snapshot` phase is treated as
potentially mutated but uncommitted CoreHost memory. The host is therefore
recycled from the last committed recovery image before any retry. A snapshot
timeout is never retried against the same in-memory process.

Resident retry is deliberately narrow and bounded:

- only durable deliveries are eligible;
- only `COREHOST_TIMEOUT` and `COREHOST_EXIT` are retryable;
- the delivery must remain durably `PENDING` before and after host recovery;
- at most three handler attempts are permitted for one event;
- every attempt keeps the original CoreHost watchdog unchanged;
- drain/cutover barriers remain pinned to the same running sequence throughout
  bounded recovery;
- commit failure, output violation, actor timeout, ambiguous delivery state,
  exhausted retry, quarantine or recovery failure still fail closed to
  `RESYNC_REQUIRED`.

This recovery path does not create a second biological ledger, alter sequence
identity, infer missing biology or relax exactly-once checkpoint/ACK semantics.
