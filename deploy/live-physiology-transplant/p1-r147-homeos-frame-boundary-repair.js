#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { stableStringify } = require('../../runtime/kernel/canonical-json');
const { createHomeosEngine } = require('../../runtime/p1-r0/homeos-engine');

const COHORT = Object.freeze({
  repairId: 'homeos-r147-committed-metab-frame-boundary-v1',
  runtimeRevision: 147,
  highWater: 4575520,
  residencyId: 'resident:homeos',
  coreId: 'HOMEOS',
  instanceId: '3f32bdc9-fa49-4eea-8c13-b9afe6b47c0f',
  version: '0.2.0-p1r0-shadow.1',
  neutralVersion: '0.1.0-p1r0-neutral.1',
  stateSchema: 2,
  moduleRelativePath: 'cores/p1-r0/homeos-shadow/index.js',
  moduleHash: 'sha256:28ce93b507a070fef823e40cce3e7368928466077fed943c98a1a88b5a84299a',
  manifestHash: 'sha256:36a34d27e58035063c94cbf2acc7f8646679ee472b1d03f0459c9b4ccaa79179',
  packagePolicyHash: 'sha256:1afd6096fed7727491847e702d2506aa9492f8ad7d1424300b99ca3645d8b161',
  topicsHash: 'abea82189093d4bb54bee213ed9f9a7ebdd9b2b0b76f6f77dcc2762555e75231',
  consumerCursor: 4574290,
  inputCursor: 4574287,
  sourceCheckpointId: '58b9dae0-3afa-48bd-be42-2ff9648b81a3',
  sourceCheckpointGeneration: 77,
  sourceCheckpointHash: '970a580617d3c298bd7ce3bee5a56791bbe9565d25df7a73cde204e7d41d7f76',
  sourceCheckpointBytes: 47620,
  repairedCheckpointId: 'homeos-r147-frame-boundary-repair-78',
  repairedCheckpointGeneration: 78,
  repairedCheckpointHash: 'd4805d5951a38fc4e5502fb3b787d7dc093e3dc9bf5ca0fb6eb4bbe815563f61',
  repairedCheckpointBytes: 3943,
  handledEvents: 70,
  fromEngineFrame: 98025,
  firstRetainedSourceFrame: 162423,
  lastRetainedSourceFrame: 162438,
  finalEngineFrame: 162439,
  firstAvailabilityProducerSequence: 128837,
  firstReserveProducerSequence: 128838,
  finalAvailabilityProducerSequence: 128867,
  finalReserveProducerSequence: 128868,
  pendingCount: 492,
  firstPendingSequence: 4574291,
  lastPendingSequence: 4575520,
  firstPendingSourceFrame: 162439,
  lastPendingSourceFrame: 162684,
  firstPendingAvailabilityProducerSequence: 128869,
  lastPendingReserveProducerSequence: 129360,
  pendingDigest: '854177c243b5901f4dc31e4efc0b0406c7421bc7889a040c0eaa135ce622e987',
  sourceLatestRecoveryRecordId: 230,
  repairedRecoveryRecordId: 231,
  exactPeers: Object.freeze({
    'resident:chronobiology': Object.freeze({
      coreId: 'chronobiology', status: 'RUNNING', generation: 12388,
      checkpointHash: 'd6374f44ba42dfa716cea7f291422f3c4684308fc73c95db1b2723d03639e022',
      consumerCursor: 4575520
    }),
    'resident:metab': Object.freeze({
      coreId: 'METAB', status: 'RUNNING', generation: 325401,
      checkpointHash: 'ec9a31171e5dd07fbe09479aaad9eb5e66de929668c1241914d28a85f9bbc0fe',
      consumerCursor: 4575520
    }),
    'resident:sntss': Object.freeze({
      coreId: 'sntss', status: 'RUNNING', generation: 2891345,
      checkpointHash: '76be4edfec7355aa2f21f1cd10f86928b54c51fe2897cc38ceefd6abde1ccd8a',
      consumerCursor: 4575516
    })
  }),
  fetus: Object.freeze({
    consumerId: 'core:fetus-legacy', instanceId: '82202211-8dd6-44d4-a4ec-8f2553d8dc6f',
    version: '0.6.0', authorityEpoch: 1, consumerCursor: 4574204,
    consumerCheckpointHash: '4e1e648fb80c66d6c21d5c1c550ae50f702f581ab52bbda60805ce66b33078bf',
    checkpointGeneration: 208,
    checkpointHash: '09e5c63c912792d96535f6bcfe65861b55b4eccd38f9e50085a9bb30989966ae',
    checkpointBytes: 60264
  })
});

