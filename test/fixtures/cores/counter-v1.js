'use strict';
const manifest = {
  coreId: 'test-counter', version: '1.0.0', protocol: 'stay-test-counter-v1', stateSchema: 1,
  hotSwap: true, priority: 'normal', inputs: ['test.tick'], outputs: ['test.pulse'],
  resources: { queueCapacity: 16, handlerTimeoutMs: 500, healthTimeoutMs: 250, maxRestarts: 4, restartWindowMs: 5000, restartBackoffMs: 25 }
};
async function createCore({ initialState, emit }) {
  let ticks = Number(initialState?.ticks) || 0;
  return {
    async start() {},
    async handle(event) { if (event.topic === 'test.tick') { ticks += 1; await emit('test.pulse', { ticks, generation: 'v1' }); } },
    async snapshot() { return { ticks }; },
    async health() { return { ok: ticks >= 0 }; },
    async stop() {}
  };
}
module.exports = { manifest, createCore };
