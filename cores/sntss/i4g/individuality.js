'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../../../runtime/kernel/canonical-json');

const HASH = /^sha256:[0-9a-f]{64}$/;
const HEX_32 = /^[0-9a-f]{64}$/;
const AUTHORIZATION = 'R13_SNTSS_CONTINUITY_GENESIS_SHADOW';
const TYPE = 'SNTSS_CONTINUITY_GENESIS';
const PARENT_FREEZE_REVISION = 105;
const PARENT_FREEZE_RECORD_SHA256 =
  'sha256:78021d86da8038e298fedb46b7371a46e1bc1e4d1cb0624205a864877ca22875';

const PAYLOAD_KEYS = Object.freeze([
  'authorization',
  'formatVersion',
  'organismIdentitySha256',
  'parentFreezeRecordSha256',
  'parentFreezeRevision',
  'runtimeRevision',
  'seedHex',
  'sourceCheckpointGeneration',
  'sourceCheckpointHash'
]);

const RECORD_KEYS = Object.freeze([
  'authorityMode',
  'authorization',
  'createdAt',
  'formatVersion',
  'genesisEventId',
  'genesisSequence',
  'lineageSha256',
  'organismIdentitySha256',
  'organismLineage',
  'outputs',
  'parentFreezeRecordSha256',
  'parentFreezeRevision',
  'prenatalChemistrySha256',
  'prenatalModelClock',
  'prenatalStateSha256',
  'productionEligible',
  'runtimeRevision',
  'seedCommitmentSha256',
  'sourceCheckpointGeneration',
  'sourceCheckpointHash',
  'type'
]);

