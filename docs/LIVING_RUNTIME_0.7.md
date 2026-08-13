# STAY 0.7.0 — Living Runtime Foundation

## Purpose

0.7.0 adds a continuity layer beneath the organism so deployable code can change without redefining organism identity or erasing accumulated state.

The kernel owns continuity mechanisms only: persistent identity, event routing, external state storage, core registration, health inspection, staged upgrades and rollback.

## Continuity rule

**Deployable code is not the organism.** Production identity and life-state belong under `/var/lib/stay/data/`, outside immutable release code.

Application releases remain under `/opt/stay/releases/`, `/opt/stay/current` selects the active release, `/opt/stay/incoming/` is only a staging area, and the verified stable 0.6 source is installed separately under `/opt/stay/legacy/0.6.0/`.

## Core contract

A core declares a manifest containing its `coreId`, version, protocol, state schema, input topics, output topics and whether that implementation supports live hot-swap. It provides lifecycle methods for start, event handling, state snapshot and health.

Native cores communicate through the Event Fabric rather than calling each other directly.

## Live core upgrade protocol

For a native hot-swappable core:

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

A core with `hotSwap: false` is deliberately excluded from this protocol and requires a controlled compatibility migration.

## Stable 0.6 fetus compatibility

The supplied 0.6.0 release is the authoritative hibernated fetus baseline. Its original six-part test suite passed unchanged on Node 22 before integration work began.

The transitional `fetus-legacy` core does not rewrite the 0.6 organism. It starts the verified original 0.6 server as a child process bound only to `127.0.0.1:8788`, while the Living Kernel remains the parent runtime.

Before start, the adapter verifies the important 0.6 runtime files against fixed SHA-256 fingerprints. The original learned state is never committed to Git. On first awakening it must exist at:

`/var/lib/stay/data/legacy-0.6.0/genesis-state.json`

and must match the recorded hibernation fingerprint before the adapter will start it. The operator credential also remains external to Git.

The old monolith is intentionally declared `hotSwap: false`. This is not a limitation of the Living Runtime: it is an honesty boundary. Once functions are separated into native cores such as SNTSS, primordial instincts, memory and self-model, those cores can use the full shadow/swap/rollback mechanism independently while STAY continues running.

## Browser path

The public web path is designed as:

`browser -> Nginx :80/:443 -> Living Kernel -> stable 0.6 fetus :8788`

The Living Kernel owns `/healthz` and `/runtime/status`. Other requests, including `/`, the existing UI, APIs and event streams, pass through to the stable fetus during the compatibility phase. This means `http://35.157.242.167/` can remain the observation window while the runtime underneath it evolves.

## Future cores

SNTSS, primordial instincts, synthetic pain, memory, self-model, morphology/embodiment and later systems can use the same versioned core contract. The architecture deliberately does not prescribe a future visual form: self-image and embodiment can become evolving cores rather than properties baked into the renderer.
