'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  StateStore
} = require('../runtime/kernel/state-store');

const {
  makeKernel,
  waitFor
} = require('./helpers');

const producerPath =
  path.join(
    __dirname,
    'fixtures',
    'cores',
    'ledger-producer.js'
  );

const sinkPath =
  path.join(
    __dirname,
    'fixtures',
    'cores',
    'ledger-sink.js'
  );

function transitionId(value) {
  return (
    'sha256:' +
    crypto
      .createHash('sha256')
      .update(String(value))
      .digest('hex')
  );
}

async function makeStore(t, name) {
  const dir =
    await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        `stay-ef1-d-${name}-`
      )
    );

  const holder = {
    store:
      new StateStore(dir)
  };

  await holder.store.init();

  t.after(
    async () => {
      try {
        holder.store?.close();
      } catch {}

      await fs.rm(
        dir,
        {
          recursive: true,
          force: true
        }
      );
    }
  );

  holder.store.setInitialAuthority({
    coreId:
      'outbox-producer',

    instanceId:
      'outbox-instance',

    version:
      '1.0.0',

    epoch:
      1,

    barrierSequence:
      0
  });

  holder.store.registerBiologicalConsumer({
    consumerId:
      'core:outbox-producer',

    coreId:
      'outbox-producer',

    topics: [
      'bio.tick'
    ],

    required:
      true,

    authorityEpoch:
      1
  });

  return {
    dir,
    holder
  };
}

function appendInput(
  store,
  key,
  value = 1
) {
  return store.appendBiologicalEvent({
    topic:
      'bio.tick',

    payload: {
      value
    },

    meta: {
      deduplicationKey:
        key
    },

    eventClass:
      'durable',

    at:
      1000 + value,

    minimum:
      0
  }).event;
}

async function commitTransition(
  store,
  input,
  {
    state = {
      ticks: 1
    },

    outputs = null,

    updateAuthority = true
  } = {}
) {
  const id =
    transitionId(
      input.sequence
    );

  const actualOutputs =
    outputs ??
    [
      {
        outputIndex:
          1,

        topic:
          'bio.observed',

        payload: {
          ticks:
            state.ticks
        },

        causeSequence:
          input.sequence,

        causalParent:
          input.id
      }
    ];

  return store.commitCheckpoint({
    coreId:
      'outbox-producer',

    instanceId:
      'outbox-instance',

    version:
      '1.0.0',

    authorityEpoch:
      1,

    stateSchema:
      1,

    state,

    updateAuthority,

    consumerAck: {
      consumerId:
        'core:outbox-producer',

      sequence:
        input.sequence,

      transitionId:
        id
    },

    producerTransitionId:
      id,

    outboxIntents:
      actualOutputs
  });
}

test(
  'EF1-D checkpoint state ACK and output obligation commit atomically',
  async t => {
    const {
      holder
    } =
      await makeStore(
        t,
        'atomic'
      );

    const input =
      appendInput(
        holder.store,
        'ef1-d-atomic'
      );

    const result =
      await commitTransition(
        holder.store,
        input
      );

    const checkpoint =
      await holder.store
        .readAuthoritativeCheckpoint(
          'outbox-producer'
        );

    const delivery =
      holder.store
        .getBiologicalDelivery(
          'core:outbox-producer',
          input.sequence
        );

    const pending =
      holder.store
        .listPendingBiologicalOutboxIntents({
          producerCoreId:
            'outbox-producer'
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
      delivery.status,
      'ACKED'
    );

    assert.equal(
      pending.length,
      1
    );

    assert.equal(
      pending[0].checkpointId,
      result.checkpointId
    );

    assert.equal(
      pending[0].checkpointHash,
      checkpoint.blobHash
    );
  }
);

test(
  'EF1-D outbox insertion failure rolls back checkpoint authority pointer and ACK',
  async t => {
    const {
      holder
    } =
      await makeStore(
        t,
        'rollback'
      );

    const store =
      holder.store;

    const input =
      appendInput(
        store,
        'ef1-d-rollback'
      );

    store.db.exec(`
      CREATE TRIGGER ef1_d_fail_outbox
      BEFORE INSERT
      ON biological_outbox_intents
      BEGIN
        SELECT RAISE(
          ABORT,
          'injected EF1-D failure'
        );
      END;
    `);

    await assert.rejects(
      () =>
        commitTransition(
          store,
          input
        )
    );

    assert.equal(
      store.db.prepare(
        "SELECT COUNT(*) AS count FROM checkpoints WHERE core_id='outbox-producer'"
      ).get().count,
      0
    );

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_outbox_intents'
      ).get().count,
      0
    );

    assert.equal(
      store
        .getBiologicalDelivery(
          'core:outbox-producer',
          input.sequence
        )
        .status,
      'PENDING'
    );

    assert.equal(
      store
        .getAuthority(
          'outbox-producer'
        )
        .checkpointHash,
      null
    );
  }
);

