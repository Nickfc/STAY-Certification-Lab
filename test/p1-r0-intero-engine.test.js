'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const q48 = require('../runtime/p1-r0/q16-48');
const { triangularQ0_48 } = require('../runtime/p1-r0/deterministic-noise');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const { ROUTES } = require('../runtime/p1-r0/contract-registry');
const { createMetabEngine } = require('../runtime/p1-r0/metab-engine');
const { createHomeosEngine } = require('../runtime/p1-r0/homeos-engine');
const { createInteroEngine } = require('../runtime/p1-r0/intero-engine');
const profiles = require('../runtime/p1-r0/c0-source-contracts/contracts/founder_profile_templates.json').profiles;

function identity(coreId, mode = 'SHADOW') {
  return {
    organismId: 'stay-p1-r0-test',
    founderLineageId: `lineage-${coreId.toLowerCase()}-0001`,
    residencyId: `resident:${coreId.toLowerCase()}`,
    coreVersion: '0.1.0-lab',
    authorityEpoch: '0',
    mode
  };
}

function metab() {
  return createMetabEngine({ profile: profiles.METAB, identity: identity('METAB') });
}

function homeos() {
  return createHomeosEngine({ profile: profiles.HOMEOS, identity: identity('HOMEOS') });
}

function intero(overrides = {}) {
  return createInteroEngine({
    profile: profiles.INTERO,
    identity: identity('INTERO'),
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

function committedInputs(metabEngine, homeosEngine, sourceFrame, eligible = '1') {
  const metabResult = metabEngine.advance(capacity(sourceFrame, eligible));
  const homeosResult = homeosEngine.advance({
    frameIndex: sourceFrame + 1,
    inputs: metabResult.outputs.filter(frame => frame.route.consumerCoreId === 'HOMEOS')
  });
  return [
    ...metabResult.outputs.filter(frame => frame.route.consumerCoreId === 'INTERO'),
    ...homeosResult.outputs.filter(frame => frame.route.routeId === 'p1r0.homeos-stability.intero')
  ];
}

function firstInputs(eligible = '1') {
  return committedInputs(metab(), homeos(), 1, eligible);
}

test('INTERO-R01 two canonical producers for one channel are rejected before state mutation', () => {
  const invalid = JSON.parse(JSON.stringify(profiles.INTERO));
  invalid.channels[1].channelId = invalid.channels[0].channelId;
  invalid.channels[1].source = { ...invalid.channels[0].source };
  assert.throws(() => intero({ profile: invalid }), { code: 'P1_INTERO_PROFILE_SOURCE' });

  const inputs = firstInputs();
  const engine = intero();
  const before = stableStringify(engine.snapshot());
  assert.throws(() => engine.advance({ frameIndex: 4, inputs: [inputs[0], inputs[0], inputs[2]] }), {
    code: 'P1_INTERO_INPUT_CONFLICT'
  });
  assert.equal(stableStringify(engine.snapshot()), before);
});

test('INTERO-R02 INTERO has no source database, checkpoint or private-memory read path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'p1-r0', 'intero-engine.js'), 'utf8');
  const contractSource = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'p1-r0', 'intero-contract.js'), 'utf8');
  assert.doesNotMatch(source + contractSource, /state-store|continuity\.sqlite|checkpoint|privateMemory|directSource/i);
});

test('INTERO-R03 same-frame and under-delayed evidence are rejected without biological delta', () => {
  const inputs = firstInputs();
  const engine = intero();
  const before = stableStringify(engine.snapshot());
  assert.throws(() => engine.advance({ frameIndex: 3, inputs }), { code: 'P1_INTERO_INPUT_DELAY' });
  assert.equal(stableStringify(engine.snapshot()), before);
  const invalid = JSON.parse(JSON.stringify(profiles.INTERO));
  invalid.channels[0].delayFrames = -1;
  assert.throws(() => intero({ profile: invalid }), { code: 'P1_INTERO_PROFILE_SOURCE' });
});

