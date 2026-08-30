'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const q48 = require('../runtime/p1-r0/q16-48');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const { createMetabEngine } = require('../runtime/p1-r0/metab-engine');
const { createHomeosEngine } = require('../runtime/p1-r0/homeos-engine');
const profiles = require('../runtime/p1-r0/c0-source-contracts/contracts/founder_profile_templates.json').profiles;

function metab() {
  return createMetabEngine({
    profile: profiles.METAB,
    identity: {
      organismId: 'stay-p1-r0-test',
      founderLineageId: 'lineage-metab-0001',
      residencyId: 'resident:metab',
      coreVersion: '0.1.0-lab',
      authorityEpoch: '0',
      mode: 'SHADOW'
    }
  });
}

function homeos(overrides = {}) {
  return createHomeosEngine({
    profile: profiles.HOMEOS,
    identity: {
      organismId: 'stay-p1-r0-test',
      founderLineageId: 'lineage-homeos-0001',
      residencyId: 'resident:homeos',
      coreVersion: '0.1.0-lab',
      authorityEpoch: '0',
      mode: 'SHADOW'
    },
    ...overrides
  });
}

function capacity(frameIndex, eligible = '1', overrides = {}) {
  return {
    frameIndex,
    producerSequence: String(frameIndex),
    eligibleCapacityQ48: q48.fromDecimal(eligible).toString(),
    safetyCeilingQ48: q48.SCALE.toString(),
    capacityClass: 'STANDARD',
    qualityStatus: 'VALID',
    qualityQ48: q48.SCALE.toString(),
    coverageQ48: q48.SCALE.toString(),
    ceilingVerified: true,
    ...overrides
  };
}

function metabInputs(engine, frameIndex, eligible = '1', overrides = {}) {
  return engine.advance(capacity(frameIndex, eligible, overrides)).outputs.filter(frame => frame.route.consumerCoreId === 'HOMEOS');
}

test('HOMEOS-R01 closed HOMEOS summaries contain no heart or respiratory targets', () => {
  const inputs = metabInputs(metab(), 1);
  const result = homeos().advance({ frameIndex: 2, inputs });
  assert.equal(result.outputs.length, 3);
  assert.doesNotMatch(stableStringify(result.outputs), /heartRate|respiratoryRate|heart|breath/i);
});

test('HOMEOS-R02 duplicate canonical METAB sources are rejected before state mutation', () => {
  const inputs = metabInputs(metab(), 1);
  const engine = homeos();
  const before = stableStringify(engine.snapshot());
  assert.throws(() => engine.advance({ frameIndex: 2, inputs: [inputs[0], inputs[0]] }), { code: 'P1_HOMEOS_INPUT_CONFLICT' });
  assert.equal(stableStringify(engine.snapshot()), before);
});

test('HOMEOS-R03 missing evidence freezes filter and burden and becomes explicit UNRESOLVED', () => {
  const engine = homeos();
  const before = engine.snapshot();
  const result = engine.advance({ frameIndex: 1, inputs: null });
  assert.equal(result.state.lifecycle, 'UNRESOLVED');
  assert.deepEqual(result.outputs, []);
  for (let index = 0; index < before.dimensions.length; index += 1) {
    for (const field of ['filteredQ48', 'deviationQ48', 'burdenLowQ48', 'burdenHighQ48', 'adaptedCenterQ48', 'lifetimeDriftQ48']) {
      assert.equal(result.state.dimensions[index][field], before.dimensions[index][field]);
    }
    assert.equal(result.state.dimensions[index].quality, 'UNKNOWN');
  }
});

test('HOMEOS-R04 persistent deficit accumulates burden but cannot normalize the founder center', () => {
  const metabEngine = metab();
  const engine = homeos();
  const founderCenters = engine.snapshot().dimensions.map(dimension => dimension.adaptedCenterQ48);
  for (let sourceFrame = 1; sourceFrame <= 24; sourceFrame += 1) {
    const inputs = metabInputs(metabEngine, sourceFrame, '0');
    engine.advance({ frameIndex: sourceFrame + 1, inputs });
  }
  const state = engine.snapshot();
  assert.equal(state.dimensions.some(dimension => q48.parseRaw(dimension.burdenLowQ48) > 0n), true);
  assert.deepEqual(state.dimensions.map(dimension => dimension.adaptedCenterQ48), founderCenters);
  assert.deepEqual(state.dimensions.map(dimension => dimension.lifetimeDriftQ48), ['0', '0']);
});

test('HOMEOS-R05 same-frame METAB feedback is rejected without changing HOMEOS', () => {
  const inputs = metabInputs(metab(), 1);
  const engine = homeos();
  const before = stableStringify(engine.snapshot());
  assert.throws(() => engine.advance({ frameIndex: 1, inputs }), { code: 'P1_HOMEOS_INPUT_DELAY' });
  assert.equal(stableStringify(engine.snapshot()), before);
});

