'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeKernel, waitFor, fs, path } = require('./helpers');
const { StateStore } = require('../runtime/kernel/state-store');

const producerPath = path.join(__dirname, 'fixtures', 'cores', 'ledger-producer.js');
const sinkPath = path.join(__dirname, 'fixtures', 'cores', 'ledger-sink.js');

test('G0-01: durable envelope and provenance hashes exist before delivery', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(async () => { await kernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  let observed = null;
  kernel.fabric.subscribe('ledger.inspect', event => {
    const row = kernel.stateStore.db.prepare('SELECT * FROM biological_events WHERE sequence=?').get(event.sequence);
    assert.ok(row, 'ledger row must exist before the first handler runs');
    assert.equal(row.event_id, event.id);
    assert.equal(row.envelope_sha256, event.ledger.envelopeHash.replace('sha256:', ''));
    observed = event;
  });
  const event = await kernel.publish('ledger.inspect', { magnitude: 42 }, {
    eventClass: 'durable', evidenceHash: 'sha256:test-evidence', deduplicationKey: 'g0-01'
  });
  assert.equal(observed.id, event.id);
  assert.equal(kernel.stateStore.biologicalLedgerStatus().events, 1);
});

test('G0-02: deterministic keys deduplicate exact events and reject conflicting content', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(async () => { await kernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  const first = await kernel.publish('ledger.dedup', { value: 7 }, { eventClass: 'durable', deduplicationKey: 'same-cause' });
  const repeated = await kernel.publish('ledger.dedup', { value: 7 }, { eventClass: 'durable', deduplicationKey: 'same-cause' });
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.sequence, first.sequence);
  assert.equal(repeated.ledger.deduplicated, true);
  assert.equal(kernel.stateStore.biologicalLedgerStatus().events, 1);
  await assert.rejects(
    () => kernel.publish('ledger.dedup', { value: 8 }, { eventClass: 'durable', deduplicationKey: 'same-cause' }),
    error => error.code === 'EVENT_DEDUP_CONFLICT'
  );
});

test('G0-03: checkpoint, physiological transition and consumer acknowledgement commit atomically', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(async () => { await kernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  await kernel.installCore(producerPath);
  const event = await kernel.publish('bio.tick', { value: 1 }, { eventClass: 'durable', deduplicationKey: 'g0-03-tick' });
  const checkpoint = await kernel.stateStore.readAuthoritativeCheckpoint('ledger-producer');
  const delivery = kernel.stateStore.getBiologicalDelivery('core:ledger-producer', event.sequence);
  const consumer = kernel.stateStore.getBiologicalConsumer('core:ledger-producer');
  assert.equal(checkpoint.state.ticks, 1);
  assert.equal(checkpoint.inputCursor, event.sequence);
  assert.equal(delivery.status, 'ACKED');
  assert.equal(delivery.checkpointHash, checkpoint.blobHash);
  assert.ok(delivery.transitionId.startsWith('sha256:'));
  assert.ok(consumer.cursor >= event.sequence);
});

test('G0-04: failed producer commit publishes nothing before transition commit and replay produces exactly once', async t => {
  const { kernel, dataDir } = await makeKernel();
  let activeKernel = kernel;
  t.after(async () => { await activeKernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  await kernel.installCore(producerPath);
  await kernel.installCore(sinkPath);

  const originalCommit = kernel.stateStore.commitCheckpoint.bind(kernel.stateStore);
  let injected = false;
  kernel.stateStore.commitCheckpoint = async options => {
    if (!injected && options.coreId === 'ledger-producer' && options.consumerAck) {
      injected = true;
      throw Object.assign(new Error('injected power-loss boundary'), { code: 'TEST_POWER_LOSS' });
    }
    return originalCommit(options);
  };

  await assert.rejects(
    () => kernel.publish('bio.tick', { value: 1 }, { eventClass: 'durable', deduplicationKey: 'g0-04-tick' }),
    error => error.code === 'EVENT_DELIVERY_FAILED'
  );
  await waitFor(() => kernel.registry.get('ledger-producer')?.active?.client?.lifecycle === 'active');
  const pendingBefore = kernel.stateStore.listPendingBiologicalEvents('core:ledger-producer');
  assert.equal(pendingBefore.filter(event => event.topic === 'bio.tick').length, 1);
  assert.equal(
    (await kernel.stateStore.readAuthoritativeCheckpoint('ledger-sink')).state.observed,
    0
  );
  assert.equal(
    kernel.stateStore.listPendingBiologicalOutboxIntents({
      producerCoreId: 'ledger-producer'
    }).length,
    0
  );

  kernel.stateStore.commitCheckpoint = originalCommit;
  await kernel.stop();

  const { kernel: restarted } = await makeKernel({ dataDir, allowIdentityBootstrap: false });
  activeKernel = restarted;
  await restarted.installCore(sinkPath);
  await restarted.installCore(producerPath);
  assert.equal((await restarted.stateStore.readAuthoritativeCheckpoint('ledger-producer')).state.ticks, 1);
  assert.equal((await restarted.stateStore.readAuthoritativeCheckpoint('ledger-sink')).state.observed, 1);
  assert.equal(restarted.stateStore.listPendingBiologicalEvents('core:ledger-producer').length, 0);
  assert.equal(restarted.stateStore.listPendingBiologicalEvents('core:ledger-sink').length, 0);
  assert.equal(restarted.stateStore.db.prepare("SELECT COUNT(*) AS count FROM biological_events WHERE topic='bio.observed'").get().count, 1);
});

test('G0-05: consumer cursors do not cross an earlier pending event and retention waits for every required consumer', async t => {
  const dataDir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'stay-g0-cursors-'));
  const store = new StateStore(dataDir);
  await store.init();
  t.after(async () => { store.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  store.registerBiologicalConsumer({ consumerId: 'core:a', coreId: 'a', topics: ['bio.test'], required: true });
  store.registerBiologicalConsumer({ consumerId: 'core:b', coreId: 'b', topics: ['bio.test'], required: true });
  const events = [1, 2, 3].map(value => store.appendBiologicalEvent({
    topic: 'bio.test', payload: { value }, meta: { deduplicationKey: `g0-05-${value}` },
    eventClass: 'durable', at: 1000 + value, minimum: value - 1
  }).event);
  store.acknowledgeBiologicalEvent({ consumerId: 'core:a', sequence: events[1].sequence });
  assert.equal(store.getBiologicalConsumer('core:a').cursor, 0);
  store.acknowledgeBiologicalEvent({ consumerId: 'core:a', sequence: events[0].sequence });
  assert.equal(store.getBiologicalConsumer('core:a').cursor, events[1].sequence);
  store.acknowledgeBiologicalEvent({ consumerId: 'core:a', sequence: events[2].sequence });
  store.acknowledgeBiologicalEvent({ consumerId: 'core:b', sequence: events[0].sequence });
  const firstPrune = store.pruneBiologicalEvents({ retainCount: 1 });
  assert.equal(firstPrune.removed, 1);
  assert.deepEqual(store.listPendingBiologicalEvents('core:b').map(event => event.sequence), [events[1].sequence, events[2].sequence]);
  store.acknowledgeBiologicalEvent({ consumerId: 'core:b', sequence: events[2].sequence });
  assert.equal(store.getBiologicalConsumer('core:b').cursor, events[0].sequence);
  store.acknowledgeBiologicalEvent({ consumerId: 'core:b', sequence: events[1].sequence });
  assert.equal(store.getBiologicalConsumer('core:b').cursor, events[2].sequence);
  const secondPrune = store.pruneBiologicalEvents({ retainCount: 1 });
  assert.equal(secondPrune.removed, 1);
  assert.equal(store.biologicalLedgerStatus().events, 1);
});

test('G0-06: altered durable envelope fails integrity verification before replay', async t => {
  const dataDir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'stay-g0-corrupt-'));
  const store = new StateStore(dataDir);
  await store.init();
  t.after(async () => { store.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  store.registerBiologicalConsumer({ consumerId: 'core:a', coreId: 'a', topics: ['bio.test'], required: true });
  const event = store.appendBiologicalEvent({
    topic: 'bio.test', payload: { value: 1 }, meta: { deduplicationKey: 'g0-06' }, eventClass: 'durable', at: 1000
  }).event;
  store.db.prepare('UPDATE biological_events SET envelope_json=? WHERE sequence=?').run('{"corrupt":true}', event.sequence);
  assert.throws(() => store.listPendingBiologicalEvents('core:a'), error => error.code === 'BIOLOGICAL_EVENT_CORRUPT');
});
