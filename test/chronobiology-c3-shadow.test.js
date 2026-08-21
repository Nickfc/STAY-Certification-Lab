'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createCore, manifest } = require('../cores/chronobiology/c3');
const { SUMMARY_CADENCE_US, SUMMARY_TOPIC } = require('../cores/chronobiology/c3/summary');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const { EventFabric } = require('../runtime/kernel/event-fabric');
const {
  AUTHORITY_MODE,
  DURABILITY_CLASS,
  SIGNAL_CLASS,
  TEMPORAL_TYPE,
} = require('../runtime/kernel/biological-envelope');
const { BiologicalSignallingFabric } = require('../runtime/kernel/biological-signalling-fabric');
const { validateManifest } = require('../runtime/kernel/manifest');
const { ResidentManager, CHRONOBIOLOGY_RESIDENT_CONTRACT } = require('../runtime/kernel/resident-manager');
const { StateStore } = require('../runtime/kernel/state-store');

const RELEASE_ROOT = path.resolve(__dirname, '..');
const MODULE = 'cores/chronobiology/c3/index.js';

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function binding(identity = { organismId: 'stay-c3-shadow', lineage: 'STAY/Genesis' }) {
  return {
    bindingVersion: 1,
    identitySha256: sha256(identity),
    organismLineage: identity.lineage,
    issuedAt: 1_000,
    runtimeRevision: 1,
    authorityEpoch: 1,
    kernelVersion: '0.8.11.3',
  };
}

function bindingEvent(identity) {
  const payload = binding(identity);
  return {
    id: 'c3-shadow-binding',
    topic: 'runtime.organism.binding',
    payload,
    meta: { sourceCore: 'living-kernel', authorityEpoch: payload.authorityEpoch },
  };
}

