'use strict';

const { stableStringify } = require('../../kernel/canonical-json');
const {
  RESOURCES,
  clone,
  deepFreeze,
  exact,
  fail,
  normalizeRuntimeBinding,
  sha256
} = require('../resident-support');
const neutral = require('./homeos-neutral');

const CORE_ID = 'HOMEOS';
const RESIDENCY_ID = 'resident:homeos';
const VERSION = '0.2.0-p1r0-shadow.1';
const STAGE = 'p1-r0-production-output-firewalled-shadow-r145';
const ACTIVATION_TOPIC = 'runtime.homeos.shadow-activation';
const OUTPUT_POLICY = 'FORBIDDEN_UNTIL_INTERO_ATTACHMENT';
const HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const ACTIVATION_PAYLOAD_FIELDS = new Set([
  'protocol', 'organismIdentityHash', 'residencyId', 'instanceId',
  'fromVersion', 'fromStateSchema', 'sourceCheckpointGeneration',
  'sourceCheckpointHash', 'toVersion', 'toStateSchema', 'targetRevision',
  'parentRevision', 'parentFreezeRecordSha256', 'mode', 'authorityEpoch',
  'outputPolicy'
]);
const ACTIVATION_FIELDS = new Set([...ACTIVATION_PAYLOAD_FIELDS, 'eventId', 'eventSequence']);
const STATE_FIELDS = new Set(['schema', 'activation', 'neutralState']);

const manifest = Object.freeze({
  coreId: CORE_ID,
  version: VERSION,
  protocol: 'stay-p1-r0-resident-v1',
  stateSchema: 2,
  hotSwap: true,
  priority: 'optional',
  stage: STAGE,
  productionEligible: false,
  inputs: Object.freeze([...neutral.manifest.inputs, ACTIVATION_TOPIC]),
  outputs: Object.freeze([]),
  biology: Object.freeze({
    protocol: 'stay-biological-signalling-fabric-v1',
    producerCapabilities: Object.freeze([]),
    consumerRouteLeases: Object.freeze([])
  }),
  resources: RESOURCES
});

function normalizeActivationPayload(payload) {
  exact(payload, ACTIVATION_PAYLOAD_FIELDS, 'HOMEOS shadow activation', 'P1_HOMEOS_SHADOW_ACTIVATION');
  if (
    payload.protocol !== 'stay-p1-r0-homeos-shadow-activation-v1' ||
    payload.residencyId !== RESIDENCY_ID ||
    payload.fromVersion !== neutral.VERSION || payload.fromStateSchema !== 1 ||
    payload.toVersion !== VERSION || payload.toStateSchema !== 2 ||
    payload.targetRevision !== 145 || payload.parentRevision !== 141 ||
    payload.mode !== 'SHADOW' || payload.authorityEpoch !== '0' ||
    payload.outputPolicy !== OUTPUT_POLICY ||
    !HASH.test(String(payload.organismIdentityHash || '')) ||
    !HASH.test(String(payload.sourceCheckpointHash || '')) ||
    !HASH.test(String(payload.parentFreezeRecordSha256 || '')) ||
    !Number.isSafeInteger(payload.sourceCheckpointGeneration) || payload.sourceCheckpointGeneration < 1 ||
    typeof payload.instanceId !== 'string' || !SAFE_ID.test(payload.instanceId)
  ) fail('HOMEOS shadow activation is invalid', 'P1_HOMEOS_SHADOW_ACTIVATION');
  return deepFreeze(clone(payload));
}

function normalizeActivation(payload, event) {
  const normalized = normalizeActivationPayload(payload);
  if (
    event?.topic !== ACTIVATION_TOPIC || event?.ledger?.durable !== true ||
    !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
    typeof event.id !== 'string' || !SAFE_ID.test(event.id) ||
    event.meta?.sourceCore !== 'living-kernel' ||
    event.meta?.authorityEpoch !== normalized.targetRevision ||
    event.meta?.evidenceHash !== normalized.organismIdentityHash
  ) fail('HOMEOS activation provenance is invalid', 'P1_HOMEOS_SHADOW_ACTIVATION');
  return deepFreeze({ ...clone(normalized), eventId: event.id, eventSequence: event.sequence });
}

function createShadowStagingState(neutralState) {
  return deepFreeze({
    schema: 'stay-p1-r0-resident/homeos-shadow-state-v2',
    activation: null,
    neutralState: clone(neutral.validateState(neutralState))
  });
}

