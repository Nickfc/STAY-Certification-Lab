'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { stableStringify } = require('../runtime/kernel/canonical-json');
const { BASELINE, REPAIR } = require(
  '../deploy/live-physiology-transplant/p1-r119f-chronobiology-bounded-catchup-repair');
const { EXPECTED_SNTSS, verify } = require(
  '../deploy/live-physiology-transplant/p1-r119f-live-proof');
const freeze = require('../deploy/live-physiology-transplant/p1-r119f-freeze');
const { LivingKernel } = require('../runtime/kernel/living-kernel');

const root = path.resolve(__dirname, '..');

function resident({ chrono = false, repaired = false, generation = null } = {}) {
  if (chrono) {
    const identity = repaired ? REPAIR : BASELINE;
    return {
      residency_id: BASELINE.residencyId,
      core_id: BASELINE.coreId,
      instance_id: BASELINE.instanceId,
      version: identity.version,
      state_schema: BASELINE.stateSchema,
      module_relative_path: identity.moduleRelativePath,
      module_hash: identity.moduleHash,
      manifest_hash: identity.manifestHash,
      package_policy_hash: identity.packagePolicyHash,
      checkpoint_generation: generation ?? identity.checkpointGeneration,
      checkpoint_hash: BASELINE.checkpointHash,
      status: repaired ? 'RUNNING' : BASELINE.status,
    };
  }
  return {
    residency_id: 'resident:sntss',
    core_id: 'sntss',
    instance_id: EXPECTED_SNTSS.instanceId,
    version: EXPECTED_SNTSS.version,
    state_schema: EXPECTED_SNTSS.stateSchema,
    module_relative_path: EXPECTED_SNTSS.moduleRelativePath,
    package_policy_hash: EXPECTED_SNTSS.packagePolicyHash,
    checkpoint_generation: generation ?? 900000,
    checkpoint_hash: 'a'.repeat(64),
    status: 'RUNNING',
  };
}

function before() {
  return {
    quickCheck: 'ok', runtimeRevision: 118, runtimeReason: 'core.install',
    residents: [resident({ chrono: true }), resident()],
    consumers: [{
      consumer_id: BASELINE.residencyId, core_id: BASELINE.coreId,
      required: 0, active: 0, cursor: BASELINE.consumerCursor,
      authority_epoch: 0, checkpoint_hash: BASELINE.checkpointHash,
    }],
    checkpoints: [{
      checkpoint_id: BASELINE.checkpointId,
      residency_id: BASELINE.residencyId,
      instance_id: BASELINE.instanceId,
      version: BASELINE.version,
      state_schema: BASELINE.stateSchema,
      generation: BASELINE.checkpointGeneration,
      blob_hash: BASELINE.checkpointHash,
      byte_length: BASELINE.checkpointByteLength,
      input_cursor: BASELINE.checkpointInputCursor,
    }],
    pendingDeliveries: 0, chronobiologyPendingDeliveries: 0,
    pendingOutboxIntents: 0, sntssOutputRows: 0,
    sntssAuthorityRows: 0, chronobiologyAuthorityRows: 0,
    recoveryHighWaterId: 88,
    chronobiologyCoreFaultsThroughHighWater: 3,
    sntssCoreFaultsThroughHighWater: 2,
    latestImplementationRepair: { id: 87, detail: {
      repairId: 'chronobiology-c3r4-r116-contained-performance',
    } },
    latestResyncRequired: { id: 88, detail: {
      code: 'CORE_WORKER_TIMEOUT', sequence: BASELINE.failedSequence,
    } },
    latestColdReplayBegin: { detail: {
      pendingCount: 4096, abandonedCount: 0, inventedBiologicalTime: false,
    } },
    latestColdReplayComplete: { detail: {
      replayedPendingCount: 4096, abandonedCount: 0, inventedBiologicalTime: false,
    } },
  };
}

