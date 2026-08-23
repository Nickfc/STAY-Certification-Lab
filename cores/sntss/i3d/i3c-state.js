'use strict';

/*
 * STAY / SNTSS I3-C
 *
 * Durable receptor physiology Core.
 *
 * Owns:
 *   - I2 chemical state
 *   - trusted chemical time
 *   - I3 receptor adaptation memory
 *
 * Boundary:
 *   - no Event Fabric outputs
 *   - no behaviour authority
 *   - no fetus authority
 *   - no production eligibility
 *
 * Receptor physiology advances only when chemical
 * model time advances by a trusted quantum.
 */

const {
  QUANTUM_MS,
  MAX_STEPS_PER_ADVANCE,
  ACTIVE_FAMILIES,
  DORMANT_FAMILIES,
  createChemicalState,
  validateChemicalState,
  advanceChemicalState
} = require('./chemical-state');

const {
  receptorProfile
} = require('./receptor-profile');

const {
  observeReceptors
} = require('./receptor-model');

const {
  adaptationProfile
} = require(
  './receptor-adaptation-profile'
);

const {
  createReceptorAdaptationState,
  advanceReceptorAdaptation,
  validateState:
    validateReceptorAdaptationState
} = require(
  './receptor-adaptation'
);


const HASH =
  /^sha256:[0-9a-f]{64}$/;


const CLOCK_STATUSES =
  Object.freeze([
    'trusted',
    'degraded',
    'uncertain'
  ]);


const manifest =
  Object.freeze({
    coreId: 'sntss',

    version:
      '0.3.0-i3c',

    protocol:
      'stay-sntss-v1',

    stateSchema: 3,

    hotSwap: true,

    priority:
      'optional',

    stage:
      'i3-durable-receptor-physiology',

    productionEligible:
      false,

    inputs:
      Object.freeze([
        'runtime.organism.binding',
        'runtime.time.pulse'
      ]),

    outputs:
      Object.freeze([]),

    resources:
      Object.freeze({
        softRamMiB: 64,
        hardRamMiB: 96,

        softCpuPercent: 5,
        hardCpuPercent: 20,

        pidsMax: 16,

        queueCapacity: 256,
        handlerTimeoutMs: 250,
        healthTimeoutMs: 1000,

        outputCapacity: 128,
        outputLimitPerEvent: 16,
        outputBytesPerEvent: 65536,

        storageMiB: 4,

        maxRestarts: 4,
        restartWindowMs: 60000,
        restartBackoffMs: 250
      })
  });


function fail(
  message,
  code
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


function integer(
  value,
  field,
  minimum = 0
) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    fail(
      `invalid ${field}`,
      'SNTSS_I3C_STATE_INVALID'
    );
  }

  return value;
}


function normalizePersistedBinding(
  input
) {
  if (input == null) {
    return null;
  }

  if (
    typeof input !== 'object' ||
    Array.isArray(input)
  ) {
    fail(
      'persisted organism binding is invalid',
      'SNTSS_BINDING_INVALID'
    );
  }

  const allowed =
    new Set([
      'bindingVersion',
      'identitySha256',
      'organismLineage',
      'issuedAt',
      'runtimeRevision',
      'authorityEpoch',
      'kernelVersion',
      'bindingEventId'
    ]);

  for (
    const key
    of Object.keys(input)
  ) {
    if (!allowed.has(key)) {
      fail(
        `persisted binding field is not allowed: ${key}`,
        'SNTSS_BINDING_INVALID'
      );
    }
  }

  if (
    input.bindingVersion !== 1 ||
    !HASH.test(
      input.identitySha256
    ) ||
    input.organismLineage !==
      'STAY/Genesis'
  ) {
    fail(
      'persisted organism binding identity is invalid',
      'SNTSS_BINDING_INVALID'
    );
  }

  integer(
    input.issuedAt,
    'persisted binding issue time'
  );

  integer(
    input.runtimeRevision,
    'persisted binding runtime revision',
    1
  );

  integer(
    input.authorityEpoch,
    'persisted binding authority epoch',
    1
  );

  if (
    typeof input.kernelVersion !==
      'string' ||
    !input.kernelVersion
  ) {
    fail(
      'persisted binding kernel version is invalid',
      'SNTSS_BINDING_INVALID'
    );
  }

  if (
    typeof input.bindingEventId !==
      'string' ||
    !input.bindingEventId
  ) {
    fail(
      'persisted binding event is invalid',
      'SNTSS_BINDING_INVALID'
    );
  }

  return {
    bindingVersion: 1,

    identitySha256:
      input.identitySha256,

    organismLineage:
      input.organismLineage,

    issuedAt:
      input.issuedAt,

    runtimeRevision:
      input.runtimeRevision,

    authorityEpoch:
      input.authorityEpoch,

    kernelVersion:
      input.kernelVersion,

    bindingEventId:
      input.bindingEventId
  };
}


