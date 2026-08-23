# R10.5 Hostile Boundary Closure

Status: candidate hardening complete in the repository; production activation remains prohibited. R10.5 exists because the R0-R10 hostile-takeover audit deliberately changed the threat model from **buggy Core code** to **actively malicious candidate code and artifacts**.

## Constitutional rule

The Living Kernel and canonical StateStore are the authority boundary. A Core may be wrong, compromised, adversarial, or intentionally deceptive and must still be unable to obtain authority by escaping an application-level convention.

R10.5 therefore treats all candidate release bytes and all native Core code as untrusted until a trusted layer outside the candidate has authenticated and contained them.

## Release trust boundary

The activation path is now:

1. extract an archive with path/type/size checks;
2. verify the transport checksum;
3. use the **host-owned** `/usr/local/lib/stay/trusted-release-verifier.js`, never a verifier from the candidate;
4. reproduce the candidate byte inventory without importing candidate JavaScript;
5. verify R10 provenance and no-rewind policy from trusted code;
6. verify an external Ed25519 release authorization against `/etc/stay/release-authority.pub`;
7. only after authentication, perform syntax checks and executable continuity preflight;
8. executable preflight runs unprivileged in a bubblewrap namespace with no live StateStore mount and no network;
9. only then may the immutable release pointer be switched during an explicit operator deployment.

The private release-authority key is offline-only. GitHub staging and the production host do not receive it. CI may build/stage an unsigned candidate, but an unsigned candidate is not activatable.

The authorization binds the exact archive SHA-256, release inventory hash, provenance hash, version, commit, permitted action, validity window and nonce. Regenerating candidate-controlled provenance is therefore insufficient to gain activation authority.

## Core execution boundary

The Kernel no longer relies on the source scanner or Node permission model as the hostile-code security boundary.

For native Cores, the process hierarchy is:

```text
Living Kernel
  -> trusted CoreHost supervisor (does not import candidate code)
      -> OS-contained candidate worker
```

The supervisor retains the Kernel IPC channel and independently stamps causal context. Candidate code is loaded only by the worker. On a production host the worker is launched through bubblewrap with:

- separate mount, network, PID, IPC, UTS, cgroup and user namespaces (`--unshare-all`);
- nested user namespaces disabled;
- all Linux capabilities dropped;
- a read-only exact release mount at `/stay-release`;
- `/usr` read-only for Node/runtime dependencies;
- scratch `/tmp`, `/var` and `/run` only;
- no `/var/lib/stay` mount;
- no `/opt/stay/current` mount;
- no shared host network;
- death coupled to the trusted supervisor.

The current immutable fetus compatibility Core remains an explicit legacy exception. SNTSS and future native Cores do not receive that exception.

Bubblewrap presence and namespace behavior must still be proven on the non-live production host during certification. Repository tests prove the plan and fail-closed requirement; they do not pretend to be a real host namespace test.

## Package policy

SNTSS package policy is mandatory, including `0.0.0-neutral`. A missing SNTSS policy is a hard load failure.

The source analyzer remains useful defense in depth for dependency hygiene, ambient capability syntax and accidental mistakes, but it is explicitly not treated as the hostile-code sandbox. Relative package inventory entries may not escape the package root except for a tiny explicitly trusted shared ABI (`runtime/kernel/canonical-json.js`).

## Kernel-owned promotion authority

A candidate manifest cannot promote itself. When production promotion enforcement is enabled, the Kernel requires an external Ed25519 `stay-core-promotion-v1` certificate bound to:

- permanent organism identity and identity hash;
- exact Core ID and version;
- exact module hash;
- exact validated manifest hash;
- exact package-policy hash;
- exact allowed input and output topics;
- permitted lifecycle action;
- authorization class and validity window;
- R11 certification hash when active non-neutral SNTSS is eventually permitted.

Neutral SNTSS may have zero outputs only. Pre-R11 SNTSS shadow authorization may also have zero outputs only. Active non-neutral SNTSS requires both `productionEligible === true` and an R11 certification hash. The current laboratory SNTSS cannot satisfy that gate.

Rollback is intentionally different: it may reactivate an already-authorized standby as an emergency safety operation, but it still cannot rewind acquired biological state.

## Provenance ownership

Generic `LivingKernel.publish()` may no longer assert Kernel/Core authority metadata such as `sourceCore`, `sourceVersion`, `sourceInstanceId`, `authorityEpoch`, `causeSequence` or `causalParent`. Kernel-origin events use a separate trusted publisher. Core output provenance continues to be stamped by the trusted RuntimeSlot rather than accepted from candidate code.

## Forensic-chain rotation

R9 rotation now has a persistent monotonic segment high-water mark and an explicit retained anchor. Dropping old local segment manifests no longer resets the segment number or makes the retained chain unverifiable. An optional anchor sink allows rotated heads to be anchored outside the in-memory retention window; sink failure degrades observability only.

## Biological ledger retention debt

A required consumer may not pin the organism's biological ledger forever. A bounded retention-debt governor demotes and quarantines a consumer that exceeds the configured pending-event ceiling. The demotion is recorded durably. A demoted Core cannot silently reinstall/commit as though it had caught up; explicit biological resynchronization is required.

This is an availability containment action, not permission to rewrite or skip SNTSS biology. Any future resynchronization procedure must be separately specified and certified.

## Controls deliberately still pending

R10.5 is not production certification. The following remain hard gates:

- R8 full 24-hour host-endurance result and independent closure;
- actual bubblewrap/native-Core namespace rehearsal on a non-live production-host replica;
- R10 isolated production-host release rehearsal using the host-owned verifier and signed authorization path;
- R11 complete frozen-candidate certification and hostile-takeover re-audit;
- explicit wiring of external forensic-head anchoring before relying on it as off-box evidence.

Application-layer authentication for `/runtime/status` and signed snapshot manifests remain defense-in-depth follow-ups. The public Nginx boundary and loopback binding remain in force meanwhile.

## R11 entrance rule

R11 may not claim certification merely because unit tests pass. Before R11 closure, the exact frozen candidate must demonstrate:

- no candidate JavaScript executes in a privileged verifier;
- unsigned/re-signed-by-wrong-key release artifacts fail closed;
- a malicious native Core cannot observe or mutate canonical StateStore files;
- a malicious native Core has no host network and cannot signal/inspect host processes;
- promotion without the exact organism/package/certification certificate fails closed;
- forensic rotation remains verifiable across retention;
- required-consumer retention abuse is bounded;
- R8 endurance and the complete hostile suite are green.