function fail(message, code = 'P1_R147_HOMEOS_FRAME_BOUNDARY') {
  throw Object.assign(new Error(message), { code });
}
function assert(value, message, code) { if (!value) fail(message, code); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function clone(value) { return JSON.parse(stableStringify(value)); }
function scalar(db, sql, ...args) { return Number(db.prepare(sql).get(...args)?.value || 0); }

function metadata(db, key) {
  const row = db.prepare('SELECT json,sha256 FROM metadata WHERE key=?').get(key);
  assert(row && sha256(row.json) === row.sha256, `${key} metadata integrity changed`);
  try { return JSON.parse(row.json); } catch { fail(`${key} metadata is invalid`); }
}

function blobPath(databasePath, hash) {
  return path.join(path.dirname(databasePath), 'blobs', 'sha256', hash.slice(0, 2), hash);
}

function readCheckpointState(databasePath, checkpoint) {
  const file = blobPath(databasePath, checkpoint.blob_hash);
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'HOMEOS checkpoint blob type changed');
  const bytes = fs.readFileSync(file);
  assert(bytes.length === Number(checkpoint.byte_length) && sha256(bytes) === checkpoint.blob_hash,
    'HOMEOS checkpoint blob integrity changed');
  return JSON.parse(bytes);
}

function loadDefinition(releaseRoot) {
  const entry = path.resolve(releaseRoot, COHORT.moduleRelativePath);
  const stat = fs.lstatSync(entry);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'HOMEOS package entry type changed');
  assert(`sha256:${sha256(fs.readFileSync(entry))}` === COHORT.moduleHash,
    'HOMEOS package identity changed');
  const definition = require(entry);
  assert(definition?.manifest?.coreId === COHORT.coreId &&
    definition.manifest.version === COHORT.version &&
    definition.manifest.stateSchema === COHORT.stateSchema &&
    definition.manifest.productionEligible === false &&
    Array.isArray(definition.manifest.outputs) && definition.manifest.outputs.length === 0 &&
    typeof definition.validateState === 'function', 'HOMEOS containment contract changed');
  return definition;
}

function pendingRows(db) {
  return db.prepare(`SELECT d.sequence,d.status,d.transition_id,d.checkpoint_hash,
    e.event_id,e.topic,e.event_class,e.deduplication_key,e.envelope_json,e.envelope_sha256
    FROM biological_deliveries d JOIN biological_events e ON e.sequence=d.sequence
    WHERE d.consumer_id=? AND d.status='PENDING' ORDER BY d.sequence`).all(COHORT.residencyId);
}

function validatePending(rows) {
  assert(rows.length === COHORT.pendingCount &&
    Number(rows[0]?.sequence) === COHORT.firstPendingSequence &&
    Number(rows.at(-1)?.sequence) === COHORT.lastPendingSequence &&
    sha256(JSON.stringify(rows)) === COHORT.pendingDigest,
  'HOMEOS pending replay identity changed');
  for (let index = 0; index < rows.length; index += 2) {
    const availability = rows[index];
    const reserve = rows[index + 1];
    let left;
    let right;
    try {
      assert(sha256(availability.envelope_json) === availability.envelope_sha256 &&
        sha256(reserve.envelope_json) === reserve.envelope_sha256,
      'HOMEOS pending envelope integrity changed');
      left = JSON.parse(availability.envelope_json).payload;
      right = JSON.parse(reserve.envelope_json).payload;
    } catch (error) {
      if (error?.code) throw error;
      fail('HOMEOS pending envelope is invalid');
    }
    const frame = COHORT.firstPendingSourceFrame + (index / 2);
    assert(availability.topic === 'metab.energy.availability.v1' &&
      reserve.topic === 'metab.energy.reserve.v1' &&
      left?.committedFrame === frame && right?.committedFrame === frame &&
      left?.producerSequence === String(COHORT.firstPendingAvailabilityProducerSequence + index) &&
      right?.producerSequence === String(COHORT.firstPendingAvailabilityProducerSequence + index + 1) &&
      left?.route?.consumerCoreId === COHORT.coreId &&
      right?.route?.consumerCoreId === COHORT.coreId,
    'HOMEOS pending causal pair changed');
  }
}

