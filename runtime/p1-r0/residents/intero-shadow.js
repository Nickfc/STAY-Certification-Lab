'use strict';

const { stableStringify } = require('../../kernel/canonical-json');
const { createInteroEngine } = require('../intero-engine');
const {
  RESOURCES, boundedInsert, clone, deepFreeze, exact, fail, frameFromEvent,
  normalizeRuntimeBinding, sha256
} = require('../resident-support');
const neutral = require('./intero-neutral');

const CORE_ID = 'INTERO';
const RESIDENCY_ID = 'resident:intero';
const VERSION = '0.2.0-p1r0-shadow.1';
const STAGE = 'p1-r0-production-perception-only-shadow-r150';
const ACTIVATION_TOPIC = 'runtime.intero.shadow-activation';
const OUTPUT_POLICY = 'PERCEPTION_ONLY_NO_OUTPUT';
const AVAILABILITY_TOPIC = 'metab.energy.availability.v1';
const RESERVE_TOPIC = 'metab.energy.reserve.v1';
const STABILITY_TOPIC = 'homeos.stability.summary.v1';
const HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const FORBIDDEN_SEMANTICS = /fear|pain|emotion|diagnosis|cause|self|action/i;
const ACTIVATION_PAYLOAD_FIELDS = new Set([
  'protocol', 'organismIdentityHash', 'residencyId', 'instanceId',
  'fromVersion', 'fromStateSchema', 'sourceCheckpointGeneration',
  'sourceCheckpointHash', 'toVersion', 'toStateSchema', 'targetRevision',
  'parentRevision', 'parentFreezeRecordSha256', 'mode', 'authorityEpoch',
  'outputPolicy', 'receptorRoute'
]);
const ACTIVATION_FIELDS = new Set([...ACTIVATION_PAYLOAD_FIELDS, 'eventId', 'eventSequence']);
const STATE_FIELDS = new Set([
  'schema', 'activation', 'neutralState', 'engineState',
  'pendingAvailability', 'pendingReserve', 'pendingStability',
  'lastProjection', 'handledEvents'
]);

const manifest = Object.freeze({
  coreId: CORE_ID,
  version: VERSION,
  protocol: 'stay-p1-r0-resident-v1',
  stateSchema: 2,
  hotSwap: true,
  priority: 'optional',
  stage: STAGE,
  productionEligible: false,
  inputs: Object.freeze([
    'runtime.organism.binding',
    ACTIVATION_TOPIC,
    AVAILABILITY_TOPIC,
    RESERVE_TOPIC,
    STABILITY_TOPIC
  ]),
  outputs: Object.freeze([]),
  biology: Object.freeze({
    protocol: 'stay-biological-signalling-fabric-v1',
    producerCapabilities: Object.freeze([]),
    consumerRouteLeases: Object.freeze([])
  }),
  resources: RESOURCES
});

function engineIdentity(founder) {
  return deepFreeze({
    organismId: founder.organismId,
    founderLineageId: founder.lineageId,
    residencyId: founder.residencyId,
    coreVersion: VERSION,
    authorityEpoch: '0',
    mode: 'SHADOW'
  });
}

function normalizeActivationPayload(payload) {
  exact(payload, ACTIVATION_PAYLOAD_FIELDS, 'INTERO shadow activation', 'P1_INTERO_SHADOW_ACTIVATION');
  if (
    payload.protocol !== 'stay-p1-r0-intero-shadow-activation-v1' ||
    payload.residencyId !== RESIDENCY_ID ||
    payload.fromVersion !== neutral.VERSION || payload.fromStateSchema !== 1 ||
    payload.toVersion !== VERSION || payload.toStateSchema !== 2 ||
    payload.targetRevision !== 150 || payload.parentRevision !== 145 ||
    payload.mode !== 'SHADOW' || payload.authorityEpoch !== '0' ||
    payload.outputPolicy !== OUTPUT_POLICY || payload.receptorRoute !== 'ABSENT' ||
    !HASH.test(String(payload.organismIdentityHash || '')) ||
    !HASH.test(String(payload.sourceCheckpointHash || '')) ||
    !HASH.test(String(payload.parentFreezeRecordSha256 || '')) ||
    !Number.isSafeInteger(payload.sourceCheckpointGeneration) || payload.sourceCheckpointGeneration < 1 ||
    typeof payload.instanceId !== 'string' || !SAFE_ID.test(payload.instanceId)
  ) fail('INTERO shadow activation is invalid', 'P1_INTERO_SHADOW_ACTIVATION');
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
  ) fail('INTERO activation provenance is invalid', 'P1_INTERO_SHADOW_ACTIVATION');
  return deepFreeze({ ...clone(normalized), eventId: event.id, eventSequence: event.sequence });
}

