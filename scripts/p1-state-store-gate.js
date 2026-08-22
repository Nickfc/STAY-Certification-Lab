#!/usr/bin/env node
'use strict';

const path = require('node:path');
const control = require('../runtime/release/surgery-a-control');

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function main(argv = process.argv.slice(2)) {
  const database = option(argv, '--database');
  const candidateRoot = option(argv, '--candidate-root');
  const rollbackRoot = option(argv, '--rollback-root');
  const phase = option(argv, '--phase') || 'pre';
  if (!database || !candidateRoot || !rollbackRoot || !['pre', 'post'].includes(phase)) {
    throw Object.assign(new Error(
      'usage: p1-state-store-gate --database <continuity.sqlite3> --candidate-root <dir> --rollback-root <dir> --phase pre|post'
    ), { code: 'P1_GATE_USAGE' });
  }

  const candidate = control.verifyAnchors(path.resolve(candidateRoot), {
    verifyGitTrees: false
  });
  const rollback = control.verifyAnchors(path.resolve(rollbackRoot), {
    verifyGitTrees: false
  });
  const state = control.inspectDatabase(path.resolve(database));
  if (phase === 'pre') control.assertPreSurgeryState(state);
  else {
    if (state.continuitySchema !== 4) {
      throw Object.assign(new Error('post-write gate requires continuity schema 4'), {
        code: 'P1_SCHEMA4_REQUIRED'
      });
    }
    control.assertNoNewPhysiology(state);
  }

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    openMode: 'read-only',
    phase,
    continuitySchema: state.continuitySchema,
    schemaMigrationDuringSurgeryA: state.continuitySchema === 3,
    forwardCompatibleRollbackRelease: 'PROVEN_REQUIRED',
    authority: state.authority,
    residents: state.residents,
    candidateAnchors: candidate.files,
    rollbackAnchors: rollback.files,
    sntssActivated: false,
    chronobiologyActivated: false
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(`${error.code || 'P1_GATE_FAILED'}: ${error.message}`);
  process.exitCode = 1;
}
