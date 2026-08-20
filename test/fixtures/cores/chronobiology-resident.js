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
    'runtime.trusted-organism-time.pulse',
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

async function createCore({ initialState, emit }) {
  const state = {
    schemaVersion: 1,
    transitionCount: Number(initialState?.transitionCount) || 0,
  };
  return {
    async start() {},
    async handle(event) {
      state.transitionCount += 1;
      if (event.topic === 'environment.photic.exposure') {
        await emit('chronobiology.phase.summary', {
          transitionCount: state.transitionCount,
          mode: 'LABORATORY',
        }, { eventClass: 'durable' });
      }
    },
    async snapshot() {
      return { ...state };
    },
    async health() {
      return { ok: true };
    },
    async stop() {},
  };
}

module.exports = { manifest, createCore };