test(
  'EF1-D producer event identity is stable while content is independently committed',
  async t => {
    const {
      holder
    } =
      await makeStore(
        t,
        'identity'
      );

    const store =
      holder.store;

    const input =
      appendInput(
        store,
        'ef1-d-identity'
      );

    const result =
      await commitTransition(
        store,
        input
      );

    const intent =
      result.outboxIntents[0];

    const expected =
      crypto
        .createHash('sha256')
        .update(
          JSON.stringify({
            authorityEpoch:
              1,

            coreId:
              'outbox-producer',

            outputIndex:
              1,

            protocol:
              'stay-biological-producer-event-v1',

            transitionId:
              transitionId(
                input.sequence
              )
          })
        )
        .digest('hex');

    /*
     * stableStringify sorts object keys, and this object
     * is already expressed in that canonical key order.
     */
    assert.equal(
      intent.producerEventId,
      expected
    );

    assert.equal(
      typeof intent.proposalHash,
      'string'
    );

    assert.equal(
      intent.proposalHash.length,
      64
    );
  }
);

test(
  'EF1-D outbox stream sequence advances durably across transitions',
  async t => {
    const {
      holder
    } =
      await makeStore(
        t,
        'sequence'
      );

    const store =
      holder.store;

    const first =
      appendInput(
        store,
        'ef1-d-sequence-1',
        1
      );

    const firstResult =
      await commitTransition(
        store,
        first,
        {
          outputs: [
            {
              outputIndex: 1,
              topic: 'bio.observed',
              payload: { value: 'a' },
              causeSequence: first.sequence,
              causalParent: first.id
            },
            {
              outputIndex: 2,
              topic: 'bio.observed',
              payload: { value: 'b' },
              causeSequence: first.sequence,
              causalParent: first.id
            }
          ]
        }
      );

    const second =
      appendInput(
        store,
        'ef1-d-sequence-2',
        2
      );

    const secondResult =
      await commitTransition(
        store,
        second,
        {
          state: {
            ticks: 2
          }
        }
      );

    assert.deepEqual(
      firstResult.outboxIntents.map(
        value =>
          value.streamSequence
      ),
      [
        1,
        2
      ]
    );

    assert.deepEqual(
      secondResult.outboxIntents.map(
        value =>
          value.streamSequence
      ),
      [
        3
      ]
    );
  }
);

test(
  'EF1-D pending outbox survives StateStore restart',
  async t => {
    const {
      dir,
      holder
    } =
      await makeStore(
        t,
        'restart'
      );

    const input =
      appendInput(
        holder.store,
        'ef1-d-restart'
      );

    const result =
      await commitTransition(
        holder.store,
        input
      );

    const expected =
      result
        .outboxIntents[0]
        .producerEventId;

    holder.store.close();

    holder.store =
      new StateStore(
        dir
      );

    await holder.store.init();

    const pending =
      holder.store
        .listPendingBiologicalOutboxIntents({
          producerCoreId:
            'outbox-producer'
        });

    assert.equal(
      pending.length,
      1
    );

    assert.equal(
      pending[0].producerEventId,
      expected
    );

    assert.equal(
      pending[0].status,
      'PENDING'
    );
  }
);

