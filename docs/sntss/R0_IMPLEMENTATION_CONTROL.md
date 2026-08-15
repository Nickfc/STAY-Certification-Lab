# SNTSS R0 Implementation Control

Status: implementation baseline frozen; production promotion blocked

Specification: `STAY SNTSS Core - Synthesized Neurotransmitter Subsystem Design and Production Specification`

Document-control note: the supplied filename identifies revision 1.1 while the PDF cover and footer identify design version 1.0. This implementation treats the supplied 48-page file as the controlling content and records the discrepancy rather than silently choosing a different text.

## Frozen baseline

- Repository: `Nickfc/STAY-Genesis`
- Working branch: `agent/living-runtime-0.7.0`
- Baseline tree/commit: `bdf868421601f49a95e1175097d73c95c9dc5ea2`
- Runtime/package version: `0.8.11.3`
- Baseline verification: 43/43 repository tests passing before SNTSS work
- Immutable fetus file: `cores/fetus-legacy-0.6/index.js`
- Immutable fetus SHA-256: `ad2698402492a573aa5b28978b2b1a8e3387a6adc8ca0592d06bcfe310cdc9b1`

No production deployment, StateStore mutation, organism genesis, or behavior influence is authorized by this record.

## Locked protocol decisions

| Item | Decision |
| --- | --- |
| Chemical fixed-point scale | `0..1,000,000`; signed effects `-1,000,000..1,000,000` |
| Time unit | integer milliseconds |
| Integration quantum | 250 ms |
| Core protocol | `stay-sntss-v1` |
| Durable event protocol | `stay-biological-ledger-v1` |
| State schema owner | StateStore owns durable envelopes, consumer progress and checkpoint lineage; SNTSS owns only its canonical state payload |
| Event ordering | Kernel sequence; append-before-delivery for critical/durable events |
| Consumer identity | stable `core:<coreId>` identity, independent of CoreHost process instance |
| Output identity | deterministic producer/cause/output-index key with content-conflict rejection |
| Laboratory boundary | synthetic fixtures and accelerated time may never be imported into the living lineage |
| Initial production posture | neutral only; no chemistry and no biological outputs |

## Repository map

| Authority or function | Existing component | SNTSS/Gate Zero change surface |
| --- | --- | --- |
| Kernel lifecycle and trusted time | `runtime/kernel/living-kernel.js` | durable appender, trusted binding/time events, ledger status |
| Event order and delivery | `runtime/kernel/event-fabric.js` | append-before-delivery and deterministic deduplication |
| State authority | `runtime/kernel/state-store.js` | durable envelopes, deliveries, consumers, cursors and atomic checkpoint/ack |
| Core authority and cutover | `runtime/kernel/slot.js` | stable consumer identity, replay and commit/recovery barrier |
| Isolated process client | `runtime/kernel/core-host-client.js` | do not adopt uncommitted recovery state |
| CoreHost execution | `runtime/core-host/host.js` | deterministic per-cause output index |
| Manifest/resource policy | `runtime/kernel/manifest.js`, `resource-governor.js`, `cgroup-governor.js` | SNTSS-specific declared ceilings; no new authority |
| Neutral package | `cores/sntss/neutral/` | new R2 package |
| Laboratory core | `cores/sntss/v0.1.0/` | R3 deterministic engine and R4 hashed family profiles; CoreHost lifecycle remains inert |
| Verification | `test/`, `scripts/` | Gate Zero crash matrix, neutral lifecycle, later property/endurance suites |
| Release controls | `deploy/`, `.github/workflows/` | unchanged until R10; production remains blocked |

## Phase issue set

| Phase | Owned deliverable | Entry condition | Exit evidence | Current state |
| --- | --- | --- | --- | --- |
| R0 | traceability, map, decisions and risks | pinned baseline | no orphan/ambiguous critical requirement | In progress |
| R1 | durable biological event plane | R0 map frozen | complete crash matrix and exact replay | Candidate implementation |
| R2 | neutral SNTSS package | R1 accepted | inert lifecycle/restart/rollback proof | Candidate implementation |
| R3-R7 | chemistry, families, stimuli, receptors, lineage | R2 accepted | laboratory gates only | R3 numerical candidate; R4 family candidate; R5-R7 blocked |
| R8-R11 | containment, audit, packaging and certification | R3-R7 complete | pinned certification bundle | Blocked |
| R12 | neutral production | R11 plus operator approval | production neutral acceptance | Blocked |
| R13+ | genesis, shadow, probe and influence | irreversible approval at each boundary | phase-specific evidence | Blocked |

## R0 closure blockers

- The exact production release digest and deployed source tree must be compared with the pinned baseline before any production package is built.
- Gate Zero requires a broader crash-injection matrix than the initial executable proofs.
- No independent reviewer has yet signed the Gate Zero model.
- No SNTSS package may be added to a live release until R1 and R2 evidence are complete and explicitly approved.

## Change control

Any change to event identity, durable envelope fields, consumer cursor semantics, checkpoint/ack atomicity, organism binding, lineage, fixed-point units, promotion gates, or authority boundaries invalidates the affected evidence. The change requires a decision record, test-map update, fresh evidence and review.
