#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { stableStringify } = require('../../runtime/kernel/canonical-json');
const {
  enforcePackagePolicy,
  verifyManifestAgainstPackagePolicy,
} = require('../../runtime/kernel/package-policy');
const { validateManifest } = require('../../runtime/kernel/manifest');

const BASELINE = Object.freeze({
  runtimeRevision: 116,
  residencyId: 'resident:chronobiology',
  coreId: 'chronobiology',
  instanceId: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
  status: 'RESYNC_REQUIRED',
  version: '1.0.0-c3rc.1',
  stateSchema: 2,
  moduleRelativePath: 'cores/chronobiology/c3/index.js',
  moduleHash: 'sha256:60d15f828a58a0f3dd70a424b2bdb5a7e56c090efa7594c9bb141452439c8a9e',
  releaseManifestHash: 'sha256:e70cb4d3c7a73515027d04fbec6b0f8ea3608dcdf16be3ae89a061e34bd8e624',
  manifestHash: 'sha256:293db4a1e8e6ffd9a4360231ef328da6a648d957d5b04c105b05435c0d0ea7f3',
  packagePolicyHash: 'sha256:9ab15c27c69494c6ce3156255ed06d2f57887934928a85b13ff58d578add7820',
  checkpointId: '96963d58-db13-42ba-af45-c137ec86e29e',
  checkpointGeneration: 5116,
  checkpointHash: '81bb366d99550dffc2e78c16c869bb7da20c70473636c3ee1e95b9d8bf8382ae',
  checkpointByteLength: 49287,
  checkpointInputCursor: 1636338,
  consumerCursor: 2094162,
  failedSequence: 2094163,
});

const REPAIR = Object.freeze({
  version: '1.0.0-c3rc.4',
  stateSchema: 2,
  moduleRelativePath: 'cores/chronobiology/c3r4/index.js',
  moduleHash: 'sha256:f758f8f96aef70af9fa33b805945616d416b80d338cec1e243acc17ca7e6a58a',
  releaseManifestHash: 'sha256:a57e6529e47da7fa227ae5d6feeeacb974f1eea2a9ddf1cd982d438493c1a556',
  manifestHash: 'sha256:30786502c45427d9accd8fdcc418dabe9ed8d9bdaf8cc90d56df55783175211b',
  packagePolicyHash: 'sha256:b4a309490e276df8916475549c796f624c9bb06c4c34507beeddb03121dfbd3e',
  checkpointGeneration: 5117,
  checkpointId: 'chronobiology-c3r4-repair-f1e1ae54-5117',
  repairId: 'chronobiology-c3r4-r116-contained-performance',
});

