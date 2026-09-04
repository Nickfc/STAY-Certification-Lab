'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { DURABILITY, createSignal, deriveSignal } = require('../runtime/kernel/biological-fabric');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const { EventFabric } = require('../runtime/kernel/event-fabric');
const {
  LivingKernel,
  R146_METAB_Q48_HOMEOS_RECOVERY,
  R147_HOMEOS_FORWARD_RECOVERY
} = require('../runtime/kernel/living-kernel');
const { validateManifest } = require('../runtime/kernel/manifest');
const { ResidentManager } = require('../runtime/kernel/resident-manager');
const { StateStore } = require('../runtime/kernel/state-store');
const { METAB_SHADOW_RESIDENT_CONTRACT } = require('../runtime/p1-r0/metab-shadow-contract');
const { METAB_HOMEOS_RESIDENT_CONTRACT } = require('../runtime/p1-r0/metab-homeos-contract');
const { HOMEOS_NEUTRAL_RESIDENT_CONTRACT } = require('../runtime/p1-r0/homeos-neutral-contract');
const { HOMEOS_SHADOW_RESIDENT_CONTRACT } = require('../runtime/p1-r0/homeos-shadow-contract');
const {
  createCapacityPayloads,
  createCapacitySourceState,
  stageCapacitySample
} = require('../runtime/p1-r0/metab-capacity-source');
const {
  HOMEOS_NEUTRAL_AUTHORIZATION_CLASS,
  HOMEOS_NEUTRAL_BIRTH_FORMAT
} = require('../runtime/p1-r0/homeos-neutral-birth-authority');
const {
  PRODUCTION_STORAGE_AUTHORIZATION,
  P1ProductionExpansionPersistence
} = require('../runtime/p1-r0/production-persistence');
const { recordHash } = require('../runtime/p1-r0/records');
const { sha256 } = require('../runtime/p1-r0/resident-support');
const packageHashes = require('../runtime/p1-r0/resident-package-hashes.json');
const neutralMetab = require('../runtime/p1-r0/residents/metab-neutral');
const shadowMetab = require('../runtime/p1-r0/residents/metab-shadow');
const metabHomeos = require('../runtime/p1-r0/residents/metab-homeos');
const neutralHomeos = require('../runtime/p1-r0/residents/homeos-neutral');
const shadowHomeos = require('../runtime/p1-r0/residents/homeos-shadow');
const profiles = require(
  '../runtime/p1-r0/c0-source-contracts/contracts/founder_profile_templates.json'
).profiles;
const {
  FORMAT: REVISION_FREEZE_FORMAT,
  sealRevisionFreeze
} = require('../runtime/revision-freeze');

const INSTANCE_METAB = 'd424c722-ef31-44b0-8201-ba68c418d14a';
const INSTANCE_HOMEOS = 'a0f0c4dd-dced-4643-984a-8717e5f2e30f';
const IDENTITY = Object.freeze({
  organismId: 'stay-r145-homeos-shadow-test',
  createdAt: '2026-09-03T08:00:00.000Z',
  lineage: 'STAY/Genesis'
});
const IDENTITY_HASH = sha256(IDENTITY);
const PARENT_FREEZE = `sha256:${'7'.repeat(64)}`;
const ROOT = path.resolve(__dirname, '..');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function binding(runtimeRevision = 141) {
  return {
    bindingVersion: 1,
    identitySha256: IDENTITY_HASH,
    organismLineage: IDENTITY.lineage,
    issuedAt: 10_000,
    runtimeRevision,
    authorityEpoch: runtimeRevision,
    kernelVersion: '0.8.11.3'
  };
}

function founder(coreId, mode = 'NEUTRAL') {
  const profile = clone(profiles[coreId]);
  profile.profileId = `${coreId.toLowerCase()}.p1-r0.production-r145-test.v1`;
  return {
    recordVersion: 'P1ResidentFounderBindingV1',
    coreId,
    organismId: IDENTITY.organismId,
    organismIdentityHash: IDENTITY_HASH,
    founderId: `founder:${coreId.toLowerCase()}:r145:test`,
    lineageId: `lineage:${coreId.toLowerCase()}:r145:test`,
    residencyId: `resident:${coreId.toLowerCase()}`,
    profileId: profile.profileId,
    profileHash: sha256(profile),
    profile,
    mode,
    authorityEpoch: '0'
  };
}

function homeosFounderRecord() {
  const source = founder('HOMEOS');
  return {
    recordVersion: 'P1FounderRecordV1',
    organismId: source.organismId,
    coreId: source.coreId,
    founderId: source.founderId,
    lineageId: source.lineageId,
    profileId: source.profileId,
    profileHash: source.profileHash,
    founderSchemaId: 'urn:stay:p1-r0:schema:homeos-founder-profile:v1',
    founderSchemaVersion: '1',
    genesisFrame: 0,
    genesisTransactionId: 'tx:homeos:r143:entry-test',
    phenotypeHash: sha256({ coreId: source.coreId, profile: source.profile }),
    committed: true,
    previousFounderId: null
  };
}

function eventFromSignal(signal, sequence, { sourceVersion, evidenceHash = null } = {}) {
  return Object.freeze({
    id: `evt-${sequence}`,
    sequence,
    topic: signal.topic,
    class: 'durable',
    payload: clone(signal.payload),
    at: signal.trustedTime.observedAtMs,
    deadlineAt: null,
    meta: Object.freeze({
      eventClass: 'durable',
      sourceCore: signal.provenance.producerId,
      sourceVersion,
      authorityEpoch: signal.provenance.authorityEpoch,
      evidenceHash,
      biological: clone({
        protocol: signal.protocol,
        signalId: signal.signalId,
        durability: signal.durability,
        trustedTime: signal.trustedTime,
        causality: signal.causality,
        provenance: signal.provenance
      })
    }),
    ledger: Object.freeze({ durable: true })
  });
}

function currentMetabActivation() {
  const checkpointHash = `sha256:${'1'.repeat(64)}`;
  return createSignal({
    signalId: `runtime.metab.shadow-activation:r139:g1:${checkpointHash.slice(7)}`,
    topic: shadowMetab.ACTIVATION_TOPIC,
    payload: {
      protocol: 'stay-p1-r0-metab-shadow-activation-v1',
      organismIdentityHash: IDENTITY_HASH,
      residencyId: 'resident:metab',
      instanceId: INSTANCE_METAB,
      fromVersion: neutralMetab.VERSION,
      fromStateSchema: 1,
      sourceCheckpointGeneration: 1,
      sourceCheckpointHash: checkpointHash,
      toVersion: shadowMetab.VERSION,
      toStateSchema: 2,
      runtimeRevision: 139,
      parentRevision: 127,
      parentFreezeRecordSha256: PARENT_FREEZE,
      mode: 'SHADOW',
      authorityEpoch: '0',
      outputPolicy: 'FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT'
    },
    trustedTime: {
      source: 'kernel',
      observedAtMs: 20_000,
      pulseId: 'metab-shadow-activation-r139-g1'
    },
    provenance: {
      producerType: 'kernel',
      producerId: 'living-kernel',
      authorityEpoch: 139
    },
    durability: DURABILITY.DURABLE
  });
}

async function currentMetabShadowState(bindingRevision = 124) {
  const neutralState = neutralMetab.createNeutralMetabInitialState({
    binding: binding(bindingRevision),
    founder: founder('METAB')
  });
  const state = await shadowMetab.migrateState({ state: neutralState, fromSchema: 1, toSchema: 2 });
  const core = await shadowMetab.createCore({ initialState: state });
  await core.start();
  await core.handle(eventFromSignal(currentMetabActivation(), 1, {
    sourceVersion: '0.8.11.3',
    evidenceHash: IDENTITY_HASH
  }));
  return core.snapshot();
}

