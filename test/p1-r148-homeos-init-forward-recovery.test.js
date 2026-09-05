'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LivingKernel,
  R148_HOMEOS_INIT_FORWARD_RECOVERY,
  R148_HOMEOS_INIT_POST_DURABLE_FINALIZATION,
  R148_HOMEOS_POST_FINALIZATION_RESTART,
  R148_HOMEOS_CAPACITY_SOURCE_FINALIZATION,
  R148_HOMEOS_SNTSS_RESTART_ANCHOR_RECOVERY
} = require('../runtime/kernel/living-kernel');
const { LivingKernel: HardenedLivingKernel } = require('../runtime');
const { StateStore } = require('../runtime/kernel/state-store');
const { FORMAT, validateRequest } = require('../runtime/kernel/resident-control-socket');
const { commitCapacitySample } = require('../runtime/p1-r0/metab-capacity-source');

const REVISION_JSON =
  '{"revision":148,"reason":"kernel.start","at":"2026-09-05T02:17:05.453Z","kernelVersion":"0.8.11.3","version":"0.8.11.3","pid":595505}';
const CAPACITY_JSON =
  '{"protocol":"stay-p1-r0-metab-capacity-source-v1","residencyId":"resident:metab","instanceId":"d424c722-ef31-44b0-8201-ba68c418d14a","residentVersion":"0.3.0-p1r0-homeos-feed.1","runtimeRevision":128,"lastCommittedFrame":162715,"lastTrustedTimeUs":1011923537625,"lastContinuityEpoch":1,"pending":{"continuityEpoch":1,"eligiblePayload":{"capacityClass":"HOST_RESOURCE_HEADROOM_V1","eligibleCapacityQ48":"163221394184393","safetyCeilingQ48":"281474976710656","sampleFrame":162716},"eligibleSignalId":"runtime.metab.capacity.eligible:r128:f162716","observedAtMs":1011924235,"pulseId":"metab-capacity-r128-f162716","qualityPayload":{"ceilingVerified":true,"qualityQ48":"281474976710656","reasonCodes":["TRUSTED_ORGANISM_TIME","KERNEL_CPU_HEADROOM","KERNEL_MEMORY_HEADROOM"],"status":"VALID"},"qualitySignalId":"runtime.metab.capacity.quality:r128:f162716","sampleFrame":162716,"trustedTimeUs":1011924235209}}';
const POST_FAILURE_CAPACITY_JSON =
  '{"protocol":"stay-p1-r0-metab-capacity-source-v1","residencyId":"resident:metab","instanceId":"d424c722-ef31-44b0-8201-ba68c418d14a","residentVersion":"0.3.0-p1r0-homeos-feed.1","runtimeRevision":128,"lastCommittedFrame":162800,"lastTrustedTimeUs":1022392296483,"lastContinuityEpoch":1,"pending":null}';

