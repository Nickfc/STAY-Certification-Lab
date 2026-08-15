'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../../../runtime/kernel/canonical-json');
const kinetics = require('./kinetics');
const sourceFamilies = require('./families');

const ACTIVE_FAMILIES = Object.freeze([
  'acetylcholine-like', 'dopamine-like', 'gaba-like',
  'glutamate-like', 'noradrenaline-like', 'serotonin-like'
]);
const DORMANT_FAMILIES = Object.freeze(['endogenous-opioid-like', 'oxytocin-like']);
const ALL_FAMILIES = Object.freeze([...ACTIVE_FAMILIES, ...DORMANT_FAMILIES].sort());
const FAMILY_KEYS = Object.freeze([
  'activation', 'birthState', 'explicitBoundary', 'family', 'kineticContractVersion',
  'kinetics', 'modeledRole', 'profileVersion', 'status'
]);
const ACTIVATION_KEYS = Object.freeze(['laboratoryDriveEnabled', 'productionActivationEnabled', 'productionProducerCount']);
const KINETIC_KEYS = Object.freeze([
  'affinity', 'concentrationRetention', 'exposureAlpha', 'exposureRetention', 'hill',
  'maxReleasePerStep', 'maxSuppressionPerStep', 'opponentBuildAlpha', 'opponentRetention',
  'precursorRecovery', 'refractoryCost', 'refractoryRecovery', 'refractoryRetention',
  'reserveRetention', 'synthCap', 'toleranceStrength'
]);
const INTERACTION_KEYS = Object.freeze([
  'gabaBrakeStrength', 'noradrenalineAttentionSupport', 'noradrenalineHighNarrowing',
  'noradrenalineModerateCeiling', 'serotoninDampingStrength', 'serotoninExtremeThreshold', 'version'
]);
const DORMANT_KINETICS = Object.freeze({
  synthCap: 0, precursorRecovery: 0, reserveRetention: 1000000,
  maxReleasePerStep: 0, maxSuppressionPerStep: 0, concentrationRetention: 1000000,
  exposureAlpha: 0, exposureRetention: 1000000, toleranceStrength: 0,
  opponentBuildAlpha: 0, opponentRetention: 1000000,
  refractoryRecovery: 0, refractoryRetention: 1000000, refractoryCost: 0,
  affinity: 1000000, hill: 1
});

function fail(message, code = 'SNTSS_SPECIES_PROFILE_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} fields do not match the frozen schema`);
  }
}

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isZeroState(state) { return kinetics.STATE_KEYS.every(key => state[key] === 0); }

function validateFamilyBody(input, expectedFamily) {
  exactKeys(input, FAMILY_KEYS, `family ${expectedFamily}`);
  if (input.profileVersion !== 1 || input.kineticContractVersion !== 1) fail(`family ${expectedFamily} version is unsupported`);
  if (input.family !== expectedFamily || !ALL_FAMILIES.includes(input.family)) fail(`family identity mismatch: ${expectedFamily}`);
  if (typeof input.modeledRole !== 'string' || !input.modeledRole || typeof input.explicitBoundary !== 'string' || !input.explicitBoundary) {
    fail(`family ${expectedFamily} semantics are incomplete`);
  }
  exactKeys(input.activation, ACTIVATION_KEYS, `family ${expectedFamily} activation`);
  exactKeys(input.kinetics, KINETIC_KEYS, `family ${expectedFamily} kinetics`);
  exactKeys(input.birthState, kinetics.STATE_KEYS, `family ${expectedFamily} birth state`);
  if (!Number.isSafeInteger(input.activation.productionProducerCount) || input.activation.productionProducerCount !== 0) {
    fail(`family ${expectedFamily} has a production producer`, 'SNTSS_PRODUCTION_ACTIVATION_BLOCKED');
  }
  if (input.activation.productionActivationEnabled !== false) fail(`family ${expectedFamily} enables production activation`, 'SNTSS_PRODUCTION_ACTIVATION_BLOCKED');
  const normalizedKinetics = kinetics.validateProfile(input.kinetics);
  const normalizedBirth = kinetics.validateState(input.birthState);
  const dormant = DORMANT_FAMILIES.includes(expectedFamily);
  if (dormant) {
    if (input.status !== 'dormant' || input.activation.laboratoryDriveEnabled !== false) fail(`dormant family ${expectedFamily} has an activation path`, 'SNTSS_FAMILY_DORMANT');
    if (stableStringify(normalizedKinetics) !== stableStringify(DORMANT_KINETICS) || !isZeroState(normalizedBirth)) {
      fail(`dormant family ${expectedFamily} can acquire chemistry`, 'SNTSS_FAMILY_DORMANT');
    }
  } else if (input.status !== 'active-shadow' || input.activation.laboratoryDriveEnabled !== true) {
    fail(`active family ${expectedFamily} is not laboratory-enabled`);
  } else if (normalizedKinetics.synthCap === 0 || normalizedKinetics.precursorRecovery === 0 || normalizedKinetics.maxReleasePerStep === 0) {
    fail(`active family ${expectedFamily} has an inert or partial kinetic profile`);
  }
  return { ...input, kinetics: normalizedKinetics, birthState: normalizedBirth };
}

