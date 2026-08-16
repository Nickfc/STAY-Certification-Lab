'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { LivingKernel } = require('../runtime');
const { makeDataDir, makeKernel, fs, path } = require('./helpers');

const v1 = path.join(__dirname, 'fixtures', 'cores', 'counter-v1.js');
const v2 = path.join(__dirname, 'fixtures', 'cores', 'counter-v2.js');

test('production identity fails closed and legacy JSON identity migrates into StateStore v3', async t => {
  const empty = await makeDataDir();
  t.after(() => fs.rm(empty, { recursive: true, force: true }));
  const denied = new LivingKernel({ dataDir: empty, heartbeatIntervalMs: 0, snapshotIntervalMs: 0 });
  await assert.rejects(() => denied.start(), error => error.code === 'IDENTITY_MISSING');
  denied.stateStore.close();

  const migrated = await makeDataDir();
  t.after(() => fs.rm(migrated, { recursive: true, force: true }));
  const identity = { organismId: 'stay-' + crypto.randomUUID(), createdAt: new Date().toISOString(), lineage: 'STAY/Genesis' };
  await fs.mkdir(path.join(migrated, 'life'), { recursive: true });
  await fs.writeFile(path.join(migrated, 'life', 'identity.json'), JSON.stringify(identity, null, 2) + '\n');
  const kernel = new LivingKernel({ dataDir: migrated, heartbeatIntervalMs: 0, snapshotIntervalMs: 0 });
  await kernel.start();
  assert.equal(kernel.identity.organismId, identity.organismId);
  assert.equal((await kernel.status()).health.persistence.format, 'stay-statestore-v3');
  await kernel.stop();
});

test('epoch cutover, state migration, warm rollback and restart preserve one authority', async t => {
  const { kernel, dataDir } = await makeKernel();
  let restarted = null;
  t.after(async () => {
    if (restarted?.stateStore.db) await restarted.stop().catch(() => {});
    if (kernel.stateStore.db) await kernel.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const identity = kernel.identity.organismId;
  const seen = [];
  kernel.fabric.subscribe('test.pulse', event => seen.push({ ...event.payload, epoch: event.meta.authorityEpoch }));
  await kernel.installCore(v1);
  await kernel.publish('test.tick', {});
  await kernel.stageCoreUpgrade(v2);
  await kernel.publish('test.tick', {});
  assert.equal(seen.at(-1).generation, 'v1');
  const committed = await kernel.commitCoreUpgrade('test-counter', { minEvents: 1 });
  assert.equal(committed.authority.epoch, 2);
  await kernel.publish('test.tick', {});
  assert.equal(seen.at(-1).generation, 'v2');
  assert.equal(seen.at(-1).epoch, 2);
  const rolledBack = await kernel.rollbackCore('test-counter');
  assert.equal(rolledBack.authority.epoch, 3);
  await kernel.publish('test.tick', {});
  assert.equal(seen.at(-1).generation, 'v1');
  assert.equal(seen.at(-1).ticks, 4);
  assert.deepEqual(kernel.stateStore.listAuthority().map(entry => entry.epoch), [3]);
  await kernel.stop();

  restarted = new LivingKernel({ dataDir, heartbeatIntervalMs: 0, snapshotIntervalMs: 0 });
  await restarted.start();
  assert.equal(restarted.identity.organismId, identity);
  const restartSeen = [];
  restarted.fabric.subscribe('test.pulse', event => restartSeen.push(event.payload));
  await restarted.installCore(v1);
  await restarted.publish('test.tick', {});
  assert.equal(restartSeen.at(-1).ticks, 5);
  assert.equal(restarted.stateStore.getAuthority('test-counter').epoch, 3);
  await restarted.stop();
});

test('cutover race rejects old-epoch outputs and never creates dual authority', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(async () => {
    if (kernel.stateStore.db) await kernel.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await kernel.installCore(v1);
  await kernel.stageCoreUpgrade(v2);
  await kernel.publish('test.tick', {});
  const outputs = [];
  kernel.fabric.subscribe('test.pulse', event => outputs.push(event.meta.authorityEpoch));
  const cutover = kernel.commitCoreUpgrade('test-counter', { minEvents: 1 });
  // Keep this test below the fixture's queue-capacity threshold: its purpose is
  // authority-race validation, while overflow/quarantine is covered separately.
  const concurrent = Promise.allSettled(Array.from({ length: 8 }, () => kernel.publish('test.tick', {})));
  await cutover;
  await concurrent;
  await kernel.publish('test.tick', {});
  assert.ok(outputs.every(epoch => epoch === 1 || epoch === 2));
  const authority = kernel.stateStore.getAuthority('test-counter');
  assert.equal(authority.epoch, 2);
  const status = await kernel.status();
  assert.equal(status.cores.find(core => core.coreId === 'test-counter').active.authorityEpoch, 2);
  await kernel.stop();
});
