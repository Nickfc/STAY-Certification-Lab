'use strict';

const { stableStringify } = require('../../../runtime/kernel/canonical-json');
const { validateLaboratoryModel, assertDormantState } = require('./validation');
const kinetics = require('./kinetics');
const { ALL_FAMILIES, speciesProfile, hash } = require('./species-profile');
const { validateReceptorState } = require('./receptors');

const HASH = /^sha256:[0-9a-f]{64}$/;
const STATE_KEYS = Object.freeze([
  'auditChainHead', 'circuitBreakers', 'clampCounters', 'developmentalClock', 'formatVersion',
  'habituation', 'inputCursor', 'leases', 'lineage', 'migrations', 'modelClock', 'organismBinding',
  'protocol', 'receptors', 'sourceHistory', 'speciesProfileHash', 'stateSchema', 'transmitters'
]);
const BINDING_KEYS = Object.freeze(['authorityEpoch', 'bindingEventId', 'bindingVersion', 'identitySha256', 'issuedAt', 'kernelVersion', 'organismLineage', 'runtimeRevision']);
const MODEL_CLOCK_KEYS = Object.freeze(['chemicalElapsedMs', 'lastTrustedWallClockMs', 'remainderMs']);
const DEVELOPMENT_CLOCK_KEYS = Object.freeze(['experienceMs', 'lastTrustedWallClockMs']);
const GENESIS_KEYS = Object.freeze(['birthStateHash', 'createdAt', 'genesisEventId', 'genesisSequence', 'laboratoryOrigin', 'lineage', 'neutralCheckpointHash', 'productionEligible', 'recordVersion', 'speciesProfileHash', 'topic']);
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_MAP_ENTRIES = 2048;

function fail(message, code = 'SNTSS_ACQUIRED_STATE_INVALID') { throw Object.assign(new Error(message), { code }); }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} fields are not canonical`);
}
function integer(value, label, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`); return value; }
function finiteMap(value, label, maximum = MAX_MAP_ENTRIES) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > maximum) fail(`${label} is invalid or oversized`);
  return value;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function validateBinding(binding) {
  exactKeys(binding, BINDING_KEYS, 'organism binding');
  if (binding.bindingVersion !== 1 || !HASH.test(binding.identitySha256) || binding.organismLineage !== 'STAY/Genesis') fail('organism binding identity is invalid', 'SNTSS_BINDING_MISMATCH');
  integer(binding.issuedAt, 'binding issue time'); integer(binding.runtimeRevision, 'binding runtime revision', 1); integer(binding.authorityEpoch, 'binding authority epoch', 1);
  if (typeof binding.kernelVersion !== 'string' || !binding.kernelVersion || typeof binding.bindingEventId !== 'string' || !binding.bindingEventId) fail('organism binding provenance is invalid');
  return binding;
}

