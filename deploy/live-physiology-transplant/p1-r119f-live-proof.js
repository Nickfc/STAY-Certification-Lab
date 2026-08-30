#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const { stableStringify } = require('../../runtime/kernel/canonical-json');
const { BASELINE, REPAIR } = require('./p1-r119f-chronobiology-bounded-catchup-repair');

const DATABASE = process.env.STAY_DATABASE || '/var/lib/stay/data/continuity.sqlite3';
const EXPECTED_SNTSS = Object.freeze({
  instanceId: '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
  version: '0.5.0-i4g1',
  stateSchema: 5,
  moduleRelativePath: 'cores/sntss/i4g/index.js',
  packagePolicyHash: 'sha256:ba12622fcc9c782c8c48f0544a5b019c96dc198dcbb7fb209c1dad47de64639d',
  lineageSha256: 'sha256:f90aaee3814402dff6d17c69f10b82e96918184eadc7941f66a90ee50f1f550d',
});

function fail(message, code = 'R119F_LIVE_PROOF') {
  throw Object.assign(new Error(message), { code });
}

function assert(condition, message, code) {
  if (!condition) fail(message, code);
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`${label} is invalid: ${error.message}`, 'R119F_LIVE_PROOF_INPUT'); }
}

function parseDetail(row) {
  if (!row) return null;
  try { return { ...row, detail: JSON.parse(row.detail_json) }; }
  catch { return { ...row, detail: null }; }
}

function captureDatabase() {
  const database = new DatabaseSync(DATABASE, { readOnly: true });
  database.exec('PRAGMA query_only=ON;');
  try {
    const one = (sql, ...parameters) => database.prepare(sql).get(...parameters) || null;
    const value = (sql, ...parameters) => Number(one(sql, ...parameters)?.value || 0);
    const revisionRow = one("SELECT json FROM metadata WHERE key='life:runtime-revision'");
    const revision = JSON.parse(revisionRow?.json || '{}');
    const residents = database.prepare(`
      SELECT residency_id, core_id, instance_id, version, state_schema,
        module_relative_path, module_hash, manifest_hash, package_policy_hash,
        checkpoint_generation, checkpoint_hash, status
      FROM resident_instances
      WHERE residency_id IN ('resident:sntss', 'resident:chronobiology')
      ORDER BY residency_id
    `).all();
    const consumers = database.prepare(`
      SELECT consumer_id, core_id, required, active, cursor, authority_epoch,
        checkpoint_hash
      FROM biological_consumers
      WHERE consumer_id IN ('resident:sntss', 'resident:chronobiology')
      ORDER BY consumer_id
    `).all();
    const checkpoints = database.prepare(`
      SELECT checkpoint_id, residency_id, instance_id, version, state_schema,
        generation, blob_hash, byte_length, input_cursor
      FROM resident_checkpoints
      WHERE residency_id=? AND (
        generation IN (?, ?)
        OR generation=(
          SELECT checkpoint_generation FROM resident_instances WHERE residency_id=?
        )
      )
      ORDER BY generation
    `).all(BASELINE.residencyId, BASELINE.checkpointGeneration,
      REPAIR.checkpointGeneration, BASELINE.residencyId);
    const latest = (type, coreId) => parseDetail(one(`
      SELECT id, type, core_id, detail_json, created_at
      FROM recovery_records WHERE type=? AND core_id=? ORDER BY id DESC LIMIT 1
    `, type, coreId));
    const coreFaultsAfter = (coreId, id) => value(`
      SELECT COUNT(*) value FROM recovery_records
      WHERE id>? AND core_id=? AND json_valid(detail_json)
        AND json_extract(detail_json, '$.code') IN (
          'COREHOST_TIMEOUT', 'COREHOST_EXIT', 'COREHOST_OFFLINE',
          'CORE_WORKER_TIMEOUT', 'CORE_WORKER_EXIT', 'CORE_WORKER_OFFLINE',
          'ACTOR_HANDLER_STALLED', 'ACTOR_RECOVERY_TIMEOUT',
          'ACTOR_RECOVERY_STALLED', 'RESIDENT_REPLAY_COREHOST_RECOVERY_TIMEOUT'
        )
    `, id, coreId);
    const recoveryHighWaterId = value('SELECT COALESCE(MAX(id), 0) value FROM recovery_records');
    return {
      quickCheck: one('PRAGMA quick_check')?.quick_check || null,
      runtimeRevision: Number(revision.revision),
      runtimeReason: revision.reason || null,
      residents,
      consumers,
      checkpoints,
      pendingDeliveries: value("SELECT COUNT(*) value FROM biological_deliveries WHERE status='PENDING'"),
      chronobiologyPendingDeliveries: value(`
        SELECT COUNT(*) value FROM biological_deliveries
        WHERE consumer_id='resident:chronobiology' AND status='PENDING'
      `),
      pendingOutboxIntents: value("SELECT COUNT(*) value FROM biological_outbox_intents WHERE status='PENDING'"),
      sntssOutputRows: value("SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id='sntss'"),
      sntssAuthorityRows: value("SELECT COUNT(*) value FROM authority WHERE core_id='sntss'"),
      chronobiologyAuthorityRows: value("SELECT COUNT(*) value FROM authority WHERE core_id='chronobiology'"),
      recoveryHighWaterId,
      chronobiologyCoreFaultsThroughHighWater: coreFaultsAfter('chronobiology', 0),
      sntssCoreFaultsThroughHighWater: coreFaultsAfter('sntss', 0),
      latestImplementationRepair: latest('resident.implementation-repaired', 'chronobiology'),
      latestBiologicalResync: latest('resident.biological-resync', 'chronobiology'),
      latestResidentResync: latest('resident.resynchronized', 'chronobiology'),
      latestResyncRequired: latest('resident.resync-required', 'chronobiology'),
      latestColdReplayBegin: latest('resident.cold-backlog-replay-begin', 'chronobiology'),
      latestColdReplayComplete: latest('resident.cold-backlog-replayed', 'chronobiology'),
    };
  } finally {
    database.close();
  }
}