test(
  'EF1-D published marker binds outbox to exact durable Fabric identity and is idempotent',
  async t => {
    const {
      holder
    } =
      await makeStore(
        t,
        'published'
      );

    const store =
      holder.store;

    const input =
      appendInput(
        store,
        'ef1-d-published'
      );

    const result =
      await commitTransition(
        store,
        input
      );

    const intent =
      result.outboxIntents[0];

    const event =
      store.appendBiologicalEvent({
        topic:
          intent.topic,

        payload:
          intent.payload,

        meta:
          intent.publishMeta,

        eventClass:
          'durable',

        at:
          5000,

        minimum:
          input.sequence
      }).event;

    const marked =
      store.markBiologicalOutboxPublished({
        producerEventId:
          intent.producerEventId,

        event
      });

    assert.equal(
      marked.status,
      'PUBLISHED'
    );

    assert.equal(
      marked.fabricSequence,
      event.sequence
    );

    const again =
      store.markBiologicalOutboxPublished({
        producerEventId:
          intent.producerEventId,

        event
      });

    assert.equal(
      again.fabricSequence,
      event.sequence
    );
  }
);

test(
  'EF1-D non-authoritative checkpoint cannot manufacture outbox intent',
  async t => {
    const {
      holder
    } =
      await makeStore(
        t,
        'authority'
      );

    const input =
      appendInput(
        holder.store,
        'ef1-d-authority'
      );

    await assert.rejects(
      () =>
        commitTransition(
          holder.store,
          input,
          {
            updateAuthority:
              false
          }
        ),
      error =>
        error.code ===
        'BIOLOGICAL_OUTBOX_AUTHORITY'
    );

    assert.equal(
      holder.store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_outbox_intents'
      ).get().count,
      0
    );
  }
);

test(
  'EF1-D pending outbox pins its originating checkpoint beyond normal retention',
  async t => {
    const {
      holder
    } =
      await makeStore(
        t,
        'retention'
      );

    const store =
      holder.store;

    const input =
      appendInput(
        store,
        'ef1-d-retention'
      );

    const first =
      await commitTransition(
        store,
        input
      );

    for (
      let i = 0;
      i < 40;
      i += 1
    ) {
      await store.commitCheckpoint({
        coreId:
          'outbox-producer',

        instanceId:
          'outbox-instance',

        version:
          '1.0.0',

        authorityEpoch:
          1,

        stateSchema:
          1,

        state: {
          ticks:
            i + 2
        },

        updateAuthority:
          true
      });
    }

    const pinned =
      store.db.prepare(
        'SELECT checkpoint_id FROM checkpoints WHERE checkpoint_id=?'
      ).get(
        first.checkpointId
      );

    assert.ok(
      pinned
    );
  }
);

test(
  'EF1-D committed undrained runtime output survives restart and can be replayed exactly once',
  async t => {
    const {
      kernel,
      dataDir
    } =
      await makeKernel();

    let activeKernel =
      kernel;

    t.after(
      async () => {
        await activeKernel
          .stop()
          .catch(
            () => {}
          );

        await fs.rm(
          dataDir,
          {
            recursive: true,
            force: true
          }
        );
      }
    );

    await kernel.installCore(
      producerPath
    );

    await kernel.installCore(
      sinkPath
    );

    const slot =
      kernel.registry.get(
        'ledger-producer'
      );

    const originalDrain =
      slot.tryDrainProducerOutbox
        .bind(slot);

    slot.tryDrainProducerOutbox =
      async () =>
        0;

    await kernel.publish(
      'bio.tick',
      {
        value: 1
      },
      {
        eventClass:
          'durable',

        deduplicationKey:
          'ef1-d-runtime-crash-window'
      }
    );

    assert.equal(
      kernel.stateStore
        .listPendingBiologicalOutboxIntents({
          producerCoreId:
            'ledger-producer'
        })
        .length,
      1
    );

    assert.equal(
      (
        await kernel.stateStore
          .readAuthoritativeCheckpoint(
            'ledger-sink'
          )
      ).state.observed,
      0
    );

    slot.tryDrainProducerOutbox =
      originalDrain;

    await kernel.stop();

    const {
      kernel:
        restarted
    } =
      await makeKernel({
        dataDir,
        allowIdentityBootstrap:
          false
      });

    activeKernel =
      restarted;

    await restarted.installCore(
      producerPath
    );

    await restarted.installCore(
      sinkPath
    );

    const restartedSlot =
      restarted.registry.get(
        'ledger-producer'
      );

    await restartedSlot
      .drainProducerOutbox();

    await waitFor(
      async () =>
        (
          await restarted.stateStore
            .readAuthoritativeCheckpoint(
              'ledger-sink'
            )
        )?.state?.observed ===
        1
    );

    assert.equal(
      restarted.stateStore
        .listPendingBiologicalOutboxIntents({
          producerCoreId:
            'ledger-producer'
        })
        .length,
      0
    );

    assert.equal(
      restarted.stateStore.db.prepare(`
        SELECT COUNT(*) AS count
        FROM biological_events
        WHERE topic='bio.observed'
      `).get().count,
      1
    );
  }
);


