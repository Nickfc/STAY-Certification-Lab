# STAY Chronobiology C0 v1.1 implementation audit

Status: **IMPLEMENTATION CLOSED; C3-C SEAL BLOCKED**

This audit covers every normative section and appendix in *STAY Chronobiology C0 Design & Production Specification v1.1*. It does not grant live authority. Chronobiology remains `LABORATORY/SHADOW`, `productionEligible=false`, and has no live route or direct SNTSS mutation surface.

The source candidate is based on `feature/chronobiology`. The exact final-candidate commit is intentionally not named here because it is created only after this audit and its evidence are committed. `docs/chronobiology/c3c-certification-status.json` binds the candidate tree and hashes.

## Normative section closure

| C0 section | Status | Implementation / proof |
| --- | --- | --- |
| 0–1 bootstrap and sealed baseline | CLOSED | Source identity captured at `b699fca…`; one feature branch; sealed resident/BSF substrate reused. |
| 2 purpose, scope, non-goals | CLOSED | 64-unit endogenous oscillator; no scheduler, civil-time, sleep, cardiac, autonomic, endocrine or SNTSS ownership. |
| 3 constitutional laws | CLOSED | All C0.1–C0.20 laws are enforced by founder/state validation, fixed-point dynamics, trusted-time evidence, route gating, shared outbox/recovery and SHADOW-only contracts. |
| 4 ownership and authority modes | CLOSED | Kernel owns time/authority; Chronobiology owns only its rhythm. Manifest and resident contract are non-production SHADOW. |
| 5 oscillator architecture | CLOSED | `founder.js`, `oscillator.js`: 64 persistent units, intrinsic heterogeneity, amplitude, PRC sensitivity and symmetric bounded coupling graph. |
| 6 founder and single genesis | CLOSED | Deterministic founder expansion, persisted seed/expanded phenotype/hash, second-genesis refusal and exact reconstruction checks. |
| 7 authoritative state | CLOSED | Schema v2 separates binding, genesis, phenotype, acquired physiology and continuity; macro phase is derived, never a master state variable. |
| 8 dynamics and ordering | CLOSED | Simultaneous pre-state integration; coupling, intrinsic phase, amplitude, photic perturbation and validation occur deterministically. |
| 9 deterministic numerics | CLOSED | Integer/BigInt fixed-point engine, hash-bound 4096-entry trig table, canonical rounding/wrap, bounded 60 s quantum and overflow refusal. |
| 10 trusted organism time | CLOSED | Kernel-authenticated `trustedTimeUs`; wall-clock independence test; rewind/duplicate/revision/uncertainty tests; no downtime inference. |
| 11 ordering and catch-up | CLOSED | Ordered evidence plan, route-finalized frontier gating, 30-day coarse-path threshold, certified 12 h coarse integration through two years. |
| 12 photic evidence | CLOSED | Versioned LAB/SHADOW interval contract, quality/coverage/completeness validation, bounded queue, darkness distinct from gap. Real-world producer remains C0-deferred. |
| 13 transduction and PRC | CLOSED | Nonlinear saturation, persistent adaptation/recovery and continuous two-harmonic phase-dependent PRC. |
| 14 entrainment | CLOSED | Cue coverage, phase-lock/alignment summaries, advance/delay, gradual re-entrainment, chaotic/competing schedule bounds. |
| 15 aggregate state | CLOSED | Population vector, independent amplitude/coherence, enter/exit resolvability hysteresis and bounded trusted-time phase history deriving wrap-aware velocity/effective period. |
| 16 BSF contracts | CLOSED | Trusted binding/time and LAB photic inputs; context-only phase-summary output; no target commands or microphysiology. |
| 17 exactly-once/outbox/routes | CLOSED | Shared producer identity, stream sequencing, checkpoint+ACK+outbox transaction, route progress/finalization and replay; no private ledger. |
| 18 persistence/migration | CLOSED | Full checkpoints; latest prior CoreHost-valid checkpoint recovery; finalized cursor replay; deterministic schema v1→v2 migration; v2→v1 refusal. |
| 19 failure physiology | CLOSED | Local fail-closed behavior, uncertainty freeze, gap degradation, bounded CoreHost retry, corrupt state fallback/quarantine and no reset. |
| 20 containment/backpressure | CLOSED | Package capabilities, cgroup/resource contract, queue/output/pending-request/history/checkpoint bounds and local quarantine. Host enforcement is rechecked by the server bundle. |
| 21 observability/privacy/operators | CLOSED | Public health exposes macro context only; oscillator/founder microstate stays in checkpoint/lab evidence; no phase-set/reset/authority operator control. |
| 22 C1 package | CLOSED | Core package, manifest, policy, founder, trusted time, durable state, CoreHost lifecycle and direct hostile tests. |
| 23 C2-A laboratory | CLOSED | 32/64/128 resolution, 15/30/60 s convergence, accelerated year, aggregate history/hysteresis; report in `c2a-convergence-report.json`. |
| 24 C2-B laboratory | CLOSED | Advance/delay/weak PRC, saturation, adaptation, darkness/gap, entrainment/re-entrainment, route causality; report in `c2b-photic-report.json`. |
| 25 C2-C laboratory | CLOSED | Restart, duplicate, long gap, corruption fallback, finalized replay, migration and rollback; report in `c2c-persistence-report.json`. |
| 26 C3-A containment | CLOSED (source); SERVER RECHECK REQUIRED | Eight direct containment gates plus shared CoreHost/cgroup/resource tests. Exact production-host enforcement is part of C3-C server certification. |
| 27 C3-B shadow | CLOSED | SHADOW context, cadence, deterministic replay, transactional output, authority isolation, prior-checkpoint recovery and no SNTSS mutation. |
| 28 C3-C evidence/seal | PARTIAL / SEAL BLOCKED | Split-host compute and actual-Lightsail sentinel lanes are produced. Zero-failure/zero-skip compute evidence and byte-identical real live sentinels must bind the exact same candidate SHA/tree before a seal. |
| 29 calibration | CLOSED | Versioned machine profiles and human-readable C2 reports bind provisional/frozen values and convergence tolerances. |
| 30 repository layout | CLOSED | Modular Chronobiology package, schemas, reports, tools and tests; shared Kernel mechanisms generalized only where required. |
| 31 tranche workflow | CLOSED | Meaningful green commits pushed to one branch. Read-only watchable server certification bundle supplied. |
| 32 hostile matrix | CLOSED except server gates | Direct and targeted matrices are executable; full-host items are deliberately delegated to the exact server bundle. |
| 33 decision register | CLOSED | C0 frozen choices preserved; calibration choices versioned; real photic producer/live route and all future peripheral clocks remain deferred. |
| 34 rejected shortcuts | CLOSED | No wall clock, scalar timer, phase setter, hidden reroll, direct core shortcut, private chronology, per-unit repair or live-authority relabeling. |
| 35 definition of done / C-AUTH | IMPLEMENTATION CLOSED; RELEASE BLOCKED | C1–C3 source is complete. C-AUTH and final seal remain blocked pending the exact server result and separate future approval. |
| Appendices A–C | CLOSED | State/wire schemas and numerical/state invariants are represented in schemas, validation and hostile tests. |
| Appendix D | CLOSED except release-host gates | Detailed mapping below. |
| Appendices E–G | CLOSED | Source capture performed; bootstrap/change policy followed; this audit records the changed implementation basis. |

