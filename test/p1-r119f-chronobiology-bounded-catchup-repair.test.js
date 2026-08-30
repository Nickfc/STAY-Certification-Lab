'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { stableStringify } = require('../runtime/kernel/canonical-json');
const { validateManifest } = require('../runtime/kernel/manifest');
const {
  BASELINE,
  REPAIR,
  applyRepair,
  preflightRepair,
  rollbackRepair,
  validateReleaseIdentity,
} = require('../deploy/live-physiology-transplant/p1-r119f-chronobiology-bounded-catchup-repair');
const { emptyState } = require('../cores/chronobiology/c3/state');

const root = path.resolve(__dirname, '..');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-r119f-repair-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'continuity.sqlite3');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE metadata(key TEXT PRIMARY KEY, json TEXT NOT NULL, sha256 TEXT NOT NULL);
    CREATE TABLE resident_instances(
      residency_id TEXT PRIMARY KEY, core_id TEXT, role TEXT, instance_id TEXT,
      version TEXT, state_schema INTEGER, module_relative_path TEXT, module_hash TEXT,
      manifest_hash TEXT, package_policy_hash TEXT, organism_identity_hash TEXT,
      checkpoint_hash TEXT, checkpoint_generation INTEGER, status TEXT,
      attached_at TEXT, updated_at TEXT
    );
    CREATE TABLE resident_checkpoints(
      checkpoint_id TEXT PRIMARY KEY, residency_id TEXT, instance_id TEXT,
      version TEXT, state_schema INTEGER, generation INTEGER, blob_hash TEXT,
      byte_length INTEGER, input_cursor INTEGER, created_at TEXT,
      UNIQUE(residency_id, generation)
    );
    CREATE TABLE biological_consumers(
      consumer_id TEXT PRIMARY KEY, core_id TEXT, required INTEGER, active INTEGER,
      topics_json TEXT, topics_sha256 TEXT, cursor INTEGER, authority_epoch INTEGER,
      checkpoint_hash TEXT, registered_at TEXT, updated_at TEXT
    );
    CREATE TABLE biological_deliveries(sequence INTEGER, consumer_id TEXT, status TEXT);
    CREATE TABLE biological_outbox_intents(producer_core_id TEXT, status TEXT);
    CREATE TABLE authority(core_id TEXT);
    CREATE TABLE recovery_records(
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, core_id TEXT,
      detail_json TEXT, created_at TEXT
    );
  `);
  const revisionJson = JSON.stringify({ revision: BASELINE.runtimeRevision });
  database.prepare('INSERT INTO metadata VALUES(?, ?, ?)').run(
    'life:runtime-revision', revisionJson, sha256(revisionJson));
  database.prepare(`
    INSERT INTO resident_instances VALUES(
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    BASELINE.residencyId, BASELINE.coreId, 'chronobiology', BASELINE.instanceId,
    BASELINE.version, BASELINE.stateSchema, BASELINE.moduleRelativePath,
    BASELINE.moduleHash, BASELINE.manifestHash, BASELINE.packagePolicyHash,
    `sha256:${'d'.repeat(64)}`, BASELINE.checkpointHash,
    BASELINE.checkpointGeneration, BASELINE.status,
    '2026-08-01T00:00:00.000Z', '2026-08-29T04:00:00.000Z',
  );

  const checkpointBytes = Buffer.from(stableStringify(emptyState()));
  database.prepare(`
    INSERT INTO resident_checkpoints VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    BASELINE.checkpointId, BASELINE.residencyId, BASELINE.instanceId,
    BASELINE.version, BASELINE.stateSchema, BASELINE.checkpointGeneration,
    BASELINE.checkpointHash, BASELINE.checkpointByteLength, BASELINE.checkpointInputCursor,
    '2026-08-29T04:00:00.000Z',
  );
  const topics = stableStringify([
    'environment.photic.exposure',
    'runtime.organism.binding',
    'runtime.trusted-organism-time.pulse',
  ]);
  database.prepare(`
    INSERT INTO biological_consumers VALUES(?, ?, 0, 0, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    BASELINE.residencyId, BASELINE.coreId, topics, sha256(topics),
    BASELINE.consumerCursor, BASELINE.checkpointHash,
    '2026-08-01T00:00:00.000Z', '2026-08-29T04:00:00.000Z',
  );
  database.prepare(`
    INSERT INTO recovery_records(type, core_id, detail_json, created_at)
    VALUES('resident.resync-required', ?, ?, ?)
  `).run(BASELINE.coreId, stableStringify({
    sequence: BASELINE.failedSequence,
    topic: 'runtime.trusted-organism-time.pulse',
    code: 'CORE_WORKER_TIMEOUT',
  }), '2026-08-29T04:00:01.000Z');
  database.close();

  const blobPath = path.join(directory, 'blobs', 'sha256', BASELINE.checkpointHash.slice(0, 2),
    BASELINE.checkpointHash);
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  fs.writeFileSync(blobPath, checkpointBytes);
  return { databasePath, directory, checkpointBytes };
}

