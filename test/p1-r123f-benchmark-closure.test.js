'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const v4 = require('../scripts/p1-physiology-benchmark-v4');

const root = path.resolve(__dirname, '..');
const evidenceRoot = path.join(root, 'certification', 'p1-r0', 'r123f-benchmark-closure');

function read(name) {
  return fs.readFileSync(path.join(evidenceRoot, name));
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function verifyEvidenceHash(value) {
  const body = { ...value };
  delete body.evidenceHash;
  assert.equal(value.evidenceHash, v4.evidenceHash(body));
}

test('R123F-CLOSE-01 query-only witness remains exact, immutable, and Chronobiology-only', () => {
  const bytes = read('outbox-witness-v1.json');
  assert.equal(sha256(bytes), '80c383e7b9b15c3da64b29e14d2ca4800d8ad64f19b63dd44ec401afa8564cfc');
  const witness = JSON.parse(bytes);
  verifyEvidenceHash(witness);
  assert.equal(witness.format, v4.WITNESS_FORMAT);
  assert.equal(witness.revisionLabel, 'R123F');
  assert.equal(witness.queryOnly, true);
  assert.equal(witness.productionMutated, false);
  assert.equal(witness.databaseQuickCheck, 'ok');
  assert.equal(witness.entries.length, 1);
  assert.equal(witness.entries[0].sampleLine, 1280);
  assert.equal(witness.entries[0].candidateRows.length, 1);
  assert.deepEqual({
    coreId: witness.entries[0].candidateRows[0].producerCoreId,
    status: witness.entries[0].candidateRows[0].status,
    generation: witness.entries[0].candidateRows[0].checkpointGeneration,
    fabricSequence: witness.entries[0].candidateRows[0].fabricSequence
  }, {
    coreId: 'chronobiology',
    status: 'PUBLISHED',
    generation: 6467,
    fabricSequence: 2793344
  });
});

test('R123F-CLOSE-02 V4 PASS retains V3 result and binds every immutable input', () => {
  const bytes = read('adjudication-v4.json');
  assert.equal(sha256(bytes), 'a78cd8281d246d851e3476f8da50964bc7e9556a8760439099dd727ecadfc6e4');
  const report = JSON.parse(bytes);
  verifyEvidenceHash(report);
  assert.equal(report.format, v4.REPORT_FORMAT);
  assert.equal(report.result, 'PASS');
  assert.equal(report.productionMutated, false);
  assert.deepEqual(report.sourceV3, {
    result: 'OBSERVED_FAILURES',
    samples: 4312,
    failures: 1,
    observedFailureCount: 1,
    collectorStarts: 1,
    collectorRestarts: 0
  });
  assert.deepEqual(report.v4, {
    observedFailureCount: 0,
    adjudicatedTransientCount: 1,
    evidenceIncompleteCount: 0,
    hardObservationFailureCount: 0
  });
  assert.deepEqual(report.checkpointProgress, { sntss: 1034033, chronobiology: 4320 });
  assert.equal(report.observations.length, 1);
  assert.equal(report.observations[0].disposition, 'COMMITTED_IN_FLIGHT_PUBLISHED');
  assert.equal(report.observations[0].failure, false);
  assert.equal(report.observations[0].evidenceComplete, true);
  assert.deepEqual(report.inputHashes, {
    samples: 'sha256:47b7b60e91e853fcd1a4c9cf8a5242d8af65bd403e47fe8a45d4dbcf19311136',
    state: 'sha256:700f3736ff92f13bbbcfc1427e324160cc7cbc4a48d1de4474c103c67a51ee89',
    attempts: 'sha256:ea418fd91a72bccf4ea4714cf7ba9e595520b97e4e8fd99adfb2b1d581feddd1',
    milestone: 'sha256:4d2116da14a18d92f710815d64b23f08e2b48d81acc46c0de8a727390d76961f',
    witness: 'sha256:80c383e7b9b15c3da64b29e14d2ca4800d8ad64f19b63dd44ec401afa8564cfc'
  });
});
