'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const matrixPath = path.resolve(__dirname, '../docs/sntss/R11_CERTIFICATION_MATRIX.json');
const contractPath = path.resolve(__dirname, '../docs/sntss/R11_COMPLETE_LABORATORY_CERTIFICATION.md');

function loadMatrix() {
  return JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
}

const REQUIRED_DOMAINS = [
  'R11-A','R11-B','R11-C','R11-D','R11-E','R11-F','R11-G','R11-H','R11-I',
  'R11-J','R11-K','R11-L','R11-M','R11-N','R11-O','R11-P','R11-Q'
];

const REQUIRED_BLOCKERS = [
  'R8_24H_HOST_ENDURANCE_ACCEPTED',
  'TRUST_BOOTSTRAP_CEREMONY_EXECUTED',
  'BUBBLEWRAP_HOST_ESCAPE_PROBES_PASSED',
  'R10_SIGNED_RELEASE_REHEARSAL_PASSED',
  'R10_5_MEDIUM_FINDINGS_CLOSED_OR_EXPLICITLY_BLOCKED'
];

test('R11-00 certification matrix is complete and remains blocked before host evidence', () => {
  const matrix = loadMatrix();
  assert.equal(matrix.format, 'stay-sntss-r11-certification-matrix-v1');
  assert.equal(matrix.stage, 'R11-complete-laboratory-certification');
  assert.equal(matrix.status, 'DESIGNED_BLOCKED');
  assert.equal(matrix.candidateFrozen, false);
  assert.equal(matrix.frozenCommitSha, null);
  assert.equal(matrix.productionEligible, false);
  assert.equal(matrix.liveMutationAllowed, false);
  assert.equal(matrix.liveChemistryAllowed, false);
  assert.equal(matrix.r12NeutralOnly, true);
  assert.deepEqual(matrix.domains.map(domain => domain.id), REQUIRED_DOMAINS);
  for (const blocker of REQUIRED_BLOCKERS) assert.ok(matrix.entranceBlockers.includes(blocker), blocker);
  assert.equal(matrix.domains.length, 17);
  for (const domain of matrix.domains) {
    assert.notEqual(domain.state, 'PASS', `${domain.id} must not be pre-certified`);
    assert.ok(Array.isArray(domain.requiredEvidence) && domain.requiredEvidence.length >= 2, `${domain.id} evidence contract`);
  }
});

test('R11-01 host-dependent attack domains cannot be satisfied by repository tests alone', () => {
  const matrix = loadMatrix();
  const requiredHostDomains = ['R11-B','R11-F','R11-G','R11-H','R11-K','R11-L','R11-N','R11-O','R11-Q'];
  for (const id of requiredHostDomains) {
    const domain = matrix.domains.find(item => item.id === id);
    assert.ok(domain, id);
    assert.equal(domain.hostEvidence, true, `${id} must require host evidence`);
  }
});

test('R11-02 R10.5 residual medium findings stay explicit as they move through closure', () => {
  const matrix = loadMatrix();
  assert.deepEqual(matrix.residualMediums.map(item => item.id), ['M-01','M-02','M-03']);
  const m01 = matrix.residualMediums.find(item => item.id === 'M-01');
  const m02 = matrix.residualMediums.find(item => item.id === 'M-02');
  const m03 = matrix.residualMediums.find(item => item.id === 'M-03');
  assert.equal(m01.status, 'CLOSED_IN_CANDIDATE_PENDING_HOST_PROOF');
  assert.equal(m02.status, 'CLOSED_IN_CANDIDATE_PENDING_HOST_PROOF');
  assert.equal(m03.status, 'OPEN');
  assert.equal(matrix.domains.find(item => item.id === 'R11-K').state, 'PLANNED_HOST_PROOF');
  assert.equal(matrix.domains.find(item => item.id === 'R11-H').state, 'PLANNED_HOST_PROOF');
  assert.ok(matrix.domains.find(item => item.id === 'R11-L').state.includes('M03'));
  for (const medium of matrix.residualMediums) assert.ok(medium.requiredClosure && medium.requiredClosure.length > 20);
});

test('R11-03 freeze contract prevents code drift and never grants live chemistry', () => {
  const matrix = loadMatrix();
  const required = [
    'ALL_17_DOMAINS_PASS','ALL_HOST_EVIDENCE_PRESENT','M01_CLOSED','M02_CLOSED','M03_CLOSED',
    'ZERO_OPEN_CRITICAL','ZERO_OPEN_HIGH','ZERO_UNEXPLAINED_MEDIUM','FULL_SUITE_GREEN_ON_EXACT_SHA','INDEPENDENT_REVIEW_ACCEPTED'
  ];
  for (const gate of required) assert.ok(matrix.freezeRequirements.includes(gate), gate);
  assert.ok(matrix.freezeInventory.includes('gitCommitSha'));
  assert.ok(matrix.freezeInventory.includes('sntssPackageDigest'));
  assert.ok(matrix.freezeInventory.includes('releaseAuthorityPublicKeyFingerprint'));
  assert.ok(matrix.freezeInventory.includes('revocationTableHead'));
  assert.ok(matrix.freezeInventory.includes('externalForensicAnchorIdentity'));
  assert.equal(matrix.acceptanceOutput, 'CERTIFIED_NEUTRAL_CAPABLE_CANDIDATE_ONLY');
  assert.equal(matrix.productionEligible, false);
  assert.equal(matrix.liveChemistryAllowed, false);
});

test('R11-04 human contract preserves neutral-first and no-live-testing boundaries', () => {
  const doc = fs.readFileSync(contractPath, 'utf8');
  assert.match(doc, /R11 itself performs no live installation/i);
  assert.match(doc, /(does not authorize|never grants) live chemistry/i);
  assert.match(doc, /no runtime-bearing file may change/i);
  assert.match(doc, /rollback may restore code authority but may never rewind acquired biological state/i);
  assert.match(doc, /repository tests cannot substitute for physical namespace, cgroup, bootstrap, process, network and filesystem evidence/i);
});