function validateAcquiredState(state) {
  exactKeys(state, STATE_KEYS, 'acquired state');
  if (state.formatVersion !== 1 || state.stateSchema !== 2 || state.protocol !== 'stay-sntss-v1') fail('acquired state header is unsupported', 'SNTSS_STATE_SCHEMA_UNSUPPORTED');
  if (!HASH.test(state.lineage) || !HASH.test(state.speciesProfileHash) || state.speciesProfileHash !== speciesProfile.profileHash || !HASH.test(state.auditChainHead)) fail('state lineage, profile or audit binding is invalid', 'SNTSS_LINEAGE_MISMATCH');
  validateBinding(state.organismBinding);
  exactKeys(state.modelClock, MODEL_CLOCK_KEYS, 'chemical clock');
  integer(state.modelClock.chemicalElapsedMs, 'chemical elapsed time'); integer(state.modelClock.remainderMs, 'chemical remainder'); integer(state.modelClock.lastTrustedWallClockMs, 'chemical wall clock');
  if (state.modelClock.remainderMs >= 250) fail('chemical remainder is invalid');
  exactKeys(state.developmentalClock, DEVELOPMENT_CLOCK_KEYS, 'developmental clock');
  integer(state.developmentalClock.experienceMs, 'developmental experience'); integer(state.developmentalClock.lastTrustedWallClockMs, 'developmental wall clock');
  integer(state.inputCursor, 'input cursor');
  exactKeys(state.transmitters, ALL_FAMILIES, 'transmitter inventory');
  for (const family of ALL_FAMILIES) kinetics.validateState(state.transmitters[family]);
  validateReceptorState(state.receptors);
  if (state.receptors.lineage !== state.lineage || stableStringify(state.leases) !== stableStringify(state.receptors.leases)) fail('receptor lineage or lease projection is inconsistent', 'SNTSS_LINEAGE_MISMATCH');
  for (const [value, label] of [[state.sourceHistory, 'source history'], [state.habituation, 'habituation'], [state.leases, 'leases'], [state.circuitBreakers, 'circuit breakers'], [state.clampCounters, 'clamp counters']]) finiteMap(value, label);
  exactKeys(state.clampCounters, ALL_FAMILIES, 'clamp counters');
  for (const value of Object.values(state.clampCounters)) integer(value, 'clamp counter');
  exactKeys(state.sourceHistory.genesis, GENESIS_KEYS, 'genesis history');
  const genesis = state.sourceHistory.genesis;
  if (genesis.recordVersion !== 1 || genesis.topic !== 'SNTSS_GENESIS' || genesis.lineage !== state.lineage || genesis.speciesProfileHash !== state.speciesProfileHash || genesis.laboratoryOrigin !== true || genesis.productionEligible !== false || !HASH.test(genesis.neutralCheckpointHash) || !HASH.test(genesis.birthStateHash)) fail('genesis history is invalid', 'SNTSS_LINEAGE_MISMATCH');
  integer(genesis.createdAt, 'genesis time'); integer(genesis.genesisSequence, 'genesis sequence', 1);
  if (typeof genesis.genesisEventId !== 'string' || !genesis.genesisEventId || genesis.genesisSequence > state.inputCursor) fail('genesis event history is invalid');
  if (!Array.isArray(state.migrations) || state.migrations.length > 64) fail('migration history is invalid');
  const encoded = stableStringify(state);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_STATE_BYTES) fail('acquired state exceeds its canonical size limit', 'SNTSS_STATE_OVERSIZED');
  return state;
}

function stateHash(state) { validateAcquiredState(state); return hash(state); }

function createCheckpoint(state, committedAtMs) {
  validateAcquiredState(state); integer(committedAtMs, 'checkpoint commit time');
  const body = { checkpointVersion: 1, committedAtMs, lineage: state.lineage, identitySha256: state.organismBinding.identitySha256, inputCursor: state.inputCursor, state: clone(state) };
  return { ...body, checkpointHash: hash(body) };
}

function validateCheckpoint(checkpoint, expected = {}) {
  exactKeys(checkpoint, ['checkpointHash', 'checkpointVersion', 'committedAtMs', 'identitySha256', 'inputCursor', 'lineage', 'state'], 'acquired checkpoint');
  const { checkpointHash, ...body } = checkpoint;
  if (checkpoint.checkpointVersion !== 1 || !HASH.test(checkpointHash) || checkpointHash !== hash(body)) fail('checkpoint integrity failed', 'SNTSS_CHECKPOINT_CORRUPT');
  validateAcquiredState(checkpoint.state);
  if (checkpoint.lineage !== checkpoint.state.lineage || checkpoint.identitySha256 !== checkpoint.state.organismBinding.identitySha256 || checkpoint.inputCursor !== checkpoint.state.inputCursor) fail('checkpoint envelope disagrees with state', 'SNTSS_CHECKPOINT_CORRUPT');
  if ((expected.lineage && expected.lineage !== checkpoint.lineage) || (expected.identitySha256 && expected.identitySha256 !== checkpoint.identitySha256) || (expected.speciesProfileHash && expected.speciesProfileHash !== checkpoint.state.speciesProfileHash)) fail('checkpoint belongs to another organism or profile', 'SNTSS_LINEAGE_MISMATCH');
  return checkpoint;
}

// This is a laboratory projection guard only. Durable individuality and migration belong to R7.
function projectLaboratoryModel(model) {
  validateLaboratoryModel(model);
  assertDormantState(model);
  return JSON.parse(JSON.stringify(model));
}

module.exports = {
  stateSchema: 2, stage: 'laboratory-r7-acquired-state', HASH, STATE_KEYS, MAX_STATE_BYTES,
  validateBinding, validateAcquiredState, stateHash, createCheckpoint, validateCheckpoint,
  projectLaboratoryModel, clone
};
