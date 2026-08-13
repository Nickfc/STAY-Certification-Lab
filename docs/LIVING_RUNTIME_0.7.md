# STAY 0.7.0 — Living Runtime Foundation

## Purpose

0.7.0 adds a continuity layer beneath the organism so deployable code can change without redefining organism identity or erasing accumulated state.

The kernel owns continuity mechanisms only: persistent identity, event routing, external state storage, core registration, health inspection, staged upgrades and rollback.

## Continuity rule

**Deployable code is not the organism.** Production identity and life-state belong under `/var/lib/stay/data/`, outside immutable release code.

Application releases remain under `/opt/stay/releases/`, `/opt/stay/current` may select the active release, and `/opt/stay/incoming/` is only a staging area.

## Core contract

A core declares a manifest containing its `coreId`, version, protocol, state schema, input topics, output topics and hot-swap support. It provides lifecycle methods for start, event handling, state snapshot and health.

Cores communicate through the Event Fabric rather than calling each other directly.

## Live core upgrade protocol

1. Validate the new core manifest.
2. Snapshot the current implementation.
3. Migrate state when the state schema changes.
4. Start the new implementation in shadow mode.
5. Mirror subscribed events to both implementations.
6. Suppress shadow outputs from the organism.
7. Require health and shadow evidence before cutover.
8. Transfer output authority to the new implementation inside the running kernel.
9. Keep the previous implementation warm as standby and continue mirroring events to it.
10. If required, roll authority back to the warm standby.

## Current 0.6 organism

0.7.0 does not recreate or overwrite the existing 0.6 fetus. The repository currently contains the deployment foundation but not the full 0.6 organism source. The 0.6 source and existing state therefore need an explicit compatibility adapter and audited migration before the Living Kernel is allowed to replace the current production process.

Until that cutover is verified, 0.7 can be packaged and staged beside 0.6 without changing the running organism.

## Future cores

SNTSS, primordial instincts, synthetic pain, memory, self-model, morphology/embodiment and later systems can use the same versioned core contract. The architecture deliberately does not prescribe a future visual form: self-image and embodiment can become evolving cores rather than properties baked into the renderer.
