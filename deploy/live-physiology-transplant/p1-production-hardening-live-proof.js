#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { stableStringify } = require('../../runtime/kernel/canonical-json');

const DATABASE = process.env.STAY_DATABASE || '/var/lib/stay/data/continuity.sqlite3';
const R110_12H_SHA256 = '1fbf5e7b854204278a7ee7967dfc0c9016d1eeb5b281eb7a5289fd66d3b88007';
const R110_72H_SHA256 = '67551f663c79efb6d106ca4f6e9c16557917d24b64bbe2b2592f27820065b504';
const R110_STATE_SHA256 = 'a215023bac35f1c12b8ba9b8021b7ebc16e131f153623a48a0a3c891814fd61a';
const R110_SAMPLES_SHA256 = '53cbbffc750534c5e5aadc056845f31bf88afc4f850cd1e23800371a8bdd5237';
const R110_TERMINAL_SAMPLES = 4311;
const BENCHMARK_72H_MS = 72 * 60 * 60 * 1000;
const MIB = 1024 * 1024;
const EXPECTED_CHRONOBIOLOGY_INSTANCE = 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a';
const EXPECTED_CHRONOBIOLOGY_POLICY = 'sha256:9ab15c27c69494c6ce3156255ed06d2f57887934928a85b13ff58d578add7820';
const EXPECTED_CHRONOBIOLOGY_CHECKPOINT = '81bb366d99550dffc2e78c16c869bb7da20c70473636c3ee1e95b9d8bf8382ae';

function targetRevision() {
  const value = Number(process.env.STAY_PRODUCTION_HARDENING_TARGET_REVISION || 111);
  if (![111, 114, 116].includes(value)) {
    fail('production-hardening target revision is invalid', 'P1_PRODUCTION_HARDENING_REVISION');
  }
  return value;
}

function fail(message, code = 'P1_PRODUCTION_HARDENING_LIVE_PROOF') {
  throw Object.assign(new Error(message), { code });
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`${label} is invalid: ${error.message}`, 'P1_PRODUCTION_HARDENING_LIVE_PROOF_INPUT'); }
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assert(condition, message, code) {
  if (!condition) fail(message, code);
}

function databaseSnapshot() {
  const database = new DatabaseSync(DATABASE, { open: true, readOnly: true });
  database.exec('PRAGMA query_only=ON');
  try {
    const one = (sql, ...parameters) => database.prepare(sql).get(...parameters) || null;
    const value = (sql, ...parameters) => Number(one(sql, ...parameters)?.value || 0);
    const coreHostFaults = coreId => value(`
      SELECT COUNT(*) value
      FROM recovery_records
      WHERE core_id=?
        AND json_valid(detail_json)
        AND json_extract(detail_json, '$.code') IN (
          'COREHOST_TIMEOUT',
          'COREHOST_EXIT',
          'COREHOST_OFFLINE',
          'CORE_WORKER_TIMEOUT',
          'CORE_WORKER_EXIT',
          'CORE_WORKER_OFFLINE',
          'ACTOR_HANDLER_STALLED',
          'ACTOR_RECOVERY_TIMEOUT',
          'ACTOR_RECOVERY_STALLED',
          'RESIDENT_REPLAY_COREHOST_RECOVERY_TIMEOUT'
        )
    `, coreId);
    const revision = JSON.parse(one(
      "SELECT json FROM metadata WHERE key='life:runtime-revision'"
    )?.json || '{}');
    const residents = database.prepare(`
      SELECT residency_id, instance_id, core_id, module_relative_path,
             version, state_schema, package_policy_hash, status,
             checkpoint_generation, checkpoint_hash, updated_at
      FROM resident_instances
      WHERE residency_id IN ('resident:sntss', 'resident:chronobiology')
      ORDER BY residency_id
    `).all();
    const sntss = residents.find(row => row.residency_id === 'resident:sntss') || null;
    const chronobiologyConsumer = one(`
      SELECT consumer_id, core_id, required, active, cursor, authority_epoch,
        checkpoint_hash
      FROM biological_consumers
      WHERE consumer_id='resident:chronobiology'
    `);
    const checkpoint = sntss ? one(`
      SELECT generation, version, state_schema, blob_hash, created_at
      FROM resident_checkpoints
      WHERE residency_id=? AND generation=? AND blob_hash=?
    `, sntss.residency_id, sntss.checkpoint_generation, sntss.checkpoint_hash) : null;
    const blobPath = checkpoint ? path.join(
      path.dirname(DATABASE), 'blobs', 'sha256', checkpoint.blob_hash.slice(0, 2), checkpoint.blob_hash
    ) : null;
    const blob = blobPath && fs.existsSync(blobPath) ? fs.readFileSync(blobPath) : null;
    const recentRecovery = database.prepare(`
      SELECT id, type, core_id, detail_json, created_at
      FROM recovery_records
      WHERE core_id IN ('sntss', 'chronobiology')
      ORDER BY id DESC
      LIMIT 64
    `).all().map(row => ({
      ...row,
      detail: (() => { try { return JSON.parse(row.detail_json); } catch { return null; } })()
    }));
    return {
      quickCheck: one('PRAGMA quick_check')?.quick_check || null,
      runtimeRevision: Number(revision.revision),
      residents,
      chronobiologyConsumer,
      checkpoint: checkpoint ? {
        ...checkpoint,
        blobDigestMatches: Boolean(blob && digest(blob) === checkpoint.blob_hash)
      } : null,
      pendingDeliveries: value("SELECT COUNT(*) value FROM biological_deliveries WHERE status='PENDING'"),
      chronobiologyPendingDeliveries: value("SELECT COUNT(*) value FROM biological_deliveries WHERE consumer_id='resident:chronobiology' AND status='PENDING'"),
      failedDeliveries: value("SELECT COUNT(*) value FROM biological_deliveries WHERE status='FAILED'"),
      pendingOutboxIntents: value("SELECT COUNT(*) value FROM biological_outbox_intents WHERE status='PENDING'"),
      sntssAuthorityRows: value("SELECT COUNT(*) value FROM authority WHERE core_id='sntss'"),
      chronobiologyAuthorityRows: value("SELECT COUNT(*) value FROM authority WHERE core_id='chronobiology'"),
      sntssOutputRows: value("SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id='sntss'"),
      maintenanceFailureRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='maintenance.failed'"),
      startupTeardownFailureRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.startup-teardown-failed'"),
      detachTeardownFailureRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.detach-teardown-failed'"),
      terminalTeardownFailureRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.terminal-teardown-failed'"),
      shutdownCheckpointFailureRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.shutdown-checkpoint-failed'"),
      shutdownStopFailureRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.shutdown-stop-failed'"),
      outboxPendingRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.outbox-pending' AND core_id IN ('sntss', 'chronobiology')"),
      quarantinedRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.quarantined' AND core_id IN ('sntss', 'chronobiology')"),
      kernelRecoveryFailedRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.kernel-recovery-failed' AND core_id IN ('sntss', 'chronobiology')"),
      coldRecoveryFailedRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.cold-recovery-failed' AND core_id IN ('sntss', 'chronobiology')"),
      sntssCoreHostFaults: coreHostFaults('sntss'),
      chronobiologyCoreHostFaults: coreHostFaults('chronobiology'),
      sntssResyncRequiredRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.resync-required' AND core_id='sntss'"),
      chronobiologyResyncRequiredRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.resync-required' AND core_id='chronobiology'"),
      sntssDeliveryRetryRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.delivery-retry' AND core_id='sntss'"),
      chronobiologyDeliveryRetryRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.delivery-retry' AND core_id='chronobiology'"),
      duplicateResyncGroups: value(`
        SELECT COUNT(*) value
        FROM (
          SELECT core_id, json_extract(detail_json, '$.sequence') sequence
          FROM recovery_records
          WHERE type='resident.resync-required'
            AND core_id IN ('sntss', 'chronobiology')
            AND json_valid(detail_json)
          GROUP BY core_id, json_extract(detail_json, '$.sequence')
          HAVING COUNT(*) > 1
        )
      `),
      recoveryHighWaterId: value('SELECT COALESCE(MAX(id), 0) value FROM recovery_records'),
      recentRecovery
    };
  } finally { database.close(); }
}

