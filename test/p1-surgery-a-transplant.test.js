'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const surgery = require('../runtime/release/surgery-a-control');

const ROOT = path.resolve(__dirname, '..');

async function removeImmutableTree(root) {
  if (!fs.existsSync(root)) return;
  const entries = await fsp.readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(entry.parentPath || entry.path, entry.name);
    if (entry.isDirectory()) await fsp.chmod(absolute, 0o700);
    else if (entry.isFile()) await fsp.chmod(absolute, 0o600);
  }
  await fsp.chmod(root, 0o700);
  await fsp.rm(root, { recursive: true, force: true });
}

test('P1-A-01 transplant identities and certified shared anchors are exact', () => {
  const result = surgery.verifyAnchors(ROOT);
  assert.equal(result.status, 'PASS');
  assert.equal(result.sntss.tree, surgery.IDENTITIES.sntssPackageTree);
  assert.equal(result.sntss.version, '0.4.0-i3d3');
  assert.equal(result.sntss.stateSchema, 4);
  assert.equal(result.sntss.productionOutputs, 0);
  assert.equal(result.files.biologicalSignallingFabric.sha256,
    '9838f5e37dc410e6ef959e2b614398ba42a33e87392f39c9a682cd032d85114a');
  assert.equal(result.files.residentManager.sha256,
    'e1b889eb8a4879c71b863f44415bfbd6e3f4b39e0325f3ca100e5c905c483d52');
  assert.equal(result.files.residentManager.certifiedAnchorSha256,
    surgery.IDENTITIES.anchors.residentManager);
  assert.equal(result.files.residentManager.successorRevision, 150);
  assert.equal(surgery.IDENTITIES.anchors.stateStore,
    '28dde80f852294e243ed7a70689a0626062f7f3efa6536d3682e770b4bb521a1');
  assert.equal(result.files.stateStore.sha256,
    'a128b267375141b1a109217e50305aa7f8a15928fa41e9468efda8d843ba7ce7');
  assert.equal(result.files.stateStore.certifiedAnchorSha256,
    surgery.IDENTITIES.anchors.stateStore);
  assert.equal(result.files.stateStore.successorRevision, 150);
});

