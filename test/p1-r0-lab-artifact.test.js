'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const candidate = require('../scripts/p1-r0-lab-candidate');

const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'certification', 'p1-r0', 'artifacts');
const stem = 'STAY_P1_R0_LAB_QUALIFIED_CANDIDATE_cf90104d8e5f';
const expectedCommit = 'cf90104d8e5fa874ebacb033304ff2e6faaae4da';

test('P1-CANDIDATE-04 committed candidate extracts cleanly and every immutable hash verifies', async () => {
  const expectedNames = [
    `${stem}.evidence.json`,
    `${stem}.inventory.json`,
    `${stem}.tar.gz`,
    `${stem}.tar.gz.sha256`
  ];
  assert.deepEqual(fs.readdirSync(directory).sort(), expectedNames.sort());
  const evidence = JSON.parse(fs.readFileSync(path.join(directory, `${stem}.evidence.json`), 'utf8'));
  assert.deepEqual({
    result: evidence.result,
    commit: evidence.commit,
    tree: evidence.tree,
    focusedTests: evidence.focusedTests,
    completeTests: evidence.completeTests,
    ciRunId: evidence.ciRunId,
    productionTouched: evidence.productionTouched
  }, {
    result: 'PASS',
    commit: expectedCommit,
    tree: '0ed7392de31f077138fec74e8cd89e5a8251c3ac',
    focusedTests: 108,
    completeTests: 1034,
    ciRunId: '33314754554',
    productionTouched: false
  });
  const result = await candidate.verify({
    archive: path.join(directory, `${stem}.tar.gz`),
    sidecar: path.join(directory, `${stem}.tar.gz.sha256`),
    inventory: path.join(directory, `${stem}.inventory.json`),
    evidence: path.join(directory, `${stem}.evidence.json`),
    expectedCommit
  });
  assert.deepEqual({
    status: result.status,
    commit: result.commit,
    tree: result.tree,
    archiveSha256: result.archiveSha256,
    fileCount: result.fileCount,
    productionTouched: result.productionTouched
  }, {
    status: 'PASS',
    commit: expectedCommit,
    tree: '0ed7392de31f077138fec74e8cd89e5a8251c3ac',
    archiveSha256: 'sha256:1fb4bfbf2a1b24cefc9e6c44b2cda4551f53616675356c5a077f7fff818c288a',
    fileCount: 745,
    productionTouched: false
  });
});
