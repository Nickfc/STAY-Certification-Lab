'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LivingKernel,
  R148_HOMEOS_INIT_FORWARD_RECOVERY
} = require('../runtime/kernel/living-kernel');
const { StateStore } = require('../runtime/kernel/state-store');

const REVISION_JSON =
  '{"revision":148,"reason":"kernel.start","at":"2026-09-05T02:17:05.453Z","kernelVersion":"0.8.11.3","version":"0.8.11.3","pid":595505}';
const CAPACITY_JSON =
  '{"protocol":"stay-p1-r0-metab-capacity-source-v1","residencyId":"resident:metab","instanceId":"d424c722-ef31-44b0-8201-ba68c418d14a","residentVersion":"0.3.0-p1r0-homeos-feed.1","runtimeRevision":128,"lastCommittedFrame":162715,"lastTrustedTimeUs":1011923537625,"lastContinuityEpoch":1,"pending":{"continuityEpoch":1,"eligiblePayload":{"capacityClass":"HOST_RESOURCE_HEADROOM_V1","eligibleCapacityQ48":"163221394184393","safetyCeilingQ48":"281474976710656","sampleFrame":162716},"eligibleSignalId":"runtime.metab.capacity.eligible:r128:f162716","observedAtMs":1011924235,"pulseId":"metab-capacity-r128-f162716","qualityPayload":{"ceilingVerified":true,"qualityQ48":"281474976710656","reasonCodes":["TRUSTED_ORGANISM_TIME","KERNEL_CPU_HEADROOM","KERNEL_MEMORY_HEADROOM"],"status":"VALID"},"qualitySignalId":"runtime.metab.capacity.quality:r128:f162716","sampleFrame":162716,"trustedTimeUs":1011924235209}}';

function r148Harness() {
  const expected = R148_HOMEOS_INIT_FORWARD_RECOVERY;
  const residents = Object.fromEntries(Object.values(expected.residents)
    .map(fence => [fence.residencyId, { ...fence }]));
  const consumers = Object.fromEntries(Object.values(expected.residents)
    .map(fence => [fence.residencyId, {
      coreId: fence.coreId, required: false, active: true, authorityEpoch: 0,
      cursor: fence.consumerCursor, checkpointHash: fence.checkpointHash,
      topicsHash: fence.topicsHash
    }]));
  consumers[expected.fetus.consumerId] = {
    coreId: expected.fetus.coreId, required: true, active: true,
    authorityEpoch: expected.fetus.authorityEpoch, cursor: expected.fetus.consumerCursor,
    checkpointHash: expected.fetus.consumerCheckpointHash,
    topicsHash: expected.fetus.topicsHash
  };
  const outbox = expected.pendingOutbox.map(fence => ({
    producer_event_id: fence.producerEventId, intent_sha256: fence.intentHash,
    producer_core_id: 'METAB', stream_sequence: fence.streamSequence,
    cause_sequence: fence.causeSequence, topic: fence.topic,
    checkpoint_hash: fence.checkpointHash,
    checkpoint_generation: fence.checkpointGeneration, status: 'PENDING'
  }));
  const harness = {
    runtimeRevision: 148,
    homeosStrandedR148InitRecoveryAuthorization: expected.authorization,
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
                count: expected.pendingFetusDeliveries,
                minimum: expected.pendingFetusFirstSequence,
                maximum: expected.pendingFetusLastSequence
              };
              if (sql.includes("biological_deliveries WHERE status='PENDING' AND consumer_id!=")) {
                return { count: 0 };
              }
              if (sql.includes("biological_deliveries WHERE status='PENDING'")) {
                return { count: expected.pendingFetusDeliveries };
              }
              if (sql.includes("biological_deliveries WHERE status='FAILED'") ||
                  sql.includes("biological_deliveries WHERE status='ABANDONED'")) return { count: 0 };
              if (sql.includes("biological_outbox_intents WHERE status='PENDING'")) {
                return { count: expected.pendingOutbox.length };
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
                  json: CAPACITY_JSON,
                  sha256: crypto.createHash('sha256').update(CAPACITY_JSON).digest('hex')
                };
              }
              if (sql.includes('FROM recovery_records')) return {
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
