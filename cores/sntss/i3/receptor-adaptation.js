'use strict';

/*
 * STAY / SNTSS I3-B
 *
 * Persistent receptor adaptation state:
 *
 *   exposure        fast recent receptor stimulation
 *   desensitization faster response attenuation
 *   tolerance       slower accumulated attenuation
 *
 * All timing is derived from I2 chemical modelClock.
 * No wall clock is accepted here.
 */

const fp =
  require('../i2/fixed-point');

const {
  receptorProfile
} = require(
  './receptor-profile'
);

const {
  adaptationProfile,
  validateAdaptationProfile
} = require(
  './receptor-adaptation-profile'
);


const FORMAT =
  'stay-sntss-i3b-receptor-adaptation-v1';


const RECEPTOR_STATE_KEYS =
  Object.freeze([
    'desensitization',
    'exposure',
    'tolerance'
  ]);


function fail(
  message,
  code = 'SNTSS_I3_ADAPTATION_STATE'
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


function bounded(
  value,
  label
) {
  const result =
    fp.integer(
      value,
      label
    );

  if (
    result < 0 ||
    result > fp.SCALE
  ) {
    fail(
      `${label} is outside fixed-point range`
    );
  }

  return result;
}


function receptorIds() {
  return receptorProfile
    .receptors
    .map(
      receptor =>
        receptor.receptorId
    )
    .sort();
}


function validateObservation(
  input
) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  ) {
    fail(
      'I3-A receptor observation is invalid',
      'SNTSS_I3_OBSERVATION_INVALID'
    );
  }

  if (
    input.format !==
      'stay-sntss-i3a-receptor-observation-v1' ||
    input.stage !==
      'i3a-receptor-observation'
  ) {
    fail(
      'unexpected receptor observation format',
      'SNTSS_I3_OBSERVATION_INVALID'
    );
  }

  if (
    input.receptorProfileHash !==
      receptorProfile.profileHash
  ) {
    fail(
      'receptor observation profile binding changed',
      'SNTSS_I3_OBSERVATION_BINDING'
    );
  }

  if (
    input.productionEligible !== false ||
    input.outputAuthority !== false
  ) {
    fail(
      'receptor observation claims authority',
      'SNTSS_I3_OUTPUT_AUTHORITY'
    );
  }

  if (
    !Number.isSafeInteger(
      input.modelClock
    ) ||
    input.modelClock < 0
  ) {
    fail(
      'receptor observation model clock is invalid',
      'SNTSS_I3_ADAPTATION_TIME'
    );
  }

  const expectedIds =
    receptorIds();

  const actualIds =
    Object.keys(
      input.receptors || {}
    ).sort();

  if (
    JSON.stringify(actualIds) !==
    JSON.stringify(expectedIds)
  ) {
    fail(
      'receptor observation inventory changed',
      'SNTSS_I3_ADAPTATION_INVENTORY'
    );
  }

  for (
    const profile
    of receptorProfile.receptors
  ) {
    const record =
      input.receptors[
        profile.receptorId
      ];

    if (
      record.receptorId !==
        profile.receptorId ||
      record.family !==
        profile.family ||
      record.authoritative !==
        false
    ) {
      fail(
        `receptor observation identity changed: ${profile.receptorId}`,
        'SNTSS_I3_OBSERVATION_INVALID'
      );
    }

    bounded(
      record.occupancy,
      `${profile.receptorId}.occupancy`
    );

    bounded(
      record.tonicOccupancy,
      `${profile.receptorId}.tonicOccupancy`
    );

    if (
      !Number.isSafeInteger(
        record.deltaOccupancy
      ) ||
      record.deltaOccupancy <
        fp.SIGNED_MIN ||
      record.deltaOccupancy >
        fp.SIGNED_MAX
    ) {
      fail(
        'receptor delta occupancy is invalid',
        'SNTSS_I3_OBSERVATION_INVALID'
      );
    }

    if (
      !Number.isSafeInteger(
        record.effect
      ) ||
      record.effect <
        fp.SIGNED_MIN ||
      record.effect >
        fp.SIGNED_MAX
    ) {
      fail(
        'receptor effect is invalid',
        'SNTSS_I3_OBSERVATION_INVALID'
      );
    }
  }

  return input;
}


