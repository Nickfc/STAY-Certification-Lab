#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { stableStringify } = require('../../runtime/kernel/canonical-json');
const { sealRevisionFreeze, validateRevisionFreeze } = require('../../runtime/revision-freeze');

const EXPECTED = Object.freeze({
  release: '/opt/stay/releases/0.8.11.3-p1m-r119f-chrono-repair-2961f9a48173',
  runtimeRevision: 120,
  residencyId: 'resident:chronobiology',
  coreId: 'chronobiology',
  instanceId: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
  oldVersion: '1.0.0-c3rc.1',
  version: '1.0.0-c3rc.5',
  moduleRelativePath: 'cores/chronobiology/c3r5/index.js',
  moduleHash: 'sha256:ecac9b25bf5897d6344cbca702a6ce30ab76c5ff69af76ad17f1aea734e54867',
  manifestHash: 'sha256:4f809b9fee2b4099d51250d339fbee15d226ed9aa0126c4a83d47ff580021012',
  packagePolicyHash: 'sha256:887ff83909b360a75abc1ea6f755db597e613186acaa9b7b20d33b1d21d2232b',
  checkpointGeneration: 5120,
  checkpointId: '54c72496-87bc-4b1c-9d7b-3312d7542ce2',
  checkpointHash: '81bb366d99550dffc2e78c16c869bb7da20c70473636c3ee1e95b9d8bf8382ae',
  checkpointBytes: 49287,
  checkpointInputCursor: 1636338,
  consumerCursor: 2466905,
  pendingSequence: 2466906,
  authorityEpoch: 1,
  producerStreamId: 'core:chronobiology:outputs',
  lastStreamSequence: 341,
  lastProducerEventId: 'e3530fc93102bb7bda7b36b518b5d87de2e76f59a5d16c7b199b8db47f3f723b',
  oldHeadHash: '46086b279848aaaa7c3b5dd8fb3d0ef549fb3ea7764b1a33c6b87142661804e5',
  failureRecoveryId: 102,
  sntssInstanceId: '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
  sntssVersion: '0.5.0-i4g1',
});

function fail(message, code = 'R120F_RECOVERY') {
  throw Object.assign(new Error(message), { code });
}
function assert(value, message, code) { if (!value) fail(message, code); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function scalar(database, sql, ...args) {
  return Number(database.prepare(sql).get(...args)?.value || 0);
}
function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`${label} is invalid: ${error.message}`, 'R120F_RECOVERY_INPUT'); }
}
function headBody(version) {
  return {
    producerCoreId: EXPECTED.coreId,
    authorityEpoch: EXPECTED.authorityEpoch,
    producerStreamId: EXPECTED.producerStreamId,
    producerInstanceId: EXPECTED.instanceId,
    producerVersion: version,
    lastStreamSequence: EXPECTED.lastStreamSequence,
    lastProducerEventId: EXPECTED.lastProducerEventId,
  };
}
function newHeadHash() { return sha256(stableStringify(headBody(EXPECTED.version))); }

function revision(database) {
  const row = database.prepare("SELECT json, sha256 FROM metadata WHERE key='life:runtime-revision'").get();
  assert(row && sha256(row.json) === row.sha256, 'runtime revision metadata is corrupt',
    'R120F_RECOVERY_REVISION');
  const value = JSON.parse(row.json);
  assert(value.revision === EXPECTED.runtimeRevision && value.reason === 'core.install',
    'runtime is not the exact irreversible R120 boundary', 'R120F_RECOVERY_REVISION');
  return value;
}

function snapshot(database) {
  return {
    resident: database.prepare('SELECT * FROM resident_instances WHERE residency_id=?')
      .get(EXPECTED.residencyId),
    consumer: database.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?')
      .get(EXPECTED.residencyId),
    checkpoint: database.prepare('SELECT * FROM resident_checkpoints WHERE residency_id=? AND generation=?')
      .get(EXPECTED.residencyId, EXPECTED.checkpointGeneration),
    pending: database.prepare("SELECT * FROM biological_deliveries WHERE consumer_id=? AND status='PENDING'")
      .all(EXPECTED.residencyId),
    head: database.prepare(`SELECT * FROM biological_outbox_stream_heads
      WHERE producer_core_id=? AND authority_epoch=? AND producer_stream_id=?`).get(
      EXPECTED.coreId, EXPECTED.authorityEpoch, EXPECTED.producerStreamId),
    failure: database.prepare('SELECT * FROM recovery_records WHERE id=?').get(EXPECTED.failureRecoveryId),
  };
}

