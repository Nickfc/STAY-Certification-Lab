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

function eventId(number) {
  return 'sha256:' + number.toString(16).padStart(64, '0');
}

async function makeStore(t, prefix = 'stay-ef1-f-') {
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
  now = { value: 10_000 },
  coreId = 'pulse',
  instanceId = 'pulse-instance-1',
  version = '0.1.0',
  epoch = 4,
  mode = AUTHORITY_MODE.SHADOW
} = {}) {
  return new BiologicalAcceptanceBoundary({
    organismId: 'stay-ef1-f-test',

    trustedTime: {
      async sample() {
        return {
          status: 'TRUSTED',
          trustedTimeUs: now.value
        };
      }
    },

    async resolveProducer(handle) {
      if (handle !== 'producer') return null;
      return {
        coreId,
        instanceId,
        version,
        authorityEpoch: epoch,
        authorityMode: mode
      };
    },

    async resolveSignal() {
      return null;
    },

    async resolveStreamRange() {
      return [];
    },

    async allocateFabricSequence() {
      throw Object.assign(
        new Error('EF1-F uses StateStore durability'),
        { code: 'EF1_F_WRONG_ALLOCATOR' }
      );
    }
  });
}

function signalProposal({
  id,
  sequence,
  atUs
}) {
  return {
    producer_event_id: eventId(id),
    producer_stream_id: 'pulse:beats',
    stream_sequence: sequence,
    topic: 'pulse.beat.summary',
    signal_class: SIGNAL_CLASS.RAW_AFFERENT,
    schema_version: 1,
    temporal: {
      type: TEMPORAL_TYPE.INSTANT,
      at_us: atUs
    },
    valid_from_us: atUs,
    expires_at_us: atUs + 1000,
    durability_class: DURABILITY_CLASS.DURABLE_TRANSITION,
    payload: { beat: sequence },
    direct_parents: [],
    causal_source_spans: []
  };
}

async function acceptSignal(store, boundary, input) {
  const prepared = await boundary.prepare({
    producerHandle: 'producer',
    proposal: input
  });

  return store.appendAcceptedBiologicalEnvelope({
    prepared,
    finalizePrepared: (value, sequence) =>
      boundary.finalizePrepared(value, sequence)
  });
}

async function progress(store, boundary, finalizedThroughUs, authorityWitness = null) {
  const prepared = await boundary.prepareStreamProgress({
    producerHandle: 'producer',
    progress: {
      producer_stream_id: 'pulse:beats',
      finalized_through_us: finalizedThroughUs
    }
  });

  return store.commitBiologicalStreamProgress({
    prepared,
    authorityWitness,
    finalizePrepared: value =>
      boundary.finalizePreparedStreamProgress(value)
  });
}

test('EF1-F durable stream progress advances monotonically and survives StateStore restart', async t => {
  const { dir, holder } = await makeStore(t);
  const now = { value: 10_000 };
  const boundary = makeBoundary({ now });

  await acceptSignal(
    holder.store,
    boundary,
    signalProposal({ id: 1, sequence: 1, atUs: 1_000 })
  );

  const first = await progress(holder.store, boundary, 2_000);
  assert.equal(first.finalizedThroughUs, 2_000);
  assert.equal(first.finalizedSignalCount, 1);
  assert.equal(first.finalizedLastStreamSequence, 1);
  assert.equal(first.deduplicated, false);

  holder.store.close();
  holder.store = new StateStore(dir);
  await holder.store.init();

  const recovered = holder.store.getBiologicalStreamProgress({
    organismId: 'stay-ef1-f-test',
    producerStreamId: 'pulse:beats',
    authorityEpoch: 4
  });

  assert.equal(recovered.progressId, first.progressId);
  assert.equal(recovered.finalizedThroughUs, 2_000);
});

test('EF1-F repeated identical finalization is idempotent and finalization rewind fails closed', async t => {
  const { holder } = await makeStore(t);
  const boundary = makeBoundary();

  const first = await progress(holder.store, boundary, 2_000);
  const retry = await progress(holder.store, boundary, 2_000);

  assert.equal(retry.deduplicated, true);
  assert.equal(retry.progressId, first.progressId);
  assert.equal(holder.store.db.prepare('SELECT COUNT(*) AS n FROM biological_stream_progress').get().n, 1);

  await assert.rejects(
    () => progress(holder.store, boundary, 1_999),
    error => error?.code === 'BIOLOGICAL_STREAM_PROGRESS_REWIND'
  );
});

test('EF1-F producer cannot finalize future Trusted Organism Time', async t => {
  const { holder } = await makeStore(t);
  const now = { value: 2_000 };
  const boundary = makeBoundary({ now });

  await assert.rejects(
    () => progress(holder.store, boundary, 2_001),
    error => error?.code === 'BIOLOGICAL_STREAM_PROGRESS_FUTURE'
  );
});

