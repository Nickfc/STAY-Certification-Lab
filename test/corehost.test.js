'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeKernel, waitFor, fs, path } = require('./helpers');

const crashCore = path.join(__dirname, 'fixtures', 'cores', 'crash-core.js');
const hangCore = path.join(__dirname, 'fixtures', 'cores', 'hang-core.js');
const counter = path.join(__dirname, 'fixtures', 'cores', 'counter-v1.js');
const shadowHang = path.join(__dirname, 'fixtures', 'cores', 'shadow-hang-v2.js');
const sandboxCore = path.join(__dirname, 'fixtures', 'cores', 'sandbox-core.js');

test('native CoreHost permission boundary denies filesystem writes and child processes', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(async () => { if (kernel.stateStore.db) await kernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  await kernel.installCore(sandboxCore);
  const results = [];
  kernel.fabric.subscribe('sandbox.result', event => results.push(event.payload));
  await kernel.publish('sandbox.test', {});
  assert.deepEqual(results.at(-1), { fsDenied: true, childDenied: true });
  await kernel.stop();
});

test('crashing active CoreHost restarts locally while Kernel identity remains alive', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(async () => { if (kernel.stateStore.db) await kernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  const identity = kernel.identity.organismId;
  await kernel.installCore(crashCore);
  const slot = kernel.registry.get('test-crash');
  const firstPid = slot.active.client.pid;
  await assert.rejects(() => kernel.publish('fault.crash', {}));
  await waitFor(() => slot.active.client.generation >= 2 && slot.active.client.lifecycle === 'active' && slot.active.client.pid && slot.active.client.pid !== firstPid, 4000);
  const pong = [];
  kernel.fabric.subscribe('fault.pong', event => pong.push(event.payload));
  await kernel.publish('fault.ping', {});
  assert.equal(pong.at(-1).ok, true);
  assert.equal(kernel.identity.organismId, identity);
  assert.equal((await kernel.health()).ok, true);
  await kernel.stop();
});

test('hung CoreHost handler times out, recycles, and does not block Kernel heartbeat', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(async () => { if (kernel.stateStore.db) await kernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  await kernel.installCore(hangCore);
  const slot = kernel.registry.get('test-hang');
  await assert.rejects(() => kernel.publish('fault.hang', {}));
  await waitFor(() => slot.active.client.generation >= 2 && slot.active.client.lifecycle === 'active', 4000);
  await kernel.writeHeartbeat();
  assert.equal((await kernel.health()).persistence.ok, true);
  await kernel.stop();
});

test('frozen shadow queue stays bounded and never delays active authority', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(async () => { if (kernel.stateStore.db) await kernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  await kernel.installCore(counter);
  await kernel.stageCoreUpgrade(shadowHang);
  const slot = kernel.registry.get('test-counter');
  const started = Date.now();
  await Promise.all(Array.from({ length: 100 }, () => kernel.publish('test.tick', {}, { eventClass: 'best-effort' })));
  assert.ok(Date.now() - started < 1000);
  const status = await slot.status();
  assert.ok(status.candidate.queue.depth <= status.candidate.queue.capacity);
  assert.ok(status.candidate.queue.dropped > 0 || status.candidate.queue.failed > 0);
  assert.equal((await kernel.health()).ok, true);
  await kernel.upgrades.abort('test-counter');
  await kernel.stop();
});
