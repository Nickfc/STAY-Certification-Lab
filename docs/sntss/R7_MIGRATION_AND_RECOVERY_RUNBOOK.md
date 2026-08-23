# SNTSS R7 Migration and Recovery Runbook

Status: laboratory procedure

## Recovery order

1. Preserve the primary checkpoint and candidate backup set unchanged.
2. Verify checkpoint hash, state schema, organism identity, lineage, species profile, cursor, receptor lineage, leases, and genesis record.
3. Use the primary only if every check passes; otherwise select the first verified matching backup.
4. If no verified state exists, stop with `SNTSS_RECOVERY_NO_VERIFIED_STATE`. Never create fresh chemistry or ask an operator to supply values.
5. Replay only after the checkpoint cursor, then advance trusted downtime analytically with zero stimulus.
6. Retain the deterministic recovery report and selected checkpoint hash.

Trusted downtime advances clearance, reserve/precursor recovery, exposure, opponent and receptor recovery. It expires derived queues and disconnects stale leases. It does not advance developmental experience, input cursor, source history, habituation, or fabricate evidence. Uncertain time or mismatched lineage blocks the operation.

## Upgrade and rollback

Schema 1 to 2 migration adds only explicit zero clamp counters under a pinned transformation hash. The biological invariant includes identity, lineage, profile, clocks, cursor, all transmitter variables, receptor history, source history, habituation, leases, and breakers; its hash must be identical before and after migration.

Backward compatibility projects the current schema-2 biology into schema 1. The newer state remains authoritative. The projection may never use an older checkpoint to restore reserves, baselines, tolerance, exposure, opponent load, receptor sensitivity, history, or cursor. Unsupported migration is not hot-swappable.
