# SNTSS R10 Release and Rollback Contract

Status: candidate release-control implementation; production installation remains prohibited before R12.

## Purpose

R10 binds SNTSS to STAY's immutable release pipeline without giving software deployment authority over organism history. Release code is replaceable. Canonical organism identity, StateStore lineage and acquired SNTSS biology are not release artifacts and may never be silently rewound because a candidate fails.

## Immutable release contract

Every SNTSS-bearing release must be built from one full 40-character source commit and contain `RELEASE_INVENTORY.json` plus `RELEASE_PROVENANCE.json` using `stay-release-provenance-v2`. The inventory is sorted and hash-addresses every included source, schema, fixture, test, evidence artifact and release-control file. It excludes Git metadata, live data, `.stay-data`, release-output directories, secret/key paths and laboratory/candidate/failed state.

Provenance binds the STAY version and source commit to the inventory hash, dependency inventory, SNTSS package-policy hash, species profile hash, source-registry hash, receptor-profile hash, schema inventory, evidence inventory, test inventory and neutral fallback. The archive sidecar remains an independent SHA-256 transport check.

A release directory is immutable after acceptance. The only production pointer is `/opt/stay/current`, and a switch is performed by creating a replacement symlink and atomically renaming it over the pointer.

## Preflight is read-only with respect to the organism

Before any release switch, the candidate must pass:

1. archive path/type/size checks and SHA-256 sidecar verification;
2. release provenance and inventory reproduction from candidate bytes;
3. full commit/version match;
4. JavaScript syntax checks;
5. SNTSS package-policy, dependency/capability and file-hash enforcement;
6. neutral fallback validation with zero output authority;
7. deterministic forward-migration/backward-projection rehearsal;
8. existing isolated continuity checks.

No preflight operation may write `/var/lib/stay/data`, change `/opt/stay/current`, create SNTSS genesis, or consume live semantic input. Candidate-state rehearsal occurs on a disposable copy/fixture only.

## No-rewind rollback law

`stateRollbackPolicy` is `preserve-forward-state`.

If a post-switch candidate fails, rollback may restore the previous **code pointer**, but it must not automatically unpack a pre-deployment StateStore over the canonical state. The pre-switch backup is retained as recovery evidence. The forward state at failure is separately retained as failed-candidate evidence while the canonical forward lineage remains authoritative.

Backward compatibility is a projection problem, not a time-reversal problem. `migrateForward()` and `projectBackward()` must preserve the biological invariant: lineage, organism binding, model/development clocks, input cursor, transmitter state, receptor history, source history, habituation, leases and circuit-breaker history. Backward projection explicitly leaves the source forward state authoritative.

Any rollback path that restores old acquired chemistry as the normal automatic action is an R10 blocker.

## Neutral fallback

The release must contain `cores/sntss/neutral/index.js` with core version `0.0.0-neutral`, stage `neutral-production`, and zero biological outputs. Neutral fallback is a software/lifecycle safety posture; it is not permission to erase acquired state.

## Failed-state and safety evidence

Each switched deployment retains:

- the previous immutable release path;
- pre-switch safety backup and digest;
- source commit and archive digest;
- release inventory/provenance;
- identity hash and StateStore integrity result;
- failed forward-state evidence after a post-switch failure;
- rollback health result and reason.

The backup is emergency recovery evidence, not the default software rollback mechanism.

## Promotion boundary

R10 candidate work may build, verify and rehearse releases in an isolated replica. It does not authorize installing SNTSS into the live organism. Live neutral installation begins only at R12 after R11 certification and an explicit operator-approved deployment window.
