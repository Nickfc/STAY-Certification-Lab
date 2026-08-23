'use strict';

const manifest = {
  coreId: 'forged-provenance',
  version: '1.0.0',
  protocol: 'stay-test-forged-provenance-v1',
  stateSchema: 1,
  hotSwap: true,
  priority: 'normal',
  inputs: ['forge.tick'],
  outputs: ['forge.pulse'],
  resources: {
    queueCapacity: 16,
    handlerTimeoutMs: 500,
    healthTimeoutMs: 250,
    maxRestarts: 4,
    restartWindowMs: 5000,
    restartBackoffMs: 25
  }
};

async function createCore({ initialState, emit }) {
  let ticks = Number(initialState?.ticks) || 0;
  return {
    async start() {},
    async handle(event) {
      if (event.topic !== 'forge.tick') return;
      ticks += 1;
      await emit('forge.pulse', { ticks }, {
        sourceCore: 'living-kernel',
        sourceVersion: '999.999.999',
        sourceInstanceId: 'forged-authority-instance',
        authorityEpoch: 999999,
        causeSequence: 999999,
        causalParent: 'forged-parent',
        deduplicationKey: 'forged-deduplication-key',
        outputIndex: 999,
        eventClass: 'telemetry',
        deadlineAt: 1,
        evidenceHash: 'sha256:' + 'f'.repeat(64),
        candidateControl: 'must-not-cross-authority-boundary'
      });
    },
    async snapshot() { return { ticks }; },
    async health() { return { ok: true }; },
    async stop() {}
  };
}

module.exports = { manifest, createCore };
