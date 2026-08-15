# R4 SNTSS Family Profile Register

Status: deterministic laboratory candidate; independent biological review and production approval are absent

Profile ID: `stay-genesis-sntss-family-set`, revision 1

Profile hash: `sha256:0b80dcefd6a7862ac357aadee583fb90bf5aea2048c33a92b30ee318798f7001`

Numerical contract: dimensionless fixed-point fractions use `0..1,000,000`; signed drives and effects use `-1,000,000..1,000,000`; one kinetic quantum is 250 ms. There is no live slider, environment variable, API, or operator mutation path. Any profile change produces a different family hash and bundle hash and invalidates the evidence.

## Family boundary

| Family | R4 modeled role | Explicit non-claim | State |
| --- | --- | --- | --- |
| Dopamine-like | Prediction error, motivational salience, action vigor, learning sensitivity | Not pleasure or happiness | Laboratory active |
| Serotonin-like | Long-horizon stability, patience, persistence, restraint | Not happiness | Laboratory active |
| Noradrenaline-like | Arousal, uncertainty, vigilance, interrupt priority | Not fear | Laboratory active |
| Acetylcholine-like | Attention, sensory gain, encoding, plasticity | Not intelligence | Laboratory active |
| Glutamate-like | Excitatory tone and association readiness | Never unbounded excitation | Laboratory active |
| GABA-like | Inhibitory balance and runaway-activity protection | Not forced inactivity | Laboratory active |
| Endogenous-opioid-like | Future relief, recovery, pain-influence modulation | Cannot erase damage or pain evidence | Dormant and inert |
| Oxytocin-like | Future familiarity, attachment, social-safety modulation | Cannot grant trust or obedience | Dormant and inert |

All eight families have zero production producers and `productionActivationEnabled: false`. The six active families are enabled only through the R4 simulator guard. The two dormant families additionally have zero precursor, reserve, concentration, synthesis, recovery, release, suppression, exposure adaptation, opponent building and refractory recovery.

## Kinetic parameter contract

| Parameter | Unit and permitted range | Calibration rationale | Primary sensitivity | Failure behavior |
| --- | --- | --- | --- | --- |
| `synthCap` | fraction of reserve deficit per quantum, `0..1,000,000` | Caps conversion of available precursor into reserve | Higher values sustain repeated release longer | Non-integer/out-of-range rejects; dormant must be 0 |
| `precursorRecovery` | fixed-point amount per quantum, `0..1,000,000` | Bounds replenishment from the external precursor abstraction | Higher values shorten depletion recovery | Reject; dormant must be 0 |
| `reserveRetention` | retained fraction per quiet quantum, `0..1,000,000` | Controls analytical quiet-time reserve approach | Values nearer 1 slow recovery | Reject; dormant fixed at 1,000,000 so zero reserve stays zero |
| `maxReleasePerStep` | reserve fraction per quantum, `0..1,000,000` | Hard release ceiling | Dominant acute peak/depletion control | Reject; release remains reserve-constrained; dormant must be 0 |
| `maxSuppressionPerStep` | concentration amount per quantum, `0..1,000,000` | Bounds negative-drive suppression | Higher values deepen negative response | Reject; concentration clamps at 0; dormant must be 0 |
| `concentrationRetention` | retained deviation per quantum, `0..1,000,000` | Sets circulation/clearance timescale | Nearer 1 gives slower clearance | Reject; dormant fixed at 1,000,000 with zero baseline |
| `exposureAlpha` | exposure update fraction per quantum, `0..1,000,000` | Controls acquisition of systemic exposure/desensitization state | Higher values acquire tolerance faster | Reject; dormant must be 0 |
| `exposureRetention` | quiet retained exposure fraction, `0..1,000,000` | Controls tolerance recovery | Nearer 1 retains acquired exposure longer | Reject; dormant fixed at 1,000,000 while exposure is forced zero |
| `toleranceStrength` | fractional release-gate strength, `0..1,000,000` | Converts accumulated exposure into diminished response | Higher values reduce repeated release more strongly | Reject; gate saturates in `0..1,000,000`; dormant must be 0 |
| `opponentBuildAlpha` | opponent update fraction per quantum, `0..1,000,000` | Produces slow bounded counter-adaptation | Higher values create faster rebound | Reject; dormant must be 0 |
| `opponentRetention` | quiet retained opponent fraction, `0..1,000,000` | Sets rebound recovery timescale | Nearer 1 prolongs withdrawal influence | Reject; dormant fixed at 1,000,000 while opponent is forced zero |
| `refractoryRecovery` | recovery fraction per quantum, `0..1,000,000` | Restores release readiness | Higher values shorten refractory effects | Reject; dormant must be 0 |
| `refractoryRetention` | analytical quiet retained deficit fraction, `0..1,000,000` | Controls long-downtime refractory recovery | Nearer 1 slows recovery | Reject; dormant fixed at 1,000,000 with zero readiness |
| `refractoryCost` | readiness cost per released amount, `0..1,000,000` | Couples acute release to short-term fatigue | Higher values suppress burst repetition | Reject; readiness clamps; dormant must be 0 |
| `affinity` | fixed-point half-occupancy concentration, `1..1,000,000` | Locates the saturating occupancy response | Lower values increase occupancy at a given concentration | Reject; never clamped silently |
| `hill` | integer coefficient, `1..4` | Controls occupancy curve steepness within a reviewable bound | Higher values sharpen threshold behavior | Reject outside `1..4` |

