'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const candidate = require('../scripts/p1-r0-lab-candidate');

const root = path.resolve(__dirname, '..');

test('P1-CANDIDATE-01 Git inventory rejects links, submodules and unsafe paths', () => {
  const records = candidate.inspectGitTree(root, 'HEAD');
  assert.ok(records.length > 700);
  assert.ok(records.every(record => candidate.ALLOWED_MODES.has(record.mode)));
  assert.throws(() => candidate.validateRelative('../escape'), { code: 'P1_R0_CANDIDATE_PATH' });
  assert.throws(() => candidate.validateRelative('/absolute'), { code: 'P1_R0_CANDIDATE_PATH' });
  assert.throws(() => candidate.validateRelative('windows\\escape'), { code: 'P1_R0_CANDIDATE_PATH' });
});

test('P1-CANDIDATE-02 archive listing must remain under one exact root', () => {
  const prefix = 'STAY_P1_R0_LAB_QUALIFIED_CANDIDATE_deadbeefdead';
  assert.equal(candidate.assertSafeListing(`${prefix}/\n${prefix}/runtime/p1-r0/index.js\n`, prefix).length, 2);
  assert.throws(() => candidate.assertSafeListing(`${prefix}/\n../escape\n`, prefix), { code: 'P1_R0_CANDIDATE_PREFIX' });
  assert.throws(() => candidate.assertSafeListing(`${prefix}/\n${prefix}/a/../../escape\n`, prefix), { code: 'P1_R0_CANDIDATE_PATH' });
});

test('P1-CANDIDATE-03 builder is explicitly laboratory-only and SHA-bound', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/p1-r0-lab-candidate.js'), 'utf8');
  assert.match(source, /productionEligible: false/);
  assert.match(source, /productionAttached: false/);
  assert.match(source, /productionTouched: false/);
  assert.match(source, /git', \['archive'/);
  assert.match(source, /clean extraction does not match every inventoried file hash/);
  assert.doesNotMatch(source, /attachResident|grantAuthority|setBiologicalAuthority|writeCheckpoint/);
});