function resident(snapshot, residencyId) {
  return snapshot.residents.find(value => value.residency_id === residencyId) || null;
}

function consumer(snapshot, consumerId) {
  return snapshot.consumers.find(value => value.consumer_id === consumerId) || null;
}

function checkpoint(snapshot, generation) {
  return snapshot.checkpoints?.find(value => Number(value.generation) === generation) || null;
}

function validateBefore(before) {
  const sntss = resident(before, 'resident:sntss');
  const chrono = resident(before, BASELINE.residencyId);
  const chronoConsumer = consumer(before, BASELINE.residencyId);
  const chronoSource = checkpoint(before, BASELINE.checkpointGeneration);
  assert(before.quickCheck === 'ok' && before.runtimeRevision === 118
    && before.runtimeReason === 'core.install',
  'before snapshot is not exact durable R118', 'R119F_BEFORE_REVISION');
  assert(sntss?.instance_id === EXPECTED_SNTSS.instanceId
    && sntss.version === EXPECTED_SNTSS.version
    && Number(sntss.state_schema) === EXPECTED_SNTSS.stateSchema
    && sntss.module_relative_path === EXPECTED_SNTSS.moduleRelativePath
    && sntss.package_policy_hash === EXPECTED_SNTSS.packagePolicyHash
    && sntss.status === 'RUNNING',
  'SNTSS before identity changed', 'R119F_BEFORE_SNTSS');
  assert(chrono?.instance_id === BASELINE.instanceId
    && chrono.version === BASELINE.version
    && Number(chrono.state_schema) === BASELINE.stateSchema
    && chrono.module_relative_path === BASELINE.moduleRelativePath
    && chrono.module_hash === BASELINE.moduleHash
    && chrono.manifest_hash === BASELINE.manifestHash
    && chrono.package_policy_hash === BASELINE.packagePolicyHash
    && Number(chrono.checkpoint_generation) === BASELINE.checkpointGeneration
    && chrono.checkpoint_hash === BASELINE.checkpointHash
    && chrono.status === BASELINE.status,
  'Chronobiology before identity changed', 'R119F_BEFORE_CHRONOBIOLOGY');
  assert(chronoConsumer
    && Number(chronoConsumer.required) === 0
    && Number(chronoConsumer.active) === 0
    && Number(chronoConsumer.cursor) === BASELINE.consumerCursor
    && Number(chronoConsumer.authority_epoch) === 0
    && chronoConsumer.checkpoint_hash === BASELINE.checkpointHash,
  'Chronobiology before consumer fence changed', 'R119F_BEFORE_CONSUMER');
  assert(chronoSource
    && chronoSource.checkpoint_id === BASELINE.checkpointId
    && chronoSource.instance_id === BASELINE.instanceId
    && chronoSource.version === BASELINE.version
    && Number(chronoSource.state_schema) === BASELINE.stateSchema
    && chronoSource.blob_hash === BASELINE.checkpointHash
    && Number(chronoSource.byte_length) === BASELINE.checkpointByteLength
    && Number(chronoSource.input_cursor) === BASELINE.checkpointInputCursor
    && checkpoint(before, REPAIR.checkpointGeneration) === null,
  'Chronobiology before checkpoint provenance changed', 'R119F_BEFORE_CHECKPOINT');
  assert(before.chronobiologyPendingDeliveries === 0
    && before.pendingOutboxIntents === 0
    && before.sntssOutputRows === 0
    && before.sntssAuthorityRows === 0
    && before.chronobiologyAuthorityRows === 0
    && before.latestImplementationRepair?.detail?.repairId ===
      'chronobiology-c3r4-r116-contained-performance'
    && before.latestResyncRequired?.detail?.code === 'CORE_WORKER_TIMEOUT'
    && Number(before.latestResyncRequired?.detail?.sequence) === BASELINE.failedSequence,
  'before snapshot is not authority/output/debt contained', 'R119F_BEFORE_CONTAINMENT');
  assert(before.latestColdReplayBegin?.detail?.pendingCount === 4096
    && before.latestColdReplayBegin?.detail?.abandonedCount === 0
    && before.latestColdReplayBegin?.detail?.inventedBiologicalTime === false
    && before.latestColdReplayComplete?.detail?.replayedPendingCount === 4096
    && before.latestColdReplayComplete?.detail?.abandonedCount === 0
    && before.latestColdReplayComplete?.detail?.inventedBiologicalTime === false,
  'completed 4,096-event cold replay evidence changed', 'R119F_BEFORE_COLD_REPLAY');
  return { sntss, chrono };
}

