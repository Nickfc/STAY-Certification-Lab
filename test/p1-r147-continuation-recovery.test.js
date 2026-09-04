'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LivingKernel,
  R147_HOMEOS_CONTINUATION_RECOVERY
} = require('../runtime/kernel/living-kernel');
const { StateStore } = require('../runtime/kernel/state-store');
const { createCapacitySourceState } = require('../runtime/p1-r0/metab-capacity-source');

const AT = '2026-09-04T19:20:00.000Z';
const IDENTITY_HASH = '9'.repeat(64);
const PENDING = Object.freeze({
  'resident:homeos': Object.freeze([
    Object.freeze({ sequence: 4574291,
      deduplicationKey: 'core-output:241118f896bf22f9e7fdc76ac282ab598b2223ea617c76635edbef2e6e125e58' }),
    Object.freeze({ sequence: 4574292,
      deduplicationKey: 'core-output:900f2c215b6e2d3d729f1e00857d46c8d92a2bee5960456ad43a995e22ba404e' })
  ]),
  'resident:sntss': Object.freeze([
    Object.freeze({ sequence: 4574212, deduplicationKey: 'runtime.time.pulse:147:3' }),
    Object.freeze({ sequence: 4574217, deduplicationKey: 'runtime.time.pulse:147:4' }),
    Object.freeze({ sequence: 4574223, deduplicationKey: 'runtime.time.pulse:147:5' }),
    Object.freeze({ sequence: 4574228, deduplicationKey: 'runtime.time.pulse:147:6' })
  ])
});

function continuationHarness() {
  const expected = R147_HOMEOS_CONTINUATION_RECOVERY;
  const residents = Object.fromEntries(
    [expected.metab, expected.homeos, expected.sntss, expected.chronobiology]
      .map(value => [value.residencyId, { ...value }])
  );
  const consumers = Object.fromEntries(
    [expected.metab, expected.homeos, expected.sntss, expected.chronobiology]
      .map(value => [value.residencyId, {
        coreId: value.coreId,
        required: false,
        active: value.status === 'RUNNING',
        authorityEpoch: 0,
        cursor: value.consumerCursor,
        checkpointHash: value.checkpointHash,
        topicsHash: value.topicsHash
      }])
  );
  const capacity = {
    ...createCapacitySourceState({
      instanceId: expected.metab.instanceId,
      residentVersion: expected.metab.version
    }),
    ...expected.capacitySource,
    pending: null
  };
  const capacityJson = JSON.stringify(capacity);
  const byCore = new Map([
    [expected.homeos.coreId, expected.homeos],
    [expected.sntss.coreId, expected.sntss]
  ]);
  const harness = {
    runtimeRevision: 147,
    homeosNeutralBirthAuthorization: 'AUTHORIZE_R143_HOMEOS_NEUTRAL_BIRTH_ONLY',
    metabHomeosRouteAuthorization: 'AUTHORIZE_R144_METAB_HOMEOS_ROUTE_ONLY',
    homeosShadowPromotionAuthorization: 'AUTHORIZE_R145_HOMEOS_OUTPUT_FIREWALLED_SHADOW_ONLY',
    homeosStrandedR147RecoveryAuthorization: expected.authorization,
    homeosFinalR146RecoveryActive: false,
    homeosFinalR147RecoveryActive: false,
    fetusEmptyInputR147RecoveryActive: false,
    r147HomeosContinuationRecoveryActive: false,
    r147DeferredResidentRecovery: false,
    p1ExpansionFetusInstallRevisionPreservation: null,
    exactR146FetusContinuityCohort: () => ({ valid: true, resolved: true }),
    stateStore: {
      getResident: residencyId => residents[residencyId] || null,
      getBiologicalConsumer: residencyId => consumers[residencyId] || null,
      listAuthority: () => [],
      db: {
        prepare: sql => ({
          get: (...args) => {
            if (sql.includes('FROM resident_checkpoints')) {
              const fence = residents[args[0]];
              return fence && {
                checkpoint_id: fence.checkpointId,
                instance_id: fence.instanceId,
                version: fence.version,
                state_schema: fence.stateSchema,
                generation: fence.checkpointGeneration,
                blob_hash: fence.checkpointHash,
                byte_length: fence.checkpointBytes,
                input_cursor: fence.inputCursor
              };
            }
            if (sql.includes("status!='ACKED'")) return { count: 6 };
            if (sql.includes('biological_outbox_intents')) return { count: 0 };
            if (sql.includes('COALESCE(MAX(sequence),0)')) return { value: expected.highWater };
            if (sql.includes("status='PENDING'")) {
              const fence = residents[args[0]];
              return {
                count: fence.pendingCount,
                minimum: fence.firstPendingSequence,
                maximum: fence.lastPendingSequence
              };
            }
            if (sql.includes("type='resident.resync-required'")) {
              const fence = byCore.get(args[0]);
              return fence && {
                id: fence.failureRecordId,
                detail_json: JSON.stringify({
                  residencyId: fence.residencyId,
                  sequence: fence.failureSequence,
                  code: fence.failureCode
                })
              };
            }
            if (sql.includes('ORDER BY id DESC LIMIT 1') &&
                !sql.includes("type='biological.consumer-resynchronized'")) {
              return { id: expected.latestRecoveryRecordId, type: 'resident.resync-required', core_id: 'HOMEOS' };
            }
            if (sql.includes("type='biological.consumer-resynchronized'")) {
              return {
                id: expected.fetusResolutionRecordId,
                detail_json: JSON.stringify({
                  cohort: 'r146-fetus-empty-input-continuity-v1',
                  toCursor: 4574204,
                  abandonedCount: 0,
                  inventedBiologicalTime: false,
                  authorityChanged: false
                })
              };
            }
            if (sql.includes("key='life:p1-r0-metab-capacity-source'")) {
              return {
                json: capacityJson,
                sha256: crypto.createHash('sha256').update(capacityJson).digest('hex')
              };
            }
            return null;
          }
        })
      }
    }
  };
  return { expected, harness, residents };
}

