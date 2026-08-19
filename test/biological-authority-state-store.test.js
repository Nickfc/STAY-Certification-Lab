'use strict';

const test =
  require('node:test');

const assert =
  require('node:assert/strict');

const fs =
  require('node:fs/promises');

const os =
  require('node:os');

const path =
  require('node:path');

const {
  StateStore
} = require(
  '../runtime/kernel/state-store'
);

const {
  BiologicalAcceptanceBoundary
} = require(
  '../runtime/kernel/biological-acceptance'
);

const {
  createStateStoreAuthoritativeProducerResolver,
  authorityWitnessFromPrepared
} = require(
  '../runtime/kernel/biological-acceptance-state-store'
);

const {
  SIGNAL_CLASS,
  DURABILITY_CLASS,
  TEMPORAL_TYPE,
  AUTHORITY_MODE
} = require(
  '../runtime/kernel/biological-envelope'
);


function hash(
  character
) {
  return (
    'sha256:' +
    character.repeat(64)
  );
}


async function makeStore(
  t,
  prefix = 'stay-b2b4-'
) {
  const dataDir =
    await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        prefix
      )
    );

  const store =
    new StateStore(
      dataDir
    );

  await store.init();

  t.after(
    async () => {
      try {
        store.close();
      } catch {}

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

  return store;
}


function producerHandle(
  overrides = {}
) {
  return {
    coreId:
      'autonomic',

    instanceId:
      'autonomic-instance-1',

    version:
      '0.2.0',

    authorityEpoch:
      7,

    ...overrides
  };
}


function proposal(
  overrides = {}
) {
  return {
    producer_event_id:
      hash('a'),

    producer_stream_id:
      'autonomic:cardiac',

    stream_sequence:
      1,

    topic:
      'autonomic.cardiac.modulation',

    signal_class:
      SIGNAL_CLASS.REGULATORY_EFFERENT,

    schema_version:
      1,

    temporal: {
      type:
        TEMPORAL_TYPE.INSTANT,

      at_us:
        2_000_000
    },

    valid_from_us:
      2_000_000,

    expires_at_us:
      2_500_000,

    durability_class:
      DURABILITY_CLASS.CHECKPOINT_CRITICAL,

    payload: {
      chronotropy:
        0.1
    },

    direct_parents:
      [],

    causal_source_spans:
      [],

    ...overrides
  };
}


function makeBoundary({
  store,
  trustedTimeUs = 2_000_100
}) {
  const resolveProducer =
    createStateStoreAuthoritativeProducerResolver({
      stateStore:
        store
    });

  return new BiologicalAcceptanceBoundary({
    organismId:
      'stay-b2b4-test',

    trustedTime: {
      async sample() {
        return {
          status:
            'TRUSTED',

          trustedTimeUs
        };
      }
    },

    resolveProducer,

    async resolveSignal() {
      return null;
    },

    async resolveStreamRange() {
      return [];
    },

    async allocateFabricSequence() {
      throw Object.assign(
        new Error(
          'B2B4 authoritative path must persist through StateStore'
        ),
        {
          code:
            'B2B4_WRONG_ALLOCATOR'
        }
      );
    }
  });
}


async function prepare({
  boundary,
  handle = producerHandle(),
  proposalValue = proposal()
}) {
  return boundary.prepare({
    producerHandle:
      handle,

    proposal:
      proposalValue
  });
}


function persist({
  store,
  boundary,
  prepared
}) {
  return store
    .appendAcceptedBiologicalEnvelope({
      prepared,

      authorityWitness:
        authorityWitnessFromPrepared(
          prepared
        ),

      finalizePrepared:
        (
          value,
          sequence
        ) =>
          boundary.finalizePrepared(
            value,
            sequence
          )
    });
}


test(
  'EF1-B2B4 authoritative producer resolver binds exact current StateStore authority tuple',
  async t => {
    const store =
      await makeStore(t);

    store.setInitialAuthority({
      coreId:
        'autonomic',

      instanceId:
        'autonomic-instance-1',

      version:
        '0.2.0',

      epoch:
        7,

      barrierSequence:
        0
    });

    const resolve =
      createStateStoreAuthoritativeProducerResolver({
        stateStore:
          store
      });

    const producer =
      await resolve(
        producerHandle()
      );

    assert.deepEqual(
      producer,
      {
        coreId:
          'autonomic',

        instanceId:
          'autonomic-instance-1',

        version:
          '0.2.0',

        authorityEpoch:
          7,

        authorityMode:
          AUTHORITY_MODE.AUTHORITATIVE,

        barrierSequence:
          0
      }
    );
  }
);


test(
  'EF1-B2B4 stale or forged producer identity cannot inherit current authority',
  async t => {
    const store =
      await makeStore(
        t,
        'stay-b2b4-stale-resolver-'
      );

    store.setInitialAuthority({
      coreId:
        'autonomic',

      instanceId:
        'autonomic-instance-1',

      version:
        '0.2.0',

      epoch:
        7,

      barrierSequence:
        0
    });

    const resolve =
      createStateStoreAuthoritativeProducerResolver({
        stateStore:
          store
      });

    assert.equal(
      await resolve(
        producerHandle({
          instanceId:
            'stale-instance'
        })
      ),
      null
    );

    assert.equal(
      await resolve(
        producerHandle({
          version:
            '99.0.0'
        })
      ),
      null
    );

    assert.equal(
      await resolve(
        producerHandle({
          authorityEpoch:
            6
        })
      ),
      null
    );

    assert.equal(
      await resolve({
        coreId:
          'unknown',

        instanceId:
          'unknown-1',

        version:
          '1.0.0',

        authorityEpoch:
          1
      }),
      null
    );
  }
);


test(
  'EF1-B2B4 authoritative persistence rechecks current authority and respects durable cutover barrier',
  async t => {
    const store =
      await makeStore(
        t,
        'stay-b2b4-success-'
      );

    store.setInitialAuthority({
      coreId:
        'autonomic',

      instanceId:
        'autonomic-instance-1',

      version:
        '0.2.0',

      epoch:
        7,

      barrierSequence:
        20
    });

    const boundary =
      makeBoundary({
        store
      });

    const prepared =
      await prepare({
        boundary
      });

    const witness =
      authorityWitnessFromPrepared(
        prepared
      );

    assert.deepEqual(
      witness,
      {
        coreId:
          'autonomic',

        instanceId:
          'autonomic-instance-1',

        version:
          '0.2.0',

        authorityEpoch:
          7
      }
    );

    const committed =
      persist({
        store,
        boundary,
        prepared
      });

    assert.equal(
      committed.envelope.fabric_sequence,
      21
    );

    assert.equal(
      committed.envelope.producer_core_id,
      'autonomic'
    );

    assert.equal(
      committed.envelope.producer_instance_id,
      'autonomic-instance-1'
    );

    assert.equal(
      committed.envelope.producer_version,
      '0.2.0'
    );

    assert.equal(
      committed.envelope.authority_epoch,
      7
    );

    assert.equal(
      committed.envelope.authority_mode,
      AUTHORITY_MODE.AUTHORITATIVE
    );

    assert.equal(
      store.metadataGet(
        'life:event-sequence'
      ).sequence,
      21
    );
  }
);


test(
  'EF1-B2B4 authority cutover after prepare invalidates stale output atomically without burning sequence',
  async t => {
    const store =
      await makeStore(
        t,
        'stay-b2b4-cutover-race-'
      );

    store.setInitialAuthority({
      coreId:
        'autonomic',

      instanceId:
        'autonomic-instance-1',

      version:
        '0.2.0',

      epoch:
        7,

      barrierSequence:
        0
    });

    const oldBoundary =
      makeBoundary({
        store
      });

    const stalePrepared =
      await prepare({
        boundary:
          oldBoundary,

        proposalValue:
          proposal({
            producer_event_id:
              hash('b')
          })
      });

    /*
     * Simulate a completed authority cutover occurring
     * after prepare but before durable biological commit.
     */
    store.db.prepare(`
      UPDATE authority
      SET
        instance_id=?,
        version=?,
        epoch=?,
        barrier_sequence=?,
        updated_at=?
      WHERE core_id=?
    `).run(
      'autonomic-instance-2',
      '0.3.0',
      8,
      40,
      new Date().toISOString(),
      'autonomic'
    );

    assert.throws(
      () =>
        persist({
          store,

          boundary:
            oldBoundary,

          prepared:
            stalePrepared
        }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_AUTHORITY_STALE'
    );

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_events'
      ).get().count,
      0
    );

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_envelopes_v2'
      ).get().count,
      0
    );

    assert.equal(
      store.metadataGet(
        'life:event-sequence',
        {
          sequence:
            0
        }
      ).sequence,
      0
    );

    const newBoundary =
      makeBoundary({
        store,

        trustedTimeUs:
          3_000_100
      });

    const newPrepared =
      await prepare({
        boundary:
          newBoundary,

        handle:
          producerHandle({
            instanceId:
              'autonomic-instance-2',

            version:
              '0.3.0',

            authorityEpoch:
              8
          }),

        proposalValue:
          proposal({
            producer_event_id:
              hash('c'),

            stream_sequence:
              2,

            temporal: {
              type:
                TEMPORAL_TYPE.INSTANT,

              at_us:
                3_000_000
            },

            valid_from_us:
              3_000_000,

            expires_at_us:
              3_500_000
          })
      });

    const committed =
      persist({
        store,

        boundary:
          newBoundary,

        prepared:
          newPrepared
      });

    assert.equal(
      committed.envelope.fabric_sequence,
      41
    );

    assert.equal(
      committed.envelope.producer_instance_id,
      'autonomic-instance-2'
    );

    assert.equal(
      committed.envelope.authority_epoch,
      8
    );
  }
);


