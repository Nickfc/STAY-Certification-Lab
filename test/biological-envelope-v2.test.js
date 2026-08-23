'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ENVELOPE_PROTOCOL,
  AUTHORITY_MODE,
  SIGNAL_CLASS,
  DURABILITY_CLASS,
  TEMPORAL_TYPE,
  acceptEnvelope,
  normalizeAcceptedEnvelope
} = require('../runtime/kernel/biological-envelope');


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
      'pulse:beats',

    stream_sequence:
      1,

    topic:
      'cardiac.beat.raw',

    signal_class:
      SIGNAL_CLASS.RAW_AFFERENT,

    schema_version:
      1,

    temporal: {
      type:
        TEMPORAL_TYPE.INSTANT,

      at_us:
        1_000_000
    },

    valid_from_us:
      null,

    expires_at_us:
      null,

    durability_class:
      DURABILITY_CLASS.EPHEMERAL_REPLAYABLE,

    payload: {
      beat_sequence:
        1,

      pacemaker_cycle_id:
        1
    },

    direct_parents:
      [],

    causal_source_spans:
      [],

    ...overrides
  };
}


function kernel(overrides = {}) {
  return {
    organism_id:
      'stay-envelope-test',

    producer_core_id:
      'pulse',

    producer_instance_id:
      'instance-pulse-0001',

    producer_version:
      '0.1.0',

    authority_epoch:
      7,

    authority_mode:
      AUTHORITY_MODE.AUTHORITATIVE,

    accepted_time_us:
      1_000_100,

    fabric_sequence:
      44,

    causal_roots:
      [],

    causal_generation:
      0,

    roots_overflow_digest:
      null,

    lineage_digest:
      null,

    ancestor_core_set:
      [],

    causality_validated:
      false,

    max_causal_order_time_us:
      0,

    ...overrides
  };
}


test(
  'EF1-B1 accepts one canonical authoritative INSTANT envelope',
  () => {
    const envelope =
      acceptEnvelope(
        proposal(),
        kernel()
      );

    assert.equal(
      envelope.protocol,
      ENVELOPE_PROTOCOL
    );

    assert.equal(
      envelope.organism_id,
      'stay-envelope-test'
    );

    assert.equal(
      envelope.producer_core_id,
      'pulse'
    );

    assert.equal(
      envelope.producer_stream_id,
      'pulse:beats'
    );

    assert.equal(
      envelope.stream_sequence,
      1
    );

    assert.equal(
      envelope.authority_epoch,
      7
    );

    assert.equal(
      envelope.authority_mode,
      AUTHORITY_MODE.AUTHORITATIVE
    );

    assert.equal(
      envelope.order_time_us,
      1_000_000
    );

    assert.match(
      envelope.signal_id,
      /^sha256:[0-9a-f]{64}$/
    );

    assert.match(
      envelope.payload_hash,
      /^sha256:[0-9a-f]{64}$/
    );

    assert.equal(
      envelope.fabric_sequence,
      44
    );

    assert.deepEqual(
      envelope.ancestor_core_set,
      ['pulse']
    );

    assert.equal(
      Object.isFrozen(envelope),
      true
    );

    assert.equal(
      Object.isFrozen(envelope.payload),
      true
    );

    assert.equal(
      Object.isFrozen(envelope.temporal),
      true
    );
  }
);


test(
  'EF1-B1 derives canonical order_time_us from every temporal form',
  () => {
    const instant =
      acceptEnvelope(
        proposal({
          temporal: {
            type:
              TEMPORAL_TYPE.INSTANT,

            at_us:
              100
          }
        }),
        kernel()
      );

    assert.equal(
      instant.order_time_us,
      100
    );

    const interval =
      acceptEnvelope(
        proposal({
          producer_event_id:
            HASH_B,

          temporal: {
            type:
              TEMPORAL_TYPE.INTERVAL,

            start_us:
              200,

            end_us:
              400
          }
        }),
        kernel({
          fabric_sequence:
            45
        })
      );

    assert.equal(
      interval.order_time_us,
      200
    );

    const observation =
      acceptEnvelope(
        proposal({
          producer_event_id:
            HASH_C,

          temporal: {
            type:
              TEMPORAL_TYPE.OBSERVATION_WINDOW,

            start_us:
              300,

            end_us:
              500,

            decision_us:
              550
          }
        }),
        kernel({
          fabric_sequence:
            46
        })
      );

    assert.equal(
      observation.order_time_us,
      550
    );

    const state =
      acceptEnvelope(
        proposal({
          producer_event_id:
            'sha256:' + 'd'.repeat(64),

          temporal: {
            type:
              TEMPORAL_TYPE.STATE_AS_OF,

            at_us:
              600
          }
        }),
        kernel({
          fabric_sequence:
            47
        })
      );

    assert.equal(
      state.order_time_us,
      600
    );
  }
);


