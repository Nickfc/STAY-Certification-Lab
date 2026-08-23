'use strict';

const { deriveAggregate } = require('../cores/chronobiology/c3/aggregate');
const { PROFILE } = require('../cores/chronobiology/c3/calibration-profile');
const { Q31_ONE, signedPhaseDifference } = require('../cores/chronobiology/c3/fixed-point');
const { expandPhenotype } = require('../cores/chronobiology/c3/founder');
const { stepPopulation } = require('../cores/chronobiology/c3/oscillator');

const LAB_SEED = '0123456789abcdef'.repeat(4);
const SUPPORTED_RESOLUTIONS = Object.freeze([32, 64, 128]);
const SUPPORTED_QUANTA_US = Object.freeze([15_000_000, 30_000_000, 60_000_000]);

function createLaboratoryState({
  oscillatorCount = 64,
  seedHex = LAB_SEED,
} = {}) {
  if (!SUPPORTED_RESOLUTIONS.includes(oscillatorCount)) {
    throw Object.assign(new Error('unsupported convergence resolution'), {
      code: 'CHRONOBIOLOGY_LAB_RESOLUTION',
    });
  }
  const { phenotype } = expandPhenotype(seedHex, { oscillatorCount });
  return Object.freeze({
    phenotype,
    acquired: Object.freeze({
      oscillators: Object.freeze(phenotype.oscillators.map(unit => Object.freeze({
        unit_id: unit.unit_id,
        phase_q: unit.initial_phase_q,
        amplitude_q: unit.baseline_amplitude_q,
      }))),
      photic_activation_q: 0,
      photic_adaptation_q: 0,
      cue_coverage_q: 0,
      phase_lock_summary: Object.freeze({ status: 'UNKNOWN', strength_q: 0 }),
      alignment_summary: Object.freeze({ status: 'UNKNOWN', stability_q: 0 }),
      bounded_entrainment_history: Object.freeze([]),
      aggregate_phase_history: Object.freeze([]),
      evidence_gap_summary: Object.freeze({ gap_count: 0, unknown_duration_us: 0 }),
    }),
  });
}

function runLaboratory(state, { durationUs, quantumUs }) {
  if (!Number.isSafeInteger(durationUs) || durationUs < 0
    || !SUPPORTED_QUANTA_US.includes(quantumUs)
    || durationUs % quantumUs !== 0) {
    throw Object.assign(new Error('laboratory duration/quantum is invalid'), {
      code: 'CHRONOBIOLOGY_LAB_TIME',
    });
  }
  let current = state;
  for (let elapsed = 0; elapsed < durationUs; elapsed += quantumUs) {
    current = Object.freeze({
      ...current,
      acquired: stepPopulation(current, quantumUs),
    });
  }
  return current;
}

function macroDifference(leftState, rightState) {
  const left = deriveAggregate(leftState);
  const right = deriveAggregate(rightState);
  return Object.freeze({
    phase_q: left.central_phase_q === null || right.central_phase_q === null
      ? null
      : Math.abs(signedPhaseDifference(left.central_phase_q, right.central_phase_q)),
    coherence_q: Math.abs(left.oscillator_coherence_q - right.oscillator_coherence_q),
    amplitude_q: Math.abs(left.rhythm_amplitude_q - right.rhythm_amplitude_q),
  });
}

function withinTolerance(difference, tolerance) {
  return difference.phase_q !== null
    && difference.phase_q <= tolerance.phase_q
    && difference.coherence_q <= tolerance.coherence_q
    && difference.amplitude_q <= tolerance.amplitude_q;
}

const RESOLUTION_TOLERANCE = Object.freeze({
  phase_q: PROFILE.resolutionConvergencePhaseToleranceQ,
  coherence_q: PROFILE.resolutionConvergenceCoherenceToleranceQ31,
  amplitude_q: PROFILE.resolutionConvergenceAmplitudeToleranceQ31,
});

const QUANTUM_TOLERANCE = Object.freeze({
  phase_q: PROFILE.quantumConvergencePhaseToleranceQ,
  coherence_q: PROFILE.quantumConvergenceCoherenceToleranceQ31,
  amplitude_q: PROFILE.quantumConvergenceAmplitudeToleranceQ31,
});

module.exports = {
  LAB_SEED,
  Q31_ONE,
  QUANTUM_TOLERANCE,
  RESOLUTION_TOLERANCE,
  SUPPORTED_QUANTA_US,
  SUPPORTED_RESOLUTIONS,
  createLaboratoryState,
  macroDifference,
  runLaboratory,
  withinTolerance,
};
