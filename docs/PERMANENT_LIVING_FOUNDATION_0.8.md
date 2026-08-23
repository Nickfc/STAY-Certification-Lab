# STAY v0.8 Permanent Living Foundation

## Release state

`0.8.11.3` is a hostile-audit repair candidate. Deterministic local evidence now covers shadow-gap refusal, sequence reservation, acknowledged-state recovery, SIGUSR1 inspector suppression, evidence-sample rejection, bounded logging and inspector reaping. This does not replace the open delegated-cgroup, live deployment/rollback, live Compute Fabric, browser hardware, 24h or 72h gates.

## Permanent spine

The Living Kernel owns only continuity authority:

- fail-closed organism identity
- transactional authority map and authority epochs
- bounded typed event transport
- CoreHost supervision and resource policy
- upgrade preparation, cutover, rollback and recovery reconciliation
- checkpoint coordination and integrity verification
- bounded health and runtime metadata

Domain behavior runs outside the Kernel in supervised CoreHost processes. Browser compute is untrusted resource capacity and never continuity authority.

## Roadmap implementation map

| Milestone | Implementation | Automated evidence | Status |
| --- | --- | --- | --- |
| 0.8.0 CoreHost isolation | `runtime/core-host/host.js`, `core-host-client.js` | crash/hang containment plus production SIGUSR1 guard | Fault isolation implemented for trusted release code; real-host cgroup proof required |
| 0.8.1 Event Fabric v2 | `event-fabric.js`, `actor-queue.js` | ordering/bounds/frozen-shadow tests | Implemented |
| 0.8.2 Atomic hot-swap | `slot.js`, `upgrades.js` | epoch cutover, race, rollback tests | Implemented |
| 0.8.3 StateStore v2 | `state-store.js` | migration, WAL, corruption, reconciliation tests | Implemented |
| 0.8.4 Resource Governor | `resource-governor.js` | crash/hang/restart and bounded-policy tests | Implemented |
| 0.8.5 GPU Governor v3 | `runtime/ui/gpu-engine.js` | static contract and browser integration checks | Implemented; hardware calibration required |
| 0.8.6 CPU Quiet Governor | `compute-governor.js`, server worker transform | slice/concurrency contract checks | Implemented; Ryzen validation required |
| 0.8.7 Browser Compute v3 | GPU reduction and reusable buffer pool | 16-byte readback/persistent-buffer checks | Implemented; multi-hour browser proof required |
| 0.8.8 Responsiveness | long-task/interaction/mobile/heap backoff | browser contract checks | Implemented; real phone proof required |
| 0.8.9 Compute Fabric | `runtime/compute/compute-fabric.js`; preserved 0.6 WebSocket tunnel | bounded scheduler/verifier unit tests | Partial: scheduler exists; live browser traffic integration remains open |
| 0.8.10 Shadow Evidence v2 | `shadow-evidence.js` | 10,000-output bounded-memory test | Implemented |
| 0.8.11 Failure Lab | `scripts/failure-injection-lab.js`, `test/hostile-closure.test.js` | baseline plus twelve hostile closure regressions | Deterministic local subset passing; real OOM/disk-full/GPU/reconnect/100-node work remains open |
| 0.8.12 Endurance | `scripts/endurance-runner.js` | smoke run only in this handoff | Pending 24h/72h certification |

## Authority protocol

1. Snapshot the active implementation.
2. Inspect the candidate in an isolated process.
3. Start the candidate as shadow from migrated state.
4. Mirror ordered events through its bounded queue.
5. Collect bounded evidence.
6. Close ingress above a known barrier and hold post-barrier events in a bounded transition queue.
7. Drain active and candidate through the barrier and fail the transition if either drain failed.
8. Persist the candidate's exact instance/version/epoch/schema checkpoint.
9. Persist `PREPARED`, validate that exact checkpoint tuple, and atomically compare-and-swap authority plus its checkpoint pointer.
10. Release held events only to the new authority and retain the previous active as a non-blocking warm standby.

Rollback is another forward authority epoch, not a reversal of time.

## Persistence protocol

SQLite runs in WAL mode with `synchronous=FULL`. Identity, runtime revision, sequence high-water, authority, schemas, checkpoint pointers, upgrade transactions and recovery records are authoritative metadata. Core state is serialized into immutable SHA-256 blobs. Snapshot manifests hash the SQLite image, identity mirror, fetus state when present and referenced checkpoint blobs.

Checkpoint generations, recovery records, upgrade history, journals, snapshots, queue telemetry and shadow evidence all have explicit bounds.

## Compatibility

On first v0.8 start, existing 0.7 JSON identity metadata is imported into StateStore v2 without rewriting the identity file. A missing production identity stops startup. Local development can bootstrap only through the explicit constructor/environment path.

The preserved fetus remains `hotSwap: false`; it is supervised behind CoreHost as a compatibility implementation and retains its existing nested memory guardian.
