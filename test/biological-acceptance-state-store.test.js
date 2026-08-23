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
  BiologicalAcceptanceBoundary,
  digestSourceRange
} = require(
  '../runtime/kernel/biological-acceptance'
);

const {
  createStateStoreBiologicalEvidenceResolvers
} = require(
  '../runtime/kernel/biological-acceptance-state-store'
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
  prefix = 'stay-b2b3-'
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


function proposal({
  producerEventId,
  producerStreamId,
  streamSequence,
  atUs,
  topic = 'biology.test',
  signalClass =
    SIGNAL_CLASS.INTEGRATED_EVIDENCE,
  directParents = [],
  causalSourceSpans = [],
  payload = {
    value:
      1
  }
}) {
  return {
    producer_event_id:
      producerEventId,

    producer_stream_id:
      producerStreamId,

    stream_sequence:
      streamSequence,

    topic,

    signal_class:
      signalClass,

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

    payload,

    direct_parents:
      directParents,

    causal_source_spans:
      causalSourceSpans
  };
}


function makeBoundary({
  organismId = 'stay-b2b3-test',
  coreId,
  instanceId,
  version = '0.1.0',
  epoch = 1,
  trustedTimeUs,
  stateStore = null
}) {
  const evidence =
    stateStore
      ? createStateStoreBiologicalEvidenceResolvers({
          stateStore
        })
      : {
          async resolveSignal() {
            return null;
          },

          async resolveStreamRange() {
            return [];
          }
        };

  const producerHandle =
    `producer:${coreId}`;

  const boundary =
    new BiologicalAcceptanceBoundary({
      organismId,

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
          producerHandle
        ) {
          return null;
        }

        return {
          coreId,
          instanceId,
          version,
          authorityEpoch:
            epoch,

          authorityMode:
            AUTHORITY_MODE.SHADOW
        };
      },

      resolveSignal:
        evidence.resolveSignal,

      resolveStreamRange:
        evidence.resolveStreamRange,

      async allocateFabricSequence() {
        throw Object.assign(
          new Error(
            'B2B3 must use StateStore atomic persistence'
          ),
          {
            code:
              'B2B3_WRONG_ALLOCATOR'
          }
        );
      }
    });

  return {
    boundary,
    producerHandle,
    evidence
  };
}


async function persist({
  store,
  boundary,
  producerHandle,
  proposalValue
}) {
  const prepared =
    await boundary.prepare({
      producerHandle,

      proposal:
        proposalValue
    });

  return store
    .appendAcceptedBiologicalEnvelope({
      prepared,

      finalizePrepared:
        (
          accepted,
          sequence
        ) =>
          boundary.finalizePrepared(
            accepted,
            sequence
          )
    });
}


test(
  'EF1-B2B3 direct causal parent is resolved from exact durable Envelope v2 history',
  async t => {
    const {
      store
    } =
      await makeStore(t);

    const pulse =
      makeBoundary({
        coreId:
          'pulse',

        instanceId:
          'pulse-1',

        epoch:
          4,

        trustedTimeUs:
          2_000_100
      });

    const parent =
      await persist({
        store,

        boundary:
          pulse.boundary,

        producerHandle:
          pulse.producerHandle,

        proposalValue:
          proposal({
            producerEventId:
              hash('a'),

            producerStreamId:
              'pulse:rhythm',

            streamSequence:
              1,

            atUs:
              2_000_000,

            topic:
              'cardiac.rhythm.summary',

            signalClass:
              SIGNAL_CLASS.STATE_SUMMARY
          })
      });

    const interoception =
      makeBoundary({
        coreId:
          'interoception',

        instanceId:
          'interoception-1',

        epoch:
          7,

        trustedTimeUs:
          3_000_100,

        stateStore:
          store
      });

    const child =
      await persist({
        store,

        boundary:
          interoception.boundary,

        producerHandle:
          interoception.producerHandle,

        proposalValue:
          proposal({
            producerEventId:
              hash('b'),

            producerStreamId:
              'interoception:cardiac',

            streamSequence:
              1,

            atUs:
              3_000_000,

            topic:
              'interoception.cardiac.integrated',

            directParents: [
              parent.envelope.signal_id
            ]
          })
      });

    assert.equal(
      child.envelope.causal_generation,
      parent.envelope.causal_generation + 1
    );

    assert.ok(
      child.envelope.ancestor_core_set.includes(
        'pulse'
      )
    );

    assert.equal(
      child.envelope.direct_parents[0],
      parent.envelope.signal_id
    );

    assert.equal(
      store
        .getAcceptedBiologicalEnvelope(
          child.envelope.signal_id
        )
        .signal_id,
      child.envelope.signal_id
    );
  }
);


