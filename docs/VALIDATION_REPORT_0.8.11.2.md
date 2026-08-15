# STAY 0.8.11.2 Hardened Repair-Candidate Validation

> Superseded by `VALIDATION_REPORT_0.8.11.3.md`. Retained as historical evidence only.

## Decision

This tree is a **pre-certification repair candidate**, not a production-certified release. Automated gates can establish deterministic software properties; they cannot replace the roadmap's physical Ryzen, WebGPU, CPU-only and mobile endurance evidence.

## Closed audit findings

| ID | Closed control | Automated evidence |
| --- | --- | --- |
| A-01 | Post-barrier events are held and released only to the new authority epoch. | `test/audit-regressions.test.js` |
| A-02 | Candidate checkpoint tuple is durable before authority commit and is the only restart source. | `test/audit-regressions.test.js` |
| A-03 | Durable downstream output failure rejects the causal publish. | `test/audit-regressions.test.js` |
| A-04 | Concurrent status reads share one bounded health refresh. | `test/audit-regressions.test.js` |
| A-05 | Native CoreHost code cannot use `process.kill` against the Kernel parent. | `test/audit-regressions.test.js` |
| A-06 | Every single-process CPU hard limit is reachable at or below one full core. | `test/audit-regressions.test.js` |

Additional controls include exact authority/checkpoint validation, journaled metadata mirrors, identity divergence refusal, consistent SQLite snapshots, per-event output quotas and IPC backpressure, cgroup v2 fail-closed production mode, manifest revalidation, compute task/lease bounds, mandatory result verification, truthful endurance evidence requirements and state-aware deployment rollback.

## Local verification required before handoff

```sh
node --test --test-concurrency=1 test/*.test.js
node scripts/continuity-check.js
node scripts/failure-injection-lab.js
node scripts/endurance-runner.js --seconds 15
```

The smoke runner may report `PASS-SMOKE-NOT-CERTIFICATION`. That is intentionally not a certification result.

## External gates still open

- delegated cgroup v2 startup and containment on the target systemd host
- safe archive deployment plus code-and-state rollback rehearsal on staging
- WebGPU shader compilation and duty calibration on both required adapters
- physical 5% CPU quietness on the Ryzen system
- long-task, freeze, memory and reconnect observations on the real mobile viewer
- retained 24-hour and 72-hour hardware-evidence reports

Do not change `releaseChannel` to `certified` until every external gate passes and the evidence is retained beside the release.
