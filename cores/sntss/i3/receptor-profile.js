'use strict';

/*
 * STAY / SNTSS I3-A
 *
 * Immutable synthetic receptor definitions.
 *
 * Important boundary:
 *   - observation only
 *   - no Event Fabric output authority
 *   - no behaviour authority
 *   - no fetus authority
 *   - no production eligibility
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
  ACTIVE_FAMILIES,
  DORMANT_FAMILIES
} = require(
  '../i2/species-profile'
);


const PROFILE_VERSION = 1;

const PROFILE_ID =
  'stay-genesis-sntss-receptor-set';


const RECEPTOR_KEYS =
  Object.freeze([
    'affinity',
    'efficacy',
    'family',
    'hill',
    'mode',
    'productionOutputEnabled',
    'receptorId',
    'receptorVersion'
  ]);


const SOURCE_RECEPTORS =
  Object.freeze([

    /*
     * Acetylcholine-like family
     */
    Object.freeze({
      receptorVersion: 1,
      receptorId:
        'ach-nicotinic-like',
      family:
        'acetylcholine-like',
      affinity: 280000,
      hill: 2,
      efficacy: 820000,
      mode: 'observation-only',
      productionOutputEnabled: false
    }),

    Object.freeze({
      receptorVersion: 1,
      receptorId:
        'ach-muscarinic-like',
      family:
        'acetylcholine-like',
      affinity: 440000,
      hill: 1,
      efficacy: 480000,
      mode: 'observation-only',
      productionOutputEnabled: false
    }),


    /*
     * Dopamine-like family.
     *
     * Lower affinity number means occupancy rises
     * at lower concentration in this synthetic model.
     */
    Object.freeze({
      receptorVersion: 1,
      receptorId:
        'dopamine-d1-like',
      family:
        'dopamine-like',
      affinity: 430000,
      hill: 2,
      efficacy: 760000,
      mode: 'observation-only',
      productionOutputEnabled: false
    }),

    Object.freeze({
      receptorVersion: 1,
      receptorId:
        'dopamine-d2-like',
      family:
        'dopamine-like',
      affinity: 230000,
      hill: 2,
      efficacy: -640000,
      mode: 'observation-only',
      productionOutputEnabled: false
    }),


    /*
     * GABA-like family
     */
    Object.freeze({
      receptorVersion: 1,
      receptorId:
        'gaba-a-like',
      family:
        'gaba-like',
      affinity: 250000,
      hill: 2,
      efficacy: -900000,
      mode: 'observation-only',
      productionOutputEnabled: false
    }),

    Object.freeze({
      receptorVersion: 1,
      receptorId:
        'gaba-b-like',
      family:
        'gaba-like',
      affinity: 430000,
      hill: 1,
      efficacy: -600000,
      mode: 'observation-only',
      productionOutputEnabled: false
    }),


    /*
     * Glutamate-like family
     */
    Object.freeze({
      receptorVersion: 1,
      receptorId:
        'glutamate-ampa-like',
      family:
        'glutamate-like',
      affinity: 300000,
      hill: 2,
      efficacy: 900000,
      mode: 'observation-only',
      productionOutputEnabled: false
    }),

    Object.freeze({
      receptorVersion: 1,
      receptorId:
        'glutamate-nmda-like',
      family:
        'glutamate-like',
      affinity: 520000,
      hill: 2,
      efficacy: 650000,
      mode: 'observation-only',
      productionOutputEnabled: false
    }),


    /*
     * Noradrenaline-like family
     */
    Object.freeze({
      receptorVersion: 1,
      receptorId:
        'noradrenaline-alpha2-like',
      family:
        'noradrenaline-like',
      affinity: 220000,
      hill: 2,
      efficacy: -550000,
      mode: 'observation-only',
      productionOutputEnabled: false
    }),

    Object.freeze({
      receptorVersion: 1,
      receptorId:
        'noradrenaline-beta-like',
      family:
        'noradrenaline-like',
      affinity: 470000,
      hill: 2,
      efficacy: 660000,
      mode: 'observation-only',
      productionOutputEnabled: false
    }),


    /*
     * Serotonin-like family
     */
    Object.freeze({
      receptorVersion: 1,
      receptorId:
        'serotonin-5ht1-like',
      family:
        'serotonin-like',
      affinity: 270000,
      hill: 2,
      efficacy: -500000,
      mode: 'observation-only',
      productionOutputEnabled: false
    }),

    Object.freeze({
      receptorVersion: 1,
      receptorId:
        'serotonin-5ht2-like',
      family:
        'serotonin-like',
      affinity: 490000,
      hill: 2,
      efficacy: 560000,
      mode: 'observation-only',
      productionOutputEnabled: false
    })
  ]);


function fail(
  message,
  code = 'SNTSS_I3_RECEPTOR_PROFILE'
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


function exactKeys(
  value,
  expected,
  label
) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    fail(
      `${label} must be an object`
    );
  }

  const actual =
    Object.keys(value).sort();

  const wanted =
    [...expected].sort();

  if (
    actual.length !== wanted.length ||
    actual.some(
      (key, index) =>
        key !== wanted[index]
    )
  ) {
    fail(
      `${label} fields changed`
    );
  }
}


