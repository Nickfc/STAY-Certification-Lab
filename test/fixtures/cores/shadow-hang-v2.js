'use strict';
const manifest = {
  coreId: 'test-counter', version: '2.1.0', protocol: 'stay-test-counter-v1', stateSchema: 1,
  hotSwap: true, priority: 'optional', inputs: ['test.tick'], outputs: ['test.pulse'],
  resources: { queueCapacity: 8, handlerTimeoutMs: 2000, healthTimeoutMs: 75, maxRestarts: 2, restartWindowMs: 5000, restartBackoffMs: 20 }
};
async function createCore() {
  return {
    async start() {}, async handle() { await new Promise(() => {}); }, async snapshot() { return {}; },
    async health() { return { ok: true }; }, async stop() {}
  };
}
module.exports = { manifest, createCore };
