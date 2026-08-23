'use strict';

const test =
  require('node:test');

const assert =
  require('node:assert/strict');

const {
  manifest,
  createCore
} = require(
  '../cores/sntss/i2'
);


const IDENTITY =
  'sha256:' +
  'b'.repeat(64);


function binding() {
  return {
    id: 'i2e-binding',

    topic:
      'runtime.organism.binding',

    at: 1000,

    meta: {
      sourceCore:
        'living-kernel',

      authorityEpoch: 1
    },

    payload: {
      bindingVersion: 1,

      identitySha256:
        IDENTITY,

      organismLineage:
        'STAY/Genesis',

      issuedAt: 1000,

      runtimeRevision: 1,

      authorityEpoch: 1,

      kernelVersion:
        '0.8.11.3'
    }
  };
}


function pulse(
  runtimeRevision,
  pulseSequence,
  wallClockMs,
  clockStatus = 'trusted'
) {
  return {
    id:
      `i2e-${runtimeRevision}-${pulseSequence}`,

    topic:
      'runtime.time.pulse',

    at:
      wallClockMs,

    meta: {
      sourceCore:
        'living-kernel',

      authorityEpoch:
        runtimeRevision
    },

    payload: {
      wallClockMs,
      runtimeRevision,
      pulseSequence,
      clockStatus
    }
  };
}


async function core() {
  const instance =
    await createCore({
      manifest,
      initialState: {}
    });

  await instance.start();

  await instance.handle(
    binding()
  );

  return instance;
}


test(
  'I2-E newer runtime revision re-anchors pulse sequence without downtime catch-up',
  async () => {
    const instance =
      await core();

    await instance.handle(
      pulse(
        10,
        50,
        100000
      )
    );

    await instance.handle(
      pulse(
        10,
        51,
        101000
      )
    );

    let state =
      await instance.snapshot();

    assert.equal(
      state.chemistry.modelClock,
      1000
    );

    assert.equal(
      state.trustedTime
        .lastRuntimeRevision,
      10
    );

    assert.equal(
      state.trustedTime
        .lastPulseSequence,
      51
    );

    /*
     * Simulate a Kernel restart:
     * revision advances, pulse sequence resets,
     * and wall clock has moved far ahead.
     */
    await instance.handle(
      pulse(
        11,
        1,
        500000
      )
    );

    state =
      await instance.snapshot();

    assert.equal(
      state.chemistry.modelClock,
      1000,
      'restart downtime must not be chemically caught up'
    );

    assert.equal(
      state.trustedTime
        .lastRuntimeRevision,
      11
    );

    assert.equal(
      state.trustedTime
        .lastPulseSequence,
      1
    );

    await instance.handle(
      pulse(
        11,
        2,
        501000
      )
    );

    state =
      await instance.snapshot();

    assert.equal(
      state.chemistry.modelClock,
      2000
    );

    assert.equal(
      state.trustedTime
        .lastPulseSequence,
      2
    );
  }
);


test(
  'I2-E older runtime revision is rejected even with a larger pulse sequence',
  async () => {
    const instance =
      await core();

    await instance.handle(
      pulse(
        20,
        1,
        200000
      )
    );

    await assert.rejects(
      instance.handle(
        pulse(
          19,
          999,
          201000
        )
      ),

      error =>
        error?.code ===
        'SNTSS_TIME_REVISION_REWIND'
    );
  }
);


test(
  'I2-E newer revision with rewound wall clock fails closed',
  async () => {
    const instance =
      await core();

    await instance.handle(
      pulse(
        30,
        10,
        300000
      )
    );

    await assert.rejects(
      instance.handle(
        pulse(
          31,
          1,
          299999
        )
      ),

      error =>
        error?.code ===
        'SNTSS_TIME_REWIND'
    );
  }
);
