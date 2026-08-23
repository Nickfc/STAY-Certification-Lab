'use strict';

const HASH = /^sha256:[0-9a-f]{64}$/;

const manifest = Object.freeze({
  coreId: 'sntss',
  version: '0.0.0-neutral',
  protocol: 'stay-sntss-v1',
  stateSchema: 1,
  hotSwap: true,
  priority: 'optional',
  stage: 'neutral-production',
  inputs: Object.freeze(['runtime.organism.binding', 'runtime.time.pulse']),
  outputs: Object.freeze([]),
  resources: Object.freeze({
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
    restartWindowMs: 60000,
    restartBackoffMs: 250
  })
});

function fail(message, code) { throw Object.assign(new Error(message), { code }); }
function integer(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`invalid ${field}`, 'SNTSS_STATE_INVALID');
  return value;
}

function normalizeBinding(payload, event) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('organism binding payload is invalid', 'SNTSS_BINDING_INVALID');
  const allowed = new Set(['bindingVersion', 'identitySha256', 'organismLineage', 'issuedAt', 'runtimeRevision', 'authorityEpoch', 'kernelVersion']);
  for (const key of Object.keys(payload)) if (!allowed.has(key)) fail(`organism binding field is not allowed: ${key}`, 'SNTSS_BINDING_INVALID');
  if (payload.bindingVersion !== 1) fail('organism binding version is unsupported', 'SNTSS_BINDING_VERSION');
  if (!HASH.test(payload.identitySha256)) fail('organism identity hash is invalid', 'SNTSS_BINDING_INVALID');
  if (payload.organismLineage !== 'STAY/Genesis') fail('organism lineage is invalid', 'SNTSS_BINDING_INVALID');
  if (typeof payload.kernelVersion !== 'string' || !payload.kernelVersion) fail('kernel version is missing', 'SNTSS_BINDING_INVALID');
  integer(payload.issuedAt, 'binding issue time');
  if (payload.issuedAt > event.at) fail('organism binding issue time is in the future', 'SNTSS_BINDING_INVALID');
  integer(payload.runtimeRevision, 'runtime revision', 1);
  integer(payload.authorityEpoch, 'authority epoch', 1);
  if (event.meta?.sourceCore !== 'living-kernel' || Number(event.meta?.authorityEpoch) !== payload.authorityEpoch) {
    fail('organism binding is not Kernel-authoritative', 'SNTSS_BINDING_AUTHORITY');
  }
  return Object.freeze({
    bindingVersion: 1,
    identitySha256: payload.identitySha256,
    organismLineage: payload.organismLineage,
    issuedAt: payload.issuedAt,
    runtimeRevision: payload.runtimeRevision,
    authorityEpoch: payload.authorityEpoch,
    kernelVersion: payload.kernelVersion,
    bindingEventId: event.id
  });
}

