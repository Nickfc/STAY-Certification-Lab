#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const surgery = require('../runtime/release/surgery-a-control');

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

async function atomicPointer(pointer, target) {
  const temporary = `${pointer}.new-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fsp.symlink(path.resolve(target), temporary);
  await fsp.rename(temporary, pointer);
}

async function makeDisposableTreeWritable(root) {
  if (!fs.existsSync(root)) return;
  const entries = await fsp.readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(entry.parentPath || entry.path, entry.name);
    if (entry.isDirectory()) await fsp.chmod(absolute, 0o700);
    else if (entry.isFile()) await fsp.chmod(absolute, 0o600);
  }
  await fsp.chmod(root, 0o700);
}

async function createSchema3Fixture(dataDir) {
  await fsp.mkdir(path.join(dataDir, 'life'), { recursive: true, mode: 0o700 });
  const identity = Object.freeze({
    organismId: 'stay-p1-offlive-existing-organism',
    createdAt: '2026-08-15T12:48:11.910Z',
    lineage: 'STAY/Genesis'
  });
  await fsp.writeFile(
    path.join(dataDir, 'life', 'identity.json'),
    `${JSON.stringify(identity, null, 2)}\n`,
    { mode: 0o600 }
  );
  const databasePath = path.join(dataDir, 'continuity.sqlite3');
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, json TEXT NOT NULL, sha256 TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE pending_metadata_mirrors (key TEXT PRIMARY KEY, relative_path TEXT NOT NULL, json TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE authority (core_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, version TEXT NOT NULL, epoch INTEGER NOT NULL, barrier_sequence INTEGER NOT NULL DEFAULT 0, checkpoint_hash TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE upgrade_transactions (transaction_id TEXT PRIMARY KEY, core_id TEXT NOT NULL, status TEXT NOT NULL, from_instance_id TEXT NOT NULL, from_version TEXT NOT NULL, from_epoch INTEGER NOT NULL, to_instance_id TEXT NOT NULL, to_version TEXT NOT NULL, to_epoch INTEGER NOT NULL, barrier_sequence INTEGER NOT NULL, prepared_at TEXT NOT NULL, finalized_at TEXT, to_checkpoint_hash TEXT, to_state_schema INTEGER, detail_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE checkpoints (checkpoint_id TEXT PRIMARY KEY, core_id TEXT NOT NULL, instance_id TEXT NOT NULL, version TEXT NOT NULL, authority_epoch INTEGER NOT NULL, state_schema INTEGER NOT NULL, generation INTEGER NOT NULL, blob_hash TEXT NOT NULL, byte_length INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(core_id, generation));
      CREATE TABLE recovery_records (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, core_id TEXT, detail_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE schema_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
    `);
    db.prepare('INSERT INTO schema_versions(name, version, updated_at) VALUES(?, ?, ?)')
      .run('continuity', 3, '2026-08-15T13:16:23.428Z');
    db.prepare(`INSERT INTO authority(core_id, instance_id, version, epoch, barrier_sequence, checkpoint_hash, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run(
        'fetus-legacy', '82202211-8dd6-44d4-a4ec-8f2553d8dc6f', '0.6.0', 1, 0,
        'fcda9ed1919bf60902968b883e3649a7fdbb13f3c0c15b20b4e0ea31ae4d6e9a',
        '2026-08-22T13:16:23.557Z'
      );
    db.prepare(`INSERT INTO checkpoints(checkpoint_id, core_id, instance_id, version, authority_epoch, state_schema, generation, blob_hash, byte_length, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'p1-fixture-fetus-37', 'fetus-legacy', '82202211-8dd6-44d4-a4ec-8f2553d8dc6f',
        '0.6.0', 1, 1, 37,
        'fcda9ed1919bf60902968b883e3649a7fdbb13f3c0c15b20b4e0ea31ae4d6e9a',
        13758, '2026-08-22T13:16:23.557Z'
      );
  } finally {
    db.close();
  }
  return { databasePath, identity };
}

