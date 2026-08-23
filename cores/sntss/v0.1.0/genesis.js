'use strict';

const crypto = require('node:crypto');
const { speciesProfile, createInitialModel, ALL_FAMILIES, hash } = require('./species-profile');
const { createReceptorState } = require('./receptors');
const stateContract = require('./state');

const REQUEST_KEYS = Object.freeze(['at', 'binding', 'genesisEventId', 'genesisSequence', 'neutralCheckpointHash']);
const CONTEXT_KEYS = Object.freeze(['authorityEpoch', 'neutralHandoffVerified', 'productionCommit', 'speciesProfileHash', 'stage']);

function fail(message, code = 'SNTSS_GENESIS_INVALID') { throw Object.assign(new Error(message), { code }); }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} fields are not canonical`);
}

function prepareGenesis(existingState, request, context, entropyHex = null) {
  if (existingState != null) fail('SNTSS lineage already exists', 'SNTSS_SECOND_GENESIS');
  exactKeys(request, REQUEST_KEYS, 'genesis request'); exactKeys(context, CONTEXT_KEYS, 'genesis authorization');
  stateContract.validateBinding(request.binding);
  if (!stateContract.HASH.test(request.neutralCheckpointHash) || typeof request.genesisEventId !== 'string' || !request.genesisEventId || !Number.isSafeInteger(request.genesisSequence) || request.genesisSequence < 1 || !Number.isSafeInteger(request.at) || request.at < request.binding.issuedAt) fail('genesis evidence is invalid');
  if (context.stage !== 'laboratory-r7' || context.productionCommit !== false) fail('production genesis is reserved for accepted R13 shadow transition', 'SNTSS_PRODUCTION_GENESIS_BLOCKED');
  if (context.neutralHandoffVerified !== true || context.speciesProfileHash !== speciesProfile.profileHash || context.authorityEpoch !== request.binding.authorityEpoch) fail('genesis authority, handoff or profile is unverified', 'SNTSS_GENESIS_AUTHORITY');
  const entropy = entropyHex || crypto.randomBytes(32).toString('hex');
  if (typeof entropy !== 'string' || !/^[0-9a-f]{64}$/.test(entropy)) fail('genesis entropy is invalid');
  const lineage = hash({ identitySha256: request.binding.identitySha256, genesisEventId: request.genesisEventId, entropy });
  const model = createInitialModel(0); const receptorState = createReceptorState(lineage, request.at);
  const genesisRecord = {
    recordVersion: 1, topic: 'SNTSS_GENESIS', genesisEventId: request.genesisEventId,
    genesisSequence: request.genesisSequence, createdAt: request.at, neutralCheckpointHash: request.neutralCheckpointHash,
    lineage, speciesProfileHash: speciesProfile.profileHash, laboratoryOrigin: true, productionEligible: false,
    birthStateHash: hash(model.transmitters)
  };
  const state = {
    formatVersion: 1, stateSchema: 2, protocol: 'stay-sntss-v1', lineage,
    organismBinding: stateContract.clone(request.binding), speciesProfileHash: speciesProfile.profileHash,
    modelClock: { chemicalElapsedMs: 0, remainderMs: 0, lastTrustedWallClockMs: request.at },
    developmentalClock: { experienceMs: 0, lastTrustedWallClockMs: request.at },
    inputCursor: request.genesisSequence, transmitters: model.transmitters, receptors: receptorState,
    sourceHistory: { genesis: genesisRecord }, habituation: {}, leases: {}, circuitBreakers: {}, migrations: [],
    clampCounters: Object.fromEntries(ALL_FAMILIES.map(family => [family, 0])), auditChainHead: hash(genesisRecord)
  };
  stateContract.validateAcquiredState(state);
  const ledgerEvent = {
    id: request.genesisEventId, sequence: request.genesisSequence, topic: 'SNTSS_GENESIS', class: 'critical',
    lineage, identitySha256: request.binding.identitySha256, stateHash: stateContract.stateHash(state),
    causalParent: request.binding.bindingEventId, at: request.at
  };
  const transactionBody = { transactionVersion: 1, state, ledgerEvent, authorityEpoch: context.authorityEpoch };
  return { ...transactionBody, transactionHash: hash(transactionBody) };
}

function validateGenesisTransaction(transaction) {
  exactKeys(transaction, ['authorityEpoch', 'ledgerEvent', 'state', 'transactionHash', 'transactionVersion'], 'genesis transaction');
  const { transactionHash, ...body } = transaction;
  if (transaction.transactionVersion !== 1 || transactionHash !== hash(body)) fail('genesis transaction hash mismatch');
  stateContract.validateAcquiredState(transaction.state);
  const genesis = transaction.state.sourceHistory.genesis;
  if (!genesis || genesis.genesisEventId !== transaction.ledgerEvent.id || transaction.ledgerEvent.stateHash !== stateContract.stateHash(transaction.state) || transaction.ledgerEvent.lineage !== transaction.state.lineage) fail('genesis ledger/state binding is invalid');
  return transaction;
}

function assertProductionImportAllowed(state) {
  stateContract.validateAcquiredState(state);
  if (state.sourceHistory.genesis?.laboratoryOrigin === true || state.sourceHistory.genesis?.productionEligible !== true) fail('laboratory genesis state cannot enter production', 'SNTSS_LAB_IMPORT_BLOCKED');
  return true;
}

module.exports = { prepareGenesis, validateGenesisTransaction, assertProductionImportAllowed };
