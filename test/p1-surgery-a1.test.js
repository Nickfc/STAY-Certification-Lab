'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const { LivingKernel } = require('../runtime');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const { capture, compare } = require('../deploy/live-physiology-transplant/p1-surgery-a1-state');
const builder = require('../scripts/p1-build-surgery-a1');

const ROOT = path.resolve(__dirname, '..');

test('P1-A1-04 immutable overlay is limited to secure entrypoint and resident-control module', () => {
  assert.deepEqual([...builder.OVERLAY_FILES], [
    'server-secure.js',
    'runtime/kernel/resident-control-socket.js'
  ]);
  assert.ok(builder.PROTECTED_PATHS.includes('runtime/kernel/resident-manager.js'));
  assert.ok(builder.PROTECTED_PATHS.includes('runtime/kernel/state-store.js'));
  assert.ok(builder.PROTECTED_PATHS.includes('runtime/kernel/biological-signalling-fabric.js'));
  assert.ok(builder.PROTECTED_PATHS.includes('cores/fetus-legacy-0.6'));
  assert.ok(builder.PROTECTED_PATHS.includes('cores/sntss/i3d'));
  assert.ok(builder.PROTECTED_PATHS.includes('cores/chronobiology'));
  assert.equal(builder.EXACT_SHA, '7d040592ccf1f149f0f0a170f79cf76bb5f05d92');
  assert.equal(builder.EXACT_TREE, '450cc22f70b7abf3b5733fe882049d88cd52de74');
});

