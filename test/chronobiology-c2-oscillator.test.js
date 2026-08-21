'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { stableStringify } = require('../runtime/kernel/canonical-json');
const { deriveAggregate } = require('../cores/chronobiology/c3/aggregate');
const { PROFILE } = require('../cores/chronobiology/c3/calibration-profile');
const {
  Q31_ONE,
  TRIG_TABLE_HASH,
  multiplyQ30,
  signedPhaseDifference,
  sinQ30,
  wrapPhase,
} = require('../cores/chronobiology/c3/fixed-point');
const { stepPopulation } = require('../cores/chronobiology/c3/oscillator');
const {
  advanceTrustedTime,
  bindState,
  emptyState,
  normalizeState,
} = require('../cores/chronobiology/c3/state');
const {
  QUANTUM_TOLERANCE,
  RESOLUTION_TOLERANCE,
  createLaboratoryState,
  macroDifference,
  runLaboratory,
  withinTolerance,
} = require('../tools/chronobiology-convergence-lab');

const DAY_US = 86_400_000_000;
const HALF_TURN = 0x80000000;

let resolutionEvidence;
function resolutionRuns() {
  if (!resolutionEvidence) {
    resolutionEvidence = new Map([32, 64, 128].map(count => [
      count,
      runLaboratory(createLaboratoryState({ oscillatorCount: count }), {
        durationUs: 30 * DAY_US,
        quantumUs: 60_000_000,
      }),
    ]));
  }
  return resolutionEvidence;
}

let quantumEvidence;
function quantumRuns() {
  if (!quantumEvidence) {
    quantumEvidence = new Map([15_000_000, 30_000_000, 60_000_000].map(quantumUs => [
      quantumUs,
      runLaboratory(createLaboratoryState(), {
        durationUs: 7 * DAY_US,
        quantumUs,
      }),
    ]));
  }
  return quantumEvidence;
}

test('C2-NUM-01 fixed-point replay is byte-identical', () => {
  const checkpoint = createLaboratoryState();
  const options = { durationUs: DAY_US, quantumUs: 60_000_000 };
  assert.equal(stableStringify(runLaboratory(checkpoint, options)),
    stableStringify(runLaboratory(checkpoint, options)));
});

test('C2-NUM-02 phase wrapping and signed difference are canonical', () => {
  assert.equal(wrapPhase(-1), 0xffffffff);
  assert.equal(wrapPhase(0x100000000), 0);
  assert.equal(signedPhaseDifference(1, 0xffffffff), 2);
  assert.equal(signedPhaseDifference(0xffffffff, 1), -2);
});

test('C2-NUM-03 hash-bound lookup symmetry is exact at representative phases', () => {
  assert.match(TRIG_TABLE_HASH, /^sha256:[0-9a-f]{64}$/);
  for (const phase of [0, 1, 0x12345678, 0x40000000, 0x7fffffff]) {
    assert.equal(sinQ30(phase) + sinQ30(wrapPhase(BigInt(phase) + BigInt(HALF_TURN))), 0);
  }
});

