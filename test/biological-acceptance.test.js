'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  acceptEnvelope,
  AUTHORITY_MODE,
  SIGNAL_CLASS,
  DURABILITY_CLASS,
  TEMPORAL_TYPE
} = require('../runtime/kernel/biological-envelope');

const {
  BiologicalAcceptanceBoundary,
  digestSourceRange
} = require('../runtime/kernel/biological-acceptance');


const HASH_A =
  'sha256:' + 'a'.repeat(64);

const HASH_B =
  'sha256:' + 'b'.repeat(64);

const HASH_C =
  'sha256:' + 'c'.repeat(64);


function proposal(overrides = {}) {
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
      DURABILITY_CLASS.EPHEMERAL_REPLAYABLE,

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


function acceptedFact({
  organismId = 'stay-b2-test',
  coreId = 'interoception',
  instanceId = 'interoception-1',
  version = '0.1.0',
  epoch = 3,
  mode = AUTHORITY_MODE.AUTHORITATIVE,
  producerEventId = HASH_B,
  streamId = 'interoception:cardiac',
  streamSequence = 1,
  topic = 'interoception.cardiac.evidence',
  orderTimeUs = 1_900_000,
  fabricSequence = 10,
  causalRoots = [],
  causalGeneration = 0,
  ancestorCoreSet = []
} = {}) {
  return acceptEnvelope(
    {
      producer_event_id:
        producerEventId,

      producer_stream_id:
        streamId,

      stream_sequence:
        streamSequence,

      topic,

      signal_class:
        SIGNAL_CLASS.INTEGRATED_EVIDENCE,

      schema_version:
        1,

      temporal: {
        type:
          TEMPORAL_TYPE.INSTANT,

        at_us:
          orderTimeUs
      },

      valid_from_us:
        null,

      expires_at_us:
        null,

      durability_class:
        DURABILITY_CLASS.EPHEMERAL_REPLAYABLE,

      payload: {
        value:
          streamSequence
      },

      direct_parents:
        [],

      causal_source_spans:
        []
    },

    {
      organism_id:
        organismId,

      producer_core_id:
        coreId,

      producer_instance_id:
        instanceId,

      producer_version:
        version,

      authority_epoch:
        epoch,

      authority_mode:
        mode,

      accepted_time_us:
        orderTimeUs + 10,

      fabric_sequence:
        fabricSequence,

      causal_roots:
        causalRoots,

      causal_generation:
        causalGeneration,

      roots_overflow_digest:
        null,

      lineage_digest:
        null,

      ancestor_core_set:
        ancestorCoreSet,

      causality_validated:
        causalRoots.length > 0,

      max_causal_order_time_us:
        0
    }
  );
}


function harness({
  organismId = 'stay-b2-test',
  mode = AUTHORITY_MODE.AUTHORITATIVE,
  epoch = 8,
  version = '0.2.0',
  timeStatus = 'TRUSTED',
  trustedTimeUs = 2_000_100,
  facts = [],
  nextFabricSequence = 100
} = {}) {
  const byId =
    new Map(
      facts.map(
        fact => [
          fact.signal_id,
          fact
        ]
      )
    );

  const boundary =
    new BiologicalAcceptanceBoundary({
      organismId,

      trustedTime: {
        async sample() {
          return {
            status:
              timeStatus,

            trustedTimeUs
          };
        }
      },

      async resolveProducer(handle) {
        if (handle !== 'trusted-autonomic-handle') {
          return null;
        }

        return {
          coreId:
            'autonomic',

          instanceId:
            'autonomic-instance-1',

          version,

          authorityEpoch:
            epoch,

          authorityMode:
            mode
        };
      },

      async resolveSignal(signalId) {
        return (
          byId.get(signalId) ||
          null
        );
      },

      async resolveStreamRange({
        producerStreamId,
        authorityEpoch,
        firstSequence,
        lastSequence
      }) {
        return facts
          .filter(
            fact =>
              fact.producer_stream_id ===
                producerStreamId &&
              fact.authority_epoch ===
                authorityEpoch &&
              fact.stream_sequence >=
                firstSequence &&
              fact.stream_sequence <=
                lastSequence
          )
          .sort(
            (a, b) =>
              a.stream_sequence -
              b.stream_sequence
          );
      },

      async allocateFabricSequence() {
        return nextFabricSequence;
      }
    });

  return boundary;
}


test(
  'EF1-B2A Kernel resolves producer identity authority trusted time and sequence',
  async () => {
    const boundary =
      harness();

    const envelope =
      await boundary.accept({
        producerHandle:
          'trusted-autonomic-handle',

        proposal:
          proposal()
      });

    assert.equal(
      envelope.organism_id,
      'stay-b2-test'
    );

    assert.equal(
      envelope.producer_core_id,
      'autonomic'
    );

    assert.equal(
      envelope.producer_instance_id,
      'autonomic-instance-1'
    );

    assert.equal(
      envelope.producer_version,
      '0.2.0'
    );

    assert.equal(
      envelope.authority_epoch,
      8
    );

    assert.equal(
      envelope.authority_mode,
      AUTHORITY_MODE.AUTHORITATIVE
    );

    assert.equal(
      envelope.accepted_time_us,
      2_000_100
    );

    assert.equal(
      envelope.fabric_sequence,
      100
    );
  }
);


test(
  'EF1-B2A unknown producer handle fails closed',
  async () => {
    const boundary =
      harness();

    await assert.rejects(
      () =>
        boundary.accept({
          producerHandle:
            'forged-handle',

          proposal:
            proposal()
        }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ACCEPTANCE_PRODUCER'
    );
  }
);


test(
  'EF1-B2A uncertain Trusted Organism Time forbids biological acceptance',
  async () => {
    const boundary =
      harness({
        timeStatus:
          'TRUSTED_TIME_UNCERTAIN'
      });

    await assert.rejects(
      () =>
        boundary.accept({
          producerHandle:
            'trusted-autonomic-handle',

          proposal:
            proposal()
        }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ACCEPTANCE_TIME_UNCERTAIN'
    );
  }
);


test(
  'EF1-B2A resolves a real direct parent and derives causal ancestry',
  async () => {
    const parent =
      acceptedFact();

    const boundary =
      harness({
        facts: [
          parent
        ]
      });

    const envelope =
      await boundary.accept({
        producerHandle:
          'trusted-autonomic-handle',

        proposal:
          proposal({
            direct_parents: [
              parent.signal_id
            ]
          })
      });

    assert.deepEqual(
      envelope.direct_parents,
      [
        parent.signal_id
      ]
    );

    assert.deepEqual(
      envelope.causal_roots,
      [
        parent.signal_id
      ]
    );

    assert.equal(
      envelope.causal_generation,
      1
    );

    assert.deepEqual(
      envelope.ancestor_core_set,
      [
        'autonomic',
        'interoception'
      ]
    );
  }
);


test(
  'EF1-B2A missing direct parent becomes explicit evidence gap',
  async () => {
    const boundary =
      harness();

    await assert.rejects(
      () =>
        boundary.accept({
          producerHandle:
            'trusted-autonomic-handle',

          proposal:
            proposal({
              direct_parents: [
                HASH_C
              ]
            })
        }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ACCEPTANCE_EVIDENCE_GAP'
    );
  }
);


test(
  'EF1-B2A cross-organism causal evidence is rejected',
  async () => {
    const parent =
      acceptedFact({
        organismId:
          'another-organism'
      });

    const boundary =
      harness({
        facts: [
          parent
        ]
      });

    await assert.rejects(
      () =>
        boundary.accept({
          producerHandle:
            'trusted-autonomic-handle',

          proposal:
            proposal({
              direct_parents: [
                parent.signal_id
              ]
            })
        }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ACCEPTANCE_ORGANISM_MISMATCH'
    );
  }
);


test(
  'EF1-B2A authoritative output cannot launder shadow evidence',
  async () => {
    const parent =
      acceptedFact({
        mode:
          AUTHORITY_MODE.SHADOW
      });

    const boundary =
      harness({
        facts: [
          parent
        ],

        mode:
          AUTHORITY_MODE.AUTHORITATIVE
      });

    await assert.rejects(
      () =>
        boundary.accept({
          producerHandle:
            'trusted-autonomic-handle',

          proposal:
            proposal({
              direct_parents: [
                parent.signal_id
              ]
            })
        }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ACCEPTANCE_AUTHORITY_LAUNDERING'
    );
  }
);


test(
  'EF1-B2A causal ancestry rejects a core re-entering its own lineage',
  async () => {
    const parent =
      acceptedFact({
        ancestorCoreSet: [
          'autonomic'
        ]
      });

    const boundary =
      harness({
        facts: [
          parent
        ]
      });

    await assert.rejects(
      () =>
        boundary.accept({
          producerHandle:
            'trusted-autonomic-handle',

          proposal:
            proposal({
              direct_parents: [
                parent.signal_id
              ]
            })
        }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ACCEPTANCE_CAUSAL_CYCLE'
    );
  }
);


test(
  'EF1-B2A validates every member of a contiguous causal source span',
  async () => {
    const members = [
      acceptedFact({
        producerEventId:
          HASH_A,

        streamId:
          'pulse:beats',

        streamSequence:
          10,

        epoch:
          4,

        orderTimeUs:
          1_700_000,

        fabricSequence:
          20,

        coreId:
          'pulse'
      }),

      acceptedFact({
        producerEventId:
          HASH_B,

        streamId:
          'pulse:beats',

        streamSequence:
          11,

        epoch:
          4,

        orderTimeUs:
          1_800_000,

        fabricSequence:
          21,

        coreId:
          'pulse'
      }),

      acceptedFact({
        producerEventId:
          HASH_C,

        streamId:
          'pulse:beats',

        streamSequence:
          12,

        epoch:
          4,

        orderTimeUs:
          1_900_000,

        fabricSequence:
          22,

        coreId:
          'pulse'
      })
    ];

    const rangeDigest =
      digestSourceRange(
        members
      );

    const boundary =
      harness({
        facts:
          members
      });

    const envelope =
      await boundary.accept({
        producerHandle:
          'trusted-autonomic-handle',

        proposal:
          proposal({
            causal_source_spans: [
              {
                producer_stream_id:
                  'pulse:beats',

                authority_epoch:
                  4,

                first_sequence:
                  10,

                last_sequence:
                  12,

                source_count:
                  3,

                max_order_time_us:
                  1_900_000,

                range_digest:
                  rangeDigest
              }
            ]
          })
      });

    assert.equal(
      envelope.causal_source_spans.length,
      1
    );

    assert.equal(
      envelope.causal_generation,
      1
    );

    assert.deepEqual(
      envelope.ancestor_core_set,
      [
        'autonomic',
        'pulse'
      ]
    );
  }
);


test(
  'EF1-B2A missing source-span member fails as evidence gap',
  async () => {
    const members = [
      acceptedFact({
        producerEventId:
          HASH_A,

        streamId:
          'pulse:beats',

        streamSequence:
          10,

        epoch:
          4,

        coreId:
          'pulse'
      }),

      acceptedFact({
        producerEventId:
          HASH_C,

        streamId:
          'pulse:beats',

        streamSequence:
          12,

        epoch:
          4,

        coreId:
          'pulse'
      })
    ];

    const boundary =
      harness({
        facts:
          members
      });

    await assert.rejects(
      () =>
        boundary.accept({
          producerHandle:
            'trusted-autonomic-handle',

          proposal:
            proposal({
              causal_source_spans: [
                {
                  producer_stream_id:
                    'pulse:beats',

                  authority_epoch:
                    4,

                  first_sequence:
                    10,

                  last_sequence:
                    12,

                  source_count:
                    3,

                  max_order_time_us:
                    2_000_000,

                  range_digest:
                    HASH_A
                }
              ]
            })
        }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ACCEPTANCE_EVIDENCE_GAP'
    );
  }
);


test(
  'EF1-B2A forged source-range digest fails closed',
  async () => {
    const members = [
      acceptedFact({
        producerEventId:
          HASH_A,

        streamId:
          'pulse:beats',

        streamSequence:
          10,

        epoch:
          4,

        coreId:
          'pulse'
      }),

      acceptedFact({
        producerEventId:
          HASH_B,

        streamId:
          'pulse:beats',

        streamSequence:
          11,

        epoch:
          4,

        coreId:
          'pulse'
      })
    ];

    const boundary =
      harness({
        facts:
          members
      });

    await assert.rejects(
      () =>
        boundary.accept({
          producerHandle:
            'trusted-autonomic-handle',

          proposal:
            proposal({
              causal_source_spans: [
                {
                  producer_stream_id:
                    'pulse:beats',

                  authority_epoch:
                    4,

                  first_sequence:
                    10,

                  last_sequence:
                    11,

                  source_count:
                    2,

                  max_order_time_us:
                    2_000_000,

                  range_digest:
                    HASH_C
                }
              ]
            })
        }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ACCEPTANCE_RANGE_DIGEST'
    );
  }
);


test(
  'EF1-B2A fabric sequence is allocated only after evidence and trusted time validate',
  async () => {
    let allocations = 0;

    const boundary =
      new BiologicalAcceptanceBoundary({
        organismId:
          'stay-b2-test',

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

        async resolveProducer() {
          return {
            coreId:
              'autonomic',

            instanceId:
              'a1',

            version:
              '0.1.0',

            authorityEpoch:
              1,

            authorityMode:
              AUTHORITY_MODE.AUTHORITATIVE
          };
        },

        async resolveSignal() {
          return null;
        },

        async resolveStreamRange() {
          return [];
        },

        async allocateFabricSequence() {
          allocations += 1;
          return allocations;
        }
      });

    await assert.rejects(
      () =>
        boundary.accept({
          producerHandle:
            'anything',

          proposal:
            proposal({
              direct_parents: [
                HASH_C
              ]
            })
        })
    );

    assert.equal(
      allocations,
      0
    );

    await boundary.accept({
      producerHandle:
        'anything',

      proposal:
        proposal()
    });

    assert.equal(
      allocations,
      1
    );
  }
);


test(
  'EF1-B2A inherited root-overflow ancestry survives another derivation',
  async () => {
    const parent =
      acceptEnvelope(
        {
          producer_event_id:
            HASH_B,

          producer_stream_id:
            'interoception:summary',

          stream_sequence:
            5,

          topic:
            'interoception.summary',

          signal_class:
            SIGNAL_CLASS.INTEGRATED_EVIDENCE,

          schema_version:
            1,

          temporal: {
            type:
              TEMPORAL_TYPE.INSTANT,

            at_us:
              1_900_000
          },

          valid_from_us:
            null,

          expires_at_us:
            null,

          durability_class:
            DURABILITY_CLASS.EPHEMERAL_REPLAYABLE,

          payload: {
            value:
              1
          },

          direct_parents:
            [],

          causal_source_spans:
            []
        },

        {
          organism_id:
            'stay-b2-test',

          producer_core_id:
            'interoception',

          producer_instance_id:
            'interoception-1',

          producer_version:
            '0.1.0',

          authority_epoch:
            3,

          authority_mode:
            AUTHORITY_MODE.AUTHORITATIVE,

          accepted_time_us:
            1_900_010,

          fabric_sequence:
            30,

          causal_roots: [
            'root-a',
            'root-b',
            'root-c',
            'root-d'
          ],

          causal_generation:
            4,

          roots_overflow_digest:
            'sha256:' + 'e'.repeat(64),

          lineage_digest:
            'sha256:' + 'f'.repeat(64),

          ancestor_core_set: [
            'pulse'
          ],

          causality_validated:
            true,

          max_causal_order_time_us:
            1_800_000
        }
      );

    const boundary =
      harness({
        facts: [
          parent
        ]
      });

    const child =
      await boundary.accept({
        producerHandle:
          'trusted-autonomic-handle',

        proposal:
          proposal({
            direct_parents: [
              parent.signal_id
            ],

            temporal: {
              type:
                TEMPORAL_TYPE.INSTANT,

              at_us:
                2_000_000
            }
          })
      });

    assert.deepEqual(
      child.causal_roots,
      parent.causal_roots
    );

    assert.match(
      child.roots_overflow_digest,
      /^sha256:[0-9a-f]{64}$/
    );

    assert.notEqual(
      child.roots_overflow_digest,
      parent.roots_overflow_digest
    );

    assert.match(
      child.lineage_digest,
      /^sha256:[0-9a-f]{64}$/
    );
  }
);


test(
  'EF1-B2A authoritative output cannot launder non-authoritative evidence through a source span',
  async () => {
    const members = [
      acceptedFact({
        producerEventId:
          HASH_A,

        streamId:
          'pulse:beats',

        streamSequence:
          10,

        epoch:
          4,

        coreId:
          'pulse',

        mode:
          AUTHORITY_MODE.SHADOW
      })
    ];

    const boundary =
      harness({
        facts:
          members,

        mode:
          AUTHORITY_MODE.AUTHORITATIVE
      });

    await assert.rejects(
      () =>
        boundary.accept({
          producerHandle:
            'trusted-autonomic-handle',

          proposal:
            proposal({
              causal_source_spans: [
                {
                  producer_stream_id:
                    'pulse:beats',

                  authority_epoch:
                    4,

                  first_sequence:
                    10,

                  last_sequence:
                    10,

                  source_count:
                    1,

                  max_order_time_us:
                    members[0].order_time_us,

                  range_digest:
                    digestSourceRange(
                      members
                    )
                }
              ]
            })
        }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ACCEPTANCE_AUTHORITY_LAUNDERING'
    );
  }
);


test(
  'EF1-B2A tampered resolved causal evidence cannot be accepted',
  async () => {
    const parent =
      acceptedFact();

    const corrupted =
      JSON.parse(
        JSON.stringify(
          parent
        )
      );

    corrupted.payload.value =
      999;

    const boundary =
      harness({
        facts: [
          corrupted
        ]
      });

    await assert.rejects(
      () =>
        boundary.accept({
          producerHandle:
            'trusted-autonomic-handle',

          proposal:
            proposal({
              direct_parents: [
                parent.signal_id
              ]
            })
        })
    );
  }
);


test(
  'EF1-B2A failure of Trusted Organism Time never allocates a Fabric sequence',
  async () => {
    let allocations =
      0;

    const boundary =
      new BiologicalAcceptanceBoundary({
        organismId:
          'stay-b2-test',

        trustedTime: {
          async sample() {
            return {
              status:
                'TRUSTED_TIME_UNCERTAIN',

              trustedTimeUs:
                2_000_100
            };
          }
        },

        async resolveProducer() {
          return {
            coreId:
              'autonomic',

            instanceId:
              'a1',

            version:
              '0.1.0',

            authorityEpoch:
              1,

            authorityMode:
              AUTHORITY_MODE.AUTHORITATIVE
          };
        },

        async resolveSignal() {
          return null;
        },

        async resolveStreamRange() {
          return [];
        },

        async allocateFabricSequence() {
          allocations += 1;
          return allocations;
        }
      });

    await assert.rejects(
      () =>
        boundary.accept({
          producerHandle:
            'anything',

          proposal:
            proposal()
        }),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ACCEPTANCE_TIME_UNCERTAIN'
    );

    assert.equal(
      allocations,
      0
    );
  }
);


test(
  'EF1-B2A non-authoritative derivation may consume authoritative evidence without gaining live authority',
  async () => {
    const parent =
      acceptedFact({
        mode:
          AUTHORITY_MODE.AUTHORITATIVE
      });

    const boundary =
      harness({
        facts: [
          parent
        ],

        mode:
          AUTHORITY_MODE.SHADOW
      });

    const child =
      await boundary.accept({
        producerHandle:
          'trusted-autonomic-handle',

        proposal:
          proposal({
            direct_parents: [
              parent.signal_id
            ]
          })
      });

    assert.equal(
      child.authority_mode,
      AUTHORITY_MODE.SHADOW
    );
  }
);
