'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
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
const { OUTPUT: GENERATED_KERNEL, generate } = require('../tools/generate-c3r4-local-kernel');
const {
  OUTPUT: GENERATED_GENERAL_KERNEL,
  generate: generateGeneralKernel,
} = require('../tools/generate-c3r4-general-kernel');

const GOLDEN_DIGEST = '53158bb15a19011b448b17aa9b8a0859bd63b96c53566d089e959880c9120606';
const Q30_ONE = 1_073_741_824;
const RESPONSE_LIMIT_Q30 = 67_108_864;
const RESPONSE_FAST_PATH_GUARD = 0.00001;

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

test('C3R4-TOPO-01 static kernel is reproducible and malformed local topology fails closed', () => {
  assert.equal(fs.readFileSync(GENERATED_KERNEL, 'utf8'), generate());
  assert.equal(fs.readFileSync(GENERATED_GENERAL_KERNEL, 'utf8'), generateGeneralKernel());
  const state = founder('C3RC.4 malformed topology');
  const phenotype = structuredClone(state.phenotype);
  const firstLocal = phenotype.coupling_graph.edges.findIndex(edge =>
    edge.weight_q30 === 134_217_728);
  assert.notEqual(firstLocal, -1);
  phenotype.coupling_graph.edges[firstLocal] = {
    ...phenotype.coupling_graph.edges[firstLocal],
    right_unit_id: 3,
  };
  assert.throws(() => repairedOscillator.integratePopulationDuration(
    structuredClone(state.acquired),
    phenotype,
    60_000_000,
  ), {
    code: 'CHRONOBIOLOGY_OSCILLATOR_INVALID',
    message: 'compiled local ring topology is invalid',
  });
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

test('C3R4-NUM-01 combined response fast path is exact outside its rounding fence', () => {
  let accepted = 0;
  let fenced = 0;
  let sample = 0xc3_c4_2026;
  for (let vector = 0; vector < 8; vector += 1) {
    const state = founder(`C3RC.4 response fence founder ${vector}`);
    const totalWeights = new Array(state.phenotype.oscillator_count).fill(0);
    for (const edge of state.phenotype.coupling_graph.edges) {
      totalWeights[edge.left_unit_id] += edge.weight_q30;
      totalWeights[edge.right_unit_id] += edge.weight_q30;
    }
    for (let unitId = 0; unitId < totalWeights.length; unitId += 1) {
      const denominator = totalWeights[unitId];
      const sensitivity = state.phenotype.oscillators[unitId].coupling_sensitivity_q;
      const responseScale = sensitivity / denominator;
      const guard = sensitivity / Q30_ONE / 2 + RESPONSE_FAST_PATH_GUARD;
      const magnitudes = [0, 1, Math.floor(denominator / 2), denominator - 1, denominator];
      for (let index = 0; index < 256; index += 1) {
        sample = (Math.imul(sample, 1_664_525) + 1_013_904_223) >>> 0;
        magnitudes.push(Math.floor(
          (sample / 0x1_0000_0000) * (denominator + 1),
        ));
      }
      for (const magnitude of magnitudes) {
        const scaled = magnitude * responseScale;
        const floor = scaled | 0;
        const fraction = scaled - floor;
        if (fraction >= 0.5 - guard && fraction <= 0.5 + guard) {
          fenced += 1;
          continue;
        }
        const candidate = Math.min(
          floor + (fraction >= 0.5 ? 1 : 0),
          RESPONSE_LIMIT_Q30,
        );
        const exactCoupling = Number(
          (2n * BigInt(magnitude) * BigInt(Q30_ONE) + BigInt(denominator))
            / (2n * BigInt(denominator)),
        );
        const exactResponse = Math.min(Number(
          (2n * BigInt(exactCoupling) * BigInt(sensitivity) + BigInt(Q30_ONE))
            / (2n * BigInt(Q30_ONE)),
        ), RESPONSE_LIMIT_Q30);
        assert.equal(candidate, exactResponse,
          `founder ${vector}, unit ${unitId}, magnitude ${magnitude}`);
        accepted += 1;
      }
    }
  }
  assert.ok(accepted > 80_000, `insufficient accepted coverage: ${accepted}`);
  assert.ok(fenced > 10_000, `insufficient exact-fallback coverage: ${fenced}`);
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
