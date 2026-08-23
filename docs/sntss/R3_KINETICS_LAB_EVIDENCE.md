# R3 Deterministic Kinetics Laboratory Evidence

Status: numerical substrate candidate; chemistry is not wired into the SNTSS CoreHost

## Contract implemented

- Canonical scale `1,000,000` and integer-millisecond model time.
- Checked BigInt intermediates with canonical truncation-toward-zero division.
- 250 ms integration quantum and retained sub-quantum remainder.
- Precursor recovery, bounded synthesis, reserve conservation, bounded release, suppression, concentration decay, receptor occupancy, exposure/tolerance, opponent adaptation and refractory recovery.
- Sorted saturating combination of signed drives.
- Deterministic exponentiation-by-squaring for long quiet downtime.
- Active spans beyond 4,096 quanta fail closed instead of iterating an unbounded interval.

## Passing evidence

- 20,000 seeded hostile randomized transitions remain finite and bounded.
- Release never exceeds reserve; synthesis never exceeds available precursor; reserve and precursor equations reconcile exactly.
- Repeated equal evidence develops acquired exposure and a smaller late marginal release.
- 365 days of quiet analytical time emits no release and converges concentration, exposure, opponent and refractory state safely.
- Exposure and opponent adaptation track activation above tonic occupancy, so baseline chemistry does not create false tolerance during short quiet intervals.
- Identical checkpoint/time/drive inputs reproduce golden SHA-256 `069227dfbb97151b0022415b9490705d5177cc307f95b43846d55731f86cf65a`.
- Invalid numerics, overflow, missing profiles, invalid clocks and unbounded active downtime fail closed.

## Deliberate boundary

`cores/sntss/v0.1.0/index.js` remains an inert laboratory skeleton. The engine is not invoked by live events, no transmitter families are active, and no receptor frame can be emitted.

## R3 exit work still required

- Cross-platform golden-hash confirmation on every supported production platform.
- Accelerated 30-day active/mixed baseline and larger seeded corpus.
- Parameter-independent property generation beyond the provisional laboratory profile.
- Independent numerical review and evidence bundle pinned to the eventual production candidate.
