'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { StateStore } = require('../runtime/kernel/state-store');

const HASH = prefix => `sha256:${prefix.repeat(64)}`;

async function makeStore(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-chr-outbox-'));
  const store = new StateStore(dataDir);
  await store.init();
  t.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

function register(store) {
  store.registerResident({
    residencyId: 'resident:chronobiology',
    coreId: 'chronobiology',
    role: 'chronobiology',
    instanceId: 'chronobiology-founder-instance',
    version: '0.1.0-c3',
    stateSchema: 1,
    moduleRelativePath: 'cores/chronobiology/c3/index.js',
    moduleHash: HASH('a'),
    manifestHash: HASH('b'),
    packagePolicyHash: HASH('c'),
    organismIdentityHash: HASH('d'),
  });
  store.setResidentStatus('resident:chronobiology', 'RUNNING');
  store.registerBiologicalConsumer({
    consumerId: 'resident:chronobiology',
    coreId: 'chronobiology',
    topics: ['runtime.time.pulse'],
    required: false,
    authorityEpoch: 0,
  });
}

function appendPulse(store, suffix) {
  return store.appendBiologicalEvent({
    topic: 'runtime.time.pulse',
    payload: { trustedTimeUs: 60_000_000 },
    meta: { deduplicationKey: `chr-pulse-${suffix}` },
    eventClass: 'durable',
    at: 1_000,
  }).event;
}

test('CHR-INF-04 resident checkpoint, ACK and LAB output obligation commit atomically', async t => {
  const store = await makeStore(t);
  register(store);
  const event = appendPulse(store, 'atomic');
  const transitionId = HASH('e');

  const checkpoint = await store.commitResidentCheckpoint({
    residencyId: 'resident:chronobiology',
    instanceId: 'chronobiology-founder-instance',
    version: '0.1.0-c3',
    stateSchema: 1,
    state: { trustedTimeUs: 60_000_000, phase: 1234 },
    consumerAck: {
      consumerId: 'resident:chronobiology',
      sequence: event.sequence,
      transitionId,
    },
    producerEpoch: 1,
    producerTransitionId: transitionId,
    outboxIntents: [{
      outputIndex: 1,
      causeSequence: event.sequence,
      topic: 'chronobiology.phase.summary',
      payload: { phase: 1234, mode: 'LABORATORY' },
      causalParent: event.id,
    }],
  });

  assert.equal(store.getBiologicalDelivery('resident:chronobiology', event.sequence).status,
    'ACKED');
  assert.equal(checkpoint.outboxIntents.length, 1);
  assert.equal(checkpoint.outboxIntents[0].checkpointHash, checkpoint.blobHash);
  assert.equal(store.listPendingBiologicalOutboxIntents({
    producerCoreId: 'chronobiology',
  }).length, 1);
  assert.deepEqual(store.listAuthority(), []);
});

test('CHR-INF-05 invalid LAB output rolls back resident checkpoint and input ACK', async t => {
  const store = await makeStore(t);
  register(store);
  const event = appendPulse(store, 'rollback');
  const transitionId = HASH('f');

  await assert.rejects(
    store.commitResidentCheckpoint({
      residencyId: 'resident:chronobiology',
      instanceId: 'chronobiology-founder-instance',
      version: '0.1.0-c3',
      stateSchema: 1,
      state: { trustedTimeUs: 60_000_000 },
      consumerAck: {
        consumerId: 'resident:chronobiology',
        sequence: event.sequence,
        transitionId,
      },
      producerEpoch: 1,
      producerTransitionId: transitionId,
      outboxIntents: [{
        outputIndex: 2,
        causeSequence: event.sequence,
        topic: 'chronobiology.phase.summary',
        payload: {},
      }],
    }),
    error => error.code === 'BIOLOGICAL_OUTBOX_ORDER',
  );

  assert.equal(store.getBiologicalDelivery('resident:chronobiology', event.sequence).status,
    'PENDING');
  assert.equal(store.getResident('resident:chronobiology').checkpointGeneration, 0);
  assert.equal(store.listPendingBiologicalOutboxIntents({
    producerCoreId: 'chronobiology',
  }).length, 0);
});
