'use strict';
const manifest = {
  coreId: 'test-crash', version: '1.0.0', protocol: 'stay-test-fault-v1', stateSchema: 1,
  hotSwap: true, priority: 'optional', inputs: ['fault.crash', 'fault.ping'], outputs: ['fault.pong'],
  resources: { queueCapacity: 8, handlerTimeoutMs: 250, healthTimeoutMs: 150, maxRestarts: 4, restartWindowMs: 5000, restartBackoffMs: 20 }
};
async function createCore({ emit }) {
  return {
    async start() {},
    async handle(event) {
      if (event.topic === 'fault.crash') process.exit(42);
      if (event.topic === 'fault.ping') await emit('fault.pong', { ok: true, pid: process.pid });
    },
    async snapshot() { return {}; }, async health() { return { ok: true }; }, async stop() {}
  };
}
module.exports = { manifest, createCore };
