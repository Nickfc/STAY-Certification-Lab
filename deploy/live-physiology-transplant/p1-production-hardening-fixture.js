'use strict';

/*
 * Deliberately stateful, non-registered release fixture used only by the
 * preflight. It proves the real production CoreHost/sandbox path discards a
 * worker that mutates and emits before timing out, then reconstructs from the
 * last committed image without leaking the speculative output.
 */
const manifest = Object.freeze({
  coreId: 'production-hardening-fixture',
  version: '1.0.0',
  protocol: 'stay-production-hardening-fixture-v1',
  stateSchema: 1,
  hotSwap: true,
  priority: 'optional',
  inputs: Object.freeze(['test.event']),
  outputs: Object.freeze(['test.output']),
  resources: Object.freeze({
    softRamMiB: 32,
    hardRamMiB: 64,
    softCpuPercent: 5,
    hardCpuPercent: 50,
    pidsMax: 8,
    queueCapacity: 8,
    handlerTimeoutMs: 100,
    healthTimeoutMs: 100,
    outputCapacity: 8,
    outputLimitPerEvent: 2,
    outputBytesPerEvent: 4096,
    storageMiB: 1,
    maxRestarts: 4,
    restartWindowMs: 60000,
    restartBackoffMs: 10
  })
});

async function createCore({ initialState, emit }) {
  let count = Number(initialState?.count || 0);
  return Object.freeze({
    async start() {},
    async handle(event) {
      if (event.payload?.mutateBeforeDelay === true) count += 1;
      if (event.payload?.emitBeforeDelay === true) {
        await emit('test.output', { count });
      }
      if (event.payload?.neverSettle === true) {
        await new Promise(() => {});
      }
      const delayMs = Number(event.payload?.delayMs || 0);
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      if (event.payload?.mutateBeforeDelay !== true) count += 1;
    },
    async snapshot() { return { count }; },
    async health() { return { ok: true, count }; },
    async stop() {}
  });
}

module.exports = { manifest, createCore };