test(
  'EF1-B2B3 contiguous causal source span is resolved and validated from durable StateStore history',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-b2b3-span-'
      );

    const pulse =
      makeBoundary({
        coreId:
          'pulse',

        instanceId:
          'pulse-span-1',

        epoch:
          9,

        trustedTimeUs:
          2_500_100
      });

    for (
      const [
        index,
        eventId
      ] of [
        [10, hash('c')],
        [11, hash('d')],
        [12, hash('e')]
      ]
    ) {
      await persist({
        store,

        boundary:
          pulse.boundary,

        producerHandle:
          pulse.producerHandle,

        proposalValue:
          proposal({
            producerEventId:
              eventId,

            producerStreamId:
              'pulse:beats',

            streamSequence:
              index,

            atUs:
              2_000_000 +
              index,

            topic:
              'cardiac.beat.raw',

            signalClass:
              SIGNAL_CLASS.RAW_AFFERENT
          })
      });
    }

    const durableRange =
      store.listAcceptedBiologicalStreamRange({
        producerStreamId:
          'pulse:beats',

        authorityEpoch:
          9,

        firstSequence:
          10,

        lastSequence:
          12
      });

    assert.deepEqual(
      durableRange.map(
        item =>
          item.stream_sequence
      ),
      [
        10,
        11,
        12
      ]
    );

    const span = {
      producer_stream_id:
        'pulse:beats',

      authority_epoch:
        9,

      first_sequence:
        10,

      last_sequence:
        12,

      source_count:
        durableRange.length,

      max_order_time_us:
        Math.max(
          ...durableRange.map(
            item =>
              item.order_time_us
          )
        ),

      range_digest:
        digestSourceRange(
          durableRange
        )
    };

    const interoception =
      makeBoundary({
        coreId:
          'interoception',

        instanceId:
          'interoception-span-1',

        epoch:
          10,

        trustedTimeUs:
          3_000_100,

        stateStore:
          store
      });

    const prepared =
      await interoception
        .boundary
        .prepare({
          producerHandle:
            interoception.producerHandle,

          proposal:
            proposal({
              producerEventId:
                hash('f'),

              producerStreamId:
                'interoception:beat-window',

              streamSequence:
                1,

              atUs:
                3_000_000,

              topic:
                'interoception.cardiac.window',

              causalSourceSpans: [
                span
              ]
            })
        });

    assert.equal(
      prepared.kernel.causal_generation,
      1
    );

    assert.ok(
      prepared.kernel.ancestor_core_set.includes(
        'pulse'
      )
    );

    const committed =
      store.appendAcceptedBiologicalEnvelope({
        prepared,

        finalizePrepared:
          (
            value,
            sequence
          ) =>
            interoception
              .boundary
              .finalizePrepared(
                value,
                sequence
              )
      });

    assert.equal(
      committed.envelope
        .causal_source_spans[0]
        .range_digest,
      span.range_digest
    );
  }
);


test(
  'EF1-B2B3 pruned durable parent becomes explicit evidence gap rather than fabricated continuity',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-b2b3-gap-'
      );

    const pulse =
      makeBoundary({
        coreId:
          'pulse',

        instanceId:
          'pulse-gap-1',

        epoch:
          2,

        trustedTimeUs:
          2_000_100
      });

    const parent =
      await persist({
        store,

        boundary:
          pulse.boundary,

        producerHandle:
          pulse.producerHandle,

        proposalValue:
          proposal({
            producerEventId:
              hash('1'),

            producerStreamId:
              'pulse:gap-test',

            streamSequence:
              1,

            atUs:
              2_000_000
          })
      });

    store.db.prepare(
      'DELETE FROM biological_events WHERE sequence=?'
    ).run(
      parent.envelope.fabric_sequence
    );

    assert.equal(
      store.getAcceptedBiologicalEnvelope(
        parent.envelope.signal_id
      ),
      null
    );

    const target =
      makeBoundary({
        coreId:
          'interoception',

        instanceId:
          'interoception-gap-1',

        epoch:
          3,

        trustedTimeUs:
          3_000_100,

        stateStore:
          store
      });

    await assert.rejects(
      () =>
        target.boundary.prepare({
          producerHandle:
            target.producerHandle,

          proposal:
            proposal({
              producerEventId:
                hash('2'),

              producerStreamId:
                'interoception:gap-test',

              streamSequence:
                1,

              atUs:
                3_000_000,

              directParents: [
                parent.envelope.signal_id
              ]
            })
        }),

      error =>
        error &&
        String(
          error.code || ''
        ).includes(
          'EVIDENCE_GAP'
        )
    );
  }
);


