'use strict';

const test =
  require('node:test');

const assert =
  require('node:assert/strict');

const neutral =
  require(
    '../cores/sntss/neutral'
  );

const {
  manifest,
  createCore,
  migrateState
} = require(
  '../cores/sntss/i2'
);

const {
  enforcePackagePolicy,
  verifyManifestAgainstPackagePolicy
} = require(
  '../runtime/kernel/package-policy'
);


const IDENTITY =
  'sha256:' +
  'a'.repeat(64);


function bindingEvent(
  at = 1000
) {
  return {
    id: 'binding-i2',

    topic:
      'runtime.organism.binding',

    at,

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
      issuedAt:
        at,
      runtimeRevision: 1,
      authorityEpoch: 1,
      kernelVersion:
        '0.8.11.3'
    }
  };
}


function pulse(
  sequence,
  wallClockMs,
  status = 'trusted',
  runtimeRevision = 10
) {
  return {
    id:
      `pulse-${sequence}-${wallClockMs}`,

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
      pulseSequence:
        sequence,
      clockStatus:
        status
    }
  };
}


async function newCore() {
  let outputs = 0;

  const core =
    await createCore({
      manifest,
      initialState: {},
      emit: async () => {
        outputs += 1;
        throw new Error(
          'I2-B emitted an output'
        );
      }
    });

  await core.start();

  return {
    core,

    outputs: () =>
      outputs
  };
}


test(
  'I2-B manifest remains internal-only with zero outputs',
  () => {
    assert.equal(
      manifest.coreId,
      'sntss'
    );

    assert.equal(
      manifest.stateSchema,
      2
    );

    assert.equal(
      manifest.productionEligible,
      false
    );

    assert.deepEqual(
      manifest.outputs,
      []
    );
  }
);


test(
  'I2-B package is self-contained and hash-attested',
  () => {
    const modulePath =
      require.resolve(
        '../cores/sntss/i2'
      );

    const record =
      enforcePackagePolicy(
        modulePath
      );

    assert.ok(record);

    assert.equal(
      record.policy.coreId,
      'sntss'
    );

    assert.equal(
      record.policy.bounds
        .productionOutputs,
      0
    );

    assert.equal(
      verifyManifestAgainstPackagePolicy(
        record,
        manifest
      ),
      true
    );
  }
);


test(
  'I2-B migrates neutral schema-1 state into internal chemistry schema-2',
  async () => {
    const old =
      neutral.normalizeState(
        {},
        '0.0.0-neutral'
      );

    const migrated =
      await migrateState({
        state: old,
        fromSchema: 1,
        toSchema: 2
      });

    assert.equal(
      migrated.stateSchema,
      2
    );

    assert.equal(
      migrated.stage,
      'i2-internal-chemistry'
    );

    assert.equal(
      migrated.chemistry.modelClock,
      0
    );

    assert.equal(
      migrated.trustedTime
        .lastPulseSequence,
      0
    );

    assert.deepEqual(
      migrated.migrations,
      [
        'schema-1->2:i2-internal-chemistry'
      ]
    );
  }
);


test(
  'I2-B time pulses cannot start chemistry before organism binding',
  async () => {
    const { core } =
      await newCore();

    await core.handle(
      pulse(
        55,
        100000
      )
    );

    const state =
      await core.snapshot();

    const health =
      await core.health();

    assert.equal(
      state.trustedTime
        .lastPulseSequence,
      0
    );

    assert.equal(
      state.chemistry.modelClock,
      0
    );

    assert.equal(
      health.bound,
      false
    );

    assert.equal(
      health.chemistryActive,
      false
    );
  }
);


