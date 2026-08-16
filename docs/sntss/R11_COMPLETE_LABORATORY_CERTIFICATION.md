# R11 Complete Laboratory Certification

Status: **DESIGNED / BLOCKED — certification has not started**

R11 is the final pre-live certification stage for SNTSS. Its purpose is not to prove that the implementation looks reasonable. Its purpose is to make a frozen candidate survive deliberate attempts to corrupt authority, provenance, state continuity, sandbox boundaries, rollback, observability and biological causality before any live-organism installation is considered.

This stage is repository- and laboratory-only. It does not authorize live chemistry, live biological output, active-state mutation, deployment to the running organism, or destructive testing against the live STAY service.

## Non-negotiable laws

1. **Exact-candidate law** — certification applies to one exact Git commit and one exact SNTSS package digest. Any runtime-bearing change invalidates certification and requires a new freeze and rerun.
2. **No self-certification** — candidate-controlled code may generate evidence, but may not be the sole verifier of its own authority, release provenance, package identity, trust bootstrap or sandbox boundary.
3. **Forward biology law** — rollback may restore code authority but may never rewind acquired biological state.
4. **One authority law** — no test may ever produce dual active authority, ambiguous producer provenance or two simultaneously valid SNTSS implementation instances for the same authority epoch.
5. **Fail-closed law** — uncertainty about release identity, promotion authority, organism lineage, source instance, state continuity, sandbox availability or trusted time blocks promotion.
6. **Host proof law** — repository tests cannot substitute for physical namespace, cgroup, bootstrap, process, network and filesystem evidence on a production-host replica.
7. **Observer separation law** — observability may degrade, fail or disappear without becoming chemistry control authority.
8. **Neutral-first law** — even a fully certified R11 candidate may only advance toward the separately gated neutral R12 installation. R11 never grants live chemistry.

## Entrance gate

R11 execution is blocked until all of the following are true:

- R8 24-hour host endurance evidence is complete and independently accepted.
- The out-of-band trusted-boundary bootstrap ceremony has been executed on a non-live certification host.
- Bubblewrap namespace behavior has been proven with malicious worker probes on a production-host replica.
- The signed R10 release path has been rehearsed on an isolated production-host replica, including failed cutover and preserve-forward-state rollback.
- R10.5 residual medium findings have either been closed or converted into explicit frozen-candidate blockers with evidence-backed rationale.

Until then, R11 is **DESIGNED / BLOCKED**.

## Certification domains

### R11-A — Authority attacks

Attempt stale-epoch publication, dual-authority races, forged active instance identity, authority reuse after restart, promotion replay and post-cutover writes from the demoted implementation.

Pass: exactly one authoritative implementation exists at every observable point; all stale or ambiguous authority fails closed; authority epoch remains monotonic.

### R11-B — Malicious Core attacks

Run purpose-built hostile SNTSS workers that attempt filesystem escape, StateStore access, host PID discovery, network access, child-process creation, executable probing, environment scraping, signal abuse, inspector activation and privilege escalation.

Pass: no StateStore access, no network, no host PID namespace access, no writable release, no process-spawn authority, no privilege escalation, no Kernel signal/inspector control.

### R11-C — Provenance attacks

Forge producer identity, source instance, implementation version, causal ancestry, delivery metadata, event identity and authority epoch across generic publish and direct CoreHost paths.

Pass: Kernel-owned provenance cannot be supplied or overwritten by the candidate; forged or missing provenance fails closed.

### R11-D — Modulation-frame forgery

Generate self-consistent frame hashes with wrong source core, source instance, version, organism lineage, authority epoch, target consumer, receptor profile, expiry or sequence.

Pass: frame acceptance requires both local frame integrity and independently trusted Kernel-authenticated delivery authority.

### R11-E — Package substitution

Replace, add, remove, symlink or mutate SNTSS package files; attempt policy omission; alter dependency inventory; substitute neutral and laboratory packages; attempt package-root escape.

Pass: exact package policy and package digest bind every executable dependency; any substitution blocks load/promotion.

### R11-F — Release substitution

Replace release files after build, swap provenance, alter authorization, replay authorization against another digest, change verifier inputs, alter release pointer targets and race verification against switch.

Pass: externally signed authorization binds exact release bytes and trusted verifier independently reproduces the authorized candidate before switch.

### R11-G — Trust-root substitution

Replace the release public key, manifest, installer or trusted verifier before bootstrap; attempt to make repository code become the first root of trust.

Pass: independent public-key fingerprint plus detached signature over exact bootstrap manifest is verified using system tools before repository code receives root.

### R11-H — Rollback and revocation

Attempt rollback to stale authority, corrupted standby, revoked package, revoked implementation instance, incompatible acquired state and pre-migration state.

Pass: rollback checks a durable revocation registry; authority advances; acquired biology is projected forward and never rewound.

### R11-I — StateStore corruption

Corrupt checkpoints, identity records, SQLite/JSON mirrors, upgrade journals, biological state blobs, content-addressed objects and continuity snapshots.

