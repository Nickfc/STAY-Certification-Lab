'use strict';
const manifest = {
  coreId: 'test-counter', version: '2.0.0', protocol: 'stay-test-counter-v1', stateSchema: 2,
  hotSwap: true, priority: 'normal', inputs: ['test.tick'], outputs: ['test.pulse'],
  resources: { queueCapacity: 16, handlerTimeoutMs: 500, healthTimeoutMs: 250, maxRestarts: 4, restartWindowMs: 5000, restartBackoffMs: 25 }
};
async function migrateState({ state, fromSchema, toSchema }) {
  if (fromSchema === 1 && toSchema === 2) return { ticks: Number(state?.ticks) || 0, migrations: 1 };
  return state;
}
async function createCore({ initialState, emit }) {
  let state = { ticks: 0, migrations: 0, ...initialState };
  return {
    async start() {},
    async handle(event) { if (event.topic === 'test.tick') { state.ticks += 1; await emit('test.pulse', { ...state, generation: 'v2' }); } },
    async snapshot() { return { ...state }; },
    async health() { return { ok: state.migrations === 1 && state.ticks >= 0 }; },
    async stop() {}
  };
}
module.exports = { manifest, migrateState, createCore };