function r148Harness(expected = R148_HOMEOS_INIT_FORWARD_RECOVERY, { postDurable = false } = {}) {
  const residents = Object.fromEntries(Object.values(expected.residents)
    .map(fence => [fence.residencyId, { ...fence }]));
  const consumers = Object.fromEntries(Object.values(expected.residents)
    .map(fence => [fence.residencyId, {
      coreId: fence.coreId, required: false, active: fence.consumerActive !== false,
      authorityEpoch: 0,
      cursor: fence.consumerCursor, checkpointHash: fence.checkpointHash,
      topicsHash: fence.topicsHash
    }]));
  consumers[expected.fetus.consumerId] = {
    coreId: expected.fetus.coreId, required: true, active: true,
    authorityEpoch: expected.fetus.authorityEpoch, cursor: expected.fetus.consumerCursor,
    checkpointHash: expected.fetus.consumerCheckpointHash,
    topicsHash: expected.fetus.topicsHash
  };
  const outbox = (expected.pendingOutbox || []).map(fence => ({
    producer_event_id: fence.producerEventId, intent_sha256: fence.intentHash,
    producer_core_id: 'METAB', stream_sequence: fence.streamSequence,
    cause_sequence: fence.causeSequence, topic: fence.topic,
    checkpoint_hash: fence.checkpointHash,
    checkpoint_generation: fence.checkpointGeneration, status: 'PENDING'
  }));
  const harness = {
    runtimeRevision: 148,
    homeosStrandedR148InitRecoveryAuthorization: postDurable ? '' : expected.authorization,
    homeosR148InitPostDurableFinalizationAuthorization:
      postDurable ? expected.authorization : '',
    homeosStrandedR147RecoveryAuthorization: '', homeosNeutralBirthAuthorization: '',
    metabHomeosRouteAuthorization: '', homeosShadowPromotionAuthorization: '',
    interoNeutralBirthAuthorization: '', metabInteroRouteAuthorization: '',
    homeosInteroRouteAuthorization: '', interoShadowPromotionAuthorization: '',
    r148HomeosInitForwardRecoveryActive: false, r148DeferredResidentRecovery: false,
    p1ExpansionFetusInstallRevisionPreservation: null,
    stateStore: {
      getResident: id => residents[id] || null,
      getBiologicalConsumer: id => consumers[id] || null,
      listResidents: () => Object.values(residents),
      listAuthority: () => [{ coreId: expected.fetus.coreId }],
      biologicalOutboxIntentFromRow: () => ({}),
      db: {
        prepare(sql) {
          return {
            all() {
              if (sql.includes("biological_outbox_intents WHERE status='PENDING'")) return outbox;
              return [];
            },
            get(...args) {
              if (sql.includes('FROM resident_checkpoints')) {
                const fence = residents[args[0]];
                return fence && {
                  checkpoint_id: fence.checkpointId, instance_id: fence.instanceId,
                  version: fence.version, state_schema: fence.stateSchema,
                  generation: fence.checkpointGeneration, blob_hash: fence.checkpointHash,
                  byte_length: fence.checkpointBytes, input_cursor: fence.inputCursor
                };
              }
              if (sql.includes('COALESCE(MAX(sequence),0)')) return { value: expected.highWater };
              if (sql.includes('MIN(sequence)')) return {
                count: expected.pendingFetusDeliveries || 0,
                minimum: expected.pendingFetusFirstSequence,
                maximum: expected.pendingFetusLastSequence
              };
              if (sql.includes("biological_deliveries WHERE status='PENDING' AND consumer_id!=")) {
                return { count: 0 };
              }
              if (sql.includes("biological_deliveries WHERE status='PENDING'")) {
                return { count: expected.pendingDeliveries || expected.pendingFetusDeliveries || 0 };
              }
              if (sql.includes("biological_deliveries WHERE status='FAILED'") ||
                  sql.includes("biological_deliveries WHERE status='ABANDONED'")) return { count: 0 };
              if (sql.includes("biological_outbox_intents WHERE status='PENDING'")) {
                return { count: (expected.pendingOutbox || []).length };
              }
              if (sql.includes("status!='PUBLISHED' AND producer_core_id!='METAB'") ||
                  sql.includes("producer_core_id IN ('sntss','SNTSS','HOMEOS','INTERO')")) {
                return { count: 0 };
              }
              if (sql.includes('FROM metadata WHERE key=?')) {
                if (args[0] === 'life:runtime-revision') return {
                  json: REVISION_JSON,
                  sha256: crypto.createHash('sha256').update(REVISION_JSON).digest('hex')
                };
                if (args[0] === 'life:p1-r0-metab-capacity-source') return {
                  json: expected === R148_HOMEOS_SNTSS_RESTART_ANCHOR_RECOVERY
                    ? POST_FAILURE_CAPACITY_JSON : CAPACITY_JSON,
                  sha256: crypto.createHash('sha256').update(
                    expected === R148_HOMEOS_SNTSS_RESTART_ANCHOR_RECOVERY
                      ? POST_FAILURE_CAPACITY_JSON : CAPACITY_JSON
                  ).digest('hex')
                };
              }
              if (sql.includes('FROM recovery_records')) return postDurable ? {
                id: expected.latestRecoveryRecordId,
                type: expected.latestRecovery?.type || 'resident.recovered',
                core_id: expected.latestRecovery?.coreId || 'sntss',
                detail_json: JSON.stringify(expected.latestRecovery?.detail || {
                  residencyId: 'resident:sntss',
                  instanceId: expected.residents['resident:sntss'].instanceId,
                  version: expected.residents['resident:sntss'].version,
                  checkpointHash: expected.residents['resident:sntss'].checkpointHash
                })
              } : {
                id: expected.latestRecoveryRecordId, type: 'resident.delivery-retry',
                core_id: 'sntss', detail_json: JSON.stringify({
                  residencyId: 'resident:sntss', sequence: 4575528, attempt: 1,
                  code: 'CORE_WORKER_TIMEOUT', operation: 'event',
                  failedGeneration: 1, recoveredGeneration: 2
                })
              };
              if (sql.includes('FROM authority WHERE core_id=?')) return {
                instance_id: expected.fetus.instanceId, version: expected.fetus.version,
                epoch: expected.fetus.authorityEpoch,
                checkpoint_hash: expected.fetus.checkpointHash
              };
              if (sql.includes('FROM checkpoints WHERE core_id=?')) return {
                instance_id: expected.fetus.instanceId, version: expected.fetus.version,
                authority_epoch: expected.fetus.authorityEpoch,
                generation: expected.fetus.checkpointGeneration,
                blob_hash: expected.fetus.checkpointHash,
                byte_length: expected.fetus.checkpointBytes
              };
              return { count: 0 };
            }
          };
        }
      }
    }
  };
  return { expected, harness, residents, outbox };
}

