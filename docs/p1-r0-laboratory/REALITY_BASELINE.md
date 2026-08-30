# P1-R0 laboratory reality baseline

Status: captured; Linux acceptance remains a separate required gate. No runtime implementation change is authorized by this record.

## Lane boundary

This laboratory lane is isolated from the frozen R123F production release and its running physiology benchmark. It may add repository code and tests, but it must not attach a resident, create a founder or route in production, restart `stay.service`, write the production StateStore, or merge into the benchmarked production release.

The supplied C0 pack describes an older R110F handoff and says to wait for that campaign's terminal PASS. The controlling owner plan for this lane explicitly permits laboratory development after the newer R123F benchmark starts. That newer instruction changes the scheduling gate only; every containment, causality, persistence, no-rewind, and authority prohibition from the pack remains binding.

## Source identity

- Repository: `https://github.com/Nickfc/STAY-Genesis.git`
- Worktree: `C:/Users/nickf/Documents/GitHub/STAY-Genesis-p1-r0-laboratory`
- Branch: `codex/p1-r0-laboratory`
- Source tag: `r119f-v4`
- HEAD: `833cf2564ed2be040c681a627de24042f9ac1538`
- Tree: `97a1f8dbcf596cb98f0bda9af8faacfd709cb9ef`
- Capture host: `NICK`, Windows, Node `v24.19.0`, Git `2.55.0.windows.3`
- Capture time: 2026-08-30 UTC
- Initial and post-capture Git status: clean
- Submodules: none
- Git LFS entries: none
- Package lockfiles: none

## Immutable input pack

- Archive: `STAY_P1_R0_Laboratory_Implementation_Pack_C0_v1.0.zip`
- Archive SHA-256: `3a4ed9516a9e22dd2dadd4238072d0afc95bfde7d8e1d1e33e85f4426b67115e`
- Manifest SHA-256: `b095c882407ec3d9f2c416309711e6519b41e2fb4fbf2f89f533cab952dc6d69`
- Manifest payload entries: 66
- Archive files: 68, consisting of 66 payloads plus `MANIFEST.json` and `SHA256SUMS`
- Size/hash mismatches: 0
- Missing/extra manifest payloads: 0
- Pack validator: 56 JSON documents, 37 schema documents, 53 recursive schema IDs, 144 references, three founder profiles, three evidence templates, zero errors

## Repository inventory

| Inventory | Identity |
|---|---|
| `package.json` SHA-256 | `30fdbe2295cc6892f3432000d8d7ba169920ab87d705a0e7521c5e7fd6981d03` |
| `.github/workflows` tree | `a853fb54c93b096daa07321218d2694c2f7095fe` |
| `runtime/kernel` tree | `bfeb0d3f1984d068f89d859b86d68e9a483557e3` |
| `runtime/ui` tree | `0005f1070ca068a82aa8192e9f62d0c13d5c6854` |
| `cores` tree | `29ba9a45b36c4be1f24e01113502a2ce03c8cba9` |
| `test` tree | `56c22476cc095eea75487038b46e84d962b52025` |
| production transplant tree | `1d08f4d6c812e58e92a9c764d387ece6cd5a7400` |

The full-suite command is `node --test --test-concurrency=1 test/*.test.js`. The source tree contains 113 `*.test.js` files and 936 lexical `test(...)` declarations.

The direct-Windows baseline exercised the entire glob using the bundled Node `v24.19.0`:

- tests: 926;
- passed: 898;
- failed: 20;
- skipped by existing test declarations: 8;
- cancelled/todo: 0/0;
- Node duration: 502,750.6561 ms;
- wall duration: 502,800 ms;
- exit code: 1.

All 20 failures are existing Linux/Unix-environment assumptions: read-only cleanup semantics, path/packaging normalization, Linux Node-path planning, `SIGUSR1`, symlink creation, Unix-domain sockets, POSIX shell execution, the approved Linux R11 host-root shape, and Linux release-pointer rehearsal. These are environment failures, not waived tests. The real unmodified Linux full suite and Bubblewrap entry gates remain required before a tranche can pass.

## Concurrent production benchmark boundary

The independent R123F collector started at `2026-08-30T09:55:32.018Z`. Its root-owned, mode-0400 15-minute milestone was captured at `2026-08-30T10:10:33.181Z` and passed with:

