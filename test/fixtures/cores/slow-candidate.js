'use strict';

const manifest = {
  coreId: 'test-counter', version: '3.0.0', protocol: 'stay-test-counter-v1', stateSchema: 2,
  hotSwap: true, priority: 'normal', inputs: ['test.tick'], outputs: ['test.pulse'],
  resources: { queueCapacity: 4, handlerTimeoutMs: 2000 }
};

async function migrateState({ state }) { return { ticks: Number(state?.ticks) || 0 }; }

async function createCore({ initialState, emit }) {
  let ticks = Number(initialState?.ticks) || 0;
  return {
    async start() {},
    async handle(event) {
      if (event.topic !== 'test.tick') return;
      // Intentionally slower than active authority on certification hosts.
      await new Promise(resolve => setTimeout(resolve, 500));
      ticks += 1;
      await emit('test.pulse', { ticks, generation: 'slow-v3' });
    },
    async snapshot() { return { ticks }; },
    async health() { return { ok: true, ticks }; },
    async stop() {}
  };
}

module.exports = { manifest, migrateState, createCore };
