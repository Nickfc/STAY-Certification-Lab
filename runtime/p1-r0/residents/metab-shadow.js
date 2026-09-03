'use strict';

const { stableStringify } = require('../../kernel/canonical-json');
const q48 = require('../q16-48');
const { createMetabEngine } = require('../metab-engine');
const {
  VERSION: NEUTRAL_VERSION,
  normalizeNeutralFounder,
  validateState: validateNeutralState
} = require('./metab-neutral');
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
const VERSION = '0.2.0-p1r0-shadow.1';
const STAGE = 'p1-r0-production-shadow-r128';
const ACTIVATION_TOPIC = 'runtime.metab.shadow-activation';
const ELIGIBLE_TOPIC = 'resource.capacity.eligible.v1';
const QUALITY_TOPIC = 'resource.capacity.quality.v1';
const FRAME_INTERVAL_MS = 250;
const ACTIVATION_PAYLOAD_FIELDS = new Set([
  'protocol', 'organismIdentityHash', 'residencyId', 'instanceId',
  'fromVersion', 'fromStateSchema', 'sourceCheckpointGeneration',
  'sourceCheckpointHash', 'toVersion', 'toStateSchema', 'runtimeRevision',
  'parentRevision', 'parentFreezeRecordSha256', 'mode', 'authorityEpoch',
  'outputPolicy'
]);
const ACTIVATION_FIELDS = new Set([
  ...ACTIVATION_PAYLOAD_FIELDS,
  'eventId', 'eventSequence', 'signalId'
]);
const ELIGIBLE_FIELDS = new Set([
  'eligibleCapacityQ48', 'safetyCeilingQ48', 'capacityClass', 'sampleFrame'
]);
const QUALITY_FIELDS = new Set([
  'status', 'qualityQ48', 'ceilingVerified', 'reasonCodes'
]);
const PENDING_ELIGIBLE_FIELDS = new Set([
  ...ELIGIBLE_FIELDS,
  'producerSequence', 'eventId', 'signalId', 'pulseId', 'observedAtMs'
]);
const PENDING_QUALITY_FIELDS = new Set([
  ...QUALITY_FIELDS,
  'eventSequence', 'eventId', 'signalId', 'parentSignalId',
  'rootSignalId', 'pulseId', 'observedAtMs', 'sampleFrame'
]);
const STATE_FIELDS = new Set([
  'schema', 'runtimeBinding', 'founder', 'activation', 'engineState',
  'pendingEligible', 'pendingQuality', 'handledEvents',
  'lastAcceptedFrame', 'lastAcceptedTimeMs'
]);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

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
    ELIGIBLE_TOPIC,
    QUALITY_TOPIC
  ]),
  outputs: Object.freeze([]),
  biology: Object.freeze({
    protocol: 'stay-biological-signalling-fabric-v1',
    producerCapabilities: Object.freeze([]),
    consumerRouteLeases: Object.freeze([])
  }),
  resources: RESOURCES
});