test('P1-A-02 Surgery A source has no implicit SNTSS or Chronobiology attachment', () => {
  const source = fs.readFileSync(path.join(ROOT, 'runtime/kernel/living-kernel.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.doesNotMatch(server, /attachResident\s*\(/);
  assert.match(source, /listResidents\(\)/);
  assert.match(source, /durableResidents\.length\s*>\s*0/);
  assert.match(source, /require\('\.\/resident-manager'\)/);
  assert.doesNotMatch(source.slice(0, source.indexOf('class LivingKernel')), /resident-manager/);
});

test('P1-A-03 forward rollback entrypoint disables resident recovery and never restores state', () => {
  const entrypoint = fs.readFileSync(path.join(ROOT, 'server-surgery-a-rollback.js'), 'utf8');
  const rollback = fs.readFileSync(path.join(ROOT,
    'deploy/live-physiology-transplant/p1-forward-rollback.sh'), 'utf8');
  assert.match(entrypoint, /STAY_DISABLE_DURABLE_RESIDENTS\s*=\s*'1'/);
  assert.match(rollback, /STAY_ROLLBACK_A_WRITE_AUTHORIZED/);
  assert.match(rollback, /CANONICAL_FORWARD_STATE_PRESERVED=YES/);
  assert.doesNotMatch(rollback, /cp\s+.*\/var\/lib\/stay|tar\s+.*-x|sqlite3\s+.*restore|rm\s+.*\/var\/lib\/stay/);
});

test('P1-A-04 production scripts execute the fail-closed IP guard before service or pointer operations', () => {
  const preflight = fs.readFileSync(path.join(ROOT,
    'deploy/live-physiology-transplant/p1-live-preflight.sh'), 'utf8');
  const rollback = fs.readFileSync(path.join(ROOT,
    'deploy/live-physiology-transplant/p1-forward-rollback.sh'), 'utf8');
  const guard = fs.readFileSync(path.join(ROOT,
    'deploy/live-physiology-transplant/p1-host-identity-guard.sh'), 'utf8');
  assert.match(guard, /EXPECTED_PRIVATE_IPV4="172\.26\.9\.207"/);
  assert.match(guard, /OBSERVED_PRIVATE_IPV4.*!=.*EXPECTED_PRIVATE_IPV4/s);
  for (const source of [preflight, rollback]) {
    const guardAt = source.indexOf('p1-host-identity-guard.sh');
    const systemdAt = source.indexOf('systemctl');
    assert.ok(guardAt >= 0 && systemdAt > guardAt);
  }
  assert.match(preflight, /PRAGMA query_only=ON|p1-state-store-gate/);
  assert.match(preflight, /WRITE_PHASE_AUTHORIZED=NO/);
});

test('P1-A-05 the database inspector is read-only and detects forbidden physiology', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stay-p1-readonly-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const database = path.join(dir, 'continuity.sqlite3');
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE schema_versions(name TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE authority(core_id TEXT PRIMARY KEY, instance_id TEXT, version TEXT, epoch INTEGER, barrier_sequence INTEGER, checkpoint_hash TEXT);
    INSERT INTO schema_versions VALUES('continuity', 3, '2026-08-22T00:00:00Z');
  `);
  db.close();
  const before = surgery.fileSha256(database);
  const state = surgery.inspectDatabase(database);
  surgery.assertPreSurgeryState(state);
  assert.equal(surgery.fileSha256(database), before);

  const writable = new DatabaseSync(database);
  writable.exec(`
    CREATE TABLE resident_instances(residency_id TEXT, core_id TEXT, version TEXT, state_schema INTEGER, status TEXT, checkpoint_hash TEXT, checkpoint_generation INTEGER);
    INSERT INTO resident_instances VALUES('resident:sntss', 'sntss', '0.4.0-i3d3', 4, 'RUNNING', NULL, 0);
  `);
  writable.close();
  assert.throws(() => surgery.assertNoNewPhysiology(surgery.inspectDatabase(database)),
    error => error.code === 'P1_PHYSIOLOGY_ACTIVATED');
});

test('P1-A-06 immutable build and install/start/stop/forward-rollback rehearsal pass off-live', async t => {
  const output = path.join(ROOT, 'release-output',
    `p1-test-${process.pid}-${Date.now()}`);
  await fsp.mkdir(output, { recursive: true });
  t.after(() => removeImmutableTree(output));
  const tree = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  const sourceSha = 'a'.repeat(40);
  const buildText = execFileSync(process.execPath, [
    path.join(ROOT, 'scripts/p1-build-surgery-a.js'),
    '--source-sha', sourceSha,
    '--source-tree', tree,
    '--output-root', output
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const build = JSON.parse(buildText);
  assert.equal(build.status, 'PASS');
  assert.equal(build.schemaMigrationDuringSurgeryA, true);
  for (const release of [build.candidate, build.rollback]) {
    assert.equal(fs.statSync(release.path).mode & 0o222, 0);
    assert.match(release.inventoryHash, /^sha256:[0-9a-f]{64}$/);
  }

  const rehearsalText = execFileSync(process.execPath, [
    path.join(ROOT, 'scripts/p1-offlive-rehearsal.js'),
    '--candidate-root', build.candidate.path,
    '--rollback-root', build.rollback.path
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const rehearsal = JSON.parse(rehearsalText);
  assert.equal(rehearsal.status, 'PASS');
  assert.equal(rehearsal.schema3Compatible, true);
  assert.equal(rehearsal.schemaMigrationDuringSurgeryA, true);
  assert.equal(rehearsal.forwardCompatibleRollbackRelease, 'PROVEN');
  assert.equal(rehearsal.organismIdentityPreserved, true);
  assert.equal(rehearsal.bsfAuthorityRecords, 0);
  assert.equal(rehearsal.residentManagerConstructed, false);
  assert.equal(rehearsal.sntssActivated, false);
  assert.equal(rehearsal.chronobiologyActivated, false);
  assert.equal(rehearsal.biologicalAuthorityChanged, false);
  assert.equal(rehearsal.productionTouched, false);
});
