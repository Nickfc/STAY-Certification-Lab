'use strict';

/*
 * STAY / SNTSS I3-D2
 *
 * Durable synthetic receptor-regulation state.
 *
 * Schema 4 owns:
 *   - I2 chemical state
 *   - I3 receptor adaptation memory
 *   - I3-D receptor availability memory
 *
 * All three physiological clocks must remain aligned.
 *
 * This is still a pure state/integration layer.
 * Runtime CoreHost attachment comes later.
 */

const {
  manifest:
    i3cManifest,

  createState:
    createI3CState,

  normalizeState:
    normalizeI3CState
} = require(
  './i3c-state'
);


const {
  QUANTUM_MS,
  MAX_STEPS_PER_ADVANCE,
  createChemicalState,
  validateChemicalState,
  advanceChemicalState
} = require(
  './chemical-state'
);


const {
  observeReceptors
} = require(
  './receptor-model'
);


const {
  createReceptorAdaptationState,
  advanceReceptorAdaptation,
  buildProbe,
  validateState:
    validateReceptorAdaptationState
} = require(
  './receptor-adaptation'
);


const {
  availabilityProfile
} = require(
  './receptor-availability-profile'
);


const {
  createReceptorAvailabilityState,
  advanceReceptorAvailability,
  validateState:
    validateReceptorAvailabilityState
} = require(
  './receptor-availability'
);


const VERSION =
  '0.4.0-i3d2';


const STAGE =
  'i3d-durable-receptor-regulation';


function fail(
  message,
  code =
    'SNTSS_I3D_STATE_INVALID'
) {
  throw Object.assign(
    new Error(message),
    { code }
  );
}


function clone(value) {
  return JSON.parse(
    JSON.stringify(value)
  );
}


function validateAlignment(
  state
) {
  validateChemicalState(
    state.chemistry
  );

  validateReceptorAdaptationState(
    state.receptorAdaptation
  );

  validateReceptorAvailabilityState(
    state.receptorAvailability
  );


  const chemicalClock =
    state.chemistry.modelClock;

  const adaptationClock =
    state.receptorAdaptation
      .modelClock;

  const availabilityClock =
    state.receptorAvailability
      .modelClock;


  if (
    chemicalClock !==
      adaptationClock ||
    chemicalClock !==
      availabilityClock
  ) {
    fail(
      'chemical, receptor adaptation and receptor availability clocks diverged',
      'SNTSS_I3D_CLOCK_DIVERGENCE'
    );
  }


  return state;
}


function createState(
  version = VERSION
) {
  /*
   * Start from the exact frozen I3-C neutral state,
   * then add neutral receptor availability at the
   * same biological clock.
   */
  const i3c =
    createI3CState(
      i3cManifest.version
    );


  const observation =
    observeReceptors(
      i3c.chemistry
    );


  const adaptedProbe =
    buildProbe(
      i3c.receptorAdaptation,
      observation
    );


  const state = {
    formatVersion: 1,

    stateSchema: 4,

    protocol:
      'stay-sntss-v1',

    coreVersion:
      version,

    stage:
      STAGE,

    organismBinding:
      clone(
        i3c.organismBinding
      ),

    chemistry:
      clone(
        i3c.chemistry
      ),

    receptorAdaptation:
      clone(
        i3c.receptorAdaptation
      ),

    receptorAvailability:
      createReceptorAvailabilityState(
        adaptedProbe
      ),

    trustedTime:
      clone(
        i3c.trustedTime
      ),

    migrations: []
  };


  validateAlignment(state);

  return clone(state);
}


function validateI3CEnvelope(
  source
) {
  /*
   * Reconstruct a strict schema-3 envelope and let
   * frozen I3-C validate binding, trusted time,
   * chemistry and receptor adaptation semantics.
   */
  return normalizeI3CState(
    {
      formatVersion: 1,

      stateSchema: 3,

      protocol:
        'stay-sntss-v1',

      coreVersion:
        i3cManifest.version,

      stage:
        'i3-durable-receptor-physiology',

      organismBinding:
        clone(
          source.organismBinding
        ),

      chemistry:
        clone(
          source.chemistry
        ),

      receptorAdaptation:
        clone(
          source.receptorAdaptation
        ),

      trustedTime:
        clone(
          source.trustedTime
        ),

      migrations:
        clone(
          source.migrations
        )
    },

    i3cManifest.version
  );
}


function normalizeState(
  input,
  version = VERSION
) {
  const source =
    input &&
    typeof input === 'object' &&
    !Array.isArray(input)
      ? input
      : {};


  if (
    Object.keys(source).length === 0
  ) {
    return createState(
      version
    );
  }


  const allowed =
    new Set([
      'formatVersion',
      'stateSchema',
      'protocol',
      'coreVersion',
      'stage',
      'organismBinding',
      'chemistry',
      'receptorAdaptation',
      'receptorAvailability',
      'trustedTime',
      'migrations'
    ]);


  for (
    const key
    of Object.keys(source)
  ) {
    if (!allowed.has(key)) {
      fail(
        `I3-D state field is not allowed: ${key}`
      );
    }
  }


  if (
    source.formatVersion !== 1 ||
    source.stateSchema !== 4 ||
    source.protocol !==
      'stay-sntss-v1' ||
    source.stage !==
      STAGE
  ) {
    fail(
      'I3-D state header is invalid'
    );
  }


  if (
    typeof source.coreVersion !==
      'string' ||
    !source.coreVersion
  ) {
    fail(
      'I3-D core version is invalid'
    );
  }


  if (
    !Array.isArray(
      source.migrations
    ) ||
    source.migrations.length > 64
  ) {
    fail(
      'I3-D migration history is invalid'
    );
  }


  /*
   * This validates all inherited I3-C state
   * without weakening its frozen rules.
   */
  const inherited =
    validateI3CEnvelope(
      source
    );


  const normalized =
    clone(source);


  normalized.coreVersion =
    version;


  normalized.organismBinding =
    clone(
      inherited.organismBinding
    );


  normalized.chemistry =
    clone(
      inherited.chemistry
    );


  normalized.receptorAdaptation =
    clone(
      inherited.receptorAdaptation
    );


  normalized.trustedTime =
    clone(
      inherited.trustedTime
    );


  validateReceptorAvailabilityState(
    normalized.receptorAvailability
  );


  validateAlignment(
    normalized
  );


  return normalized;
}