test('INTERO-R04 missing evidence freezes perception and becomes explicit UNRESOLVED', () => {
  const engine = intero();
  const before = engine.snapshot();
  const result = engine.advance({ frameIndex: 1, inputs: null });
  assert.equal(result.state.lifecycle, 'UNRESOLVED');
  assert.equal(result.projection, null);
  assert.deepEqual(result.outputs, []);
  for (let index = 0; index < before.channels.length; index += 1) {
    for (const field of [
      'delayRingHash', 'delayIndex', 'filteredQ48', 'trendQ48', 'baselineQ48',
      'lifetimeDriftQ48', 'persistenceQ48', 'salienceQ48', 'sourceSequence'
    ]) assert.equal(result.state.channels[index][field], before.channels[index][field]);
    assert.equal(result.state.channels[index].quality, 'UNKNOWN');
  }
});

test('INTERO-R05 exact SplitMix64 transform determines the first perceived availability', () => {
  const inputs = firstInputs();
  const result = intero().advance({ frameIndex: 4, inputs });
  const descriptor = profiles.INTERO.channels.find(channel => channel.channelId === 'energy.availability');
  const input = inputs.find(frame => frame.route.routeId === 'p1r0.metab-availability.intero');
  const vector = triangularQ0_48({
    noiseKeyHex: profiles.INTERO.noiseKeyHex,
    channelId: descriptor.channelId,
    frameIndex: 4
  });
  const noise = q48.mul(q48.parseRaw(descriptor.imperfectionAmplitudeQ48), q48.parseRaw(vector.differenceQ0_48Raw));
  const perceived = q48.clamp(
    q48.quantize(q48.parseRaw(input.payload.availabilityQ48) + noise, q48.parseRaw(descriptor.resolutionQ48)),
    q48.parseRaw(descriptor.sourceLowQ48),
    q48.parseRaw(descriptor.sourceHighQ48)
  );
  const founder = q48.parseRaw(descriptor.founderBaselineQ48);
  const expected = founder + q48.mul(q48.parseRaw(descriptor.alphaQ48), perceived - founder);
  assert.equal(result.state.channels[0].filteredQ48, expected.toString());
});

test('INTERO-R06 duplicate replay advances no ring, counter, persistence, cursor or output', () => {
  const inputs = firstInputs();
  const engine = intero();
  engine.advance({ frameIndex: 4, inputs });
  const before = stableStringify(engine.snapshot());
  const duplicate = engine.advance({ frameIndex: 4, inputs });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.projection, null);
  assert.deepEqual(duplicate.outputs, []);
  assert.equal(stableStringify(engine.snapshot()), before);
});

test('INTERO-R07 chronic scarcity accumulates persistence and cannot adapt the founder baseline away', () => {
  const metabEngine = metab();
  const homeosEngine = homeos();
  const engine = intero();
  const founderBaselines = engine.snapshot().channels.map(channel => channel.baselineQ48);
  for (let sourceFrame = 1; sourceFrame <= 24; sourceFrame += 1) {
    const inputs = committedInputs(metabEngine, homeosEngine, sourceFrame, '0');
    engine.advance({ frameIndex: sourceFrame + 3, inputs });
  }
  const state = engine.snapshot();
  assert.equal(state.channels.some(channel => q48.parseRaw(channel.persistenceQ48) > 0n), true);
  assert.deepEqual(state.channels.map(channel => channel.baselineQ48), founderBaselines);
  assert.deepEqual(state.channels.map(channel => channel.lifetimeDriftQ48), ['0', '0', '0']);
});

test('INTERO-R08 SHADOW ancestry remains contained and cannot reach SNTSS', () => {
  const result = intero().advance({ frameIndex: 4, inputs: firstInputs('0.5') });
  assert.equal(result.state.channels.every(channel => channel.quality === 'ACCEPT'), true);
  assert.ok(result.projection);
  assert.deepEqual(result.outputs, []);
  assert.equal(ROUTES['p1r0.intero.sntss-receptor'].stage, 'ABSENT');
});

