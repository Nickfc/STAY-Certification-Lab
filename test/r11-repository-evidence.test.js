'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stableStringify } = require('../runtime/kernel/canonical-json');

const root = path.resolve(__dirname, '..');
const mapPath = path.join(root, 'docs/sntss/R11_REPOSITORY_ATTACK_MAP.json');
const matrixPath = path.join(root, 'docs/sntss/R11_CERTIFICATION_MATRIX.json');
const packagePath = path.join(root, 'package.json');
const REQUIRED = ['R11-A','R11-B','R11-C','R11-D','R11-E','R11-F','R11-G','R11-H','R11-I','R11-J','R11-K','R11-L','R11-M','R11-N','R11-O','R11-P','R11-Q'];

function sha256(value) {
  return 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
}
function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('R11-REPO-01 attack map is hash-bound, complete and explicitly repository-only', () => {
  const attackMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
  const body = { ...attackMap };
  delete body.attackMapHash;
  assert.equal(attackMap.attackMapHash, sha256(stableStringify(body)));
  assert.equal(matrix.repositoryPrecertification.attackMapHash, attackMap.attackMapHash);
  assert.equal(attackMap.scope, 'repository-and-CI-only');
  assert.equal(attackMap.hostEvidenceMayNotBeSynthesized, true);
  assert.equal(attackMap.liveMutationAllowed, false);
  assert.equal(attackMap.liveChemistryAllowed, false);
  assert.deepEqual(attackMap.domains.map(item => item.id), REQUIRED);
  assert.equal(new Set(attackMap.domains.map(item => item.id)).size, 17);
});

test('R11-REPO-02 every A-Q repository claim is backed by executable non-skipped regressions in the full CI glob', () => {
  const attackMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  assert.match(pkg.scripts.test, /test\/\*\.test\.js/);
  assert.equal(pkg.scripts['test:sntss-r11-repo'], 'node scripts/sntss-r11-repository-suite.js');

  for (const domain of attackMap.domains) {
    const matrixDomain = matrix.domains.find(item => item.id === domain.id);
    assert.ok(matrixDomain, domain.id);
    assert.equal(domain.repositoryResult, 'PASS');
    assert.equal(matrixDomain.repositoryState, 'PASS');
    assert.equal(domain.hostRequired, matrixDomain.hostEvidence);
    assert.equal(domain.hostResult, domain.hostRequired ? 'PENDING' : 'NOT_REQUIRED');
    assert.equal(matrixDomain.hostState, domain.hostResult);
    assert.equal(matrixDomain.attackMapHash, attackMap.attackMapHash);
    assert.notEqual(matrixDomain.state, 'PASS', `${domain.id} formal certification must remain blocked`);
    assert.ok(Array.isArray(domain.regressions) && domain.regressions.length >= 2, `${domain.id} needs at least two regressions`);

    for (const regression of domain.regressions) {
      assert.match(regression.file, /^test\/[^/]+\.test\.js$/, `${domain.id} regression must be in full CI test glob`);
      const absolute = path.join(root, regression.file);
      const source = fs.readFileSync(absolute, 'utf8');
      const name = escaped(regression.name);
      assert.match(source, new RegExp(`test\\s*\\(\\s*['\"\\`]${name}['\"\\`]`), `${domain.id} missing ${regression.name}`);
      assert.doesNotMatch(source, new RegExp(`test\\.(?:skip|todo)\\s*\\(\\s*['\"\\`]${name}['\"\\`]`), `${domain.id} regression is skipped`);
    }
  }
});

test('R11-REPO-03 host-required domains remain pending and cannot be converted to PASS by repository evidence', () => {
  const attackMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
  const expectedHost = ['R11-B','R11-F','R11-G','R11-H','R11-K','R11-L','R11-N','R11-O','R11-Q'];
  assert.deepEqual(attackMap.domains.filter(item => item.hostRequired).map(item => item.id), expectedHost);
  for (const id of expectedHost) {
    const attack = attackMap.domains.find(item => item.id === id);
    const domain = matrix.domains.find(item => item.id === id);
    assert.equal(attack.hostResult, 'PENDING');
    assert.equal(domain.hostState, 'PENDING');
    assert.equal(domain.hostEvidence, true);
    assert.notEqual(domain.state, 'PASS');
  }
  assert.equal(matrix.status, 'DESIGNED_BLOCKED');
  assert.equal(matrix.candidateFrozen, false);
  assert.equal(matrix.productionEligible, false);
  assert.equal(matrix.liveMutationAllowed, false);
  assert.equal(matrix.liveChemistryAllowed, false);
});
