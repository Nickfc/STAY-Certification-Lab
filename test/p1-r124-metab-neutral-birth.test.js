'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EventFabric } = require('../runtime/kernel/event-fabric');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const { ResidentManager, RESIDENT_SIGNALLING } = require('../runtime/kernel/resident-manager');
const { StateStore } = require('../runtime/kernel/state-store');
const {
  METAB_NEUTRAL_AUTHORIZATION_CLASS,
  METAB_NEUTRAL_BIRTH_FORMAT,
  verifyMetabNeutralBirthCertificate
} = require('../runtime/p1-r0/metab-neutral-birth-authority');
const {
  METAB_NEUTRAL_RESIDENT_CONTRACT
} = require('../runtime/p1-r0/metab-neutral-contract');
const {
  createNeutralMetabInitialState,
  manifest: neutralManifest
} = require('../runtime/p1-r0/residents/metab-neutral');
const {
  PRODUCTION_STORAGE_AUTHORIZATION,
  P1ProductionPersistence
} = require('../runtime/p1-r0/production-persistence');
const { recordHash } = require('../runtime/p1-r0/records');
const { sha256 } = require('../runtime/p1-r0/resident-support');
const profiles = require(
  '../runtime/p1-r0/c0-source-contracts/contracts/founder_profile_templates.json'
).profiles;
const packageHashes = require('../runtime/p1-r0/resident-package-hashes.json');
const {
  enforcePackagePolicy,
  verifyManifestAgainstPackagePolicy
} = require('../runtime/kernel/package-policy');
const { validateRequest } = require('../runtime/kernel/resident-control-socket');

const ROOT = path.resolve(__dirname, '..');
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const IDENTITY = Object.freeze({
  organismId: 'stay-r124-neutral-test',
  createdAt: '2026-09-02T10:00:00.000Z',
  lineage: 'STAY/Genesis'
});
const IDENTITY_HASH = sha256(IDENTITY);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function binding() {
  return {
    bindingVersion: 1,
    identitySha256: IDENTITY_HASH,
    organismLineage: 'STAY/Genesis',
    issuedAt: 10_000,
    runtimeRevision: 124,
    authorityEpoch: 124,
    kernelVersion: '0.8.11.3'
  };
}

function founderBinding() {
  const profile = clone(profiles.METAB);
  profile.profileId = 'metab.p1-r0.production-founder-candidate.r124.v1';
  return {
    recordVersion: 'P1ResidentFounderBindingV1',
    coreId: 'METAB',
    organismId: IDENTITY.organismId,
    organismIdentityHash: IDENTITY_HASH,
    founderId: 'founder:metab:r124:test',
    lineageId: 'lineage:metab:r124:test',
    residencyId: 'resident:metab',
    profileId: profile.profileId,
    profileHash: sha256(profile),
    profile,
    mode: 'NEUTRAL',
    authorityEpoch: '0'
  };
}

function founderRecord() {
  const founder = founderBinding();
  return {
    recordVersion: 'P1FounderRecordV1',
    organismId: founder.organismId,
    coreId: founder.coreId,
    founderId: founder.founderId,
    lineageId: founder.lineageId,
    profileId: founder.profileId,
    profileHash: founder.profileHash,
    founderSchemaId: 'urn:stay:p1-r0:schema:metab-founder-profile:v1',
    founderSchemaVersion: '1',
    genesisFrame: 0,
    genesisTransactionId: 'tx:metab:r124:test',
    phenotypeHash: sha256({ coreId: founder.coreId, profile: founder.profile }),
    committed: true,
    previousFounderId: null
  };
}

