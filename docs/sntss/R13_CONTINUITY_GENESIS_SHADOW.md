# SNTSS R13 Continuity-Genesis Shadow Candidate

Status: implemented non-live candidate; live R105F remains unchanged

Candidate identity:

- module: `cores/sntss/i4g/index.js`
- version: `0.5.0-i4g1`
- state schema: 5
- stage: `i4g-continuity-genesis-shadow`
- production eligibility: false
- authority: none
- outputs: none
- package-policy hash: `sha256:ba12622fcc9c782c8c48f0544a5b019c96dc198dcbb7fb209c1dad47de64639d`
- accepted parent: `R105F`
- parent freeze record: `sha256:78021d86da8038e298fedb46b7371a46e1bc1e4d1cb0624205a864877ca22875`

## Reconciliation with the live lineage

The early R7 laboratory contract described production SNTSS as pre-genesis and inert. Later work legitimately advanced the live lineage beyond that assumption: R105F contains SNTSS `0.4.0-i3d3`, whose synthetic transmitter chemistry, receptor adaptation, receptor regulation, receptor availability, and trusted-time clocks are already durable and advancing. It remains neutral because it accepts no semantic drives, declares no outputs, and owns no authority.

R13 therefore does not create a second chemistry engine and does not discard, reset, reroll, or back-project the R105F state. The existing i3d3 state is treated as preserved prenatal physiology: real autonomous internal dynamics without a durable individuality record. Schema 5 adds exactly that missing record over the inherited state.

This clarification does not rewrite prior evidence. R7 accurately described its own laboratory candidate. R105F is the accepted later live baseline from which this candidate descends.

## One-time transition

The candidate accepts one new input, `runtime.sntss.continuity-genesis`. Acceptance requires all of the following:

- a canonical, exact-key payload;
- the explicit `R13_SNTSS_CONTINUITY_GENESIS_SHADOW` authorization;
- the live organism's already-persisted identity;
- the exact R105F revision and freeze-record digest;
- the source checkpoint generation and digest;
- a 256-bit seed supplied for this one transition;
- a durable event attributed to `living-kernel`;
- a Kernel authority epoch equal to the proposed runtime revision.

The transaction commits:

- one lineage digest bound to organism identity, event identity, parent freeze, prenatal state, source checkpoint, and seed;
- the seed commitment, never the raw seed;
- the prenatal state and chemistry digests;
- the exact prenatal model clock;
- the genesis event, runtime revision, and checkpoint coordinates;
- permanent `productionEligible: false`, `authorityMode: NONE`, and `outputs: 0` boundaries.

An exact retry of the already-accepted event is idempotent. Every different second attempt fails with `SNTSS_SECOND_GENESIS`. A wrong organism, wrong parent, non-durable event, or non-Kernel event fails closed.

## State continuity

Migration from schema 4 to schema 5 preserves these fields byte-for-byte:

- organism binding;
- synthetic chemistry;
- receptor adaptation;
- receptor availability;
- trusted-time state.

The migration adds `individuality: null` and the marker `schema-4->5:i4g-continuity-genesis-shadow:prenatal-physiology-preserved`. Continuity genesis changes only `individuality`. Subsequent trusted time advances the inherited physiology normally while the individuality record remains stable across snapshot and restart.

## Containment and current authorization

This candidate has no Event Fabric outputs and no behavioural, fetus, SNTSS production, or Chronobiology authority. It does not consume Chronobiology output. It does not change BSF routes. It cannot influence another core.

The implementation and focused tests are repository-local preparation allowed during the R105F 72-hour benchmark. They do not authorize changing `/opt/stay/current`, attaching the candidate to the live organism, emitting the genesis event, replacing the live resident, advancing the live revision, or interrupting the benchmark.

## Executable acceptance

`test/sntss-i4g-continuity-genesis.test.js` proves:

1. exact manifest and zero-output boundary;
2. cryptographic attestation of all 27 package/ABI files;
3. byte-preserving schema-4 migration;
4. one-time identity binding without prenatal-state mutation;
5. exact replay idempotence and second-genesis rejection;
6. provenance, parent, durability, and organism rejection;
7. restart continuity and continued trusted physiology.

The next operation is an isolated exact-candidate CoreHost/StateStore rehearsal. A later, separately reviewed live transition must establish a fresh frozen parent and benchmark window; no live transition is implicit in this document.
