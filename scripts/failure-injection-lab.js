'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LivingKernel } = require('../runtime');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await wait(25); }
  throw new Error('fault recovery timeout');
}

function record(report, type, contained, detail = {}) {
  report.faults.push({ type, contained, ...detail });
  if (!contained) report.failures.push(type);
}

async function main() {
  const root = path.join(__dirname, '..');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-fault-lab-'));
  const report = { version: 'stay-failure-lab-v2', startedAt: new Date().toISOString(), faults: [], failures: [] };
  const kernel = new LivingKernel({ dataDir: dir, allowIdentityBootstrap: true, heartbeatIntervalMs: 0, snapshotIntervalMs: 0 });
  try {
    await kernel.start();
    const identity = kernel.identity.organismId;

    const crash = path.join(root, 'test', 'fixtures', 'cores', 'crash-core.js');
    await kernel.installCore(crash);
    const crashSlot = kernel.registry.get('test-crash');
    const crashGeneration = crashSlot.active.client.generation;
    let crashError = null;
    await kernel.publish('fault.crash', {}).catch(error => { crashError = error; });
    await until(() => crashSlot.active.client.generation > crashGeneration && crashSlot.active.client.lifecycle === 'active');
    record(report, 'active-process-crash', Boolean(crashError), { code: crashError?.code || null });

    const hang = path.join(root, 'test', 'fixtures', 'cores', 'hang-core.js');
    await kernel.installCore(hang);
    const hangSlot = kernel.registry.get('test-hang');
    const hangGeneration = hangSlot.active.client.generation;
    let hangError = null;
    await kernel.publish('fault.hang', {}).catch(error => { hangError = error; });
    await until(() => hangSlot.active.client.generation > hangGeneration && hangSlot.active.client.lifecycle === 'active');
    record(report, 'handler-deadline', Boolean(hangError), { code: hangError?.code || null });

    const counterV1 = path.join(root, 'test', 'fixtures', 'cores', 'counter-v1.js');
    const counterV2 = path.join(root, 'test', 'fixtures', 'cores', 'counter-v2.js');
    await kernel.installCore(counterV1);
    await kernel.stageCoreUpgrade(counterV2);
    await kernel.publish('test.tick', {});
    await kernel.commitCoreUpgrade('test-counter', { minEvents: 1 });
    const authority = kernel.stateStore.getAuthority('test-counter');
    const checkpoint = await kernel.stateStore.readAuthoritativeCheckpoint('test-counter');
    record(report, 'authority-cutover-checkpoint', authority.epoch === 2 && checkpoint.instanceId === authority.instanceId && checkpoint.authorityEpoch === authority.epoch);

    const downstreamOff = kernel.fabric.subscribe('test.pulse', () => { throw Object.assign(new Error('injected sink outage'), { code: 'FAULT_SINK_OUTAGE' }); });
    let sinkError = null;
    await kernel.publish('test.tick', {}).catch(error => { sinkError = error; });
    downstreamOff();
    record(report, 'durable-output-sink-failure', sinkError?.code === 'EVENT_DELIVERY_FAILED', { code: sinkError?.code || null });

    const signalCore = path.join(root, 'test', 'fixtures', 'cores', 'signal-core.js');
    await kernel.installCore(signalCore);
    const signals = [];
    kernel.fabric.subscribe('signal.result', event => signals.push(event.payload));
    await kernel.publish('signal.test', {});
    record(report, 'parent-signal-attempt', signals.at(-1)?.parentSignalDenied === true);

    const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-corrupt-checkpoint-'));
    try {
      const { StateStore } = require('../runtime/kernel/state-store');
      const store = new StateStore(isolated);
      await store.init();
      store.setInitialAuthority({ coreId: 'fault-checkpoint', instanceId: 'one', version: '1.0.0', epoch: 1 });
      const saved = await store.commitCheckpoint({ coreId: 'fault-checkpoint', instanceId: 'one', version: '1.0.0', authorityEpoch: 1, stateSchema: 1, state: { alive: true } });
      await fs.writeFile(store.blobPath(saved.blobHash), 'injected-corruption');
      let detected = false;
      await store.readAuthoritativeCheckpoint('fault-checkpoint').catch(error => { detected = error.code === 'CHECKPOINT_CORRUPT'; });
      record(report, 'checkpoint-corruption', detected);
      store.close();
    } finally { await fs.rm(isolated, { recursive: true, force: true }); }

    await kernel.writeHeartbeat();
    const health = await kernel.health();
    report.identityPreserved = kernel.identity.organismId === identity;
    report.persistenceHealthy = health.persistence.ok;
    if (!report.identityPreserved) report.failures.push('identity-preservation');
    if (!report.persistenceHealthy) report.failures.push('persistence-health');
    report.completedAt = new Date().toISOString();
    report.status = report.failures.length ? 'FAIL' : 'PASS';
    await kernel.stop();
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'PASS') process.exitCode = 1;
  } finally {
    if (kernel.stateStore.db) await kernel.stop().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { main };