function recoveryRecordAfter(id, type, coreId) {
  const database = new DatabaseSync(DATABASE, { open: true, readOnly: true });
  database.exec('PRAGMA query_only=ON');
  try {
    const row = database.prepare(`
      SELECT id, type, core_id, detail_json, created_at
      FROM recovery_records
      WHERE id>? AND type=? AND core_id=?
      ORDER BY id
      LIMIT 1
    `).get(Number(id) || 0, type, coreId) || null;
    if (!row) return null;
    return {
      ...row,
      detail: (() => { try { return JSON.parse(row.detail_json); } catch { return null; } })()
    };
  } finally { database.close(); }
}

function captureBefore(sntssStatusFile, chronobiologyStatusFile) {
  const sntssStatus = readJson(sntssStatusFile, 'SNTSS status')?.resident;
  const chronobiologyStatus = readJson(chronobiologyStatusFile, 'Chronobiology status')?.resident;
  const database = databaseSnapshot();
  const sntss = database.residents.find(row => row.residency_id === 'resident:sntss');
  const chronobiology = database.residents.find(row => row.residency_id === 'resident:chronobiology');
  assert(
    database.quickCheck === 'ok' && database.runtimeRevision === 110 &&
    sntss?.version === '0.5.0-i4g1' && Number(sntss?.state_schema) === 5 &&
    sntss?.status === 'RESYNC_REQUIRED' && database.checkpoint?.blobDigestMatches === true &&
    sntssStatus?.status === 'RESYNC_REQUIRED' && sntssStatus?.running === false &&
    sntssStatus?.authorityOwned === false && Number(sntssStatus?.observedOutputs) === 0 &&
    chronobiology?.version === '1.0.0-c3rc.1' && chronobiology?.status === 'RUNNING' &&
    chronobiologyStatus?.running === true && chronobiologyStatus?.health?.ok === true &&
    chronobiologyStatus?.authorityOwned === false &&
    database.maintenanceFailureRows === 0 &&
    database.startupTeardownFailureRows === 0 &&
    database.detachTeardownFailureRows === 0 &&
    database.terminalTeardownFailureRows === 0 &&
    database.shutdownCheckpointFailureRows === 0 &&
    database.shutdownStopFailureRows === 0 &&
    database.pendingOutboxIntents === 0 &&
    database.failedDeliveries === 0 && database.sntssAuthorityRows === 0 &&
    database.chronobiologyAuthorityRows === 0 && database.sntssOutputRows === 0,
    'R110F live recovery baseline is invalid',
    'P1_PRODUCTION_HARDENING_R110_BASELINE'
  );
  return {
    format: 'stay-production-hardening-before-v1',
    capturedAt: new Date().toISOString(),
    runtimeRevision: 110,
    sntss: {
      instanceId: sntss.instance_id,
      status: sntss.status,
      checkpointGeneration: Number(sntss.checkpoint_generation),
      checkpointHash: sntss.checkpoint_hash
    },
    chronobiology: {
      instanceId: chronobiology.instance_id,
      status: chronobiology.status,
      checkpointGeneration: Number(chronobiology.checkpoint_generation),
      checkpointHash: chronobiology.checkpoint_hash
    },
    pendingDeliveries: database.pendingDeliveries,
    maintenanceFailureRows: database.maintenanceFailureRows,
    startupTeardownFailureRows: database.startupTeardownFailureRows,
    detachTeardownFailureRows: database.detachTeardownFailureRows,
    terminalTeardownFailureRows: database.terminalTeardownFailureRows,
    shutdownCheckpointFailureRows: database.shutdownCheckpointFailureRows,
    shutdownStopFailureRows: database.shutdownStopFailureRows,
    outboxPendingRows: database.outboxPendingRows,
    sntssCoreHostFaults: database.sntssCoreHostFaults,
    chronobiologyCoreHostFaults: database.chronobiologyCoreHostFaults,
    sntssResyncRequiredRows: database.sntssResyncRequiredRows,
    chronobiologyResyncRequiredRows: database.chronobiologyResyncRequiredRows,
    sntssDeliveryRetryRows: database.sntssDeliveryRetryRows,
    chronobiologyDeliveryRetryRows: database.chronobiologyDeliveryRetryRows,
    duplicateResyncGroups: database.duplicateResyncGroups,
    recentRecoveryHighWaterId: database.recoveryHighWaterId
  };
}

