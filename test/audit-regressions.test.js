'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LivingKernel } = require('../runtime');
const { normalizePolicy } = require('../runtime/kernel/resource-governor');
const { makeKernel, fs, path } = require('./helpers');

const v1 = path.join(__dirname, 'fixtures', 'cores', 'counter-v1.js');
const v2 = path.join(__dirname, 'fixtures', 'cores', 'counter-v2.js');
const signalCore = path.join(__dirname, 'fixtures', 'cores', 'signal-core.js');
const outputFloodCore = path.join(__dirname, 'fixtures', 'cores', 'output-flood-core.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('A-01: post-barrier events are never authored by the old epoch', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(async () => { if (kernel.stateStore.db) await kernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  await kernel.installCore(v1);
  await kernel.stageCoreUpgrade(v2);
  await kernel.publish('test.tick', {});
  const slot = kernel.registry.get('test-counter');
  const outputs = [];
  kernel.fabric.subscribe('test.pulse', event => outputs.push({ causeSequence: event.meta.causeSequence, epoch: event.meta.authorityEpoch }));
  let revealBarrier;
  const barrierSeen = new Promise(resolve => { revealBarrier = resolve; });
  const originalDrain = slot.active.queue.drainThrough.bind(slot.active.queue);
  slot.active.queue.drainThrough = async sequence => { revealBarrier(sequence); await pause(100); return originalDrain(sequence); };
  const committing = kernel.commitCoreUpgrade('test-counter', { minEvents: 1 });
  const barrier = await barrierSeen;
  const input = await kernel.publish('test.tick', {});
  await committing;
  const output = outputs.find(entry => entry.causeSequence === input.sequence);
  assert.ok(input.sequence > barrier);
  assert.equal(output?.epoch, 2);
});

