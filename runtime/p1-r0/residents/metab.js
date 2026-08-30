'use strict';

const q48 = require('../q16-48');
const { createMetabEngine } = require('../metab-engine');
const {
  FOUNDER_TOPICS,
  RESOURCES,
  clone,
  deepFreeze,
  engineIdentity,
  exact,
  fail,
  normalizeFounderBinding,
  normalizeRuntimeBinding,
  sha256
} = require('../resident-support');

const CORE_ID = 'METAB';
const RESIDENCY_ID = 'resident:metab';
const VERSION = '0.1.0-p1r0-lab';
const FOUNDER_TOPIC = FOUNDER_TOPICS.METAB;
const ELIGIBLE_FIELDS = new Set([
  'eligibleCapacityQ48', 'safetyCeilingQ48', 'capacityClass', 'sampleFrame'
]);
const QUALITY_FIELDS = new Set([
  'status', 'qualityQ48', 'ceilingVerified', 'reasonCodes'
]);
const STATE_FIELDS = new Set([
  'schema', 'runtimeBinding', 'founder', 'engineState', 'pendingEligible',
  'pendingQuality', 'handledEvents'
]);
const QUALITY = new Set(['VALID', 'STALE', 'CONFLICT', 'INVALID']);

const manifest = Object.freeze({
  coreId: CORE_ID,
  version: VERSION,
  protocol: 'stay-p1-r0-resident-v1',
  stateSchema: 1,
  hotSwap: true,
  priority: 'optional',
  stage: 'p1-r0-lab-shadow',
  productionEligible: false,
  inputs: Object.freeze([
    'runtime.organism.binding',
    FOUNDER_TOPIC,
    'resource.capacity.eligible.v1',
    'resource.capacity.quality.v1'
  ]),
  outputs: Object.freeze([
    'metab.energy.availability.v1',
    'metab.energy.reserve.v1'
  ]),
  biology: Object.freeze({
    protocol: 'stay-biological-signalling-fabric-v1',
    producerCapabilities: Object.freeze([]),
    consumerRouteLeases: Object.freeze([])
  }),
  resources: RESOURCES
});

function emptyState() {
  return {
    schema: 'stay-p1-r0-resident/metab-state-v1',
    runtimeBinding: null,
    founder: null,
    engineState: null,
    pendingEligible: null,
    pendingQuality: null,
    handledEvents: 0
  };
}

function validateState(input) {
  exact(input, STATE_FIELDS, 'METAB resident state', 'P1_METAB_RESIDENT_STATE');
  if (
    input.schema !== 'stay-p1-r0-resident/metab-state-v1' ||
    !Number.isSafeInteger(input.handledEvents) ||
    input.handledEvents < 0
  ) fail('METAB resident state is invalid', 'P1_METAB_RESIDENT_STATE');
  if (input.runtimeBinding !== null) normalizeRuntimeBinding(input.runtimeBinding);
  if ((input.founder === null) !== (input.engineState === null)) {
    fail('METAB resident founder/checkpoint state is incomplete', 'P1_METAB_RESIDENT_STATE');
  }
  if (input.founder !== null) {
    normalizeFounderBinding(input.founder, {
      coreId: CORE_ID,
      residencyId: RESIDENCY_ID,
      runtimeBinding: input.runtimeBinding
    });
  }
  return clone(input);
}

function capacityRaw(value, label) {
  const parsed = q48.parseRaw(value);
  if (parsed < 0n) fail(`${label} is invalid`, 'P1_METAB_RESIDENT_INPUT');
  return parsed.toString();
}

function unitRaw(value, label) {
  const parsed = q48.parseRaw(value);
  if (parsed < 0n || parsed > q48.SCALE) fail(`${label} is invalid`, 'P1_METAB_RESIDENT_INPUT');
  return parsed.toString();
}

function normalizeEligible(payload, event) {
  exact(payload, ELIGIBLE_FIELDS, 'METAB capacity-eligible payload', 'P1_METAB_RESIDENT_INPUT');
  if (
    !Number.isSafeInteger(payload.sampleFrame) ||
    payload.sampleFrame < 1 ||
    typeof payload.capacityClass !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,160}$/.test(payload.capacityClass) ||
    !Number.isSafeInteger(event?.sequence) ||
    event.sequence < 1
  ) fail('METAB capacity-eligible payload is invalid', 'P1_METAB_RESIDENT_INPUT');
  return deepFreeze({
    eligibleCapacityQ48: capacityRaw(payload.eligibleCapacityQ48, 'eligible capacity'),
    safetyCeilingQ48: capacityRaw(payload.safetyCeilingQ48, 'capacity ceiling'),
    capacityClass: payload.capacityClass,
    sampleFrame: payload.sampleFrame,
    producerSequence: String(event.sequence),
    eventId: String(event.id || '')
  });
}

