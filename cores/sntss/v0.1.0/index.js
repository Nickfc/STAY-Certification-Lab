'use strict';

const HASH = /^sha256:[0-9a-f]{64}$/;
const { speciesProfile } = require('./species-profile');
const { sourceRegistry } = require('./source-registry');
const { receptorProfileRegistry } = require('./receptor-profiles');

const manifest = Object.freeze({
  coreId: 'sntss',
  version: '0.1.0',
  protocol: 'stay-sntss-v1',
  stateSchema: 1,
  hotSwap: true,
  priority: 'optional',
  stage: 'laboratory-r4-profile',
  productionEligible: false,
  inputs: Object.freeze(['runtime.organism.binding', 'runtime.time.pulse']),
  outputs: Object.freeze([]),
  resources: Object.freeze({
    softRamMiB: 64, hardRamMiB: 96, softCpuPercent: 5, hardCpuPercent: 20, pidsMax: 16,
    queueCapacity: 256, handlerTimeoutMs: 250, healthTimeoutMs: 1000, outputCapacity: 128,
    outputLimitPerEvent: 16, outputBytesPerEvent: 65536, storageMiB: 4,
    maxRestarts: 4, restartWindowMs: 60000, restartBackoffMs: 250
  })
});

function validate(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw Object.assign(new Error('SNTSS laboratory state is invalid'), { code: 'SNTSS_STATE_INVALID' });
  if (state.organismBinding != null && (!HASH.test(state.organismBinding.identitySha256) || state.organismBinding.organismLineage !== 'STAY/Genesis')) {
    throw Object.assign(new Error('SNTSS laboratory binding is invalid'), { code: 'SNTSS_STATE_INVALID' });
  }
}

function project(source = {}) {
  validate(source);
  return {
    formatVersion: 1, stateSchema: 1, protocol: 'stay-sntss-v1', coreVersion: manifest.version,
    stage: 'neutral', organismBinding: source.organismBinding ? { ...source.organismBinding } : null,
    transmitters: {}, receptors: {}, migrations: Array.isArray(source.migrations) ? [...source.migrations] : []
  };
}

async function createCore({ initialState }) {
  const state = project(initialState);
  return {
    async start() { validate(state); },
    async handle(event) {
      if (event.topic === 'runtime.organism.binding' && !state.organismBinding) state.organismBinding = { ...event.payload, bindingEventId: event.id };
    },
    async snapshot() { return project(state); },
    async health() {
      return {
        ok: true,
        stage: 'laboratory-r4-profile',
        bound: Boolean(state.organismBinding),
        chemistryActive: false,
        calibratedFamilies: speciesProfile.activeFamilies.length,
        dormantFamilies: speciesProfile.dormantFamilies.length,
        profileHash: speciesProfile.profileHash,
        semanticPolicies: Object.keys(sourceRegistry.policies).length,
        productionSemanticTopics: 0,
        sourceRegistryHash: sourceRegistry.registryHash,
        laboratoryReceptorProfiles: Object.keys(receptorProfileRegistry.profiles).length,
        productionReceptorConsumers: 0,
        receptorProfileRegistryHash: receptorProfileRegistry.registryHash
      };
    },
    async stop() {}
  };
}

async function migrateState({ state, fromSchema, toSchema }) {
  if (Number(fromSchema) !== 1 || Number(toSchema) !== 1) throw Object.assign(new Error('unsupported SNTSS migration'), { code: 'SNTSS_MIGRATION_UNSUPPORTED' });
  return project(state);
}

module.exports = { manifest, createCore, migrateState };