function chip(checkpoint, observedUtc = '2026-09-02T10:00:01.000Z') {
  return {
    recordVersion: 'CoreChipObservationV1',
    chipId: 'resident:metab',
    organismId: IDENTITY.organismId,
    coreId: 'METAB',
    publicName: 'METAB',
    born: true,
    firstActivationFrame: 0,
    firstResidencyId: 'resident:metab',
    currentState: 'NEUTRAL',
    mode: 'NEUTRAL',
    lifecycle: 'RUNNING',
    healthReasonCode: 'R124_NEUTRAL_ACCEPTED',
    coreVersion: neutralManifest.version,
    stateSchemaVersion: String(neutralManifest.stateSchema),
    checkpointGeneration: String(checkpoint.generation),
    lastTrustedFrame: null,
    coverageBand: 'UNKNOWN',
    evidenceRefs: [`sha256:${checkpoint.blobHash}`],
    observedUtc
  };
}

async function makeStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r124-neutral-'));
  const stateStore = new StateStore(root);
  await stateStore.init();
  t.after(async () => {
    try { stateStore.close(); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, stateStore };
}

test('R124-METAB-RED-01 neutral contract grants no physiology route or output permission', () => {
  assert.equal(METAB_NEUTRAL_RESIDENT_CONTRACT.residencyId, 'resident:metab');
  assert.equal(METAB_NEUTRAL_RESIDENT_CONTRACT.coreId, 'METAB');
  assert.equal(METAB_NEUTRAL_RESIDENT_CONTRACT.version, '0.1.0-p1r0-neutral.1');
  assert.equal(METAB_NEUTRAL_RESIDENT_CONTRACT.stage, 'p1-r0-production-neutral-r124');
  assert.equal(METAB_NEUTRAL_RESIDENT_CONTRACT.productionEligible, false);
  assert.equal(METAB_NEUTRAL_RESIDENT_CONTRACT.authorityMode, 'neutral');
  assert.equal(METAB_NEUTRAL_RESIDENT_CONTRACT.signalling, RESIDENT_SIGNALLING.FORBIDDEN);
  assert.deepEqual(METAB_NEUTRAL_RESIDENT_CONTRACT.inputs, ['runtime.organism.binding']);
  assert.deepEqual(METAB_NEUTRAL_RESIDENT_CONTRACT.outputs, []);
  assert.equal(METAB_NEUTRAL_RESIDENT_CONTRACT.packagePolicyHash, packageHashes.METAB_NEUTRAL);
});

test('R124-METAB-RED-02 neutral package is reproducible, resource-unchanged and output-firewalled', () => {
  const packageRoot = path.join(ROOT, 'cores', 'p1-r0', 'metab-neutral');
  const policy = enforcePackagePolicy(path.join(packageRoot, 'index.js'));
  const definition = require(path.join(packageRoot, 'index.js'));
  assert.equal(policy.policy.coreId, 'METAB');
  assert.equal(policy.policy.policyHash, packageHashes.METAB_NEUTRAL);
  assert.equal(policy.policy.bounds.productionOutputs, 0);
  assert.equal(policy.policy.resourceContract.manifestResources.handlerTimeoutMs, 250);
  assert.equal(policy.policy.resourceContract.manifestResources.hardRamMiB, 96);
  assert.equal(policy.policy.resourceContract.manifestResources.pidsMax, 16);
  assert.equal(verifyManifestAgainstPackagePolicy(policy, definition.manifest), true);
  assert.deepEqual(definition.manifest.inputs, ['runtime.organism.binding']);
  assert.deepEqual(definition.manifest.outputs, []);
  assert.deepEqual(definition.manifest.biology.producerCapabilities, []);
  assert.deepEqual(definition.manifest.biology.consumerRouteLeases, []);
});

test('R124-METAB-RED-03 neutral core requires one precommitted founder and cannot process physiology', async () => {
  await assert.rejects(
    () => require('../runtime/p1-r0/residents/metab-neutral').createCore(),
    { code: 'P1_METAB_NEUTRAL_FOUNDER_REQUIRED' }
  );
  const emitted = [];
  const initialState = createNeutralMetabInitialState({
    binding: binding(),
    founder: founderBinding()
  });
  const core = await require('../runtime/p1-r0/residents/metab-neutral').createCore({
    initialState,
    emit: async (...args) => emitted.push(args)
  });
  await core.start();
  await core.handle({ topic: 'runtime.organism.binding', payload: binding() });
  await assert.rejects(
    () => core.handle({
      topic: 'resource.capacity.eligible.v1',
      payload: { eligibleCapacityQ48: '1' }
    }),
    { code: 'P1_METAB_NEUTRAL_INPUT_FORBIDDEN' }
  );
  const health = await core.health();
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'NEUTRAL');
  assert.equal(health.authorityOwned, false);
  assert.equal(health.foundered, true);
  assert.equal(health.frameIndex, 0);
  assert.deepEqual(emitted, []);
});

