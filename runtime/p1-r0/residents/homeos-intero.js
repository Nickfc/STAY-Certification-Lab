'use strict';

const { stableStringify } = require('../../kernel/canonical-json');
const { validateCausalFrame } = require('../causal-frame');
const { createHomeosEngine } = require('../homeos-engine');
const { RESOURCES, clone, deepFreeze, exact, fail, sha256 } = require('../resident-support');
const shadowSource = require('./homeos-shadow');
const neutralSource = require('./homeos-neutral');

const CORE_ID = 'HOMEOS';
const RESIDENCY_ID = 'resident:homeos';
const VERSION = '0.3.0-p1r0-intero-feed.1';
const STAGE = 'p1-r0-production-intero-feed-shadow-r149';
const ACTIVATION_TOPIC = 'runtime.homeos.intero-route-activation';
const OUTPUT_POLICY = 'INTERO_STABILITY_ONLY_SHADOW_SUMMARY';
const INTERO_ROUTE = 'p1r0.homeos-stability.intero';
const OUTPUT_TOPIC = 'homeos.stability.summary.v1';
const HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const ACTIVATION_PAYLOAD_FIELDS = new Set([
  'protocol', 'organismIdentityHash', 'residencyId', 'instanceId',
  'fromVersion', 'fromStateSchema', 'sourceCheckpointGeneration',
  'sourceCheckpointHash', 'toVersion', 'toStateSchema', 'targetRevision',
  'parentRevision', 'parentFreezeRecordSha256', 'mode', 'authorityEpoch',
  'outputPolicy', 'routes'
]);
const ACTIVATION_FIELDS = new Set([...ACTIVATION_PAYLOAD_FIELDS, 'eventId', 'eventSequence']);
const STATE_FIELDS = new Set([
  'schema', 'activation', 'sourceState', 'routedEngineState',
  'emittedOutputSequence'
]);

const manifest = Object.freeze({
  coreId: CORE_ID,
  version: VERSION,
  protocol: 'stay-p1-r0-resident-v1',
  stateSchema: 3,
  hotSwap: true,
  priority: 'optional',
  stage: STAGE,
  productionEligible: false,
  inputs: Object.freeze([...shadowSource.manifest.inputs, ACTIVATION_TOPIC]),
  outputs: Object.freeze([OUTPUT_TOPIC]),
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
  exact(payload, ACTIVATION_PAYLOAD_FIELDS, 'HOMEOS INTERO route activation', 'P1_HOMEOS_INTERO_ACTIVATION');
  if (
    payload.protocol !== 'stay-p1-r0-homeos-intero-route-activation-v1' ||
    payload.residencyId !== RESIDENCY_ID ||
    payload.fromVersion !== shadowSource.VERSION || payload.fromStateSchema !== 2 ||
    payload.toVersion !== VERSION || payload.toStateSchema !== 3 ||
    payload.targetRevision !== 149 || payload.parentRevision !== 145 ||
    payload.mode !== 'SHADOW' || payload.authorityEpoch !== '0' ||
    payload.outputPolicy !== OUTPUT_POLICY ||
    stableStringify(payload.routes) !== stableStringify([INTERO_ROUTE]) ||
    !HASH.test(String(payload.organismIdentityHash || '')) ||
    !HASH.test(String(payload.sourceCheckpointHash || '')) ||
    !HASH.test(String(payload.parentFreezeRecordSha256 || '')) ||
    !Number.isSafeInteger(payload.sourceCheckpointGeneration) || payload.sourceCheckpointGeneration < 1 ||
    typeof payload.instanceId !== 'string' || !SAFE_ID.test(payload.instanceId)
  ) fail('HOMEOS INTERO route activation is invalid', 'P1_HOMEOS_INTERO_ACTIVATION');
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
  ) fail('HOMEOS INTERO activation provenance is invalid', 'P1_HOMEOS_INTERO_ACTIVATION');
  return deepFreeze({ ...clone(normalized), eventId: event.id, eventSequence: event.sequence });
}

function samePhysiology(left, right) {
  const normalized = clone(left);
  normalized.outputSequence = right.outputSequence;
  return stableStringify(normalized) === stableStringify(right);
}

