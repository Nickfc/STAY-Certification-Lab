# SNTSS R10 Candidate Traceability

R10-01 deterministic release inventory and state/secret exclusion -> `runtime/release/sntss-release-control.js`, `test/sntss-release.test.js`.

R10-02 pinned provenance binds commit, package policy, profiles, schemas, evidence, tests and dependencies -> `RELEASE_PROVENANCE.json` v2 emitter/verifier.

R10-03 neutral fallback is inert -> `cores/sntss/neutral/index.js` validation in release-control.

R10-04 preflight cannot mutate canonical state -> disposable release replica rejection test.

R10-05 post-switch failure rolls code back without restoring old biology -> `preserve-forward-state` rollback policy and failed-forward-state retention.

R10-06 successful switch is atomic and identity-preserving -> release replica atomic symlink test.

R10-07 forward migration/backward projection preserve acquired biological invariant -> existing SNTSS migration contract exercised by R10 verifier.

R10-08 release documents reproduce from candidate bytes and tampering fails closed -> isolated copy verification test.

R10-09 production deployer requires R10 provenance and contains no routine pre-deployment StateStore restore path.

R10-10 remote staging remains workflow-dispatch-only with pinned GitHub actions and uploads to incoming only.

R10-11 Git/Linux and Windows builders emit the same v2 provenance/inventory contract and exclude live/laboratory state.

R10-12 committed R10 evidence is hash-bound to the controlling implementation, tests and builders.

Formal R10 acceptance remains dependency-gated by R8/R9 closure and the isolated production-host release rehearsal. No live SNTSS installation is authorized here.