test('EF1-F once time is finalized a late signal cannot be inserted into that stream-time region', async t => {
  const { holder } = await makeStore(t);
  const now = { value: 10_000 };
  const boundary = makeBoundary({ now });

  await acceptSignal(
    holder.store,
    boundary,
    signalProposal({ id: 1, sequence: 1, atUs: 1_000 })
  );

  await progress(holder.store, boundary, 2_000);

  await assert.rejects(
    () => acceptSignal(
      holder.store,
      boundary,
      signalProposal({ id: 2, sequence: 2, atUs: 2_000 })
    ),
    error => error?.code === 'BIOLOGICAL_STREAM_FINALIZED_TIME'
  );

  const later = await acceptSignal(
    holder.store,
    boundary,
    signalProposal({ id: 2, sequence: 2, atUs: 2_001 })
  );

  assert.equal(later.envelope.stream_sequence, 2);
});

test('EF1-F unchanged finalized signal count proves explicit silence between two progress boundaries', async t => {
  const { holder } = await makeStore(t);
  const boundary = makeBoundary();

  await acceptSignal(
    holder.store,
    boundary,
    signalProposal({ id: 1, sequence: 1, atUs: 900 })
  );

  await progress(holder.store, boundary, 1_000);
  await progress(holder.store, boundary, 2_000);

  const proof = holder.store.proveBiologicalSilence({
    organismId: 'stay-ef1-f-test',
    producerStreamId: 'pulse:beats',
    authorityEpoch: 4,
    fromUs: 1_000,
    throughUs: 2_000
  });

  assert.equal(proof.complete, true);
  assert.equal(proof.silent, true);
  assert.equal(proof.reason, 'FINALIZED_COUNT_UNCHANGED');
});

test('EF1-F retained signal inside a finalized window proves the window is not silent', async t => {
  const { holder } = await makeStore(t);
  const boundary = makeBoundary();

  await progress(holder.store, boundary, 1_000);

  await acceptSignal(
    holder.store,
    boundary,
    signalProposal({ id: 1, sequence: 1, atUs: 1_500 })
  );

  await progress(holder.store, boundary, 2_000);

  const proof = holder.store.proveBiologicalSilence({
    organismId: 'stay-ef1-f-test',
    producerStreamId: 'pulse:beats',
    authorityEpoch: 4,
    fromUs: 1_000,
    throughUs: 2_000
  });

  assert.equal(proof.complete, true);
  assert.equal(proof.silent, false);
  assert.equal(proof.reason, 'SIGNAL_PRESENT');
});

test('EF1-F missing lower progress boundary remains UNKNOWN rather than inventing silence', async t => {
  const { holder } = await makeStore(t);
  const boundary = makeBoundary();

  await progress(holder.store, boundary, 2_000);

  const proof = holder.store.proveBiologicalSilence({
    organismId: 'stay-ef1-f-test',
    producerStreamId: 'pulse:beats',
    authorityEpoch: 4,
    fromUs: 1_000,
    throughUs: 2_000
  });

  assert.equal(proof.complete, true);
  assert.equal(proof.silent, null);
  assert.equal(proof.reason, 'LOWER_PROGRESS_BOUND_MISSING');
});

test('EF1-F progress-count silence proof survives compaction of the biological event rows', async t => {
  const { holder } = await makeStore(t);
  const boundary = makeBoundary();

  await acceptSignal(
    holder.store,
    boundary,
    signalProposal({ id: 1, sequence: 1, atUs: 900 })
  );

  await progress(holder.store, boundary, 1_000);
  await progress(holder.store, boundary, 2_000);

  holder.store.db.prepare('DELETE FROM biological_events').run();

  const proof = holder.store.proveBiologicalSilence({
    organismId: 'stay-ef1-f-test',
    producerStreamId: 'pulse:beats',
    authorityEpoch: 4,
    fromUs: 1_000,
    throughUs: 2_000
  });

  assert.equal(proof.complete, true);
  assert.equal(proof.silent, true);
});

test('EF1-F tampered stream-progress head fails closed before silence can be inferred', async t => {
  const { holder } = await makeStore(t);
  const boundary = makeBoundary();

  await progress(holder.store, boundary, 1_000);

  holder.store.db.prepare(`
    UPDATE biological_stream_progress_heads
    SET head_sha256=?
  `).run('0'.repeat(64));

  assert.throws(
    () => holder.store.getBiologicalStreamProgress({
      organismId: 'stay-ef1-f-test',
      producerStreamId: 'pulse:beats',
      authorityEpoch: 4
    }),
    error => error?.code === 'BIOLOGICAL_STREAM_PROGRESS_CORRUPT'
  );
});

