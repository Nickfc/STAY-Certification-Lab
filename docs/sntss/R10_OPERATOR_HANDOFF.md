# SNTSS R10 Operator Handoff

R10 is a release-control rehearsal. Do not use it as authorization to deploy SNTSS to the live organism.

## Candidate build

A valid candidate has a full source commit, archive `.sha256` sidecar, `RELEASE_INVENTORY.json`, and `RELEASE_PROVENANCE.json` in format `stay-release-provenance-v2`. Run the R10 verifier against the extracted candidate before any switch. A mismatch in commit, inventory, dependency/profile/schema/evidence hash, neutral fallback, syntax or migration rehearsal rejects the candidate.

## What rollback means

Rollback changes the immutable release pointer back to known code. It does **not** restore an old StateStore over the organism as a routine action. Preserve the forward canonical state, retain a failed-forward-state evidence archive, and use reviewed backward projection/compatibility. A safety backup remains available for disaster recovery only and must never be used casually to make a failed software deployment look successful.

## Stop conditions

Abort promotion on any unpinned input, absent/mismatched sidecar, missing provenance/inventory, mutable release directory, secret or laboratory-state inclusion, package-policy/profile mismatch, preflight mutation, destructive migration, identity mismatch, StateStore integrity failure, missing neutral fallback, failed-state evidence loss, or biology rewind.

## Current boundary

R8 endurance and formal R9 dependency closure still gate R10 acceptance. Even after R10 is accepted, R11 complete laboratory certification comes before R12 neutral production installation.
