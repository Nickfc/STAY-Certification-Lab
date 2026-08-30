'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../kernel/canonical-json');

const HASH = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9._:-]{1,160}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CHIP_STATES = Object.freeze([
  'QUARANTINED', 'OFFLINE', 'RECOVERING', 'DEGRADED', 'LIVE', 'SHADOW', 'NEUTRAL'
]);
const CHIP_MODES = Object.freeze(['LIVE', 'SHADOW', 'NEUTRAL', 'NONE']);
const COVERAGE_BANDS = Object.freeze(['FULL', 'PARTIAL', 'UNKNOWN', 'NOT_APPLICABLE']);
const CHIP_STATE_SET = new Set(CHIP_STATES);
const CHIP_MODE_SET = new Set(CHIP_MODES);
const COVERAGE_BAND_SET = new Set(COVERAGE_BANDS);
const FOUNDER_FIELDS = new Set([
  'recordVersion', 'organismId', 'coreId', 'founderId', 'lineageId', 'profileId',
  'profileHash', 'founderSchemaId', 'founderSchemaVersion', 'genesisFrame',
  'genesisTransactionId', 'phenotypeHash', 'committed', 'previousFounderId'
]);
const CHIP_OBSERVATION_FIELDS = new Set([
  'recordVersion', 'chipId', 'organismId', 'coreId', 'publicName', 'born',
  'firstActivationFrame', 'firstResidencyId', 'currentState', 'mode', 'lifecycle',
  'healthReasonCode', 'coreVersion', 'stateSchemaVersion', 'checkpointGeneration',
  'lastTrustedFrame', 'coverageBand', 'evidenceRefs', 'observedUtc'
]);
const CHIP_RECORD_FIELDS = new Set([...CHIP_OBSERVATION_FIELDS, 'historyHeadHash']);
const CHECKPOINT_FIELDS = new Set([
  'recordVersion', 'organismId', 'coreId', 'residencyId', 'founderId', 'lineageId',
  'profileHash', 'stateSchemaVersion', 'implementationVersion', 'authorityEpoch',
  'mode', 'checkpointGeneration', 'parentCheckpointHash', 'trustedFrontier',
  'fabricFrontier', 'inputCursors', 'outputSequence', 'stateHash', 'cursorHash',
  'outputLedgerHash', 'causalHighWaterHash', 'commitTransactionId', 'complete', 'createdUtc'
]);
const P1_CORES = new Set(['METAB', 'HOMEOS', 'INTERO']);
const UNSIGNED_TEXT = /^(0|[1-9][0-9]*)$/;

function fail(message, code = 'P1_RECORD_SCHEMA') {
  throw Object.assign(new Error(message), { code });
}

function exact(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some(key => !fields.has(key))) fail(`${label} fields are not exact`);
}

function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function text(value, label, maximum = 160) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) fail(`${label} is invalid`);
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} is invalid`);
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`);
  return value;
}

