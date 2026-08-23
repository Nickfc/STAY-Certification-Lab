'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { LivingKernel } = require('../runtime');

const expectedLegacy = {
  'cores/fetus-legacy-0.6/index.js': 'ad2698402492a573aa5b28978b2b1a8e3387a6adc8ca0592d06bcfe310cdc9b1',
  'legacy/0.6.0/HIBERNATION_STATE_SHA256': 'aff6ae3773cd58f153f3ed92680cd552d9c70f4d398fbf2bc2a2905f8c101dbb',
  'legacy/0.6.0/SOURCE_ARCHIVE_SHA256': '3e6efcb80a2707bb81c313f2cf3d98c14b1d2a7a8b1645de6cca8be80031445e'
};

async function main() {
  const root = path.join(__dirname, '..');
  for (const [relative, expected] of Object.entries(expectedLegacy)) {
    const bytes = await fs.readFile(path.join(root, relative));
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) throw new Error('immutable legacy artifact changed: ' + relative);
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-continuity-v08-'));
  const first = path.join(root, 'test', 'fixtures', 'cores', 'counter-v1.js');
  const next = path.join(root, 'test', 'fixtures', 'cores', 'counter-v2.js');
  try {
    const kernel = new LivingKernel({ dataDir: dir, allowIdentityBootstrap: true, heartbeatIntervalMs: 0, snapshotIntervalMs: 0 });
    await kernel.start();
    const originalId = kernel.identity.organismId;
    const seen = [];
    kernel.fabric.subscribe('test.pulse', event => seen.push({ ...event.payload, epoch: event.meta.authorityEpoch }));
    await kernel.installCore(first);
    await kernel.publish('test.tick', {});
    await kernel.stageCoreUpgrade(next);
    await kernel.publish('test.tick', {});
    if (seen.at(-1).generation !== 'v1') throw new Error('shadow output escaped');
    await kernel.commitCoreUpgrade('test-counter', { minEvents: 1 });
    await kernel.publish('test.tick', {});
    if (seen.at(-1).generation !== 'v2' || seen.at(-1).epoch !== 2) throw new Error('epoch cutover failed');
    await kernel.rollbackCore('test-counter');
    await kernel.publish('test.tick', {});
    if (seen.at(-1).generation !== 'v1' || seen.at(-1).ticks !== 4 || seen.at(-1).epoch !== 3) throw new Error('warm epoch rollback failed');
    const status = await kernel.status();
    if (status.kernel.version !== '0.8.11.3') throw new Error('kernel version mismatch');
    if (!status.health.ok || status.health.persistence.format !== 'stay-statestore-v3') throw new Error('StateStore v3 health failed');
    if (status.eventFabric.protocol !== 'stay-event-fabric-v3') throw new Error('Event Fabric v3 missing');
    await kernel.stop();

    const restarted = new LivingKernel({ dataDir: dir, heartbeatIntervalMs: 0, snapshotIntervalMs: 0 });
    await restarted.start();
    if (restarted.identity.organismId !== originalId) throw new Error('identity changed on restart');
    await restarted.installCore(first);
    const restartSeen = [];
    restarted.fabric.subscribe('test.pulse', event => restartSeen.push(event.payload));
    await restarted.publish('test.tick', {});
    if (restartSeen.at(-1).ticks !== 5) throw new Error('checkpoint continuity failed');
    await restarted.stop();
    console.log('STAY 0.8.11.3 continuity, isolation, authority epochs, StateStore v3 schema and immutable fetus boundary verified');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