function migrateI3CState(
  input,
  version = VERSION
) {
  /*
   * Frozen I3-C performs the complete schema-3
   * validation first.
   */
  const source =
    normalizeI3CState(
      input,
      i3cManifest.version
    );


  const observation =
    observeReceptors(
      source.chemistry
    );


  const adaptedProbe =
    buildProbe(
      source.receptorAdaptation,
      observation
    );


  /*
   * We deliberately DO NOT derive historical
   * receptor availability from pre-I3-D receptor
   * adaptation.
   *
   * Availability begins neutral at the exact
   * current biological model clock.
   */
  const receptorAvailability =
    createReceptorAvailabilityState(
      adaptedProbe
    );


  const history =
    source.migrations
      .map(String)
      .slice(-63);


  const next = {
    formatVersion: 1,

    stateSchema: 4,

    protocol:
      'stay-sntss-v1',

    coreVersion:
      version,

    stage:
      STAGE,

    organismBinding:
      clone(
        source.organismBinding
      ),

    chemistry:
      clone(
        source.chemistry
      ),

    receptorAdaptation:
      clone(
        source.receptorAdaptation
      ),

    receptorAvailability,

    trustedTime:
      clone(
        source.trustedTime
      ),

    migrations: [
      ...history,

      'schema-3->4:i3d-durable-receptor-regulation:neutral-receptor-availability'
    ]
  };


  validateAlignment(next);

  return clone(next);
}


function advanceRegulatedPhysiology(
  inputState,
  elapsedMs
) {
  const state =
    normalizeState(
      inputState,
      inputState?.coreVersion ||
        VERSION
    );


  if (
    !Number.isSafeInteger(
      elapsedMs
    ) ||
    elapsedMs < 0
  ) {
    fail(
      'elapsed regulated physiology time is invalid',
      'SNTSS_I3D_TIME_INVALID'
    );
  }


  const totalMs =
    state.chemistry.remainderMs +
    elapsedMs;


  if (
    !Number.isSafeInteger(
      totalMs
    )
  ) {
    fail(
      'regulated physiology elapsed time overflowed',
      'SNTSS_I3D_TIME_INVALID'
    );
  }


  const plannedSteps =
    Math.floor(
      totalMs /
      QUANTUM_MS
    );


  if (
    plannedSteps >
      MAX_STEPS_PER_ADVANCE
  ) {
    fail(
      'regulated physiology advance exceeds bounded work limit',
      'SNTSS_I2_ADVANCE_BOUNDED'
    );
  }


  let remaining =
    elapsedMs;


  let integratedSteps = 0;


  while (
    remaining > 0
  ) {
    const untilQuantum =
      QUANTUM_MS -
      state.chemistry.remainderMs;


    const slice =
      Math.min(
        remaining,
        untilQuantum
      );


    const chemical =
      advanceChemicalState(
        state.chemistry,
        slice,
        {}
      );


    state.chemistry =
      chemical.state;


    remaining -=
      slice;


    if (
      chemical.transition.steps ===
        0
    ) {
      continue;
    }


    if (
      chemical.transition.steps !==
        1
    ) {
      fail(
        'internal regulated physiology integration exceeded one quantum',
        'SNTSS_I3D_INTEGRATION_INVALID'
      );
    }


    const observation =
      observeReceptors(
        state.chemistry
      );


    const adapted =
      advanceReceptorAdaptation(
        state.receptorAdaptation,
        observation
      );


    state.receptorAdaptation =
      adapted.state;


    const availability =
      advanceReceptorAvailability(
        state.receptorAvailability,
        adapted.probe
      );


    state.receptorAvailability =
      availability.state;


    integratedSteps +=
      1;
  }


  if (
    integratedSteps !==
      plannedSteps
  ) {
    fail(
      'regulated physiology integration step accounting diverged',
      'SNTSS_I3D_INTEGRATION_INVALID'
    );
  }


  validateAlignment(
    state
  );


  return {
    state:
      clone(state),

    transition: {
      elapsedMs,

      quantumMs:
        QUANTUM_MS,

      steps:
        integratedSteps,

      chemicalModelClock:
        state.chemistry
          .modelClock,

      receptorAdaptationModelClock:
        state.receptorAdaptation
          .modelClock,

      receptorAvailabilityModelClock:
        state.receptorAvailability
          .modelClock
    }
  };
}


module.exports = {
  VERSION,
  STAGE,
  createState,
  normalizeState,
  migrateI3CState,
  advanceRegulatedPhysiology,
  validateAlignment
};
