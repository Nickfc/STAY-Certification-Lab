'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const inspector = require('node:inspector');
const os = require('node:os');
const path = require('node:path');
const { LivingKernel } = require('../../runtime');

(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-inspector-guard-'));
  const kernel = new LivingKernel({ dataDir, allowIdentityBootstrap: true, heartbeatIntervalMs: 0, snapshotIntervalMs: 0 });
  try {
    await kernel.start();
    await kernel.installCore(path.join(__dirname, 'cores', 'debug-parent-core.js'));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(inspector.url(), undefined);
  } finally {
    await kernel.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