test(
  'EF1-B1 producer cannot smuggle Kernel-owned trust fields into a proposal',
  () => {
    for (const field of [
      'organism_id',
      'signal_id',
      'producer_core_id',
      'producer_instance_id',
      'producer_version',
      'authority_epoch',
      'authority_mode',
      'accepted_time_us',
      'order_time_us',
      'fabric_sequence',
      'payload_hash',
      'causal_roots',
      'causal_generation',
      'lineage_digest',
      'ancestor_core_set'
    ]) {
      assert.throws(
        () =>
          acceptEnvelope(
            proposal({
              [field]:
                'forged'
            }),
            kernel()
          ),

        error =>
          error &&
          error.code ===
            'BIOLOGICAL_ENVELOPE_TRUST_FIELD'
      );
    }
  }
);


test(
  'EF1-B1 neutral laboratory shadow and authoritative use one envelope protocol',
  () => {
    const modes = [
      AUTHORITY_MODE.NEUTRAL,
      AUTHORITY_MODE.LABORATORY,
      AUTHORITY_MODE.SHADOW,
      AUTHORITY_MODE.AUTHORITATIVE
    ];

    for (
      let index = 0;
      index < modes.length;
      index += 1
    ) {
      const envelope =
        acceptEnvelope(
          proposal({
            producer_event_id:
              'sha256:' +
              String(index + 1)
                .repeat(64)
                .slice(0, 64)
          }),

          kernel({
            authority_mode:
              modes[index],

            fabric_sequence:
              100 + index
          })
        );

      assert.equal(
        envelope.protocol,
        ENVELOPE_PROTOCOL
      );

      assert.equal(
        envelope.authority_mode,
        modes[index]
      );
    }
  }
);


test(
  'EF1-B1 payload is bounded to the P0 default 8 KiB',
  () => {
    assert.throws(
      () =>
        acceptEnvelope(
          proposal({
            payload: {
              value:
                'x'.repeat(9000)
            }
          }),

          kernel()
        ),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ENVELOPE_PAYLOAD_TOO_LARGE'
    );
  }
);


test(
  'EF1-B1 causal parent and source-span budgets are bounded',
  () => {
    assert.throws(
      () =>
        acceptEnvelope(
          proposal({
            direct_parents: [
              HASH_A,
              HASH_B,
              HASH_C,
              'sha256:' + 'd'.repeat(64),
              'sha256:' + 'e'.repeat(64)
            ]
          }),

          kernel({
            causality_validated:
              true,

            causal_generation:
              1
          })
        ),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ENVELOPE_CAUSAL_BOUND'
    );

    const span = sequence => ({
      producer_stream_id:
        'pulse:beats',

      authority_epoch:
        4,

      first_sequence:
        sequence,

      last_sequence:
        sequence,

      source_count:
        1,

      max_order_time_us:
        100,

      range_digest:
        HASH_B
    });

    assert.throws(
      () =>
        acceptEnvelope(
          proposal({
            causal_source_spans: [
              span(1),
              span(2),
              span(3),
              span(4),
              span(5)
            ]
          }),

          kernel({
            causality_validated:
              true,

            causal_generation:
              1,

            max_causal_order_time_us:
              100
          })
        ),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ENVELOPE_CAUSAL_BOUND'
    );
  }
);


test(
  'EF1-B1 claimed causality cannot enter accepted envelope without Kernel validation',
  () => {
    assert.throws(
      () =>
        acceptEnvelope(
          proposal({
            direct_parents: [
              HASH_B
            ]
          }),

          kernel({
            causal_roots: [
              HASH_B
            ],

            causal_generation:
              1,

            causality_validated:
              false,

            max_causal_order_time_us:
              900_000
          })
        ),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ENVELOPE_CAUSAL_UNVERIFIED'
    );
  }
);


test(
  'EF1-B1 causal precedence prevents backdating a child beneath validated evidence',
  () => {
    assert.throws(
      () =>
        acceptEnvelope(
          proposal({
            direct_parents: [
              HASH_B
            ],

            temporal: {
              type:
                TEMPORAL_TYPE.INSTANT,

              at_us:
                500
            }
          }),

          kernel({
            causal_roots: [
              HASH_B
            ],

            causal_generation:
              1,

            causality_validated:
              true,

            max_causal_order_time_us:
              501
          })
        ),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ENVELOPE_CAUSAL_PRECEDENCE'
    );
  }
);


test(
  'EF1-B1 validates stream identity sequence and validity interval',
  () => {
    assert.throws(
      () =>
        acceptEnvelope(
          proposal({
            stream_sequence:
              0
          }),
          kernel()
        ),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ENVELOPE_STREAM'
    );

    assert.throws(
      () =>
        acceptEnvelope(
          proposal({
            valid_from_us:
              900,

            expires_at_us:
              800
          }),
          kernel()
        ),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ENVELOPE_VALIDITY'
    );
  }
);


