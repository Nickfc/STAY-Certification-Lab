'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { StateStore } = require('../runtime/kernel/state-store');
const { EventFabric } = require('../runtime/kernel/event-fabric');
const { RuntimeSlot } = require('../runtime/kernel/slot');

function transitionId(value) {
  return 'sha256:' + crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function makeDir(t, name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `stay-ef1-h-${name}-`));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function seedCutover(dir) {
  const store = new StateStore(dir);
  await store.init();
  store.setInitialAuthority({
    coreId: 'ledger-producer', instanceId: 'producer-old', version: '1.0.0', epoch: 1
  });
  store.registerBiologicalConsumer({
    consumerId: 'core:ledger-producer', coreId: 'ledger-producer', topics: ['bio.tick'],
    required: true, authorityEpoch: 1
  });

  const input = store.appendBiologicalEvent({
    topic: 'bio.tick', payload: { value: 1 }, meta: { deduplicationKey: 'ef1-h-origin' },
    eventClass: 'durable', at: 1000, minimum: 0
  }).event;
  const id = transitionId(input.sequence);
  const origin = await store.commitCheckpoint({
    coreId: 'ledger-producer', instanceId: 'producer-old', version: '1.0.0', authorityEpoch: 1,
    stateSchema: 1, state: { ticks: 1 }, updateAuthority: true,
    consumerAck: { consumerId: 'core:ledger-producer', sequence: input.sequence, transitionId: id },
    producerTransitionId: id,
    outboxIntents: [{
      outputIndex: 1, topic: 'bio.observed', payload: { ticks: 1, sourceEventId: input.id },
      causeSequence: input.sequence, causalParent: input.id
    }]
  });

  const target = await store.commitCheckpoint({
    coreId: 'ledger-producer', instanceId: 'producer-new', version: '1.0.0', authorityEpoch: 2,
    stateSchema: 1, state: { ticks: 1 }, updateAuthority: false
  });
  const tx = store.prepareUpgrade({
    coreId: 'ledger-producer',
    from: { instanceId: 'producer-old', version: '1.0.0', epoch: 1 },
    to: { instanceId: 'producer-new', version: '1.0.0', epoch: 2 },
    barrierSequence: input.sequence,
    checkpoint: target,
    detail: { hostile: true }
  });
  store.commitUpgrade(tx.transactionId);
  const intent = origin.outboxIntents[0];
  store.close();
  return { input, intent, transactionId: tx.transactionId };
}

function makeFabric(store) {
  return new EventFabric({
    clock: () => 5000,
    durableAppender: options => store.appendBiologicalEvent(options)
  });
}

function makeDrainSlot(store, fabric, epoch = 2) {
  const slot = Object.create(RuntimeSlot.prototype);
  slot.coreId = 'ledger-producer';
  slot.stateStore = store;
  slot.fabric = fabric;
  slot.authorityEpoch = epoch;
  slot.logger = { warn() {} };
  return slot;
}

test('EF1-H whole-process restart after cutover commit replays one spooled old-epoch obligation with its original identity', async t => {
  const dir = await makeDir(t, 'restart-drain');
  const seeded = await seedCutover(dir);

  const store = new StateStore(dir);
  await store.init();
  t.after(() => { try { store.close(); } catch {} });
  const fabric = makeFabric(store);
  const observed = [];
  fabric.subscribe('bio.observed', event => { observed.push(event); });
  const slot = makeDrainSlot(store, fabric, 2);

  const drained = await slot.drainProducerOutbox();

  assert.equal(drained, 1);
  assert.equal(observed.length, 1);
  const spool = store.getBiologicalCutoverSpoolIntent(seeded.intent.producerEventId);
  assert.equal(spool.status, 'ACCEPTED');
  assert.equal(spool.fromAuthorityEpoch, 1);
  assert.equal(store.getAuthority('ledger-producer').epoch, 2);
  assert.equal(store.listDrainableBiologicalOutboxIntents({ producerCoreId: 'ledger-producer', currentAuthorityEpoch: 2 }).length, 0);
});

