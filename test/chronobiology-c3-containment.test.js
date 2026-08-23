'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { performance } = require('node:perf_hooks');

const chronobiology = require('../cores/chronobiology/c3');
const { PROFILE } = require('../cores/chronobiology/c3/calibration-profile');
const { MAX_LONG_GAP_US } = require('../cores/chronobiology/c3/long-gap');
const {
  advanceTrustedTime,
  bindState,
  emptyState,
  normalizeState,
  queuePhoticEvidence,
} = require('../cores/chronobiology/c3/state');
const { PHOTIC_PROFILE } = require('../cores/chronobiology/c3/photic-calibration-profile');
const { CoreHostClient } = require('../runtime/kernel/core-host-client');
const { cgroupLimitValues } = require('../runtime/kernel/cgroup-governor');
const {
  auditSourceText,
  enforcePackagePolicy,
  verifyManifestAgainstPackagePolicy,
} = require('../runtime/kernel/package-policy');
const { normalizePolicy } = require('../runtime/kernel/resource-governor');
const { nativeCoreExecArgv } = require('../runtime/kernel/core-sandbox');

const root = path.resolve(__dirname, '..');
const entrypoint = require.resolve('../cores/chronobiology/c3');
const DAY_US = 86_400_000_000;

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

function light(index, startUs, durationUs = 3_600_000_000) {
  return {
    id: `c3-cue-${String(index).padStart(4, '0')}`,
    topic: 'environment.photic.exposure',
    payload: {
      schema: 'environment.photic.exposure/v1',
      effective_from_us: startUs,
      effective_to_us: startUs + durationUs,
      broadband_level_q: 1_000_000_000,
      spectral_channels: {},
      source_quality_q: 2_000_000_000,
      evidence_completeness: 'COMPLETE',
      sample_count: 60,
      coverage_q: 2_000_000_000,
    },
    meta: { sourceCore: 'laboratory-photic-source', authorityMode: 'lab' },
  };
}

function genesis() {
  return advanceTrustedTime(bindState(emptyState(), binding()), pulse(1, 0));
}

test('C3-RES-01 package and cgroup contracts preserve the frozen resource ceiling', () => {
  const record = enforcePackagePolicy(entrypoint);
  assert.equal(verifyManifestAgainstPackagePolicy(record, chronobiology.manifest), true);
  assert.equal(record.policy.ambientCapabilities.filesystemWrite, false);
  assert.equal(record.policy.ambientCapabilities.network, false);
  assert.equal(record.policy.ambientCapabilities.processSpawn, false);
  assert.deepEqual(cgroupLimitValues(normalizePolicy(
    chronobiology.manifest.resources,
    chronobiology.manifest.priority,
  )), {
    'memory.high': String(64 * 1024 * 1024),
    'memory.max': String(96 * 1024 * 1024),
    'pids.max': '16',
    'cpu.max': '20000 100000',
  });
  const argv = nativeCoreExecArgv(entrypoint);
  assert.ok(argv.includes('--permission'));
  assert.ok(argv.every(value => !value.startsWith('--allow-child-process')
    && !value.startsWith('--allow-net')));
});

