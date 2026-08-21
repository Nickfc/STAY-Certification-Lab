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
} = require('./state');

const manifest = Object.freeze({
  coreId: 'chronobiology',
  version: '0.4.0-c2c',
  protocol: 'stay-chronobiology-v1',
  stateSchema: 1,
  hotSwap: true,
  priority: 'optional',
  stage: 'c2c-persistence-recovery',
  productionEligible: false,
  inputs: Object.freeze([
    'runtime.organism.binding',
    TRUSTED_TIME_TOPIC,
    PHOTIC_TOPIC,
  ]),
  outputs: Object.freeze([
    'chronobiology.phase.summary',
  ]),
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

async function createCore({ manifest: activeManifest = manifest, initialState } = {}) {
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
        state = advanceTrustedTime(state, event);
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
