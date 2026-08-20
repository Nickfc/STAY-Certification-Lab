'use strict';

const manifest = Object.freeze({
  coreId: 'chronobiology-fixture',
  version: '0.0.0-test',
  protocol: 'stay-chronobiology-test-v1',
  stateSchema: 1,
  hotSwap: true,
  priority: 'optional',
  stage: 'laboratory-resident-fixture',
  productionEligible: false,
  inputs: Object.freeze([
    'runtime.organism.binding',
    'runtime.time.pulse',
    'environment.photic.exposure',
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
    restartWindowMs: 60000,
    restartBackoffMs: 250,
  }),
});

function createCore() {
  let state = Object.freeze({ schemaVersion: 1, transitionCount: 0 });
  return {
    manifest,
    async initialize(snapshot) {
      if (snapshot) state = Object.freeze({ ...snapshot });
      return { ready: true };
    },
    async handleEvent() {
      state = Object.freeze({ ...state, transitionCount: state.transitionCount + 1 });
      return { outputs: [] };
    },
    async snapshot() {
      return { ...state };
    },
    async health() {
      return { healthy: true };
    },
    async shutdown() {},
  };
}

module.exports = { manifest, createCore };
