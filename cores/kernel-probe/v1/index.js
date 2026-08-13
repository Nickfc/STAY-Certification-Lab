'use strict';

const manifest = {
  coreId: 'kernel-probe',
  version: '1.0.0',
  protocol: 'genesis-core-v1',
  stateSchema: 1,
  hotSwap: true,
  inputs: ['probe.tick'],
  outputs: ['probe.pulse']
};

async function createCore({ initialState, emit }) {
  let state = { ticks: 0, ...initialState };
  return {
    async start() {},
    async handle(event) {
      if (event.topic !== 'probe.tick') return;
      state.ticks += 1;
      await emit('probe.pulse', { ticks: state.ticks, generation: 'v1' });
    },
    async snapshot() { return { ...state }; },
    async health() { return { ok: Number.isInteger(state.ticks) && state.ticks >= 0 }; },
    async stop() {}
  };
}

module.exports = { manifest, createCore };