test('R124-METAB-RED-04 production persistence requires its own token and commits founder plus resident atomically', async t => {
  const { stateStore } = await makeStore(t);
  assert.throws(
    () => new P1ProductionPersistence({ stateStore, authorization: 'P1_R0_LABORATORY_STORAGE_V1' }),
    { code: 'P1_PRODUCTION_STORAGE_AUTHORIZATION' }
  );
  assert.equal(
    stateStore.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'p1_%'").get().count,
    0
  );
  const storage = new P1ProductionPersistence({
    stateStore,
    authorization: PRODUCTION_STORAGE_AUTHORIZATION
  }).initialize();
  const registration = {
    residencyId: 'resident:metab',
    coreId: 'METAB',
    role: 'metabolism',
    instanceId: '00000000-0000-4000-8000-000000000124',
    version: neutralManifest.version,
    stateSchema: neutralManifest.stateSchema,
    moduleRelativePath: 'cores/p1-r0/metab-neutral/index.js',
    moduleHash: HASH_A,
    manifestHash: HASH_B,
    packagePolicyHash: packageHashes.METAB_NEUTRAL,
    organismIdentityHash: IDENTITY_HASH
  };
  const accepted = storage.commitNeutralBirth({ founder: founderRecord(), resident: registration });
  assert.deepEqual(accepted.founder, founderRecord());
  assert.equal(accepted.resident.status, 'ATTACHED');
  assert.equal(stateStore.getResident('resident:metab').instanceId, registration.instanceId);
  assert.throws(
    () => storage.commitNeutralBirth({
      founder: { ...founderRecord(), phenotypeHash: HASH_A },
      resident: registration
    }),
    { code: 'P1_FOUNDER_REROLL' }
  );
  assert.equal(storage.readChip('resident:metab'), null);
});

test('R124-METAB-RED-05 accepted RUNNING transition and persistent NEUTRAL chip share one transaction', async t => {
  const { stateStore } = await makeStore(t);
  const storage = new P1ProductionPersistence({
    stateStore,
    authorization: PRODUCTION_STORAGE_AUTHORIZATION
  }).initialize();
  let now = 10_000;
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
    contracts: [METAB_NEUTRAL_RESIDENT_CONTRACT]
  });
  t.after(() => manager.shutdown().catch(() => {}));
  const initialState = createNeutralMetabInitialState({
    binding: binding(),
    founder: founderBinding()
  });
  const unit = await manager.attach({
    moduleRelativePath: 'cores/p1-r0/metab-neutral/index.js',
    binding: binding(),
    initialState,
    registerResident: registration => storage.commitNeutralBirth({
      founder: founderRecord(),
      resident: registration
    }).resident,
    acceptanceCommit: ({ checkpoint }) => storage.appendNeutralChip(chip(checkpoint))
  });
  const resident = stateStore.getResident('resident:metab');
  const consumer = stateStore.getBiologicalConsumer('resident:metab');
  const status = await manager.status('resident:metab');
  assert.equal(unit.residencyId, 'resident:metab');
  assert.equal(resident.status, 'RUNNING');
  assert.deepEqual(consumer.topics, ['runtime.organism.binding']);
  assert.equal(consumer.authorityEpoch, 0);
  assert.equal(status.authorityOwned, false);
  assert.equal(status.observedOutputs, 0);
  assert.equal(status.health.mode, 'NEUTRAL');
  assert.equal(stateStore.listAuthority().length, 0);
  assert.equal(
    stateStore.db.prepare("SELECT COUNT(*) AS count FROM biological_outbox_intents WHERE producer_core_id='METAB'").get().count,
    0
  );
  const persistentChip = storage.readChip('resident:metab');
  assert.equal(persistentChip.currentState, 'NEUTRAL');
  assert.equal(persistentChip.checkpointGeneration, String(resident.checkpointGeneration));
  assert.equal(storage.verifyChipHistory('resident:metab'), true);
});

