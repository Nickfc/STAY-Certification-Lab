'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { StateStore } = require('../runtime/kernel/state-store');

function transitionId(value) {
  return 'sha256:' + crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function makeStore(t, name = 'cutover') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `stay-ef1-g-${name}-`));
  const holder = { store: new StateStore(dir) };
  await holder.store.init();

  t.after(async () => {
    try { holder.store?.close(); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  holder.store.setInitialAuthority({
    coreId: 'alpha', instanceId: 'a1', version: '1.0.0', epoch: 1, barrierSequence: 0
  });
  holder.store.registerBiologicalConsumer({
    consumerId: 'core:alpha', coreId: 'alpha', topics: ['bio.tick'], required: true, authorityEpoch: 1
  });

  return { dir, holder };
}

function appendInput(store, key = 'input-1') {
  return store.appendBiologicalEvent({
    topic: 'bio.tick', payload: { value: 1 }, meta: { deduplicationKey: key },
    eventClass: 'durable', at: 1001, minimum: 0
  }).event;
}

async function commitOldEpochOutput(store, key = 'input-1') {
  const input = appendInput(store, key);
  const id = transitionId(input.sequence);
  const checkpoint = await store.commitCheckpoint({
    coreId: 'alpha', instanceId: 'a1', version: '1.0.0', authorityEpoch: 1,
    stateSchema: 1, state: { applied: input.sequence }, updateAuthority: true,
    consumerAck: { consumerId: 'core:alpha', sequence: input.sequence, transitionId: id },
    producerTransitionId: id,
    outboxIntents: [{
      outputIndex: 1,
      topic: 'bio.output',
      payload: { source: input.sequence },
      causeSequence: input.sequence,
      causalParent: input.id
    }]
  });
  return { input, checkpoint, intent: checkpoint.outboxIntents[0] };
}

async function prepareTarget(store, barrierSequence = 77) {
  const checkpoint = await store.commitCheckpoint({
    coreId: 'alpha', instanceId: 'a2', version: '2.0.0', authorityEpoch: 2,
    stateSchema: 1, state: { upgraded: true }, updateAuthority: false
  });
  const tx = store.prepareUpgrade({
    coreId: 'alpha',
    from: { instanceId: 'a1', version: '1.0.0', epoch: 1 },
    to: { instanceId: 'a2', version: '2.0.0', epoch: 2 },
    barrierSequence,
    checkpoint,
    detail: { test: true }
  });
  return { checkpoint, tx };
}

function publishIntent(store, intent, minimum = 0) {
  return store.appendBiologicalEvent({
    topic: intent.topic,
    payload: intent.payload,
    meta: intent.publishMeta,
    eventClass: 'durable',
    at: 5000,
    minimum
  }).event;
}

test('EF1-G authority promotion atomically spools every committed pending old-epoch output before revocation', async t => {
  const { holder } = await makeStore(t, 'atomic-spool');
  const { intent } = await commitOldEpochOutput(holder.store);
  const { tx } = await prepareTarget(holder.store, 88);

  const authority = holder.store.commitUpgrade(tx.transactionId);
  assert.equal(authority.epoch, 2);
  assert.equal(authority.instanceId, 'a2');

  const spool = holder.store.getBiologicalCutoverSpoolIntent(intent.producerEventId);
  assert.equal(spool.status, 'SPOOLED');
  assert.equal(spool.fromAuthorityEpoch, 1);
  assert.equal(spool.toAuthorityEpoch, 2);
  assert.equal(spool.barrierSequence, 88);
  assert.equal(spool.producerEventId, intent.producerEventId);
  assert.equal(spool.producerStreamId, intent.producerStreamId);
  assert.equal(spool.streamSequence, intent.streamSequence);
  assert.equal(spool.intentHash, intent.intentHash);

  const sealed = holder.store.getUpgradeTransaction(tx.transactionId);
  assert.equal(sealed.status, 'COMMITTED');
  assert.equal(sealed.spooledIntentCount, 1);
  assert.ok(sealed.spoolHash);
  assert.ok(sealed.cutoverSealedAt);
});

test('EF1-G injected spool failure rolls back authority cutover and leaves the old epoch authoritative', async t => {
  const { holder } = await makeStore(t, 'rollback');
  await commitOldEpochOutput(holder.store);
  const { tx } = await prepareTarget(holder.store);

  holder.store.db.exec(`
    CREATE TRIGGER ef1_g_spool_abort
    BEFORE INSERT ON biological_cutover_spool
    BEGIN
      SELECT RAISE(ABORT, 'TEST_CUTOVER_SPOOL_FAILURE');
    END;
  `);

  assert.throws(
    () => holder.store.commitUpgrade(tx.transactionId),
    /TEST_CUTOVER_SPOOL_FAILURE/
  );

  const authority = holder.store.getAuthority('alpha');
  assert.equal(authority.epoch, 1);
  assert.equal(authority.instanceId, 'a1');
  assert.equal(holder.store.listBiologicalCutoverSpool({ producerCoreId: 'alpha' }).length, 0);
  assert.equal(holder.store.getUpgradeTransaction(tx.transactionId).status, 'PREPARED');
});

test('EF1-G revoked old-epoch spool is drainable under the new authority without impersonating the old epoch', async t => {
  const { holder } = await makeStore(t, 'drainable');
  const { intent } = await commitOldEpochOutput(holder.store);
  const { tx } = await prepareTarget(holder.store);
  holder.store.commitUpgrade(tx.transactionId);

  const drainable = holder.store.listDrainableBiologicalOutboxIntents({
    producerCoreId: 'alpha', currentAuthorityEpoch: 2
  });

  assert.equal(drainable.length, 1);
  assert.equal(drainable[0].producerEventId, intent.producerEventId);
  assert.equal(drainable[0].authorityEpoch, 1);
  assert.equal(drainable[0].producerInstanceId, 'a1');
});

test('EF1-G old-epoch pending output without a Kernel spool fails closed after authority changes', async t => {
  const { holder } = await makeStore(t, 'orphan');
  await commitOldEpochOutput(holder.store);

  holder.store.db.prepare(`
    UPDATE authority
    SET instance_id='a2', version='2.0.0', epoch=2, barrier_sequence=99
    WHERE core_id='alpha'
  `).run();

  assert.throws(
    () => holder.store.listDrainableBiologicalOutboxIntents({ producerCoreId: 'alpha', currentAuthorityEpoch: 2 }),
    error => error?.code === 'BIOLOGICAL_CUTOVER_ORPHANED_OUTBOX'
  );
});

test('EF1-G future-epoch pending output cannot be drained by an older authority', async t => {
  const { holder } = await makeStore(t, 'future');
  await commitOldEpochOutput(holder.store);

  holder.store.db.prepare(`
    UPDATE biological_outbox_intents
    SET authority_epoch=2
    WHERE producer_core_id='alpha'
  `).run();

  assert.throws(
    () => holder.store.listDrainableBiologicalOutboxIntents({ producerCoreId: 'alpha', currentAuthorityEpoch: 1 }),
    error => error?.code === 'BIOLOGICAL_OUTBOX_FUTURE_AUTHORITY'
  );
});

test('EF1-G published old-epoch spool binds to the exact durable Fabric identity and becomes accepted', async t => {
  const { holder } = await makeStore(t, 'published');
  const { input, intent } = await commitOldEpochOutput(holder.store);
  const { tx } = await prepareTarget(holder.store);
  holder.store.commitUpgrade(tx.transactionId);

  const event = publishIntent(holder.store, intent, input.sequence);
  const marked = holder.store.markBiologicalOutboxPublished({ producerEventId: intent.producerEventId, event });
  assert.equal(marked.status, 'PUBLISHED');

  const spool = holder.store.getBiologicalCutoverSpoolIntent(intent.producerEventId);
  assert.equal(spool.status, 'ACCEPTED');
  assert.equal(spool.fabricSequence, event.sequence);
  assert.equal(spool.fabricEventId, event.id);

  const retry = holder.store.markBiologicalOutboxPublished({ producerEventId: intent.producerEventId, event });
  assert.equal(retry.fabricSequence, event.sequence);
  assert.equal(holder.store.getBiologicalCutoverSpoolIntent(intent.producerEventId).status, 'ACCEPTED');
});

test('EF1-G cutover spool and exact old-epoch identity survive StateStore restart', async t => {
  const { dir, holder } = await makeStore(t, 'restart');
  const { intent } = await commitOldEpochOutput(holder.store);
  const { tx } = await prepareTarget(holder.store);
  holder.store.commitUpgrade(tx.transactionId);

  holder.store.close();
  holder.store = new StateStore(dir);
  await holder.store.init();

  const spool = holder.store.getBiologicalCutoverSpoolIntent(intent.producerEventId);
  assert.equal(spool.status, 'SPOOLED');
  assert.equal(spool.fromAuthorityEpoch, 1);
  assert.equal(holder.store.getAuthority('alpha').epoch, 2);

  const drainable = holder.store.listDrainableBiologicalOutboxIntents({
    producerCoreId: 'alpha', currentAuthorityEpoch: 2
  });
  assert.equal(drainable.length, 1);
  assert.equal(drainable[0].producerEventId, intent.producerEventId);
});

test('EF1-G accepted historical spool remains immutable evidence after another authority epoch advances', async t => {
  const { holder } = await makeStore(t, 'history');
  const { input, intent } = await commitOldEpochOutput(holder.store);
  const { tx } = await prepareTarget(holder.store);
  holder.store.commitUpgrade(tx.transactionId);

  const event = publishIntent(holder.store, intent, input.sequence);
  holder.store.markBiologicalOutboxPublished({ producerEventId: intent.producerEventId, event });

  holder.store.db.prepare(`UPDATE authority SET epoch=3, instance_id='a3', version='3.0.0' WHERE core_id='alpha'`).run();
  const spool = holder.store.getBiologicalCutoverSpoolIntent(intent.producerEventId);
  assert.equal(spool.status, 'ACCEPTED');
  assert.equal(spool.fromAuthorityEpoch, 1);
  assert.equal(spool.fabricSequence, event.sequence);
});

test('EF1-G cutover transaction aggregate spool seal detects missing or tampered spool evidence', async t => {
  const { holder } = await makeStore(t, 'aggregate-seal');
  await commitOldEpochOutput(holder.store);
  const { tx } = await prepareTarget(holder.store);
  holder.store.commitUpgrade(tx.transactionId);

  const before = holder.store.getUpgradeTransaction(tx.transactionId);
  assert.equal(before.spooledIntentCount, 1);

  holder.store.db.prepare(`UPDATE upgrade_transactions SET spool_sha256=? WHERE transaction_id=?`)
    .run('0'.repeat(64), tx.transactionId);

  assert.throws(
    () => holder.store.getUpgradeTransaction(tx.transactionId),
    error => error?.code === 'BIOLOGICAL_CUTOVER_SPOOL_CORRUPT'
  );
});
