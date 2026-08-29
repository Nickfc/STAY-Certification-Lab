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
const Q30_SPLIT = 32_768;

function fail(message, code = 'CHRONOBIOLOGY_OSCILLATOR_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function roundSafeInteger(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
    || denominator < 1) {
    fail('safe integer division is invalid');
  }
  const sign = numerator < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(numerator) + denominator / 2) / denominator);
}

function scaleQ30Ratio(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
    || denominator < 1
    || (Math.floor(Math.abs(numerator) / denominator) + 1) * Q30_ONE
      > Number.MAX_SAFE_INTEGER) {
    fail('Q30 ratio is invalid');
  }
  const sign = numerator < 0 ? -1 : 1;
  const magnitude = Math.abs(numerator);
  const whole = Math.floor(magnitude / denominator);
  let remainder = magnitude - whole * denominator;
  const firstScaled = remainder * Q30_SPLIT;
  const high = Math.floor(firstScaled / denominator);
  remainder = firstScaled - high * denominator;
  const secondScaled = remainder * Q30_SPLIT;
  const low = Math.floor(secondScaled / denominator);
  remainder = secondScaled - low * denominator;
  const roundedFraction = high * Q30_SPLIT + low
    + (remainder * 2 >= denominator ? 1 : 0);
  const result = sign * (whole * Q30_ONE + roundedFraction);
  if (!Number.isSafeInteger(result)) fail('Q30 ratio result is invalid');
  return result;
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

function populationStepPlan(phenotype, durationUs) {
  if (!Number.isSafeInteger(durationUs) || durationUs < 1
    || durationUs > PROFILE.integrationQuantumUs) {
    fail('integration quantum is invalid');
  }

  const weights = Array.from({ length: phenotype.oscillator_count }, () => 0n);
  for (const edge of phenotype.coupling_graph.edges) {
    weights[edge.left_unit_id] += BigInt(edge.weight_q30);
    weights[edge.right_unit_id] += BigInt(edge.weight_q30);
  }

  const oscillators = phenotype.oscillators.map(founder => Object.freeze({
    founder,
    intrinsic: phaseAdvance(founder.intrinsic_period_us, durationUs),
    recoveryForDuration: clamp(Number(roundDivide(
      BigInt(founder.amplitude_recovery_q) * BigInt(durationUs),
      BigInt(PROFILE.integrationQuantumUs),
    )), 0, Q31_ONE),
  }));

  return Object.freeze({
    durationUs,
    phenotype,
    weights: Object.freeze(weights),
    oscillators: Object.freeze(oscillators),
  });
}