## C0 constitutional-law evidence

| Law | Enforcement |
| --- | --- |
| C0.1–C0.4 endogenous population, heterogeneity, phenotype continuity, resolution non-biology | `founder.js`, `oscillator.js`, C1-GEN and C2-OSC tests, 32/64/128 convergence. |
| C0.5 phase/amplitude separation | `aggregate.js`, C2-OSC-04/05. |
| C0.6 Kernel time only | `state.js`, Kernel trusted-time evidence, CHR-C1-TIME-01–05. |
| C0.7–C0.8 entrainment never setting / no 24 h command | `photic-transducer.js`, `phase-response.js`, C2-PHOT-01–04/09. |
| C0.9–C0.12 genesis/no prehistory/no reroll/acquired persistence | `founder.js`, `validation.js`, C1-GEN, CoreHost restart and C2-PERS tests. |
| C0.13 context only | phase-summary schema, C3-SHD/REL tests. |
| C0.14–C0.15 cue-loss free-run / uncertain-time freeze | C2-PHOT-06/07 and CHR-C1-TIME-05. |
| C0.16 resolvability | aggregate enter/exit hysteresis, C2-OSC-05/08–10. |
| C0.17 invalid mathematics | fixed-point/validation fail-closed tests. |
| C0.18 reset forbidden | prior-valid recovery, no-valid fail-closed, founder corruption tests. |
| C0.19 forward model change | schema migration is representation-only; model v1 remains pinned; unsupported model refuses. |
| C0.20 BSF-only communication | manifest/BSF/shared outbox routes; source audit forbids SNTSS dependency. |