test('INTERO-R09 body projection contains no emotion, diagnosis, cause, self or action semantics', () => {
  const projection = intero().advance({ frameIndex: 4, inputs: firstInputs() }).projection;
  assert.doesNotMatch(stableStringify(projection), /fear|pain|hunger|emotion|diagnosis|cause|self|action/i);
});

test('INTERO-R10 UI and chip fields are outside the engine schema and yield zero biological delta', () => {
  const engine = intero();
  const before = stableStringify(engine.snapshot());
  assert.throws(() => engine.advance({ frameIndex: 4, inputs: firstInputs(), chipState: 'LIVE' }), {
    code: 'P1_INTERO_ENGINE_SCHEMA'
  });
  assert.equal(stableStringify(engine.snapshot()), before);
});

test('INTERO-Q01 consumes real committed METAB/HOMEOS frames only after 2/3/2 founder delays', () => {
  const inputs = firstInputs();
  assert.deepEqual(inputs.map(frame => frame.committedFrame).sort(), [1, 1, 2]);
  const result = intero().advance({ frameIndex: 4, inputs });
  assert.equal(result.state.frameIndex, 4);
  assert.equal(result.projection.bodyFrame.frameIndex, 4);
});

test('INTERO-Q02 contained body frame and summary preserve the closed C0 payload shapes', () => {
  const projection = intero().advance({ frameIndex: 4, inputs: firstInputs() }).projection;
  assert.deepEqual(Object.keys(projection.bodyFrame).sort(), [
    'axes', 'channels', 'frameFrontier', 'frameIndex', 'profileHash', 'requiredCoverageQ48', 'transformVersion'
  ]);
  assert.deepEqual(Object.keys(projection.bodySummary).sort(), [
    'axisBands', 'confidenceQ48', 'coverageQ48', 'validChannelCount'
  ]);
  assert.equal(projection.bodyFrame.channels.length, 3);
  assert.equal(projection.bodyFrame.axes.length, 2);
});

test('INTERO-Q03 NEUTRAL may compute contained perception but emits no routed evidence', () => {
  const result = intero({ identity: identity('INTERO', 'NEUTRAL') }).advance({ frameIndex: 4, inputs: firstInputs() });
  assert.ok(result.projection);
  assert.deepEqual(result.outputs, []);
});

test('INTERO-Q04 laboratory INTERO owns zero authority and cannot instantiate LIVE', () => {
  assert.throws(() => intero({ identity: identity('INTERO', 'LIVE') }), { code: 'P1_INTERO_AUTHORITY' });
  assert.throws(() => intero({ identity: { ...identity('INTERO'), authorityEpoch: '1' } }), { code: 'P1_INTERO_AUTHORITY' });
});

test('INTERO-Q05 rollback cannot restore an older acquired perception state', () => {
  const engine = intero();
  const old = engine.snapshot();
  engine.advance({ frameIndex: 4, inputs: firstInputs() });
  assert.throws(() => engine.restore(old), { code: 'P1_INTERO_REWIND' });
});

test('INTERO-Q06 identical delayed frames produce byte-identical state and projection', () => {
  const inputs = firstInputs('0.5');
  assert.equal(
    stableStringify(intero().advance({ frameIndex: 4, inputs })),
    stableStringify(intero().advance({ frameIndex: 4, inputs }))
  );
});

test('INTERO-Q07 implementation has no wall clock, platform RNG, StateStore, UI or attachment path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'p1-r0', 'intero-engine.js'), 'utf8');
  assert.doesNotMatch(source, /\bDate[.(]|\bperformance\.|\bMath\.random|\brandomBytes/);
  assert.doesNotMatch(source, /state-store|continuity\.sqlite|chip-projection|live-bridge|resident-manager/i);
});

test('INTERO-Q08 all three source routes and the receptor route remain ABSENT and revocable', () => {
  for (const routeId of [
    'p1r0.metab-availability.intero',
    'p1r0.metab-reserve.intero',
    'p1r0.homeos-stability.intero',
    'p1r0.intero.sntss-receptor'
  ]) {
    assert.equal(ROUTES[routeId].stage, 'ABSENT');
    assert.equal(ROUTES[routeId].revocable, true);
  }
});