function stepPopulationWithPlan(acquired, plan) {
  const sums = Array.from({ length: plan.phenotype.oscillator_count }, () => 0n);
  for (const edge of plan.phenotype.coupling_graph.edges) {
    const left = edge.left_unit_id;
    const right = edge.right_unit_id;
    const difference = signedPhaseDifference(
      acquired.oscillators[right].phase_q,
      acquired.oscillators[left].phase_q,
    );
    const response = multiplyQ30(sinQ30(wrapPhase(difference)), edge.weight_q30);
    sums[left] += BigInt(response);
    sums[right] -= BigInt(response);
  }

  const nextOscillators = plan.oscillators.map(({ founder, intrinsic,
    recoveryForDuration }, unitId) => {
    const current = acquired.oscillators[unitId];
    const weight = plan.weights[unitId];
    const coupling = weight === 0n
      ? 0
      : Number(roundDivide(sums[unitId] * BigInt(Q30_ONE), weight));
    const response = clamp(
      multiplyQ30(coupling, founder.coupling_sensitivity_q),
      -PROFILE.couplingResponseLimitQ30,
      PROFILE.couplingResponseLimitQ30,
    );
    const adjustment = Number(roundDivide(
      BigInt(intrinsic) * BigInt(response),
      BigInt(Q30_ONE),
    ));
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

function createPopulationStepper(phenotype) {
  const plans = new Map();
  return Object.freeze({
    step(acquired, durationUs) {
      let plan = plans.get(durationUs);
      if (!plan) {
        plan = populationStepPlan(phenotype, durationUs);
        plans.set(durationUs, plan);
      }
      return stepPopulationWithPlan(acquired, plan);
    },
    get planCount() {
      return plans.size;
    },
  });
}

function integratePopulationDuration(acquired, phenotype, durationUs) {
  if (!Number.isSafeInteger(durationUs) || durationUs < 0) {
    fail('trusted integration duration is invalid', 'CHRONOBIOLOGY_TIME_REWIND');
  }
  const steps = Math.ceil(durationUs / PROFILE.integrationQuantumUs);
  if (steps > MAX_INTEGRATION_STEPS) {
    fail('trusted interval exceeds bounded integration work', 'CHRONOBIOLOGY_INTERVAL_BOUND');
  }
  if (durationUs === 0) return Object.freeze({ acquired, steps: 0 });

  const count = phenotype.oscillator_count;
  const phases = acquired.oscillators.map(value => value.phase_q);
  const amplitudes = acquired.oscillators.map(value => value.amplitude_q);
  const sums = new Array(count).fill(0);
  const weights = new Array(count).fill(0);
  for (const edge of phenotype.coupling_graph.edges) {
    weights[edge.left_unit_id] += edge.weight_q30;
    weights[edge.right_unit_id] += edge.weight_q30;
  }
  const plans = new Map();
  const planFor = duration => {
    let plan = plans.get(duration);
    if (!plan) {
      plan = populationStepPlan(phenotype, duration);
      plans.set(duration, plan);
    }
    return plan;
  };

  let remaining = durationUs;
  while (remaining > 0) {
    const duration = Math.min(remaining, PROFILE.integrationQuantumUs);
    const plan = planFor(duration);
    sums.fill(0);
    for (const edge of phenotype.coupling_graph.edges) {
      const left = edge.left_unit_id;
      const right = edge.right_unit_id;
      const difference = signedPhaseDifference(phases[right], phases[left]);
      const response = multiplyQ30(sinQ30(wrapPhase(difference)), edge.weight_q30);
      sums[left] += response;
      sums[right] -= response;
    }

    for (let unitId = 0; unitId < count; unitId += 1) {
      const { founder, intrinsic, recoveryForDuration } = plan.oscillators[unitId];
      const weight = weights[unitId];
      const coupling = weight === 0
        ? 0
        : scaleQ30Ratio(sums[unitId], weight);
      const response = clamp(
        multiplyQ30(coupling, founder.coupling_sensitivity_q),
        -PROFILE.couplingResponseLimitQ30,
        PROFILE.couplingResponseLimitQ30,
      );
      const adjustment = roundSafeInteger(intrinsic * response, Q30_ONE);
      const amplitudeDifference = founder.baseline_amplitude_q - amplitudes[unitId];
      const amplitudeIncrement = multiplyQ31(amplitudeDifference, recoveryForDuration);
      phases[unitId] = wrapPhase(phases[unitId] + intrinsic + adjustment);
      amplitudes[unitId] = clamp(amplitudes[unitId] + amplitudeIncrement, 0, Q31_ONE);
    }
    remaining -= duration;
  }

  const oscillators = phenotype.oscillators.map((founder, unitId) => Object.freeze({
    unit_id: founder.unit_id,
    phase_q: phases[unitId],
    amplitude_q: amplitudes[unitId],
  }));
  return Object.freeze({
    acquired: Object.freeze({
      ...acquired,
      oscillators: Object.freeze(oscillators),
    }),
    steps,
  });
}

function stepPopulation(state, durationUs) {
  return stepPopulationWithPlan(
    state.acquired,
    populationStepPlan(state.phenotype, durationUs),
  );
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

  const integrated = integratePopulationDuration(state.acquired, state.phenotype, interval);
  return Object.freeze({ acquired: integrated.acquired, steps });
}

module.exports = {
  MAX_INTEGRATION_STEPS,
  couplingInputs,
  createPopulationStepper,
  integratePopulationDuration,
  integratePopulation,
  stepPopulation,
  roundSafeInteger,
  scaleQ30Ratio,
};