function normalizeBinding(
  payload,
  event
) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    fail(
      'organism binding payload is invalid',
      'SNTSS_BINDING_INVALID'
    );
  }

  const allowed =
    new Set([
      'bindingVersion',
      'identitySha256',
      'organismLineage',
      'issuedAt',
      'runtimeRevision',
      'authorityEpoch',
      'kernelVersion'
    ]);

  for (
    const key
    of Object.keys(payload)
  ) {
    if (!allowed.has(key)) {
      fail(
        `organism binding field is not allowed: ${key}`,
        'SNTSS_BINDING_INVALID'
      );
    }
  }

  if (
    payload.bindingVersion !== 1 ||
    !HASH.test(
      payload.identitySha256
    ) ||
    payload.organismLineage !==
      'STAY/Genesis'
  ) {
    fail(
      'organism binding identity is invalid',
      'SNTSS_BINDING_INVALID'
    );
  }

  integer(
    payload.issuedAt,
    'binding issue time'
  );

  integer(
    payload.runtimeRevision,
    'binding runtime revision',
    1
  );

  integer(
    payload.authorityEpoch,
    'binding authority epoch',
    1
  );

  if (
    payload.issuedAt >
      Number(event.at)
  ) {
    fail(
      'organism binding issue time is in the future',
      'SNTSS_BINDING_INVALID'
    );
  }

  if (
    event.meta?.sourceCore !==
      'living-kernel' ||
    Number(
      event.meta?.authorityEpoch
    ) !==
      payload.authorityEpoch
  ) {
    fail(
      'organism binding is not Kernel-authoritative',
      'SNTSS_BINDING_AUTHORITY'
    );
  }

  if (
    typeof payload.kernelVersion !==
      'string' ||
    !payload.kernelVersion
  ) {
    fail(
      'organism binding kernel version is invalid',
      'SNTSS_BINDING_INVALID'
    );
  }

  return {
    ...payload,

    bindingEventId:
      String(event.id)
  };
}


function sameBinding(
  left,
  right
) {
  return (
    left.bindingVersion ===
      right.bindingVersion &&

    left.identitySha256 ===
      right.identitySha256 &&

    left.organismLineage ===
      right.organismLineage
  );
}


function emptyTrustedTime() {
  return {
    lastWallClockMs: null,
    lastPulseSequence: 0,
    lastRuntimeRevision: 0,
    lastClockStatus: null,
    acceptedPulses: 0,
    integratedIntervals: 0
  };
}


function validateTrustedTime(
  value
) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    fail(
      'trusted-time state is invalid',
      'SNTSS_TIME_INVALID'
    );
  }

  integer(
    value.lastPulseSequence,
    'last pulse sequence'
  );

  integer(
    value.lastRuntimeRevision,
    'last runtime revision'
  );

  integer(
    value.acceptedPulses,
    'accepted pulse count'
  );

  integer(
    value.integratedIntervals,
    'integrated interval count'
  );

  if (
    value.lastWallClockMs !== null
  ) {
    integer(
      value.lastWallClockMs,
      'last wall clock'
    );
  }

  if (
    value.lastClockStatus !== null &&
    !CLOCK_STATUSES.includes(
      value.lastClockStatus
    )
  ) {
    fail(
      'persisted clock status is invalid',
      'SNTSS_TIME_INVALID'
    );
  }

  if (
    value.lastPulseSequence === 0
  ) {
    if (
      value.lastWallClockMs !== null ||
      value.lastRuntimeRevision !== 0 ||
      value.lastClockStatus !== null ||
      value.acceptedPulses !== 0 ||
      value.integratedIntervals !== 0
    ) {
      fail(
        'uninitialized trusted-time state is inconsistent',
        'SNTSS_TIME_INVALID'
      );
    }
  } else if (
    value.lastWallClockMs === null ||
    value.lastRuntimeRevision < 1 ||
    value.lastClockStatus === null ||
    value.acceptedPulses < 1
  ) {
    fail(
      'initialized trusted-time state is incomplete',
      'SNTSS_TIME_INVALID'
    );
  }

  return value;
}


