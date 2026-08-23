# R4 SNTSS Calibration Notebook

Status: automated laboratory evidence passing; R4 candidate is not production-authorized

Reproduction command: `npm run evidence:sntss-r4`

Pinned profile: `sha256:0b80dcefd6a7862ac357aadee583fb90bf5aea2048c33a92b30ee318798f7001`

Golden scenario: `fdedc30f270628768681c3ef685376aa71bd4cfdff1bd10361d8332467bff16d`

Evidence bundle: `sha256:3e58b7604f24f0f5e31f59f68248b99f10ef85f07071a702b5f32b4833f0bcd6`

Machine-readable evidence: `docs/sntss/evidence/R4_CALIBRATION_EVIDENCE.json`. It pins the profile, every family, the numerical/interaction modules and the species-profile schema, so modified code cannot reuse the evidence hash.

## Method

The calibration runner constructs a fresh laboratory model from the pinned species profile. It never reads organism state. Every scenario uses the 250 ms deterministic integrator and fixed-point arithmetic. The sensitivity sweep executes each active family independently at nine fixed drives from -1,000,000 to +1,000,000 for 128 quanta. A second 400-quantum exposure run measures early versus late release. All eight families are present in the model, but the two dormant families use the inert profile and are rejected at simulator, stimulus and receptor guards.

## Named scenario results

| Scenario | Result | Interpretation |
| --- | --- | --- |
| Baseline | All six active concentrations returned to tonic baseline after 24 quiet hours | Quiet convergence passes |
| Positive prediction | Dopamine-like release 19,200; concentration 199,200 from baseline 180,000 | Positive response passes |
| Negative prediction | Release 0; concentration 170,400 | Suppression is bounded and opposite |
| Uncertainty/vigilance | Noradrenaline-like release 24,000 | Fast vigilance lane responds |
| Attention | Base 400,000; moderate NE 472,000; high NE 172,500 | Moderate support and high narrowing both pass |
| Excitation/inhibition | Glutamate input 800,000 with GABA 600,000 yields excitation 200,000 and balance -400,000 | Inhibition bounds excitation without forcing zero |
| Serotonin damping | Dopamine-like input 900,000 is bounded to 732,000 with serotonin-like 800,000 | Extreme gain is reduced, not deleted |
| Depletion | Every active family ends below its birth reserve after sustained drive | Reserve economics passes |
| Desensitization/tolerance | Every active family develops nonzero exposure and lower late release | Diminishing repeated response passes |
| Rebound | Minimum dopamine-like withdrawal effect -119,490 | Opponent response is present and bounded |
| Recovery | After 30 quiet days: concentration=baseline, exposure=0, opponent=0, readiness=1,000,000, reserve=1,000,000 | Analytical recovery passes |

## Sensitivity findings

- All 54 family/drive sweep endpoints were canonical integers inside `0..1,000,000`.
- All cross-family readouts remained inside the signed fixed-point range.
- Zero drive at tonic baseline produces zero exposure, zero opponent load and zero relative effect; negative drive produces suppression without release or negative concentration.
- Sustained high positive drive intentionally entered a depletion/tolerance region rather than maintaining an unbounded high concentration.
- Several terminal relative effects become negative under sustained drive because opponent load outlives the acute concentration excursion. This is the designed rebound mechanism, not an arithmetic underflow.
- The full signed drive range is numerically stable, but this does not declare the entire range biologically suitable. R5 source policies must impose smaller dose/rate/cooldown limits before authoritative events exist.

## Dormancy proof

For both endogenous-opioid-like and oxytocin-like families:

- simulator stimulus-family selection rejects with `SNTSS_FAMILY_DORMANT`;
- laboratory receptor-family selection rejects with `SNTSS_FAMILY_DORMANT`;
- drive-map validation rejects even a well-formed maximum drive;
- a migrated nonzero state is rejected;
- a deliberately bypassed low-level replay of 4,096 maximum-drive quanta produces exactly zero precursor, reserve, concentration, baseline, exposure, opponent, readiness, release and relative effect;
- a maliciously rehashed profile that adds dormant synthesis is rejected by semantic dormancy validation.

## Exit assessment

The automated R4 implementation gate passes for profile completeness, determinism, numerical stability, named scenarios, interaction bounds and hard dormancy. R4 remains a candidate because the profile has not received independent biological/numerical review, longer accelerated mixed-pattern endurance is not yet pinned, and Gate Zero is not fully certified. The CoreHost package remains chemically inert with no outputs; R5, R6 and R7 remain separate gates.