function recoveryProof(beforeFile, sntssStatusFile, chronobiologyStatusFile) {
  const before = readJson(beforeFile, 'before proof');
  const sntssStatus = readJson(sntssStatusFile, 'SNTSS status')?.resident;
  const chronobiologyStatus = readJson(chronobiologyStatusFile, 'Chronobiology status')?.resident;
  const database = databaseSnapshot();
  const sntss = database.residents.find(row => row.residency_id === 'resident:sntss');
  const chronobiology = database.residents.find(row => row.residency_id === 'resident:chronobiology');
  const serviceRestarts = Number(process.env.STAY_RECOVERY_SERVICE_RESTARTS || 1);
  const resync = recoveryRecordAfter(
    before.recentRecoveryHighWaterId,
    'resident.resynchronized',
    'sntss'
  );
  assert(
    before.format === 'stay-production-hardening-before-v1' &&
    Number.isSafeInteger(serviceRestarts) && serviceRestarts >= 1 && serviceRestarts <= 2 &&
    database.quickCheck === 'ok' && database.runtimeRevision === 111 &&
    sntss?.instance_id === before.sntss.instanceId && sntss?.status === 'RUNNING' &&
    Number(sntss?.checkpoint_generation) > Number(before.sntss.checkpointGeneration) &&
    sntssStatus?.running === true && sntssStatus?.status === 'RUNNING' &&
    sntssStatus?.version === '0.5.0-i4g1' && Number(sntssStatus?.stateSchema) === 5 &&
    sntssStatus?.authorityOwned === false && Number(sntssStatus?.observedOutputs) === 0 &&
    sntssStatus?.health?.ok === true && sntssStatus?.resyncRequired !== true &&
    !sntssStatus?.terminalPersistenceError && !sntssStatus?.teardownError &&
    chronobiology?.instance_id === before.chronobiology.instanceId &&
    chronobiology?.status === 'RUNNING' && chronobiologyStatus?.running === true &&
    chronobiologyStatus?.health?.ok === true && chronobiologyStatus?.authorityOwned === false &&
    !chronobiologyStatus?.terminalPersistenceError &&
    !chronobiologyStatus?.teardownError &&
    resync?.detail?.inventedBiologicalTime === false &&
    database.maintenanceFailureRows === Number(before.maintenanceFailureRows) &&
    database.startupTeardownFailureRows === Number(before.startupTeardownFailureRows) &&
    database.detachTeardownFailureRows === Number(before.detachTeardownFailureRows) &&
    database.terminalTeardownFailureRows === Number(before.terminalTeardownFailureRows) &&
    database.shutdownCheckpointFailureRows === Number(before.shutdownCheckpointFailureRows) &&
    database.shutdownStopFailureRows === Number(before.shutdownStopFailureRows) &&
    database.outboxPendingRows === Number(before.outboxPendingRows) &&
    database.sntssCoreHostFaults === Number(before.sntssCoreHostFaults) &&
    database.chronobiologyCoreHostFaults === Number(before.chronobiologyCoreHostFaults) &&
    database.sntssResyncRequiredRows === Number(before.sntssResyncRequiredRows) &&
    database.chronobiologyResyncRequiredRows === Number(before.chronobiologyResyncRequiredRows) &&
    database.sntssDeliveryRetryRows === Number(before.sntssDeliveryRetryRows) &&
    database.chronobiologyDeliveryRetryRows === Number(before.chronobiologyDeliveryRetryRows) &&
    database.duplicateResyncGroups === Number(before.duplicateResyncGroups) &&
    database.pendingOutboxIntents === 0 &&
    database.failedDeliveries === 0 && database.sntssAuthorityRows === 0 &&
    database.chronobiologyAuthorityRows === 0 && database.sntssOutputRows === 0,
    'R111 cold recovery proof is invalid',
    'P1_PRODUCTION_HARDENING_RECOVERY_PROOF'
  );
  return {
    format: 'stay-production-hardening-recovery-proof-v1',
    result: 'PASS',
    capturedAt: new Date().toISOString(),
    before: {
      runtimeRevision: 110,
      status: before.sntss.status,
      instanceId: before.sntss.instanceId,
      checkpointGeneration: before.sntss.checkpointGeneration,
      checkpointHash: before.sntss.checkpointHash
    },
    after: {
      runtimeRevision: 111,
      status: sntss.status,
      running: true,
      instanceId: sntss.instance_id,
      checkpointGeneration: Number(sntss.checkpoint_generation),
      checkpointHash: sntss.checkpoint_hash
    },
    resyncRecordId: Number(resync.id),
    abandonedCount: Number(resync.detail?.abandonedCount || 0),
    inventedBiologicalTime: false,
    maintenanceFailuresDuringRecovery: 0,
    outboxPublicationFailuresDuringRecovery: 0,
    coreHostFaultsDuringRecovery: 0,
    resyncRequiredDuringRecovery: 0,
    deliveryRetriesDuringRecovery: 0,
    duplicateResyncGroupsDuringRecovery: 0,
    serviceRestarts,
    chronobiologyInstancePreserved: true
  };
}

function captureRepairBefore(sntssStatusFile, chronobiologyStatusFile) {
  const sntssStatus = readJson(sntssStatusFile, 'SNTSS status')?.resident;
  const chronobiologyStatus = readJson(chronobiologyStatusFile, 'Chronobiology status')?.resident;
  const database = databaseSnapshot();
  const sntss = database.residents.find(row => row.residency_id === 'resident:sntss');
  const chronobiology = database.residents.find(row => row.residency_id === 'resident:chronobiology');
  const sntssResync = database.recentRecovery.find(row =>
    row.type === 'resident.resynchronized' && row.core_id === 'sntss'
  );
  const sntssQuarantine = database.recentRecovery.find(row =>
    row.type === 'resident.quarantined' && row.core_id === 'sntss'
  );
  const chronobiologyFailure = database.recentRecovery.find(row =>
    row.type === 'resident.kernel-recovery-failed' && row.core_id === 'chronobiology'
  );
  assert(
    database.quickCheck === 'ok' && database.runtimeRevision === 112 &&
    sntss?.version === '0.5.0-i4g1' && Number(sntss?.state_schema) === 5 &&
    sntss?.status === 'QUARANTINED' && database.checkpoint?.blobDigestMatches === true &&
    sntssStatus?.status === 'QUARANTINED' && sntssStatus?.running === false &&
    sntssStatus?.authorityOwned === false && Number(sntssStatus?.observedOutputs) === 0 &&
    chronobiology?.version === '1.0.0-c3rc.1' && chronobiology?.status === 'QUARANTINED' &&
    chronobiology?.instance_id === EXPECTED_CHRONOBIOLOGY_INSTANCE &&
    chronobiology?.module_relative_path === 'cores/chronobiology/c3/index.js' &&
    chronobiology?.package_policy_hash === EXPECTED_CHRONOBIOLOGY_POLICY &&
    chronobiology?.checkpoint_hash === EXPECTED_CHRONOBIOLOGY_CHECKPOINT &&
    chronobiologyStatus?.status === 'QUARANTINED' && chronobiologyStatus?.running === false &&
    chronobiologyStatus?.authorityOwned === false && Number(chronobiologyStatus?.observedOutputs) === 0 &&
    database.chronobiologyConsumer?.core_id === 'chronobiology' &&
    Number(database.chronobiologyConsumer?.required) === 0 &&
    Number(database.chronobiologyConsumer?.active) === 1 &&
    Number(database.chronobiologyConsumer?.authority_epoch) === 0 &&
    database.chronobiologyConsumer?.checkpoint_hash === EXPECTED_CHRONOBIOLOGY_CHECKPOINT &&
    sntssResync?.detail?.runtimeRevision === 111 &&
    sntssResync?.detail?.inventedBiologicalTime === false &&
    Number(sntssResync?.detail?.abandonedCount) === 0 &&
    sntssQuarantine?.detail?.reason === 'restart-storm' &&
    Number(sntssQuarantine?.detail?.restarts) === 5 &&
    chronobiologyFailure?.detail?.code === 'CGROUP_REQUIRED' &&
    /ESRCH/.test(String(chronobiologyFailure?.detail?.message || '')) &&
    database.pendingOutboxIntents === 0 && database.failedDeliveries === 0 &&
    database.sntssAuthorityRows === 0 && database.chronobiologyAuthorityRows === 0 &&
    database.sntssOutputRows === 0,
    'contained R112 repair baseline is invalid',
    'P1_PRODUCTION_HARDENING_R112_REPAIR_BASELINE'
  );
  const resident = value => ({
    instanceId: value.instance_id,
    status: value.status,
    checkpointGeneration: Number(value.checkpoint_generation),
    checkpointHash: value.checkpoint_hash
  });
  return {
    format: 'stay-production-hardening-repair-before-v1',
    capturedAt: new Date().toISOString(),
    runtimeRevision: 112,
    sntss: resident(sntss),
    chronobiology: resident(chronobiology),
    pendingDeliveries: database.pendingDeliveries,
    recentRecoveryHighWaterId: database.recoveryHighWaterId,
    counters: {
      maintenanceFailureRows: database.maintenanceFailureRows,
      startupTeardownFailureRows: database.startupTeardownFailureRows,
      detachTeardownFailureRows: database.detachTeardownFailureRows,
      terminalTeardownFailureRows: database.terminalTeardownFailureRows,
      shutdownCheckpointFailureRows: database.shutdownCheckpointFailureRows,
      shutdownStopFailureRows: database.shutdownStopFailureRows,
      outboxPendingRows: database.outboxPendingRows,
      quarantinedRows: database.quarantinedRows,
      kernelRecoveryFailedRows: database.kernelRecoveryFailedRows,
      coldRecoveryFailedRows: database.coldRecoveryFailedRows,
      sntssCoreHostFaults: database.sntssCoreHostFaults,
      chronobiologyCoreHostFaults: database.chronobiologyCoreHostFaults,
      sntssResyncRequiredRows: database.sntssResyncRequiredRows,
      chronobiologyResyncRequiredRows: database.chronobiologyResyncRequiredRows,
      sntssDeliveryRetryRows: database.sntssDeliveryRetryRows,
      chronobiologyDeliveryRetryRows: database.chronobiologyDeliveryRetryRows,
      duplicateResyncGroups: database.duplicateResyncGroups
    }
  };
}