function assertPreflight(database, expectedHeadVersion = EXPECTED.oldVersion) {
  assert(database.prepare('PRAGMA quick_check').get()?.quick_check === 'ok',
    'SQLite quick-check failed', 'R120F_RECOVERY_DATABASE');
  revision(database);
  const value = snapshot(database);
  const resident = value.resident;
  assert(resident?.core_id === EXPECTED.coreId
    && resident.instance_id === EXPECTED.instanceId
    && resident.version === EXPECTED.version
    && Number(resident.state_schema) === 2
    && resident.module_relative_path === EXPECTED.moduleRelativePath
    && resident.module_hash === EXPECTED.moduleHash
    && resident.manifest_hash === EXPECTED.manifestHash
    && resident.package_policy_hash === EXPECTED.packagePolicyHash
    && Number(resident.checkpoint_generation) === EXPECTED.checkpointGeneration
    && resident.checkpoint_hash === EXPECTED.checkpointHash
    && resident.status === 'RESYNC_REQUIRED',
  'Chronobiology is not at the exact failed c3rc.5 fence', 'R120F_RECOVERY_RESIDENT');
  const checkpoint = value.checkpoint;
  assert(checkpoint?.checkpoint_id === EXPECTED.checkpointId
    && checkpoint.instance_id === EXPECTED.instanceId
    && checkpoint.version === EXPECTED.version
    && Number(checkpoint.state_schema) === 2
    && checkpoint.blob_hash === EXPECTED.checkpointHash
    && Number(checkpoint.byte_length) === EXPECTED.checkpointBytes
    && Number(checkpoint.input_cursor) === EXPECTED.checkpointInputCursor,
  'Chronobiology checkpoint fence changed', 'R120F_RECOVERY_CHECKPOINT');
  const consumer = value.consumer;
  assert(consumer?.core_id === EXPECTED.coreId
    && Number(consumer.required) === 0
    && Number(consumer.active) === 0
    && Number(consumer.cursor) === EXPECTED.consumerCursor
    && Number(consumer.authority_epoch) === 0
    && consumer.checkpoint_hash === EXPECTED.checkpointHash,
  'Chronobiology consumer fence changed', 'R120F_RECOVERY_CONSUMER');
  assert(value.pending.length === 1
    && Number(value.pending[0].sequence) === EXPECTED.pendingSequence
    && value.pending[0].transition_id == null
    && value.pending[0].checkpoint_hash == null,
  'Chronobiology pending delivery is not the exact failed pulse', 'R120F_RECOVERY_PENDING');
  const head = value.head;
  const expectedHash = expectedHeadVersion === EXPECTED.oldVersion
    ? EXPECTED.oldHeadHash : newHeadHash();
  assert(head?.producer_instance_id === EXPECTED.instanceId
    && head.producer_version === expectedHeadVersion
    && Number(head.last_stream_sequence) === EXPECTED.lastStreamSequence
    && head.last_producer_event_id === EXPECTED.lastProducerEventId
    && head.head_sha256 === expectedHash
    && sha256(stableStringify(headBody(expectedHeadVersion))) === expectedHash,
  'Chronobiology outbox head is not the exact fenced identity', 'R120F_RECOVERY_OUTBOX_HEAD');
  assert(scalar(database, "SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id=?",
    EXPECTED.coreId) === EXPECTED.lastStreamSequence
    && scalar(database, "SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id=? AND status='PUBLISHED'",
      EXPECTED.coreId) === EXPECTED.lastStreamSequence
    && scalar(database, "SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id=? AND status='PENDING'",
      EXPECTED.coreId) === 0,
  'Chronobiology outbox history is not fully published', 'R120F_RECOVERY_OUTBOX_DEBT');
  assert(scalar(database, 'SELECT COUNT(*) value FROM authority WHERE core_id=?', EXPECTED.coreId) === 0
    && scalar(database, "SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id='sntss'") === 0
    && scalar(database, "SELECT COUNT(*) value FROM authority WHERE core_id='sntss'") === 0,
  'authority or SNTSS zero-output containment changed', 'R120F_RECOVERY_AUTHORITY');
  let detail = null;
  try { detail = JSON.parse(value.failure?.detail_json || 'null'); } catch {}
  assert(value.failure?.type === 'resident.resync-required'
    && value.failure.core_id === EXPECTED.coreId
    && Number(detail?.sequence) === EXPECTED.pendingSequence
    && detail?.code === 'RESIDENT_COMMIT_FAILED'
    && /outbox producer identity changed/.test(String(detail?.message || '')),
  'diagnosed failure evidence changed', 'R120F_RECOVERY_FAILURE');
  return value;
}

