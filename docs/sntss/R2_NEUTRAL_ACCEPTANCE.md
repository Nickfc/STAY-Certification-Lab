# R2 Neutral SNTSS Candidate Evidence

Status: laboratory candidate accepted by automated tests; not production-authorized

## Implemented

- `cores/sntss/neutral/index.js` with protocol `stay-sntss-v1`, state schema 1 and version `0.0.0-neutral`.
- One-time, hash-verified `runtime.organism.binding` issued by the Living Kernel and persisted independently of restart.
- Trusted manual `runtime.time.pulse` contract; SNTSS owns no ambient timer.
- Canonical finite neutral state containing no transmitter or receptor state.
- Exact provisional containment limits: 64/96 MiB RAM, 5/20% CPU, 16 PIDs, queue 256, 250 ms handler, 1,000 ms health, 16 outputs and 65,536 output bytes per cause.
- Versioned `0.1.0` laboratory skeleton with no chemistry and no outputs.
- JSON schemas for neutral state, organism binding and time pulse.

## Passing evidence

- R2-01: bind once, remain chemically empty, zero outputs.
- R2-02: restart preserves binding and does not create a second binding cause.
- R2-03: neutral-to-laboratory hot-swap and rollback preserve binding and remain inert.
- R2-04: no timer, network, filesystem, process or output capability in the neutral package.
- R2-05: conflicting later binding fails closed without replacing the acquired binding.

## Production blockers

- Gate Zero still requires the complete crash/power-loss matrix and independent review.
- No immutable candidate archive or provenance bundle has been built under R10.
- No real-host cgroup/resource acceptance has been executed for SNTSS.
- R12 requires a separately approved deployment window, verified backup and automatic rollback rehearsal.
