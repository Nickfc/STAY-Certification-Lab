'use strict';

/*
 * STAY / SNTSS I3-D1
 *
 * Persistent receptor availability state.
 *
 * Regulatory pressure from I3-D0 changes receptor
 * availability slowly across trusted biological
 * quanta.
 *
 * This state remains internal physiology.
 *
 * No Event Fabric outputs.
 * No behaviour authority.
 * No fetus authority.
 */

const fp =
  require('./fixed-point');

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
  evaluateRegulation,
  validateAdaptedProbe
} = require(
  './receptor-regulation'
);

const {
  availabilityProfile,
  validateAvailabilityProfile
} = require(
  './receptor-availability-profile'
);


const FORMAT =
  'stay-sntss-i3d1-receptor-availability-v1';


function fail(
  message,
  code =
    'SNTSS_I3D_AVAILABILITY_STATE'
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


function receptorIds() {
  return receptorProfile
    .receptors
    .map(
      receptor =>
        receptor.receptorId
    )
    .sort();
}


function validateAvailability(
  value,
  receptorId
) {
  fp.integer(
    value,
    `${receptorId}.availability`
  );

  if (
    value <
      availabilityProfile
        .minimumAvailability ||
    value >
      availabilityProfile
        .maximumAvailability
  ) {
    fail(
      `receptor availability is outside frozen bounds: ${receptorId}`,
      'SNTSS_I3D_AVAILABILITY_BOUNDS'
    );
  }

  return value;
}


function validateState(
  input
) {
  validateAvailabilityProfile(
    availabilityProfile
  );

  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  ) {
    fail(
      'availability state is invalid'
    );
  }

  const actualKeys =
    Object.keys(input).sort();

  const expectedKeys =
    [
      'adaptationProfileHash',
      'availabilityProfileHash',
      'behaviourAuthority',
      'format',
      'modelClock',
      'outputAuthority',
      'productionEligible',
      'receptorProfileHash',
      'receptors',
      'regulationProfileHash',
      'stage'
    ].sort();

  if (
    actualKeys.length !==
      expectedKeys.length ||
    actualKeys.some(
      (key, index) =>
        key !== expectedKeys[index]
    )
  ) {
    fail(
      'availability state fields changed'
    );
  }

  if (
    input.format !== FORMAT ||
    input.stage !==
      'i3d1-receptor-availability'
  ) {
    fail(
      'availability state header changed'
    );
  }

  if (
    input.receptorProfileHash !==
      receptorProfile.profileHash ||
    input.adaptationProfileHash !==
      adaptationProfile.profileHash ||
    input.regulationProfileHash !==
      regulationProfile.profileHash ||
    input.availabilityProfileHash !==
      availabilityProfile.profileHash
  ) {
    fail(
      'availability state profile binding changed',
      'SNTSS_I3D_AVAILABILITY_BINDING'
    );
  }

  if (
    input.productionEligible !==
      false ||
    input.outputAuthority !==
      false ||
    input.behaviourAuthority !==
      false
  ) {
    fail(
      'availability state claims authority',
      'SNTSS_I3D_OUTPUT_AUTHORITY'
    );
  }

  if (
    !Number.isSafeInteger(
      input.modelClock
    ) ||
    input.modelClock < 0
  ) {
    fail(
      'availability model clock is invalid',
      'SNTSS_I3D_AVAILABILITY_TIME'
    );
  }

  const expectedIds =
    receptorIds();

  const actualIds =
    Object.keys(
      input.receptors || {}
    ).sort();

  if (
    JSON.stringify(
      actualIds
    ) !==
      JSON.stringify(
        expectedIds
      )
  ) {
    fail(
      'availability receptor inventory changed',
      'SNTSS_I3D_REGULATION_INVENTORY'
    );
  }

  for (
    const receptorId
    of expectedIds
  ) {
    const record =
      input.receptors[
        receptorId
      ];

    if (
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      Object.keys(record).length !== 1 ||
      !Object.hasOwn(
        record,
        'availability'
      )
    ) {
      fail(
        `availability state fields changed: ${receptorId}`
      );
    }

    validateAvailability(
      record.availability,
      receptorId
    );
  }

  return input;
}


