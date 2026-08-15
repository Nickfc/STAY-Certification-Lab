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
| Headroom/leak smoke | `test:smoke` | bounded local run; production-host endurance still required |

## Result boundary

The laboratory matrix is complete when the R8 suite, full repository suite, continuity check, failure-injection lab and smoke run pass from the same tree. This evidence does not claim the intended production host exposed delegated cgroups or that real OOM/pids/CPU pressure was applied there. Those observations are the remaining R8 acceptance action and must use an isolated candidate StateStore/cgroup, never the active state path.
