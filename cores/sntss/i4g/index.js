'use strict';

/*
 * STAY / SNTSS I4-G1
 *
 * Durable continuity-genesis shadow Core.
 *
 * Owns:
 *   - synthetic transmitter chemistry
 *   - receptor adaptation memory
 *   - regulatory pressure
 *   - receptor availability memory
 *   - one organism-bound individuality record over preserved prenatal physiology
 *
 * Boundaries:
 *   - zero Event Fabric outputs
 *   - zero behaviour authority
 *   - zero fetus authority
 *   - production ineligible
 */

const {
  VERSION,
  STAGE,
  createState,
  normalizeState,
  migrateLegacyState,
  advanceRegulatedPhysiology
} = require(
  './durable-state'
);


const {
  establishContinuityGenesis
} = require(
  './individuality'
);


const i3cState =
  require(
    './i3c-state'
  );


const {
  ACTIVE_FAMILIES,
  DORMANT_FAMILIES
} = require(
  './chemical-state'
);


const {
  receptorProfile
} = require(
  './receptor-profile'
);


const {
  adaptationProfile
} = require(
  './receptor-adaptation-profile'
);


const {
  regulationProfile
} = require(
  './regulation-profile'
);


const {
  availabilityProfile
} = require(
  './receptor-availability-profile'
);


const HASH =
  /^sha256:[0-9a-f]{64}$/;


const manifest =
  Object.freeze({
    coreId:
      'sntss',

    version:
      VERSION,

    protocol:
      'stay-sntss-v1',

    stateSchema:
      5,

    hotSwap:
      true,

    priority:
      'optional',

    stage:
      STAGE,

    productionEligible:
      false,

    inputs:
      Object.freeze([
        'runtime.organism.binding',
        'runtime.sntss.continuity-genesis',
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


function integer(
  value,
  label,
  minimum = 0
) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    fail(
      `invalid ${label}`,
      'SNTSS_I3D_STATE_INVALID'
    );
  }

  return value;
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

  state.acceptedPulses +=
    1;
}


async function createCore({
  manifest:
    activeManifest = manifest,

  initialState
}) {
  let state =
    normalizeState(
      initialState,
      activeManifest.version
    );


  return {
    async start() {
      state =
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
        event.topic ===
          'runtime.sntss.continuity-genesis'
      ) {
        state =
          establishContinuityGenesis(
            state,
            event
          );

        return;
      }


      if (
        event.topic !==
          'runtime.time.pulse'
      ) {
        return;
      }


      const pulse =
        i3cState.normalizePulse(
          event
        );


      if (
        !state.organismBinding
      ) {
        return;
      }


      const time =
        state.trustedTime;


      /*
       * First pulse anchors only.
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
       * New Kernel runtime:
       * new trusted anchor, zero downtime biology.
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

      let integrated =
        false;


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
          advanceRegulatedPhysiology(
            state,
            elapsedMs
          );


        state =
          result.state;


        integrated =
          result.transition.steps >
          0;
      }


      acceptPulse(
        state.trustedTime,
        pulse
      );


      if (integrated) {
        state.trustedTime
          .integratedIntervals +=
          1;
      }
    },


    async snapshot() {
      return normalizeState(
        state,
        activeManifest.version
      );
    },


    async health() {
      const adaptationMemories =
        Object.values(
          state
            .receptorAdaptation
            .receptors
        );


      const receptorMemoryActive =
        adaptationMemories.some(
          memory =>
            memory.exposure > 0 ||
            memory.desensitization > 0 ||
            memory.tolerance > 0
        );


      const availabilityMemories =
        Object.values(
          state
            .receptorAvailability
            .receptors
        );


      const availabilityMemoryActive =
        availabilityMemories.some(
          memory =>
            memory.availability !==
              availabilityProfile
                .initialAvailability
        );


      return {
        ok: true,

        stage:
          STAGE,

        bound:
          Boolean(
            state.organismBinding
          ),

        chemistryInternalOnly:
          true,

        receptorPhysiologyInternalOnly:
          true,

        receptorRegulationInternalOnly:
          true,

        continuityGenesisEstablished:
          Boolean(
            state.individuality
          ),

        lineageSha256:
          state.individuality
            ?.lineageSha256 ||
          null,

        prenatalModelClock:
          state.individuality
            ?.prenatalModelClock ??
          null,

        chemicalModelClock:
          state.chemistry
            .modelClock,

        receptorModelClock:
          state.receptorAdaptation
            .modelClock,

        receptorAvailabilityModelClock:
          state.receptorAvailability
            .modelClock,

        chemicalRemainderMs:
          state.chemistry
            .remainderMs,

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

        availabilityMemoryActive,

        receptorProfileHash:
          receptorProfile.profileHash,

        adaptationProfileHash:
          adaptationProfile.profileHash,

        regulationProfileHash:
          regulationProfile.profileHash,

        availabilityProfileHash:
          availabilityProfile.profileHash,

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
    to !== 5
  ) {
    fail(
      `unsupported SNTSS migration ${from}->${to}`,
      'SNTSS_MIGRATION_UNSUPPORTED'
    );
  }


  if (from === 5) {
    return normalizeState(
      state,
      manifest.version
    );
  }


  if (from >= 1 && from <= 4) {
    return migrateLegacyState(
      state,
      from,
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
  advanceRegulatedPhysiology,
  VERSION
};