function validateState(state, definition, repaired) {
  definition.validateState(state);
  const source = state.neutralState;
  const availability = Object.keys(source.pendingAvailability).map(Number).sort((a, b) => a - b);
  const reserve = Object.keys(source.pendingReserve).map(Number).sort((a, b) => a - b);
  const expectedFrames = repaired ? [] : Array.from({ length: 16 },
    (_value, index) => COHORT.firstRetainedSourceFrame + index);
  assert(source.handledEvents === COHORT.handledEvents &&
    source.engineState?.frameIndex === (repaired ? COHORT.finalEngineFrame : COHORT.fromEngineFrame) &&
    source.engineState?.outputSequence === '0' &&
    stableStringify(availability) === stableStringify(expectedFrames) &&
    stableStringify(reserve) === stableStringify(expectedFrames),
  'HOMEOS checkpoint frame boundary changed');
  if (!repaired) {
    for (const [index, frame] of expectedFrames.entries()) {
      const a = source.pendingAvailability[String(frame)];
      const r = source.pendingReserve[String(frame)];
      assert(a?.committedFrame === frame && r?.committedFrame === frame &&
        a?.producerSequence === String(COHORT.firstAvailabilityProducerSequence + index * 2) &&
        r?.producerSequence === String(COHORT.firstReserveProducerSequence + index * 2),
      'HOMEOS retained causal pair changed');
    }
  } else {
    assert(source.engineState.inputCursors?.['p1r0.metab-availability.homeos'] ===
      String(COHORT.finalAvailabilityProducerSequence) &&
      source.engineState.inputCursors?.['p1r0.metab-reserve.homeos'] ===
      String(COHORT.finalReserveProducerSequence), 'HOMEOS repaired cursors changed');
  }
  return state;
}