function createStagingState(sourceState) {
  const source = shadowSource.validateState(sourceState);
  const engine = createHomeosEngine({
    profile: source.neutralState.founder.profile,
    identity: engineIdentity(source.neutralState.founder)
  });
  engine.restore(source.neutralState.engineState);
  return deepFreeze({
    schema: 'stay-p1-r0-resident/homeos-intero-state-v3',
    activation: null,
    sourceState: clone(source),
    routedEngineState: clone(engine.snapshot()),
    emittedOutputSequence: '0'
  });
}

function validateState(input) {
  exact(input, STATE_FIELDS, 'HOMEOS INTERO state', 'P1_HOMEOS_INTERO_STATE');
  if (input.schema !== 'stay-p1-r0-resident/homeos-intero-state-v3') {
    fail('HOMEOS INTERO state is invalid', 'P1_HOMEOS_INTERO_STATE');
  }
  const source = shadowSource.validateState(input.sourceState);
  const engine = createHomeosEngine({
    profile: source.neutralState.founder.profile,
    identity: engineIdentity(source.neutralState.founder)
  });
  engine.restore(input.routedEngineState);
  const routedEngineState = engine.snapshot();
  if (
    !samePhysiology(routedEngineState, source.neutralState.engineState) ||
    BigInt(routedEngineState.outputSequence) % 3n !== 0n ||
    !/^(0|[1-9][0-9]*)$/.test(input.emittedOutputSequence) ||
    BigInt(input.emittedOutputSequence) * 3n > BigInt(routedEngineState.outputSequence)
  ) fail('HOMEOS INTERO physiology diverged', 'P1_HOMEOS_INTERO_STATE');
  let activation = null;
  if (input.activation !== null) {
    exact(input.activation, ACTIVATION_FIELDS, 'stored HOMEOS INTERO activation', 'P1_HOMEOS_INTERO_STATE');
    const payload = {};
    for (const field of ACTIVATION_PAYLOAD_FIELDS) payload[field] = input.activation[field];
    activation = normalizeActivationPayload(payload);
    if (
      typeof input.activation.eventId !== 'string' || !SAFE_ID.test(input.activation.eventId) ||
      !Number.isSafeInteger(input.activation.eventSequence) || input.activation.eventSequence < 1 ||
      activation.organismIdentityHash !== source.neutralState.runtimeBinding.identitySha256
    ) fail('stored HOMEOS INTERO activation is invalid', 'P1_HOMEOS_INTERO_STATE');
    activation = deepFreeze({ ...clone(activation), eventId: input.activation.eventId, eventSequence: input.activation.eventSequence });
  } else if (input.emittedOutputSequence !== '0') {
    fail('unactivated HOMEOS INTERO state contains outputs', 'P1_HOMEOS_INTERO_STATE');
  }
  return deepFreeze({
    schema: input.schema,
    activation: activation === null ? null : clone(activation),
    sourceState: clone(source),
    routedEngineState: clone(routedEngineState),
    emittedOutputSequence: input.emittedOutputSequence
  });
}

function currentPair(before, event) {
  const source = before.neutralState;
  const availability = source.pendingAvailability[String(event?.payload?.committedFrame)] ||
    (event.topic === neutralSource.AVAILABILITY_TOPIC ? event.payload : null);
  const reserve = source.pendingReserve[String(event?.payload?.committedFrame)] ||
    (event.topic === neutralSource.RESERVE_TOPIC ? event.payload : null);
  return { availability, reserve };
}

function resequenceFrame(frame, producerSequence) {
  const next = clone(frame);
  delete next.frameId;
  next.producerSequence = producerSequence.toString();
  return validateCausalFrame({ frameId: sha256(next), ...next });
}

