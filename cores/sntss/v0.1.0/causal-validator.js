'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../../../runtime/kernel/canonical-json');

const HASH = /^sha256:[0-9a-f]{64}$/;
const UNTRUSTED_SOURCES = new Set(['browser', 'viewer', 'operator', 'telemetry', 'public', 'network']);
const CHEMICAL_COMMAND = /(dopamine|serotonin|noradrenaline|norepinephrine|acetylcholine|glutamate|gaba|oxytocin|opioid|neurotransmitter|transmitter|target.?concentration|chemical.?state|reward.?button|pleasure|happiness|obedience|grant.?trust)/i;
const ENVELOPE_KEYS = Object.freeze(['at', 'class', 'deadlineAt', 'id', 'ledger', 'meta', 'payload', 'sequence', 'topic']);
const LEDGER_KEYS = Object.freeze(['deduplicated', 'durable', 'envelopeHash', 'payloadHash', 'provenanceHash']);
const META_ALLOWED = new Set([
  'authorityEpoch', 'causalParent', 'causeSequence', 'clockStatus', 'deduplicationKey',
  'dreamOrigin', 'eventClass', 'evidenceHash', 'outputIndex', 'payloadHash', 'provenanceHash',
  'schemaVersion', 'sourceCore', 'sourceInstanceId', 'sourceVersion'
]);
const META_REQUIRED = Object.freeze([
  'authorityEpoch', 'causalParent', 'causeSequence', 'clockStatus', 'deduplicationKey',
  'dreamOrigin', 'eventClass', 'evidenceHash', 'payloadHash', 'provenanceHash',
  'schemaVersion', 'sourceCore', 'sourceInstanceId', 'sourceVersion'
]);

function fail(message, code) { throw Object.assign(new Error(message), { code }); }
function hash(value) { return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`; }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`, 'SNTSS_SCHEMA_CONFUSION');
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} fields are not canonical`, 'SNTSS_SCHEMA_CONFUSION');
}
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`, 'SNTSS_INVALID_NUMERIC');
  return value;
}
function text(value, label, maximum = 200) {
  if (typeof value !== 'string' || !value || value.length > maximum) fail(`${label} is invalid`, 'SNTSS_SCHEMA_CONFUSION');
  return value;
}

