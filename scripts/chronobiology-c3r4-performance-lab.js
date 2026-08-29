#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { CoreHostClient } = require('../runtime/kernel/core-host-client');
const { inspectCoreModule } = require('../runtime/kernel/core-loader');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const { enforcePackagePolicy } = require('../runtime/kernel/package-policy');
const {
  emptyState,
  bindState,
  advanceTrustedTime,
} = require('../cores/chronobiology/c3r4/state');

const ENTRYPOINT = path.resolve(__dirname, '../cores/chronobiology/c3r4/index.js');
const GAP_US = 36 * 3_600_000_000;
const GOLDEN_DIGEST = '53158bb15a19011b448b17aa9b8a0859bd63b96c53566d089e959880c9120606';

function fail(message, code = 'C3R4_PERFORMANCE_LAB_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function parseArguments(argv) {
  let mode = 'direct';
  let samples = 3;
  for (const argument of argv) {
    if (argument === '--direct') mode = 'direct';
    else if (argument === '--corehost') mode = 'corehost';
    else if (/^--samples=[1-9][0-9]*$/.test(argument)) {
      samples = Number(argument.slice('--samples='.length));
    } else fail(`unknown argument: ${argument}`);
  }
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 12) {
    fail('sample count is outside 1..12');
  }
  return Object.freeze({ mode, samples });
}