Pass: corruption is detected before authority activation; deterministic verified recovery is used where possible; fresh biology is never fabricated.

### R11-J — Migration corruption

Inject partial migrations, invalid schema versions, interrupted forward migration, backward projection mismatch, replayed migration records and oversized migration work.

Pass: migration is deterministic, bounded, journaled and recoverable; acquired biological invariants survive forward and backward code transitions.

### R11-K — Privacy leakage

Probe public metadata, operator health, logs, exceptions, observability records, release evidence and network responses for raw stimuli, private state, event payloads, identifiers or sensitive host data.

Pass: public surfaces remain bounded; privileged surfaces require an operator-only authenticated channel; forensic payload access requires explicit forensic capability.

### R11-L — Forensic tampering

Alter, omit, reorder, truncate or replace forensic records and segments; exhaust retention; replace local chain heads; fail external anchor storage.

Pass: tampering or omission is detectable; segment numbering remains monotonic; independently retained anchor heads prove chain continuity outside the mutable StateStore domain.

### R11-M — Observer failure

Crash telemetry sinks, block observer callbacks, overflow observability queues, throw during forensic capture and remove external anchor availability.

Pass: chemistry/authority never depends on observer success; failures are fail-visible and bounded, not state-control exceptions.

### R11-N — Resource exhaustion

Exercise memory pressure, CPU pressure, pids exhaustion, queue floods, log floods, output abuse, retained-ledger debt, checkpoint growth, hostile shutdown and restart storms.

Pass: cgroup and Kernel limits contain the candidate; the organism/kernel stays healthy; required-consumer debt is bounded by quarantine rather than unbounded storage.

### R11-O — Restart, crash and replay

Kill SNTSS at every lifecycle phase, kill trusted supervisor, interrupt candidate startup, crash after checkpoint but before acknowledgement, repeat durable events and restart during cutover/rollback.

Pass: exactly-once causal semantics and last-acknowledged state survive; no duplicate biological dose, no lost authority barrier and no stale post-restart source identity.

### R11-P — Deterministic reproduction

Run golden biology, migration, receptor, modulation-frame, package, release and forensic scenarios repeatedly across clean laboratories using the exact frozen candidate.

Pass: canonical outputs and evidence hashes reproduce exactly where determinism is part of the contract; explicitly random genesis values remain organism-bound and are not regenerated during restart.

### R11-Q — Long-duration stability

Run the frozen candidate under quiet, normal and bounded hostile laboratory load long enough to expose memory trends, queue growth, timer accumulation, forensic rotation and restart debt.

Pass: no unbounded resource trend, no authority drift, no evidence-chain degradation, no StateStore growth outside contract and no unexpected chemistry activation.

## Residual R10.5 medium closure inside R11

R11 must close the following before final acceptance:

- **M-01 privileged runtime status** — move detailed status behind an authenticated operator-only path or local Unix-socket/operator channel. Loopback/nginx topology alone is not the final application-layer control.
- **M-02 standby revocation** — add a durable revocation table keyed by package/module digest and implementation identity and check it before standby reactivation.
- **M-03 independent forensic anchoring** — configure and prove a retained external anchor sink outside the mutable StateStore trust domain.

## Evidence classes

Every domain must have at least one executable regression and, where the boundary is environmental, one independent host artifact. Accepted evidence classes are:

- deterministic test result tied to exact commit SHA;
- exact source/package/release digest;
- signed release/promotion/bootstrap artifact;
- host namespace/cgroup/filesystem/network/process probe transcript;
- StateStore integrity/recovery transcript;
- forensic chain plus independently retained anchor head;
- long-duration resource trace;
- independent reviewer acceptance record.

Narrative claims without an executable or independently verifiable artifact do not satisfy an R11 gate.

## Freeze ceremony

When every entrance blocker is closed, R11 creates one **frozen candidate** containing:

- exact Git commit SHA;
- exact SNTSS package-policy digest;
- exact SNTSS package digest/inventory;
- exact trusted verifier digest;
- exact release authorization public-key fingerprint;
- exact promotion certificate schema/version;
- exact R8/R10/R10.5/R11 evidence inventory;
- explicit revocation-table head;
- external forensic anchor identity;
- host certification fingerprint/environment record.

After freeze, no runtime-bearing file may change. Documentation-only changes must be proven non-runtime-bearing; otherwise the freeze is invalidated.

## Final acceptance rule

R11 can be marked PASS only when:

- all 17 certification domains are PASS;
- all host-required domains include real host evidence;
- all residual medium findings are closed;
- no Critical or High finding is open;
- no unexplained Medium finding remains;
- the exact frozen candidate has a fully green regression suite;
- independent review accepts the evidence inventory;
- `productionEligible` for active chemistry remains false.

The output of a successful R11 is **a certified neutral-capable candidate**, not a live chemistry authorization.

## R12 boundary

R12 remains the first stage that may consider touching the live organism, and only through a separately approved **neutral SNTSS installation** with no chemistry, no semantic stimulus processing and no biological output authority. R11 itself performs no live installation.
