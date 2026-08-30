'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { stableStringify } = require('../runtime/kernel/canonical-json');
const q48 = require('../runtime/p1-r0/q16-48');
const {
  contract,
  validateHomeosInputFrame,
  collectHomeosInputs,
  validateHomeosFounderProfile
} = require('../runtime/p1-r0/homeos-contract');
const profiles = require('../runtime/p1-r0/c0-source-contracts/contracts/founder_profile_templates.json').profiles;

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function sourceFrame(kind, overrides = {}) {
  const reserve = kind === 'reserve';
  const payload = overrides.payload || (reserve ? {
    reserveQ48: q48.fromDecimal('0.5').toString(),
    reserveFractionQ48: q48.fromDecimal('0.5').toString(),
    trendQ48PerSecond: '0',
    cumulativeChargeQ48: '0',
    cumulativeDischargeQ48: '0',
    confidenceQ48: q48.SCALE.toString()
  } : {
    availabilityQ48: q48.fromDecimal('0.8').toString(),
    debtQ48: '0',
    scarcityState: 'BALANCED',
    confidenceQ48: q48.SCALE.toString(),
    coverageQ48: q48.SCALE.toString()
  });
  const suffix = reserve ? 'reserve' : 'availability';
  const base = {
    frameVersion: 'stay-p1-r0-causal-frame-v1',
    frameId: `sha256:${reserve ? '2' : '1'}`.padEnd(71, reserve ? '2' : '1'),
    organismId: 'stay-p1-r0-test',
    founderLineageId: 'lineage-metab-0001',
    producer: {
      coreId: 'METAB',
      residencyId: 'resident:metab',
      coreVersion: '0.1.0-lab',
      authorityEpoch: '0',
      mode: 'SHADOW',
      lifecycle: 'RUNNING'
    },
    route: {
      routeId: `p1r0.metab-${suffix}.homeos`,
      consumerCoreId: 'HOMEOS',
      routeVersion: '1'
    },
    topic: {
      name: `metab.energy.${suffix}.v1`,
      class: 'SUMMARY',
      schemaId: `urn:stay:p1-r0:schema:metab-energy-${suffix}-payload:v1`,
      schemaVersion: '1',
      unit: 'ratio',
      scale: 'Q16.48'
    },
    producerSequence: reserve ? '2' : '1',
    committedFrame: 40,
    visibleFromFrame: 41,
    sourceWindow: { startFrame: 39, endFrame: 40 },
    causalSpan: {
      earliestFrame: 39,
      latestFrame: 40,
      containsNeutral: false,
      containsShadow: false,
      ancestors: []
    },
    quality: {
      status: 'ACCEPT',
      confidenceQ48: q48.SCALE.toString(),
      coverageQ48: q48.SCALE.toString(),
      reasons: []
    },
    expiresAtFrame: null,
    payload,
    payloadHash: hash(payload)
  };
  return { ...base, ...overrides, payload, payloadHash: overrides.payloadHash || hash(payload) };
}

test('P1R0-HC-01 HOMEOS contract fixes two canonical SHADOW METAB sources', () => {
  assert.equal(contract.routeStage, 'ABSENT');
  assert.equal(contract.consumerDelayFrames, 1);
  assert.deepEqual(contract.sources.map(source => source.key), ['availability', 'reserve']);
  assert.equal(contract.sources.every(source => source.producer === 'METAB' && source.producerMode === 'SHADOW'), true);
  assert.equal(Object.isFrozen(contract), true);
});

test('P1R0-HC-02 committed METAB availability and reserve become visible to HOMEOS only in the next frame', () => {
  assert.throws(() => validateHomeosInputFrame(sourceFrame('availability'), 40), { code: 'P1_HOMEOS_INPUT_DELAY' });
  assert.equal(validateHomeosInputFrame(sourceFrame('availability'), 41).source, 'availability');
  const collected = collectHomeosInputs([sourceFrame('availability'), sourceFrame('reserve')], 41);
  assert.equal(collected.committedFrame, 40);
  assert.equal(collected.consumerFrame, 41);
  assert.equal(collected.evidence.length, 2);
});

test('P1R0-HC-03 missing, duplicate and cross-generation METAB evidence fail closed', () => {
  assert.throws(() => collectHomeosInputs([sourceFrame('availability')], 41), { code: 'P1_HOMEOS_INPUT_COVERAGE' });
  assert.throws(() => collectHomeosInputs([sourceFrame('availability'), sourceFrame('availability')], 41), { code: 'P1_HOMEOS_INPUT_CONFLICT' });
  assert.throws(() => collectHomeosInputs([
    sourceFrame('availability'),
    sourceFrame('reserve', { producer: { ...sourceFrame('reserve').producer, authorityEpoch: '1' } })
  ], 41), { code: 'P1_HOMEOS_INPUT_COHERENCE' });
});

test('P1R0-HC-04 payloads are closed and cannot smuggle owner/viewer or organ semantics', () => {
  const original = sourceFrame('availability');
  const payload = { ...original.payload, viewerId: 'forbidden' };
  assert.throws(() => validateHomeosInputFrame(sourceFrame('availability', { payload }), 41), { code: 'P1_HOMEOS_INPUT_SCHEMA' });
  assert.equal(contract.forbiddenHomeosSemantics.includes('heartRate'), true);
  assert.equal(contract.forbiddenHomeosSemantics.includes('respiratoryRate'), true);
});

test('P1R0-HC-05 frame quality and payload quality must agree exactly', () => {
  const original = sourceFrame('availability');
  const payload = { ...original.payload, confidenceQ48: q48.fromDecimal('0.5').toString() };
  assert.throws(() => validateHomeosInputFrame(sourceFrame('availability', { payload }), 41), { code: 'P1_HOMEOS_INPUT_QUALITY' });
  assert.throws(() => validateHomeosInputFrame(sourceFrame('reserve', {
    quality: { ...sourceFrame('reserve').quality, status: 'UNKNOWN', reasons: ['SOURCE_GAP'] }
  }), 41), { code: 'P1_HOMEOS_INPUT_UNKNOWN' });
});

test('P1R0-HC-06 founder profile binds each HOMEOS dimension to one METAB summary', () => {
  assert.equal(validateHomeosFounderProfile(profiles.HOMEOS).profileId, 'homeos.p1-r0.normalized-lab.v1');
  const duplicate = JSON.parse(JSON.stringify(profiles.HOMEOS));
  duplicate.dimensions[1].source = { ...duplicate.dimensions[0].source };
  assert.throws(() => validateHomeosFounderProfile(duplicate), { code: 'P1_HOMEOS_PROFILE_SOURCE' });
});