test('C2-NUM-04 overflow and out-of-profile quantum reject the whole candidate', () => {
  assert.throws(() => multiplyQ30(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    { code: 'CHRONOBIOLOGY_NUMERICAL_INVALID' });
  assert.throws(() => stepPopulation(createLaboratoryState(), 60_000_001),
    { code: 'CHRONOBIOLOGY_OSCILLATOR_INVALID' });
});

test('C2-NUM-05 unsupported numerical engine fails closed', () => {
  const binding = {
    id: 'c2-binding',
    topic: 'runtime.organism.binding',
    payload: {
      bindingVersion: 1,
      identitySha256: `sha256:${'c'.repeat(64)}`,
      organismLineage: 'STAY/Genesis',
      runtimeRevision: 1,
      authorityEpoch: 1,
      kernelVersion: '0.8.11.3',
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
  };
  const pulse = {
    id: 'c2-pulse',
    topic: 'runtime.trusted-organism-time.pulse',
    payload: {
      runtimeRevision: 1,
      pulseSequence: 1,
      status: 'TRUSTED',
      trustedTimeUs: 0,
      continuityEpoch: 1,
      reasonCode: null,
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
  };
  const state = structuredClone(advanceTrustedTime(bindState(emptyState(), binding), pulse));
  state.phenotype.numerical_engine_version = 'chronobiology-fixed-point-v999';
  assert.throws(() => normalizeState(state), {
    code: 'CHRONOBIOLOGY_VERSION_UNSUPPORTED',
  });
});

test('C2-NUM-06 15/30/60-second integration remains within declared tolerance', () => {
  const evidence = quantumRuns();
  for (const quantumUs of [15_000_000, 30_000_000]) {
    const difference = macroDifference(evidence.get(quantumUs), evidence.get(60_000_000));
    assert.equal(withinTolerance(difference, QUANTUM_TOLERANCE), true,
      `${quantumUs}/60000000 divergence ${JSON.stringify(difference)}`);
  }
});

test('C2-OSC-01 free-running advances endogenously without creating cue evidence', () => {
  const initial = createLaboratoryState();
  const advanced = resolutionRuns().get(64);
  const before = deriveAggregate(initial);
  const after = deriveAggregate(advanced);
  assert.notEqual(after.central_phase_q, before.central_phase_q);
  assert.equal(advanced.acquired.photic_activation_q, 0);
  assert.equal(advanced.acquired.cue_coverage_q, 0);
  assert.ok(after.rhythm_amplitude_q > 0);
});

test('C2-OSC-02 32/64/128 macro physiology converges at production quantum', () => {
  const evidence = resolutionRuns();
  for (const [left, right] of [[32, 64], [64, 128]]) {
    const difference = macroDifference(evidence.get(left), evidence.get(right));
    assert.equal(withinTolerance(difference, RESOLUTION_TOLERANCE), true,
      `${left}/${right} divergence ${JSON.stringify(difference)}`);
  }
});

test('C2-OSC-03 perturbed amplitude recovers toward founder baseline', () => {
  const state = structuredClone(createLaboratoryState());
  state.acquired.oscillators = state.acquired.oscillators.map(unit => ({ ...unit, amplitude_q: 0 }));
  const recovered = runLaboratory(state, { durationUs: DAY_US, quantumUs: 60_000_000 });
  for (let index = 0; index < recovered.acquired.oscillators.length; index += 1) {
    assert.ok(recovered.acquired.oscillators[index].amplitude_q > 0);
    assert.ok(recovered.acquired.oscillators[index].amplitude_q
      <= recovered.phenotype.oscillators[index].baseline_amplitude_q);
  }
});

test('C2-OSC-04 coherence and amplitude remain distinct observations', () => {
  const synchronizedWeak = structuredClone(createLaboratoryState());
  synchronizedWeak.acquired.oscillators = synchronizedWeak.acquired.oscillators.map(unit => ({
    ...unit, phase_q: 0, amplitude_q: Math.floor(Q31_ONE / 10),
  }));
  const cancellingStrong = structuredClone(createLaboratoryState());
  cancellingStrong.acquired.oscillators = cancellingStrong.acquired.oscillators.map((unit, index) => ({
    ...unit, phase_q: index % 2 === 0 ? 0 : HALF_TURN, amplitude_q: Q31_ONE,
  }));
  const weak = deriveAggregate(synchronizedWeak);
  const cancelling = deriveAggregate(cancellingStrong);
  assert.ok(weak.oscillator_coherence_q > cancelling.oscillator_coherence_q);
  assert.ok(weak.rhythm_amplitude_q < cancelling.rhythm_amplitude_q);
});

test('C2-OSC-05 near-cancellation makes central phase unavailable', () => {
  const state = structuredClone(createLaboratoryState());
  state.acquired.oscillators = state.acquired.oscillators.map((unit, index) => ({
    ...unit, phase_q: index % 2 === 0 ? 0 : HALF_TURN, amplitude_q: Q31_ONE,
  }));
  const aggregate = deriveAggregate(state);
  assert.equal(aggregate.central_phase_q, null);
  assert.ok(aggregate.phase_resolvability_q < PROFILE.phaseResolvableMinimumQ31);
});

test('C2-OSC-06 coupling restores coherence without assigning a phase', () => {
  const state = structuredClone(createLaboratoryState());
  state.acquired.oscillators = state.acquired.oscillators.map((unit, index) => ({
    ...unit,
    phase_q: wrapPhase(index * 50_000_000 + (index % 3) * 1_234_567),
  }));
  state.phenotype.oscillators = state.phenotype.oscillators.map(unit => ({
    ...unit, intrinsic_period_us: PROFILE.intrinsicPeriodMeanUs,
  }));
  const before = deriveAggregate(state);
  const after = deriveAggregate(runLaboratory(state, {
    durationUs: 10 * DAY_US,
    quantumUs: 60_000_000,
  }));
  assert.ok(after.oscillator_coherence_q > before.oscillator_coherence_q);
  assert.notEqual(after.central_phase_q, 0);
});

test('C2-OSC-07 one accelerated year remains bounded and phase-resolvable', () => {
  const state = runLaboratory(createLaboratoryState(), {
    durationUs: 365 * DAY_US,
    quantumUs: 60_000_000,
  });
  const aggregate = deriveAggregate(state);
  for (const oscillator of state.acquired.oscillators) {
    assert.ok(oscillator.phase_q >= 0 && oscillator.phase_q <= 0xffffffff);
    assert.ok(oscillator.amplitude_q >= 0 && oscillator.amplitude_q <= Q31_ONE);
  }
  assert.notEqual(aggregate.central_phase_q, null);
  assert.ok(aggregate.oscillator_coherence_q > PROFILE.phaseResolvableMinimumQ31);
});