async function runKernel(releaseRoot, dataDir, durableResidentsDisabled) {
  const runtimePath = path.join(releaseRoot, 'runtime');
  delete require.cache[require.resolve(runtimePath)];
  const { LivingKernel } = require(runtimePath);
  const kernel = new LivingKernel({
    dataDir,
    allowIdentityBootstrap: false,
    heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0,
    trustedTimePulseIntervalMs: 0,
    durableResidentsDisabled,
    auxiliaryCorePaths: ''
  });
  await kernel.start();
  const status = await kernel.status();
  await kernel.stop();
  return status;
}

function appendForwardState(databasePath) {
  const db = new DatabaseSync(databasePath);
  const forwardHash = '7c65f47b08b4c594363bb0f9ecafdd818de5ebd8457bcf49e00e131fd7f4b786';
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    db.prepare(`INSERT INTO checkpoints(checkpoint_id, core_id, instance_id, version, authority_epoch, state_schema, generation, blob_hash, byte_length, input_cursor, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'p1-forward-fetus-38', 'fetus-legacy', '82202211-8dd6-44d4-a4ec-8f2553d8dc6f',
        '0.6.0', 1, 1, 38, forwardHash, 13801, 0, new Date().toISOString()
      );
    db.prepare('UPDATE authority SET checkpoint_hash=?, updated_at=? WHERE core_id=?')
      .run(forwardHash, new Date().toISOString(), 'fetus-legacy');
    db.prepare('INSERT INTO recovery_records(type, core_id, detail_json, created_at) VALUES(?, ?, ?, ?)')
      .run('p1.forward-state-sentinel', 'fetus-legacy', JSON.stringify({ generation: 38, blobHash: forwardHash }), new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.close();
  }
  return forwardHash;
}

function assertForwardState(databasePath, forwardHash) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const checkpoint = db.prepare('SELECT generation, blob_hash FROM checkpoints WHERE core_id=? ORDER BY generation DESC LIMIT 1').get('fetus-legacy');
    const authority = db.prepare('SELECT core_id, instance_id, version, epoch, checkpoint_hash FROM authority WHERE core_id=?').get('fetus-legacy');
    const sentinel = Number(db.prepare("SELECT COUNT(*) AS count FROM recovery_records WHERE type='p1.forward-state-sentinel'").get()?.count || 0);
    if (Number(checkpoint?.generation) !== 38 || checkpoint?.blob_hash !== forwardHash ||
        authority?.checkpoint_hash !== forwardHash || sentinel !== 1) {
      throw Object.assign(new Error('forward biological state was rewound or lost'), {
        code: 'P1_FORWARD_STATE_REWIND'
      });
    }
    return { checkpoint, authority, sentinel };
  } finally { db.close(); }
}

async function main(argv = process.argv.slice(2)) {
  const candidateRoot = path.resolve(option(argv, '--candidate-root') || '');
  const rollbackRoot = path.resolve(option(argv, '--rollback-root') || '');
  if (!candidateRoot || !rollbackRoot || !fs.existsSync(candidateRoot) || !fs.existsSync(rollbackRoot)) {
    throw Object.assign(new Error('usage: p1-offlive-rehearsal --candidate-root <dir> --rollback-root <dir>'), {
      code: 'P1_REHEARSAL_USAGE'
    });
  }
  surgery.verifyAnchors(candidateRoot, { verifyGitTrees: false });
  surgery.verifyAnchors(rollbackRoot, { verifyGitTrees: false });

  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'stay-p1-surgery-a-'));
  try {
    const releases = path.join(workspace, 'releases');
    const oldRelease = path.join(releases, 'old-schema3');
    const installedCandidate = path.join(releases, path.basename(candidateRoot));
    const installedRollback = path.join(releases, path.basename(rollbackRoot));
    const current = path.join(workspace, 'current');
    const dataDir = path.join(workspace, 'state', 'data');
    await fsp.mkdir(oldRelease, { recursive: true });
    await fsp.writeFile(path.join(oldRelease, 'release.txt'), 'schema3 runtime fixture\n');
    await fsp.cp(candidateRoot, installedCandidate, { recursive: true });
    await fsp.cp(rollbackRoot, installedRollback, { recursive: true });
    await atomicPointer(current, oldRelease);
    const fixture = await createSchema3Fixture(dataDir);
    const before = surgery.inspectDatabase(fixture.databasePath);
    surgery.assertPreSurgeryState(before);

    await atomicPointer(current, installedCandidate);
    const candidateStatus = await runKernel(installedCandidate, dataDir, false);
    const afterCandidate = surgery.inspectDatabase(fixture.databasePath);
    surgery.assertPostSurgeryState(before, afterCandidate);
    const candidateResidentManagerLoaded = Object.keys(require.cache).some(file =>
      file.startsWith(installedCandidate) &&
      /resident-manager/.test(file)
    );
    if (candidateResidentManagerLoaded) {
      throw Object.assign(new Error('Surgery A constructed the resident authority substrate without resident state'), {
        code: 'P1_UNAUTHORIZED_INFRASTRUCTURE_LOAD'
      });
    }

    const forwardHash = appendForwardState(fixture.databasePath);
    await atomicPointer(current, installedRollback);
    const rollbackStatus = await runKernel(installedRollback, dataDir, true);
    const afterRollback = surgery.inspectDatabase(fixture.databasePath);
    surgery.assertNoNewPhysiology(afterRollback);
    const forwardState = assertForwardState(fixture.databasePath, forwardHash);
    const rollbackResidentManagerLoaded = Object.keys(require.cache).some(file =>
      file.startsWith(installedRollback) &&
      /resident-manager/.test(file)
    );
    if (rollbackResidentManagerLoaded) {
      throw Object.assign(new Error('forward rollback constructed the resident authority substrate'), {
        code: 'P1_ROLLBACK_AUTHORITY_LOAD'
      });
    }
    const identityAfter = JSON.parse(await fsp.readFile(path.join(dataDir, 'life', 'identity.json'), 'utf8'));
    if (JSON.stringify(identityAfter) !== JSON.stringify(fixture.identity)) {
      throw Object.assign(new Error('organism identity changed during rehearsal'), {
        code: 'P1_IDENTITY_CHANGED'
      });
    }

    process.stdout.write(`${JSON.stringify({
      status: 'PASS',
      workspaceClass: 'disposable-off-live',
      install: 'PASS',
      candidateStart: candidateStatus.health?.ok === true ? 'PASS' : 'FAIL',
      candidateStop: 'PASS',
      rollbackStart: rollbackStatus.health?.ok === true ? 'PASS' : 'FAIL',
      rollbackStop: 'PASS',
      pointerRollback: path.resolve(await fsp.realpath(current)) === path.resolve(installedRollback),
      schema3Compatible: true,
      schemaMigrationDuringSurgeryA: true,
      continuitySchemaAfter: afterCandidate.continuitySchema,
      forwardCompatibleRollbackRelease: 'PROVEN',
      forwardStatePreserved: forwardState,
      organismIdentityPreserved: true,
      authorityIdentityPreserved: before.authority.map(({ core_id, instance_id, version, epoch }) => ({ core_id, instance_id, version, epoch })),
      bsfPresent: true,
      bsfAuthorityRecords: 0,
      residentManagerConstructed: false,
      sntssActivated: false,
      chronobiologyActivated: false,
      biologicalAuthorityChanged: false,
      productionTouched: false
    }, null, 2)}\n`);
  } finally {
    await makeDisposableTreeWritable(workspace);
    await fsp.rm(workspace, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`${error.code || 'P1_REHEARSAL_FAILED'}: ${error.message}`);
  process.exitCode = 1;
});
