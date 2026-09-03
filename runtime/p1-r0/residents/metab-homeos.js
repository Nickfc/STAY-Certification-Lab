'use strict';

const { stableStringify } = require('../../kernel/canonical-json');
const q48 = require('../q16-48');
const { validateCausalFrame } = require('../causal-frame');
const { createMetabEngine } = require('../metab-engine');
const {
  RESOURCES,
  clone,
  deepFreeze,
  exact,
  fail,
  sha256
} = require('../resident-support');
const sourceDefinition = require('./metab-shadow');

const CORE_ID = 'METAB';
const RESIDENCY_ID = 'resident:metab';
const VERSION = '0.3.0-p1r0-homeos-feed.1';
const STAGE = 'p1-r0-production-homeos-feed-shadow-r144';
const ACTIVATION_TOPIC = 'runtime.metab.homeos-route-activation';
const OUTPUT_POLICY = 'HOMEOS_ONLY_SHADOW_SUMMARIES';
const HOMEOS_ROUTES = Object.freeze([
  'p1r0.metab-availability.homeos',
  'p1r0.metab-reserve.homeos'
]);
const OUTPUT_TOPICS = Object.freeze([
  'metab.energy.availability.v1',
  'metab.energy.reserve.v1'
]);
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
  inputs: Object.freeze([...sourceDefinition.manifest.inputs, ACTIVATION_TOPIC]),
  outputs: OUTPUT_TOPICS,
  biology: Object.freeze({
    protocol: 'stay-biological-signalling-fabric-v1',
    producerCapabilities: Object.freeze([]),
    consumerRouteLeases: Object.freeze([])
  }),
  resources: RESOURCES
});

function routedIdentity(founder) {
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
  exact(payload, ACTIVATION_PAYLOAD_FIELDS, 'METAB HOMEOS route activation', 'P1_METAB_HOMEOS_ACTIVATION');
  if (
    payload.protocol !== 'stay-p1-r0-metab-homeos-route-activation-v1' ||
    payload.residencyId !== RESIDENCY_ID ||
    payload.fromVersion !== sourceDefinition.VERSION || payload.fromStateSchema !== 2 ||
    payload.toVersion !== VERSION || payload.toStateSchema !== 3 ||
    payload.targetRevision !== 144 || payload.parentRevision !== 141 ||
    payload.mode !== 'SHADOW' || payload.authorityEpoch !== '0' ||
    payload.outputPolicy !== OUTPUT_POLICY ||
    stableStringify(payload.routes) !== stableStringify(HOMEOS_ROUTES) ||
    !HASH.test(String(payload.organismIdentityHash || '')) ||
    !HASH.test(String(payload.sourceCheckpointHash || '')) ||
    !HASH.test(String(payload.parentFreezeRecordSha256 || '')) ||
    !Number.isSafeInteger(payload.sourceCheckpointGeneration) || payload.sourceCheckpointGeneration < 1 ||
    typeof payload.instanceId !== 'string' || !SAFE_ID.test(payload.instanceId)
  ) fail('METAB HOMEOS route activation is invalid', 'P1_METAB_HOMEOS_ACTIVATION');
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
  ) fail('METAB HOMEOS activation provenance is invalid', 'P1_METAB_HOMEOS_ACTIVATION');
  return deepFreeze({ ...clone(normalized), eventId: event.id, eventSequence: event.sequence });
}

function createStagingState(sourceState) {
  const source = sourceDefinition.validateState(sourceState);
  const engine = createMetabEngine({ profile: source.founder.profile, identity: routedIdentity(source.founder) });
  engine.restore(source.engineState);
  return deepFreeze({
    schema: 'stay-p1-r0-resident/metab-homeos-state-v3',
    activation: null,
    sourceState: clone(source),
    routedEngineState: clone(engine.snapshot()),
    emittedOutputSequence: '0'
  });
}

function samePhysiology(left, right) {
  const normalized = clone(left);
  normalized.outputSequence = right.outputSequence;
  return stableStringify(normalized) === stableStringify(right);
}