function createShadowStagingState(neutralState) {
  const source = neutral.validateState(neutralState);
  const engine = createInteroEngine({
    profile: source.founder.profile,
    identity: engineIdentity(source.founder)
  });
  engine.restore(source.engineState);
  return deepFreeze({
    schema: 'stay-p1-r0-resident/intero-shadow-state-v2',
    activation: null,
    neutralState: clone(source),
    engineState: clone(engine.snapshot()),
    pendingAvailability: {},
    pendingReserve: {},
    pendingStability: {},
    lastProjection: null,
    handledEvents: 0
  });
}

function validatePending(record, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length > 16) {
    fail(`${label} is invalid`, 'P1_INTERO_SHADOW_STATE');
  }
  for (const key of Object.keys(record)) {
    if (!/^[1-9][0-9]*$/.test(key)) fail(`${label} key is invalid`, 'P1_INTERO_SHADOW_STATE');
    frameFromEvent({ payload: record[key] }, CORE_ID);
  }
}

function validateState(input) {
  exact(input, STATE_FIELDS, 'INTERO shadow state', 'P1_INTERO_SHADOW_STATE');
  if (
    input.schema !== 'stay-p1-r0-resident/intero-shadow-state-v2' ||
    !Number.isSafeInteger(input.handledEvents) || input.handledEvents < 0 ||
    (input.lastProjection !== null && (
      !input.lastProjection || typeof input.lastProjection !== 'object' ||
      Array.isArray(input.lastProjection) || FORBIDDEN_SEMANTICS.test(stableStringify(input.lastProjection))
    ))
  ) fail('INTERO shadow state is invalid', 'P1_INTERO_SHADOW_STATE');
  const neutralState = neutral.validateState(input.neutralState);
  const engine = createInteroEngine({
    profile: neutralState.founder.profile,
    identity: engineIdentity(neutralState.founder)
  });
  engine.restore(input.engineState);
  const engineState = engine.snapshot();
  if (engineState.outputSequence !== '0') {
    fail('INTERO shadow state contains biological output', 'P1_INTERO_SHADOW_OUTPUT');
  }
  validatePending(input.pendingAvailability, 'INTERO pending availability');
  validatePending(input.pendingReserve, 'INTERO pending reserve');
  validatePending(input.pendingStability, 'INTERO pending stability');
  let activation = null;
  if (input.activation !== null) {
    exact(input.activation, ACTIVATION_FIELDS, 'stored INTERO activation', 'P1_INTERO_SHADOW_STATE');
    const payload = {};
    for (const field of ACTIVATION_PAYLOAD_FIELDS) payload[field] = input.activation[field];
    activation = normalizeActivationPayload(payload);
    if (
      typeof input.activation.eventId !== 'string' || !SAFE_ID.test(input.activation.eventId) ||
      !Number.isSafeInteger(input.activation.eventSequence) || input.activation.eventSequence < 1 ||
      activation.organismIdentityHash !== neutralState.runtimeBinding.identitySha256
    ) fail('stored INTERO activation is invalid', 'P1_INTERO_SHADOW_STATE');
    activation = deepFreeze({ ...clone(activation), eventId: input.activation.eventId, eventSequence: input.activation.eventSequence });
  }
  return deepFreeze({
    schema: input.schema,
    activation: activation === null ? null : clone(activation),
    neutralState: clone(neutralState),
    engineState: clone(engineState),
    pendingAvailability: clone(input.pendingAvailability),
    pendingReserve: clone(input.pendingReserve),
    pendingStability: clone(input.pendingStability),
    lastProjection: input.lastProjection === null ? null : clone(input.lastProjection),
    handledEvents: input.handledEvents
  });
}

