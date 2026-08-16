'use strict';

const fs = require('node:fs');
const path = require('node:path');

const matrixPath = path.resolve(__dirname, '../docs/sntss/R11_CERTIFICATION_MATRIX.json');
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));

const blockers = [];
for (const blocker of matrix.entranceBlockers || []) blockers.push(`entrance:${blocker}`);
for (const medium of matrix.residualMediums || []) blockers.push(`medium:${medium.id}`);
for (const domain of matrix.domains || []) {
  if (domain.state !== 'PASS') blockers.push(`domain:${domain.id}:${domain.state}`);
}

const report = {
  format: 'stay-sntss-r11-certification-status-v1',
  status: blockers.length ? 'BLOCKED' : 'READY_TO_FREEZE',
  candidateFrozen: matrix.candidateFrozen === true,
  productionEligible: false,
  liveMutationAllowed: false,
  liveChemistryAllowed: false,
  domainCount: Array.isArray(matrix.domains) ? matrix.domains.length : 0,
  blockers
};

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.exitCode = blockers.length ? 2 : 0;
