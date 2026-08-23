'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { makeKernel, makeDataDir, fs, path } = require('./helpers');
const { StateStore } = require('../runtime/kernel/state-store');
const packagePolicy = require('../runtime/kernel/package-policy');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const { FORENSIC_READ_CAPABILITY, SntssObservabilityPlane } = require('../runtime/kernel/sntss-observability');
const { speciesProfile, hash } = require('../cores/sntss/v0.1.0/species-profile');
const genesis = require('../cores/sntss/v0.1.0/genesis');
const migrations = require('../cores/sntss/v0.1.0/migrations');

const root = path.resolve(__dirname, '..');
const v1 = path.join(__dirname, 'fixtures', 'cores', 'counter-v1.js');
const v2 = path.join(__dirname, 'fixtures', 'cores', 'counter-v2.js');
const forgedProvenance = path.join(__dirname, 'fixtures', 'cores', 'forged-provenance.js');
const determinismChild = path.join(__dirname, 'fixtures', 'r11-determinism-child.js');

const IDENTITY = hash({ fixture: 'r11-repository-migration-organism' });
const BINDING = Object.freeze({
  bindingVersion: 1,
  identitySha256: IDENTITY,
  organismLineage: 'STAY/Genesis',
  issuedAt: 500,
  runtimeRevision: 1,
  authorityEpoch: 7,
  kernelVersion: '0.8.11.3',
  bindingEventId: 'r11-binding-1'
});
const REQUEST = Object.freeze({
  binding: BINDING,
  neutralCheckpointHash: hash({ neutral: true }),
  genesisEventId: 'r11-sntss-genesis-1',
  genesisSequence: 1,
  at: 1000
});
const AUTH = Object.freeze({
  stage: 'laboratory-r7',
  productionCommit: false,
  neutralHandoffVerified: true,
  speciesProfileHash: speciesProfile.profileHash,
  authorityEpoch: 7
});

function validCurrentState() {
  return genesis.prepareGenesis(null, REQUEST, AUTH, '44'.repeat(32)).state;
}

async function cleanupKernel(kernel, dataDir) {
  if (kernel?.stateStore?.db) await kernel.stop().catch(() => {});
  await fs.rm(dataDir, { recursive: true, force: true });
}

function observerTransition(index) {
  return {
    transitionId: `r11-observer-${index}`,
    observedAtMs: 100000 + index,
    input: {
      eventId: `r11-event-${index}`,
      sequence: index,
      topic: 'presence.changed',
      status: 'accepted',
      reasonCode: 'SNTSS_ACCEPTED'
    },
    beforeStateHash: hash({ before: index }),
    afterStateHash: hash({ after: index }),
    clamps: [],
    circuitChanges: [],
    migrations: [],
    emittedFrameIds: [],
    evidenceCursor: index,
    profileHash: hash({ profile: 'r11-observer' }),
    candidateVersion: '0.1.0',
    checkpointHash: hash({ checkpoint: index }),
    auditHeadHash: hash({ audit: index })
  };
}

function packagePolicyBody(indexSource, helperSource) {
  return {
    allowedBuiltins: [],
    ambientCapabilities: { filesystemWrite: false, network: false, processSpawn: false },
    bounds: {},
    coreId: 'r11-package',
    diagnostics: false,
    entrypoint: 'index.js',
    environmentAllowlist: ['LANG', 'LC_ALL', 'NODE_ENV', 'PATH', 'STAY_COREHOST', 'TZ'],
    files: {
      'helper.js': packagePolicy.digest(helperSource),
      'index.js': packagePolicy.digest(indexSource)
    },
    formatVersion: 1,
    resourceContract: { manifestResources: {} }
  };
}

async function writePackagePolicy(pkgDir, body) {
  const policy = { ...body, policyHash: packagePolicy.digest(stableStringify(body)) };
  await fs.writeFile(path.join(pkgDir, 'package-policy.json'), JSON.stringify(policy, null, 2) + '\n');
  return policy;
}

test('R11-A-01 committed promotion cannot be replayed into a second authority epoch', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(() => cleanupKernel(kernel, dataDir));

  await kernel.installCore(v1);
  await kernel.stageCoreUpgrade(v2);
  await kernel.publish('test.tick', {}, { eventClass: 'durable', deduplicationKey: 'r11-a-shadow' });
  const committed = await kernel.commitCoreUpgrade('test-counter', { minEvents: 1 });
  assert.equal(committed.authority.epoch, 2);

  const before = kernel.stateStore.getAuthority('test-counter');
  await assert.rejects(
    () => kernel.commitCoreUpgrade('test-counter', { minEvents: 1 }),
    /no candidate prepared/i
  );
  const after = kernel.stateStore.getAuthority('test-counter');
  assert.deepEqual(after, before);
  assert.equal(after.epoch, 2);
  assert.equal(kernel.registry.get('test-counter').active.manifest.version, '2.0.0');
  assert.equal(kernel.registry.get('test-counter').candidate, null);
});