async function createCore({ manifest: activeManifest = manifest, initialState, emit = async () => null } = {}) {
  if (
    activeManifest.coreId !== CORE_ID || activeManifest.version !== VERSION ||
    activeManifest.stateSchema !== 3 ||
    stableStringify(activeManifest.inputs) !== stableStringify(manifest.inputs) ||
    stableStringify(activeManifest.outputs) !== stableStringify([OUTPUT_TOPIC]) ||
    typeof emit !== 'function'
  ) fail('HOMEOS INTERO manifest mismatch', 'P1_HOMEOS_INTERO_MANIFEST');
  if (!initialState || Object.keys(initialState).length === 0) {
    fail('HOMEOS INTERO requires preserved shadow state', 'P1_HOMEOS_INTERO_STATE');
  }
  let state = clone(validateState(initialState));
  const inner = await shadowSource.createCore({ initialState: state.sourceState });
  await inner.start();
  const routedEngine = createHomeosEngine({
    profile: state.sourceState.neutralState.founder.profile,
    identity: engineIdentity(state.sourceState.neutralState.founder)
  });
  routedEngine.restore(state.routedEngineState);
  async function syncSource() { state.sourceState = await inner.snapshot(); }

  return Object.freeze({
    async start() { state = clone(validateState(state)); },
    async handle(event) {
      if (event?.topic === ACTIVATION_TOPIC) {
        const activation = normalizeActivation(event.payload, event);
        if (state.activation) {
          if (sha256(state.activation) !== sha256(activation)) {
            fail('HOMEOS INTERO activation cannot change', 'P1_HOMEOS_INTERO_ACTIVATION');
          }
          return;
        }
        if (activation.organismIdentityHash !== state.sourceState.neutralState.runtimeBinding.identitySha256) {
          fail('HOMEOS INTERO activation crossed identity', 'P1_HOMEOS_INTERO_ACTIVATION');
        }
        state.activation = clone(activation);
        return;
      }
      if (!state.activation && event?.topic !== 'runtime.organism.binding') {
        fail('HOMEOS INTERO route is not activated', 'P1_HOMEOS_INTERO_UNACTIVATED');
      }
      const before = await inner.snapshot();
      await inner.handle(event);
      await syncSource();
      if (state.sourceState.neutralState.engineState.frameIndex > before.neutralState.engineState.frameIndex) {
        const { availability, reserve } = currentPair(before, event);
        if (!availability || !reserve) fail('HOMEOS INTERO committed pair is unavailable', 'P1_HOMEOS_INTERO_PAIR');
        const consumerFrame = availability.committedFrame + 1;
        const result = routedEngine.advance({
          frameIndex: consumerFrame,
          inputs: [availability, reserve]
        });
        const priorSequence = BigInt(state.emittedOutputSequence);
        const stability = result.outputs.filter(frame => frame.route.routeId === INTERO_ROUTE);
        if (
          result.outputs.length !== 3 || stability.length !== 1 ||
          !samePhysiology(result.state, state.sourceState.neutralState.engineState)
        ) fail('HOMEOS INTERO output derivation is invalid', 'P1_HOMEOS_INTERO_OUTPUT');
        const frame = resequenceFrame(stability[0], priorSequence + 1n);
        state.routedEngineState = clone(result.state);
        state.emittedOutputSequence = (priorSequence + 1n).toString();
        await emit(frame.topic.name, frame, { eventClass: 'durable' });
      }
    },
    async snapshot() { await syncSource(); return clone(validateState(state)); },
    async health() {
      await syncSource();
      const verified = validateState(state);
      return Object.freeze({
        ok: verified.activation !== null,
        mode: 'SHADOW',
        authorityOwned: false,
        foundered: true,
        activated: verified.activation !== null,
        lifecycle: verified.sourceState.neutralState.engineState.lifecycle,
        frameIndex: verified.sourceState.neutralState.engineState.frameIndex,
        biologicalOutputs: Number(BigInt(verified.emittedOutputSequence)),
        physiologicalInputs: verified.sourceState.neutralState.handledEvents,
        outputPolicy: OUTPUT_POLICY,
        activeRoutes: [INTERO_ROUTE]
      });
    },
    async stop() { await inner.stop(); }
  });
}

async function migrateState({ state, fromSchema, toSchema }) {
  if (fromSchema === 2 && toSchema === 3) return clone(createStagingState(state));
  if (fromSchema === 3 && toSchema === 3) return clone(validateState(state));
  fail(`unsupported HOMEOS INTERO migration ${fromSchema}->${toSchema}`, 'P1_HOMEOS_INTERO_MIGRATION');
}

module.exports = Object.freeze({
  ACTIVATION_TOPIC,
  CORE_ID,
  INTERO_ROUTE,
  OUTPUT_POLICY,
  RESIDENCY_ID,
  STAGE,
  VERSION,
  createCore,
  createStagingState,
  manifest,
  migrateState,
  normalizeActivationPayload,
  validateState
});