function preflight(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec('PRAGMA query_only=ON');
  try {
    assertPreflight(database);
    return { result: 'PASS', runtimeRevision: 120, pendingSequence: EXPECTED.pendingSequence,
      oldHeadSha256: EXPECTED.oldHeadHash, newHeadSha256: newHeadHash(), authorityChanged: false,
      biologicalStateChanged: false, abandonedCount: 0, inventedBiologicalTime: false };
  } finally { database.close(); }
}

function apply(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  try {
    assertPreflight(database);
    const createdAt = new Date().toISOString();
    const updated = database.prepare(`UPDATE biological_outbox_stream_heads
      SET producer_version=?, head_sha256=?, updated_at=?
      WHERE producer_core_id=? AND authority_epoch=? AND producer_stream_id=?
        AND producer_instance_id=? AND producer_version=? AND last_stream_sequence=?
        AND last_producer_event_id=? AND head_sha256=?`).run(
      EXPECTED.version, newHeadHash(), createdAt, EXPECTED.coreId, EXPECTED.authorityEpoch,
      EXPECTED.producerStreamId, EXPECTED.instanceId, EXPECTED.oldVersion,
      EXPECTED.lastStreamSequence, EXPECTED.lastProducerEventId, EXPECTED.oldHeadHash);
    assert(updated.changes === 1, 'outbox head compare-and-swap lost its fence',
      'R120F_RECOVERY_COMPARE_AND_SWAP');
    database.prepare(`INSERT INTO recovery_records(type, core_id, detail_json, created_at)
      VALUES('resident.output-stream-identity-repaired', ?, ?, ?)`).run(
      EXPECTED.coreId, stableStringify({
        repairId: 'chronobiology-c3r5-output-stream-r120-fenced',
        residencyId: EXPECTED.residencyId,
        instanceId: EXPECTED.instanceId,
        producerStreamId: EXPECTED.producerStreamId,
        authorityEpoch: EXPECTED.authorityEpoch,
        fromVersion: EXPECTED.oldVersion,
        toVersion: EXPECTED.version,
        lastStreamSequence: EXPECTED.lastStreamSequence,
        lastProducerEventId: EXPECTED.lastProducerEventId,
        fromHeadSha256: EXPECTED.oldHeadHash,
        toHeadSha256: newHeadHash(),
        pendingOutputCount: 0,
        authorityChanged: false,
        biologicalStateChanged: false,
        abandonedCount: 0,
        inventedBiologicalTime: false,
        runtimeRevision: 120,
      }), createdAt);
    assertPreflight(database, EXPECTED.version);
    database.exec('COMMIT');
    return { result: 'APPLIED', runtimeRevision: 120, oldHeadSha256: EXPECTED.oldHeadHash,
      newHeadSha256: newHeadHash(), authorityChanged: false, biologicalStateChanged: false,
      abandonedCount: 0, inventedBiologicalTime: false };
  } catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; }
  finally { database.close(); }
}

