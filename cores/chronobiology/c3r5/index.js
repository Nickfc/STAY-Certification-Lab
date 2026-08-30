'use strict';

const { stableStringify } = require('../../../runtime/kernel/canonical-json');
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
  resumeDeferredTrustedTime,
} = require('./state');
const { buildPhaseSummary, shouldEmitPhaseSummary } = require('./summary');

const manifest = Object.freeze({
  coreId: 'chronobiology',
  version: '1.0.0-c3rc.5',
  protocol: 'stay-chronobiology-v1',
  stateSchema: 2,
  hotSwap: true,
  priority: 'optional',
  stage: 'c3-shadow-jitless-bounded-catchup-repair',
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
        const candidate = resumeDeferredTrustedTime(state, event);
        if (candidate !== state && shouldEmitPhaseSummary(candidate)) {
          const payload = buildPhaseSummary(candidate);
          const committed = recordSummaryEmission(candidate, payload);
          await emit('chronobiology.phase.summary', payload, { eventClass: 'durable' });
          state = committed;
        } else {
          state = candidate;
        }
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
  if (fromSchema === 2 && toSchema === 2) {
    return structuredClone(normalizeState(state));
  }
  if (fromSchema === 1 && toSchema === 2) {
    const legacy = structuredClone(state);
    if (!legacy || legacy.schema !== 'chronobiology.state/v1'
      || legacy.continuity?.state_schema_version !== 1) {
      throw Object.assign(new Error('Chronobiology schema-v1 migration input is invalid'), {
        code: 'CHRONOBIOLOGY_MIGRATION_INVALID',
      });
    }
    const inputStateHash = require('./founder').sha256(stableStringify(legacy));
    legacy.schema = 'chronobiology.state/v2';
    legacy.acquired.aggregate_phase_history ??= [];
    legacy.continuity.photic_route_configured ??= false;
    legacy.continuity.pending_photic_evidence ??= [];
    legacy.continuity.recent_photic_evidence ??= [];
    legacy.continuity.last_summary_emitted_us ??= null;
    legacy.continuity.last_summary_payload_hash ??= null;
    legacy.continuity.deferred_trusted_time_evidence ??= null;
    legacy.continuity.state_schema_version = 2;
    legacy.continuity.representation_migrations = [{
      migration_id: 'chronobiology-state-v1-to-v2',
      from_schema: 1,
      to_schema: 2,
      applied_at_us: legacy.continuity.committed_through_us,
      input_state_hash: inputStateHash,
    }];
    return structuredClone(normalizeState(legacy));
  }
  {
    throw Object.assign(new Error(`unsupported Chronobiology migration ${fromSchema}->${toSchema}`), {
      code: 'CHRONOBIOLOGY_MIGRATION_UNSUPPORTED',
    });
  }
}

module.exports = {
  createCore,
  manifest,
  migrateState,
};