function assertCohort(db, databasePath, releaseRoot, { repaired = false } = {}) {
  assert(String(db.prepare('PRAGMA quick_check').get()?.quick_check || '').toLowerCase() === 'ok',
    'database quick-check failed');
  assert(Number(metadata(db, 'life:runtime-revision').revision) === COHORT.runtimeRevision,
    'runtime revision changed');
  const capacity = metadata(db, 'life:p1-r0-metab-capacity-source');
  assert(capacity.runtimeRevision === 128 && capacity.lastCommittedFrame === 162684 &&
    capacity.lastTrustedTimeUs === 986135434231 && capacity.lastContinuityEpoch === 1 &&
    capacity.pending === null, 'METAB capacity boundary changed');
  assert(scalar(db, 'SELECT COALESCE(MAX(sequence),0) value FROM biological_events') === COHORT.highWater &&
    scalar(db, "SELECT COUNT(*) value FROM biological_deliveries WHERE status='PENDING'") === COHORT.pendingCount &&
    scalar(db, "SELECT COUNT(*) value FROM biological_deliveries WHERE status='ABANDONED'") === 0 &&
    scalar(db, "SELECT COUNT(*) value FROM biological_outbox_intents WHERE status!='PUBLISHED'") === 0 &&
    scalar(db, "SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id IN ('sntss','SNTSS','HOMEOS','INTERO')") === 0 &&
    scalar(db, "SELECT COUNT(*) value FROM authority WHERE core_id IN ('sntss','chronobiology','METAB','HOMEOS','INTERO')") === 0 &&
    !db.prepare("SELECT 1 FROM resident_instances WHERE residency_id='resident:intero'").get(),
  'biological containment boundary changed');

  const resident = db.prepare('SELECT * FROM resident_instances WHERE residency_id=?')
    .get(COHORT.residencyId);
  const consumer = db.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?')
    .get(COHORT.residencyId);
  const generation = repaired ? COHORT.repairedCheckpointGeneration : COHORT.sourceCheckpointGeneration;
  const hash = repaired ? COHORT.repairedCheckpointHash : COHORT.sourceCheckpointHash;
  const checkpointId = repaired ? COHORT.repairedCheckpointId : COHORT.sourceCheckpointId;
  const checkpointBytes = repaired ? COHORT.repairedCheckpointBytes : COHORT.sourceCheckpointBytes;
  const checkpoint = db.prepare(`SELECT * FROM resident_checkpoints
    WHERE residency_id=? AND generation=?`).get(COHORT.residencyId, generation);
  assert(resident?.core_id === COHORT.coreId && resident.instance_id === COHORT.instanceId &&
    resident.version === COHORT.version && Number(resident.state_schema) === COHORT.stateSchema &&
    resident.module_relative_path === COHORT.moduleRelativePath && resident.module_hash === COHORT.moduleHash &&
    resident.manifest_hash === COHORT.manifestHash && resident.package_policy_hash === COHORT.packagePolicyHash &&
    resident.status === 'RESYNC_REQUIRED' && Number(resident.checkpoint_generation) === generation &&
    resident.checkpoint_hash === hash, 'HOMEOS resident fence changed');
  assert(consumer?.core_id === COHORT.coreId && Number(consumer.required) === 0 &&
    Number(consumer.active) === 0 && Number(consumer.cursor) === COHORT.consumerCursor &&
    Number(consumer.authority_epoch) === 0 && consumer.topics_sha256 === COHORT.topicsHash &&
    consumer.checkpoint_hash === hash, 'HOMEOS consumer fence changed');
  assert(checkpoint?.checkpoint_id === checkpointId && checkpoint.instance_id === COHORT.instanceId &&
    checkpoint.version === COHORT.version && Number(checkpoint.state_schema) === COHORT.stateSchema &&
    Number(checkpoint.generation) === generation && checkpoint.blob_hash === hash &&
    Number(checkpoint.byte_length) === checkpointBytes && Number(checkpoint.input_cursor) === COHORT.inputCursor,
  'HOMEOS checkpoint tuple changed');

  for (const [residencyId, expected] of Object.entries(COHORT.exactPeers)) {
    const peer = db.prepare('SELECT * FROM resident_instances WHERE residency_id=?').get(residencyId);
    const peerConsumer = db.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?').get(residencyId);
    assert(peer?.core_id === expected.coreId && peer.status === expected.status &&
      Number(peer.checkpoint_generation) === expected.generation &&
      peer.checkpoint_hash === expected.checkpointHash &&
      Number(peerConsumer?.active) === 1 && Number(peerConsumer.cursor) === expected.consumerCursor &&
      Number(peerConsumer.authority_epoch) === 0 && peerConsumer.checkpoint_hash === expected.checkpointHash,
    `${residencyId} continuity changed`);
  }
  const fetus = COHORT.fetus;
  const fetusConsumer = db.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?')
    .get(fetus.consumerId);
  const fetusAuthority = db.prepare("SELECT * FROM authority WHERE core_id='fetus-legacy'").get();
  const fetusCheckpoint = db.prepare("SELECT * FROM checkpoints WHERE core_id='fetus-legacy' ORDER BY generation DESC LIMIT 1").get();
  assert(Number(fetusConsumer?.required) === 1 && Number(fetusConsumer.active) === 1 &&
    Number(fetusConsumer.cursor) === fetus.consumerCursor &&
    Number(fetusConsumer.authority_epoch) === fetus.authorityEpoch &&
    fetusConsumer.checkpoint_hash === fetus.consumerCheckpointHash &&
    fetusAuthority?.instance_id === fetus.instanceId && fetusAuthority.version === fetus.version &&
    Number(fetusAuthority.epoch) === fetus.authorityEpoch &&
    fetusAuthority.checkpoint_hash === fetus.checkpointHash &&
    Number(fetusCheckpoint?.generation) === fetus.checkpointGeneration &&
    fetusCheckpoint.blob_hash === fetus.checkpointHash &&
    Number(fetusCheckpoint.byte_length) === fetus.checkpointBytes,
  'fetus continuity changed');

  validatePending(pendingRows(db));
  const latest = db.prepare('SELECT id,type,core_id,detail_json FROM recovery_records ORDER BY id DESC LIMIT 1').get();
  if (repaired) {
    let detail;
    try { detail = JSON.parse(latest?.detail_json || 'null'); } catch { detail = null; }
    assert(Number(latest?.id) === COHORT.repairedRecoveryRecordId &&
      latest.type === 'resident.r147-frame-boundary-repaired' && latest.core_id === COHORT.coreId &&
      detail?.repairId === COHORT.repairId && detail?.repairedCheckpointHash === COHORT.repairedCheckpointHash &&
      detail?.pendingDeliveriesPreserved === COHORT.pendingCount && detail?.biologicalEventsDeleted === 0 &&
      detail?.abandonedCount === 0 && detail?.inventedBiologicalTime === false &&
      detail?.authorityChanged === false && detail?.biologicalOutputs === 0,
    'HOMEOS frame-boundary repair evidence changed');
  } else {
    assert(Number(latest?.id) === COHORT.sourceLatestRecoveryRecordId &&
      latest.type === 'resident.r147-continuation-replayed' && latest.core_id === 'sntss',
    'source recovery boundary changed');
  }
  const definition = loadDefinition(releaseRoot);
  const state = validateState(readCheckpointState(databasePath, checkpoint), definition, repaired);
  return { resident, consumer, checkpoint, state, definition };
}

