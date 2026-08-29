'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const previous = require('../cores/chronobiology/c3r3');
const repaired = require('../cores/chronobiology/c3r4');
const { createFounderState } = require('../cores/chronobiology/c3r3/founder');
const referenceOscillator = require('../cores/chronobiology/c3r3/oscillator');
const repairedOscillator = require('../cores/chronobiology/c3r4/oscillator');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const {
  enforcePackagePolicy,
  verifyManifestAgainstPackagePolicy,
} = require('../runtime/kernel/package-policy');

const GOLDEN_DIGEST = '53158bb15a19011b448b17aa9b8a0859bd63b96c53566d089e959880c9120606';

function founder(seed) {
  return createFounderState({
    organismId: `sha256:${'c'.repeat(64)}`,
    trustedTimeUs: 0,
    runtimeRevision: 1,
    pulseSequence: 1,
    continuityEpoch: 1,
    founderSeedHex: crypto.createHash('sha256').update(seed).digest('hex'),
  });
}

test('C3R4-ID-01 topology repair is a new contained implementation identity', () => {
  const record = enforcePackagePolicy(require.resolve('../cores/chronobiology/c3r4'));
  assert.equal(verifyManifestAgainstPackagePolicy(record, repaired.manifest), true);
  assert.equal(previous.manifest.version, '1.0.0-c3rc.3');
  assert.equal(repaired.manifest.version, '1.0.0-c3rc.4');
  assert.equal(repaired.manifest.stage, 'c3-shadow-jitless-topology-performance-repair');
  assert.equal(repaired.manifest.productionEligible, false);
  assert.deepEqual(repaired.manifest.resources, previous.manifest.resources);
  assert.deepEqual(repaired.manifest.inputs, previous.manifest.inputs);
  assert.deepEqual(repaired.manifest.outputs, previous.manifest.outputs);
  assert.equal(record.policy.bounds.productionOutputs, 0);
  assert.equal(record.policy.ambientCapabilities.filesystemWrite, false);
  assert.equal(record.policy.ambientCapabilities.network, false);
  assert.equal(record.policy.ambientCapabilities.processSpawn, false);
});

test('C3R4-BIO-01 topology engine is byte-identical across founders and remainder quanta', () => {
  const durations = [
    1,
    59_999_999,
    60_000_000,
    60_000_001,
    180_000_000,
    3_600_000_000,
    12_345_678_901,
  ];
  for (let vector = 0; vector < 8; vector += 1) {
    const state = founder(`C3RC.4 differential founder ${vector}`);
    const acquired = structuredClone(state.acquired);
    for (let unitId = 0; unitId < acquired.oscillators.length; unitId += 1) {
      const unit = acquired.oscillators[unitId];
      unit.phase_q = (unit.phase_q + Math.imul(unitId + 1, 31_415_927)) >>> 0;
      unit.amplitude_q = Math.max(0, Math.min(2_147_483_647,
        unit.amplitude_q + ((unitId % 7) - 3) * 1_000_003));
    }
    for (const durationUs of durations) {
      const expected = referenceOscillator.integratePopulationDuration(
        acquired,
        state.phenotype,
        durationUs,
      );
      const actual = repairedOscillator.integratePopulationDuration(
        acquired,
        state.phenotype,
        durationUs,
      );
      assert.equal(stableStringify(actual), stableStringify(expected),
        `founder ${vector}, duration ${durationUs}`);
    }
  }
});

test('C3R4-ENTRY-01 real --jitless biological path preserves the golden state inside the contract', () => {
  const script = String.raw`
    const crypto = require('node:crypto');
    const { performance } = require('node:perf_hooks');
    const { stableStringify } = require('./runtime/kernel/canonical-json');
    const { emptyState, bindState, advanceTrustedTime } =
      require('./cores/chronobiology/c3r4/state');
    const binding = {
      id: 'c3-containment-binding',
      topic: 'runtime.organism.binding',
      payload: {
        bindingVersion: 1,
        identitySha256: 'sha256:' + 'c'.repeat(64),
        organismLineage: 'STAY/Genesis',
        runtimeRevision: 1,
        authorityEpoch: 1,
        kernelVersion: '0.8.11.3',
      },
      meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
    };
    const pulse = (sequence, trustedTimeUs) => ({
      id: 'c3-containment-pulse-' + sequence,
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
    });
    const elapsed = [];
    let digest = null;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const genesis = advanceTrustedTime(bindState(emptyState(), binding), pulse(1, 0));
      const started = performance.now();
      const advanced = advanceTrustedTime(genesis, pulse(2, 36 * 3_600_000_000));
      elapsed.push(performance.now() - started);
      digest = crypto.createHash('sha256').update(stableStringify(advanced)).digest('hex');
    }
    process.stdout.write(JSON.stringify({ elapsed, digest }));
  `;
  const child = spawnSync(process.execPath, ['--jitless', '-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 2_000,
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const result = JSON.parse(child.stdout);
  assert.equal(result.digest, GOLDEN_DIGEST);
  assert.equal(result.elapsed.length, 3);
  for (const elapsedMs of result.elapsed) {
    assert.ok(elapsedMs < repaired.manifest.resources.handlerTimeoutMs * 0.8,
      `JITless 36-hour free-run took ${elapsedMs.toFixed(3)} ms`);
  }
});