function validateState(
  input
) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  ) {
    fail(
      'adaptation state is invalid'
    );
  }

  if (
    input.format !== FORMAT ||
    input.stage !==
      'i3b-receptor-adaptation'
  ) {
    fail(
      'adaptation state header changed'
    );
  }

  if (
    input.receptorProfileHash !==
      receptorProfile.profileHash ||
    input.adaptationProfileHash !==
      adaptationProfile.profileHash
  ) {
    fail(
      'adaptation state profile binding changed',
      'SNTSS_I3_ADAPTATION_BINDING'
    );
  }

  if (
    input.productionEligible !== false ||
    input.outputAuthority !== false
  ) {
    fail(
      'adaptation state claims authority',
      'SNTSS_I3_OUTPUT_AUTHORITY'
    );
  }

  if (
    !Number.isSafeInteger(
      input.modelClock
    ) ||
    input.modelClock < 0
  ) {
    fail(
      'adaptation model clock is invalid',
      'SNTSS_I3_ADAPTATION_TIME'
    );
  }

  const expectedIds =
    receptorIds();

  const actualIds =
    Object.keys(
      input.receptors || {}
    ).sort();

  if (
    JSON.stringify(actualIds) !==
    JSON.stringify(expectedIds)
  ) {
    fail(
      'adaptation state receptor inventory changed',
      'SNTSS_I3_ADAPTATION_INVENTORY'
    );
  }

  for (
    const receptorId
    of expectedIds
  ) {
    const state =
      input.receptors[
        receptorId
      ];

    const keys =
      Object.keys(
        state || {}
      ).sort();

    const expectedKeys =
      [...RECEPTOR_STATE_KEYS].sort();

    if (
      JSON.stringify(keys) !==
      JSON.stringify(expectedKeys)
    ) {
      fail(
        `adaptation state fields changed: ${receptorId}`
      );
    }

    for (
      const key
      of RECEPTOR_STATE_KEYS
    ) {
      bounded(
        state[key],
        `${receptorId}.${key}`
      );
    }

    const parameters =
      adaptationProfile
        .receptors[
          receptorId
        ];

    if (
      state.desensitization >
        parameters.maxDesensitization
    ) {
      fail(
        `desensitization exceeds frozen maximum: ${receptorId}`,
        'SNTSS_I3_ADAPTATION_STATE_BOUNDS'
      );
    }

    if (
      state.tolerance >
        parameters.maxTolerance
    ) {
      fail(
        `tolerance exceeds frozen maximum: ${receptorId}`,
        'SNTSS_I3_ADAPTATION_STATE_BOUNDS'
      );
    }

    if (
      state.desensitization +
        state.tolerance >
      fp.SCALE -
        parameters.minimumSensitivity
    ) {
      fail(
        `adaptation would cross receptor sensitivity floor: ${receptorId}`,
        'SNTSS_I3_ADAPTATION_STATE_BOUNDS'
      );
    }
  }

  return input;
}


function createReceptorAdaptationState(
  observation
) {
  validateAdaptationProfile(
    adaptationProfile
  );

  validateObservation(
    observation
  );

  const state = {
    format:
      FORMAT,

    stage:
      'i3b-receptor-adaptation',

    modelClock:
      observation.modelClock,

    receptorProfileHash:
      receptorProfile.profileHash,

    adaptationProfileHash:
      adaptationProfile.profileHash,

    productionEligible:
      false,

    outputAuthority:
      false,

    receptors:
      Object.fromEntries(
        receptorIds().map(
          receptorId => [
            receptorId,
            {
              exposure: 0,
              desensitization: 0,
              tolerance: 0
            }
          ]
        )
      )
  };

  validateState(state);

  return clone(state);
}


function approachAdaptive(
  value,
  target,
  buildAlpha,
  retention
) {
  const rate =
    target >= value
      ? buildAlpha
      : fp.SCALE -
        retention;

  return fp.clamp(
    value +
      fp.mul(
        target - value,
        rate
      )
  );
}


function sensitivityFor(
  state,
  parameters
) {
  return fp.clamp(
    fp.SCALE -
      state.desensitization -
      state.tolerance,

    parameters.minimumSensitivity,

    fp.SCALE
  );
}


