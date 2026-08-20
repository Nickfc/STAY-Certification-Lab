'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { LivingKernel } = require('../runtime/kernel/living-kernel');

test('CHR-INF-06 resident pulse carries Kernel-owned trusted organism time evidence', async () => {
  let wallClockMs = 1;
  const kernel = new LivingKernel({
    dataDir: '/tmp/stay-chr-trusted-time-evidence',
    clock: () => wallClockMs,
    trustedOrganismTime: {
      async sample() {
        return {
          status: 'TRUSTED',
          trustedTimeUs: 987_654_321,
          continuityEpoch: 7,
          reasonCode: null,
        };
      },
    },
  });
  kernel.runtimeRevision = 3;
  let captured;
  kernel.fabric.publishBiologicalSignal = async signal => {
    captured = signal;
    return signal;
  };

  await kernel.publishTrustedOrganismTimePulse();
  const first = captured.payload;
  wallClockMs = 9_999_999_999;
  await kernel.publishTrustedOrganismTimePulse();
  const second = captured.payload;

  assert.equal(first.trustedTimeUs, second.trustedTimeUs);
  assert.equal(first.continuityEpoch, second.continuityEpoch);
  assert.deepEqual({
    status: second.status,
    trustedTimeUs: second.trustedTimeUs,
    continuityEpoch: second.continuityEpoch,
    reasonCode: second.reasonCode,
  }, {
    status: 'TRUSTED',
    trustedTimeUs: 987_654_321,
    continuityEpoch: 7,
    reasonCode: null,
  });
});

test('CHR-INF-07 absent or uncertain trusted time fails closed without inventing time', async () => {
  const absent = new LivingKernel({
    dataDir: '/tmp/stay-chr-trusted-time-absent',
  });
  assert.deepEqual(await absent.sampleTrustedTimeEvidence(), {
    status: 'TRUSTED_TIME_UNAVAILABLE',
    trustedTimeUs: null,
    continuityEpoch: null,
    reasonCode: 'TRUSTED_TIME_PROVIDER_UNAVAILABLE',
  });

  const uncertain = new LivingKernel({
    dataDir: '/tmp/stay-chr-trusted-time-uncertain',
    trustedOrganismTime: {
      async sample() {
        return {
          status: 'TRUSTED_TIME_UNCERTAIN',
          trustedTimeUs: 123,
          continuityEpoch: 2,
          reasonCode: 'TRUSTED_TIME_CONTINUITY_UNPROVEN',
        };
      },
    },
  });
  assert.deepEqual(await uncertain.sampleTrustedTimeEvidence(), {
    status: 'TRUSTED_TIME_UNCERTAIN',
    trustedTimeUs: null,
    continuityEpoch: null,
    reasonCode: 'TRUSTED_TIME_CONTINUITY_UNPROVEN',
  });
});
