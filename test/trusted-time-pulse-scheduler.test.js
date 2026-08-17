'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const {
  HardenedLivingKernel,
  TRUSTED_TIME_PULSE_MIN_INTERVAL_MS,
  TRUSTED_TIME_PULSE_MAX_INTERVAL_MS,
  normalizeTrustedTimePulseIntervalMs
} = require('../runtime/kernel/hardened-living-kernel');

function makeKernel(options = {}) {
  return new HardenedLivingKernel({
    dataDir: path.join(os.tmpdir(), `stay-time-pulse-${process.pid}-${Math.random().toString(16).slice(2)}`),
    heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0,
    trustedTimePulseIntervalMs: 0,
    ...options
  });
}

test('trusted time pulse scheduler is disabled by default', () => {
  const kernel = makeKernel();
  assert.deepEqual(kernel.trustedTimePulseStatus(), {
    enabled: false,
    running: false,
    inFlight: false,
    intervalMs: 0,
    sequence: 0
  });
});

test('trusted time pulse interval accepts 0 and bounded integer milliseconds only', () => {
  assert.equal(normalizeTrustedTimePulseIntervalMs(0), 0);
  assert.equal(normalizeTrustedTimePulseIntervalMs(''), 0);
  assert.equal(normalizeTrustedTimePulseIntervalMs(TRUSTED_TIME_PULSE_MIN_INTERVAL_MS), TRUSTED_TIME_PULSE_MIN_INTERVAL_MS);
  assert.equal(normalizeTrustedTimePulseIntervalMs(String(TRUSTED_TIME_PULSE_MAX_INTERVAL_MS)), TRUSTED_TIME_PULSE_MAX_INTERVAL_MS);

  for (const invalid of [-1, 1, TRUSTED_TIME_PULSE_MIN_INTERVAL_MS - 1, TRUSTED_TIME_PULSE_MAX_INTERVAL_MS + 1, 1.5, 'nope']) {
    assert.throws(
      () => normalizeTrustedTimePulseIntervalMs(invalid),
      error => error?.code === 'TRUSTED_TIME_PULSE_INTERVAL_INVALID'
    );
  }
});

test('scheduler starts only once and stop is idempotent', () => {
  const kernel = makeKernel({ trustedTimePulseIntervalMs: TRUSTED_TIME_PULSE_MIN_INTERVAL_MS });
  kernel.publishTimePulse = async () => {};

  assert.equal(kernel.startTrustedTimePulseScheduler(), true);
  assert.equal(kernel.startTrustedTimePulseScheduler(), false);
  assert.equal(kernel.trustedTimePulseStatus().running, true);
  assert.equal(kernel.stopTrustedTimePulseScheduler(), true);
  assert.equal(kernel.stopTrustedTimePulseScheduler(), false);
  assert.equal(kernel.trustedTimePulseStatus().running, false);
});

test('scheduler never overlaps trusted time pulse publication', async () => {
  const kernel = makeKernel();
  let release;
  let calls = 0;
  kernel.publishTimePulse = async () => {
    calls += 1;
    await new Promise(resolve => { release = resolve; });
  };

  const first = kernel.runTrustedTimePulse();
  await new Promise(resolve => setImmediate(resolve));
  const second = await kernel.runTrustedTimePulse();

  assert.equal(second, false);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, true);
  assert.equal(kernel.trustedTimePulseStatus().inFlight, false);
});

test('trusted time pulse failures are fail-visible and a later success clears the maintenance error', async () => {
  const kernel = makeKernel();
  let fail = true;
  kernel.publishTimePulse = async () => {
    if (fail) throw Object.assign(new Error('synthetic pulse failure'), { code: 'SYNTHETIC_PULSE_FAILURE' });
  };

  assert.equal(await kernel.runTrustedTimePulse(), false);
  assert.equal(kernel.maintenanceErrors['trusted-time-pulse']?.code, 'SYNTHETIC_PULSE_FAILURE');

  fail = false;
  assert.equal(await kernel.runTrustedTimePulse(), true);
  assert.equal(kernel.maintenanceErrors['trusted-time-pulse'], undefined);
});

test('installing a time-pulse consumer starts the configured scheduler', async () => {
  const kernel = makeKernel({ trustedTimePulseIntervalMs: TRUSTED_TIME_PULSE_MIN_INTERVAL_MS });
  const unit = Object.freeze({
    manifest: Object.freeze({
      coreId: 'pulse-consumer',
      version: '1.0.0',
      inputs: Object.freeze(['runtime.time.pulse'])
    })
  });

  kernel.upgrades.installInitial = async () => unit;
  kernel.bumpRuntimeRevision = async () => 1;

  const installed = await kernel.installCore('/tmp/pulse-consumer.js');
  assert.equal(installed, unit);
  assert.equal(kernel.trustedTimePulseStatus().running, true);
  kernel.stopTrustedTimePulseScheduler();
});

test('installing a Core that does not consume time pulses leaves the scheduler stopped', async () => {
  const kernel = makeKernel({ trustedTimePulseIntervalMs: TRUSTED_TIME_PULSE_MIN_INTERVAL_MS });
  const unit = Object.freeze({
    manifest: Object.freeze({
      coreId: 'quiet-core',
      version: '1.0.0',
      inputs: Object.freeze([])
    })
  });

  kernel.upgrades.installInitial = async () => unit;
  kernel.bumpRuntimeRevision = async () => 1;

  await kernel.installCore('/tmp/quiet-core.js');
  assert.equal(kernel.trustedTimePulseStatus().running, false);
});

test('configured scheduler emits pulses and stops emitting after shutdown', async () => {
  const kernel = makeKernel({ trustedTimePulseIntervalMs: TRUSTED_TIME_PULSE_MIN_INTERVAL_MS });
  let calls = 0;
  kernel.publishTimePulse = async () => { calls += 1; };

  kernel.startTrustedTimePulseScheduler();
  const deadline = Date.now() + 1000;
  while (calls < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(calls >= 2, `expected at least two pulses, observed ${calls}`);

  kernel.stopTrustedTimePulseScheduler();
  const stoppedAt = calls;
  await new Promise(resolve => setTimeout(resolve, TRUSTED_TIME_PULSE_MIN_INTERVAL_MS * 3));
  assert.equal(calls, stoppedAt);
});
