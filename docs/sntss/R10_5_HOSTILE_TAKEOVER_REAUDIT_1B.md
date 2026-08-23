# R10.5 Hostile Takeover Re-Audit #1B

Status: **repository attack surface PASS; production certification still blocked by host evidence**

Audited runtime candidate: `f89e47c33759865c20f7748321b2b1d7308aadbd`

Scope: R0 through R10.5, with emphasis on malicious candidate code, malicious release artifacts, compromised sibling cores, forged producer provenance, forged modulation frames, observer/control inversion, authority rollback, retention exhaustion, and trust-bootstrap substitution.

This review treats candidate code and release artifacts as hostile until a trust boundary independently proves otherwise. Passing unit tests is supporting evidence, not the trust root.

## Result

Repository-design severity after closure:

- Critical: **0 open**
- High: **0 open**
- Medium: **3 residual hardening items**
- Host/certification evidence blockers: **4**

This does **not** authorize production SNTSS. `productionEligible` remains false and no live chemistry/output authority is granted.

## Original critical/high findings and closure

| Finding | Original risk | Closure in R10.5 | Re-audit |
|---|---|---|---|
| C-01 candidate verifier executed as root | hostile release could become root before verification | deployment invokes a root-owned verifier outside the candidate; candidate JavaScript does not execute before authentication | CLOSED |
| C-02 CoreHost shared Kernel OS trust domain | sandbox bypass could expose StateStore | hostile worker is planned through bubblewrap with isolated user/PID/network namespaces, read-only release, no StateStore mount; untrusted worker also has no child-process permission | CLOSED IN DESIGN; host execution proof required |
| C-03 self-attested release provenance | attacker could regenerate its own provenance | external Ed25519 release authority signs authorization; host pins root-owned public key/verifier; bootstrap itself now requires out-of-band key fingerprint and detached signed manifest before repository code receives root | CLOSED IN DESIGN; bootstrap ceremony required |
| H-01 regex scanner treated as sandbox | syntax variation could bypass lexical filters | scanner explicitly downgraded to defense-in-depth; OS namespace sandbox is the security boundary | CLOSED |
| H-02 package policy optional | SNTSS could load without package attestation | SNTSS policy is mandatory, including neutral SNTSS | CLOSED |
| H-03 candidate could describe itself as promotable | manifest could self-grant authority | Kernel-owned signed promotion certificate binds organism identity, module, manifest, package policy, allowed actions/inputs/outputs and R11 status | CLOSED |
| H-04 frame hash mistaken for frame authorship | forged self-consistent modulation frame could be accepted | consumer validation now requires trusted organism lineage plus Kernel-authenticated SNTSS core/version/instance/authority metadata; self-hash alone is insufficient | CLOSED |
| H-05 generic publisher could spoof producer provenance | internal caller could claim authoritative source fields | generic Kernel publish rejects reserved provenance; authoritative CoreHost fields are Kernel stamped | CLOSED |
| H-06 forensic segment rotation reused indices/broke chain | long-lived audit trail could become unverifiable | global monotonic segment high-water/retained anchor chain implemented and regression tested past retention capacity | CLOSED |
| H-07 required consumer could pin ledger indefinitely | hostile/stalled core could force unbounded Kernel storage | retention debt is bounded; offending required consumer is quarantined/demoted and cannot silently reactivate without explicit biological resynchronization | CLOSED |

## Additional findings discovered during the re-audit

### Worker inherited child-process authority

The trusted CoreHost supervisor legitimately needs child-process permission to launch bubblewrap. The first R10.5 implementation propagated that permission into the hostile worker as well. Bubblewrap still constrained the worker, but the permission unnecessarily enlarged the in-namespace executable attack surface.

Closure: only the trusted supervisor retains child-process permission. The candidate worker receives no process-spawn authority. Regression: `R10.5-16`.

### Trust-bootstrap circularity

A repository-provided installer cannot itself be the initial root of trust. If the checkout were already malicious, running that installer with sudo would recreate C-01 one level earlier.

Closure: the repository installer is now explicitly second-stage only. The host must first use system OpenSSL/SHA256 tools to verify an independently recorded release-authority public-key fingerprint and detached Ed25519 signature over the exact bootstrap manifest. Only then may the authenticated second-stage installer receive root. Regression: `R10.5-17`.

### Modulation-frame source authenticity

R6 originally authenticated integrity, target, profile, expiry and epoch but not the actual authoritative SNTSS implementation instance. A self-consistent forged frame could therefore satisfy the frame-local checks.

Closure: `validateFrameForConsumer` now requires both a consumer-local trusted authority expectation and Kernel-authenticated delivery metadata. It verifies expected organism lineage, authority epoch, SNTSS version and exact SNTSS instance ID. Missing trust context, wrong source core, forged instance, wrong lineage or stale epoch fail closed. R6 evidence and the SNTSS package-policy hash were re-attested.

## Residual medium findings

### M-01 privileged runtime status is topology-protected, not application-authenticated

`/runtime/status` is loopback-bound in production and `/runtime/*` is denied by nginx, so there is no current public control path. A future defense-in-depth improvement should require an application-layer operator capability/token as well, so a reverse-proxy mistake cannot expose the detailed status surface.

R11 action: add authenticated operator status or move privileged status to a local Unix-socket/operator channel.

### M-02 standby rollback has no explicit post-authorization revocation registry

Rollback preserves forward biological state and increments authority again, which is correct. However, a standby that was valid when created but later declared known-bad needs an explicit durable revocation record so emergency rollback cannot resurrect it.

There is no public rollback endpoint and pre-R11 SNTSS output remains forbidden, so this is not a current takeover path.

R11 action: frozen-candidate revocation table keyed by package/module hash and implementation instance, checked before standby reactivation.

### M-03 external forensic anchor is implemented but not independently configured

The R9 plane supports an `anchorSink`, and local chain rotation is monotonic. Production tamper resistance still requires the anchor head to be retained outside the same mutable storage domain.

R11 action: configure and prove an independently retained anchor sink; failure degrades observability only and must never alter chemistry.

## Host/certification evidence still required

Repository proofs cannot substitute for these physical/environmental checks:

1. Finish and independently review the R8 24-hour host endurance evidence.
2. Execute the out-of-band trusted-boundary bootstrap ceremony on a non-live certification host and record the independent key fingerprint/signature evidence.
3. Run malicious worker probes inside the real bubblewrap namespace and prove no StateStore, network, host PID, writable release, privilege-escalation or process-spawn escape.
4. Rehearse the signed R10 release path on an isolated production-host replica, including failed cutover and preserve-forward-state rollback.

These are **certification blockers**, not permission to test destructively against the live organism.

## R11 entrance rule

R11 may begin only after the repository candidate remains green and the R8 dependency is resolved. Formal R11 acceptance additionally requires the host/certification evidence above and closure or explicit blocking treatment of every residual medium item.

No R11 result may authorize live chemistry. The first live SNTSS step remains the separately gated neutral installation stage.
