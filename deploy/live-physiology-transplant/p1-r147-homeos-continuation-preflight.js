#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const EXPECTED = Object.freeze({
  runtimeRevision: 147,
  highWater: 4575520,
  latestRecoveryRecordId: 231,
  fetusResolutionRecordId: 194,
  capacitySource: Object.freeze({
    instanceId: 'd424c722-ef31-44b0-8201-ba68c418d14a',
    residentVersion: '0.3.0-p1r0-homeos-feed.1',
    runtimeRevision: 128,
    lastCommittedFrame: 162684,
    lastTrustedTimeUs: 986135434231,
    lastContinuityEpoch: 1
  }),
  fetus: Object.freeze({
    consumerId: 'core:fetus-legacy', coreId: 'fetus-legacy',
    instanceId: '82202211-8dd6-44d4-a4ec-8f2553d8dc6f', version: '0.6.0',
    authorityEpoch: 1,
    consumerCheckpointHash: '4e1e648fb80c66d6c21d5c1c550ae50f702f581ab52bbda60805ce66b33078bf',
    checkpointGeneration: 208,
    checkpointHash: '09e5c63c912792d96535f6bcfe65861b55b4eccd38f9e50085a9bb30989966ae',
    checkpointBytes: 60264,
    cursor: 4574204,
    topicsHash: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
  }),
  residents: Object.freeze({
    'resident:chronobiology': Object.freeze({
      coreId: 'chronobiology', instanceId: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
      version: '1.0.0-c3rc.5', stateSchema: 2, status: 'RUNNING',
      checkpointGeneration: 12388,
      checkpointHash: 'd6374f44ba42dfa716cea7f291422f3c4684308fc73c95db1b2723d03639e022',
      checkpointId: '4ac1dc48-0d93-4993-a88f-04ac7ef9cc47', checkpointBytes: 49187,
      inputCursor: 4575400, consumerCursor: 4575520,
      moduleRelativePath: 'cores/chronobiology/c3r5/index.js',
      topics: Object.freeze(['runtime.organism.binding', 'runtime.organism.time.pulse']),
      topicsHash: 'a0897ae1c2f0bdf9f94e5491cf681820cda4a0126afcb47511cc4a538d5a281e'
    }),
    'resident:metab': Object.freeze({
      coreId: 'METAB', instanceId: 'd424c722-ef31-44b0-8201-ba68c418d14a',
      version: '0.3.0-p1r0-homeos-feed.1', stateSchema: 3, status: 'RUNNING',
      checkpointGeneration: 325401,
      checkpointHash: 'ec9a31171e5dd07fbe09479aaad9eb5e66de929668c1241914d28a85f9bbc0fe',
      checkpointId: '3ec1e822-c6ae-48c1-8dc4-7a792d0f3d46', checkpointBytes: 5008,
      inputCursor: 4575518, consumerCursor: 4575520,
      moduleRelativePath: 'cores/p1-r0/metab-homeos/index.js',
      topics: Object.freeze(['resource.capacity.eligible.v1', 'resource.capacity.quality.v1',
        'runtime.metab.homeos-route-activation', 'runtime.metab.shadow-activation',
        'runtime.organism.binding', 'runtime.time.pulse']),
      topicsHash: '089945e41de20089fc1c06ae83c755470a49fe23e2ba8d00ac5a0ddcc64fef82'
    }),
    'resident:homeos': Object.freeze({
      coreId: 'HOMEOS', instanceId: '3f32bdc9-fa49-4eea-8c13-b9afe6b47c0f',
      version: '0.2.0-p1r0-shadow.1', stateSchema: 2, status: 'RESYNC_REQUIRED',
      checkpointGeneration: 78,
      checkpointHash: 'd4805d5951a38fc4e5502fb3b787d7dc093e3dc9bf5ca0fb6eb4bbe815563f61',
      checkpointId: 'homeos-r147-frame-boundary-repair-78', checkpointBytes: 3943,
      inputCursor: 4574287, consumerCursor: 4574290,
      moduleRelativePath: 'cores/p1-r0/homeos-shadow/index.js',
      topics: Object.freeze(['metab.energy.availability.v1', 'metab.energy.reserve.v1',
        'runtime.homeos.shadow-activation', 'runtime.organism.binding']),
      topicsHash: 'abea82189093d4bb54bee213ed9f9a7ebdd9b2b0b76f6f77dcc2762555e75231',
      eligibleReplayCount: 492, invalidPendingCount: 0,
      pendingCount: 492, firstPendingSequence: 4574291, lastPendingSequence: 4575520,
      replayBeginRecordId: 224, failureRecordId: 225, failureSequence: 4574291,
      failureCode: 'P1_RESIDENT_PENDING_BOUND'
    }),
    'resident:sntss': Object.freeze({
      coreId: 'sntss', instanceId: '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
      version: '0.5.0-i4g1', stateSchema: 5, status: 'RUNNING',
      checkpointGeneration: 2891345,
      checkpointHash: '76be4edfec7355aa2f21f1cd10f86928b54c51fe2897cc38ceefd6abde1ccd8a',
      checkpointId: 'dfaf23c7-2c2f-46d9-862c-e728fa7d27d6', checkpointBytes: 4973,
      inputCursor: 4575516, consumerCursor: 4575516,
      moduleRelativePath: 'cores/sntss/i4g/index.js',
      topics: Object.freeze(['runtime.organism.binding', 'runtime.sntss.continuity-genesis',
        'runtime.time.pulse']),
      topicsHash: 'b752d8eebb09ac925c4c193810d31f5527315e42e36fbedafa1f30ef25a97501',
      eligibleReplayCount: 0, invalidPendingCount: 0,
      pendingCount: 0
    })
  })
});

