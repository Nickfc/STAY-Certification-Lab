# SNTSS R7 State and Genesis Contract

Status: laboratory candidate; production genesis disabled until R13

R7 defines the first complete acquired-state payload for one organism. The canonical schema records lineage, permanent organism binding, pinned species profile, chemical and developmental clocks, durable input cursor, all transmitter state, receptor history, source history, habituation, leases, circuit breakers, migrations, clamp counters, and the forensic audit-chain head.

The state is exact-key validated, finite, normalized, limited to 1 MiB, and hash-verifiable. NaN, infinity, unknown schema, partial maps, oversized state, identity/profile/lineage mismatch, inconsistent receptor leases, malformed genesis history, and unknown transmitter inventories fail closed.

## Laboratory genesis transaction

1. Require that no prior SNTSS state exists.
2. Verify the permanent Kernel organism binding, neutral handoff checkpoint, current authority epoch, and pinned R4 species-profile hash.
3. Generate one cryptographically random lineage identifier.
4. Create the documented neutral birth state: safe nonmaximal active reserves; zero exposure and opponent load; dormant families exactly zero; empty stimulus and habituation history.
5. Bind the state hash and lineage to one `SNTSS_GENESIS` ledger proposal.
6. Mark the entire fixture `laboratoryOrigin: true` and `productionEligible: false`.

A second genesis returns `SNTSS_SECOND_GENESIS`. Any attempt to import this laboratory lineage into production returns `SNTSS_LAB_IMPORT_BLOCKED`. R7 does not commit to StateStore; the live CoreHost remains pre-genesis and inert. Real production genesis remains an explicit R13 shadow-transition decision.