function normalizeState(initialState, version) {
  const source = initialState && typeof initialState === 'object' && !Array.isArray(initialState) ? initialState : {};
  const existing = Object.keys(source).length > 0;
  if (existing) {
    const allowed = new Set(['formatVersion', 'stateSchema', 'protocol', 'coreVersion', 'stage', 'organismBinding', 'transmitters', 'receptors', 'migrations']);
    for (const key of Object.keys(source)) if (!allowed.has(key)) fail(`persisted neutral field is not allowed: ${key}`, 'SNTSS_STATE_INVALID');
    if (source.formatVersion !== 1 || source.stateSchema !== 1 || source.protocol !== 'stay-sntss-v1' || source.stage !== 'neutral') {
      fail('persisted neutral state header is invalid', 'SNTSS_STATE_INVALID');
    }
    if (typeof source.coreVersion !== 'string' || !source.coreVersion) fail('persisted neutral core version is invalid', 'SNTSS_STATE_INVALID');
    if (!source.transmitters || Array.isArray(source.transmitters) || Object.keys(source.transmitters).length !== 0) fail('neutral state contains transmitter data', 'SNTSS_STATE_INVALID');
    if (!source.receptors || Array.isArray(source.receptors) || Object.keys(source.receptors).length !== 0) fail('neutral state contains receptor data', 'SNTSS_STATE_INVALID');
    if (!Array.isArray(source.migrations) || source.migrations.length > 64) fail('persisted migration history is invalid', 'SNTSS_STATE_INVALID');
  }
  const binding = source.organismBinding == null ? null : Object.freeze({ ...source.organismBinding });
  if (binding) {
    if (binding.bindingVersion !== 1 || !HASH.test(binding.identitySha256) || binding.organismLineage !== 'STAY/Genesis') {
      fail('persisted neutral binding is invalid', 'SNTSS_STATE_INVALID');
    }
    integer(binding.issuedAt, 'persisted binding issue time');
    integer(binding.runtimeRevision, 'persisted runtime revision', 1);
    integer(binding.authorityEpoch, 'persisted authority epoch', 1);
    if (typeof binding.bindingEventId !== 'string' || !binding.bindingEventId) fail('persisted binding event is invalid', 'SNTSS_STATE_INVALID');
  }
  return {
    formatVersion: 1,
    stateSchema: 1,
    protocol: 'stay-sntss-v1',
    coreVersion: version,
    stage: 'neutral',
    organismBinding: binding,
    transmitters: {},
    receptors: {},
    migrations: Array.isArray(source.migrations) ? source.migrations.map(String).slice(0, 64) : []
  };
}

function sameBinding(left, right) {
  return left.identitySha256 === right.identitySha256
    && left.organismLineage === right.organismLineage
    && left.bindingVersion === right.bindingVersion;
}

async function createCore({ manifest: activeManifest, initialState }) {
  const state = normalizeState(initialState, activeManifest.version);
  return {
    async start() { normalizeState(state, activeManifest.version); },
    async handle(event) {
      if (event.topic === 'runtime.organism.binding') {
        const incoming = normalizeBinding(event.payload, event);
        if (state.organismBinding && !sameBinding(state.organismBinding, incoming)) {
          fail('organism binding changed after first acceptance', 'SNTSS_BINDING_MISMATCH');
        }
        if (!state.organismBinding) state.organismBinding = incoming;
        return;
      }
      if (event.topic === 'runtime.time.pulse') {
        const pulse = event.payload || {};
        const allowed = new Set(['wallClockMs', 'runtimeRevision', 'pulseSequence', 'clockStatus']);
        for (const key of Object.keys(pulse)) if (!allowed.has(key)) fail(`time pulse field is not allowed: ${key}`, 'SNTSS_TIME_INVALID');
        if (event.meta?.sourceCore !== 'living-kernel') fail('time pulse is not Kernel-authoritative', 'SNTSS_TIME_AUTHORITY');
        integer(pulse.wallClockMs, 'time pulse wall clock');
        integer(pulse.runtimeRevision, 'time pulse runtime revision', 1);
        integer(pulse.pulseSequence, 'time pulse sequence', 1);
        if (!['trusted', 'degraded', 'uncertain'].includes(pulse.clockStatus)) fail('time pulse clock status is invalid', 'SNTSS_TIME_INVALID');
      }
    },
    async snapshot() { return normalizeState(state, activeManifest.version); },
    async health() {
      return {
        ok: true,
        stage: 'neutral',
        bound: Boolean(state.organismBinding),
        chemistryActive: false,
        biologicalOutputs: 0
      };
    },
    async stop() {}
  };
}

async function migrateState({ state, fromSchema, toSchema }) {
  if (Number(fromSchema) !== 1 || Number(toSchema) !== 1) fail('unsupported neutral state migration', 'SNTSS_MIGRATION_UNSUPPORTED');
  return normalizeState(state, manifest.version);
}

module.exports = { manifest, createCore, migrateState, normalizeState };
