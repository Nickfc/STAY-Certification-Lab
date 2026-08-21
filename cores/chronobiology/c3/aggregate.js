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
  signedPhaseDifference,
} = require('./fixed-point');

const DAY_US = 86_400_000_000n;
const FULL_TURN_Q = 0x1_0000_0000n;

function rawAggregate(state) {
  let vectorX = 0n;
  let vectorY = 0n;
  let totalAmplitude = 0n;

  for (const oscillator of state.acquired.oscillators) {
    const amplitude = BigInt(oscillator.amplitude_q);
    vectorX += roundDivide(BigInt(cosQ30(oscillator.phase_q)) * amplitude, BigInt(Q30_ONE));
    vectorY += roundDivide(BigInt(sinQ30(oscillator.phase_q)) * amplitude, BigInt(Q30_ONE));
    totalAmplitude += amplitude;
  }

  const count = BigInt(state.phenotype.oscillator_count);
  const magnitude = integerSqrt(vectorX * vectorX + vectorY * vectorY);
  const coherenceQ31 = totalAmplitude === 0n
    ? 0
    : clamp(Number(roundDivide(magnitude * BigInt(Q31_ONE), totalAmplitude)), 0, Q31_ONE);
  const rhythmAmplitudeQ31 = Number(roundDivide(totalAmplitude, count));
  const phaseResolvabilityQ31 = multiplyQ31(coherenceQ31, rhythmAmplitudeQ31);
  const history = state.acquired.aggregate_phase_history ?? [];
  const previouslyResolved = history.length > 0 && history.at(-1).resolved;
  const threshold = previouslyResolved
    ? PROFILE.phaseResolvableExitQ31
    : PROFILE.phaseResolvableEnterQ31;
  const resolved = phaseResolvabilityQ31 >= threshold;

  return Object.freeze({
    centralPhaseQ: resolved ? phaseFromVectorQ30(vectorX, vectorY) : null,
    coherenceQ31,
    phaseResolvabilityQ31,
    resolved,
    rhythmAmplitudeQ31,
  });
}

function phaseEstimator(history) {
  let elapsedUs = 0n;
  let progressionQ = 0n;
  let intervals = 0;
  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1];
    const current = history[index];
    const intervalUs = current.trusted_time_us - previous.trusted_time_us;
    if (!previous.resolved || !current.resolved
      || previous.central_phase_q === null || current.central_phase_q === null
      || intervalUs <= 0 || intervalUs > PROFILE.aggregateEstimatorMaximumIntervalUs) {
      continue;
    }
    elapsedUs += BigInt(intervalUs);
    progressionQ += BigInt(signedPhaseDifference(
      current.central_phase_q,
      previous.central_phase_q,
    ));
    intervals += 1;
  }
  if (intervals < PROFILE.aggregateEstimatorMinimumObservations - 1
    || elapsedUs <= 0n || progressionQ <= 0n) {
    return Object.freeze({ effectivePeriodUs: null, phaseVelocityQ: null });
  }
  return Object.freeze({
    effectivePeriodUs: Number(roundDivide(elapsedUs * FULL_TURN_Q, progressionQ)),
    // Phase-Q units progressed per trusted organism day.
    phaseVelocityQ: Number(roundDivide(progressionQ * DAY_US, elapsedUs)),
  });
}

function appendAggregateObservation(state, trustedTimeUs) {
  if (!Number.isSafeInteger(trustedTimeUs) || trustedTimeUs < 0) {
    throw Object.assign(new Error('aggregate observation frontier is invalid'), {
      code: 'CHRONOBIOLOGY_AGGREGATE_INVALID',
    });
  }
  const aggregate = rawAggregate(state);
  const history = state.acquired.aggregate_phase_history ?? [];
  if (history.length > 0 && history.at(-1).trusted_time_us >= trustedTimeUs) {
    if (history.at(-1).trusted_time_us === trustedTimeUs) return state;
    throw Object.assign(new Error('aggregate observation frontier rewound'), {
      code: 'CHRONOBIOLOGY_AGGREGATE_REWIND',
    });
  }
  const observation = Object.freeze({
    trusted_time_us: trustedTimeUs,
    central_phase_q: aggregate.centralPhaseQ,
    phase_resolvability_q: aggregate.phaseResolvabilityQ31,
    resolved: aggregate.resolved,
  });
  return Object.freeze({
    ...state,
    acquired: Object.freeze({
      ...state.acquired,
      aggregate_phase_history: Object.freeze([...history, observation]
        .slice(-PROFILE.aggregateHistoryCapacity)),
    }),
  });
}

function deriveAggregate(state) {
  const raw = rawAggregate(state);
  const estimate = phaseEstimator(state.acquired.aggregate_phase_history ?? []);

  return Object.freeze({
    central_phase_q: raw.centralPhaseQ,
    phase_resolvability_q: raw.phaseResolvabilityQ31,
    effective_period_us: raw.resolved ? estimate.effectivePeriodUs : null,
    oscillator_coherence_q: raw.coherenceQ31,
    rhythm_amplitude_q: raw.rhythmAmplitudeQ31,
    entrainment_strength_q: state.acquired.phase_lock_summary.strength_q,
    cue_coverage_q: state.acquired.cue_coverage_q,
    alignment_stability_q: state.acquired.alignment_summary.stability_q,
    phase_velocity_q: raw.resolved ? estimate.phaseVelocityQ : null,
    evidence_quality: state.continuity
      ? !state.continuity.photic_route_configured
        ? 'UNCERTAIN'
        : state.acquired.evidence_gap_summary.gap_count > 0
          || state.acquired.cue_coverage_q === 0
          ? 'DEGRADED'
          : 'TRUSTED'
      : state.acquired.cue_coverage_q > 0
        ? 'TRUSTED'
        : 'UNCERTAIN',
    model_version: state.phenotype.model_version,
    calibration_profile_id: state.phenotype.calibration_profile_id,
  });
}

module.exports = { appendAggregateObservation, deriveAggregate, phaseEstimator, rawAggregate };