test(
  'EF1-B1 temporal structures fail closed when internally inconsistent',
  () => {
    assert.throws(
      () =>
        acceptEnvelope(
          proposal({
            temporal: {
              type:
                TEMPORAL_TYPE.INTERVAL,

              start_us:
                500,

              end_us:
                499
            }
          }),

          kernel()
        ),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ENVELOPE_TEMPORAL'
    );

    assert.throws(
      () =>
        acceptEnvelope(
          proposal({
            temporal: {
              type:
                TEMPORAL_TYPE.OBSERVATION_WINDOW,

              start_us:
                100,

              end_us:
                300,

              decision_us:
                299
            }
          }),

          kernel()
        ),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ENVELOPE_TEMPORAL'
    );
  }
);


test(
  'EF1-B1 identical immutable acceptance produces identical deterministic identity',
  () => {
    const a =
      acceptEnvelope(
        proposal(),
        kernel()
      );

    const b =
      acceptEnvelope(
        proposal(),
        kernel()
      );

    assert.equal(
      a.signal_id,
      b.signal_id
    );

    assert.equal(
      a.payload_hash,
      b.payload_hash
    );

    const changed =
      acceptEnvelope(
        proposal({
          payload: {
            beat_sequence:
              2,

            pacemaker_cycle_id:
              1
          }
        }),
        kernel()
      );

    assert.notEqual(
      a.payload_hash,
      changed.payload_hash
    );

    assert.notEqual(
      a.signal_id,
      changed.signal_id
    );
  }
);


test(
  'EF1-B1 accepted envelope round-trip validation preserves immutable identity',
  () => {
    const original =
      acceptEnvelope(
        proposal(),
        kernel()
      );

    const normalized =
      normalizeAcceptedEnvelope(
        JSON.parse(
          JSON.stringify(original)
        )
      );

    assert.deepEqual(
      normalized,
      original
    );

    assert.equal(
      Object.isFrozen(normalized),
      true
    );
  }
);


test(
  'EF1-B1 canonical authority wire values match the frozen P0 contract',
  () => {
    assert.deepEqual(
      AUTHORITY_MODE,
      {
        NEUTRAL:
          'neutral',

        LABORATORY:
          'lab',

        SHADOW:
          'shadow',

        AUTHORITATIVE:
          'authoritative'
      }
    );

    assert.throws(
      () =>
        acceptEnvelope(
          proposal(),
          kernel({
            authority_mode:
              'AUTHORITATIVE'
          })
        ),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ENVELOPE_AUTHORITY'
    );
  }
);


test(
  'EF1-B1 accepted envelope is deeply immutable across payload temporal ancestry and spans',
  () => {
    const span = {
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
        900_000,

      range_digest:
        HASH_B
    };

    const envelope =
      acceptEnvelope(
        proposal({
          temporal: {
            type:
              TEMPORAL_TYPE.INSTANT,

            at_us:
              1_000_000
          },

          direct_parents: [
            HASH_B
          ],

          causal_source_spans: [
            span
          ]
        }),

        kernel({
          causal_roots: [
            HASH_C
          ],

          causal_generation:
            2,

          causality_validated:
            true,

          max_causal_order_time_us:
            900_000,

          ancestor_core_set: [
            'interoception'
          ]
        })
      );

    assert.equal(
      Object.isFrozen(
        envelope.direct_parents
      ),
      true
    );

    assert.equal(
      Object.isFrozen(
        envelope.causal_roots
      ),
      true
    );

    assert.equal(
      Object.isFrozen(
        envelope.causal_source_spans
      ),
      true
    );

    assert.equal(
      Object.isFrozen(
        envelope.causal_source_spans[0]
      ),
      true
    );

    assert.equal(
      Object.isFrozen(
        envelope.ancestor_core_set
      ),
      true
    );

    assert.throws(
      () => {
        envelope.payload.beat_sequence =
          999;
      },
      TypeError
    );

    assert.throws(
      () => {
        envelope.direct_parents.push(
          HASH_A
        );
      },
      TypeError
    );
  }
);


test(
  'EF1-B1 duplicate causal roots fail closed',
  () => {
    assert.throws(
      () =>
        acceptEnvelope(
          proposal({
            direct_parents: [
              HASH_B
            ]
          }),

          kernel({
            causal_roots: [
              HASH_B,
              HASH_B
            ],

            causal_generation:
              1,

            causality_validated:
              true,

            max_causal_order_time_us:
              900_000
          })
        ),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ENVELOPE_CAUSAL_BOUND'
    );
  }
);


