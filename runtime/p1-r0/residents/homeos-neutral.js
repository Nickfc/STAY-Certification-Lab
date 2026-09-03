'use strict';

const { stableStringify } = require('../../kernel/canonical-json');
const { createHomeosEngine } = require('../homeos-engine');
const {
  RESOURCES,
  boundedInsert,
  clone,
  deepFreeze,
  exact,
  fail,
  frameFromEvent,
  normalizeRuntimeBinding,
  sha256
} = require('../resident-support');

const CORE_ID = 'HOMEOS';
const RESIDENCY_ID = 'resident:homeos';
const VERSION = '0.1.0-p1r0-neutral.1';
const STAGE = 'p1-r0-production-neutral-r143';
const AVAILABILITY_TOPIC = 'metab.energy.availability.v1';
const RESERVE_TOPIC = 'metab.energy.reserve.v1';
const FOUNDER_FIELDS = new Set([
  'recordVersion', 'coreId', 'organismId', 'organismIdentityHash',
  'founderId', 'lineageId', 'residencyId', 'profileId', 'profileHash',
  'profile', 'mode', 'authorityEpoch'
]);
const STATE_FIELDS = new Set([
  'schema', 'runtimeBinding', 'founder', 'engineState', 'pendingAvailability',
  'pendingReserve', 'handledEvents'
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
  inputs: Object.freeze([
    'runtime.organism.binding',
    AVAILABILITY_TOPIC,
    RESERVE_TOPIC
  ]),
  outputs: Object.freeze([]),
  biology: Object.freeze({
    protocol: 'stay-biological-signalling-fabric-v1',
    producerCapabilities: Object.freeze([]),
    consumerRouteLeases: Object.freeze([])
  }),
  resources: RESOURCES
});

