'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  FORENSIC_READ_CAPABILITY,
  hash,
  verifyForensicBundle,
  explainTransition,
  SntssObservabilityPlane
} = require('../runtime/kernel/sntss-observability');

const PROFILE = hash({ profile: 'stay-sntss-human-v1' });
const ANCHOR = hash({ checkpoint: 'checkpoint-42', audit: 'audit-head-42' });
const AUDIT = hash({ audit: 'head-43' });
const BEFORE = hash({ state: 'before' });
const AFTER = hash({ state: 'after' });

function transition(overrides = {}) {
  return {
    transitionId: 'transition-43',
    observedAtMs: 123456789,
    input: { eventId: 'evt-43', sequence: 43, topic: 'presence.changed', status: 'accepted', reasonCode: 'SNTSS_ACCEPTED' },
    beforeStateHash: BEFORE,
    afterStateHash: AFTER,
    clamps: ['dose.max'],
    circuitChanges: ['presence.source.closed'],
    migrations: [],
    emittedFrameIds: ['frame-43'],
    evidenceCursor: 43,
    profileHash: PROFILE,
    candidateVersion: '0.1.0',
    checkpointHash: hash({ checkpoint: 43 }),
    auditHeadHash: AUDIT,
    ...overrides
  };
}

function populatedPlane(options = {}) {
  const plane = new SntssObservabilityPlane({ anchorHash: ANCHOR, ...options });
  assert.equal(plane.capture(transition()).captured, true);
  assert.equal(plane.capture(transition({
    transitionId: 'transition-44', observedAtMs: 123456790,
    input: { eventId: 'evt-44', sequence: 44, topic: 'presence.changed', status: 'rejected', reasonCode: 'SNTSS_COOLDOWN' },
    beforeStateHash: AFTER, afterStateHash: hash({ state: 'after-44' }), evidenceCursor: 44,
    clamps: [], circuitChanges: [], emittedFrameIds: []
  })).captured, true);
  return plane;
}

test('R9-01 public summary is bounded and cannot expose forensic identifiers or private state', () => {
  const plane = populatedPlane();
  const summary = plane.publicSummary();
  const encoded = JSON.stringify(summary);
  assert.equal(summary.transitionCount, 2);
  assert.equal(summary.acceptedCount, 1);
  assert.equal(summary.rejectedCount, 1);
  for (const forbidden of ['evt-43', 'presence.changed', 'SNTSS_ACCEPTED', BEFORE, AFTER, PROFILE, 'frame-43']) {
    assert.equal(encoded.includes(forbidden), false);
  }
  assert.ok(Buffer.byteLength(encoded) < 2048);
});

test('R9-02 routine operator health has diagnostic hashes/reasons but no raw event identity or internal values', () => {
  const plane = populatedPlane();
  const health = plane.operatorHealth();
  const encoded = JSON.stringify(health);
  assert.equal(health.ok, true);
  assert.equal(typeof health.chainHeadHash, 'string');
  assert.equal(health.lastReasonCode, 'SNTSS_COOLDOWN');
  for (const forbidden of ['evt-43', 'evt-44', 'presence.changed', BEFORE, AFTER, 'frame-43']) assert.equal(encoded.includes(forbidden), false);
});

test('R9-03 raw payload/private fields fail closed and observability failure does not throw into chemistry', () => {
  const plane = new SntssObservabilityPlane({ anchorHash: ANCHOR });
  const sourceState = Object.freeze({ chemistry: Object.freeze({ serotonin: 777 }) });
  const result = plane.capture({ ...transition(), payload: { privilegedMessage: 'never log me' } });
  assert.equal(result.captured, false);
  assert.equal(result.code, 'SNTSS_PRIVATE_FIELD');
  assert.deepEqual(sourceState, { chemistry: { serotonin: 777 } });
  assert.equal(plane.operatorHealth().telemetryDrops, 1);
});