function normalizePulse(
  event
) {
  const pulse =
    event?.payload;

  if (
    !pulse ||
    typeof pulse !== 'object' ||
    Array.isArray(pulse)
  ) {
    fail(
      'trusted-time pulse payload is invalid',
      'SNTSS_TIME_INVALID'
    );
  }

  const allowed =
    new Set([
      'wallClockMs',
      'runtimeRevision',
      'pulseSequence',
      'clockStatus'
    ]);

  for (
    const key
    of Object.keys(pulse)
  ) {
    if (!allowed.has(key)) {
      fail(
        `trusted-time pulse field is not allowed: ${key}`,
        'SNTSS_TIME_INVALID'
      );
    }
  }

  integer(
    pulse.wallClockMs,
    'trusted-time wall clock'
  );

  integer(
    pulse.runtimeRevision,
    'trusted-time runtime revision',
    1
  );

  integer(
    pulse.pulseSequence,
    'trusted-time pulse sequence',
    1
  );

  if (
    !CLOCK_STATUSES.includes(
      pulse.clockStatus
    )
  ) {
    fail(
      'trusted-time clock status is invalid',
      'SNTSS_TIME_INVALID'
    );
  }

  if (
    event.meta?.sourceCore !==
      'living-kernel' ||
    Number(
      event.meta?.authorityEpoch
    ) !==
      pulse.runtimeRevision
  ) {
    fail(
      'trusted-time pulse is not Kernel-authoritative',
      'SNTSS_TIME_AUTHORITY'
    );
  }

  return {
    wallClockMs:
      pulse.wallClockMs,

    runtimeRevision:
      pulse.runtimeRevision,

    pulseSequence:
      pulse.pulseSequence,

    clockStatus:
      pulse.clockStatus
  };
}


function samePulse(
  state,
  pulse
) {
  return (
    state.lastWallClockMs ===
      pulse.wallClockMs &&

    state.lastPulseSequence ===
      pulse.pulseSequence &&

    state.lastRuntimeRevision ===
      pulse.runtimeRevision &&

    state.lastClockStatus ===
      pulse.clockStatus
  );
}


function acceptPulse(
  state,
  pulse
) {
  state.lastWallClockMs =
    pulse.wallClockMs;

  state.lastPulseSequence =
    pulse.pulseSequence;

  state.lastRuntimeRevision =
    pulse.runtimeRevision;

  state.lastClockStatus =
    pulse.clockStatus;

  state.acceptedPulses += 1;
}


function createState(
  version = manifest.version
) {
  const chemistry =
    createChemicalState();

  const receptorAdaptation =
    createReceptorAdaptationState(
      observeReceptors(
        chemistry
      )
    );

  return {
    formatVersion: 1,

    stateSchema: 3,

    protocol:
      'stay-sntss-v1',

    coreVersion:
      version,

    stage:
      'i3-durable-receptor-physiology',

    organismBinding: null,

    chemistry,

    receptorAdaptation,

    trustedTime:
      emptyTrustedTime(),

    migrations: []
  };
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

  if (
    state.chemistry.modelClock !==
      state.receptorAdaptation
        .modelClock
  ) {
    fail(
      'chemical and receptor clocks diverged',
      'SNTSS_I3C_CLOCK_DIVERGENCE'
    );
  }

  return state;
}


