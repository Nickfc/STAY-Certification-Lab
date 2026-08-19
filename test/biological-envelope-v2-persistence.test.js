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
  AUTHORITY_MODE,
  SIGNAL_CLASS,
  DURABILITY_CLASS,
  TEMPORAL_TYPE
} = require(
  '../runtime/kernel/biological-envelope'
);


const HASH_A =
  'sha256:' + 'a'.repeat(64);

const HASH_B =
  'sha256:' + 'b'.repeat(64);

const HASH_C =
  'sha256:' + 'c'.repeat(64);

const HASH_D =
  'sha256:' + 'd'.repeat(64);


async function makeStore(
  t,
  name = 'stay-b2b2-'
) {
  const dataDir =
    await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        name
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


function proposal(
  overrides = {}
) {
  return {
    producer_event_id:
      HASH_A,

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


function boundary() {
  return new BiologicalAcceptanceBoundary({
    organismId:
      'stay-b2b2-test',

    trustedTime: {
      async sample() {
        return {
          status:
            'TRUSTED',

          trustedTimeUs:
            2_000_100
        };
      }
    },

    async resolveProducer(
      handle
    ) {
      if (
        handle !==
        'trusted-autonomic'
      ) {
        return null;
      }

      return {
        coreId:
          'autonomic',

        instanceId:
          'autonomic-instance-1',

        version:
          '0.2.0',

        authorityEpoch:
          8,

        authorityMode:
          AUTHORITY_MODE.SHADOW
      };
    },

    async resolveSignal() {
      return null;
    },

    async resolveStreamRange() {
      return [];
    },

    /*
     * B2B2 MUST NOT use the compatibility sequence
     * allocator. StateStore owns the durable sequence.
     */
    async allocateFabricSequence() {
      throw Object.assign(
        new Error(
          'compatibility allocator must not be called'
        ),
        {
          code:
            'B2B2_WRONG_ALLOCATOR'
        }
      );
    }
  });
}


async function prepare(
  b,
  overrides = {}
) {
  return b.prepare({
    producerHandle:
      'trusted-autonomic',

    proposal:
      proposal(
        overrides
      )
  });
}


function persist(
  store,
  b,
  prepared,
  minimum = 0
) {
  return store
    .appendAcceptedBiologicalEnvelope({
      prepared,

      minimum,

      finalizePrepared:
        (
          value,
          sequence
        ) =>
          b.finalizePrepared(
            value,
            sequence
          )
    });
}


test(
  'EF1-B2B2 sequence finalization exact Envelope v2 persistence delivery creation and high-water commit are one durable operation',
  async t => {
    const {
      store
    } =
      await makeStore(t);

    store.registerBiologicalConsumer({
      consumerId:
        'core:pulse',

      coreId:
        'pulse',

      topics: [
        'autonomic.cardiac.modulation'
      ],

      required:
        true,

      authorityEpoch:
        1
    });

    const b =
      boundary();

    const prepared =
      await prepare(b);

    const result =
      persist(
        store,
        b,
        prepared
      );

    assert.equal(
      result.envelope.fabric_sequence,
      result.event.sequence
    );

    assert.equal(
      result.envelope.signal_id,
      store
        .getAcceptedBiologicalEnvelope(
          result.envelope.signal_id
        )
        .signal_id
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

    const highWater =
      store.metadataGet(
        'life:event-sequence',
        {
          sequence:
            0
        }
      );

    assert.equal(
      highWater.sequence,
      result.envelope.fabric_sequence
    );

    const pending =
      store.listPendingBiologicalEvents(
        'core:pulse'
      );

    assert.equal(
      pending.length,
      1
    );

    assert.equal(
      pending[0].sequence,
      result.envelope.fabric_sequence
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
  }
);


test(
  'EF1-B2B2 companion insert failure rolls back legacy ledger row delivery and sequence high-water',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-b2b2-rollback-'
      );

    store.registerBiologicalConsumer({
      consumerId:
        'core:pulse',

      coreId:
        'pulse',

      topics: [
        'autonomic.cardiac.modulation'
      ]
    });

    const b =
      boundary();

    const prepared =
      await prepare(b);

    store.db.exec(`
      CREATE TRIGGER b2b2_force_failure
      BEFORE INSERT
      ON biological_envelopes_v2
      BEGIN
        SELECT RAISE(
          ABORT,
          'forced B2B2 transaction failure'
        );
      END;
    `);

    assert.throws(
      () =>
        persist(
          store,
          b,
          prepared
        )
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
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_deliveries'
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

    store.db.exec(
      'DROP TRIGGER b2b2_force_failure'
    );

    const committed =
      persist(
        store,
        b,
        prepared
      );

    assert.equal(
      committed.envelope.fabric_sequence,
      1
    );
  }
);


test(
  'EF1-B2B2 exact accepted Envelope v2 survives StateStore restart',
  async t => {
    const dataDir =
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'stay-b2b2-restart-'
        )
      );

    let store =
      new StateStore(
        dataDir
      );

    await store.init();

    const b =
      boundary();

    const prepared =
      await prepare(b);

    const committed =
      persist(
        store,
        b,
        prepared
      );

    const expected =
      JSON.parse(
        JSON.stringify(
          committed.envelope
        )
      );

    const signalId =
      committed.envelope.signal_id;

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

    const recovered =
      store
        .getAcceptedBiologicalEnvelope(
          signalId
        );

    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          recovered
        )
      ),
      expected
    );

    assert.equal(
      Object.isFrozen(
        recovered
      ),
      true
    );
  }
);