function validateStatus(status, expected) {
  const value = status?.resident;
  assert(value?.residencyId === expected.residencyId
    && value.instanceId !== null
    && value.status === 'RUNNING'
    && value.running === true
    && value.health?.ok === true
    && value.authorityOwned === false
    && value.productionEligible === false,
  `${expected.label} is not a contained running resident`, 'R119F_RESIDENT_STATUS');
  const policy = value.host?.resourceGovernor?.policy;
  const limits = value.host?.osContainment?.limits;
  assert(value.host?.osContainment?.payloadSandboxed === true
    && policy?.softRamBytes === 64 * 1024 * 1024
    && policy?.hardRamBytes === 96 * 1024 * 1024
    && policy?.softCpuDuty === 0.05
    && policy?.hardCpuDuty === 0.2
    && policy?.queueCapacity === 256
    && policy?.handlerTimeoutMs === 250
    && policy?.healthTimeoutMs === 1000
    && limits?.['memory.high'] === String(64 * 1024 * 1024)
    && limits?.['memory.max'] === String(96 * 1024 * 1024)
    && limits?.['pids.max'] === '16'
    && limits?.['cpu.max'] === '20000 100000',
  `${expected.label} resource limits changed`, 'R119F_RESOURCE_CONTRACT');
  return value;
}