function rollback(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  try {
    assertPreflight(database, EXPECTED.version);
    const createdAt = new Date().toISOString();
    const updated = database.prepare(`UPDATE biological_outbox_stream_heads
      SET producer_version=?, head_sha256=?, updated_at=?
      WHERE producer_core_id=? AND authority_epoch=? AND producer_stream_id=?
        AND producer_instance_id=? AND producer_version=? AND last_stream_sequence=?
        AND last_producer_event_id=? AND head_sha256=?`).run(
      EXPECTED.oldVersion, EXPECTED.oldHeadHash, createdAt, EXPECTED.coreId, EXPECTED.authorityEpoch,
      EXPECTED.producerStreamId, EXPECTED.instanceId, EXPECTED.version,
      EXPECTED.lastStreamSequence, EXPECTED.lastProducerEventId, newHeadHash());
    assert(updated.changes === 1, 'outbox head rollback lost its fence', 'R120F_RECOVERY_ROLLBACK');
    database.prepare(`INSERT INTO recovery_records(type, core_id, detail_json, created_at)
      VALUES('resident.output-stream-identity-repair-rolled-back', ?, ?, ?)`).run(
      EXPECTED.coreId, stableStringify({ repairId: 'chronobiology-c3r5-output-stream-r120-fenced',
        authorityChanged: false, biologicalStateChanged: false, abandonedCount: 0,
        inventedBiologicalTime: false, runtimeRevision: 120 }), createdAt);
    assertPreflight(database);
    database.exec('COMMIT');
    return { result: 'ROLLED_BACK', runtimeRevision: 120 };
  } catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; }
  finally { database.close(); }
}

function liveProof(databasePath, sntssFile, chronobiologyFile, metaFile) {
  const sntss = readJson(sntssFile, 'SNTSS status').resident;
  const chrono = readJson(chronobiologyFile, 'Chronobiology status').resident;
  const meta = readJson(metaFile, 'public metadata');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec('PRAGMA query_only=ON');
  try {
    revision(database);
    const resident = database.prepare('SELECT * FROM resident_instances WHERE residency_id=?')
      .get(EXPECTED.residencyId);
    const consumer = database.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?')
      .get(EXPECTED.residencyId);
    const checkpoint = database.prepare('SELECT * FROM resident_checkpoints WHERE residency_id=? AND generation=?')
      .get(EXPECTED.residencyId, resident?.checkpoint_generation);
    const head = database.prepare(`SELECT * FROM biological_outbox_stream_heads
      WHERE producer_core_id=? AND authority_epoch=? AND producer_stream_id=?`).get(
      EXPECTED.coreId, EXPECTED.authorityEpoch, EXPECTED.producerStreamId);
    assert(database.prepare('PRAGMA quick_check').get()?.quick_check === 'ok'
      && resident?.instance_id === EXPECTED.instanceId && resident.version === EXPECTED.version
      && resident.status === 'RUNNING' && Number(resident.checkpoint_generation) > EXPECTED.checkpointGeneration
      && consumer?.active === 1 && Number(consumer.authority_epoch) === 0
      && checkpoint?.instance_id === EXPECTED.instanceId && checkpoint.version === EXPECTED.version
      && Number(checkpoint.input_cursor) === Number(consumer.cursor)
      && checkpoint.blob_hash === resident.checkpoint_hash
      && head?.producer_instance_id === EXPECTED.instanceId && head.producer_version === EXPECTED.version
      && Number(head.last_stream_sequence) > EXPECTED.lastStreamSequence
      && scalar(database, "SELECT COUNT(*) value FROM biological_deliveries WHERE consumer_id=? AND status='PENDING'", EXPECTED.residencyId) === 0
      && scalar(database, "SELECT COUNT(*) value FROM biological_outbox_intents WHERE status='PENDING'") === 0
      && scalar(database, "SELECT COUNT(*) value FROM authority WHERE core_id IN ('chronobiology','sntss')") === 0
      && scalar(database, "SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id='sntss'") === 0,
    'durable live recovery proof failed', 'R120F_RECOVERY_LIVE_DATABASE');
    const bsf = meta.systems?.find(value => value.id === 'bsf');
    const fetus = meta.cores?.find(value => value.id === 'fetus-legacy');
    const chip = id => meta.chipProjection?.lifecycle?.find(value => value.coreId === id);
    assert(meta.ok === true && meta.revision === 120 && meta.revisionFrozen === false
      && bsf?.mode === 'LIVE' && bsf.status === 'RUNNING' && bsf.healthOk === true
      && fetus?.memoryGuardian?.status === 'healthy'
      && sntss?.instanceId === EXPECTED.sntssInstanceId && sntss.version === EXPECTED.sntssVersion
      && sntss.running === true && sntss.authorityOwned === false && sntss.observedOutputs === 0
      && chrono?.instanceId === EXPECTED.instanceId && chrono.version === EXPECTED.version
      && chrono.running === true && chrono.authorityOwned === false && chrono.resyncRequired === false
      && chip('bsf')?.state === 'LIVE' && chip('sntss')?.state === 'SHADOW'
      && chip('chronobiology')?.state === 'SHADOW',
    'public live recovery proof failed', 'R120F_RECOVERY_LIVE_META');
    return { result: 'PASS', runtimeRevision: 120, bsf: 'LIVE', sntss: 'SHADOW',
      chronobiology: 'SHADOW', sntssOutputs: 0, authority: 'NONE',
      chronobiologyCheckpointGeneration: Number(resident.checkpoint_generation),
      chronobiologyConsumerCursor: Number(consumer.cursor), outboxStreamSequence: Number(head.last_stream_sequence),
      abandonedCount: 0, inventedBiologicalTime: false, fetus: 'healthy' };
  } finally { database.close(); }
}

