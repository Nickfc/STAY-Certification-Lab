# R11 M-02 Durable Core Revocation

Status: **IMPLEMENTED IN CANDIDATE / HOST ROLLBACK PROOF STILL REQUIRED**

This closes the repository architecture portion of hostile re-audit finding M-02. A previously legitimate standby or candidate may no longer regain authority after the trusted Kernel has durably revoked its exact module, package policy, implementation instance, or an exact combination of those selectors.

## Law

**Rollback remains certificate-independent for emergency availability, but it is never revocation-independent.**

A standby that was already authorized does not need to contact an online signer merely to perform emergency rollback. It does, however, have to pass the Kernel-owned durable revocation registry immediately before authority can change.

Revocation never rewinds biology and does not itself manufacture replacement state.

## Registry

The trusted Kernel owns an append-only SQLite table inside the continuity StateStore. Each record contains only bounded authority metadata:

- monotonic sequence;
- random revocation ID;
- canonical subject hash;
- core ID;
- optional exact module SHA-256;
- optional package-policy SHA-256;
- optional exact implementation instance ID;
- bounded reason code;
- optional evidence SHA-256;
- creation time;
- previous-record hash;
- current record hash.

Records form a SHA-256 chain. There is deliberately no un-revoke, delete, clear or in-place update operation. Repeating the same canonical subject is idempotent and returns the existing immutable record rather than changing its rationale.

**The chain is not merely inspectable. It is verified before every revocation write and before every activation/commit/rollback revocation decision.** If any retained record has a broken sequence, previous hash, record hash or canonical subject hash, the authority transition fails closed with `CORE_REVOCATION_CHAIN_INVALID`, even when the corrupted record describes a different implementation.

The registry lives in the same canonical SQLite continuity database, so normal StateStore snapshot/recovery mechanisms carry it with authority history. R11 freeze inventory includes the verified revocation-chain head. The frozen head is also the external reference needed to detect a privileged tail-truncation attack that could otherwise remove the newest internally valid records.

## Matching semantics

Every non-null selector in a revocation record must match the attempted implementation. This allows deliberately narrow or broad trusted actions:

- module digest only: revoke every instance of that exact module;
- package-policy hash only: revoke every implementation under that exact policy;
- instance ID only: revoke that exact implementation instance;
- combinations: revoke only the exact combination.

## Enforcement points

The production RuntimeRegistry creates revocation-aware RuntimeSlots. The slot authority boundary checks the verified registry before:

1. initial activation;
2. staging a candidate;
3. committing a staged candidate;
4. reactivating a standby during rollback.

Commit and rollback therefore fail with `CORE_REVOKED` before authority epoch, release mode or canonical acquired state can change. A damaged revocation chain fails earlier with `CORE_REVOCATION_CHAIN_INVALID`.

The loader also gives the trusted parent independently calculated module SHA-256 and attested package-policy hash; candidate code does not supply those identifiers.

## Operator boundary

The registry is an internal Kernel facility (`RuntimeRegistry.revokeCore`). No HTTP, viewer, CoreHost or SNTSS command endpoint is added by this change. Future operator tooling must remain separately authenticated and must only append revocation records through trusted Kernel authority.

## R11 host proof still required

M-02 is not final-certified until the frozen candidate performs the isolated-host rollback rehearsal and proves:

- an authorized standby can roll back when not revoked;
- exact module revocation blocks rollback;
- exact implementation-instance revocation blocks rollback;
- revocation survives Kernel restart and continuity snapshot/recovery;
- damaged retained revocation history blocks activation and further revocation writes;
- the authority epoch does not advance on a blocked rollback;
- acquired biological state is unchanged by a blocked rollback and remains forward-only after subsequent activity;
- the verified revocation head is included in frozen certification evidence and compared during certification/recovery.

No part of this change authorizes live SNTSS chemistry, production genesis or testing against the live organism.
