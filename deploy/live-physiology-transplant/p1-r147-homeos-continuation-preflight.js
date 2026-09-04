#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const EXPECTED = Object.freeze({
  runtimeRevision: 147,
  highWater: 4575520,
  latestRecoveryRecordId: 211,
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
    checkpointHash: '4e1e648fb80c66d6c21d5c1c550ae50f702f581ab52bbda60805ce66b33078bf',
    cursor: 4574204
  }),
  residents: Object.freeze({
    'resident:chronobiology': Object.freeze({
      coreId: 'chronobiology', instanceId: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
      version: '1.0.0-c3rc.5', stateSchema: 2, status: 'RUNNING',
      checkpointGeneration: 12385,
      checkpointHash: 'd6374f44ba42dfa716cea7f291422f3c4684308fc73c95db1b2723d03639e022',
      checkpointId: '7df51681-f3f3-440c-9f7d-4434001b2245', checkpointBytes: 49187,
      inputCursor: 4575400, consumerCursor: 4575520,
      moduleRelativePath: 'cores/chronobiology/c3r5/index.js',
      topics: Object.freeze(['runtime.organism.binding', 'runtime.organism.time.pulse']),
      topicsHash: 'a0897ae1c2f0bdf9f94e5491cf681820cda4a0126afcb47511cc4a538d5a281e'
    }),
    'resident:metab': Object.freeze({
      coreId: 'METAB', instanceId: 'd424c722-ef31-44b0-8201-ba68c418d14a',
      version: '0.3.0-p1r0-homeos-feed.1', stateSchema: 3, status: 'RUNNING',
      checkpointGeneration: 325398,
      checkpointHash: 'ec9a31171e5dd07fbe09479aaad9eb5e66de929668c1241914d28a85f9bbc0fe',
      checkpointId: '88ef8550-d093-40d8-be3f-e187245e9ffd', checkpointBytes: 5008,
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
      checkpointGeneration: 75,
      checkpointHash: '970a580617d3c298bd7ce3bee5a56791bbe9565d25df7a73cde204e7d41d7f76',
      checkpointId: 'eed95af7-03f4-4349-89c5-32fafe52d2c3', checkpointBytes: 47620,
      inputCursor: 4574287, consumerCursor: 4574290,
      moduleRelativePath: 'cores/p1-r0/homeos-shadow/index.js',
      topics: Object.freeze(['metab.energy.availability.v1', 'metab.energy.reserve.v1',
        'runtime.homeos.shadow-activation', 'runtime.organism.binding']),
      topicsHash: 'abea82189093d4bb54bee213ed9f9a7ebdd9b2b0b76f6f77dcc2762555e75231',
      eligibleReplayCount: 492, failureRecordId: 211, failureSequence: 4574291,
      failureCode: 'P1_RESIDENT_PENDING_BOUND',
      pending: Object.freeze([
        Object.freeze({ sequence: 4574291, topic: 'metab.energy.availability.v1',
          deduplicationKey: 'core-output:241118f896bf22f9e7fdc76ac282ab598b2223ea617c76635edbef2e6e125e58' }),
        Object.freeze({ sequence: 4574292, topic: 'metab.energy.reserve.v1',
          deduplicationKey: 'core-output:900f2c215b6e2d3d729f1e00857d46c8d92a2bee5960456ad43a995e22ba404e' })
      ])
    }),
    'resident:sntss': Object.freeze({
      coreId: 'sntss', instanceId: '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
      version: '0.5.0-i4g1', stateSchema: 5, status: 'RESYNC_REQUIRED',
      checkpointGeneration: 2891082,
      checkpointHash: '16a0224ff3f8dbeac51ebb27c05ad6e5bef8a1d831f308367470f7cb639cd5a0',
      checkpointId: '4ffc8006-ecbb-47cc-abcf-47f41aac33ae', checkpointBytes: 4971,
      inputCursor: 4574207, consumerCursor: 4574211,
      moduleRelativePath: 'cores/sntss/i4g/index.js',
      topics: Object.freeze(['runtime.organism.binding', 'runtime.sntss.continuity-genesis',
        'runtime.time.pulse']),
      topicsHash: 'b752d8eebb09ac925c4c193810d31f5527315e42e36fbedafa1f30ef25a97501',
      eligibleReplayCount: 261, failureRecordId: 210, failureSequence: 4574212,
      failureCode: 'CORE_WORKER_TIMEOUT',
      pending: Object.freeze([
        Object.freeze({ sequence: 4574212, topic: 'runtime.time.pulse', deduplicationKey: 'runtime.time.pulse:147:3' }),
        Object.freeze({ sequence: 4574217, topic: 'runtime.time.pulse', deduplicationKey: 'runtime.time.pulse:147:4' }),
        Object.freeze({ sequence: 4574223, topic: 'runtime.time.pulse', deduplicationKey: 'runtime.time.pulse:147:5' }),
        Object.freeze({ sequence: 4574228, topic: 'runtime.time.pulse', deduplicationKey: 'runtime.time.pulse:147:6' })
      ])
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
    assert(Number(database.prepare("SELECT COUNT(*) count FROM biological_deliveries WHERE status='PENDING'").get().count) === 6,
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
        Number(consumer.active) === (expected.status === 'RUNNING' ? 1 : 0) &&
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
      if (expected.pending) {
        const pending = database.prepare(`SELECT d.sequence,e.topic,e.deduplication_key
          FROM biological_deliveries d JOIN biological_events e ON e.sequence=d.sequence
          WHERE d.consumer_id=? AND d.status='PENDING' ORDER BY d.sequence`).all(residencyId);
        assert(pending.length === expected.pending.length && pending.every((row, index) =>
          Number(row.sequence) === expected.pending[index].sequence &&
          row.topic === expected.pending[index].topic &&
          row.deduplication_key === expected.pending[index].deduplicationKey),
        `${residencyId} pending identity changed`);
        const markers = expected.topics.map(() => '?').join(',');
        const replayCount = Number(database.prepare(`SELECT COUNT(*) count FROM biological_events
          WHERE sequence>? AND topic IN (${markers})`).get(expected.consumerCursor, ...expected.topics).count);
        assert(replayCount === expected.eligibleReplayCount && replayCount <= 1023,
          `${residencyId} replay boundary changed`);
        const failure = database.prepare(`SELECT id,detail_json FROM recovery_records
          WHERE type='resident.resync-required' AND core_id=? ORDER BY id DESC LIMIT 1`).get(expected.coreId);
        let detail;
        try { detail = JSON.parse(failure?.detail_json || 'null'); } catch { detail = null; }
        assert(Number(failure?.id) === expected.failureRecordId &&
          detail?.residencyId === residencyId && detail?.sequence === expected.failureSequence &&
          detail?.code === expected.failureCode, `${residencyId} failure identity changed`);
      }
    }

    const fetus = EXPECTED.fetus;
    const fetusConsumer = database.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?')
      .get(fetus.consumerId);
    const fetusAuthority = database.prepare('SELECT * FROM authority WHERE core_id=?').get(fetus.coreId);
    assert(fetusConsumer?.core_id === fetus.coreId && Number(fetusConsumer.active) === 0 &&
      Number(fetusConsumer.cursor) === fetus.cursor && fetusConsumer.checkpoint_hash === fetus.checkpointHash &&
      fetusAuthority?.instance_id === fetus.instanceId && fetusAuthority.version === fetus.version &&
      fetusAuthority.checkpoint_hash === fetus.checkpointHash, 'fetus continuity changed');
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
    const latest = database.prepare('SELECT id,type,core_id FROM recovery_records ORDER BY id DESC LIMIT 1').get();
    assert(Number(latest?.id) === EXPECTED.latestRecoveryRecordId &&
      latest.type === 'resident.resync-required' && latest.core_id === 'HOMEOS',
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
      format: 'stay-r147-homeos-continuation-preflight-v1', result: 'PASS',
      runtimeRevision: EXPECTED.runtimeRevision, highWater: EXPECTED.highWater,
      pendingDeliveries: 6, homeosReplayEvents: 492, sntssReplayEvents: 261,
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
