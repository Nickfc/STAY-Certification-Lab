'use strict';

const { ALL_FAMILIES, speciesProfile, hash } = require('./species-profile');
const stateContract = require('./state');

const MIGRATION_ID = 'sntss-acquired-state-1-to-2';
const TRANSFORMATION_HASH = hash({ migrationId: MIGRATION_ID, adds: 'explicit-zero-clamp-counters', preserves: 'all-acquired-biology' });

function fail(message, code = 'SNTSS_MIGRATION_INVALID') { throw Object.assign(new Error(message), { code }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function biologicalInvariant(state) {
  return {
    lineage: state.lineage, organismBinding: state.organismBinding, speciesProfileHash: state.speciesProfileHash,
    modelClock: state.modelClock, developmentalClock: state.developmentalClock, inputCursor: state.inputCursor,
    transmitters: state.transmitters, receptors: state.receptors, sourceHistory: state.sourceHistory,
    habituation: state.habituation, leases: state.leases, circuitBreakers: state.circuitBreakers
  };
}
function biologicalInvariantHash(state) { return hash(biologicalInvariant(state)); }

function validateLegacyState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.stateSchema !== 1 || Object.prototype.hasOwnProperty.call(input, 'clampCounters')) fail('legacy state schema is invalid', 'SNTSS_STATE_SCHEMA_UNSUPPORTED');
  const probe = { ...clone(input), stateSchema: 2, clampCounters: Object.fromEntries(ALL_FAMILIES.map(family => [family, 0])) };
  stateContract.validateAcquiredState(probe);
  return input;
}

function migrateForward(input, targetSchema = 2) {
  if (targetSchema !== 2) fail('migration target is unsupported', 'SNTSS_MIGRATION_UNSUPPORTED');
  if (input?.stateSchema === 2) { stateContract.validateAcquiredState(input); return { state: input, report: { status: 'already-current', outputHash: stateContract.stateHash(input) } }; }
  validateLegacyState(input);
  if (input.speciesProfileHash !== speciesProfile.profileHash) fail('migration cannot replace the species profile', 'SNTSS_PROFILE_HASH_MISMATCH');
  const before = biologicalInvariantHash(input); const state = clone(input); const inputHash = hash(input);
  state.stateSchema = 2;
  state.clampCounters = Object.fromEntries(ALL_FAMILIES.map(family => [family, 0]));
  state.migrations.push({ type: 'forward', migrationId: MIGRATION_ID, fromSchema: 1, toSchema: 2, inputHash, transformationHash: TRANSFORMATION_HASH, appliedAtCursor: state.inputCursor });
  state.auditChainHead = hash({ previous: state.auditChainHead, migrationId: MIGRATION_ID, inputHash, transformationHash: TRANSFORMATION_HASH });
  stateContract.validateAcquiredState(state);
  const after = biologicalInvariantHash(state);
  if (before !== after) fail('migration changed acquired biology', 'SNTSS_MIGRATION_BIOLOGICAL_REWRITE');
  return { state, report: { status: 'migrated', migrationId: MIGRATION_ID, inputHash, outputHash: stateContract.stateHash(state), biologicalInvariantHash: after, transformationHash: TRANSFORMATION_HASH } };
}

function projectBackward(input, targetSchema = 1) {
  stateContract.validateAcquiredState(input);
  if (targetSchema !== 1) fail('backward projection target is unsupported', 'SNTSS_MIGRATION_UNSUPPORTED');
  const before = biologicalInvariantHash(input); const projected = clone(input); const inputHash = stateContract.stateHash(input);
  delete projected.clampCounters; projected.stateSchema = 1;
  projected.migrations.push({ type: 'backward-projection', migrationId: 'sntss-acquired-state-2-to-1-projection', fromSchema: 2, toSchema: 1, inputHash, transformationHash: TRANSFORMATION_HASH, appliedAtCursor: projected.inputCursor });
  projected.auditChainHead = hash({ previous: projected.auditChainHead, projection: '2-to-1', inputHash, transformationHash: TRANSFORMATION_HASH });
  validateLegacyState(projected);
  const after = biologicalInvariantHash(projected);
  if (before !== after) fail('backward projection rewound acquired biology', 'SNTSS_ROLLBACK_REWIND');
  return { state: projected, report: { status: 'projected', sourceStateRemainsAuthoritative: true, inputHash, outputHash: hash(projected), biologicalInvariantHash: after, transformationHash: TRANSFORMATION_HASH } };
}

module.exports = { MIGRATION_ID, TRANSFORMATION_HASH, validateLegacyState, biologicalInvariantHash, migrateForward, projectBackward };
