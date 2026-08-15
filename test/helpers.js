'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LivingKernel } = require('../runtime');

async function makeDataDir(prefix = 'stay-v08-test-') { return fs.mkdtemp(path.join(os.tmpdir(), prefix)); }

async function makeKernel(options = {}) {
  const dataDir = options.dataDir || await makeDataDir();
  const kernel = new LivingKernel({
    dataDir,
    allowIdentityBootstrap: options.allowIdentityBootstrap ?? true,
    heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0,
    snapshotRetention: 4
  });
  await kernel.start();
  return { kernel, dataDir };
}

async function waitFor(predicate, timeoutMs = 3000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('condition not reached before timeout');
}

module.exports = { makeDataDir, makeKernel, waitFor, fs, path };