function after(source) {
  return {
    ...source,
    runtimeRevision: 119,
    runtimeReason: 'core.install',
    residents: [
      resident({ chrono: true, repaired: true, generation: 5120 }),
      resident({ generation: 900100 }),
    ],
    consumers: [{
      consumer_id: BASELINE.residencyId, core_id: BASELINE.coreId,
      required: 0, active: 1, cursor: BASELINE.consumerCursor + 10,
      authority_epoch: 0, checkpoint_hash: 'b'.repeat(64),
    }],
    checkpoints: [
      ...source.checkpoints,
      {
        checkpoint_id: REPAIR.checkpointId,
        residency_id: BASELINE.residencyId,
        instance_id: BASELINE.instanceId,
        version: REPAIR.version,
        state_schema: REPAIR.stateSchema,
        generation: REPAIR.checkpointGeneration,
        blob_hash: BASELINE.checkpointHash,
        byte_length: source.checkpoints[0].byte_length,
        input_cursor: BASELINE.checkpointInputCursor,
      },
    ],
    recoveryHighWaterId: 93,
    latestImplementationRepair: { id: 89, detail: {
      repairId: REPAIR.repairId,
      instanceId: BASELINE.instanceId,
      sourceCheckpointId: BASELINE.checkpointId,
      checkpointHash: BASELINE.checkpointHash,
      checkpointByteLength: BASELINE.checkpointByteLength,
      checkpointInputCursor: BASELINE.checkpointInputCursor,
      consumerCursor: BASELINE.consumerCursor,
      biologicalStateChanged: false,
      checkpointBytesChanged: false,
      abandonedCount: 0,
      inventedBiologicalTime: false,
      authorityChanged: false,
      resourceLimitsChanged: false,
    } },
    latestBiologicalResync: { id: 90, detail: {
      runtimeRevision: 119, abandonedCount: 0, inventedBiologicalTime: false,
    } },
    latestResidentResync: { id: 92, detail: {
      runtimeRevision: 119, abandonedCount: 0, inventedBiologicalTime: false,
    } },
  };
}

function resourceStatus(chrono = false) {
  return { resident: {
    residencyId: chrono ? BASELINE.residencyId : 'resident:sntss',
    version: chrono ? REPAIR.version : EXPECTED_SNTSS.version,
    status: 'RUNNING', running: true, authorityOwned: false,
    productionEligible: false,
    observedOutputs: 0,
    declaredOutputs: chrono ? 1 : 0,
    handledEvents: 10,
    health: chrono ? { ok: true, stage: 'c3-shadow-jitless-bounded-catchup-repair' } : {
      ok: true, lineageSha256: EXPECTED_SNTSS.lineageSha256,
      biologicalOutputs: 0,
    },
    host: {
      instanceId: chrono ? BASELINE.instanceId : EXPECTED_SNTSS.instanceId,
      resourceGovernor: { policy: {
        softRamBytes: 64 * 1024 * 1024,
        hardRamBytes: 96 * 1024 * 1024,
        softCpuDuty: 0.05, hardCpuDuty: 0.2, queueCapacity: 256,
        handlerTimeoutMs: 250, healthTimeoutMs: 1000,
      } },
      osContainment: { payloadSandboxed: true, limits: {
        'memory.high': String(64 * 1024 * 1024),
        'memory.max': String(96 * 1024 * 1024),
        'pids.max': '16', 'cpu.max': '20000 100000',
      } },
    },
  } };
}

function meta() {
  return {
    ok: true, revision: 119,
    cores: [{ id: 'fetus-legacy', ok: true, memoryGuardian: {
      status: 'healthy', warnAtMiB: 192, recycleAtMiB: 256,
    } }],
    systems: [{ id: 'bsf', mode: 'LIVE', status: 'RUNNING',
      running: true, healthOk: true, writeFailures: 0 }],
    chipProjection: {
      observationOnly: true, mutationEndpoints: [], lifecycle: [
        { coreId: 'bsf', state: 'LIVE' },
        { coreId: 'sntss', state: 'SHADOW' },
        { coreId: 'chronobiology', state: 'SHADOW', version: REPAIR.version },
      ],
    },
  };
}