test(
  'EF1-B2B3 corrupt durable source member fails closed before causal acceptance',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-b2b3-corrupt-'
      );

    const pulse =
      makeBoundary({
        coreId:
          'pulse',

        instanceId:
          'pulse-corrupt-1',

        epoch:
          5,

        trustedTimeUs:
          2_000_100
      });

    const source =
      await persist({
        store,

        boundary:
          pulse.boundary,

        producerHandle:
          pulse.producerHandle,

        proposalValue:
          proposal({
            producerEventId:
              hash('3'),

            producerStreamId:
              'pulse:corrupt-range',

            streamSequence:
              20,

            atUs:
              2_000_000
          })
      });

    const cleanRange =
      store.listAcceptedBiologicalStreamRange({
        producerStreamId:
          'pulse:corrupt-range',

        authorityEpoch:
          5,

        firstSequence:
          20,

        lastSequence:
          20
      });

    const span = {
      producer_stream_id:
        'pulse:corrupt-range',

      authority_epoch:
        5,

      first_sequence:
        20,

      last_sequence:
        20,

      source_count:
        1,

      max_order_time_us:
        cleanRange[0]
          .order_time_us,

      range_digest:
        digestSourceRange(
          cleanRange
        )
    };

    store.db.prepare(`
      UPDATE biological_envelopes_v2
      SET envelope_json=?
      WHERE signal_id=?
    `).run(
      '{"corrupt":true}',
      source.envelope.signal_id
    );

    const target =
      makeBoundary({
        coreId:
          'interoception',

        instanceId:
          'interoception-corrupt-1',

        epoch:
          6,

        trustedTimeUs:
          3_000_100,

        stateStore:
          store
      });

    await assert.rejects(
      () =>
        target.boundary.prepare({
          producerHandle:
            target.producerHandle,

          proposal:
            proposal({
              producerEventId:
                hash('4'),

              producerStreamId:
                'interoception:corrupt-range',

              streamSequence:
                1,

              atUs:
                3_000_000,

              causalSourceSpans: [
                span
              ]
            })
        }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ENVELOPE_V2_CORRUPT'
    );
  }
);


test(
  'EF1-B2B3 durable evidence resolver survives StateStore restart without synthetic parent maps',
  async t => {
    const dataDir =
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'stay-b2b3-restart-'
        )
      );

    let store =
      new StateStore(
        dataDir
      );

    await store.init();

    const pulse =
      makeBoundary({
        coreId:
          'pulse',

        instanceId:
          'pulse-restart-1',

        epoch:
          11,

        trustedTimeUs:
          2_000_100
      });

    const parent =
      await persist({
        store,

        boundary:
          pulse.boundary,

        producerHandle:
          pulse.producerHandle,

        proposalValue:
          proposal({
            producerEventId:
              hash('5'),

            producerStreamId:
              'pulse:restart',

            streamSequence:
              1,

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

    const target =
      makeBoundary({
        coreId:
          'interoception',

        instanceId:
          'interoception-restart-1',

        epoch:
          12,

        trustedTimeUs:
          3_000_100,

        stateStore:
          store
      });

    const prepared =
      await target.boundary.prepare({
        producerHandle:
          target.producerHandle,

        proposal:
          proposal({
            producerEventId:
              hash('6'),

            producerStreamId:
              'interoception:restart',

            streamSequence:
              1,

            atUs:
              3_000_000,

            directParents: [
              parent.envelope.signal_id
            ]
          })
      });

    assert.ok(
      prepared.kernel.ancestor_core_set.includes(
        'pulse'
      )
    );

    assert.equal(
      prepared.kernel.causal_generation,
      1
    );
  }
);


test(
  'EF1-B2B3 StateStore range adapter supports exact span-object and positional resolver forms',
  async t => {
    const {
      store
    } =
      await makeStore(
        t,
        'stay-b2b3-adapter-'
      );

    const pulse =
      makeBoundary({
        coreId:
          'pulse',

        instanceId:
          'pulse-adapter-1',

        epoch:
          15,

        trustedTimeUs:
          2_000_100
      });

    for (
      const [
        sequence,
        eventId
      ] of [
        [31, hash('7')],
        [32, hash('8')]
      ]
    ) {
      await persist({
        store,

        boundary:
          pulse.boundary,

        producerHandle:
          pulse.producerHandle,

        proposalValue:
          proposal({
            producerEventId:
              eventId,

            producerStreamId:
              'pulse:adapter',

            streamSequence:
              sequence,

            atUs:
              2_000_000 +
              sequence
          })
      });
    }

    const resolvers =
      createStateStoreBiologicalEvidenceResolvers({
        stateStore:
          store
      });

    const objectResult =
      await resolvers.resolveStreamRange({
        producer_stream_id:
          'pulse:adapter',

        authority_epoch:
          15,

        first_sequence:
          31,

        last_sequence:
          32
      });

    const positionalResult =
      await resolvers.resolveStreamRange(
        'pulse:adapter',
        15,
        31,
        32
      );

    assert.deepEqual(
      objectResult.map(
        item =>
          item.signal_id
      ),
      positionalResult.map(
        item =>
          item.signal_id
      )
    );

    assert.deepEqual(
      objectResult.map(
        item =>
          item.stream_sequence
      ),
      [
        31,
        32
      ]
    );
  }
);
