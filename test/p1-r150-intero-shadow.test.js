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
const { LivingKernel } = require('../runtime/kernel/living-kernel');
const { validateManifest } = require('../runtime/kernel/manifest');
const { ResidentManager } = require('../runtime/kernel/resident-manager');
const { StateStore } = require('../runtime/kernel/state-store');
const {
  INTERO_NEUTRAL_AUTHORIZATION_CLASS,
  INTERO_NEUTRAL_BIRTH_FORMAT,
  verifyInteroNeutralBirthCertificate
} = require('../runtime/p1-r0/intero-neutral-birth-authority');
const { INTERO_NEUTRAL_RESIDENT_CONTRACT } = require('../runtime/p1-r0/intero-neutral-contract');
const { INTERO_SHADOW_RESIDENT_CONTRACT } = require('../runtime/p1-r0/intero-shadow-contract');
const { METAB_HOMEOS_RESIDENT_CONTRACT } = require('../runtime/p1-r0/metab-homeos-contract');
const { METAB_INTERO_RESIDENT_CONTRACT } = require('../runtime/p1-r0/metab-intero-contract');
const { HOMEOS_SHADOW_RESIDENT_CONTRACT } = require('../runtime/p1-r0/homeos-shadow-contract');
const { HOMEOS_INTERO_RESIDENT_CONTRACT } = require('../runtime/p1-r0/homeos-intero-contract');
const {
  PRODUCTION_STORAGE_AUTHORIZATION,
  P1ProductionExpansionPersistence
} = require('../runtime/p1-r0/production-persistence');
const { recordHash } = require('../runtime/p1-r0/records');
const {
  commitCapacitySample,
  createCapacityPayloads,
  createCapacitySourceState,
  SOURCE_STATE_KEY,
  stageCapacitySample
} = require('../runtime/p1-r0/metab-capacity-source');
const { sha256 } = require('../runtime/p1-r0/resident-support');
const packageHashes = require('../runtime/p1-r0/resident-package-hashes.json');
const neutralMetab = require('../runtime/p1-r0/residents/metab-neutral');
const shadowMetab = require('../runtime/p1-r0/residents/metab-shadow');
const metabHomeos = require('../runtime/p1-r0/residents/metab-homeos');
const metabIntero = require('../runtime/p1-r0/residents/metab-intero');
const neutralHomeos = require('../runtime/p1-r0/residents/homeos-neutral');
const shadowHomeos = require('../runtime/p1-r0/residents/homeos-shadow');
const homeosIntero = require('../runtime/p1-r0/residents/homeos-intero');
const neutralIntero = require('../runtime/p1-r0/residents/intero-neutral');
const shadowIntero = require('../runtime/p1-r0/residents/intero-shadow');
const profiles = require(
  '../runtime/p1-r0/c0-source-contracts/contracts/founder_profile_templates.json'
).profiles;
const {
  FORMAT: REVISION_FREEZE_FORMAT,
  sealRevisionFreeze
} = require('../runtime/revision-freeze');
const { publicMetadata } = require('../server');

const IDENTITY = Object.freeze({
  organismId: 'stay-r150-intero-shadow-test',
  createdAt: '2026-09-03T08:00:00.000Z',
  lineage: 'STAY/Genesis'
});
const IDENTITY_HASH = sha256(IDENTITY);
const PARENT_FREEZE = `sha256:${'8'.repeat(64)}`;
const MODULE_HASH = `sha256:${'9'.repeat(64)}`;
const MANIFEST_HASH = `sha256:${'a'.repeat(64)}`;
const INSTANCES = Object.freeze({
  METAB: 'd424c722-ef31-44b0-8201-ba68c418d14a',
  HOMEOS: 'a0f0c4dd-dced-4643-984a-8717e5f2e30f',
  INTERO: 'e604fda9-ce14-4f52-a4b4-d77acf38ce5a'
});
const ROOT = path.resolve(__dirname, '..');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function binding(runtimeRevision = 145) {
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
  profile.profileId = `${coreId.toLowerCase()}.p1-r0.production-r150-test.v1`;
  if (coreId === 'INTERO') profile.noiseKeyHex = '89abcdef01234567';
  return {
    recordVersion: 'P1ResidentFounderBindingV1',
    coreId,
    organismId: IDENTITY.organismId,
    organismIdentityHash: IDENTITY_HASH,
    founderId: `founder:${coreId.toLowerCase()}:r150:test`,
    lineageId: `lineage:${coreId.toLowerCase()}:r150:test`,
    residencyId: `resident:${coreId.toLowerCase()}`,
    profileId: profile.profileId,
    profileHash: sha256(profile),
    profile,
    mode,
    authorityEpoch: '0'
  };
}

function interoFounderRecord() {
  const source = founder('INTERO');
  return {
    recordVersion: 'P1FounderRecordV1',
    organismId: source.organismId,
    coreId: source.coreId,
    founderId: source.founderId,
    lineageId: source.lineageId,
    profileId: source.profileId,
    profileHash: source.profileHash,
    founderSchemaId: 'urn:stay:p1-r0:schema:intero-founder-profile:v1',
    founderSchemaVersion: '1',
    genesisFrame: 0,
    genesisTransactionId: 'tx:intero:r147:test',
    phenotypeHash: sha256({ coreId: source.coreId, profile: source.profile }),
    committed: true,
    previousFounderId: null
  };
}

