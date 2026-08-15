'use strict';
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const manifest = {
  coreId: 'test-sandbox', version: '1.0.0', protocol: 'stay-test-sandbox-v1', stateSchema: 1,
  hotSwap: true, priority: 'optional', inputs: ['sandbox.test'], outputs: ['sandbox.result']
};
async function createCore({ emit }) {
  return {
    async start() {},
    async handle() {
      let fsDenied = false;
      let childDenied = false;
      try { await fs.writeFile('/tmp/stay-corehost-escape-test', 'forbidden'); } catch (error) { fsDenied = error.code === 'ERR_ACCESS_DENIED'; }
      try { spawn(process.execPath, ['-e', 'process.exit(0)']); } catch (error) { childDenied = error.code === 'ERR_ACCESS_DENIED'; }
      await emit('sandbox.result', { fsDenied, childDenied });
    },
    async snapshot() { return {}; }, async health() { return { ok: true }; }, async stop() {}
  };
}
module.exports = { manifest, createCore };