test('P1-A1-05 secure entrypoint installs local control without attaching physiology', () => {
  const secure = fs.readFileSync(path.join(ROOT, 'server-secure.js'), 'utf8');
  const control = fs.readFileSync(path.join(ROOT, 'runtime/kernel/resident-control-socket.js'), 'utf8');
  assert.match(secure, /installResidentControlSocket\(\)/);
  assert.doesNotMatch(secure, /attachResident|detachResident/);
  assert.match(control, /DEFAULT_SOCKET_PATH = '\/run\/stay\/resident-control\.sock'/);
  assert.doesNotMatch(control, /createServer\s*\(.*host|\.listen\([^s]*port|child_process|eval\(|Function\(/s);
  assert.match(control, /kernel\.attachResident\(resolved\.moduleRelativePath\)/);
  assert.match(control, /kernel\.detachResident\(request\.residencyId\)/);
});

test('P1-A1-06 forward checkpoint advance preserves frozen biological authority identity', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stay-p1-a1-state-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const database = path.join(root, 'continuity.sqlite3');
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, json TEXT NOT NULL, sha256 TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE schema_versions(name TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE authority(core_id TEXT PRIMARY KEY, instance_id TEXT, version TEXT, epoch INTEGER, barrier_sequence INTEGER, checkpoint_hash TEXT, updated_at TEXT);
    CREATE TABLE checkpoints(core_id TEXT, generation INTEGER, blob_hash TEXT);
    CREATE TABLE resident_instances(residency_id TEXT, core_id TEXT, status TEXT, checkpoint_hash TEXT, checkpoint_generation INTEGER);
    INSERT INTO metadata VALUES('life:identity','{}','${'a'.repeat(64)}','now');
    INSERT INTO schema_versions VALUES('continuity',4,'now');
    INSERT INTO authority VALUES('fetus-legacy','fetus-instance','0.6.0',1,0,'${'b'.repeat(64)}','before');
    INSERT INTO checkpoints VALUES('fetus-legacy',37,'${'b'.repeat(64)}');
  `);
  const before = capture(database);
  db.exec(`
    UPDATE authority SET checkpoint_hash='${'c'.repeat(64)}', updated_at='after' WHERE core_id='fetus-legacy';
    INSERT INTO checkpoints VALUES('fetus-legacy',38,'${'c'.repeat(64)}');
  `);
  db.close();
  const after = capture(database);
  const result = compare(before, after);
  assert.equal(result.status, 'PASS');
  assert.equal(result.fetusCheckpointAdvanced, true);
  assert.equal(result.fetusCheckpointHashChanged, true);
  assert.equal(result.fetusCheckpointGeneration, 38);
  assert.equal(result.authorityIdentityHash, before.authorityIdentityHash);
  assert.equal(result.organismIdentityHash, before.organismIdentityHash);
});

test('P1-A1-07 production scripts are fixed, guarded, forward-only and attach nothing', () => {
  const preflight = fs.readFileSync(path.join(ROOT, 'deploy/live-physiology-transplant/p1-surgery-a1-preflight.sh'), 'utf8');
  const surgery = fs.readFileSync(path.join(ROOT, 'deploy/live-physiology-transplant/p1-surgery-a1-execute.sh'), 'utf8');
  const rollback = fs.readFileSync(path.join(ROOT, 'deploy/live-physiology-transplant/p1-surgery-a1-rollback.sh'), 'utf8');
  for (const source of [preflight, surgery, rollback]) {
    assert.ok(source.indexOf('p1-host-identity-guard.sh') < source.indexOf('systemctl'));
    assert.doesNotMatch(source, /attach resident:|\battach\b.*resident:sntss|\battach\b.*resident:chronobiology/);
    assert.doesNotMatch(source, /sqlite3.*(DELETE|UPDATE|INSERT)|restore|snapshot.*-x/);
  }
  assert.match(surgery, /systemctl stop stay\.service/);
  assert.match(surgery, /systemctl start stay\.service/);
  assert.match(surgery, /p1-resident-control-client\.js" status resident:sntss/);
  assert.match(surgery, /p1-resident-control-client\.js" status resident:chronobiology/);
  assert.match(rollback, /CANONICAL_FORWARD_STATE_PRESERVED=YES/);
});

test('P1-A1-08 narrow wrapper and Actions expose only fixed A.1 operations with distinct authorization', () => {
  const wrapper = fs.readFileSync(path.join(ROOT, 'deploy/live-physiology-transplant/stay-p1-production-controller'), 'utf8');
  const installer = fs.readFileSync(path.join(ROOT, 'deploy/live-physiology-transplant/install-p1-production-controller.sh'), 'utf8');
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/stage-lightsail-0.7.yml'), 'utf8');
  assert.match(wrapper, /preflight-a1\)/);
  assert.match(wrapper, /surgery-a1\)/);
  assert.match(wrapper, /rollback-a1\)/);
  assert.match(wrapper, /AUTHORIZE_SURGERY_A1_RESIDENT_CONTROL_7D040592CCF1F149/);
  assert.match(wrapper, /AUTHORIZE_ROLLBACK_A1_FORWARD_STATE_7D040592CCF1F149/);
  assert.match(wrapper, /verify_a1_release_identity/);
  assert.match(wrapper, /stay-release-inventory-v1/);
  assert.doesNotMatch(wrapper, /systemd-run|sudo\s+.*(?:bash|node|systemctl|cp|mv|rm)/);
  assert.match(installer, /staydeploy ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/stay-p1-production-controller/);
  assert.match(workflow, /- preflight-a1/);
  assert.match(workflow, /- surgery-a1/);
  assert.match(workflow, /- rollback-a1/);
  assert.doesNotMatch(workflow, /command:\s*\$\{\{\s*inputs|shell_command|arbitrary/i);
});

test('P1-A1-09 controlled runtime restart advances its durable checkpoint without changing authority identity', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stay-p1-a1-restart-'));
  const dataDir = path.join(root, 'state');
  const corePath = path.join(ROOT, 'test/fixtures/cores/counter-v1.js');
  let first = new LivingKernel({
    dataDir,
    allowIdentityBootstrap: true,
    heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0,
    trustedTimePulseIntervalMs: 0
  });
  let restarted = null;
  t.after(async () => {
    if (first?.stateStore?.db) await first.stop().catch(() => {});
    if (restarted?.stateStore?.db) await restarted.stop().catch(() => {});
    await fsp.rm(root, { recursive: true, force: true });
  });

  await first.start();
  await first.installCore(corePath);
  await first.publish('test.tick', {});
  const identityHashBefore = crypto.createHash('sha256')
    .update(stableStringify(first.identity)).digest('hex');
  const authorityBefore = first.stateStore.getAuthority('test-counter');
  const checkpointBefore = await first.stateStore.readAuthoritativeCheckpoint('test-counter');
  const authorityIdentityBefore = {
    coreId: authorityBefore.coreId,
    instanceId: authorityBefore.instanceId,
    version: authorityBefore.version,
    epoch: authorityBefore.epoch,
    barrierSequence: authorityBefore.barrierSequence
  };

  await first.stop();
  first = null;
  restarted = new LivingKernel({
    dataDir,
    heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0,
    trustedTimePulseIntervalMs: 0
  });
  await restarted.start();
  await restarted.installCore(corePath);
  const authorityAfter = restarted.stateStore.getAuthority('test-counter');
  const checkpointAfter = await restarted.stateStore.readAuthoritativeCheckpoint('test-counter');
  const authorityIdentityAfter = {
    coreId: authorityAfter.coreId,
    instanceId: authorityAfter.instanceId,
    version: authorityAfter.version,
    epoch: authorityAfter.epoch,
    barrierSequence: authorityAfter.barrierSequence
  };
  const identityHashAfter = crypto.createHash('sha256')
    .update(stableStringify(restarted.identity)).digest('hex');

  assert.deepEqual(authorityIdentityAfter, authorityIdentityBefore);
  assert.equal(identityHashAfter, identityHashBefore);
  assert.ok(checkpointAfter.generation >= checkpointBefore.generation);
  assert.equal(checkpointAfter.instanceId, checkpointBefore.instanceId);
  assert.equal(checkpointAfter.authorityEpoch, checkpointBefore.authorityEpoch);
});