test('R148-INIT-01 preserves only the exact stopped post-timeout cohort', () => {
  const { expected, harness, residents } = r148Harness();
  assert.equal(crypto.createHash('sha256').update(REVISION_JSON).digest('hex'),
    expected.runtimeRevisionMetadataHash);
  assert.equal(crypto.createHash('sha256').update(CAPACITY_JSON).digest('hex'),
    expected.capacitySourceMetadataHash);
  assert.equal(
    LivingKernel.prototype.preserveExactR148HomeosInitForwardRecoveryRevision.call(harness),
    true
  );
  assert.equal(harness.r148DeferredResidentRecovery, true);
  assert.equal(harness.r148HomeosInitForwardRecoveryActive, true);
  assert.equal(harness.p1ExpansionFetusInstallRevisionPreservation, 148);

  residents['resident:chronobiology'].checkpointHash =
    `f${expected.residents['resident:chronobiology'].checkpointHash.slice(1)}`;
  harness.r148DeferredResidentRecovery = false;
  assert.throws(
    () => LivingKernel.prototype.preserveExactR148HomeosInitForwardRecoveryRevision.call(harness),
    { code: 'P1_R148_INIT_RECOVERY_IDENTITY' }
  );
});

test('R148-INIT-02 rejects wrong authorization and any INTERO presence', () => {
  const { harness, residents } = r148Harness();
  harness.homeosStrandedR148InitRecoveryAuthorization = 'wrong';
  assert.equal(
    LivingKernel.prototype.preserveExactR148HomeosInitForwardRecoveryRevision.call(harness), false);
  harness.homeosStrandedR148InitRecoveryAuthorization =
    R148_HOMEOS_INIT_FORWARD_RECOVERY.authorization;
  residents['resident:intero'] = { residencyId: 'resident:intero' };
  assert.throws(
    () => LivingKernel.prototype.preserveExactR148HomeosInitForwardRecoveryRevision.call(harness),
    { code: 'P1_R148_INIT_RECOVERY_IDENTITY' });
});

