'use strict';

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

function sha256File(file) { return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`; }
function outcome(name, fn) {
  try { fn(); return { name, detected: false, code: null }; }
  catch (error) { return { name, detected: true, code: error.code || error.message }; }
}

const root = path.resolve(__dirname, '..');
const destination = path.resolve(process.argv[2] || path.join(root, 'docs/sntss/evidence/R9_OBSERVABILITY_EVIDENCE.json'));
const profileHash = hash({ profile: 'r9-evidence-profile' });
const anchorHash = hash({ checkpoint: 'r9-anchor', auditHead: 'r9-audit-anchor' });
const auditHeadHash = hash({ auditHead: 'r9-audit-head' });
let sinkFailures = 0;
const plane = new SntssObservabilityPlane({
  anchorHash,
  forensicCapacity: 8,
  sink(record) { if (record.sequence === 4) { sinkFailures += 1; throw new Error('simulated optional telemetry sink failure'); } }
});

function transition(sequence, status, reasonCode, extra = {}) {
  return {
    transitionId: `transition-${sequence}`,
    observedAtMs: 100000 + sequence,
    input: { eventId: `evt-${sequence}`, sequence, topic: 'presence.changed', status, reasonCode },
    beforeStateHash: hash({ state: sequence - 1 }),
    afterStateHash: hash({ state: sequence }),
    clamps: extra.clamps || [],
    circuitChanges: extra.circuitChanges || [],
    migrations: extra.migrations || [],
    emittedFrameIds: extra.emittedFrameIds || [],
    evidenceCursor: sequence,
    profileHash,
    candidateVersion: '0.1.0',
    checkpointHash: hash({ checkpoint: sequence }),
    auditHeadHash
  };
}

const captures = [
  plane.capture(transition(1, 'accepted', 'SNTSS_ACCEPTED', { emittedFrameIds: ['frame-1'] })),
  plane.capture(transition(2, 'rejected', 'SNTSS_COOLDOWN')),
  plane.capture(transition(3, 'probe', 'SNTSS_BREAKER_RECOVERY_PROBE', { circuitChanges: ['presence.source.probe'] })),
  plane.capture(transition(4, 'migration', 'SNTSS_MIGRATION_APPLIED', { migrations: ['migration-v1'], clamps: ['tonic.max'] }))
];
const privateCapture = plane.capture({ ...transition(5, 'accepted', 'SNTSS_ACCEPTED'), payload: { privilegedMessage: 'DO NOT LOG' } });
const publicSummary = plane.publicSummary();
const operatorHealth = plane.operatorHealth();
const bundle = plane.forensicBundle(FORENSIC_READ_CAPABILITY);
const verified = verifyForensicBundle(bundle, { expectedAnchorHash: anchorHash, expectedCount: 4, expectedCandidateVersion: '0.1.0', expectedProfileHash: profileHash });
const explanation = explainTransition(bundle, 'transition-1', { expectedAnchorHash: anchorHash, expectedCandidateVersion: '0.1.0', expectedProfileHash: profileHash });

const tampered = JSON.parse(JSON.stringify(bundle)); tampered.records[0].input.reasonCode = 'SNTSS_FORGED';
const omitted = JSON.parse(JSON.stringify(bundle)); omitted.records.splice(1, 1);
const reordered = JSON.parse(JSON.stringify(bundle)); [reordered.records[0], reordered.records[1]] = [reordered.records[1], reordered.records[0]];
const privacyNeedles = ['DO NOT LOG', 'privilegedMessage', 'dreamContent', 'memoryContent', 'rawState'];
const publicEncoded = JSON.stringify(publicSummary);
const operatorEncoded = JSON.stringify(operatorHealth);
const forensicEncoded = JSON.stringify(bundle);

const body = {
  format: 'stay-sntss-r9-observability-evidence-v1',
  candidateVersion: '0.1.0',
  productionEligible: false,
  liveMutationPerformed: false,
  telemetryControlPathPresent: false,
  sourceHashes: {
    observability: sha256File(path.join(root, 'runtime/kernel/sntss-observability.js')),
    test: sha256File(path.join(root, 'test/sntss-observability.test.js')),
    publicSchema: sha256File(path.join(root, 'cores/sntss/schemas/public-summary.schema.json')),
    operatorSchema: sha256File(path.join(root, 'cores/sntss/schemas/operator-health.schema.json')),
    forensicSchema: sha256File(path.join(root, 'cores/sntss/schemas/forensic-record.schema.json'))
  },
  surfaces: {
    publicSummary,
    operatorHealth,
    forensicRecordCount: bundle.records.length,
    forensicHeadHash: bundle.headHash,
    accessCapability: FORENSIC_READ_CAPABILITY
  },
  privacy: {
    privateFieldRejected: privateCapture.captured === false && privateCapture.code === 'SNTSS_PRIVATE_FIELD',
    publicLeakDetected: privacyNeedles.some(value => publicEncoded.includes(value)),
    operatorLeakDetected: privacyNeedles.some(value => operatorEncoded.includes(value)),
    forensicPrivatePayloadLeakDetected: privacyNeedles.some(value => forensicEncoded.includes(value)),
    publicContainsEventId: publicEncoded.includes('evt-1'),
    operatorContainsEventId: operatorEncoded.includes('evt-1')
  },
  replay: {
    verified,
    deterministicExplanation: explanation,
    alteration: outcome('alteration', () => verifyForensicBundle(tampered, { expectedAnchorHash: anchorHash, expectedCount: 4 })),
    omission: outcome('omission', () => verifyForensicBundle(omitted, { expectedAnchorHash: anchorHash, expectedCount: 4 })),
    reorder: outcome('reorder', () => verifyForensicBundle(reordered, { expectedAnchorHash: anchorHash, expectedCount: 4 })),
    candidateMismatch: outcome('candidate-mismatch', () => verifyForensicBundle(bundle, { expectedAnchorHash: anchorHash, expectedCandidateVersion: '9.9.9' })),
    profileMismatch: outcome('profile-mismatch', () => verifyForensicBundle(bundle, { expectedAnchorHash: anchorHash, expectedProfileHash: hash({ wrong: true }) }))
  },
  failureIsolation: {
    capturesSucceeded: captures.every(result => result.captured),
    optionalSinkFailuresObserved: sinkFailures,
    operatorReportsSinkFailure: operatorHealth.sinkFailures === 1,
    captureThrewIntoChemistry: false
  }
};

body.status = body.privacy.privateFieldRejected
  && !body.privacy.publicLeakDetected && !body.privacy.operatorLeakDetected && !body.privacy.forensicPrivatePayloadLeakDetected
  && !body.privacy.publicContainsEventId && !body.privacy.operatorContainsEventId
  && Object.values(body.replay).filter(value => value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'detected')).every(value => value.detected)
  && body.failureIsolation.capturesSucceeded && body.failureIsolation.optionalSinkFailuresObserved === 1 && body.failureIsolation.operatorReportsSinkFailure
  ? 'PASS' : 'FAIL';
body.evidenceHash = hash(body);
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, `${JSON.stringify(body, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: body.status, destination, evidenceHash: body.evidenceHash })}\n`);
if (body.status !== 'PASS') process.exitCode = 1;