test(
  'EF1-B1 overlapping source spans in one stream authority epoch fail closed',
  () => {
    const span = (
      first,
      last
    ) => ({
      producer_stream_id:
        'pulse:beats',

      authority_epoch:
        9,

      first_sequence:
        first,

      last_sequence:
        last,

      source_count:
        last - first + 1,

      max_order_time_us:
        900_000,

      range_digest:
        HASH_B
    });

    assert.throws(
      () =>
        acceptEnvelope(
          proposal({
            causal_source_spans: [
              span(10, 20),
              span(20, 30)
            ]
          }),

          kernel({
            causal_roots: [
              HASH_C
            ],

            causal_generation:
              1,

            causality_validated:
              true,

            max_causal_order_time_us:
              900_000
          })
        ),

      error =>
        error &&
        error.code ===
          'BIOLOGICAL_ENVELOPE_CAUSAL_SPAN'
    );
  }
);


test(
  'EF1-B1 disjoint spans in the same stream authority epoch remain legal',
  () => {
    const envelope =
      acceptEnvelope(
        proposal({
          causal_source_spans: [
            {
              producer_stream_id:
                'pulse:beats',

              authority_epoch:
                9,

              first_sequence:
                10,

              last_sequence:
                12,

              source_count:
                3,

              max_order_time_us:
                800_000,

              range_digest:
                HASH_B
            },

            {
              producer_stream_id:
                'pulse:beats',

              authority_epoch:
                9,

              first_sequence:
                20,

              last_sequence:
                22,

              source_count:
                3,

              max_order_time_us:
                900_000,

              range_digest:
                HASH_C
            }
          ]
        }),

        kernel({
          causal_roots: [
            HASH_A
          ],

          causal_generation:
            1,

          causality_validated:
            true,

          max_causal_order_time_us:
            900_000
        })
      );

    assert.equal(
      envelope.causal_source_spans.length,
      2
    );
  }
);


test(
  'EF1-B1 accepted-envelope tampering is detected for payload authority and ordering',
  () => {
    const original =
      acceptEnvelope(
        proposal(),
        kernel()
      );

    const cases = [
      envelope => {
        envelope.payload.beat_sequence =
          999;
      },

      envelope => {
        envelope.authority_mode =
          AUTHORITY_MODE.SHADOW;
      },

      envelope => {
        envelope.order_time_us +=
          1;
      },

      envelope => {
        envelope.fabric_sequence +=
          1;
      },

      envelope => {
        envelope.producer_core_id =
          'sntss';
      }
    ];

    for (const mutate of cases) {
      const corrupted =
        JSON.parse(
          JSON.stringify(
            original
          )
        );

      mutate(corrupted);

      assert.throws(
        () =>
          normalizeAcceptedEnvelope(
            corrupted
          )
      );
    }
  }
);


test(
  'EF1-B1 malformed stream topic schema producer identity and authority fail closed',
  () => {
    const cases = [
      {
        proposal: {
          producer_stream_id:
            '*'
        }
      },

      {
        proposal: {
          topic:
            '*'
        }
      },

      {
        proposal: {
          schema_version:
            0
        }
      },

      {
        proposal: {
          producer_event_id:
            'not-an-id'
        }
      },

      {
        kernel: {
          authority_epoch:
            0
        }
      },

      {
        kernel: {
          fabric_sequence:
            0
        }
      }
    ];

    for (const item of cases) {
      assert.throws(
        () =>
          acceptEnvelope(
            proposal(
              item.proposal || {}
            ),

            kernel(
              item.kernel || {}
            )
          )
      );
    }
  }
);


test(
  'EF1-B1 payload canonicalization prevents caller mutation from rewriting an accepted fact',
  () => {
    const payload = {
      nested: {
        value:
          42
      }
    };

    const envelope =
      acceptEnvelope(
        proposal({
          payload
        }),
        kernel()
      );

    const signalId =
      envelope.signal_id;

    const payloadHash =
      envelope.payload_hash;

    payload.nested.value =
      999;

    assert.equal(
      envelope.payload.nested.value,
      42
    );

    assert.equal(
      envelope.signal_id,
      signalId
    );

    assert.equal(
      envelope.payload_hash,
      payloadHash
    );
  }
);


test(
  'EF1-B1 authority mode remains Kernel-owned and producer cannot launder it',
  () => {
    for (const attempted of [
      'neutral',
      'lab',
      'shadow',
      'authoritative'
    ]) {
      assert.throws(
        () =>
          acceptEnvelope(
            proposal({
              authority_mode:
                attempted
            }),

            kernel({
              authority_mode:
                AUTHORITY_MODE.AUTHORITATIVE
            })
          ),

        error =>
          error &&
          error.code ===
            'BIOLOGICAL_ENVELOPE_TRUST_FIELD'
      );
    }
  }
);