test(
  'EF1-B2B2 accepted source stream ranges are durably queryable in producer order',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-b2b2-range-'
      );

    const b =
      boundary();

    const inputs = [
      {
        producer_event_id:
          HASH_A,

        stream_sequence:
          10
      },

      {
        producer_event_id:
          HASH_B,

        stream_sequence:
          11
      },

      {
        producer_event_id:
          HASH_C,

        stream_sequence:
          12
      }
    ];

    for (
      const input of inputs
    ) {
      const prepared =
        await prepare(
          b,
          input
        );

      persist(
        store,
        b,
        prepared
      );
    }

    const range =
      store
        .listAcceptedBiologicalStreamRange({
          producerStreamId:
            'autonomic:cardiac',

          authorityEpoch:
            8,

          firstSequence:
            10,

          lastSequence:
            12
        });

    assert.deepEqual(
      range.map(
        envelope =>
          envelope.stream_sequence
      ),
      [
        10,
        11,
        12
      ]
    );

    assert.ok(
      range.every(
        envelope =>
          envelope.producer_core_id ===
          'autonomic'
      )
    );
  }
);


test(
  'EF1-B2B2 corruption of persisted Envelope v2 fails closed before causal reuse',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-b2b2-corrupt-'
      );

    const b =
      boundary();

    const committed =
      persist(
        store,
        b,
        await prepare(b)
      );

    store.db.prepare(`
      UPDATE biological_envelopes_v2
      SET envelope_json=?
      WHERE signal_id=?
    `).run(
      '{"corrupt":true}',
      committed.envelope.signal_id
    );

    assert.throws(
      () =>
        store
          .getAcceptedBiologicalEnvelope(
            committed.envelope.signal_id
          ),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ENVELOPE_V2_CORRUPT'
    );
  }
);


test(
  'EF1-B2B2 Envelope v2 and legacy EventFabric events share one monotonic StateStore sequence',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-b2b2-one-sequence-'
      );

    const first =
      store.appendBiologicalEvent({
        topic:
          'legacy.before',

        payload: {
          value:
            1
        },

        meta: {
          deduplicationKey:
            'b2b2-legacy-before'
        },

        eventClass:
          'durable',

        at:
          1000
      }).event;

    const b =
      boundary();

    const middle =
      persist(
        store,
        b,
        await prepare(b)
      );

    const last =
      store.appendBiologicalEvent({
        topic:
          'legacy.after',

        payload: {
          value:
            2
        },

        meta: {
          deduplicationKey:
            'b2b2-legacy-after'
        },

        eventClass:
          'durable',

        at:
          1001
      }).event;

    assert.equal(
      first.sequence,
      1
    );

    assert.equal(
      middle.envelope.fabric_sequence,
      2
    );

    assert.equal(
      last.sequence,
      3
    );

    assert.equal(
      store.metadataGet(
        'life:event-sequence'
      ).sequence,
      3
    );
  }
);


test(
  'EF1-B2B2 biological durability classes map onto existing certified retention classes without losing v2 meaning',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-b2b2-durability-'
      );

    const b =
      boundary();

    const cases = [
      {
        durability:
          DURABILITY_CLASS.EPHEMERAL_REPLAYABLE,

        eventId:
          HASH_A,

        streamSequence:
          1,

        expectedClass:
          'durable'
      },

      {
        durability:
          DURABILITY_CLASS.CHECKPOINT_CRITICAL,

        eventId:
          HASH_B,

        streamSequence:
          2,

        expectedClass:
          'critical'
      },

      {
        durability:
          DURABILITY_CLASS.DURABLE_TRANSITION,

        eventId:
          HASH_C,

        streamSequence:
          3,

        expectedClass:
          'durable'
      }
    ];

    for (
      const entry of cases
    ) {
      const committed =
        persist(
          store,
          b,
          await prepare(
            b,
            {
              producer_event_id:
                entry.eventId,

              stream_sequence:
                entry.streamSequence,

              durability_class:
                entry.durability
            }
          )
        );

      const row =
        store.db.prepare(`
          SELECT event_class
          FROM biological_events
          WHERE sequence=?
        `).get(
          committed.envelope.fabric_sequence
        );

      assert.equal(
        row.event_class,
        entry.expectedClass
      );

      assert.equal(
        committed.envelope.durability_class,
        entry.durability
      );
    }
  }
);


