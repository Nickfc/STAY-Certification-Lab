'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LivingKernel } = require('../runtime');
const { CoreRevocationRegistry } = require('../runtime/kernel/revocation-registry');
const { inspectCoreModule } = require('../runtime/kernel/core-loader');
const { makeKernel, fs, path } = require('./helpers');

const v1 = path.join(__dirname, 'fixtures', 'cores', 'counter-v1.js');
const v2 = path.join(__dirname, 'fixtures', 'cores', 'counter-v2.js');

async function cleanupKernel(kernel, dataDir) {
  if (kernel?.stateStore?.db) await kernel.stop().catch(() => {});
  await fs.rm(dataDir, { recursive: true, force: true });
}

test('R11-M02-01 exact module revocation blocks initial activation before a CoreHost is built', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(() => cleanupKernel(kernel, dataDir));
  const definition = await inspectCoreModule(v1);
  assert.match(definition.moduleDigest, /^sha256:[0-9a-f]{64}$/);
  kernel.registry.revokeCore({
    coreId: definition.manifest.coreId,
    moduleDigest: definition.moduleDigest,
    reasonCode: 'R11_TEST_MODULE'
  });
  await assert.rejects(() => kernel.installCore(v1), error => error.code === 'CORE_REVOKED');
  const blockedSlot = kernel.registry.get('test-counter');
  assert.ok(blockedSlot, 'registry may allocate an inert slot before activation checks');
  assert.equal(blockedSlot.active, null);
  assert.equal(blockedSlot.candidate, null);
  assert.equal(blockedSlot.standby, null);
  assert.equal(kernel.stateStore.getAuthority('test-counter'), null);
});

test('R11-M02-02 revoking a staged implementation instance blocks commit without changing authority', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(() => cleanupKernel(kernel, dataDir));
  await kernel.installCore(v1);
  await kernel.stageCoreUpgrade(v2);
  await kernel.publish('test.tick', {});
  const slot = kernel.registry.get('test-counter');
  const candidate = slot.candidate;
  const before = kernel.stateStore.getAuthority('test-counter');
  kernel.registry.revokeCore({
    coreId: 'test-counter',
    instanceId: candidate.instanceId,
    reasonCode: 'R11_TEST_INSTANCE'
  });
  await assert.rejects(() => kernel.commitCoreUpgrade('test-counter', { minEvents: 1 }), error => error.code === 'CORE_REVOKED');
  const after = kernel.stateStore.getAuthority('test-counter');
  assert.equal(after.epoch, before.epoch);
  assert.equal(after.instanceId, before.instanceId);
  assert.equal(slot.active.manifest.version, '1.0.0');
  assert.equal(slot.candidate.instanceId, candidate.instanceId);
});

test('R11-M02-03 revoked standby cannot be resurrected by emergency rollback and biology keeps moving forward', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(() => cleanupKernel(kernel, dataDir));
  const seen = [];
  kernel.fabric.subscribe('test.pulse', event => seen.push({ ...event.payload, epoch: event.meta.authorityEpoch }));
  await kernel.installCore(v1);
  await kernel.publish('test.tick', {});
  await kernel.stageCoreUpgrade(v2);
  await kernel.publish('test.tick', {});
  await kernel.commitCoreUpgrade('test-counter', { minEvents: 1 });
  await kernel.publish('test.tick', {});

  const slot = kernel.registry.get('test-counter');
  const standby = slot.standby;
  const beforeAuthority = kernel.stateStore.getAuthority('test-counter');
  const beforeTicks = seen.at(-1).ticks;
  kernel.registry.revokeCore({
    coreId: 'test-counter',
    moduleDigest: standby.definition.moduleDigest,
    instanceId: standby.instanceId,
    reasonCode: 'R11_TEST_STANDBY'
  });

  await assert.rejects(() => kernel.rollbackCore('test-counter'), error => error.code === 'CORE_REVOKED');
  const afterAuthority = kernel.stateStore.getAuthority('test-counter');
  assert.equal(afterAuthority.epoch, beforeAuthority.epoch);
  assert.equal(afterAuthority.instanceId, beforeAuthority.instanceId);
  assert.equal(slot.active.manifest.version, '2.0.0');

  await kernel.publish('test.tick', {});
  assert.equal(seen.at(-1).generation, 'v2');
  assert.equal(seen.at(-1).ticks, beforeTicks + 1);
  assert.equal(seen.at(-1).epoch, beforeAuthority.epoch);
});

test('R11-M02-04 revocation ledger is append-only, idempotent, hash-chained and survives restart', async t => {
  const { kernel, dataDir } = await makeKernel();
  let restarted = null;
  t.after(async () => {
    if (restarted?.stateStore?.db) await restarted.stop().catch(() => {});
    if (kernel.stateStore.db) await kernel.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const definition = await inspectCoreModule(v1);
  const first = kernel.registry.revokeCore({
    coreId: 'test-counter',
    moduleDigest: definition.moduleDigest,
    reasonCode: 'R11_TEST_FIRST',
    createdAt: '2026-08-16T10:00:00.000Z'
  });
  assert.equal(first.created, true);
  const duplicate = kernel.registry.revokeCore({
    coreId: 'test-counter',
    moduleDigest: definition.moduleDigest,
    reasonCode: 'R11_TEST_CHANGED',
    createdAt: '2026-08-16T10:01:00.000Z'
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.record.reasonCode, 'R11_TEST_FIRST');
  assert.equal(kernel.registry.listCoreRevocations().length, 1);
  assert.deepEqual(kernel.registry.verifyCoreRevocations(), first.head);
  const headBefore = kernel.registry.coreRevocationHead();

  await kernel.stop();
  restarted = new LivingKernel({ dataDir, heartbeatIntervalMs: 0, snapshotIntervalMs: 0 });
  await restarted.start();
  assert.deepEqual(restarted.registry.coreRevocationHead(), headBefore);
  assert.equal(restarted.registry.listCoreRevocations('test-counter').length, 1);
  await assert.rejects(() => restarted.installCore(v1), error => error.code === 'CORE_REVOKED');
});

test('R11-M02-05 unrelated revocations do not block another exact implementation and there is no un-revoke API', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(() => cleanupKernel(kernel, dataDir));
  const d1 = await inspectCoreModule(v1);
  const d2 = await inspectCoreModule(v2);
  kernel.registry.revokeCore({
    coreId: 'test-counter',
    moduleDigest: d2.moduleDigest,
    reasonCode: 'R11_TEST_OTHER'
  });
  const unit = await kernel.installCore(v1);
  assert.equal(unit.manifest.version, '1.0.0');
  assert.notEqual(d1.moduleDigest, d2.moduleDigest);

  const methods = Object.getOwnPropertyNames(CoreRevocationRegistry.prototype);
  assert.equal(methods.some(name => /unrevoke|delete|remove|clear/i.test(name)), false);
});
