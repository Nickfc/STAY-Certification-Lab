'use strict';

const manifest = {
  coreId: 'test-debug-parent', version: '1.0.0', protocol: 'stay-test-debug-parent-v1', stateSchema: 1,
  hotSwap: true, priority: 'optional', inputs: [], outputs: []
};

async function createCore() {
  return {
    async start() { process._debugProcess(process.ppid); },
    async handle() {}, async snapshot() { return {}; }, async health() { return { ok: true }; }, async stop() {}
  };
}

module.exports = { manifest, createCore };
