'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StateStore } = require('../runtime/kernel/state-store');
const { makeDataDir, fs } = require('./helpers');

test('checkpoint blobs are content-addressed and corruption is detected', async t => {
  const dir = await makeDataDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  await store.init();
  store.setInitialAuthority({ coreId: 'alpha', instanceId: 'a1', version: '1.0.0', epoch: 1 });
  const checkpoint = await store.commitCheckpoint({ coreId: 'alpha', instanceId: 'a1', version: '1.0.0', authorityEpoch: 1, stateSchema: 1, state: { alive: true } });
  assert.deepEqual((await store.readLatestCheckpoint('alpha')).state, { alive: true });
  await fs.writeFile(store.blobPath(checkpoint.blobHash), 'corrupt');
  await assert.rejects(() => store.readLatestCheckpoint('alpha'), error => error.code === 'CHECKPOINT_CORRUPT');
  store.close();
});

test('incomplete upgrade transaction reconciles deterministically from durable authority', async t => {
  const dir = await makeDataDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let store = new StateStore(dir);
  await store.init();
  store.setInitialAuthority({ coreId: 'alpha', instanceId: 'a1', version: '1.0.0', epoch: 1 });
  const tx = store.prepareUpgrade({
    coreId: 'alpha',
    from: { instanceId: 'a1', version: '1.0.0', epoch: 1 },
    to: { instanceId: 'a2', version: '2.0.0', epoch: 2 },
    barrierSequence: 99
  });
  store.close();
  store = new StateStore(dir);
  await store.init();
  const row = store.db.prepare('SELECT status FROM upgrade_transactions WHERE transaction_id=?').get(tx.transactionId);
  assert.equal(row.status, 'ABORTED');
  assert.equal(store.getAuthority('alpha').instanceId, 'a1');
  store.close();
});

test('snapshot v2 contains a verified SQLite continuity image and immutable blobs', async t => {
  const dir = await makeDataDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  await store.init();
  await store.writeLife('identity', { organismId: 'stay-test', createdAt: '2026-01-01T00:00:00.000Z', lineage: 'STAY/Genesis' });
  store.setInitialAuthority({ coreId: 'alpha', instanceId: 'a1', version: '1.0.0', epoch: 1 });
  await store.commitCheckpoint({ coreId: 'alpha', instanceId: 'a1', version: '1.0.0', authorityEpoch: 1, stateSchema: 1, state: { n: 1 } });
  const snapshot = await store.createSnapshot({ reason: 'test', retention: 2 });
  const manifest = await store.verifySnapshot(snapshot.path);
  assert.equal(manifest.format, 'stay-runtime-snapshot-v2');
  assert.ok(manifest.files['continuity.sqlite3']);
  store.close();
});
