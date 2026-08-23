'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  nativeCoreExecArgv,
  trustedCoreHostExecArgv,
  sandboxWorkerPlan
} = require('../runtime/kernel/core-sandbox');

const neutralPath = path.join(__dirname, '..', 'cores', 'sntss', 'neutral', 'index.js');

test('R10.5-16 untrusted worker has no child-process permission while trusted supervisor retains bubblewrap spawn authority', () => {
  const workerFlags = nativeCoreExecArgv(neutralPath).join(' ');
  assert.doesNotMatch(workerFlags, /--allow-child-process/);

  const planFlags = sandboxWorkerPlan(neutralPath).args.join(' ');
  assert.doesNotMatch(planFlags, /--allow-child-process/);

  const supervisorFlags = trustedCoreHostExecArgv(neutralPath).join(' ');
  assert.match(supervisorFlags, /--allow-child-process/);
});
