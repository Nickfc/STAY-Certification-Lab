# STAY / Project Genesis

## v0.8 Permanent Living Foundation - pre-certification

This tree identifies itself as `0.8.11.3` and remains a pre-certification repair candidate. It closes the deterministic hostile-audit regressions listed in `docs/VALIDATION_REPORT_0.8.11.3.md`. It is intentionally not production-certified: delegated cgroup/deployment rehearsal and the roadmap's real 24-hour qualification and 72-hour mixed-device endurance run remain external gates.

### What changed

- Evolvable native cores execute in supervised CoreHost child processes, never inside the Living Kernel process.
- Event Fabric v2 uses ordered, bounded per-implementation queues with explicit critical, durable, best-effort and coalescible telemetry classes. "Durable" is fail-visible, acknowledged only after checkpointing and at-least-once; handlers must use event sequence/idempotency keys for non-idempotent external effects.
- Authority transfers close post-barrier ingress, persist the candidate's exact checkpoint, compare-and-swap authority and its checkpoint pointer, then release held events only to the new epoch.
- StateStore schema v3 uses SQLite WAL/FULL durability, journaled JSON mirrors, verified consistent SQLite snapshots and immutable SHA-256 checkpoint blobs.
- Production identity fails closed on missing identity or SQLite/JSON divergence. It is never silently regenerated or reconciled without a durable mirror journal.
- Per-core RAM, CPU, PID, queue, output, storage, deadline and restart-storm policies are bounded. Production service configuration requires delegated cgroup v2 containment.
- GPU compute performs winner reduction on the GPU, reads back only 16 bytes, reuses buffers and enforces measured 5/30-second duty with cooldown.
- CPU contribution uses conservative concurrency ceilings and 4-10 ms slices with requested/effective reporting.
- Viewer responsiveness backs off compute on interaction, long tasks, freezes, mobile limits, latency inflation and heap growth.
- The compute fabric profiles heterogeneous nodes, caps queued/assigned work, expires leases, and requires a named verifier before accepting results. Its live replacement of the preserved 0.6 WebSocket compute path remains a declared integration gate, not a completed production claim.
- Shadow evidence stores bounded statistics, hashes and a fixed recent sample window.
- Failure injection and configurable endurance runners are included.

### Immutable continuity boundary

The existing fetus compatibility wrapper and both 0.6 fingerprint files are byte-identical to the 0.7.1.12 baseline. Production life-state remains external to release code under `/var/lib/stay/data`.

### Verify locally

Requires Node.js 24 or newer.

```bash
npm test
npm run test:continuity
npm run test:faults
npm run test:smoke
```

### Certification status

Automated gates: implemented and passing.

Real heterogeneous 24h/72h endurance: not run in this workspace. The harness now fails certification runs without structured hardware evidence. Follow `docs/ENDURANCE_CERTIFICATION_0.8.md`. The deployment script refuses this `pre-certification` channel unless an operator explicitly enables a staging-only override.

Native CoreHosts are fault-containment boundaries for trusted, root-owned release code. Node's Permission Model is not claimed as a sandbox for arbitrary malicious modules. Production startup requires `--disable-sigusr1`, delegated cgroups and the read-only release layout; see `docs/SECURITY_MODEL_0.8.md`.

See `docs/PERMANENT_LIVING_FOUNDATION_0.8.md` for the implementation map and `docs/VALIDATION_REPORT_0.8.11.3.md` for the verified handoff state.
