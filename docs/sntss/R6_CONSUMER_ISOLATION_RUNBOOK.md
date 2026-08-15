# SNTSS R6 Consumer Isolation Runbook

Status: laboratory procedure; no live delivery authorized

| Condition | R6 behavior | Operator response |
| --- | --- | --- |
| Missing lease | no frame | verify trusted runtime registration; do not create a consumer dynamically |
| Expired lease/frame | reject, neutral fallback | grant a new bounded lease through runtime authority |
| Disconnected consumer | clear its derived queue; preserve receptor history | repair consumer independently |
| Queue pressure | discard only that consumer's oldest expired/derived frame | inspect consumer delay; other consumers continue |
| Repeated pressure | open only that consumer breaker | isolate consumer and retain evidence |
| Profile mismatch | reject | restore the pinned profile or perform a separately reviewed migration |
| Recovery | bounded resynchronization frame | confirm no backlog impulse and current authority/profile |
| Consumer removal | population becomes dormant | retain for rollback; never delete acquired history silently |

A hostile or failed consumer has no API to select chemistry, renew its own authority, extend frame validity, write receptor parameters, acknowledge physiological history, change another queue, or modify Kernel, fetus, StateStore, identity, deployment, safety, or resource state.

Automatic R6 failure conditions are untargeted delivery, acceptance after expiry, unbounded efficacy/effect, reverse control, cross-consumer state change, history reset on rollback, or any consumer failure that changes foundation health.
