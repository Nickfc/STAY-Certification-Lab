#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { inspectCoreModule } = require('../../runtime/kernel/core-loader');
const {
  CoreHostClient,
  COREHOST_IPC_MARGIN_MS
} = require('../../runtime/kernel/core-host-client');
const { stableStringify } = require('../../runtime/kernel/canonical-json');

const DATABASE = process.env.STAY_DATABASE || '/var/lib/stay/data/continuity.sqlite3';
const RELEASE_ROOT = path.resolve(__dirname, '../..');
const I4_MODULE = path.join(RELEASE_ROOT, 'cores/sntss/i4g/index.js');
const FIXTURE_MODULE = path.join(__dirname, 'p1-production-hardening-fixture.js');
const EXPECTED_POLICY = 'sha256:ba12622fcc9c782c8c48f0544a5b019c96dc198dcbb7fb209c1dad47de64639d';
const EXPECTED_PARENT_FREEZE = 'sha256:78021d86da8038e298fedb46b7371a46e1bc1e4d1cb0624205a864877ca22875';
const ACCELERATED_PULSE_COUNT = 5_000;
const SUSTAINED_PULSE_INTERVAL_MS = 50;
const MINIMUM_CERTIFIED_ACCELERATION_FACTOR = 2;
const CPU_PACING_TARGET_RATIO = 0.5;
const CPU_BACKPRESSURE_THRESHOLD_RATIO = 0.75;
const CPU_BACKPRESSURE_SAMPLE_MARGIN_MS = 50;
const CANDIDATE_INSPECTION_ONLY = '--candidate-inspection-only';
const MIB = 1024 * 1024;

function fail(message, code = 'P1_PRODUCTION_HARDENING_PREFLIGHT') {
  throw Object.assign(new Error(message), { code });
}