function createReceptorAvailabilityState(
  adaptedProbe
) {
  validateAdaptedProbe(
    adaptedProbe
  );

  const state = {
    format:
      FORMAT,

    stage:
      'i3d1-receptor-availability',

    modelClock:
      adaptedProbe.modelClock,

    receptorProfileHash:
      receptorProfile.profileHash,

    adaptationProfileHash:
      adaptationProfile.profileHash,

    regulationProfileHash:
      regulationProfile.profileHash,

    availabilityProfileHash:
      availabilityProfile.profileHash,

    productionEligible:
      false,

    outputAuthority:
      false,

    behaviourAuthority:
      false,

    receptors:
      Object.fromEntries(
        receptorIds().map(
          receptorId => [
            receptorId,
            {
              availability:
                availabilityProfile
                  .initialAvailability
            }
          ]
        )
      )
  };

  validateState(state);

  return clone(state);
}


function buildRegulatedProbe(
  state,
  adaptedProbe
) {
  validateState(state);
  validateAdaptedProbe(
    adaptedProbe
  );

  if (
    state.modelClock !==
      adaptedProbe.modelClock
  ) {
    fail(
      'availability state and adapted receptor probe clocks differ',
      'SNTSS_I3D_AVAILABILITY_TIME'
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

    const adapted =
      adaptedProbe
        .receptors[
          receptorId
        ];

    const availability =
      state.receptors[
        receptorId
      ].availability;

    const regulatedSensitivity =
      fp.clamp(
        fp.mul(
          adapted.sensitivity,
          availability
        ),
        0,
        fp.SCALE
      );

    const regulatedEffect =
      fp.clamp(
        fp.mul(
          adapted.adaptedEffect,
          availability
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

      availability,

      adaptedSensitivity:
        adapted.sensitivity,

      regulatedSensitivity,

      adaptedEffect:
        adapted.adaptedEffect,

      regulatedEffect,

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
      regulatedEffect
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

            combinedRegulatedEffect:
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
      'stay-sntss-i3d1-regulated-receptor-probe-v1',

    stage:
      'i3d1-receptor-availability',

    modelClock:
      state.modelClock,

    receptorProfileHash:
      receptorProfile.profileHash,

    adaptationProfileHash:
      adaptationProfile.profileHash,

    regulationProfileHash:
      regulationProfile.profileHash,

    availabilityProfileHash:
      availabilityProfile.profileHash,

    productionEligible:
      false,

    outputAuthority:
      false,

    behaviourAuthority:
      false,

    authoritative:
      false,

    receptors,

    families
  });
}


function advanceReceptorAvailability(
  inputState,
  adaptedProbe
) {
  validateState(
    inputState
  );

  validateAdaptedProbe(
    adaptedProbe
  );

  const elapsed =
    adaptedProbe.modelClock -
    inputState.modelClock;

  if (
    elapsed !==
      availabilityProfile.quantumMs
  ) {
    fail(
      `receptor availability requires exactly ${availabilityProfile.quantumMs} ms of trusted biological time`,
      'SNTSS_I3D_AVAILABILITY_TIME_STEP'
    );
  }

  const pressure =
    evaluateRegulation(
      adaptedProbe
    );

  const state =
    clone(
      inputState
    );

  for (
    const receptorId
    of receptorIds()
  ) {
    const current =
      state.receptors[
        receptorId
      ].availability;

    const bias =
      pressure.receptors[
        receptorId
      ].netRegulatoryBias;

    let next =
      current;

    if (bias < 0) {
      const availableRange =
        current -
        availabilityProfile
          .minimumAvailability;

      const pressureMagnitude =
        Math.abs(bias);

      const step =
        fp.mul(
          fp.mul(
            availableRange,
            pressureMagnitude
          ),

          availabilityProfile
            .downregulationRate
        );

      next =
        current -
        step;
    } else if (bias > 0) {
      const recoveryRange =
        availabilityProfile
          .maximumAvailability -
        current;

      const step =
        fp.mul(
          fp.mul(
            recoveryRange,
            bias
          ),

          availabilityProfile
            .upregulationRate
        );

      next =
        current +
        step;
    }

    state.receptors[
      receptorId
    ].availability =
      fp.clamp(
        next,

        availabilityProfile
          .minimumAvailability,

        availabilityProfile
          .maximumAvailability
      );
  }

  state.modelClock =
    adaptedProbe.modelClock;

  validateState(state);

  return {
    state:
      clone(state),

    pressure:
      clone(pressure),

    probe:
      buildRegulatedProbe(
        state,
        adaptedProbe
      )
  };
}


module.exports = {
  createReceptorAvailabilityState,
  advanceReceptorAvailability,
  buildRegulatedProbe,
  validateState
};
