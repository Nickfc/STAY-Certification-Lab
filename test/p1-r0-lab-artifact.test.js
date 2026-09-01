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
const adjudicationStem = 'STAY_P1_R0_LAB_QUALIFIED_CANDIDATE_5d861fade180';
const adjudicationCommit = '5d861fade18035b401e3fd52f504856e0a1d1d61';

test('P1-CANDIDATE-04 committed candidate extracts cleanly and every immutable hash verifies', async () => {
  const expectedNames = [
    `${stem}.evidence.json`,
    `${stem}.inventory.json`,
    `${stem}.tar.gz`,
    `${stem}.tar.gz.sha256`,
    `${adjudicationStem}.evidence.json`,
    `${adjudicationStem}.inventory.json`,
    `${adjudicationStem}.tar.gz`,
    `${adjudicationStem}.tar.gz.sha256`
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

  const adjudicationEvidence = JSON.parse(fs.readFileSync(
    path.join(directory, `${adjudicationStem}.evidence.json`),
    'utf8'
  ));
  assert.deepEqual({
    result: adjudicationEvidence.result,
    commit: adjudicationEvidence.commit,
    tree: adjudicationEvidence.tree,
    focusedTests: adjudicationEvidence.focusedTests,
    completeTests: adjudicationEvidence.completeTests,
    ciRunId: adjudicationEvidence.ciRunId,
    productionTouched: adjudicationEvidence.productionTouched
  }, {
    result: 'PASS',
    commit: adjudicationCommit,
    tree: '79ba90dd85f688e7f932bf771bf1708a11fd4768',
    focusedTests: 6,
    completeTests: 1041,
    ciRunId: '33521480728',
    productionTouched: false
  });
  const adjudicationResult = await candidate.verify({
    archive: path.join(directory, `${adjudicationStem}.tar.gz`),
    sidecar: path.join(directory, `${adjudicationStem}.tar.gz.sha256`),
    inventory: path.join(directory, `${adjudicationStem}.inventory.json`),
    evidence: path.join(directory, `${adjudicationStem}.evidence.json`),
    expectedCommit: adjudicationCommit
  });
  assert.deepEqual({
    status: adjudicationResult.status,
    commit: adjudicationResult.commit,
    tree: adjudicationResult.tree,
    archiveSha256: adjudicationResult.archiveSha256,
    fileCount: adjudicationResult.fileCount,
    productionTouched: adjudicationResult.productionTouched
  }, {
    status: 'PASS',
    commit: adjudicationCommit,
    tree: '79ba90dd85f688e7f932bf771bf1708a11fd4768',
    archiveSha256: 'sha256:9605b0bbe1c008915e40a58f844891cfd4df54ef15baff1267c81ec8792c368a',
    fileCount: 754,
    productionTouched: false
  });
});