async function createCore({ manifest: activeManifest = manifest, initialState, emit = async () => null } = {}) {
  if (
    activeManifest.coreId !== CORE_ID || activeManifest.version !== VERSION ||
    activeManifest.stateSchema !== 2 ||
    stableStringify(activeManifest.inputs) !== stableStringify(manifest.inputs) ||
    stableStringify(activeManifest.outputs) !== stableStringify([]) || typeof emit !== 'function'
  ) fail('INTERO shadow manifest mismatch', 'P1_INTERO_SHADOW_MANIFEST');
  if (!initialState || Object.keys(initialState).length === 0) {
    fail('INTERO shadow requires preserved neutral state', 'P1_INTERO_SHADOW_STATE');
  }
  let state = clone(validateState(initialState));
  const engine = createInteroEngine({
    profile: state.neutralState.founder.profile,
    identity: engineIdentity(state.neutralState.founder)
  });
  engine.restore(state.engineState);

  function drainCompleteSets() {
    let transitions = 0;
    while (transitions < 16) {
      const sourceFrame = state.engineState.frameIndex === 0
        ? Object.keys(state.pendingAvailability)
            .map(Number)
            .filter(frame =>
              state.pendingReserve[String(frame)] &&
              state.pendingStability[String(frame)]
            )
            .sort((left, right) => left - right)[0]
        : state.engineState.frameIndex - 2;
      if (!Number.isSafeInteger(sourceFrame) || sourceFrame < 1) return;
      const key = String(sourceFrame);
      if (
        !state.pendingAvailability[key] || !state.pendingReserve[key] ||
        !state.pendingStability[key]
      ) return;
      const result = engine.advance({
        frameIndex: sourceFrame + 3,
        inputs: [
          state.pendingAvailability[key],
          state.pendingReserve[key],
          state.pendingStability[key]
        ]
      });
      if (result.outputs.length !== 0 || result.state.outputSequence !== '0') {
        fail('INTERO output firewall failed', 'P1_INTERO_SHADOW_OUTPUT');
      }
      if (result.projection && FORBIDDEN_SEMANTICS.test(stableStringify(result.projection))) {
        fail('INTERO projection crossed semantic containment', 'P1_INTERO_SHADOW_SEMANTICS');
      }
      state.engineState = clone(result.state);
      if (result.projection) state.lastProjection = clone(result.projection);
      delete state.pendingAvailability[key];
      delete state.pendingReserve[key];
      delete state.pendingStability[key];
      transitions += 1;
    }
  }

  return Object.freeze({
    async start() { state = clone(validateState(state)); },
    async handle(event) {
      if (event?.topic === ACTIVATION_TOPIC) {
        const activation = normalizeActivation(event.payload, event);
        if (state.activation) {
          if (sha256(state.activation) !== sha256(activation)) {
            fail('INTERO activation cannot change', 'P1_INTERO_SHADOW_ACTIVATION');
          }
          return;
        }
        state.activation = clone(activation);
        return;
      }
      if (event?.topic === 'runtime.organism.binding') {
        if (sha256(normalizeRuntimeBinding(event.payload)) !== sha256(state.neutralState.runtimeBinding)) {
          fail('INTERO runtime identity cannot change', 'P1_INTERO_SHADOW_IDENTITY');
        }
        return;
      }
      if (!state.activation) {
        fail('INTERO cannot consume before shadow activation', 'P1_INTERO_SHADOW_UNACTIVATED');
      }
      if (![AVAILABILITY_TOPIC, RESERVE_TOPIC, STABILITY_TOPIC].includes(event?.topic)) {
        fail('INTERO shadow input is forbidden', 'P1_INTERO_SHADOW_INPUT');
      }
      const frame = frameFromEvent(event, CORE_ID);
      if (frame) {
        if (event.topic === AVAILABILITY_TOPIC) {
          boundedInsert(state.pendingAvailability, String(frame.committedFrame), frame);
        } else if (event.topic === RESERVE_TOPIC) {
          boundedInsert(state.pendingReserve, String(frame.committedFrame), frame);
        } else {
          if (frame.committedFrame < 2) {
            fail('INTERO HOMEOS source frame is invalid', 'P1_INTERO_SHADOW_FRAME');
          }
          boundedInsert(state.pendingStability, String(frame.committedFrame - 1), frame);
        }
        drainCompleteSets();
      }
      state.handledEvents += 1;
    },
    async snapshot() { return clone(validateState(state)); },
    async health() {
      const verified = validateState(state);
      return Object.freeze({
        ok: verified.activation !== null,
        mode: 'SHADOW',
        authorityOwned: false,
        activated: verified.activation !== null,
        signalling: 'FORBIDDEN',
        receptorRoute: 'ABSENT',
        foundered: true,
        lifecycle: verified.engineState.lifecycle,
        frameIndex: verified.engineState.frameIndex,
        projectionAvailable: verified.lastProjection !== null,
        pendingFrames: Object.keys(verified.pendingAvailability).length +
          Object.keys(verified.pendingReserve).length +
          Object.keys(verified.pendingStability).length,
        biologicalOutputs: 0,
        physiologicalInputs: verified.handledEvents,
        outputPolicy: OUTPUT_POLICY
      });
    },
    async stop() {}
  });
}

async function migrateState({ state, fromSchema, toSchema }) {
  if (fromSchema === 1 && toSchema === 2) return clone(createShadowStagingState(state));
  if (fromSchema === 2 && toSchema === 2) return clone(validateState(state));
  fail(`unsupported INTERO shadow migration ${fromSchema}->${toSchema}`, 'P1_INTERO_SHADOW_MIGRATION');
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
