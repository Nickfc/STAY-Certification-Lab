'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../kernel/canonical-json');
const { validateCausalFrame } = require('./causal-frame');
const { validateFrameRoute } = require('./contract-registry');

const FOUNDER_TOPICS = Object.freeze({
  METAB: 'p1r0.metab.founder.binding.v1',
  HOMEOS: 'p1r0.homeos.founder.binding.v1',
  INTERO: 'p1r0.intero.founder.binding.v1'
});
const HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const FOUNDER_FIELDS = new Set([
  'recordVersion', 'coreId', 'organismId', 'organismIdentityHash',
  'founderId', 'lineageId', 'residencyId', 'profileId', 'profileHash',
  'profile', 'mode', 'authorityEpoch'
]);

const RESOURCES = Object.freeze({
  softRamMiB: 64,
  hardRamMiB: 96,
  softCpuPercent: 5,
  hardCpuPercent: 20,
  pidsMax: 16,
  queueCapacity: 256,
  handlerTimeoutMs: 250,
  healthTimeoutMs: 1000,
  outputCapacity: 128,
  outputLimitPerEvent: 16,
  outputBytesPerEvent: 65536,
  storageMiB: 4,
  maxRestarts: 4,
  restartWindowMs: 60_000,
  restartBackoffMs: 250
});

function fail(message, code = 'P1_RESIDENT_SCHEMA') {
  throw Object.assign(new Error(message), { code });
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

function exact(value, fields, label, code = 'P1_RESIDENT_SCHEMA') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`, code);
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`${label} fields are not exact`, code);
  }
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function normalizeRuntimeBinding(payload) {
  const canonical = payload && typeof payload === 'object' && !Array.isArray(payload) &&
    Object.keys(payload).length === 3 &&
    Object.hasOwn(payload, 'identitySha256') &&
    Object.hasOwn(payload, 'organismLineage') &&
    Object.hasOwn(payload, 'runtimeRevision');
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    (!canonical && payload.bindingVersion !== 1) ||
    typeof payload.identitySha256 !== 'string' ||
    !HASH.test(payload.identitySha256) ||
    payload.organismLineage !== 'STAY/Genesis' ||
    !Number.isSafeInteger(payload.runtimeRevision) ||
    payload.runtimeRevision < 1
  ) fail('P1 resident runtime binding is invalid', 'P1_RESIDENT_RUNTIME_BINDING');
  return deepFreeze({
    identitySha256: payload.identitySha256,
    organismLineage: payload.organismLineage,
    runtimeRevision: payload.runtimeRevision
  });
}

function normalizeFounderBinding(payload, { coreId, residencyId, runtimeBinding }) {
  exact(payload, FOUNDER_FIELDS, 'P1 resident founder binding', 'P1_RESIDENT_FOUNDER');
  if (
    payload.recordVersion !== 'P1ResidentFounderBindingV1' ||
    payload.coreId !== coreId ||
    payload.residencyId !== residencyId ||
    payload.mode !== 'SHADOW' ||
    payload.authorityEpoch !== '0' ||
    !runtimeBinding ||
    payload.organismIdentityHash !== runtimeBinding.identitySha256
  ) fail('P1 resident founder binding identity is invalid', 'P1_RESIDENT_FOUNDER');
  for (const field of ['organismId', 'founderId', 'lineageId', 'residencyId', 'profileId']) {
    safeId(payload[field], `P1 founder ${field}`);
  }
  if (!HASH.test(payload.organismIdentityHash) || !HASH.test(payload.profileHash)) {
    fail('P1 resident founder hash is invalid', 'P1_RESIDENT_FOUNDER');
  }
  if (!payload.profile || typeof payload.profile !== 'object' || Array.isArray(payload.profile)) {
    fail('P1 resident founder profile is invalid', 'P1_RESIDENT_FOUNDER');
  }
  if (payload.profile.profileId !== payload.profileId || sha256(payload.profile) !== payload.profileHash) {
    fail('P1 resident founder profile binding is invalid', 'P1_RESIDENT_FOUNDER');
  }
  return deepFreeze(clone(payload));
}

function engineIdentity(founder, version) {
  return deepFreeze({
    organismId: founder.organismId,
    founderLineageId: founder.lineageId,
    residencyId: founder.residencyId,
    coreVersion: version,
    authorityEpoch: '0',
    mode: 'SHADOW'
  });
}

function frameFromEvent(event, consumerCoreId) {
  const payload = event?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('P1 resident causal-frame payload is invalid', 'P1_RESIDENT_FRAME');
  }
  const frame = validateCausalFrame(payload);
  validateFrameRoute(frame);
  if (frame.route?.consumerCoreId !== consumerCoreId) return null;
  return frame;
}

function boundedInsert(record, key, value, maximum = 16) {
  if (!Object.hasOwn(record, key) && Object.keys(record).length >= maximum) {
    fail('P1 resident pending-frame bound exceeded', 'P1_RESIDENT_PENDING_BOUND');
  }
  const existing = record[key];
  const digest = sha256(value);
  if (existing && sha256(existing) !== digest) {
    fail('P1 resident pending frame conflicts with retained evidence', 'P1_RESIDENT_REPLAY_CONFLICT');
  }
  record[key] = clone(value);
}

module.exports = Object.freeze({
  FOUNDER_TOPICS,
  RESOURCES,
  boundedInsert,
  clone,
  deepFreeze,
  engineIdentity,
  exact,
  fail,
  frameFromEvent,
  normalizeFounderBinding,
  normalizeRuntimeBinding,
  sha256
});
