# SNTSS R5 Source Registry

Status: laboratory candidate; production topics disabled

Registry hash: `sha256:b3302a68d46b40cb9f20ef597d20bc51ed8b38fccd80d0a4279cbe85a2e9397f`

R5 accepts only durable, independently verified semantic facts from the registered producer and current authority epoch. Producers never select a transmitter, concentration, reward, mood, trust, or chemical state. The registry maps a bounded semantic signal to an internal fixed-point drive only after ledger, provenance, evidence, deadline, clock, and causal-chain validation.

| Topic | Producer | Semantic class | Special control |
| --- | --- | --- | --- |
| `presence.state.changed` | presence | presence state | contradiction check |
| `social.interaction.verified` | social-identity | verified social interaction | signed valence |
| `activity.phase.changed` | activity | activity phase | bounded phase vocabulary |
| `homeostasis.state.changed` | homeostasis | homeostasis state | contradiction check |
| `homeostasis.need.changed` | homeostasis | homeostasis need | bounded need class |
| `instinct.threat.assessed` | primordial-instinct | threat assessment | reduced dose/rate, cooldown |
| `instinct.drive.changed` | primordial-instinct | instinct drive | bounded drive class |
| `pain.damage.registered` | synthetic-pain | damage registration | reduced dose/rate, cooldown |
| `pain.relief.registered` | synthetic-pain | verified relief | reduced dose/rate, cooldown |
| `memory.novelty.assessed` | memory | novelty assessment | habituated scalar |
| `memory.prediction.outcome` | memory | prediction outcome | signed valence |
| `memory.familiarity.assessed` | memory | familiarity assessment | habituated scalar |
| `sensory.attention.requested` | sensory | attention priority | reduced rate |
| `dream.affect.generated` | dream | dream affect | permanent dream mark, 0.1 dose cap |

All policies are immutable, hashed, `productionEnabled: false`, and restricted to the six active R4 families. Opioid-like and oxytocin-like families remain unreachable. The runtime CoreHost manifest still subscribes only to organism binding and trusted time, publishes no outputs, and declares zero production semantic topics.

## Acceptance order

1. Exact durable envelope and ledger hashes.
2. Exact topic payload schema and absence of chemical/reward commands.
3. Current source version, instance, and authority epoch.
4. Independently verified evidence hash and trusted deadline/clock.
5. Earlier, fully verified, non-circular causal ancestry with no SNTSS descendant.
6. Replay, evidence, and claim deduplication.
7. Contradiction, rate, cooldown, habituation, and source-breaker controls.
8. Bounded internal drive derivation and hash-chained decision trace.

Any failed check produces an explicit stable reason code and an empty drive map. A breaker recovery event is consumed as a verified zero-drive probe; it cannot create a recovery impulse.
