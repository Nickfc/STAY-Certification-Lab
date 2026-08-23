# R11 Certification Operator Runbook

This runbook exists so R11 is executed as explicit gates rather than as an informal test session.

## Phase 0 — keep R11 blocked

While R8 endurance or any R10.5 host-certification dependency remains unresolved, do not freeze a candidate and do not run destructive probes against the live organism. Repository regression work may continue, but it is not certification evidence for host-only boundaries.

Run `node scripts/sntss-r11-certification-status.js` to produce the current blocker inventory. A non-zero exit while blockers exist is expected and correct.

The R11 host harness may be inspected in plan mode with `npm run plan:sntss-r11-host`. **Do not execute the host harness while an R8 endurance unit is active.** The harness itself refuses that overlap.

## Phase 1 — entrance evidence review

Collect and independently review:

- accepted R8 24-hour endurance artifact;
- out-of-band trusted-boundary bootstrap transcript and independently recorded public-key fingerprint;
- malicious bubblewrap namespace probe transcript;
- signed R10 release/cutover/rollback rehearsal transcript from a production-host replica, not the live organism;
- closure evidence for M-01, M-02 and M-03.

Do not convert a blocker to PASS merely because implementation contains the intended control. Required evidence must exist.

Use `docs/sntss/R11_HOST_CERTIFICATION_HARNESS.md` as the host-probe contract. Host execution is unprivileged, lab-root constrained, commit-bound and evidence-producing. Root-required trust establishment remains a separate externally verified ceremony.

## Phase 2 — candidate stabilization before freeze

Run the non-duration R11 host probes. If any probe produces a runtime-bearing fix, create a new candidate SHA and repeat affected repository/host evidence.

When the candidate stops changing, run a **second 24-hour exact-candidate endurance/pressure drill**. The earlier R8 artifact remains entrance proof for R8; it cannot by itself certify R11-Q after later sandbox/runtime changes.

Only after this exact-candidate endurance evidence and its independent review are accepted may the candidate proceed to freeze.

## Phase 3 — freeze candidate

Record one exact Git SHA and all freeze-inventory digests from `R11_CERTIFICATION_MATRIX.json`. After this point, any runtime-bearing source change invalidates the freeze. Create a new candidate SHA instead of amending evidence around changed code.

## Phase 4 — execute domains R11-A through R11-Q

For every domain:

1. run its executable hostile/regression suite against the exact frozen SHA;
2. collect the required evidence classes;
3. where `hostEvidence` is true, run only on the isolated certification host/production-host replica;
4. record PASS only when every required artifact is present and independently reviewable;
5. if a new Critical or High issue is found, invalidate the freeze, fix it outside certification, create a new candidate and restart affected certification.

## Phase 5 — full-suite closure

Run the entire repository regression suite on the exact frozen SHA after all domain-specific probes. No ignored failures, skipped security tests or evidence-hash mismatches are permitted.

## Phase 6 — independent acceptance

A reviewer must verify:

- exact frozen SHA and package/release digests;
- all 17 domains PASS;
- required host evidence exists;
- M-01, M-02 and M-03 are closed;
- zero open Critical/High and zero unexplained Medium findings;
- external forensic anchor evidence is retained outside the mutable StateStore domain;
- acceptance output remains `CERTIFIED_NEUTRAL_CAPABLE_CANDIDATE_ONLY`.

## Stop conditions

Immediately stop certification and return to engineering if any test shows dual authority, biological rewind, untrusted root execution, StateStore access from the hostile worker, sandbox escape, unauthenticated frame acceptance, provenance spoofing, unbounded resource growth, forensic-chain ambiguity, or any route from observer failure into chemistry control.

None of these stop conditions authorizes experimentation against the live organism.