function buildProbe(
  state,
  observation
) {
  validateState(state);
  validateObservation(observation);

  if (
    state.modelClock !==
      observation.modelClock
  ) {
    fail(
      'adaptation state and receptor observation clocks differ',
      'SNTSS_I3_ADAPTATION_TIME'
    );
  }

  const receptors = {};

  const familyEffects = {};


  for (
    const profile
    of receptorProfile.receptors
  ) {
    const receptorId =
      profile.receptorId;

    const memory =
      state.receptors[
        receptorId
      ];

    const parameters =
      adaptationProfile
        .receptors[
          receptorId
        ];

    const raw =
      observation
        .receptors[
          receptorId
        ];

    const sensitivity =
      sensitivityFor(
        memory,
        parameters
      );

    const adaptedEffect =
      fp.clamp(
        fp.mul(
          raw.effect,
          sensitivity
        ),
        fp.SIGNED_MIN,
        fp.SIGNED_MAX
      );

    receptors[
      receptorId
    ] = {
      receptorId,

      family:
        profile.family,

      exposure:
        memory.exposure,

      desensitization:
        memory.desensitization,

      tolerance:
        memory.tolerance,

      sensitivity,

      rawEffect:
        raw.effect,

      adaptedEffect,

      authoritative:
        false
    };

    if (
      !familyEffects[
        profile.family
      ]
    ) {
      familyEffects[
        profile.family
      ] = [];
    }

    familyEffects[
      profile.family
    ].push(
      adaptedEffect
    );
  }


  const families =
    Object.fromEntries(
      Object.entries(
        familyEffects
      ).map(
        ([
          family,
          effects
        ]) => [
          family,
          {
            family,

            combinedAdaptedEffect:
              fp.saturatingCombine(
                effects
              ),

            authoritative:
              false
          }
        ]
      )
    );


  return clone({
    format:
      'stay-sntss-i3b-adapted-receptor-probe-v1',

    stage:
      'i3b-receptor-adaptation',

    modelClock:
      state.modelClock,

    productionEligible:
      false,

    outputAuthority:
      false,

    receptorProfileHash:
      receptorProfile.profileHash,

    adaptationProfileHash:
      adaptationProfile.profileHash,

    receptors,

    families
  });
}


function advanceReceptorAdaptation(
  inputState,
  observation
) {
  validateAdaptationProfile(
    adaptationProfile
  );

  validateState(
    inputState
  );

  validateObservation(
    observation
  );

  const elapsed =
    observation.modelClock -
    inputState.modelClock;

  if (
    elapsed !==
      adaptationProfile.quantumMs
  ) {
    fail(
      `receptor adaptation requires exactly ${adaptationProfile.quantumMs} ms of trusted chemical time`,
      'SNTSS_I3_ADAPTATION_TIME_STEP'
    );
  }

  const state =
    clone(
      inputState
    );


  for (
    const profile
    of receptorProfile.receptors
  ) {
    const receptorId =
      profile.receptorId;

    const raw =
      observation
        .receptors[
          receptorId
        ];

    const memory =
      state.receptors[
        receptorId
      ];

    const parameters =
      adaptationProfile
        .receptors[
          receptorId
        ];


    /*
     * Only occupancy above the receptor's own tonic
     * occupancy builds exposure.
     *
     * Below-tonic chemistry therefore permits recovery
     * rather than creating inverted "negative tolerance".
     */
    const stimulation =
      Math.max(
        0,
        raw.deltaOccupancy
      );


    const exposure =
      approachAdaptive(
        memory.exposure,
        stimulation,
        parameters.exposureBuildAlpha,
        parameters.exposureRetention
      );


    const desensitizationTarget =
      fp.mul(
        exposure,
        parameters.maxDesensitization
      );


    const toleranceTarget =
      fp.mul(
        exposure,
        parameters.maxTolerance
      );


    const desensitization =
      approachAdaptive(
        memory.desensitization,
        desensitizationTarget,
        parameters.desensitizationBuildAlpha,
        parameters.desensitizationRetention
      );


    const tolerance =
      approachAdaptive(
        memory.tolerance,
        toleranceTarget,
        parameters.toleranceBuildAlpha,
        parameters.toleranceRetention
      );


    state.receptors[
      receptorId
    ] = {
      exposure,
      desensitization,
      tolerance
    };
  }


  state.modelClock =
    observation.modelClock;


  validateState(state);


  return {
    state:
      clone(state),

    probe:
      buildProbe(
        state,
        observation
      )
  };
}


module.exports = {
  createReceptorAdaptationState,
  advanceReceptorAdaptation,
  buildProbe,
  validateState,
  validateObservation
};