test('HOMEOS-R06 duplicate replay advances neither state, cursor nor output', () => {
  const inputs = metabInputs(metab(), 1);
  const engine = homeos();
  engine.advance({ frameIndex: 2, inputs });
  const before = stableStringify(engine.snapshot());
  const duplicate = engine.advance({ frameIndex: 2, inputs });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.outputs, []);
  assert.equal(stableStringify(engine.snapshot()), before);
});

test('HOMEOS-R07 rollback cannot erase burden or restore an older acquired state', () => {
  const inputs = metabInputs(metab(), 1, '0');
  const engine = homeos();
  const old = engine.snapshot();
  engine.advance({ frameIndex: 2, inputs });
  assert.throws(() => engine.restore(old), { code: 'P1_HOMEOS_REWIND' });
});

test('HOMEOS-R08 SHADOW METAB ancestry remains SHADOW and never becomes authoritative pressure', () => {
  const inputs = metabInputs(metab(), 1, '0');
  const result = homeos().advance({ frameIndex: 2, inputs });
  assert.equal(result.outputs.every(frame => frame.producer.mode === 'SHADOW'), true);
  assert.equal(result.outputs.every(frame => frame.causalSpan.containsShadow === true), true);
  assert.equal(result.outputs.every(frame => frame.causalSpan.ancestors.every(ancestor => ancestor.mode === 'SHADOW')), true);
});

test('HOMEOS-R09 UI and chip fields are outside the engine schema and yield zero biological delta', () => {
  const inputs = metabInputs(metab(), 1);
  const engine = homeos();
  const before = stableStringify(engine.snapshot());
  assert.throws(() => engine.advance({ frameIndex: 2, inputs, chipState: 'LIVE' }), { code: 'P1_HOMEOS_ENGINE_SCHEMA' });
  assert.equal(stableStringify(engine.snapshot()), before);
});

test('HOMEOS-R10 unreviewed temperature-like dimensions are rejected without a successor dossier', () => {
  const invalid = JSON.parse(JSON.stringify(profiles.HOMEOS));
  invalid.dimensions[0].dimensionId = 'temperature';
  assert.throws(() => homeos({ profile: invalid }), { code: 'P1_HOMEOS_PROFILE_SOURCE' });
});

test('HOMEOS-Q01 HOMEOS consumes actual METAB committed frames and publishes no earlier than the following frame', () => {
  const inputs = metabInputs(metab(), 1);
  const result = homeos().advance({ frameIndex: 2, inputs });
  assert.equal(inputs.every(frame => frame.committedFrame === 1 && frame.visibleFromFrame === 2), true);
  assert.equal(result.outputs.every(frame => frame.committedFrame === 2 && frame.visibleFromFrame === 3), true);
});

test('HOMEOS-Q02 NEUTRAL computes contained acquired state but emits zero frames', () => {
  const neutral = homeos({
    identity: {
      organismId: 'stay-p1-r0-test',
      founderLineageId: 'lineage-homeos-0001',
      residencyId: 'resident:homeos',
      coreVersion: '0.1.0-lab',
      authorityEpoch: '0',
      mode: 'NEUTRAL'
    }
  });
  const result = neutral.advance({ frameIndex: 2, inputs: metabInputs(metab(), 1) });
  assert.equal(result.state.frameIndex, 2);
  assert.deepEqual(result.outputs, []);
});

test('HOMEOS-Q03 laboratory HOMEOS owns zero authority and cannot instantiate LIVE', () => {
  assert.throws(() => homeos({
    identity: {
      organismId: 'stay-p1-r0-test',
      founderLineageId: 'lineage-homeos-0001',
      residencyId: 'resident:homeos',
      coreVersion: '0.1.0-lab',
      authorityEpoch: '0',
      mode: 'LIVE'
    }
  }), { code: 'P1_HOMEOS_AUTHORITY' });
});

test('HOMEOS-Q04 identical METAB evidence produces byte-identical HOMEOS state and summaries', () => {
  const inputs = metabInputs(metab(), 1, '0.5');
  assert.equal(
    stableStringify(homeos().advance({ frameIndex: 2, inputs })),
    stableStringify(homeos().advance({ frameIndex: 2, inputs }))
  );
});

test('HOMEOS-Q05 implementation has no wall clock, RNG, StateStore, UI or attachment path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'p1-r0', 'homeos-engine.js'), 'utf8');
  assert.doesNotMatch(source, /\bDate[.(]|\bperformance\.|\bMath\.random|\brandomBytes/);
  assert.doesNotMatch(source, /state-store|continuity\.sqlite|chip-projection|live-bridge|resident-manager/i);
});