function repairRecoveryProof(beforeFile, sntssStatusFile, chronobiologyStatusFile) {
  const before = readJson(beforeFile, 'repair before proof');
  const sntssStatus = readJson(sntssStatusFile, 'SNTSS status')?.resident;
  const chronobiologyStatus = readJson(chronobiologyStatusFile, 'Chronobiology status')?.resident;
  const database = databaseSnapshot();
  const sntss = database.residents.find(row => row.residency_id === 'resident:sntss');
  const chronobiology = database.residents.find(row => row.residency_id === 'resident:chronobiology');
  const sntssResync = recoveryRecordAfter(
    before.recentRecoveryHighWaterId, 'resident.resynchronized', 'sntss'
  );
  const chronobiologyResync = recoveryRecordAfter(
    before.recentRecoveryHighWaterId, 'resident.resynchronized', 'chronobiology'
  );
  const counters = before.counters || {};
  const unchanged = [
    'maintenanceFailureRows', 'startupTeardownFailureRows', 'detachTeardownFailureRows',
    'terminalTeardownFailureRows', 'shutdownCheckpointFailureRows', 'shutdownStopFailureRows',
    'outboxPendingRows', 'quarantinedRows', 'kernelRecoveryFailedRows', 'coldRecoveryFailedRows',
    'sntssCoreHostFaults', 'chronobiologyCoreHostFaults',
    'sntssResyncRequiredRows', 'chronobiologyResyncRequiredRows',
    'sntssDeliveryRetryRows', 'chronobiologyDeliveryRetryRows', 'duplicateResyncGroups'
  ];
  const healthyResident = (status, coreId) => {
    const memory = status?.host?.resourceGovernor?.policy?.memoryPlan;
    const processRss = Number(status?.host?.resourceGovernor?.latest?.process?.rssBytes);
    return status?.coreId === coreId && status?.status === 'RUNNING' && status?.running === true &&
      status?.health?.ok === true && status?.authorityOwned === false &&
      !status?.terminalPersistenceError && !status?.teardownError &&
      status?.host?.osContainment?.required === true &&
      status?.host?.osContainment?.available === true &&
      status?.host?.osContainment?.payloadAttachedBeforeInit === true &&
      Number(memory?.payloadSoftBytes) === 64 * MIB &&
      Number(memory?.payloadHardBytes) === 96 * MIB &&
      Number(memory?.supervisorHardBytes) === 64 * MIB &&
      Number(memory?.supervisorOldSpaceMiB) === 12 &&
      Number(memory?.supervisorSemiSpaceMiB) === 1 &&
      Number.isFinite(processRss) && processRss > 0 && processRss < 64 * MIB &&
      status?.host?.resourceGovernor?.lastAction == null;
  };
  const serviceRestarts = Number(process.env.STAY_RECOVERY_SERVICE_RESTARTS || 1);
  assert(
    before.format === 'stay-production-hardening-repair-before-v1' &&
    Number.isSafeInteger(serviceRestarts) && serviceRestarts >= 1 && serviceRestarts <= 2 &&
    before.runtimeRevision === 112 && database.quickCheck === 'ok' && database.runtimeRevision === 114 &&
    sntss?.instance_id === before.sntss?.instanceId && sntss?.status === 'RUNNING' &&
    Number(sntss?.checkpoint_generation) > Number(before.sntss?.checkpointGeneration) &&
    chronobiology?.instance_id === before.chronobiology?.instanceId && chronobiology?.status === 'RUNNING' &&
    Number(chronobiology?.checkpoint_generation) > Number(before.chronobiology?.checkpointGeneration) &&
    healthyResident(sntssStatus, 'sntss') && healthyResident(chronobiologyStatus, 'chronobiology') &&
    Number(sntssStatus?.observedOutputs) === 0 &&
    sntssResync?.detail?.runtimeRevision === 113 &&
    sntssResync?.detail?.inventedBiologicalTime === false &&
    Number(sntssResync?.detail?.abandonedCount) === 0 &&
    chronobiologyResync?.detail?.runtimeRevision === 113 &&
    chronobiologyResync?.detail?.inventedBiologicalTime === false &&
    Number(chronobiologyResync?.detail?.abandonedCount) === 0 &&
    unchanged.every(key => Number(database[key]) === Number(counters[key])) &&
    database.pendingOutboxIntents === 0 && database.failedDeliveries === 0 &&
    database.pendingDeliveries <= 32 && database.sntssAuthorityRows === 0 &&
    database.chronobiologyAuthorityRows === 0 && database.sntssOutputRows === 0,
    'R112 to R114 contained recovery proof is invalid',
    'P1_PRODUCTION_HARDENING_R114_RECOVERY_PROOF'
  );
  const recoveryResident = (prior, current, resync) => ({
    before: prior,
    after: {
      runtimeRevision: 114,
      status: current.status,
      running: true,
      instanceId: current.instance_id,
      checkpointGeneration: Number(current.checkpoint_generation),
      checkpointHash: current.checkpoint_hash
    },
    resyncRecordId: Number(resync.id),
    abandonedCount: Number(resync.detail.abandonedCount),
    inventedBiologicalTime: false
  });
  return {
    format: 'stay-production-hardening-contained-repair-proof-v1',
    result: 'PASS',
    capturedAt: new Date().toISOString(),
    sourceRevision: 112,
    coldRecoveryRevision: 113,
    completedRevision: 114,
    serviceRestarts,
    sntss: recoveryResident(before.sntss, sntss, sntssResync),
    chronobiology: recoveryResident(before.chronobiology, chronobiology, chronobiologyResync),
    maintenanceFailuresDuringRecovery: 0,
    outboxPublicationFailuresDuringRecovery: 0,
    coreHostFaultsDuringRecovery: 0,
    resyncRequiredDuringRecovery: 0,
    deliveryRetriesDuringRecovery: 0,
    quarantinesDuringRecovery: 0,
    duplicateResyncGroupsDuringRecovery: 0,
    payloadLimitsChanged: false,
    deadlinesChanged: false,
    authorityChanged: false
  };
}

