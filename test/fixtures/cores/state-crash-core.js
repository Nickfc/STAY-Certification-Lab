'use strict';

const manifest = {
  coreId: 'test-state-crash', version: '1.0.0', protocol: 'stay-test-state-crash-v1', stateSchema: 1,
  hotSwap: true, priority: 'normal', inputs: ['state.tick', 'state.crash'], outputs: ['state.value']
};

async function createCore({ initialState, emit }) {
  let value = Number(initialState?.value) || 0;
  return {
    async start() {},
    async handle(event) {
      if (event.topic === 'state.crash') process.exit(17);
      if (event.topic === 'state.tick') { value += 1; await emit('state.value', { value }); }
    },
    async snapshot() { return { value }; },
    async health() { return { ok: true, value }; },
    async stop() {}
  };
}

module.exports = { manifest, createCore };
