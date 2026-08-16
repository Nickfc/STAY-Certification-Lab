# R11 Host Certification Harness

Status: **DESIGNED — DO NOT EXECUTE WHILE R8 ENDURANCE IS ACTIVE**

The R11 host harness converts the host-only cells of the R11 certification matrix into explicit, evidence-producing probes. It is a certification helper, not a deployment mechanism. It does not authorize R11 acceptance, R12 installation, production genesis, live chemistry, or mutation of the living organism.

## Non-negotiable boundary

The harness itself must never run as root. It refuses UID 0. Candidate repository code therefore cannot acquire root merely because an operator starts host certification.

Root-required trust establishment remains a separate ceremony governed by `R10_5_TRUST_BOOTSTRAP_CEREMONY.md`: system/OpenSSL/SHA256 verification happens first, and only externally authenticated trusted-boundary bytes may subsequently receive root. The R11 harness only inspects those installed trusted objects from an unprivileged account.

The harness also refuses to execute while any active `stay-r8-host-*` service exists. **It must not be executed while the current R8 24-hour endurance trace is still collecting.** Plan mode is repository-only and safe during R8.

## Protected live surfaces

The harness may read a minimal live-foundation fingerprint, but it never writes:

- `/var/lib/stay` — organism StateStore and service state;
- `/opt/stay/current` — active release pointer;
- `/etc/stay` — trusted production configuration;
- `/usr/local/lib/stay` and `/usr/local/sbin/stay-deploy` — trusted verifier/deployer;
- `/etc/systemd/system` — system service definitions;
- `/run/stay-forensic-anchor` — separately owned witness runtime root.

It never invokes a start/stop/restart/enable/disable operation on `stay.service`, and it never invokes `stay-deploy`.

Every writable artifact remains under one approved lab directory whose basename starts `r11-host-cert-` and whose direct parent is `/opt/stay/incoming` or `/tmp`. The directory must be a real non-symlink directory owned by the unprivileged runner and not group/world writable. `.r11-host-lab.json` permanently binds a reused lab directory to one exact candidate SHA.

## Modes

`npm run plan:sntss-r11-host` prints the plan only. It performs no host attacks and writes no host evidence.

`npm run certify:sntss-r11-host -- ...` enters execution mode, but also requires:

`STAY_R11_HOST_CERT_ACK=ISOLATED-NON-LIVE`

Execution receives the exact checked-out 40-hex candidate commit and compares it with `git rev-parse HEAD`.

A phase-only execution may produce useful evidence, but returns `PARTIAL_PASS_HOST_EVIDENCE_ONLY`, not whole-host PASS. `PASS_HOST_EVIDENCE_ONLY` is possible only when every host phase is present and PASS. Even that result **does not certify R11**; freeze, Hostile Takeover Audit #2 and independent acceptance remain separate gates.

## Host phases

### Sandbox — R11-B

Uses the candidate's real `sandboxWorkerPlan()` and real bubblewrap. It proves the hostile worker cannot see the live StateStore or active release, cannot see the live STAY PID in sandbox `/proc`, cannot write the release mount, cannot reach live loopback networking, and cannot spawn child processes.

### Trust — R11-G

Read-only proof of already-established trust: root ownership, non-writable trusted objects, exact out-of-band SHA-256 public-key fingerprint, and an independent bootstrap transcript outside the candidate checkout. The harness cannot bootstrap its own trust.

### Release — R11-F

The host-owned verifier at `/usr/local/lib/stay/trusted-release-verifier.js` authenticates an exact signed release bundle inside the disposable lab. Candidate verifier code is never used for the trust decision.

The phase remains pending until an independent production-host **replica** rehearsal record binds the same candidate/archive and records `replica: true`, `liveOrganismTouched: false`, and `preserveForwardState: true`. The live organism is never a deployment rehearsal target.

### Operator authentication — R11-K / M-01

Launches `server-secure.js` with a disposable StateStore and random loopback port. `/healthz` must remain public; missing, wrong and query-string credentials must fail; the correct bearer capability must succeed. Only a token hash enters evidence.

### Revocation — R11-H / M-02

Runs durable revocation/rollback regressions on the host using disposable test StateStores. No live authority is touched.

### Independent forensic anchor — R11-L / M-03

Inspects `stay-forensic-anchor.service` and its separately owned runtime/state roots. The STAY user must not own writable witness state. Repository regressions independently prove receipt chaining and outage behavior; final review retains witness evidence outside the organism StateStore.

### Lifecycle — R11-O

Runs crash/restart/replay and biological-ledger hostile regressions on disposable StateStores only. It does not signal or restart live `stay.service`.

### R8 entrance evidence

Strictly validates the completed R8 24-hour artifact and independent review bound to its exact hash. The long-window RSS slope must be finite and non-positive; null/missing values fail closed.

This closes the R8 entrance gate. It is not automatically R11-Q evidence for code changed afterward.

### Exact-candidate endurance — R11-N / R11-Q

Because R10.5/R11 introduced runtime-bearing security changes after the current R8 candidate was pinned, final R11 certification requires a **second 24-hour exact-candidate endurance/pressure artifact** once the eventual R11 candidate has stopped changing.

That artifact must name the exact candidate SHA, meet the same strict non-positive memory-slope contract, contain successful OOM/PID/CPU containment evidence, preserve continuous health and the live-foundation fingerprint, and receive an independent review bound to both artifact hash and candidate SHA.

This second run is deliberately deferred until the current R8 run is accepted and non-duration host attacks are complete. It prevents a newer sandbox/runtime from inheriting an older endurance certificate.

## Execution order after R8 closes

1. Independently review and accept the current R8 artifact.
2. Run non-duration host probes: sandbox, trust, operator auth, revocation, anchor and lifecycle.
3. Complete the signed release/cutover/rollback rehearsal on a production-host replica, never the live organism.
4. Fix anything found; any runtime-bearing fix creates a new candidate SHA.
5. When the candidate stops changing, run the second 24-hour exact-candidate endurance/pressure drill.
6. Run the complete host harness against that exact candidate.
7. Run Hostile Takeover Audit #2.
8. Only then may independent review freeze `CERTIFIED_NEUTRAL_CAPABLE_CANDIDATE_ONLY`.

## Stop conditions

Stop and return to engineering on sandbox escape, StateStore visibility, release mutation, PID/network escape, unauthorized operator status, trust-root mismatch, candidate-controlled verification, revoked-code resurrection, biological rewind, forensic-witness ambiguity, positive long-window memory slope, or any before/after live-foundation change.

A stop condition never authorizes experimentation on the live organism.
