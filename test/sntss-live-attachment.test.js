'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { LivingKernel } = require('../runtime');
const { SOURCE_FILES: SEALED_LEGACY_FILES } = require('../cores/fetus-legacy-0.6');
const { waitFor } = require('./helpers');

const repoRoot = path.join(__dirname, '..');
const fetusPath = path.join(repoRoot, 'cores', 'fetus-legacy-0.6', 'index.js');
const neutralPath = path.join(repoRoot, 'cores', 'sntss', 'neutral', 'index.js');
const defaultLegacySourceDir = '/opt/stay/legacy/0.6.0';

function resolveLegacySourceDir() {
  return path.resolve(
    process.env.STAY_I1C_LEGACY_SOURCE_DIR ||
    process.env.STAY_LEGACY_SOURCE_DIR ||
    defaultLegacySourceDir
  );
}

async function prepareReadOnlyLegacyFixture(sourceDir) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-sntss-legacy-fixture-'));
  const fixture = path.join(root, 'legacy-0.6.0');
  try {
    await fs.mkdir(path.join(fixture, 'public'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(fixture, 'data'), { recursive: true, mode: 0o700 });

    for (const relative of Object.keys(SEALED_LEGACY_FILES)) {
      const source = path.join(sourceDir, relative);
      const target = path.join(fixture, relative);
      await fs.copyFile(source, target);
      await fs.chmod(target, 0o444);
    }

    // The sealed 0.6 server calls mkdirSync(__dirname/data) even when its
    // authoritative state path is redirected outside the source tree. Match
    // the hardened host with an existing, empty, non-writable compatibility
    // directory rather than making immutable program source writable.
    await fs.chmod(path.join(fixture, 'data'), 0o555);
    await fs.chmod(path.join(fixture, 'public'), 0o555);
    await fs.chmod(fixture, 0o555);

    return { root, sourceDir: fixture };
  } catch (error) {
    await fs.chmod(fixture, 0o755).catch(() => {});
    await fs.chmod(path.join(fixture, 'public'), 0o755).catch(() => {});
    await fs.chmod(path.join(fixture, 'data'), 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function removeReadOnlyLegacyFixture(fixture) {
  if (!fixture) return;
  await fs.chmod(fixture.sourceDir, 0o755).catch(() => {});
  await fs.chmod(path.join(fixture.sourceDir, 'public'), 0o755).catch(() => {});
  await fs.chmod(path.join(fixture.sourceDir, 'data'), 0o755).catch(() => {});
  await fs.rm(fixture.root, { recursive: true, force: true });
}

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

async function readLegacyState(port) {
  return await new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/state' }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.once('error', reject);
      response.once('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`legacy state returned HTTP ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
  });
}

async function connectLegacyVisitor(port, nodeId, label) {
  return await new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      port,
      path: `/events?nodeId=${encodeURIComponent(nodeId)}&label=${encodeURIComponent(label)}`
    });
    request.once('error', reject);
    request.once('response', response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`legacy visitor returned HTTP ${response.statusCode}`));
        return;
      }
      response.once('error', reject);
      response.once('data', () => resolve({ request, response }));
    });
  });
}

