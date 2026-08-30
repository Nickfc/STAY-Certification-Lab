'use strict';

const { createHomeosEngine } = require('../homeos-engine');
const {
  FOUNDER_TOPICS,
  RESOURCES,
  boundedInsert,
  clone,
  deepFreeze,
  engineIdentity,
  exact,
  fail,
  frameFromEvent,
  normalizeFounderBinding,
  normalizeRuntimeBinding,
  sha256
} = require('../resident-support');

const CORE_ID = 'HOMEOS';
const RESIDENCY_ID = 'resident:homeos';
const VERSION = '0.1.0-p1r0-lab';
const FOUNDER_TOPIC = FOUNDER_TOPICS.HOMEOS;
const STATE_FIELDS = new Set([
  'schema', 'runtimeBinding', 'founder', 'engineState', 'pendingAvailability',
  'pendingReserve', 'handledEvents'
]);

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
    'metab.energy.availability.v1',
    'metab.energy.reserve.v1'
  ]),
  outputs: Object.freeze([
    'homeos.dimension.summary.v1',
    'homeos.stability.summary.v1'
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
    schema: 'stay-p1-r0-resident/homeos-state-v1',
    runtimeBinding: null,
    founder: null,
    engineState: null,
    pendingAvailability: {},
    pendingReserve: {},
    handledEvents: 0
  };
}

function validatePending(record, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length > 16) {
    fail(`${label} is invalid`, 'P1_HOMEOS_RESIDENT_STATE');
  }
  for (const key of Object.keys(record)) {
    if (!/^[1-9][0-9]*$/.test(key)) fail(`${label} key is invalid`, 'P1_HOMEOS_RESIDENT_STATE');
    frameFromEvent({ payload: record[key] }, CORE_ID);
  }
}

function validateState(input) {
  exact(input, STATE_FIELDS, 'HOMEOS resident state', 'P1_HOMEOS_RESIDENT_STATE');
  if (
    input.schema !== 'stay-p1-r0-resident/homeos-state-v1' ||
    !Number.isSafeInteger(input.handledEvents) ||
    input.handledEvents < 0
  ) fail('HOMEOS resident state is invalid', 'P1_HOMEOS_RESIDENT_STATE');
  if (input.runtimeBinding !== null) normalizeRuntimeBinding(input.runtimeBinding);
  if ((input.founder === null) !== (input.engineState === null)) {
    fail('HOMEOS resident founder/checkpoint state is incomplete', 'P1_HOMEOS_RESIDENT_STATE');
  }
  if (input.founder !== null) {
    normalizeFounderBinding(input.founder, {
      coreId: CORE_ID,
      residencyId: RESIDENCY_ID,
      runtimeBinding: input.runtimeBinding
    });
  }
  validatePending(input.pendingAvailability, 'HOMEOS pending availability');
  validatePending(input.pendingReserve, 'HOMEOS pending reserve');
  return clone(input);
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
  ) fail('HOMEOS resident manifest mismatch', 'P1_HOMEOS_RESIDENT_MANIFEST');

  let state = validateState(
    initialState && Object.keys(initialState).length > 0 ? initialState : emptyState()
  );
  let engine = null;

  function restoreEngine() {
    if (!state.founder) return;
    engine = createHomeosEngine({
      profile: state.founder.profile,
      identity: engineIdentity(state.founder, VERSION)
    });
    engine.restore(state.engineState);
  }

  restoreEngine();

  function bindFounder(payload) {
    const founder = normalizeFounderBinding(payload, {
      coreId: CORE_ID,
      residencyId: RESIDENCY_ID,
      runtimeBinding: state.runtimeBinding
    });
    if (state.founder) {
      if (sha256(state.founder) !== sha256(founder)) {
        fail('HOMEOS founder identity cannot change', 'P1_HOMEOS_FOUNDER_FENCE');
      }
      return;
    }
    engine = createHomeosEngine({
      profile: founder.profile,
      identity: engineIdentity(founder, VERSION)
    });
    state.founder = clone(founder);
    state.engineState = clone(engine.snapshot());
  }

  async function drainCompletePairs() {
    let transitions = 0;
    while (transitions < 5) {
      const sourceFrame = state.engineState.frameIndex === 0 ? 1 : state.engineState.frameIndex;
      const key = String(sourceFrame);
      if (!state.pendingAvailability[key] || !state.pendingReserve[key]) return;
      const result = engine.advance({
        frameIndex: sourceFrame + 1,
        inputs: [state.pendingAvailability[key], state.pendingReserve[key]]
      });
      for (const frame of result.outputs) {
        await emit(frame.topic.name, frame, { eventClass: 'durable' });
      }
      state.engineState = clone(result.state);
      delete state.pendingAvailability[key];
      delete state.pendingReserve[key];
      transitions += 1;
    }
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
          fail('HOMEOS runtime identity cannot change', 'P1_HOMEOS_IDENTITY_FENCE');
        }
        state.runtimeBinding = clone(binding);
      } else if (event?.topic === FOUNDER_TOPIC) {
        bindFounder(event.payload);
      } else if (
        event?.topic === 'metab.energy.availability.v1' ||
        event?.topic === 'metab.energy.reserve.v1'
      ) {
        physiological = true;
        if (!engine) fail('HOMEOS cannot consume before founder binding', 'P1_HOMEOS_UNFOUNDED');
        const frame = frameFromEvent(event, CORE_ID);
        if (frame) {
          const key = String(frame.committedFrame);
          if (event.topic === 'metab.energy.availability.v1') {
            boundedInsert(state.pendingAvailability, key, frame);
          } else {
            boundedInsert(state.pendingReserve, key, frame);
          }
          await drainCompletePairs();
        }
      }
      if (physiological) state.handledEvents += 1;
    },

    async snapshot() {
      return clone(validateState(state));
    },

    async health() {
      return deepFreeze({
        ok: true,
        mode: 'SHADOW',
        authorityOwned: false,
        foundered: state.founder !== null,
        lifecycle: state.engineState?.lifecycle || 'UNFOUNDED',
        frameIndex: state.engineState?.frameIndex || 0,
        pendingFrames: Object.keys(state.pendingAvailability).length + Object.keys(state.pendingReserve).length
      });
    },

    async stop() {}
  });
}

async function migrateState({ state, fromSchema, toSchema }) {
  if (fromSchema !== 1 || toSchema !== 1) {
    fail(`unsupported HOMEOS resident migration ${fromSchema}->${toSchema}`, 'P1_HOMEOS_RESIDENT_MIGRATION');
  }
  return clone(validateState(state));
}

module.exports = Object.freeze({ createCore, manifest, migrateState });
