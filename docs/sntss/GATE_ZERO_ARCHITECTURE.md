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

Each CoreHost emission receives a deterministic per-cause output index. The Kernel derives a deterministic key from producer, authority epoch, cause sequence, output index, topic and payload. Replaying the producer therefore resolves to the existing durable output envelope. Reusing the key with different content fails closed.

This closes the boundary where a downstream consumer may already have committed the output before the producer checkpoint fails: producer replay reuses the output event and an already-acknowledged downstream consumer does not apply it again.

## Durable tables

- `biological_events`: canonical envelopes, hashes and deterministic keys.
- `biological_consumers`: stable consumer identity, topic profile, cursor, authority epoch and checkpoint link.
- `biological_deliveries`: pending/acknowledged event-consumer pairs, transition IDs and checkpoint hashes.
- `checkpoints.input_cursor`: event boundary represented by the checkpoint transition.

## Failure posture

| Failure boundary | Authoritative result |
| --- | --- |
| before envelope transaction commits | no event and no sequence becomes authoritative |
| after envelope commit, before handler | pending event replays |
| during handler | old checkpoint remains; pending event replays |
| downstream output commits, producer checkpoint fails | output is retained; producer replays; output deduplicates; downstream skips |
| checkpoint/ack transaction commits, response is lost | new checkpoint and ACK agree; replay skips |
| envelope/dedup content conflict | fail closed |

## Evidence currently present

- G0-01: append-before-delivery and hash presence.
- G0-02: deterministic exact deduplication and conflict rejection.
- G0-03: checkpoint, transition ID, delivery ACK and cursor agreement.
- G0-04: injected producer commit failure, CoreHost recovery, Kernel restart, deterministic replay and exactly-once downstream effect.

## Certification gaps

The candidate is not Gate Zero complete until the full append/delivery/output/checkpoint/ack crash matrix, out-of-order concurrency, corruption, retention exhaustion, authority cutover, failed upgrade, host power loss, restore, latency, growth and independent hostile review evidence all pass on one pinned candidate.
