'use strict';

const { PROFILE } = require('./calibration-profile');
const {
  Q30_ONE,
  Q31_ONE,
  clamp,
  multiplyQ30,
  multiplyQ31,
  phaseAdvance,
  roundDivide,
  signedPhaseDifference,
  sinQ30,
  wrapPhase,
} = require('./fixed-point');

const MAX_INTEGRATION_STEPS = 43_200;

function fail(message, code = 'CHRONOBIOLOGY_OSCILLATOR_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function couplingInputs(phenotype, acquired) {
  const count = phenotype.oscillator_count;
  const sums = Array.from({ length: count }, () => 0n);
  const weights = Array.from({ length: count }, () => 0n);

  for (const edge of phenotype.coupling_graph.edges) {
    const left = edge.left_unit_id;
    const right = edge.right_unit_id;
    const difference = signedPhaseDifference(
      acquired.oscillators[right].phase_q,
      acquired.oscillators[left].phase_q,
    );
    const response = multiplyQ30(sinQ30(wrapPhase(difference)), edge.weight_q30);
    sums[left] += BigInt(response);
    sums[right] -= BigInt(response);
    weights[left] += BigInt(edge.weight_q30);
    weights[right] += BigInt(edge.weight_q30);
  }

  return sums.map((sum, unitId) => {
    if (weights[unitId] === 0n) return 0;
    return Number(roundDivide(sum * BigInt(Q30_ONE), weights[unitId]));
  });
}

function stepPopulation(state, durationUs) {
  if (!Number.isSafeInteger(durationUs) || durationUs < 1
    || durationUs > PROFILE.integrationQuantumUs) {
    fail('integration quantum is invalid');
  }

  const phenotype = state.phenotype;
  const acquired = state.acquired;
  const coupling = couplingInputs(phenotype, acquired);
  const nextOscillators = phenotype.oscillators.map((founder, unitId) => {
    const current = acquired.oscillators[unitId];
    const intrinsic = phaseAdvance(founder.intrinsic_period_us, durationUs);
    const response = clamp(
      multiplyQ30(coupling[unitId], founder.coupling_sensitivity_q),
      -PROFILE.couplingResponseLimitQ30,
      PROFILE.couplingResponseLimitQ30,
    );
    const adjustment = Number(roundDivide(
      BigInt(intrinsic) * BigInt(response),
      BigInt(Q30_ONE),
    ));

    const recoveryForDuration = clamp(Number(roundDivide(
      BigInt(founder.amplitude_recovery_q) * BigInt(durationUs),
      BigInt(PROFILE.integrationQuantumUs),
    )), 0, Q31_ONE);
    const amplitudeDifference = founder.baseline_amplitude_q - current.amplitude_q;
    const amplitudeIncrement = multiplyQ31(amplitudeDifference, recoveryForDuration);

    return Object.freeze({
      unit_id: founder.unit_id,
      phase_q: wrapPhase(BigInt(current.phase_q) + BigInt(intrinsic) + BigInt(adjustment)),
      amplitude_q: clamp(current.amplitude_q + amplitudeIncrement, 0, Q31_ONE),
    });
  });

  return Object.freeze({
    ...acquired,
    oscillators: Object.freeze(nextOscillators),
  });
}

function integratePopulation(state, targetTimeUs) {
  const start = state.continuity.committed_through_us;
  if (!Number.isSafeInteger(targetTimeUs) || targetTimeUs < start) {
    fail('trusted integration frontier rewound', 'CHRONOBIOLOGY_TIME_REWIND');
  }
  const interval = targetTimeUs - start;
  const steps = Math.ceil(interval / PROFILE.integrationQuantumUs);
  if (steps > MAX_INTEGRATION_STEPS) {
    fail('trusted interval exceeds bounded integration work', 'CHRONOBIOLOGY_INTERVAL_BOUND');
  }

  let acquired = state.acquired;
  let remaining = interval;
  while (remaining > 0) {
    const duration = Math.min(remaining, PROFILE.integrationQuantumUs);
    acquired = stepPopulation({ ...state, acquired }, duration);
    remaining -= duration;
  }

  return Object.freeze({ acquired, steps });
}

module.exports = {
  MAX_INTEGRATION_STEPS,
  couplingInputs,
  integratePopulation,
  stepPopulation,
};
