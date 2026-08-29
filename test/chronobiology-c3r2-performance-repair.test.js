'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { performance } = require('node:perf_hooks');

const historical = require('../cores/chronobiology/c3');
const repaired = require('../cores/chronobiology/c3r2');
const {
  TRIG_TABLE_RESOLUTION,
  multiplyQ30,
  multiplyQ31,
  sinQ30,
} = require('../cores/chronobiology/c3r2/fixed-point');
const { SIN_Q30 } = require('../cores/chronobiology/c3r2/trig-table');
const {
  roundSafeInteger,
  scaleQ30Ratio,
} = require('../cores/chronobiology/c3r2/oscillator');
const {
  advanceTrustedTime,
  bindState,
  emptyState,
} = require('../cores/chronobiology/c3r2/state');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const {
  enforcePackagePolicy,
  verifyManifestAgainstPackagePolicy,
} = require('../runtime/kernel/package-policy');

function binding() {
  return {
    id: 'c3-containment-binding',
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

function genesis() {
  return advanceTrustedTime(bindState(emptyState(), binding()), pulse(1, 0));
}

test('C3R2-ID-01 performance repair is a new contained implementation identity', () => {
  const record = enforcePackagePolicy(require.resolve('../cores/chronobiology/c3r2'));
  assert.equal(verifyManifestAgainstPackagePolicy(record, repaired.manifest), true);
  assert.equal(historical.manifest.version, '1.0.0-c3rc.1');
  assert.equal(historical.manifest.stage, 'c3-shadow-release-candidate');
  assert.equal(repaired.manifest.version, '1.0.0-c3rc.2');
  assert.equal(repaired.manifest.stage, 'c3-shadow-performance-repair');
  assert.equal(repaired.manifest.productionEligible, false);
  assert.deepEqual(repaired.manifest.resources, historical.manifest.resources);
  assert.deepEqual(repaired.manifest.inputs, historical.manifest.inputs);
  assert.deepEqual(repaired.manifest.outputs, historical.manifest.outputs);
  assert.equal(record.policy.bounds.productionOutputs, 0);
  assert.equal(record.policy.ambientCapabilities.filesystemWrite, false);
  assert.equal(record.policy.ambientCapabilities.network, false);
  assert.equal(record.policy.ambientCapabilities.processSpawn, false);
});

test('C3R2-NUM-01 optimized primitives are exact against the frozen BigInt engine', () => {
  const referenceMultiply = (left, right, shift) => {
    const product = BigInt(left) * BigInt(right);
    const sign = product < 0n ? -1n : 1n;
    const magnitude = product < 0n ? -product : product;
    const scale = 1n << BigInt(shift);
    return Number(sign * ((magnitude + (scale >> 1n)) / scale));
  };
  const referenceSin = phaseQ => {
    const wrapped = BigInt(phaseQ) & 0xffff_ffffn;
    const index = Number(wrapped >> 20n);
    const fraction = wrapped & 0xf_ffffn;
    const current = BigInt(SIN_Q30[index]);
    const next = BigInt(SIN_Q30[(index + 1) % TRIG_TABLE_RESOLUTION]);
    const scaled = (next - current) * fraction;
    const sign = scaled < 0n ? -1n : 1n;
    const magnitude = scaled < 0n ? -scaled : scaled;
    return Number(current + sign * ((magnitude + 0x8_0000n) / 0x10_0000n));
  };

  let seed = 0x5a17c3e1;
  const next = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };

  for (let index = 0; index < 20_000; index += 1) {
    const left = next() - 0x8000_0000;
    const right = next() - 0x8000_0000;
    assert.equal(multiplyQ30(left, right), referenceMultiply(left, right, 30));
    assert.equal(multiplyQ31(left, right), referenceMultiply(left, right, 31));
    assert.equal(sinQ30(next()), referenceSin(seed));
    const denominator = (next() % 1_000_000_000) + 1;
    const ratioInput = (next() % (denominator * 7 + 1))
      * (next() % 2 === 0 ? 1 : -1);
    const ratioProduct = BigInt(ratioInput) * 1_073_741_824n;
    const ratioSign = ratioProduct < 0n ? -1n : 1n;
    const ratioMagnitude = ratioProduct < 0n ? -ratioProduct : ratioProduct;
    assert.equal(scaleQ30Ratio(ratioInput, denominator), Number(ratioSign
      * ((ratioMagnitude + BigInt(Math.floor(denominator / 2))) / BigInt(denominator))));
    const safeLeft = next() % 3_200_001;
    const safeRight = (next() % 134_217_729) - 67_108_864;
    const safeProduct = safeLeft * safeRight;
    assert.equal(roundSafeInteger(safeProduct, 1_073_741_824),
      Number((BigInt(safeProduct) < 0n ? -1n : 1n)
        * ((BigInt(safeProduct) < 0n ? -BigInt(safeProduct) : BigInt(safeProduct))
          + 536_870_912n) / 1_073_741_824n));
  }
});

test('C3R2-BIO-01 36-hour repair is byte-identical and completes below 60% of the unchanged deadline', () => {
  const state = genesis();
  const started = performance.now();
  const advanced = advanceTrustedTime(state, pulse(2, 36 * 3_600_000_000));
  const elapsedMs = performance.now() - started;
  const digest = crypto.createHash('sha256').update(stableStringify(advanced)).digest('hex');

  assert.equal(digest, '53158bb15a19011b448b17aa9b8a0859bd63b96c53566d089e959880c9120606');
  assert.equal(advanced.continuity.committed_through_us, 36 * 3_600_000_000);
  assert.ok(elapsedMs < repaired.manifest.resources.handlerTimeoutMs * 0.6,
    `36-hour free-run took ${elapsedMs.toFixed(3)} ms`);
});
