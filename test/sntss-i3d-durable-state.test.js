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
  manifest:
    i3cManifest,

  createState:
    createI3CState,

  normalizeState:
    normalizeI3CState
} = require(
  '../cores/sntss/i3c'
);


const {
  QUANTUM_MS,
  MAX_STEPS_PER_ADVANCE,
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


const {
  availabilityProfile
} = require(
  '../cores/sntss/i3d/receptor-availability-profile'
);


const {
  VERSION,
  STAGE,
  createState,
  normalizeState,
  migrateI3CState,
  advanceRegulatedPhysiology,
  validateAlignment
} = require(
  '../cores/sntss/i3d/durable-state'
);


function clone(value) {
  return JSON.parse(
    JSON.stringify(value)
  );
}


function i3cWithAdaptationHistory(
  steps = 80
) {
  const source =
    createI3CState(
      i3cManifest.version
    );


  let chemistry =
    createChemicalState(0);


  let observation =
    observeReceptors(
      chemistry
    );


  let adaptation =
    createReceptorAdaptationState(
      observation
    );


  for (
    let index = 1;
    index <= steps;
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


    observation =
      observeReceptors(
        chemistry
      );


    adaptation =
      advanceReceptorAdaptation(
        adaptation,
        observation
      ).state;
  }


  source.chemistry =
    chemistry;


  source.receptorAdaptation =
    adaptation;


  return normalizeI3CState(
    source,
    i3cManifest.version
  );
}


test(
  'I3-D2 creates schema-4 durable regulation state with three aligned physiology clocks',
  () => {
    const state =
      createState();


    assert.equal(
      state.formatVersion,
      1
    );


    assert.equal(
      state.stateSchema,
      4
    );


    assert.equal(
      state.coreVersion,
      VERSION
    );


    assert.equal(
      state.stage,
      STAGE
    );


    assert.equal(
      state.chemistry.modelClock,
      0
    );


    assert.equal(
      state.receptorAdaptation
        .modelClock,
      0
    );


    assert.equal(
      state.receptorAvailability
        .modelClock,
      0
    );


    assert.doesNotThrow(
      () =>
        validateAlignment(
          state
        )
    );
  }
);


test(
  'I3-D2 migration preserves exact I3-C physiology and trusted state while adding neutral availability',
  () => {
    const source =
      i3cWithAdaptationHistory();


    const migrated =
      migrateI3CState(
        source
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


    assert.equal(
      stableStringify(
        migrated.trustedTime
      ),
      stableStringify(
        source.trustedTime
      )
    );


    assert.equal(
      stableStringify(
        migrated.organismBinding
      ),
      stableStringify(
        source.organismBinding
      )
    );


    assert.equal(
      migrated
        .receptorAvailability
        .modelClock,
      source.chemistry
        .modelClock
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


    assert.equal(
      migrated.migrations.at(-1),
      'schema-3->4:i3d-durable-receptor-regulation:neutral-receptor-availability'
    );
  }
);


test(
  'I3-D2 never invents historical availability from pre-I3-D receptor adaptation',
  () => {
    const source =
      i3cWithAdaptationHistory(
        120
      );


    assert.ok(
      source
        .receptorAdaptation
        .receptors[
          'dopamine-d1-like'
        ].tolerance > 0
    );


    const migrated =
      migrateI3CState(
        source
      );


    assert.equal(
      migrated
        .receptorAvailability
        .receptors[
          'dopamine-d1-like'
        ].availability,
      availabilityProfile
        .initialAvailability
    );
  }
);


test(
  'I3-D2 one complete quantum advances chemistry adaptation and availability on exactly one clock',
  () => {
    const initial =
      createState();


    const result =
      advanceRegulatedPhysiology(
        initial,
        QUANTUM_MS
      );


    assert.equal(
      result.transition.steps,
      1
    );


    assert.equal(
      result.state
        .chemistry
        .modelClock,
      QUANTUM_MS
    );


    assert.equal(
      result.state
        .receptorAdaptation
        .modelClock,
      QUANTUM_MS
    );


    assert.equal(
      result.state
        .receptorAvailability
        .modelClock,
      QUANTUM_MS
    );
  }
);


test(
  'I3-D2 partial chemistry time cannot advance receptor physiology before a complete quantum',
  () => {
    const initial =
      createState();


    const first =
      advanceRegulatedPhysiology(
        initial,
        125
      );


    assert.equal(
      first.transition.steps,
      0
    );


    assert.equal(
      first.state
        .chemistry
        .remainderMs,
      125
    );


    assert.equal(
      first.state
        .chemistry
        .modelClock,
      0
    );


    assert.equal(
      first.state
        .receptorAdaptation
        .modelClock,
      0
    );


    assert.equal(
      first.state
        .receptorAvailability
        .modelClock,
      0
    );


    const second =
      advanceRegulatedPhysiology(
        first.state,
        125
      );


    assert.equal(
      second.transition.steps,
      1
    );


    assert.equal(
      second.state
        .chemistry
        .modelClock,
      QUANTUM_MS
    );


    assert.equal(
      second.state
        .receptorAdaptation
        .modelClock,
      QUANTUM_MS
    );


    assert.equal(
      second.state
        .receptorAvailability
        .modelClock,
      QUANTUM_MS
    );
  }
);


test(
  'I3-D2 rejects divergence of the persistent receptor-availability clock',
  () => {
    const state =
      createState();


    state
      .receptorAvailability
      .modelClock +=
      QUANTUM_MS;


    assert.throws(
      () =>
        validateAlignment(
          state
        ),

      error =>
        error?.code ===
        'SNTSS_I3D_CLOCK_DIVERGENCE'
    );
  }
);


test(
  'I3-D2 rejects forged persisted receptor availability outside its frozen floor',
  () => {
    const state =
      createState();


    state
      .receptorAvailability
      .receptors[
        'dopamine-d1-like'
      ].availability =
      availabilityProfile
        .minimumAvailability -
      1;


    assert.throws(
      () =>
        normalizeState(
          state
        ),

      error =>
        error?.code ===
        'SNTSS_I3D_AVAILABILITY_BOUNDS'
    );
  }
);


test(
  'I3-D2 bounded-work protection rejects oversized biological catch-up without mutating input',
  () => {
    const state =
      createState();


    const before =
      stableStringify(
        state
      );


    assert.throws(
      () =>
        advanceRegulatedPhysiology(
          state,
          (
            MAX_STEPS_PER_ADVANCE +
            1
          ) *
          QUANTUM_MS
        ),

      error =>
        error?.code ===
        'SNTSS_I2_ADVANCE_BOUNDED'
    );


    assert.equal(
      stableStringify(
        state
      ),
      before
    );
  }
);


test(
  'I3-D2 regulated physiology is deterministic and input-immutable',
  () => {
    const state =
      createState();


    const before =
      stableStringify(
        state
      );


    const first =
      advanceRegulatedPhysiology(
        state,
        QUANTUM_MS * 8
      );


    const second =
      advanceRegulatedPhysiology(
        state,
        QUANTUM_MS * 8
      );


    assert.equal(
      stableStringify(
        first
      ),
      stableStringify(
        second
      )
    );


    assert.equal(
      stableStringify(
        state
      ),
      before
    );
  }
);