test(
  'EF1-EF hardening outbox stream head survives published-row compaction and prevents sequence rewind',
  async t => {
    const {
      holder
    } =
      await makeStore(
        t,
        'durable-head'
      );

    const store =
      holder.store;

    const firstInput =
      appendInput(
        store,
        'ef1-ef-head-1',
        1
      );

    const first =
      await commitTransition(
        store,
        firstInput
      );

    const intent =
      first.outboxIntents[0];

    const event =
      store.appendBiologicalEvent({
        topic:
          intent.topic,

        payload:
          intent.payload,

        meta:
          intent.publishMeta,

        eventClass:
          'durable',

        at:
          5000,

        minimum:
          firstInput.sequence
      }).event;

    store.markBiologicalOutboxPublished({
      producerEventId:
        intent.producerEventId,

      event
    });

    const headBefore =
      store.getBiologicalOutboxStreamHead({
        producerCoreId:
          'outbox-producer',

        authorityEpoch:
          1,

        producerStreamId:
          'core:outbox-producer:outputs'
      });

    assert.equal(
      headBefore.lastStreamSequence,
      1
    );

    store.db.prepare(`
      DELETE FROM biological_outbox_intents
      WHERE producer_event_id=?
    `).run(
      intent.producerEventId
    );

    const secondInput =
      appendInput(
        store,
        'ef1-ef-head-2',
        2
      );

    const second =
      await commitTransition(
        store,
        secondInput,
        {
          state: {
            ticks:
              2
          }
        }
      );

    assert.equal(
      second.outboxIntents[0]
        .streamSequence,
      2
    );

    const headAfter =
      store.getBiologicalOutboxStreamHead({
        producerCoreId:
          'outbox-producer',

        authorityEpoch:
          1,

        producerStreamId:
          'core:outbox-producer:outputs'
      });

    assert.equal(
      headAfter.lastStreamSequence,
      2
    );
  }
);


test(
  'EF1-EF hardening physiological outbox payloads are bounded to 8 KiB and rejection rolls back the transition',
  async t => {
    const {
      holder
    } =
      await makeStore(
        t,
        'payload-bound'
      );

    const store =
      holder.store;

    const input =
      appendInput(
        store,
        'ef1-ef-payload-bound',
        1
      );

    await assert.rejects(
      () =>
        commitTransition(
          store,
          input,
          {
            outputs: [
              {
                outputIndex:
                  1,

                topic:
                  'bio.observed',

                payload: {
                  value:
                    'x'.repeat(
                      9 * 1024
                    )
                },

                causeSequence:
                  input.sequence,

                causalParent:
                  input.id
              }
            ]
          }
        ),
      error =>
        error?.code ===
        'BIOLOGICAL_OUTBOX_BOUND'
    );

    assert.equal(
      store.db.prepare(`
        SELECT COUNT(*) AS count
        FROM checkpoints
        WHERE core_id='outbox-producer'
      `).get().count,
      0
    );

    assert.equal(
      store.db.prepare(`
        SELECT COUNT(*) AS count
        FROM biological_outbox_intents
      `).get().count,
      0
    );

    assert.equal(
      store
        .getBiologicalDelivery(
          'core:outbox-producer',
          input.sequence
        )
        .status,
      'PENDING'
    );
  }
);


