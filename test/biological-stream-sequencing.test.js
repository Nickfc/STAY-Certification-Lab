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
  DatabaseSync
} = require(
  'node:sqlite'
);

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
  AUTHORITY_MODE,
  SIGNAL_CLASS,
  DURABILITY_CLASS,
  TEMPORAL_TYPE
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
  prefix = 'stay-ef1-c-'
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

  return {
    store,
    dataDir
  };
}


function makeBoundary({
  coreId = 'pulse',
  instanceId = 'pulse-instance-1',
  version = '0.1.0',
  authorityEpoch = 4,
  authorityMode = AUTHORITY_MODE.SHADOW,
  trustedTimeUs = 5_000_000
} = {}) {
  const boundary =
    new BiologicalAcceptanceBoundary({
      organismId:
        'stay-ef1-c-test',

      trustedTime: {
        async sample() {
          return {
            status:
              'TRUSTED',

            trustedTimeUs
          };
        }
      },

      async resolveProducer(
        handle
      ) {
        if (
          handle !==
          'producer'
        ) {
          return null;
        }

        return {
          coreId,
          instanceId,
          version,
          authorityEpoch,
          authorityMode
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
          new Error(
            'EF1-C must persist through StateStore'
          ),
          {
            code:
              'EF1_C_WRONG_ALLOCATOR'
          }
        );
      }
    });

  return boundary;
}


function proposal({
  eventId,
  streamId = 'pulse:beats',
  streamSequence,
  atUs,
  topic = 'cardiac.beat.summary'
}) {
  return {
    producer_event_id:
      eventId,

    producer_stream_id:
      streamId,

    stream_sequence:
      streamSequence,

    topic,

    signal_class:
      SIGNAL_CLASS.STATE_SUMMARY,

    schema_version:
      1,

    temporal: {
      type:
        TEMPORAL_TYPE.INSTANT,

      at_us:
        atUs
    },

    valid_from_us:
      atUs,

    expires_at_us:
      atUs + 500_000,

    durability_class:
      DURABILITY_CLASS.CHECKPOINT_CRITICAL,

    payload: {
      sequence:
        streamSequence
    },

    direct_parents:
      [],

    causal_source_spans:
      []
  };
}


async function commit({
  store,
  boundary,
  proposalValue
}) {
  const prepared =
    await boundary.prepare({
      producerHandle:
        'producer',

      proposal:
        proposalValue
    });

  return store
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
    });
}


test(
  'EF1-C producer stream advances monotonically while intentional sequence gaps remain legal',
  async t => {
    const {
      store
    } =
      await makeStore(t);

    const boundary =
      makeBoundary();

    const first =
      await commit({
        store,
        boundary,

        proposalValue:
          proposal({
            eventId:
              hash('a'),

            streamSequence:
              10,

            atUs:
              2_000_000
          })
      });

    const second =
      await commit({
        store,
        boundary,

        proposalValue:
          proposal({
            eventId:
              hash('b'),

            streamSequence:
              12,

            atUs:
              2_100_000
          })
      });

    assert.equal(
      first.envelope.stream_sequence,
      10
    );

    assert.equal(
      second.envelope.stream_sequence,
      12
    );

    const head =
      store.getBiologicalStreamHead({
        organismId:
          'stay-ef1-c-test',

        producerStreamId:
          'pulse:beats',

        authorityEpoch:
          4
      });

    assert.equal(
      head.lastStreamSequence,
      12
    );

    assert.equal(
      head.lastFabricSequence,
      second.envelope.fabric_sequence
    );

    assert.equal(
      head.lastSignalId,
      second.envelope.signal_id
    );

    assert.equal(
      head.producerCoreId,
      'pulse'
    );
  }
);


test(
  'EF1-C duplicate or rewound producer stream sequence is rejected atomically without burning Fabric sequence',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-ef1-c-rewind-'
      );

    const boundary =
      makeBoundary();

    await commit({
      store,
      boundary,

      proposalValue:
        proposal({
          eventId:
            hash('c'),

          streamSequence:
            10,

          atUs:
            2_000_000
        })
    });

    for (
      const [
        streamSequence,
        eventId
      ] of [
        [10, hash('d')],
        [9, hash('e')]
      ]
    ) {
      await assert.rejects(
        () =>
          commit({
            store,
            boundary,

            proposalValue:
              proposal({
                eventId,
                streamSequence,
                atUs:
                  2_100_000
              })
          }),

        error =>
          error &&
          error.code ===
            'BIOLOGICAL_STREAM_SEQUENCE'
      );
    }

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_events'
      ).get().count,
      1
    );

    assert.equal(
      store.metadataGet(
        'life:event-sequence'
      ).sequence,
      1
    );

    const next =
      await commit({
        store,
        boundary,

        proposalValue:
          proposal({
            eventId:
              hash('f'),

            streamSequence:
              11,

            atUs:
              2_200_000
          })
      });

    assert.equal(
      next.envelope.fabric_sequence,
      2
    );
  }
);