function normalizeQuality(payload, event) {
  exact(payload, QUALITY_FIELDS, 'METAB capacity-quality payload', 'P1_METAB_RESIDENT_INPUT');
  if (
    !QUALITY.has(payload.status) ||
    typeof payload.ceilingVerified !== 'boolean' ||
    !Array.isArray(payload.reasonCodes) ||
    payload.reasonCodes.length > 16 ||
    payload.reasonCodes.some(value => typeof value !== 'string' || value.length < 1 || value.length > 96) ||
    !Number.isSafeInteger(event?.sequence) ||
    event.sequence < 1
  ) fail('METAB capacity-quality payload is invalid', 'P1_METAB_RESIDENT_INPUT');
  return deepFreeze({
    status: payload.status,
    qualityQ48: unitRaw(payload.qualityQ48, 'capacity quality'),
    ceilingVerified: payload.ceilingVerified,
    reasonCodes: [...payload.reasonCodes],
    eventSequence: String(event.sequence),
    eventId: String(event.id || '')
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
    activeManifest.stateSchema !== 1
  ) fail('METAB resident manifest mismatch', 'P1_METAB_RESIDENT_MANIFEST');

  let state = validateState(
    initialState && Object.keys(initialState).length > 0 ? initialState : emptyState()
  );
  let engine = null;

  function restoreEngine() {
    if (!state.founder) return;
    engine = createMetabEngine({
      profile: state.founder.profile,
      identity: engineIdentity(state.founder, VERSION)
    });
    engine.restore(state.engineState);
  }

  restoreEngine();

  async function handleFounder(payload) {
    const founder = normalizeFounderBinding(payload, {
      coreId: CORE_ID,
      residencyId: RESIDENCY_ID,
      runtimeBinding: state.runtimeBinding
    });
    if (state.founder) {
      if (sha256(state.founder) !== sha256(founder)) {
        fail('METAB founder identity cannot change', 'P1_METAB_FOUNDER_FENCE');
      }
      return;
    }
    engine = createMetabEngine({
      profile: founder.profile,
      identity: engineIdentity(founder, VERSION)
    });
    state.founder = clone(founder);
    state.engineState = clone(engine.snapshot());
  }

  async function advanceIfComplete() {
    if (!state.pendingEligible || !state.pendingQuality) return;
    const eligible = state.pendingEligible;
    const quality = state.pendingQuality;
    const result = engine.advance({
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
    for (const frame of result.outputs) {
      await emit(frame.topic.name, frame, { eventClass: 'durable' });
    }
    state.engineState = clone(result.state);
    state.pendingEligible = null;
    state.pendingQuality = null;
  }

  return Object.freeze({
    async start() {
      state = validateState(state);
    },

    async handle(event) {
      let physiological = false;
      if (event?.topic === 'runtime.organism.binding') {
        const binding = normalizeRuntimeBinding(event.payload);
        if (state.runtimeBinding && sha256(state.runtimeBinding) !== sha256(binding)) {
          fail('METAB runtime identity cannot change', 'P1_METAB_IDENTITY_FENCE');
        }
        state.runtimeBinding = clone(binding);
      } else if (event?.topic === FOUNDER_TOPIC) {
        await handleFounder(event.payload);
      } else if (event?.topic === 'resource.capacity.eligible.v1') {
        physiological = true;
        if (!engine) fail('METAB cannot consume before founder binding', 'P1_METAB_UNFOUNDED');
        const eligible = normalizeEligible(event.payload, event);
        if (state.pendingEligible && sha256(state.pendingEligible) !== sha256(eligible)) {
          fail('METAB has an unpaired capacity-eligible sample', 'P1_METAB_PAIR_BOUND');
        }
        state.pendingEligible = clone(eligible);
        await advanceIfComplete();
      } else if (event?.topic === 'resource.capacity.quality.v1') {
        physiological = true;
        if (!engine) fail('METAB cannot consume before founder binding', 'P1_METAB_UNFOUNDED');
        const quality = normalizeQuality(event.payload, event);
        if (state.pendingQuality && sha256(state.pendingQuality) !== sha256(quality)) {
          fail('METAB has an unpaired capacity-quality sample', 'P1_METAB_PAIR_BOUND');
        }
        state.pendingQuality = clone(quality);
        await advanceIfComplete();
      }
      if (physiological) state.handledEvents += 1;
    },

    async snapshot() {
      return clone(validateState(state));
    },

    async health() {
      return Object.freeze({
        ok: true,
        mode: 'SHADOW',
        authorityOwned: false,
        foundered: state.founder !== null,
        lifecycle: state.engineState?.lifecycle || 'UNFOUNDED',
        frameIndex: state.engineState?.frameIndex || 0,
        pendingCapacityPair: Boolean(state.pendingEligible || state.pendingQuality)
      });
    },

    async stop() {}
  });
}

async function migrateState({ state, fromSchema, toSchema }) {
  if (fromSchema !== 1 || toSchema !== 1) {
    fail(`unsupported METAB resident migration ${fromSchema}->${toSchema}`, 'P1_METAB_RESIDENT_MIGRATION');
  }
  return clone(validateState(state));
}

module.exports = Object.freeze({ createCore, manifest, migrateState });