test(
  'EF1-B2B2 forged final sequence fails atomically and burns no biological identity',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-b2b2-sequence-forgery-'
      );

    const b =
      boundary();

    const prepared =
      await prepare(
        b,
        {
          producer_event_id:
            HASH_D
        }
      );

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
                b.finalizePrepared(
                  value,
                  sequence + 1
                )
          }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ENVELOPE_V2_SEQUENCE'
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

    const real =
      persist(
        store,
        b,
        prepared
      );

    assert.equal(
      real.envelope.fabric_sequence,
      1
    );
  }
);


test(
  'EF1-B2B2 delivery fan-out failure rolls back Envelope v2 event deliveries and sequence',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-b2b2-delivery-failure-'
      );

    store.registerBiologicalConsumer({
      consumerId:
        'core:pulse',

      coreId:
        'pulse',

      topics: [
        'autonomic.cardiac.modulation'
      ]
    });

    const b =
      boundary();

    const prepared =
      await prepare(b);

    store.db.exec(`
      CREATE TRIGGER b2b2_fail_delivery
      BEFORE INSERT
      ON biological_deliveries
      BEGIN
        SELECT RAISE(
          ABORT,
          'forced biological delivery failure'
        );
      END;
    `);

    assert.throws(
      () =>
        persist(
          store,
          b,
          prepared
        )
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
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_deliveries'
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

    store.db.exec(
      'DROP TRIGGER b2b2_fail_delivery'
    );

    const committed =
      persist(
        store,
        b,
        prepared
      );

    assert.equal(
      committed.envelope.fabric_sequence,
      1
    );
  }
);


test(
  'EF1-B2B2 high-water persistence failure at final transaction step rolls back every biological row',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-b2b2-highwater-failure-'
      );

    store.registerBiologicalConsumer({
      consumerId:
        'core:pulse',

      coreId:
        'pulse',

      topics: [
        'autonomic.cardiac.modulation'
      ]
    });

    const b =
      boundary();

    const prepared =
      await prepare(
        b,
        {
          producer_event_id:
            HASH_D
        }
      );

    store.db.exec(`
      CREATE TRIGGER b2b2_fail_highwater
      BEFORE INSERT
      ON metadata
      WHEN NEW.key='life:event-sequence'
      BEGIN
        SELECT RAISE(
          ABORT,
          'forced event high-water failure'
        );
      END;
    `);

    assert.throws(
      () =>
        persist(
          store,
          b,
          prepared
        )
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
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_deliveries'
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

    store.db.exec(
      'DROP TRIGGER b2b2_fail_highwater'
    );

    const committed =
      persist(
        store,
        b,
        prepared
      );

    assert.equal(
      committed.envelope.fabric_sequence,
      1
    );
  }
);


test(
  'EF1-B2B2 durable index drift fails closed even when exact stored envelope bytes remain intact',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-b2b2-index-drift-'
      );

    const b =
      boundary();

    const committed =
      persist(
        store,
        b,
        await prepare(b)
      );

    store.db.prepare(`
      UPDATE biological_envelopes_v2
      SET producer_core_id=?
      WHERE signal_id=?
    `).run(
      'forged-core',
      committed.envelope.signal_id
    );

    assert.throws(
      () =>
        store.getAcceptedBiologicalEnvelope(
          committed.envelope.signal_id
        ),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ENVELOPE_V2_CORRUPT'
    );
  }
);


test(
  'EF1-B2B2 Envelope v2 companion follows canonical ledger retention by foreign-key cascade',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-b2b2-retention-'
      );

    store.registerBiologicalConsumer({
      consumerId:
        'core:pulse',

      coreId:
        'pulse',

      topics: [
        'autonomic.cardiac.modulation'
      ]
    });

    const b =
      boundary();

    const committed =
      persist(
        store,
        b,
        await prepare(b)
      );

    const sequence =
      committed.envelope.fabric_sequence;

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_envelopes_v2 WHERE sequence=?'
      ).get(sequence).count,
      1
    );

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_deliveries WHERE sequence=?'
      ).get(sequence).count,
      1
    );

    store.db.prepare(
      'DELETE FROM biological_events WHERE sequence=?'
    ).run(
      sequence
    );

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_events WHERE sequence=?'
      ).get(sequence).count,
      0
    );

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_envelopes_v2 WHERE sequence=?'
      ).get(sequence).count,
      0
    );

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM biological_deliveries WHERE sequence=?'
      ).get(sequence).count,
      0
    );
  }
);


test(
  'EF1-B2B2 runtime refuses biological-envelope schema newer than version 4',
  async t => {
    const dataDir =
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'stay-b2b2-schema-refusal-'
        )
      );

    let first =
      new StateStore(
        dataDir
      );

    await first.init();

    first.db.prepare(`
      UPDATE schema_versions
      SET version=5
      WHERE name='biological-envelope'
    `).run();

    first.close();

    const second =
      new StateStore(
        dataDir
      );

    t.after(
      async () => {
        try {
          second.close();
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

    await assert.rejects(
      () =>
        second.init(),

      error =>
        error &&
        error.code ===
          'STATE_BIOLOGICAL_SCHEMA_UNSUPPORTED'
    );
  }
);