function insertEvent(store, sequence, topic, deduplicationKey) {
  store.db.prepare(`INSERT INTO biological_events(
    sequence,event_id,topic,event_class,at_ms,deadline_at_ms,envelope_json,
    envelope_sha256,payload_sha256,provenance_sha256,deduplication_key,
    deduplication_sha256,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    sequence, `evt-r147-${sequence}`, topic, 'durable', sequence, null, '{}',
    crypto.createHash('sha256').update(`envelope:${sequence}`).digest('hex'),
    crypto.createHash('sha256').update(`payload:${sequence}`).digest('hex'),
    crypto.createHash('sha256').update(`provenance:${sequence}`).digest('hex'),
    deduplicationKey,
    crypto.createHash('sha256').update(`dedup:${deduplicationKey}`).digest('hex'), AT
  );
}

test('R147-CONTINUATION-01 preserves only the exact stopped six-delivery cohort', () => {
  const { expected, harness, residents } = continuationHarness();
  assert.equal(
    LivingKernel.prototype.preserveExactR147HomeosContinuationRevision.call(harness),
    true
  );
  assert.equal(harness.r147DeferredResidentRecovery, true);
  assert.equal(harness.r147HomeosContinuationRecoveryActive, true);
  assert.equal(harness.p1ExpansionFetusInstallRevisionPreservation, 147);

  residents['resident:sntss'].checkpointHash = `f${expected.sntss.checkpointHash.slice(1)}`;
  harness.r147DeferredResidentRecovery = false;
  assert.equal(
    LivingKernel.prototype.preserveExactR147HomeosContinuationRevision.call(harness),
    false
  );
  assert.equal(harness.r147DeferredResidentRecovery, false);
});

test('R147-CONTINUATION-02 exact HOMEOS and SNTSS admission is atomic and bounded at 1023', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r147-continuation-'));
  const store = new StateStore(root);
  await store.init();
  t.after(async () => {
    try { store.close(); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });
  const expected = R147_HOMEOS_CONTINUATION_RECOVERY;
  const fences = [expected.homeos, expected.sntss];
  store.withTransaction(() => {
    for (const fence of fences) {
      store.db.prepare(`INSERT INTO resident_instances(
        residency_id,core_id,role,instance_id,version,state_schema,module_relative_path,
        module_hash,manifest_hash,package_policy_hash,organism_identity_hash,
        checkpoint_hash,checkpoint_generation,status,attached_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        fence.residencyId, fence.coreId, 'optional', fence.instanceId, fence.version,
        fence.stateSchema, fence.moduleRelativePath, fence.moduleHash, fence.manifestHash,
        fence.packagePolicyHash, IDENTITY_HASH, fence.checkpointHash,
        fence.checkpointGeneration, fence.status, AT, AT
      );
      store.db.prepare(`INSERT INTO resident_checkpoints(
        checkpoint_id,residency_id,instance_id,version,state_schema,generation,
        blob_hash,byte_length,input_cursor,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        fence.checkpointId, fence.residencyId, fence.instanceId, fence.version,
        fence.stateSchema, fence.checkpointGeneration, fence.checkpointHash,
        fence.checkpointBytes, fence.inputCursor, AT
      );
      const topics = fence === expected.homeos
        ? ['metab.energy.availability.v1', 'metab.energy.reserve.v1',
          'runtime.homeos.shadow-activation', 'runtime.organism.binding']
        : ['runtime.organism.binding', 'runtime.sntss.continuity-genesis', 'runtime.time.pulse'];
      store.db.prepare(`INSERT INTO biological_consumers(
        consumer_id,core_id,required,active,topics_json,topics_sha256,cursor,
        authority_epoch,checkpoint_hash,registered_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        fence.residencyId, fence.coreId, 0, 0, JSON.stringify(topics), fence.topicsHash,
        fence.consumerCursor, 0, fence.checkpointHash, AT, AT
      );
    }

    for (let sequence = 4574291; sequence <= 4574782; sequence += 1) {
      const topic = sequence % 2 === 0
        ? 'metab.energy.reserve.v1' : 'metab.energy.availability.v1';
      const exact = PENDING['resident:homeos'].find(value => value.sequence === sequence);
      insertEvent(store, sequence, topic, exact?.deduplicationKey || `homeos:${sequence}`);
    }
    const sntssSequences = [];
    for (let sequence = 4574212; sequence <= 4574290; sequence += 1) sntssSequences.push(sequence);
    for (let sequence = 4574783; sequence <= 4574964; sequence += 1) sntssSequences.push(sequence);
    assert.equal(sntssSequences.length, expected.sntss.eligibleReplayCount);
    for (const sequence of sntssSequences) {
      const exact = PENDING['resident:sntss'].find(value => value.sequence === sequence);
      insertEvent(store, sequence, 'runtime.time.pulse', exact?.deduplicationKey || `sntss:${sequence}`);
    }
    insertEvent(store, expected.highWater, 'unrelated.topic', 'r147:high-water');
    for (const fence of fences) {
      for (const pending of PENDING[fence.residencyId]) {
        store.db.prepare(`INSERT INTO biological_deliveries(sequence,consumer_id,status)
          VALUES(?,?,'PENDING')`).run(pending.sequence, fence.residencyId);
      }
      store.db.prepare(`INSERT INTO recovery_records(id,type,core_id,detail_json,created_at)
        VALUES(?,?,?,?,?)`).run(
        fence.failureRecordId, 'resident.resync-required', fence.coreId,
        JSON.stringify({
          residencyId: fence.residencyId,
          sequence: fence.failureSequence,
          code: fence.failureCode
        }), AT
      );
    }
  });

  assert.throws(() => store.beginExactR147ContinuationBacklogReplay({
    residencyId: expected.homeos.residencyId,
    coreId: expected.homeos.coreId,
    checkpointHash: expected.homeos.checkpointHash,
    runtimeRevision: 147,
    maximumPending: 1024
  }), { code: 'P1_R147_CONTINUATION_REPLAY_CONTRACT' });

  for (const fence of fences) {
    const record = store.beginExactR147ContinuationBacklogReplay({
      residencyId: fence.residencyId,
      coreId: fence.coreId,
      checkpointHash: fence.checkpointHash,
      runtimeRevision: 147,
      maximumPending: 1023
    });
    assert.equal(record.pendingCount, fence.pendingCount);
    assert.equal(record.eligibleReplayCount, fence.eligibleReplayCount);
    assert.equal(record.maximumPending, 1023);
    assert.equal(record.abandonedCount, 0);
    assert.equal(record.inventedBiologicalTime, false);
    assert.equal(record.authorityChanged, false);
    assert.equal(store.getResident(fence.residencyId).status, 'RECOVERING');
  }
  assert.equal(store.db.prepare(`SELECT COUNT(*) count FROM biological_deliveries
    WHERE status='PENDING'`).get().count, 6);
  assert.equal(store.db.prepare(`SELECT COUNT(*) count FROM biological_deliveries
    WHERE status='ACKED'`).get().count, 0);
  assert.equal(store.db.prepare(`SELECT COUNT(*) count FROM biological_outbox_intents
    WHERE status='PENDING'`).get().count, 0);
});

