'use strict';

/*
 * STAY / SNTSS I3-D0
 *
 * Pure receptor regulatory-pressure engine.
 *
 * Input:
 *   frozen I3-B adapted receptor probe
 *
 * Output:
 *   observation-only regulatory pressure
 *
 * This engine does NOT mutate receptor physiology.
 * Durable regulation state comes in a later I3-D
 * stage after these pressure semantics are frozen.
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
  regulationProfile,
  validateRegulationProfile
} = require(
  './regulation-profile'
);


const PROBE_RECEPTOR_KEYS =
  Object.freeze([
    'adaptedEffect',
    'authoritative',
    'desensitization',
    'exposure',
    'family',
    'rawEffect',
    'receptorId',
    'sensitivity',
    'tolerance'
  ]);


function fail(
  message,
  code =
    'SNTSS_I3D_REGULATION'
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


function exactKeys(
  input,
  expected,
  label
) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  ) {
    fail(
      `${label} must be an object`,
      'SNTSS_I3D_PROBE_INVALID'
    );
  }

  const actual =
    Object.keys(input).sort();

  const wanted =
    [...expected].sort();

  if (
    actual.length !==
      wanted.length ||
    actual.some(
      (key, index) =>
        key !== wanted[index]
    )
  ) {
    fail(
      `${label} fields changed`,
      'SNTSS_I3D_PROBE_INVALID'
    );
  }
}


function unsigned(
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
      `${label} is outside bounds`,
      'SNTSS_I3D_PROBE_INVALID'
    );
  }

  return result;
}


function signed(
  value,
  label
) {
  const result =
    fp.integer(
      value,
      label
    );

  if (
    result < fp.SIGNED_MIN ||
    result > fp.SIGNED_MAX
  ) {
    fail(
      `${label} is outside signed bounds`,
      'SNTSS_I3D_PROBE_INVALID'
    );
  }

  return result;
}


function combineUnsigned(
  values
) {
  return fp.clamp(
    fp.saturatingCombine(
      values.map(
        value =>
          fp.clamp(
            value,
            0,
            fp.SCALE
          )
      )
    ),
    0,
    fp.SCALE
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


function validateAdaptedProbe(
  input
) {
  exactKeys(
    input,
    [
      'adaptationProfileHash',
      'families',
      'format',
      'modelClock',
      'outputAuthority',
      'productionEligible',
      'receptorProfileHash',
      'receptors',
      'stage'
    ],
    'adapted receptor probe'
  );

  if (
    input.format !==
      'stay-sntss-i3b-adapted-receptor-probe-v1' ||
    input.stage !==
      'i3b-receptor-adaptation'
  ) {
    fail(
      'unexpected adapted receptor probe format',
      'SNTSS_I3D_PROBE_INVALID'
    );
  }

  if (
    input.receptorProfileHash !==
      receptorProfile.profileHash ||
    input.adaptationProfileHash !==
      adaptationProfile.profileHash
  ) {
    fail(
      'adapted receptor probe binding changed',
      'SNTSS_I3D_PROBE_BINDING'
    );
  }

  if (
    input.productionEligible !==
      false ||
    input.outputAuthority !==
      false
  ) {
    fail(
      'adapted receptor probe claims authority',
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
      'adapted receptor probe clock is invalid',
      'SNTSS_I3D_PROBE_INVALID'
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
      'adapted receptor inventory changed',
      'SNTSS_I3D_REGULATION_INVENTORY'
    );
  }

  const familyEffects = {};

  for (
    const profile
    of receptorProfile.receptors
  ) {
    const record =
      input.receptors[
        profile.receptorId
      ];

    exactKeys(
      record,
      PROBE_RECEPTOR_KEYS,
      `adapted receptor ${profile.receptorId}`
    );

    if (
      record.receptorId !==
        profile.receptorId ||
      record.family !==
        profile.family ||
      record.authoritative !==
        false
    ) {
      fail(
        `adapted receptor identity changed: ${profile.receptorId}`,
        'SNTSS_I3D_PROBE_INVALID'
      );
    }

    unsigned(
      record.exposure,
      `${profile.receptorId}.exposure`
    );

    unsigned(
      record.desensitization,
      `${profile.receptorId}.desensitization`
    );

    unsigned(
      record.tolerance,
      `${profile.receptorId}.tolerance`
    );

    unsigned(
      record.sensitivity,
      `${profile.receptorId}.sensitivity`
    );

    signed(
      record.rawEffect,
      `${profile.receptorId}.rawEffect`
    );

    signed(
      record.adaptedEffect,
      `${profile.receptorId}.adaptedEffect`
    );

    const parameters =
      adaptationProfile
        .receptors[
          profile.receptorId
        ];

    const expectedSensitivity =
      fp.clamp(
        fp.SCALE -
          record.desensitization -
          record.tolerance,

        parameters
          .minimumSensitivity,

        fp.SCALE
      );

    if (
      record.sensitivity !==
        expectedSensitivity
    ) {
      fail(
        `adapted receptor sensitivity is inconsistent: ${profile.receptorId}`,
        'SNTSS_I3D_PROBE_INVALID'
      );
    }

    const expectedEffect =
      fp.clamp(
        fp.mul(
          record.rawEffect,
          record.sensitivity
        ),
        fp.SIGNED_MIN,
        fp.SIGNED_MAX
      );

    if (
      record.adaptedEffect !==
        expectedEffect
    ) {
      fail(
        `adapted receptor effect is inconsistent: ${profile.receptorId}`,
        'SNTSS_I3D_PROBE_INVALID'
      );
    }

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
      record.adaptedEffect
    );
  }


  const expectedFamilies =
    [...receptorProfile.activeFamilies]
      .sort();

  const actualFamilies =
    Object.keys(
      input.families || {}
    ).sort();

  if (
    JSON.stringify(
      actualFamilies
    ) !==
      JSON.stringify(
        expectedFamilies
      )
  ) {
    fail(
      'adapted family inventory changed',
      'SNTSS_I3D_REGULATION_INVENTORY'
    );
  }


  for (
    const family
    of expectedFamilies
  ) {
    const record =
      input.families[
        family
      ];

    exactKeys(
      record,
      [
        'authoritative',
        'combinedAdaptedEffect',
        'family'
      ],
      `adapted family ${family}`
    );

    if (
      record.family !== family ||
      record.authoritative !==
        false
    ) {
      fail(
        `adapted family identity changed: ${family}`,
        'SNTSS_I3D_PROBE_INVALID'
      );
    }

    const expected =
      fp.saturatingCombine(
        familyEffects[
          family
        ] || []
      );

    if (
      record.combinedAdaptedEffect !==
        expected
    ) {
      fail(
        `adapted family effect is inconsistent: ${family}`,
        'SNTSS_I3D_PROBE_INVALID'
      );
    }
  }

  return input;
}


function activityMagnitude(
  receptor
) {
  return fp.clamp(
    Math.abs(
      receptor.adaptedEffect
    ),
    0,
    fp.SCALE
  );
}


function evaluateRegulation(
  inputProbe
) {
  validateRegulationProfile(
    regulationProfile
  );

  validateAdaptedProbe(
    inputProbe
  );


  const receptorOutput = {};


  for (
    const profile
    of receptorProfile.receptors
  ) {
    const receptorId =
      profile.receptorId;

    const current =
      inputProbe
        .receptors[
          receptorId
        ];

    const h =
      regulationProfile
        .homeostasis;


    const exposurePressure =
      fp.mul(
        current.exposure,
        h.exposureWeight
      );

    const desensitizationPressure =
      fp.mul(
        current.desensitization,
        h.desensitizationWeight
      );

    const tolerancePressure =
      fp.mul(
        current.tolerance,
        h.toleranceWeight
      );


    const availabilityReductionPressure =
      combineUnsigned([
        exposurePressure,
        desensitizationPressure,
        tolerancePressure
      ]);


    const adaptationBurden =
      combineUnsigned([
        current.desensitization,
        current.tolerance
      ]);


    const quietOpportunity =
      fp.SCALE -
      current.exposure;


    const availabilityRecoveryPressure =
      fp.mul(
        fp.mul(
          adaptationBurden,
          quietOpportunity
        ),
        h.recoveryGain
      );


    const incoming =
      regulationProfile
        .edges
        .filter(
          edge =>
            edge.targetReceptorId ===
              receptorId
        )
        .map(
          edge => {
            const source =
              inputProbe
                .receptors[
                  edge.sourceReceptorId
                ];

            const sourceActivity =
              activityMagnitude(
                source
              );

            const contribution =
              fp.mul(
                sourceActivity,
                edge.gain
              );

            return {
              edgeId:
                edge.edgeId,

              sourceReceptorId:
                edge.sourceReceptorId,

              targetReceptorId:
                edge.targetReceptorId,

              polarity:
                edge.polarity,

              gain:
                edge.gain,

              sourceActivity,

              contribution,

              authoritative:
                false
            };
          }
        )
        .sort(
          (left, right) =>
            left.edgeId.localeCompare(
              right.edgeId
            )
        );


    const sensitizationContributions =
      incoming
        .filter(
          edge =>
            edge.polarity ===
              'sensitize'
        )
        .map(
          edge =>
            edge.contribution
        );


    const inhibitionContributions =
      incoming
        .filter(
          edge =>
            edge.polarity ===
              'inhibit'
        )
        .map(
          edge =>
            edge.contribution
        );


    const crossSensitizationPressure =
      combineUnsigned(
        sensitizationContributions
      );


    const crossInhibitionPressure =
      combineUnsigned(
        inhibitionContributions
      );


    const netCrossModulation =
      fp.saturatingCombine([
        ...sensitizationContributions,

        ...inhibitionContributions
          .map(
            value =>
              -value
          )
      ]);


    const netRegulatoryBias =
      fp.saturatingCombine([
        availabilityRecoveryPressure,
        crossSensitizationPressure,
        -availabilityReductionPressure,
        -crossInhibitionPressure
      ]);


    receptorOutput[
      receptorId
    ] = {
      receptorId,

      family:
        profile.family,

      activityMagnitude:
        activityMagnitude(
          current
        ),

      exposure:
        current.exposure,

      desensitization:
        current.desensitization,

      tolerance:
        current.tolerance,

      sensitivity:
        current.sensitivity,

      availabilityReductionPressure,

      availabilityRecoveryPressure,

      crossSensitizationPressure,

      crossInhibitionPressure,

      netCrossModulation,

      netRegulatoryBias,

      incoming,

      authoritative:
        false
    };
  }


  const families = {};


  for (
    const family
    of receptorProfile.activeFamilies
  ) {
    const members =
      receptorProfile
        .receptors
        .filter(
          receptor =>
            receptor.family ===
              family
        )
        .map(
          receptor =>
            receptorOutput[
              receptor.receptorId
            ]
        );


    families[
      family
    ] = {
      family,

      combinedRegulatoryBias:
        fp.saturatingCombine(
          members.map(
            receptor =>
              receptor
                .netRegulatoryBias
          )
        ),

      authoritative:
        false
    };
  }


  return clone({
    format:
      'stay-sntss-i3d0-regulatory-pressure-v1',

    stage:
      'i3d0-regulatory-pressure',

    modelClock:
      inputProbe.modelClock,

    receptorProfileHash:
      receptorProfile.profileHash,

    adaptationProfileHash:
      adaptationProfile.profileHash,

    regulationProfileHash:
      regulationProfile.profileHash,

    productionEligible:
      false,

    outputAuthority:
      false,

    behaviourAuthority:
      false,

    persistentState:
      false,

    authoritative:
      false,

    receptors:
      receptorOutput,

    families
  });
}


module.exports = {
  evaluateRegulation,
  validateAdaptedProbe,
  activityMagnitude,
  combineUnsigned
};