function validateState(input) {
  exact(input, STATE_FIELDS, 'METAB HOMEOS state', 'P1_METAB_HOMEOS_STATE');
  if (input.schema !== 'stay-p1-r0-resident/metab-homeos-state-v3') {
    fail('METAB HOMEOS state is invalid', 'P1_METAB_HOMEOS_STATE');
  }
  const sourceState = sourceDefinition.validateState(input.sourceState);
  const engine = createMetabEngine({ profile: sourceState.founder.profile, identity: routedIdentity(sourceState.founder) });
  engine.restore(input.routedEngineState);
  const routedEngineState = engine.snapshot();
  if (
    !samePhysiology(routedEngineState, sourceState.engineState) ||
    BigInt(routedEngineState.outputSequence) < 0n ||
    BigInt(routedEngineState.outputSequence) % 4n !== 0n ||
    !/^(0|[1-9][0-9]*)$/.test(input.emittedOutputSequence) ||
    BigInt(routedEngineState.outputSequence) !== BigInt(input.emittedOutputSequence) * 2n
  ) fail('METAB HOMEOS routed state diverged from physiology', 'P1_METAB_HOMEOS_STATE');
  let activation = null;
  if (input.activation !== null) {
    exact(input.activation, ACTIVATION_FIELDS, 'stored METAB HOMEOS activation', 'P1_METAB_HOMEOS_STATE');
    const payload = {};
    for (const field of ACTIVATION_PAYLOAD_FIELDS) payload[field] = input.activation[field];
    activation = normalizeActivationPayload(payload);
    if (
      typeof input.activation.eventId !== 'string' || !SAFE_ID.test(input.activation.eventId) ||
      !Number.isSafeInteger(input.activation.eventSequence) || input.activation.eventSequence < 1 ||
      activation.organismIdentityHash !== sourceState.runtimeBinding.identitySha256
    ) fail('stored METAB HOMEOS activation is invalid', 'P1_METAB_HOMEOS_STATE');
    activation = deepFreeze({ ...clone(activation), eventId: input.activation.eventId, eventSequence: input.activation.eventSequence });
  } else if (routedEngineState.outputSequence !== '0') {
    fail('unactivated METAB HOMEOS state contains outputs', 'P1_METAB_HOMEOS_STATE');
  }
  return deepFreeze({
    schema: input.schema,
    activation: activation === null ? null : clone(activation),
    sourceState: clone(sourceState),
    routedEngineState: clone(routedEngineState),
    emittedOutputSequence: input.emittedOutputSequence
  });
}

function resequenceFrame(frame, producerSequence) {
  const next = clone(frame);
  delete next.frameId;
  next.producerSequence = producerSequence.toString();
  return validateCausalFrame({ frameId: sha256(next), ...next });
}

function currentPair(before, event) {
  const eligible = before.pendingEligible || (event.topic === sourceDefinition.ELIGIBLE_TOPIC ? {
    eligibleCapacityQ48: event.payload.eligibleCapacityQ48,
    safetyCeilingQ48: event.payload.safetyCeilingQ48,
    capacityClass: event.payload.capacityClass,
    sampleFrame: event.payload.sampleFrame,
    producerSequence: String(event.sequence)
  } : null);
  const quality = before.pendingQuality || (event.topic === sourceDefinition.QUALITY_TOPIC ? {
    status: event.payload.status,
    qualityQ48: event.payload.qualityQ48,
    ceilingVerified: event.payload.ceilingVerified
  } : null);
  return { eligible, quality };
}

