# STAY 0.8.11.3 Hostile-Audit Repair Validation

## Decision

This tree is a pre-certification repair candidate. It is materially stronger than 0.8.11.2, but it is not production-certified and does not claim completion of real-host, live Compute Fabric, physical browser or endurance gates.

## Deterministic red-to-green closures

| ID | Former failure | Closure evidence |
| --- | --- | --- |
| R-01 | Native core activated Kernel inspector with `_debugProcess`. | production refuses startup without `--disable-sigusr1`; guarded harness stays closed |
| R-02 | Shadow lost required events and still committed. | `SHADOW_INCOMPLETE` permanently blocks commit and preserves epoch |
| R-03 | Abrupt Kernel death reused sequence and lost acknowledged state. | SQLite sequence reservation before delivery plus durable publish checkpoint |
| R-04 | Unexpected CoreHost exit restored stale state. | required-event dispatch refreshes recovery snapshot before acknowledgement |
| R-05 | Empty asserted hardware evidence passed. | per-node raw samples, unique timestamps and full run-span validation required |
| R-06 | Manifest inspector had no verified kill escalation. | wait, SIGKILL escalation and reap failure path |
| R-07 | CoreHost logs were rate-unbounded. | 40 messages / 64 KiB per second per host with suppression telemetry |
| R-08 | Staging archive omitted continuity fixtures. | exact staging recipe includes `test/` and embedded provenance |
| R-09 | Lightsail marker uploaded on push. | all external-write workflows are manual-only |
| R-10 | Action tags were mutable. | checkout/setup-node pinned to full reviewed commit SHAs |
| R-11 | Deployer ignored checksum sidecar/provenance. | both are mandatory and must match filename/package before preflight |
| R-12 | Rollback could finish unhealthy without a distinct failure. | rollback health is mandatory; incomplete recovery exits 125 and demands manual recovery |

`test/hostile-closure.test.js` contains twelve named closure regressions. The complete suite is 40/40. An exact locally staged archive, including `.github/` because workflow-policy regressions inspect it, also passed 40/40 after extraction, continuity, the six-fault deterministic Failure Lab and the deliberately non-certifying smoke run.

## Deliberately open gates

- real systemd delegated-cgroup startup and containment
- staged code-and-state rollback rehearsal on the target host
- live browser traffic through Kernel Compute Fabric (the preserved 0.6 tunnel remains canonical)
- physical Ryzen quietness and two-adapter GPU calibration
- desktop/mobile long-session responsiveness and memory trends
- retained 24-hour qualification and 72-hour certification evidence

Do not change `releaseChannel` to `certified` until every external gate passes.
