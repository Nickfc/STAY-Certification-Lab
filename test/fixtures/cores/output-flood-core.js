'use strict';

const manifest = {
  coreId: 'test-output-flood', version: '1.0.0', protocol: 'stay-test-output-flood-v1', stateSchema: 1,
  hotSwap: true, priority: 'optional', inputs: ['flood.start'], outputs: ['flood.item'],
  resources: { outputLimitPerEvent: 8, outputBytesPerEvent: 4096 }
};

async function createCore({ emit }) {
  return {
    async start() {},
    async handle(event) {
      if (event.topic !== 'flood.start') return;
      for (let index = 0; index < 9; index++) await emit('flood.item', { index });
    },
    async snapshot() { return {}; },
    async health() { return { ok: true }; },
    async stop() {}
  };
}

module.exports = { manifest, createCore };
