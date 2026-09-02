# R123F 72-hour physiology benchmark closure

Status: PASS under the reviewed V4 adjudication contract.

The canonical V3 milestone remains `OBSERVED_FAILURES`; it is not rewritten. V4 proves that its sole failed observation was one committed Chronobiology outbox publication sampled during the bounded committed-before-published interval. The durable row was published 40 ms after the sample, the immediately adjacent samples were clear, and no hard or evidence-incomplete observation remains.

## Immutable identities

- R123F start: `2026-08-30T09:55:32.018Z`.
- R123F 72-hour capture: `2026-09-02T09:55:50.255Z`.
- Collector starts/restarts: `1 / 0`.
- Samples: `4,312`.
- Sample ledger SHA-256: `47b7b60e91e853fcd1a4c9cf8a5242d8af65bd403e47fe8a45d4dbcf19311136`.
- V3 state SHA-256: `700f3736ff92f13bbbcfc1427e324160cc7cbc4a48d1de4474c103c67a51ee89`.
- 72-hour milestone SHA-256: `4d2116da14a18d92f710815d64b23f08e2b48d81acc46c0de8a727390d76961f`.
- Query-only witness SHA-256: `80c383e7b9b15c3da64b29e14d2ca4800d8ad64f19b63dd44ec401afa8564cfc`.
- V4 report SHA-256: `a78cd8281d246d851e3476f8da50964bc7e9556a8760439099dd727ecadfc6e4`.
- Complete nine-file closure bundle SHA-256: `1d51379d733a1428019ed2c21a866cd12037aec6eab684b5eeae9e0ed0501995`.

The complete bundle is retained off-host and the original evidence remains root-owned mode `0400` on the production host. Clean extraction produced exactly nine expected regular files. A second offline run reproduced `adjudication-v4.json` byte-for-byte.

## Closure state

- V4 result: `PASS`.
- Remaining observed failures: `0`.
- Adjudicated committed-in-flight publications: `1`.
- Evidence-incomplete observations: `0`.
- Hard observation failures: `0`.
- SNTSS checkpoint progress: `1,034,033`; outputs: `0`; authority: `0`.
- Chronobiology checkpoint progress: `4,320`; authority: `0`.
- Service PID: `395571`; service restarts: `0`.
- SQLite quick-check: `ok`; pending/failed deliveries: `0 / 0`; pending outbox: `0`.
- BSF: `LIVE / RUNNING`.
- SNTSS and Chronobiology: `SHADOW / RUNNING / healthy / authority-free`.
- Fetus `0.6.0`: healthy with unchanged `192 / 256 MiB` memory guards.

No production revision, release pointer, StateStore row, biological route, resident authority, resource contract, or runtime file was changed by adjudication.