test('R124-METAB-RED-06 birth certificate binds R123F, R124, executable and one exact founder dossier', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const inspected = {
    manifestHash: HASH_A,
    moduleRelativePath: 'cores/p1-r0/metab-neutral/index.js',
    contract: METAB_NEUTRAL_RESIDENT_CONTRACT,
    definition: {
      manifest: neutralManifest,
      moduleDigest: HASH_B,
      packagePolicyHash: packageHashes.METAB_NEUTRAL
    }
  };
  const nowMs = 1_800_000_000_000;
  const body = {
    allowedAction: 'birth-metab-neutral',
    authorizationClass: METAB_NEUTRAL_AUTHORIZATION_CLASS,
    certificateId: 'r124-metab-neutral-test-certificate',
    expiresAtMs: nowMs + 60_000,
    founderBinding: founderBinding(),
    founderDossierSha256: recordHash({
      status: 'PRODUCTION_FOUNDER_CANDIDATE',
      reviewedProfile: founderBinding().profile,
      noAuthority: true
    }),
    founderRecord: founderRecord(),
    issuedAtMs: nowMs - 1_000,
    manifestHash: inspected.manifestHash,
    moduleHash: inspected.definition.moduleDigest,
    organismId: IDENTITY.organismId,
    organismIdentityHash: IDENTITY_HASH,
    packagePolicyHash: inspected.definition.packagePolicyHash,
    parentFreezeRecordSha256: HASH_A,
    parentRevision: 123,
    residencyId: 'resident:metab',
    targetRevision: 124,
    version: neutralManifest.version
  };
  const certificate = {
    format: METAB_NEUTRAL_BIRTH_FORMAT,
    body,
    signature: crypto.sign(null, Buffer.from(stableStringify(body)), privateKey).toString('base64')
  };
  const verified = verifyMetabNeutralBirthCertificate(certificate, publicKey, {
    inspected,
    identity: IDENTITY,
    runtimeRevision: 124,
    parentFreezeRecordSha256: HASH_A,
    nowMs
  });
  assert.equal(verified.authorizationClass, METAB_NEUTRAL_AUTHORIZATION_CLASS);
  assert.deepEqual(verified.founderRecord, founderRecord());
  assert.deepEqual(verified.founderBinding, founderBinding());
  const altered = clone(certificate);
  altered.body.founderBinding.profile.reserve.initialFractionQ48 = '0';
  assert.throws(
    () => verifyMetabNeutralBirthCertificate(altered, publicKey, {
      inspected,
      identity: IDENTITY,
      runtimeRevision: 124,
      parentFreezeRecordSha256: HASH_A,
      nowMs
    }),
    { code: 'P1_METAB_BIRTH_FOUNDER' }
  );
});

test('R124-METAB-RED-07 control surface exposes exact birth but forbids generic METAB attach and new-system promotion', () => {
  assert.deepEqual(validateRequest({
    format: 'stay-resident-control-v1',
    operation: 'birth',
    residencyId: 'resident:metab'
  }), { operation: 'birth', residencyId: 'resident:metab' });
  assert.throws(() => validateRequest({
    format: 'stay-resident-control-v1',
    operation: 'birth',
    residencyId: 'resident:homeos'
  }), { code: 'RESIDENT_CONTROL_RESIDENCY' });
  assert.throws(() => validateRequest({
    format: 'stay-resident-control-v1',
    operation: 'promote',
    residencyId: 'resident:metab'
  }), { code: 'RESIDENT_CONTROL_OPERATION' });
});
