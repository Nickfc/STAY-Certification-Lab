# SNTSS R9 Reviewer Access Runbook

## Roles

Public viewers receive only the bounded public summary. Routine operators receive the operator-health surface. Forensic reviewers receive sanitized records only after authenticated authorization mapped to `sntss.forensic.read`.

## Reviewer package

Provide the pinned source commit, R9 schemas, R9 test inventory, R9 evidence JSON, trusted checkpoint/audit anchor, expected forensic head/count, candidate version and profile hash. Do not include production secrets, raw privileged messages, raw dream/memory content or unrestricted StateStore copies.

## Handling

Forensic exports are read-only evidence. A reviewer may verify, copy and annotate them but must not modify the canonical evidence set. Any redaction for external sharing produces a new derivative artifact with its own hash and must never replace the canonical sanitized record chain.

## Incident rule

Chain break, unexplained transition, private-field leak or evidence/candidate mismatch blocks R9 acceptance. Telemetry outage alone is an observability incident and must not trigger chemistry mutation, StateStore surgery or a Kernel safety bypass.