function validateMeta(meta) {
  const bsf = meta.systems?.find(value => value.id === 'bsf');
  const fetus = meta.cores?.find(value => value.id === 'fetus-legacy');
  const chip = id => meta.chipProjection?.lifecycle?.find(value => value.coreId === id);
  assert(meta.ok === true && meta.revision === 119,
    'public metadata is not R119', 'R119F_PUBLIC_META');
  assert(bsf?.mode === 'LIVE' && bsf?.status === 'RUNNING'
    && bsf?.running === true && bsf?.healthOk === true
    && Number(bsf?.writeFailures) === 0,
  'BSF is not LIVE and healthy', 'R119F_BSF');
  assert(fetus?.ok === true
    && fetus?.memoryGuardian?.status === 'healthy'
    && fetus?.memoryGuardian?.warnAtMiB === 192
    && fetus?.memoryGuardian?.recycleAtMiB === 256,
  'fetus continuity or memory contract changed', 'R119F_FETUS');
  assert(meta.chipProjection?.observationOnly === true
    && Array.isArray(meta.chipProjection?.mutationEndpoints)
    && meta.chipProjection.mutationEndpoints.length === 0
    && chip('bsf')?.state === 'LIVE'
    && chip('sntss')?.state === 'SHADOW'
    && chip('chronobiology')?.state === 'SHADOW'
    && chip('chronobiology')?.version === REPAIR.version,
  'web-chip acceptance state is invalid', 'R119F_CHIPS');
  return { bsf, fetus };
}