function normalizeNeutralFounder(payload, runtimeBinding) {
  exact(payload, FOUNDER_FIELDS, 'HOMEOS neutral founder binding', 'P1_HOMEOS_NEUTRAL_FOUNDER');
  if (
    payload.recordVersion !== 'P1ResidentFounderBindingV1' ||
    payload.coreId !== CORE_ID ||
    payload.residencyId !== RESIDENCY_ID ||
    payload.mode !== 'NEUTRAL' ||
    payload.authorityEpoch !== '0' ||
    !runtimeBinding ||
    payload.organismIdentityHash !== runtimeBinding.identitySha256
  ) fail('HOMEOS neutral founder identity is invalid', 'P1_HOMEOS_NEUTRAL_FOUNDER');
  for (const field of ['organismId', 'founderId', 'lineageId', 'residencyId', 'profileId']) {
    if (typeof payload[field] !== 'string' || !SAFE_ID.test(payload[field])) {
      fail(`HOMEOS neutral founder ${field} is invalid`, 'P1_HOMEOS_NEUTRAL_FOUNDER');
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
  ) fail('HOMEOS neutral founder profile binding is invalid', 'P1_HOMEOS_NEUTRAL_FOUNDER');
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

function createNeutralHomeosInitialState({ binding, founder } = {}) {
  const runtimeBinding = normalizeRuntimeBinding(binding);
  const normalizedFounder = normalizeNeutralFounder(founder, runtimeBinding);
  const engine = createHomeosEngine({
    profile: normalizedFounder.profile,
    identity: engineIdentity(normalizedFounder)
  });
  return deepFreeze({
    schema: 'stay-p1-r0-resident/homeos-neutral-state-v1',
    runtimeBinding: clone(runtimeBinding),
    founder: clone(normalizedFounder),
    engineState: clone(engine.snapshot()),
    pendingAvailability: {},
    pendingReserve: {},
    handledEvents: 0
  });
}

function validatePending(record, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length > 16) {
    fail(`${label} is invalid`, 'P1_HOMEOS_NEUTRAL_STATE');
  }
  for (const key of Object.keys(record)) {
    if (!/^[1-9][0-9]*$/.test(key)) fail(`${label} key is invalid`, 'P1_HOMEOS_NEUTRAL_STATE');
    frameFromEvent({ payload: record[key] }, CORE_ID);
  }
}

function validateState(input) {
  exact(input, STATE_FIELDS, 'HOMEOS neutral resident state', 'P1_HOMEOS_NEUTRAL_STATE');
  if (
    input.schema !== 'stay-p1-r0-resident/homeos-neutral-state-v1' ||
    !Number.isSafeInteger(input.handledEvents) || input.handledEvents < 0
  ) fail('HOMEOS neutral resident state is invalid', 'P1_HOMEOS_NEUTRAL_STATE');
  const runtimeBinding = normalizeRuntimeBinding(input.runtimeBinding);
  const founder = normalizeNeutralFounder(input.founder, runtimeBinding);
  validatePending(input.pendingAvailability, 'HOMEOS pending availability');
  validatePending(input.pendingReserve, 'HOMEOS pending reserve');
  const engine = createHomeosEngine({ profile: founder.profile, identity: engineIdentity(founder) });
  engine.restore(input.engineState);
  if (engine.snapshot().outputSequence !== '0') {
    fail('HOMEOS neutral state contains biological output', 'P1_HOMEOS_NEUTRAL_OUTPUT');
  }
  return deepFreeze({
    schema: input.schema,
    runtimeBinding: clone(runtimeBinding),
    founder: clone(founder),
    engineState: clone(engine.snapshot()),
    pendingAvailability: clone(input.pendingAvailability),
    pendingReserve: clone(input.pendingReserve),
    handledEvents: input.handledEvents
  });
}

async function createCore({ manifest: activeManifest = manifest, initialState, emit = async () => null } = {}) {
  if (
    activeManifest.coreId !== CORE_ID || activeManifest.version !== VERSION ||
    activeManifest.stateSchema !== 1 ||
    stableStringify(activeManifest.inputs) !== stableStringify(manifest.inputs) ||
    stableStringify(activeManifest.outputs) !== stableStringify([]) || typeof emit !== 'function'
  ) fail('HOMEOS neutral manifest mismatch', 'P1_HOMEOS_NEUTRAL_MANIFEST');
  if (!initialState || Object.keys(initialState).length === 0) {
    fail('HOMEOS neutral requires a precommitted founder', 'P1_HOMEOS_NEUTRAL_FOUNDER_REQUIRED');
  }
  let state = clone(validateState(initialState));
  let engine = createHomeosEngine({ profile: state.founder.profile, identity: engineIdentity(state.founder) });
  engine.restore(state.engineState);

  function drainCompletePairs() {
    let transitions = 0;
    while (transitions < 5) {
      const sourceFrame = state.engineState.frameIndex === 0
        ? Object.keys(state.pendingAvailability)
            .map(Number)
            .filter(frame => state.pendingReserve[String(frame)])
            .sort((left, right) => left - right)[0]
        : state.engineState.frameIndex;
      if (!Number.isSafeInteger(sourceFrame) || sourceFrame < 1) return;
      const key = String(sourceFrame);
      if (!state.pendingAvailability[key] || !state.pendingReserve[key]) return;
      const result = engine.advance({
        frameIndex: sourceFrame + 1,
        inputs: [state.pendingAvailability[key], state.pendingReserve[key]]
      });
      if (result.outputs.length !== 0 || result.state.outputSequence !== '0') {
        fail('HOMEOS neutral output firewall failed', 'P1_HOMEOS_NEUTRAL_OUTPUT');
      }
      state.engineState = clone(result.state);
      delete state.pendingAvailability[key];
      delete state.pendingReserve[key];
      transitions += 1;
    }
  }

  return Object.freeze({
    async start() { state = clone(validateState(state)); },
    async handle(event) {
      if (event?.topic === 'runtime.organism.binding') {
        const binding = normalizeRuntimeBinding(event.payload);
        if (sha256(binding) !== sha256(state.runtimeBinding)) {
          fail('HOMEOS neutral runtime identity cannot change', 'P1_HOMEOS_NEUTRAL_IDENTITY');
        }
        return;
      }
      if (![AVAILABILITY_TOPIC, RESERVE_TOPIC].includes(event?.topic)) {
        fail('HOMEOS neutral input is forbidden', 'P1_HOMEOS_NEUTRAL_INPUT');
      }
      const frame = frameFromEvent(event, CORE_ID);
      if (frame) {
        const key = String(frame.committedFrame);
        if (event.topic === AVAILABILITY_TOPIC) boundedInsert(state.pendingAvailability, key, frame);
        else boundedInsert(state.pendingReserve, key, frame);
        drainCompletePairs();
      }
      state.handledEvents += 1;
    },
    async snapshot() { return clone(validateState(state)); },
    async health() {
      const verified = validateState(state);
      return Object.freeze({
        ok: true,
        mode: 'NEUTRAL',
        authorityOwned: false,
        foundered: true,
        lifecycle: verified.engineState.lifecycle,
        frameIndex: verified.engineState.frameIndex,
        pendingFrames: Object.keys(verified.pendingAvailability).length + Object.keys(verified.pendingReserve).length,
        biologicalOutputs: 0,
        physiologicalInputs: verified.handledEvents,
        outputPolicy: 'FORBIDDEN_UNTIL_INTERO_ATTACHMENT'
      });
    },
    async stop() {}
  });
}

async function migrateState({ state, fromSchema, toSchema }) {
  if (fromSchema !== 1 || toSchema !== 1) {
    fail(`unsupported HOMEOS neutral migration ${fromSchema}->${toSchema}`, 'P1_HOMEOS_NEUTRAL_MIGRATION');
  }
  return clone(validateState(state));
}

module.exports = Object.freeze({
  AVAILABILITY_TOPIC,
  CORE_ID,
  RESERVE_TOPIC,
  RESIDENCY_ID,
  STAGE,
  VERSION,
  createCore,
  createNeutralHomeosInitialState,
  manifest,
  migrateState,
  normalizeNeutralFounder,
  validateState
});