function containsChemicalCommand(value, path = 'payload') {
  if (typeof value === 'string') return CHEMICAL_COMMAND.test(value) ? path : null;
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = containsChemicalCommand(value[index], `${path}[${index}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (CHEMICAL_COMMAND.test(key)) return `${path}.${key}`;
    const hit = containsChemicalCommand(entry, `${path}.${key}`);
    if (hit) return hit;
  }
  return null;
}

function verifyLedgerEnvelope(event) {
  exactKeys(event, ENVELOPE_KEYS, 'semantic event');
  exactKeys(event.ledger, LEDGER_KEYS, 'semantic ledger proof');
  if (event.ledger.durable !== true || typeof event.ledger.deduplicated !== 'boolean') fail('semantic event is not durably appended', 'SNTSS_LEDGER_REQUIRED');
  for (const field of ['envelopeHash', 'payloadHash', 'provenanceHash']) if (!HASH.test(event.ledger[field])) fail(`ledger ${field} is invalid`, 'SNTSS_PROVENANCE_FORGED');
  if (!event.meta || typeof event.meta !== 'object' || Array.isArray(event.meta)) fail('semantic metadata is invalid', 'SNTSS_SCHEMA_CONFUSION');
  for (const key of Object.keys(event.meta)) if (!META_ALLOWED.has(key)) fail(`semantic metadata field is not allowed: ${key}`, 'SNTSS_SCHEMA_CONFUSION');
  for (const key of META_REQUIRED) if (!Object.prototype.hasOwnProperty.call(event.meta, key)) fail(`semantic metadata field is missing: ${key}`, 'SNTSS_SCHEMA_CONFUSION');
  if (!['critical', 'durable'].includes(event.class) || event.meta.eventClass !== event.class) fail('semantic event class is invalid', 'SNTSS_LEDGER_REQUIRED');
  integer(event.sequence, 'semantic sequence', 1);
  integer(event.at, 'semantic issue time');
  integer(event.deadlineAt, 'semantic deadline');
  if (event.deadlineAt < event.at) fail('semantic deadline precedes issue time', 'SNTSS_EVENT_DEADLINE');
  text(event.id, 'semantic event id');
  text(event.topic, 'semantic topic');

  const payloadHash = hash(event.payload);
  if (payloadHash !== event.ledger.payloadHash || event.meta.payloadHash !== payloadHash) fail('semantic payload hash mismatch', 'SNTSS_PROVENANCE_FORGED');
  const provenance = {
    sourceCore: event.meta.sourceCore ?? null,
    sourceVersion: event.meta.sourceVersion ?? null,
    sourceInstanceId: event.meta.sourceInstanceId ?? null,
    authorityEpoch: event.meta.authorityEpoch ?? null,
    causeSequence: event.meta.causeSequence ?? null,
    causalParent: event.meta.causalParent ?? null,
    evidenceHash: event.meta.evidenceHash ?? null
  };
  const provenanceHash = hash(provenance);
  if (provenanceHash !== event.ledger.provenanceHash || event.meta.provenanceHash !== provenanceHash) fail('semantic provenance hash mismatch', 'SNTSS_PROVENANCE_FORGED');
  const { ledger, ...envelope } = event;
  if (hash(envelope) !== ledger.envelopeHash) fail('semantic envelope hash mismatch', 'SNTSS_PROVENANCE_FORGED');
  return true;
}

function validatePayload(payload, policy) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('semantic payload is invalid', 'SNTSS_SCHEMA_CONFUSION');
  const commandPath = containsChemicalCommand(payload);
  if (commandPath) fail(`direct chemical command at ${commandPath}`, 'SNTSS_DIRECT_CHEMICAL_COMMAND');
  exactKeys(payload, Object.keys(policy.payloadFields), `payload for ${policy.topic}`);
  for (const [field, descriptor] of Object.entries(policy.payloadFields)) {
    const value = payload[field];
    if (descriptor.type === 'scaled') {
      if (!Number.isSafeInteger(value) || value < 0 || value > 1000000) fail(`payload ${field} is outside fixed-point bounds`, 'SNTSS_INVALID_NUMERIC');
    } else if (descriptor.type === 'signed') {
      if (!Number.isSafeInteger(value) || value < -1000000 || value > 1000000) fail(`payload ${field} is outside signed bounds`, 'SNTSS_INVALID_NUMERIC');
    } else if (descriptor.type === 'enum') {
      if (!descriptor.values.includes(value)) fail(`payload ${field} is outside its semantic vocabulary`, 'SNTSS_SCHEMA_CONFUSION');
    } else if (descriptor.type === 'hash') {
      if (!HASH.test(value)) fail(`payload ${field} is not a canonical hash`, 'SNTSS_SCHEMA_CONFUSION');
    } else fail(`payload ${field} has an unknown schema`, 'SNTSS_SCHEMA_CONFUSION');
  }
  return payload;
}

function authorityRecord(context, sourceCore) {
  const record = context?.authorityByCore?.[sourceCore];
  if (!record || record.active !== true) fail('producer has no current authority', 'SNTSS_AUTHORITY_STALE');
  return record;
}

function hasVerifiedEvidence(context, evidenceHash) {
  const source = context?.verifiedEvidenceHashes;
  if (source instanceof Set) return source.has(evidenceHash);
  if (Array.isArray(source)) return source.includes(evidenceHash);
  return false;
}

function resolveCausalRecord(id, state, context) {
  return state?.causalRecords?.[id] || context?.causalRecords?.[id] || null;
}

function validateCausalChain(event, state, context) {
  const parentId = text(event.meta.causalParent, 'causal parent');
  const direct = resolveCausalRecord(parentId, state, context);
  if (!direct || direct.verified !== true) fail('causal parent is not verified', 'SNTSS_CAUSAL_UNVERIFIED');
  if (integer(direct.sequence, 'causal parent sequence', 1) !== integer(event.meta.causeSequence, 'cause sequence', 1)) fail('cause sequence does not identify the parent', 'SNTSS_CAUSAL_UNVERIFIED');
  const visited = new Set([event.id]);
  const ancestry = [];
  let current = direct;
  for (let depth = 0; current; depth += 1) {
    if (depth >= 64) fail('causal ancestry exceeds the bounded depth', 'SNTSS_CAUSAL_UNVERIFIED');
    text(current.id, 'causal record id');
    if (visited.has(current.id)) fail('circular causal ancestry detected', 'SNTSS_CAUSAL_CIRCULAR');
    visited.add(current.id);
    if (!Number.isSafeInteger(current.sequence) || current.sequence >= event.sequence) fail('causal sequence is impossible', 'SNTSS_CAUSAL_UNVERIFIED');
    if (current.sourceCore === 'sntss' || String(current.topic || '').startsWith('sntss.')) fail('SNTSS descendant is not an accepted stimulus', 'SNTSS_CAUSAL_DESCENDANT');
    ancestry.push({ id: current.id, sequence: current.sequence, sourceCore: current.sourceCore, topic: current.topic });
    if (current.causalParent == null) break;
    current = resolveCausalRecord(current.causalParent, state, context);
    if (!current || current.verified !== true) fail('causal ancestry contains an unverifiable link', 'SNTSS_CAUSAL_UNVERIFIED');
  }
  return { ancestry, ancestryHash: hash(ancestry) };
}

function validateAuthoritativeEvent(event, policy, context, state) {
  verifyLedgerEnvelope(event);
  if (event.topic !== policy.topic) fail('source policy topic mismatch', 'SNTSS_TOPIC_UNREGISTERED');
  if (UNTRUSTED_SOURCES.has(event.meta.sourceCore)) fail('untrusted surface attempted biological input', 'SNTSS_UNTRUSTED_SURFACE');
  if (event.meta.sourceCore !== policy.sourceCore) fail('producer is not registered for this topic', 'SNTSS_SOURCE_UNREGISTERED');
  text(event.meta.sourceVersion, 'source version', 100);
  text(event.meta.sourceInstanceId, 'source instance', 200);
  text(event.meta.deduplicationKey, 'deduplication key', 256);
  if (event.meta.schemaVersion !== 1) fail('semantic schema version is unsupported', 'SNTSS_SCHEMA_CONFUSION');
  if (event.meta.clockStatus !== 'trusted') fail('semantic event clock is not trusted', 'SNTSS_CLOCK_DEGRADED');
  if (event.meta.dreamOrigin !== policy.dreamOrigin) fail('dream provenance does not match the registered topic', 'SNTSS_PROVENANCE_FORGED');
  if (!HASH.test(event.meta.evidenceHash)) fail('semantic evidence hash is invalid', 'SNTSS_EVIDENCE_UNVERIFIED');
  if (!hasVerifiedEvidence(context, event.meta.evidenceHash)) fail('semantic evidence is not independently verified', 'SNTSS_EVIDENCE_UNVERIFIED');
  const authority = authorityRecord(context, policy.sourceCore);
  if (integer(event.meta.authorityEpoch, 'authority epoch', 1) !== authority.epoch
    || event.meta.sourceVersion !== authority.version
    || event.meta.sourceInstanceId !== authority.instanceId) fail('producer authority is stale or forged', 'SNTSS_AUTHORITY_STALE');
  const now = integer(context?.trustedNowMs, 'trusted current time');
  if (event.at > now) fail('semantic event is issued in the future', 'SNTSS_CLOCK_ANOMALY');
  if (now > event.deadlineAt) fail('semantic event deadline expired', 'SNTSS_EVENT_EXPIRED');
  if (event.deadlineAt - event.at > policy.limits.maxDurationMs) fail('semantic event duration exceeds policy', 'SNTSS_EVENT_DEADLINE');
  validatePayload(event.payload, policy);
  const causal = validateCausalChain(event, state, context);
  return {
    authority,
    ...causal,
    record: {
      id: event.id, sequence: event.sequence, sourceCore: event.meta.sourceCore,
      topic: event.topic, causalParent: event.meta.causalParent, verified: true
    }
  };
}

module.exports = {
  HASH, UNTRUSTED_SOURCES, containsChemicalCommand, verifyLedgerEnvelope,
  validatePayload, validateCausalChain, validateAuthoritativeEvent, hash
};