test(
  'EF1-C stream-head write failure rolls back event Envelope deliveries and global sequence',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-ef1-c-head-failure-'
      );

    store.registerBiologicalConsumer({
      consumerId:
        'core:interoception',

      coreId:
        'interoception',

      topics: [
        'cardiac.beat.summary'
      ]
    });

    const boundary =
      makeBoundary();

    await commit({
      store,
      boundary,

      proposalValue:
        proposal({
          eventId:
            hash('1'),

          streamSequence:
            1,

          atUs:
            2_000_000
        })
    });

    store.db.exec(`
      CREATE TRIGGER ef1_c_fail_stream_head
      BEFORE UPDATE
      ON biological_stream_heads
      BEGIN
        SELECT RAISE(
          ABORT,
          'forced stream-head failure'
        );
      END;
    `);

    await assert.rejects(
      () =>
        commit({
          store,
          boundary,

          proposalValue:
            proposal({
              eventId:
                hash('2'),

              streamSequence:
                2,

              atUs:
                2_100_000
            })
        })
    );

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_events'
      ).get().count,
      1
    );

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_envelopes_v2'
      ).get().count,
      1
    );

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_deliveries'
      ).get().count,
      1
    );

    assert.equal(
      store.metadataGet(
        'life:event-sequence'
      ).sequence,
      1
    );

    assert.equal(
      store.getBiologicalStreamHead({
        organismId:
          'stay-ef1-c-test',

        producerStreamId:
          'pulse:beats',

        authorityEpoch:
          4
      }).lastStreamSequence,
      1
    );

    store.db.exec(
      'DROP TRIGGER ef1_c_fail_stream_head'
    );

    const committed =
      await commit({
        store,
        boundary,

        proposalValue:
          proposal({
            eventId:
              hash('3'),

            streamSequence:
              2,

            atUs:
              2_200_000
          })
      });

    assert.equal(
      committed.envelope.fabric_sequence,
      2
    );
  }
);


test(
  'EF1-C pruning retained events cannot rewind durable producer stream high-water',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-ef1-c-prune-'
      );

    const boundary =
      makeBoundary();

    const committed =
      await commit({
        store,
        boundary,

        proposalValue:
          proposal({
            eventId:
              hash('4'),

            streamSequence:
              50,

            atUs:
              2_000_000
          })
      });

    store.db.prepare(
      'DELETE FROM biological_events WHERE sequence=?'
    ).run(
      committed.envelope.fabric_sequence
    );

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_envelopes_v2'
      ).get().count,
      0
    );

    const retainedHead =
      store.getBiologicalStreamHead({
        organismId:
          'stay-ef1-c-test',

        producerStreamId:
          'pulse:beats',

        authorityEpoch:
          4
      });

    assert.equal(
      retainedHead.lastStreamSequence,
      50
    );

    await assert.rejects(
      () =>
        commit({
          store,
          boundary,

          proposalValue:
            proposal({
              eventId:
                hash('5'),

              streamSequence:
                50,

              atUs:
                2_100_000
            })
        }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_STREAM_SEQUENCE'
    );

    const next =
      await commit({
        store,
        boundary,

        proposalValue:
          proposal({
            eventId:
              hash('6'),

            streamSequence:
              51,

            atUs:
              2_200_000
          })
      });

    assert.equal(
      next.envelope.stream_sequence,
      51
    );
  }
);


test(
  'EF1-C authority epochs carry independent stream high-waters',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-ef1-c-epoch-'
      );

    const epochFour =
      makeBoundary({
        authorityEpoch:
          4
      });

    const epochFive =
      makeBoundary({
        authorityEpoch:
          5,

        instanceId:
          'pulse-instance-2',

        version:
          '0.2.0'
      });

    await commit({
      store,

      boundary:
        epochFour,

      proposalValue:
        proposal({
          eventId:
            hash('7'),

          streamSequence:
            1,

          atUs:
            2_000_000
        })
    });

    await commit({
      store,

      boundary:
        epochFive,

      proposalValue:
        proposal({
          eventId:
            hash('8'),

          streamSequence:
            1,

          atUs:
            2_100_000
        })
    });

    assert.equal(
      store.getBiologicalStreamHead({
        organismId:
          'stay-ef1-c-test',

        producerStreamId:
          'pulse:beats',

        authorityEpoch:
          4
      }).lastStreamSequence,
      1
    );

    assert.equal(
      store.getBiologicalStreamHead({
        organismId:
          'stay-ef1-c-test',

        producerStreamId:
          'pulse:beats',

        authorityEpoch:
          5
      }).lastStreamSequence,
      1
    );
  }
);