test(
  'I2-B consecutive trusted Kernel pulses advance internal chemistry',
  async () => {
    const {
      core,
      outputs
    } = await newCore();

    await core.handle(
      bindingEvent()
    );

    await core.handle(
      pulse(
        100,
        100000
      )
    );

    const anchored =
      await core.snapshot();

    assert.equal(
      anchored.chemistry
        .modelClock,
      0
    );

    await core.handle(
      pulse(
        101,
        101000
      )
    );

    const advanced =
      await core.snapshot();

    const health =
      await core.health();

    assert.equal(
      advanced.chemistry
        .modelClock,
      1000
    );

    assert.equal(
      advanced.trustedTime
        .lastPulseSequence,
      101
    );

    assert.equal(
      advanced.trustedTime
        .integratedIntervals,
      1
    );

    assert.notDeepEqual(
      advanced.chemistry
        .transmitters,
      anchored.chemistry
        .transmitters
    );

    assert.equal(
      health.chemistryActive,
      true
    );

    assert.equal(
      health.chemistryInternalOnly,
      true
    );

    assert.equal(
      health.biologicalOutputs,
      0
    );

    assert.equal(
      outputs(),
      0
    );
  }
);


test(
  'I2-B degraded time pauses chemistry without later catch-up',
  async () => {
    const { core } =
      await newCore();

    await core.handle(
      bindingEvent()
    );

    await core.handle(
      pulse(
        1,
        1000
      )
    );

    await core.handle(
      pulse(
        2,
        2000
      )
    );

    assert.equal(
      (
        await core.snapshot()
      ).chemistry.modelClock,
      1000
    );

    await core.handle(
      pulse(
        3,
        3000,
        'degraded'
      )
    );

    assert.equal(
      (
        await core.snapshot()
      ).chemistry.modelClock,
      1000
    );

    await core.handle(
      pulse(
        4,
        4000,
        'trusted'
      )
    );

    assert.equal(
      (
        await core.snapshot()
      ).chemistry.modelClock,
      1000
    );

    await core.handle(
      pulse(
        5,
        5000,
        'trusted'
      )
    );

    assert.equal(
      (
        await core.snapshot()
      ).chemistry.modelClock,
      2000
    );
  }
);


test(
  'I2-B pulse replay is idempotent while conflicts gaps and rewinds fail closed',
  async () => {
    const { core } =
      await newCore();

    await core.handle(
      bindingEvent()
    );

    const first =
      pulse(
        7,
        7000
      );

    await core.handle(first);

    const before =
      await core.snapshot();

    await core.handle(
      structuredClone(first)
    );

    assert.deepEqual(
      await core.snapshot(),
      before
    );

    await assert.rejects(
      core.handle(
        pulse(
          7,
          7001
        )
      ),
      error =>
        error?.code ===
        'SNTSS_TIME_REPLAY_CONFLICT'
    );

    await assert.rejects(
      core.handle(
        pulse(
          9,
          9000
        )
      ),
      error =>
        error?.code ===
        'SNTSS_TIME_SEQUENCE_GAP'
    );

    await core.handle(
      pulse(
        8,
        8000
      )
    );

    await assert.rejects(
      core.handle(
        pulse(
          9,
          7999
        )
      ),
      error =>
        error?.code ===
        'SNTSS_TIME_REWIND'
    );
  }
);


test(
  'I2-B chemical clock survives snapshot and restart deterministically',
  async () => {
    const first =
      await newCore();

    await first.core.handle(
      bindingEvent()
    );

    await first.core.handle(
      pulse(
        200,
        100000
      )
    );

    await first.core.handle(
      pulse(
        201,
        101000
      )
    );

    const checkpoint =
      await first.core.snapshot();

    assert.equal(
      checkpoint.chemistry
        .modelClock,
      1000
    );

    const restored =
      await createCore({
        manifest,
        initialState:
          checkpoint
      });

    await restored.start();

    await restored.handle(
      pulse(
        202,
        102000
      )
    );

    const after =
      await restored.snapshot();

    assert.equal(
      after.chemistry
        .modelClock,
      2000
    );

    assert.equal(
      after.trustedTime
        .lastPulseSequence,
      202
    );
  }
);
