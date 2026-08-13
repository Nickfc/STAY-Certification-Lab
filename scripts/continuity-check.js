'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LivingKernel } = require('../runtime');
const { validateManifest, assertUpgradeCompatible } = require('../runtime/kernel/manifest');
const legacy = require('../cores/fetus-legacy-0.6');

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

  const legacyManifest = validateManifest(legacy.manifest);
  if (legacyManifest.coreId !== 'fetus-legacy' || legacyManifest.version !== '0.6.0') throw new Error('legacy compatibility identity changed');
  if (legacyManifest.hotSwap !== false) throw new Error('legacy monolith must not claim live hot-swap support');
  if (legacy.HIBERNATION_SHA256 !== 'b45d6addd70b13bfa684f53c075edb3ca6a76bae7d7384849f84a1df2d7d073d') throw new Error('hibernation fingerprint changed');
  let rejected = false;
  try { assertUpgradeCompatible(legacyManifest, legacyManifest); }
  catch (error) { rejected = /controlled compatibility migration/.test(error.message); }
  if (!rejected) throw new Error('kernel did not protect the legacy monolith from live hot-swap');

  console.log('Living Runtime continuity and stable 0.6 compatibility verified');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