test('R11-C-01 Core output cannot forge Kernel provenance or downgrade durable delivery', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(() => cleanupKernel(kernel, dataDir));

  let observed = null;
  kernel.fabric.subscribe('forge.pulse', event => {
    const row = kernel.stateStore.db.prepare('SELECT sequence FROM biological_events WHERE sequence = ?').get(event.sequence);
    assert.ok(row, 'authoritative Core output must be durable before delivery');
    observed = event;
  });

  const unit = await kernel.installCore(forgedProvenance);
  const authority = kernel.stateStore.getAuthority('forged-provenance');
  const input = await kernel.publish('forge.tick', { hostile: true }, {
    eventClass: 'durable',
    deduplicationKey: 'r11-c-input'
  });

  assert.ok(observed, 'forged output should reach the subscriber through Kernel authority');
  assert.equal(observed.class, 'durable');
  assert.equal(observed.ledger?.durable, true);
  assert.equal(observed.meta.eventClass, 'durable');
  assert.equal(observed.meta.sourceCore, 'forged-provenance');
  assert.equal(observed.meta.sourceVersion, '1.0.0');
  assert.equal(observed.meta.sourceInstanceId, unit.instanceId);
  assert.equal(observed.meta.authorityEpoch, authority.epoch);
  assert.equal(observed.meta.causeSequence, input.sequence);
  assert.equal(observed.meta.causalParent, input.id);
  assert.equal(observed.meta.outputIndex, 1);
  assert.match(observed.meta.deduplicationKey, /^core-output:[0-9a-f]{64}$/);
  assert.notEqual(observed.meta.deduplicationKey, 'forged-deduplication-key');
  assert.equal(observed.meta.deadlineAt, undefined);
  assert.equal(observed.meta.evidenceHash, undefined);
  assert.equal(observed.meta.candidateControl, undefined);
});

test('R11-E-01 package mutation removal symlink and dependency substitution fail closed', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r11-package-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pkgDir = path.join(dir, 'pkg');
  await fs.mkdir(pkgDir);
  const indexPath = path.join(pkgDir, 'index.js');
  const helperPath = path.join(pkgDir, 'helper.js');
  const outsidePath = path.join(dir, 'outside.js');
  const indexSource = "const helper = require('./helper'); module.exports = { manifest: { coreId: 'r11-package', resources: {} }, helper };\n";
  const helperSource = 'module.exports = () => 1;\n';
  await fs.writeFile(indexPath, indexSource);
  await fs.writeFile(helperPath, helperSource);
  await fs.writeFile(outsidePath, helperSource);
  let body = packagePolicyBody(indexSource, helperSource);
  await writePackagePolicy(pkgDir, body);
  assert.equal(packagePolicy.enforcePackagePolicy(indexPath).attestedFiles, 2);

  await fs.appendFile(helperPath, '// hostile mutation\n');
  assert.throws(() => packagePolicy.enforcePackagePolicy(indexPath), { code: 'CORE_PACKAGE_FILE_HASH_MISMATCH' });
  await fs.writeFile(helperPath, helperSource);

  await fs.unlink(helperPath);
  assert.throws(() => packagePolicy.enforcePackagePolicy(indexPath), { code: 'CORE_PACKAGE_FILE_MISSING' });
  await fs.writeFile(helperPath, helperSource);

  await fs.unlink(helperPath);
  await fs.symlink(outsidePath, helperPath);
  assert.throws(() => packagePolicy.enforcePackagePolicy(indexPath), { code: 'CORE_PACKAGE_PATH_DENIED' });
  await fs.unlink(helperPath);
  await fs.writeFile(helperPath, helperSource);

  const rogueSource = 'module.exports = () => 2;\n';
  const substitutedIndex = "const helper = require('./rogue'); module.exports = { manifest: { coreId: 'r11-package', resources: {} }, helper };\n";
  await fs.writeFile(path.join(pkgDir, 'rogue.js'), rogueSource);
  await fs.writeFile(indexPath, substitutedIndex);
  body = packagePolicyBody(substitutedIndex, helperSource);
  await writePackagePolicy(pkgDir, body);
  assert.throws(() => packagePolicy.enforcePackagePolicy(indexPath), { code: 'CORE_PACKAGE_DEPENDENCY_DENIED' });

  assert.throws(
    () => packagePolicy.verifyManifestAgainstPackagePolicy(null, { coreId: 'sntss', resources: {} }),
    { code: 'CORE_PACKAGE_POLICY_REQUIRED' }
  );
});