function verify({ before, after, sntssStatus, chronobiologyStatus, meta, service }) {
  const source = validateBefore(before);
  const sntss = resident(after, 'resident:sntss');
  const chrono = resident(after, BASELINE.residencyId);
  const chronoConsumer = consumer(after, BASELINE.residencyId);
  const chronoCurrentCheckpoint = checkpoint(after, Number(chrono?.checkpoint_generation));
  assert(after.quickCheck === 'ok'
    && after.runtimeRevision === 119
    && after.runtimeReason === 'core.install',
  'after snapshot is not durable R119', 'R119F_AFTER_REVISION');
  assert(sntss?.instance_id === source.sntss.instance_id
    && sntss.version === EXPECTED_SNTSS.version
    && Number(sntss.state_schema) === EXPECTED_SNTSS.stateSchema
    && sntss.module_relative_path === EXPECTED_SNTSS.moduleRelativePath
    && sntss.package_policy_hash === EXPECTED_SNTSS.packagePolicyHash
    && sntss.status === 'RUNNING'
    && Number(sntss.checkpoint_generation) > Number(source.sntss.checkpoint_generation),
  'SNTSS lineage or progression changed', 'R119F_AFTER_SNTSS');
  assert(chrono?.instance_id === BASELINE.instanceId
    && chrono.version === REPAIR.version
    && Number(chrono.state_schema) === REPAIR.stateSchema
    && chrono.module_relative_path === REPAIR.moduleRelativePath
    && chrono.module_hash === REPAIR.moduleHash
    && chrono.manifest_hash === REPAIR.manifestHash
    && chrono.package_policy_hash === REPAIR.packagePolicyHash
    && chrono.status === 'RUNNING'
    && Number(chrono.checkpoint_generation) > REPAIR.checkpointGeneration,
  'Chronobiology repair identity is not running', 'R119F_AFTER_CHRONOBIOLOGY');
  assert(chronoConsumer
    && Number(chronoConsumer.required) === 0
    && Number(chronoConsumer.active) === 1
    && Number(chronoConsumer.authority_epoch) === 0
    && Number(chronoConsumer.cursor) >= BASELINE.consumerCursor
    && chronoConsumer.checkpoint_hash === chrono.checkpoint_hash,
  'Chronobiology consumer continuity is invalid', 'R119F_AFTER_CONSUMER');
  assert(chronoCurrentCheckpoint
    && chronoCurrentCheckpoint.instance_id === BASELINE.instanceId
    && chronoCurrentCheckpoint.version === REPAIR.version
    && Number(chronoCurrentCheckpoint.state_schema) === REPAIR.stateSchema
    && Number(chronoCurrentCheckpoint.generation) === Number(chrono.checkpoint_generation)
    && chronoCurrentCheckpoint.blob_hash === chrono.checkpoint_hash
    && Number(chronoCurrentCheckpoint.byte_length) > 0
    && Number(chronoCurrentCheckpoint.input_cursor) === Number(chronoConsumer.cursor)
    && Number(chronoCurrentCheckpoint.input_cursor) > BASELINE.consumerCursor,
  'Chronobiology current checkpoint continuity is invalid', 'R119F_AFTER_CHECKPOINT');
  assert(after.chronobiologyPendingDeliveries === 0
    && after.pendingOutboxIntents === 0
    && after.sntssOutputRows === 0
    && after.sntssAuthorityRows === 0
    && after.chronobiologyAuthorityRows === 0,
  'after snapshot has debt, output, or authority leakage', 'R119F_AFTER_CONTAINMENT');

  const repair = after.latestImplementationRepair?.detail;
  const biologicalResync = after.latestBiologicalResync?.detail;
  const residentResync = after.latestResidentResync?.detail;
  assert(repair?.repairId === REPAIR.repairId
    && repair?.instanceId === BASELINE.instanceId
    && repair?.sourceCheckpointId === BASELINE.checkpointId
    && repair?.checkpointHash === BASELINE.checkpointHash
    && repair?.checkpointByteLength === BASELINE.checkpointByteLength
    && repair?.checkpointInputCursor === BASELINE.checkpointInputCursor
    && repair?.consumerCursor === BASELINE.consumerCursor
    && repair?.biologicalStateChanged === false
    && repair?.checkpointBytesChanged === false
    && repair?.abandonedCount === 0
    && repair?.inventedBiologicalTime === false
    && repair?.authorityChanged === false
    && repair?.resourceLimitsChanged === false,
  'implementation repair evidence is invalid', 'R119F_REPAIR_EVIDENCE');
  assert(biologicalResync?.runtimeRevision === 119
    && biologicalResync?.abandonedCount === 0
    && biologicalResync?.inventedBiologicalTime === false
    && residentResync?.runtimeRevision === 119
    && residentResync?.abandonedCount === 0
    && residentResync?.inventedBiologicalTime === false,
  'R119 recovery invented or abandoned biological history', 'R119F_RECOVERY_EVIDENCE');
  assert(after.latestResyncRequired?.id === before.latestResyncRequired?.id
    && after.chronobiologyCoreFaultsThroughHighWater === before.chronobiologyCoreFaultsThroughHighWater
    && after.sntssCoreFaultsThroughHighWater === before.sntssCoreFaultsThroughHighWater,
  'new resident fault evidence appeared after repair', 'R119F_NEW_FAULT');

  const liveSntss = validateStatus(sntssStatus, {
    residencyId: 'resident:sntss', label: 'SNTSS',
  });
  const liveChrono = validateStatus(chronobiologyStatus, {
    residencyId: BASELINE.residencyId, label: 'Chronobiology',
  });
  assert(liveSntss.version === EXPECTED_SNTSS.version
    && liveSntss.host?.instanceId === EXPECTED_SNTSS.instanceId
    && liveSntss.observedOutputs === 0
    && liveSntss.declaredOutputs === 0
    && liveSntss.health?.lineageSha256 === EXPECTED_SNTSS.lineageSha256
    && liveSntss.health?.biologicalOutputs === 0,
  'SNTSS zero-output lineage contract changed', 'R119F_LIVE_SNTSS');
  assert(liveChrono.version === REPAIR.version
    && liveChrono.host?.instanceId === BASELINE.instanceId
    && liveChrono.health?.stage === 'c3-shadow-jitless-bounded-catchup-repair'
    && Number(liveChrono.handledEvents) > 0,
  'Chronobiology live repaired status is invalid', 'R119F_LIVE_CHRONOBIOLOGY');
  const publicState = validateMeta(meta);
  assert(service?.beforePid > 1 && service?.afterPid > 1
    && service.beforePid !== service.afterPid
    && service.beforeRestarts === service.afterRestarts
    && service.restartCommands === 1,
  'service restart fence is invalid', 'R119F_SERVICE_RESTART');

  return Object.freeze({
    format: 'stay-r119f-live-proof-v1',
    result: 'PASS',
    runtime: { fromRevision: 118, recoveryRevision: 119, toRevision: 119 },
    service,
    release: {
      chronobiologyInstanceId: BASELINE.instanceId,
      chronobiologyVersion: REPAIR.version,
      sntssInstanceId: EXPECTED_SNTSS.instanceId,
      sntssVersion: EXPECTED_SNTSS.version,
    },
    continuity: {
      coldReplayEvents: 4096,
      abandonedCount: 0,
      inventedBiologicalTime: false,
      sourceCheckpointHash: BASELINE.checkpointHash,
      sourceCheckpointId: BASELINE.checkpointId,
      sourceCheckpointByteLength: BASELINE.checkpointByteLength,
      sourceCheckpointGeneration: BASELINE.checkpointGeneration,
      sourceCheckpointInputCursor: BASELINE.checkpointInputCursor,
      sourceConsumerCursor: BASELINE.consumerCursor,
      repairCheckpointGeneration: REPAIR.checkpointGeneration,
      finalChronobiologyCheckpointGeneration: Number(chrono.checkpoint_generation),
      finalSntssCheckpointGeneration: Number(sntss.checkpoint_generation),
    },
    authority: { sntss: 'NONE', chronobiology: 'NONE' },
    outputs: { sntss: 0 },
    resources: { changed: false, hardCpuPercent: 20, hardRamMiB: 96 },
    bsf: { mode: publicState.bsf.mode, status: publicState.bsf.status },
    fetus: { status: publicState.fetus.memoryGuardian.status,
      warnAtMiB: 192, recycleAtMiB: 256 },
    chips: { bsf: 'LIVE', sntss: 'SHADOW', chronobiology: 'SHADOW' },
    recoveryHighWaterId: after.recoveryHighWaterId,
    verifiedAt: new Date().toISOString(),
  });
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === 'capture') {
    process.stdout.write(`${stableStringify(captureDatabase())}\n`);
    return;
  }
  if (argv.length === 7 && argv[0] === 'verify') {
    const [beforeFile, afterFile, sntssFile, chronoFile, metaFile, serviceFile] = argv.slice(1);
    const proof = verify({
      before: readJson(beforeFile, 'before database'),
      after: readJson(afterFile, 'after database'),
      sntssStatus: readJson(sntssFile, 'SNTSS status'),
      chronobiologyStatus: readJson(chronoFile, 'Chronobiology status'),
      meta: readJson(metaFile, 'public metadata'),
      service: readJson(serviceFile, 'service evidence'),
    });
    process.stdout.write(`${stableStringify(proof)}\n`);
    return;
  }
  fail('capture or verify inputs required', 'R119F_LIVE_PROOF_USAGE');
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`R119F_LIVE_PROOF_ABORT=${error.code || 'FAILED'}:${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { EXPECTED_SNTSS, captureDatabase, validateBefore, verify };
