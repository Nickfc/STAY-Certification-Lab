# SNTSS R8 Containment and Resource Contract

## Status and boundary

This is an R8 laboratory candidate. It does not authorize production installation, genesis, chemistry, output delivery, deployment, or mutation of the active state path. Destructive pressure tests are restricted to an isolated production-host candidate cgroup with a disposable StateStore.

## Pre-execution package closure

`cores/sntss/v0.1.0/package-policy.json` is checked before the CoreHost inspector executes the entrypoint and again before a CoreHost client starts. The policy binds the canonical entrypoint, every allowed source file and hash, the sole builtin dependency (`node:crypto`), the shared canonical JSON module, the sanitized environment, disabled diagnostics and zero ambient filesystem-write/network/process-spawn authority. Missing, altered, unlisted, dynamically required or forbidden dependencies fail closed.

The policy hash is calculated over the canonical policy body. The policy cannot attest itself. Release immutability and R10 provenance remain additional mandatory layers.

## Resource ownership

The Living Kernel owns every governor and may tighten but SNTSS may never relax a ceiling. cgroup v2 controllers are delegated at the `stay-cores` distribution level and applied again at the `sntss-<instance>` leaf.

| Resource | Soft / normal | Hard / action |
| --- | ---: | ---: |
| Resident memory | 64 MiB (`memory.high`) | 96 MiB (`memory.max`) |
| CPU duty | 5% warning | 20% / `cpu.max = 20000 100000` |
| Processes | — | `pids.max = 16` |
| Actor queue | — | 256 including running work |
| Handler | — | 250 ms |
| Health probe | — | 1,000 ms |
| Pending CoreHost requests | — | 128 |
| Pending outputs | — | 128 |
| Outputs per cause | — | 16 / 65,536 bytes |
| Acquired state checkpoint | — | 1 MiB canonical bytes |
| Containment incidents | — | 128 retained records |
| Migration records/work | — | 64 |
| Non-legacy shutdown | — | 2,000 ms then reap/kill |

Production SNTSS still declares no output topics, so the practical production output ceiling is zero.

## Failure semantics

A trusted-runtime incident opens the smallest identified scope. A warning degrades locally; a critical incident or three repeated incidents quarantines the package. Process escape, governor bypass, invalid checkpoint and unsafe shutdown also request Kernel-owned force termination. SNTSS cannot kill itself, reset state, fabricate neutral chemistry or authorize a restart.

All recovery actions retain the checkpoint hash, failed-state hash and chained incident evidence. A restart after force termination is shadow-only until a separately reviewed recovery probe accepts the retained state.

## Acceptance boundary

The repository suite covers package closure, environment/permission controls, hangs, bounded floods, output abuse, SIGKILL restart, checkpoint rejection, quarantine and foundation health. R8 cannot be accepted for production until the isolated host drill records real cgroup availability, OOM/pids/CPU enforcement, sustained headroom and a non-positive long-window memory slope on the intended host class.
