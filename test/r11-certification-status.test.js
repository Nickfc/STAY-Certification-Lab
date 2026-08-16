'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const script = path.resolve(__dirname, '../scripts/sntss-r11-certification-status.js');

test('R11-05 status command reports repository completion but fails closed while formal and host blockers remain', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.format, 'stay-sntss-r11-certification-status-v1');
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.repositoryPrecertificationStatus, 'PASS');
  assert.equal(report.repositoryComplete, true);
  assert.equal(report.repositoryPassedDomains, 17);
  assert.deepEqual(report.hostPendingDomains, ['R11-B','R11-F','R11-G','R11-H','R11-K','R11-L','R11-N','R11-O','R11-Q']);
  assert.equal(report.candidateFrozen, false);
  assert.equal(report.productionEligible, false);
  assert.equal(report.liveMutationAllowed, false);
  assert.equal(report.liveChemistryAllowed, false);
  assert.equal(report.domainCount, 17);
  assert.ok(report.blockers.some(item => item.startsWith('entrance:R8_24H_HOST_ENDURANCE_ACCEPTED')));
  assert.ok(report.blockers.some(item => item === 'medium-host-proof:M-01'));
  assert.ok(report.blockers.some(item => item === 'medium-host-proof:M-02'));
  assert.ok(report.blockers.some(item => item === 'medium-host-proof:M-03'));
  assert.ok(report.blockers.some(item => item.startsWith('domain:R11-B:')));
});
