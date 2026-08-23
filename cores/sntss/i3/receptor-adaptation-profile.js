'use strict';

/*
 * STAY / SNTSS I3-B
 *
 * Synthetic receptor adaptation profile.
 *
 * Fast desensitization and slower tolerance are
 * separate state processes. Neither grants any
 * behavioural or Event Fabric authority.
 */

const crypto =
  require('node:crypto');

const {
  stableStringify
} = require(
  '../../../runtime/kernel/canonical-json'
);

const fp =
  require('../i2/fixed-point');

const {
  speciesProfile
} = require(
  '../i2/species-profile'
);

const {
  receptorProfile
} = require(
  './receptor-profile'
);


const CLASS_KEYS =
  Object.freeze([
    'desensitizationBuildAlpha',
    'desensitizationRetention',
    'exposureBuildAlpha',
    'exposureRetention',
    'maxDesensitization',
    'maxTolerance',
    'minimumSensitivity',
    'toleranceBuildAlpha',
    'toleranceRetention'
  ]);


const CLASSES =
  Object.freeze({

    fast: Object.freeze({
      exposureBuildAlpha: 120000,
      exposureRetention: 920000,

      desensitizationBuildAlpha: 85000,
      desensitizationRetention: 950000,

      toleranceBuildAlpha: 12000,
      toleranceRetention: 995000,

      maxDesensitization: 380000,
      maxTolerance: 300000,

      minimumSensitivity: 320000
    }),

    balanced: Object.freeze({
      exposureBuildAlpha: 90000,
      exposureRetention: 950000,

      desensitizationBuildAlpha: 55000,
      desensitizationRetention: 970000,

      toleranceBuildAlpha: 8000,
      toleranceRetention: 996000,

      maxDesensitization: 330000,
      maxTolerance: 300000,

      minimumSensitivity: 350000
    }),

    slow: Object.freeze({
      exposureBuildAlpha: 65000,
      exposureRetention: 970000,

      desensitizationBuildAlpha: 35000,
      desensitizationRetention: 980000,

      toleranceBuildAlpha: 6000,
      toleranceRetention: 997000,

      maxDesensitization: 280000,
      maxTolerance: 330000,

      minimumSensitivity: 390000
    })
  });


const CLASS_BY_RECEPTOR =
  Object.freeze({
    'ach-nicotinic-like': 'fast',
    'ach-muscarinic-like': 'slow',

    'dopamine-d1-like': 'balanced',
    'dopamine-d2-like': 'fast',

    'gaba-a-like': 'fast',
    'gaba-b-like': 'slow',

    'glutamate-ampa-like': 'fast',
    'glutamate-nmda-like': 'slow',

    'noradrenaline-alpha2-like': 'fast',
    'noradrenaline-beta-like': 'balanced',

    'serotonin-5ht1-like': 'balanced',
    'serotonin-5ht2-like': 'slow'
  });


function fail(
  message,
  code = 'SNTSS_I3_ADAPTATION_PROFILE'
) {
  throw Object.assign(
    new Error(message),
    { code }
  );
}


function hash(value) {
  return (
    'sha256:' +
    crypto
      .createHash('sha256')
      .update(
        stableStringify(value)
      )
      .digest('hex')
  );
}


function deepFreeze(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.isFrozen(value)
  ) {
    return value;
  }

  for (
    const child
    of Object.values(value)
  ) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}


function bounded(
  value,
  label,
  minimum = 0,
  maximum = fp.SCALE
) {
  const result =
    fp.integer(
      value,
      label
    );

  if (
    result < minimum ||
    result > maximum
  ) {
    fail(
      `${label} is outside bounds`
    );
  }

  return result;
}


function validateClass(
  input,
  label
) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  ) {
    fail(
      `${label} is invalid`
    );
  }

  const actual =
    Object.keys(input).sort();

  const expected =
    [...CLASS_KEYS].sort();

  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) =>
        key !== expected[index]
    )
  ) {
    fail(
      `${label} fields changed`
    );
  }

  const result = {};

  for (
    const key
    of CLASS_KEYS
  ) {
    result[key] =
      bounded(
        input[key],
        `${label}.${key}`
      );
  }

  if (
    result.minimumSensitivity < 1
  ) {
    fail(
      `${label} permits zero receptor sensitivity`
    );
  }

  if (
    result.maxDesensitization +
      result.maxTolerance >
    fp.SCALE
  ) {
    fail(
      `${label} adaptation exceeds complete sensitivity`
    );
  }

  return result;
}