function interoBirthBody(nowMs = 1_800_000_000_000) {
  return {
    allowedAction: 'birth-intero-neutral',
    authorizationClass: INTERO_NEUTRAL_AUTHORIZATION_CLASS,
    certificateId: 'r147-intero-neutral-test-certificate',
    expiresAtMs: nowMs + 60_000,
    founderBinding: founder('INTERO'),
    founderDossierSha256: recordHash({
      status: 'PRODUCTION_FOUNDER_CANDIDATE',
      reviewedProfile: founder('INTERO').profile,
      noAuthority: true,
      receptorRoute: 'ABSENT'
    }),
    founderRecord: interoFounderRecord(),
    issuedAtMs: nowMs - 1_000,
    manifestHash: MANIFEST_HASH,
    moduleHash: MODULE_HASH,
    organismId: IDENTITY.organismId,
    organismIdentityHash: IDENTITY_HASH,
    packagePolicyHash: INTERO_NEUTRAL_RESIDENT_CONTRACT.packagePolicyHash,
    parentFreezeRecordSha256: PARENT_FREEZE,
    parentRevision: 145,
    residencyId: 'resident:intero',
    targetRevision: 147,
    version: neutralIntero.VERSION
  };
}

function signedInteroCertificate(body, privateKey) {
  return {
    format: INTERO_NEUTRAL_BIRTH_FORMAT,
    body,
    signature: crypto.sign(null, Buffer.from(stableStringify(body)), privateKey).toString('base64')
  };
}

function inspectedIntero() {
  return {
    contract: INTERO_NEUTRAL_RESIDENT_CONTRACT,
    definition: {
      manifest: neutralIntero.manifest,
      moduleDigest: MODULE_HASH,
      packagePolicyHash: INTERO_NEUTRAL_RESIDENT_CONTRACT.packagePolicyHash
    },
    manifestHash: MANIFEST_HASH
  };
}