function projectRepair(state, definition) {
  const projected = clone(validateState(clone(state), definition, false));
  const source = projected.neutralState;
  const engine = createHomeosEngine({
    profile: source.founder.profile,
    identity: {
      organismId: source.founder.organismId,
      founderLineageId: source.founder.lineageId,
      residencyId: source.founder.residencyId,
      coreVersion: COHORT.neutralVersion,
      authorityEpoch: '0',
      mode: 'NEUTRAL'
    }
  });
  engine.restore(source.engineState);
  for (let frame = COHORT.fromEngineFrame; frame < COHORT.firstRetainedSourceFrame; frame += 1) {
    const result = engine.advance({ frameIndex: frame + 1, inputs: null });
    assert(result.outputs.length === 0 && result.state.outputSequence === '0',
      'HOMEOS UNKNOWN boundary emitted output');
  }
  for (let frame = COHORT.firstRetainedSourceFrame;
    frame <= COHORT.lastRetainedSourceFrame; frame += 1) {
    const key = String(frame);
    const result = engine.advance({
      frameIndex: frame + 1,
      inputs: [source.pendingAvailability[key], source.pendingReserve[key]]
    });
    assert(result.outputs.length === 0 && result.state.outputSequence === '0',
      'HOMEOS retained physiology emitted output');
    delete source.pendingAvailability[key];
    delete source.pendingReserve[key];
  }
  source.engineState = clone(engine.snapshot());
  validateState(projected, definition, true);
  const bytes = Buffer.from(stableStringify(projected));
  assert(bytes.length === COHORT.repairedCheckpointBytes && sha256(bytes) === COHORT.repairedCheckpointHash,
    'HOMEOS repaired checkpoint projection changed');
  return Object.freeze({ state: projected, bytes });
}

function ensureBlob(databasePath, bytes) {
  const hash = sha256(bytes);
  assert(hash === COHORT.repairedCheckpointHash && bytes.length === COHORT.repairedCheckpointBytes,
    'HOMEOS repaired blob identity changed');
  const databaseStat = fs.statSync(databasePath);
  const directory = path.dirname(blobPath(databasePath, hash));
  const target = blobPath(databasePath, hash);
  const directoryExisted = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!directoryExisted) {
    fs.chownSync(directory, databaseStat.uid, databaseStat.gid);
    fs.chmodSync(directory, 0o700);
  }
  const directoryStat = fs.lstatSync(directory);
  assert(directoryStat.isDirectory() && !directoryStat.isSymbolicLink() &&
    directoryStat.uid === databaseStat.uid && directoryStat.gid === databaseStat.gid &&
    (directoryStat.mode & 0o077) === 0, 'HOMEOS repaired blob directory is unsafe');
  if (!fs.existsSync(target)) {
    const temporary = path.join(directory, `.${hash}.${process.pid}.tmp`);
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.chownSync(temporary, databaseStat.uid, databaseStat.gid);
    fs.renameSync(temporary, target);
    const directoryHandle = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
  }
  const targetStat = fs.lstatSync(target);
  assert(targetStat.isFile() && !targetStat.isSymbolicLink() &&
    targetStat.uid === databaseStat.uid && targetStat.gid === databaseStat.gid &&
    (targetStat.mode & 0o077) === 0 && sha256(fs.readFileSync(target)) === hash,
  'HOMEOS repaired blob verification failed');
  return target;
}