function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} is invalid`, 'P1_METAB_SHADOW_STATE');
  }
  return value;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    fail(`${label} is invalid`, 'P1_METAB_SHADOW_STATE');
  }
  return value;
}

function containedEngineIdentity(founder) {
  return deepFreeze({
    organismId: founder.organismId,
    founderLineageId: founder.lineageId,
    residencyId: founder.residencyId,
    coreVersion: VERSION,
    authorityEpoch: '0',
    /*
     * R128 runs physiology while retaining the engine's NEUTRAL emission
     * mode. The resident lifecycle is SHADOW; its output authority stays
     * physically absent until a later HOMEOS route gate.
     */
    mode: 'NEUTRAL'
  });
}

const ACTIVATION_BOUNDARIES = Object.freeze({
  128: Object.freeze({ label: 'r128', parentRevision: 127 }),
  135: Object.freeze({ label: 'r135', parentRevision: 127 }),
  137: Object.freeze({ label: 'r137', parentRevision: 127 })
});

function normalizeActivationPayload(payload) {
  exact(
    payload,
    ACTIVATION_PAYLOAD_FIELDS,
    'METAB shadow activation payload',
    'P1_METAB_SHADOW_ACTIVATION'
  );
  const boundary = ACTIVATION_BOUNDARIES[payload?.runtimeRevision];
  if (
    payload.protocol !== 'stay-p1-r0-metab-shadow-activation-v1' ||
    payload.residencyId !== RESIDENCY_ID ||
    payload.fromVersion !== NEUTRAL_VERSION ||
    payload.fromStateSchema !== 1 ||
    payload.toVersion !== VERSION ||
    payload.toStateSchema !== 2 ||
    !boundary ||
    payload.parentRevision !== boundary.parentRevision ||
    payload.mode !== 'SHADOW' ||
    payload.authorityEpoch !== '0' ||
    payload.outputPolicy !== 'FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT' ||
    !HASH.test(String(payload.organismIdentityHash || '')) ||
    !HASH.test(String(payload.sourceCheckpointHash || '')) ||
    !HASH.test(String(payload.parentFreezeRecordSha256 || '')) ||
    !Number.isSafeInteger(payload.sourceCheckpointGeneration) ||
    payload.sourceCheckpointGeneration < 1
  ) {
    fail('METAB shadow activation is invalid', 'P1_METAB_SHADOW_ACTIVATION');
  }
  safeId(payload.instanceId, 'METAB activation instance');
  return deepFreeze(clone(payload));
}

function normalizeBiologicalEvent(event, {
  producerId,
  sourceVersion,
  authorityEpoch,
  derived = false
} = {}) {
  const biological = event?.meta?.biological;
  const trustedTime = biological?.trustedTime;
  const causality = biological?.causality;
  if (
    event?.ledger?.durable !== true ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    typeof event.id !== 'string' ||
    !event.id ||
    biological?.protocol !== 'stay-biological-signal-v1' ||
    biological?.durability !== 'durable' ||
    biological?.provenance?.producerType !== 'kernel' ||
    biological?.provenance?.producerId !== producerId ||
    biological?.provenance?.authorityEpoch !== authorityEpoch ||
    event.meta?.sourceCore !== producerId ||
    event.meta?.sourceVersion !== sourceVersion ||
    event.meta?.authorityEpoch !== authorityEpoch ||
    trustedTime?.source !== 'kernel' ||
    !Number.isSafeInteger(trustedTime?.observedAtMs) ||
    trustedTime.observedAtMs < 0 ||
    typeof biological.signalId !== 'string' ||
    !biological.signalId ||
    !causality ||
    (derived
      ? (
          typeof causality.parentEventId !== 'string' ||
          typeof causality.rootEventId !== 'string' ||
          causality.depth !== 1
        )
      : (
          causality.parentEventId !== null ||
          causality.rootEventId !== biological.signalId ||
          causality.depth !== 0
        ))
  ) {
    fail('METAB input provenance is invalid', 'P1_METAB_SHADOW_PROVENANCE');
  }
  return biological;
}

function normalizeActivation(payload, event) {
  const normalized = normalizeActivationPayload(payload);
  const boundary = ACTIVATION_BOUNDARIES[normalized.runtimeRevision];
  const biological = normalizeBiologicalEvent(event, {
    producerId: 'living-kernel',
    sourceVersion: '0.8.11.3',
    authorityEpoch: normalized.runtimeRevision
  });
  if (
    biological.signalId !==
      `runtime.metab.shadow-activation:${boundary.label}:g${normalized.sourceCheckpointGeneration}:${normalized.sourceCheckpointHash.slice(7)}` ||
    normalized.organismIdentityHash !==
      event.meta?.evidenceHash
  ) {
    fail('METAB activation evidence is not exact', 'P1_METAB_SHADOW_ACTIVATION');
  }
  return deepFreeze({
    ...clone(normalized),
    eventId: event.id,
    eventSequence: event.sequence,
    signalId: biological.signalId
  });
}

function capacityRaw(value, label) {
  const parsed = q48.parseRaw(value);
  if (parsed < 0n) {
    fail(`${label} is invalid`, 'P1_METAB_SHADOW_INPUT');
  }
  return parsed.toString();
}

function unitRaw(value, label) {
  const parsed = q48.parseRaw(value);
  if (parsed < 0n || parsed > q48.SCALE) {
    fail(`${label} is invalid`, 'P1_METAB_SHADOW_INPUT');
  }
  return parsed.toString();
}

function frameFromPulseId(value) {
  const match = /^metab-capacity-r128-f([1-9][0-9]*)$/.exec(String(value || ''));
  const frame = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(frame) || frame < 1) {
    fail('METAB capacity pulse identity is invalid', 'P1_METAB_SHADOW_INPUT');
  }
  return frame;
}

function normalizeEligible(payload, event) {
  exact(payload, ELIGIBLE_FIELDS, 'METAB capacity-eligible payload', 'P1_METAB_SHADOW_INPUT');
  const biological = normalizeBiologicalEvent(event, {
    producerId: 'kernel-resource',
    sourceVersion: '1.0.0',
    authorityEpoch: 0
  });
  const sampleFrame = safeInteger(payload.sampleFrame, 'METAB sample frame', 1);
  const pulseId = biological.trustedTime?.pulseId;
  const eligibleCapacityQ48 = capacityRaw(
    payload.eligibleCapacityQ48,
    'eligible capacity'
  );
  const safetyCeilingQ48 = unitRaw(
    payload.safetyCeilingQ48,
    'capacity ceiling'
  );
  if (
    frameFromPulseId(pulseId) !== sampleFrame ||
    biological.signalId !== `runtime.metab.capacity.eligible:r128:f${sampleFrame}` ||
    payload.capacityClass !== 'HOST_RESOURCE_HEADROOM_V1' ||
    safetyCeilingQ48 !== q48.SCALE.toString() ||
    q48.parseRaw(eligibleCapacityQ48) > q48.parseRaw(safetyCeilingQ48)
  ) {
    fail('METAB capacity-eligible identity is invalid', 'P1_METAB_SHADOW_INPUT');
  }
  return deepFreeze({
    eligibleCapacityQ48,
    safetyCeilingQ48,
    capacityClass: payload.capacityClass,
    sampleFrame,
    producerSequence: String(event.sequence),
    eventId: event.id,
    signalId: biological.signalId,
    pulseId,
    observedAtMs: biological.trustedTime.observedAtMs
  });
}

function normalizeQuality(payload, event) {
  exact(payload, QUALITY_FIELDS, 'METAB capacity-quality payload', 'P1_METAB_SHADOW_INPUT');
  const biological = normalizeBiologicalEvent(event, {
    producerId: 'kernel-resource',
    sourceVersion: '1.0.0',
    authorityEpoch: 0,
    derived: true
  });
  const pulseId = biological.trustedTime?.pulseId;
  const sampleFrame = frameFromPulseId(pulseId);
  const qualityQ48 = unitRaw(
    payload.qualityQ48,
    'capacity quality'
  );
  if (
    biological.signalId !== `runtime.metab.capacity.quality:r128:f${sampleFrame}` ||
    payload.status !== 'VALID' ||
    qualityQ48 !== q48.SCALE.toString() ||
    payload.ceilingVerified !== true ||
    !Array.isArray(payload.reasonCodes) ||
    stableStringify(payload.reasonCodes) !== stableStringify([
      'TRUSTED_ORGANISM_TIME',
      'KERNEL_CPU_HEADROOM',
      'KERNEL_MEMORY_HEADROOM'
    ])
  ) {
    fail('METAB capacity-quality identity is invalid', 'P1_METAB_SHADOW_INPUT');
  }
  return deepFreeze({
    status: payload.status,
    qualityQ48,
    ceilingVerified: payload.ceilingVerified,
    reasonCodes: [...payload.reasonCodes],
    eventSequence: String(event.sequence),
    eventId: event.id,
    signalId: biological.signalId,
    parentSignalId: biological.causality.parentEventId,
    rootSignalId: biological.causality.rootEventId,
    pulseId,
    observedAtMs: biological.trustedTime.observedAtMs,
    sampleFrame
  });
}

function normalizeStoredEligible(input) {
  exact(input, PENDING_ELIGIBLE_FIELDS, 'stored METAB eligible sample', 'P1_METAB_SHADOW_STATE');
  const sampleFrame = safeInteger(input.sampleFrame, 'stored METAB sample frame', 1);
  const observedAtMs = safeInteger(input.observedAtMs, 'stored METAB observed time');
  const producerSequence = safeInteger(
    Number(input.producerSequence),
    'stored METAB producer sequence',
    1
  );
  if (
    input.producerSequence !== String(producerSequence) ||
    input.capacityClass !== 'HOST_RESOURCE_HEADROOM_V1' ||
    input.pulseId !== `metab-capacity-r128-f${sampleFrame}` ||
    input.signalId !== `runtime.metab.capacity.eligible:r128:f${sampleFrame}`
  ) {
    fail('stored METAB eligible identity is invalid', 'P1_METAB_SHADOW_STATE');
  }
  safeId(input.eventId, 'stored METAB eligible event');
  const eligibleCapacityQ48 = capacityRaw(
    input.eligibleCapacityQ48,
    'stored eligible capacity'
  );
  const safetyCeilingQ48 = unitRaw(
    input.safetyCeilingQ48,
    'stored capacity ceiling'
  );
  if (
    safetyCeilingQ48 !== q48.SCALE.toString() ||
    q48.parseRaw(eligibleCapacityQ48) > q48.parseRaw(safetyCeilingQ48)
  ) {
    fail('stored METAB eligible capacity is invalid', 'P1_METAB_SHADOW_STATE');
  }
  return deepFreeze({
    eligibleCapacityQ48,
    safetyCeilingQ48,
    capacityClass: input.capacityClass,
    sampleFrame,
    producerSequence: input.producerSequence,
    eventId: input.eventId,
    signalId: input.signalId,
    pulseId: input.pulseId,
    observedAtMs
  });
}

function normalizeStoredQuality(input) {
  exact(input, PENDING_QUALITY_FIELDS, 'stored METAB quality sample', 'P1_METAB_SHADOW_STATE');
  const sampleFrame = safeInteger(input.sampleFrame, 'stored METAB quality frame', 1);
  const observedAtMs = safeInteger(input.observedAtMs, 'stored METAB quality time');
  const eventSequence = safeInteger(
    Number(input.eventSequence),
    'stored METAB quality sequence',
    1
  );
  if (
    input.eventSequence !== String(eventSequence) ||
    input.status !== 'VALID' ||
    input.ceilingVerified !== true ||
    !Array.isArray(input.reasonCodes) ||
    stableStringify(input.reasonCodes) !== stableStringify([
      'TRUSTED_ORGANISM_TIME',
      'KERNEL_CPU_HEADROOM',
      'KERNEL_MEMORY_HEADROOM'
    ]) ||
    input.pulseId !== `metab-capacity-r128-f${sampleFrame}` ||
    input.signalId !== `runtime.metab.capacity.quality:r128:f${sampleFrame}` ||
    input.parentSignalId !== `runtime.metab.capacity.eligible:r128:f${sampleFrame}` ||
    input.rootSignalId !== input.parentSignalId
  ) {
    fail('stored METAB quality identity is invalid', 'P1_METAB_SHADOW_STATE');
  }
  safeId(input.eventId, 'stored METAB quality event');
  const qualityQ48 = unitRaw(input.qualityQ48, 'stored capacity quality');
  if (qualityQ48 !== q48.SCALE.toString()) {
    fail('stored METAB quality value is invalid', 'P1_METAB_SHADOW_STATE');
  }
  return deepFreeze({
    status: input.status,
    qualityQ48,
    ceilingVerified: input.ceilingVerified,
    reasonCodes: [...input.reasonCodes],
    eventSequence: input.eventSequence,
    eventId: input.eventId,
    signalId: input.signalId,
    parentSignalId: input.parentSignalId,
    rootSignalId: input.rootSignalId,
    pulseId: input.pulseId,
    observedAtMs,
    sampleFrame
  });
}

function createShadowStagingState(neutralInput) {
  const neutral = validateNeutralState(neutralInput);
  return deepFreeze({
    schema: 'stay-p1-r0-resident/metab-shadow-state-v2',
    runtimeBinding: clone(neutral.runtimeBinding),
    founder: clone(neutral.founder),
    activation: null,
    engineState: clone(neutral.engineState),
    pendingEligible: null,
    pendingQuality: null,
    handledEvents: 0,
    lastAcceptedFrame: 0,
    lastAcceptedTimeMs: null
  });
}

function validateState(input) {
  exact(input, STATE_FIELDS, 'METAB shadow resident state', 'P1_METAB_SHADOW_STATE');
  if (
    input.schema !== 'stay-p1-r0-resident/metab-shadow-state-v2' ||
    !Number.isSafeInteger(input.handledEvents) ||
    input.handledEvents < 0 ||
    !Number.isSafeInteger(input.lastAcceptedFrame) ||
    input.lastAcceptedFrame < 0
  ) {
    fail('METAB shadow state is invalid', 'P1_METAB_SHADOW_STATE');
  }
  const runtimeBinding = normalizeRuntimeBinding(input.runtimeBinding);
  const founder = normalizeNeutralFounder(input.founder, runtimeBinding);
  const activation = input.activation === null
    ? null
    : (() => {
        exact(input.activation, ACTIVATION_FIELDS, 'stored METAB activation', 'P1_METAB_SHADOW_STATE');
        const payload = {};
        for (const field of ACTIVATION_PAYLOAD_FIELDS) payload[field] = input.activation[field];
        normalizeActivationPayload(payload);
        safeId(input.activation.eventId, 'stored METAB activation event');
        safeId(input.activation.signalId, 'stored METAB activation signal');
        safeInteger(input.activation.eventSequence, 'stored METAB activation sequence', 1);
        return clone(input.activation);
      })();
  const engine = createMetabEngine({
    profile: founder.profile,
    identity: containedEngineIdentity(founder)
  });
  engine.restore(input.engineState);
  const engineState = engine.snapshot();
  const pendingEligible = input.pendingEligible === null
    ? null
    : normalizeStoredEligible(input.pendingEligible);
  const pendingQuality = input.pendingQuality === null
    ? null
    : normalizeStoredQuality(input.pendingQuality);

  if (
    engineState.frameIndex !== input.lastAcceptedFrame ||
    engineState.outputSequence !== '0' ||
    (input.lastAcceptedFrame === 0) !== (input.lastAcceptedTimeMs === null) ||
    (input.lastAcceptedTimeMs !== null &&
      (!Number.isSafeInteger(input.lastAcceptedTimeMs) || input.lastAcceptedTimeMs < 0)) ||
    (!activation && (
      input.handledEvents !== 0 ||
      input.lastAcceptedFrame !== 0 ||
      pendingEligible !== null ||
      pendingQuality !== null
    )) ||
    (pendingEligible && pendingEligible.sampleFrame !== input.lastAcceptedFrame + 1) ||
    (pendingQuality && pendingQuality.sampleFrame !== input.lastAcceptedFrame + 1)
  ) {
    fail('METAB shadow chronology is invalid', 'P1_METAB_SHADOW_STATE');
  }

  return deepFreeze({
    schema: input.schema,
    runtimeBinding: clone(runtimeBinding),
    founder: clone(founder),
    activation: activation === null ? null : clone(activation),
    engineState: clone(engineState),
    pendingEligible: pendingEligible === null ? null : clone(pendingEligible),
    pendingQuality: pendingQuality === null ? null : clone(pendingQuality),
    handledEvents: input.handledEvents,
    lastAcceptedFrame: input.lastAcceptedFrame,
    lastAcceptedTimeMs: input.lastAcceptedTimeMs
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
    activeManifest.stateSchema !== 2 ||
    stableStringify(activeManifest.inputs) !== stableStringify(manifest.inputs) ||
    stableStringify(activeManifest.outputs) !== stableStringify([]) ||
    typeof emit !== 'function'
  ) {
    fail('METAB shadow manifest mismatch', 'P1_METAB_SHADOW_MANIFEST');
  }
  if (!initialState || Object.keys(initialState).length === 0) {
    fail('METAB shadow requires preserved neutral state', 'P1_METAB_SHADOW_STATE');
  }

  let state = clone(validateState(initialState));
  let engine = createMetabEngine({
    profile: state.founder.profile,
    identity: containedEngineIdentity(state.founder)
  });
  engine.restore(state.engineState);

  async function advanceIfComplete() {
    if (!state.pendingEligible || !state.pendingQuality) return;
    const eligible = state.pendingEligible;
    const quality = state.pendingQuality;
    if (
      eligible.sampleFrame !== quality.sampleFrame ||
      eligible.pulseId !== quality.pulseId ||
      eligible.observedAtMs !== quality.observedAtMs ||
      quality.parentSignalId !== eligible.signalId ||
      quality.rootSignalId !== eligible.signalId ||
      eligible.sampleFrame !== state.lastAcceptedFrame + 1 ||
      (state.lastAcceptedTimeMs !== null &&
        eligible.observedAtMs - state.lastAcceptedTimeMs < FRAME_INTERVAL_MS)
    ) {
      fail('METAB capacity pair is not one trusted future frame', 'P1_METAB_SHADOW_PAIR');
    }
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
    if (
      result.outputs.length !== 0 ||
      result.state.outputSequence !== '0'
    ) {
      fail('METAB R128 output firewall failed', 'P1_METAB_SHADOW_OUTPUT');
    }
    state.engineState = clone(result.state);
    state.lastAcceptedFrame = eligible.sampleFrame;
    state.lastAcceptedTimeMs = eligible.observedAtMs;
    state.pendingEligible = null;
    state.pendingQuality = null;
  }

  return Object.freeze({
    async start() {
      state = clone(validateState(state));
    },

    async handle(event) {
      if (event?.topic === 'runtime.organism.binding') {
        const binding = normalizeRuntimeBinding(event.payload);
        if (sha256(binding) !== sha256(state.runtimeBinding)) {
          fail('METAB runtime identity cannot change', 'P1_METAB_SHADOW_IDENTITY');
        }
        return;
      }

      if (event?.topic === ACTIVATION_TOPIC) {
        const activation = normalizeActivation(event.payload, event);
        if (state.activation) {
          if (sha256(state.activation) !== sha256(activation)) {
            fail('METAB activation cannot change', 'P1_METAB_SHADOW_ACTIVATION');
          }
          return;
        }
        if (
          activation.organismIdentityHash !== state.runtimeBinding.identitySha256 ||
          activation.fromVersion !== NEUTRAL_VERSION ||
          activation.sourceCheckpointHash !== event.payload.sourceCheckpointHash
        ) {
          fail('METAB activation lost neutral lineage', 'P1_METAB_SHADOW_ACTIVATION');
        }
        state.activation = clone(activation);
        return;
      }

      if (!state.activation) {
        fail('METAB cannot consume before shadow activation', 'P1_METAB_SHADOW_UNACTIVATED');
      }

      let physiological = false;
      if (event?.topic === ELIGIBLE_TOPIC) {
        physiological = true;
        const eligible = normalizeEligible(event.payload, event);
        if (
          state.pendingEligible &&
          sha256(state.pendingEligible) !== sha256(eligible)
        ) {
          fail('METAB has an unpaired capacity-eligible sample', 'P1_METAB_SHADOW_PAIR');
        }
        state.pendingEligible = clone(eligible);
        await advanceIfComplete();
      } else if (event?.topic === QUALITY_TOPIC) {
        physiological = true;
        const quality = normalizeQuality(event.payload, event);
        if (
          state.pendingQuality &&
          sha256(state.pendingQuality) !== sha256(quality)
        ) {
          fail('METAB has an unpaired capacity-quality sample', 'P1_METAB_SHADOW_PAIR');
        }
        state.pendingQuality = clone(quality);
        await advanceIfComplete();
      } else {
        fail('METAB shadow input is forbidden', 'P1_METAB_SHADOW_INPUT');
      }
      if (physiological) state.handledEvents += 1;
    },

    async snapshot() {
      return clone(validateState(state));
    },

    async health() {
      const verified = validateState(state);
      return Object.freeze({
        ok: verified.activation !== null,
        mode: 'SHADOW',
        authorityOwned: false,
        foundered: true,
        activated: verified.activation !== null,
        lifecycle: verified.engineState.lifecycle,
        frameIndex: verified.lastAcceptedFrame,
        lastAcceptedTimeMs: verified.lastAcceptedTimeMs,
        pendingCapacityPair: Boolean(
          verified.pendingEligible ||
          verified.pendingQuality
        ),
        biologicalOutputs: 0,
        physiologicalInputs: verified.handledEvents,
        outputPolicy: 'FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT'
      });
    },

    async stop() {}
  });
}

async function migrateState({ state, fromSchema, toSchema }) {
  if (fromSchema === 1 && toSchema === 2) {
    return clone(createShadowStagingState(state));
  }
  if (fromSchema === 2 && toSchema === 2) {
    return clone(validateState(state));
  }
  fail(
    `unsupported METAB shadow migration ${fromSchema}->${toSchema}`,
    'P1_METAB_SHADOW_MIGRATION'
  );
}

module.exports = Object.freeze({
  ACTIVATION_TOPIC,
  CORE_ID,
  ELIGIBLE_TOPIC,
  QUALITY_TOPIC,
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