test('EF1-H second recovery drain after accepted spool cannot apply the same historical output twice', async t => {
  const dir = await makeDir(t, 'restart-twice');
  const seeded = await seedCutover(dir);

  let store = new StateStore(dir);
  await store.init();
  let fabric = makeFabric(store);
  let firstCount = 0;
  fabric.subscribe('bio.observed', () => { firstCount += 1; });
  let slot = makeDrainSlot(store, fabric, 2);
  assert.equal(await slot.drainProducerOutbox(), 1);
  assert.equal(firstCount, 1);
  store.close();

  store = new StateStore(dir);
  await store.init();
  t.after(() => { try { store.close(); } catch {} });
  fabric = makeFabric(store);
  let secondCount = 0;
  fabric.subscribe('bio.observed', () => { secondCount += 1; });
  slot = makeDrainSlot(store, fabric, 2);

  assert.equal(await slot.drainProducerOutbox(), 0);
  assert.equal(secondCount, 0);
  assert.equal(store.getBiologicalCutoverSpoolIntent(seeded.intent.producerEventId).status, 'ACCEPTED');
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM biological_events WHERE topic='bio.observed'`).get().n, 1);
});

test('EF1-H ambiguous publish failure retains the spool and retry binds the same durable event identity exactly once', async t => {
  const dir = await makeDir(t, 'delivery-failure');
  const seeded = await seedCutover(dir);

  const store = new StateStore(dir);
  await store.init();
  t.after(() => { try { store.close(); } catch {} });
  const fabric = makeFabric(store);
  let fail = true;
  let attempts = 0;
  fabric.subscribe('bio.observed', () => {
    attempts += 1;
    if (fail) throw Object.assign(new Error('hostile downstream failure'), { code: 'EF1_H_DOWNSTREAM' });
  });
  const slot = makeDrainSlot(store, fabric, 2);

  await assert.rejects(
    () => slot.drainProducerOutbox(),
    error => error?.code === 'EVENT_DELIVERY_FAILED'
  );

  assert.equal(attempts, 1);
  assert.equal(store.getBiologicalCutoverSpoolIntent(seeded.intent.producerEventId).status, 'SPOOLED');
  assert.equal(store.getBiologicalOutboxIntent(seeded.intent.producerEventId).status, 'PENDING');
  const firstEvent = store.db.prepare(`SELECT event_id, sequence FROM biological_events WHERE topic='bio.observed'`).get();
  assert.ok(firstEvent);

  fail = false;
  const drained = await slot.drainProducerOutbox();
  assert.equal(drained, 1);
  assert.equal(attempts, 2);
  const spool = store.getBiologicalCutoverSpoolIntent(seeded.intent.producerEventId);
  assert.equal(spool.status, 'ACCEPTED');
  assert.equal(spool.fabricSequence, firstEvent.sequence);
  assert.equal(spool.fabricEventId, firstEvent.event_id);
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM biological_events WHERE topic='bio.observed'`).get().n, 1);
});

