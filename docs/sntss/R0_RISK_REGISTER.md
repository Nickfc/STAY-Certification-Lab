# SNTSS R0 Risk Register

| ID | Risk | Severity | Containment or required evidence | Owner | State |
| --- | --- | --- | --- | --- | --- |
| RISK-G0-01 | Core mutates after an event but crashes before durable progress | Critical | checkpoint and consumer acknowledgement in one StateStore transaction; kill uncommitted CoreHost and replay | Runtime | Candidate control implemented |
| RISK-G0-02 | Downstream output commits while producer commit fails | Critical | deterministic per-cause output key; content-conflict rejection; replay must reuse existing output envelope | Runtime | Initial proof passing |
| RISK-G0-03 | Event sequence survives but envelope is lost | Critical | append full envelope and hashes in the same transaction that advances sequence | StateStore | Implemented |
| RISK-G0-04 | Later delivery advances a cursor past an earlier unacknowledged event | Critical | cursor advances only to the last acknowledged event before the first pending delivery | StateStore | Implemented; out-of-order test pending |
| RISK-G0-05 | Ledger grows without bound | High | retain until every required consumer crosses, then bounded reviewed pruning and backup evidence | Operations | Not yet implemented; no deletion currently occurs |
| RISK-G0-06 | Deduplication key is reused with different content | High | fail closed with `EVENT_DEDUP_CONFLICT` | Event Fabric | Implemented |
| RISK-G0-07 | New consumer receives fabricated pre-registration history | High | initial cursor starts at current ledger high-water; genesis records the actual start boundary | Runtime/SNTSS | Implemented for core registration |
| RISK-STATE-01 | Rollback rewinds acquired chemistry | Critical | forward authoritative state and backward projection; never restore old biological state | SNTSS/Release | Blocked until R7/R10 |
| RISK-IDENT-01 | Organism binding changes after first acceptance | Critical | one-time hash-verified binding; later mismatch fatal | SNTSS neutral | R2 work |
| RISK-AUTH-01 | Candidate or stale epoch emits authoritative output | Critical | existing authority epoch/cutover checks plus deterministic output provenance | Kernel | Existing coverage; Gate Zero regression required |
| RISK-RES-01 | Ledger/checkpoint frequency causes I/O or state growth pressure | High | resource and latency budgets; batch/endurance tests; no production promotion without headroom | Runtime/Operations | R7/R11 evidence pending |
| RISK-PRIV-01 | Durable envelopes leak private content | High | bounded semantic payloads and hashed evidence; access-controlled forensic plane | Producers/R9 | Schema boundary pending R5/R9 |
| RISK-PROD-01 | Repository candidate differs from live Lightsail release | Critical | compare immutable archive/source/provenance digest before R10/R12 | Operator/Release | Open production blocker |
| RISK-FAM-01 | An undocumented or operator-mutated family profile changes chemistry | Critical | exact schema, immutable family objects, per-family and bundle hashes, no caller-supplied policy | SNTSS/R4 | Candidate control passing; independent review pending |
| RISK-FAM-02 | Dormant opioid-like or oxytocin-like chemistry becomes reachable | Critical | zero production producers, blocked family guards, exact inert kinetics, zero-state migration guard and bypass replay proof | SNTSS/R4 | Candidate control passing |
| RISK-FAM-03 | Cross-family feedback creates runaway release | Critical | interactions consume post-kinetic effects only and cannot create release drives; all readouts bounded | SNTSS/R4 | Candidate control passing; extended mixed endurance pending |
