#!/usr/bin/env node
'use strict';

const { verifyPromotion } = require('./p1-surgery-b-state');

function safe(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '?')
    .replace(/\r?\n/g, ' | ')
    .slice(0, 2048);
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 4) {
    throw Object.assign(new Error('release, database, public key and certificate directory are required'), {
      code: 'P1_B0_LIVE_USER_ARGUMENTS'
    });
  }
  const result = await verifyPromotion(...argv);
  process.stdout.write([
    'LIVE_USER_CORE_INSPECT=PASS',
    'LIVE_USER_PROMOTION=PASS',
    `RESIDENCY_ID=${result.residencyId}`,
    `VERSION=${result.version}`,
    `CERTIFICATE_ID=${result.certificateId}`,
    `AUTHORIZATION_CLASS=${result.authorizationClass}`,
    `LABORATORY_BYPASS=${result.laboratoryBypass === true ? 'YES' : 'NO'}`
  ].join('\n') + '\n');
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write([
      'LIVE_USER_DIAGNOSTIC=FAIL',
      `ERROR_CODE=${safe(error?.code || 'UNKNOWN')}`,
      `ERROR_MESSAGE=${safe(error?.message || error)}`
    ].join('\n') + '\n');
    process.exitCode = 1;
  });
}

module.exports = { main, safe };
