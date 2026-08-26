'use strict';

/*
 * STAY / SNTSS I3-D0
 *
 * Synthetic receptor regulation profile.
 *
 * This stage defines regulatory PRESSURES only.
 *
 * It does not:
 *   - mutate receptor state
 *   - alter I3-C physiology
 *   - emit Event Fabric output
 *   - grant behaviour authority
 *   - grant fetus authority
 *   - grant production eligibility
 *
 * Cross-modulation is explicitly synthetic.
 * It is not represented as a claim about
 * mammalian receptor biology.
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
  receptorProfile
} = require(
  './receptor-profile'
);

const {
  adaptationProfile
} = require(
  './receptor-adaptation-profile'
);


const POLARITIES =
  Object.freeze([
    'sensitize',
    'inhibit'
  ]);


const HOMEOSTASIS_KEYS =
  Object.freeze([
    'desensitizationWeight',
    'exposureWeight',
    'recoveryGain',
    'toleranceWeight'
  ]);


const HOMEOSTASIS =
  Object.freeze({
    /*
     * Exposure contributes modestly to pressure
     * for reduced future availability.
     */
    exposureWeight:
      350000,

    /*
     * Existing fast adaptation contributes more
     * strongly.
     */
    desensitizationWeight:
      750000,

    /*
     * Long-lived tolerance contributes most
     * strongly.
     */
    toleranceWeight:
      1000000,

    /*
     * When stimulation falls while adaptation
     * burden remains, recovery pressure grows.
     */
    recoveryGain:
      850000
  });


/*
 * Conservative synthetic compensation graph.
 *
 * Paired receptor classes create compensatory
 * sensitization pressure on their sibling.
 *
 * Glutamate-like activity creates compensatory
 * sensitization pressure on inhibitory receptors.
 *
 * GABA-like activity creates inhibitory regulatory
 * pressure on excitatory glutamate-like receptors.
 *
 * These are regulatory pressure relationships,
 * not direct chemical drives or behavioural rules.
 */
const SOURCE_EDGES =
  Object.freeze([

    Object.freeze({
      edgeId:
        'ach-nicotinic->ach-muscarinic',

      sourceReceptorId:
        'ach-nicotinic-like',

      targetReceptorId:
        'ach-muscarinic-like',

      polarity:
        'sensitize',

      gain: 100000
    }),

    Object.freeze({
      edgeId:
        'ach-muscarinic->ach-nicotinic',

      sourceReceptorId:
        'ach-muscarinic-like',

      targetReceptorId:
        'ach-nicotinic-like',

      polarity:
        'sensitize',

      gain: 100000
    }),


    Object.freeze({
      edgeId:
        'dopamine-d1->dopamine-d2',

      sourceReceptorId:
        'dopamine-d1-like',

      targetReceptorId:
        'dopamine-d2-like',

      polarity:
        'sensitize',

      gain: 140000
    }),

    Object.freeze({
      edgeId:
        'dopamine-d2->dopamine-d1',

      sourceReceptorId:
        'dopamine-d2-like',

      targetReceptorId:
        'dopamine-d1-like',

      polarity:
        'sensitize',

      gain: 140000
    }),


    Object.freeze({
      edgeId:
        'noradrenaline-alpha2->noradrenaline-beta',

      sourceReceptorId:
        'noradrenaline-alpha2-like',

      targetReceptorId:
        'noradrenaline-beta-like',

      polarity:
        'sensitize',

      gain: 120000
    }),

    Object.freeze({
      edgeId:
        'noradrenaline-beta->noradrenaline-alpha2',

      sourceReceptorId:
        'noradrenaline-beta-like',

      targetReceptorId:
        'noradrenaline-alpha2-like',

      polarity:
        'sensitize',

      gain: 120000
    }),


    Object.freeze({
      edgeId:
        'serotonin-5ht1->serotonin-5ht2',

      sourceReceptorId:
        'serotonin-5ht1-like',

      targetReceptorId:
        'serotonin-5ht2-like',

      polarity:
        'sensitize',

      gain: 120000
    }),

    Object.freeze({
      edgeId:
        'serotonin-5ht2->serotonin-5ht1',

      sourceReceptorId:
        'serotonin-5ht2-like',

      targetReceptorId:
        'serotonin-5ht1-like',

      polarity:
        'sensitize',

      gain: 120000
    }),


    Object.freeze({
      edgeId:
        'glutamate-ampa->gaba-a',

      sourceReceptorId:
        'glutamate-ampa-like',

      targetReceptorId:
        'gaba-a-like',

      polarity:
        'sensitize',

      gain: 220000
    }),

    Object.freeze({
      edgeId:
        'glutamate-nmda->gaba-b',

      sourceReceptorId:
        'glutamate-nmda-like',

      targetReceptorId:
        'gaba-b-like',

      polarity:
        'sensitize',

      gain: 180000
    }),


    Object.freeze({
      edgeId:
        'gaba-a->glutamate-ampa',

      sourceReceptorId:
        'gaba-a-like',

      targetReceptorId:
        'glutamate-ampa-like',

      polarity:
        'inhibit',

      gain: 300000
    }),

    Object.freeze({
      edgeId:
        'gaba-b->glutamate-nmda',

      sourceReceptorId:
        'gaba-b-like',

      targetReceptorId:
        'glutamate-nmda-like',

      polarity:
        'inhibit',

      gain: 240000
    })
  ]);


const EDGE_KEYS =
  Object.freeze([
    'edgeId',
    'gain',
    'polarity',
    'sourceReceptorId',
    'targetReceptorId'
  ]);