const receptorIds =
  receptorProfile
    .receptors
    .map(
      receptor =>
        receptor.receptorId
    )
    .sort();


const mappedIds =
  Object.keys(
    CLASS_BY_RECEPTOR
  ).sort();


if (
  stableStringify(
    receptorIds
  ) !==
  stableStringify(
    mappedIds
  )
) {
  fail(
    'adaptation mapping does not exactly match I3-A receptor inventory',
    'SNTSS_I3_ADAPTATION_INVENTORY'
  );
}


const receptors =
  Object.fromEntries(
    receptorIds.map(
      receptorId => {
        const adaptationClass =
          CLASS_BY_RECEPTOR[
            receptorId
          ];

        const parameters =
          validateClass(
            CLASSES[
              adaptationClass
            ],
            `class ${adaptationClass}`
          );

        return [
          receptorId,
          deepFreeze({
            receptorId,
            adaptationClass,
            ...parameters
          })
        ];
      }
    )
  );


const body = {
  formatVersion: 1,

  profileId:
    'stay-genesis-sntss-receptor-adaptation',

  stage:
    'i3b-receptor-adaptation',

  receptorProfileHash:
    receptorProfile.profileHash,

  quantumMs:
    speciesProfile.integrationQuantumMs,

  productionEligible:
    false,

  outputAuthority:
    false,

  receptors
};


const adaptationProfile =
  deepFreeze({
    ...body,

    profileHash:
      hash(body)
  });


function validateAdaptationProfile(
  input
) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  ) {
    fail(
      'adaptation profile is invalid'
    );
  }

  if (
    input.formatVersion !== 1 ||
    input.profileId !==
      body.profileId ||
    input.stage !==
      'i3b-receptor-adaptation'
  ) {
    fail(
      'adaptation profile header changed'
    );
  }

  if (
    input.receptorProfileHash !==
      receptorProfile.profileHash
  ) {
    fail(
      'I3-A receptor profile binding changed',
      'SNTSS_I3_ADAPTATION_BINDING'
    );
  }

  if (
    input.quantumMs !==
      speciesProfile.integrationQuantumMs
  ) {
    fail(
      'adaptation time quantum changed',
      'SNTSS_I3_ADAPTATION_TIME'
    );
  }

  if (
    input.productionEligible !== false ||
    input.outputAuthority !== false
  ) {
    fail(
      'adaptation profile crossed observation boundary',
      'SNTSS_I3_OUTPUT_AUTHORITY'
    );
  }

  const ids =
    Object.keys(
      input.receptors || {}
    ).sort();

  if (
    stableStringify(ids) !==
    stableStringify(receptorIds)
  ) {
    fail(
      'adaptation receptor inventory changed',
      'SNTSS_I3_ADAPTATION_INVENTORY'
    );
  }

  for (
    const receptorId
    of receptorIds
  ) {
    const record =
      input.receptors[
        receptorId
      ];

    if (
      record.receptorId !==
        receptorId ||
      record.adaptationClass !==
        CLASS_BY_RECEPTOR[
          receptorId
        ]
    ) {
      fail(
        `adaptation identity changed: ${receptorId}`
      );
    }

    validateClass(
      Object.fromEntries(
        CLASS_KEYS.map(
          key => [
            key,
            record[key]
          ]
        )
      ),
      receptorId
    );
  }

  const {
    profileHash,
    ...profileBody
  } = input;

  if (
    profileHash !==
      hash(profileBody)
  ) {
    fail(
      'adaptation profile hash mismatch',
      'SNTSS_I3_ADAPTATION_HASH'
    );
  }

  /*
   * A valid recomputed hash proves consistency,
   * not authorization to redefine physiology.
   *
   * I3-B freezes the complete receptor adaptation
   * parameter set against the canonical profile.
   */
  if (
    stableStringify(
      input.receptors
    ) !==
    stableStringify(
      adaptationProfile.receptors
    )
  ) {
    fail(
      'adaptation parameters differ from frozen canonical set',
      'SNTSS_I3_ADAPTATION_FROZEN'
    );
  }

  return input;
}


module.exports = {
  adaptationProfile,
  validateAdaptationProfile,
  hash
};
