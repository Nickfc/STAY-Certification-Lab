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
  t.after(async () => {
    if (kernel.stateStore.db) await kernel.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await kernel.installCore(counter);
  await kernel.stageCoreUpgrade(shadowHang);

  const slot = kernel.registry.get('test-counter');

  /*
   * The shadow handler never resolves. If authority dispatch awaited shadow
   * execution, this publish could not complete while the candidate actor is
   * still actively handling the same event.
   */
  const seed = await kernel.publish(
    'test.tick',
    {},
    { eventClass: 'durable' }
  );

  assert.equal(
    slot.candidate.queue.running,
    true,
    'active authority returned only after shadow execution stopped'
  );

  assert.equal(
    slot.candidate.queue.closed,
    false,
    'shadow timed out before active authority completed'
  );

  assert.equal(
    (await slot.active.snapshot()).ticks,
    1
  );

  /*
   * Saturate the shadow queue directly. The property being tested is shadow
   * boundedness, not certification-host throughput for 100 active events.
   */
  for (let index = 0; index < 32; index++) {
    slot.enqueueCandidate({
      ...seed,
      id: `${seed.id}:shadow-load:${index}`,
      sequence: seed.sequence + 1000 + index,
      class: 'best-effort',
      meta: {
        ...seed.meta,
        eventClass: 'best-effort'
      }
    });
  }

  const queue = slot.candidate.queue.snapshotMetrics();

  assert.ok(queue.depth <= queue.capacity);
  assert.ok(queue.dropped > 0);

  /*
   * Abort before the deliberately hung shadow reaches its execution timeout.
   * Active authority remains the only state-bearing implementation.
   */
  await kernel.upgrades.abort('test-counter');

  assert.equal((await kernel.health()).ok, true);

  await kernel.stop();
});

test('timed-out shadow fails closed without recycling into active authority', async t => {
  const { kernel, dataDir } = await makeKernel();

  t.after(async () => {
    if (kernel.stateStore.db) await kernel.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await kernel.installCore(counter);
  await kernel.stageCoreUpgrade(shadowHang);

  const slot = kernel.registry.get('test-counter');
  const activeGeneration = slot.active.client.generation;
  const shadowGeneration = slot.candidate.client.generation;

  await kernel.publish(
    'test.tick',
    {},
    { eventClass: 'durable' }
  );

  await waitFor(
    () => slot.candidate.queue.closed === true,
    4000,
    25
  );

  assert.equal(
    slot.candidate.client.generation,
    shadowGeneration,
    'failed shadow was recycled into a replacement with incomplete history'
  );

  assert.equal(
    slot.active.client.generation,
    activeGeneration,
    'shadow failure disturbed active authority'
  );

  await kernel.publish(
    'test.tick',
    {},
    { eventClass: 'durable' }
  );

  assert.equal(
    (await slot.active.snapshot()).ticks,
    2
  );

  await assert.rejects(
    () => kernel.commitCoreUpgrade(
      'test-counter',
      { minEvents: 1 }
    ),
    error => error.code === 'SHADOW_INCOMPLETE'
  );

  assert.equal(
    kernel.stateStore.getAuthority('test-counter').epoch,
    1
  );

  await kernel.upgrades.abort('test-counter');

  assert.equal((await kernel.health()).ok, true);

  await kernel.stop();
});
