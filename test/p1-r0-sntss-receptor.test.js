'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const q48 = require('../runtime/p1-r0/q16-48');
const { ROUTES } = require('../runtime/p1-r0/contract-registry');
const { sha256 } = require('../runtime/p1-r0/resident-support');
const {
  RECEPTOR_CONTRACT,
  createSntssInteroReceptor
} = require('../runtime/p1-r0/sntss-receptor');

function candidateBodyFrame() {
  const payload = {
    frameFrontier: 4,
    frameIndex: 4,
    channels: [],
    axes: [],
    profileHash: `sha256:${'a'.repeat(64)}`,
    requiredCoverageQ48: q48.SCALE.toString(),
    transformVersion: 'splitmix64-fnv1a64-q0.48-triangular-v1'
  };
  const withoutId = {
    frameVersion: 'stay-p1-r0-causal-frame-v1',
    organismId: 'stay-p1-r0-receptor-test',
    founderLineageId: 'lineage-intero-0001',
    producer: {
      coreId: 'INTERO',
      residencyId: 'resident:intero',
      coreVersion: '0.1.0-p1r0-lab',
      authorityEpoch: '0',
      mode: 'SHADOW',
      lifecycle: 'SENSING'
    },
    route: {
      routeId: 'p1r0.intero.sntss-receptor',
      consumerCoreId: 'SNTSS_RECEPTOR_P1_R0',
      routeVersion: '1'
    },
    topic: {
      name: 'intero.body.frame.v1',
      class: 'SUMMARY',
      schemaId: 'urn:stay:p1-r0:schema:intero-body-frame-payload:v1',
      schemaVersion: '1',
      unit: 'body-vector',
      scale: 'Q16.48'
    },
    producerSequence: '1',
    committedFrame: 4,
    visibleFromFrame: 5,
    sourceWindow: { startFrame: 1, endFrame: 2 },
    causalSpan: {
      earliestFrame: 1,
      latestFrame: 2,
      containsNeutral: false,
      containsShadow: true,
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
    payloadHash: sha256(payload)
  };
  return { frameId: sha256(withoutId), ...withoutId };
}

test('P1-SNTSS-R01 exactly one bounded, revocable, zero-authority receptor is declared', () => {
  assert.deepEqual(Object.keys(RECEPTOR_CONTRACT).sort(), [
    'authorityEpoch', 'bufferCapacity', 'consumerCoreId', 'maximumPayloadBytes',
    'outputs', 'ownerCoreId', 'producerCoreId', 'productionEligible', 'receptorId',
    'revocable', 'routeId', 'routeStage', 'topic'
  ]);
  assert.equal(RECEPTOR_CONTRACT.routeStage, 'ABSENT');
  assert.equal(RECEPTOR_CONTRACT.revocable, true);
  assert.equal(RECEPTOR_CONTRACT.bufferCapacity, 16);
  assert.equal(RECEPTOR_CONTRACT.authorityEpoch, '0');
  assert.deepEqual(RECEPTOR_CONTRACT.outputs, []);
});

test('P1-SNTSS-R02 a valid contained body frame cannot cross the absent route', () => {
  const receptor = createSntssInteroReceptor();
  const before = receptor.snapshot();
  assert.throws(() => receptor.receive(candidateBodyFrame()), { code: 'P1_SNTSS_RECEPTOR_ABSENT' });
  assert.deepEqual(receptor.snapshot(), before);
  assert.deepEqual(receptor.health(), {
    ok: true,
    routeStage: 'ABSENT',
    revocable: true,
    bufferDepth: 0,
    bufferCapacity: 16,
    authorityOwned: false,
    outputCount: 0
  });
});

test('P1-SNTSS-R03 revocation is persistent and never creates an activation path', () => {
  const receptor = createSntssInteroReceptor();
  const revoked = receptor.revoke();
  assert.equal(revoked.revocationGeneration, 1);
  assert.equal(revoked.routeStage, 'ABSENT');
  assert.deepEqual(revoked.buffer, []);
  const restarted = createSntssInteroReceptor({ initialState: revoked });
  assert.equal(restarted.snapshot().revocationGeneration, 1);
  assert.throws(() => restarted.receive(candidateBodyFrame()), { code: 'P1_SNTSS_RECEPTOR_ABSENT' });
});

test('P1-SNTSS-R04 route registry and production SNTSS remain unmodified and disconnected', () => {
  assert.equal(ROUTES[RECEPTOR_CONTRACT.routeId].stage, 'ABSENT');
  assert.equal(ROUTES[RECEPTOR_CONTRACT.routeId].revocable, true);
  const productionSntss = fs.readFileSync(
    path.join(__dirname, '..', 'cores', 'sntss', 'i4g', 'index.js'),
    'utf8'
  );
  assert.doesNotMatch(productionSntss, /p1-r0|intero\.body\.frame|sntss\.receptor\.intero/i);
});