function sealFamily(source, family) {
  const body = validateFamilyBody(source, family);
  return deepFreeze({ ...body, profileHash: hash(body) });
}

const sealedFamilies = Object.fromEntries(ALL_FAMILIES.map(family => [family, sealFamily(sourceFamilies[family], family)]));
const body = {
  profileVersion: 1,
  profileId: 'stay-genesis-sntss-family-set',
  revision: 1,
  kineticContractVersion: 1,
  fixedPointScale: 1000000,
  integrationQuantumMs: 250,
  stage: 'laboratory-r4',
  productionEligible: false,
  review: {
    status: 'candidate-awaiting-independent-review',
    approval: false,
    changeControl: 'profile-hash-invalidates-evidence'
  },
  activeFamilies: [...ACTIVE_FAMILIES],
  dormantFamilies: [...DORMANT_FAMILIES],
  families: sealedFamilies,
  interactionPolicy: {
    version: 1,
    gabaBrakeStrength: 1000000,
    noradrenalineModerateCeiling: 550000,
    noradrenalineAttentionSupport: 300000,
    noradrenalineHighNarrowing: 650000,
    serotoninExtremeThreshold: 600000,
    serotoninDampingStrength: 700000
  }
};
const speciesProfile = deepFreeze({ ...body, profileHash: hash(body) });

function validateSpeciesProfile(input) {
  exactKeys(input, [...Object.keys(body), 'profileHash'], 'species profile');
  if (input.profileVersion !== 1 || input.kineticContractVersion !== 1 || input.profileId !== body.profileId || input.revision !== 1) {
    fail('species profile header is unsupported');
  }
  if (input.fixedPointScale !== 1000000 || input.integrationQuantumMs !== 250) fail('species profile numerical contract changed');
  exactKeys(input.review, ['approval', 'changeControl', 'status'], 'species profile review');
  exactKeys(input.interactionPolicy, INTERACTION_KEYS, 'species interaction policy');
  if (stableStringify(input.review) !== stableStringify(body.review)
    || stableStringify(input.interactionPolicy) !== stableStringify(body.interactionPolicy)) {
    fail('species profile review or interaction policy does not match revision 1');
  }
  if (input.productionEligible !== false || input.stage !== 'laboratory-r4' || input.review?.approval !== false) {
    fail('species profile attempts to cross the laboratory boundary', 'SNTSS_PRODUCTION_ACTIVATION_BLOCKED');
  }
  if (stableStringify(input.activeFamilies) !== stableStringify(ACTIVE_FAMILIES)
    || stableStringify(input.dormantFamilies) !== stableStringify(DORMANT_FAMILIES)) fail('species family inventory changed');
  exactKeys(input.families, ALL_FAMILIES, 'species profile families');
  const families = {};
  for (const family of ALL_FAMILIES) {
    const candidate = input.families[family];
    exactKeys(candidate, [...FAMILY_KEYS, 'profileHash'], `sealed family ${family}`);
    const { profileHash, ...candidateBody } = candidate;
    if (profileHash !== hash(candidateBody)) fail(`family profile hash mismatch: ${family}`, 'SNTSS_PROFILE_HASH_MISMATCH');
    families[family] = { ...validateFamilyBody(candidateBody, family), profileHash };
  }
  const { profileHash, ...candidateBody } = input;
  if (profileHash !== hash(candidateBody)) fail('species profile hash mismatch', 'SNTSS_PROFILE_HASH_MISMATCH');
  return deepFreeze({ ...candidateBody, families, profileHash });
}

function createInitialModel(modelClock = 0) {
  if (!Number.isSafeInteger(modelClock) || modelClock < 0) fail('initial model clock is invalid');
  return {
    modelClock,
    remainderMs: 0,
    transmitters: Object.fromEntries(ALL_FAMILIES.map(family => [family, { ...speciesProfile.families[family].birthState }]))
  };
}

function kineticProfiles() {
  return Object.fromEntries(ALL_FAMILIES.map(family => [family, speciesProfile.families[family].kinetics]));
}

module.exports = {
  ACTIVE_FAMILIES, DORMANT_FAMILIES, ALL_FAMILIES, speciesProfile,
  validateSpeciesProfile, createInitialModel, kineticProfiles, hash
};
