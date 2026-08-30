'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const previous = require('../cores/chronobiology/c3r4');
const repaired = require('../cores/chronobiology/c3r5');
const previousState = require('../cores/chronobiology/c3r4/state');
const repairedState = require('../cores/chronobiology/c3r5/state');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const {
  enforcePackagePolicy,
  verifyManifestAgainstPackagePolicy,
} = require('../runtime/kernel/package-policy');

const HOUR_US = 3_600_000_000;
const FIRST_TARGET_US = 49 * HOUR_US;
const PULSE_INTERVAL_US = 250_000;

function binding() {
  return {
    id: 'c3r5-bounded-binding',
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
    id: `c3r5-bounded-pulse-${sequence}`,
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

function genesis(implementation) {
  return implementation.advanceTrustedTime(
    implementation.bindState(implementation.emptyState(), binding()),
    pulse(1, 0),
  );
}

function digest(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function runCatchup({ restartAfter = null } = {}) {
  let state = genesis(repairedState);
  const frontiers = [];
  for (let index = 0; index < 7; index += 1) {
    state = repairedState.advanceTrustedTime(
      state,
      pulse(index + 2, FIRST_TARGET_US + index * PULSE_INTERVAL_US),
    );
    frontiers.push(state.continuity.committed_through_us);
    if (restartAfter === index) {
      state = repairedState.normalizeState(structuredClone(state));
    }
  }
  return { state, frontiers };
}

test('C3R5-ID-01 bounded catch-up is a new contained implementation identity', () => {
  const record = enforcePackagePolicy(require.resolve('../cores/chronobiology/c3r5'));
  assert.equal(verifyManifestAgainstPackagePolicy(record, repaired.manifest), true);
  assert.equal(previous.manifest.version, '1.0.0-c3rc.4');
  assert.equal(repaired.manifest.version, '1.0.0-c3rc.5');
  assert.equal(repaired.manifest.stage, 'c3-shadow-jitless-bounded-catchup-repair');
  assert.equal(repaired.manifest.productionEligible, false);
  assert.deepEqual(repaired.manifest.resources, previous.manifest.resources);
  assert.deepEqual(repaired.manifest.inputs, previous.manifest.inputs);
  assert.deepEqual(repaired.manifest.outputs, previous.manifest.outputs);
  assert.equal(record.policy.bounds.productionOutputs, 0);
  assert.equal(record.policy.ambientCapabilities.filesystemWrite, false);
  assert.equal(record.policy.ambientCapabilities.network, false);
  assert.equal(record.policy.ambientCapabilities.processSpawn, false);
});

test('C3R5-BIO-01 bounded slices converge byte-identically to the frozen one-shot biology', () => {
  const { state, frontiers } = runCatchup();
  const finalTargetUs = FIRST_TARGET_US + 6 * PULSE_INTERVAL_US;
  const expected = previousState.advanceTrustedTime(
    genesis(previousState),
    pulse(8, finalTargetUs),
  );
  assert.deepEqual(frontiers.slice(0, 6), [
    8 * HOUR_US,
    16 * HOUR_US,
    24 * HOUR_US,
    32 * HOUR_US,
    40 * HOUR_US,
    48 * HOUR_US,
  ]);
  assert.equal(frontiers[6], finalTargetUs);
  assert.equal(state.continuity.deferred_trusted_time_evidence, null);
  assert.equal(stableStringify(state), stableStringify(expected));
});

test('C3R5-BIO-02 a checkpoint restart during catch-up preserves the exact terminal state', () => {
  const uninterrupted = runCatchup().state;
  const restarted = runCatchup({ restartAfter: 2 }).state;
  assert.equal(digest(restarted), digest(uninterrupted));
  assert.equal(stableStringify(restarted), stableStringify(uninterrupted));
});

test('C3R5-FENCE-01 deferred evidence remains monotonic and fail-closed', () => {
  let state = genesis(repairedState);
  state = repairedState.advanceTrustedTime(state, pulse(20, FIRST_TARGET_US));
  assert.throws(() => repairedState.advanceTrustedTime(
    state,
    pulse(19, FIRST_TARGET_US + PULSE_INTERVAL_US),
  ), {
    code: 'CHRONOBIOLOGY_TIME_REWIND',
    message: 'bounded trusted-time catch-up rewound',
  });
});

test('C3R5-FENCE-02 a duplicate accepted pulse cannot integrate a second slice', () => {
  let state = genesis(repairedState);
  const accepted = pulse(20, FIRST_TARGET_US);
  state = repairedState.advanceTrustedTime(state, accepted);
  const checkpoint = repairedState.normalizeState(structuredClone(state));
  const duplicate = repairedState.advanceTrustedTime(checkpoint, accepted);
  assert.equal(digest(duplicate), digest(checkpoint));
  assert.equal(duplicate.continuity.committed_through_us, 8 * HOUR_US);
  assert.equal(duplicate.continuity.deferred_trusted_time_evidence.pulse_sequence, 20);
});

test('C3R5-ENTRY-01 real --jitless slices stay inside the quota-aware CPU work fence', () => {
  const script = String.raw`
    const { performance } = require('node:perf_hooks');
    const stateApi = require('./cores/chronobiology/c3r5/state');
    const binding = ${JSON.stringify(binding())};
    const pulse = (sequence, trustedTimeUs) => ({
      id: 'c3r5-bounded-pulse-' + sequence,
      topic: 'runtime.trusted-organism-time.pulse',
      payload: {
        runtimeRevision: 1, pulseSequence: sequence, status: 'TRUSTED',
        trustedTimeUs, continuityEpoch: 1, reasonCode: null,
      },
      meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
    });
    let state = stateApi.advanceTrustedTime(
      stateApi.bindState(stateApi.emptyState(), binding), pulse(1, 0));
    const elapsed = [];
    for (let index = 0; index < 7; index += 1) {
      const started = performance.now();
      state = stateApi.advanceTrustedTime(
        state, pulse(index + 2, ${FIRST_TARGET_US} + index * ${PULSE_INTERVAL_US}));
      elapsed.push(performance.now() - started);
    }
    process.stdout.write(JSON.stringify({
      elapsed,
      deferred: state.continuity.deferred_trusted_time_evidence,
      committedThroughUs: state.continuity.committed_through_us,
    }));
  `;
  const child = spawnSync(process.execPath, ['--jitless', '-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 2_000,
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const result = JSON.parse(child.stdout);
  assert.equal(result.deferred, null);
  assert.equal(result.committedThroughUs, FIRST_TARGET_US + 6 * PULSE_INTERVAL_US);
  assert.equal(result.elapsed.length, 7);
  assert.ok(Math.max(...result.elapsed) < 50,
    `maximum bounded --jitless slice took ${Math.max(...result.elapsed).toFixed(3)} ms`);
});