function preflight({ databasePath, releaseRoot }) {
  const db = new DatabaseSync(databasePath, { open: true, readOnly: true });
  db.exec('PRAGMA query_only=ON; BEGIN');
  try {
    const resident = db.prepare('SELECT checkpoint_generation FROM resident_instances WHERE residency_id=?')
      .get(COHORT.residencyId);
    if (Number(resident?.checkpoint_generation) === COHORT.repairedCheckpointGeneration) {
      assertCohort(db, databasePath, releaseRoot, { repaired: true });
      return Object.freeze({ result: 'ALREADY_APPLIED', repairId: COHORT.repairId,
        repairedCheckpointHash: COHORT.repairedCheckpointHash, pendingDeliveries: COHORT.pendingCount,
        abandonedCount: 0, inventedBiologicalTime: false, authorityOwned: false });
    }
    const current = assertCohort(db, databasePath, releaseRoot);
    projectRepair(current.state, current.definition);
    return Object.freeze({ result: 'PASS', repairId: COHORT.repairId,
      sourceCheckpointHash: COHORT.sourceCheckpointHash,
      repairedCheckpointHash: COHORT.repairedCheckpointHash,
      unknownCommittedSourceFrames: COHORT.firstRetainedSourceFrame - COHORT.fromEngineFrame,
      retainedPairCount: 16, pendingDeliveries: COHORT.pendingCount,
      abandonedCount: 0, inventedBiologicalTime: false, authorityOwned: false });
  } finally { try { db.exec('ROLLBACK'); } catch {} db.close(); }
}