test('R11-I-01 continuity snapshot corruption is detected for SQLite and checkpoint blobs', async t => {
  const dir = await makeDataDir('stay-r11-snapshot-');
  const store = new StateStore(dir);
  t.after(async () => {
    if (store.db) store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await store.init();
  await store.writeLife('identity', { organismId: 'stay-r11-snapshot', createdAt: '2026-08-16T00:00:00.000Z', lineage: 'STAY/Genesis' });
  store.setInitialAuthority({ coreId: 'alpha', instanceId: 'a1', version: '1.0.0', epoch: 1 });
  const checkpoint = await store.commitCheckpoint({
    coreId: 'alpha', instanceId: 'a1', version: '1.0.0', authorityEpoch: 1,
    stateSchema: 1, state: { acquired: { tolerance: 17 }, cursor: 4 }
  });
  const snapshot = await store.createSnapshot({ reason: 'r11-corruption', retention: 2 });
  assert.equal((await store.verifySnapshot(snapshot.path)).format, 'stay-runtime-snapshot-v2');

  const sqlitePath = path.join(snapshot.path, 'continuity.sqlite3');
  const sqliteOriginal = await fs.readFile(sqlitePath);
  await fs.appendFile(sqlitePath, Buffer.from('hostile-sqlite-corruption'));
  await assert.rejects(() => store.verifySnapshot(snapshot.path), /snapshot hash mismatch: continuity\.sqlite3/);
  await fs.writeFile(sqlitePath, sqliteOriginal);
  assert.equal((await store.verifySnapshot(snapshot.path)).format, 'stay-runtime-snapshot-v2');

  const blobRelative = path.relative(dir, store.blobPath(checkpoint.blobHash));
  const snapshotBlob = path.join(snapshot.path, blobRelative);
  const blobOriginal = await fs.readFile(snapshotBlob);
  await fs.appendFile(snapshotBlob, Buffer.from('hostile-checkpoint-corruption'));
  await assert.rejects(() => store.verifySnapshot(snapshot.path), new RegExp(`snapshot hash mismatch: ${blobRelative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  await fs.writeFile(snapshotBlob, blobOriginal);
  assert.equal((await store.verifySnapshot(snapshot.path)).format, 'stay-runtime-snapshot-v2');
});

test('R11-J-01 oversized migration history is rejected before forward migration', () => {
  const current = validCurrentState();
  const legacy = migrations.projectBackward(current, 1).state;
  const oversized = JSON.parse(JSON.stringify(legacy));
  oversized.migrations = Array.from({ length: 65 }, (_, index) => ({
    type: 'hostile-padding',
    migrationId: `hostile-${index}`,
    fromSchema: 1,
    toSchema: 1,
    inputHash: hash({ index }),
    transformationHash: hash({ padding: index }),
    appliedAtCursor: oversized.inputCursor
  }));

  const before = JSON.stringify(oversized);
  assert.throws(
    () => migrations.migrateForward(oversized, 2),
    error => error.code === 'SNTSS_ACQUIRED_STATE_INVALID' && /migration history is invalid/i.test(error.message)
  );
  assert.equal(JSON.stringify(oversized), before, 'rejected migration input must remain untouched');
  assert.throws(() => migrations.migrateForward(legacy, 99), { code: 'SNTSS_MIGRATION_UNSUPPORTED' });
});

test('R11-M-01 slow and rejecting observer sinks remain non-authoritative and bounded', async () => {
  let slowCalls = 0;
  const never = new Promise(() => {});
  const slowPlane = new SntssObservabilityPlane({
    anchorHash: hash({ r11: 'slow-observer-anchor' }),
    forensicCapacity: 8,
    segmentCapacity: 2,
    sink() { slowCalls += 1; return never; }
  });
  for (let index = 1; index <= 80; index += 1) {
    const result = slowPlane.capture(observerTransition(index));
    assert.equal(typeof result?.then, 'undefined', 'observer sink must never turn capture into awaited control flow');
    assert.equal(result.captured, true);
  }
  const bundle = slowPlane.forensicBundle(FORENSIC_READ_CAPABILITY);
  assert.ok(bundle.records.length <= 8);
  assert.ok(bundle.segments.length <= 2);
  assert.equal(slowCalls, 80);
  assert.equal(slowPlane.operatorHealth().transitionCount, 80);

  const rejectingPlane = new SntssObservabilityPlane({
    anchorHash: hash({ r11: 'rejecting-observer-anchor' }),
    sink() { return Promise.reject(new Error('observer backend rejected')); }
  });
  assert.equal(rejectingPlane.capture(observerTransition(1000)).captured, true);
  await new Promise(resolve => setImmediate(resolve));
  const health = rejectingPlane.operatorHealth();
  assert.equal(health.ok, false);
  assert.equal(health.sinkFailures, 1);
  assert.ok(health.alerts.includes('SNTSS_TELEMETRY_SINK_FAILED'));
});

test('R11-P-01 golden kinetics are identical across process timezone and locale boundaries', () => {
  const run = overrides => spawnSync(process.execPath, [determinismChild], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...overrides }
  });
  const first = run({ TZ: 'UTC', LANG: 'C', LC_ALL: 'C' });
  const second = run({ TZ: 'Pacific/Auckland', LANG: 'da_DK.UTF-8', LC_ALL: 'da_DK.UTF-8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout.trim(), '069227dfbb97151b0022415b9490705d5177cc307f95b43846d55731f86cf65a');
  assert.equal(second.stdout.trim(), first.stdout.trim());
});