function eventFromSignal(signal, sequence, { sourceVersion = '1.0.0', evidenceHash = null } = {}) {
  return {
    id: `evt-${sequence}`,
    sequence,
    topic: signal.topic,
    class: 'durable',
    payload: clone(signal.payload),
    at: signal.trustedTime.observedAtMs,
    deadlineAt: null,
    meta: {
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
    },
    ledger: { durable: true }
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

function capacitySignals(frame, observedAtMs = 40_000 + frame) {
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
  return {
    eligible,
    quality: deriveSignal(eligible, {
      signalId: `runtime.metab.capacity.quality:r128:f${frame}`,
      topic: shadowMetab.QUALITY_TOPIC,
      payload: payloads.qualityPayload,
      trustedTime,
      provenance,
      durability: DURABILITY.DURABLE
    })
  };
}

function activationPayload(definition, { fromVersion, fromStateSchema, toStateSchema, targetRevision, protocol, outputPolicy, routes } = {}) {
  const payload = {
    protocol,
    organismIdentityHash: IDENTITY_HASH,
    residencyId: definition.RESIDENCY_ID,
    instanceId: INSTANCES[definition.CORE_ID],
    fromVersion,
    fromStateSchema,
    sourceCheckpointGeneration: 4,
    sourceCheckpointHash: `sha256:${String(targetRevision).padStart(64, '0')}`,
    toVersion: definition.VERSION,
    toStateSchema,
    targetRevision,
    parentRevision: 145,
    parentFreezeRecordSha256: PARENT_FREEZE,
    mode: 'SHADOW',
    authorityEpoch: '0',
    outputPolicy
  };
  if (routes) payload.routes = routes;
  else payload.receptorRoute = 'ABSENT';
  return payload;
}

async function activatedMetabShadow() {
  const initial = neutralMetab.createNeutralMetabInitialState({
    binding: binding(141),
    founder: founder('METAB')
  });
  const staged = await shadowMetab.migrateState({ state: initial, fromSchema: 1, toSchema: 2 });
  const core = await shadowMetab.createCore({ initialState: staged });
  await core.start();
  const checkpointHash = `sha256:${'1'.repeat(64)}`;
  const activation = createSignal({
    signalId: `runtime.metab.shadow-activation:r139:g1:${checkpointHash.slice(7)}`,
    topic: shadowMetab.ACTIVATION_TOPIC,
    payload: {
    protocol: 'stay-p1-r0-metab-shadow-activation-v1',
    organismIdentityHash: IDENTITY_HASH,
    residencyId: 'resident:metab',
    instanceId: INSTANCES.METAB,
    fromVersion: neutralMetab.VERSION,
    fromStateSchema: 1,
    sourceCheckpointGeneration: 1,
    sourceCheckpointHash: checkpointHash,
    toVersion: shadowMetab.VERSION,
    toStateSchema: 2,
    runtimeRevision: 139,
    parentRevision: 127,
    parentFreezeRecordSha256: `sha256:${'7'.repeat(64)}`,
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
  await core.handle(eventFromSignal(activation, 1, {
    sourceVersion: '0.8.11.3',
    evidenceHash: IDENTITY_HASH
  }));
  return core.snapshot();
}

async function buildR145States() {
  const metabState = await activatedMetabShadow();
  const stagedMetab = await metabHomeos.migrateState({ state: metabState, fromSchema: 2, toSchema: 3 });
  const metabOutputs = [];
  const metab = await metabHomeos.createCore({
    initialState: stagedMetab,
    emit: async (topic, payload) => metabOutputs.push({ topic, payload })
  });
  await metab.start();
  await metab.handle(activationEvent(metabHomeos.ACTIVATION_TOPIC, {
    protocol: 'stay-p1-r0-metab-homeos-route-activation-v1',
    organismIdentityHash: IDENTITY_HASH,
    residencyId: 'resident:metab',
    instanceId: INSTANCES.METAB,
    fromVersion: shadowMetab.VERSION,
    fromStateSchema: 2,
    sourceCheckpointGeneration: 2,
    sourceCheckpointHash: `sha256:${'2'.repeat(64)}`,
    toVersion: metabHomeos.VERSION,
    toStateSchema: 3,
    targetRevision: 144,
    parentRevision: 141,
    parentFreezeRecordSha256: `sha256:${'7'.repeat(64)}`,
    mode: 'SHADOW',
    authorityEpoch: '0',
    outputPolicy: metabHomeos.OUTPUT_POLICY,
    routes: [...metabHomeos.HOMEOS_ROUTES]
  }, 2, 144));
  const first = capacitySignals(1);
  await metab.handle(eventFromSignal(first.eligible, 3));
  await metab.handle(eventFromSignal(first.quality, 4));

  const neutralState = neutralHomeos.createNeutralHomeosInitialState({
    binding: binding(141),
    founder: founder('HOMEOS')
  });
  const neutral = await neutralHomeos.createCore({ initialState: neutralState });
  await neutral.start();
  for (const output of metabOutputs) await neutral.handle(output);
  const stagedHomeos = await shadowHomeos.migrateState({
    state: await neutral.snapshot(),
    fromSchema: 1,
    toSchema: 2
  });
  const homeos = await shadowHomeos.createCore({ initialState: stagedHomeos });
  await homeos.start();
  await homeos.handle(activationEvent(shadowHomeos.ACTIVATION_TOPIC, {
    protocol: 'stay-p1-r0-homeos-shadow-activation-v1',
    organismIdentityHash: IDENTITY_HASH,
    residencyId: 'resident:homeos',
    instanceId: INSTANCES.HOMEOS,
    fromVersion: neutralHomeos.VERSION,
    fromStateSchema: 1,
    sourceCheckpointGeneration: 2,
    sourceCheckpointHash: `sha256:${'3'.repeat(64)}`,
    toVersion: shadowHomeos.VERSION,
    toStateSchema: 2,
    targetRevision: 145,
    parentRevision: 141,
    parentFreezeRecordSha256: `sha256:${'7'.repeat(64)}`,
    mode: 'SHADOW',
    authorityEpoch: '0',
    outputPolicy: shadowHomeos.OUTPUT_POLICY
  }, 5, 145));
  return { metabState: await metab.snapshot(), homeosState: await homeos.snapshot() };
}

async function buildR149Frames() {
  const r145 = await buildR145States();
  const metabOutputs = [];
  const metab = await metabIntero.createCore({
    initialState: await metabIntero.migrateState({ state: r145.metabState, fromSchema: 3, toSchema: 4 }),
    emit: async (topic, payload) => metabOutputs.push({ topic, payload })
  });
  await metab.start();
  const metabActivation = activationPayload(metabIntero, {
    fromVersion: metabHomeos.VERSION,
    fromStateSchema: 3,
    toStateSchema: 4,
    targetRevision: 148,
    protocol: 'stay-p1-r0-metab-intero-route-activation-v1',
    outputPolicy: metabIntero.OUTPUT_POLICY,
    routes: [...metabIntero.INTERO_ROUTES]
  });
  await metab.handle(activationEvent(metabIntero.ACTIVATION_TOPIC, metabActivation, 6, 148));
  const second = capacitySignals(2, 40_300);
  await metab.handle(eventFromSignal(second.quality, 7));
  await metab.handle(eventFromSignal(second.eligible, 8));

  const homeosOutputs = [];
  const homeos = await homeosIntero.createCore({
    initialState: await homeosIntero.migrateState({ state: r145.homeosState, fromSchema: 2, toSchema: 3 }),
    emit: async (topic, payload) => homeosOutputs.push({ topic, payload })
  });
  await homeos.start();
  const homeosActivation = activationPayload(homeosIntero, {
    fromVersion: shadowHomeos.VERSION,
    fromStateSchema: 2,
    toStateSchema: 3,
    targetRevision: 149,
    protocol: 'stay-p1-r0-homeos-intero-route-activation-v1',
    outputPolicy: homeosIntero.OUTPUT_POLICY,
    routes: [homeosIntero.INTERO_ROUTE]
  });
  await homeos.handle(activationEvent(homeosIntero.ACTIVATION_TOPIC, homeosActivation, 9, 149));
  for (const output of metabOutputs.filter(item => item.payload.route.consumerCoreId === 'HOMEOS')) {
    await homeos.handle(output);
  }
  return {
    metab,
    homeos,
    interoFrames: [
      ...metabOutputs.filter(item => item.payload.route.consumerCoreId === 'INTERO'),
      ...homeosOutputs
    ]
  };
}

async function managedR145Runtime(t, { includeIntero = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r150-managed-'));
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
    contracts: [
      METAB_HOMEOS_RESIDENT_CONTRACT,
      HOMEOS_SHADOW_RESIDENT_CONTRACT,
      INTERO_NEUTRAL_RESIDENT_CONTRACT
    ]
  });
  t.after(async () => {
    await manager.shutdown().catch(() => {});
    try { stateStore.close(); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });
  const r145 = await buildR145States();
  await manager.attach({
    moduleRelativePath: 'cores/p1-r0/metab-homeos/index.js',
    binding: binding(141),
    initialState: r145.metabState,
    instanceId: INSTANCES.METAB
  });
  await manager.attach({
    moduleRelativePath: 'cores/p1-r0/homeos-shadow/index.js',
    binding: binding(141),
    initialState: r145.homeosState,
    instanceId: INSTANCES.HOMEOS
  });
  if (includeIntero) {
    await manager.attach({
      moduleRelativePath: 'cores/p1-r0/intero-neutral/index.js',
      binding: binding(141),
      initialState: neutralIntero.createNeutralInteroInitialState({
        binding: binding(141),
        founder: founder('INTERO')
      }),
      instanceId: INSTANCES.INTERO
    });
  }
  await stateStore.writeLife('identity', IDENTITY);
  await stateStore.writeLife('organism-binding', binding(141));
  await stateStore.writeLife('runtime-revision', {
    revision: 145,
    reason: 'r145f.accepted',
    at: '2026-09-03T07:59:59.000Z',
    kernelVersion: '0.8.11.3'
  });
  async function publishActivation(topic, payload, targetRevision, label) {
    const signal = createSignal({
      signalId: `${topic}:test:${label}`,
      topic,
      payload,
      trustedTime: {
        source: 'kernel',
        observedAtMs: now++,
        pulseId: `${topic}:pulse:${label}`
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

test('R150-INTERO-01 production packages retain resource and authority containment', () => {
  for (const definition of [metabIntero, homeosIntero, neutralIntero, shadowIntero]) {
    const checked = validateManifest(definition.manifest);
    assert.equal(checked.productionEligible, false);
    assert.equal(checked.priority, 'optional');
    assert.equal(checked.resources.handlerTimeoutMs, 250);
    assert.equal(checked.resources.hardRamMiB, 96);
    assert.equal(checked.resources.pidsMax, 16);
  }
  for (const name of ['METAB_INTERO', 'HOMEOS_INTERO', 'INTERO_NEUTRAL', 'INTERO_SHADOW']) {
    assert.match(packageHashes[name], /^sha256:[0-9a-f]{64}$/);
  }
  assert.deepEqual(shadowIntero.manifest.outputs, []);
  assert.deepEqual(shadowIntero.manifest.biology.consumerRouteLeases, []);
});

test('R150-INTERO-02 delayed committed pipeline reaches contained perception with zero output', async () => {
  const pipeline = await buildR149Frames();
  assert.deepEqual(
    pipeline.interoFrames.map(item => item.payload.route.routeId).sort(),
    [
      'p1r0.homeos-stability.intero',
      'p1r0.metab-availability.intero',
      'p1r0.metab-reserve.intero'
    ]
  );
  const neutralState = neutralIntero.createNeutralInteroInitialState({
    binding: binding(147),
    founder: founder('INTERO')
  });
  const staged = await shadowIntero.migrateState({ state: neutralState, fromSchema: 1, toSchema: 2 });
  let emitted = 0;
  const intero = await shadowIntero.createCore({
    initialState: staged,
    emit: async () => { emitted += 1; }
  });
  await intero.start();
  await assert.rejects(() => intero.handle(pipeline.interoFrames[0]), {
    code: 'P1_INTERO_SHADOW_UNACTIVATED'
  });
  await intero.handle(activationEvent(shadowIntero.ACTIVATION_TOPIC, activationPayload(shadowIntero, {
    fromVersion: neutralIntero.VERSION,
    fromStateSchema: 1,
    toStateSchema: 2,
    targetRevision: 150,
    protocol: 'stay-p1-r0-intero-shadow-activation-v1',
    outputPolicy: shadowIntero.OUTPUT_POLICY
  }), 10, 150));
  for (const input of [...pipeline.interoFrames].reverse()) await intero.handle(input);
  const state = await intero.snapshot();
  const health = await intero.health();
  assert.equal(state.engineState.frameIndex, 5);
  assert.ok(state.lastProjection);
  assert.doesNotMatch(stableStringify(state.lastProjection), /fear|pain|hunger|emotion|diagnosis|cause|self|action/i);
  assert.equal(state.engineState.outputSequence, '0');
  assert.equal(health.mode, 'SHADOW');
  assert.equal(health.authorityOwned, false);
  assert.equal(health.receptorRoute, 'ABSENT');
  assert.equal(health.biologicalOutputs, 0);
  assert.equal(emitted, 0);
  const restarted = await shadowIntero.createCore({ initialState: state });
  await restarted.start();
  assert.equal(stableStringify(await restarted.snapshot()), stableStringify(state));
});

test('R150-INTERO-03 identity, revision, route, and semantic fences fail closed', async () => {
  const neutralState = neutralIntero.createNeutralInteroInitialState({
    binding: binding(147),
    founder: founder('INTERO')
  });
  const staged = await shadowIntero.migrateState({ state: neutralState, fromSchema: 1, toSchema: 2 });
  const core = await shadowIntero.createCore({ initialState: staged });
  await core.start();
  const payload = activationPayload(shadowIntero, {
    fromVersion: neutralIntero.VERSION,
    fromStateSchema: 1,
    toStateSchema: 2,
    targetRevision: 150,
    protocol: 'stay-p1-r0-intero-shadow-activation-v1',
    outputPolicy: shadowIntero.OUTPUT_POLICY
  });
  const wrongRevision = activationEvent(shadowIntero.ACTIVATION_TOPIC, payload, 1, 150);
  wrongRevision.meta.authorityEpoch = 149;
  await assert.rejects(() => core.handle(wrongRevision), { code: 'P1_INTERO_SHADOW_ACTIVATION' });
  const wrongRoute = clone(payload);
  wrongRoute.receptorRoute = 'p1r0.intero.sntss-receptor';
  await assert.rejects(
    () => core.handle(activationEvent(shadowIntero.ACTIVATION_TOPIC, wrongRoute, 2, 150)),
    { code: 'P1_INTERO_SHADOW_ACTIVATION' }
  );
  assert.equal(stableStringify(await core.snapshot()), stableStringify(staged));
});

test('R147-INTERO-BIRTH-01 signed authority binds R145F, executable, founder, and non-golden noise', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const nowMs = 1_800_000_000_000;
  const certificate = signedInteroCertificate(interoBirthBody(nowMs), privateKey);
  const verified = verifyInteroNeutralBirthCertificate(certificate, publicKey, {
    inspected: inspectedIntero(),
    identity: IDENTITY,
    runtimeRevision: 147,
    parentFreezeRecordSha256: PARENT_FREEZE,
    nowMs
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.founderBinding.profile.noiseKeyHex, '89abcdef01234567');

  const golden = clone(interoBirthBody(nowMs));
  golden.founderBinding.profile.noiseKeyHex = '0123456789abcdef';
  golden.founderBinding.profileHash = sha256(golden.founderBinding.profile);
  golden.founderRecord.profileHash = golden.founderBinding.profileHash;
  golden.founderRecord.phenotypeHash = sha256({ coreId: 'INTERO', profile: golden.founderBinding.profile });
  const goldenCertificate = signedInteroCertificate(golden, privateKey);
  assert.throws(() => verifyInteroNeutralBirthCertificate(goldenCertificate, publicKey, {
    inspected: inspectedIntero(),
    identity: IDENTITY,
    runtimeRevision: 147,
    parentFreezeRecordSha256: PARENT_FREEZE,
    nowMs
  }), { code: 'P1_INTERO_BIRTH_FOUNDER' });
});

test('R147-INTERO-BIRTH-02 additive persistence atomically commits INTERO origin', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r147-intero-birth-'));
  const stateStore = new StateStore(root);
  await stateStore.init();
  t.after(async () => {
    try { stateStore.close(); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });
  const storage = new P1ProductionExpansionPersistence({
    stateStore,
    authorization: PRODUCTION_STORAGE_AUTHORIZATION
  }).initialize();
  const authorization = {
    ok: true,
    certificateId: interoBirthBody().certificateId,
    authorizationClass: INTERO_NEUTRAL_AUTHORIZATION_CLASS,
    founderDossierSha256: interoBirthBody().founderDossierSha256,
    founderRecord: interoFounderRecord(),
    founderBinding: founder('INTERO'),
    targetRevision: 147,
    parentFreezeRecordSha256: PARENT_FREEZE
  };
  const registration = {
    residencyId: 'resident:intero',
    coreId: 'INTERO',
    role: 'interoception',
    instanceId: INSTANCES.INTERO,
    version: neutralIntero.VERSION,
    stateSchema: neutralIntero.manifest.stateSchema,
    moduleRelativePath: 'cores/p1-r0/intero-neutral/index.js',
    moduleHash: MODULE_HASH,
    manifestHash: MANIFEST_HASH,
    packagePolicyHash: INTERO_NEUTRAL_RESIDENT_CONTRACT.packagePolicyHash,
    organismIdentityHash: IDENTITY_HASH
  };
  const committed = storage.commitInteroNeutralBirth({
    founder: interoFounderRecord(),
    resident: registration,
    authorization
  });
  assert.equal(committed.resident.status, 'ATTACHED');
  assert.equal(storage.readBirthDossier('resident:intero').certificateId, authorization.certificateId);
  assert.equal(
    storage.readFounder({ organismId: IDENTITY.organismId, coreId: 'INTERO' }).founderId,
    founder('INTERO').founderId
  );
  const conflicting = clone(authorization);
  conflicting.certificateId = 'r147-intero-neutral-conflicting-certificate';
  assert.throws(() => storage.commitInteroNeutralBirth({
    founder: interoFounderRecord(),
    resident: registration,
    authorization: conflicting
  }), { code: 'P1_PRODUCTION_EXPANSION_DOSSIER_CONFLICT' });
});

test('R150-INTERO-04 manager atomically promotes R148, R149 and R150 without identity drift', async t => {
  const runtime = await managedR145Runtime(t);
  const before = Object.fromEntries(['metab', 'homeos', 'intero'].map(name => [
    name,
    runtime.stateStore.getResident(`resident:${name}`)
  ]));
  await runtime.manager.promoteP1ContainedGeneration({
    kind: 'METAB_INTERO_ROUTE_R148',
    moduleRelativePath: 'cores/p1-r0/metab-intero/index.js',
    binding: binding(141),
    nextContract: METAB_INTERO_RESIDENT_CONTRACT,
    publishActivation: async ({ sourceCheckpoint, resident }) => runtime.publishActivation(
      metabIntero.ACTIVATION_TOPIC,
      {
        ...activationPayload(metabIntero, {
          fromVersion: metabHomeos.VERSION,
          fromStateSchema: 3,
          toStateSchema: 4,
          targetRevision: 148,
          protocol: 'stay-p1-r0-metab-intero-route-activation-v1',
          outputPolicy: metabIntero.OUTPUT_POLICY,
          routes: [...metabIntero.INTERO_ROUTES]
        }),
        sourceCheckpointGeneration: sourceCheckpoint.generation,
        sourceCheckpointHash: `sha256:${sourceCheckpoint.blobHash}`
      },
      148,
      `${resident.instanceId}:g${sourceCheckpoint.generation}`
    )
  });
  await runtime.manager.promoteP1ContainedGeneration({
    kind: 'HOMEOS_INTERO_ROUTE_R149',
    moduleRelativePath: 'cores/p1-r0/homeos-intero/index.js',
    binding: binding(141),
    nextContract: HOMEOS_INTERO_RESIDENT_CONTRACT,
    publishActivation: async ({ sourceCheckpoint, resident }) => runtime.publishActivation(
      homeosIntero.ACTIVATION_TOPIC,
      {
        ...activationPayload(homeosIntero, {
          fromVersion: shadowHomeos.VERSION,
          fromStateSchema: 2,
          toStateSchema: 3,
          targetRevision: 149,
          protocol: 'stay-p1-r0-homeos-intero-route-activation-v1',
          outputPolicy: homeosIntero.OUTPUT_POLICY,
          routes: [homeosIntero.INTERO_ROUTE]
        }),
        sourceCheckpointGeneration: sourceCheckpoint.generation,
        sourceCheckpointHash: `sha256:${sourceCheckpoint.blobHash}`
      },
      149,
      `${resident.instanceId}:g${sourceCheckpoint.generation}`
    )
  });
  await runtime.manager.promoteP1ContainedGeneration({
    kind: 'INTERO_NEUTRAL_TO_SHADOW_R150',
    moduleRelativePath: 'cores/p1-r0/intero-shadow/index.js',
    binding: binding(141),
    nextContract: INTERO_SHADOW_RESIDENT_CONTRACT,
    publishActivation: async ({ sourceCheckpoint, resident }) => runtime.publishActivation(
      shadowIntero.ACTIVATION_TOPIC,
      {
        ...activationPayload(shadowIntero, {
          fromVersion: neutralIntero.VERSION,
          fromStateSchema: 1,
          toStateSchema: 2,
          targetRevision: 150,
          protocol: 'stay-p1-r0-intero-shadow-activation-v1',
          outputPolicy: shadowIntero.OUTPUT_POLICY
        }),
        sourceCheckpointGeneration: sourceCheckpoint.generation,
        sourceCheckpointHash: `sha256:${sourceCheckpoint.blobHash}`
      },
      150,
      `${resident.instanceId}:g${sourceCheckpoint.generation}`
    )
  });
  for (const name of ['metab', 'homeos', 'intero']) {
    const after = runtime.stateStore.getResident(`resident:${name}`);
    assert.equal(after.instanceId, before[name].instanceId);
    assert.equal(after.organismIdentityHash, before[name].organismIdentityHash);
    assert.equal(after.status, 'RUNNING');
    assert.equal((await runtime.manager.status(`resident:${name}`)).authorityOwned, false);
  }
  assert.equal(runtime.stateStore.getResident('resident:metab').version, metabIntero.VERSION);
  assert.equal(runtime.stateStore.getResident('resident:homeos').version, homeosIntero.VERSION);
  assert.equal(runtime.stateStore.getResident('resident:intero').version, shadowIntero.VERSION);
  assert.deepEqual(runtime.stateStore.listAuthority(), []);

  const third = capacitySignals(2, 40_300);
  await runtime.fabric.publishBiologicalSignal(third.eligible, {
    eventClass: 'durable',
    sourceVersion: '1.0.0'
  });
  await runtime.fabric.publishBiologicalSignal(third.quality, {
    eventClass: 'durable',
    sourceVersion: '1.0.0'
  });
  await runtime.manager.drain('resident:metab');
  await runtime.manager.drain('resident:homeos');
  await runtime.manager.drain('resident:intero');
  const interoStatus = await runtime.manager.status('resident:intero');
  assert.equal(interoStatus.health.projectionAvailable, true);
  assert.equal(interoStatus.health.biologicalOutputs, 0);
  assert.equal(interoStatus.observedOutputs, 0);
  assert.equal(runtime.stateStore.listPendingBiologicalOutboxIntents().length, 0);
  assert.deepEqual(runtime.stateStore.listAuthority(), []);
});

test('R150-INTERO-ENTRY-05 real LivingKernel path reaches R150 with contained sources and perception', async t => {
  const runtime = await managedR145Runtime(t, { includeIntero: false });
  const freezeDirectory = path.join(runtime.root, 'runtime-freezes');
  const publicKeyPath = path.join(runtime.root, 'release-authority.pub');
  const certificateFile = path.join(runtime.root, 'intero-neutral-birth.json');
  await fs.mkdir(freezeDirectory, { recursive: true });
  const parentFreeze = sealRevisionFreeze({
    format: REVISION_FREEZE_FORMAT,
    result: 'PASS',
    acceptance: 'ACCEPTED',
    freezeType: 'R145F_HOMEOS_SHADOW_ACCEPTANCE',
    runtime: { revision: 145, revisionLabel: 'R145F' }
  });
  await fs.writeFile(
    path.join(freezeDirectory, 'R145.json'),
    `${stableStringify(parentFreeze)}\n`,
    { encoding: 'utf8', mode: 0o444 }
  );
  await fs.chmod(path.join(freezeDirectory, 'R145.json'), 0o444);

  let sourceState = createCapacitySourceState({
    instanceId: INSTANCES.METAB,
    residentVersion: metabHomeos.VERSION
  });
  sourceState = stageCapacitySample(sourceState, {
    trustedTimeUs: 40_001_000,
    continuityEpoch: 1,
    metrics: {
      cpuCount: 4,
      loadAverageMilli: 1000,
      freeMemoryBytes: 6_000,
      totalMemoryBytes: 8_000
    }
  });
  sourceState = commitCapacitySample(sourceState);
  await runtime.stateStore.writeLife(SOURCE_STATE_KEY, sourceState);

  let wallClock = 1_800_000_000_000;
  let trustedTimeUs = 40_301_000;
  const kernel = new LivingKernel({
    dataDir: runtime.root,
    releaseRoot: ROOT,
    logger: { log() {}, info() {}, warn() {}, error() {} },
    clock: () => wallClock++,
    heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0,
    interoNeutralBirthAuthorization: 'AUTHORIZE_R147_INTERO_NEUTRAL_BIRTH_ONLY',
    metabInteroRouteAuthorization: 'AUTHORIZE_R148_METAB_INTERO_ROUTE_ONLY',
    homeosInteroRouteAuthorization: 'AUTHORIZE_R149_HOMEOS_INTERO_ROUTE_ONLY',
    interoShadowPromotionAuthorization: 'AUTHORIZE_R150_INTERO_PERCEPTION_ONLY_SHADOW_ONLY',
    interoNeutralBirthPublicKeyPath: publicKeyPath,
    interoNeutralBirthCertificateFile: certificateFile,
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
  kernel.runtimeRevision = 146;
  kernel.residentManager = runtime.manager;
  kernel.trustedOrganismTime = {
    sample: async () => {
      const value = trustedTimeUs;
      trustedTimeUs += 300_000;
      return { status: 'TRUSTED', trustedTimeUs: value, continuityEpoch: 1 };
    }
  };

  const inspected = await runtime.manager.inspect(
    'cores/p1-r0/intero-neutral/index.js',
    'resident:intero',
    INTERO_NEUTRAL_RESIDENT_CONTRACT
  );
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  await fs.writeFile(
    publicKeyPath,
    publicKey.export({ type: 'spki', format: 'pem' }),
    { encoding: 'utf8', mode: 0o444 }
  );
  await fs.chmod(publicKeyPath, 0o444);
  const body = {
    ...interoBirthBody(wallClock),
    manifestHash: inspected.manifestHash,
    moduleHash: inspected.definition.moduleDigest,
    packagePolicyHash: inspected.definition.packagePolicyHash,
    parentFreezeRecordSha256: parentFreeze.recordSha256
  };
  await fs.writeFile(
    certificateFile,
    `${stableStringify(signedInteroCertificate(body, privateKey))}\n`,
    { encoding: 'utf8', mode: 0o444 }
  );
  await fs.chmod(certificateFile, 0o444);

  await kernel.birthInteroNeutral();
  assert.equal(kernel.runtimeRevision, 147);
  await kernel.promoteMetabInteroRoute();
  assert.equal(kernel.runtimeRevision, 148);
  await kernel.promoteHomeosInteroRoute();
  assert.equal(kernel.runtimeRevision, 149);
  await kernel.promoteInteroShadow();
  assert.equal(kernel.runtimeRevision, 150);

  const statuses = await Promise.all(['metab', 'homeos', 'intero'].map(name =>
    runtime.manager.status(`resident:${name}`)
  ));
  assert.deepEqual(statuses.map(status => status.health.mode), ['SHADOW', 'SHADOW', 'SHADOW']);
  assert.equal(statuses.every(status => status.running === true), true);
  assert.equal(statuses.every(status => status.authorityOwned === false), true);
  assert.equal(statuses[2].health.projectionAvailable, true);
  assert.equal(statuses[2].health.receptorRoute, 'ABSENT');
  assert.equal(statuses[2].observedOutputs, 0);
  assert.deepEqual(runtime.stateStore.listAuthority(), []);
  assert.equal(runtime.stateStore.listPendingBiologicalOutboxIntents().length, 0);
  assert.equal(runtime.stateStore.db.prepare(
    "SELECT COUNT(*) AS count FROM biological_deliveries WHERE status='FAILED'"
  ).get().count, 0);
  const storage = new P1ProductionExpansionPersistence({
    stateStore: runtime.stateStore,
    authorization: PRODUCTION_STORAGE_AUTHORIZATION
  }).initialize();
  assert.equal(storage.legacy.readChip('resident:metab').currentState, 'SHADOW');
  assert.equal(storage.legacy.readChip('resident:homeos').currentState, 'SHADOW');
  assert.equal(storage.legacy.readChip('resident:intero').currentState, 'SHADOW');
});

test('R150-INTERO-WEB-06 born HOMEOS and INTERO replace roadmap labels with SHADOW chips', () => {
  const metadata = publicMetadata({
    kernel: { runtimeRevision: 150 },
    cores: [],
    residencies: ['metab', 'homeos', 'intero'].map((name, index) => ({
      residencyId: `resident:${name}`,
      coreId: name.toUpperCase(),
      version: [metabIntero.VERSION, homeosIntero.VERSION, shadowIntero.VERSION][index],
      status: 'RUNNING',
      lifecycle: 'RUNNING',
      running: true,
      authorityOwned: false,
      checkpointGeneration: index + 10,
      handledEvents: index + 20,
      observedOutputs: index === 2 ? 0 : index + 1,
      health: { ok: true, mode: 'SHADOW' }
    })),
    biologicalLedger: {
      protocol: 'stay-biological-ledger-v1',
      events: 100,
      pendingDeliveries: 0,
      activeConsumers: 3
    },
    health: { ok: true, persistence: { ok: true, writeFailureCount: 0 } }
  });
  assert.deepEqual(
    metadata.chipProjection.lifecycle.map(chip => [chip.coreId, chip.state, chip.symbol]),
    [
      ['bsf', 'LIVE', '●'],
      ['metab', 'SHADOW', '◐'],
      ['homeos', 'SHADOW', '◐'],
      ['intero', 'SHADOW', '◐']
    ]
  );
  assert.deepEqual(metadata.chipProjection.roadmap, []);
  assert.deepEqual(metadata.chipProjection.mutationEndpoints, []);
});

test('R150-INTERO-REVISION-07 only exact durable R147-R149 cohorts preserve revision after a crash', () => {
  const residents = new Map([
    ['resident:metab', {
      version: metabHomeos.VERSION,
      stateSchema: 3,
      moduleRelativePath: 'cores/p1-r0/metab-homeos/index.js',
      status: 'RUNNING'
    }],
    ['resident:homeos', {
      version: shadowHomeos.VERSION,
      stateSchema: 2,
      moduleRelativePath: 'cores/p1-r0/homeos-shadow/index.js',
      status: 'RUNNING'
    }],
    ['resident:intero', {
      version: neutralIntero.VERSION,
      stateSchema: 1,
      moduleRelativePath: 'cores/p1-r0/intero-neutral/index.js',
      status: 'RUNNING'
    }]
  ]);
  const harness = {
    runtimeRevision: 147,
    interoNeutralBirthAuthorization: 'AUTHORIZE_R147_INTERO_NEUTRAL_BIRTH_ONLY',
    metabInteroRouteAuthorization: 'AUTHORIZE_R148_METAB_INTERO_ROUTE_ONLY',
    homeosInteroRouteAuthorization: 'AUTHORIZE_R149_HOMEOS_INTERO_ROUTE_ONLY',
    interoShadowPromotionAuthorization: 'AUTHORIZE_R150_INTERO_PERCEPTION_ONLY_SHADOW_ONLY',
    stateStore: {
      getResident: residencyId => residents.get(residencyId) || null,
      listAuthority: () => []
    }
  };
  assert.equal(LivingKernel.prototype.preserveExactR150InteroProgressRevision.call(harness), true);
  harness.runtimeRevision = 148;
  residents.set('resident:metab', {
    version: metabIntero.VERSION,
    stateSchema: 4,
    moduleRelativePath: 'cores/p1-r0/metab-intero/index.js',
    status: 'RUNNING'
  });
  assert.equal(LivingKernel.prototype.preserveExactR150InteroProgressRevision.call(harness), true);
  harness.runtimeRevision = 149;
  residents.set('resident:homeos', {
    version: homeosIntero.VERSION,
    stateSchema: 3,
    moduleRelativePath: 'cores/p1-r0/homeos-intero/index.js',
    status: 'RUNNING'
  });
  assert.equal(LivingKernel.prototype.preserveExactR150InteroProgressRevision.call(harness), true);
  residents.get('resident:intero').status = 'QUARANTINED';
  assert.equal(LivingKernel.prototype.preserveExactR150InteroProgressRevision.call(harness), false);
});
