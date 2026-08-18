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


test('G0-C222-01: authoritative lifecycle checkpoints preserve biological input provenance', async t => {
  const dir = await makeDataDir();

  t.after(() =>
    fs.rm(
      dir,
      {
        recursive: true,
        force: true
      }
    )
  );

  const store =
    new StateStore(dir);

  await store.init();

  store.setInitialAuthority({
    coreId: 'alpha',
    instanceId: 'a1',
    version: '1.0.0',
    epoch: 1
  });

  store.registerBiologicalConsumer({
    consumerId: 'core:alpha',
    coreId: 'alpha',
    topics: ['bio.tick'],
    required: true,
    authorityEpoch: 1
  });

  const first =
    store.appendBiologicalEvent({
      topic: 'bio.tick',
      payload: {
        value: 1
      },
      meta: {
        deduplicationKey:
          'g0-c222-first'
      },
      eventClass: 'durable',
      at: 1001
    }).event;

  await store.commitCheckpoint({
    coreId: 'alpha',
    instanceId: 'a1',
    version: '1.0.0',
    authorityEpoch: 1,
    stateSchema: 1,
    state: {
      applied: [first.sequence]
    },
    consumerAck: {
      consumerId: 'core:alpha',
      sequence: first.sequence,
      transitionId:
        'sha256:g0-c222-first'
    }
  });

  const biological =
    await store.readAuthoritativeCheckpoint(
      'alpha'
    );

  assert.equal(
    biological.inputCursor,
    first.sequence,
    'durable transition must record incorporated sequence'
  );

  /*
   * Lifecycle persistence of the same authoritative
   * instance/epoch incorporates no new biological input.
   *
   * It must therefore preserve the provenance of the
   * state being checkpointed.
   */
  await store.commitCheckpoint({
    coreId: 'alpha',
    instanceId: 'a1',
    version: '1.0.0',
    authorityEpoch: 1,
    stateSchema: 1,
    state: {
      applied: [first.sequence]
    }
  });

  const lifecycleOne =
    await store.readAuthoritativeCheckpoint(
      'alpha'
    );

  assert.equal(
    lifecycleOne.inputCursor,
    first.sequence,
    'authoritative lifecycle checkpoint must inherit biological provenance'
  );

  /*
   * Prove that administrative consumer progress is not
   * equivalent to physiological provenance.
   */
  const second =
    store.appendBiologicalEvent({
      topic: 'bio.tick',
      payload: {
        value: 2
      },
      meta: {
        deduplicationKey:
          'g0-c222-second'
      },
      eventClass: 'durable',
      at: 1002
    }).event;

  store.acknowledgeBiologicalEvent({
    consumerId: 'core:alpha',
    sequence: second.sequence,
    transitionId:
      'sha256:g0-c222-administrative'
  });

  assert.equal(
    store.getBiologicalConsumer(
      'core:alpha'
    ).cursor,
    second.sequence,
    'administrative cursor should advance for the control case'
  );

  await store.commitCheckpoint({
    coreId: 'alpha',
    instanceId: 'a1',
    version: '1.0.0',
    authorityEpoch: 1,
    stateSchema: 1,
    state: {
      applied: [first.sequence]
    }
  });

  const lifecycleTwo =
    await store.readAuthoritativeCheckpoint(
      'alpha'
    );

  assert.equal(
    lifecycleTwo.inputCursor,
    first.sequence,
    'lifecycle checkpoint must not copy administrative consumer progress'
  );

  const rows =
    store.db.prepare(`
      SELECT
        generation,
        instance_id,
        authority_epoch,
        input_cursor
      FROM checkpoints
      WHERE core_id='alpha'
      ORDER BY generation
    `).all();

  assert.deepEqual(
    rows.map(row => ({
      generation:
        Number(row.generation),

      instanceId:
        row.instance_id,

      authorityEpoch:
        Number(row.authority_epoch),

      inputCursor:
        Number(row.input_cursor)
    })),

    [
      {
        generation: 1,
        instanceId: 'a1',
        authorityEpoch: 1,
        inputCursor: first.sequence
      },
      {
        generation: 2,
        instanceId: 'a1',
        authorityEpoch: 1,
        inputCursor: first.sequence
      },
      {
        generation: 3,
        instanceId: 'a1',
        authorityEpoch: 1,
        inputCursor: first.sequence
      }
    ]
  );

  store.close();
});