function normalizeState(
  input,
  version = manifest.version
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
    return createState(version);
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
      'trustedTime',
      'migrations'
    ]);

  for (
    const key
    of Object.keys(source)
  ) {
    if (!allowed.has(key)) {
      fail(
        `I3-C state field is not allowed: ${key}`,
        'SNTSS_I3C_STATE_INVALID'
      );
    }
  }

  if (
    source.formatVersion !== 1 ||
    source.stateSchema !== 3 ||
    source.protocol !==
      'stay-sntss-v1' ||
    source.stage !==
      'i3-durable-receptor-physiology'
  ) {
    fail(
      'I3-C state header is invalid',
      'SNTSS_I3C_STATE_INVALID'
    );
  }

  const binding =
    normalizePersistedBinding(
      source.organismBinding
    );

  validateTrustedTime(
    source.trustedTime
  );

  if (
    !Array.isArray(
      source.migrations
    ) ||
    source.migrations.length > 64
  ) {
    fail(
      'I3-C migration history is invalid',
      'SNTSS_I3C_STATE_INVALID'
    );
  }

  const normalized =
    clone(source);

  normalized.coreVersion =
    version;

  normalized.organismBinding =
    binding;

  validateAlignment(
    normalized
  );

  return normalized;
}


function normalizeI2Source(
  input
) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  ) {
    fail(
      'I2 migration source is invalid',
      'SNTSS_MIGRATION_INVALID'
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
      'trustedTime',
      'migrations'
    ]);

  for (
    const key
    of Object.keys(input)
  ) {
    if (!allowed.has(key)) {
      fail(
        `I2 migration source field is not allowed: ${key}`,
        'SNTSS_MIGRATION_INVALID'
      );
    }
  }

  if (
    input.formatVersion !== 1 ||
    input.stateSchema !== 2 ||
    input.protocol !==
      'stay-sntss-v1' ||
    input.stage !==
      'i2-internal-chemistry'
  ) {
    fail(
      'I2 migration source header is invalid',
      'SNTSS_MIGRATION_INVALID'
    );
  }

  const binding =
    normalizePersistedBinding(
      input.organismBinding
    );

  validateChemicalState(
    input.chemistry
  );

  validateTrustedTime(
    input.trustedTime
  );

  if (
    !Array.isArray(
      input.migrations
    ) ||
    input.migrations.length > 64
  ) {
    fail(
      'I2 migration history is invalid',
      'SNTSS_MIGRATION_INVALID'
    );
  }

  const result =
    clone(input);

  result.organismBinding =
    binding;

  return result;
}


function migrateI2State(
  input
) {
  const source =
    normalizeI2Source(
      input
    );

  const chemistry =
    clone(
      source.chemistry
    );

  /*
   * We do not invent tolerance from history we never
   * observed. I3 receptor memory begins neutral at the
   * exact current chemical model clock.
   */
  const receptorAdaptation =
    createReceptorAdaptationState(
      observeReceptors(
        chemistry
      )
    );

  const history =
    source.migrations
      .map(String)
      .slice(-63);

  const next = {
    formatVersion: 1,
    stateSchema: 3,
    protocol:
      'stay-sntss-v1',
    coreVersion:
      manifest.version,
    stage:
      'i3-durable-receptor-physiology',

    organismBinding:
      source.organismBinding,

    chemistry,

    receptorAdaptation,

    trustedTime:
      clone(
        source.trustedTime
      ),

    migrations: [
      ...history,
      'schema-2->3:i3-durable-receptor-physiology:neutral-receptor-memory'
    ]
  };

  validateAlignment(next);

  return next;
}


function migrateNeutralState(
  source
) {
  if (
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source)
  ) {
    fail(
      'neutral migration source is invalid',
      'SNTSS_MIGRATION_INVALID'
    );
  }

  if (
    source.formatVersion !== 1 ||
    source.stateSchema !== 1 ||
    source.protocol !==
      'stay-sntss-v1' ||
    source.stage !==
      'neutral'
  ) {
    fail(
      'neutral migration source header is invalid',
      'SNTSS_MIGRATION_INVALID'
    );
  }

  if (
    !source.transmitters ||
    Array.isArray(
      source.transmitters
    ) ||
    Object.keys(
      source.transmitters
    ).length !== 0
  ) {
    fail(
      'neutral migration source contains transmitter chemistry',
      'SNTSS_MIGRATION_INVALID'
    );
  }

  if (
    !source.receptors ||
    Array.isArray(
      source.receptors
    ) ||
    Object.keys(
      source.receptors
    ).length !== 0
  ) {
    fail(
      'neutral migration source contains receptor chemistry',
      'SNTSS_MIGRATION_INVALID'
    );
  }

  const next =
    createState(
      manifest.version
    );

  next.organismBinding =
    normalizePersistedBinding(
      source.organismBinding
    );

  const history =
    Array.isArray(
      source.migrations
    )
      ? source.migrations
          .map(String)
          .slice(-63)
      : [];

  next.migrations = [
    ...history,
    'schema-1->3:i3-durable-receptor-physiology'
  ];

  return next;
}


