#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const FAILURE_STAGES = new Set([
  'SOURCE', 'ENVIRONMENT', 'PERFORMANCE', 'DIRECT',
  'TARGETED', 'FULL', 'SAFETY', 'SANITIZE',
]);

function fail() {
  throw Object.assign(new Error('sanitized compute failure record is unavailable'), {
    code: 'C3C_PUBLIC_FAILURE_RECORD_INVALID',
  });
}

function buildFailureRecord({ candidateSha, candidateTree, exitCode, privateStatus }) {
  const numericExitCode = Number(exitCode);
  if (!/^[0-9a-f]{40}$/.test(candidateSha)
    || !/^[0-9a-f]{40}$/.test(candidateTree)
    || !Number.isSafeInteger(numericExitCode) || numericExitCode < 1 || numericExitCode > 255
    || !privateStatus || privateStatus.result !== 'FAILED'
    || !FAILURE_STAGES.has(privateStatus.stage)) fail();

  return Object.freeze({
    candidate_sha: candidateSha,
    candidate_tree: candidateTree,
    result: 'FAILED',
    stage: privateStatus.stage,
    exit_code: numericExitCode,
  });
}

if (require.main === module) {
  let status;
  try {
    status = JSON.parse(fs.readFileSync(process.env.PRIVATE_STATUS_PATH, 'utf8'));
  } catch {
    fail();
  }
  process.stdout.write(`${JSON.stringify(buildFailureRecord({
    candidateSha: process.env.CANDIDATE_SHA,
    candidateTree: process.env.CANDIDATE_TREE,
    exitCode: process.env.COMPUTE_EXIT_CODE,
    privateStatus: status,
  }), null, 2)}\n`);
}

module.exports = { buildFailureRecord, FAILURE_STAGES };
