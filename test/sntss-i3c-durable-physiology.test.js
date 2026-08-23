'use strict';

const test =
  require('node:test');

const assert =
  require('node:assert/strict');

const {
  stableStringify
} = require(
  '../runtime/kernel/canonical-json'
);

const {
  enforcePackagePolicy,
  verifyManifestAgainstPackagePolicy
} = require(
  '../runtime/kernel/package-policy'
);

const {
  manifest:
    i2Manifest,

  createCore:
    createI2Core
} = require(
  '../cores/sntss/i2'
);

const {
  manifest,
  createCore,
  migrateState,
  createState,
  normalizeState,
  advancePhysiology
} = require(
  '../cores/sntss/i3c'
);

const {
  QUANTUM_MS,
  createChemicalState
} = require(
  '../cores/sntss/i3c/chemical-state'
);

const {
  observeReceptors
} = require(
  '../cores/sntss/i3c/receptor-model'
);

const {
  createReceptorAdaptationState,
  advanceReceptorAdaptation
} = require(
  '../cores/sntss/i3c/receptor-adaptation'
);


const IDENTITY =
  'sha256:' +
  'c'.repeat(64);


function binding() {
  return {
    id:
      'i3c-binding',

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
      `i3c-${runtimeRevision}-${pulseSequence}`,

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


async function i2Snapshot() {
  const core =
    await createI2Core({
      manifest:
        i2Manifest,

      initialState: {}
    });

  await core.start();

  await core.handle(
    binding()
  );

  await core.handle(
    pulse(
      1,
      1,
      1000
    )
  );

  await core.handle(
    pulse(
      1,
      2,
      2000
    )
  );

  return core.snapshot();
}


function adaptationIsZero(
  state
) {
  return Object.values(
    state.receptorAdaptation
      .receptors
  ).every(
    value =>
      value.exposure === 0 &&
      value.desensitization === 0 &&
      value.tolerance === 0
  );
}


test(
  'I3-C manifest remains laboratory-only with zero outputs',
  () => {
    assert.equal(
      manifest.coreId,
      'sntss'
    );

    assert.equal(
      manifest.version,
      '0.3.0-i3c'
    );

    assert.equal(
      manifest.stateSchema,
      3
    );

    assert.equal(
      manifest.stage,
      'i3-durable-receptor-physiology'
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
  'I3-C self-contained package passes cryptographic package attestation',
  () => {
    const record =
      enforcePackagePolicy(
        require.resolve(
          '../cores/sntss/i3c'
        )
      );

    assert.ok(record);

    assert.equal(
      record.policy.coreId,
      'sntss'
    );

    assert.equal(
      record.policy
        .bounds
        .productionOutputs,
      0
    );

    verifyManifestAgainstPackagePolicy(
      record,
      manifest
    );
  }
);


test(
  'I3-C migration preserves I2 chemistry and trusted-time state exactly',
  async () => {
    const source =
      await i2Snapshot();

    const migrated =
      await migrateState({
        state: source,
        fromSchema: 2,
        toSchema: 3
      });

    assert.equal(
      stableStringify(
        migrated.chemistry
      ),
      stableStringify(
        source.chemistry
      )
    );

    assert.equal(
      stableStringify(
        migrated.trustedTime
      ),
      stableStringify(
        source.trustedTime
      )
    );

    assert.equal(
      migrated.organismBinding
        .identitySha256,
      source.organismBinding
        .identitySha256
    );

    assert.equal(
      migrated
        .receptorAdaptation
        .modelClock,
      migrated
        .chemistry
        .modelClock
    );
  }
);


test(
  'I3-C migration never invents historical receptor tolerance',
  async () => {
    const migrated =
      await migrateState({
        state:
          await i2Snapshot(),

        fromSchema: 2,
        toSchema: 3
      });

    assert.equal(
      adaptationIsZero(
        migrated
      ),
      true
    );

    assert.equal(
      migrated.migrations.at(-1),
      'schema-2->3:i3-durable-receptor-physiology:neutral-receptor-memory'
    );
  }
);


test(
  'I3-C trusted interval advances chemistry and receptor physiology on the same clock',
  async () => {
    const migrated =
      await migrateState({
        state:
          await i2Snapshot(),

        fromSchema: 2,
        toSchema: 3
      });

    const core =
      await createCore({
        manifest,
        initialState:
          migrated
      });

    await core.start();

    await core.handle(
      pulse(
        1,
        3,
        3000
      )
    );

    const state =
      await core.snapshot();

    assert.equal(
      state.chemistry.modelClock,
      2000
    );

    assert.equal(
      state
        .receptorAdaptation
        .modelClock,
      2000
    );

    assert.equal(
      state.trustedTime
        .integratedIntervals,
      2
    );
  }
);


test(
  'I3-C Kernel revision re-anchor causes no downtime chemistry or receptor catch-up',
  async () => {
    const migrated =
      await migrateState({
        state:
          await i2Snapshot(),

        fromSchema: 2,
        toSchema: 3
      });

    const first =
      await createCore({
        manifest,
        initialState:
          migrated
      });

    await first.start();

    await first.handle(
      pulse(
        1,
        3,
        3000
      )
    );

    const before =
      await first.snapshot();

    const restarted =
      await createCore({
        manifest,
        initialState:
          before
      });

    await restarted.start();

    await restarted.handle(
      pulse(
        2,
        1,
        9000000
      )
    );

    const anchored =
      await restarted.snapshot();

    assert.equal(
      stableStringify(
        anchored.chemistry
      ),
      stableStringify(
        before.chemistry
      )
    );

    assert.equal(
      stableStringify(
        anchored.receptorAdaptation
      ),
      stableStringify(
        before.receptorAdaptation
      )
    );

    assert.equal(
      anchored.trustedTime
        .lastRuntimeRevision,
      2
    );

    assert.equal(
      anchored.trustedTime
        .lastPulseSequence,
      1
    );
  }
);


test(
  'I3-C persisted nonzero receptor memory survives snapshot reconstruction exactly',
  async () => {
    const state =
      createState(
        manifest.version
      );

    let adaptation =
      createReceptorAdaptationState(
        observeReceptors(
          createChemicalState(0)
        )
      );

    let chemistry =
      null;

    for (
      let index = 1;
      index <= 80;
      index += 1
    ) {
      chemistry =
        createChemicalState(
          index *
          QUANTUM_MS
        );

      chemistry.transmitters[
        'dopamine-like'
      ].C = 900000;

      const observation =
        observeReceptors(
          chemistry
        );

      adaptation =
        advanceReceptorAdaptation(
          adaptation,
          observation
        ).state;
    }

    assert.ok(
      adaptation
        .receptors[
          'dopamine-d1-like'
        ]
        .exposure > 0
    );

    state.chemistry =
      chemistry;

    state.receptorAdaptation =
      adaptation;

    const normalized =
      normalizeState(
        state,
        manifest.version
      );

    const first =
      await createCore({
        manifest,
        initialState:
          normalized
      });

    await first.start();

    const snapshot =
      await first.snapshot();

    const second =
      await createCore({
        manifest,
        initialState:
          snapshot
      });

    await second.start();

    const recovered =
      await second.snapshot();

    assert.equal(
      stableStringify(
        recovered
          .receptorAdaptation
      ),
      stableStringify(
        snapshot
          .receptorAdaptation
      )
    );

    assert.ok(
      recovered
        .receptorAdaptation
        .receptors[
          'dopamine-d1-like'
        ]
        .tolerance > 0
    );
  }
);


test(
  'I3-C rejects chemical and receptor clock divergence',
  () => {
    const state =
      createState(
        manifest.version
      );

    state
      .receptorAdaptation
      .modelClock +=
        QUANTUM_MS;

    assert.throws(
      () =>
        normalizeState(
          state,
          manifest.version
        ),

      error =>
        error?.code ===
        'SNTSS_I3C_CLOCK_DIVERGENCE'
    );
  }
);


test(
  'I3-C physiology integration is deterministic and bounded',
  () => {
    const first =
      createState(
        manifest.version
      );

    const second =
      createState(
        manifest.version
      );

    const a =
      advancePhysiology(
        first,
        1000
      );

    const b =
      advancePhysiology(
        second,
        1000
      );

    assert.equal(
      stableStringify(first),
      stableStringify(second)
    );

    assert.deepEqual(
      a,
      b
    );

    assert.equal(
      first.chemistry.modelClock,
      first
        .receptorAdaptation
        .modelClock
    );

    assert.equal(
      a.steps,
      4
    );
  }
);


test(
  'I3-C cannot perform oversized physiology catch-up work',
  () => {
    const state =
      createState(
        manifest.version
      );

    assert.throws(
      () =>
        advancePhysiology(
          state,
          QUANTUM_MS *
          4097
        ),

      error =>
        error?.code ===
        'SNTSS_I2_ADVANCE_BOUNDED'
    );
  }
);


test(
  'I3-C exact duplicate trusted pulse is idempotent',
  async () => {
    const core =
      await createCore({
        manifest,
        initialState: {}
      });

    await core.start();

    await core.handle(
      binding()
    );

    await core.handle(
      pulse(
        1,
        1,
        1000
      )
    );

    const before =
      await core.snapshot();

    await core.handle(
      pulse(
        1,
        1,
        1000
      )
    );

    const after =
      await core.snapshot();

    assert.equal(
      stableStringify(after),
      stableStringify(before)
    );
  }
);


test(
  'I3-C conflicting duplicate trusted pulse fails closed',
  async () => {
    const core =
      await createCore({
        manifest,
        initialState: {}
      });

    await core.start();

    await core.handle(
      binding()
    );

    await core.handle(
      pulse(
        1,
        1,
        1000
      )
    );

    await assert.rejects(
      () =>
        core.handle(
          pulse(
            1,
            1,
            1001
          )
        ),

      error =>
        error?.code ===
        'SNTSS_TIME_REPLAY_CONFLICT'
    );
  }
);


test(
  'I3-C trusted pulse sequence gaps fail closed without biological catch-up',
  async () => {
    const core =
      await createCore({
        manifest,
        initialState: {}
      });

    await core.start();

    await core.handle(
      binding()
    );

    await core.handle(
      pulse(
        1,
        1,
        1000
      )
    );

    const before =
      await core.snapshot();

    await assert.rejects(
      () =>
        core.handle(
          pulse(
            1,
            3,
            3000
          )
        ),

      error =>
        error?.code ===
        'SNTSS_TIME_SEQUENCE_GAP'
    );

    const after =
      await core.snapshot();

    assert.equal(
      stableStringify(after),
      stableStringify(before)
    );
  }
);


test(
  'I3-C older runtime revision is rejected',
  async () => {
    const core =
      await createCore({
        manifest,
        initialState: {}
      });

    await core.start();

    await core.handle(
      binding()
    );

    await core.handle(
      pulse(
        2,
        1,
        1000
      )
    );

    await assert.rejects(
      () =>
        core.handle(
          pulse(
            1,
            2,
            1250
          )
        ),

      error =>
        error?.code ===
        'SNTSS_TIME_REVISION_REWIND'
    );
  }
);


test(
  'I3-C degraded and uncertain clock periods cannot manufacture missed biological time',
  async () => {
    const core =
      await createCore({
        manifest,
        initialState: {}
      });

    await core.start();

    await core.handle(
      binding()
    );

    await core.handle(
      pulse(
        1,
        1,
        1000,
        'trusted'
      )
    );

    await core.handle(
      pulse(
        1,
        2,
        2000,
        'degraded'
      )
    );

    await core.handle(
      pulse(
        1,
        3,
        5000000,
        'uncertain'
      )
    );

    await core.handle(
      pulse(
        1,
        4,
        9000000,
        'trusted'
      )
    );

    const noCatchup =
      await core.snapshot();

    assert.equal(
      noCatchup
        .chemistry
        .modelClock,
      0
    );

    assert.equal(
      noCatchup
        .receptorAdaptation
        .modelClock,
      0
    );

    await core.handle(
      pulse(
        1,
        5,
        9000000 +
          QUANTUM_MS,
        'trusted'
      )
    );

    const resumed =
      await core.snapshot();

    assert.equal(
      resumed
        .chemistry
        .modelClock,
      QUANTUM_MS
    );

    assert.equal(
      resumed
        .receptorAdaptation
        .modelClock,
      QUANTUM_MS
    );
  }
);


test(
  'I3-C forged receptor tolerance outside frozen physiology fails during checkpoint restore',
  () => {
    const state =
      createState(
        manifest.version
      );

    const {
      adaptationProfile
    } = require(
      '../cores/sntss/i3c/receptor-adaptation-profile'
    );

    const receptorId =
      'dopamine-d1-like';

    state
      .receptorAdaptation
      .receptors[
        receptorId
      ]
      .tolerance =
        adaptationProfile
          .receptors[
            receptorId
          ]
          .maxTolerance + 1;

    assert.throws(
      () =>
        normalizeState(
          state,
          manifest.version
        ),

      error =>
        error?.code ===
        'SNTSS_I3_ADAPTATION_STATE_BOUNDS'
    );
  }
);


test(
  'I3-C schema-2 migration rejects injected receptor state',
  async () => {
    const source =
      await i2Snapshot();

    source.receptorAdaptation = {
      forged: true
    };

    await assert.rejects(
      () =>
        migrateState({
          state: source,
          fromSchema: 2,
          toSchema: 3
        }),

      error =>
        error?.code ===
        'SNTSS_MIGRATION_INVALID'
    );
  }
);
