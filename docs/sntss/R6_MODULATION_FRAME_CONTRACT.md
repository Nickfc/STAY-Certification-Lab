# SNTSS R6 Modulation Frame Contract

Status: laboratory delivery only

A frame is a narrow, consumer-specific, expiring observation of receptor modulation. Its ID is the SHA-256 hash of its canonical body. The body includes SNTSS authority epoch, independent per-consumer sequence, durable evidence cursor, ordering ID, exact consumer ID, profile hash, lineage hash, validity window, receptor signals, and degradation state.

Per-receptor signals contain only the registered receptor ID and permitted function plus bounded activation, sensitivity, effect, trend, and availability. They contain no action, goal, identity, trust, safety, deployment, resource, memory-content, or chemical-control interface.

## Consumer acceptance order

1. Verify the complete canonical frame hash.
2. Require the exact consumer ID; wildcards are invalid.
3. Require the locally pinned profile hash and current authority epoch.
4. Require current time inside the validity window.
5. Require exact receptor order, identities, and permitted functions from the profile.
6. Require fixed-point bounds and a declared availability/degradation state.

Any failed check rejects the frame. An identical evidence cursor returns the prior frame without state or queue mutation. A lower cursor is a rewind failure. Replaying the same starting state, model, authority, cursor and trusted time produces identical frame IDs and effects.

On upstream degradation, every activation/effect is exactly zero and the consumer is instructed to decay to neutral after its short profile hold. Recovery emits one `recovering` frame capped to `±50000`; no missed-frame backlog is converted into an impulse.
