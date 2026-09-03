'use strict';

const { stableStringify } = require('../../kernel/canonical-json');
const q48 = require('../q16-48');
const { validateCausalFrame } = require('../causal-frame');
const { createMetabEngine } = require('../metab-engine');
const { RESOURCES, clone, deepFreeze, exact, fail, sha256 } = require('../resident-support');
const homeosFeed = require('./metab-homeos');
const shadowSource = require('./metab-shadow');

const CORE_ID = 'METAB';
const RESIDENCY_ID = 'resident:metab';
const VERSION = '0.4.0-p1r0-intero-feed.1';
const STAGE = 'p1-r0-production-intero-feed-shadow-r148';
const ACTIVATION_TOPIC = 'runtime.metab.intero-route-activation';
const OUTPUT_POLICY = 'HOMEOS_AND_INTERO_SHADOW_SUMMARIES';
const INTERO_ROUTES = Object.freeze([
  'p1r0.metab-availability.intero',
  'p1r0.metab-reserve.intero'
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
  'schema', 'activation', 'homeosFeedState', 'interoEngineState',
  'interoOutputSequence'
]);

const manifest = Object.freeze({
  coreId: CORE_ID,
  version: VERSION,
  protocol: 'stay-p1-r0-resident-v1',
  stateSchema: 4,
  hotSwap: true,
  priority: 'optional',
  stage: STAGE,
  productionEligible: false,
  inputs: Object.freeze([...homeosFeed.manifest.inputs, ACTIVATION_TOPIC]),
  outputs: OUTPUT_TOPICS,
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
  exact(payload, ACTIVATION_PAYLOAD_FIELDS, 'METAB INTERO route activation', 'P1_METAB_INTERO_ACTIVATION');
  if (
    payload.protocol !== 'stay-p1-r0-metab-intero-route-activation-v1' ||
    payload.residencyId !== RESIDENCY_ID ||
    payload.fromVersion !== homeosFeed.VERSION || payload.fromStateSchema !== 3 ||
    payload.toVersion !== VERSION || payload.toStateSchema !== 4 ||
    payload.targetRevision !== 148 || payload.parentRevision !== 145 ||
    payload.mode !== 'SHADOW' || payload.authorityEpoch !== '0' ||
    payload.outputPolicy !== OUTPUT_POLICY ||
    stableStringify(payload.routes) !== stableStringify(INTERO_ROUTES) ||
    !HASH.test(String(payload.organismIdentityHash || '')) ||
    !HASH.test(String(payload.sourceCheckpointHash || '')) ||
    !HASH.test(String(payload.parentFreezeRecordSha256 || '')) ||
    !Number.isSafeInteger(payload.sourceCheckpointGeneration) || payload.sourceCheckpointGeneration < 1 ||
    typeof payload.instanceId !== 'string' || !SAFE_ID.test(payload.instanceId)
  ) fail('METAB INTERO route activation is invalid', 'P1_METAB_INTERO_ACTIVATION');
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
  ) fail('METAB INTERO activation provenance is invalid', 'P1_METAB_INTERO_ACTIVATION');
  return deepFreeze({ ...clone(normalized), eventId: event.id, eventSequence: event.sequence });
}

function samePhysiology(left, right) {
  const normalized = clone(left);
  normalized.outputSequence = right.outputSequence;
  return stableStringify(normalized) === stableStringify(right);
}

function createStagingState(sourceState) {
  const source = homeosFeed.validateState(sourceState);
  const engine = createMetabEngine({
    profile: source.sourceState.founder.profile,
    identity: engineIdentity(source.sourceState.founder)
  });
  engine.restore(source.routedEngineState);
  return deepFreeze({
    schema: 'stay-p1-r0-resident/metab-intero-state-v4',
    activation: null,
    homeosFeedState: clone(source),
    interoEngineState: clone(engine.snapshot()),
    interoOutputSequence: '0'
  });
}

function validateState(input) {
  exact(input, STATE_FIELDS, 'METAB INTERO state', 'P1_METAB_INTERO_STATE');
  if (input.schema !== 'stay-p1-r0-resident/metab-intero-state-v4') {
    fail('METAB INTERO state is invalid', 'P1_METAB_INTERO_STATE');
  }
  const source = homeosFeed.validateState(input.homeosFeedState);
  const engine = createMetabEngine({
    profile: source.sourceState.founder.profile,
    identity: engineIdentity(source.sourceState.founder)
  });
  engine.restore(input.interoEngineState);
  const interoEngineState = engine.snapshot();
  if (
    !samePhysiology(interoEngineState, source.routedEngineState) ||
    !/^(0|[1-9][0-9]*)$/.test(input.interoOutputSequence) ||
    BigInt(interoEngineState.outputSequence) % 4n !== 0n ||
    BigInt(input.interoOutputSequence) * 2n > BigInt(interoEngineState.outputSequence)
  ) fail('METAB INTERO physiology diverged', 'P1_METAB_INTERO_STATE');
  let activation = null;
  if (input.activation !== null) {
    exact(input.activation, ACTIVATION_FIELDS, 'stored METAB INTERO activation', 'P1_METAB_INTERO_STATE');
    const payload = {};
    for (const field of ACTIVATION_PAYLOAD_FIELDS) payload[field] = input.activation[field];
    activation = normalizeActivationPayload(payload);
    if (
      typeof input.activation.eventId !== 'string' || !SAFE_ID.test(input.activation.eventId) ||
      !Number.isSafeInteger(input.activation.eventSequence) || input.activation.eventSequence < 1 ||
      activation.organismIdentityHash !== source.sourceState.runtimeBinding.identitySha256
    ) fail('stored METAB INTERO activation is invalid', 'P1_METAB_INTERO_STATE');
    activation = deepFreeze({ ...clone(activation), eventId: input.activation.eventId, eventSequence: input.activation.eventSequence });
  } else if (input.interoOutputSequence !== '0') {
    fail('unactivated METAB INTERO state contains outputs', 'P1_METAB_INTERO_STATE');
  }
  return deepFreeze({
    schema: input.schema,
    activation: activation === null ? null : clone(activation),
    homeosFeedState: clone(source),
    interoEngineState: clone(interoEngineState),
    interoOutputSequence: input.interoOutputSequence
  });
}