function captureBacklogRepairBefore(sntssStatusFile, chronobiologyStatusFile) {
  const sntssStatus = readJson(sntssStatusFile, 'SNTSS status')?.resident;
  const chronobiologyStatus = readJson(chronobiologyStatusFile, 'Chronobiology status')?.resident;
  const database = databaseSnapshot();
  const sntss = database.residents.find(row => row.residency_id === 'resident:sntss');
  const chronobiology = database.residents.find(row => row.residency_id === 'resident:chronobiology');
  const failedColdRecovery = database.recentRecovery.find(row =>
    row.type === 'resident.cold-recovery-failed' && row.core_id === 'chronobiology'
  );
  assert(
    database.quickCheck === 'ok' && database.runtimeRevision === 114 &&
    sntss?.version === '0.5.0-i4g1' && Number(sntss?.state_schema) === 5 &&
    sntss?.status === 'RUNNING' && sntssStatus?.status === 'RUNNING' &&
    sntssStatus?.running === true && sntssStatus?.health?.ok === true &&
    sntssStatus?.authorityOwned === false && Number(sntssStatus?.observedOutputs) === 0 &&
    chronobiology?.version === '1.0.0-c3rc.1' && chronobiology?.status === 'QUARANTINED' &&
    chronobiologyStatus?.status === 'QUARANTINED' && chronobiologyStatus?.running === false &&
    chronobiologyStatus?.authorityOwned === false && Number(chronobiologyStatus?.observedOutputs) === 0 &&
    failedColdRecovery?.detail?.expectedRevision === 113 &&
    failedColdRecovery?.detail?.code === 'RESIDENT_RESYNC_STATE' &&
    database.chronobiologyPendingDeliveries > 0 &&
    database.chronobiologyPendingDeliveries <= 8192 &&
    database.pendingDeliveries === database.chronobiologyPendingDeliveries &&
    database.pendingOutboxIntents === 0 && database.failedDeliveries === 0 &&
    database.sntssAuthorityRows === 0 && database.chronobiologyAuthorityRows === 0 &&
    database.sntssOutputRows === 0,
    'contained R114 backlog-repair baseline is invalid',
    'P1_PRODUCTION_HARDENING_R114_BACKLOG_BASELINE'
  );
  const resident = value => ({
    instanceId: value.instance_id,
    status: value.status,
    checkpointGeneration: Number(value.checkpoint_generation),
    checkpointHash: value.checkpoint_hash
  });
  return {
    format: 'stay-production-hardening-backlog-repair-before-v1',
    capturedAt: new Date().toISOString(),
    runtimeRevision: 114,
    sntss: resident(sntss),
    chronobiology: resident(chronobiology),
    chronobiologyPendingDeliveries: database.chronobiologyPendingDeliveries,
    recentRecoveryHighWaterId: database.recoveryHighWaterId,
    counters: {
      maintenanceFailureRows: database.maintenanceFailureRows,
      startupTeardownFailureRows: database.startupTeardownFailureRows,
      detachTeardownFailureRows: database.detachTeardownFailureRows,
      terminalTeardownFailureRows: database.terminalTeardownFailureRows,
      shutdownCheckpointFailureRows: database.shutdownCheckpointFailureRows,
      shutdownStopFailureRows: database.shutdownStopFailureRows,
      outboxPendingRows: database.outboxPendingRows,
      quarantinedRows: database.quarantinedRows,
      kernelRecoveryFailedRows: database.kernelRecoveryFailedRows,
      coldRecoveryFailedRows: database.coldRecoveryFailedRows,
      sntssCoreHostFaults: database.sntssCoreHostFaults,
      chronobiologyCoreHostFaults: database.chronobiologyCoreHostFaults,
      sntssResyncRequiredRows: database.sntssResyncRequiredRows,
      chronobiologyResyncRequiredRows: database.chronobiologyResyncRequiredRows,
      sntssDeliveryRetryRows: database.sntssDeliveryRetryRows,
      chronobiologyDeliveryRetryRows: database.chronobiologyDeliveryRetryRows,
      duplicateResyncGroups: database.duplicateResyncGroups
    }
  };
}