function validateState(input) {
  exact(input, STATE_FIELDS, 'HOMEOS shadow state', 'P1_HOMEOS_SHADOW_STATE');
  if (input.schema !== 'stay-p1-r0-resident/homeos-shadow-state-v2') {
    fail('HOMEOS shadow state is invalid', 'P1_HOMEOS_SHADOW_STATE');
  }
  const neutralState = neutral.validateState(input.neutralState);
  let activation = null;
  if (input.activation !== null) {
    exact(input.activation, ACTIVATION_FIELDS, 'stored HOMEOS activation', 'P1_HOMEOS_SHADOW_STATE');
    const payload = {};
    for (const field of ACTIVATION_PAYLOAD_FIELDS) payload[field] = input.activation[field];
    activation = normalizeActivationPayload(payload);
    if (
      typeof input.activation.eventId !== 'string' || !SAFE_ID.test(input.activation.eventId) ||
      !Number.isSafeInteger(input.activation.eventSequence) || input.activation.eventSequence < 1 ||
      activation.organismIdentityHash !== neutralState.runtimeBinding.identitySha256
    ) fail('stored HOMEOS activation is invalid', 'P1_HOMEOS_SHADOW_STATE');
    activation = deepFreeze({ ...clone(activation), eventId: input.activation.eventId, eventSequence: input.activation.eventSequence });
  }
  return deepFreeze({ schema: input.schema, activation: activation === null ? null : clone(activation), neutralState: clone(neutralState) });
}

async function createCore({ manifest: activeManifest = manifest, initialState, emit = async () => null } = {}) {
  if (
    activeManifest.coreId !== CORE_ID || activeManifest.version !== VERSION ||
    activeManifest.stateSchema !== 2 ||
    stableStringify(activeManifest.inputs) !== stableStringify(manifest.inputs) ||
    stableStringify(activeManifest.outputs) !== stableStringify([]) || typeof emit !== 'function'
  ) fail('HOMEOS shadow manifest mismatch', 'P1_HOMEOS_SHADOW_MANIFEST');
  if (!initialState || Object.keys(initialState).length === 0) {
    fail('HOMEOS shadow requires preserved neutral state', 'P1_HOMEOS_SHADOW_STATE');
  }
  let state = clone(validateState(initialState));
  let inner = await neutral.createCore({ initialState: state.neutralState });
  await inner.start();

  async function syncInner() {
    state.neutralState = await inner.snapshot();
  }

  return Object.freeze({
    async start() { state = clone(validateState(state)); },
    async handle(event) {
      if (event?.topic === ACTIVATION_TOPIC) {
        const activation = normalizeActivation(event.payload, event);
        if (state.activation) {
          if (sha256(state.activation) !== sha256(activation)) {
            fail('HOMEOS shadow activation cannot change', 'P1_HOMEOS_SHADOW_ACTIVATION');
          }
          return;
        }
        if (
          activation.organismIdentityHash !== state.neutralState.runtimeBinding.identitySha256 ||
          activation.sourceCheckpointHash !== event.payload.sourceCheckpointHash
        ) fail('HOMEOS shadow activation lost neutral lineage', 'P1_HOMEOS_SHADOW_ACTIVATION');
        state.activation = clone(activation);
        return;
      }
      if (!state.activation && event?.topic !== 'runtime.organism.binding') {
        fail('HOMEOS cannot consume before shadow activation', 'P1_HOMEOS_SHADOW_UNACTIVATED');
      }
      await inner.handle(event);
      await syncInner();
    },
    async snapshot() { await syncInner(); return clone(validateState(state)); },
    async health() {
      await syncInner();
      const verified = validateState(state);
      const innerHealth = await inner.health();
      return Object.freeze({
        ...innerHealth,
        ok: verified.activation !== null,
        mode: 'SHADOW',
        authorityOwned: false,
        activated: verified.activation !== null,
        biologicalOutputs: 0,
        outputPolicy: OUTPUT_POLICY
      });
    },
    async stop() { await inner.stop(); }
  });
}

async function migrateState({ state, fromSchema, toSchema }) {
  if (fromSchema === 1 && toSchema === 2) return clone(createShadowStagingState(state));
  if (fromSchema === 2 && toSchema === 2) return clone(validateState(state));
  fail(`unsupported HOMEOS shadow migration ${fromSchema}->${toSchema}`, 'P1_HOMEOS_SHADOW_MIGRATION');
}

module.exports = Object.freeze({
  ACTIVATION_TOPIC,
  CORE_ID,
  OUTPUT_POLICY,
  RESIDENCY_ID,
  STAGE,
  VERSION,
  createCore,
  createShadowStagingState,
  manifest,
  migrateState,
  normalizeActivationPayload,
  validateState
});