function fail(message, code = 'R118F_CHRONOBIOLOGY_REPAIR') {
  throw Object.assign(new Error(message), { code });
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalHash(value) {
  return `sha256:${sha256(stableStringify(value))}`;
}

function assert(condition, message, code) {
  if (!condition) fail(message, code);
}

function validateReleaseIdentity(releaseRoot) {
  const root = path.resolve(releaseRoot);
  const historicalEntrypoint = path.join(root, BASELINE.moduleRelativePath);
  const repairEntrypoint = path.join(root, REPAIR.moduleRelativePath);
  const historical = enforcePackagePolicy(historicalEntrypoint);
  const repaired = enforcePackagePolicy(repairEntrypoint);
  const historicalManifest = require(historicalEntrypoint).manifest;
  const repairedManifest = require(repairEntrypoint).manifest;
  const historicalDurableManifest = validateManifest(historicalManifest);
  const repairedDurableManifest = validateManifest(repairedManifest);
  const repairedState = require(path.join(path.dirname(repairEntrypoint), 'state.js'));

  verifyManifestAgainstPackagePolicy(historical, historicalManifest);
  verifyManifestAgainstPackagePolicy(repaired, repairedManifest);

  assert(`sha256:${sha256(fs.readFileSync(historicalEntrypoint))}` === BASELINE.moduleHash,
    'historical Chronobiology module identity changed', 'R118F_REPAIR_RELEASE_IDENTITY');
  assert(canonicalHash(historicalManifest) === BASELINE.releaseManifestHash,
    'historical Chronobiology manifest identity changed', 'R118F_REPAIR_RELEASE_IDENTITY');
  assert(canonicalHash(historicalDurableManifest) === BASELINE.manifestHash,
    'historical Chronobiology durable manifest identity changed',
    'R118F_REPAIR_RELEASE_IDENTITY');
  assert(historical.policy.policyHash === BASELINE.packagePolicyHash,
    'historical Chronobiology package policy changed', 'R118F_REPAIR_RELEASE_IDENTITY');
  assert(`sha256:${sha256(fs.readFileSync(repairEntrypoint))}` === REPAIR.moduleHash,
    'repaired Chronobiology module identity changed', 'R118F_REPAIR_RELEASE_IDENTITY');
  assert(canonicalHash(repairedManifest) === REPAIR.releaseManifestHash,
    'repaired Chronobiology manifest identity changed', 'R118F_REPAIR_RELEASE_IDENTITY');
  assert(canonicalHash(repairedDurableManifest) === REPAIR.manifestHash,
    'repaired Chronobiology durable manifest identity changed',
    'R118F_REPAIR_RELEASE_IDENTITY');
  assert(repaired.policy.policyHash === REPAIR.packagePolicyHash,
    'repaired Chronobiology package policy changed', 'R118F_REPAIR_RELEASE_IDENTITY');
  assert(repairedManifest.version === REPAIR.version
    && repairedManifest.stateSchema === BASELINE.stateSchema
    && repairedManifest.productionEligible === false,
  'repaired Chronobiology manifest is not contained', 'R118F_REPAIR_RELEASE_IDENTITY');
  assert(stableStringify(repairedManifest.resources) === stableStringify(historicalManifest.resources),
    'Chronobiology resource contract changed', 'R118F_REPAIR_RESOURCE_CONTRACT');
  assert(stableStringify(repairedManifest.inputs) === stableStringify(historicalManifest.inputs)
    && stableStringify(repairedManifest.outputs) === stableStringify(historicalManifest.outputs),
  'Chronobiology signalling contract changed', 'R118F_REPAIR_SIGNALLING_CONTRACT');

  return { historicalManifest, repairedManifest, repairedState };
}

function metadataRevision(database) {
  const row = database.prepare(`
    SELECT json, sha256
    FROM metadata
    WHERE key='life:runtime-revision'
  `).get();
  assert(row && sha256(row.json) === row.sha256,
    'runtime revision metadata integrity failed', 'R118F_REPAIR_RUNTIME_REVISION');
  const revision = Number(JSON.parse(row.json).revision);
  assert(Number.isSafeInteger(revision),
    'runtime revision is invalid', 'R118F_REPAIR_RUNTIME_REVISION');
  return revision;
}

function scalar(database, sql, ...parameters) {
  return Number(database.prepare(sql).get(...parameters)?.value || 0);
}

function readBaseline(database) {
  return {
    resident: database.prepare(`
      SELECT * FROM resident_instances WHERE residency_id=?
    `).get(BASELINE.residencyId),
    sourceCheckpoint: database.prepare(`
      SELECT * FROM resident_checkpoints
      WHERE residency_id=? AND generation=?
    `).get(BASELINE.residencyId, BASELINE.checkpointGeneration),
    repairCheckpoint: database.prepare(`
      SELECT * FROM resident_checkpoints
      WHERE residency_id=? AND generation=?
    `).get(BASELINE.residencyId, REPAIR.checkpointGeneration),
    consumer: database.prepare(`
      SELECT * FROM biological_consumers WHERE consumer_id=?
    `).get(BASELINE.residencyId),
  };
}

function assertQuiescentBaseline(database, { allowRepairedIdentity = false } = {}) {
  assert(database.prepare('PRAGMA quick_check').get()?.quick_check === 'ok',
    'SQLite quick-check failed', 'R118F_REPAIR_DATABASE_INTEGRITY');
  assert(metadataRevision(database) === BASELINE.runtimeRevision,
    'durable runtime revision is not the exact R116 recovery boundary',
    'R118F_REPAIR_RUNTIME_REVISION');

  const snapshot = readBaseline(database);
  const resident = snapshot.resident;
  const expectedIdentity = allowRepairedIdentity ? REPAIR : BASELINE;
  assert(resident
    && resident.residency_id === BASELINE.residencyId
    && resident.core_id === BASELINE.coreId
    && resident.instance_id === BASELINE.instanceId
    && resident.version === expectedIdentity.version
    && Number(resident.state_schema) === BASELINE.stateSchema
    && resident.module_relative_path === expectedIdentity.moduleRelativePath
    && resident.module_hash === expectedIdentity.moduleHash
    && resident.manifest_hash === expectedIdentity.manifestHash
    && resident.package_policy_hash === expectedIdentity.packagePolicyHash
    && resident.status === BASELINE.status
    && Number(resident.checkpoint_generation) === expectedIdentity.checkpointGeneration
    && resident.checkpoint_hash === BASELINE.checkpointHash,
  'Chronobiology resident is not the exact fenced implementation boundary',
  'R118F_REPAIR_RESIDENT_FENCE');

  const source = snapshot.sourceCheckpoint;
  assert(source
    && source.checkpoint_id === BASELINE.checkpointId
    && source.instance_id === BASELINE.instanceId
    && source.version === BASELINE.version
    && Number(source.state_schema) === BASELINE.stateSchema
    && Number(source.generation) === BASELINE.checkpointGeneration
    && source.blob_hash === BASELINE.checkpointHash
    && Number(source.byte_length) === BASELINE.checkpointByteLength
    && Number(source.input_cursor) === BASELINE.checkpointInputCursor,
  'Chronobiology source checkpoint identity changed', 'R118F_REPAIR_CHECKPOINT_FENCE');

  if (allowRepairedIdentity) {
    const repaired = snapshot.repairCheckpoint;
    assert(repaired
      && repaired.checkpoint_id === REPAIR.checkpointId
      && repaired.instance_id === BASELINE.instanceId
      && repaired.version === REPAIR.version
      && Number(repaired.state_schema) === REPAIR.stateSchema
      && Number(repaired.generation) === REPAIR.checkpointGeneration
      && repaired.blob_hash === BASELINE.checkpointHash
      && Number(repaired.byte_length) === BASELINE.checkpointByteLength
      && Number(repaired.input_cursor) === BASELINE.checkpointInputCursor,
    'Chronobiology repair checkpoint identity changed', 'R118F_REPAIR_CHECKPOINT_FENCE');
  }

  const consumer = snapshot.consumer;
  assert(consumer
    && consumer.core_id === BASELINE.coreId
    && Number(consumer.required) === 0
    && Number(consumer.active) === 0
    && Number(consumer.cursor) === BASELINE.consumerCursor
    && Number(consumer.authority_epoch) === 0
    && consumer.checkpoint_hash === BASELINE.checkpointHash,
  'Chronobiology consumer is not quiescent', 'R118F_REPAIR_CONSUMER_FENCE');

  assert(scalar(database,
    "SELECT COUNT(*) value FROM biological_deliveries WHERE consumer_id=? AND status='PENDING'",
    BASELINE.residencyId) === 0,
  'Chronobiology has pending delivery debt', 'R118F_REPAIR_PENDING_DEBT');
  assert(scalar(database,
    "SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id=? AND status='PENDING'",
    BASELINE.coreId) === 0,
  'Chronobiology has pending output debt', 'R118F_REPAIR_OUTPUT_DEBT');
  assert(scalar(database,
    'SELECT COUNT(*) value FROM authority WHERE core_id=?', BASELINE.coreId) === 0,
  'Chronobiology owns authority', 'R118F_REPAIR_AUTHORITY');
  assert(scalar(database,
    "SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id=?",
    'sntss') === 0,
  'SNTSS zero-output contract changed', 'R118F_REPAIR_SNTSS_OUTPUT');

  const failure = database.prepare(`
    SELECT detail_json
    FROM recovery_records
    WHERE type='resident.resync-required' AND core_id=?
    ORDER BY id DESC LIMIT 1
  `).get(BASELINE.coreId);
  let failureDetail = null;
  try { failureDetail = JSON.parse(failure?.detail_json || 'null'); } catch {}
  assert(failureDetail
    && Number(failureDetail.sequence) === BASELINE.failedSequence
    && failureDetail.topic === 'runtime.trusted-organism-time.pulse'
    && failureDetail.code === 'COREHOST_TIMEOUT',
  'Chronobiology failure evidence is not the diagnosed live-pulse boundary',
  'R118F_REPAIR_FAILURE_FENCE');

  return snapshot;
}

function checkpointBlob(databasePath, checkpoint) {
  const blobPath = path.join(path.dirname(databasePath), 'blobs', 'sha256',
    checkpoint.blob_hash.slice(0, 2), checkpoint.blob_hash);
  const bytes = fs.readFileSync(blobPath);
  assert(bytes.length === Number(checkpoint.byte_length)
    && sha256(bytes) === checkpoint.blob_hash,
  'Chronobiology checkpoint blob integrity failed', 'R118F_REPAIR_CHECKPOINT_BLOB');
  return bytes;
}

function preflightRepair({ databasePath, releaseRoot }) {
  const manifests = validateReleaseIdentity(releaseRoot);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec('PRAGMA query_only=ON;');
  try {
    const snapshot = assertQuiescentBaseline(database);
    const bytes = checkpointBlob(databasePath, snapshot.sourceCheckpoint);
    const state = JSON.parse(bytes.toString('utf8'));
    assert(stableStringify(manifests.repairedState.normalizeState(state)) === stableStringify(state),
      'Chronobiology checkpoint representation changed under the repair engine',
      'R118F_REPAIR_CHECKPOINT_STATE');
    return Object.freeze({
      result: 'PASS',
      repairId: REPAIR.repairId,
      runtimeRevision: BASELINE.runtimeRevision,
      instanceId: BASELINE.instanceId,
      checkpointGeneration: BASELINE.checkpointGeneration,
      checkpointId: BASELINE.checkpointId,
      checkpointHash: BASELINE.checkpointHash,
      checkpointByteLength: BASELINE.checkpointByteLength,
      checkpointInputCursor: BASELINE.checkpointInputCursor,
      consumerCursor: BASELINE.consumerCursor,
      abandonedCount: 0,
      inventedBiologicalTime: false,
      authorityOwned: false,
      pendingOutputs: 0,
    });
  } finally {
    database.close();
  }
}

function appendRecovery(database, type, detail, createdAt) {
  database.prepare(`
    INSERT INTO recovery_records(type, core_id, detail_json, created_at)
    VALUES(?, ?, ?, ?)
  `).run(type, BASELINE.coreId, stableStringify(detail), createdAt);
}

function applyRepair({
  databasePath,
  releaseRoot,
  now = () => new Date().toISOString(),
  checkpointReader = checkpointBlob,
}) {
  const manifests = validateReleaseIdentity(releaseRoot);
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;');
  try {
    database.exec('BEGIN EXCLUSIVE');
    const current = readBaseline(database).resident;
    if (current?.version === REPAIR.version
      && current?.module_relative_path === REPAIR.moduleRelativePath) {
      assertQuiescentBaseline(database, { allowRepairedIdentity: true });
      database.exec('COMMIT');
      return Object.freeze({ result: 'ALREADY_APPLIED', repairId: REPAIR.repairId });
    }

    const snapshot = assertQuiescentBaseline(database);
    const bytes = checkpointReader(databasePath, snapshot.sourceCheckpoint);
    const state = JSON.parse(bytes.toString('utf8'));
    assert(stableStringify(manifests.repairedState.normalizeState(state)) === stableStringify(state),
      'Chronobiology checkpoint representation changed under the repair engine',
      'R118F_REPAIR_CHECKPOINT_STATE');
    assert(manifests.repairedManifest.stateSchema === Number(snapshot.sourceCheckpoint.state_schema),
      'Chronobiology checkpoint schema changed', 'R118F_REPAIR_CHECKPOINT_STATE');

    const createdAt = now();
    const existingRepairCheckpoint = snapshot.repairCheckpoint;
    if (existingRepairCheckpoint) {
      assert(existingRepairCheckpoint.checkpoint_id === REPAIR.checkpointId
        && existingRepairCheckpoint.instance_id === BASELINE.instanceId
        && existingRepairCheckpoint.version === REPAIR.version
        && Number(existingRepairCheckpoint.state_schema) === REPAIR.stateSchema
        && existingRepairCheckpoint.blob_hash === BASELINE.checkpointHash
        && Number(existingRepairCheckpoint.byte_length) === Number(snapshot.sourceCheckpoint.byte_length)
        && Number(existingRepairCheckpoint.input_cursor) === BASELINE.checkpointInputCursor,
      'existing repair checkpoint does not match the immutable repair generation',
      'R118F_REPAIR_CHECKPOINT_FENCE');
    } else {
      database.prepare(`
        INSERT INTO resident_checkpoints(
          checkpoint_id, residency_id, instance_id, version, state_schema,
          generation, blob_hash, byte_length, input_cursor, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        REPAIR.checkpointId, BASELINE.residencyId, BASELINE.instanceId,
        REPAIR.version, REPAIR.stateSchema, REPAIR.checkpointGeneration,
        BASELINE.checkpointHash, snapshot.sourceCheckpoint.byte_length,
        BASELINE.checkpointInputCursor, createdAt,
      );
    }

    const updated = database.prepare(`
      UPDATE resident_instances SET
        version=?, state_schema=?, module_relative_path=?, module_hash=?,
        manifest_hash=?, package_policy_hash=?, checkpoint_generation=?,
        checkpoint_hash=?, updated_at=?
      WHERE residency_id=? AND instance_id=? AND version=? AND state_schema=?
        AND module_relative_path=? AND module_hash=? AND manifest_hash=?
        AND package_policy_hash=? AND checkpoint_generation=?
        AND checkpoint_hash=? AND status=?
    `).run(
      REPAIR.version, REPAIR.stateSchema, REPAIR.moduleRelativePath, REPAIR.moduleHash,
      REPAIR.manifestHash, REPAIR.packagePolicyHash, REPAIR.checkpointGeneration,
      BASELINE.checkpointHash, createdAt,
      BASELINE.residencyId, BASELINE.instanceId, BASELINE.version, BASELINE.stateSchema,
      BASELINE.moduleRelativePath, BASELINE.moduleHash, BASELINE.manifestHash,
      BASELINE.packagePolicyHash, BASELINE.checkpointGeneration,
      BASELINE.checkpointHash, BASELINE.status,
    );
    assert(updated.changes === 1,
      'Chronobiology implementation compare-and-swap lost its fence',
      'R118F_REPAIR_COMPARE_AND_SWAP');

    appendRecovery(database, 'resident.implementation-repaired', {
      repairId: REPAIR.repairId,
      residencyId: BASELINE.residencyId,
      instanceId: BASELINE.instanceId,
      fromVersion: BASELINE.version,
      toVersion: REPAIR.version,
      fromModuleRelativePath: BASELINE.moduleRelativePath,
      toModuleRelativePath: REPAIR.moduleRelativePath,
      fromModuleHash: BASELINE.moduleHash,
      toModuleHash: REPAIR.moduleHash,
      fromPackagePolicyHash: BASELINE.packagePolicyHash,
      toPackagePolicyHash: REPAIR.packagePolicyHash,
      fromCheckpointGeneration: BASELINE.checkpointGeneration,
      toCheckpointGeneration: REPAIR.checkpointGeneration,
      checkpointHash: BASELINE.checkpointHash,
      checkpointBytesChanged: false,
      sourceCheckpointId: BASELINE.checkpointId,
      checkpointByteLength: BASELINE.checkpointByteLength,
      biologicalStateChanged: false,
      inventedBiologicalTime: false,
      abandonedCount: 0,
      authorityChanged: false,
      resourceLimitsChanged: false,
      checkpointInputCursor: BASELINE.checkpointInputCursor,
      consumerCursor: BASELINE.consumerCursor,
      runtimeRevision: BASELINE.runtimeRevision,
    }, createdAt);

    assertQuiescentBaseline(database, { allowRepairedIdentity: true });
    database.exec('COMMIT');
    return Object.freeze({
      result: 'APPLIED',
      repairId: REPAIR.repairId,
      sourceCheckpointId: BASELINE.checkpointId,
      checkpointHash: BASELINE.checkpointHash,
      checkpointByteLength: BASELINE.checkpointByteLength,
      checkpointInputCursor: BASELINE.checkpointInputCursor,
      consumerCursor: BASELINE.consumerCursor,
      fromCheckpointGeneration: BASELINE.checkpointGeneration,
      toCheckpointGeneration: REPAIR.checkpointGeneration,
    });
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    database.close();
  }
}

function rollbackRepair({ databasePath, releaseRoot, now = () => new Date().toISOString() }) {
  validateReleaseIdentity(releaseRoot);
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;');
  try {
    database.exec('BEGIN EXCLUSIVE');
    assertQuiescentBaseline(database, { allowRepairedIdentity: true });
    assert(scalar(database, `
      SELECT COUNT(*) value FROM resident_checkpoints
      WHERE residency_id=? AND generation>?
    `, BASELINE.residencyId, REPAIR.checkpointGeneration) === 0,
    'Chronobiology advanced beyond the rollback fence', 'R118F_REPAIR_ROLLBACK_FENCE');

    const createdAt = now();
    const updated = database.prepare(`
      UPDATE resident_instances SET
        version=?, state_schema=?, module_relative_path=?, module_hash=?,
        manifest_hash=?, package_policy_hash=?, checkpoint_generation=?,
        checkpoint_hash=?, updated_at=?
      WHERE residency_id=? AND instance_id=? AND version=? AND state_schema=?
        AND module_relative_path=? AND module_hash=? AND manifest_hash=?
        AND package_policy_hash=? AND checkpoint_generation=?
        AND checkpoint_hash=? AND status=?
    `).run(
      BASELINE.version, BASELINE.stateSchema, BASELINE.moduleRelativePath, BASELINE.moduleHash,
      BASELINE.manifestHash, BASELINE.packagePolicyHash, BASELINE.checkpointGeneration,
      BASELINE.checkpointHash, createdAt,
      BASELINE.residencyId, BASELINE.instanceId, REPAIR.version, REPAIR.stateSchema,
      REPAIR.moduleRelativePath, REPAIR.moduleHash, REPAIR.manifestHash,
      REPAIR.packagePolicyHash, REPAIR.checkpointGeneration,
      BASELINE.checkpointHash, BASELINE.status,
    );
    assert(updated.changes === 1, 'Chronobiology repair rollback lost its fence',
      'R118F_REPAIR_ROLLBACK_COMPARE_AND_SWAP');
    appendRecovery(database, 'resident.implementation-repair-rolled-back', {
      repairId: REPAIR.repairId,
      residencyId: BASELINE.residencyId,
      instanceId: BASELINE.instanceId,
      sourceCheckpointId: BASELINE.checkpointId,
      checkpointHash: BASELINE.checkpointHash,
      checkpointByteLength: BASELINE.checkpointByteLength,
      checkpointInputCursor: BASELINE.checkpointInputCursor,
      consumerCursor: BASELINE.consumerCursor,
      biologicalStateChanged: false,
      inventedBiologicalTime: false,
      abandonedCount: 0,
      authorityChanged: false,
      runtimeRevision: BASELINE.runtimeRevision,
    }, createdAt);
    assertQuiescentBaseline(database);
    database.exec('COMMIT');
    return Object.freeze({ result: 'ROLLED_BACK', repairId: REPAIR.repairId });
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    database.close();
  }
}

function parseArguments(argv) {
  const mode = argv[2];
  const databasePath = argv[3];
  const releaseRoot = argv[4];
  assert(['preflight', 'apply', 'rollback'].includes(mode) && databasePath && releaseRoot,
    'usage: p1-r118f-chronobiology-implementation-repair.js preflight|apply|rollback DATABASE RELEASE_ROOT',
    'R118F_REPAIR_ARGUMENTS');
  return { mode, databasePath: path.resolve(databasePath), releaseRoot: path.resolve(releaseRoot) };
}

if (require.main === module) {
  try {
    const { mode, ...options } = parseArguments(process.argv);
    const result = mode === 'preflight'
      ? preflightRepair(options)
      : mode === 'apply'
        ? applyRepair(options)
        : rollbackRepair(options);
    process.stdout.write(`${stableStringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`R118F_CHRONOBIOLOGY_REPAIR_ABORT=${error.code || 'ERROR'}:${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  BASELINE,
  REPAIR,
  applyRepair,
  preflightRepair,
  rollbackRepair,
  validateReleaseIdentity,
};
