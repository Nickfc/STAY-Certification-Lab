'use strict';

const fs =
  require('node:fs');

const path =
  require('node:path');

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


const i3cState =
  require(
    '../cores/sntss/i3d/i3c-state'
  );


const {
  manifest,
  createCore,
  createState,
  migrateState
} = require(
  '../cores/sntss/i3d'
);


const {
  QUANTUM_MS
} = require(
  '../cores/sntss/i3d/chemical-state'
);


const {
  availabilityProfile
} = require(
  '../cores/sntss/i3d/receptor-availability-profile'
);


function binding(
  revision = 1,
  at = 1000000
) {
  return {
    id:
      `binding-${revision}`,

    topic:
      'runtime.organism.binding',

    at,

    payload: {
      bindingVersion:
        1,

      identitySha256:
        'sha256:' +
        'a'.repeat(64),

      organismLineage:
        'STAY/Genesis',

      issuedAt:
        at,

      runtimeRevision:
        revision,

      authorityEpoch:
        revision,

      kernelVersion:
        '0.8.11.3'
    },

    meta: {
      sourceCore:
        'living-kernel',

      authorityEpoch:
        revision
    }
  };
}


function pulse(
  revision,
  sequence,
  wallClockMs,
  clockStatus = 'trusted'
) {
  return {
    id:
      `pulse-${revision}-${sequence}-${wallClockMs}-${clockStatus}`,

    topic:
      'runtime.time.pulse',

    at:
      wallClockMs,

    payload: {
      wallClockMs,
      runtimeRevision:
        revision,

      pulseSequence:
        sequence,

      clockStatus
    },

    meta: {
      sourceCore:
        'living-kernel',

      authorityEpoch:
        revision
    }
  };
}


test(
  'I3-D3 runtime manifest remains schema-4, laboratory-only and zero-output',
  () => {
    assert.equal(
      manifest.coreId,
      'sntss'
    );

    assert.equal(
      manifest.version,
      '0.4.0-i3d3'
    );

    assert.equal(
      manifest.stateSchema,
      4
    );

    assert.equal(
      manifest.stage,
      'i3d-durable-receptor-regulation'
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
  'I3-D3 package passes cryptographic package attestation',
  () => {
    const record =
      enforcePackagePolicy(
        require.resolve(
          '../cores/sntss/i3d'
        )
      );

    assert.ok(record);

    assert.equal(
      record.attestedFiles,
      25
    );

    assert.doesNotThrow(
      () =>
        verifyManifestAgainstPackagePolicy(
          record,
          manifest
        )
    );
  }
);


test(
  'I3-D3 runtime package contains no external ../i3c dependency',
  () => {
    const root =
      path.resolve(
        __dirname,
        '../cores/sntss/i3d'
      );

    const stack =
      [root];

    while (
      stack.length
    ) {
      const directory =
        stack.pop();

      for (
        const entry
        of fs.readdirSync(
          directory,
          {
            withFileTypes:
              true
          }
        )
      ) {
        const absolute =
          path.join(
            directory,
            entry.name
          );

        if (
          entry.isDirectory()
        ) {
          stack.push(
            absolute
          );

          continue;
        }

        if (
          entry.isFile() &&
          path.extname(
            entry.name
          ) === '.js'
        ) {
          const source =
            fs.readFileSync(
              absolute,
              'utf8'
            );

          assert.equal(
            source.includes(
              '../i3c'
            ),
            false,
            absolute
          );
        }
      }
    }
  }
);


test(
  'I3-D3 schema-3 migration preserves I3-C physiology and adds neutral availability',
  async () => {
    const source =
      i3cState.createState(
        i3cState.manifest.version
      );

    const migrated =
      await migrateState({
        state:
          source,

        fromSchema:
          3,

        toSchema:
          4
      });

    assert.equal(
      migrated.stateSchema,
      4
    );

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
        migrated.receptorAdaptation
      ),
      stableStringify(
        source.receptorAdaptation
      )
    );

    for (
      const receptor
      of Object.values(
        migrated
          .receptorAvailability
          .receptors
      )
    ) {
      assert.equal(
        receptor.availability,
        availabilityProfile
          .initialAvailability
      );
    }
  }
);


