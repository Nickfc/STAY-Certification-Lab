'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { makeKernel, fs, path } = require('./helpers');

const neutralPath = path.join(__dirname, '..', 'cores', 'sntss', 'neutral', 'index.js');
const laboratoryPath = path.join(__dirname, '..', 'cores', 'sntss', 'v0.1.0', 'index.js');

test('R2-01: neutral package binds once and remains chemically empty with zero output authority', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(async () => { await kernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  const emitted = [];
  kernel.fabric.subscribeAll(event => { if (event.topic.startsWith('sntss.')) emitted.push(event); });
  const unit = await kernel.installCore(neutralPath);
  assert.equal(unit.manifest.coreId, 'sntss');
  assert.equal(unit.manifest.version, '0.0.0-neutral');
  assert.equal(unit.manifest.priority, 'optional');
  assert.deepEqual(unit.manifest.outputs, []);

  const checkpoint = await kernel.stateStore.readAuthoritativeCheckpoint('sntss');
  assert.equal(checkpoint.state.stage, 'neutral');
  assert.equal(checkpoint.state.organismBinding.organismLineage, 'STAY/Genesis');
  assert.match(checkpoint.state.organismBinding.identitySha256, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(checkpoint.state.transmitters, {});
  assert.deepEqual(checkpoint.state.receptors, {});
  assert.equal(emitted.length, 0);
  const health = await unit.health();
  assert.deepEqual(health, { ok: true, stage: 'neutral', bound: true, chemistryActive: false, biologicalOutputs: 0 });
});

test('R2-02: restart reuses the permanent binding and does not create a second biological cause', async t => {
  const { kernel, dataDir } = await makeKernel();
  let activeKernel = kernel;
  t.after(async () => { await activeKernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  await kernel.installCore(neutralPath);
  const before = await kernel.stateStore.readAuthoritativeCheckpoint('sntss');
  const bindingEvent = before.state.organismBinding.bindingEventId;
  await kernel.stop();

  const { kernel: restarted } = await makeKernel({ dataDir, allowIdentityBootstrap: false });
  activeKernel = restarted;
  await restarted.installCore(neutralPath);
  const after = await restarted.stateStore.readAuthoritativeCheckpoint('sntss');
  assert.equal(after.state.organismBinding.identitySha256, before.state.organismBinding.identitySha256);
  assert.equal(after.state.organismBinding.bindingEventId, bindingEvent);
  assert.equal(restarted.stateStore.db.prepare("SELECT COUNT(*) AS count FROM biological_events WHERE topic='runtime.organism.binding'").get().count, 1);
});

test('R2-03: neutral-to-laboratory hot-swap and rollback preserve binding and remain inert', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(async () => { await kernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  await kernel.installCore(neutralPath);
  const initial = await kernel.stateStore.readAuthoritativeCheckpoint('sntss');
  await kernel.stageCoreUpgrade(laboratoryPath);
  await kernel.publishTimePulse('trusted');
  const committed = await kernel.commitCoreUpgrade('sntss', { minEvents: 1 });
  assert.equal(committed.active.version, '0.1.0');
  let checkpoint = await kernel.stateStore.readAuthoritativeCheckpoint('sntss');
  assert.equal(checkpoint.state.organismBinding.identitySha256, initial.state.organismBinding.identitySha256);
  assert.deepEqual(checkpoint.state.transmitters, {});
  assert.deepEqual(checkpoint.state.receptors, {});
  const rolledBack = await kernel.rollbackCore('sntss');
  assert.equal(rolledBack.active.version, '0.0.0-neutral');
  checkpoint = await kernel.stateStore.readAuthoritativeCheckpoint('sntss');
  assert.equal(checkpoint.state.organismBinding.identitySha256, initial.state.organismBinding.identitySha256);
  assert.deepEqual(checkpoint.state.transmitters, {});
  assert.deepEqual(checkpoint.state.receptors, {});
});

test('R2-04: neutral lifecycle source has no ambient timer, network, filesystem, process or output capability', async () => {
  const source = await fs.readFile(neutralPath, 'utf8');
  for (const prohibited of ['node:fs', 'node:http', 'node:https', 'node:net', 'node:dgram', 'node:child_process', 'setInterval(', 'setTimeout(', 'process.', 'emit(']) {
    assert.equal(source.includes(prohibited), false, `neutral source contains prohibited surface: ${prohibited}`);
  }
  const definition = require(neutralPath);
  assert.deepEqual(definition.manifest.outputs, []);
  assert.equal(definition.manifest.resources.softRamMiB, 64);
  assert.equal(definition.manifest.resources.hardRamMiB, 96);
  assert.equal(definition.manifest.resources.softCpuPercent, 5);
  assert.equal(definition.manifest.resources.hardCpuPercent, 20);
  assert.equal(definition.manifest.resources.pidsMax, 16);
  assert.equal(definition.manifest.resources.queueCapacity, 256);
  assert.equal(definition.manifest.resources.handlerTimeoutMs, 250);
  assert.equal(definition.manifest.resources.outputLimitPerEvent, 16);
  assert.equal(definition.manifest.resources.outputBytesPerEvent, 65536);
});

test('R2-05: a conflicting later binding fails closed without replacing acquired binding', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(async () => { await kernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  await kernel.installCore(neutralPath);
  const before = await kernel.stateStore.readAuthoritativeCheckpoint('sntss');
  const fakeHash = 'sha256:' + crypto.createHash('sha256').update('not-this-organism').digest('hex');
  const accepted = before.state.organismBinding;
  await assert.rejects(() => kernel.publish('runtime.organism.binding', {
    bindingVersion: accepted.bindingVersion,
    identitySha256: fakeHash,
    organismLineage: accepted.organismLineage,
    issuedAt: accepted.issuedAt,
    runtimeRevision: accepted.runtimeRevision,
    authorityEpoch: accepted.authorityEpoch,
    kernelVersion: accepted.kernelVersion
  }, {
    eventClass: 'critical', sourceCore: 'living-kernel', sourceVersion: '0.8.11.3',
    authorityEpoch: before.state.organismBinding.authorityEpoch,
    evidenceHash: fakeHash, deduplicationKey: 'forged-conflicting-binding'
  }), error => error.code === 'EVENT_DELIVERY_FAILED');
  const after = await kernel.stateStore.readAuthoritativeCheckpoint('sntss');
  assert.equal(after.state.organismBinding.identitySha256, before.state.organismBinding.identitySha256);
});
