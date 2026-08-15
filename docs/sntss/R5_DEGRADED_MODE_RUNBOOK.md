# SNTSS R5 Degraded-Mode Runbook

Status: laboratory procedure; no production activation authorized

## Invariants

- Missing, late, contradictory, quarantined, or unverifiable producers create no new phasic release.
- The boundary never substitutes, infers, or fabricates semantic meaning.
- Durable rejected sequences advance the laboratory cursor with a stable reason and trace; exact replays do not mutate state.
- Producer downtime does not manufacture events, reset exposure counts, or erase habituation. Recovery is calculated from trusted elapsed time.
- A breaker that reaches its recovery interval requires one fully verified zero-drive probe before closing.

## Operator response

| Observed status | Boundary behavior | Required action |
| --- | --- | --- |
| `missing` | degraded, `{}` drives | restore the registered producer; do not backfill invented history |
| `late` | degraded, `{}` drives | verify trusted clock and producer health; resume with current facts only |
| `quarantined` | breaker blocks, `{}` drives | investigate the stable reason code and provenance chain |
| `SNTSS_EVIDENCE_CONTRADICTION` | source breaker opens | reconcile upstream evidence; never choose a preferred claim inside SNTSS |
| `SNTSS_AUTHORITY_STALE` or forged provenance | source breaker opens | repair authority/cutover state before sending a probe |
| recovery interval elapsed | next valid fact is a probe | verify that the probe returns no drive and closes the breaker |

## Evidence to retain

Retain the input envelope hash, ancestry hash, reason code, prior trace hash, decision trace hash, state cursor, source authority record, and relevant upstream evidence verification. Payload content is not copied into the R5 causal trace.

Escalate any non-empty degraded drive, accepted circular chain, accepted chemical command, silent durable drop, or fabricated history as an automatic R5 gate failure.
