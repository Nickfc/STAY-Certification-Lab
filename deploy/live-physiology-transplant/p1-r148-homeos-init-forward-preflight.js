#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { R148_HOMEOS_INIT_FORWARD_RECOVERY: EXPECTED } =
  require('../../runtime/kernel/living-kernel');

function fail(message) {
  throw Object.assign(new Error(message), { code: 'P1_R148_INIT_FORWARD_PREFLIGHT' });
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function assert(value, message) { if (!value) fail(message); }
function checkpointBlobIsExact(databasePath, checkpoint) {
  const file = path.join(path.dirname(databasePath), 'blobs', 'sha256',
    checkpoint.blob_hash.slice(0, 2), checkpoint.blob_hash);
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'checkpoint blob type changed');
  const bytes = fs.readFileSync(file);
  return bytes.length === Number(checkpoint.byte_length) && sha256(bytes) === checkpoint.blob_hash;
}
function exactMetadata(database, key, expectedHash) {
  const row = database.prepare('SELECT json,sha256 FROM metadata WHERE key=?').get(key);
  assert(row?.sha256 === expectedHash && sha256(row?.json || '') === expectedHash,
    `${key} metadata changed`);
  return JSON.parse(row.json);
}

function validate(databasePath) {
  const stat = fs.lstatSync(databasePath);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'database trust fence failed');
  const database = new DatabaseSync(databasePath, { open: true, readOnly: true });
  try {
    database.exec('PRAGMA query_only=ON; BEGIN');
    assert(String(database.prepare('PRAGMA quick_check').get()?.quick_check || '').toLowerCase() === 'ok',
      'database quick-check failed');
    const revision = exactMetadata(database, 'life:runtime-revision',
      EXPECTED.runtimeRevisionMetadataHash);
    assert(Number(revision.revision) === EXPECTED.runtimeRevision && revision.reason === 'kernel.start',
      'runtime revision boundary changed');
    exactMetadata(database, 'life:p1-r0-metab-capacity-source',
      EXPECTED.capacitySourceMetadataHash);
    assert(Number(database.prepare('SELECT COALESCE(MAX(sequence),0) value FROM biological_events')
      .get().value) === EXPECTED.highWater, 'biological high-water changed');
    assert(Number(database.prepare('SELECT COUNT(*) count FROM resident_instances').get().count) ===
      Object.keys(EXPECTED.residents).length, 'resident cohort size changed');
    assert(!database.prepare("SELECT 1 FROM resident_instances WHERE residency_id='resident:intero'").get(),
      'INTERO exists');
    assert(Number(database.prepare("SELECT COUNT(*) count FROM authority WHERE core_id IN ('sntss','chronobiology','METAB','HOMEOS','INTERO')")
      .get().count) === 0, 'contained authority changed');

    for (const [residencyId, expected] of Object.entries(EXPECTED.residents)) {
      const resident = database.prepare(
        'SELECT * FROM resident_instances WHERE residency_id=?').get(residencyId);
      const consumer = database.prepare(
        'SELECT * FROM biological_consumers WHERE consumer_id=?').get(residencyId);
      const checkpoint = database.prepare(`SELECT * FROM resident_checkpoints
        WHERE residency_id=? AND generation=?`).get(residencyId, expected.checkpointGeneration);
      assert(resident?.core_id === expected.coreId && resident.instance_id === expected.instanceId &&
        resident.version === expected.version && Number(resident.state_schema) === expected.stateSchema &&
        resident.status === expected.status &&
        Number(resident.checkpoint_generation) === expected.checkpointGeneration &&
        resident.checkpoint_hash === expected.checkpointHash &&
        resident.module_relative_path === expected.moduleRelativePath &&
        resident.module_hash === expected.moduleHash && resident.manifest_hash === expected.manifestHash &&
        resident.package_policy_hash === expected.packagePolicyHash,
      `${residencyId} identity changed`);
      assert(consumer?.core_id === expected.coreId && Number(consumer.required) === 0 &&
        Number(consumer.active) === 1 && Number(consumer.authority_epoch) === 0 &&
        Number(consumer.cursor) === expected.consumerCursor &&
        consumer.checkpoint_hash === expected.checkpointHash &&
        consumer.topics_sha256 === expected.topicsHash, `${residencyId} consumer changed`);
      assert(checkpoint?.checkpoint_id === expected.checkpointId &&
        checkpoint.instance_id === expected.instanceId && checkpoint.version === expected.version &&
        Number(checkpoint.state_schema) === expected.stateSchema &&
        Number(checkpoint.generation) === expected.checkpointGeneration &&
        checkpoint.blob_hash === expected.checkpointHash &&
        Number(checkpoint.byte_length) === expected.checkpointBytes &&
        Number(checkpoint.input_cursor) === expected.inputCursor &&
        checkpointBlobIsExact(databasePath, checkpoint), `${residencyId} checkpoint changed`);
    }

    const fetus = EXPECTED.fetus;
    const fetusConsumer = database.prepare(
      'SELECT * FROM biological_consumers WHERE consumer_id=?').get(fetus.consumerId);
    const fetusAuthority = database.prepare(
      'SELECT * FROM authority WHERE core_id=?').get(fetus.coreId);
    const fetusCheckpoint = database.prepare(`SELECT * FROM checkpoints
      WHERE core_id=? ORDER BY generation DESC LIMIT 1`).get(fetus.coreId);
    assert(fetusConsumer?.core_id === fetus.coreId && Number(fetusConsumer.required) === 1 &&
      Number(fetusConsumer.active) === 1 && Number(fetusConsumer.cursor) === fetus.consumerCursor &&
      Number(fetusConsumer.authority_epoch) === fetus.authorityEpoch &&
      fetusConsumer.checkpoint_hash === fetus.consumerCheckpointHash &&
      fetusConsumer.topics_sha256 === fetus.topicsHash &&
      fetusAuthority?.instance_id === fetus.instanceId && fetusAuthority.version === fetus.version &&
      Number(fetusAuthority.epoch) === fetus.authorityEpoch &&
      fetusAuthority.checkpoint_hash === fetus.checkpointHash &&
      fetusCheckpoint?.instance_id === fetus.instanceId && fetusCheckpoint.version === fetus.version &&
      Number(fetusCheckpoint.authority_epoch) === fetus.authorityEpoch &&
      Number(fetusCheckpoint.generation) === fetus.checkpointGeneration &&
      fetusCheckpoint.blob_hash === fetus.checkpointHash &&
      Number(fetusCheckpoint.byte_length) === fetus.checkpointBytes &&
      checkpointBlobIsExact(databasePath, fetusCheckpoint), 'fetus continuity changed');

    const pending = database.prepare(`SELECT consumer_id,COUNT(*) count,
      MIN(sequence) minimum,MAX(sequence) maximum FROM biological_deliveries
      WHERE status='PENDING' GROUP BY consumer_id ORDER BY consumer_id`).all();
    assert(pending.length === 1 && pending[0].consumer_id === fetus.consumerId &&
      Number(pending[0].count) === EXPECTED.pendingFetusDeliveries &&
      Number(pending[0].minimum) === EXPECTED.pendingFetusFirstSequence &&
      Number(pending[0].maximum) === EXPECTED.pendingFetusLastSequence,
    'bounded fetus delivery debt changed');
    assert(Number(database.prepare(
      "SELECT COUNT(*) count FROM biological_deliveries WHERE status IN ('FAILED','ABANDONED')")
      .get().count) === 0, 'failed or abandoned delivery appeared');

    const intents = database.prepare(`SELECT * FROM biological_outbox_intents
      WHERE status='PENDING' ORDER BY stream_sequence,producer_event_id`).all();
    assert(intents.length === EXPECTED.pendingOutbox.length && intents.every((row, index) => {
      const expected = EXPECTED.pendingOutbox[index];
      return row.producer_event_id === expected.producerEventId &&
        row.intent_sha256 === expected.intentHash && sha256(row.intent_json) === row.intent_sha256 &&
        row.producer_core_id === 'METAB' && Number(row.stream_sequence) === expected.streamSequence &&
        Number(row.cause_sequence) === expected.causeSequence && row.topic === expected.topic &&
        row.checkpoint_hash === expected.checkpointHash &&
        Number(row.checkpoint_generation) === expected.checkpointGeneration;
    }), 'retained METAB intent identity changed');
    assert(Number(database.prepare(`SELECT COUNT(*) count FROM biological_outbox_intents
      WHERE status!='PUBLISHED' AND producer_core_id!='METAB'`).get().count) === 0,
    'foreign pending output appeared');
    assert(Number(database.prepare(`SELECT COUNT(*) count FROM biological_outbox_intents
      WHERE producer_core_id IN ('sntss','SNTSS','HOMEOS','INTERO')`).get().count) === 0,
    'forbidden output history appeared');

    const latest = database.prepare(
      'SELECT id,type,core_id,detail_json FROM recovery_records ORDER BY id DESC LIMIT 1').get();
    let retry = null;
    try { retry = JSON.parse(latest?.detail_json || 'null'); } catch {}
    assert(Number(latest?.id) === EXPECTED.latestRecoveryRecordId &&
      latest.type === 'resident.delivery-retry' && latest.core_id === 'sntss' &&
      retry?.residencyId === 'resident:sntss' && retry?.sequence === 4575528 &&
      retry?.attempt === 1 && retry?.code === 'CORE_WORKER_TIMEOUT' &&
      retry?.operation === 'event' && retry?.failedGeneration === 1 &&
      retry?.recoveredGeneration === 2, 'latest recovery identity changed');
    database.exec('COMMIT');
    return Object.freeze({
      format: 'stay-r148-homeos-init-forward-preflight-v1', result: 'PASS',
      runtimeRevision: EXPECTED.runtimeRevision, highWater: EXPECTED.highWater,
      pendingDeliveries: EXPECTED.pendingFetusDeliveries,
      pendingOutboxIntents: EXPECTED.pendingOutbox.length,
      failedDeliveries: 0, abandonedDeliveries: 0, authorityOwned: false,
      intero: 'ABSENT', benchmarkStarted: false
    });
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    database.close();
  }
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) fail('usage: p1-r148-homeos-init-forward-preflight.js <database>');
  process.stdout.write(`${JSON.stringify(validate(path.resolve(argv[0])))}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`${error.code || 'P1_R148_INIT_FORWARD_PREFLIGHT'}: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ EXPECTED, validate });