function read(databasePath, sql, ...parameters) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try { return database.prepare(sql).get(...parameters); }
  finally { database.close(); }
}

test('R119F-IMP-01 release identity preserves historical code, limits, routes and authority containment', () => {
  const { historicalManifest, repairedManifest } = validateReleaseIdentity(root);
  assert.equal(`sha256:${sha256(stableStringify(historicalManifest))}`,
    BASELINE.releaseManifestHash);
  assert.equal(`sha256:${sha256(stableStringify(validateManifest(historicalManifest)))}`,
    BASELINE.manifestHash);
  assert.equal(`sha256:${sha256(stableStringify(repairedManifest))}`,
    REPAIR.releaseManifestHash);
  assert.equal(`sha256:${sha256(stableStringify(validateManifest(repairedManifest)))}`,
    REPAIR.manifestHash);
  assert.notEqual(BASELINE.releaseManifestHash, BASELINE.manifestHash);
  assert.notEqual(REPAIR.releaseManifestHash, REPAIR.manifestHash);
  assert.notEqual(BASELINE.checkpointInputCursor, BASELINE.consumerCursor);
  assert.equal(historicalManifest.version, BASELINE.version);
  assert.equal(repairedManifest.version, REPAIR.version);
  assert.equal(repairedManifest.productionEligible, false);
  assert.deepEqual(repairedManifest.resources, historicalManifest.resources);
  assert.deepEqual(repairedManifest.inputs, historicalManifest.inputs);
  assert.deepEqual(repairedManifest.outputs, historicalManifest.outputs);
});

test('R119F-IMP-02 exact offline CAS preserves checkpoint bytes, instance, cursor and zero authority', t => {
  const data = fixture(t);
  const result = applyRepair({
    databasePath: data.databasePath,
    releaseRoot: root,
    now: () => '2026-08-29T05:00:00.000Z',
    checkpointReader: () => data.checkpointBytes,
  });
  assert.equal(result.result, 'APPLIED');

  const resident = read(data.databasePath,
    'SELECT * FROM resident_instances WHERE residency_id=?', BASELINE.residencyId);
  assert.equal(resident.instance_id, BASELINE.instanceId);
  assert.equal(resident.version, REPAIR.version);
  assert.equal(resident.module_relative_path, REPAIR.moduleRelativePath);
  assert.equal(resident.status, BASELINE.status);
  assert.equal(resident.checkpoint_hash, BASELINE.checkpointHash);
  assert.equal(resident.checkpoint_generation, REPAIR.checkpointGeneration);
  const oldCheckpoint = read(data.databasePath,
    'SELECT * FROM resident_checkpoints WHERE residency_id=? AND generation=?',
    BASELINE.residencyId, BASELINE.checkpointGeneration);
  const repairedCheckpoint = read(data.databasePath,
    'SELECT * FROM resident_checkpoints WHERE residency_id=? AND generation=?',
    BASELINE.residencyId, REPAIR.checkpointGeneration);
  assert.equal(oldCheckpoint.version, BASELINE.version);
  assert.equal(repairedCheckpoint.version, REPAIR.version);
  assert.equal(repairedCheckpoint.blob_hash, oldCheckpoint.blob_hash);
  assert.equal(repairedCheckpoint.byte_length, oldCheckpoint.byte_length);
  assert.equal(oldCheckpoint.checkpoint_id, BASELINE.checkpointId);
  assert.equal(oldCheckpoint.byte_length, BASELINE.checkpointByteLength);
  assert.equal(oldCheckpoint.input_cursor, BASELINE.checkpointInputCursor);
  assert.equal(repairedCheckpoint.input_cursor, oldCheckpoint.input_cursor);
  const consumer = read(data.databasePath,
    'SELECT * FROM biological_consumers WHERE consumer_id=?', BASELINE.residencyId);
  assert.equal(consumer.cursor, BASELINE.consumerCursor);
  const evidence = read(data.databasePath, `
    SELECT detail_json FROM recovery_records
    WHERE type='resident.implementation-repaired'
  `);
  assert.deepEqual(JSON.parse(evidence.detail_json), {
    abandonedCount: 0,
    authorityChanged: false,
    biologicalStateChanged: false,
    checkpointBytesChanged: false,
    checkpointByteLength: BASELINE.checkpointByteLength,
    checkpointHash: BASELINE.checkpointHash,
    checkpointInputCursor: BASELINE.checkpointInputCursor,
    consumerCursor: BASELINE.consumerCursor,
    fromCheckpointGeneration: BASELINE.checkpointGeneration,
    fromModuleHash: BASELINE.moduleHash,
    fromModuleRelativePath: BASELINE.moduleRelativePath,
    fromPackagePolicyHash: BASELINE.packagePolicyHash,
    fromVersion: BASELINE.version,
    instanceId: BASELINE.instanceId,
    inventedBiologicalTime: false,
    repairId: REPAIR.repairId,
    residencyId: BASELINE.residencyId,
    resourceLimitsChanged: false,
    runtimeRevision: BASELINE.runtimeRevision,
    sourceCheckpointId: BASELINE.checkpointId,
    toCheckpointGeneration: REPAIR.checkpointGeneration,
    toModuleHash: REPAIR.moduleHash,
    toModuleRelativePath: REPAIR.moduleRelativePath,
    toPackagePolicyHash: REPAIR.packagePolicyHash,
    toVersion: REPAIR.version,
  });
  assert.equal(applyRepair({
    databasePath: data.databasePath,
    releaseRoot: root,
    checkpointReader: () => data.checkpointBytes,
  }).result,
    'ALREADY_APPLIED');
});