function backlogRepairRecoveryProof(beforeFile, sntssStatusFile, chronobiologyStatusFile) {
  const before = readJson(beforeFile, 'backlog repair before proof');
  const sntssStatus = readJson(sntssStatusFile, 'SNTSS status')?.resident;
  const chronobiologyStatus = readJson(chronobiologyStatusFile, 'Chronobiology status')?.resident;
  const database = databaseSnapshot();
  const sntss = database.residents.find(row => row.residency_id === 'resident:sntss');
  const chronobiology = database.residents.find(row => row.residency_id === 'resident:chronobiology');
  const begin = recoveryRecordAfter(
    before.recentRecoveryHighWaterId, 'resident.cold-backlog-replay-begin', 'chronobiology'
  );
  const complete = recoveryRecordAfter(
    before.recentRecoveryHighWaterId, 'resident.cold-backlog-replayed', 'chronobiology'
  );
  const forbiddenResync = recoveryRecordAfter(
    before.recentRecoveryHighWaterId, 'resident.biological-resync', 'chronobiology'
  );
  const counters = before.counters || {};
  const unchanged = [
    'maintenanceFailureRows', 'startupTeardownFailureRows', 'detachTeardownFailureRows',
    'terminalTeardownFailureRows', 'shutdownCheckpointFailureRows', 'shutdownStopFailureRows',
    'outboxPendingRows', 'quarantinedRows', 'kernelRecoveryFailedRows', 'coldRecoveryFailedRows',
    'sntssCoreHostFaults', 'chronobiologyCoreHostFaults',
    'sntssResyncRequiredRows', 'chronobiologyResyncRequiredRows',
    'sntssDeliveryRetryRows', 'chronobiologyDeliveryRetryRows', 'duplicateResyncGroups'
  ];
  const healthy = (status, coreId) => status?.coreId === coreId &&
    status?.status === 'RUNNING' && status?.running === true && status?.health?.ok === true &&
    status?.authorityOwned === false && !status?.terminalPersistenceError && !status?.teardownError &&
    status?.host?.osContainment?.required === true && status?.host?.osContainment?.available === true &&
    status?.host?.osContainment?.payloadAttachedBeforeInit === true &&
    Number(status?.host?.resourceGovernor?.policy?.memoryPlan?.payloadSoftBytes) === 64 * MIB &&
    Number(status?.host?.resourceGovernor?.policy?.memoryPlan?.payloadHardBytes) === 96 * MIB &&
    Number(status?.host?.resourceGovernor?.policy?.memoryPlan?.supervisorHardBytes) === 64 * MIB &&
    Number(status?.host?.resourceGovernor?.policy?.memoryPlan?.supervisorOldSpaceMiB) === 12 &&
    Number(status?.host?.resourceGovernor?.policy?.memoryPlan?.supervisorSemiSpaceMiB) === 1 &&
    Number(status?.host?.resourceGovernor?.latest?.process?.rssBytes) > 0 &&
    Number(status?.host?.resourceGovernor?.latest?.process?.rssBytes) < 64 * MIB &&
    status?.host?.resourceGovernor?.lastAction == null;
  const serviceRestarts = Number(process.env.STAY_RECOVERY_SERVICE_RESTARTS || 1);
  assert(
    before.format === 'stay-production-hardening-backlog-repair-before-v1' &&
    before.runtimeRevision === 114 && serviceRestarts === 1 &&
    database.quickCheck === 'ok' && database.runtimeRevision === 116 &&
    sntss?.instance_id === before.sntss?.instanceId && sntss?.status === 'RUNNING' &&
    Number(sntss?.checkpoint_generation) > Number(before.sntss?.checkpointGeneration) &&
    chronobiology?.instance_id === before.chronobiology?.instanceId &&
    chronobiology?.status === 'RUNNING' &&
    Number(chronobiology?.checkpoint_generation) > Number(before.chronobiology?.checkpointGeneration) &&
    healthy(sntssStatus, 'sntss') && healthy(chronobiologyStatus, 'chronobiology') &&
    Number(sntssStatus?.observedOutputs) === 0 &&
    begin?.detail?.runtimeRevision === 115 && complete?.detail?.runtimeRevision === 115 &&
    Number(begin?.detail?.pendingCount) === Number(before.chronobiologyPendingDeliveries) &&
    Number(complete?.detail?.replayedPendingCount) === Number(before.chronobiologyPendingDeliveries) &&
    typeof begin?.detail?.replayId === 'string' && begin.detail.replayId.length > 0 &&
    complete?.detail?.replayId === begin.detail.replayId &&
    begin?.detail?.checkpointHash === before.chronobiology?.checkpointHash &&
    Number(begin?.detail?.abandonedCount) === 0 && Number(complete?.detail?.abandonedCount) === 0 &&
    begin?.detail?.inventedBiologicalTime === false &&
    complete?.detail?.inventedBiologicalTime === false && forbiddenResync == null &&
    unchanged.every(key => Number(database[key]) === Number(counters[key])) &&
    database.pendingOutboxIntents === 0 && database.failedDeliveries === 0 &&
    database.pendingDeliveries <= 32 && database.sntssAuthorityRows === 0 &&
    database.chronobiologyAuthorityRows === 0 && database.sntssOutputRows === 0,
    'R114 to R116 contained backlog recovery proof is invalid',
    'P1_PRODUCTION_HARDENING_R116_RECOVERY_PROOF'
  );
  const after = current => ({
    runtimeRevision: 116,
    status: current.status,
    running: true,
    instanceId: current.instance_id,
    checkpointGeneration: Number(current.checkpoint_generation),
    checkpointHash: current.checkpoint_hash
  });
  return {
    format: 'stay-production-hardening-contained-backlog-repair-proof-v1',
    result: 'PASS',
    capturedAt: new Date().toISOString(),
    sourceRevision: 114,
    coldRecoveryRevision: 115,
    completedRevision: 116,
    serviceRestarts,
    sntss: { before: before.sntss, after: after(sntss) },
    chronobiology: {
      before: before.chronobiology,
      after: after(chronobiology),
      backlogReplayBeginRecordId: Number(begin.id),
      backlogReplayCompletionRecordId: Number(complete.id),
      backlogReplayId: begin.detail.replayId,
      replayedPendingCount: Number(complete.detail.replayedPendingCount),
      abandonedCount: 0,
      inventedBiologicalTime: false
    },
    maintenanceFailuresDuringRecovery: 0,
    outboxPublicationFailuresDuringRecovery: 0,
    coreHostFaultsDuringRecovery: 0,
    resyncRequiredDuringRecovery: 0,
    deliveryRetriesDuringRecovery: 0,
    quarantinesDuringRecovery: 0,
    duplicateResyncGroupsDuringRecovery: 0,
    payloadLimitsChanged: false,
    deadlinesChanged: false,
    authorityChanged: false
  };
}

