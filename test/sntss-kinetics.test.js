'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fp = require('../cores/sntss/v0.1.0/fixed-point');
const kinetics = require('../cores/sntss/v0.1.0/kinetics');
const { advanceModel, QUANTUM_MS } = require('../cores/sntss/v0.1.0/integrator');
const { stableStringify } = require('../runtime/kernel/canonical-json');

const profile = Object.freeze({
  synthCap: 5000,
  precursorRecovery: 1000,
  reserveRetention: 999000,
  maxReleasePerStep: 20000,
  maxSuppressionPerStep: 10000,
  concentrationRetention: 950000,
  exposureAlpha: 20000,
  exposureRetention: 999000,
  toleranceStrength: 700000,
  opponentBuildAlpha: 5000,
  opponentRetention: 999500,
  refractoryRecovery: 10000,
  refractoryRetention: 990000,
  refractoryCost: 500000,
  affinity: 400000,
  hill: 2
});

const birth = Object.freeze({ P: 800000, R: 600000, C: 200000, B: 200000, X: 0, O: 0, F: 1000000 });

function assertBounded(state) {
  for (const key of kinetics.STATE_KEYS) {
    assert.ok(Number.isSafeInteger(state[key]), `${key} is canonical integer`);
    assert.ok(state[key] >= 0 && state[key] <= fp.SCALE, `${key} remains bounded`);
  }
}

test('R3-01: fixed-point arithmetic has one deterministic rounding rule and rejects invalid numerics', () => {
  assert.equal(fp.mul(333333, 500000), 166666);
  assert.equal(fp.mul(-333333, 500000), -166666);
  assert.equal(fp.powScaled(900000, 2), 810000);
  assert.equal(fp.approach(1000000, 0, 900000, 2), 810000);
  assert.equal(fp.hill(400000, 400000, 2), 500000);
  assert.equal(fp.saturatingCombine([500000, 500000]), 750000);
  assert.equal(fp.saturatingCombine([500000, -500000]), 0);
  assert.equal(fp.saturatingCombine([200000, 300000, -100000]), fp.saturatingCombine([-100000, 300000, 200000]));
  assert.throws(() => fp.mul(Number.NaN, 1), error => error.code === 'SNTSS_FIXED_INTEGER');
  assert.throws(() => fp.mulDiv(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1), error => error.code === 'SNTSS_FIXED_OVERFLOW');
});

test('R3-02: arbitrary valid drives preserve bounds and reserve/precursor conservation', () => {
  let seed = 0x51a7c0de;
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return seed >>> 0;
  };
  let state = { ...birth };
  for (let index = 0; index < 20000; index += 1) {
    const drive = (random() % 2000001) - 1000000;
    const before = state;
    const result = kinetics.step(before, profile, drive);
    state = result.state;
    assertBounded(state);
    assert.ok(result.transition.release <= before.R);
    assert.ok(result.transition.synthesis <= before.P + result.transition.precursorRecovery);
    assert.equal(state.R, fp.clamp(before.R + result.transition.synthesis - result.transition.release));
    assert.equal(state.P, fp.clamp(before.P + result.transition.precursorRecovery - result.transition.synthesis));
  }
});

test('R3-03: repeated equal evidence develops bounded tolerance and cannot create reserve', () => {
  let state = { ...birth };
  let earlyRelease = 0;
  let lateRelease = 0;
  for (let index = 0; index < 4000; index += 1) {
    const result = kinetics.step(state, profile, 700000);
    state = result.state;
    if (index < 100) earlyRelease += result.transition.release;
    if (index >= 3900) lateRelease += result.transition.release;
  }
  assertBounded(state);
  assert.ok(state.X > 0, 'exposure becomes acquired tolerance state');
  assert.ok(lateRelease < earlyRelease, 'equal late evidence has a smaller marginal release');
  assert.ok(state.R <= fp.SCALE);
});

test('R3-04: 365 days of quiet time uses bounded exponentiation, releases nothing and converges safely', () => {
  const model = {
    modelClock: 0,
    remainderMs: 0,
    transmitters: { test: { P: 100000, R: 100000, C: 950000, B: 200000, X: 900000, O: 800000, F: 100000 } }
  };
  const elapsed = 365 * 24 * 60 * 60 * 1000;
  const result = advanceModel(model, { test: profile }, elapsed, {});
  const state = result.model.transmitters.test;
  assert.equal(result.steps, elapsed / QUANTUM_MS);
  assert.equal(result.transitions.test.release, 0);
  assert.equal(state.C, state.B);
  assert.equal(state.X, 0);
  assert.equal(state.O, 0);
  assert.equal(state.F, fp.SCALE);
  assert.equal(state.R, fp.SCALE);
  assertBounded(state);
});

test('R3-05: identical checkpoint, ordered drives and time produce a fixed golden state hash', () => {
  const run = () => {
    let model = { modelClock: 0, remainderMs: 0, transmitters: { test: { ...birth } } };
    for (let index = 0; index < 200; index += 1) model = advanceModel(model, { test: profile }, 250, { test: [650000] }).model;
    for (let index = 0; index < 800; index += 1) model = advanceModel(model, { test: profile }, 250, { test: [] }).model;
    return model;
  };
  const first = run();
  const second = run();
  assert.deepEqual(second, first);
  const hash = crypto.createHash('sha256').update(stableStringify(first)).digest('hex');
  assert.equal(hash, 'e56a1e8ff6f603d64418ffd3bb96ebcb22adcd6a20d2ca5e79736fa34e2683d9');
});

test('R3-06: integration preserves sub-quantum remainder and rejects unbounded active downtime', () => {
  let model = { modelClock: 0, remainderMs: 0, transmitters: { test: { ...birth } } };
  let result = advanceModel(model, { test: profile }, 249, { test: [100000] });
  assert.equal(result.steps, 0);
  assert.equal(result.model.modelClock, 0);
  assert.equal(result.model.remainderMs, 249);
  result = advanceModel(result.model, { test: profile }, 1, { test: [100000] });
  assert.equal(result.steps, 1);
  assert.equal(result.model.modelClock, 250);
  assert.equal(result.model.remainderMs, 0);
  model = { modelClock: 0, remainderMs: 0, transmitters: { test: { ...birth } } };
  assert.throws(
    () => advanceModel(model, { test: profile }, (4096 + 1) * QUANTUM_MS, { test: [1] }),
    error => error.code === 'SNTSS_ACTIVE_TIME_LIMIT'
  );
});