function fail(
  message,
  code =
    'SNTSS_I3D_REGULATION_PROFILE'
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
      `${label} must be an object`
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
      `${label} fields changed`
    );
  }
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


function validateHomeostasis(
  input
) {
  exactKeys(
    input,
    HOMEOSTASIS_KEYS,
    'homeostasis'
  );

  for (
    const key
    of HOMEOSTASIS_KEYS
  ) {
    bounded(
      input[key],
      `homeostasis.${key}`
    );
  }

  return input;
}


const receptorIds =
  receptorProfile
    .receptors
    .map(
      receptor =>
        receptor.receptorId
    )
    .sort();


function validateEdgeBody(
  input
) {
  exactKeys(
    input,
    EDGE_KEYS,
    'regulation edge'
  );

  if (
    typeof input.edgeId !==
      'string' ||
    !input.edgeId
  ) {
    fail(
      'regulation edge id is invalid'
    );
  }

  if (
    !receptorIds.includes(
      input.sourceReceptorId
    ) ||
    !receptorIds.includes(
      input.targetReceptorId
    )
  ) {
    fail(
      'regulation edge references unknown receptor',
      'SNTSS_I3D_REGULATION_INVENTORY'
    );
  }

  if (
    input.sourceReceptorId ===
      input.targetReceptorId
  ) {
    fail(
      'cross-modulation edge cannot target itself'
    );
  }

  if (
    !POLARITIES.includes(
      input.polarity
    )
  ) {
    fail(
      'regulation edge polarity is invalid'
    );
  }

  bounded(
    input.gain,
    'regulation edge gain',
    1,
    fp.SCALE
  );

  return input;
}


function sealEdge(
  source
) {
  const body = {
    ...validateEdgeBody(
      source
    )
  };

  return deepFreeze({
    ...body,

    edgeHash:
      hash(body)
  });
}


const edges =
  SOURCE_EDGES
    .map(sealEdge)
    .sort(
      (left, right) =>
        left.edgeId.localeCompare(
          right.edgeId
        )
    );


if (
  new Set(
    edges.map(
      edge =>
        edge.edgeId
    )
  ).size !==
  edges.length
) {
  fail(
    'duplicate regulation edge id'
  );
}


const body = {
  formatVersion: 1,

  profileId:
    'stay-genesis-sntss-receptor-regulation',

  stage:
    'i3d0-regulatory-pressure',

  receptorProfileHash:
    receptorProfile.profileHash,

  adaptationProfileHash:
    adaptationProfile.profileHash,

  productionEligible:
    false,

  outputAuthority:
    false,

  behaviourAuthority:
    false,

  persistentState:
    false,

  mode:
    'synthetic-pressure-only',

  homeostasis:
    HOMEOSTASIS,

  edges
};


const regulationProfile =
  deepFreeze({
    ...body,

    profileHash:
      hash(body)
  });


function validateRegulationProfile(
  input
) {
  exactKeys(
    input,
    [
      ...Object.keys(body),
      'profileHash'
    ],
    'regulation profile'
  );

  if (
    input.formatVersion !== 1 ||
    input.profileId !==
      body.profileId ||
    input.stage !==
      body.stage ||
    input.mode !==
      body.mode
  ) {
    fail(
      'regulation profile header changed'
    );
  }

  if (
    input.receptorProfileHash !==
      receptorProfile.profileHash ||
    input.adaptationProfileHash !==
      adaptationProfile.profileHash
  ) {
    fail(
      'regulation profile binding changed',
      'SNTSS_I3D_REGULATION_BINDING'
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
      false
  ) {
    fail(
      'regulation profile crossed authority boundary',
      'SNTSS_I3D_OUTPUT_AUTHORITY'
    );
  }

  validateHomeostasis(
    input.homeostasis
  );

  if (
    !Array.isArray(
      input.edges
    )
  ) {
    fail(
      'regulation edges must be an array'
    );
  }

  const seen =
    new Set();

  for (
    const sealed
    of input.edges
  ) {
    exactKeys(
      sealed,
      [
        ...EDGE_KEYS,
        'edgeHash'
      ],
      'sealed regulation edge'
    );

    const {
      edgeHash,
      ...edgeBody
    } = sealed;

    validateEdgeBody(
      edgeBody
    );

    if (
      edgeHash !==
        hash(edgeBody)
    ) {
      fail(
        `regulation edge hash mismatch: ${sealed.edgeId}`,
        'SNTSS_I3D_REGULATION_HASH'
      );
    }

    if (
      seen.has(
        sealed.edgeId
      )
    ) {
      fail(
        'duplicate regulation edge id'
      );
    }

    seen.add(
      sealed.edgeId
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
      'regulation profile hash mismatch',
      'SNTSS_I3D_REGULATION_HASH'
    );
  }

  /*
   * Re-signing modified physiology is not enough.
   * The complete canonical regulation profile is
   * frozen for this stage.
   */
  if (
    stableStringify(
      input.homeostasis
    ) !==
      stableStringify(
        regulationProfile
          .homeostasis
      ) ||
    stableStringify(
      input.edges
    ) !==
      stableStringify(
        regulationProfile.edges
      )
  ) {
    fail(
      'regulation physiology differs from frozen canonical profile',
      'SNTSS_I3D_REGULATION_FROZEN'
    );
  }

  return input;
}


module.exports = {
  regulationProfile,
  validateRegulationProfile,
  hash
};