test('R148-INIT-03 awakens fetus before exact four-resident reconstruction', async () => {
  const expected = R148_HOMEOS_INIT_FORWARD_RECOVERY;
  const calls = [];
  const harness = {
    r148DeferredResidentRecovery: true, r148HomeosInitForwardRecoveryActive: true,
    runtimeRevision: 148, p1ExpansionFetusInstallPreserved: true,
    heartbeatTimer: null, snapshotTimer: null,
    recoverDurableResidents: async options => {
      calls.push('residents');
      assert.deepEqual([...options.exactCurrentCheckpointFences.keys()].sort(),
        Object.keys(expected.residents).sort());
      return Object.keys(expected.residents)
        .map(residencyId => ({ residencyId, recovered: true, status: 'RUNNING' }));
    },
    startMaintenance: () => calls.push('maintenance'),
    stateStore: {
      getResident: () => null,
      listAuthority: () => [{ coreId: 'fetus-legacy' }],
      db: { prepare: () => ({ get: () => ({ count: 0 }) }) }
    },
    statusCache: {}
  };
  await LivingKernel.prototype.completeExactR148DeferredResidentRecovery.call(harness);
  assert.deepEqual(calls, ['residents', 'maintenance']);
  assert.equal(harness.r148DeferredResidentRecovery, false);
  assert.equal(harness.r148HomeosInitForwardRecoveryActive, false);
  assert.equal(harness.lastResidentRecovery.length, 4);

  const source = await fs.readFile(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(source.indexOf('await kernel.installCore(process.env.STAY_BOOT_CORE)') <
    source.indexOf('await kernel.completeExactR148DeferredResidentRecovery()'));
  assert.ok(source.indexOf('await kernel.completeExactR148DeferredResidentRecovery()') <
    source.indexOf("const badgeSource = await fs.readFile(badgePath"));
});

test('R148-INIT-04 maintenance cannot start before fetus preservation', async () => {
  const harness = {
    r148DeferredResidentRecovery: true, r148HomeosInitForwardRecoveryActive: true,
    runtimeRevision: 148, p1ExpansionFetusInstallPreserved: false,
    heartbeatTimer: null, snapshotTimer: null
  };
  await assert.rejects(
    LivingKernel.prototype.completeExactR148DeferredResidentRecovery.call(harness),
    { code: 'P1_R148_INIT_RECOVERY_BOUNDARY' }
  );
});

test('R148-INIT-05 accepts only a verified exact-cohort preflight snapshot', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r148-snapshot-'));
  const store = new StateStore(root);
  await store.init();
  t.after(async () => {
    try { store.close(); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });
  const snapshot = await store.createSnapshot({
    reason: 'r148-homeos-init-forward-preflight-v1', retention: 2
  });
  const body = await fs.readFile(path.join(snapshot.path, 'SNAPSHOT_MANIFEST.json'));
  const harness = {
    r148DeferredResidentRecovery: true,
    r148HomeosInitForwardRecoveryActive: true,
    r148InitRecoveryPreflightSnapshot: snapshot.path,
    r148InitRecoveryPreflightSnapshotManifestSha256:
      `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`,
    stateStore: store
  };
  const evidence =
    await LivingKernel.prototype.verifyExactR148InitRecoveryPreflightSnapshot.call(harness);
  assert.equal(evidence.name, snapshot.name);
  harness.r148InitRecoveryPreflightSnapshotManifestSha256 = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(
    LivingKernel.prototype.verifyExactR148InitRecoveryPreflightSnapshot.call(harness),
    { code: 'P1_R148_INIT_SNAPSHOT_TRUST' }
  );
});

test('R148-FINAL-01 preserves only the exact post-durable recovered cohort', () => {
  const expected = R148_HOMEOS_INIT_POST_DURABLE_FINALIZATION;
  const { harness, residents } = r148Harness(expected, { postDurable: true });
  assert.equal(
    LivingKernel.prototype.preserveExactR148HomeosInitPostDurableFinalizationRevision
      .call(harness),
    true
  );
  assert.equal(harness.r148DeferredResidentRecovery, true);
  assert.equal(harness.r148HomeosInitPostDurableFinalizationActive, true);
  assert.equal(harness.p1ExpansionFetusInstallRevisionPreservation, 148);
  residents['resident:homeos'].checkpointGeneration--;
  harness.r148DeferredResidentRecovery = false;
  assert.throws(
    () => LivingKernel.prototype.preserveExactR148HomeosInitPostDurableFinalizationRevision
      .call(harness),
    { code: 'P1_R148_INIT_FINALIZATION_IDENTITY' }
  );
});

test('R148-FINAL-02 reconstructs the same four residents only after fetus install', async () => {
  const expected = R148_HOMEOS_INIT_POST_DURABLE_FINALIZATION;
  const calls = [];
  const harness = {
    r148DeferredResidentRecovery: true,
    r148HomeosInitPostDurableFinalizationActive: true,
    runtimeRevision: 148, p1ExpansionFetusInstallPreserved: true,
    heartbeatTimer: null, snapshotTimer: null,
    recoverDurableResidents: async options => {
      calls.push('residents');
      assert.deepEqual([...options.exactCurrentCheckpointFences.keys()].sort(),
        Object.keys(expected.residents).sort());
      return Object.keys(expected.residents)
        .map(residencyId => ({ residencyId, recovered: true, status: 'RUNNING' }));
    },
    startMaintenance: () => calls.push('maintenance'),
    stateStore: {
      getResident: () => null,
      listAuthority: () => [{ coreId: 'fetus-legacy' }],
      db: { prepare: () => ({ get: () => ({ count: 0 }) }) }
    },
    statusCache: {}
  };
  await LivingKernel.prototype.completeExactR148PostDurableResidentFinalization.call(harness);
  assert.deepEqual(calls, ['residents', 'maintenance']);
  assert.equal(harness.r148DeferredResidentRecovery, false);
  assert.equal(harness.r148HomeosInitPostDurableFinalizationActive, false);
  const source = await fs.readFile(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(source.indexOf('await kernel.installCore(process.env.STAY_BOOT_CORE)') <
    source.indexOf('await kernel.completeExactR148PostDurableResidentFinalization()'));
});

test('R148-FINAL-03 exact post-finalization restart is revision-preserving and HOMEOS status-only', () => {
  const expected = R148_HOMEOS_POST_FINALIZATION_RESTART;
  const { harness, residents } = r148Harness(expected, { postDurable: true });
  assert.equal(
    LivingKernel.prototype.preserveExactR148HomeosInitPostDurableFinalizationRevision
      .call(harness),
    true
  );
  assert.equal(harness.r148HomeosInitPostDurableFinalizationExpected, expected);
  assert.equal(harness.r148DeferredResidentRecovery, true);
  assert.deepEqual(validateRequest({
    format: FORMAT, operation: 'status', residencyId: 'resident:homeos'
  }), { operation: 'status', residencyId: 'resident:homeos' });
  assert.throws(() => validateRequest({
    format: FORMAT, operation: 'detach', residencyId: 'resident:homeos'
  }), { code: 'RESIDENT_CONTROL_RESIDENCY' });
  residents['resident:sntss'].checkpointGeneration--;
  assert.throws(
    () => LivingKernel.prototype.preserveExactR148HomeosInitPostDurableFinalizationRevision
      .call(harness),
    { code: 'P1_R148_INIT_FINALIZATION_IDENTITY' }
  );
});

test('R148-FINAL-04 capacity-source finalization admits only the exact stopped cohort', () => {
  const expected = R148_HOMEOS_CAPACITY_SOURCE_FINALIZATION;
  const { harness, residents } = r148Harness(expected, { postDurable: true });
  assert.equal(
    LivingKernel.prototype.preserveExactR148HomeosInitPostDurableFinalizationRevision
      .call(harness),
    true
  );
  assert.equal(harness.r148HomeosInitPostDurableFinalizationExpected, expected);
  residents['resident:metab'].checkpointGeneration--;
  assert.throws(
    () => LivingKernel.prototype.preserveExactR148HomeosInitPostDurableFinalizationRevision
      .call(harness),
    { code: 'P1_R148_INIT_FINALIZATION_IDENTITY' }
  );
});

test('R148-FINAL-04B admits only the exact bounded SNTSS restart cohort', () => {
  const expected = R148_HOMEOS_SNTSS_RESTART_ANCHOR_RECOVERY;
  const { harness, residents } = r148Harness(expected, { postDurable: true });
  assert.equal(crypto.createHash('sha256').update(POST_FAILURE_CAPACITY_JSON).digest('hex'),
    expected.capacitySourceMetadataHash);
  assert.equal(
    LivingKernel.prototype.preserveExactR148HomeosInitPostDurableFinalizationRevision
      .call(harness),
    true
  );
  assert.equal(harness.r148HomeosInitPostDurableFinalizationExpected, expected);
  assert.equal(harness.r148HomeosSntssRestartAnchorRecoveryActive, true);
  assert.equal(residents['resident:sntss'].status, 'RESYNC_REQUIRED');
  residents['resident:sntss'].checkpointGeneration += 1;
  assert.throws(
    () => LivingKernel.prototype.preserveExactR148HomeosInitPostDurableFinalizationRevision
      .call(harness),
    { code: 'P1_R148_INIT_FINALIZATION_IDENTITY' }
  );
});

test('R148-FINAL-05 commits the accepted capacity frame and resumes recovered schedulers', async () => {
  const expected = R148_HOMEOS_CAPACITY_SOURCE_FINALIZATION;
  const committed = commitCapacitySample(JSON.parse(CAPACITY_JSON));
  const capacityJson = JSON.stringify(committed);
  const calls = [];
  const harness = {
    r148DeferredResidentRecovery: true,
    r148HomeosInitPostDurableFinalizationActive: true,
    r148HomeosInitPostDurableFinalizationExpected: expected,
    runtimeRevision: 148, p1ExpansionFetusInstallPreserved: true,
    heartbeatTimer: null, snapshotTimer: null,
    recoverDurableResidents: async options => {
      calls.push('residents');
      assert.deepEqual([...options.exactCurrentCheckpointFences.keys()].sort(),
        Object.keys(expected.residents).sort());
      return Object.keys(expected.residents)
        .map(residencyId => ({ residencyId, recovered: true, status: 'RUNNING' }));
    },
    publishMetabCapacitySample: async () => { calls.push('capacity'); return true; },
    startMaintenance: () => calls.push('maintenance'),
    startTrustedTimePulseScheduler: () => calls.push('trusted-time'),
    startTrustedOrganismTimePulseScheduler: () => calls.push('organism-time'),
    stateStore: {
      getResident: () => null,
      listAuthority: () => [{ coreId: 'fetus-legacy' }],
      readResidentCheckpoint: async () => ({
        state: { sourceState: {
          lastAcceptedFrame: expected.capacitySource.lastCommittedFrame,
          pendingEligible: null, pendingQuality: null
        } }
      }),
      db: { prepare: sql => ({
        get: () => {
          if (sql.includes("key='life:p1-r0-metab-capacity-source'")) return {
            json: capacityJson,
            sha256: crypto.createHash('sha256').update(capacityJson).digest('hex')
          };
          if (sql.includes('COALESCE(MAX(sequence),0)')) return { value: expected.highWater };
          return { count: 0 };
        }
      }) }
    },
    statusCache: {}
  };
  await LivingKernel.prototype.completeExactR148PostDurableResidentFinalization.call(harness);
  assert.deepEqual(calls,
    ['residents', 'capacity', 'maintenance', 'trusted-time', 'organism-time']);
  assert.equal(harness.r148DeferredResidentRecovery, false);
  assert.equal(harness.r148HomeosInitPostDurableFinalizationActive, false);
  assert.equal(harness.r148HomeosInitPostDurableFinalizationExpected, null);
});

test('R148-FINAL-06 exact stopped-state clone anchors time before scheduler resume', {
  skip: !process.env.STAY_R148_SNTSS_RESTART_REHEARSAL_DATA_DIR
}, async () => {
  const expected = R148_HOMEOS_SNTSS_RESTART_ANCHOR_RECOVERY;
  const dataDir = path.resolve(process.env.STAY_R148_SNTSS_RESTART_REHEARSAL_DATA_DIR);
  const freezeDirectory = path.resolve(process.env.STAY_RUNTIME_FREEZE_DIR);
  const kernel = new HardenedLivingKernel({
    dataDir,
    releaseRoot: path.resolve(__dirname, '..'),
    runtimeFreezeDirectory: freezeDirectory,
    logger: { log() {}, info() {}, warn() {}, error() {} },
    heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0,
    snapshotRetention: 2,
    trustedTimePulseIntervalMs: 250,
    trustedOrganismTimePulseIntervalMs: 0,
    enableTrustedOrganismTime: true,
    homeosR148InitPostDurableFinalizationAuthorization: expected.authorization
  });
  try {
    await kernel.start();
    assert.equal(kernel.runtimeRevision, 148);
    assert.equal(kernel.r148HomeosSntssRestartAnchorRecoveryActive, true);
    assert.equal(kernel.stateStore.getResident('resident:sntss').status, 'RECOVERING');
    assert.equal(kernel.stateStore.getBiologicalConsumer('resident:sntss').cursor,
      expected.highWater);
    assert.equal(kernel.stateStore.db.prepare(
      "SELECT COUNT(*) count FROM biological_deliveries WHERE status='PENDING'"
    ).get().count, 0);

    const fetus = await kernel.installCore(path.join(
      path.resolve(__dirname, '..'), 'cores/fetus-legacy-0.6/index.js'
    ));
    assert.equal(fetus.manifest.coreId, 'fetus-legacy');
    await kernel.completeExactR148PostDurableResidentFinalization();

    const anchorRow = kernel.stateStore.db.prepare(`
      SELECT detail_json FROM recovery_records
      WHERE type='resident.r148-restart-clock-anchored'
      ORDER BY id DESC LIMIT 1
    `).get();
    const anchor = JSON.parse(anchorRow?.detail_json || 'null');
    assert.equal(anchor.cohort, 'r148-homeos-sntss-restart-anchor-v1');
    assert.equal(anchor.eventSequence, expected.highWater + expected.ledger.timePulseCount);
    assert.equal(anchor.fromAcceptedPulseSequence, 32);
    assert.equal(anchor.fromDurableLedgerPulseSequence, 116);
    assert.equal(anchor.bridgeFirstPulseSequence, 33);
    assert.equal(anchor.bridgeLastPulseSequence, 116);
    assert.equal(anchor.bridgePulseCount, 84);
    assert.equal(anchor.toPulseSequence, 116);
    assert.equal(anchor.clockStatus, 'uncertain');
    assert.equal(anchor.idempotentCheckpointCommits, 84);
    assert.equal(anchor.retainedCheckpointCount, 32);
    assert.equal(anchor.physiologyApplied, 0);
    assert.equal(anchor.abandonedCount, 0);
    assert.equal(anchor.inventedBiologicalTime, false);
    assert.equal(anchor.authorityChanged, false);
    assert.equal(anchor.physiologyStateHashAfter, anchor.physiologyStateHashBefore);
    const anchorCheckpointRow = kernel.stateStore.db.prepare(`
      SELECT blob_hash,input_cursor FROM resident_checkpoints
      WHERE residency_id='resident:sntss' AND generation=?
    `).get(anchor.checkpointGenerationAfter);
    const anchorState = JSON.parse((await kernel.stateStore.readBlob(
      anchorCheckpointRow.blob_hash
    )).toString('utf8'));
    assert.equal(Number(anchorCheckpointRow.input_cursor), anchor.eventSequence);
    assert.equal(anchorState.trustedTime.lastPulseSequence, 116);
    assert.equal(anchorState.trustedTime.lastClockStatus, 'uncertain');
    assert.equal(anchorState.trustedTime.acceptedPulses, 2891398);
    assert.equal(anchorState.trustedTime.integratedIntervals, 2655857);

    const warmRow = kernel.stateStore.db.prepare(`
      SELECT id,detail_json FROM recovery_records
      WHERE type='runtime.r148-post-anchor-capacity-warmed'
      ORDER BY id DESC LIMIT 1
    `).get();
    const warm = JSON.parse(warmRow?.detail_json || 'null');
    assert.equal(warm.cohort, 'r148-homeos-sntss-restart-capacity-warm-v1');
    assert.equal(warm.anchorEventSequence, anchor.eventSequence);
    assert.equal(warm.firstEventSequence, anchor.eventSequence + 1);
    assert.equal(warm.lastEventSequence, anchor.eventSequence + 4);
    assert.equal(warm.eventCount, 4);
    assert.equal(warm.capacityFrameBefore, 162800);
    assert.equal(warm.capacityFrameAfter, 162801);
    assert.equal(warm.sntssCheckpointChanged, false);
    assert.equal(warm.sntssCheckpointHashAfter, warm.sntssCheckpointHashBefore);
    assert.equal(warm.sntssClockStatus, 'uncertain');
    assert.equal(warm.abandonedCount, 0);
    assert.equal(warm.inventedBiologicalTime, false);
    assert.equal(warm.authorityChanged, false);

    let status = null;
    let schedulerStopped = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (!schedulerStopped && kernel.trustedTimePulseSequence >= 118) {
        assert.equal(kernel.stopTrustedTimePulseScheduler(), true);
        schedulerStopped = true;
      }
      if (schedulerStopped && !kernel.trustedTimePulseInFlight) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(schedulerStopped, true);
    assert.equal(kernel.trustedTimePulseSequence, 118);
    assert.equal(kernel.trustedTimePulseInFlight, false);
    const postSchedulerHighWater = Number(kernel.stateStore.db.prepare(
      'SELECT MAX(sequence) value FROM biological_events'
    ).get().value);
    for (const residencyId of Object.keys(expected.residents)) {
      await kernel.ensureResidentManager().drain(residencyId, postSchedulerHighWater);
    }
    status = await kernel.ensureResidentManager().status('resident:sntss');
    assert.equal(status.status, 'RUNNING');
    assert.equal(status.running, true);
    assert.equal(status.pendingDeliveries, 0);
    assert.equal(status.authorityOwned, false);
    assert.equal(status.lastError, null);
    const postSchedulerSntss = await kernel.stateStore.readResidentCheckpoint('resident:sntss');
    assert.equal(postSchedulerSntss.state.trustedTime.lastPulseSequence, 118);
    assert.equal(postSchedulerSntss.state.trustedTime.lastClockStatus, 'trusted');
    assert.equal(postSchedulerSntss.state.trustedTime.acceptedPulses, 2891400);
    assert.equal(postSchedulerSntss.state.trustedTime.integratedIntervals, 2655858);
    assert.equal(kernel.stateStore.db.prepare(
      "SELECT COUNT(*) count FROM biological_deliveries WHERE status IN ('FAILED','ABANDONED')"
    ).get().count, 0);
    assert.equal(kernel.stateStore.db.prepare(`
      SELECT COUNT(*) count FROM recovery_records
      WHERE id>? AND type='resident.delivery-retry'
    `).get(expected.latestRecoveryRecordId).count, 0);
    assert.equal(kernel.stateStore.listAuthority().filter(row =>
      ['sntss', 'chronobiology', 'METAB', 'HOMEOS', 'INTERO'].includes(row.coreId)
    ).length, 0);
    assert.equal(kernel.stateStore.getResident('resident:intero'), null);
  } finally {
    kernel.stopTrustedTimePulseScheduler?.();
    kernel.stopTrustedOrganismTimePulseScheduler?.();
    await kernel.stop().catch(() => {});
  }
});
