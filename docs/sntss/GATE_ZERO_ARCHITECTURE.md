# Gate Zero Durable Biological Event Plane

Status: candidate implementation; not production-certified

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

## Durable tables

- `biological_events`: canonical envelopes, hashes and deterministic keys.
- `biological_envelopes_v2`: exact accepted Envelope v2 plus producer-proposal commitment.
- `biological_stream_heads`: durable accepted-signal stream sequencing.
- `biological_stream_progress`: append-only stream finalization history and cumulative finalized signal counts.
- `biological_stream_progress_heads`: hash-bound latest finalization per stream/epoch.
- `biological_outbox_intents`: transactional authoritative producer output obligations.
- `biological_outbox_stream_heads`: durable outbox sequencing that survives row compaction.
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
| envelope/dedup content conflict | fail closed |

## Evidence currently present

- G0-01: append-before-delivery and hash presence.
- G0-02: deterministic exact deduplication and conflict rejection.
- G0-03: checkpoint, transition ID, delivery ACK and cursor agreement.
- G0-04: injected producer commit failure, CoreHost recovery, Kernel restart, deterministic replay and exactly-once downstream effect.

## Certification gaps

The candidate is not Gate Zero complete until the full append/delivery/output/checkpoint/ack crash matrix, out-of-order concurrency, corruption, retention exhaustion, authority cutover, failed upgrade, host power loss, restore, latency, growth and independent hostile review evidence all pass on one pinned candidate.
