'use strict';

const {
  ACTIVE_FAMILIES,
  DORMANT_FAMILIES,
  createChemicalState,
  validateChemicalState,
  advanceChemicalState
} = require('./chemical-state');

const HASH =
  /^sha256:[0-9a-f]{64}$/;

const CLOCK_STATUSES =
  Object.freeze([
    'trusted',
    'degraded',
    'uncertain'
  ]);

const manifest = Object.freeze({
  coreId: 'sntss',
  version: '0.2.0-i2b',
  protocol: 'stay-sntss-v1',
  stateSchema: 2,
  hotSwap: true,
  priority: 'optional',

  stage: 'i2-internal-chemistry',
  productionEligible: false,

  inputs: Object.freeze([
    'runtime.organism.binding',
    'runtime.time.pulse'
  ]),

  outputs: Object.freeze([]),

  resources: Object.freeze({
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


function fail(message, code) {
  throw Object.assign(
    new Error(message),
    { code }
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
      'SNTSS_I2_STATE_INVALID'
    );
  }

  return value;
}


function clone(value) {
  return JSON.parse(
    JSON.stringify(value)
  );
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

  const allowed = new Set([
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
    !HASH.test(input.identitySha256) ||
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
    typeof input.kernelVersion !== 'string' ||
    !input.kernelVersion
  ) {
    fail(
      'persisted binding kernel version is invalid',
      'SNTSS_BINDING_INVALID'
    );
  }

  if (
    typeof input.bindingEventId !== 'string' ||
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

  const allowed = new Set([
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
    !HASH.test(payload.identitySha256) ||
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
    ) !== payload.authorityEpoch
  ) {
    fail(
      'organism binding is not Kernel-authoritative',
      'SNTSS_BINDING_AUTHORITY'
    );
  }

  if (
    typeof payload.kernelVersion !== 'string' ||
    !payload.kernelVersion
  ) {
    fail(
      'organism binding kernel version is invalid',
      'SNTSS_BINDING_INVALID'
    );
  }

  return {
    ...payload,
    bindingEventId: String(event.id)
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


function createState(version) {
  return {
    formatVersion: 1,
    stateSchema: 2,
    protocol: 'stay-sntss-v1',
    coreVersion: version,
    stage: 'i2-internal-chemistry',

    organismBinding: null,

    chemistry:
      createChemicalState(),

    trustedTime:
      emptyTrustedTime(),

    migrations: []
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


function normalizeState(
  input,
  version
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

  const allowed = new Set([
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
    of Object.keys(source)
  ) {
    if (!allowed.has(key)) {
      fail(
        `I2 state field is not allowed: ${key}`,
        'SNTSS_I2_STATE_INVALID'
      );
    }
  }

  if (
    source.formatVersion !== 1 ||
    source.stateSchema !== 2 ||
    source.protocol !==
      'stay-sntss-v1' ||
    source.stage !==
      'i2-internal-chemistry'
  ) {
    fail(
      'I2 state header is invalid',
      'SNTSS_I2_STATE_INVALID'
    );
  }

  const binding =
    normalizePersistedBinding(
      source.organismBinding
    );

  validateChemicalState(
    source.chemistry
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
      'I2 migration history is invalid',
      'SNTSS_I2_STATE_INVALID'
    );
  }

  const normalized =
    clone(source);

  normalized.coreVersion =
    version;

  normalized.organismBinding =
    binding;

  return normalized;
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

  const allowed = new Set([
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
    ) !== pulse.runtimeRevision
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
    source.stage !== 'neutral'
  ) {
    fail(
      'neutral migration source header is invalid',
      'SNTSS_MIGRATION_INVALID'
    );
  }

  if (
    !source.transmitters ||
    Array.isArray(source.transmitters) ||
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
    Array.isArray(source.receptors) ||
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
    createState(manifest.version);

  next.organismBinding =
    normalizePersistedBinding(
      source.organismBinding
    );

  const history =
    Array.isArray(source.migrations)
      ? source.migrations
          .map(String)
          .slice(-63)
      : [];

  next.migrations = [
    ...history,
    'schema-1->2:i2-internal-chemistry'
  ];

  return next;
}


async function createCore({
  manifest: activeManifest = manifest,
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
       * Time may exist before organism binding,
       * but chemistry may not.
       */
      if (
        !state.organismBinding
      ) {
        return;
      }

      const time =
        state.trustedTime;

      /*
       * A newly-attached or migrated Core may first
       * observe any positive Kernel sequence.
       * That first event establishes its clock anchor.
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
        pulse.runtimeRevision <
        time.lastRuntimeRevision
      ) {
        fail(
          'runtime revision rewound',
          'SNTSS_TIME_REVISION_REWIND'
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
       * Chemistry advances only across a fully
       * trusted interval. A degraded/uncertain
       * interval is deliberately not caught up later.
       */
      if (
        previousStatus === 'trusted' &&
        pulse.clockStatus === 'trusted'
      ) {
        const elapsedMs =
          pulse.wallClockMs -
          previousWallClock;

        const result =
          advanceChemicalState(
            state.chemistry,
            elapsedMs,
            {}
          );

        state.chemistry =
          result.state;

        integrated =
          result.transition.steps > 0;
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
      const time =
        state.trustedTime;

      return {
        ok: true,

        stage:
          'i2-internal-chemistry',

        bound:
          Boolean(
            state.organismBinding
          ),

        chemistryActive:
          Boolean(
            state.organismBinding &&
            time.integratedIntervals > 0
          ),

        chemistryInternalOnly:
          true,

        chemicalModelClock:
          state.chemistry.modelClock,

        chemicalRemainderMs:
          state.chemistry.remainderMs,

        trustedPulseSequence:
          time.lastPulseSequence,

        clockStatus:
          time.lastClockStatus,

        activeFamilies:
          ACTIVE_FAMILIES.length,

        dormantFamilies:
          DORMANT_FAMILIES.length,

        biologicalOutputs:
          0,

        productionEligible:
          false,

        declaredOutputs:
          0
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
    to === 2
  ) {
    return migrateNeutralState(
      state
    );
  }

  if (
    from === 2 &&
    to === 2
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
  normalizeState,
  normalizePulse
};