test('R147-CONTINUATION-03 fetus installs before sequential recovery and HTTP exposure', async () => {
  const calls = [];
  const harness = {
    r147DeferredResidentRecovery: true,
    r147HomeosContinuationRecoveryActive: true,
    runtimeRevision: 147,
    p1ExpansionFetusInstallPreserved: true,
    heartbeatTimer: null,
    snapshotTimer: null,
    recoverDurableResidents: async () => {
      calls.push('ordinary');
      return [
        { residencyId: 'resident:chronobiology', recovered: true },
        { residencyId: 'resident:sntss', skipped: true, status: 'RESYNC_REQUIRED' },
        { residencyId: 'resident:metab', recovered: true },
        { residencyId: 'resident:homeos', skipped: true, status: 'RESYNC_REQUIRED' }
      ];
    },
    recoverColdFailedResidents: async () => {
      calls.push('cold');
      return [
        { residencyId: 'resident:homeos', recovered: true, abandonedCount: 0 },
        { residencyId: 'resident:sntss', recovered: true, abandonedCount: 0 }
      ];
    },
    startMaintenance: () => calls.push('maintenance'),
    statusCache: {}
  };
  await LivingKernel.prototype.completeExactR147DeferredResidentRecovery.call(harness);
  assert.deepEqual(calls, ['ordinary', 'cold', 'maintenance']);
  assert.equal(harness.r147DeferredResidentRecovery, false);
  assert.equal(harness.lastResidentRecovery.length, 6);

  const server = await fs.readFile(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  const fetus = server.indexOf('await kernel.installCore(process.env.STAY_BOOT_CORE);');
  const recovery = server.indexOf('await kernel.completeExactR147DeferredResidentRecovery();');
  const listen = server.indexOf('server.listen(port, host');
  assert.ok(fetus >= 0 && recovery > fetus && listen > recovery);

  const recoveryScript = await fs.readFile(path.resolve(__dirname, '..', 'deploy',
    'live-physiology-transplant', 'p1-r150-homeos-intero-forward-recovery.sh'), 'utf8');
  const preflight = await fs.readFile(path.resolve(__dirname, '..', 'deploy',
    'live-physiology-transplant', 'p1-r147-homeos-continuation-preflight.js'), 'utf8');
  assert.match(recoveryScript, /AUTHORIZE_R147_HOMEOS_SEQUENTIAL_CONTINUATION_RECOVERY_ONLY/);
  assert.match(recoveryScript, /AUTHORIZE_STRANDED_R147_HOMEOS_CONTINUATION_RECOVERY_ONLY/);
  assert.match(recoveryScript, /p1-r147-homeos-continuation-preflight\.js/);
  assert.match(recoveryScript, /systemctl stop stay\.service/);
  assert.doesNotMatch(`${recoveryScript}\n${preflight}`,
    /handlerTimeoutMs=|hardRamBytes=|hardCpuDuty=|TimeoutStartSec|TimeoutStopSec/);

  const resolved = { resolved: true, abandonedCount: 0 };
  const fetusHarness = {
    fetusEmptyInputR147RecoveryActive: true,
    homeosFinalR147RecoveryActive: true,
    runtimeRevision: 147,
    homeosStrandedR147RecoveryAuthorization: R147_HOMEOS_CONTINUATION_RECOVERY.authorization,
    exactR146FetusContinuityCohort: () => ({ valid: true, resolved: true, resolutionDetail: resolved })
  };
  assert.deepEqual(
    await LivingKernel.prototype.repairExactR146FetusEmptyInputContinuity.call(fetusHarness),
    { ...resolved, idempotent: true }
  );
});
