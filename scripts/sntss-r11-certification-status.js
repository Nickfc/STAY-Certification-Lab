'use strict';

const fs = require('node:fs');
const path = require('node:path');

const matrixPath = path.resolve(__dirname, '../docs/sntss/R11_CERTIFICATION_MATRIX.json');
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));

const repositoryDomains = (matrix.domains || []).filter(domain => domain.repositoryState === 'PASS');
const hostPendingDomains = (matrix.domains || []).filter(domain => domain.hostEvidence === true && domain.hostState !== 'PASS').map(domain => domain.id);
const blockers = [];
for (const blocker of matrix.entranceBlockers || []) blockers.push(`entrance:${blocker}`);
for (const medium of matrix.residualMediums || []) {
  if (medium.status === 'CLOSED_IN_CANDIDATE_PENDING_HOST_PROOF') blockers.push(`medium-host-proof:${medium.id}`);
  else if (medium.status !== 'CLOSED') blockers.push(`medium:${medium.id}:${medium.status}`);
}
for (const domain of matrix.domains || []) {
  if (domain.state !== 'PASS') blockers.push(`domain:${domain.id}:${domain.state}`);
}

const report = {
  format: 'stay-sntss-r11-certification-status-v1',
  status: blockers.length ? 'BLOCKED' : 'READY_TO_FREEZE',
  repositoryPrecertificationStatus: matrix.repositoryPrecertification?.status || 'UNKNOWN',
  repositoryComplete: repositoryDomains.length === 17,
  repositoryPassedDomains: repositoryDomains.length,
  hostPendingDomains,
  candidateFrozen: matrix.candidateFrozen === true,
  productionEligible: false,
  liveMutationAllowed: false,
  liveChemistryAllowed: false,
  domainCount: Array.isArray(matrix.domains) ? matrix.domains.length : 0,
  blockers
};

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.exitCode = blockers.length ? 2 : 0;
