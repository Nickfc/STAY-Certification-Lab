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
const { SIN_Q30 } = require('./trig-table');

const MAX_INTEGRATION_STEPS = 43_200;
const Q30_SPLIT = 32_768;
const PHASE_HALF_NUMBER = 2_147_483_648;
const Q20_RECIPROCAL = 9.5367431640625e-7;
const Q30_RECIPROCAL = 9.313225746154785e-10;
const Q31_RECIPROCAL = 4.656612873077393e-10;
const ADAPTIVE_ROUNDING_GUARD = 0.00001;
const COUPLING_RESPONSE_LIMIT_Q30 = PROFILE.couplingResponseLimitQ30;
const SIN_VALUES_Q30 = Int32Array.from(SIN_Q30);
const SIN_DELTA_Q30 = Int32Array.from(SIN_Q30, (value, index) =>
  SIN_Q30[(index + 1) & 4095] - value);

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

function compiledIntegrationPlan(phenotype, durationUs) {
  const count = phenotype.oscillator_count;
  if (count !== PROFILE.oscillatorCount) {
    fail('compiled oscillator population resolution is invalid');
  }
  const edges = phenotype.coupling_graph.edges;
  let localEdgeCount = 0;
  const generalEdges = [];
  const generalWeightHigh = [];
  const generalWeightLow = [];
  const totalWeights = new Array(count).fill(0);
  for (const edge of edges) {
    const left = edge.left_unit_id;
    const right = edge.right_unit_id;
    const weight = edge.weight_q30;
    if (weight === PROFILE.localEdgeWeightQ30) {
      localEdgeCount += 1;
    } else {
      generalEdges.push((left | (right << 6)) + weight * Q30_RECIPROCAL);
      const high = Math.floor(weight / Q30_SPLIT);
      generalWeightHigh.push(high);
      generalWeightLow.push(weight - high * Q30_SPLIT);
    }
    totalWeights[left] += weight;
    totalWeights[right] += weight;
  }
  if (localEdgeCount !== count * 2) {
    fail('compiled local ring is incomplete');
  }
  const units = new Array(count);
  for (let unitId = 0; unitId < count; unitId += 1) {
    const founder = phenotype.oscillators[unitId];
    const intrinsic = phaseAdvance(founder.intrinsic_period_us, durationUs);
    const recovery = clamp(Number(roundDivide(
      BigInt(founder.amplitude_recovery_q) * BigInt(durationUs),
      BigInt(PROFILE.integrationQuantumUs),
    )), 0, Q31_ONE);
    const high = Math.floor(founder.coupling_sensitivity_q / Q30_SPLIT);
    units[unitId] = {
      totalWeight: totalWeights[unitId],
      totalWeightScale: Q30_ONE / totalWeights[unitId],
      intrinsic,
      recovery,
      sensitivityHigh: high,
      sensitivityLow: founder.coupling_sensitivity_q - high * Q30_SPLIT,
      sensitivityScale: founder.coupling_sensitivity_q * Q30_RECIPROCAL,
    };
  }

  return {
    count,
    generalEdgeCount: generalEdges.length,
    generalEdges,
    generalWeightHigh,
    generalWeightLow,
    units,
  };
}

/*
 * This is deliberately a single, validation-free trusted hot loop. C3RC.2's
 * exact Number primitives remain the reference contract, but calling them for
 * every edge and oscillator is prohibitively expensive in CoreHost's mandatory
 * --jitless worker. The split products and rounding below are algebraically
 * identical to multiplyQ30/multiplyQ31 and scaleQ30Ratio. Inputs are validated
 * before this compiled plan is created; differential tests fence every result
 * against the frozen C3RC.1 engine.
 */