test('R119F-IMP-03 physiological provenance and administrative cursor are fenced independently',
  async t => {
    await t.test('checkpoint provenance cannot be replaced by the consumer cursor', () => {
      const data = fixture(t);
      const database = new DatabaseSync(data.databasePath);
      database.prepare(`
        UPDATE resident_checkpoints SET input_cursor=?
        WHERE residency_id=? AND generation=?
      `).run(BASELINE.consumerCursor, BASELINE.residencyId, BASELINE.checkpointGeneration);
      database.close();

      assert.throws(() => applyRepair({
        databasePath: data.databasePath,
        releaseRoot: root,
        checkpointReader: () => data.checkpointBytes,
      }), { code: 'R119F_REPAIR_CHECKPOINT_FENCE' });
      assert.equal(read(data.databasePath, `
        SELECT COUNT(*) value FROM resident_checkpoints WHERE generation=?
      `, REPAIR.checkpointGeneration).value, 0);
      assert.equal(read(data.databasePath, `
        SELECT version FROM resident_instances WHERE residency_id=?
      `, BASELINE.residencyId).version, BASELINE.version);
    });

    await t.test('consumer cursor cannot be replaced by checkpoint provenance', () => {
      const data = fixture(t);
      const database = new DatabaseSync(data.databasePath);
      database.prepare(`
        UPDATE biological_consumers SET cursor=? WHERE consumer_id=?
      `).run(BASELINE.checkpointInputCursor, BASELINE.residencyId);
      database.close();

      assert.throws(() => applyRepair({
        databasePath: data.databasePath,
        releaseRoot: root,
        checkpointReader: () => data.checkpointBytes,
      }), { code: 'R119F_REPAIR_CONSUMER_FENCE' });
      assert.equal(read(data.databasePath, `
        SELECT COUNT(*) value FROM resident_checkpoints WHERE generation=?
      `, REPAIR.checkpointGeneration).value, 0);
      assert.equal(read(data.databasePath, `
        SELECT version FROM resident_instances WHERE residency_id=?
      `, BASELINE.residencyId).version, BASELINE.version);
    });
  });

test('R119F-IMP-04 any pending debt rejects atomically without changing the implementation', t => {
  const data = fixture(t);
  const database = new DatabaseSync(data.databasePath);
  database.prepare('INSERT INTO biological_deliveries VALUES(?, ?, ?)').run(
    BASELINE.failedSequence, BASELINE.residencyId, 'PENDING');
  database.close();

  assert.throws(() => applyRepair({
    databasePath: data.databasePath,
    releaseRoot: root,
    checkpointReader: () => data.checkpointBytes,
  }), {
    code: 'R119F_REPAIR_PENDING_DEBT',
  });
  const resident = read(data.databasePath,
    'SELECT * FROM resident_instances WHERE residency_id=?', BASELINE.residencyId);
  assert.equal(resident.version, BASELINE.version);
  assert.equal(resident.checkpoint_generation, BASELINE.checkpointGeneration);
  assert.equal(read(data.databasePath, `
    SELECT COUNT(*) value FROM resident_checkpoints WHERE generation=?
  `, REPAIR.checkpointGeneration).value, 0);
});

