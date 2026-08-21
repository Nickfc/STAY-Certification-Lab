'use strict';

const { deriveAggregate } = require('./aggregate');
const {
  TRUSTED_TIME_TOPIC,
  PHOTIC_TOPIC,
  advanceTrustedTime,
  bindState,
  emptyState,
  normalizeState,
  queuePhoticEvidence,
  recordSummaryEmission,
} = require('./state');
const { buildPhaseSummary, shouldEmitPhaseSummary } = require('./summary');

const manifest = Object.freeze({
  coreId: 'chronobiology',
  version: '0.6.0-c3b',
  protocol: 'stay-chronobiology-v1',
  stateSchema: 1,
  hotSwap: true,
  priority: 'optional',
  stage: 'c3b-shadow-integration',
  productionEligible: false,
  inputs: Object.freeze([
    'runtime.organism.binding',
    TRUSTED_TIME_TOPIC,
    PHOTIC_TOPIC,
  ]),
  outputs: Object.freeze([
    'chronobiology.phase.summary',
  ]),
  biology: Object.freeze({
    protocol: 'stay-biological-signalling-fabric-v1',
    producerCapabilities: Object.freeze([Object.freeze({
      id: 'chronobiology-phase-summary-shadow',
      topic: 'chronobiology.phase.summary',
      signalClass: 'CHRONOBIOLOGICAL_CONTEXT',
      schemaVersions: Object.freeze([1]),
      producerStreamIds: Object.freeze(['core:chronobiology:outputs']),
      maxRate: Object.freeze({ events: 96, intervalUs: 86_400_000_000 }),
      maxPayloadBytes: 4096,
      maxValidityUs: 7_200_000_000,
      allowedAuthorityModes: Object.freeze(['shadow']),
    })]),
    consumerRouteLeases: Object.freeze([]),
  }),
  resources: Object.freeze({
    softRamMiB: 64,
    hardRamMiB: 96,
    softCpuPercent: 5,
    hardCpuPercent: 20,
    pidsMax: 16,
    queueCapacity: 256,
    handlerTimeoutMs: 250,
    healthTimeoutMs: 1000,
    outputCapacity: 128,
    outputLimitPerEvent: 16,
    outputBytesPerEvent: 65536,
    storageMiB: 4,
    maxRestarts: 4,
    restartWindowMs: 60_000,
    restartBackoffMs: 250,
  }),
});

async function createCore({
  manifest: activeManifest = manifest,
  initialState,
  emit = async () => null,
} = {}) {
  if (activeManifest.coreId !== manifest.coreId
    || activeManifest.version !== manifest.version
    || activeManifest.stateSchema !== manifest.stateSchema) {
    throw Object.assign(new Error('Chronobiology manifest contract mismatch'), {
      code: 'CHRONOBIOLOGY_MANIFEST_MISMATCH',
    });
  }

  let state = normalizeState(initialState || emptyState());

  return Object.freeze({
    async start() {
      state = normalizeState(state);
    },

    async handle(event) {
      if (event?.topic === 'runtime.organism.binding') {
        state = bindState(state, event);
      } else if (event?.topic === TRUSTED_TIME_TOPIC) {
        const candidate = advanceTrustedTime(state, event);
        if (candidate !== state && shouldEmitPhaseSummary(candidate)) {
          const payload = buildPhaseSummary(candidate);
          const committed = recordSummaryEmission(candidate, payload);
          await emit('chronobiology.phase.summary', payload, { eventClass: 'durable' });
          state = committed;
        } else {
          state = candidate;
        }
      } else if (event?.topic === PHOTIC_TOPIC) {
        state = queuePhoticEvidence(state, event);
      }
      // C1 is observably neutral. A later C3 shadow gate publishes summaries.
      return undefined;
    },

    async snapshot() {
      return structuredClone(normalizeState(state));
    },

    async health() {
      const current = normalizeState(state);
      return Object.freeze({
        ok: true,
        mode: current.mode,
        stage: activeManifest.stage,
        genesisEstablished: current.genesis !== null,
        committedThroughUs: current.continuity?.committed_through_us ?? null,
        aggregate: current.genesis ? deriveAggregate(current) : null,
        lastSummaryEmittedUs: current.continuity?.last_summary_emitted_us ?? null,
      });
    },

    async stop() {},
  });
}

async function migrateState({ state, fromSchema, toSchema }) {
  if (fromSchema !== 1 || toSchema !== 1) {
    throw Object.assign(new Error(`unsupported Chronobiology migration ${fromSchema}->${toSchema}`), {
      code: 'CHRONOBIOLOGY_MIGRATION_UNSUPPORTED',
    });
  }
  return structuredClone(normalizeState(state));
}

module.exports = {
  createCore,
  manifest,
  migrateState,
};
