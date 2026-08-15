'use strict';

const { stableStringify } = require('../../../runtime/kernel/canonical-json');
const fp = require('./fixed-point');
const { ACTIVE_FAMILIES, DORMANT_FAMILIES, hash } = require('./species-profile');

const PERMITTED_FUNCTIONS = Object.freeze([
  'action-vigor', 'association-readiness', 'attention-gain', 'encoding-gain',
  'inhibition', 'interrupt-sensitivity', 'learning-sensitivity', 'persistence'
]);
const PROFILE_KEYS = Object.freeze(['consumerCoreId', 'frameValidityMs', 'holdMs', 'migration', 'productionEligible', 'profileVersion', 'queueCapacity', 'receptors', 'revision', 'stage', 'wildcardAllowed']);
const RECEPTOR_KEYS = Object.freeze([
  'affinity', 'analogue', 'densityAdaptationRate', 'densityBirth', 'desensitizationStrength',
  'efficacy', 'exposureAlpha', 'exposureRetention', 'fallback', 'family', 'hill', 'permittedFunction',
  'polarity', 'recoveryRate', 'receptorId', 'receptorVersion', 'sensitivityBirth'
]);

function fail(message, code = 'SNTSS_RECEPTOR_PROFILE_INVALID') { throw Object.assign(new Error(message), { code }); }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} fields do not match the frozen schema`);
}
function scaled(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > fp.SCALE) fail(`${label} is outside fixed-point bounds`);
  return value;
}
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function receptor(receptorId, family, analogue, permittedFunction, overrides = {}) {
  return {
    receptorVersion: 1, receptorId, family, analogue,
    affinity: overrides.affinity ?? 420000, hill: overrides.hill ?? 2,
    polarity: overrides.polarity ?? 1, efficacy: overrides.efficacy ?? 180000,
    densityBirth: overrides.densityBirth ?? 1000000, sensitivityBirth: overrides.sensitivityBirth ?? 1000000,
    exposureAlpha: overrides.exposureAlpha ?? 18000, exposureRetention: overrides.exposureRetention ?? 999200,
    desensitizationStrength: overrides.desensitizationStrength ?? 500000,
    recoveryRate: overrides.recoveryRate ?? 12000, densityAdaptationRate: overrides.densityAdaptationRate ?? 500,
    permittedFunction, fallback: 0
  };
}

function profile(consumerCoreId, receptors) {
  const body = {
    profileVersion: 1, consumerCoreId, revision: 1, stage: 'laboratory-r6-probe', productionEligible: false,
    wildcardAllowed: false, frameValidityMs: 1250, holdMs: 250, queueCapacity: 8,
    migration: { compatibleFrom: [], removalMode: 'dormant-preserve-history', rollbackMode: 'restore-history' },
    receptors
  };
  return { ...body, profileHash: hash(body) };
}

const profiles = {
  'receptor-probe-alpha': profile('receptor-probe-alpha', [
    receptor('probe.alpha.encoding.dopamine.v1', 'dopamine-like', 'D1-like synthetic', 'encoding-gain', { affinity: 420000, efficacy: 180000 }),
    receptor('probe.alpha.attention.acetylcholine.v1', 'acetylcholine-like', 'nicotinic-like synthetic', 'attention-gain', { affinity: 360000, efficacy: 160000 }),
    receptor('probe.alpha.interrupt.noradrenaline.v1', 'noradrenaline-like', 'adrenergic-like synthetic', 'interrupt-sensitivity', { affinity: 340000, efficacy: 140000 })
  ]),
  'receptor-probe-beta': profile('receptor-probe-beta', [
    receptor('probe.beta.inhibition.gaba.v1', 'gaba-like', 'GABA-A-like synthetic', 'inhibition', { affinity: 340000, efficacy: 170000 }),
    receptor('probe.beta.association.glutamate.v1', 'glutamate-like', 'NMDA-like synthetic', 'association-readiness', { affinity: 350000, efficacy: 150000 }),
    receptor('probe.beta.persistence.serotonin.v1', 'serotonin-like', '5-HT-like synthetic', 'persistence', { affinity: 430000, efficacy: 120000 })
  ])
};

function validateReceptorProfile(input) {
  exactKeys(input, [...PROFILE_KEYS, 'profileHash'], 'receptor profile');
  if (input.profileVersion !== 1 || input.revision !== 1 || input.stage !== 'laboratory-r6-probe' || input.productionEligible !== false || input.wildcardAllowed !== false) fail('receptor profile crosses the laboratory boundary');
  if (typeof input.consumerCoreId !== 'string' || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(input.consumerCoreId) || input.consumerCoreId.includes('*')) fail('consumer identity is invalid', 'SNTSS_RECEPTOR_WILDCARD');
  for (const [field, minimum, maximum] of [['frameValidityMs', 250, 5000], ['holdMs', 0, 1250], ['queueCapacity', 1, 32]]) {
    if (!Number.isSafeInteger(input[field]) || input[field] < minimum || input[field] > maximum) fail(`${field} is invalid`);
  }
  exactKeys(input.migration, ['compatibleFrom', 'removalMode', 'rollbackMode'], 'receptor migration');
  if (!Array.isArray(input.migration.compatibleFrom) || input.migration.removalMode !== 'dormant-preserve-history' || input.migration.rollbackMode !== 'restore-history') fail('receptor migration rule is unsafe');
  if (!Array.isArray(input.receptors) || input.receptors.length < 1 || input.receptors.length > 32) fail('receptor inventory is invalid');
  const ids = new Set();
  for (const current of input.receptors) {
    exactKeys(current, RECEPTOR_KEYS, `receptor ${current?.receptorId || 'unknown'}`);
    if (current.receptorVersion !== 1 || typeof current.receptorId !== 'string' || !/^[a-z0-9.-]{3,128}$/.test(current.receptorId) || ids.has(current.receptorId)) fail('receptor identity is invalid');
    ids.add(current.receptorId);
    if (!ACTIVE_FAMILIES.includes(current.family) || DORMANT_FAMILIES.includes(current.family)) fail('receptor family is dormant or unknown', 'SNTSS_FAMILY_DORMANT');
    if (typeof current.analogue !== 'string' || !current.analogue || !PERMITTED_FUNCTIONS.includes(current.permittedFunction)) fail('receptor semantics are invalid');
    if (![1, -1].includes(current.polarity) || !Number.isSafeInteger(current.hill) || current.hill < 1 || current.hill > 4) fail('receptor binding rule is invalid');
    for (const key of ['affinity', 'densityBirth', 'sensitivityBirth', 'exposureAlpha', 'exposureRetention', 'desensitizationStrength', 'recoveryRate', 'densityAdaptationRate']) scaled(current[key], key);
    if (current.affinity === 0 || current.densityBirth === 0 || current.sensitivityBirth === 0 || current.efficacy < 0 || current.efficacy > 250000 || current.fallback !== 0) fail('receptor efficacy or fallback is unsafe', 'SNTSS_RECEPTOR_EFFICACY');
  }
  const { profileHash, ...body } = input;
  if (profileHash !== hash(body)) fail('receptor profile hash mismatch', 'SNTSS_PROFILE_HASH_MISMATCH');
  const canonical = profiles[input.consumerCoreId];
  if (!canonical || stableStringify(input) !== stableStringify(canonical)) fail('profile is not in the static R6 registry', 'SNTSS_RECEPTOR_DYNAMIC_PROFILE');
  return input;
}

const receptorProfiles = deepFreeze(Object.fromEntries(Object.keys(profiles).sort().map(key => [key, profiles[key]])));
for (const current of Object.values(receptorProfiles)) validateReceptorProfile(current);
const registryBody = { registryVersion: 1, stage: 'laboratory-r6', productionConsumersEnabled: false, profiles: receptorProfiles };
const receptorProfileRegistry = deepFreeze({ ...registryBody, registryHash: hash(registryBody) });

function validateReceptorProfileRegistry(input) {
  exactKeys(input, ['productionConsumersEnabled', 'profiles', 'registryHash', 'registryVersion', 'stage'], 'receptor profile registry');
  if (input.registryVersion !== 1 || input.stage !== 'laboratory-r6' || input.productionConsumersEnabled !== false) fail('receptor registry crosses the laboratory boundary');
  exactKeys(input.profiles, Object.keys(receptorProfiles), 'receptor profile inventory');
  for (const current of Object.values(input.profiles)) validateReceptorProfile(current);
  const { registryHash, ...body } = input;
  if (registryHash !== hash(body) || stableStringify(input) !== stableStringify(receptorProfileRegistry)) fail('receptor registry hash or content mismatch', 'SNTSS_PROFILE_HASH_MISMATCH');
  return input;
}
validateReceptorProfileRegistry(receptorProfileRegistry);

module.exports = { PERMITTED_FUNCTIONS, receptorProfileRegistry, validateReceptorProfile, validateReceptorProfileRegistry, hash };