function validateTerminalBenchmark(evidence, state, sampleLedgerRecords) {
  const bsf = evidence.final?.meta?.systems?.find(system => system.id === 'bsf');
  const sntss = evidence.final?.meta?.residents?.find(
    resident => resident.residencyId === 'resident:sntss'
  );
  const chronobiology = evidence.final?.meta?.residents?.find(
    resident => resident.residencyId === 'resident:chronobiology'
  );
  const startedAt = Date.parse(evidence.startedAt);
  const capturedAt = Date.parse(evidence.capturedAt);
  assert(
    evidence.format === 'stay-physiology-benchmark-milestone-v2' &&
    evidence.milestone === '72h' && evidence.result === 'OBSERVED_FAILURES' &&
    evidence.recoveryAware === true && Number(evidence.runtimeRevision) === 110 &&
    Number(evidence.elapsedMs) >= BENCHMARK_72H_MS &&
    Number.isFinite(startedAt) && Number.isFinite(capturedAt) &&
    capturedAt - startedAt >= BENCHMARK_72H_MS &&
    Number(evidence.samples) === R110_TERMINAL_SAMPLES &&
    Number(evidence.failures) === 3596 && Number(evidence.observedFailureCount) === 3606 &&
    evidence.progressOk === true &&
    Number(evidence.coreHostFaults?.sntss) === 6 &&
    Number(evidence.coreHostFaults?.chronobiology) === 0 &&
    Number(evidence.coreHostTimeouts?.sntss) === 4 &&
    Number(evidence.coreHostTimeouts?.chronobiology) === 0 &&
    Number(evidence.processTransitions?.main) === 0 &&
    Number(evidence.processTransitions?.sntss) === 4 &&
    Number(evidence.processTransitions?.chronobiology) === 0 &&
    evidence.final?.health?.ok === true && Number(evidence.final?.health?.revision) === 110 &&
    Number(evidence.final?.meta?.revision) === 110 &&
    evidence.final?.meta?.revisionFrozen === true &&
    evidence.final?.meta?.revisionLabel === 'R110F' &&
    bsf?.mode === 'LIVE' && bsf?.status === 'RUNNING' &&
    bsf?.running === true && bsf?.healthOk === true &&
    sntss?.version === '0.5.0-i4g1' && sntss?.status === 'RESYNC_REQUIRED' &&
    sntss?.running === false && sntss?.mode === 'SHADOW' &&
    sntss?.authorityOwned === false && Number(sntss?.observedOutputs) === 0 &&
    sntss?.healthOk === true &&
    chronobiology?.version === '1.0.0-c3rc.1' && chronobiology?.status === 'RUNNING' &&
    chronobiology?.running === true && chronobiology?.mode === 'SHADOW' &&
    chronobiology?.authorityOwned === false && chronobiology?.healthOk === true &&
    Number(chronobiology?.observedOutputs) > 0 &&
    evidence.final?.database?.quickCheck === 'ok' &&
    Number(evidence.final?.database?.pendingDeliveries) === 0 &&
    Number(evidence.final?.database?.failedDeliveries) === 0 &&
    evidence.final?.database?.pendingOutboxIntents == null &&
    Number(evidence.final?.database?.sntssAuthorityRows) === 0 &&
    Number(evidence.final?.database?.chronobiologyAuthorityRows) === 0 &&
    Number(evidence.final?.database?.sntssOutputRows) === 0 &&
    state.format === 'stay-physiology-benchmark-state-v2' &&
    state.startedAt === evidence.startedAt && Number(state.runtimeRevision) === 110 &&
    Number(state.samples) === R110_TERMINAL_SAMPLES &&
    Number(state.samples) === Number(sampleLedgerRecords) &&
    Number(state.failures) === Number(evidence.failures) &&
    state.milestones?.['72h'] === evidence.capturedAt &&
    Number(state.sntssCoreHostFaults) === Number(evidence.coreHostFaults.sntss) &&
    Number(state.chronobiologyCoreHostFaults) === Number(evidence.coreHostFaults.chronobiology) &&
    Number(state.sntssCoreHostTimeouts) === Number(evidence.coreHostTimeouts.sntss) &&
    Number(state.chronobiologyCoreHostTimeouts) === Number(evidence.coreHostTimeouts.chronobiology) &&
    Number(state.sntssProcessTransitions) === Number(evidence.processTransitions.sntss) &&
    Number(state.chronobiologyProcessTransitions) === Number(evidence.processTransitions.chronobiology) &&
    Number(state.mainPidTransitions) === Number(evidence.processTransitions.main),
    'R110F terminal 72-hour failure evidence is invalid',
    'P1_PRODUCTION_HARDENING_R110_TERMINAL_EVIDENCE'
  );
  return {
    elapsedMs: Number(evidence.elapsedMs),
    samples: Number(evidence.samples),
    failures: Number(evidence.failures),
    observedFailureCount: Number(evidence.observedFailureCount),
    completedAt: evidence.capturedAt
  };
}

function makeClosure(evidenceFile, terminalEvidenceFile, stateFile, samplesFile) {
  const bytes = fs.readFileSync(evidenceFile);
  const terminalBytes = fs.readFileSync(terminalEvidenceFile);
  const stateBytes = fs.readFileSync(stateFile);
  const sampleBytes = fs.readFileSync(samplesFile);
  const evidence = JSON.parse(bytes.toString('utf8'));
  const terminalEvidence = JSON.parse(terminalBytes.toString('utf8'));
  const state = JSON.parse(stateBytes.toString('utf8'));
  let sampleLedgerRecords = sampleBytes.at(-1) === 0x0a ? 0 : -1;
  if (sampleLedgerRecords === 0) {
    for (const byte of sampleBytes) sampleLedgerRecords += byte === 0x0a ? 1 : 0;
  }
  assert(
    digest(bytes) === R110_12H_SHA256 &&
    digest(terminalBytes) === R110_72H_SHA256 &&
    digest(stateBytes) === R110_STATE_SHA256 &&
    digest(sampleBytes) === R110_SAMPLES_SHA256 &&
    Number(evidence.runtimeRevision) === 110 && evidence.milestone === '12h' &&
    Number(evidence.coreHostFaults?.sntss) >= 1 &&
    Number(evidence.coreHostTimeouts?.sntss) >= 1 &&
    Number(evidence.processTransitions?.sntss) >= 1,
    'R110F 12-hour failure evidence is invalid',
    'P1_PRODUCTION_HARDENING_R110_EVIDENCE'
  );
  const terminal = validateTerminalBenchmark(terminalEvidence, state, sampleLedgerRecords);
  const record = {
    format: 'stay-physiology-benchmark-closure-v4',
    revisionLabel: 'R110F',
    result: 'OBSERVED_FAILURES',
    disposition: 'REQUIRES_PRODUCTION_HARDENING',
    source12hSha256: `sha256:${R110_12H_SHA256}`,
    source72hSha256: `sha256:${R110_72H_SHA256}`,
    sourceStateSha256: `sha256:${R110_STATE_SHA256}`,
    sourceSamplesSha256: `sha256:${R110_SAMPLES_SHA256}`,
    terminal,
    observed: {
      sntssCoreHostFaults: Number(evidence.coreHostFaults.sntss),
      sntssCoreHostTimeouts: Number(evidence.coreHostTimeouts.sntss),
      sntssProcessTransitions: Number(evidence.processTransitions.sntss),
      mainProcessTransitions: Number(evidence.processTransitions.main || 0),
      chronobiologyCoreHostFaults: Number(evidence.coreHostFaults.chronobiology || 0)
    },
    replacementRevision: 111,
    replacementBenchmarkHours: 72,
    evidenceRetained: true,
    closedAt: new Date().toISOString()
  };
  record.recordSha256 = `sha256:${digest(stableStringify(record))}`;
  return record;
}

function processList(sample, resident) {
  return [...new Set((sample?.service?.cgroup?.[resident]?.processes || []).map(Number))]
    .filter(Number.isSafeInteger).sort((a, b) => a - b);
}