function fail(message) {
  throw Object.assign(new Error(message), { code: 'P1_R147_CONTINUATION_PREFLIGHT' });
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function assert(value, message) { if (!value) fail(message); }
function metadata(database, key) {
  const row = database.prepare('SELECT json,sha256 FROM metadata WHERE key=?').get(key);
  assert(row && sha256(row.json) === row.sha256, `${key} metadata changed`);
  try { return JSON.parse(row.json); } catch { fail(`${key} metadata is invalid`); }
}
function checkpointBlobIsExact(databasePath, checkpoint) {
  const file = path.join(path.dirname(databasePath), 'blobs', 'sha256',
    checkpoint.blob_hash.slice(0, 2), checkpoint.blob_hash);
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'checkpoint blob type changed');
  const bytes = fs.readFileSync(file);
  return bytes.length === Number(checkpoint.byte_length) && sha256(bytes) === checkpoint.blob_hash;
}

function validate(databasePath) {
  const database = new DatabaseSync(databasePath, { open: true, readOnly: true });
  try {
    database.exec('PRAGMA query_only=ON; BEGIN');
    assert(String(database.prepare('PRAGMA quick_check').get()?.quick_check || '').toLowerCase() === 'ok',
      'database quick-check failed');
    assert(Number(metadata(database, 'life:runtime-revision').revision) === EXPECTED.runtimeRevision,
      'runtime revision changed');
    assert(!database.prepare("SELECT 1 FROM resident_instances WHERE residency_id='resident:intero'").get(),
      'INTERO exists');
    assert(Number(database.prepare("SELECT COUNT(*) count FROM authority WHERE core_id IN ('sntss','chronobiology','METAB','HOMEOS','INTERO')").get().count) === 0,
      'P1 authority changed');
    assert(Number(database.prepare("SELECT COUNT(*) count FROM biological_deliveries WHERE status='PENDING'").get().count) === 492,
      'pending delivery total changed');
    assert(Number(database.prepare("SELECT COUNT(*) count FROM biological_outbox_intents WHERE status='PENDING'").get().count) === 0,
      'pending output intent changed');
    assert(Number(database.prepare("SELECT COUNT(*) count FROM biological_outbox_intents WHERE producer_core_id IN ('sntss','SNTSS','HOMEOS','INTERO')").get().count) === 0,
      'forbidden output history changed');
    assert(Number(database.prepare('SELECT COALESCE(MAX(sequence),0) value FROM biological_events').get().value) === EXPECTED.highWater,
      'biological high-water changed');

    for (const [residencyId, expected] of Object.entries(EXPECTED.residents)) {
      const resident = database.prepare('SELECT * FROM resident_instances WHERE residency_id=?').get(residencyId);
      const consumer = database.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?').get(residencyId);
      const checkpoint = database.prepare(`SELECT * FROM resident_checkpoints
        WHERE residency_id=? AND generation=?`).get(residencyId, expected.checkpointGeneration);
      assert(resident?.core_id === expected.coreId && resident.instance_id === expected.instanceId &&
        resident.version === expected.version && Number(resident.state_schema) === expected.stateSchema &&
        resident.status === expected.status &&
        Number(resident.checkpoint_generation) === expected.checkpointGeneration &&
        resident.checkpoint_hash === expected.checkpointHash &&
        resident.module_relative_path === expected.moduleRelativePath,
      `${residencyId} identity changed`);
      assert(consumer?.core_id === expected.coreId && Number(consumer.required) === 0 &&
        Number(consumer.active) === (['RUNNING', 'RECOVERING'].includes(expected.status) ? 1 : 0) &&
        Number(consumer.authority_epoch) === 0 && Number(consumer.cursor) === expected.consumerCursor &&
        consumer.checkpoint_hash === expected.checkpointHash && consumer.topics_sha256 === expected.topicsHash,
      `${residencyId} consumer changed`);
      assert(checkpoint?.checkpoint_id === expected.checkpointId &&
        checkpoint.instance_id === expected.instanceId && checkpoint.version === expected.version &&
        Number(checkpoint.state_schema) === expected.stateSchema &&
        Number(checkpoint.generation) === expected.checkpointGeneration &&
        checkpoint.blob_hash === expected.checkpointHash &&
        Number(checkpoint.byte_length) === expected.checkpointBytes &&
        Number(checkpoint.input_cursor) === expected.inputCursor &&
        checkpointBlobIsExact(databasePath, checkpoint), `${residencyId} checkpoint changed`);
      if (expected.pendingCount) {
        const pending = database.prepare(`SELECT d.sequence,e.topic,e.deduplication_key
          FROM biological_deliveries d JOIN biological_events e ON e.sequence=d.sequence
          WHERE d.consumer_id=? AND d.status='PENDING' ORDER BY d.sequence`).all(residencyId);
        assert(pending.length === expected.pendingCount &&
          Number(pending[0]?.sequence) === expected.firstPendingSequence &&
          Number(pending[pending.length - 1]?.sequence) === expected.lastPendingSequence,
        `${residencyId} pending identity changed`);
        const markers = expected.topics.map(() => '?').join(',');
        const replayCount = Number(database.prepare(`SELECT COUNT(*) count FROM biological_events
          WHERE sequence>? AND topic IN (${markers})`).get(expected.consumerCursor, ...expected.topics).count);
        assert(replayCount === expected.eligibleReplayCount && replayCount <= 1023,
          `${residencyId} replay boundary changed`);
        const relevantPending = Number(database.prepare(`SELECT COUNT(*) count
          FROM biological_deliveries d JOIN biological_events e ON e.sequence=d.sequence
          WHERE d.consumer_id=? AND d.status='PENDING' AND d.sequence>? AND
            e.topic IN (${markers})`).get(residencyId, expected.consumerCursor, ...expected.topics).count);
        const invalidPending = Number(database.prepare(`SELECT COUNT(*) count
          FROM biological_deliveries d JOIN biological_events e ON e.sequence=d.sequence
          WHERE d.consumer_id=? AND d.status='PENDING' AND d.sequence>? AND
            e.topic NOT IN (${markers})`).get(residencyId, expected.consumerCursor, ...expected.topics).count);
        assert(relevantPending === expected.eligibleReplayCount &&
          invalidPending === expected.invalidPendingCount,
        `${residencyId} materialized backlog classification changed`);
        const failure = database.prepare(`SELECT id,detail_json FROM recovery_records
          WHERE type='resident.resync-required' AND core_id=? ORDER BY id DESC LIMIT 1`).get(expected.coreId);
        let detail;
        try { detail = JSON.parse(failure?.detail_json || 'null'); } catch { detail = null; }
        assert(Number(failure?.id) === expected.failureRecordId &&
          detail?.residencyId === residencyId && detail?.sequence === expected.failureSequence &&
          detail?.code === expected.failureCode, `${residencyId} failure identity changed`);
        const replayBegin = database.prepare(`SELECT id,detail_json FROM recovery_records
          WHERE type='resident.r147-continuation-replay-begin' AND core_id=?
          ORDER BY id DESC LIMIT 1`).get(expected.coreId);
        let replayDetail;
        try { replayDetail = JSON.parse(replayBegin?.detail_json || 'null'); } catch { replayDetail = null; }
        assert(Number(replayBegin?.id) === expected.replayBeginRecordId &&
          replayDetail?.cohort === 'r147-homeos-sntss-sequential-continuation-v1' &&
          replayDetail?.residencyId === residencyId &&
          replayDetail?.eligibleReplayCount === expected.eligibleReplayCount &&
          replayDetail?.abandonedCount === 0 && replayDetail?.inventedBiologicalTime === false &&
          replayDetail?.authorityChanged === false, `${residencyId} source replay identity changed`);
      }
    }

    const fetus = EXPECTED.fetus;
    const fetusConsumer = database.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?')
      .get(fetus.consumerId);
    const fetusAuthority = database.prepare('SELECT * FROM authority WHERE core_id=?').get(fetus.coreId);
    const fetusCheckpoint = database.prepare(`SELECT * FROM checkpoints
      WHERE core_id=? ORDER BY generation DESC LIMIT 1`).get(fetus.coreId);
    assert(fetusConsumer?.core_id === fetus.coreId && Number(fetusConsumer.required) === 1 &&
      Number(fetusConsumer.active) === 1 && Number(fetusConsumer.authority_epoch) === fetus.authorityEpoch &&
      Number(fetusConsumer.cursor) === fetus.cursor &&
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
    assert(Number(database.prepare(`SELECT COUNT(*) count FROM biological_deliveries
      WHERE consumer_id=? AND status='PENDING'`).get(fetus.consumerId).count) === 0,
    'fetus pending input changed');
    const resolution = database.prepare(`SELECT id,detail_json FROM recovery_records
      WHERE type='biological.consumer-resynchronized' AND core_id='fetus-legacy'
      ORDER BY id DESC LIMIT 1`).get();
    let resolutionDetail;
    try { resolutionDetail = JSON.parse(resolution?.detail_json || 'null'); } catch { resolutionDetail = null; }
    assert(Number(resolution?.id) === EXPECTED.fetusResolutionRecordId &&
      resolutionDetail?.cohort === 'r146-fetus-empty-input-continuity-v1' &&
      resolutionDetail?.toCursor === fetus.cursor && resolutionDetail?.abandonedCount === 0 &&
      resolutionDetail?.inventedBiologicalTime === false && resolutionDetail?.authorityChanged === false,
    'fetus resolution changed');
    const latest = database.prepare(
      'SELECT id,type,core_id,detail_json FROM recovery_records ORDER BY id DESC LIMIT 1'
    ).get();
    let latestDetail;
    try { latestDetail = JSON.parse(latest?.detail_json || 'null'); } catch { latestDetail = null; }
    assert(Number(latest?.id) === EXPECTED.latestRecoveryRecordId &&
      latest.type === 'resident.r147-frame-boundary-repaired' && latest.core_id === 'HOMEOS' &&
      latestDetail?.repairId === 'homeos-r147-committed-metab-frame-boundary-v1' &&
      latestDetail?.repairedCheckpointHash === EXPECTED.residents['resident:homeos'].checkpointHash &&
      latestDetail?.pendingDeliveriesPreserved === 492 && latestDetail?.biologicalEventsDeleted === 0 &&
      latestDetail?.abandonedCount === 0 && latestDetail?.inventedBiologicalTime === false &&
      latestDetail?.authorityChanged === false,
    'latest recovery boundary changed');
    const source = metadata(database, 'life:p1-r0-metab-capacity-source');
    assert(source.instanceId === EXPECTED.capacitySource.instanceId &&
      source.residentVersion === EXPECTED.capacitySource.residentVersion &&
      source.runtimeRevision === EXPECTED.capacitySource.runtimeRevision &&
      source.lastCommittedFrame === EXPECTED.capacitySource.lastCommittedFrame &&
      source.lastTrustedTimeUs === EXPECTED.capacitySource.lastTrustedTimeUs &&
      source.lastContinuityEpoch === EXPECTED.capacitySource.lastContinuityEpoch &&
      source.pending === null, 'METAB capacity source changed');
    database.exec('COMMIT');
    return Object.freeze({
      format: 'stay-r147-homeos-frame-boundary-continuation-preflight-v4', result: 'PASS',
      runtimeRevision: EXPECTED.runtimeRevision, highWater: EXPECTED.highWater,
      pendingDeliveries: 492, invalidDeliveryAssignments: 0,
      homeosReplayEvents: 492, sntssReplayEvents: 0,
      authorityOwned: false, pendingOutboxIntents: 0, benchmarkStarted: false
    });
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    database.close();
  }
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) fail('usage: p1-r147-homeos-continuation-preflight.js <database>');
  process.stdout.write(`${JSON.stringify(validate(path.resolve(argv[0])))}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`${error.code || 'P1_R147_CONTINUATION_PREFLIGHT'}: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ EXPECTED, validate });