test(
  'EF1-B2B4 forged authority witness is rejected before biological identity can be committed',
  async t => {
    const store =
      await makeStore(
        t,
        'stay-b2b4-witness-'
      );

    store.setInitialAuthority({
      coreId:
        'autonomic',

      instanceId:
        'autonomic-instance-1',

      version:
        '0.2.0',

      epoch:
        7,

      barrierSequence:
        0
    });

    const boundary =
      makeBoundary({
        store
      });

    const prepared =
      await prepare({
        boundary,

        proposalValue:
          proposal({
            producer_event_id:
              hash('d')
          })
      });

    assert.throws(
      () =>
        store
          .appendAcceptedBiologicalEnvelope({
            prepared,

            authorityWitness: {
              ...authorityWitnessFromPrepared(
                prepared
              ),

              authorityEpoch:
                999
            },

            finalizePrepared:
              (
                value,
                sequence
              ) =>
                boundary.finalizePrepared(
                  value,
                  sequence
                )
          }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_AUTHORITY_WITNESS'
    );

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_events'
      ).get().count,
      0
    );

    assert.equal(
      store.metadataGet(
        'life:event-sequence',
        {
          sequence:
            0
        }
      ).sequence,
      0
    );
  }
);


test(
  'EF1-B2B4 authoritative persistence requires a commit-time authority witness',
  async t => {
    const store =
      await makeStore(
        t,
        'stay-b2b4-required-witness-'
      );

    store.setInitialAuthority({
      coreId:
        'autonomic',

      instanceId:
        'autonomic-instance-1',

      version:
        '0.2.0',

      epoch:
        7,

      barrierSequence:
        0
    });

    const boundary =
      makeBoundary({
        store
      });

    const prepared =
      await prepare({
        boundary,

        proposalValue:
          proposal({
            producer_event_id:
              hash('e')
          })
      });

    assert.throws(
      () =>
        store
          .appendAcceptedBiologicalEnvelope({
            prepared,

            finalizePrepared:
              (
                value,
                sequence
              ) =>
                boundary.finalizePrepared(
                  value,
                  sequence
                )
          }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_AUTHORITY_WITNESS_REQUIRED'
    );

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_events'
      ).get().count,
      0
    );

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_envelopes_v2'
      ).get().count,
      0
    );

    assert.equal(
      store.metadataGet(
        'life:event-sequence',
        {
          sequence:
            0
        }
      ).sequence,
      0
    );
  }
);