test('EF1-H crash before cutover seal preserves old authority and ordinary pending output rather than inventing a new epoch', async t => {
  const dir = await makeDir(t, 'before-seal');
  const store = new StateStore(dir);
  await store.init();
  store.setInitialAuthority({ coreId: 'alpha', instanceId: 'old', version: '1.0.0', epoch: 1 });
  store.registerBiologicalConsumer({ consumerId: 'core:alpha', coreId: 'alpha', topics: ['tick'], required: true, authorityEpoch: 1 });
  const input = store.appendBiologicalEvent({ topic: 'tick', payload: {}, meta: { deduplicationKey: 'before-seal' }, eventClass: 'durable', at: 1 }).event;
  const id = transitionId(input.sequence);
  await store.commitCheckpoint({
    coreId: 'alpha', instanceId: 'old', version: '1.0.0', authorityEpoch: 1, stateSchema: 1, state: { n: 1 },
    consumerAck: { consumerId: 'core:alpha', sequence: input.sequence, transitionId: id }, producerTransitionId: id,
    outboxIntents: [{ outputIndex: 1, topic: 'out', payload: { n: 1 }, causeSequence: input.sequence, causalParent: input.id }]
  });
  const target = await store.commitCheckpoint({ coreId: 'alpha', instanceId: 'new', version: '2.0.0', authorityEpoch: 2, stateSchema: 1, state: { n: 1 }, updateAuthority: false });
  store.prepareUpgrade({
    coreId: 'alpha', from: { instanceId: 'old', version: '1.0.0', epoch: 1 },
    to: { instanceId: 'new', version: '2.0.0', epoch: 2 }, barrierSequence: input.sequence, checkpoint: target
  });
  store.close();

  const recovered = new StateStore(dir);
  await recovered.init();
  t.after(() => { try { recovered.close(); } catch {} });
  assert.equal(recovered.getAuthority('alpha').epoch, 1);
  assert.equal(recovered.listPendingBiologicalOutboxIntents({ producerCoreId: 'alpha' }).length, 1);
  assert.equal(recovered.listBiologicalCutoverSpool({ producerCoreId: 'alpha' }).length, 0);
});

test('EF1-H committed cutover spool hash tampering fails closed after restart', async t => {
  const dir = await makeDir(t, 'spool-tamper');
  const seeded = await seedCutover(dir);
  const store = new StateStore(dir);
  await store.init();
  t.after(() => { try { store.close(); } catch {} });

  store.db.prepare(`UPDATE biological_cutover_spool SET barrier_sequence=barrier_sequence+1 WHERE producer_event_id=?`).run(seeded.intent.producerEventId);
  assert.throws(
    () => store.getBiologicalCutoverSpoolIntent(seeded.intent.producerEventId),
    error => error?.code === 'BIOLOGICAL_CUTOVER_SPOOL_CORRUPT'
  );
});

test('EF1-H initial recovery binds persisted authority before attempting old-epoch spool drain and before input replay', async () => {
  const calls = [];
  const slot = Object.create(RuntimeSlot.prototype);
  slot.coreId = 'alpha';
  slot.consumerId = 'core:alpha';
  slot.active = null;
  slot.authorityEpoch = 0;
  slot.cutoverBarrier = 0;
  slot.stateStore = {
    getAuthority(coreId) {
      assert.equal(coreId, 'alpha');
      return { coreId, instanceId: 'new-instance', version: '2.0.0', epoch: 7, barrierSequence: 55 };
    },
    async readAuthoritativeCheckpoint() {
      return { stateSchema: 1, state: { recovered: true } };
    },
    registerBiologicalConsumer(value) {
      calls.push(['consumer', value.authorityEpoch]);
    }
  };
  slot.buildUnit = async (_definition, envelope, mode, instanceId, epoch) => {
    calls.push(['build', mode, instanceId, epoch, envelope.state.recovered]);
    return { manifest: { inputs: [], stateSchema: 1 }, instanceId, assignedEpoch: epoch, mode };
  };
  slot.persistActive = async () => { calls.push(['persist', slot.authorityEpoch]); };
  slot.tryDrainProducerOutbox = async () => { calls.push(['drain', slot.authorityEpoch]); return 1; };
  slot.replayPendingBiologicalEvents = async () => { calls.push(['replay', slot.authorityEpoch]); };

  await RuntimeSlot.prototype.installInitial.call(slot, {
    manifest: { coreId: 'alpha', version: '2.0.0', stateSchema: 1 }
  });

  assert.equal(slot.authorityEpoch, 7);
  assert.equal(slot.cutoverBarrier, 55);
  assert.deepEqual(
    calls.map(call => call[0]),
    ['build', 'consumer', 'persist', 'drain', 'replay']
  );
  assert.deepEqual(calls.find(call => call[0] === 'drain'), ['drain', 7]);
});