test('EF1-F authoritative stream progress requires and rechecks the exact current authority witness', async t => {
  const { holder } = await makeStore(t);

  holder.store.setInitialAuthority({
    coreId: 'pulse',
    instanceId: 'pulse-instance-1',
    version: '0.1.0',
    epoch: 4,
    barrierSequence: 0
  });

  const boundary = makeBoundary({
    mode: AUTHORITY_MODE.AUTHORITATIVE
  });

  await assert.rejects(
    () => progress(holder.store, boundary, 1_000),
    error => error?.code === 'BIOLOGICAL_AUTHORITY_WITNESS_REQUIRED'
  );

  const committed = await progress(
    holder.store,
    boundary,
    1_000,
    {
      coreId: 'pulse',
      instanceId: 'pulse-instance-1',
      version: '0.1.0',
      authorityEpoch: 4
    }
  );

  assert.equal(committed.finalizedThroughUs, 1_000);
});

test('EF1-F progress ownership cannot move to another core inside the same stream epoch', async t => {
  const { holder } = await makeStore(t);

  await progress(
    holder.store,
    makeBoundary({ coreId: 'pulse' }),
    1_000
  );

  await assert.rejects(
    () => progress(
      holder.store,
      makeBoundary({ coreId: 'autonomic' }),
      2_000
    ),
    error => error?.code === 'BIOLOGICAL_STREAM_PROGRESS_IDENTITY'
  );
});

test('EF1-F authority epochs carry independent finalization heads', async t => {
  const { holder } = await makeStore(t);

  const epoch4 = makeBoundary({ epoch: 4 });
  const epoch5 = makeBoundary({ epoch: 5, instanceId: 'pulse-instance-2' });

  const first = await progress(holder.store, epoch4, 2_000);
  const second = await progress(holder.store, epoch5, 1_000);

  assert.notEqual(first.progressId, second.progressId);
  assert.equal(
    holder.store.getBiologicalStreamProgress({
      organismId: 'stay-ef1-f-test',
      producerStreamId: 'pulse:beats',
      authorityEpoch: 4
    }).finalizedThroughUs,
    2_000
  );
  assert.equal(
    holder.store.getBiologicalStreamProgress({
      organismId: 'stay-ef1-f-test',
      producerStreamId: 'pulse:beats',
      authorityEpoch: 5
    }).finalizedThroughUs,
    1_000
  );
});

test('EF1-F later progress keeps cumulative evidence monotonic after older finalized rows are compacted', async t => {
  const { holder } = await makeStore(t);
  const boundary = makeBoundary();

  const accepted = await acceptSignal(
    holder.store,
    boundary,
    signalProposal({ id: 1, sequence: 1, atUs: 900 })
  );

  const lower = await progress(holder.store, boundary, 1_000);
  assert.equal(lower.finalizedSignalCount, 1);

  holder.store.db.prepare(
    'DELETE FROM biological_events WHERE sequence=?'
  ).run(accepted.envelope.fabric_sequence);

  const upper = await progress(holder.store, boundary, 2_000);

  assert.equal(upper.finalizedSignalCount, 1);
  assert.equal(upper.finalizedLastStreamSequence, 1);

  const proof = holder.store.proveBiologicalSilence({
    organismId: 'stay-ef1-f-test',
    producerStreamId: 'pulse:beats',
    authorityEpoch: 4,
    fromUs: 1_000,
    throughUs: 2_000
  });

  assert.equal(proof.complete, true);
  assert.equal(proof.silent, true);
  assert.equal(proof.reason, 'FINALIZED_COUNT_UNCHANGED');
});

test('EF1-F stream progress cannot silently move to another producer instance within one epoch', async t => {
  const { holder } = await makeStore(t);

  await progress(
    holder.store,
    makeBoundary({ instanceId: 'pulse-instance-1' }),
    1_000
  );

  await assert.rejects(
    () => progress(
      holder.store,
      makeBoundary({ instanceId: 'pulse-instance-2' }),
      2_000
    ),
    error => error?.code === 'BIOLOGICAL_STREAM_PROGRESS_IDENTITY'
  );
});

test('EF1-F resident route query detects temporally prior pending durable evidence', async t => {
  const { holder } = await makeStore(t, 'stay-ef1-f-pending-route-');
  holder.store.registerBiologicalConsumer({
    consumerId: 'resident:chronobiology',
    coreId: 'chronobiology',
    topics: ['pulse.beat.summary'],
    required: false,
    authorityEpoch: 0,
  });
  const accepted = await acceptSignal(holder.store, makeBoundary(),
    signalProposal({ id: 91, sequence: 1, atUs: 1_000 }));
  assert.equal(holder.store.hasPendingBiologicalRouteEvidence({
    consumerId: 'resident:chronobiology',
    producerStreamIds: ['pulse:beats'],
    throughUs: 2_000,
  }), true);
  assert.equal(holder.store.hasPendingBiologicalRouteEvidence({
    consumerId: 'resident:chronobiology',
    producerStreamIds: ['pulse:beats'],
    throughUs: 2_000,
    excludingSequence: accepted.envelope.fabric_sequence,
  }), false);
});