function fail(message, code = 'SNTSS_I4G_GENESIS_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} fields are not canonical`);
  }
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`);
  return value;
}

function digest(value) {
  const bytes = typeof value === 'string' ? value : stableStringify(value);
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalPrenatalState(state) {
  return {
    formatVersion: state.formatVersion,
    stateSchema: state.stateSchema,
    protocol: state.protocol,
    coreVersion: state.coreVersion,
    stage: state.stage,
    organismBinding: structuredClone(state.organismBinding),
    individuality: null,
    chemistry: structuredClone(state.chemistry),
    receptorAdaptation: structuredClone(state.receptorAdaptation),
    receptorAvailability: structuredClone(state.receptorAvailability),
    trustedTime: structuredClone(state.trustedTime),
    migrations: structuredClone(state.migrations)
  };
}

function validatePayload(payload) {
  exactKeys(payload, PAYLOAD_KEYS, 'continuity-genesis payload');
  if (payload.formatVersion !== 1 || payload.authorization !== AUTHORIZATION) {
    fail('continuity-genesis authorization is invalid', 'SNTSS_I4G_GENESIS_AUTHORITY');
  }
  if (!HASH.test(payload.organismIdentitySha256) || !HASH.test(payload.sourceCheckpointHash) ||
      !HASH.test(payload.parentFreezeRecordSha256) || !HEX_32.test(payload.seedHex)) {
    fail('continuity-genesis identity or digest is invalid');
  }
  integer(payload.runtimeRevision, 'runtime revision', 1);
  integer(payload.sourceCheckpointGeneration, 'source checkpoint generation', 1);
  if (payload.parentFreezeRevision !== PARENT_FREEZE_REVISION ||
      payload.parentFreezeRecordSha256 !== PARENT_FREEZE_RECORD_SHA256) {
    fail('continuity-genesis parent is not the accepted R105F physiology baseline',
      'SNTSS_I4G_GENESIS_PARENT');
  }
  return payload;
}

function validateIndividuality(record, binding = null) {
  if (record == null) return null;
  exactKeys(record, RECORD_KEYS, 'continuity-genesis record');
  if (record.formatVersion !== 1 || record.type !== TYPE || record.authorization !== AUTHORIZATION ||
      record.parentFreezeRevision !== PARENT_FREEZE_REVISION ||
      record.parentFreezeRecordSha256 !== PARENT_FREEZE_RECORD_SHA256 ||
      record.productionEligible !== false || record.authorityMode !== 'NONE' || record.outputs !== 0) {
    fail('continuity-genesis record contract is invalid');
  }
  for (const field of [
    'lineageSha256', 'organismIdentitySha256', 'prenatalChemistrySha256',
    'prenatalStateSha256', 'seedCommitmentSha256', 'sourceCheckpointHash'
  ]) {
    if (!HASH.test(record[field])) fail(`continuity-genesis record digest is invalid: ${field}`);
  }
  for (const [field, minimum] of [
    ['createdAt', 0], ['genesisSequence', 1], ['prenatalModelClock', 0],
    ['runtimeRevision', 1], ['sourceCheckpointGeneration', 1]
  ]) integer(record[field], field, minimum);
  if (typeof record.genesisEventId !== 'string' || !record.genesisEventId ||
      record.organismLineage !== 'STAY/Genesis') {
    fail('continuity-genesis record identity is invalid');
  }
  if (binding && (record.organismIdentitySha256 !== binding.identitySha256 ||
      record.organismLineage !== binding.organismLineage)) {
    fail('continuity-genesis record belongs to another organism', 'SNTSS_I4G_LINEAGE_MISMATCH');
  }
  return record;
}

function establishContinuityGenesis(inputState, event) {
  const payload = validatePayload(event?.payload);
  const binding = inputState?.organismBinding;
  if (!binding || binding.identitySha256 !== payload.organismIdentitySha256 ||
      binding.organismLineage !== 'STAY/Genesis') {
    fail('continuity-genesis organism binding is unavailable or mismatched',
      'SNTSS_I4G_LINEAGE_MISMATCH');
  }
  if (event.topic !== 'runtime.sntss.continuity-genesis' || event.ledger?.durable !== true ||
      event.meta?.sourceCore !== 'living-kernel' ||
      Number(event.meta?.authorityEpoch) !== payload.runtimeRevision) {
    fail('continuity-genesis event is not Kernel-authoritative and durable',
      'SNTSS_I4G_GENESIS_AUTHORITY');
  }
  integer(event.sequence, 'genesis event sequence', 1);
  integer(event.at, 'genesis event time', binding.issuedAt);
  if (typeof event.id !== 'string' || !event.id) fail('continuity-genesis event identity is invalid');

  if (inputState.individuality) {
    const existing = validateIndividuality(inputState.individuality, binding);
    if (existing.genesisEventId === event.id &&
        existing.genesisSequence === event.sequence &&
        existing.createdAt === event.at &&
        existing.runtimeRevision === payload.runtimeRevision &&
        existing.seedCommitmentSha256 === digest(payload.seedHex) &&
        existing.sourceCheckpointHash === payload.sourceCheckpointHash &&
        existing.sourceCheckpointGeneration === payload.sourceCheckpointGeneration) {
      return structuredClone(inputState);
    }
    fail('SNTSS individuality already exists', 'SNTSS_SECOND_GENESIS');
  }

  const prenatal = canonicalPrenatalState(inputState);
  const prenatalStateSha256 = digest(prenatal);
  const prenatalChemistrySha256 = digest(prenatal.chemistry);
  const seedCommitmentSha256 = digest(payload.seedHex);
  const lineageSha256 = digest({
    formatVersion: 1,
    type: TYPE,
    genesisEventId: event.id,
    organismIdentitySha256: binding.identitySha256,
    parentFreezeRecordSha256: payload.parentFreezeRecordSha256,
    prenatalStateSha256,
    seedHex: payload.seedHex,
    sourceCheckpointHash: payload.sourceCheckpointHash
  });

  const individuality = {
    formatVersion: 1,
    type: TYPE,
    authorization: AUTHORIZATION,
    genesisEventId: event.id,
    genesisSequence: event.sequence,
    createdAt: event.at,
    runtimeRevision: payload.runtimeRevision,
    organismIdentitySha256: binding.identitySha256,
    organismLineage: binding.organismLineage,
    sourceCheckpointHash: payload.sourceCheckpointHash,
    sourceCheckpointGeneration: payload.sourceCheckpointGeneration,
    parentFreezeRevision: payload.parentFreezeRevision,
    parentFreezeRecordSha256: payload.parentFreezeRecordSha256,
    prenatalStateSha256,
    prenatalChemistrySha256,
    prenatalModelClock: prenatal.chemistry.modelClock,
    seedCommitmentSha256,
    lineageSha256,
    productionEligible: false,
    authorityMode: 'NONE',
    outputs: 0
  };
  validateIndividuality(individuality, binding);
  return { ...structuredClone(inputState), individuality };
}

module.exports = {
  AUTHORIZATION,
  TYPE,
  PARENT_FREEZE_REVISION,
  PARENT_FREEZE_RECORD_SHA256,
  digest,
  canonicalPrenatalState,
  validatePayload,
  validateIndividuality,
  establishContinuityGenesis
};