test('R9-04 forensic access requires the explicit read capability', () => {
  const plane = populatedPlane();
  assert.throws(() => plane.forensicBundle(), error => error.code === 'SNTSS_FORENSIC_ACCESS');
  assert.throws(() => plane.forensicBundle('operator.read'), error => error.code === 'SNTSS_FORENSIC_ACCESS');
  assert.equal(plane.forensicBundle(FORENSIC_READ_CAPABILITY).records.length, 2);
});

test('R9-05 cryptographic chain detects alteration', () => {
  const plane = populatedPlane();
  const bundle = plane.forensicBundle(FORENSIC_READ_CAPABILITY);
  assert.equal(verifyForensicBundle(bundle, { expectedAnchorHash: ANCHOR, expectedCount: 2 }).ok, true);
  bundle.records[0].input.reasonCode = 'SNTSS_FORGED';
  assert.throws(() => verifyForensicBundle(bundle, { expectedAnchorHash: ANCHOR, expectedCount: 2 }), error => error.code === 'SNTSS_FORENSIC_TAMPER');
});

test('R9-06 forensic replay detects omission and reordering', () => {
  const plane = new SntssObservabilityPlane({ anchorHash: ANCHOR });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(plane.capture(transition({
      transitionId: `transition-${index + 1}`, observedAtMs: 1000 + index,
      input: { eventId: `evt-${index + 1}`, sequence: index + 1, topic: 'presence.changed', status: 'accepted', reasonCode: 'SNTSS_ACCEPTED' },
      evidenceCursor: index + 1
    })).captured, true);
  }
  const omitted = plane.forensicBundle(FORENSIC_READ_CAPABILITY);
  omitted.records.splice(1, 1);
  assert.throws(() => verifyForensicBundle(omitted, { expectedAnchorHash: ANCHOR, expectedCount: 3 }), error => ['SNTSS_FORENSIC_CHAIN', 'SNTSS_FORENSIC_SEQUENCE', 'SNTSS_FORENSIC_COUNT'].includes(error.code));
  const reordered = plane.forensicBundle(FORENSIC_READ_CAPABILITY);
  [reordered.records[0], reordered.records[1]] = [reordered.records[1], reordered.records[0]];
  assert.throws(() => verifyForensicBundle(reordered, { expectedAnchorHash: ANCHOR, expectedCount: 3 }), error => ['SNTSS_FORENSIC_CHAIN', 'SNTSS_FORENSIC_SEQUENCE'].includes(error.code));
});

test('R9-07 candidate/profile mismatch blocks forensic explanation', () => {
  const plane = populatedPlane();
  const bundle = plane.forensicBundle(FORENSIC_READ_CAPABILITY);
  assert.throws(() => verifyForensicBundle(bundle, { expectedAnchorHash: ANCHOR, expectedCandidateVersion: '0.2.0' }), error => error.code === 'SNTSS_FORENSIC_CANDIDATE');
  assert.throws(() => verifyForensicBundle(bundle, { expectedAnchorHash: ANCHOR, expectedProfileHash: hash({ wrong: true }) }), error => error.code === 'SNTSS_FORENSIC_PROFILE');
});

test('R9-08 explanation is deterministic and references hashes/IDs rather than private payloads', () => {
  const plane = populatedPlane();
  const bundle = plane.forensicBundle(FORENSIC_READ_CAPABILITY);
  const expected = { expectedAnchorHash: ANCHOR, expectedCandidateVersion: '0.1.0', expectedProfileHash: PROFILE };
  const first = explainTransition(bundle, 'transition-43', expected);
  const second = explainTransition(bundle, 'transition-43', expected);
  assert.deepEqual(first, second);
  assert.equal(first.input.eventId, 'evt-43');
  assert.equal(first.stateBeforeHash, BEFORE);
  assert.equal(first.stateAfterHash, AFTER);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'payload'), false);
});