async function managedPromotionRuntime(t, { includeHomeos = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r145-homeos-'));
  const stateStore = new StateStore(root);
  await stateStore.init();
  let now = 80_000;
  const fabric = new EventFabric({
    clock: () => now++,
    sequenceAllocator: ({ minimum }) => stateStore.reserveEventSequence(minimum),
    durableAppender: envelope => stateStore.appendBiologicalEvent(envelope)
  });
  const manager = new ResidentManager({
    releaseRoot: ROOT,
    stateStore,
    fabric,
    identity: IDENTITY,
    clock: () => now++,
    logger: { log() {}, info() {}, warn() {}, error() {} },
    contracts: [METAB_SHADOW_RESIDENT_CONTRACT, HOMEOS_NEUTRAL_RESIDENT_CONTRACT]
  });
  t.after(async () => {
    await manager.shutdown().catch(() => {});
    try { stateStore.close(); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });
  await manager.attach({
    moduleRelativePath: 'cores/p1-r0/metab-shadow/index.js',
    binding: binding(141),
    initialState: await currentMetabShadowState(141),
    instanceId: INSTANCE_METAB
  });
  if (includeHomeos) {
    await manager.attach({
      moduleRelativePath: 'cores/p1-r0/homeos-neutral/index.js',
      binding: binding(141),
      initialState: neutralHomeos.createNeutralHomeosInitialState({
        binding: binding(141),
        founder: founder('HOMEOS')
      }),
      instanceId: INSTANCE_HOMEOS
    });
  }
  await stateStore.writeLife('identity', IDENTITY);
  await stateStore.writeLife('organism-binding', binding(141));
  await stateStore.writeLife('runtime-revision', {
    revision: 141,
    reason: 'r141f.accepted',
    at: '2026-09-03T07:59:59.000Z',
    kernelVersion: '0.8.11.3'
  });
  async function publishActivation(topic, payload, targetRevision, sequenceLabel) {
    const signal = createSignal({
      signalId: `${topic}:test:${sequenceLabel}`,
      topic,
      payload,
      trustedTime: {
        source: 'kernel',
        observedAtMs: now++,
        pulseId: `${topic}:pulse:${sequenceLabel}`
      },
      provenance: {
        producerType: 'kernel',
        producerId: 'living-kernel',
        authorityEpoch: targetRevision
      },
      durability: DURABILITY.DURABLE
    });
    return fabric.publishBiologicalSignal(signal, {
      eventClass: 'critical',
      sourceVersion: '0.8.11.3',
      evidenceHash: IDENTITY_HASH
    });
  }
  return { root, stateStore, fabric, manager, publishActivation };
}

function metabHomeosActivation(sourceCheckpointHash = `sha256:${'2'.repeat(64)}`) {
  return {
    protocol: 'stay-p1-r0-metab-homeos-route-activation-v1',
    organismIdentityHash: IDENTITY_HASH,
    residencyId: 'resident:metab',
    instanceId: INSTANCE_METAB,
    fromVersion: shadowMetab.VERSION,
    fromStateSchema: 2,
    sourceCheckpointGeneration: 2,
    sourceCheckpointHash,
    toVersion: metabHomeos.VERSION,
    toStateSchema: 3,
    targetRevision: 144,
    parentRevision: 141,
    parentFreezeRecordSha256: PARENT_FREEZE,
    mode: 'SHADOW',
    authorityEpoch: '0',
    outputPolicy: metabHomeos.OUTPUT_POLICY,
    routes: [...metabHomeos.HOMEOS_ROUTES]
  };
}

function homeosActivation(
  sourceCheckpointHash = `sha256:${'3'.repeat(64)}`,
  sourceCheckpointGeneration = 1
) {
  return {
    protocol: 'stay-p1-r0-homeos-shadow-activation-v1',
    organismIdentityHash: IDENTITY_HASH,
    residencyId: 'resident:homeos',
    instanceId: INSTANCE_HOMEOS,
    fromVersion: neutralHomeos.VERSION,
    fromStateSchema: 1,
    sourceCheckpointGeneration,
    sourceCheckpointHash,
    toVersion: shadowHomeos.VERSION,
    toStateSchema: 2,
    targetRevision: 145,
    parentRevision: 141,
    parentFreezeRecordSha256: PARENT_FREEZE,
    mode: 'SHADOW',
    authorityEpoch: '0',
    outputPolicy: shadowHomeos.OUTPUT_POLICY
  };
}

function activationEvent(topic, payload, sequence, targetRevision) {
  return {
    id: `activation-${sequence}`,
    sequence,
    topic,
    class: 'durable',
    payload: clone(payload),
    at: 30_000 + sequence,
    deadlineAt: null,
    meta: {
      eventClass: 'durable',
      sourceCore: 'living-kernel',
      sourceVersion: '0.8.11.3',
      authorityEpoch: targetRevision,
      evidenceHash: IDENTITY_HASH
    },
    ledger: { durable: true }
  };
}

function capacitySignals(frame, observedAtMs = 40_000) {
  const payloads = createCapacityPayloads({
    sampleFrame: frame,
    metrics: {
      cpuCount: 4,
      loadAverageMilli: 1000,
      freeMemoryBytes: 6_000,
      totalMemoryBytes: 8_000
    }
  });
  const trustedTime = {
    source: 'kernel',
    observedAtMs,
    pulseId: `metab-capacity-r128-f${frame}`
  };
  const provenance = {
    producerType: 'kernel',
    producerId: 'kernel-resource',
    authorityEpoch: 0
  };
  const eligible = createSignal({
    signalId: `runtime.metab.capacity.eligible:r128:f${frame}`,
    topic: shadowMetab.ELIGIBLE_TOPIC,
    payload: payloads.eligiblePayload,
    trustedTime,
    provenance,
    durability: DURABILITY.DURABLE
  });
  const quality = deriveSignal(eligible, {
    signalId: `runtime.metab.capacity.quality:r128:f${frame}`,
    topic: shadowMetab.QUALITY_TOPIC,
    payload: payloads.qualityPayload,
    trustedTime,
    provenance,
    durability: DURABILITY.DURABLE
  });
  return { eligible, quality };
}

test('R145-HOMEOS-01 production packages keep exact resources and authority containment', () => {
  for (const definition of [metabHomeos, neutralHomeos, shadowHomeos]) {
    const checked = validateManifest(definition.manifest);
    assert.equal(checked.productionEligible, false);
    assert.equal(checked.priority, 'optional');
    assert.equal(checked.resources.handlerTimeoutMs, 250);
    assert.equal(checked.resources.hardRamMiB, 96);
    assert.equal(checked.resources.pidsMax, 16);
  }
  assert.match(packageHashes.METAB_HOMEOS, /^sha256:[0-9a-f]{64}$/);
  assert.match(packageHashes.HOMEOS_NEUTRAL, /^sha256:[0-9a-f]{64}$/);
  assert.match(packageHashes.HOMEOS_SHADOW, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(neutralHomeos.manifest.outputs, []);
  assert.deepEqual(shadowHomeos.manifest.outputs, []);
  assert.deepEqual(metabHomeos.manifest.outputs, [
    'metab.energy.availability.v1',
    'metab.energy.reserve.v1'
  ]);
});

test('R145-HOMEOS-02 METAB opens only delayed HOMEOS summaries without changing physiology', async () => {
  const sourceState = await currentMetabShadowState();
  const staged = await metabHomeos.migrateState({ state: sourceState, fromSchema: 2, toSchema: 3 });
  const outputs = [];
  const core = await metabHomeos.createCore({
    initialState: staged,
    emit: async (topic, payload, meta) => outputs.push({ topic, payload, meta })
  });
  await core.start();
  await assert.rejects(
    () => core.handle(eventFromSignal(capacitySignals(1).eligible, 2, { sourceVersion: '1.0.0' })),
    { code: 'P1_METAB_HOMEOS_UNACTIVATED' }
  );
  await core.handle(activationEvent(
    metabHomeos.ACTIVATION_TOPIC,
    metabHomeosActivation(),
    3,
    144
  ));
  const signals = capacitySignals(1);
  await core.handle(eventFromSignal(signals.eligible, 4, { sourceVersion: '1.0.0' }));
  await core.handle(eventFromSignal(signals.quality, 5, { sourceVersion: '1.0.0' }));
  assert.deepEqual(outputs.map(output => output.topic), [
    'metab.energy.availability.v1',
    'metab.energy.reserve.v1'
  ]);
  assert.deepEqual(outputs.map(output => output.payload.route.routeId), metabHomeos.HOMEOS_ROUTES);
  assert.equal(outputs.every(output => output.payload.producer.mode === 'SHADOW'), true);
  assert.equal(outputs.every(output => output.payload.visibleFromFrame === 2), true);
  assert.equal(outputs.every(output => output.payload.route.consumerCoreId === 'HOMEOS'), true);
  const state = await core.snapshot();
  assert.equal(state.sourceState.engineState.frameIndex, 1);
  assert.equal(state.routedEngineState.frameIndex, 1);
  assert.equal(state.routedEngineState.outputSequence, '4');
  assert.equal(state.emittedOutputSequence, '2');
  assert.equal((await core.health()).authorityOwned, false);
});

test('R145-HOMEOS-03 HOMEOS preserves founder, consumes committed delayed pairs, and emits zero', async () => {
  const sourceState = await currentMetabShadowState();
  const routedState = await metabHomeos.migrateState({ state: sourceState, fromSchema: 2, toSchema: 3 });
  const metabOutputs = [];
  const metab = await metabHomeos.createCore({
    initialState: routedState,
    emit: async (topic, payload, meta) => metabOutputs.push({ topic, payload, meta })
  });
  await metab.start();
  await metab.handle(activationEvent(metabHomeos.ACTIVATION_TOPIC, metabHomeosActivation(), 3, 144));
  const signals = capacitySignals(1);
  await metab.handle(eventFromSignal(signals.eligible, 4, { sourceVersion: '1.0.0' }));
  await metab.handle(eventFromSignal(signals.quality, 5, { sourceVersion: '1.0.0' }));

  const originalFounder = founder('HOMEOS');
  const neutralState = neutralHomeos.createNeutralHomeosInitialState({
    binding: binding(143),
    founder: originalFounder
  });
  let emitted = 0;
  const homeos = await neutralHomeos.createCore({
    initialState: neutralState,
    emit: async () => { emitted += 1; }
  });
  await homeos.start();
  await homeos.handle({ topic: metabOutputs[0].topic, payload: metabOutputs[0].payload });
  await homeos.handle({ topic: metabOutputs[1].topic, payload: metabOutputs[1].payload });
  const consumed = await homeos.snapshot();
  assert.equal(consumed.engineState.frameIndex, 2);
  assert.equal(consumed.engineState.outputSequence, '0');
  assert.equal(consumed.handledEvents, 2);
  assert.equal(sha256(consumed.founder), sha256(originalFounder));
  assert.equal(emitted, 0);

  const stagedShadow = await shadowHomeos.migrateState({
    state: consumed,
    fromSchema: 1,
    toSchema: 2
  });
  const shadow = await shadowHomeos.createCore({
    initialState: stagedShadow,
    emit: async () => { emitted += 1; }
  });
  await shadow.start();
  assert.equal((await shadow.health()).ok, false);
  await shadow.handle(activationEvent(
    shadowHomeos.ACTIVATION_TOPIC,
    homeosActivation(),
    6,
    145
  ));
  const accepted = await shadow.snapshot();
  const health = await shadow.health();
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'SHADOW');
  assert.equal(health.authorityOwned, false);
  assert.equal(health.biologicalOutputs, 0);
  assert.equal(sha256(accepted.neutralState.founder), sha256(originalFounder));
  assert.equal(stableStringify(accepted.neutralState.engineState), stableStringify(consumed.engineState));
  assert.equal(emitted, 0);

  const restarted = await shadowHomeos.createCore({ initialState: accepted });
  await restarted.start();
  assert.equal(stableStringify(await restarted.snapshot()), stableStringify(accepted));
});

test('R145-HOMEOS-04 forged authority, identity, route, and activation changes fail closed', async () => {
  const neutralState = neutralHomeos.createNeutralHomeosInitialState({
    binding: binding(143),
    founder: founder('HOMEOS')
  });
  const stagedShadow = await shadowHomeos.migrateState({ state: neutralState, fromSchema: 1, toSchema: 2 });
  const core = await shadowHomeos.createCore({ initialState: stagedShadow });
  await core.start();

  const forged = activationEvent(shadowHomeos.ACTIVATION_TOPIC, homeosActivation(), 1, 145);
  forged.meta.authorityEpoch = 0;
  await assert.rejects(() => core.handle(forged), { code: 'P1_HOMEOS_SHADOW_ACTIVATION' });

  const accepted = activationEvent(shadowHomeos.ACTIVATION_TOPIC, homeosActivation(), 2, 145);
  await core.handle(accepted);
  const changed = homeosActivation();
  changed.sourceCheckpointGeneration = 2;
  await assert.rejects(
    () => core.handle(activationEvent(shadowHomeos.ACTIVATION_TOPIC, changed, 3, 145)),
    { code: 'P1_HOMEOS_SHADOW_ACTIVATION' }
  );
  const changedBinding = binding(143);
  changedBinding.identitySha256 = `sha256:${'a'.repeat(64)}`;
  await assert.rejects(
    () => core.handle({ topic: 'runtime.organism.binding', payload: changedBinding }),
    { code: 'P1_HOMEOS_NEUTRAL_IDENTITY' }
  );
  await assert.rejects(
    () => core.handle({ topic: 'runtime.forbidden', payload: {} }),
    { code: 'P1_HOMEOS_NEUTRAL_INPUT' }
  );
  assert.equal((await core.health()).authorityOwned, false);
});

test('R145-HOMEOS-05 manager commits both generation changes atomically without identity drift', async t => {
  const runtime = await managedPromotionRuntime(t);
  const metabBefore = runtime.stateStore.getResident('resident:metab');
  const homeosBefore = runtime.stateStore.getResident('resident:homeos');
  const metab = await runtime.manager.promoteP1ContainedGeneration({
    kind: 'METAB_HOMEOS_ROUTE_R144',
    moduleRelativePath: 'cores/p1-r0/metab-homeos/index.js',
    binding: binding(141),
    nextContract: METAB_HOMEOS_RESIDENT_CONTRACT,
    publishActivation: async ({ sourceCheckpoint, resident }) => runtime.publishActivation(
      metabHomeos.ACTIVATION_TOPIC,
      metabHomeosActivation(`sha256:${sourceCheckpoint.blobHash}`),
      144,
      `${resident.instanceId}:g${sourceCheckpoint.generation}`
    )
  });
  const metabAfter = runtime.stateStore.getResident('resident:metab');
  assert.equal(metab.residencyId, 'resident:metab');
  assert.equal(metabAfter.instanceId, metabBefore.instanceId);
  assert.equal(metabAfter.organismIdentityHash, metabBefore.organismIdentityHash);
  assert.equal(metabAfter.version, metabHomeos.VERSION);
  assert.equal(metabAfter.stateSchema, 3);
  assert.equal(metabAfter.checkpointGeneration, metabBefore.checkpointGeneration + 3);
  assert.equal((await runtime.manager.status('resident:metab')).authorityOwned, false);

  const capacity = capacitySignals(1, 90_000);
  await runtime.fabric.publishBiologicalSignal(capacity.eligible, {
    eventClass: 'durable',
    sourceVersion: '1.0.0'
  });
  const qualityEvent = await runtime.fabric.publishBiologicalSignal(capacity.quality, {
    eventClass: 'durable',
    sourceVersion: '1.0.0'
  });
  await runtime.manager.drain('resident:metab', qualityEvent.sequence);
  await runtime.manager.drain('resident:homeos', qualityEvent.sequence + 2);
  const routedStatus = await runtime.manager.status('resident:metab');
  const neutralStatus = await runtime.manager.status('resident:homeos');
  assert.equal(routedStatus.observedOutputs, 2);
  assert.equal(runtime.stateStore.listPendingBiologicalOutboxIntents({
    producerCoreId: 'METAB'
  }).length, 0);
  assert.equal(neutralStatus.health.physiologicalInputs, 2);
  assert.equal(neutralStatus.observedOutputs, 0);
  const homeosPrePromotion = runtime.stateStore.getResident('resident:homeos');

  const homeos = await runtime.manager.promoteP1ContainedGeneration({
    kind: 'HOMEOS_NEUTRAL_TO_SHADOW_R145',
    moduleRelativePath: 'cores/p1-r0/homeos-shadow/index.js',
    binding: binding(141),
    nextContract: HOMEOS_SHADOW_RESIDENT_CONTRACT,
    publishActivation: async ({ sourceCheckpoint, resident }) => runtime.publishActivation(
      shadowHomeos.ACTIVATION_TOPIC,
      homeosActivation(`sha256:${sourceCheckpoint.blobHash}`, sourceCheckpoint.generation),
      145,
      `${resident.instanceId}:g${sourceCheckpoint.generation}`
    )
  });
  const homeosAfter = runtime.stateStore.getResident('resident:homeos');
  assert.equal(homeos.residencyId, 'resident:homeos');
  assert.equal(homeosAfter.instanceId, homeosBefore.instanceId);
  assert.equal(homeosAfter.organismIdentityHash, homeosBefore.organismIdentityHash);
  assert.equal(homeosAfter.version, shadowHomeos.VERSION);
  assert.equal(homeosAfter.stateSchema, 2);
  assert.equal(homeosAfter.checkpointGeneration, homeosPrePromotion.checkpointGeneration + 3);
  const status = await runtime.manager.status('resident:homeos');
  assert.equal(status.running, true);
  assert.equal(status.health.mode, 'SHADOW');
  assert.equal(status.authorityOwned, false);
  assert.equal(status.observedOutputs, 0);
  assert.deepEqual(runtime.stateStore.listAuthority(), []);
});

test('R145-HOMEOS-ENTRY-06 real LivingKernel path reaches R145 output-firewalled SHADOW', async t => {
  const runtime = await managedPromotionRuntime(t, { includeHomeos: false });
  const freezeDirectory = path.join(runtime.root, 'runtime-freezes');
  const publicKeyPath = path.join(runtime.root, 'release-authority.pub');
  const certificateFile = path.join(runtime.root, 'homeos-neutral-birth.json');
  await fs.mkdir(freezeDirectory, { recursive: true });
  const parentFreeze = sealRevisionFreeze({
    format: REVISION_FREEZE_FORMAT,
    result: 'PASS',
    acceptance: 'ACCEPTED',
    freezeType: 'R141F_METAB_SHADOW_ACCEPTANCE',
    runtime: { revision: 141, revisionLabel: 'R141F' }
  });
  const freezeFile = path.join(freezeDirectory, 'R141.json');
  await fs.writeFile(freezeFile, `${stableStringify(parentFreeze)}\n`, {
    encoding: 'utf8', mode: 0o444
  });
  await fs.chmod(freezeFile, 0o444);

  let wallClock = 1_800_000_000_000;
  let trustedTimeUs = 40_001_000;
  const kernel = new LivingKernel({
    dataDir: runtime.root,
    releaseRoot: ROOT,
    logger: { log() {}, info() {}, warn() {}, error() {} },
    clock: () => wallClock++,
    heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0,
    homeosNeutralBirthAuthorization: 'AUTHORIZE_R143_HOMEOS_NEUTRAL_BIRTH_ONLY',
    metabHomeosRouteAuthorization: 'AUTHORIZE_R144_METAB_HOMEOS_ROUTE_ONLY',
    homeosShadowPromotionAuthorization: 'AUTHORIZE_R145_HOMEOS_OUTPUT_FIREWALLED_SHADOW_ONLY',
    homeosNeutralBirthPublicKeyPath: publicKeyPath,
    homeosNeutralBirthCertificateFile: certificateFile,
    runtimeFreezeDirectory: freezeDirectory,
    metabCapacitySampler: () => ({
      cpuCount: 4,
      loadAverageMilli: 1000,
      freeMemoryBytes: 6_000,
      totalMemoryBytes: 8_000
    })
  });
  kernel.stateStore = runtime.stateStore;
  kernel.fabric = runtime.fabric;
  kernel.identity = IDENTITY;
  kernel.runtimeRevision = 142;
  kernel.residentManager = runtime.manager;
  kernel.trustedOrganismTime = {
    sample: async () => {
      const value = trustedTimeUs;
      trustedTimeUs += 300_000;
      return { status: 'TRUSTED', trustedTimeUs: value, continuityEpoch: 1 };
    }
  };

  const inspected = await runtime.manager.inspect(
    'cores/p1-r0/homeos-neutral/index.js',
    'resident:homeos',
    HOMEOS_NEUTRAL_RESIDENT_CONTRACT
  );
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  await fs.writeFile(
    publicKeyPath,
    publicKey.export({ type: 'spki', format: 'pem' }),
    { encoding: 'utf8', mode: 0o444 }
  );
  await fs.chmod(publicKeyPath, 0o444);
  const founderBinding = founder('HOMEOS');
  const body = {
    allowedAction: 'birth-homeos-neutral',
    authorizationClass: HOMEOS_NEUTRAL_AUTHORIZATION_CLASS,
    certificateId: 'r143-homeos-neutral-kernel-entry-test',
    expiresAtMs: wallClock + 60_000,
    founderBinding,
    founderDossierSha256: recordHash({
      status: 'PRODUCTION_FOUNDER_CANDIDATE',
      reviewedProfile: founderBinding.profile,
      noAuthority: true
    }),
    founderRecord: homeosFounderRecord(),
    issuedAtMs: wallClock - 1_000,
    manifestHash: inspected.manifestHash,
    moduleHash: inspected.definition.moduleDigest,
    organismId: IDENTITY.organismId,
    organismIdentityHash: IDENTITY_HASH,
    packagePolicyHash: inspected.definition.packagePolicyHash,
    parentFreezeRecordSha256: parentFreeze.recordSha256,
    parentRevision: 141,
    residencyId: 'resident:homeos',
    targetRevision: 143,
    version: neutralHomeos.VERSION
  };
  const certificate = {
    format: HOMEOS_NEUTRAL_BIRTH_FORMAT,
    body,
    signature: crypto.sign(
      null,
      Buffer.from(stableStringify(body)),
      privateKey
    ).toString('base64')
  };
  await fs.writeFile(certificateFile, `${stableStringify(certificate)}\n`, {
    encoding: 'utf8', mode: 0o444
  });
  await fs.chmod(certificateFile, 0o444);

  await kernel.birthHomeosNeutral();
  assert.equal(kernel.runtimeRevision, 143);
  await kernel.promoteMetabHomeosRoute();
  assert.equal(kernel.runtimeRevision, 144);
  const routedHomeos = await runtime.manager.status('resident:homeos');
  assert.equal(routedHomeos.health.physiologicalInputs >= 2, true);
  assert.equal(routedHomeos.observedOutputs, 0);
  await kernel.promoteHomeosShadow();
  assert.equal(kernel.runtimeRevision, 145);

  const metab = await runtime.manager.status('resident:metab');
  const homeos = await runtime.manager.status('resident:homeos');
  assert.equal(metab.health.mode, 'SHADOW');
  assert.equal(metab.health.outputPolicy, metabHomeos.OUTPUT_POLICY);
  assert.equal(metab.authorityOwned, false);
  assert.equal(homeos.health.mode, 'SHADOW');
  assert.equal(homeos.health.outputPolicy, shadowHomeos.OUTPUT_POLICY);
  assert.equal(homeos.health.biologicalOutputs, 0);
  assert.equal(homeos.observedOutputs, 0);
  assert.equal(homeos.authorityOwned, false);
  assert.deepEqual(runtime.stateStore.listAuthority(), []);
  assert.equal(runtime.stateStore.listPendingBiologicalOutboxIntents().length, 0);
  const storage = new P1ProductionExpansionPersistence({
    stateStore: runtime.stateStore,
    authorization: PRODUCTION_STORAGE_AUTHORIZATION
  }).initialize();
  assert.equal(storage.legacy.readChip('resident:homeos').currentState, 'SHADOW');
});

test('R145-HOMEOS-RECOVERY-07 exact stranded R145 cohort completes without revision rewind or authority', async t => {
  const runtime = await managedPromotionRuntime(t, { includeHomeos: false });
  const freezeDirectory = path.join(runtime.root, 'runtime-freezes');
  const publicKeyPath = path.join(runtime.root, 'release-authority.pub');
  const certificateFile = path.join(runtime.root, 'homeos-neutral-birth.json');
  await fs.mkdir(freezeDirectory, { recursive: true });
  const parentFreeze = sealRevisionFreeze({
    format: REVISION_FREEZE_FORMAT,
    result: 'PASS',
    acceptance: 'ACCEPTED',
    freezeType: 'R141F_METAB_SHADOW_ACCEPTANCE',
    runtime: { revision: 141, revisionLabel: 'R141F' }
  });
  await fs.writeFile(
    path.join(freezeDirectory, 'R141.json'),
    `${stableStringify(parentFreeze)}\n`,
    { encoding: 'utf8', mode: 0o444 }
  );

  let wallClock = 1_800_000_000_000;
  let trustedTimeUs = 40_001_000;
  const kernel = new LivingKernel({
    dataDir: runtime.root,
    releaseRoot: ROOT,
    logger: { log() {}, info() {}, warn() {}, error() {} },
    clock: () => wallClock++,
    heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0,
    homeosNeutralBirthAuthorization: 'AUTHORIZE_R143_HOMEOS_NEUTRAL_BIRTH_ONLY',
    metabHomeosRouteAuthorization: 'AUTHORIZE_R144_METAB_HOMEOS_ROUTE_ONLY',
    homeosShadowPromotionAuthorization: 'AUTHORIZE_R145_HOMEOS_OUTPUT_FIREWALLED_SHADOW_ONLY',
    homeosStrandedR145RecoveryAuthorization:
      'AUTHORIZE_STRANDED_R145_HOMEOS_FORWARD_RECOVERY_ONLY',
    homeosNeutralBirthPublicKeyPath: publicKeyPath,
    homeosNeutralBirthCertificateFile: certificateFile,
    runtimeFreezeDirectory: freezeDirectory,
    metabCapacitySampler: () => ({
      cpuCount: 4,
      loadAverageMilli: 1000,
      freeMemoryBytes: 6_000,
      totalMemoryBytes: 8_000
    })
  });
  kernel.stateStore = runtime.stateStore;
  kernel.fabric = runtime.fabric;
  kernel.identity = IDENTITY;
  kernel.runtimeRevision = 145;
  kernel.residentManager = runtime.manager;
  kernel.trustedOrganismTime = {
    sample: async () => {
      const value = trustedTimeUs;
      trustedTimeUs += 300_000;
      return { status: 'TRUSTED', trustedTimeUs: value, continuityEpoch: 1 };
    }
  };

  const inspected = await runtime.manager.inspect(
    'cores/p1-r0/homeos-neutral/index.js',
    'resident:homeos',
    HOMEOS_NEUTRAL_RESIDENT_CONTRACT
  );
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  await fs.writeFile(
    publicKeyPath,
    publicKey.export({ type: 'spki', format: 'pem' }),
    { encoding: 'utf8', mode: 0o444 }
  );
  const founderBinding = founder('HOMEOS');
  const body = {
    allowedAction: 'birth-homeos-neutral',
    authorizationClass: HOMEOS_NEUTRAL_AUTHORIZATION_CLASS,
    certificateId: 'r143-homeos-neutral-stranded-r145-recovery-test',
    expiresAtMs: wallClock + 60_000,
    founderBinding,
    founderDossierSha256: recordHash({
      status: 'PRODUCTION_FOUNDER_CANDIDATE',
      reviewedProfile: founderBinding.profile,
      noAuthority: true
    }),
    founderRecord: homeosFounderRecord(),
    issuedAtMs: wallClock - 1_000,
    manifestHash: inspected.manifestHash,
    moduleHash: inspected.definition.moduleDigest,
    organismId: IDENTITY.organismId,
    organismIdentityHash: IDENTITY_HASH,
    packagePolicyHash: inspected.definition.packagePolicyHash,
    parentFreezeRecordSha256: parentFreeze.recordSha256,
    parentRevision: 141,
    residencyId: 'resident:homeos',
    targetRevision: 143,
    version: neutralHomeos.VERSION
  };
  await fs.writeFile(certificateFile, `${stableStringify({
    format: HOMEOS_NEUTRAL_BIRTH_FORMAT,
    body,
    signature: crypto.sign(
      null,
      Buffer.from(stableStringify(body)),
      privateKey
    ).toString('base64')
  })}\n`, { encoding: 'utf8', mode: 0o444 });

  assert.equal(kernel.preserveExactR145HomeosProgressRevision(), true);
  assert.equal(kernel.homeosStrandedR145RecoveryActive, true);
  await kernel.recoverStrandedR145Homeos();

  const metab = await runtime.manager.status('resident:metab');
  const homeos = await runtime.manager.status('resident:homeos');
  assert.equal(kernel.runtimeRevision, 145);
  assert.equal(kernel.p1ExpansionFetusInstallRevisionPreservation, 145);
  assert.equal(metab.version, metabHomeos.VERSION);
  assert.equal(metab.health.mode, 'SHADOW');
  assert.equal(homeos.version, shadowHomeos.VERSION);
  assert.equal(homeos.health.mode, 'SHADOW');
  assert.equal(homeos.observedOutputs, 0);
  assert.equal(homeos.authorityOwned, false);
  assert.deepEqual(runtime.stateStore.listAuthority(), []);
  assert.equal(runtime.stateStore.listPendingBiologicalOutboxIntents().length, 0);
});

test('R145-HOMEOS-REVISION-08 only exact durable progress or recovery cohorts preserve revision', () => {
  const residents = new Map([
    ['resident:metab', {
      version: shadowMetab.VERSION,
      stateSchema: 2,
      moduleRelativePath: 'cores/p1-r0/metab-shadow/index.js',
      status: 'RUNNING'
    }],
    ['resident:homeos', {
      version: neutralHomeos.VERSION,
      stateSchema: 1,
      moduleRelativePath: 'cores/p1-r0/homeos-neutral/index.js',
      status: 'RUNNING'
    }]
  ]);
  const harness = {
    runtimeRevision: 143,
    homeosNeutralBirthAuthorization: 'AUTHORIZE_R143_HOMEOS_NEUTRAL_BIRTH_ONLY',
    metabHomeosRouteAuthorization: 'AUTHORIZE_R144_METAB_HOMEOS_ROUTE_ONLY',
    homeosShadowPromotionAuthorization: 'AUTHORIZE_R145_HOMEOS_OUTPUT_FIREWALLED_SHADOW_ONLY',
    stateStore: {
      getResident: residencyId => residents.get(residencyId) || null,
      listAuthority: () => []
    }
  };
  assert.equal(LivingKernel.prototype.preserveExactR145HomeosProgressRevision.call(harness), true);
  harness.runtimeRevision = 144;
  residents.set('resident:metab', {
    version: metabHomeos.VERSION,
    stateSchema: 3,
    moduleRelativePath: 'cores/p1-r0/metab-homeos/index.js',
    status: 'RUNNING'
  });
  assert.equal(LivingKernel.prototype.preserveExactR145HomeosProgressRevision.call(harness), true);
  harness.stateStore.listAuthority = () => [{ coreId: 'HOMEOS' }];
  assert.equal(LivingKernel.prototype.preserveExactR145HomeosProgressRevision.call(harness), false);

  harness.stateStore.listAuthority = () => [];
  residents.delete('resident:homeos');
  residents.set('resident:metab', {
    instanceId: INSTANCE_METAB,
    version: shadowMetab.VERSION,
    stateSchema: 2,
    moduleRelativePath: 'cores/p1-r0/metab-shadow/index.js',
    status: 'RUNNING'
  });
  harness.runtimeRevision = 145;
  harness.stateStore.getBiologicalConsumer = () => null;
  harness.homeosStrandedR145RecoveryAuthorization = '';
  assert.equal(LivingKernel.prototype.preserveExactR145HomeosProgressRevision.call(harness), false);
  harness.homeosStrandedR145RecoveryAuthorization =
    'AUTHORIZE_STRANDED_R145_HOMEOS_FORWARD_RECOVERY_ONLY';
  assert.equal(LivingKernel.prototype.preserveExactR145HomeosProgressRevision.call(harness), true);
  assert.equal(harness.homeosStrandedR145RecoveryActive, true);
});

test('R146-HOMEOS-RECOVERY-09 only the exact repaired zero-debt METAB cohort preserves R146', () => {
  const checkpointHash = 'c'.repeat(64);
  const metab = {
    instanceId: R146_METAB_Q48_HOMEOS_RECOVERY.metabInstanceId,
    version: R146_METAB_Q48_HOMEOS_RECOVERY.metabVersion,
    stateSchema: R146_METAB_Q48_HOMEOS_RECOVERY.metabStateSchema,
    moduleRelativePath: R146_METAB_Q48_HOMEOS_RECOVERY.metabModuleRelativePath,
    moduleHash: R146_METAB_Q48_HOMEOS_RECOVERY.metabModuleHash,
    manifestHash: R146_METAB_Q48_HOMEOS_RECOVERY.metabManifestHash,
    packagePolicyHash: R146_METAB_Q48_HOMEOS_RECOVERY.metabPackagePolicyHash,
    status: 'RESYNC_REQUIRED',
    checkpointGeneration: R146_METAB_Q48_HOMEOS_RECOVERY.checkpointGeneration,
    checkpointHash
  };
  const rows = {
    checkpoint: {
      checkpoint_id: R146_METAB_Q48_HOMEOS_RECOVERY.checkpointId,
      instance_id: R146_METAB_Q48_HOMEOS_RECOVERY.metabInstanceId,
      version: R146_METAB_Q48_HOMEOS_RECOVERY.metabVersion,
      state_schema: R146_METAB_Q48_HOMEOS_RECOVERY.metabStateSchema,
      generation: R146_METAB_Q48_HOMEOS_RECOVERY.checkpointGeneration,
      blob_hash: checkpointHash,
      byte_length: 3880,
      input_cursor: R146_METAB_Q48_HOMEOS_RECOVERY.inputCursor
    },
    failure: {
      id: R146_METAB_Q48_HOMEOS_RECOVERY.failureRecordId,
      detail_json: JSON.stringify({
        sequence: R146_METAB_Q48_HOMEOS_RECOVERY.failureSequence,
        topic: 'resource.capacity.quality.v1',
        code: 'P1_Q48_OVERFLOW'
      })
    },
    repair: {
      detail_json: JSON.stringify({
        repairId: R146_METAB_Q48_HOMEOS_RECOVERY.repairId,
        repairedCheckpointHash: checkpointHash,
        abandonedCount: 0,
        inventedBiologicalTime: false,
        authorityChanged: false
      })
    },
    capacity: (() => {
      const json = JSON.stringify({ lastCommittedFrame: 98001, pending: null });
      return { json, sha256: crypto.createHash('sha256').update(json).digest('hex') };
    })()
  };
  const harness = {
    runtimeRevision: 146,
    homeosNeutralBirthAuthorization: 'AUTHORIZE_R143_HOMEOS_NEUTRAL_BIRTH_ONLY',
    metabHomeosRouteAuthorization: 'AUTHORIZE_R144_METAB_HOMEOS_ROUTE_ONLY',
    homeosShadowPromotionAuthorization: 'AUTHORIZE_R145_HOMEOS_OUTPUT_FIREWALLED_SHADOW_ONLY',
    homeosStrandedR145RecoveryAuthorization: '',
    homeosStrandedR146RecoveryAuthorization:
      R146_METAB_Q48_HOMEOS_RECOVERY.authorization,
    homeosStrandedR145RecoveryActive: false,
    homeosStrandedRecoveryRevision: null,
    metabQ48R146RecoveryActive: false,
    stateStore: {
      getResident: id => id === 'resident:metab' ? metab : null,
      getBiologicalConsumer: id => id === 'resident:metab' ? {
        coreId: 'METAB', required: false, active: false,
        cursor: R146_METAB_Q48_HOMEOS_RECOVERY.inputCursor,
        authorityEpoch: 0, checkpointHash
      } : null,
      listAuthority: () => [],
      db: {
        prepare: sql => ({
          get: () => sql.includes('resident_checkpoints') ? rows.checkpoint
            : sql.includes("type='resident.resync-required'") ? rows.failure
              : sql.includes("type='resident.implementation-repaired'") ? rows.repair
                : sql.includes("key='life:p1-r0-metab-capacity-source'") ? rows.capacity
                : { count: 0 }
        })
      }
    }
  };
  assert.equal(
    LivingKernel.prototype.preserveExactR145HomeosProgressRevision.call(harness),
    true
  );
  assert.equal(harness.homeosStrandedRecoveryRevision, 146);
  assert.equal(harness.metabQ48R146RecoveryActive, true);
  assert.equal(
    LivingKernel.prototype.isExactStrandedHomeosRecovery.call(harness, true),
    true
  );
  metab.moduleHash = `sha256:${'d'.repeat(64)}`;
  harness.homeosStrandedR145RecoveryActive = false;
  harness.metabQ48R146RecoveryActive = false;
  assert.equal(
    LivingKernel.prototype.preserveExactR145HomeosProgressRevision.call(harness),
    false
  );
});

test('R146-HOMEOS-RECOVERY-10 resumes only the exact neutral-birth route partial state', () => {
  const metabCheckpointHash = 'a'.repeat(64);
  const homeosCheckpointHash = 'b'.repeat(64);
  const repairedCheckpointHash = 'c'.repeat(64);
  const metab = {
    instanceId: R146_METAB_Q48_HOMEOS_RECOVERY.metabInstanceId,
    version: R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabVersion,
    stateSchema: R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabStateSchema,
    moduleRelativePath: R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabModuleRelativePath,
    moduleHash: R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabModuleHash,
    manifestHash: R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabManifestHash,
    packagePolicyHash: R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabPackagePolicyHash,
    status: 'RUNNING', checkpointGeneration: 196035, checkpointHash: metabCheckpointHash
  };
  const homeos = {
    instanceId: R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosInstanceId,
    version: R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosVersion,
    stateSchema: R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosStateSchema,
    moduleRelativePath: R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosModuleRelativePath,
    moduleHash: R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosModuleHash,
    manifestHash: R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosManifestHash,
    packagePolicyHash: R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosPackagePolicyHash,
    status: 'RUNNING', checkpointGeneration: 1, checkpointHash: homeosCheckpointHash
  };
  const base = {
    ...createCapacitySourceState({
      instanceId: R146_METAB_Q48_HOMEOS_RECOVERY.metabInstanceId,
      residentVersion: R146_METAB_Q48_HOMEOS_RECOVERY.metabVersion
    }),
    lastCommittedFrame: 98004,
    lastTrustedTimeUs: 1_000_000,
    lastContinuityEpoch: 1
  };
  const source = stageCapacitySample(base, {
    trustedTimeUs: 1_250_000,
    continuityEpoch: 1,
    metrics: { cpuCount: 4, loadAverageMilli: 0, freeMemoryBytes: 8_000, totalMemoryBytes: 8_000 }
  });
  const capacityJson = JSON.stringify(source);
  const repairDetail = JSON.stringify({
    repairId: R146_METAB_Q48_HOMEOS_RECOVERY.repairId,
    repairedCheckpointHash,
    abandonedCount: 0,
    inventedBiologicalTime: false,
    authorityChanged: false
  });
  const harness = {
    runtimeRevision: 146,
    homeosNeutralBirthAuthorization: 'AUTHORIZE_R143_HOMEOS_NEUTRAL_BIRTH_ONLY',
    metabHomeosRouteAuthorization: 'AUTHORIZE_R144_METAB_HOMEOS_ROUTE_ONLY',
    homeosShadowPromotionAuthorization: 'AUTHORIZE_R145_HOMEOS_OUTPUT_FIREWALLED_SHADOW_ONLY',
    homeosStrandedR145RecoveryAuthorization: '',
    homeosStrandedR146RecoveryAuthorization: R146_METAB_Q48_HOMEOS_RECOVERY.authorization,
    homeosStrandedR145RecoveryActive: false,
    homeosStrandedRecoveryRevision: null,
    metabQ48R146RecoveryActive: false,
    homeosStrandedR146PartialRecoveryActive: false,
    stateStore: {
      getResident: id => id === 'resident:metab' ? metab : id === 'resident:homeos' ? homeos : null,
      getBiologicalConsumer: id => id === 'resident:metab'
        ? { coreId: 'METAB', required: false, active: true, authorityEpoch: 0, checkpointHash: metabCheckpointHash }
        : id === 'resident:homeos'
          ? { coreId: 'HOMEOS', required: false, active: true, authorityEpoch: 0, checkpointHash: null }
          : null,
      listAuthority: () => [],
      db: {
        prepare: sql => ({
          get: (...args) => {
            if (sql.includes('resident_checkpoints')) {
              if (args[0] === 'resident:homeos') return {
                instance_id: homeos.instanceId, version: homeos.version,
                state_schema: homeos.stateSchema, generation: 1, blob_hash: homeosCheckpointHash
              };
              if (Number(args[1]) === R146_METAB_Q48_HOMEOS_RECOVERY.checkpointGeneration) return {
                checkpoint_id: R146_METAB_Q48_HOMEOS_RECOVERY.checkpointId,
                instance_id: metab.instanceId, version: R146_METAB_Q48_HOMEOS_RECOVERY.metabVersion,
                state_schema: R146_METAB_Q48_HOMEOS_RECOVERY.metabStateSchema,
                generation: R146_METAB_Q48_HOMEOS_RECOVERY.checkpointGeneration,
                blob_hash: repairedCheckpointHash,
                input_cursor: R146_METAB_Q48_HOMEOS_RECOVERY.inputCursor
              };
              return {
                instance_id: metab.instanceId, version: metab.version,
                state_schema: metab.stateSchema, generation: metab.checkpointGeneration,
                blob_hash: metabCheckpointHash
              };
            }
            if (sql.includes("type='resident.resync-required'")) return {
              id: R146_METAB_Q48_HOMEOS_RECOVERY.failureRecordId,
              detail_json: JSON.stringify({ sequence: R146_METAB_Q48_HOMEOS_RECOVERY.failureSequence,
                topic: 'resource.capacity.quality.v1', code: 'P1_Q48_OVERFLOW' })
            };
            if (sql.includes("type='resident.implementation-repaired'")) return { detail_json: repairDetail };
            if (sql.includes("type='resident.recovered'")) return { detail_json: JSON.stringify({
              residencyId: 'resident:metab', instanceId: metab.instanceId,
              version: metab.version, checkpointHash: metabCheckpointHash
            }) };
            if (sql.includes("type='resident.attached'")) return { detail_json: JSON.stringify({
              residencyId: 'resident:homeos', instanceId: homeos.instanceId,
              version: homeos.version, checkpointHash: homeosCheckpointHash
            }) };
            if (sql.includes("key='life:p1-r0-metab-capacity-source'")) return {
              json: capacityJson,
              sha256: crypto.createHash('sha256').update(capacityJson).digest('hex')
            };
            return { count: 0 };
          }
        })
      }
    }
  };
  assert.equal(LivingKernel.prototype.preserveExactR145HomeosProgressRevision.call(harness), true);
  assert.equal(harness.homeosStrandedRecoveryRevision, 146);
  assert.equal(harness.metabQ48R146RecoveryActive, true);
  assert.equal(harness.homeosStrandedR146PartialRecoveryActive, true);
  const badSource = clone(source);
  badSource.pending.sampleFrame += 1;
  const badJson = JSON.stringify(badSource);
  harness.stateStore.db.prepare = sql => ({ get: (...args) => {
    if (sql.includes("key='life:p1-r0-metab-capacity-source'")) return {
      json: badJson, sha256: crypto.createHash('sha256').update(badJson).digest('hex')
    };
    return { count: 0 };
  } });
  harness.homeosStrandedR145RecoveryActive = false;
  harness.metabQ48R146RecoveryActive = false;
  harness.homeosStrandedR146PartialRecoveryActive = false;
  assert.equal(LivingKernel.prototype.preserveExactR145HomeosProgressRevision.call(harness), false);
});

test('R146-HOMEOS-RECOVERY-11 repairs only the exact route-boundary checkpoint', async () => {
  const sourceState = await currentMetabShadowState();
  const routedState = await metabHomeos.migrateState({
    state: sourceState,
    fromSchema: 2,
    toSchema: 3
  });
  const frames = [];
  const metab = await metabHomeos.createCore({
    initialState: routedState,
    emit: async (_topic, payload) => frames.push(clone(payload))
  });
  await metab.start();
  await metab.handle(activationEvent(
    metabHomeos.ACTIVATION_TOPIC,
    metabHomeosActivation(),
    3,
    144
  ));
  const signals = capacitySignals(1);
  await metab.handle(eventFromSignal(signals.eligible, 4, { sourceVersion: '1.0.0' }));
  await metab.handle(eventFromSignal(signals.quality, 5, { sourceVersion: '1.0.0' }));
  assert.equal(frames.length, 2);

  function retainedFrame(template, committedFrame, producerSequence) {
    const frame = clone(template);
    delete frame.frameId;
    frame.committedFrame = committedFrame;
    frame.visibleFromFrame = committedFrame + 1;
    frame.producerSequence = String(producerSequence);
    return { frameId: sha256(frame), ...frame };
  }

  const neutralState = clone(neutralHomeos.createNeutralHomeosInitialState({
    binding: binding(143),
    founder: founder('HOMEOS')
  }));
  neutralState.engineState.frameIndex = shadowHomeos.R146_ROUTE_BOUNDARY.engineFrame;
  neutralState.engineState.lifecycle = 'STABLE';
  neutralState.engineState.inputCursors = {
    'p1r0.metab-availability.homeos': String(
      shadowHomeos.R146_ROUTE_BOUNDARY.availabilityProducerSequence
    ),
    'p1r0.metab-reserve.homeos': String(
      shadowHomeos.R146_ROUTE_BOUNDARY.reserveProducerSequence
    )
  };
  neutralState.engineState.dimensions[0].sourceSequence = String(
    shadowHomeos.R146_ROUTE_BOUNDARY.availabilityProducerSequence
  );
  neutralState.engineState.dimensions[1].sourceSequence = String(
    shadowHomeos.R146_ROUTE_BOUNDARY.reserveProducerSequence
  );
  neutralState.handledEvents = shadowHomeos.R146_ROUTE_BOUNDARY.handledEvents;
  for (
    let frame = shadowHomeos.R146_ROUTE_BOUNDARY.firstRetainedSourceFrame;
    frame <= shadowHomeos.R146_ROUTE_BOUNDARY.lastRetainedSourceFrame;
    frame += 1
  ) {
    const offset = frame - shadowHomeos.R146_ROUTE_BOUNDARY.firstRetainedSourceFrame;
    neutralState.pendingAvailability[String(frame)] = retainedFrame(
      frames.find(value => value.topic.name === neutralHomeos.AVAILABILITY_TOPIC),
      frame,
      shadowHomeos.R146_ROUTE_BOUNDARY.firstRetainedAvailabilitySequence + offset * 2
    );
    neutralState.pendingReserve[String(frame)] = retainedFrame(
      frames.find(value => value.topic.name === neutralHomeos.RESERVE_TOPIC),
      frame,
      shadowHomeos.R146_ROUTE_BOUNDARY.firstRetainedReserveSequence + offset * 2
    );
  }
  const activation = homeosActivation(
    shadowHomeos.R146_ROUTE_BOUNDARY.activationSourceCheckpointHash,
    shadowHomeos.R146_ROUTE_BOUNDARY.activationSourceCheckpointGeneration
  );
  activation.instanceId = '3f32bdc9-fa49-4eea-8c13-b9afe6b47c0f';
  const exactState = {
    schema: 'stay-p1-r0-resident/homeos-shadow-state-v2',
    activation: {
      ...activation,
      eventId: shadowHomeos.R146_ROUTE_BOUNDARY.activationEventId,
      eventSequence: shadowHomeos.R146_ROUTE_BOUNDARY.activationEventSequence
    },
    neutralState
  };
  const before = stableStringify(exactState);
  const repaired = shadowHomeos.repairExactR146RouteBoundaryState(exactState);
  assert.equal(stableStringify(exactState), before);
  assert.deepEqual(repaired.evidence, {
    cohort: 'r146-homeos-route-boundary-v1',
    missingSourceFrame: 98007,
    absentFrameSemantics: 'UNKNOWN',
    retainedPairCount: 16,
    firstRetainedSourceFrame: 98008,
    lastRetainedSourceFrame: 98023,
    fromEngineFrame: 98007,
    toEngineFrame: 98024,
    checkpointBytesChanged: true,
    biologicalStateChanged: true,
    physiologyApplied: 16,
    abandonedCount: 0,
    inventedBiologicalTime: false,
    authorityChanged: false,
    biologicalOutputs: 0
  });
  assert.equal(repaired.state.neutralState.engineState.frameIndex, 98024);
  assert.equal(repaired.state.neutralState.engineState.outputSequence, '0');
  assert.equal(repaired.state.neutralState.engineState.lifecycle, 'STABLE');
  assert.deepEqual(repaired.state.neutralState.pendingAvailability, {});
  assert.deepEqual(repaired.state.neutralState.pendingReserve, {});

  const prunedPair = [
    {
      topic: neutralHomeos.AVAILABILITY_TOPIC,
      payload: retainedFrame(
        frames.find(value => value.topic.name === neutralHomeos.AVAILABILITY_TOPIC),
        shadowHomeos.R146_ROUTE_BOUNDARY.lastRetainedSourceFrame + 1,
        39
      )
    },
    {
      topic: neutralHomeos.RESERVE_TOPIC,
      payload: retainedFrame(
        frames.find(value => value.topic.name === neutralHomeos.RESERVE_TOPIC),
        shadowHomeos.R146_ROUTE_BOUNDARY.lastRetainedSourceFrame + 1,
        40
      )
    }
  ];
  const recoveredPruned = shadowHomeos.applyExactR146PrunedOutboxPair(
    repaired.state,
    prunedPair
  );
  assert.equal(recoveredPruned.state.neutralState.engineState.frameIndex, 98025);
  assert.equal(recoveredPruned.state.neutralState.engineState.outputSequence, '0');
  assert.equal(
    recoveredPruned.state.neutralState.handledEvents,
    repaired.state.neutralState.handledEvents + 2
  );
  assert.deepEqual(recoveredPruned.evidence, {
    cohort: 'r146-homeos-pruned-delivery-recovery-v1',
    sourceFrame: 98024,
    producerSequences: ['39', '40'],
    handledEventsAdded: 2,
    physiologyApplied: 1,
    biologicalOutputs: 0,
    abandonedCount: 0,
    inventedBiologicalTime: false,
    authorityChanged: false
  });

  const driftedPair = clone(prunedPair);
  driftedPair[1].payload.producerSequence = '41';
  assert.throws(
    () => shadowHomeos.applyExactR146PrunedOutboxPair(repaired.state, driftedPair),
    { code: 'P1_HOMEOS_R146_PRUNED_PAIR' }
  );

  const drifted = clone(exactState);
  drifted.neutralState.pendingReserve['98023'].producerSequence = '999';
  await assert.rejects(
    async () => shadowHomeos.repairExactR146RouteBoundaryState(drifted),
    { code: 'P1_HOMEOS_R146_ROUTE_BOUNDARY' }
  );
});

test('R146-HOMEOS-RECOVERY-12 begins only the exact two-delivery replay atomically', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r146-homeos-replay-'));
  const stateStore = new StateStore(root);
  await stateStore.init();
  t.after(async () => {
    try { stateStore.close(); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });
  const expected = R146_METAB_Q48_HOMEOS_RECOVERY;
  const at = '2026-09-04T01:00:00.000Z';
  stateStore.db.prepare(`INSERT INTO resident_instances(
    residency_id,core_id,role,instance_id,version,state_schema,module_relative_path,
    module_hash,manifest_hash,package_policy_hash,organism_identity_hash,
    checkpoint_hash,checkpoint_generation,status,attached_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'resident:homeos', 'HOMEOS', 'optional', expected.finalHomeosInstanceId,
    expected.finalHomeosVersion, expected.finalHomeosStateSchema,
    expected.finalHomeosModuleRelativePath, expected.finalHomeosModuleHash,
    expected.finalHomeosManifestHash, expected.finalHomeosPackagePolicyHash,
    IDENTITY_HASH, expected.finalHomeosCheckpointHash,
    expected.finalHomeosCheckpointGeneration, 'RESYNC_REQUIRED', at, at
  );
  stateStore.db.prepare(`INSERT INTO resident_checkpoints(
    checkpoint_id,residency_id,instance_id,version,state_schema,generation,
    blob_hash,byte_length,input_cursor,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    expected.finalHomeosCheckpointId, 'resident:homeos', expected.finalHomeosInstanceId,
    expected.finalHomeosVersion, expected.finalHomeosStateSchema,
    expected.finalHomeosCheckpointGeneration, expected.finalHomeosCheckpointHash,
    expected.finalHomeosCheckpointBytes, expected.finalHomeosInputCursor, at
  );
  stateStore.db.prepare(`INSERT INTO biological_consumers(
    consumer_id,core_id,required,active,topics_json,topics_sha256,cursor,
    authority_epoch,checkpoint_hash,registered_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    'resident:homeos', 'HOMEOS', 0, 0,
    JSON.stringify(shadowHomeos.manifest.inputs), expected.finalHomeosTopicsHash,
    expected.finalHomeosConsumerCursor, 0, expected.finalHomeosCheckpointHash, at, at
  );
  const pending = [
    [4241117, 'metab.energy.availability.v1',
      'core-output:dd4f1feb2e23462bc77206e91d066aa9e88d41ba145228599d7e64ef0a0ed8dd'],
    [4241118, 'metab.energy.reserve.v1',
      'core-output:63fadd3d778d1132eed2ec1ff533a69825b2fd2524ec16d2b35d81d01e8aeef9']
  ];
  for (const [sequence, topic, deduplicationKey] of pending) {
    stateStore.db.prepare(`INSERT INTO biological_events(
      sequence,event_id,topic,event_class,at_ms,deadline_at_ms,envelope_json,
      envelope_sha256,payload_sha256,provenance_sha256,deduplication_key,
      deduplication_sha256,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      sequence, `evt-r146-homeos-${sequence}`, topic, 'durable', sequence, null,
      '{}', 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), deduplicationKey,
      'd'.repeat(64), at
    );
    stateStore.db.prepare(`INSERT INTO biological_deliveries(
      sequence,consumer_id,status
    ) VALUES(?,?,'PENDING')`).run(sequence, 'resident:homeos');
  }
  stateStore.db.prepare(`INSERT INTO recovery_records(
    type,core_id,detail_json,created_at
  ) VALUES('resident.implementation-repaired','HOMEOS',?,?)`).run(
    JSON.stringify({
      repairId: expected.finalHomeosRepairId,
      repairedCheckpointHash: expected.finalHomeosCheckpointHash,
      pendingDeliveriesPreserved: 2,
      abandonedCount: 0,
      inventedBiologicalTime: false,
      authorityChanged: false
    }),
    at
  );

  assert.throws(() => stateStore.beginExactR146HomeosBacklogReplay({
    residencyId: 'resident:homeos',
    coreId: 'HOMEOS',
    checkpointHash: `f${expected.finalHomeosCheckpointHash.slice(1)}`,
    runtimeRevision: 146
  }), { code: 'P1_HOMEOS_R146_REPLAY_CONTRACT' });
  assert.equal(stateStore.getResident('resident:homeos').status, 'RESYNC_REQUIRED');

  const record = stateStore.beginExactR146HomeosBacklogReplay({
    residencyId: 'resident:homeos',
    coreId: 'HOMEOS',
    checkpointHash: expected.finalHomeosCheckpointHash,
    runtimeRevision: 146
  });
  assert.equal(record.pendingCount, 2);
  assert.equal(record.maximumPending, 2);
  assert.equal(record.abandonedCount, 0);
  assert.equal(record.inventedBiologicalTime, false);
  assert.equal(record.authorityChanged, false);
  assert.equal(stateStore.getResident('resident:homeos').status, 'RECOVERING');
  assert.deepEqual(
    stateStore.db.prepare(`SELECT sequence FROM biological_deliveries
      WHERE consumer_id='resident:homeos' AND status='PENDING' ORDER BY sequence`)
      .all().map(row => Number(row.sequence)),
    pending.map(value => value[0])
  );
  assert.equal(stateStore.db.prepare(`SELECT COUNT(*) count FROM biological_deliveries
    WHERE consumer_id='resident:homeos' AND status='ACKED'`).get().count, 0);

  stateStore.db.prepare(`UPDATE resident_instances SET status='RESYNC_REQUIRED'
    WHERE residency_id='resident:homeos'`).run();
  stateStore.db.prepare(`UPDATE resident_checkpoints SET input_cursor=?
    WHERE residency_id='resident:homeos' AND generation=?`).run(
    4241118, expected.finalHomeosCheckpointGeneration);
  stateStore.db.prepare(`UPDATE biological_consumers SET cursor=?
    WHERE consumer_id='resident:homeos'`).run(4241118);
  stateStore.db.prepare('DELETE FROM biological_events WHERE sequence IN (?,?)').run(
    ...pending.map(value => value[0]));
  stateStore.db.prepare(`INSERT INTO recovery_records(
    type,core_id,detail_json,created_at
  ) VALUES('resident.implementation-repaired','HOMEOS',?,?)`).run(
    JSON.stringify({
      repairId: expected.finalHomeosRepairId,
      deliveryMode: 'pruned',
      repairedCheckpointHash: expected.finalHomeosCheckpointHash,
      pendingDeliveriesPreserved: 0,
      prunedDeliveriesRecovered: 2,
      sourceIntentSha256: [
        '3e2897f3a6dfc26d5ea0faea147d8dbd552cad7a10b9028cae5dc6f78e866e21',
        'e004c64e4fa571ab00e0858dc4e1299ee4b7207f5b24555cf4be778509cad6bc'
      ],
      abandonedCount: 0,
      inventedBiologicalTime: false,
      authorityChanged: false
    }),
    at
  );
  assert.throws(() => stateStore.beginExactR146HomeosBacklogReplay({
    residencyId: 'resident:homeos',
    coreId: 'HOMEOS',
    checkpointHash: expected.finalHomeosCheckpointHash,
    runtimeRevision: 146
  }), { code: 'P1_HOMEOS_R146_REPLAY_STATE' });
  assert.equal(stateStore.getResident('resident:homeos').status, 'RESYNC_REQUIRED');
});

test('R146-HOMEOS-RECOVERY-13 fences unresolved and sealed fetus continuity exactly', () => {
  const expected = R146_METAB_Q48_HOMEOS_RECOVERY.fetus;
  const consumer = {
    coreId: expected.coreId,
    required: false,
    active: false,
    authorityEpoch: expected.authorityEpoch,
    topics: [],
    topicsHash: expected.topicsHash,
    cursor: expected.consumerCursor,
    checkpointHash: expected.priorConsumerCheckpointHash
  };
  const rows = {
    authority: {
      instance_id: expected.instanceId,
      version: expected.version,
      epoch: expected.authorityEpoch,
      checkpoint_hash: expected.checkpointHash
    },
    checkpoint: {
      instance_id: expected.instanceId,
      version: expected.version,
      authority_epoch: expected.authorityEpoch,
      generation: expected.checkpointGeneration,
      blob_hash: expected.checkpointHash,
      byte_length: expected.checkpointBytes
    },
    demotion: {
      id: expected.demotionId,
      detail_json: JSON.stringify({
        consumerId: expected.consumerId,
        cursor: expected.consumerCursor,
        pending: expected.pendingAtDemotion,
        maximumDebt: expected.maximumDebt,
        resynchronizationRequired: true
      })
    },
    resolution: {
      id: expected.priorResolutionId,
      detail_json: JSON.stringify({ demotionId: expected.priorDemotionId })
    }
  };
  const harness = {
    stateStore: {
      getBiologicalConsumer: () => consumer,
      db: {
        prepare: sql => ({
          get: () => {
            if (sql.includes('FROM authority')) return rows.authority;
            if (sql.includes('FROM checkpoints')) return rows.checkpoint;
            if (sql.includes("type='biological.consumer-demoted'")) return rows.demotion;
            if (sql.includes("type='biological.consumer-resynchronized'")) return rows.resolution;
            return { count: 0 };
          }
        })
      }
    }
  };
  const unresolved = LivingKernel.prototype.exactR146FetusContinuityCohort.call(harness);
  assert.equal(unresolved.valid, true);
  assert.equal(unresolved.unresolved, true);
  assert.equal(unresolved.resolved, false);

  const highWater = expected.consumerCursor + 1000;
  consumer.cursor = highWater;
  consumer.checkpointHash = expected.checkpointHash;
  rows.resolution = {
    id: expected.demotionId + 1,
    detail_json: JSON.stringify({
      cohort: 'r146-fetus-empty-input-continuity-v1',
      demotionId: expected.demotionId,
      consumerId: expected.consumerId,
      fromCursor: expected.consumerCursor,
      toCursor: highWater,
      inputs: [],
      checkpointHash: expected.checkpointHash,
      checkpointGeneration: expected.checkpointGeneration,
      checkpointBytesChanged: false,
      biologicalStateChanged: false,
      physiologyApplied: 0,
      abandonedCount: 0,
      inventedBiologicalTime: false,
      authorityChanged: false,
      runtimeRevision: 146
    })
  };
  const resolved = LivingKernel.prototype.exactR146FetusContinuityCohort.call(harness);
  assert.equal(resolved.valid, true);
  assert.equal(resolved.unresolved, false);
  assert.equal(resolved.resolved, true);

  rows.resolution.detail_json = JSON.stringify({
    ...JSON.parse(rows.resolution.detail_json),
    physiologyApplied: 1
  });
  assert.equal(
    LivingKernel.prototype.exactR146FetusContinuityCohort.call(harness).valid,
    false
  );
});

test('R146-HOMEOS-RECOVERY-14 preserves revision only for repaired HOMEOS plus fetus cohort', () => {
  const expected = R146_METAB_Q48_HOMEOS_RECOVERY;
  const capacityJson = JSON.stringify({ pending: null });
  const metab = {
    instanceId: expected.metabInstanceId,
    version: expected.partialMetabVersion,
    stateSchema: expected.partialMetabStateSchema,
    moduleRelativePath: expected.partialMetabModuleRelativePath,
    moduleHash: expected.partialMetabModuleHash,
    manifestHash: expected.partialMetabManifestHash,
    packagePolicyHash: expected.partialMetabPackagePolicyHash,
    status: 'RUNNING',
    checkpointGeneration: 200000,
    checkpointHash: 'metab-current'
  };
  const homeos = {
    instanceId: expected.finalHomeosInstanceId,
    version: expected.finalHomeosVersion,
    stateSchema: expected.finalHomeosStateSchema,
    moduleRelativePath: expected.finalHomeosModuleRelativePath,
    moduleHash: expected.finalHomeosModuleHash,
    manifestHash: expected.finalHomeosManifestHash,
    packagePolicyHash: expected.finalHomeosPackagePolicyHash,
    status: 'RESYNC_REQUIRED',
    checkpointGeneration: expected.finalHomeosCheckpointGeneration,
    checkpointHash: expected.finalHomeosCheckpointHash
  };
  const fetusConsumer = {
    coreId: expected.fetus.coreId,
    required: false,
    active: false,
    authorityEpoch: expected.fetus.authorityEpoch,
    topics: [],
    topicsHash: expected.fetus.topicsHash,
    cursor: expected.fetus.consumerCursor,
    checkpointHash: expected.fetus.priorConsumerCheckpointHash
  };
  const consumers = {
    'resident:metab': {
      coreId: 'METAB', required: false, active: true, authorityEpoch: 0,
      checkpointHash: metab.checkpointHash
    },
    'resident:homeos': {
      coreId: 'HOMEOS', required: false, active: false, authorityEpoch: 0,
      cursor: expected.finalHomeosConsumerCursor,
      topicsHash: expected.finalHomeosTopicsHash,
      checkpointHash: expected.finalHomeosCheckpointHash
    },
    [expected.fetus.consumerId]: fetusConsumer
  };
  const harness = {
    runtimeRevision: 146,
    homeosNeutralBirthAuthorization: 'AUTHORIZE_R143_HOMEOS_NEUTRAL_BIRTH_ONLY',
    metabHomeosRouteAuthorization: 'AUTHORIZE_R144_METAB_HOMEOS_ROUTE_ONLY',
    homeosShadowPromotionAuthorization: 'AUTHORIZE_R145_HOMEOS_OUTPUT_FIREWALLED_SHADOW_ONLY',
    homeosStrandedR145RecoveryAuthorization: '',
    homeosStrandedR146RecoveryAuthorization: expected.authorization,
    homeosStrandedR145RecoveryActive: false,
    homeosStrandedRecoveryRevision: null,
    metabQ48R146RecoveryActive: false,
    homeosStrandedR146PartialRecoveryActive: false,
    homeosFinalR146RecoveryActive: false,
    fetusEmptyInputR146RecoveryActive: false,
    exactR146FetusContinuityCohort:
      LivingKernel.prototype.exactR146FetusContinuityCohort,
    stateStore: {
      getResident: id => id === 'resident:metab' ? metab
        : id === 'resident:homeos' ? homeos : null,
      getBiologicalConsumer: id => consumers[id] || null,
      listAuthority: () => [],
      db: {
        prepare: sql => ({
          get: (...args) => {
            if (sql.includes('FROM authority')) return {
              instance_id: expected.fetus.instanceId,
              version: expected.fetus.version,
              epoch: expected.fetus.authorityEpoch,
              checkpoint_hash: expected.fetus.checkpointHash
            };
            if (sql.includes('FROM checkpoints')) return {
              instance_id: expected.fetus.instanceId,
              version: expected.fetus.version,
              authority_epoch: expected.fetus.authorityEpoch,
              generation: expected.fetus.checkpointGeneration,
              blob_hash: expected.fetus.checkpointHash,
              byte_length: expected.fetus.checkpointBytes
            };
            if (sql.includes("type='biological.consumer-demoted'")) return {
              id: expected.fetus.demotionId,
              detail_json: JSON.stringify({
                consumerId: expected.fetus.consumerId,
                cursor: expected.fetus.consumerCursor,
                pending: expected.fetus.pendingAtDemotion,
                maximumDebt: expected.fetus.maximumDebt,
                resynchronizationRequired: true
              })
            };
            if (sql.includes("type='biological.consumer-resynchronized'")) return {
              id: expected.fetus.priorResolutionId,
              detail_json: JSON.stringify({ demotionId: expected.fetus.priorDemotionId })
            };
            if (sql.includes("type='resident.resync-required'") && sql.includes("core_id='HOMEOS'")) {
              return {
                id: expected.finalHomeosFailureRecordId,
                detail_json: JSON.stringify({
                  sequence: expected.finalHomeosPendingSequences[0],
                  code: 'P1_RESIDENT_PENDING_BOUND'
                })
              };
            }
            if (sql.includes("type='resident.implementation-repaired'") &&
                sql.includes("core_id='HOMEOS'")) {
              return { detail_json: JSON.stringify({
                repairId: expected.finalHomeosRepairId,
                repairedCheckpointHash: expected.finalHomeosCheckpointHash,
                pendingDeliveriesPreserved: 2,
                abandonedCount: 0,
                inventedBiologicalTime: false,
                authorityChanged: false
              }) };
            }
            if (sql.includes("key='life:p1-r0-metab-capacity-source'")) return {
              json: capacityJson,
              sha256: crypto.createHash('sha256').update(capacityJson).digest('hex')
            };
            if (sql.includes('FROM resident_checkpoints') &&
                (args[0] === 'resident:homeos' || sql.includes("residency_id='resident:homeos'"))) {
              return {
                checkpoint_id: expected.finalHomeosCheckpointId,
                instance_id: expected.finalHomeosInstanceId,
                version: expected.finalHomeosVersion,
                state_schema: expected.finalHomeosStateSchema,
                generation: expected.finalHomeosCheckpointGeneration,
                blob_hash: expected.finalHomeosCheckpointHash,
                byte_length: expected.finalHomeosCheckpointBytes,
                input_cursor: expected.finalHomeosInputCursor
              };
            }
            if (sql.includes('COUNT(*)')) return {
              count: sql.includes("consumer_id='resident:homeos'") ? 2 : 0
            };
            return null;
          },
          all: () => sql.includes("d.consumer_id='resident:homeos'")
            ? expected.finalHomeosPendingSequences.map((sequence, index) => ({
                sequence,
                topic: ['metab.energy.availability.v1', 'metab.energy.reserve.v1'][index]
              }))
            : []
        })
      }
    }
  };

  assert.equal(harness.exactR146FetusContinuityCohort.call(harness).valid, true);
  assert.equal(
    LivingKernel.prototype.preserveExactR145HomeosProgressRevision.call(harness),
    true
  );
  assert.equal(harness.homeosFinalR146RecoveryActive, true);
  assert.equal(harness.fetusEmptyInputR146RecoveryActive, true);
  homeos.checkpointHash = `f${expected.finalHomeosCheckpointHash.slice(1)}`;
  harness.homeosFinalR146RecoveryActive = false;
  harness.fetusEmptyInputR146RecoveryActive = false;
  assert.equal(
    LivingKernel.prototype.preserveExactR145HomeosProgressRevision.call(harness),
    false
  );
});

test('R147-HOMEOS-RECOVERY-15 admits only the exact zero-debt forward-recovery cohort', () => {
  const expected = R147_HOMEOS_FORWARD_RECOVERY;
  const residents = Object.fromEntries(
    [expected.metab, expected.homeos, expected.sntss, expected.chronobiology]
      .map(value => [value.residencyId, { ...value }])
  );
  const consumers = Object.fromEntries(
    [expected.metab, expected.homeos, expected.sntss, expected.chronobiology].map(value => [
      value.residencyId,
      {
        coreId: value.coreId, required: false,
        active: value.status === 'RUNNING', authorityEpoch: 0,
        checkpointHash: value.checkpointHash,
        ...(Number.isSafeInteger(value.consumerCursor) ? { cursor: value.consumerCursor } : {}),
        ...(value.topicsHash ? { topicsHash: value.topicsHash } : {})
      }
    ])
  );
  const source = stageCapacitySample({
    ...createCapacitySourceState({
      instanceId: expected.metab.instanceId,
      residentVersion: expected.metab.version
    }),
    lastCommittedFrame: 162421,
    lastTrustedTimeUs: 1_000_000,
    lastContinuityEpoch: 1
  }, {
    trustedTimeUs: 1_250_000,
    continuityEpoch: 1,
    metrics: { cpuCount: 4, loadAverageMilli: 0, freeMemoryBytes: 8_000, totalMemoryBytes: 8_000 }
  });
  let capacityJson = JSON.stringify(source);
  const failures = new Map([
    [expected.homeos.coreId, expected.homeos],
    [expected.sntss.coreId, expected.sntss],
    [expected.chronobiology.coreId, expected.chronobiology]
  ]);
  const harness = {
    runtimeRevision: 147,
    homeosNeutralBirthAuthorization: 'AUTHORIZE_R143_HOMEOS_NEUTRAL_BIRTH_ONLY',
    metabHomeosRouteAuthorization: 'AUTHORIZE_R144_METAB_HOMEOS_ROUTE_ONLY',
    homeosShadowPromotionAuthorization: 'AUTHORIZE_R145_HOMEOS_OUTPUT_FIREWALLED_SHADOW_ONLY',
    homeosStrandedR147RecoveryAuthorization: expected.authorization,
    homeosFinalR146RecoveryActive: false,
    homeosFinalR147RecoveryActive: false,
    fetusEmptyInputR147RecoveryActive: false,
    exactR146FetusContinuityCohort: () => ({ valid: true }),
    stateStore: {
      getResident: id => residents[id] || null,
      getBiologicalConsumer: id => consumers[id] || null,
      listAuthority: () => [],
      db: { prepare: sql => ({
        get: (...args) => {
          if (sql.includes('COUNT(*)')) return { count: 0 };
          if (sql.includes("key='life:p1-r0-metab-capacity-source'")) return {
            json: capacityJson,
            sha256: crypto.createHash('sha256').update(capacityJson).digest('hex')
          };
          if (sql.includes("type='resident.resync-required'")) {
            const value = failures.get(args[0]);
            return value && {
              id: value.failureRecordId,
              detail_json: JSON.stringify({
                residencyId: value.residencyId,
                sequence: value.failureSequence,
                code: value.failureCode
              })
            };
          }
          if (sql.includes("type='resident.implementation-repaired'")) return {
            id: expected.homeosRepairRecordId,
            detail_json: JSON.stringify({
              repairId: R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosRepairId,
              repairedCheckpointHash: expected.homeosCheckpointHash,
              pendingDeliveriesPreserved: 0,
              prunedDeliveriesRecovered: 2,
              biologicalOutputs: 0,
              abandonedCount: 0,
              inventedBiologicalTime: false,
              authorityChanged: false,
              resourceLimitsChanged: false
            })
          };
          if (sql.includes('FROM recovery_records ORDER BY id DESC')) return {
            id: expected.latestRecoveryRecordId,
            detail_json: JSON.stringify({
              residencyId: expected.metab.residencyId,
              instanceId: expected.metab.instanceId,
              version: expected.metab.version,
              checkpointHash: expected.metab.checkpointHash
            })
          };
          return null;
        }
      }) }
    }
  };
  assert.equal(LivingKernel.prototype.preserveExactR147HomeosRecoveryRevision.call(harness), true);
  assert.equal(harness.homeosFinalR147RecoveryActive, true);
  assert.equal(harness.fetusEmptyInputR147RecoveryActive, true);

  harness.homeosFinalR146RecoveryActive = false;
  harness.homeosFinalR147RecoveryActive = false;
  harness.fetusEmptyInputR147RecoveryActive = false;
  residents['resident:sntss'].checkpointHash = `f${expected.sntss.checkpointHash.slice(1)}`;
  assert.equal(LivingKernel.prototype.preserveExactR147HomeosRecoveryRevision.call(harness), false);
  residents['resident:sntss'].checkpointHash = expected.sntss.checkpointHash;
  const changedSource = JSON.parse(capacityJson);
  changedSource.pending.sampleFrame += 1;
  capacityJson = JSON.stringify(changedSource);
  assert.equal(LivingKernel.prototype.preserveExactR147HomeosRecoveryRevision.call(harness), false);
});