function integrateCompiledPlan(phases, amplitudeDifferences, sums, plan, iterations) {
  const {
    count,
    generalEdgeCount,
    generalEdges,
    generalWeightHigh,
    generalWeightLow,
    units,
  } = plan;
  let recoverAmplitudes = false;
  for (let unitId = 0; unitId < count; unitId += 1) {
    if (amplitudeDifferences[unitId] !== 0) {
      recoverAmplitudes = true;
      break;
    }
  }

  for (let step = 0; step < iterations; step += 1) {
    sums.fill(0);
    // Founder reconstruction proves the fixed 64-node local ±1/±2 ring before
    // this plan is admitted. Deriving those endpoints removes 256 interpreter
    // array reads per quantum while the founder-specific long-range graph
    // remains fully plan-driven below.
    for (let left = 0; left < count; left += 1) {
      let right = (left + 1) & 63;
      let phase = (phases[right] - phases[left]) >>> 0;
      let index = phase >>> 20;
      let fraction = phase & 0xf_ffff;
      let current = SIN_VALUES_Q30[index];
      let scaled = SIN_DELTA_Q30[index] * fraction;
      let sine = current + (scaled < 0
        ? -(((-scaled + 524_288) * Q20_RECIPROCAL) | 0)
        : (((scaled + 524_288) * Q20_RECIPROCAL) | 0));
      let response = sine < 0
        ? -((-sine + 4) >>> 3)
        : ((sine + 4) >>> 3);
      sums[left] += response;
      sums[right] -= response;

      right = (left + 2) & 63;
      phase = (phases[right] - phases[left]) >>> 0;
      index = phase >>> 20;
      fraction = phase & 0xf_ffff;
      current = SIN_VALUES_Q30[index];
      scaled = SIN_DELTA_Q30[index] * fraction;
      sine = current + (scaled < 0
        ? -(((-scaled + 524_288) * Q20_RECIPROCAL) | 0)
        : (((scaled + 524_288) * Q20_RECIPROCAL) | 0));
      response = sine < 0
        ? -((-sine + 4) >>> 3)
        : ((sine + 4) >>> 3);
      sums[left] += response;
      sums[right] -= response;

    }

    for (let edgeId = 0; edgeId < generalEdgeCount; edgeId += 1) {
      const edge = generalEdges[edgeId];
      const units = edge | 0;
      const left = units & 63;
      const right = units >>> 6;
      const phase = (phases[right] - phases[left]) >>> 0;
      const index = phase >>> 20;
      const fraction = phase & 0xf_ffff;
      const current = SIN_VALUES_Q30[index];
      const scaled = SIN_DELTA_Q30[index] * fraction;
      const sine = current + (scaled < 0
        ? -(((-scaled + 524_288) * Q20_RECIPROCAL) | 0)
        : (((scaled + 524_288) * Q20_RECIPROCAL) | 0));
      let response = 0;
      if (sine !== 0) {
        const sineMagnitude = sine < 0 ? -sine : sine;
        const scaledProduct = sineMagnitude * (edge - units);
        const productFloor = scaledProduct | 0;
        const productFraction = scaledProduct - productFloor;
        let magnitude;
        if (productFraction < 0.5 - ADAPTIVE_ROUNDING_GUARD
          || productFraction > 0.5 + ADAPTIVE_ROUNDING_GUARD) {
          magnitude = productFloor + (productFraction >= 0.5 ? 1 : 0);
        } else {
          const sineHigh = sineMagnitude >>> 15;
          const sineLow = sineMagnitude & 0x7fff;
          const weightHigh = generalWeightHigh[edgeId];
          const weightLow = generalWeightLow[edgeId];
          const exactHigh = sineHigh * weightHigh;
          const exactLow = (sineHigh * weightLow + sineLow * weightHigh) * Q30_SPLIT
            + sineLow * weightLow;
          magnitude = exactHigh
            + Math.floor((exactLow + 536_870_912) * Q30_RECIPROCAL);
        }
        response = sine < 0 ? -magnitude : magnitude;
      }
      sums[left] += response;
      sums[right] -= response;
    }

    for (let unitId = 0; unitId < count; unitId += 1) {
      const unit = units[unitId];
      const sum = sums[unitId];
      const denominator = unit.totalWeight;
      let coupling = 0;
      if (sum !== 0 && denominator !== 0) {
        const sign = sum < 0 ? -1 : 1;
        const magnitude = sum < 0 ? -sum : sum;
        let couplingMagnitude;
        if (magnitude === denominator) {
          couplingMagnitude = Q30_ONE;
        } else {
          const scaledRatio = magnitude * unit.totalWeightScale;
          const ratioFloor = scaledRatio | 0;
          const ratioFraction = scaledRatio - ratioFloor;
          if (ratioFraction < 0.5 - ADAPTIVE_ROUNDING_GUARD
            || ratioFraction > 0.5 + ADAPTIVE_ROUNDING_GUARD) {
            couplingMagnitude = ratioFloor + (ratioFraction >= 0.5 ? 1 : 0);
          } else {
            const whole = magnitude >= denominator ? 1 : 0;
            let remainder = magnitude - whole * denominator;
            const firstScaled = remainder * Q30_SPLIT;
            const high = Math.floor(firstScaled / denominator);
            remainder = firstScaled - high * denominator;
            const secondScaled = remainder * Q30_SPLIT;
            const low = Math.floor(secondScaled / denominator);
            remainder = secondScaled - low * denominator;
            couplingMagnitude = whole * Q30_ONE + high * Q30_SPLIT + low
              + (remainder * 2 >= denominator ? 1 : 0);
          }
        }
        coupling = sign * couplingMagnitude;
      }

      let response = 0;
      if (coupling !== 0) {
        const couplingMagnitude = coupling < 0 ? -coupling : coupling;
        const scaledProduct = couplingMagnitude * unit.sensitivityScale;
        const productFloor = scaledProduct | 0;
        const productFraction = scaledProduct - productFloor;
        let magnitude;
        if (productFraction < 0.5 - ADAPTIVE_ROUNDING_GUARD
          || productFraction > 0.5 + ADAPTIVE_ROUNDING_GUARD) {
          magnitude = productFloor + (productFraction >= 0.5 ? 1 : 0);
        } else {
          const couplingHigh = couplingMagnitude >>> 15;
          const couplingLow = couplingMagnitude & 0x7fff;
          const exactHigh = couplingHigh * unit.sensitivityHigh;
          const exactLow = (couplingHigh * unit.sensitivityLow
            + couplingLow * unit.sensitivityHigh) * Q30_SPLIT
            + couplingLow * unit.sensitivityLow;
          magnitude = exactHigh
            + Math.floor((exactLow + 536_870_912) * Q30_RECIPROCAL);
        }
        response = coupling < 0 ? -magnitude : magnitude;
        if (response < -COUPLING_RESPONSE_LIMIT_Q30) {
          response = -COUPLING_RESPONSE_LIMIT_Q30;
        } else if (response > COUPLING_RESPONSE_LIMIT_Q30) {
          response = COUPLING_RESPONSE_LIMIT_Q30;
        }
      }

      const intrinsic = unit.intrinsic;
      const adjustmentProduct = intrinsic * response;
      const adjustment = adjustmentProduct < 0
        ? -(((-adjustmentProduct + 536_870_912) * Q30_RECIPROCAL) | 0)
        : (((adjustmentProduct + 536_870_912) * Q30_RECIPROCAL) | 0);
      phases[unitId] = phases[unitId] + intrinsic + adjustment;
    }

    if (recoverAmplitudes) {
      let remainingRecovery = false;
      for (let unitId = 0; unitId < count; unitId += 1) {
        const amplitudeDifference = amplitudeDifferences[unitId];
        if (amplitudeDifference === 0) continue;
        const sign = amplitudeDifference < 0 ? -1 : 1;
        const differenceMagnitude = Math.abs(amplitudeDifference);
        const recovery = units[unitId].recovery;
        const differenceHigh = Math.floor(differenceMagnitude / Q30_SPLIT);
        const differenceLow = differenceMagnitude - differenceHigh * Q30_SPLIT;
        const recoveryHigh = Math.floor(recovery / Q30_SPLIT);
        const recoveryLow = recovery - recoveryHigh * Q30_SPLIT;
        const productHigh = differenceHigh * recoveryHigh;
        const productLow = (differenceHigh * recoveryLow
          + differenceLow * recoveryHigh) * Q30_SPLIT
          + differenceLow * recoveryLow;
        const incrementMagnitude = Math.floor(productHigh / 2) + Math.floor(
          ((productHigh % 2) * Q30_ONE + productLow + Q30_ONE)
            * Q31_RECIPROCAL,
        );
        amplitudeDifferences[unitId] -= sign < 0 ? -incrementMagnitude : incrementMagnitude;
        if (amplitudeDifferences[unitId] !== 0) remainingRecovery = true;
      }
      recoverAmplitudes = remainingRecovery;
    }
  }
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
  const phases = Int32Array.from(acquired.oscillators, value => value.phase_q | 0);
  const amplitudeDifferences = Int32Array.from(acquired.oscillators, (value, unitId) =>
    phenotype.oscillators[unitId].baseline_amplitude_q - value.amplitude_q);
  const sums = new Int32Array(count);
  const fullSteps = Math.floor(durationUs / PROFILE.integrationQuantumUs);
  const remainder = durationUs - fullSteps * PROFILE.integrationQuantumUs;
  if (fullSteps > 0) {
    integrateCompiledPlan(
      phases,
      amplitudeDifferences,
      sums,
      compiledIntegrationPlan(phenotype, PROFILE.integrationQuantumUs),
      fullSteps,
    );
  }
  if (remainder > 0) {
    integrateCompiledPlan(
      phases,
      amplitudeDifferences,
      sums,
      compiledIntegrationPlan(phenotype, remainder),
      1,
    );
  }

  const oscillators = phenotype.oscillators.map((founder, unitId) => Object.freeze({
    unit_id: founder.unit_id,
    phase_q: phases[unitId] >>> 0,
    amplitude_q: founder.baseline_amplitude_q - amplitudeDifferences[unitId],
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
