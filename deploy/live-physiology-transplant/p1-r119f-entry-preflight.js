#!/usr/bin/env node
'use strict';

const { performance } = require('node:perf_hooks');
const path = require('node:path');

const { CoreHostClient } = require('../../runtime/kernel/core-host-client');
const { inspectCoreModule } = require('../../runtime/kernel/core-loader');

const entrypoint = path.resolve(__dirname, '../../cores/chronobiology/c3r5/index.js');
const FIRST_TARGET_US = 49 * 3_600_000_000;
const PULSE_INTERVAL_US = 250_000;
const EXPECTED_COMMITTED_THROUGH_US = FIRST_TARGET_US + 6 * PULSE_INTERVAL_US;

function transitionFailures(evidence) {
  const failures = [];
  if (evidence.committedThroughUs !== evidence.expectedCommittedThroughUs) {
    failures.push('COMMITTED_THROUGH_US');
  }
  if (evidence.healthOk === false) failures.push('HEALTH');
  if (evidence.elapsedMs >= evidence.ipcTransitionTimeoutMs) failures.push('IPC_DEADLINE');
  if (evidence.osSandboxRequired
    && (evidence.inspectorSandboxed !== true || evidence.payloadSandboxed !== true)) {
    failures.push('OS_CONTAINMENT');
  }
  if (evidence.cgroupRequired
    && (evidence.payloadCgroupRequired !== true
      || evidence.payloadCgroupAvailable !== true
      || evidence.payloadCpuMax !== '20000 100000'
      || evidence.payloadMemoryHigh !== String(64 * 1024 * 1024)
      || evidence.payloadMemoryMax !== String(96 * 1024 * 1024)
      || evidence.payloadPidsMax !== '16'
      || evidence.supervisorChargedToKernel !== true
      || evidence.payloadAttachedBeforeInit !== true
      || !Number.isSafeInteger(evidence.payloadProcessCount)
      || evidence.payloadProcessCount < 1)) {
    failures.push('PAYLOAD_CGROUP_CONTAINMENT');
  }
  if (evidence.observedOutputs > evidence.outputLimitPerEvent) failures.push('OUTPUT_LIMIT');
  return Object.freeze(failures);
}