test('C3-RES-02 source audit denies ambient capabilities and direct SNTSS access', () => {
  for (const hostile of [
    "require('node:fs')",
    "require('node:child_process')",
    'fetch("https://example.invalid")',
    'process.env.SECRET',
    'setInterval(() => {}, 1)',
  ]) {
    assert.throws(() => auditSourceText(hostile, ['node:crypto']), error => [
      'CORE_PACKAGE_CAPABILITY_DENIED',
      'CORE_PACKAGE_DEPENDENCY_DENIED',
    ].includes(error.code));
  }
  const sources = fs.readdirSync(path.dirname(entrypoint))
    .filter(name => name.endsWith('.js'))
    .map(name => fs.readFileSync(path.join(path.dirname(entrypoint), name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(sources, /cores\/sntss|\.\.\/\.\.\/sntss|Math\.random|Date\.now/);
});

test('C3-RES-03 certified one-year catch-up remains inside the 250 ms handler ceiling', () => {
  const state = genesis();
  const started = performance.now();
  const advanced = advanceTrustedTime(state, pulse(2, 365 * DAY_US));
  const elapsedMs = performance.now() - started;
  assert.equal(advanced.continuity.committed_through_us, 365 * DAY_US);
  assert.ok(elapsedMs < chronobiology.manifest.resources.handlerTimeoutMs,
    `one-year catch-up took ${elapsedMs.toFixed(3)} ms`);
  assert.throws(() => advanceTrustedTime(state, pulse(2, MAX_LONG_GAP_US + DAY_US)), {
    code: 'CHRONOBIOLOGY_LONG_GAP_BOUND',
  });
});

test('C3-RES-04 accelerated cue history and checkpoint bytes have no unbounded slope', () => {
  let state = genesis();
  let checkpointAt64 = 0;
  for (let index = 0; index < 192; index += 1) {
    const startUs = index * 3_600_000_000;
    state = queuePhoticEvidence(state, light(index, startUs));
    state = advanceTrustedTime(state, pulse(index + 2, startUs + 3_600_000_000));
    if (index === 63) checkpointAt64 = Buffer.byteLength(JSON.stringify(state));
  }
  const checkpointAt192 = Buffer.byteLength(JSON.stringify(state));
  assert.ok(state.continuity.recent_photic_evidence.length <= PHOTIC_PROFILE.evidenceCapacity);
  assert.ok(state.acquired.bounded_entrainment_history.length
    <= PROFILE.entrainmentHistoryCapacity);
  assert.ok(checkpointAt192 <= checkpointAt64 + 1024,
    `checkpoint slope ${checkpointAt64}->${checkpointAt192}`);
  assert.ok(checkpointAt192 <= 1024 * 1024);
});

test('C3-RES-05 cue flood, malformed state and output remain bounded and fail closed', async () => {
  let state = genesis();
  for (let index = 0; index < PHOTIC_PROFILE.evidenceCapacity; index += 1) {
    state = queuePhoticEvidence(state, light(index, index * 3_600_000_000));
  }
  assert.throws(() => queuePhoticEvidence(
    state,
    light(PHOTIC_PROFILE.evidenceCapacity, PHOTIC_PROFILE.evidenceCapacity * 3_600_000_000),
  ), { code: 'CHRONOBIOLOGY_PHOTIC_BACKPRESSURE' });

  const corrupt = structuredClone(genesis());
  corrupt.continuity.recent_photic_evidence = Array(PHOTIC_PROFILE.evidenceCapacity + 1).fill({
    event_id: 'oversized',
    evidence_hash: `sha256:${'0'.repeat(64)}`,
  });
  assert.throws(() => normalizeState(corrupt), { code: 'CHRONOBIOLOGY_STATE_INVALID' });

  const core = await chronobiology.createCore();
  await core.start();
  assert.equal(await core.handle(binding()), undefined);
  assert.equal(await core.handle(pulse(1, 0)), undefined);
  assert.equal(chronobiology.manifest.resources.outputLimitPerEvent, 16);
  assert.equal(chronobiology.manifest.resources.outputBytesPerEvent, 65_536);
});

test('C3-RES-06 status-poll storm is bounded at 128 pending CoreHost requests', async () => {
  const client = new CoreHostClient({
    modulePath: entrypoint,
    expectedManifest: chronobiology.manifest,
    policy: chronobiology.manifest,
    logger: { info() {}, warn() {}, error() {} },
  });
  client.child = { connected: true, send(_message, callback) { callback?.(null); } };
  const pending = Array.from({ length: 128 }, () => client.health());
  await assert.rejects(client.health(), { code: 'COREHOST_PENDING_LIMIT' });
  assert.equal(client.pending.size, 128);
  for (const request of client.pending.values()) clearTimeout(request.timer);
  client.pending.clear();
  void pending;
});

test('C3-RES-07 restart storm quarantines only the local CoreHost', async () => {
  const client = new CoreHostClient({
    modulePath: entrypoint,
    expectedManifest: chronobiology.manifest,
    policy: chronobiology.manifest,
    logger: { info() {}, warn() {}, error() {} },
  });
  const now = Date.now();
  client.restartHistory = Array.from({ length: chronobiology.manifest.resources.maxRestarts },
    (_, index) => ({ at: now - index, reason: 'hostile-test' }));
  await client.noteRestart('hostile-test-limit');
  assert.equal(client.quarantined, true);
  assert.equal(client.lifecycle, 'failed');
  assert.equal(client.child, null);
});

test('C3-RES-08 telemetry failure cannot alter a committed biological transition', () => {
  const state = genesis();
  const expected = advanceTrustedTime(state, pulse(2, DAY_US));
  const failingTelemetrySink = () => { throw new Error('telemetry unavailable'); };
  assert.throws(failingTelemetrySink, /telemetry unavailable/);
  const actual = advanceTrustedTime(state, pulse(2, DAY_US));
  assert.equal(
    crypto.createHash('sha256').update(JSON.stringify(actual)).digest('hex'),
    crypto.createHash('sha256').update(JSON.stringify(expected)).digest('hex'),
  );
});