## Appendix D detailed test mapping

| Catalogue range | Executable evidence |
| --- | --- |
| C1-GEN-01–03 | `chronobiology-c1-genesis.test.js` GEN-01/02 and deterministic phenotype reconstruction. |
| C1-GEN-04 | `chronobiology-c1-corehost.test.js` HOST-02 restart identity. |
| C1-GEN-05 | `chronobiology-c1-genesis.test.js` GEN-03 no civil-time semantics. |
| C1-TIME-01–05 | Explicit CHR-C1-TIME-01–05 tests plus Kernel trusted-time targeted tests. |
| C2-NUM-01–06 | Explicit tests in `chronobiology-c2-oscillator.test.js`. |
| C2-OSC-01–07 | Explicit tests plus OSC-08–10 for history estimator and hysteresis. |
| C2-PHOT-01–10 | Explicit tests plus PHOT-11–16 for malformed input, causality, backpressure and finalized routes. |
| C2-PERS-01 | CoreHost retry/snapshot failure tests and exact checkpoint restart. |
| C2-PERS-02 | C3-SHD-05 shared outbox recovery. |
| C2-PERS-03 | C3-SHD-08–11 prior-valid recovery/fail-closed cases. |
| C2-PERS-04–07 | C2-PERS-04/07 corruption, C2-PERS-05/06 long-gap, CHR-C1-TIME-05 uncertainty. |
| C2-PERS-08–09 | Explicit migration and rollback tests in `chronobiology-c1-corehost.test.js`. |
| C2-BSF-01–03 | Shared producer idempotency, stream sequencing and producer/resident outbox suites. |
| C2-BSF-04 | PHOT-14/15 plus biological route lifecycle/stream progress. |
| C2-BSF-05–06 | BSF policy/acceptance authority tests and C3-SHD/REL context-only tests. |
| C3-RES-01–07 | `chronobiology-c3-containment.test.js` RES-01–07, plus RES-08 telemetry isolation and shared CoreHost/audit/hostile closure. |
| C3-SHD-01–04 | C3-SHD-01–07: SHADOW output, no authority/SNTSS mutation, non-promotability by manifest, deterministic replay. |
| C3-REL-01 | Hostile certification package/hash substitution and unsupported-version tests. |
| C3-REL-02 | **COMPUTE GATE:** detached exact candidate direct, targeted and fresh full suites must be zero fail/skip/todo/cancelled in the private sustained-CPU lab. |
| C3-REL-03 | **COMPUTE GATE:** frozen 250 ms performance gate, environment record and before/after leaked-process check. |
| C3-REL-04 | **ACTUAL-HOST GATE:** before/after real `stay.service` and `/opt/stay/current` sentinels must match; they may not be emulated. |
| C3-REL-05 | **BLOCKED:** final seal only after compute and actual-host records bind the exact same candidate SHA/tree and compute-record digest. |

## Explicit deferred and blocked items

- A real-world photic producer, sensor trust model and live route are explicitly deferred by C0 §33.3.
- Live Chronobiology authority, production eligibility, SNTSS physiological coupling and C-AUTH remain unauthorized.
- The local sandbox full suite is not a seal result: Unix-socket creation is denied and the sealed legacy 0.6 fixture is absent.
- No final seal commit may be created until the private compute record reports zero failures/skips/todos/cancellations, the frozen performance and leaked-process gates pass, the actual Lightsail sentinel remains unchanged, and both sanitized records bind the exact same candidate SHA/tree.
