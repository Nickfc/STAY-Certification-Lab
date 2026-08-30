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
  wrapPhase,
} = require('./fixed-point');
const { couplingInputs } = require('./oscillator');

const COARSE_QUANTUM_US = 43_200_000_000;

function coarseStep(state, durationUs) {
  if (!Number.isSafeInteger(durationUs) || durationUs < 1 || durationUs > COARSE_QUANTUM_US) {
    throw Object.assign(new Error('coarse free-run quantum is invalid'), {
      code: 'CHRONOBIOLOGY_COARSE_QUANTUM_INVALID',
    });
  }
  const coupling = couplingInputs(state.phenotype, state.acquired);
  const oscillators = state.phenotype.oscillators.map((founder, unitId) => {
    const current = state.acquired.oscillators[unitId];
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
    const amplitudeIncrement = multiplyQ31(
      founder.baseline_amplitude_q - current.amplitude_q,
      recoveryForDuration,
    );
    return Object.freeze({
      unit_id: founder.unit_id,
      phase_q: wrapPhase(BigInt(current.phase_q) + BigInt(intrinsic) + BigInt(adjustment)),
      amplitude_q: clamp(current.amplitude_q + amplitudeIncrement, 0, Q31_ONE),
    });
  });
  return Object.freeze({ ...state.acquired, oscillators: Object.freeze(oscillators) });
}

function integrateCoarseFreeRun(state, durationUs) {
  let current = state;
  let remaining = durationUs;
  let steps = 0;
  while (remaining > 0) {
    const duration = Math.min(remaining, COARSE_QUANTUM_US);
    current = Object.freeze({
      ...current,
      acquired: coarseStep(current, duration),
    });
    remaining -= duration;
    steps += 1;
  }
  return Object.freeze({ state: current, steps });
}

module.exports = {
  COARSE_QUANTUM_US,
  coarseStep,
  integrateCoarseFreeRun,
};