function binding() {
  return {
    id: 'c3-containment-binding',
    sequence: 0,
    class: 'durable',
    topic: 'runtime.organism.binding',
    payload: {
      bindingVersion: 1,
      identitySha256: `sha256:${'c'.repeat(64)}`,
      organismLineage: 'STAY/Genesis',
      runtimeRevision: 1,
      authorityEpoch: 1,
      kernelVersion: '0.8.11.3',
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
  };
}

function pulse(sequence, trustedTimeUs) {
  return {
    id: `c3-containment-pulse-${sequence}`,
    sequence,
    class: 'durable',
    topic: 'runtime.trusted-organism-time.pulse',
    payload: {
      runtimeRevision: 1,
      pulseSequence: sequence,
      status: 'TRUSTED',
      trustedTimeUs,
      continuityEpoch: 1,
      reasonCode: null,
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
  };
}

function digest(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function summarize(mode, elapsed, stateDigest, details = {}) {
  const sorted = [...elapsed].sort((left, right) => left - right);
  return Object.freeze({
    format: 'stay-c3r4-performance-lab-v1',
    mode,
    samples: elapsed.length,
    elapsedMs: elapsed,
    minimumMs: sorted[0],
    medianMs: sorted[Math.floor(sorted.length / 2)],
    maximumMs: sorted.at(-1),
    stateDigest,
    goldenStateDigest: GOLDEN_DIGEST,
    stateDigestMatchesGolden: stateDigest === GOLDEN_DIGEST,
    gapUs: GAP_US,
    ...details,
  });
}

function runDirect(samples) {
  if (!process.execArgv.includes('--jitless')) {
    fail('direct laboratory requires the real --jitless execution mode',
      'C3R4_JITLESS_REQUIRED');
  }
  const elapsed = [];
  let stateDigest = null;
  for (let sample = 0; sample < samples; sample += 1) {
    const genesis = advanceTrustedTime(bindState(emptyState(), binding()), pulse(1, 0));
    const started = performance.now();
    const advanced = advanceTrustedTime(genesis, pulse(2, GAP_US));
    elapsed.push(performance.now() - started);
    stateDigest = digest(advanced);
  }
  if (stateDigest !== GOLDEN_DIGEST) fail('direct biological digest changed', 'C3R4_BIOLOGY_CHANGED');
  return summarize('direct-jitless', elapsed, stateDigest, {
    jitless: true,
  });
}

async function runCoreHost(samples) {
  const definition = await inspectCoreModule(ENTRYPOINT);
  const manifest = definition.manifest;
  const packageRecord = enforcePackagePolicy(definition.modulePath);
  if (manifest.version !== '1.0.0-c3rc.4'
    || manifest.resources.handlerTimeoutMs !== 250
    || manifest.resources.hardCpuPercent !== 20
    || manifest.resources.hardRamMiB !== 96
    || manifest.productionEligible !== false) {
    fail('C3RC.4 containment contract changed', 'C3R4_CONTRACT_CHANGED');
  }
  if (packageRecord?.policy?.bounds?.productionOutputs !== 0) {
    fail('C3RC.4 production output authority changed', 'C3R4_AUTHORITY_CHANGED');
  }
  const expected = advanceTrustedTime(
    advanceTrustedTime(bindState(emptyState(), binding()), pulse(1, 0)),
    pulse(2, GAP_US),
  );
  const expectedAcquiredDigest = digest(expected.acquired);
  const elapsed = [];
  const outputCounts = [];
  let stateDigest = null;
  for (let sample = 0; sample < samples; sample += 1) {
    const outputs = [];
    const client = new CoreHostClient({
      modulePath: definition.modulePath,
      expectedManifest: manifest,
      instanceId: `c3r4-performance-lab-${sample}`,
      mode: 'standby',
      logger: { log() {}, info() {}, warn() {}, error() {} },
      policy: { resources: manifest.resources, priority: manifest.priority },
    });
    client.on('error', () => {});
    client.on('output', value => outputs.push(value));
    try {
      await client.start({}, manifest.stateSchema);
      const bound = binding();
      await client.dispatch(bound, {
        coreId: manifest.coreId,
        implementationInstanceId: `c3r4-performance-lab-${sample}`,
        authorityEpoch: 1,
        eventSequence: 0,
        eventId: bound.id,
      });
      const genesis = pulse(1, 0);
      await client.dispatch(genesis, {
        coreId: manifest.coreId,
        implementationInstanceId: `c3r4-performance-lab-${sample}`,
        authorityEpoch: 1,
        eventSequence: 1,
        eventId: genesis.id,
      });
      const gap = pulse(2, GAP_US);
      const started = performance.now();
      const result = await client.dispatch(gap, {
        coreId: manifest.coreId,
        implementationInstanceId: `c3r4-performance-lab-${sample}`,
        authorityEpoch: 1,
        eventSequence: 2,
        eventId: gap.id,
      });
      elapsed.push(performance.now() - started);
      stateDigest = digest(result.checkpoint);
      outputCounts.push(outputs.length);
      if (digest(result.checkpoint?.acquired) !== expectedAcquiredDigest
        || result.checkpoint?.continuity?.committed_through_us !== GAP_US) {
        fail('CoreHost biological checkpoint changed', 'C3R4_BIOLOGY_CHANGED');
      }
      if (outputs.length > manifest.resources.outputLimitPerEvent) {
        fail('CoreHost output bound changed', 'C3R4_OUTPUT_CHANGED');
      }
    } finally {
      await client.stop().catch(() => {});
    }
  }
  return summarize('real-corehost', elapsed, stateDigest, {
    biologicalDigest: expectedAcquiredDigest,
    biologicalDigestMatches: true,
    outputCounts,
    productionOutputsAuthorized: packageRecord.policy.bounds.productionOutputs,
    declaredHandlerTimeoutMs: manifest.resources.handlerTimeoutMs,
    hardCpuPercent: manifest.resources.hardCpuPercent,
    hardRamMiB: manifest.resources.hardRamMiB,
    inspectorSandboxed: definition.sandboxed,
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = options.mode === 'corehost'
    ? await runCoreHost(options.samples)
    : runDirect(options.samples);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({
      format: 'stay-c3r4-performance-lab-error-v1',
      code: error.code || 'FAILED',
      message: error.message,
      timeoutMs: error.timeoutMs || null,
      operation: error.coreHostOperation || error.coreWorkerOperation || null,
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { GAP_US, GOLDEN_DIGEST, parseArguments, runDirect, runCoreHost };