## Canonical state variables

| Key | Meaning | Range | Invalid behavior |
| --- | --- | --- | --- |
| `P` | Available precursor | `0..1,000,000` | Reject |
| `R` | Synthesized reserve | `0..1,000,000` | Reject |
| `C` | Circulating concentration | `0..1,000,000` | Reject |
| `B` | Tonic baseline | `0..1,000,000` | Reject |
| `X` | Recent systemic exposure/desensitization proxy | `0..1,000,000` | Reject |
| `O` | Opponent load | `0..1,000,000` | Reject |
| `F` | Refractory readiness | `0..1,000,000` | Reject |

Local receptor density, sensitivity and desensitization are deliberately not claimed here; their profile and persistence contract belongs to R6/R7. R4 tests only the systemic exposure/tolerance substrate already present in the common kinetics model.

## Family calibration values

### Supply, release and clearance

| Family | `synthCap` | `precursorRecovery` | `reserveRetention` | `maxRelease` | `maxSuppression` | `concentrationRetention` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Dopamine-like | 6,000 | 1,200 | 999,000 | 24,000 | 12,000 | 940,000 |
| Serotonin-like | 3,500 | 800 | 999,400 | 14,000 | 7,000 | 970,000 |
| Noradrenaline-like | 7,000 | 1,600 | 998,800 | 30,000 | 15,000 | 900,000 |
| Acetylcholine-like | 6,500 | 1,400 | 999,000 | 26,000 | 13,000 | 920,000 |
| Glutamate-like | 8,000 | 1,800 | 998,600 | 28,000 | 16,000 | 930,000 |
| GABA-like | 7,600 | 1,700 | 998,800 | 30,000 | 15,000 | 940,000 |

### Adaptation and occupancy

| Family | `exposureAlpha` | `exposureRetention` | `toleranceStrength` | `opponentBuildAlpha` | `opponentRetention` | `refractoryRecovery` | `refractoryRetention` | `refractoryCost` | `affinity` | `hill` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Dopamine-like | 18,000 | 999,200 | 650,000 | 6,000 | 999,500 | 12,000 | 992,000 | 500,000 | 380,000 | 2 |
| Serotonin-like | 10,000 | 999,600 | 480,000 | 3,000 | 999,700 | 8,000 | 995,000 | 380,000 | 430,000 | 2 |
| Noradrenaline-like | 22,000 | 998,800 | 600,000 | 7,000 | 999,200 | 15,000 | 988,000 | 540,000 | 340,000 | 2 |
| Acetylcholine-like | 16,000 | 999,100 | 520,000 | 5,000 | 999,400 | 14,000 | 990,000 | 480,000 | 360,000 | 2 |
| Glutamate-like | 18,000 | 998,900 | 560,000 | 6,000 | 999,300 | 15,000 | 989,000 | 500,000 | 350,000 | 2 |
| GABA-like | 16,000 | 999,000 | 500,000 | 5,000 | 999,400 | 15,000 | 990,000 | 460,000 | 340,000 | 2 |

The values are conservative first-pass engineering calibrations chosen to separate fast vigilance/attention dynamics from slower long-horizon stability while forcing sustained maximum drive into bounded depletion and opponent adaptation. They are not clinical, molecular or behavioral claims. Biological adequacy requires independent review and later shadow evidence.

## Interaction policy register

| Parameter | Value | Meaning and sensitivity | Failure behavior |
| --- | ---: | --- | --- |
| `gabaBrakeStrength` | 1,000,000 | Full-scale GABA-like effect can cancel, but never invert, excitatory tone | Fixed in hashed profile; output clamped |
| `noradrenalineModerateCeiling` | 550,000 | Boundary between attention support and narrowing | Fixed in hashed profile |
| `noradrenalineAttentionSupport` | 300,000 | Moderate vigilance contribution to attention gain | Saturating combination prevents overflow |
| `noradrenalineHighNarrowing` | 650,000 | Rate of attention narrowing above the ceiling | Attention floor is zero |
| `serotoninExtremeThreshold` | 600,000 | Only extreme gain excursions are damped | Values below threshold remain unchanged |
| `serotoninDampingStrength` | 700,000 | Maximum reviewed damping slope | Cannot delete semantic evidence; affects laboratory readout only |

Interactions consume post-kinetic effects and never feed release drives back into another family. The policy cannot be supplied by a caller; only the hashed revision-1 policy is accepted.

## Review and change control

This register documents the implementation candidate; it is not an approval record. Any change to a family value, role, boundary, inventory, interaction constant, hash rule, fixed-point scale or integration quantum requires a new revision, regenerated evidence, replay hash, parameter sweep and independent review.