test(
  'EF1-EF hardening outbox schema v1 migrates durable stream heads without changing pending obligations',
  async t => {
    const {
      dir,
      holder
    } =
      await makeStore(
        t,
        'head-migration'
      );

    const input =
      appendInput(
        holder.store,
        'ef1-ef-head-migration',
        1
      );

    const committed =
      await commitTransition(
        holder.store,
        input
      );

    const producerEventId =
      committed
        .outboxIntents[0]
        .producerEventId;

    holder.store.db.prepare(`
      DELETE FROM biological_outbox_stream_heads
    `).run();

    holder.store.db.prepare(`
      UPDATE schema_versions
      SET version=1
      WHERE name='biological-outbox'
    `).run();

    holder.store.close();

    holder.store =
      new StateStore(
        dir
      );

    await holder.store.init();

    const schema =
      holder.store.db.prepare(`
        SELECT version
        FROM schema_versions
        WHERE name='biological-outbox'
      `).get();

    assert.equal(
      Number(
        schema.version
      ),
      2
    );

    const head =
      holder.store
        .getBiologicalOutboxStreamHead({
          producerCoreId:
            'outbox-producer',

          authorityEpoch:
            1,

          producerStreamId:
            'core:outbox-producer:outputs'
        });

    assert.equal(
      head.lastStreamSequence,
      1
    );

    assert.equal(
      head.lastProducerEventId,
      producerEventId
    );

    assert.equal(
      holder.store
        .listPendingBiologicalOutboxIntents({
          producerCoreId:
            'outbox-producer'
        })
        .length,
      1
    );
  }
);


test(
  'EF1-EF hardening post-commit transport failure cannot be promoted into producer failure by broken recovery logging',
  async t => {
    const {
      kernel,
      dataDir
    } =
      await makeKernel();

    t.after(
      async () => {
        await kernel
          .stop()
          .catch(
            () => {}
          );

        await fs.rm(
          dataDir,
          {
            recursive:
              true,

            force:
              true
          }
        );
      }
    );

    await kernel.installCore(
      producerPath
    );

    const slot =
      kernel.registry.get(
        'ledger-producer'
      );

    const originalPublish =
      kernel.fabric.publish
        .bind(
          kernel.fabric
        );

    const originalRecovery =
      kernel.stateStore.recordRecovery;

    kernel.fabric.publish =
      async (
        topic,
        payload,
        meta
      ) => {
        if (
          topic ===
          'bio.observed'
        ) {
          throw Object.assign(
            new Error(
              'forced transport failure'
            ),
            {
              code:
                'EF1_EF_TRANSPORT_FAILURE'
            }
          );
        }

        return originalPublish(
          topic,
          payload,
          meta
        );
      };

    kernel.stateStore.recordRecovery =
      () => {
        throw new Error(
          'forced recovery journal failure'
        );
      };

    const originalLogger =
      slot.logger;

    slot.logger =
      null;

    await kernel.publish(
      'bio.tick',
      {
        value:
          1
      },
      {
        eventClass:
          'durable',

        deduplicationKey:
          'ef1-ef-broken-reporting'
      }
    );

    kernel.fabric.publish =
      originalPublish;

    kernel.stateStore.recordRecovery =
      originalRecovery;

    slot.logger =
      originalLogger;

    assert.equal(
      kernel.stateStore
        .listPendingBiologicalOutboxIntents({
          producerCoreId:
            'ledger-producer'
        })
        .length,
      1
    );

    assert.equal(
      (
        await kernel.stateStore
          .readAuthoritativeCheckpoint(
            'ledger-producer'
          )
      ).state.ticks,
      1
    );
  }
);
