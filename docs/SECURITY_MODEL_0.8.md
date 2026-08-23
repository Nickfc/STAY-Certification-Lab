# STAY v0.8 Security and Trust Model

## Boundary statement

Native CoreHosts isolate crashes, hangs, resource pressure and ordinary programming faults from the Living Kernel. They execute only code shipped in the root-owned, read-only release artifact. Node's Permission Model is a defense-in-depth seat belt and is not claimed as a sandbox for arbitrary malicious JavaScript.

Production startup requires all of the following:

- Node starts the Kernel with `--disable-sigusr1`, preventing a CoreHost from activating the Kernel inspector with `_debugProcess`.
- `STAY_REQUIRE_CGROUPS=1` and delegated cgroup v2 containment succeed before a CoreHost starts.
- `/opt/stay` is root-owned and read-only to the service account.
- native CoreHosts receive an allowlisted environment and no child-process, worker, network, write, addon, WASI or FFI permission.
- the release archive checksum and embedded provenance match before preflight.

If future STAY accepts third-party/untrusted core code, this boundary is insufficient. That feature requires a separate OS identity or container/VM boundary, syscall filtering, network isolation and a new hostile-code certification before activation.

## Event durability statement

Critical and durable events are fail-visible. Sequence numbers are reserved transactionally before delivery. A successful top-level durable publish checkpoints active state before acknowledgement. Delivery is at-least-once, not a distributed transaction over arbitrary external side effects. Non-idempotent handlers must key effects by the stable event sequence or an explicit idempotency key.

## Remaining external proof

The real systemd/cgroup host, archive deployment, state rollback, hardware compute and 24/72-hour endurance gates remain mandatory. Local tests cannot promote these items to Pass.