test(
  'EF1-C one logical stream cannot change producer core inside the same authority epoch',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-ef1-c-owner-'
      );

    const pulse =
      makeBoundary({
        coreId:
          'pulse',

        authorityEpoch:
          9
      });

    const intruder =
      makeBoundary({
        coreId:
          'autonomic',

        instanceId:
          'autonomic-1',

        version:
          '0.3.0',

        authorityEpoch:
          9
      });

    await commit({
      store,

      boundary:
        pulse,

      proposalValue:
        proposal({
          eventId:
            hash('9'),

          streamId:
            'shared:forbidden',

          streamSequence:
            1,

          atUs:
            2_000_000
        })
    });

    await assert.rejects(
      () =>
        commit({
          store,

          boundary:
            intruder,

          proposalValue:
            proposal({
              eventId:
                hash('0'),

              streamId:
                'shared:forbidden',

              streamSequence:
                2,

              atUs:
                2_100_000
            })
        }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_STREAM_IDENTITY'
    );
  }
);


test(
  'EF1-C stream head survives StateStore restart',
  async t => {
    const dataDir =
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'stay-ef1-c-restart-'
        )
      );

    let store =
      new StateStore(
        dataDir
      );

    await store.init();

    const boundary =
      makeBoundary();

    await commit({
      store,
      boundary,

      proposalValue:
        proposal({
          eventId:
            hash('a'),

          streamSequence:
            22,

          atUs:
            2_000_000
        })
    });

    store.close();

    store =
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

    assert.equal(
      store.getBiologicalStreamHead({
        organismId:
          'stay-ef1-c-test',

        producerStreamId:
          'pulse:beats',

        authorityEpoch:
          4
      }).lastStreamSequence,
      22
    );
  }
);


test(
  'EF1-C schema 2 migration reconstructs stream heads from durable Envelope-v2 history',
  async t => {
    const dataDir =
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'stay-ef1-c-migration-'
        )
      );

    let store =
      new StateStore(
        dataDir
      );

    await store.init();

    const boundary =
      makeBoundary();

    await commit({
      store,
      boundary,

      proposalValue:
        proposal({
          eventId:
            hash('b'),

          streamSequence:
            10,

          atUs:
            2_000_000
        })
    });

    await commit({
      store,
      boundary,

      proposalValue:
        proposal({
          eventId:
            hash('c'),

          streamSequence:
            11,

          atUs:
            2_100_000
        })
    });

    store.close();

    const dbPath =
      path.join(
        dataDir,
        'continuity.sqlite3'
      );

    const raw =
      new DatabaseSync(
        dbPath
      );

    raw.exec(
      'DROP INDEX IF EXISTS biological_v2_stream_sequence'
    );

    raw.exec(
      'DROP TABLE biological_stream_heads'
    );

    raw.prepare(`
      UPDATE schema_versions
      SET version=2
      WHERE name='biological-envelope'
    `).run();

    raw.close();

    store =
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

    const schema =
      store.db.prepare(`
        SELECT version
        FROM schema_versions
        WHERE name='biological-envelope'
      `).get();

    assert.equal(
      Number(schema.version),
      4
    );

    const head =
      store.getBiologicalStreamHead({
        organismId:
          'stay-ef1-c-test',

        producerStreamId:
          'pulse:beats',

        authorityEpoch:
          4
      });

    assert.equal(
      head.lastStreamSequence,
      11
    );

    assert.equal(
      head.lastFabricSequence,
      2
    );

    const index =
      store.db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE
          type='index' AND
          name='biological_v2_stream_sequence'
      `).get();

    assert.equal(
      index.name,
      'biological_v2_stream_sequence'
    );
  }
);


test(
  'EF1-C corrupted stream head fails closed rather than permitting rewind',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-ef1-c-corrupt-head-'
      );

    const boundary =
      makeBoundary();

    await commit({
      store,
      boundary,

      proposalValue:
        proposal({
          eventId:
            hash('d'),

          streamSequence:
            30,

          atUs:
            2_000_000
        })
    });

    store.db.prepare(`
      UPDATE biological_stream_heads
      SET last_stream_sequence=1
      WHERE
        organism_id=? AND
        producer_stream_id=? AND
        authority_epoch=?
    `).run(
      'stay-ef1-c-test',
      'pulse:beats',
      4
    );

    assert.throws(
      () =>
        store.getBiologicalStreamHead({
          organismId:
            'stay-ef1-c-test',

          producerStreamId:
            'pulse:beats',

          authorityEpoch:
            4
        }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_STREAM_HEAD_CORRUPT'
    );

    await assert.rejects(
      () =>
        commit({
          store,
          boundary,

          proposalValue:
            proposal({
              eventId:
                hash('e'),

              streamSequence:
                2,

              atUs:
                2_100_000
            })
        }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_STREAM_HEAD_CORRUPT'
    );

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_events'
      ).get().count,
      1
    );

    assert.equal(
      store.metadataGet(
        'life:event-sequence'
      ).sequence,
      1
    );
  }
);
