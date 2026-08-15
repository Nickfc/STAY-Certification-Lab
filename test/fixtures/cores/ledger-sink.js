'use strict';

const manifest = Object.freeze({
  coreId: 'ledger-sink',
  version: '1.0.0',
  protocol: 'stay-ledger-test-v1',
  stateSchema: 1,
  hotSwap: true,
  priority: 'optional',
  inputs: ['bio.observed'],
  outputs: [],
  resources: { queueCapacity: 16, handlerTimeoutMs: 500, healthTimeoutMs: 250, storageMiB: 1 }
});

async function createCore({ initialState }) {
  const state = { observed: Number(initialState?.observed) || 0, lastSourceEventId: initialState?.lastSourceEventId || null };
  return {
    async start() {},
    async handle(event) {
      if (event.topic !== 'bio.observed') return;
      state.observed += 1;
      state.lastSourceEventId = event.payload.sourceEventId;
    },
    async snapshot() { return { ...state }; },
    async health() { return { ok: true, observed: state.observed }; },
    async stop() {}
  };
}

module.exports = { manifest, createCore };
