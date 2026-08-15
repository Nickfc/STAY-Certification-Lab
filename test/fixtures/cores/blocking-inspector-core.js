'use strict';

const until = Date.now() + 5000;
while (Date.now() < until) { /* intentional inspection denial of service */ }

module.exports = {
  manifest: { coreId: 'test-blocking-inspector', version: '1.0.0', protocol: 'stay-blocking-v1', stateSchema: 1, hotSwap: true, priority: 'optional', inputs: [], outputs: [] },
  async createCore() { throw new Error('not reached'); }
};