function pulseEvent(sequence, trustedTimeUs) {
  return {
    id: `c3-shadow-pulse-${sequence}`,
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

async function makeRuntime(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-chronobiology-c3b-'));
  const stateStore = new StateStore(dataDir);
  await stateStore.init();
  let now = 1_000;
  const fabric = new EventFabric({
    clock: () => now,
    sequenceAllocator: ({ minimum }) => stateStore.reserveEventSequence(minimum),
    durableAppender: envelope => stateStore.appendBiologicalEvent(envelope),
  });
  const identity = { organismId: 'stay-c3-shadow', lineage: 'STAY/Genesis' };
  const managers = [];
  const createManager = () => {
    const manager = new ResidentManager({
      releaseRoot: RELEASE_ROOT,
      stateStore,
      fabric,
      identity,
      clock: () => now,
      logger: { log() {}, info() {}, warn() {}, error() {} },
      contracts: [CHRONOBIOLOGY_RESIDENT_CONTRACT],
    });
    managers.push(manager);
    return manager;
  };
  t.after(async () => {
    for (const manager of managers.reverse()) await manager.shutdown().catch(() => {});
    stateStore.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return {
    stateStore,
    fabric,
    identity,
    createManager,
    setNow(value) { now = value; },
  };
}

async function publishPulse(runtime, sequence, trustedTimeUs) {
  runtime.setNow(1_000 + sequence);
  const event = pulseEvent(sequence, trustedTimeUs);
  return runtime.fabric.publish(event.topic, event.payload, {
    ...event.meta,
    sourceVersion: '0.8.11.3',
    eventClass: 'durable',
    deduplicationKey: event.id,
  });
}

test('C3-SHD-01 summary is context-only, schema-complete and explicitly SHADOW', async () => {
  const outputs = [];
  const core = await createCore({
    emit: async (topic, payload, meta) => outputs.push({ topic, payload, meta }),
  });
  const identity = { organismId: 'stay-c3-shadow-direct', lineage: 'STAY/Genesis' };
  await core.handle(bindingEvent(identity));
  await core.handle(pulseEvent(1, 0));
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].topic, SUMMARY_TOPIC);
  assert.equal(outputs[0].payload.mode, 'SHADOW');
  assert.equal(outputs[0].payload.schema, 'chronobiology.phase-summary/v1');
  assert.deepEqual(Object.keys(outputs[0].payload).sort(), [
    'alignment_stability_q',
    'calibration_profile_id',
    'central_phase_q',
    'cue_coverage_q',
    'effective_period_us',
    'entrainment_strength_q',
    'evidence_quality',
    'mode',
    'model_version',
    'oscillator_coherence_q',
    'phase_resolvability_q',
    'phase_velocity_q',
    'rhythm_amplitude_q',
    'schema',
  ]);
  assert.doesNotMatch(stableStringify(outputs[0].payload),
    /transmitter|receptor|concentration|mutation|command|target_core/i);
});

test('C3-SHD-02 cadence derives only from trusted biology and remains bounded', async () => {
  const outputs = [];
  const core = await createCore({ emit: async (_topic, payload) => outputs.push(payload) });
  const identity = { organismId: 'stay-c3-shadow-cadence', lineage: 'STAY/Genesis' };
  await core.handle(bindingEvent(identity));
  await core.handle(pulseEvent(1, 0));
  for (let minute = 1; minute < 15; minute += 1) {
    await core.handle(pulseEvent(minute + 1, minute * 60_000_000));
  }
  assert.equal(outputs.length, 1);
  await core.handle(pulseEvent(16, SUMMARY_CADENCE_US));
  assert.equal(outputs.length, 2);
  assert.equal((await core.snapshot()).continuity.last_summary_emitted_us,
    SUMMARY_CADENCE_US);
});

test('C3-SHD-03 same checkpoint and trusted event replay byte-identical summary and state', async () => {
  const firstOutputs = [];
  const first = await createCore({ emit: async (_topic, payload) => firstOutputs.push(payload) });
  const identity = { organismId: 'stay-c3-shadow-replay', lineage: 'STAY/Genesis' };
  await first.handle(bindingEvent(identity));
  await first.handle(pulseEvent(1, 0));
  const checkpoint = await first.snapshot();

  const leftOutputs = [];
  const rightOutputs = [];
  const left = await createCore({ initialState: checkpoint,
    emit: async (_topic, payload) => leftOutputs.push(payload) });
  const right = await createCore({ initialState: checkpoint,
    emit: async (_topic, payload) => rightOutputs.push(payload) });
  const event = pulseEvent(2, SUMMARY_CADENCE_US);
  await left.handle(event);
  await right.handle(event);
  assert.equal(stableStringify(leftOutputs), stableStringify(rightOutputs));
  assert.equal(stableStringify(await left.snapshot()), stableStringify(await right.snapshot()));
});

test('C3-SHD-04 resident checkpoint, ACK and SHADOW output publish as one outbox transition', async t => {
  const runtime = await makeRuntime(t);
  const observed = [];
  runtime.fabric.subscribeAll(event => { if (event.topic === SUMMARY_TOPIC) observed.push(event); });
  const manager = runtime.createManager();
  await manager.attach({ moduleRelativePath: MODULE, binding: binding(runtime.identity) });
  const cause = await publishPulse(runtime, 1, 0);
  await manager.drain('resident:chronobiology', cause.sequence);

  assert.equal(observed.length, 1, stableStringify({
    status: await manager.status('resident:chronobiology'),
    pending: runtime.stateStore.listPendingBiologicalOutboxIntents({
      producerCoreId: 'chronobiology',
    }),
  }));
  assert.equal(observed[0].meta.authorityMode, 'shadow');
  assert.equal(observed[0].meta.physiologicalAuthority, false);
  assert.equal(observed[0].meta.causalParent, cause.id);
  assert.equal(observed[0].payload.mode, 'SHADOW');
  assert.deepEqual(runtime.stateStore.listAuthority(), []);
  assert.equal(runtime.stateStore.listPendingBiologicalOutboxIntents({
    producerCoreId: 'chronobiology',
  }).length, 0);
  const checkpoint = await runtime.stateStore.readResidentCheckpoint('resident:chronobiology');
  assert.equal(checkpoint.state.continuity.last_summary_emitted_us, 0);
  const status = await manager.status('resident:chronobiology');
  assert.equal(status.authorityOwned, false);
  assert.equal(status.observedOutputs, 1);
});

test('C3-SHD-05 manager recovery drains the exact pre-crash durable output identity', async t => {
  const runtime = await makeRuntime(t);
  const observed = [];
  runtime.fabric.subscribeAll(event => { if (event.topic === SUMMARY_TOPIC) observed.push(event); });
  const first = runtime.createManager();
  await first.attach({ moduleRelativePath: MODULE, binding: binding(runtime.identity) });

  const originalPublish = runtime.fabric.publish.bind(runtime.fabric);
  let failSummary = true;
  runtime.fabric.publish = async (topic, payload, meta) => {
    if (topic === SUMMARY_TOPIC && failSummary) {
      failSummary = false;
      throw Object.assign(new Error('simulated fabric outage'), { code: 'C3_SHADOW_OUTAGE' });
    }
    return originalPublish(topic, payload, meta);
  };
  const cause = await publishPulse(runtime, 1, 0);
  await first.drain('resident:chronobiology', cause.sequence);
  const pending = runtime.stateStore.listPendingBiologicalOutboxIntents({
    producerCoreId: 'chronobiology',
  });
  assert.equal(pending.length, 1, stableStringify({
    status: await first.status('resident:chronobiology'),
    observed,
  }));
  const producerEventId = pending[0].producerEventId;

  await first.shutdown();
  runtime.fabric.publish = originalPublish;
  const recovered = runtime.createManager();
  await recovered.recover('resident:chronobiology', binding(runtime.identity));

  assert.equal(observed.length, 1);
  assert.equal(observed[0].meta.deduplicationKey, `core-output:${producerEventId}`);
  assert.equal(observed[0].meta.authorityMode, 'shadow');
  assert.equal(runtime.stateStore.listPendingBiologicalOutboxIntents({
    producerCoreId: 'chronobiology',
  }).length, 0);
});

test('C3-SHD-06 shadow identity is not live authority or an SNTSS mutation surface', () => {
  assert.equal(CHRONOBIOLOGY_RESIDENT_CONTRACT.signalling, 'LAB_SHADOW_ONLY');
  assert.equal(CHRONOBIOLOGY_RESIDENT_CONTRACT.authorityMode, 'shadow');
  assert.equal(CHRONOBIOLOGY_RESIDENT_CONTRACT.productionEligible, false);
  assert.deepEqual(manifest.biology.producerCapabilities[0].allowedAuthorityModes,
    ['shadow']);
  assert.deepEqual(manifest.biology.consumerRouteLeases, []);
  assert.equal(manifest.inputs.includes('sntss'), false);
});

test('C3-SHD-07 BSF capability accepts SHADOW and rejects authority relabeling', () => {
  const bsf = new BiologicalSignallingFabric();
  bsf.installManifest(validateManifest(validateManifest(manifest)));
  const proposal = {
    producer_event_id: `sha256:${'a'.repeat(64)}`,
    producer_stream_id: 'core:chronobiology:outputs',
    stream_sequence: 1,
    topic: SUMMARY_TOPIC,
    signal_class: SIGNAL_CLASS.CHRONOBIOLOGICAL_CONTEXT,
    schema_version: 1,
    temporal: { type: TEMPORAL_TYPE.STATE_AS_OF, at_us: 0 },
    valid_from_us: 0,
    expires_at_us: 7_200_000_000,
    durability_class: DURABILITY_CLASS.DURABLE_TRANSITION,
    payload: { schema: 'chronobiology.phase-summary/v1', mode: 'SHADOW' },
    direct_parents: [],
    causal_source_spans: [],
  };
  assert.doesNotThrow(() => bsf.validateProposal({
    producer: { coreId: 'chronobiology', authorityMode: AUTHORITY_MODE.SHADOW },
    proposal,
  }));
  assert.throws(() => bsf.validateProposal({
    producer: { coreId: 'chronobiology', authorityMode: AUTHORITY_MODE.AUTHORITATIVE },
    proposal,
  }), { code: 'BIOLOGICAL_BSF_CAPABILITY' });
});

test('C3-SHD-08 corrupt newest checkpoint recovers prior valid state by finalized replay', async t => {
  const runtime = await makeRuntime(t);
  const observed = [];
  runtime.fabric.subscribeAll(event => { if (event.topic === SUMMARY_TOPIC) observed.push(event); });
  const first = runtime.createManager();
  await first.attach({ moduleRelativePath: MODULE, binding: binding(runtime.identity) });
  const genesis = await publishPulse(runtime, 1, 0);
  await first.drain('resident:chronobiology', genesis.sequence);
  const later = await publishPulse(runtime, 2, SUMMARY_CADENCE_US);
  await first.drain('resident:chronobiology', later.sequence);
  const expected = (await runtime.stateStore.readResidentCheckpoint(
    'resident:chronobiology')).state;
  const outputCount = observed.length;
  await first.shutdown();

  const newest = await runtime.stateStore.readResidentCheckpoint('resident:chronobiology');
  await fs.writeFile(runtime.stateStore.blobPath(newest.blobHash), 'corrupt-checkpoint');
  const recovered = runtime.createManager();
  await recovered.recover('resident:chronobiology', binding(runtime.identity));
  const actual = (await runtime.stateStore.readResidentCheckpoint(
    'resident:chronobiology')).state;
  assert.equal(stableStringify(actual), stableStringify(expected));
  assert.equal(observed.length, outputCount);
});

test('C3-SHD-09 no retained valid checkpoint fails closed without founder reroll', async t => {
  const runtime = await makeRuntime(t);
  const first = runtime.createManager();
  await first.attach({ moduleRelativePath: MODULE, binding: binding(runtime.identity) });
  const genesis = await publishPulse(runtime, 1, 0);
  await first.drain('resident:chronobiology', genesis.sequence);
  await first.shutdown();
  const hashes = runtime.stateStore.db.prepare(`
    SELECT DISTINCT blob_hash FROM resident_checkpoints WHERE residency_id=?
  `).all('resident:chronobiology').map(row => row.blob_hash);
  for (const hash of hashes) await fs.writeFile(runtime.stateStore.blobPath(hash), 'corrupt-all');
  const recovered = runtime.createManager();
  await assert.rejects(
    () => recovered.recover('resident:chronobiology', binding(runtime.identity)),
    { code: 'RESIDENT_CHECKPOINT_NO_VALID' },
  );
  assert.equal(runtime.stateStore.getResident('resident:chronobiology').checkpointGeneration > 0,
    true);
});

test('C3-SHD-10 semantically invalid newest state falls back to a CoreHost-valid checkpoint', async t => {
  const runtime = await makeRuntime(t);
  const first = runtime.createManager();
  await first.attach({ moduleRelativePath: MODULE, binding: binding(runtime.identity) });
  const genesis = await publishPulse(runtime, 1, 0);
  await first.drain('resident:chronobiology', genesis.sequence);
  const expected = (await runtime.stateStore.readResidentCheckpoint(
    'resident:chronobiology')).state;
  await first.shutdown();

  const resident = runtime.stateStore.getResident('resident:chronobiology');
  const invalid = structuredClone(expected);
  invalid.acquired.oscillators[7].phase_q = -1;
  await runtime.stateStore.commitResidentCheckpoint({
    residencyId: resident.residencyId,
    instanceId: resident.instanceId,
    version: resident.version,
    stateSchema: resident.stateSchema,
    state: invalid,
  });
  const recovered = runtime.createManager();
  await recovered.recover('resident:chronobiology', binding(runtime.identity));
  const actual = (await runtime.stateStore.readResidentCheckpoint(
    'resident:chronobiology')).state;
  assert.equal(stableStringify(actual), stableStringify(expected));
});

test('C3-SHD-11 missing finalized replay evidence fails closed', async t => {
  const runtime = await makeRuntime(t);
  const first = runtime.createManager();
  await first.attach({ moduleRelativePath: MODULE, binding: binding(runtime.identity) });
  const genesis = await publishPulse(runtime, 1, 0);
  await first.drain('resident:chronobiology', genesis.sequence);
  const later = await publishPulse(runtime, 2, SUMMARY_CADENCE_US);
  await first.drain('resident:chronobiology', later.sequence);
  await first.shutdown();
  const newest = await runtime.stateStore.readResidentCheckpoint('resident:chronobiology');
  await fs.writeFile(runtime.stateStore.blobPath(newest.blobHash), 'corrupt-checkpoint');
  runtime.stateStore.db.prepare('DELETE FROM biological_events WHERE sequence=?').run(later.sequence);
  const recovered = runtime.createManager();
  await assert.rejects(
    () => recovered.recover('resident:chronobiology', binding(runtime.identity)),
    { code: 'RESIDENT_FINALIZED_REPLAY_INCOMPLETE' },
  );
});
