'use strict';

const { stableStringify } = require('../../kernel/canonical-json');
const { createMetabEngine } = require('../metab-engine');
const {
  RESOURCES,
  clone,
  deepFreeze,
  exact,
  fail,
  normalizeRuntimeBinding,
  sha256
} = require('../resident-support');

const CORE_ID = 'METAB';
const RESIDENCY_ID = 'resident:metab';
const VERSION = '0.1.0-p1r0-neutral.1';
const STAGE = 'p1-r0-production-neutral-r124';
const FOUNDER_FIELDS = new Set([
  'recordVersion', 'coreId', 'organismId', 'organismIdentityHash',
  'founderId', 'lineageId', 'residencyId', 'profileId', 'profileHash',
  'profile', 'mode', 'authorityEpoch'
]);
const STATE_FIELDS = new Set([
  'schema', 'runtimeBinding', 'founder', 'engineState', 'pendingEligible',
  'pendingQuality', 'handledEvents'
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
  exact(payload, FOUNDER_FIELDS, 'METAB neutral founder binding', 'P1_METAB_NEUTRAL_FOUNDER');
  if (
    payload.recordVersion !== 'P1ResidentFounderBindingV1' ||
    payload.coreId !== CORE_ID ||
    payload.residencyId !== RESIDENCY_ID ||
    payload.mode !== 'NEUTRAL' ||
    payload.authorityEpoch !== '0' ||
    !runtimeBinding ||
    payload.organismIdentityHash !== runtimeBinding.identitySha256
  ) {
    fail('METAB neutral founder identity is invalid', 'P1_METAB_NEUTRAL_FOUNDER');
  }
  for (const field of ['organismId', 'founderId', 'lineageId', 'residencyId', 'profileId']) {
    if (typeof payload[field] !== 'string' || !SAFE_ID.test(payload[field])) {
      fail(`METAB neutral founder ${field} is invalid`, 'P1_METAB_NEUTRAL_FOUNDER');
    }
  }
  if (
    !HASH.test(String(payload.organismIdentityHash || '')) ||
    !HASH.test(String(payload.profileHash || '')) ||
    !payload.profile ||
    typeof payload.profile !== 'object' ||
    Array.isArray(payload.profile) ||
    payload.profile.profileId !== payload.profileId ||
    sha256(payload.profile) !== payload.profileHash
  ) {
    fail('METAB neutral founder profile binding is invalid', 'P1_METAB_NEUTRAL_FOUNDER');
  }
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

function createNeutralMetabInitialState({ binding, founder } = {}) {
  const runtimeBinding = normalizeRuntimeBinding(binding);
  const normalizedFounder = normalizeNeutralFounder(founder, runtimeBinding);
  const engine = createMetabEngine({
    profile: normalizedFounder.profile,
    identity: engineIdentity(normalizedFounder)
  });
  return deepFreeze({
    schema: 'stay-p1-r0-resident/metab-state-v1',
    runtimeBinding: clone(runtimeBinding),
    founder: clone(normalizedFounder),
    engineState: clone(engine.snapshot()),
    pendingEligible: null,
    pendingQuality: null,
    handledEvents: 0
  });
}

function validateState(input) {
  exact(input, STATE_FIELDS, 'METAB neutral resident state', 'P1_METAB_NEUTRAL_STATE');
  if (
    input.schema !== 'stay-p1-r0-resident/metab-state-v1' ||
    !Number.isSafeInteger(input.handledEvents) ||
    input.handledEvents !== 0 ||
    input.pendingEligible !== null ||
    input.pendingQuality !== null
  ) {
    fail('METAB neutral state is not output-forbidden', 'P1_METAB_NEUTRAL_STATE');
  }
  const runtimeBinding = normalizeRuntimeBinding(input.runtimeBinding);
  const founder = normalizeNeutralFounder(input.founder, runtimeBinding);
  const engine = createMetabEngine({
    profile: founder.profile,
    identity: engineIdentity(founder)
  });
  engine.restore(input.engineState);
  if (
    engine.snapshot().frameIndex !== 0 ||
    engine.snapshot().outputSequence !== '0'
  ) {
    fail('METAB neutral state contains physiological activity', 'P1_METAB_NEUTRAL_ACTIVITY');
  }
  return deepFreeze({
    schema: input.schema,
    runtimeBinding: clone(runtimeBinding),
    founder: clone(founder),
    engineState: clone(engine.snapshot()),
    pendingEligible: null,
    pendingQuality: null,
    handledEvents: 0
  });
}

async function createCore({
  manifest: activeManifest = manifest,
  initialState,
  emit = async () => null
} = {}) {
  if (
    activeManifest.coreId !== CORE_ID ||
    activeManifest.version !== VERSION ||
    activeManifest.stateSchema !== 1 ||
    stableStringify(activeManifest.inputs) !== stableStringify(['runtime.organism.binding']) ||
    stableStringify(activeManifest.outputs) !== stableStringify([])
  ) {
    fail('METAB neutral manifest mismatch', 'P1_METAB_NEUTRAL_MANIFEST');
  }
  if (typeof emit !== 'function') {
    fail('METAB neutral emitter boundary is invalid', 'P1_METAB_NEUTRAL_MANIFEST');
  }
  if (!initialState || Object.keys(initialState).length === 0) {
    fail('METAB neutral requires a precommitted founder', 'P1_METAB_NEUTRAL_FOUNDER_REQUIRED');
  }
  let state = validateState(initialState);

  return Object.freeze({
    async start() {
      state = validateState(state);
    },

    async handle(event) {
      if (event?.topic !== 'runtime.organism.binding') {
        fail('METAB neutral input is forbidden', 'P1_METAB_NEUTRAL_INPUT_FORBIDDEN');
      }
      const next = normalizeRuntimeBinding(event.payload);
      if (sha256(next) !== sha256(state.runtimeBinding)) {
        fail('METAB neutral runtime identity cannot change', 'P1_METAB_NEUTRAL_IDENTITY_FENCE');
      }
    },

    async snapshot() {
      return clone(validateState(state));
    },

    async health() {
      return Object.freeze({
        ok: true,
        mode: 'NEUTRAL',
        authorityOwned: false,
        foundered: true,
        lifecycle: 'NEUTRAL',
        frameIndex: 0,
        biologicalOutputs: 0,
        physiologicalInputs: 0
      });
    },

    async stop() {}
  });
}

async function migrateState({ state, fromSchema, toSchema }) {
  if (fromSchema !== 1 || toSchema !== 1) {
    fail(
      `unsupported METAB neutral migration ${fromSchema}->${toSchema}`,
      'P1_METAB_NEUTRAL_MIGRATION'
    );
  }
  return clone(validateState(state));
}

module.exports = Object.freeze({
  CORE_ID,
  RESIDENCY_ID,
  VERSION,
  STAGE,
  createCore,
  createNeutralMetabInitialState,
  manifest,
  migrateState,
  normalizeNeutralFounder,
  validateState
});
