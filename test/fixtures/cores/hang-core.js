'use strict';
const manifest = {
  coreId: 'test-hang', version: '1.0.0', protocol: 'stay-test-hang-v1', stateSchema: 1,
  hotSwap: true, priority: 'optional', inputs: ['fault.hang', 'fault.ping'], outputs: ['fault.pong'],
  resources: { queueCapacity: 8, handlerTimeoutMs: 75, healthTimeoutMs: 75, maxRestarts: 4, restartWindowMs: 5000, restartBackoffMs: 20 }
};
async function createCore({ emit }) {
  return {
    async start() {},
    async handle(event) {
      if (event.topic === 'fault.hang') await new Promise(() => {});
      if (event.topic === 'fault.ping') await emit('fault.pong', { ok: true, pid: process.pid });
    },
    async snapshot() { return {}; }, async health() { return { ok: true }; }, async stop() {}
  };
}
module.exports = { manifest, createCore };
