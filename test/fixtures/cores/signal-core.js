'use strict';

const manifest = {
  coreId: 'test-signal',
  version: '1.0.0',
  protocol: 'stay-test-signal-v1',
  stateSchema: 1,
  hotSwap: true,
  priority: 'optional',
  inputs: ['signal.test'],
  outputs: ['signal.result']
};

async function createCore({ emit }) {
  return {
    async start() {},
    async handle() {
      let parentSignalDenied = false;
      try { process.kill(process.ppid, 0); }
      catch (error) { parentSignalDenied = error.code === 'ERR_ACCESS_DENIED' || error.code === 'EPERM'; }
      await emit('signal.result', { parentSignalDenied });
    },
    async snapshot() { return {}; },
    async health() { return { ok: true }; },
    async stop() {}
  };
}

module.exports = { manifest, createCore };