function advancePhysiology(
  state,
  elapsedMs
) {
  validateAlignment(
    state
  );

  if (
    !Number.isSafeInteger(
      elapsedMs
    ) ||
    elapsedMs < 0
  ) {
    fail(
      'elapsed physiology time is invalid',
      'SNTSS_I3C_TIME_INVALID'
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
      'physiology elapsed time overflowed',
      'SNTSS_I3C_TIME_INVALID'
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
      'physiology advance exceeds bounded work limit',
      'SNTSS_I2_ADVANCE_BOUNDED'
    );
  }

  let remaining =
    elapsedMs;

  let integratedSteps = 0;


  while (remaining > 0) {
    const untilQuantum =
      QUANTUM_MS -
      state.chemistry.remainderMs;

    const slice =
      Math.min(
        remaining,
        untilQuantum
      );

    const result =
      advanceChemicalState(
        state.chemistry,
        slice,
        {}
      );

    state.chemistry =
      result.state;

    remaining -= slice;


    if (
      result.transition.steps === 0
    ) {
      continue;
    }

    if (
      result.transition.steps !== 1
    ) {
      fail(
        'internal physiology integration exceeded one quantum',
        'SNTSS_I3C_INTEGRATION_INVALID'
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

    integratedSteps += 1;
  }


  if (
    integratedSteps !==
      plannedSteps
  ) {
    fail(
      'physiology integration step accounting diverged',
      'SNTSS_I3C_INTEGRATION_INVALID'
    );
  }

  validateAlignment(
    state
  );

  return {
    steps:
      integratedSteps,

    chemicalModelClock:
      state.chemistry.modelClock,

    receptorModelClock:
      state.receptorAdaptation
        .modelClock
  };
}


async function createCore({
  manifest:
    activeManifest = manifest,

  initialState
}) {
  const state =
    normalizeState(
      initialState,
      activeManifest.version
    );


  return {
    async start() {
      normalizeState(
        state,
        activeManifest.version
      );
    },


    async handle(event) {
      if (
        event.topic ===
          'runtime.organism.binding'
      ) {
        const incoming =
          normalizeBinding(
            event.payload,
            event
          );

        if (
          state.organismBinding &&
          !sameBinding(
            state.organismBinding,
            incoming
          )
        ) {
          fail(
            'organism binding changed after first acceptance',
            'SNTSS_BINDING_MISMATCH'
          );
        }

        if (
          !state.organismBinding
        ) {
          state.organismBinding =
            incoming;
        }

        return;
      }


      if (
        event.topic !==
          'runtime.time.pulse'
      ) {
        return;
      }


      const pulse =
        normalizePulse(event);


      /*
       * Biological time cannot advance before
       * organism binding.
       */
      if (
        !state.organismBinding
      ) {
        return;
      }


      const time =
        state.trustedTime;


      /*
       * First observed pulse establishes an anchor.
       * No chemistry or receptor state advances.
       */
      if (
        time.lastPulseSequence === 0
      ) {
        acceptPulse(
          time,
          pulse
        );

        return;
      }


      if (
        pulse.runtimeRevision <
          time.lastRuntimeRevision
      ) {
        fail(
          'runtime revision rewound',
          'SNTSS_TIME_REVISION_REWIND'
        );
      }


      /*
       * A newer Living Kernel runtime resets its local
       * pulse sequence. The first pulse establishes a
       * fresh trusted-time anchor.
       *
       * Critically: NO downtime chemical advance and
       * NO downtime receptor recovery/catch-up.
       */
      if (
        pulse.runtimeRevision >
          time.lastRuntimeRevision
      ) {
        if (
          pulse.wallClockMs <
            time.lastWallClockMs
        ) {
          fail(
            'trusted wall clock rewound across runtime revision',
            'SNTSS_TIME_REWIND'
          );
        }

        acceptPulse(
          time,
          pulse
        );

        return;
      }


      if (
        pulse.pulseSequence ===
          time.lastPulseSequence
      ) {
        if (
          samePulse(
            time,
            pulse
          )
        ) {
          return;
        }

        fail(
          'trusted-time duplicate conflicts with accepted pulse',
          'SNTSS_TIME_REPLAY_CONFLICT'
        );
      }


      if (
        pulse.pulseSequence <
          time.lastPulseSequence
      ) {
        fail(
          'trusted-time sequence rewound',
          'SNTSS_TIME_REWIND'
        );
      }


      if (
        pulse.pulseSequence !==
          time.lastPulseSequence + 1
      ) {
        fail(
          'trusted-time sequence gap detected',
          'SNTSS_TIME_SEQUENCE_GAP'
        );
      }


      if (
        pulse.wallClockMs <
          time.lastWallClockMs
      ) {
        fail(
          'trusted wall clock rewound',
          'SNTSS_TIME_REWIND'
        );
      }


      const previousStatus =
        time.lastClockStatus;

      const previousWallClock =
        time.lastWallClockMs;

      let integrated = false;


      /*
       * Chemistry and receptor physiology share one
       * trusted integration boundary.
       */
      if (
        previousStatus ===
          'trusted' &&
        pulse.clockStatus ===
          'trusted'
      ) {
        const elapsedMs =
          pulse.wallClockMs -
          previousWallClock;

        const result =
          advancePhysiology(
            state,
            elapsedMs
          );

        integrated =
          result.steps > 0;
      }


      acceptPulse(
        time,
        pulse
      );


      if (integrated) {
        time.integratedIntervals += 1;
      }
    },


    async snapshot() {
      return normalizeState(
        state,
        activeManifest.version
      );
    },


    async health() {
      const memories =
        Object.values(
          state
            .receptorAdaptation
            .receptors
        );

      const receptorMemoryActive =
        memories.some(
          value =>
            value.exposure > 0 ||
            value.desensitization > 0 ||
            value.tolerance > 0
        );

      return {
        ok: true,

        stage:
          'i3-durable-receptor-physiology',

        bound:
          Boolean(
            state.organismBinding
          ),

        chemistryInternalOnly:
          true,

        receptorPhysiologyInternalOnly:
          true,

        chemicalModelClock:
          state.chemistry.modelClock,

        receptorModelClock:
          state.receptorAdaptation
            .modelClock,

        chemicalRemainderMs:
          state.chemistry.remainderMs,

        trustedPulseSequence:
          state.trustedTime
            .lastPulseSequence,

        runtimeRevision:
          state.trustedTime
            .lastRuntimeRevision,

        clockStatus:
          state.trustedTime
            .lastClockStatus,

        activeFamilies:
          ACTIVE_FAMILIES.length,

        dormantFamilies:
          DORMANT_FAMILIES.length,

        receptorCount:
          receptorProfile
            .receptors.length,

        receptorMemoryActive,

        receptorProfileHash:
          receptorProfile.profileHash,

        adaptationProfileHash:
          adaptationProfile.profileHash,

        biologicalOutputs: 0,

        productionEligible: false,

        declaredOutputs: 0
      };
    },


    async stop() {}
  };
}


async function migrateState({
  state,
  fromSchema,
  toSchema
}) {
  const from =
    Number(fromSchema);

  const to =
    Number(toSchema);


  if (
    from === 1 &&
    to === 3
  ) {
    return migrateNeutralState(
      state
    );
  }


  if (
    from === 2 &&
    to === 3
  ) {
    return migrateI2State(
      state
    );
  }


  if (
    from === 3 &&
    to === 3
  ) {
    return normalizeState(
      state,
      manifest.version
    );
  }


  fail(
    `unsupported SNTSS migration ${from}->${to}`,
    'SNTSS_MIGRATION_UNSUPPORTED'
  );
}


module.exports = {
  manifest,
  createCore,
  migrateState,
  createState,
  normalizeState,
  normalizePulse,
  advancePhysiology
};