async function createCore({ manifest: activeManifest = manifest, initialState, emit = async () => null } = {}) {
  if (
    activeManifest.coreId !== CORE_ID || activeManifest.version !== VERSION ||
    activeManifest.stateSchema !== 3 ||
    stableStringify(activeManifest.inputs) !== stableStringify(manifest.inputs) ||
    stableStringify(activeManifest.outputs) !== stableStringify(OUTPUT_TOPICS) || typeof emit !== 'function'
  ) fail('METAB HOMEOS manifest mismatch', 'P1_METAB_HOMEOS_MANIFEST');
  if (!initialState || Object.keys(initialState).length === 0) {
    fail('METAB HOMEOS requires preserved shadow state', 'P1_METAB_HOMEOS_STATE');
  }
  let state = clone(validateState(initialState));
  const inner = await sourceDefinition.createCore({ initialState: state.sourceState });
  await inner.start();
  const routedEngine = createMetabEngine({
    profile: state.sourceState.founder.profile,
    identity: routedIdentity(state.sourceState.founder)
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
            fail('METAB HOMEOS activation cannot change', 'P1_METAB_HOMEOS_ACTIVATION');
          }
          return;
        }
        if (activation.organismIdentityHash !== state.sourceState.runtimeBinding.identitySha256) {
          fail('METAB HOMEOS activation crossed identity', 'P1_METAB_HOMEOS_ACTIVATION');
        }
        state.activation = clone(activation);
        return;
      }
      if (!state.activation && event?.topic !== 'runtime.organism.binding') {
        fail('METAB HOMEOS route is not activated', 'P1_METAB_HOMEOS_UNACTIVATED');
      }
      const before = await inner.snapshot();
      await inner.handle(event);
      await syncSource();
      if (state.sourceState.lastAcceptedFrame > before.lastAcceptedFrame) {
        const { eligible, quality } = currentPair(before, event);
        if (!eligible || !quality) fail('METAB HOMEOS committed pair is unavailable', 'P1_METAB_HOMEOS_PAIR');
        const priorSequence = BigInt(state.emittedOutputSequence);
        const result = routedEngine.advance({
          frameIndex: eligible.sampleFrame,
          producerSequence: eligible.producerSequence,
          eligibleCapacityQ48: eligible.eligibleCapacityQ48,
          safetyCeilingQ48: eligible.safetyCeilingQ48,
          capacityClass: eligible.capacityClass,
          qualityStatus: quality.status,
          qualityQ48: quality.qualityQ48,
          coverageQ48: quality.status === 'VALID' ? q48.SCALE.toString() : '0',
          ceilingVerified: quality.ceilingVerified
        });
        const outputs = result.outputs
          .filter(frame => HOMEOS_ROUTES.includes(frame.route.routeId))
          .map((frame, index) => resequenceFrame(frame, priorSequence + BigInt(index + 1)));
        if (
          result.outputs.length !== 4 || outputs.length !== 2 ||
          !samePhysiology(result.state, state.sourceState.engineState)
        ) fail('METAB HOMEOS output derivation is invalid', 'P1_METAB_HOMEOS_OUTPUT');
        state.routedEngineState = clone(result.state);
        state.emittedOutputSequence = (priorSequence + 2n).toString();
        for (const frame of outputs) await emit(frame.topic.name, frame, { eventClass: 'durable' });
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
        lifecycle: verified.sourceState.engineState.lifecycle,
        frameIndex: verified.sourceState.lastAcceptedFrame,
        lastAcceptedTimeMs: verified.sourceState.lastAcceptedTimeMs,
        pendingCapacityPair: Boolean(verified.sourceState.pendingEligible || verified.sourceState.pendingQuality),
        biologicalOutputs: Number(BigInt(verified.emittedOutputSequence)),
        physiologicalInputs: verified.sourceState.handledEvents,
        outputPolicy: OUTPUT_POLICY,
        activeRoutes: [...HOMEOS_ROUTES]
      });
    },
    async stop() { await inner.stop(); }
  });
}

async function migrateState({ state, fromSchema, toSchema }) {
  if (fromSchema === 2 && toSchema === 3) return clone(createStagingState(state));
  if (fromSchema === 3 && toSchema === 3) return clone(validateState(state));
  fail(`unsupported METAB HOMEOS migration ${fromSchema}->${toSchema}`, 'P1_METAB_HOMEOS_MIGRATION');
}

module.exports = Object.freeze({
  ACTIVATION_TOPIC,
  CORE_ID,
  HOMEOS_ROUTES,
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
