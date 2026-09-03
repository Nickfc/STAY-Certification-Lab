#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { stableStringify } = require('../../runtime/kernel/canonical-json');
const { enforcePackagePolicy, verifyManifestAgainstPackagePolicy } =
  require('../../runtime/kernel/package-policy');
const { validateManifest } = require('../../runtime/kernel/manifest');

const BASELINE = Object.freeze({
  runtimeRevision: 146,
  residencyId: 'resident:metab',
  coreId: 'METAB',
  instanceId: 'd424c722-ef31-44b0-8201-ba68c418d14a',
  version: '0.2.0-p1r0-shadow.1',
  stateSchema: 2,
  moduleRelativePath: 'cores/p1-r0/metab-shadow/index.js',
  moduleHash: 'sha256:07b0b6d5d6b51f70dec6d224fb46ae62f5b2f0aa0579f7d1aa3dcc24073bdcbe',
  manifestHash: 'sha256:06767143b3eae0760931d93029d4c905c7e811180e818f7236111629e0c1eb69',
  packagePolicyHash: 'sha256:6fb47a6a1fd59d3aa260e0d63c8ae9376465a00fcf04b11062bec40d9086b095',
  checkpointId: 'c81a1a9c-e621-4bff-9be3-84596727f31b',
  checkpointGeneration: 196024,
  checkpointHash: '610da12ffe27f1a4fb2c95da318715255cd0ae8693fecff4999552aebfbbd491',
  checkpointBytes: 3893,
  inputCursor: 4179959,
  failureRecordId: 164,
  failureSequence: 4179960,
  acceptedFrame: 98001,
  pendingFrame: 98002,
  capacityMetadataKey: 'life:p1-r0-metab-capacity-source',
  capacityMetadataSha256: 'ec7fb9ad06ef4dd35cba8a415d75f0f38ddd8bfa02cbf9975aeb2c319998b58c'
});

const REPAIR = Object.freeze({
  repairId: 'metab-q48-saturating-lifetime-r146-v1',
  moduleHash: 'sha256:316ccafbada62b8eb9261d2574833ec0f36eb8232041e9c35320d8cbb419f88d',
  manifestHash: BASELINE.manifestHash,
  packagePolicyHash: 'sha256:7aa327005436f91310176753baf94d783661bb5c156be2d8ace0190456fd55c9',
  checkpointGeneration: 196025,
  checkpointId: 'metab-q48-r146-partial-frame-repair-196025'
});

