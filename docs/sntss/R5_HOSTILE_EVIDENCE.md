# SNTSS R5 Hostile Laboratory Evidence

The deterministic R5 evidence bundle is `evidence/R5_HOSTILE_EVIDENCE.json`.

- Evidence hash: `sha256:ec4e16e72f949d7b596972ba7089a85dca4db213140401e17794ad4a1cb8e063`
- Golden mapping hash: `sha256:4a38aa6af36f5a1027c6744aa9a5113128d58acaab719aa4a34391ecbf0f40ea`
- Hostile corpus hash: `sha256:1eb6caa5709996a9a7c139b8490cfd5e0c112d0f9ee019ec86aee3d333c00889`
- Registry hash: `sha256:b3302a68d46b40cb9f20ef597d20bc51ed8b38fccd80d0a4279cbe85a2e9397f`

The corpus exercises authoritative acceptance, replay, forged provenance, stale authority, direct reward semantics, circular causality, SNTSS-descendant causality, and expired evidence. The executable suite additionally covers all fourteen topics, schema confusion, invalid fixed-point numerics, unverified and duplicate evidence, duplicate claims, contradictory evidence, flooding, breaker recovery probes, habituation, long downtime, dream caps, and degraded producer availability.

Regenerate with `node scripts/sntss-r5-hostile-lab.js`; verify with `node --test --test-concurrency=1 test/sntss-stimuli.test.js`. The generator hashes the controlling R5 modules and schema into the bundle. Any module or contract change invalidates this evidence.