test('A-02: committed candidate authority always restarts from its exact checkpoint', async t => {
  const { kernel, dataDir } = await makeKernel();
  let restarted = null;
  t.after(async () => {
    if (restarted?.stateStore.db) await restarted.stop().catch(() => {});
    if (kernel.stateStore.db) { await kernel.registry.stop().catch(() => {}); kernel.stateStore.close(); }
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await kernel.installCore(v1);
  await kernel.publish('test.tick', {});
  await kernel.publish('test.tick', {});
  await kernel.stageCoreUpgrade(v2);
  await kernel.publish('test.tick', {});
  const slot = kernel.registry.get('test-counter');
  const originalPersist = slot.persistActive.bind(slot);
  let persistCalls = 0;
  slot.persistActive = async () => {
    persistCalls += 1;
    if (persistCalls === 2) throw Object.assign(new Error('simulated post-commit process death'), { code: 'AUDIT_CRASH_WINDOW' });
    return originalPersist();
  };
  await assert.rejects(() => kernel.commitCoreUpgrade('test-counter', { minEvents: 1 }), error => error.code === 'AUDIT_CRASH_WINDOW');
  const authority = kernel.stateStore.getAuthority('test-counter');
  assert.equal(authority.version, '2.0.0');
  const exact = await kernel.stateStore.readAuthoritativeCheckpoint('test-counter');
  assert.equal(exact.instanceId, authority.instanceId);
  assert.equal(exact.authorityEpoch, authority.epoch);
  await kernel.registry.stop();
  kernel.stateStore.close();

  restarted = new LivingKernel({ dataDir, heartbeatIntervalMs: 0, snapshotIntervalMs: 0 });
  await restarted.start();
  const outputs = [];
  restarted.fabric.subscribe('test.pulse', event => outputs.push(event.payload));
  await restarted.installCore(v2);
  await restarted.publish('test.tick', {});
  assert.equal(outputs.at(-1).ticks, 4);
  assert.equal(outputs.at(-1).migrations, 1);
});

test('A-03: downstream output failure preserves committed transition and retries one durable outbox event exactly', async t => {
  const { kernel, dataDir } = await makeKernel();

  t.after(async () => {
    if (kernel.stateStore.db) {
      await kernel.stop().catch(() => {});
    }

    await fs.rm(
      dataDir,
      {
        recursive: true,
        force: true
      }
    );
  });

  await kernel.installCore(v1);

  let failDelivery = true;
  let deliveryAttempts = 0;
  let successfulDeliveries = 0;

  kernel.fabric.subscribe(
    'test.pulse',
    event => {
      deliveryAttempts += 1;

      if (failDelivery) {
        throw Object.assign(
          new Error('downstream failure'),
          {
            code:
              'AUDIT_DOWNSTREAM_FAILURE'
          }
        );
      }

      successfulDeliveries += 1;

      assert.equal(
        event.topic,
        'test.pulse'
      );
    }
  );

  /*
   * EF1-D / P0.34:
   *
   * The producer's state + input ACK + output obligation
   * commit before transport. A downstream transport failure
   * therefore may not retroactively reject that transition.
   */
  const input =
    await kernel.publish(
      'test.tick',
      {}
    );

  const checkpoint =
    await kernel.stateStore
      .readAuthoritativeCheckpoint(
        'test-counter'
      );

  const inputDelivery =
    kernel.stateStore
      .getBiologicalDelivery(
        'core:test-counter',
        input.sequence
      );

  const pending =
    kernel.stateStore
      .listPendingBiologicalOutboxIntents({
        producerCoreId:
          'test-counter'
      });

  assert.equal(
    checkpoint.state.ticks,
    1
  );

  assert.equal(
    checkpoint.inputCursor,
    input.sequence
  );

  assert.equal(
    inputDelivery.status,
    'ACKED'
  );

  assert.equal(
    pending.length,
    1
  );

  assert.equal(
    pending[0].status,
    'PENDING'
  );

  assert.equal(
    pending[0].topic,
    'test.pulse'
  );

  assert.equal(
    pending[0].causeSequence,
    input.sequence
  );

  assert.equal(
    deliveryAttempts,
    1
  );

  assert.equal(
    successfulDeliveries,
    0
  );

  /*
   * EventFabric appends durable identity before delivery.
   * The failed first delivery therefore already owns the one
   * canonical durable event; retry must not create another.
   */
  const pulseBeforeRetry =
    kernel.stateStore.db.prepare(`
      SELECT
        sequence,
        event_id,
        deduplication_key
      FROM biological_events
      WHERE topic='test.pulse'
    `).all();

  assert.equal(
    pulseBeforeRetry.length,
    1
  );

  assert.equal(
    pulseBeforeRetry[0].deduplication_key,
    pending[0].publishMeta.deduplicationKey
  );

  const producerEventId =
    pending[0].producerEventId;

  failDelivery = false;

  const slot =
    kernel.registry.get(
      'test-counter'
    );

  assert.ok(
    slot
  );

  const drained =
    await slot.drainProducerOutbox();

  assert.equal(
    drained,
    1
  );

  assert.equal(
    deliveryAttempts,
    2
  );

  assert.equal(
    successfulDeliveries,
    1
  );

  const remaining =
    kernel.stateStore
      .listPendingBiologicalOutboxIntents({
        producerCoreId:
          'test-counter'
      });

  assert.equal(
    remaining.length,
    0
  );

  const published =
    kernel.stateStore
      .getBiologicalOutboxIntent(
        producerEventId
      );

  assert.equal(
    published.status,
    'PUBLISHED'
  );

  assert.equal(
    published.fabricSequence,
    pulseBeforeRetry[0].sequence
  );

  assert.equal(
    published.fabricEventId,
    pulseBeforeRetry[0].event_id
  );

  const pulseAfterRetry =
    kernel.stateStore.db.prepare(`
      SELECT
        sequence,
        event_id
      FROM biological_events
      WHERE topic='test.pulse'
    `).all();

  assert.equal(
    pulseAfterRetry.length,
    1
  );

  assert.equal(
    pulseAfterRetry[0].sequence,
    pulseBeforeRetry[0].sequence
  );

  assert.equal(
    pulseAfterRetry[0].event_id,
    pulseBeforeRetry[0].event_id
  );

  /*
   * Retrying the durable EventFabric identity must not
   * re-apply the already ACKed producer input transition.
   */
  const checkpointAfterRetry =
    await kernel.stateStore
      .readAuthoritativeCheckpoint(
        'test-counter'
      );

  assert.equal(
    checkpointAfterRetry.state.ticks,
    1
  );

  assert.equal(
    checkpointAfterRetry.inputCursor,
    input.sequence
  );
});

test('A-04: concurrent status reads are coalesced and never exhaust CoreHost requests', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(async () => { if (kernel.stateStore.db) await kernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  await kernel.installCore(v1);
  const statuses = await Promise.all(Array.from({ length: 256 }, () => kernel.status()));
  const falseFailures = statuses.filter(status => status.cores.find(core => core.coreId === 'test-counter')?.active?.health?.code === 'COREHOST_PENDING_LIMIT');
  assert.equal(falseFailures.length, 0);
});

test('A-05: a native CoreHost cannot signal the Kernel parent process', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(async () => { if (kernel.stateStore.db) await kernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  await kernel.installCore(signalCore);
  const results = [];
  kernel.fabric.subscribe('signal.result', event => results.push(event.payload));
  await kernel.publish('signal.test', {});
  assert.equal(results.at(-1)?.parentSignalDenied, true);
});

test('A-06: default single-process CPU hard limits are reachable', () => {
  for (const priority of ['optional', 'normal', 'critical']) {
    const policy = normalizePolicy({}, priority);
    assert.ok(policy.hardCpuDuty <= 1, `${priority} hard CPU duty ${policy.hardCpuDuty} exceeds one full core`);
    assert.ok(policy.softCpuDuty < policy.hardCpuDuty);
  }
});

test('A-07: SQLite/JSON identity divergence is fail-closed', async t => {
  const { kernel, dataDir } = await makeKernel();
  let restarted = null;
  t.after(async () => {
    if (restarted?.stateStore.db) await restarted.stop().catch(() => {});
    if (kernel.stateStore.db) await kernel.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const original = kernel.identity;
  await kernel.stop();
  await fs.writeFile(path.join(dataDir, 'life', 'identity.json'), JSON.stringify({ ...original, organismId: 'forged-organism' }, null, 2));
  restarted = new LivingKernel({ dataDir, heartbeatIntervalMs: 0, snapshotIntervalMs: 0 });
  await assert.rejects(() => restarted.start(), error => error.code === 'IDENTITY_DIVERGENCE');
});

test('A-08: per-event CoreHost output quotas fail the causal event', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(async () => { if (kernel.stateStore.db) await kernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  await kernel.installCore(outputFloodCore);
  await assert.rejects(() => kernel.publish('flood.start', {}), error => error.code === 'EVENT_DELIVERY_FAILED');
});
