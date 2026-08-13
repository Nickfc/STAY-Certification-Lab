'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LivingKernel } = require('../runtime');

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-continuity-'));
  const kernel = new LivingKernel({ dataDir: dir });
  await kernel.start();
  const originalId = kernel.identity.organismId;
  const first = path.join(__dirname, '..', 'cores', 'kernel-probe', 'v1', 'index.js');
  const next = path.join(__dirname, '..', 'cores', 'kernel-probe', 'next', 'index.js');
  const seen = [];
  kernel.fabric.subscribe('probe.pulse', (event) => seen.push(event.payload));
  await kernel.installCore(first);
  await kernel.publish('probe.tick', {});
  await kernel.stageCoreUpgrade(next);
  await kernel.publish('probe.tick', {});
  if (seen.at(-1).generation !== 'v1') throw new Error('shadow output escaped');
  await kernel.commitCoreUpgrade('kernel-probe', { minEvents: 1 });
  await kernel.publish('probe.tick', {});
  if (seen.at(-1).generation !== 'next') throw new Error('candidate did not become active');
  await kernel.rollbackCore('kernel-probe');
  await kernel.publish('probe.tick', {});
  if (seen.at(-1).ticks !== 4 || seen.at(-1).generation !== 'v1') throw new Error('warm rollback continuity failed');
  await kernel.stop();
  const restarted = new LivingKernel({ dataDir: dir });
  await restarted.start();
  if (restarted.identity.organismId !== originalId) throw new Error('identity did not persist');
  await restarted.stop();
  console.log('Living Runtime continuity verified');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