function clone(value) {
  return JSON.parse(stableStringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function recordHash(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function unsignedText(value, label, minimum = 0n) {
  if (typeof value !== 'string' || !UNSIGNED_TEXT.test(value) || BigInt(value) < minimum) {
    fail(`${label} is invalid`);
  }
  return BigInt(value);
}

function utc(value, label) {
  if (typeof value !== 'string' || !UTC.test(value)) fail(`${label} is invalid`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) fail(`${label} is invalid`);
  return value;
}

function validateFounderRecord(input) {
  exact(input, FOUNDER_FIELDS, 'founder record');
  if (input.recordVersion !== 'P1FounderRecordV1') fail('founder record version is invalid');
  for (const field of ['organismId', 'founderId', 'lineageId', 'profileId', 'founderSchemaId', 'genesisTransactionId']) {
    id(input[field], `founder ${field}`);
  }
  if (!P1_CORES.has(input.coreId)) fail('founder core is invalid');
  hash(input.profileHash, 'founder profile hash');
  hash(input.phenotypeHash, 'founder phenotype hash');
  if (input.founderSchemaVersion !== '1') fail('founder schema version is invalid');
  integer(input.genesisFrame, 'founder genesis frame');
  if (input.committed !== true || input.previousFounderId !== null) {
    fail('P1-R0 founder must be the one committed origin with no predecessor');
  }
  return deepFreeze(clone(input));
}

function validateChipFields(input) {
  for (const field of ['chipId', 'organismId', 'firstResidencyId']) {
    id(input[field], `chip ${field}`);
  }
  if (!P1_CORES.has(input.coreId)) fail('chip core is invalid');
  for (const field of ['publicName', 'lifecycle', 'healthReasonCode', 'coreVersion']) {
    text(input[field], `chip ${field}`);
  }
  if (input.born !== true) fail('a persistent chip observation requires accepted birth');
  integer(input.firstActivationFrame, 'chip first activation frame');
  unsignedText(input.stateSchemaVersion, 'chip state schema version', 1n);
  unsignedText(input.checkpointGeneration, 'chip checkpoint generation');
  if (input.lastTrustedFrame !== null) integer(input.lastTrustedFrame, 'chip trusted frame');
  if (!CHIP_STATE_SET.has(input.currentState)) fail('chip state is invalid');
  if (!CHIP_MODE_SET.has(input.mode)) fail('chip mode is invalid');
  if (!COVERAGE_BAND_SET.has(input.coverageBand)) fail('chip coverage band is invalid');
  if (input.currentState === 'LIVE' && input.mode !== 'LIVE') fail('LIVE chip requires LIVE mode');
  if (input.currentState === 'SHADOW' && input.mode !== 'SHADOW') fail('SHADOW chip requires SHADOW mode');
  if (input.currentState === 'NEUTRAL' && input.mode !== 'NEUTRAL') fail('NEUTRAL chip requires NEUTRAL mode');
  if (input.mode === 'NONE' && ['LIVE', 'SHADOW', 'NEUTRAL'].includes(input.currentState)) fail('active chip state requires an active mode');
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length < 1 || input.evidenceRefs.length > 16 || new Set(input.evidenceRefs).size !== input.evidenceRefs.length) {
    fail('chip evidence references are invalid');
  }
  for (const evidence of input.evidenceRefs) hash(evidence, 'chip evidence reference');
  utc(input.observedUtc, 'chip observation time');
}

function validateChipObservation(input) {
  exact(input, CHIP_OBSERVATION_FIELDS, 'chip observation');
  if (input.recordVersion !== 'CoreChipObservationV1') fail('chip observation version is invalid');
  validateChipFields(input);
  return deepFreeze(clone(input));
}

function validateChipRecord(input) {
  exact(input, CHIP_RECORD_FIELDS, 'chip record');
  if (input.recordVersion !== 'CoreChipRecordV1') fail('chip record version is invalid');
  validateChipFields(input);
  hash(input.historyHeadHash, 'chip history head hash');
  return deepFreeze(clone(input));
}

function materializeChipRecord(observationInput, historyHeadHash) {
  const observation = validateChipObservation(observationInput);
  hash(historyHeadHash, 'chip history head hash');
  return validateChipRecord({
    ...observation,
    recordVersion: 'CoreChipRecordV1',
    historyHeadHash
  });
}

function chipRecordToObservation(recordInput) {
  const record = validateChipRecord(recordInput);
  const { historyHeadHash: _historyHeadHash, ...observation } = record;
  return validateChipObservation({ ...observation, recordVersion: 'CoreChipObservationV1' });
}

function validateCheckpointProjection(input) {
  exact(input, CHECKPOINT_FIELDS, 'checkpoint projection');
  if (input.recordVersion !== 'P1CheckpointRecordV1') fail('checkpoint record version is invalid');
  for (const field of ['organismId', 'residencyId', 'founderId', 'lineageId', 'implementationVersion', 'commitTransactionId']) {
    id(input[field], `checkpoint ${field}`);
  }
  if (!P1_CORES.has(input.coreId)) fail('checkpoint core is invalid');
  hash(input.profileHash, 'checkpoint profile hash');
  integer(input.stateSchemaVersion, 'checkpoint state schema version', 1);
  unsignedText(input.authorityEpoch, 'checkpoint authority epoch');
  if (!CHIP_MODE_SET.has(input.mode) || input.mode === 'NONE') fail('checkpoint mode is invalid');
  const generation = unsignedText(input.checkpointGeneration, 'checkpoint generation', 1n);
  if (generation === 1n) {
    if (input.parentCheckpointHash !== null) fail('first checkpoint cannot have a parent');
  } else {
    hash(input.parentCheckpointHash, 'checkpoint parent hash');
  }
  integer(input.trustedFrontier, 'checkpoint trusted frontier');
  unsignedText(input.fabricFrontier, 'checkpoint fabric frontier');
  if (
    !input.inputCursors ||
    typeof input.inputCursors !== 'object' ||
    Array.isArray(input.inputCursors) ||
    Object.keys(input.inputCursors).length > 128
  ) {
    fail('checkpoint input cursors are invalid');
  }
  for (const [routeId, cursor] of Object.entries(input.inputCursors)) {
    id(routeId, 'checkpoint route id');
    unsignedText(cursor, `checkpoint cursor ${routeId}`);
  }
  unsignedText(input.outputSequence, 'checkpoint output sequence');
  for (const field of ['stateHash', 'cursorHash', 'outputLedgerHash', 'causalHighWaterHash']) {
    hash(input[field], `checkpoint ${field}`);
  }
  if (input.complete !== true) fail('checkpoint must be complete');
  utc(input.createdUtc, 'checkpoint creation time');
  return deepFreeze(clone(input));
}

function validateCheckpointSuccessor(previousInput, nextInput) {
  const previous = validateCheckpointProjection(previousInput);
  const next = validateCheckpointProjection(nextInput);
  for (const field of [
    'organismId', 'coreId', 'residencyId', 'founderId', 'lineageId',
    'profileHash', 'stateSchemaVersion', 'implementationVersion', 'authorityEpoch', 'mode'
  ]) {
    if (next[field] !== previous[field]) fail(`checkpoint ${field} identity drift`, 'P1_CHECKPOINT_IDENTITY');
  }
  if (BigInt(next.checkpointGeneration) <= BigInt(previous.checkpointGeneration)) {
    fail('checkpoint generation rewound', 'P1_CHECKPOINT_REWIND');
  }
  if (next.parentCheckpointHash !== recordHash(previous)) {
    fail('checkpoint parent hash is invalid', 'P1_CHECKPOINT_PARENT');
  }
  if (
    next.trustedFrontier < previous.trustedFrontier ||
    BigInt(next.fabricFrontier) < BigInt(previous.fabricFrontier) ||
    BigInt(next.outputSequence) < BigInt(previous.outputSequence)
  ) {
    fail('checkpoint frontier rewound', 'P1_CHECKPOINT_REWIND');
  }
  for (const [routeId, cursor] of Object.entries(previous.inputCursors)) {
    if (!Object.hasOwn(next.inputCursors, routeId) || BigInt(next.inputCursors[routeId]) < BigInt(cursor)) {
      fail('checkpoint input cursor rewound or disappeared', 'P1_CHECKPOINT_REWIND');
    }
  }
  if (next.commitTransactionId === previous.commitTransactionId) {
    fail('checkpoint successor reused its transaction identity', 'P1_CHECKPOINT_TRANSACTION');
  }
  return next;
}

module.exports = Object.freeze({
  CHIP_STATES,
  CHIP_MODES,
  COVERAGE_BANDS,
  recordHash,
  validateFounderRecord,
  validateChipObservation,
  validateChipRecord,
  materializeChipRecord,
  chipRecordToObservation,
  validateCheckpointProjection,
  validateCheckpointSuccessor
});