test('R9-09 telemetry sink failure degrades observability only and never becomes a state-control exception', () => {
  let sinkCalls = 0;
  const plane = new SntssObservabilityPlane({ anchorHash: ANCHOR, sink() { sinkCalls += 1; throw new Error('disk offline'); } });
  const chemistry = { concentration: 123, authority: 'sntss' };
  const before = JSON.stringify(chemistry);
  const result = plane.capture(transition());
  assert.equal(result.captured, true);
  assert.equal(sinkCalls, 1);
  assert.equal(JSON.stringify(chemistry), before);
  const health = plane.operatorHealth();
  assert.equal(health.ok, false);
  assert.equal(health.sinkFailures, 1);
  assert.ok(health.alerts.includes('SNTSS_TELEMETRY_SINK_FAILED'));
});

test('R9-10 rotation is bounded and preserves a cryptographic segment manifest', () => {
  const plane = new SntssObservabilityPlane({ anchorHash: ANCHOR, forensicCapacity: 8, segmentCapacity: 2 });
  for (let index = 0; index < 10; index += 1) {
    assert.equal(plane.capture(transition({
      transitionId: `transition-${100 + index}`, observedAtMs: 2000 + index,
      input: { eventId: `evt-${100 + index}`, sequence: 100 + index, topic: 'presence.changed', status: 'accepted', reasonCode: 'SNTSS_ACCEPTED' },
      evidenceCursor: 100 + index
    })).captured, true);
  }
  const bundle = plane.forensicBundle(FORENSIC_READ_CAPABILITY);
  assert.equal(bundle.segments.length, 1);
  assert.equal(bundle.segments[0].recordCount, 8);
  assert.equal(bundle.records.length, 2);
  assert.equal(bundle.currentAnchorSequence, 8);
  assert.equal(verifyForensicBundle(bundle, { expectedCount: 10, expectedCandidateVersion: '0.1.0', expectedProfileHash: PROFILE }).ok, true);
});

test('R9-11 observer surface exposes no command, mutation or chemistry-control API', () => {
  const names = Object.getOwnPropertyNames(SntssObservabilityPlane.prototype).filter(name => name !== 'constructor');
  const forbidden = names.filter(name => /command|apply|mutate|stimulate|setChem|inject|dose/i.test(name));
  assert.deepEqual(forbidden, []);
  assert.ok(names.includes('capture'));
  assert.ok(names.includes('publicSummary'));
  assert.ok(names.includes('operatorHealth'));
  assert.ok(names.includes('forensicBundle'));
});

test('R9-12 retained forensic records contain only the schema whitelist and never the original event payload', () => {
  const plane = populatedPlane();
  const bundle = plane.forensicBundle(FORENSIC_READ_CAPABILITY);
  const encoded = JSON.stringify(bundle.records);
  assert.equal(encoded.includes('privilegedMessage'), false);
  assert.equal(encoded.includes('dreamContent'), false);
  assert.equal(encoded.includes('memoryContent'), false);
  assert.equal(encoded.includes('rawState'), false);
  assert.ok(encoded.includes('beforeHash'));
  assert.ok(encoded.includes('afterHash'));
});

test('R9-13 committed evidence is hash-consistent with controlling implementation, tests and schemas', () => {
  const root = path.resolve(__dirname, '..');
  const evidence = JSON.parse(fs.readFileSync(path.join(root, 'docs/sntss/evidence/R9_OBSERVABILITY_EVIDENCE.json'), 'utf8'));
  const sha256File = file => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
  const body = { ...evidence }; delete body.evidenceHash;
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.evidenceHash, hash(body));
  assert.equal(evidence.sourceHashes.observability, sha256File(path.join(root, 'runtime/kernel/sntss-observability.js')));
  assert.equal(evidence.sourceHashes.test, sha256File(path.join(root, 'test/sntss-observability.test.js')));
  assert.equal(evidence.sourceHashes.publicSchema, sha256File(path.join(root, 'cores/sntss/schemas/public-summary.schema.json')));
  assert.equal(evidence.sourceHashes.operatorSchema, sha256File(path.join(root, 'cores/sntss/schemas/operator-health.schema.json')));
  assert.equal(evidence.sourceHashes.forensicSchema, sha256File(path.join(root, 'cores/sntss/schemas/forensic-record.schema.json')));
});