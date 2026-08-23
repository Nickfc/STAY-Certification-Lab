# SNTSS R8 Containment Evidence

The machine-readable bundle is `docs/sntss/evidence/R8_CONTAINMENT_EVIDENCE.json`. It binds the package-policy hash, controlling source hashes, normalized resource contract, cgroup leaf values, finite bounds, modeled failure decisions and neutralization/termination semantics.

## Executable matrix

| Failure or control | Executable evidence | Expected containment |
| --- | --- | --- |
| Package tamper/dependency/escape syntax | `R8-01`, `R8-02`, `R8-03`, `R8-10` | reject before execution |
| CPU/RAM/pids policy | `R8-04`, hostile closure `H-13` | Kernel-owned two-level cgroup contract |
| Handler hang and queue flood | `test/corehost.test.js`, bounds suite | timeout/recycle; queue remains finite |
| Output abuse/audit flood | audit regression `A-08`, hostile closure `H-07`, `R8-06` | causal failure/rate suppression/bounded evidence |
| SIGKILL | `R8-11`, hostile closure `H-03` | local restart; Kernel and StateStore remain healthy |
| Invalid/oversized checkpoint | `R8-09`, R7 checkpoint suite | reject/quarantine; no fresh chemistry |
| Process escape | native CoreHost permission test, `R8-07` | deny and Kernel-owned termination |
| Neutral degradation | `R8-05`, `R8-08` | no state rewrite and no chemistry frames |
| Headroom/leak smoke | `test:smoke` plus host run `31902610794` | bounded local run; provisional host headroom passes, long-window confirmation remains |

## Isolated production-host drill

The machine-readable host result is `docs/sntss/evidence/R8_HOST_CONTAINMENT_EVIDENCE.json`. GitHub Actions run `31902610794`, job `95055556660`, executed source commit `be14d134a9a11f869ebe6337ebeff40062f0fb9a` in a delegated transient systemd unit on the intended host class. The unit used a disposable StateStore and did not touch the active state path, change the active release pointer or restart `stay.service`. The emitted file SHA-256 is `96ac7a70c048f0c39a9cadc388b214063e0bc6e4e96bbb5106d47c3ce316db4e`; its canonical evidence-body hash is `sha256:6e7ea6a957af5ef426ef5ea937f994e6714e6d0ebe5505b4fcac40e2a0f2c66d`.

After a 300-second stabilization period, the drill recorded 241 samples across 1,200.478 seconds. SNTSS RSS remained between 52.52 and 52.93 MiB, with a 0.414 MiB net increase and a least-squares slope of 0.695 MiB/hour. CPU duty was 0.0583%, handler p99 was 1.683 ms, queue peak was zero, the checkpoint was 447 bytes and every health sample passed. SIGKILL advanced the CoreHost generation from 1 to 2 and recovered to an active healthy lifecycle. Sacrificial nested cgroups recorded an OOM kill, 30 pids-limit rejections and CPU throttling; all three cases remained contained.

The active foundation snapshot was identical before and after: `stay.service` remained active under PID 28715, persistence stayed healthy, runtime revision remained 46, and the active Fetus instance, PID and authority epoch did not change.

This run passes the roadmap's provisional host ceilings, including RSS slope below 1 MiB/hour. It does not close the stricter contract requirement for a non-positive long-window memory slope: the 20-minute series increased in 13 small steps and then plateaued, but never decreased. `productionHostContainmentEvidenceComplete` therefore remains `false`; R8 production acceptance and R9 entry remain blocked pending a longer endurance run and independent review.

## Result boundary

The laboratory matrix is complete when the R8 suite, full repository suite, continuity check, failure-injection lab and smoke run pass from the same tree. The isolated host drill now proves delegated cgroup availability and real OOM/pids/CPU enforcement with stable foundation health. Production acceptance remains blocked on the non-positive long-window memory-slope requirement, repeatability and independent review. Any follow-up must continue to use an isolated candidate StateStore/cgroup, never the active state path.
