# STAY Durable Residency Contract v1.0

Status: L0-A frozen design contract.

## Purpose

Durable Residency allows a runtime Core to possess persistent continuity
beside the STAY organism without receiving biological or behavioural authority.

The foundational rule is:

> Residency grants continuity, never authority.

## Initial resident

The first intended resident is frozen SNTSS I3-D:

- coreId: sntss
- version: 0.4.0-i3d3
- stateSchema: 4
- Git commit: dae509ccfdd517b1de23f028836cf14d24b86b1a
- productionEligible: false
- allowed inputs:
  - runtime.organism.binding
  - runtime.time.pulse
- outputs: none

Frozen SNTSS I3-D MUST NOT be modified to implement residency.

## Rights

A resident may:

- possess an organism-bound identity;
- receive explicitly authorized Kernel inputs;
- maintain durable state;
- checkpoint state;
- recover after worker/CoreHost/Kernel failure;
- retain state while detached.

A resident may not:

- own an authority epoch;
- modify the authority table;
- participate in active/standby cutover;
- emit biological outputs;
- acquire behavioural authority;
- acquire fetus authority;
- block organism liveness.

## Persistence

Resident metadata and resident checkpoints MUST use a namespace independent
of authoritative Core checkpoints.

The resident pointer MUST NOT update or depend on the authority table.

Resident state is part of organism history once attached.

Corrupt or unavailable resident state MUST fail closed. The Kernel MUST NOT
manufacture neutral replacement physiology.

## Organism binding

A resident is permanently associated with the organism identity under which
it was attached.

Recovery under a different organism identity MUST be rejected.

## Package identity

Resident reconstruction MUST verify the exact approved executable,
manifest and package-policy identity before loading persisted state.

Package mismatch MUST leave resident state intact but offline.

## Delivery

Initial SNTSS residency accepts only:

- runtime.organism.binding
- runtime.time.pulse

No other biological event may enter SNTSS.

Resident biological consumption is non-required and MUST NOT become part of
the organism retention/liveness boundary.

Resident delivery failure MUST NOT reject or fail the originating STAY event.

## Atomic transitions

For a relevant durable resident event:

event transition + resident checkpoint + resident delivery acknowledgement

MUST become durable atomically.

It is forbidden to acknowledge biological input without persisting the
corresponding resident state transition.

## Time

A new Kernel runtime revision establishes a new trusted anchor.

Offline wall-clock duration MUST NOT be synthesized into biological time.

## Output firewall

A resident has zero output authority.

For L0:

- declared outputs MUST equal zero;
- observed resident outputs MUST equal zero;
- any attempted output is a quarantine condition;
- no resident-authored output may reach Event Fabric.

## Failure asymmetry

SNTSS may depend on STAY.

STAY MUST NOT depend on resident SNTSS for liveness.

Worker failure, CoreHost failure, resident corruption, package absence,
quarantine or operator detach MUST leave the organism operational.

## Lifecycle

Supported resident lifecycle concepts:

- ATTACHED
- RUNNING
- RECOVERING
- QUARANTINED
- RESYNC_REQUIRED
- DETACHED

DETACHED retains state.

PURGE is intentionally not part of L0.

## Detach

Normal detach preserves:

- resident identity;
- organism binding;
- package identity;
- checkpoint history;
- latest checkpoint.

Detach MUST NOT alter organism authority, fetus state or organism identity.

## No purge

L0 MUST NOT expose a resident purge API.

Destructive removal of accumulated resident state is outside this contract.

## Initial certification requirement

Before production attachment the implementation MUST prove:

- authority table unchanged;
- organism identity unchanged;
- fetus unaffected;
- exact resident checkpoint recovery;
- worker/CoreHost/Kernel crash recovery;
- SQLite/WAL reopen;
- wrong organism rejection;
- package mismatch rejection;
- output rejection;
- no downtime catch-up;
- bounded memory/storage/process usage;
- detach preserves physiology;
- resident-specific failure does not make STAY unhealthy.