function fail(message, code = 'R146_METAB_Q48_REPAIR') {
  throw Object.assign(new Error(message), { code });
}
function assert(condition, message, code) { if (!condition) fail(message, code); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function metadataRevision(db) {
  const row = db.prepare("SELECT json,sha256 FROM metadata WHERE key='life:runtime-revision'").get();
  assert(row && sha256(row.json) === row.sha256, 'runtime revision metadata is corrupt');
  return Number(JSON.parse(row.json).revision);
}
function scalar(db, sql, ...args) { return Number(db.prepare(sql).get(...args)?.value || 0); }
function readBlob(databasePath, checkpoint) {
  const file = path.join(path.dirname(databasePath), 'blobs', 'sha256',
    checkpoint.blob_hash.slice(0, 2), checkpoint.blob_hash);
  const bytes = fs.readFileSync(file);
  assert(bytes.length === Number(checkpoint.byte_length) && sha256(bytes) === checkpoint.blob_hash,
    'METAB checkpoint blob integrity failed', 'R146_METAB_Q48_CHECKPOINT');
  return bytes;
}
function validateRelease(releaseRoot) {
  const entry = path.resolve(releaseRoot, BASELINE.moduleRelativePath);
  const policy = enforcePackagePolicy(entry);
  const definition = require(entry);
  const durable = validateManifest(definition.manifest);
  verifyManifestAgainstPackagePolicy(policy, definition.manifest);
  assert(`sha256:${sha256(fs.readFileSync(entry))}` === REPAIR.moduleHash &&
    `sha256:${sha256(stableStringify(durable))}` === REPAIR.manifestHash &&
    policy.policy.policyHash === REPAIR.packagePolicyHash &&
    definition.manifest.version === BASELINE.version &&
    definition.manifest.stateSchema === BASELINE.stateSchema &&
    definition.manifest.productionEligible === false &&
    definition.manifest.outputs.length === 0,
  'repaired METAB package identity or containment changed', 'R146_METAB_Q48_RELEASE');
  return definition;
}
function snapshot(db) {
  return {
    resident: db.prepare('SELECT * FROM resident_instances WHERE residency_id=?')
      .get(BASELINE.residencyId),
    checkpoint: db.prepare('SELECT * FROM resident_checkpoints WHERE residency_id=? AND generation=?')
      .get(BASELINE.residencyId, BASELINE.checkpointGeneration),
    repairCheckpoint: db.prepare('SELECT * FROM resident_checkpoints WHERE residency_id=? AND generation=?')
      .get(BASELINE.residencyId, REPAIR.checkpointGeneration),
    consumer: db.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?')
      .get(BASELINE.residencyId),
    capacity: db.prepare('SELECT * FROM metadata WHERE key=?').get(BASELINE.capacityMetadataKey),
    failure: db.prepare("SELECT id,detail_json FROM recovery_records WHERE type='resident.resync-required' AND core_id=? ORDER BY id DESC LIMIT 1")
      .get(BASELINE.coreId)
  };
}
function assertBaseline(db, { repaired = false } = {}) {
  assert(db.prepare('PRAGMA quick_check').get()?.quick_check === 'ok' &&
    metadataRevision(db) === BASELINE.runtimeRevision,
  'database is not the exact healthy R146 storage boundary');
  const value = snapshot(db), resident = value.resident, checkpoint = value.checkpoint,
    consumer = value.consumer, capacity = value.capacity;
  const expectedModule = repaired ? REPAIR.moduleHash : BASELINE.moduleHash;
  const expectedPolicy = repaired ? REPAIR.packagePolicyHash : BASELINE.packagePolicyHash;
  const expectedGeneration = repaired ? REPAIR.checkpointGeneration : BASELINE.checkpointGeneration;
  const expectedCheckpoint = repaired ? value.repairCheckpoint : checkpoint;
  assert(resident?.instance_id === BASELINE.instanceId && resident?.core_id === BASELINE.coreId &&
    resident?.version === BASELINE.version && Number(resident?.state_schema) === BASELINE.stateSchema &&
    resident?.module_relative_path === BASELINE.moduleRelativePath && resident?.module_hash === expectedModule &&
    resident?.manifest_hash === BASELINE.manifestHash && resident?.package_policy_hash === expectedPolicy &&
    resident?.status === 'RESYNC_REQUIRED' && Number(resident?.checkpoint_generation) === expectedGeneration &&
    resident?.checkpoint_hash === expectedCheckpoint?.blob_hash,
  'METAB resident is not the exact R146 repair cohort', 'R146_METAB_Q48_RESIDENT');
  assert(checkpoint?.checkpoint_id === BASELINE.checkpointId &&
    checkpoint?.blob_hash === BASELINE.checkpointHash && Number(checkpoint?.byte_length) === BASELINE.checkpointBytes &&
    Number(checkpoint?.input_cursor) === BASELINE.inputCursor,
  'METAB source checkpoint changed', 'R146_METAB_Q48_CHECKPOINT');
  if (repaired) {
    assert(expectedCheckpoint?.checkpoint_id === REPAIR.checkpointId &&
      expectedCheckpoint?.instance_id === BASELINE.instanceId &&
      expectedCheckpoint?.version === BASELINE.version &&
      Number(expectedCheckpoint?.state_schema) === BASELINE.stateSchema &&
      Number(expectedCheckpoint?.generation) === REPAIR.checkpointGeneration &&
      Number(expectedCheckpoint?.input_cursor) === BASELINE.inputCursor &&
      Number(expectedCheckpoint?.byte_length) > 0,
    'METAB repaired checkpoint tuple changed', 'R146_METAB_Q48_CHECKPOINT');
  }
  assert(consumer?.core_id === BASELINE.coreId && Number(consumer?.required) === 0 &&
    Number(consumer?.active) === 0 && Number(consumer?.cursor) === BASELINE.inputCursor &&
    Number(consumer?.authority_epoch) === 0 && consumer?.checkpoint_hash === expectedCheckpoint?.blob_hash,
  'METAB consumer is not contained', 'R146_METAB_Q48_CONSUMER');
  assert(scalar(db, "SELECT COUNT(*) value FROM biological_deliveries WHERE consumer_id=? AND status='PENDING'",
    BASELINE.residencyId) === 0 && scalar(db,
      "SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id=? AND status='PENDING'",
      BASELINE.coreId) === 0 && scalar(db, 'SELECT COUNT(*) value FROM authority WHERE core_id=?',
      BASELINE.coreId) === 0,
  'METAB repair cohort has debt or authority', 'R146_METAB_Q48_CONTAINMENT');
  let detail = null; try { detail = JSON.parse(value.failure?.detail_json || 'null'); } catch {}
  assert(Number(value.failure?.id) === BASELINE.failureRecordId &&
    detail?.sequence === BASELINE.failureSequence && detail?.topic === 'resource.capacity.quality.v1' &&
    detail?.code === 'P1_Q48_OVERFLOW',
  'METAB terminal failure is not the diagnosed overflow', 'R146_METAB_Q48_FAILURE');
  const source = JSON.parse(capacity?.json || 'null');
  assert(capacity && sha256(capacity.json) === capacity.sha256 &&
    source?.lastCommittedFrame === BASELINE.acceptedFrame &&
    (repaired ? source.pending === null : source?.pending?.sampleFrame === BASELINE.pendingFrame),
  'METAB capacity source is not the exact partial-frame cohort', 'R146_METAB_Q48_SOURCE');
  return { ...value, source };
}
function repairIncompleteCheckpointState(state, definition, baseline = BASELINE) {
  definition.validateState(state);
  assert(state.lastAcceptedFrame === baseline.acceptedFrame &&
    state.pendingEligible?.sampleFrame === baseline.pendingFrame &&
    state.pendingQuality === null &&
    state.engineState?.frameIndex === baseline.acceptedFrame,
  'METAB checkpoint is not the exact incomplete pair', 'R146_METAB_Q48_CHECKPOINT');
  const repairedState = { ...state, pendingEligible: null, pendingQuality: null };
  definition.validateState(repairedState);
  return repairedState;
}
function prepareRepair(databasePath, releaseRoot) {
  const definition = validateRelease(releaseRoot);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  db.exec('PRAGMA query_only=ON');
  try {
    const value = assertBaseline(db);
    assert(value.capacity.sha256 === BASELINE.capacityMetadataSha256,
      'METAB capacity source identity changed', 'R146_METAB_Q48_SOURCE');
    const state = JSON.parse(readBlob(databasePath, value.checkpoint));
    const repairedState = repairIncompleteCheckpointState(state, definition);
    return { value, repairedState, repairedSource: { ...value.source, pending: null } };
  } finally { db.close(); }
}
function ensureBlob(databasePath, state) {
  const bytes = Buffer.from(JSON.stringify(state)), hash = sha256(bytes);
  const directory = path.join(path.dirname(databasePath), 'blobs', 'sha256', hash.slice(0, 2));
  const target = path.join(directory, hash);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(target)) {
    const temporary = path.join(directory, `.${hash}.${process.pid}.tmp`);
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, target);
  }
  assert(sha256(fs.readFileSync(target)) === hash, 'repaired checkpoint blob verification failed');
  return { hash, bytes: bytes.length };
}
function preflightRepair({ databasePath, releaseRoot }) {
  validateRelease(releaseRoot);
  const probe = new DatabaseSync(databasePath, { readOnly: true });
  probe.exec('PRAGMA query_only=ON');
  try {
    const resident = probe.prepare('SELECT module_hash FROM resident_instances WHERE residency_id=?')
      .get(BASELINE.residencyId);
    if (resident?.module_hash === REPAIR.moduleHash) {
      const current = assertBaseline(probe, { repaired: true });
      const state = JSON.parse(readBlob(databasePath, current.repairCheckpoint));
      validateRelease(releaseRoot).validateState(state);
      return Object.freeze({ result: 'ALREADY_APPLIED', repairId: REPAIR.repairId,
        repairedCheckpointHash: current.repairCheckpoint.blob_hash,
        acceptedFrame: BASELINE.acceptedFrame, abandonedCount: 0,
        biologicalAcceptedStateChanged: false, inventedBiologicalTime: false,
        authorityOwned: false });
    }
  } finally { probe.close(); }
  const { repairedState } = prepareRepair(databasePath, releaseRoot);
  return Object.freeze({ result: 'PASS', repairId: REPAIR.repairId,
    repairedCheckpointHash: sha256(Buffer.from(JSON.stringify(repairedState))),
    acceptedFrame: BASELINE.acceptedFrame, abandonedCount: 0,
    biologicalAcceptedStateChanged: false, inventedBiologicalTime: false, authorityOwned: false });
}
function applyRepair({ databasePath, releaseRoot, now = () => new Date().toISOString() }) {
  validateRelease(releaseRoot);
  const probe = new DatabaseSync(databasePath, { readOnly: true });
  probe.exec('PRAGMA query_only=ON');
  try {
    const resident = probe.prepare('SELECT module_hash FROM resident_instances WHERE residency_id=?')
      .get(BASELINE.residencyId);
    if (resident?.module_hash === REPAIR.moduleHash) {
      const current = assertBaseline(probe, { repaired: true });
      return Object.freeze({ result: 'ALREADY_APPLIED', repairId: REPAIR.repairId,
        repairedCheckpointHash: current.repairCheckpoint.blob_hash,
        abandonedCount: 0, inventedBiologicalTime: false });
    }
  } finally { probe.close(); }
  const prepared = prepareRepair(databasePath, releaseRoot);
  const blob = ensureBlob(databasePath, prepared.repairedState);
  const sourceJson = JSON.stringify(prepared.repairedSource), sourceHash = sha256(sourceJson);
  const mirrorJson = `${JSON.stringify(prepared.repairedSource, null, 2)}\n`, at = now();
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  try {
    assertBaseline(db);
    db.prepare(`INSERT INTO resident_checkpoints(checkpoint_id,residency_id,instance_id,version,state_schema,
      generation,blob_hash,byte_length,input_cursor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      REPAIR.checkpointId, BASELINE.residencyId, BASELINE.instanceId, BASELINE.version,
      BASELINE.stateSchema, REPAIR.checkpointGeneration, blob.hash, blob.bytes, BASELINE.inputCursor, at);
    const updated = db.prepare(`UPDATE resident_instances SET module_hash=?,package_policy_hash=?,
      checkpoint_generation=?,checkpoint_hash=?,updated_at=? WHERE residency_id=? AND instance_id=? AND
      module_hash=? AND package_policy_hash=? AND checkpoint_generation=? AND checkpoint_hash=? AND status='RESYNC_REQUIRED'`)
      .run(REPAIR.moduleHash, REPAIR.packagePolicyHash, REPAIR.checkpointGeneration, blob.hash, at,
        BASELINE.residencyId, BASELINE.instanceId, BASELINE.moduleHash, BASELINE.packagePolicyHash,
        BASELINE.checkpointGeneration, BASELINE.checkpointHash);
    assert(updated.changes === 1, 'METAB implementation repair lost its resident fence');
    assert(db.prepare(`UPDATE biological_consumers SET checkpoint_hash=?,updated_at=? WHERE consumer_id=? AND
      active=0 AND required=0 AND cursor=? AND authority_epoch=0 AND checkpoint_hash=?`).run(
      blob.hash, at, BASELINE.residencyId, BASELINE.inputCursor, BASELINE.checkpointHash).changes === 1,
    'METAB implementation repair lost its consumer fence');
    assert(db.prepare('UPDATE metadata SET json=?,sha256=?,updated_at=? WHERE key=? AND sha256=?').run(
      sourceJson, sourceHash, at, BASELINE.capacityMetadataKey, BASELINE.capacityMetadataSha256).changes === 1,
    'METAB capacity source compare-and-swap failed');
    db.prepare(`INSERT INTO pending_metadata_mirrors(key,relative_path,json,sha256,created_at)
      VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET relative_path=excluded.relative_path,json=excluded.json,
      sha256=excluded.sha256,created_at=excluded.created_at`).run(BASELINE.capacityMetadataKey,
      'life/p1-r0-metab-capacity-source.json', mirrorJson, sha256(mirrorJson), at);
    db.prepare(`INSERT INTO recovery_records(type,core_id,detail_json,created_at) VALUES(?,?,?,?)`).run(
      'resident.implementation-repaired', BASELINE.coreId, stableStringify({
        repairId: REPAIR.repairId, residencyId: BASELINE.residencyId, instanceId: BASELINE.instanceId,
        fromModuleHash: BASELINE.moduleHash, toModuleHash: REPAIR.moduleHash,
        fromPackagePolicyHash: BASELINE.packagePolicyHash, toPackagePolicyHash: REPAIR.packagePolicyHash,
        sourceCheckpointHash: BASELINE.checkpointHash, repairedCheckpointHash: blob.hash,
        fromCheckpointGeneration: BASELINE.checkpointGeneration,
        toCheckpointGeneration: REPAIR.checkpointGeneration, acceptedFrame: BASELINE.acceptedFrame,
        discardedPartialFrame: BASELINE.pendingFrame, discardedPartialInputs: 1,
        capacitySourceBeforeJson: prepared.value.capacity.json,
        capacitySourceBeforeSha256: prepared.value.capacity.sha256,
        biologicalAcceptedStateChanged: false, checkpointBytesChanged: true,
        abandonedCount: 0, inventedBiologicalTime: false, authorityChanged: false,
        resourceLimitsChanged: false, runtimeRevision: BASELINE.runtimeRevision
      }), at);
    assertBaseline(db, { repaired: true });
    db.exec('COMMIT');
    return Object.freeze({ result: 'APPLIED', repairId: REPAIR.repairId,
      repairedCheckpointHash: blob.hash, abandonedCount: 0, inventedBiologicalTime: false });
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}
function rollbackRepair({ databasePath, releaseRoot, now = () => new Date().toISOString() }) {
  validateRelease(releaseRoot);
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  try {
    const current = assertBaseline(db, { repaired: true });
    assert(scalar(db, 'SELECT COUNT(*) value FROM resident_checkpoints WHERE residency_id=? AND generation>?',
      BASELINE.residencyId, REPAIR.checkpointGeneration) === 0, 'METAB advanced beyond rollback fence');
    const repairRow = db.prepare("SELECT detail_json FROM recovery_records WHERE type='resident.implementation-repaired' AND core_id=? ORDER BY id DESC LIMIT 1")
      .get(BASELINE.coreId);
    let repairDetail = null; try { repairDetail = JSON.parse(repairRow?.detail_json || 'null'); } catch {}
    assert(repairDetail?.repairId === REPAIR.repairId &&
      repairDetail.capacitySourceBeforeSha256 === BASELINE.capacityMetadataSha256 &&
      sha256(repairDetail.capacitySourceBeforeJson || '') === BASELINE.capacityMetadataSha256,
    'METAB rollback source evidence is incomplete');
    const at = now();
    assert(db.prepare(`UPDATE resident_instances SET module_hash=?,package_policy_hash=?,checkpoint_generation=?,
      checkpoint_hash=?,updated_at=? WHERE residency_id=? AND module_hash=? AND package_policy_hash=? AND
      checkpoint_generation=? AND checkpoint_hash=? AND status='RESYNC_REQUIRED'`).run(BASELINE.moduleHash,
      BASELINE.packagePolicyHash, BASELINE.checkpointGeneration, BASELINE.checkpointHash, at,
      BASELINE.residencyId, REPAIR.moduleHash, REPAIR.packagePolicyHash, REPAIR.checkpointGeneration,
      current.repairCheckpoint.blob_hash).changes === 1, 'METAB rollback lost its resident fence');
    assert(db.prepare(`UPDATE biological_consumers SET checkpoint_hash=?,updated_at=? WHERE consumer_id=? AND
      active=0 AND required=0 AND cursor=? AND authority_epoch=0 AND checkpoint_hash=?`).run(
      BASELINE.checkpointHash, at, BASELINE.residencyId, BASELINE.inputCursor,
      current.repairCheckpoint.blob_hash).changes === 1,
    'METAB rollback lost its consumer fence');
    assert(db.prepare('UPDATE metadata SET json=?,sha256=?,updated_at=? WHERE key=? AND sha256=?').run(
      repairDetail.capacitySourceBeforeJson, BASELINE.capacityMetadataSha256, at,
      BASELINE.capacityMetadataKey, current.capacity.sha256).changes === 1,
    'METAB rollback lost its capacity-source fence');
    const sourceBefore = JSON.parse(repairDetail.capacitySourceBeforeJson);
    const mirrorJson = `${JSON.stringify(sourceBefore, null, 2)}\n`;
    db.prepare(`INSERT INTO pending_metadata_mirrors(key,relative_path,json,sha256,created_at)
      VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET relative_path=excluded.relative_path,json=excluded.json,
      sha256=excluded.sha256,created_at=excluded.created_at`).run(BASELINE.capacityMetadataKey,
      'life/p1-r0-metab-capacity-source.json', mirrorJson, sha256(mirrorJson), at);
    db.prepare('DELETE FROM resident_checkpoints WHERE residency_id=? AND generation=?')
      .run(BASELINE.residencyId, REPAIR.checkpointGeneration);
    db.prepare(`INSERT INTO recovery_records(type,core_id,detail_json,created_at) VALUES(?,?,?,?)`).run(
      'resident.implementation-repair-rolled-back', BASELINE.coreId,
      stableStringify({ repairId: REPAIR.repairId, biologicalAcceptedStateChanged: false,
        abandonedCount: 0, inventedBiologicalTime: false, authorityChanged: false }), at);
    assertBaseline(db);
    db.exec('COMMIT');
    return Object.freeze({ result: 'ROLLED_BACK', repairId: REPAIR.repairId });
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}
function parse(argv) {
  const [mode, databasePath, releaseRoot] = argv.slice(2);
  assert(['preflight', 'apply', 'rollback'].includes(mode) && databasePath && releaseRoot,
    'usage: p1-r146-metab-q48-implementation-repair.js preflight|apply|rollback DATABASE RELEASE_ROOT');
  return { mode, databasePath: path.resolve(databasePath), releaseRoot: path.resolve(releaseRoot) };
}
if (require.main === module) {
  try {
    const { mode, ...options } = parse(process.argv);
    const result = mode === 'preflight' ? preflightRepair(options) :
      mode === 'apply' ? applyRepair(options) : rollbackRepair(options);
    process.stdout.write(`${stableStringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`R146_METAB_Q48_REPAIR_ABORT=${error.code || 'ERROR'}:${error.message}\n`);
    process.exitCode = 1;
  }
}
module.exports = Object.freeze({ BASELINE, REPAIR, applyRepair, preflightRepair, rollbackRepair,
  repairIncompleteCheckpointState, validateRelease });