test('R119F-REL-01 live proof preserves lineage, history, limits, fetus and chip truth', () => {
  const source = before();
  const proof = verify({
    before: source,
    after: after(source),
    sntssStatus: resourceStatus(false),
    chronobiologyStatus: resourceStatus(true),
    meta: meta(),
    service: { beforePid: 100, afterPid: 200, beforeRestarts: 0,
      afterRestarts: 0, restartCommands: 1 },
  });
  assert.equal(proof.result, 'PASS');
  assert.deepEqual(proof.runtime, { fromRevision: 118, recoveryRevision: 119, toRevision: 119 });
  assert.equal(proof.continuity.abandonedCount, 0);
  assert.equal(proof.continuity.inventedBiologicalTime, false);
  assert.deepEqual(proof.chips, { bsf: 'LIVE', sntss: 'SHADOW', chronobiology: 'SHADOW' });
  const leaking = after(source);
  leaking.chronobiologyAuthorityRows = 1;
  assert.throws(() => verify({
    before: source, after: leaking, sntssStatus: resourceStatus(false),
    chronobiologyStatus: resourceStatus(true), meta: meta(),
    service: { beforePid: 100, afterPid: 200, beforeRestarts: 0,
      afterRestarts: 0, restartCommands: 1 },
  }), { code: 'R119F_AFTER_CONTAINMENT' });
  const falseProvenance = after(source);
  falseProvenance.checkpoints.find(value =>
    value.generation === REPAIR.checkpointGeneration).input_cursor = BASELINE.consumerCursor;
  assert.throws(() => verify({
    before: source, after: falseProvenance, sntssStatus: resourceStatus(false),
    chronobiologyStatus: resourceStatus(true), meta: meta(),
    service: { beforePid: 100, afterPid: 200, beforeRestarts: 0,
      afterRestarts: 0, restartCommands: 1 },
  }), { code: 'R119F_AFTER_CHECKPOINT' });
});

test('R119F-REL-02 freeze binds immutable release and acceptance evidence', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-r119f-freeze-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const release = path.join(directory, 'release');
  fs.mkdirSync(release);
  const write = (name, value) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
    return file;
  };
  const source = before();
  const proof = verify({
    before: source, after: after(source),
    sntssStatus: resourceStatus(false), chronobiologyStatus: resourceStatus(true),
    meta: meta(), service: { beforePid: 100, afterPid: 200,
      beforeRestarts: 0, afterRestarts: 0, restartCommands: 1 },
  });
  const record = freeze.capture({
    proof: write('proof.json', proof),
    preflight: write('preflight.json', { result: 'PASS' }),
    'entry-proof': write('entry.json', {
      result: 'PASS', version: '1.0.0-c3rc.5',
      declaredHandlerTimeoutMs: 250, workerTransitionTimeoutMs: 250,
      ipcTransitionTimeoutMs: 1000, elapsedSlicesMs: [1, 1, 1, 1, 1, 1, 1],
      hardCpuPercent: 20, hardRamMiB: 96,
      cgroupRequired: true, payloadCgroupRequired: true,
      payloadCgroupAvailable: true, payloadCpuMax: '20000 100000',
      payloadMemoryHigh: String(64 * 1024 * 1024),
      payloadMemoryMax: String(96 * 1024 * 1024), payloadPidsMax: '16',
      supervisorChargedToKernel: true, payloadAttachedBeforeInit: true,
      payloadProcessCount: 1,
    }),
    'service-proof': write('service.json', { beforePid: 100, afterPid: 200,
      beforeRestarts: 0, afterRestarts: 0, restartCommands: 1 }),
    release,
    'release-tag': 'r119f-v2',
    'release-commit': 'a'.repeat(40),
    'release-tree': 'b'.repeat(40),
    'archive-sha256': `sha256:${'c'.repeat(64)}`,
    'manifest-sha256': `sha256:${'d'.repeat(64)}`,
    'controller-sha256': `sha256:${'e'.repeat(64)}`,
    hostname: 'stay-test',
    'private-ip': '172.26.9.207',
  });
  assert.equal(freeze.verify(record).R119F_FREEZE, 'PASS');
  const corrupt = structuredClone(record);
  corrupt.continuity.abandonedCount = 1;
  assert.throws(() => freeze.verify(corrupt), { code: 'R119F_FREEZE_VERIFY' });
});