- milestone SHA-256 `39e6e62493a2ec6cd662d8b55287b222812efc693219a1ee3ebe04e6ae793458`;
- 16 samples, zero failures, and zero observed failures;
- one collector start and zero collector restarts;
- SNTSS checkpoint progress 3,594 and Chronobiology checkpoint progress 15;
- zero CoreHost faults/timeouts, recovery failures, cgroup fault events, and process transitions;
- final pending deliveries/outbox intents 0/0;
- SNTSS outputs zero;
- `BSF · LIVE`, `SNTSS · SHADOW`, `CHRONOBIOLOGY · SHADOW`;
- unchanged `stay.service` PID 395571 and zero restarts.

The maximum sampled pending-delivery count was two. Both were ordinary in-flight deliveries and drained to zero; this is not an abandonment or a hidden queue failure. The 12-hour and 72-hour collection continues independently.

## Actual API map

| Concern | Repository truth | Laboratory use |
|---|---|---|
| Resident lifecycle | `runtime/kernel/resident-manager.js`: `ResidentManager` at line 590; `attach` 1675; `recover` 2105; `processEvent` 2397; `detach` 3419; `reattach` 3617; `drain` 4154 | New cores use the resident lifecycle; they do not invent an attachment or recovery path. |
| CoreHost boundary | `runtime/kernel/core-host-client.js`: `CoreHostClient` at 120; `start` 179; `dispatch` 543; `snapshot` 615; `health` 628; `setMode` 646; `stop` 810 | Modules retain the existing manifest/start/handle/snapshot/health boundary and its existing resource deadlines. |
| StateStore | `runtime/kernel/state-store.js`: `StateStore` 479; `init` 494; `appendAcceptedBiologicalEnvelope` 2091; consumer registration 6835; resident registration 7611; resident checkpoint commit 7917; recovery-plan read 8748 | Existing Event Fabric, resident identity, consumer cursor, checkpoint, and outbox transactions remain canonical. |
| UBE v2 | `runtime/kernel/biological-envelope.js`: frozen protocol `stay-biological-envelope-v2`; `acceptEnvelope` 1265; `normalizeAcceptedEnvelope` 1440 | The pack's differently shaped “UBE v2 envelope” cannot replace or overload this protocol. P1 frames must be adapted into the existing proposal/envelope contract. |
| Acceptance/causality | `runtime/kernel/biological-acceptance.js`: `prepare` 642; `finalizePrepared` 1157; `accept` 1417 | Kernel-owned time, producer identity, sequence, causal ancestry, and anti-laundering remain outside core authority. |
| BSF | `runtime/kernel/biological-signalling-fabric.js`: manifest install 1575; proposal validation 1740; route resolution 1924; delivery evaluation 2026; route binding 2359; completeness 2457 | P1 topics/classes/routes must map into these exact manifested capabilities and leases. |
| Trusted organism time | `runtime/kernel/trusted-organism-time.js`: `TrustedOrganismTime` 271; `start` 462; `sample` 589; `checkpoint` 649 | P1 advances only from accepted trusted frames. Uncertain time freezes state and creates no catch-up impulse. |
| Fixed point | Existing SNTSS uses decimal scale 1,000,000; Chronobiology has its own frozen engine. No shared Q16.48 primitive exists. | Add a separate P1 Q16.48 module; do not change either frozen engine. |
| Chip projection | `runtime/ui/chip-projection.js`: read-only projection at 127; public metadata in `server.js` at 20 | Persistent chip history will be StateStore-owned; public projection remains additive and observation-only. |
| Freeze/benchmark | `runtime/revision-freeze.js`: freeze reader at 60; benchmark failure accounting at `p1-physiology-benchmark.js` 500 and milestone summary at 845 | Laboratory artifacts cannot change the R123F freeze or benchmark files. |

## StateStore decision

The existing resident/checkpoint/outbox tables are sufficient for resident execution and atomic transition persistence. They are not sufficient for the pack's exactly-once founder record or append-only universal chip history. Those records require an additive, fail-closed laboratory schema revision with:

- a current record and immutable history for chip observations;
- one committed founder per organism/core lineage;
- parent/hash and generation fencing;
- no cascade that can erase founder or chip history;
- migration tests proving a schema-4 P0 database gains only the new empty structures and retains byte-equivalent P0 biological rows.

This decision does not authorize migration of the production database during the R123F benchmark.

## Baseline decision

Tranche A repository reality and contract reconciliation are complete. The Windows run is diagnostic evidence, not a release PASS. No production blocker has been discovered. Tranche B may add red tests and laboratory-only foundations, but it cannot pass until its unmodified Linux full suite, clean extraction, and real entry preflights pass.
