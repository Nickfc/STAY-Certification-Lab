'use strict';

const { stableStringify } = require('../../kernel/canonical-json');
const { createHomeosEngine } = require('../homeos-engine');
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
const R146_ROUTE_BOUNDARY = Object.freeze({
  activationEventId: 'evt-2iweb-70324b1e3d6eaba6',
  activationEventSequence: 4241027,
  activationSourceCheckpointGeneration: 7,
  activationSourceCheckpointHash:
    'sha256:2c816e7d10033049d81d55bacb07c049483f243e3f60816892ccc9e3db5d3744',
  engineFrame: 98007,
  missingSourceFrame: 98007,
  firstRetainedSourceFrame: 98008,
  lastRetainedSourceFrame: 98023,
  availabilityProducerSequence: 3,
  reserveProducerSequence: 4,
  firstRetainedAvailabilitySequence: 7,
  firstRetainedReserveSequence: 8,
  handledEvents: 36
});

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

/*
 * The first R146 HOMEOS shadow route was interrupted after its neutral
 * checkpoint had consumed source frame 98006 and before the newly opened
 * route could publish source frame 98007.  The following sixteen complete,
 * delayed METAB pairs were durably accepted into the HOMEOS checkpoint but
 * could not advance because the engine correctly requires contiguous time.
 *
 * This repair is deliberately a pure, exact-cohort transform.  It advances
 * the single absent source frame as UNKNOWN, then applies only the retained
 * causal frames already present in the checkpoint.  It invents no input,
 * emits no output, changes no authority, and cannot match a later generic
 * gap.  The privileged recovery entry path persists the returned state and
 * evidence atomically before replaying the two still-PENDING deliveries.
 */
function repairExactR146RouteBoundaryState(input) {
  const state = clone(validateState(input));
  const activation = state.activation;
  const source = state.neutralState;
  const engineState = source.engineState;
  const availabilityKeys = Object.keys(source.pendingAvailability).map(Number).sort((a, b) => a - b);
  const reserveKeys = Object.keys(source.pendingReserve).map(Number).sort((a, b) => a - b);
  const expectedFrames = Array.from(
    { length: R146_ROUTE_BOUNDARY.lastRetainedSourceFrame -
        R146_ROUTE_BOUNDARY.firstRetainedSourceFrame + 1 },
    (_value, index) => R146_ROUTE_BOUNDARY.firstRetainedSourceFrame + index
  );
  if (
    activation?.eventId !== R146_ROUTE_BOUNDARY.activationEventId ||
    activation?.eventSequence !== R146_ROUTE_BOUNDARY.activationEventSequence ||
    activation?.sourceCheckpointGeneration !==
      R146_ROUTE_BOUNDARY.activationSourceCheckpointGeneration ||
    activation?.sourceCheckpointHash !== R146_ROUTE_BOUNDARY.activationSourceCheckpointHash ||
    activation?.instanceId !== '3f32bdc9-fa49-4eea-8c13-b9afe6b47c0f' ||
    engineState?.frameIndex !== R146_ROUTE_BOUNDARY.engineFrame ||
    engineState?.outputSequence !== '0' ||
    engineState?.inputCursors?.['p1r0.metab-availability.homeos'] !==
      String(R146_ROUTE_BOUNDARY.availabilityProducerSequence) ||
    engineState?.inputCursors?.['p1r0.metab-reserve.homeos'] !==
      String(R146_ROUTE_BOUNDARY.reserveProducerSequence) ||
    source.handledEvents !== R146_ROUTE_BOUNDARY.handledEvents ||
    stableStringify(availabilityKeys) !== stableStringify(expectedFrames) ||
    stableStringify(reserveKeys) !== stableStringify(expectedFrames)
  ) {
    fail('HOMEOS R146 route-boundary cohort changed', 'P1_HOMEOS_R146_ROUTE_BOUNDARY');
  }

  const engine = createHomeosEngine({
    profile: source.founder.profile,
    identity: {
      organismId: source.founder.organismId,
      founderLineageId: source.founder.lineageId,
      residencyId: source.founder.residencyId,
      coreVersion: neutral.VERSION,
      authorityEpoch: '0',
      mode: 'NEUTRAL'
    }
  });
  engine.restore(engineState);
  const absent = engine.advance({
    frameIndex: R146_ROUTE_BOUNDARY.engineFrame + 1,
    inputs: null
  });
  if (absent.outputs.length !== 0 || absent.state.outputSequence !== '0' ||
      absent.state.lifecycle !== 'UNRESOLVED') {
    fail('HOMEOS R146 absent frame was not contained', 'P1_HOMEOS_R146_ROUTE_BOUNDARY');
  }

  for (const [index, frame] of expectedFrames.entries()) {
    const availability = source.pendingAvailability[String(frame)];
    const reserve = source.pendingReserve[String(frame)];
    if (
      availability?.committedFrame !== frame || reserve?.committedFrame !== frame ||
      availability?.producerSequence !==
        String(R146_ROUTE_BOUNDARY.firstRetainedAvailabilitySequence + index * 2) ||
      reserve?.producerSequence !==
        String(R146_ROUTE_BOUNDARY.firstRetainedReserveSequence + index * 2)
    ) {
      fail('HOMEOS R146 retained frame identity changed', 'P1_HOMEOS_R146_ROUTE_BOUNDARY');
    }
    const advanced = engine.advance({ frameIndex: frame + 1, inputs: [availability, reserve] });
    if (advanced.outputs.length !== 0 || advanced.state.outputSequence !== '0') {
      fail('HOMEOS R146 route-boundary repair emitted output', 'P1_HOMEOS_R146_ROUTE_BOUNDARY');
    }
    delete source.pendingAvailability[String(frame)];
    delete source.pendingReserve[String(frame)];
  }
  source.engineState = clone(engine.snapshot());
  const repaired = validateState(state);
  if (
    repaired.neutralState.engineState.frameIndex !==
      R146_ROUTE_BOUNDARY.lastRetainedSourceFrame + 1 ||
    Object.keys(repaired.neutralState.pendingAvailability).length !== 0 ||
    Object.keys(repaired.neutralState.pendingReserve).length !== 0
  ) {
    fail('HOMEOS R146 route-boundary repair is incomplete', 'P1_HOMEOS_R146_ROUTE_BOUNDARY');
  }
  return deepFreeze({
    state: clone(repaired),
    evidence: {
      cohort: 'r146-homeos-route-boundary-v1',
      missingSourceFrame: R146_ROUTE_BOUNDARY.missingSourceFrame,
      absentFrameSemantics: 'UNKNOWN',
      retainedPairCount: expectedFrames.length,
      firstRetainedSourceFrame: expectedFrames[0],
      lastRetainedSourceFrame: expectedFrames.at(-1),
      fromEngineFrame: R146_ROUTE_BOUNDARY.engineFrame,
      toEngineFrame: repaired.neutralState.engineState.frameIndex,
      checkpointBytesChanged: true,
      biologicalStateChanged: true,
      physiologyApplied: expectedFrames.length,
      abandonedCount: 0,
      inventedBiologicalTime: false,
      authorityChanged: false,
      biologicalOutputs: 0
    }
  });
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
  repairExactR146RouteBoundaryState,
  R146_ROUTE_BOUNDARY,
  validateState
});