function targetRevision() {
  const value = Number(process.env.STAY_PRODUCTION_HARDENING_TARGET_REVISION || 111);
  if (![111, 114].includes(value)) {
    fail('production-hardening target revision is invalid', 'P1_PREFLIGHT_REVISION');
  }
  return value;
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function assert(condition, message, code) {
  if (!condition) fail(message, code);
}

function readLiveCheckpoint() {
  const database = new DatabaseSync(DATABASE, { open: true, readOnly: true });
  database.exec('PRAGMA query_only=ON');
  try {
    const quickCheck = database.prepare('PRAGMA quick_check').get()?.quick_check;
    const resident = database.prepare(`
      SELECT residency_id, instance_id, core_id, module_relative_path,
             version, state_schema, package_policy_hash, status,
             checkpoint_generation, checkpoint_hash
      FROM resident_instances
      WHERE residency_id='resident:sntss'
    `).get() || null;
    assert(quickCheck === 'ok', 'live SQLite quick-check failed', 'P1_PREFLIGHT_SQLITE');
    assert(
      resident?.core_id === 'sntss' &&
      resident.version === '0.5.0-i4g1' &&
      Number(resident.state_schema) === 5 &&
      resident.module_relative_path === 'cores/sntss/i4g/index.js' &&
      resident.package_policy_hash === EXPECTED_POLICY &&
      Number(resident.checkpoint_generation) >= 1,
      'live I4-G1 resident identity is invalid',
      'P1_PREFLIGHT_LIVE_IDENTITY'
    );
    const checkpoint = database.prepare(`
      SELECT generation, version, state_schema, blob_hash
      FROM resident_checkpoints
      WHERE residency_id=? AND generation=? AND blob_hash=?
    `).get(
      resident.residency_id,
      resident.checkpoint_generation,
      resident.checkpoint_hash
    ) || null;
    assert(checkpoint, 'live I4-G1 checkpoint row is missing', 'P1_PREFLIGHT_CHECKPOINT');
    const blobPath = path.join(
      path.dirname(DATABASE),
      'blobs',
      'sha256',
      checkpoint.blob_hash.slice(0, 2),
      checkpoint.blob_hash
    );
    const bytes = fs.readFileSync(blobPath);
    assert(
      sha256(bytes) === `sha256:${checkpoint.blob_hash}`,
      'live I4-G1 checkpoint digest is invalid',
      'P1_PREFLIGHT_CHECKPOINT_DIGEST'
    );
    const state = JSON.parse(bytes.toString('utf8'));
    assert(
      state.stateSchema === 5 &&
      state.coreVersion === '0.5.0-i4g1' &&
      state.individuality?.type === 'SNTSS_CONTINUITY_GENESIS' &&
      state.individuality?.authorization === 'R13_SNTSS_CONTINUITY_GENESIS_SHADOW' &&
      state.individuality?.parentFreezeRevision === 105 &&
      state.individuality?.parentFreezeRecordSha256 === EXPECTED_PARENT_FREEZE &&
      state.individuality?.authorityMode === 'NONE' &&
      state.individuality?.outputs === 0,
      'live I4-G1 checkpoint physiology identity is invalid',
      'P1_PREFLIGHT_CHECKPOINT_IDENTITY'
    );
    return { resident, checkpoint, state };
  } finally {
    database.close();
  }
}

function silentLogger() {
  return Object.freeze({ log() {}, info() {}, warn() {}, error() {} });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sustainedPulsePacing({ dispatchElapsedMs, resourceGovernor } = {}) {
  const elapsedMs = Math.max(0, Number(dispatchElapsedMs) || 0);
  const policy = resourceGovernor?.policy || {};
  const latest = resourceGovernor?.latest || {};
  const hardCpuDuty = Number(policy.hardCpuDuty);
  const sampleIntervalMs = Number(policy.sampleIntervalMs);
  assert(
    Number.isFinite(hardCpuDuty) && hardCpuDuty > 0 && hardCpuDuty <= 1 &&
    Number.isFinite(sampleIntervalMs) && sampleIntervalMs >= 250,
    'I4-G1 resource pacing contract is invalid',
    'P1_PREFLIGHT_I4_PACING_POLICY'
  );
  const targetCpuDuty = hardCpuDuty * CPU_PACING_TARGET_RATIO;
  const observedAverageDuty = latest.cpuEvidence?.averageDuty;
  const observedInstantDuty = latest.cpuDuty;
  const averageReady = latest.cpuEvidence?.ready === true &&
    Number.isFinite(observedAverageDuty);
  const approachingHardFence =
    (averageReady && observedAverageDuty >= hardCpuDuty * CPU_BACKPRESSURE_THRESHOLD_RATIO) ||
    (Number.isFinite(observedInstantDuty) && observedInstantDuty >= hardCpuDuty);
  const workAwareDelayMs = Math.max(
    SUSTAINED_PULSE_INTERVAL_MS,
    Math.ceil(elapsedMs / targetCpuDuty) - elapsedMs
  );
  const delayMs = approachingHardFence
    ? Math.max(workAwareDelayMs, sampleIntervalMs + CPU_BACKPRESSURE_SAMPLE_MARGIN_MS)
    : workAwareDelayMs;
  return Object.freeze({
    delayMs,
    targetCpuDuty,
    hardCpuDuty,
    approachingHardFence,
    observedAverageDuty: averageReady ? observedAverageDuty : null,
    observedInstantDuty: Number.isFinite(observedInstantDuty) ? observedInstantDuty : null
  });
}

function assertExecutionBoundary() {
  assert(process.env.STAY_REQUIRE_OS_CORE_SANDBOX === '1', 'OS sandbox must be required', 'P1_PREFLIGHT_OS_SANDBOX');
  assert(process.env.STAY_REQUIRE_CORE_PACKAGE_POLICY === '1', 'package policy must be required', 'P1_PREFLIGHT_PACKAGE_POLICY');
  assert(process.env.STAY_REQUIRE_CGROUPS !== '1', 'isolated preflight must not mutate live cgroups', 'P1_PREFLIGHT_CGROUP_SCOPE');
  assert(fs.existsSync(process.env.STAY_BWRAP || ''), 'certified bubblewrap helper is missing', 'P1_PREFLIGHT_BWRAP');
}

async function inspectFrozenI4() {
  const definition = await inspectCoreModule(I4_MODULE);
  assert(
    definition.manifest.coreId === 'sntss' &&
    definition.manifest.version === '0.5.0-i4g1' &&
    definition.manifest.stateSchema === 5,
    'candidate I4-G1 inspection differs from the frozen identity',
    'P1_PREFLIGHT_I4_INSPECTION'
  );
  return definition;
}

async function proveFrozenI4(live) {
  const revision = targetRevision();
  const definition = await inspectFrozenI4();
  const client = new CoreHostClient({
    modulePath: definition.modulePath,
    expectedManifest: definition.manifest,
    instanceId: `p1-r${revision}-i4g-preflight`,
    mode: 'standby',
    logger: silentLogger(),
    policy: {
      resources: definition.manifest.resources,
      priority: definition.manifest.priority
    }
  });
  let outputs = 0;
  const resourceWarnings = [];
  const lifecycleTransitions = [];
  const clientErrors = [];
  client.on('output', () => { outputs += 1; });
  client.on('resource-warning', detail => { resourceWarnings.push(detail); });
  client.on('lifecycle', (lifecycle, detail) => {
    lifecycleTransitions.push({ lifecycle, detail: detail || null });
  });
  client.on('error', error => {
    clientErrors.push({ code: error?.code || null, message: error?.message || String(error) });
  });
  try {
    await client.start(live.state, 5);
    const initial = await client.snapshot();
    assert(
      stableStringify(initial) === stableStringify(live.state),
      'candidate I4-G1 does not exactly reconstruct the live checkpoint',
      'P1_PREFLIGHT_I4_REPLAY'
    );
    const initialHealth = await client.health();
    assert(initialHealth?.ok === true, 'candidate I4-G1 health failed', 'P1_PREFLIGHT_I4_HEALTH');
    const startingClock = Number(initial.chemistry?.modelClock);
    assert(
      Number.isSafeInteger(startingClock) &&
      startingClock === Number(initial.receptorAdaptation?.modelClock) &&
      startingClock === Number(initial.receptorAvailability?.modelClock),
      'candidate I4-G1 physiology clocks are inconsistent',
      'P1_PREFLIGHT_I4_CLOCK'
    );
    const anchorWallClock = Number(initial.trustedTime?.lastWallClockMs) + 60_000;
    const anchored = await client.dispatch({
      id: `p1-r${revision}-preflight-anchor`,
      sequence: 1,
      class: 'durable',
      topic: 'runtime.time.pulse',
      at: anchorWallClock,
      ledger: { durable: true },
      payload: {
        wallClockMs: anchorWallClock,
        runtimeRevision: revision,
        pulseSequence: 1,
        clockStatus: 'trusted'
      },
      meta: { sourceCore: 'living-kernel', authorityEpoch: revision }
    }, { eventSequence: 1, eventId: `p1-r${revision}-preflight-anchor` });
    client.setRecoveryState(anchored.checkpoint, 5);
    const acceleratedStartedAt = Date.now();
    let advanced = null;
    let maximumPulseDelayMs = 0;
    let resourceBackpressureEvents = 0;
    for (let index = 1; index <= ACCELERATED_PULSE_COUNT; index += 1) {
      const wallClockMs = anchorWallClock + index * 250;
      const eventId = `p1-r${revision}-preflight-pulse-${index + 1}`;
      const dispatchStartedAt = Date.now();
      advanced = await client.dispatch({
        id: eventId,
        sequence: index + 1,
        class: 'durable',
        topic: 'runtime.time.pulse',
        at: wallClockMs,
        ledger: { durable: true },
        payload: {
          wallClockMs,
          runtimeRevision: revision,
          pulseSequence: index + 1,
          clockStatus: 'trusted'
        },
        meta: { sourceCore: 'living-kernel', authorityEpoch: revision }
      }, { eventSequence: index + 1, eventId });
      client.setRecoveryState(advanced.checkpoint, 5);
      if (index < ACCELERATED_PULSE_COUNT) {
        const host = client.status();
        assert(
          client.generation === 1 && host.resourceGovernor?.lastAction == null,
          `I4-G1 crossed a hard resource fence during sustained preflight: ${JSON.stringify({
            generation: client.generation,
            lifecycle: host.lifecycle,
            lastExit: host.lastExit,
            resourceGovernor: host.resourceGovernor
          })}`,
          'P1_PREFLIGHT_I4_RESOURCE_FENCE'
        );
        const pacing = sustainedPulsePacing({
          dispatchElapsedMs: Date.now() - dispatchStartedAt,
          resourceGovernor: host.resourceGovernor
        });
        maximumPulseDelayMs = Math.max(maximumPulseDelayMs, pacing.delayMs);
        if (pacing.approachingHardFence) resourceBackpressureEvents += 1;
        await delay(pacing.delayMs);
      }
    }
    const acceleratedElapsedMs = Date.now() - acceleratedStartedAt;
    const final = advanced.checkpoint;
    for (const value of [
      final.chemistry?.modelClock,
      final.receptorAdaptation?.modelClock,
      final.receptorAvailability?.modelClock
    ]) {
      assert(
        Number(value) === startingClock + 1_250_000,
        'I4-G1 exact clock advance failed',
        'P1_PREFLIGHT_I4_ADVANCE'
      );
    }
    assert(
      stableStringify(final.individuality) === stableStringify(initial.individuality),
      'I4-G1 individuality changed during isolated proof',
      'P1_PREFLIGHT_I4_INDIVIDUALITY'
    );
    const host = client.status();
    const memoryPlan = host.resourceGovernor?.policy?.memoryPlan;
    const supervisorRssBytes = Number(host.resourceGovernor?.latest?.rssBytes);
    const hostDiagnostic = JSON.stringify({
      generation: client.generation,
      lifecycle: host.lifecycle,
      lastExit: host.lastExit,
      resourceGovernor: host.resourceGovernor,
      resourceWarnings: resourceWarnings.slice(-8),
      lifecycleTransitions,
      clientErrors
    });
    assert(
      client.generation === 1,
      `I4-G1 recycled during sustained preflight: ${hostDiagnostic}`,
      'P1_PREFLIGHT_I4_RECYCLE'
    );
    assert(
      outputs === 0 && client.generation === 1 &&
      acceleratedElapsedMs >= (ACCELERATED_PULSE_COUNT - 1) * SUSTAINED_PULSE_INTERVAL_MS &&
      acceleratedElapsedMs <=
        (ACCELERATED_PULSE_COUNT * 250) / MINIMUM_CERTIFIED_ACCELERATION_FACTOR &&
      host.resourceGovernor?.lastAction == null &&
      Number(memoryPlan?.supervisorHardBytes) === 64 * MIB &&
      Number(memoryPlan?.supervisorOldSpaceMiB) === 12 &&
      Number(memoryPlan?.supervisorSemiSpaceMiB) === 1 &&
      Number.isFinite(supervisorRssBytes) && supervisorRssBytes > 0 &&
      supervisorRssBytes < 64 * MIB &&
      host.deadlineContract?.eventAndCheckpointCombined === true &&
      host.deadlineContract?.outputsReleasedAfterCheckpoint === true &&
      host.deadlineContract?.declaredHandlerTimeoutMs === 250 &&
      host.deadlineContract?.workerTransitionTimeoutMs === 250 &&
      host.deadlineContract?.ipcTransitionTimeoutMs === 250 + COREHOST_IPC_MARGIN_MS,
      'I4-G1 hardened host contract is invalid',
      'P1_PREFLIGHT_I4_HOST_CONTRACT'
    );
    return {
      checkpointGeneration: Number(live.checkpoint.generation),
      checkpointSha256: `sha256:${live.checkpoint.blob_hash}`,
      sourceTreePolicySha256: EXPECTED_POLICY,
      startingClock,
      endingClock: startingClock + 1_250_000,
      pulseCount: ACCELERATED_PULSE_COUNT,
      outputs,
      targetRevision: revision,
      hostGeneration: client.generation,
      supervisorRssBytes,
      osSandboxRequired: process.env.STAY_REQUIRE_OS_CORE_SANDBOX === '1',
      acceleratedWorkload: {
        pacing: 'RESOURCE_AWARE_COMMIT_FENCED',
        baselinePulseDelayMs: SUSTAINED_PULSE_INTERVAL_MS,
        maximumAccelerationFactor: 250 / SUSTAINED_PULSE_INTERVAL_MS,
        minimumCertifiedAccelerationFactor: MINIMUM_CERTIFIED_ACCELERATION_FACTOR,
        cpuPacingTargetDuty: Number(host.resourceGovernor?.policy?.hardCpuDuty) *
          CPU_PACING_TARGET_RATIO,
        resourceBackpressureEvents,
        maximumPulseDelayMs,
        recoveryWatermarkAdvancedPerCheckpoint: true,
        elapsedMs: acceleratedElapsedMs,
        resourceGovernorHardAction: host.resourceGovernor?.lastAction || null,
        resourceWarnings: resourceWarnings.slice(-8),
        lifecycleTransitions,
        clientErrors
      }
    };
  } finally {
    await client.stop().catch(() => {});
  }
}

async function proveFaultContainment() {
  const previous = process.env.STAY_REQUIRE_CORE_PACKAGE_POLICY;
  process.env.STAY_REQUIRE_CORE_PACKAGE_POLICY = '0';
  const fixture = require(FIXTURE_MODULE);
  const client = new CoreHostClient({
    modulePath: FIXTURE_MODULE,
    expectedManifest: fixture.manifest,
    instanceId: 'p1-r111-fault-preflight',
    mode: 'standby',
    logger: silentLogger(),
    policy: { resources: fixture.manifest.resources, priority: fixture.manifest.priority }
  });
  if (previous == null) delete process.env.STAY_REQUIRE_CORE_PACKAGE_POLICY;
  else process.env.STAY_REQUIRE_CORE_PACKAGE_POLICY = previous;
  const outputs = [];
  client.on('output', message => outputs.push(message));
  client.on('error', () => {});
  try {
    await client.start({ count: 0 }, 1);
    const failedGeneration = client.generation;
    let failure = null;
    try {
      await client.dispatch({
        id: 'forced-uncommitted-transition',
        sequence: 1,
        class: 'durable',
        topic: 'test.event',
        payload: {
          mutateBeforeDelay: true,
          emitBeforeDelay: true,
          neverSettle: true
        }
      }, { eventSequence: 1, eventId: 'forced-uncommitted-transition' });
    } catch (error) { failure = error; }
    assert(
      ['CORE_WORKER_TIMEOUT', 'COREHOST_TIMEOUT'].includes(failure?.code),
      `forced fault did not cross a bounded worker deadline: ${failure?.code || 'NO_FAILURE'}`,
      'P1_PREFLIGHT_FAULT_DEADLINE'
    );
    await client.ensureRecovery(failure);
    assert(
      client.generation > failedGeneration && outputs.length === 0,
      'fault recovery leaked output or failed to advance generation',
      'P1_PREFLIGHT_FAULT_RECOVERY'
    );
    const committed = await client.dispatch({
      id: 'replayed-committed-transition',
      sequence: 1,
      class: 'durable',
      topic: 'test.event',
      payload: { emitBeforeDelay: true }
    }, { eventSequence: 1, eventId: 'replayed-committed-transition' });
    assert(
      committed.checkpoint?.count === 1 && outputs.length === 1 &&
      outputs[0]?.payload?.count === 0,
      'post-recovery transition is not exactly-once',
      'P1_PREFLIGHT_FAULT_EXACT_ONCE'
    );
    return {
      observedFailureCode: failure.code,
      failedGeneration,
      recoveredGeneration: client.generation,
      speculativeOutputsReleased: 0,
      committedOutputsReleased: outputs.length,
      committedCount: committed.checkpoint.count
    };
  } finally {
    await client.stop().catch(() => {});
  }
}

async function main(args = process.argv.slice(2)) {
  assert(
    args.length === 0 || (args.length === 1 && args[0] === CANDIDATE_INSPECTION_ONLY),
    'unsupported preflight arguments',
    'P1_PREFLIGHT_ARGUMENTS'
  );
  assertExecutionBoundary();
  if (args[0] === CANDIDATE_INSPECTION_ONLY) {
    const definition = await inspectFrozenI4();
    process.stdout.write(JSON.stringify({
      format: 'stay-production-hardening-entry-path-v1',
      result: 'PASS',
      releaseRoot: RELEASE_ROOT,
      targetRevision: targetRevision(),
      osSandboxRequired: true,
      packagePolicyRequired: true,
      cgroupMutationDisabled: true,
      coreId: definition.manifest.coreId,
      version: definition.manifest.version,
      stateSchema: definition.manifest.stateSchema
    }) + '\n');
    return;
  }
  const live = readLiveCheckpoint();
  const i4 = await proveFrozenI4(live);
  const faultContainment = await proveFaultContainment();
  const result = {
    format: 'stay-production-hardening-preflight-v1',
    result: 'PASS',
    capturedAt: new Date().toISOString(),
    releaseRoot: RELEASE_ROOT,
    targetRevision: targetRevision(),
    liveDatabaseReadOnly: true,
    i4,
    faultContainment
  };
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (require.main === module) main().catch(error => {
  console.error(`P1_PRODUCTION_HARDENING_PREFLIGHT_ABORT=${error.code || 'FAILED'}:${error.message}`);
  process.exitCode = 1;
});

module.exports = {
  assertExecutionBoundary,
  inspectFrozenI4,
  readLiveCheckpoint,
  sustainedPulsePacing,
  proveFrozenI4,
  proveFaultContainment,
  main
};