function applyRepair({ databasePath, releaseRoot, now = () => new Date().toISOString() }) {
  const probe = new DatabaseSync(databasePath, { open: true, readOnly: true });
  probe.exec('PRAGMA query_only=ON; BEGIN');
  let projected;
  try {
    const resident = probe.prepare('SELECT checkpoint_generation FROM resident_instances WHERE residency_id=?')
      .get(COHORT.residencyId);
    if (Number(resident?.checkpoint_generation) === COHORT.repairedCheckpointGeneration) {
      assertCohort(probe, databasePath, releaseRoot, { repaired: true });
      return Object.freeze({ result: 'ALREADY_APPLIED', repairId: COHORT.repairId,
        repairedCheckpointHash: COHORT.repairedCheckpointHash, pendingDeliveriesPreserved: COHORT.pendingCount,
        abandonedCount: 0, inventedBiologicalTime: false, authorityChanged: false });
    }
    const current = assertCohort(probe, databasePath, releaseRoot);
    projected = projectRepair(current.state, current.definition);
  } finally { try { probe.exec('ROLLBACK'); } catch {} probe.close(); }
  ensureBlob(databasePath, projected.bytes);
  const at = now();
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  try {
    assertCohort(db, databasePath, releaseRoot);
    db.prepare(`INSERT INTO resident_checkpoints(checkpoint_id,residency_id,instance_id,version,
      state_schema,generation,blob_hash,byte_length,input_cursor,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(COHORT.repairedCheckpointId, COHORT.residencyId,
      COHORT.instanceId, COHORT.version, COHORT.stateSchema, COHORT.repairedCheckpointGeneration,
      COHORT.repairedCheckpointHash, COHORT.repairedCheckpointBytes, COHORT.inputCursor, at);
    const resident = db.prepare(`UPDATE resident_instances SET checkpoint_generation=?,checkpoint_hash=?,updated_at=?
      WHERE residency_id=? AND instance_id=? AND status='RESYNC_REQUIRED' AND checkpoint_generation=? AND checkpoint_hash=?`)
      .run(COHORT.repairedCheckpointGeneration, COHORT.repairedCheckpointHash, at,
        COHORT.residencyId, COHORT.instanceId, COHORT.sourceCheckpointGeneration, COHORT.sourceCheckpointHash);
    assert(resident.changes === 1, 'HOMEOS repair lost its resident compare-and-swap fence');
    const consumer = db.prepare(`UPDATE biological_consumers SET checkpoint_hash=?,updated_at=?
      WHERE consumer_id=? AND core_id=? AND required=0 AND active=0 AND cursor=? AND authority_epoch=0 AND checkpoint_hash=?`)
      .run(COHORT.repairedCheckpointHash, at, COHORT.residencyId, COHORT.coreId,
        COHORT.consumerCursor, COHORT.sourceCheckpointHash);
    assert(consumer.changes === 1, 'HOMEOS repair lost its consumer compare-and-swap fence');
    const evidence = {
      repairId: COHORT.repairId,
      residencyId: COHORT.residencyId,
      instanceId: COHORT.instanceId,
      sourceCheckpointHash: COHORT.sourceCheckpointHash,
      repairedCheckpointHash: COHORT.repairedCheckpointHash,
      fromCheckpointGeneration: COHORT.sourceCheckpointGeneration,
      toCheckpointGeneration: COHORT.repairedCheckpointGeneration,
      fromEngineFrame: COHORT.fromEngineFrame,
      toEngineFrame: COHORT.finalEngineFrame,
      unknownCommittedSourceFrameStart: COHORT.fromEngineFrame,
      unknownCommittedSourceFrameEnd: COHORT.firstRetainedSourceFrame - 1,
      unknownCommittedSourceFrames: COHORT.firstRetainedSourceFrame - COHORT.fromEngineFrame,
      unknownFrameSemantics: 'UNKNOWN_NO_PHYSIOLOGICAL_INFERENCE',
      causalCoordinatesDerivedFromCommittedMetab: true,
      retainedPairCount: 16,
      physiologyApplied: 16,
      pendingDeliveriesPreserved: COHORT.pendingCount,
      biologicalEventsDeleted: 0,
      checkpointBytesChanged: true,
      resourceLimitsChanged: false,
      biologicalOutputs: 0,
      abandonedCount: 0,
      inventedBiologicalTime: false,
      authorityChanged: false,
      runtimeRevision: COHORT.runtimeRevision
    };
    const inserted = db.prepare(`INSERT INTO recovery_records(type,core_id,detail_json,created_at)
      VALUES('resident.r147-frame-boundary-repaired',?,?,?)`).run(
      COHORT.coreId, stableStringify(evidence), at);
    assert(Number(inserted.lastInsertRowid) === COHORT.repairedRecoveryRecordId,
      'HOMEOS repair audit sequence changed');
    assertCohort(db, databasePath, releaseRoot, { repaired: true });
    db.exec('COMMIT');
    return Object.freeze({ result: 'APPLIED', ...evidence });
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}

function rollbackRepair({ databasePath, releaseRoot, now = () => new Date().toISOString() }) {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  try {
    assertCohort(db, databasePath, releaseRoot, { repaired: true });
    assert(scalar(db, `SELECT COUNT(*) value FROM resident_checkpoints
      WHERE residency_id=? AND generation>?`, COHORT.residencyId,
    COHORT.repairedCheckpointGeneration) === 0, 'HOMEOS advanced beyond rollback fence');
    const at = now();
    assert(db.prepare(`UPDATE resident_instances SET checkpoint_generation=?,checkpoint_hash=?,updated_at=?
      WHERE residency_id=? AND instance_id=? AND status='RESYNC_REQUIRED' AND checkpoint_generation=? AND checkpoint_hash=?`)
      .run(COHORT.sourceCheckpointGeneration, COHORT.sourceCheckpointHash, at,
        COHORT.residencyId, COHORT.instanceId, COHORT.repairedCheckpointGeneration,
        COHORT.repairedCheckpointHash).changes === 1, 'HOMEOS rollback lost its resident fence');
    assert(db.prepare(`UPDATE biological_consumers SET checkpoint_hash=?,updated_at=?
      WHERE consumer_id=? AND active=0 AND cursor=? AND checkpoint_hash=?`).run(
      COHORT.sourceCheckpointHash, at, COHORT.residencyId, COHORT.consumerCursor,
      COHORT.repairedCheckpointHash).changes === 1, 'HOMEOS rollback lost its consumer fence');
    db.prepare('DELETE FROM resident_checkpoints WHERE residency_id=? AND generation=?')
      .run(COHORT.residencyId, COHORT.repairedCheckpointGeneration);
    db.prepare(`INSERT INTO recovery_records(type,core_id,detail_json,created_at)
      VALUES('resident.r147-frame-boundary-repair-rolled-back',?,?,?)`).run(
      COHORT.coreId, stableStringify({ repairId: COHORT.repairId,
        abandonedCount: 0, inventedBiologicalTime: false, authorityChanged: false }), at);
    db.exec('COMMIT');
    return Object.freeze({ result: 'ROLLED_BACK', repairId: COHORT.repairId });
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3 || !['preflight', 'apply', 'rollback'].includes(argv[0])) {
    fail('usage: p1-r147-homeos-frame-boundary-repair.js <preflight|apply|rollback> <database> <release-root>');
  }
  const options = { databasePath: path.resolve(argv[1]), releaseRoot: path.resolve(argv[2]) };
  const result = argv[0] === 'preflight' ? preflight(options) :
    argv[0] === 'apply' ? applyRepair(options) : rollbackRepair(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`${error.code || 'P1_R147_HOMEOS_FRAME_BOUNDARY'}: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ COHORT, applyRepair, assertCohort, preflight,
  projectRepair, rollbackRepair, validatePending, validateState });