function validateReceptorBody(
  input
) {
  exactKeys(
    input,
    RECEPTOR_KEYS,
    'receptor'
  );

  if (
    input.receptorVersion !== 1
  ) {
    fail(
      'unsupported receptor version'
    );
  }

  if (
    typeof input.receptorId !==
      'string' ||
    !input.receptorId
  ) {
    fail(
      'receptor id is invalid'
    );
  }

  if (
    !ACTIVE_FAMILIES.includes(
      input.family
    )
  ) {
    fail(
      `receptor family is not active: ${input.family}`,
      'SNTSS_I3_RECEPTOR_FAMILY'
    );
  }

  if (
    input.mode !==
      'observation-only'
  ) {
    fail(
      'receptor attempts to gain runtime authority',
      'SNTSS_I3_OUTPUT_AUTHORITY'
    );
  }

  if (
    input.productionOutputEnabled !==
      false
  ) {
    fail(
      'receptor enables production output',
      'SNTSS_I3_OUTPUT_AUTHORITY'
    );
  }

  const affinity =
    fp.integer(
      input.affinity,
      'receptor affinity'
    );

  if (
    affinity < 1 ||
    affinity > fp.SCALE
  ) {
    fail(
      'receptor affinity is outside fixed-point range'
    );
  }

  const hill =
    fp.integer(
      input.hill,
      'receptor Hill coefficient'
    );

  if (
    hill < 1 ||
    hill > 4
  ) {
    fail(
      'receptor Hill coefficient must be 1..4'
    );
  }

  const efficacy =
    fp.integer(
      input.efficacy,
      'receptor efficacy'
    );

  if (
    efficacy < fp.SIGNED_MIN ||
    efficacy > fp.SIGNED_MAX
  ) {
    fail(
      'receptor efficacy is outside fixed-point range'
    );
  }

  return {
    ...input,
    affinity,
    hill,
    efficacy
  };
}


function sealReceptor(source) {
  const body =
    validateReceptorBody(
      source
    );

  return deepFreeze({
    ...body,

    profileHash:
      hash(body)
  });
}


const receptors =
  SOURCE_RECEPTORS
    .map(sealReceptor)
    .sort(
      (left, right) =>
        left.receptorId.localeCompare(
          right.receptorId
        )
    );


const ids =
  receptors.map(
    receptor =>
      receptor.receptorId
  );


if (
  new Set(ids).size !==
  ids.length
) {
  fail(
    'duplicate receptor id'
  );
}


for (
  const family
  of ACTIVE_FAMILIES
) {
  if (
    !receptors.some(
      receptor =>
        receptor.family === family
    )
  ) {
    fail(
      `active family has no receptor: ${family}`
    );
  }
}


for (
  const family
  of DORMANT_FAMILIES
) {
  if (
    receptors.some(
      receptor =>
        receptor.family === family
    )
  ) {
    fail(
      `dormant family acquired receptor: ${family}`,
      'SNTSS_I3_DORMANT_RECEPTOR'
    );
  }
}


const body = {
  profileVersion:
    PROFILE_VERSION,

  profileId:
    PROFILE_ID,

  stage:
    'i3a-receptor-observation',

  productionEligible:
    false,

  outputAuthority:
    false,

  activeFamilies:
    [...ACTIVE_FAMILIES],

  dormantFamilies:
    [...DORMANT_FAMILIES],

  receptors
};


const receptorProfile =
  deepFreeze({
    ...body,

    profileHash:
      hash(body)
  });


function validateReceptorProfile(
  input
) {
  exactKeys(
    input,
    [
      ...Object.keys(body),
      'profileHash'
    ],
    'receptor profile'
  );

  if (
    input.profileVersion !==
      PROFILE_VERSION ||
    input.profileId !==
      PROFILE_ID
  ) {
    fail(
      'unsupported receptor profile'
    );
  }

  if (
    input.stage !==
      'i3a-receptor-observation' ||
    input.productionEligible !==
      false ||
    input.outputAuthority !==
      false
  ) {
    fail(
      'receptor profile crossed observation boundary',
      'SNTSS_I3_OUTPUT_AUTHORITY'
    );
  }

  if (
    stableStringify(
      input.activeFamilies
    ) !==
    stableStringify(
      ACTIVE_FAMILIES
    ) ||
    stableStringify(
      input.dormantFamilies
    ) !==
    stableStringify(
      DORMANT_FAMILIES
    )
  ) {
    fail(
      'receptor family inventory changed'
    );
  }

  if (
    !Array.isArray(
      input.receptors
    )
  ) {
    fail(
      'receptors must be an array'
    );
  }

  const seen =
    new Set();

  for (
    const receptor
    of input.receptors
  ) {
    exactKeys(
      receptor,
      [
        ...RECEPTOR_KEYS,
        'profileHash'
      ],
      'sealed receptor'
    );

    const {
      profileHash,
      ...receptorBody
    } = receptor;

    if (
      profileHash !==
      hash(receptorBody)
    ) {
      fail(
        `receptor hash mismatch: ${receptor.receptorId}`,
        'SNTSS_I3_PROFILE_HASH'
      );
    }

    validateReceptorBody(
      receptorBody
    );

    if (
      seen.has(
        receptor.receptorId
      )
    ) {
      fail(
        'duplicate receptor id'
      );
    }

    seen.add(
      receptor.receptorId
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
      'receptor profile hash mismatch',
      'SNTSS_I3_PROFILE_HASH'
    );
  }

  /*
   * Hash validity proves internal consistency,
   * not authorization to redefine a receptor.
   *
   * I3-A freezes the complete canonical receptor set.
   */
  if (
    stableStringify(
      input.receptors
    ) !==
    stableStringify(
      receptorProfile.receptors
    )
  ) {
    fail(
      'receptor definitions differ from frozen canonical set',
      'SNTSS_I3_PROFILE_FROZEN'
    );
  }

  return input;
}


function receptorsForFamily(
  family
) {
  return receptorProfile
    .receptors
    .filter(
      receptor =>
        receptor.family === family
    );
}


module.exports = {
  receptorProfile,
  validateReceptorProfile,
  receptorsForFamily,
  hash
};