function currentPair(before, event) {
  const source = before.sourceState;
  const eligible = source.pendingEligible || (event.topic === shadowSource.ELIGIBLE_TOPIC ? {
    eligibleCapacityQ48: event.payload.eligibleCapacityQ48,
    safetyCeilingQ48: event.payload.safetyCeilingQ48,
    capacityClass: event.payload.capacityClass,
    sampleFrame: event.payload.sampleFrame,
    producerSequence: String(event.sequence)
  } : null);
  const quality = source.pendingQuality || (event.topic === shadowSource.QUALITY_TOPIC ? {
    status: event.payload.status,
    qualityQ48: event.payload.qualityQ48,
    ceilingVerified: event.payload.ceilingVerified
  } : null);
  return { eligible, quality };
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
    activeManifest.stateSchema !== 4 ||
    stableStringify(activeManifest.inputs) !== stableStringify(manifest.inputs) ||
    stableStringify(activeManifest.outputs) !== stableStringify(OUTPUT_TOPICS) ||
    typeof emit !== 'function'
  ) fail('METAB INTERO manifest mismatch', 'P1_METAB_INTERO_MANIFEST');
  if (!initialState || Object.keys(initialState).length === 0) {
    fail('METAB INTERO requires preserved HOMEOS-feed state', 'P1_METAB_INTERO_STATE');
  }
  let state = clone(validateState(initialState));
  const inner = await homeosFeed.createCore({
    initialState: state.homeosFeedState,
    emit
  });
  await inner.start();
  const interoEngine = createMetabEngine({
    profile: state.homeosFeedState.sourceState.founder.profile,
    identity: engineIdentity(state.homeosFeedState.sourceState.founder)
  });
  interoEngine.restore(state.interoEngineState);
  async function syncSource() { state.homeosFeedState = await inner.snapshot(); }

  return Object.freeze({
    async start() { state = clone(validateState(state)); },
    async handle(event) {
      if (event?.topic === ACTIVATION_TOPIC) {
        const activation = normalizeActivation(event.payload, event);
        if (state.activation) {
          if (sha256(state.activation) !== sha256(activation)) {
            fail('METAB INTERO activation cannot change', 'P1_METAB_INTERO_ACTIVATION');
          }
          return;
        }
        if (activation.organismIdentityHash !== state.homeosFeedState.sourceState.runtimeBinding.identitySha256) {
          fail('METAB INTERO activation crossed identity', 'P1_METAB_INTERO_ACTIVATION');
        }
        state.activation = clone(activation);
        return;
      }
      if (!state.activation && event?.topic !== 'runtime.organism.binding') {
        fail('METAB INTERO route is not activated', 'P1_METAB_INTERO_UNACTIVATED');
      }
      const before = await inner.snapshot();
      await inner.handle(event);
      await syncSource();
      if (state.homeosFeedState.sourceState.lastAcceptedFrame > before.sourceState.lastAcceptedFrame) {
        const { eligible, quality } = currentPair(before, event);
        if (!eligible || !quality) fail('METAB INTERO committed pair is unavailable', 'P1_METAB_INTERO_PAIR');
        const priorSequence = BigInt(state.interoOutputSequence);
        const result = interoEngine.advance({
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
          .filter(frame => INTERO_ROUTES.includes(frame.route.routeId))
          .map((frame, index) => resequenceFrame(frame, priorSequence + BigInt(index + 1)));
        if (
          result.outputs.length !== 4 || outputs.length !== 2 ||
          !samePhysiology(result.state, state.homeosFeedState.routedEngineState)
        ) fail('METAB INTERO output derivation is invalid', 'P1_METAB_INTERO_OUTPUT');
        state.interoEngineState = clone(result.state);
        state.interoOutputSequence = (priorSequence + 2n).toString();
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
        lifecycle: verified.homeosFeedState.sourceState.engineState.lifecycle,
        frameIndex: verified.homeosFeedState.sourceState.lastAcceptedFrame,
        lastAcceptedTimeMs: verified.homeosFeedState.sourceState.lastAcceptedTimeMs,
        pendingCapacityPair: Boolean(
          verified.homeosFeedState.sourceState.pendingEligible ||
          verified.homeosFeedState.sourceState.pendingQuality
        ),
        biologicalOutputs: Number(
          BigInt(verified.homeosFeedState.emittedOutputSequence) +
          BigInt(verified.interoOutputSequence)
        ),
        physiologicalInputs: verified.homeosFeedState.sourceState.handledEvents,
        outputPolicy: OUTPUT_POLICY,
        activeRoutes: [...homeosFeed.HOMEOS_ROUTES, ...INTERO_ROUTES]
      });
    },
    async stop() { await inner.stop(); }
  });
}

async function migrateState({ state, fromSchema, toSchema }) {
  if (fromSchema === 3 && toSchema === 4) return clone(createStagingState(state));
  if (fromSchema === 4 && toSchema === 4) return clone(validateState(state));
  fail(`unsupported METAB INTERO migration ${fromSchema}->${toSchema}`, 'P1_METAB_INTERO_MIGRATION');
}

module.exports = Object.freeze({
  ACTIVATION_TOPIC,
  CORE_ID,
  INTERO_ROUTES,
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
