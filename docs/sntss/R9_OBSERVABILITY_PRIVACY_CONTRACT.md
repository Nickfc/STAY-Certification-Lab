# SNTSS R9 Observability, Privacy and Forensic Contract

## Purpose and boundary

R9 makes SNTSS explainable without turning observation into authority. The observer is downstream of chemistry. It may receive transition metadata and hashes; it has no API that can command, dose, stimulate, mutate, roll back or otherwise influence SNTSS. Failure of every R9 surface must therefore degrade observability only.

This is a repository/laboratory candidate. It does not install SNTSS into the live organism, enable chemistry, connect production semantic inputs or create a production telemetry endpoint.

## Three distinct surfaces

### Public summary

`stay-sntss-public-summary-v1` is an ephemeral bounded snapshot. It contains only coarse observability state and aggregate transition counters. It does not contain event IDs, topics, reason codes, profile hashes, checkpoint hashes, chain heads, transmitter values, receptor values, state hashes, dream/memory/message content or any raw stimulus payload. Serialized output is bounded to 2 KiB.

Public history is not retained by R9. A UI may render the latest snapshot but must not infer or reconstruct hidden state from a private forensic feed.

### Operator health and alerts

`stay-sntss-operator-health-v1` is a routine diagnostic surface. It may contain the current forensic head hash, candidate/profile identity, last status/reason code, bounded retention counters and observer failure alerts. It deliberately omits event IDs, topics, before/after state hashes, frame IDs and raw payload/state values. Serialized output is bounded to 8 KiB.

Routine operator access does not imply forensic access.

### Forensic transition records

`stay-sntss-forensic-record-v1` is access-controlled and schema-whitelisted. A record may contain accepted/rejected input IDs, sequence/topic, reason code, before/after state hashes, clamp IDs, circuit-change IDs, migration IDs, emitted frame IDs, evidence cursor, profile hash, candidate version, checkpoint hash and audit-head hash.

The record constructor rejects unknown top-level or input fields before hashing. Raw payloads, privileged messages, dream content, memory content and raw internal state are not redacted after storage; they are refused before a forensic record can exist.

## Cryptographic chain

Each forensic record contains `previousRecordHash` and a segment `chainAnchorHash`. The record hash is SHA-256 over canonical JSON excluding only `recordHash`. The first retained record is anchored to the current checkpoint/audit head. Rotation emits a hash-attested segment manifest containing its anchor, head, first/last sequence and record count; the next segment begins from the preceding head.

Verification fails on content alteration, sequence gaps, reorder, anchor/head mismatch, segment omission, candidate mismatch or profile mismatch. Expected head and count may be supplied by an external evidence index to detect truncation at the tail.

## Retention, rotation and redaction

The in-process candidate keeps at most 4,096 forensic records in the current segment and at most 128 segment manifests. Production persistence must retain sanitized forensic segments for 90 days by default, while preserving segment manifests and checkpoint/audit anchors for at least one year or the governing incident-retention period, whichever is longer. Rotation may remove a sanitized segment only after its manifest/head is durably retained and independently verifiable.

Any future payload exception requires a new schema, explicit privacy review, separate access capability and a new promotion gate. R9 v1 has no payload exception.

## Failure semantics

`capture()` is an observation operation, not a chemistry transaction. Invalid telemetry is counted and dropped. An optional telemetry sink may fail synchronously or asynchronously; the observer records the failure but does not throw a state-control exception back into SNTSS. The Kernel and chemistry path must never wait for telemetry durability to make a biological safety decision.

Required alerts are `SNTSS_TELEMETRY_DROPPED` and `SNTSS_TELEMETRY_SINK_FAILED`. A forensic chain verification failure is a reviewer/incident blocker, not a command to alter chemistry.

## Access rule

Forensic readout requires the exact capability `sntss.forensic.read`. This code-level capability is a contract marker, not a complete production authentication system. R10/R12 deployment surfaces must map it to authenticated operator/reviewer roles without exposing it publicly.

## R9 closure boundary

R9 candidate closure requires the privacy suite, deterministic replay/tamper corpus, bounded-surface tests, optional-sink failure test and evidence bundle to pass from one pinned tree. Formal R9 acceptance remains downstream of R8 acceptance and independent review. No R9 artifact may be used as justification to cross the R8 gate early.
