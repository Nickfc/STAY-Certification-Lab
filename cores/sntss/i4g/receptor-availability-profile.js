'use strict';

/*
 * STAY / SNTSS I3-D1
 *
 * Persistent synthetic receptor availability.
 *
 * Availability represents the fraction of the
 * receptor system currently available relative
 * to its synthetic birth baseline.
 *
 * Range:
 *
 *   1.000000 = full baseline availability
 *   0.450000 = frozen minimum availability
 *
 * This stage does NOT permit super-baseline
 * receptor proliferation. Positive regulation
 * restores availability toward baseline.
 *
 * No behaviour, fetus or Event Fabric authority.
 */

const crypto =
  require('node:crypto');

const {
  stableStringify
} = require(
  '../../../runtime/kernel/canonical-json'
);

const fp =
  require('./fixed-point');

const {
  QUANTUM_MS
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


function fail(
  message,
  code =
    'SNTSS_I3D_AVAILABILITY_PROFILE'
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


const body = {
  formatVersion: 1,

  profileId:
    'stay-genesis-sntss-receptor-availability',

  stage:
    'i3d1-receptor-availability',

  receptorProfileHash:
    receptorProfile.profileHash,

  adaptationProfileHash:
    adaptationProfile.profileHash,

  regulationProfileHash:
    regulationProfile.profileHash,

  quantumMs:
    QUANTUM_MS,

  initialAvailability:
    fp.SCALE,

  minimumAvailability:
    450000,

  maximumAvailability:
    fp.SCALE,

  /*
   * Rate multipliers are applied once per trusted
   * 250 ms biological quantum.
   *
   * These intentionally make availability slower
   * than fast receptor desensitization.
   */
  downregulationRate:
    4000,

  upregulationRate:
    2500,

  productionEligible:
    false,

  outputAuthority:
    false,

  behaviourAuthority:
    false,

  persistentState:
    true
};


const availabilityProfile =
  deepFreeze({
    ...body,

    profileHash:
      hash(body)
  });


function validateAvailabilityProfile(
  input
) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  ) {
    fail(
      'availability profile is invalid'
    );
  }

  const actual =
    Object.keys(input).sort();

  const expected =
    [
      ...Object.keys(body),
      'profileHash'
    ].sort();

  if (
    actual.length !==
      expected.length ||
    actual.some(
      (key, index) =>
        key !== expected[index]
    )
  ) {
    fail(
      'availability profile fields changed'
    );
  }

  if (
    input.formatVersion !== 1 ||
    input.profileId !==
      body.profileId ||
    input.stage !==
      body.stage
  ) {
    fail(
      'availability profile header changed'
    );
  }

  if (
    input.receptorProfileHash !==
      receptorProfile.profileHash ||
    input.adaptationProfileHash !==
      adaptationProfile.profileHash ||
    input.regulationProfileHash !==
      regulationProfile.profileHash
  ) {
    fail(
      'availability profile binding changed',
      'SNTSS_I3D_AVAILABILITY_BINDING'
    );
  }

  if (
    input.quantumMs !==
      QUANTUM_MS
  ) {
    fail(
      'availability time quantum changed',
      'SNTSS_I3D_AVAILABILITY_TIME'
    );
  }

  for (
    const [
      label,
      value
    ]
    of [
      [
        'initialAvailability',
        input.initialAvailability
      ],
      [
        'minimumAvailability',
        input.minimumAvailability
      ],
      [
        'maximumAvailability',
        input.maximumAvailability
      ],
      [
        'downregulationRate',
        input.downregulationRate
      ],
      [
        'upregulationRate',
        input.upregulationRate
      ]
    ]
  ) {
    fp.integer(
      value,
      label
    );

    if (
      value < 0 ||
      value > fp.SCALE
    ) {
      fail(
        `${label} is outside bounds`
      );
    }
  }

  if (
    input.initialAvailability !==
      fp.SCALE ||
    input.maximumAvailability !==
      fp.SCALE ||
    input.minimumAvailability < 1 ||
    input.minimumAvailability >=
      input.maximumAvailability
  ) {
    fail(
      'availability range changed'
    );
  }

  if (
    input.downregulationRate < 1 ||
    input.upregulationRate < 1
  ) {
    fail(
      'availability kinetics are inert'
    );
  }

  if (
    input.productionEligible !==
      false ||
    input.outputAuthority !==
      false ||
    input.behaviourAuthority !==
      false ||
    input.persistentState !==
      true
  ) {
    fail(
      'availability profile crossed authority boundary',
      'SNTSS_I3D_OUTPUT_AUTHORITY'
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
      'availability profile hash mismatch',
      'SNTSS_I3D_AVAILABILITY_HASH'
    );
  }

  /*
   * A valid replacement hash is not permission to
   * redefine frozen availability physiology.
   */
  if (
    stableStringify(input) !==
      stableStringify(
        availabilityProfile
      )
  ) {
    fail(
      'availability physiology differs from frozen canonical profile',
      'SNTSS_I3D_AVAILABILITY_FROZEN'
    );
  }

  return input;
}


module.exports = {
  availabilityProfile,
  validateAvailabilityProfile,
  hash
};