test('R119F-IMP-05 pre-advancement rollback is fenced and retains immutable repair evidence', t => {
  const data = fixture(t);
  applyRepair({
    databasePath: data.databasePath,
    releaseRoot: root,
    checkpointReader: () => data.checkpointBytes,
  });
  const result = rollbackRepair({
    databasePath: data.databasePath,
    releaseRoot: root,
    now: () => '2026-08-29T05:01:00.000Z',
  });
  assert.equal(result.result, 'ROLLED_BACK');
  const resident = read(data.databasePath,
    'SELECT * FROM resident_instances WHERE residency_id=?', BASELINE.residencyId);
  assert.equal(resident.version, BASELINE.version);
  assert.equal(resident.module_relative_path, BASELINE.moduleRelativePath);
  assert.equal(resident.checkpoint_generation, BASELINE.checkpointGeneration);
  assert.equal(read(data.databasePath, `
    SELECT COUNT(*) value FROM recovery_records
    WHERE type IN ('resident.implementation-repaired',
      'resident.implementation-repair-rolled-back')
  `).value, 2);
  assert.equal(read(data.databasePath, `
    SELECT COUNT(*) value FROM resident_checkpoints WHERE generation=?
  `, REPAIR.checkpointGeneration).value, 1);
});

test('R119F-IMP-06 real preflight refuses a checkpoint blob that misses the immutable SHA-256', t => {
  const data = fixture(t);
  assert.throws(() => preflightRepair({
    databasePath: data.databasePath,
    releaseRoot: root,
  }), { code: 'R119F_REPAIR_CHECKPOINT_BLOB' });
  const resident = read(data.databasePath,
    'SELECT * FROM resident_instances WHERE residency_id=?', BASELINE.residencyId);
  assert.equal(resident.version, BASELINE.version);
  assert.equal(resident.checkpoint_generation, BASELINE.checkpointGeneration);
});

test('R119F-IMP-07 durable resident fence requires the normalized manifest identity', t => {
  const data = fixture(t);
  const database = new DatabaseSync(data.databasePath);
  database.prepare(`
    UPDATE resident_instances SET manifest_hash=? WHERE residency_id=?
  `).run(BASELINE.releaseManifestHash, BASELINE.residencyId);
  database.close();

  assert.throws(() => preflightRepair({
    databasePath: data.databasePath,
    releaseRoot: root,
  }), { code: 'R119F_REPAIR_RESIDENT_FENCE' });
  const resident = read(data.databasePath,
    'SELECT * FROM resident_instances WHERE residency_id=?', BASELINE.residencyId);
  assert.equal(resident.version, BASELINE.version);
  assert.equal(resident.manifest_hash, BASELINE.releaseManifestHash);
  assert.equal(resident.checkpoint_generation, BASELINE.checkpointGeneration);
});

test('R119F-IMP-08 idempotent apply refuses a corrupted repair-checkpoint provenance', t => {
  const data = fixture(t);
  applyRepair({
    databasePath: data.databasePath,
    releaseRoot: root,
    checkpointReader: () => data.checkpointBytes,
  });
  const database = new DatabaseSync(data.databasePath);
  database.prepare(`
    UPDATE resident_checkpoints SET input_cursor=?
    WHERE residency_id=? AND generation=?
  `).run(BASELINE.consumerCursor, BASELINE.residencyId, REPAIR.checkpointGeneration);
  database.close();

  assert.throws(() => applyRepair({
    databasePath: data.databasePath,
    releaseRoot: root,
    checkpointReader: () => data.checkpointBytes,
  }), { code: 'R119F_REPAIR_CHECKPOINT_FENCE' });
  const resident = read(data.databasePath,
    'SELECT * FROM resident_instances WHERE residency_id=?', BASELINE.residencyId);
  assert.equal(resident.version, REPAIR.version);
  assert.equal(resident.checkpoint_generation, REPAIR.checkpointGeneration);
});