function freeze(databasePath, releaseRoot, sntssFile, chronoFile, metaFile, identityFile,
  servicePid, evidenceSha256) {
  const proof = liveProof(databasePath, sntssFile, chronoFile, metaFile);
  const identity = readJson(identityFile, 'release identity');
  assert(path.resolve(releaseRoot) === EXPECTED.release && identity?.releaseTag === 'r119f-v4'
    && identity.releaseCommit === '833cf2564ed2be040c681a627de24042f9ac1538'
    && identity.releaseTree === '97a1f8dbcf596cb98f0bda9af8faacfd709cb9ef'
    && /^sha256:[0-9a-f]{64}$/.test(identity.archiveSha256)
    && /^sha256:[0-9a-f]{64}$/.test(identity.manifestSha256)
    && /^sha256:[0-9a-f]{64}$/.test(identity.controllerSha256)
    && /^sha256:[0-9a-f]{64}$/.test(evidenceSha256),
  'release or recovery identity is invalid', 'R120F_RECOVERY_FREEZE_IDENTITY');
  const record = sealRevisionFreeze({
    format: 'stay-runtime-revision-freeze-v1', result: 'PASS', acceptance: 'ACCEPTED',
    freezeType: 'R120F_FENCED_CHRONOBIOLOGY_OUTPUT_STREAM_RECOVERY',
    runtime: { revision: 120, revisionLabel: 'R120F', progression: [118, 119, 120],
      serviceMainPid: Number(servicePid), restartCommands: 1 },
    release: { path: EXPECTED.release, tag: identity.releaseTag, commit: identity.releaseCommit,
      tree: identity.releaseTree, archiveSha256: identity.archiveSha256,
      manifestSha256: identity.manifestSha256, controllerSha256: identity.controllerSha256 },
    recovery: { proofSha256: evidenceSha256, outputHeadFromVersion: EXPECTED.oldVersion,
      outputHeadToVersion: EXPECTED.version, authorityChanged: false, biologicalStateChanged: false,
      abandonedCount: 0, inventedBiologicalTime: false },
    acceptance: 'ACCEPTED', continuity: proof, capturedAt: new Date().toISOString(),
  });
  assert(validateRevisionFreeze(record, 120), 'generated R120F freeze is invalid',
    'R120F_RECOVERY_FREEZE_VERIFY');
  return record;
}

function main(argv = process.argv.slice(2)) {
  const [mode, databasePath, releaseRoot, ...rest] = argv;
  assert(['preflight', 'apply', 'rollback', 'live-proof', 'freeze'].includes(mode)
    && databasePath && releaseRoot && path.resolve(releaseRoot) === EXPECTED.release,
  'recovery arguments are invalid', 'R120F_RECOVERY_ARGUMENTS');
  let result;
  if (mode === 'preflight') result = preflight(databasePath);
  else if (mode === 'apply') result = apply(databasePath);
  else if (mode === 'rollback') result = rollback(databasePath);
  else if (mode === 'live-proof') result = liveProof(databasePath, ...rest);
  else result = freeze(databasePath, releaseRoot, ...rest);
  process.stdout.write(`${stableStringify(result)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`R120F_RECOVERY_ABORT=${error.code || 'FAILED'}:${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { EXPECTED, apply, freeze, liveProof, preflight, rollback };
