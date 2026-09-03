'use strict';

const { stableStringify } = require('../../kernel/canonical-json');
const { createInteroEngine } = require('../intero-engine');
const {
  RESOURCES, clone, deepFreeze, exact, fail, normalizeRuntimeBinding, sha256
} = require('../resident-support');

const CORE_ID = 'INTERO';
const RESIDENCY_ID = 'resident:intero';
const VERSION = '0.1.0-p1r0-neutral.1';
const STAGE = 'p1-r0-production-neutral-r147';
const FOUNDER_FIELDS = new Set([
  'recordVersion', 'coreId', 'organismId', 'organismIdentityHash',
  'founderId', 'lineageId', 'residencyId', 'profileId', 'profileHash',
  'profile', 'mode', 'authorityEpoch'
]);
const STATE_FIELDS = new Set([
  'schema', 'runtimeBinding', 'founder', 'engineState', 'lastProjection',
  'handledEvents'
]);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

const manifest = Object.freeze({
  coreId: CORE_ID,
  version: VERSION,
  protocol: 'stay-p1-r0-resident-v1',
  stateSchema: 1,
  hotSwap: true,
  priority: 'optional',
  stage: STAGE,
  productionEligible: false,
  inputs: Object.freeze(['runtime.organism.binding']),
  outputs: Object.freeze([]),
  biology: Object.freeze({
    protocol: 'stay-biological-signalling-fabric-v1',
    producerCapabilities: Object.freeze([]),
    consumerRouteLeases: Object.freeze([])
  }),
  resources: RESOURCES
});

function normalizeNeutralFounder(payload, runtimeBinding) {
  exact(payload, FOUNDER_FIELDS, 'INTERO neutral founder binding', 'P1_INTERO_NEUTRAL_FOUNDER');
  if (
    payload.recordVersion !== 'P1ResidentFounderBindingV1' ||
    payload.coreId !== CORE_ID || payload.residencyId !== RESIDENCY_ID ||
    payload.mode !== 'NEUTRAL' || payload.authorityEpoch !== '0' ||
    !runtimeBinding || payload.organismIdentityHash !== runtimeBinding.identitySha256
  ) fail('INTERO neutral founder identity is invalid', 'P1_INTERO_NEUTRAL_FOUNDER');
  for (const field of ['organismId', 'founderId', 'lineageId', 'residencyId', 'profileId']) {
    if (typeof payload[field] !== 'string' || !SAFE_ID.test(payload[field])) {
      fail(`INTERO neutral founder ${field} is invalid`, 'P1_INTERO_NEUTRAL_FOUNDER');
    }
  }
  if (
    !HASH.test(String(payload.organismIdentityHash || '')) ||
    !HASH.test(String(payload.profileHash || '')) ||
    !payload.profile || typeof payload.profile !== 'object' || Array.isArray(payload.profile) ||
    payload.profile.profileId !== payload.profileId || sha256(payload.profile) !== payload.profileHash
  ) fail('INTERO neutral founder profile binding is invalid', 'P1_INTERO_NEUTRAL_FOUNDER');
  return deepFreeze(clone(payload));
}

function engineIdentity(founder) {
  return deepFreeze({
    organismId: founder.organismId,
    founderLineageId: founder.lineageId,
    residencyId: founder.residencyId,
    coreVersion: VERSION,
    authorityEpoch: '0',
    mode: 'NEUTRAL'
  });
}

function createNeutralInteroInitialState({ binding, founder } = {}) {
  const runtimeBinding = normalizeRuntimeBinding(binding);
  const normalizedFounder = normalizeNeutralFounder(founder, runtimeBinding);
  const engine = createInteroEngine({
    profile: normalizedFounder.profile,
    identity: engineIdentity(normalizedFounder)
  });
  return deepFreeze({
    schema: 'stay-p1-r0-resident/intero-neutral-state-v1',
    runtimeBinding: clone(runtimeBinding),
    founder: clone(normalizedFounder),
    engineState: clone(engine.snapshot()),
    lastProjection: null,
    handledEvents: 0
  });
}

function validateState(input) {
  exact(input, STATE_FIELDS, 'INTERO neutral state', 'P1_INTERO_NEUTRAL_STATE');
  if (
    input.schema !== 'stay-p1-r0-resident/intero-neutral-state-v1' ||
    input.lastProjection !== null || input.handledEvents !== 0
  ) fail('INTERO neutral state is invalid', 'P1_INTERO_NEUTRAL_STATE');
  const runtimeBinding = normalizeRuntimeBinding(input.runtimeBinding);
  const founder = normalizeNeutralFounder(input.founder, runtimeBinding);
  const engine = createInteroEngine({ profile: founder.profile, identity: engineIdentity(founder) });
  engine.restore(input.engineState);
  if (engine.snapshot().frameIndex !== 0 || engine.snapshot().outputSequence !== '0') {
    fail('INTERO neutral state contains perception or output', 'P1_INTERO_NEUTRAL_OUTPUT');
  }
  return deepFreeze({
    schema: input.schema,
    runtimeBinding: clone(runtimeBinding),
    founder: clone(founder),
    engineState: clone(engine.snapshot()),
    lastProjection: null,
    handledEvents: 0
  });
}

async function createCore({ manifest: activeManifest = manifest, initialState, emit = async () => null } = {}) {
  if (
    activeManifest.coreId !== CORE_ID || activeManifest.version !== VERSION ||
    activeManifest.stateSchema !== 1 ||
    stableStringify(activeManifest.inputs) !== stableStringify(manifest.inputs) ||
    stableStringify(activeManifest.outputs) !== stableStringify([]) || typeof emit !== 'function'
  ) fail('INTERO neutral manifest mismatch', 'P1_INTERO_NEUTRAL_MANIFEST');
  if (!initialState || Object.keys(initialState).length === 0) {
    fail('INTERO neutral requires a precommitted founder', 'P1_INTERO_NEUTRAL_FOUNDER_REQUIRED');
  }
  let state = clone(validateState(initialState));
  return Object.freeze({
    async start() { state = clone(validateState(state)); },
    async handle(event) {
      if (event?.topic !== 'runtime.organism.binding') {
        fail('INTERO neutral input is forbidden', 'P1_INTERO_NEUTRAL_INPUT');
      }
      const next = normalizeRuntimeBinding(event.payload);
      if (sha256(next) !== sha256(state.runtimeBinding)) {
        fail('INTERO neutral runtime identity cannot change', 'P1_INTERO_NEUTRAL_IDENTITY');
      }
    },
    async snapshot() { return clone(validateState(state)); },
    async health() {
      validateState(state);
      return Object.freeze({
        ok: true,
        mode: 'NEUTRAL',
        authorityOwned: false,
        foundered: true,
        lifecycle: 'INITIALIZING',
        frameIndex: 0,
        projectionAvailable: false,
        biologicalOutputs: 0,
        physiologicalInputs: 0,
        receptorRoute: 'ABSENT',
        outputPolicy: 'PERCEPTION_ONLY_NO_OUTPUT'
      });
    },
    async stop() {}
  });
}

async function migrateState({ state, fromSchema, toSchema }) {
  if (fromSchema !== 1 || toSchema !== 1) {
    fail(`unsupported INTERO neutral migration ${fromSchema}->${toSchema}`, 'P1_INTERO_NEUTRAL_MIGRATION');
  }
  return clone(validateState(state));
}

module.exports = Object.freeze({
  CORE_ID,
  RESIDENCY_ID,
  STAGE,
  VERSION,
  createCore,
  createNeutralInteroInitialState,
  manifest,
  migrateState,
  normalizeNeutralFounder,
  validateState
});