function binding() {
  return {
    id: 'r119f-entry-preflight-binding',
    sequence: 0,
    class: 'durable',
    topic: 'runtime.organism.binding',
    payload: {
      bindingVersion: 1,
      identitySha256: `sha256:${'c'.repeat(64)}`,
      organismLineage: 'STAY/Genesis',
      runtimeRevision: 119,
      authorityEpoch: 1,
      kernelVersion: '0.8.11.3',
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
  };
}

function pulse(sequence, trustedTimeUs) {
  return {
    id: `r119f-entry-preflight-pulse-${sequence}`,
    sequence,
    class: 'durable',
    topic: 'runtime.trusted-organism-time.pulse',
    payload: {
      runtimeRevision: 119,
      pulseSequence: sequence,
      status: 'TRUSTED',
      trustedTimeUs,
      continuityEpoch: 1,
      reasonCode: null,
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
  };
}

async function run() {
  const definition = await inspectCoreModule(entrypoint);
  const manifest = definition.manifest;
  if (manifest.coreId !== 'chronobiology'
    || manifest.version !== '1.0.0-c3rc.5'
    || manifest.stateSchema !== 2
    || manifest.productionEligible !== false
    || manifest.resources.handlerTimeoutMs !== 250
    || manifest.resources.healthTimeoutMs !== 1000
    || manifest.resources.softCpuPercent !== 5
    || manifest.resources.hardCpuPercent !== 20
    || manifest.resources.softRamMiB !== 64
    || manifest.resources.hardRamMiB !== 96) {
    throw Object.assign(new Error('R119F entry manifest changed its containment contract'), {
      code: 'R119F_ENTRY_MANIFEST',
    });
  }

  const client = new CoreHostClient({
    modulePath: definition.modulePath,
    expectedManifest: manifest,
    instanceId: 'r119f-real-entry-preflight',
    mode: 'standby',
    logger: { log() {}, info() {}, warn() {}, error() {} },
    policy: { resources: manifest.resources, priority: manifest.priority },
  });
  const outputs = [];
  client.on('error', () => {});
  client.on('output', value => outputs.push(value));
  try {
    await client.start({}, manifest.stateSchema);
    const bound = binding();
    await client.dispatch(bound, {
      coreId: manifest.coreId,
      implementationInstanceId: 'r119f-real-entry-preflight',
      authorityEpoch: 1,
      eventSequence: 0,
      eventId: bound.id,
    });
    const genesis = pulse(1, 0);
    await client.dispatch(genesis, {
      coreId: manifest.coreId,
      implementationInstanceId: 'r119f-real-entry-preflight',
      authorityEpoch: 1,
      eventSequence: 1,
      eventId: genesis.id,
    });
    const elapsedSlicesMs = [];
    let result = null;
    for (let index = 0; index < 7; index += 1) {
      const gap = pulse(index + 2, FIRST_TARGET_US + index * PULSE_INTERVAL_US);
      const started = performance.now();
      result = await client.dispatch(gap, {
        coreId: manifest.coreId,
        implementationInstanceId: 'r119f-real-entry-preflight',
        authorityEpoch: 1,
        eventSequence: index + 2,
        eventId: gap.id,
      });
      elapsedSlicesMs.push(performance.now() - started);
    }
    const elapsedMs = Math.max(...elapsedSlicesMs);
    const state = result.checkpoint || await client.snapshot();
    const health = await client.health();
    const status = client.status();
    const osSandboxRequired = process.env.STAY_REQUIRE_OS_CORE_SANDBOX === '1';
    const cgroupRequired = process.env.STAY_REQUIRE_CGROUPS === '1';
    const containment = status.osContainment || {};
    const cgroupLimits = containment.limits || {};
    const transitionEvidence = Object.freeze({
      committedThroughUs: state?.continuity?.committed_through_us ?? null,
      expectedCommittedThroughUs: EXPECTED_COMMITTED_THROUGH_US,
      healthOk: health?.ok ?? null,
      elapsedMs,
      workerTransitionTimeoutMs: client.handlerTimeoutMs,
      ipcTransitionTimeoutMs: client.handlerTimeoutMs + 750,
      osSandboxRequired,
      inspectorSandboxed: definition.sandboxed,
      payloadSandboxed: containment.payloadSandboxed === true,
      cgroupRequired,
      payloadCgroupRequired: containment.required === true,
      payloadCgroupAvailable: containment.available === true,
      payloadCpuMax: cgroupLimits['cpu.max'] ?? null,
      payloadMemoryHigh: cgroupLimits['memory.high'] ?? null,
      payloadMemoryMax: cgroupLimits['memory.max'] ?? null,
      payloadPidsMax: cgroupLimits['pids.max'] ?? null,
      supervisorChargedToKernel: containment.supervisorChargedToKernel === true,
      payloadAttachedBeforeInit: containment.payloadAttachedBeforeInit === true,
      payloadProcessCount: Array.isArray(containment.payloadPids)
        ? containment.payloadPids.length : 0,
      observedOutputs: outputs.length,
      outputLimitPerEvent: manifest.resources.outputLimitPerEvent,
    });
    const failures = transitionFailures(transitionEvidence);
    if (failures.length > 0) {
      const diagnostic = JSON.stringify({ failures, ...transitionEvidence });
      throw Object.assign(new Error(
        `R119F real entry path failed its bounded gap transition: ${diagnostic}`), {
        code: 'R119F_ENTRY_TRANSITION',
        diagnostic,
      });
    }
    return Object.freeze({
      format: 'stay-r119f-entry-preflight-v1',
      result: 'PASS',
      coreId: manifest.coreId,
      version: manifest.version,
      stateSchema: manifest.stateSchema,
      committedThroughUs: transitionEvidence.committedThroughUs,
      observedOutputs: transitionEvidence.observedOutputs,
      elapsedMs: transitionEvidence.elapsedMs,
      elapsedSlicesMs,
      declaredHandlerTimeoutMs: manifest.resources.handlerTimeoutMs,
      workerTransitionTimeoutMs: transitionEvidence.workerTransitionTimeoutMs,
      ipcTransitionTimeoutMs: transitionEvidence.ipcTransitionTimeoutMs,
      osSandboxRequired: transitionEvidence.osSandboxRequired,
      inspectorSandboxed: transitionEvidence.inspectorSandboxed,
      payloadSandboxed: transitionEvidence.payloadSandboxed,
      cgroupRequired: transitionEvidence.cgroupRequired,
      payloadCgroupRequired: transitionEvidence.payloadCgroupRequired,
      payloadCgroupAvailable: transitionEvidence.payloadCgroupAvailable,
      payloadCpuMax: transitionEvidence.payloadCpuMax,
      payloadMemoryHigh: transitionEvidence.payloadMemoryHigh,
      payloadMemoryMax: transitionEvidence.payloadMemoryMax,
      payloadPidsMax: transitionEvidence.payloadPidsMax,
      supervisorChargedToKernel: transitionEvidence.supervisorChargedToKernel,
      payloadAttachedBeforeInit: transitionEvidence.payloadAttachedBeforeInit,
      payloadProcessCount: transitionEvidence.payloadProcessCount,
      packagePolicyRequired: process.env.STAY_REQUIRE_CORE_PACKAGE_POLICY === '1',
      productionEligible: manifest.productionEligible,
      hardCpuPercent: manifest.resources.hardCpuPercent,
      hardRamMiB: manifest.resources.hardRamMiB,
    });
  } finally {
    await client.stop().catch(() => {});
  }
}

if (require.main === module) {
  run().then(value => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  }).catch(error => {
    process.stderr.write(`R119F_ENTRY_PREFLIGHT_ABORT=${error.code || 'FAILED'}:${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { run, transitionFailures };
