'use strict';

const test =
  require('node:test');

const assert =
  require('node:assert/strict');

const {
  EventFabric
} =
  require(
    '../runtime/kernel/event-fabric'
  );

const {
  createSignal
} =
  require(
    '../runtime/kernel/biological-fabric'
  );

const {
  LivingKernel
} =
  require(
    '../runtime/kernel/living-kernel'
  );


test(
  'F1.1 biological bridge reconstructs Kernel provenance for existing SNTSS validators',
  async () => {
    const appended = [];

    const fabric =
      new EventFabric({
        clock:
          () => 2001,

        durableAppender:
          async input => {
            appended.push(input);

            return {
              deduplicated: false,

              event:
                Object.freeze({
                  id: 1,
                  sequence: 1,
                  topic: input.topic,
                  class: input.eventClass,
                  payload: input.payload,
                  at: input.at,
                  deadlineAt:
                    input.deadlineAt,

                  meta:
                    Object.freeze({
                      ...input.meta,
                      eventClass:
                        input.eventClass
                    }),

                  ledger:
                    Object.freeze({
                      durable: true
                    })
                })
            };
          }
      });

    const signal =
      createSignal({
        signalId:
          'runtime.organism.binding:v1:test',

        topic:
          'runtime.organism.binding',

        payload: {
          bindingVersion: 1
        },

        trustedTime: {
          source: 'kernel',
          observedAtMs: 2000
        },

        provenance: {
          producerType: 'kernel',
          producerId: 'living-kernel',
          authorityEpoch: 7
        }
      });

    const event =
      await fabric
        .publishBiologicalSignal(
          signal,
          {
            eventClass:
              'critical',

            sourceVersion:
              '0.8.11.3',

            evidenceHash:
              'sha256:test'
          }
        );

    assert.equal(
      appended.length,
      1
    );

    assert.equal(
      appended[0].meta.sourceCore,
      'living-kernel'
    );

    assert.equal(
      appended[0].meta.authorityEpoch,
      7
    );

    assert.equal(
      appended[0].eventClass,
      'critical'
    );

    assert.equal(
      appended[0].meta.deduplicationKey,
      'runtime.organism.binding:v1:test'
    );

    assert.equal(
      event.meta.biological.provenance.producerId,
      'living-kernel'
    );
  }
);


test(
  'F1.1 organism binding publisher creates one canonical biological signal',
  async () => {
    const binding = {
      bindingVersion: 1,
      identitySha256:
        `sha256:${'a'.repeat(64)}`,
      organismLineage:
        'STAY/Genesis',
      issuedAt: 3000,
      runtimeRevision: 9,
      authorityEpoch: 9,
      kernelVersion: '0.8.11.3'
    };

    const calls = [];

    const fake = {
      clock:
        () => 3001,

      ensureOrganismBinding:
        async () => binding,

      fabric: {
        publishBiologicalSignal:
          async (signal, options) => {
            calls.push({
              signal,
              options
            });

            return {
              signal,
              options
            };
          }
      }
    };

    await LivingKernel.prototype
      .publishOrganismBinding
      .call(fake);

    assert.equal(
      calls.length,
      1
    );

    const {
      signal,
      options
    } =
      calls[0];

    assert.equal(
      signal.topic,
      'runtime.organism.binding'
    );

    assert.equal(
      signal.signalId,
      `runtime.organism.binding:v1:${binding.identitySha256}`
    );

    assert.equal(
      signal.provenance.producerType,
      'kernel'
    );

    assert.equal(
      signal.provenance.producerId,
      'living-kernel'
    );

    assert.equal(
      signal.provenance.authorityEpoch,
      9
    );

    assert.equal(
      signal.trustedTime.source,
      'kernel'
    );

    assert.equal(
      options.eventClass,
      'critical'
    );
  }
);


test(
  'F1.1 trusted time pulse publisher creates canonical durable biological time',
  async () => {
    const calls = [];

    const fake = {
      trustedTimePulseSequence: 4,
      runtimeRevision: 12,

      clock:
        () => 4444,

      fabric: {
        publishBiologicalSignal:
          async (signal, options) => {
            calls.push({
              signal,
              options
            });

            return {
              signal,
              options
            };
          }
      }
    };

    await LivingKernel.prototype
      .publishTimePulse
      .call(
        fake,
        'trusted'
      );

    assert.equal(
      fake.trustedTimePulseSequence,
      5
    );

    assert.equal(
      calls.length,
      1
    );

    const {
      signal,
      options
    } =
      calls[0];

    assert.equal(
      signal.signalId,
      'runtime.time.pulse:12:5'
    );

    assert.equal(
      signal.topic,
      'runtime.time.pulse'
    );

    assert.deepEqual(
      signal.payload,
      {
        clockStatus:
          'trusted',

        pulseSequence:
          5,

        runtimeRevision:
          12,

        wallClockMs:
          4444
      }
    );

    assert.equal(
      signal.trustedTime.observedAtMs,
      4444
    );

    assert.equal(
      signal.trustedTime.pulseId,
      'pulse-12-5'
    );

    assert.equal(
      signal.provenance.authorityEpoch,
      12
    );

    assert.equal(
      options.eventClass,
      'durable'
    );
  }
);


test(
  'F1.1 durable biological publisher rejects accidental best-effort downgrade',
  async () => {
    const fabric =
      new EventFabric({
        clock:
          () => 5001
      });

    const signal =
      createSignal({
        signalId:
          'runtime.time.pulse:1:1',

        topic:
          'runtime.time.pulse',

        payload: {
          wallClockMs:
            5000
        },

        trustedTime: {
          source:
            'kernel',

          observedAtMs:
            5000
        },

        provenance: {
          producerType:
            'kernel',

          producerId:
            'living-kernel',

          authorityEpoch:
            1
        }
      });

    await assert.rejects(
      fabric.publishBiologicalSignal(
        signal,
        {
          eventClass:
            'best-effort'
        }
      ),

      error =>
        error.code ===
        'BIOLOGICAL_FABRIC_EVENT_CLASS'
    );
  }
);
