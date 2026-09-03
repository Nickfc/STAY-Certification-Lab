'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const q48 = require('../runtime/p1-r0/q16-48');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const { collectHomeosInputs } = require('../runtime/p1-r0/homeos-contract');
const { ROUTES } = require('../runtime/p1-r0/contract-registry');
const profile = require('../runtime/p1-r0/c0-source-contracts/contracts/founder_profile_templates.json').profiles.METAB;

let implementation = null;
try {
  implementation = require('../runtime/p1-r0/metab-engine');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

function createEngine(overrides = {}) {
  assert.equal(typeof implementation?.createMetabEngine, 'function', 'RED: METAB engine is not implemented');
  return implementation.createMetabEngine({
    profile,
    identity: {
      organismId: 'stay-p1-r0-test',
      founderLineageId: 'lineage-metab-0001',
      residencyId: 'resident:metab',
      coreVersion: '0.1.0-lab',
      authorityEpoch: '0',
      mode: 'SHADOW'
    },
    ...overrides
  });
}

function capacity(frameIndex, sequence = frameIndex, overrides = {}) {
  return {
    frameIndex,
    producerSequence: String(sequence),
    eligibleCapacityQ48: q48.SCALE.toString(),
    safetyCeilingQ48: q48.SCALE.toString(),
    capacityClass: 'STANDARD',
    qualityStatus: 'VALID',
    qualityQ48: q48.SCALE.toString(),
    coverageQ48: q48.SCALE.toString(),
    ceilingVerified: true,
    ...overrides
  };
}

function homeosOutputs(result) {
  return result.outputs.filter(frame => frame.route.consumerCoreId === 'HOMEOS');
}

test('METAB-R01 capacity identity and owner/viewer/payment fields are rejected by a closed input', () => {
  const engine = createEngine();
  assert.throws(() => engine.advance({ ...capacity(1), viewerId: 'forbidden' }), { code: 'P1_METAB_INPUT_SCHEMA' });
});

test('METAB-R02 capacity above the external ceiling cannot increase production', () => {
  const bounded = createEngine().advance(capacity(1));
  const excessive = createEngine().advance(capacity(1, 1, { eligibleCapacityQ48: q48.fromDecimal('2').toString() }));
  assert.equal(excessive.state.productionQ48, bounded.state.productionQ48);
});

test('METAB-R03 stale capacity holds at most four frames, then production is zero and reserve cannot charge', () => {
  const engine = createEngine();
  engine.advance(capacity(1));
  for (let frameIndex = 2; frameIndex <= 5; frameIndex += 1) engine.advance({ frameIndex, capacity: null });
  const before = engine.snapshot();
  const stopped = engine.advance({ frameIndex: 6, capacity: null });
  assert.equal(stopped.state.productionQ48, '0');
  assert.equal(stopped.state.cumulativeChargeQ48, before.cumulativeChargeQ48);
});

test('METAB-R04 cumulative discharge cannot exceed founder reserve plus committed valid charges', () => {
  const engine = createEngine();
  for (let frameIndex = 1; frameIndex <= 16; frameIndex += 1) engine.advance(capacity(frameIndex, frameIndex, { eligibleCapacityQ48: '0' }));
  const state = engine.snapshot();
  const initial = q48.mul(q48.parseRaw(profile.reserve.capacityQ48), q48.parseRaw(profile.reserve.initialFractionQ48));
  assert.ok(q48.parseRaw(state.cumulativeDischargeQ48) <= initial + q48.parseRaw(state.cumulativeChargeQ48));
});

test('METAB-R05 one surplus unit cannot both serve demand and charge reserve', () => {
  const engine = createEngine();
  const before = engine.snapshot();
  const result = engine.advance(capacity(1));
  const production = q48.parseRaw(result.state.productionQ48);
  const service = q48.parseRaw(result.state.serviceQ48);
  const reserveGain = q48.parseRaw(result.state.reserveQ48) - q48.parseRaw(before.reserveQ48);
  assert.ok(service + reserveGain <= production);
});

test('METAB-R06 duplicate replay leaves state and outputs byte-identical to the deduplicated control', () => {
  const engine = createEngine();
  const input = capacity(1);
  engine.advance(input);
  const before = stableStringify(engine.snapshot());
  const duplicate = engine.advance(input);
  assert.equal(stableStringify(engine.snapshot()), before);
  assert.deepEqual(duplicate.outputs, []);
  assert.equal(duplicate.duplicate, true);
});

test('METAB-R07 SHADOW ancestry publishes only SHADOW summaries and cannot create LIVE budgets', () => {
  const result = createEngine().advance(capacity(1));
  assert.equal(result.outputs.every(frame => frame.producer.mode === 'SHADOW'), true);
  assert.equal(result.outputs.some(frame => frame.topic.name === 'metab.consumer.budget.v1'), false);
  assert.equal(collectHomeosInputs(homeosOutputs(result), 2).producer.mode, 'SHADOW');
});

test('METAB-R08 restoring older reserve/debt/scarcity state is rejected as biological rewind', () => {
  const engine = createEngine();
  const old = engine.snapshot();
  engine.advance(capacity(1));
  assert.throws(() => engine.restore(old), { code: 'P1_METAB_REWIND' });
});

test('METAB-R09 outputs cannot contain death, suffering, punishment or viewer-directed semantics', () => {
  const text = stableStringify(createEngine().advance(capacity(1)).outputs);
  assert.doesNotMatch(text, /death|suffering|punishment|viewer|owner|payment/i);
});

test('METAB-R10 UI/chip input is outside the engine schema and produces zero biological delta', () => {
  const engine = createEngine();
  const before = stableStringify(engine.snapshot());
  assert.throws(() => engine.advance({ ...capacity(1), chipState: 'LIVE' }), { code: 'P1_METAB_INPUT_SCHEMA' });
  assert.equal(stableStringify(engine.snapshot()), before);
});

test('METAB-Q01 NEUTRAL computes contained state but emits no biological frames', () => {
  const engine = createEngine({
    identity: {
      organismId: 'stay-p1-r0-test',
      founderLineageId: 'lineage-metab-0001',
      residencyId: 'resident:metab',
      coreVersion: '0.1.0-lab',
      authorityEpoch: '0',
      mode: 'NEUTRAL'
    }
  });
  const result = engine.advance(capacity(1));
  assert.equal(result.state.frameIndex, 1);
  assert.deepEqual(result.outputs, []);
});

test('METAB-Q02 laboratory identity is authority-zero and cannot instantiate LIVE', () => {
  assert.throws(() => createEngine({
    identity: {
      organismId: 'stay-p1-r0-test',
      founderLineageId: 'lineage-metab-0001',
      residencyId: 'resident:metab',
      coreVersion: '0.1.0-lab',
      authorityEpoch: '1',
      mode: 'SHADOW'
    }
  }), { code: 'P1_METAB_AUTHORITY' });
  assert.throws(() => createEngine({
    identity: {
      organismId: 'stay-p1-r0-test',
      founderLineageId: 'lineage-metab-0001',
      residencyId: 'resident:metab',
      coreVersion: '0.1.0-lab',
      authorityEpoch: '0',
      mode: 'LIVE'
    }
  }), { code: 'P1_METAB_AUTHORITY' });
});

test('METAB-Q03 conflicting content under one producer sequence is quarantined', () => {
  const engine = createEngine();
  engine.advance(capacity(1));
  assert.throws(() => engine.advance(capacity(1, 1, { eligibleCapacityQ48: '0' })), { code: 'P1_METAB_REPLAY_CONFLICT' });
});

test('METAB-Q04 invalid capacity is explicit UNKNOWN and cannot charge reserve', () => {
  const engine = createEngine();
  const before = engine.snapshot();
  const result = engine.advance(capacity(1, 1, { qualityStatus: 'INVALID', ceilingVerified: false }));
  assert.equal(result.state.lifecycle, 'UNRESOLVED');
  assert.equal(result.state.productionQ48, '0');
  assert.equal(result.state.cumulativeChargeQ48, before.cumulativeChargeQ48);
  assert.equal(result.outputs.every(frame => frame.quality.status === 'UNKNOWN'), true);
  assert.throws(() => collectHomeosInputs(homeosOutputs(result), 2), { code: 'P1_HOMEOS_INPUT_UNKNOWN' });
});

test('METAB-Q05 identical founders and inputs produce byte-identical state and summaries', () => {
  const left = createEngine().advance(capacity(1));
  const right = createEngine().advance(capacity(1));
  assert.equal(stableStringify(left), stableStringify(right));
});

test('METAB-Q06 implementation has no wall clock, RNG, StateStore, UI or production attachment path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'p1-r0', 'metab-engine.js'), 'utf8');
  assert.doesNotMatch(source, /\bDate[.(]|\bperformance\.|\bMath\.random|\brandomBytes/);
  assert.doesNotMatch(source, /state-store|continuity\.sqlite|chip-projection|live-bridge|resident-manager/i);
  assert.equal(ROUTES['p1r0.capacity.metab'].stage, 'ABSENT');
  assert.equal(ROUTES['p1r0.metab-availability.homeos'].stage, 'ABSENT');
  assert.equal(ROUTES['p1r0.metab-reserve.homeos'].stage, 'ABSENT');
});

test('METAB-Q07 lifetime counters saturate at signed Q16.48 capacity without failing physiology', () => {
  const nearMaximum = (q48.MAX_RAW - 1n).toString();
  const reserveCapacity = profile.reserve.capacityQ48;

  const surplus = createEngine();
  surplus.restore({
    ...surplus.snapshot(),
    frameIndex: 100,
    reserveQ48: reserveCapacity,
    cumulativeChargeQ48: nearMaximum,
    cumulativeDischargeQ48: nearMaximum,
    saturationLossQ48: nearMaximum,
    inputCursors: { 'p1r0.capacity.metab': '100' }
  });
  const saturatedSurplus = surplus.advance(capacity(101, 101));
  assert.equal(saturatedSurplus.state.saturationLossQ48, q48.MAX_RAW.toString());

  const deficit = createEngine();
  deficit.restore({
    ...deficit.snapshot(),
    frameIndex: 100,
    reserveQ48: reserveCapacity,
    cumulativeChargeQ48: nearMaximum,
    cumulativeDischargeQ48: nearMaximum,
    saturationLossQ48: nearMaximum,
    inputCursors: { 'p1r0.capacity.metab': '100' }
  });
  const saturatedDischarge = deficit.advance(capacity(101, 101, {
    eligibleCapacityQ48: '0'
  }));
  assert.equal(saturatedDischarge.state.cumulativeDischargeQ48, q48.MAX_RAW.toString());
});