async function disconnectLegacyVisitor(visitor) {
  if (!visitor || visitor.response.destroyed) return;
  await new Promise(resolve => {
    visitor.response.once('close', resolve);
    visitor.response.destroy();
  });
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

function makeAttachmentKernel({
  dataDir,
  port,
  allowIdentityBootstrap,
  legacySourceDir,
  expectedHibernationSha256 = null
}) {
  process.env.STAY_DATA_DIR = dataDir;
  process.env.STAY_LEGACY_SOURCE_DIR = legacySourceDir;
  process.env.STAY_LEGACY_PORT = String(port);
  delete process.env.STAY_REQUIRE_HIBERNATION_STATE;
  if (expectedHibernationSha256) {
    process.env.STAY_EXPECTED_HIBERNATION_SHA256 =
      expectedHibernationSha256;
  } else {
    delete process.env.STAY_EXPECTED_HIBERNATION_SHA256;
  }
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
  const sealedLegacySourceDir = resolveLegacySourceDir();
  try {
    for (const relative of Object.keys(SEALED_LEGACY_FILES)) {
      await fs.access(path.join(sealedLegacySourceDir, relative));
    }
  } catch {
    t.skip(`sealed legacy 0.6 source is unavailable at ${sealedLegacySourceDir}`);
    return;
  }

  const legacyFixture = await prepareReadOnlyLegacyFixture(sealedLegacySourceDir);
  const legacySourceDir = legacyFixture.sourceDir;
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

  const fixtureStat = await fs.stat(legacySourceDir);
  const fixtureDataStat = await fs.stat(path.join(legacySourceDir, 'data'));
  assert.equal(fixtureStat.mode & 0o222, 0, 'legacy source fixture must be non-writable');
  assert.equal(fixtureDataStat.mode & 0o222, 0, 'legacy compatibility data directory must be non-writable');
  assert.deepEqual(await fs.readdir(path.join(legacySourceDir, 'data')), []);

  let activeKernel = null;
  let activeVisitor = null;
  t.after(async () => {
    await disconnectLegacyVisitor(activeVisitor).catch(() => {});
    await activeKernel?.stop().catch(() => {});
    restoreEnvironment(env);
    await fs.rm(dataDir, { recursive: true, force: true });
    await removeReadOnlyLegacyFixture(legacyFixture);
  });

  const firstObserved = { timePulses: [], sntssOutputs: [] };
  const first = makeAttachmentKernel({
    dataDir,
    port,
    allowIdentityBootstrap: true,
    legacySourceDir
  });
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

  const visitorId = 'i1c-persistence-visitor';
  const visitorLabel = 'I1-C continuity visitor';
  activeVisitor = await connectLegacyVisitor(port, visitorId, visitorLabel);
  const mutatedState = await waitFor(async () => {
    const state = await readLegacyState(port);
    const visitor = state.nodes?.find(node => node.id === visitorId);
    return visitor?.visits === 1 ? state : null;
  }, 5000, 25);
  assert.equal(mutatedState.nodeCount, 1);
  assert.match(mutatedState.recentEvent, /appeared as a new star/);

  await disconnectLegacyVisitor(activeVisitor);
  activeVisitor = null;
  const disconnectedState = await waitFor(async () => {
    const state = await readLegacyState(port);
    return state.nodeCount === 0 && /faded from the sky/.test(state.recentEvent)
      ? state : null;
  }, 5000, 25);
  assert.equal(disconnectedState.nodeCount, 0);

  await first.stop();
  activeKernel = null;

  /*
   * This is a synthetic fresh-bootstrap fixture, not the historical
   * production hibernation image.
   *
   * The frozen fetus adapter already supports an explicit expected import
   * hash. Bind the restart to the exact state produced by the first fixture
   * run rather than modifying or weakening the immutable adapter.
   */
  const restartStatePath =
    path.join(
      dataDir,
      'legacy-0.6.0',
      'genesis-state.json'
    );

  const restartStateBytes =
    await fs.readFile(
      restartStatePath
    );

  const persistedState = JSON.parse(restartStateBytes);
  const persistedVisitor = persistedState.relationships?.find(
    relationship => relationship.id === visitorId
  );
  assert.ok(persistedVisitor, 'visitor mutation must exist in durable 0.6 state');
  assert.equal(persistedVisitor.visits, 1);
  assert.ok(Number.isFinite(persistedVisitor.firstSeen));
  assert.ok(Number.isFinite(persistedVisitor.lastSeen));

  const restartStateSha256 =
    crypto
      .createHash('sha256')
      .update(restartStateBytes)
      .digest('hex');

  const secondObserved = { timePulses: [], sntssOutputs: [] };
  const restarted = makeAttachmentKernel({
    dataDir,
    port,
    allowIdentityBootstrap: false,
    legacySourceDir,
    expectedHibernationSha256:
      restartStateSha256
  });
  activeKernel = restarted;
  restarted.fabric.subscribeAll(event => {
    if (event.topic === 'runtime.time.pulse') secondObserved.timePulses.push(event);
    if (event.topic.startsWith('sntss.')) secondObserved.sntssOutputs.push(event);
  });

  await restarted.start();
  await restarted.installCore(fetusPath);

  /*
   * The fetus adapter performs hibernation verification during Core start,
   * so its import marker can only exist after installCore(fetusPath).
   */
  const restartImportMarker =
    JSON.parse(
      await fs.readFile(
        path.join(
          dataDir,
          'legacy-0.6.0',
          'hibernation-import.json'
        ),
        'utf8'
      )
    );

  assert.equal(
    restartImportMarker.sourceStateSha256,
    restartStateSha256,
    'synthetic restart must be bound to the exact persisted fixture state'
  );
  const after = await assertAttached(restarted, secondObserved);

  activeVisitor = await connectLegacyVisitor(port, visitorId, visitorLabel);
  const restoredState = await waitFor(async () => {
    const state = await readLegacyState(port);
    const visitor = state.nodes?.find(node => node.id === visitorId);
    return visitor?.visits === 2 ? state : null;
  }, 5000, 25);
  assert.match(restoredState.recentEvent, /returned to the sky/);
  assert.equal(restoredState.nodes.find(node => node.id === visitorId).visits, 2);
  await disconnectLegacyVisitor(activeVisitor);
  activeVisitor = null;

  assert.equal(restarted.identity.organismId, organismId);
  assert.equal(after.state.organismBinding.identitySha256, bindingHash);
  assert.equal(after.state.organismBinding.bindingEventId, bindingEventId);
  assert.equal(restarted.stateStore.db.prepare(
    "SELECT COUNT(*) AS count FROM biological_events WHERE topic='runtime.organism.binding'"
  ).get().count, 1);
  assert.equal(secondObserved.sntssOutputs.length, 0);
});
