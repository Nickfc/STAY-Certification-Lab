'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { LivingKernel } = require('../runtime');
const { waitFor } = require('./helpers');

const repoRoot = path.join(__dirname, '..');
const fetusPath = path.join(repoRoot, 'cores', 'fetus-legacy-0.6', 'index.js');
const neutralPath = path.join(repoRoot, 'cores', 'sntss', 'neutral', 'index.js');
const legacySourceDir = path.join(repoRoot, 'legacy', '0.6.0');

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = Number(address && address.port);
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error('failed to reserve loopback port');
  return port;
}

function captureEnvironment(keys) {
  return new Map(keys.map(key => [key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined]));
}

function restoreEnvironment(snapshot) {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function makeAttachmentKernel({ dataDir, port, allowIdentityBootstrap }) {
  process.env.STAY_DATA_DIR = dataDir;
  process.env.STAY_LEGACY_SOURCE_DIR = legacySourceDir;
  process.env.STAY_LEGACY_PORT = String(port);
  delete process.env.STAY_REQUIRE_HIBERNATION_STATE;
  delete process.env.STAY_EXPECTED_HIBERNATION_SHA256;
  delete process.env.STAY_REQUIRE_CORE_PROMOTION_CERT;

  return new LivingKernel({
    dataDir,
    allowIdentityBootstrap,
    heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0,
    trustedTimePulseIntervalMs: 25,
    primaryBootCorePath: fetusPath,
    auxiliaryCorePaths: [neutralPath],
    auxiliaryCoreCwd: repoRoot
  });
}

async function assertAttached(kernel, observed) {
  await waitFor(() => observed.timePulses.length >= 2, 5000, 25);
  const status = await kernel.status({ force: true });
  const fetus = status.cores.find(slot => slot.coreId === 'fetus-legacy');
  const sntss = status.cores.find(slot => slot.coreId === 'sntss');

  assert.ok(fetus?.active, 'fetus-legacy must remain active beside SNTSS');
  assert.equal(fetus.active.health?.ok, true);
  assert.ok(sntss?.active, 'SNTSS must be active as an auxiliary Core');
  assert.equal(sntss.active.manifest.version, '0.0.0-neutral');
  assert.deepEqual(sntss.active.manifest.outputs, []);
  assert.deepEqual(sntss.active.health, {
    ok: true,
    stage: 'neutral',
    bound: true,
    chemistryActive: false,
    biologicalOutputs: 0
  });

  assert.equal(status.health.trustedTimePulse.enabled, true);
  assert.equal(status.health.trustedTimePulse.running, true);
  assert.ok(status.health.trustedTimePulse.sequence >= 2);
  assert.equal(observed.sntssOutputs.length, 0);

  for (const event of observed.timePulses) {
    assert.equal(event.meta?.sourceCore, 'living-kernel');
    assert.equal(event.payload?.clockStatus, 'trusted');
    assert.ok(Number.isSafeInteger(event.payload?.pulseSequence));
    assert.ok(event.payload.pulseSequence >= 1);
  }

  const checkpoint = await kernel.stateStore.readAuthoritativeCheckpoint('sntss');
  assert.equal(checkpoint.state.stage, 'neutral');
  assert.equal(checkpoint.state.organismBinding.organismLineage, 'STAY/Genesis');
  assert.deepEqual(checkpoint.state.transmitters, {});
  assert.deepEqual(checkpoint.state.receptors, {});
  return checkpoint;
}

test('I1-C: fetus and neutral SNTSS coexist, bind, receive trusted time and remain chemically inert across restart', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-sntss-live-attachment-'));
  const port = await reserveLoopbackPort();
  const env = captureEnvironment([
    'STAY_DATA_DIR',
    'STAY_LEGACY_SOURCE_DIR',
    'STAY_LEGACY_PORT',
    'STAY_REQUIRE_HIBERNATION_STATE',
    'STAY_EXPECTED_HIBERNATION_SHA256',
    'STAY_REQUIRE_CORE_PROMOTION_CERT'
  ]);

  let activeKernel = null;
  t.after(async () => {
    await activeKernel?.stop().catch(() => {});
    restoreEnvironment(env);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const firstObserved = { timePulses: [], sntssOutputs: [] };
  const first = makeAttachmentKernel({ dataDir, port, allowIdentityBootstrap: true });
  activeKernel = first;
  first.fabric.subscribeAll(event => {
    if (event.topic === 'runtime.time.pulse') firstObserved.timePulses.push(event);
    if (event.topic.startsWith('sntss.')) firstObserved.sntssOutputs.push(event);
  });

  await first.start();
  await first.installCore(fetusPath);
  const before = await assertAttached(first, firstObserved);
  const organismId = first.identity.organismId;
  const bindingHash = before.state.organismBinding.identitySha256;
  const bindingEventId = before.state.organismBinding.bindingEventId;
  const bindingEventsBefore = first.stateStore.db.prepare(
    "SELECT COUNT(*) AS count FROM biological_events WHERE topic='runtime.organism.binding'"
  ).get().count;
  assert.equal(bindingEventsBefore, 1);

  await first.stop();
  activeKernel = null;

  const secondObserved = { timePulses: [], sntssOutputs: [] };
  const restarted = makeAttachmentKernel({ dataDir, port, allowIdentityBootstrap: false });
  activeKernel = restarted;
  restarted.fabric.subscribeAll(event => {
    if (event.topic === 'runtime.time.pulse') secondObserved.timePulses.push(event);
    if (event.topic.startsWith('sntss.')) secondObserved.sntssOutputs.push(event);
  });

  await restarted.start();
  await restarted.installCore(fetusPath);
  const after = await assertAttached(restarted, secondObserved);

  assert.equal(restarted.identity.organismId, organismId);
  assert.equal(after.state.organismBinding.identitySha256, bindingHash);
  assert.equal(after.state.organismBinding.bindingEventId, bindingEventId);
  assert.equal(restarted.stateStore.db.prepare(
    "SELECT COUNT(*) AS count FROM biological_events WHERE topic='runtime.organism.binding'"
  ).get().count, 1);
  assert.equal(secondObserved.sntssOutputs.length, 0);
});
