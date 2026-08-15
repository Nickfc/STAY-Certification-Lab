'use strict';

const manifest = Object.freeze({
  coreId: 'ledger-producer',
  version: '1.0.0',
  protocol: 'stay-ledger-test-v1',
  stateSchema: 1,
  hotSwap: true,
  priority: 'optional',
  inputs: ['bio.tick'],
  outputs: ['bio.observed'],
  resources: { queueCapacity: 16, handlerTimeoutMs: 500, healthTimeoutMs: 250, storageMiB: 1 }
});

async function createCore({ initialState, emit }) {
  const state = { ticks: Number(initialState?.ticks) || 0 };
  return {
    async start() {},
    async handle(event) {
      if (event.topic !== 'bio.tick') return;
      state.ticks += 1;
      await emit('bio.observed', { ticks: state.ticks, sourceEventId: event.id }, { eventClass: 'durable' });
    },
    async snapshot() { return { ...state }; },
    async health() { return { ok: true, ticks: state.ticks }; },
    async stop() {}
  };
}

module.exports = { manifest, createCore };