test(
  'I3-D3 trusted runtime advances all three physiology clocks together',
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
        1000000
      )
    );

    await core.handle(
      pulse(
        1,
        2,
        1000000 +
          QUANTUM_MS
      )
    );

    const state =
      await core.snapshot();

    assert.equal(
      state.chemistry.modelClock,
      QUANTUM_MS
    );

    assert.equal(
      state
        .receptorAdaptation
        .modelClock,
      QUANTUM_MS
    );

    assert.equal(
      state
        .receptorAvailability
        .modelClock,
      QUANTUM_MS
    );
  }
);


test(
  'I3-D3 new runtime revision anchors without downtime chemistry, adaptation or availability catch-up',
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
        1000000
      )
    );

    await core.handle(
      pulse(
        1,
        2,
        1000000 +
          QUANTUM_MS
      )
    );

    const before =
      await core.snapshot();

    await core.handle(
      pulse(
        2,
        1,
        51000250
      )
    );

    const anchored =
      await core.snapshot();

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
        anchored
          .receptorAdaptation
      ),
      stableStringify(
        before
          .receptorAdaptation
      )
    );

    assert.equal(
      stableStringify(
        anchored
          .receptorAvailability
      ),
      stableStringify(
        before
          .receptorAvailability
      )
    );

    await core.handle(
      pulse(
        2,
        2,
        51000500
      )
    );

    const finalState =
      await core.snapshot();

    assert.equal(
      finalState
        .chemistry
        .modelClock,
      before.chemistry.modelClock +
        QUANTUM_MS
    );

    assert.equal(
      finalState
        .receptorAdaptation
        .modelClock,
      before
        .receptorAdaptation
        .modelClock +
        QUANTUM_MS
    );

    assert.equal(
      finalState
        .receptorAvailability
        .modelClock,
      before
        .receptorAvailability
        .modelClock +
        QUANTUM_MS
    );
  }
);


test(
  'I3-D3 exact duplicate trusted pulse is idempotent',
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

    const anchor =
      pulse(
        1,
        1,
        1000000
      );

    await core.handle(
      anchor
    );

    const before =
      stableStringify(
        await core.snapshot()
      );

    await core.handle(
      anchor
    );

    const after =
      stableStringify(
        await core.snapshot()
      );

    assert.equal(
      after,
      before
    );
  }
);


test(
  'I3-D3 conflicting duplicate trusted pulse fails closed',
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
        1000000
      )
    );

    await assert.rejects(
      () =>
        core.handle(
          pulse(
            1,
            1,
            1000001
          )
        ),

      error =>
        error?.code ===
          'SNTSS_TIME_REPLAY_CONFLICT'
    );
  }
);


test(
  'I3-D3 forged availability below frozen floor is rejected during restore',
  async () => {
    const state =
      createState(
        manifest.version
      );

    state
      .receptorAvailability
      .receptors[
        'dopamine-d1-like'
      ].availability =
      availabilityProfile
        .minimumAvailability -
      1;

    await assert.rejects(
      () =>
        createCore({
          manifest,
          initialState:
            state
        }),

      error =>
        error?.code ===
          'SNTSS_I3D_AVAILABILITY_BOUNDS'
    );
  }
);


test(
  'I3-D3 health exposes internal regulation with zero biological authority',
  async () => {
    const core =
      await createCore({
        manifest,
        initialState: {}
      });

    await core.start();

    const health =
      await core.health();

    assert.equal(
      health.ok,
      true
    );

    assert.equal(
      health
        .chemicalModelClock,
      health
        .receptorModelClock
    );

    assert.equal(
      health
        .chemicalModelClock,
      health
        .receptorAvailabilityModelClock
    );

    assert.equal(
      health
        .receptorRegulationInternalOnly,
      true
    );

    assert.equal(
      health.biologicalOutputs,
      0
    );

    assert.equal(
      health.declaredOutputs,
      0
    );

    assert.equal(
      health.productionEligible,
      false
    );
  }
);
