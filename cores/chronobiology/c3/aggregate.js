'use strict';

const { PROFILE } = require('./calibration-profile');
const {
  Q30_ONE,
  Q31_ONE,
  clamp,
  cosQ30,
  integerSqrt,
  multiplyQ31,
  phaseFromVectorQ30,
  roundDivide,
  sinQ30,
} = require('./fixed-point');

function deriveAggregate(state) {
  let vectorX = 0n;
  let vectorY = 0n;
  let totalAmplitude = 0n;

  for (const oscillator of state.acquired.oscillators) {
    const amplitude = BigInt(oscillator.amplitude_q);
    vectorX += roundDivide(
      BigInt(cosQ30(oscillator.phase_q)) * amplitude,
      BigInt(Q30_ONE),
    );
    vectorY += roundDivide(
      BigInt(sinQ30(oscillator.phase_q)) * amplitude,
      BigInt(Q30_ONE),
    );
    totalAmplitude += amplitude;
  }

  const count = BigInt(state.phenotype.oscillator_count);
  const magnitude = integerSqrt(vectorX * vectorX + vectorY * vectorY);
  const coherenceQ31 = totalAmplitude === 0n
    ? 0
    : clamp(Number(roundDivide(magnitude * BigInt(Q31_ONE), totalAmplitude)), 0, Q31_ONE);
  const rhythmAmplitudeQ31 = Number(roundDivide(totalAmplitude, count));
  const phaseResolvabilityQ31 = multiplyQ31(coherenceQ31, rhythmAmplitudeQ31);
  const resolved = phaseResolvabilityQ31 >= PROFILE.phaseResolvableMinimumQ31;
  const centralPhaseQ = resolved
    ? phaseFromVectorQ30(vectorX, vectorY)
    : null;

  let weightedPeriod = 0n;
  for (let unitId = 0; unitId < state.phenotype.oscillator_count; unitId += 1) {
    weightedPeriod += BigInt(state.phenotype.oscillators[unitId].intrinsic_period_us)
      * BigInt(state.acquired.oscillators[unitId].amplitude_q);
  }
  const effectivePeriodUs = resolved && totalAmplitude > 0n
    ? Number(roundDivide(weightedPeriod, totalAmplitude))
    : null;

  return Object.freeze({
    central_phase_q: centralPhaseQ,
    phase_resolvability_q: phaseResolvabilityQ31,
    effective_period_us: effectivePeriodUs,
    oscillator_coherence_q: coherenceQ31,
    rhythm_amplitude_q: rhythmAmplitudeQ31,
    entrainment_strength_q: 0,
    cue_coverage_q: state.acquired.cue_coverage_q,
    alignment_stability_q: state.acquired.alignment_summary.stability_q,
    phase_velocity_q: null,
    evidence_quality: 'UNCERTAIN',
    model_version: state.phenotype.model_version,
    calibration_profile_id: state.phenotype.calibration_profile_id,
  });
}

module.exports = { deriveAggregate };
