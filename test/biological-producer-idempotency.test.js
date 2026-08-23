'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  StateStore
} = require('../runtime/kernel/state-store');

const {
  BiologicalAcceptanceBoundary
} = require('../runtime/kernel/biological-acceptance');

const {
  AUTHORITY_MODE,
  SIGNAL_CLASS,
  DURABILITY_CLASS,
  TEMPORAL_TYPE
} = require('../runtime/kernel/biological-envelope');

function eventId(character) {
  return 'sha256:' + character.repeat(64);
}

async function makeStore(t, prefix = 'stay-ef1-e-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const holder = { store: new StateStore(dir) };
  await holder.store.init();

  t.after(async () => {
    try { holder.store?.close(); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  return { dir, holder };
}

function makeBoundary({
  now = { value: 2_000_100 },
  coreId = 'pulse',
  instanceId = 'pulse-instance-1',
  version = '0.1.0',
  epoch = 4,
  mode = AUTHORITY_MODE.SHADOW,
  resolveSignal = async () => null,
  resolveStreamRange = async () => [],
  resolveProducerEvent = null
} = {}) {
  return new BiologicalAcceptanceBoundary({
    organismId: 'stay-ef1-e-test',

    trustedTime: {
      async sample() {
        const value = now.value;
        now.value += 100;
        return {
          status: 'TRUSTED',
          trustedTimeUs: value
        };
      }
    },

    async resolveProducer(handle) {
      if (handle !== 'pulse') return null;
      return {
        coreId,
        instanceId,
        version,
        authorityEpoch: epoch,
        authorityMode: mode
      };
    },

    resolveSignal,

    resolveStreamRange,

    resolveProducerEvent,

    async allocateFabricSequence() {
      throw Object.assign(
        new Error('EF1-E must persist through StateStore'),
        { code: 'EF1_E_WRONG_ALLOCATOR' }
      );
    }
  });
}

function proposal({
  producerEventId = eventId('a'),
  streamSequence = 1,
  atUs = 2_000_000,
  payload = { beat: 1 },
  topic = 'pulse.beat.summary',
  producerStreamId = 'pulse:beats'
} = {}) {
  return {
    producer_event_id: producerEventId,
    producer_stream_id: producerStreamId,
    stream_sequence: streamSequence,
    topic,
    signal_class: SIGNAL_CLASS.RAW_AFFERENT,
    schema_version: 1,
    temporal: {
      type: TEMPORAL_TYPE.INSTANT,
      at_us: atUs
    },
    valid_from_us: atUs,
    expires_at_us: atUs + 500_000,
    durability_class: DURABILITY_CLASS.DURABLE_TRANSITION,
    payload,
    direct_parents: [],
    causal_source_spans: []
  };
}

async function accept(store, boundary, input) {
  const prepared = await boundary.prepare({
    producerHandle: 'pulse',
    proposal: input
  });

  return store.appendAcceptedBiologicalEnvelope({
    prepared,
    finalizePrepared: (value, sequence) =>
      boundary.finalizePrepared(value, sequence)
  });
}

test('EF1-E exact producer_event_id retry returns the original accepted signal without allocating another Fabric sequence', async t => {
  const { holder } = await makeStore(t);
  const boundary = makeBoundary();
  const input = proposal();

  const first = await accept(holder.store, boundary, input);
  const highWaterBefore = holder.store.metadataGet('life:event-sequence').sequence;

  const retry = await accept(holder.store, boundary, input);

  assert.equal(retry.deduplicated, true);
  assert.equal(retry.event.ledger.deduplicated, true);
  assert.equal(retry.envelope.signal_id, first.envelope.signal_id);
  assert.equal(retry.envelope.fabric_sequence, first.envelope.fabric_sequence);
  assert.equal(retry.event.id, first.event.id);
  assert.equal(holder.store.metadataGet('life:event-sequence').sequence, highWaterBefore);
  assert.equal(holder.store.db.prepare('SELECT COUNT(*) AS n FROM biological_events').get().n, 1);
  assert.equal(holder.store.db.prepare('SELECT COUNT(*) AS n FROM biological_envelopes_v2').get().n, 1);

  const byProducer = holder.store.getAcceptedBiologicalEnvelopeByProducerEvent({
    organismId: 'stay-ef1-e-test',
    producerCoreId: 'pulse',
    producerEventId: input.producer_event_id
  });

  assert.equal(byProducer.signal_id, first.envelope.signal_id);
});

test('EF1-E producer_event_id reuse with changed producer content fails closed', async t => {
  const { holder } = await makeStore(t);
  const boundary = makeBoundary();

  await accept(holder.store, boundary, proposal());

  await assert.rejects(
    () => accept(
      holder.store,
      boundary,
      proposal({ payload: { beat: 2 } })
    ),
    error => error?.code === 'BIOLOGICAL_PRODUCER_EVENT_CONFLICT'
  );

  assert.equal(holder.store.db.prepare('SELECT COUNT(*) AS n FROM biological_events').get().n, 1);
});

test('EF1-E producer_event_id cannot be adopted by a different producer instance in the same core identity', async t => {
  const { holder } = await makeStore(t);

  await accept(
    holder.store,
    makeBoundary({ instanceId: 'pulse-instance-1' }),
    proposal()
  );

  await assert.rejects(
    () => accept(
      holder.store,
      makeBoundary({ instanceId: 'pulse-instance-2' }),
      proposal()
    ),
    error => error?.code === 'BIOLOGICAL_PRODUCER_EVENT_CONFLICT'
  );
});

test('EF1-E idempotency survives StateStore restart and trusted acceptance time advances without changing the accepted fact', async t => {
  const { dir, holder } = await makeStore(t, 'stay-ef1-e-restart-');
  const now = { value: 2_000_100 };
  const boundary = makeBoundary({ now });
  const input = proposal();

  const first = await accept(holder.store, boundary, input);
  holder.store.close();

  holder.store = new StateStore(dir);
  await holder.store.init();

  now.value = 2_100_000;
  const retry = await accept(holder.store, boundary, input);

  assert.equal(retry.deduplicated, true);
  assert.equal(retry.envelope.signal_id, first.envelope.signal_id);
  assert.equal(retry.envelope.accepted_time_us, first.envelope.accepted_time_us);
  assert.equal(holder.store.db.prepare('SELECT COUNT(*) AS n FROM biological_events').get().n, 1);
});

test('EF1-E a conflicting retry burns no sequence and the next distinct producer event receives the next exact Fabric position', async t => {
  const { holder } = await makeStore(t);
  const boundary = makeBoundary();

  const first = await accept(holder.store, boundary, proposal());

  await assert.rejects(
    () => accept(
      holder.store,
      boundary,
      proposal({ topic: 'pulse.beat.changed' })
    ),
    error => error?.code === 'BIOLOGICAL_PRODUCER_EVENT_CONFLICT'
  );

  const second = await accept(
    holder.store,
    boundary,
    proposal({
      producerEventId: eventId('b'),
      streamSequence: 2,
      atUs: 2_000_050,
      payload: { beat: 2 }
    })
  );

  assert.equal(second.envelope.fabric_sequence, first.envelope.fabric_sequence + 1);
});

test('EF1-E durable producer proposal commitment detects post-commit index tampering', async t => {
  const { holder } = await makeStore(t);
  const boundary = makeBoundary();
  const committed = await accept(holder.store, boundary, proposal());

  holder.store.db.prepare(`
    UPDATE biological_envelopes_v2
    SET proposal_sha256=?
    WHERE sequence=?
  `).run(
    '0'.repeat(64),
    committed.envelope.fabric_sequence
  );

  assert.throws(
    () => holder.store.getAcceptedBiologicalEnvelope(committed.envelope.signal_id),
    error => error?.code === 'BIOLOGICAL_ENVELOPE_V2_CORRUPT'
  );
});


test('EF1-E accepted retry remains idempotent after its causal parent has been compacted', async t => {
  const { holder } = await makeStore(t, 'stay-ef1-e-compaction-');
  const now = { value: 2_000_100 };

  const parentBoundary = makeBoundary({
    now,
    coreId: 'chronobiology',
    instanceId: 'chronobiology-instance-1'
  });
  const parent = await accept(
    holder.store,
    parentBoundary,
    proposal({
      producerEventId: eventId('c'),
      producerStreamId: 'chronobiology:phase',
      streamSequence: 1,
      atUs: 2_000_000,
      payload: { phase: 'parent' },
      topic: 'chronobiology.phase.summary'
    })
  );

  const childInput = proposal({
    producerEventId: eventId('d'),
    streamSequence: 1,
    atUs: 2_000_050,
    payload: { beat: 'child' }
  });

  childInput.direct_parents = [parent.envelope.signal_id];

  const initialChildBoundary = makeBoundary({
    now,
    resolveSignal: async signalId =>
      holder.store.getAcceptedBiologicalEnvelope(signalId)
  });

  const child = await accept(
    holder.store,
    initialChildBoundary,
    childInput
  );

  /*
   * Simulate certified compaction of the causal parent only.
   * The child remains an accepted historical fact. P0.29 says
   * acknowledgement retry of that exact producer_event_id must
   * still return the original child rather than depending on the
   * now-compacted parent row.
   */
  holder.store.db.prepare(
    'DELETE FROM biological_events WHERE sequence=?'
  ).run(parent.envelope.fabric_sequence);

  assert.equal(
    holder.store.getAcceptedBiologicalEnvelope(parent.envelope.signal_id),
    null
  );

  const retryBoundary = makeBoundary({
    now,

    resolveSignal: async () => {
      throw Object.assign(
        new Error('causal parent should not be re-resolved for exact accepted retry'),
        { code: 'EF1_E_PARENT_RELOOKUP' }
      );
    },

    resolveProducerEvent: async ({ organismId, producerCoreId, producerEventId }) =>
      holder.store.getAcceptedBiologicalEnvelopeByProducerEvent({
        organismId,
        producerCoreId,
        producerEventId
      })
  });

  const highWaterBefore =
    holder.store.metadataGet('life:event-sequence').sequence;

  const retry = await accept(
    holder.store,
    retryBoundary,
    childInput
  );

  assert.equal(retry.deduplicated, true);
  assert.equal(retry.envelope.signal_id, child.envelope.signal_id);
  assert.equal(retry.envelope.fabric_sequence, child.envelope.fabric_sequence);
  assert.equal(
    holder.store.metadataGet('life:event-sequence').sequence,
    highWaterBefore
  );
});