function noQueueFaults(resident) {
  return !resident?.terminalPersistenceError && !resident?.teardownError &&
    ['failed', 'timedOut', 'stalled', 'recovered', 'recoveryRejected', 'recoveryTimedOut']
    .every(key => Number(resident?.queue?.[key] || 0) === 0);
}

function resourceEvents(sample, resident) {
  const cgroup = sample?.service?.cgroup?.[resident] || {};
  const memory = cgroup.memoryEvents || {};
  const pids = cgroup.pidsEvents || {};
  const cpu = cgroup.cpuStat || {};
  return [
    ...['high', 'max', 'oom', 'oom_kill'].map(key => Number(memory[key] || 0)),
    Number(pids.max || 0),
    Number(cpu.nr_throttled || 0)
  ];
}

function soakProof(beforeFile, afterFile) {
  const before = readJson(beforeFile, 'soak start');
  const after = readJson(afterFile, 'soak end');
  const elapsedMs = Date.parse(after.capturedAt) - Date.parse(before.capturedAt);
  const counters = [
    'sntssCoreHostFaults', 'sntssCoreHostTimeouts',
    'chronobiologyCoreHostFaults', 'chronobiologyCoreHostTimeouts',
    'sntssResyncRows', 'chronobiologyResyncRows',
    'sntssDeliveryRetryRows', 'chronobiologyDeliveryRetryRows',
    'maintenanceFailureRows', 'startupTeardownFailureRows', 'detachTeardownFailureRows',
    'terminalTeardownFailureRows',
    'shutdownCheckpointFailureRows', 'shutdownStopFailureRows',
    'outboxPendingRows', 'duplicateResyncGroups', 'failedDeliveries'
  ];
  const revision = targetRevision();
  assert(
    elapsedMs >= 125000 && before.health?.ok === true && after.health?.ok === true &&
    Number(before.health?.revision) === revision && Number(after.health?.revision) === revision &&
    before.meta?.revisionFrozen === false && after.meta?.revisionFrozen === false &&
    before.service?.pid === after.service?.pid &&
    JSON.stringify(processList(before, 'sntss')) === JSON.stringify(processList(after, 'sntss')) &&
    JSON.stringify(processList(before, 'chronobiology')) === JSON.stringify(processList(after, 'chronobiology')) &&
    Number(after.residents?.sntss?.checkpointGeneration) >
      Number(before.residents?.sntss?.checkpointGeneration) &&
    Number(after.residents?.chronobiology?.checkpointGeneration) >
      Number(before.residents?.chronobiology?.checkpointGeneration) &&
    after.residents?.sntss?.running === true && after.residents?.sntss?.health?.ok === true &&
    after.residents?.sntss?.authorityOwned === false &&
    Number(after.residents?.sntss?.observedOutputs) === 0 && noQueueFaults(after.residents?.sntss) &&
    after.residents?.chronobiology?.running === true &&
    after.residents?.chronobiology?.health?.ok === true &&
    after.residents?.chronobiology?.authorityOwned === false &&
    noQueueFaults(after.residents?.chronobiology) &&
    counters.every(key => Number(after.database?.[key] || 0) === Number(before.database?.[key] || 0)) &&
    JSON.stringify(resourceEvents(before, 'sntss')) === JSON.stringify(resourceEvents(after, 'sntss')) &&
    JSON.stringify(resourceEvents(before, 'chronobiology')) === JSON.stringify(resourceEvents(after, 'chronobiology')) &&
    Number(after.database?.pendingDeliveries) <= 32 &&
    Number(after.database?.pendingOutboxIntents) === 0 &&
    after.database?.quickCheck === 'ok' &&
    Number(after.database?.sntssAuthorityRows) === 0 &&
    Number(after.database?.chronobiologyAuthorityRows) === 0 &&
    Number(after.database?.sntssOutputRows) === 0,
    `bounded R${revision} live soak failed`,
    'P1_PRODUCTION_HARDENING_SOAK'
  );
  return {
    format: 'stay-production-hardening-live-soak-v1',
    result: 'PASS',
    startedAt: before.capturedAt,
    completedAt: after.capturedAt,
    elapsedMs,
    sntssCheckpointProgress:
      Number(after.residents.sntss.checkpointGeneration) - Number(before.residents.sntss.checkpointGeneration),
    chronobiologyCheckpointProgress:
      Number(after.residents.chronobiology.checkpointGeneration) -
      Number(before.residents.chronobiology.checkpointGeneration),
    residentProcessTransitions: 0,
    newCoreHostFaults: 0,
    newMaintenanceFailures: 0,
    newOutboxPublicationFailures: 0,
    pendingOutboxIntents: 0,
    newResourcePressureEvents: 0,
    failedDeliveries: 0,
    sqliteQuickCheck: 'ok'
  };
}

function main(argv = process.argv.slice(2)) {
  const [mode, ...rest] = argv;
  if (mode === 'before' && rest.length === 2) {
    process.stdout.write(JSON.stringify(captureBefore(rest[0], rest[1])) + '\n');
    return;
  }
  if (mode === 'recovery' && rest.length === 3) {
    process.stdout.write(JSON.stringify(recoveryProof(rest[0], rest[1], rest[2])) + '\n');
    return;
  }
  if (mode === 'repair-before' && rest.length === 2) {
    process.stdout.write(JSON.stringify(captureRepairBefore(rest[0], rest[1])) + '\n');
    return;
  }
  if (mode === 'repair-recovery' && rest.length === 3) {
    process.stdout.write(JSON.stringify(repairRecoveryProof(rest[0], rest[1], rest[2])) + '\n');
    return;
  }
  if (mode === 'backlog-repair-before' && rest.length === 2) {
    process.stdout.write(JSON.stringify(captureBacklogRepairBefore(rest[0], rest[1])) + '\n');
    return;
  }
  if (mode === 'backlog-repair-recovery' && rest.length === 3) {
    process.stdout.write(JSON.stringify(backlogRepairRecoveryProof(rest[0], rest[1], rest[2])) + '\n');
    return;
  }
  if (mode === 'closure' && rest.length === 4) {
    process.stdout.write(JSON.stringify(makeClosure(...rest)) + '\n');
    return;
  }
  if (mode === 'soak' && rest.length === 2) {
    process.stdout.write(JSON.stringify(soakProof(rest[0], rest[1])) + '\n');
    return;
  }
  fail('before, recovery, repair-before, repair-recovery, backlog-repair-before, backlog-repair-recovery, closure, or soak arguments are required', 'P1_PRODUCTION_HARDENING_LIVE_PROOF_USAGE');
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`P1_PRODUCTION_HARDENING_LIVE_PROOF_ABORT=${error.code || 'FAILED'}:${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  databaseSnapshot,
  captureBefore,
  recoveryProof,
  captureRepairBefore,
  repairRecoveryProof,
  captureBacklogRepairBefore,
  backlogRepairRecoveryProof,
  makeClosure,
  validateTerminalBenchmark,
  soakProof
};