test('R119F-REL-03 scripts expose one restart, exact revision progression and no widened limits', () => {
  const read = name => fs.readFileSync(path.join(root,
    'deploy/live-physiology-transplant', name), 'utf8');
  const forward = read('p1-r119f-forward.sh');
  const recovery = read('p1-r119f-forward-recovery.sh');
  const finalize = read('p1-r119f-finalize.sh');
  assert.equal((forward.match(/systemctl restart stay\.service/g) || []).length, 1);
  assert.equal((recovery.match(/systemctl restart stay\.service/g) || []).length, 0);
  assert.equal((finalize.match(/systemctl restart stay\.service/g) || []).length, 0);
  assert.match(forward, /STAY_RECOVER_COLD_RESIDENTS_AT_REVISION=119/);
  assert.match(forward, /durable_runtime_revision\)" == 118/);
  assert.match(forward, /--property=Delegate=yes/);
  assert.match(forward, /STAY_REQUIRE_CGROUPS=1/);
  assert.match(forward, /payloadCpuMax\)" == '20000 100000'/);
  assert.doesNotMatch(forward, /--property=CPUQuota=20%/);
  assert.equal(forward.includes('declaredHandlerTimeoutMs)" == 250'), true);
  assert.match(forward,
    /NON-PRODUCTION C3R3 HISTORICAL IDENTITY AND BIOLOGY[\s\S]*--test-name-pattern='\^C3R3-\(\?:ID\|BIO\)-01'[\s\S]*chronobiology-c3r3-jitless-performance-repair\.test\.js/);
  assert.equal((forward.match(
    /chronobiology-c3r3-jitless-performance-repair\.test\.js/g) || []).length, 2);
  assert.match(forward, /cat "\$WORK\/c3r3-historical-tests\.tap"/);
  assert.doesNotMatch(forward, /test-name-pattern=.*C3R4/);
  assert.doesNotMatch(`${forward}\n${recovery}\n${finalize}`,
    /STAY_RECOVER_COLD_RESIDENTS_AT_REVISION=(?:12[0-9]|[2-9][0-9]{2,})/);
  assert.equal((recovery.match(/systemctl start stay\.service/g) || []).length, 1);
  assert.match(recovery, /revision" == 118[\s\S]*systemctl start stay\.service/);
  assert.match(recovery, /elif \[\[ "\$revision" != 119 \]\]/);
  assert.equal((forward.match(/point_current "\$SOURCE_RELEASE"/g) || []).length, 1);
  assert.doesNotMatch(forward, /chronobiology-bounded-catchup-repair\.js"\s+rollback/);
  assert.match(forward,
    /elif \[\[ "\$COMPLETED" -eq 0 \]\]; then[\s\S]*write_recovery_marker[\s\S]*LEFT_REVISION_FENCED_FOR_FORWARD_RECOVERY/);
  assert.match(forward, /overlay_digest="\$\(\s*cd "\$STAGE_ROOT"[\s\S]*sha256sum "\$file"/);
  assert.doesNotMatch(forward,
    /overlay_digest="\$\([\s\S]{0,240}sha256sum "\$STAGE_ROOT\/\$file"/);
});

test('R119F-REL-04 release manifest is exact for every listed file and carries repair dependencies', () => {
  const manifestFile = path.join(root,
    'deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R118_TO_R119F.sha256');
  const lines = fs.readFileSync(manifestFile, 'utf8').trim().split(/\r?\n/);
  const entries = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  \.\/(.+)$/.exec(line);
    assert.ok(match, `invalid manifest line: ${line}`);
    assert.equal(entries.has(match[2]), false, `duplicate manifest path: ${match[2]}`);
    entries.set(match[2], match[1]);
    const bytes = fs.readFileSync(path.join(root, match[2]));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), match[1], match[2]);
  }
  for (const required of [
    'cores/chronobiology/c3/aggregate.js',
    'cores/chronobiology/c3/index.js',
    'cores/chronobiology/c3r2/index.js',
    'cores/chronobiology/c3r3/index.js',
    'cores/chronobiology/c3r4/index.js',
    'cores/chronobiology/c3r5/index.js',
    'cores/sntss/neutral/index.js',
    'runtime/kernel/core-host-client.js',
    'runtime/kernel/core-loader.js',
    'runtime/kernel/chronobiology-resident-contracts.js',
    'runtime/kernel/living-kernel.js',
    'runtime/kernel/resident-manager.js',
    'deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R110F_TO_R111F.sha256',
    'deploy/live-physiology-transplant/p1-r119f-forward.sh',
    'deploy/live-physiology-transplant/p1-r119f-forward-recovery.sh',
    'deploy/live-physiology-transplant/p1-r119f-chronobiology-bounded-catchup-repair.js',
    'test/p1-r119f-entry-path.test.js',
    'test/p1-r119f-release-contract.test.js',
    'test/chronobiology-c3r5-bounded-catchup-repair.test.js',
    'test/chronobiology-c3r3-jitless-performance-repair.test.js',
    'test/chronobiology-c3r4-topology-performance-repair.test.js',
    'test/chronobiology-c3r4-performance-lab.test.js',
    'scripts/chronobiology-c3r4-performance-lab.js',
    'tools/generate-c3r4-local-kernel.js',
  ]) assert.equal(entries.has(required), true, required);
});

test('R119F-REL-05 durable implementation identity selects only its matching contract', t => {
  const managers = [];
  const makeKernel = durableChronobiology => {
    const kernel = Object.create(LivingKernel.prototype);
    Object.assign(kernel, {
      durableResidentsDisabled: false,
      residentManager: null,
      identity: { organismId: 'stay-r119f-test', createdAt: '2026-08-29T00:00:00.000Z',
        lineage: 'STAY/Genesis' },
      releaseRoot: root,
      stateStore: { getResident(id) {
        if (id === 'resident:sntss') return {
          version: EXPECTED_SNTSS.version,
          stateSchema: EXPECTED_SNTSS.stateSchema,
          moduleRelativePath: EXPECTED_SNTSS.moduleRelativePath,
        };
        return durableChronobiology;
      } },
      fabric: { subscribeAll() { return () => {}; } },
      logger: { log() {}, info() {}, warn() {}, error() {} },
      clock: () => 0,
    });
    const manager = kernel.ensureResidentManager();
    managers.push(manager);
    return manager;
  };
  t.after(async () => {
    await Promise.all(managers.map(manager => manager.shutdown()));
  });
  const repairedManager = makeKernel({
    version: REPAIR.version,
    stateSchema: REPAIR.stateSchema,
    moduleRelativePath: REPAIR.moduleRelativePath,
  });
  assert.equal(repairedManager.contractRegistry.byResidencyId
    .get(BASELINE.residencyId).version, REPAIR.version);
  assert.equal(repairedManager.contractRegistry.byResidencyId
    .get(BASELINE.residencyId).packagePolicyHash, REPAIR.packagePolicyHash);
  const historicalManager = makeKernel({
    version: BASELINE.version,
    stateSchema: BASELINE.stateSchema,
    moduleRelativePath: BASELINE.moduleRelativePath,
  });
  assert.equal(historicalManager.contractRegistry.byResidencyId
    .get(BASELINE.residencyId).version, BASELINE.version);
  assert.equal(historicalManager.contractRegistry.byResidencyId
    .get(BASELINE.residencyId).packagePolicyHash, BASELINE.packagePolicyHash);
});
