'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EventFabric } = require('../runtime/kernel/event-fabric');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const { LivingKernel } = require('../runtime/kernel/living-kernel');
const { ResidentManager, RESIDENT_SIGNALLING } = require('../runtime/kernel/resident-manager');
const { StateStore } = require('../runtime/kernel/state-store');
const {
  FORMAT: REVISION_FREEZE_FORMAT,
  sealRevisionFreeze
} = require('../runtime/revision-freeze');
const {
  METAB_NEUTRAL_AUTHORIZATION_CLASS,
  METAB_NEUTRAL_BIRTH_FORMAT,
  loadAndVerifyMetabNeutralBirth,
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
  PRODUCTION_SCHEMA_NAME,
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
const { validateArguments: validateControlClientArguments } = require(
  '../deploy/live-physiology-transplant/p1-resident-control-client'
);
const { projectObservationChips } = require('../runtime/ui/chip-projection');

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

function birthAuthorization() {
  return Object.freeze({
    ok: true,
    certificateId: 'r124-metab-neutral-test-certificate',
    authorizationClass: METAB_NEUTRAL_AUTHORIZATION_CLASS,
    founderDossierSha256: recordHash({
      status: 'PRODUCTION_FOUNDER_CANDIDATE',
      reviewedProfile: founderBinding().profile,
      noAuthority: true
    }),
    founderRecord: founderRecord(),
    founderBinding: founderBinding(),
    targetRevision: 124,
    parentFreezeRecordSha256: HASH_A
  });
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

async function makeStore(t, registerCleanup = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r124-neutral-'));
  const stateStore = new StateStore(root);
  await stateStore.init();
  if (registerCleanup) {
    t.after(async () => {
      try { stateStore.close(); } catch {}
      await fs.rm(root, { recursive: true, force: true });
    });
  }
  return { root, stateStore };
}

async function writeReadOnlyJson(file, value) {
  await fs.writeFile(file, `${stableStringify(value)}\n`, { encoding: 'utf8', mode: 0o444 });
  await fs.chmod(file, 0o444);
}

async function makeKernelHarness(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r124-kernel-'));
  const freezeDirectory = path.join(root, 'runtime-freezes');
  const publicKeyPath = path.join(root, 'release-authority.pub');
  const certificateFile = path.join(root, 'metab-neutral-birth.json');
  await fs.mkdir(freezeDirectory, { recursive: true });

  const seed = new StateStore(root);
  await seed.init();
  await seed.writeLife('identity', IDENTITY);
  await seed.writeLife('organism-binding', binding());
  await seed.writeLife('runtime-revision', {
    revision: 123,
    reason: 'r123f.accepted',
    at: '2026-09-02T09:59:59.000Z',
    kernelVersion: '0.8.11.3'
  });
  seed.close();

  const parentFreeze = sealRevisionFreeze({
    format: REVISION_FREEZE_FORMAT,
    result: 'PASS',
    acceptance: 'ACCEPTED',
    freezeType: 'R123F_72_HOUR_ACCEPTANCE',
    runtime: {
      revision: 123,
      revisionLabel: 'R123F'
    }
  });
  await writeReadOnlyJson(path.join(freezeDirectory, 'R123.json'), parentFreeze);

  const nowMs = 1_800_000_000_000;
  const kernel = new LivingKernel({
    dataDir: root,
    releaseRoot: ROOT,
    logger: { log() {}, info() {}, warn() {}, error() {} },
    clock: () => nowMs,
    heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0,
    allowMetabNeutralBirth: true,
    metabNeutralBirthPublicKeyPath: publicKeyPath,
    metabNeutralBirthCertificateFile: certificateFile,
    runtimeFreezeDirectory: freezeDirectory
  });
  await kernel.start();
  assert.equal(kernel.runtimeRevision, 124);

  const inspected = await kernel.ensureResidentManager().inspect(
    'cores/p1-r0/metab-neutral/index.js',
    'resident:metab'
  );
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  await fs.writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }), {
    encoding: 'utf8',
    mode: 0o444
  });
  await fs.chmod(publicKeyPath, 0o444);
  const body = {
    allowedAction: 'birth-metab-neutral',
    authorizationClass: METAB_NEUTRAL_AUTHORIZATION_CLASS,
    certificateId: 'r124-metab-neutral-kernel-entry-test',
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
    parentFreezeRecordSha256: parentFreeze.recordSha256,
    parentRevision: 123,
    residencyId: 'resident:metab',
    targetRevision: 124,
    version: neutralManifest.version
  };
  await writeReadOnlyJson(certificateFile, {
    format: METAB_NEUTRAL_BIRTH_FORMAT,
    body,
    signature: crypto.sign(
      null,
      Buffer.from(stableStringify(body)),
      privateKey
    ).toString('base64')
  });

  t.after(async () => {
    await kernel.stop().catch(() => {});
    await fs.chmod(publicKeyPath, 0o666).catch(() => {});
    await fs.chmod(certificateFile, 0o666).catch(() => {});
    await fs.chmod(path.join(freezeDirectory, 'R123.json'), 0o666).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    kernel,
    parentFreeze,
    root,
    freezeDirectory,
    publicKeyPath,
    certificateFile,
    nowMs
  };
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
  assert.equal(
    stateStore.db.prepare('SELECT version FROM schema_versions WHERE name=?').get(PRODUCTION_SCHEMA_NAME).version,
    1
  );
  assert.equal(
    stateStore.db.prepare("SELECT COUNT(*) AS count FROM schema_versions WHERE name='p1-r0-laboratory'").get().count,
    0
  );
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
  const accepted = storage.commitNeutralBirth({
    founder: founderRecord(),
    resident: registration,
    authorization: birthAuthorization()
  });
  assert.deepEqual(accepted.founder, founderRecord());
  assert.equal(accepted.resident.status, 'ATTACHED');
  assert.equal(accepted.dossier.certificateId, birthAuthorization().certificateId);
  assert.deepEqual(storage.readBirthDossier(), accepted.dossier);
  assert.equal(stateStore.getResident('resident:metab').instanceId, registration.instanceId);
  assert.throws(
    () => storage.commitNeutralBirth({
      founder: { ...founderRecord(), phenotypeHash: HASH_A },
      resident: registration,
      authorization: birthAuthorization()
    }),
    { code: 'P1_FOUNDER_REROLL' }
  );
  assert.equal(storage.readChip('resident:metab'), null);
});

test('R124-METAB-RED-05 accepted RUNNING transition and persistent NEUTRAL chip share one transaction', async t => {
  const { root, stateStore } = await makeStore(t, false);
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
  t.after(async () => {
    await manager.shutdown().catch(() => {});
    try { stateStore.close(); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });
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
      resident: registration,
      authorization: birthAuthorization()
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
  assert.deepEqual(validateControlClientArguments(['birth', 'resident:metab']), {
    operation: 'birth', residencyId: 'resident:metab'
  });
  assert.deepEqual(validateControlClientArguments(['status', 'resident:metab']), {
    operation: 'status', residencyId: 'resident:metab'
  });
  assert.throws(
    () => validateControlClientArguments(['attach', 'resident:metab']),
    { code: 'RESIDENT_CONTROL_CLIENT_USAGE' }
  );
  assert.throws(
    () => validateControlClientArguments(['birth', 'resident:sntss']),
    { code: 'RESIDENT_CONTROL_CLIENT_USAGE' }
  );
});

test('R124-METAB-ENTRY-01 real LivingKernel path births one neutral resident without advancing R124', async t => {
  const { kernel, parentFreeze } = await makeKernelHarness(t);
  const revisionBefore = await kernel.stateStore.readLife('runtime-revision', null);
  const biologicalEventsBefore = kernel.stateStore.db.prepare(
    'SELECT COUNT(*) AS count FROM biological_events'
  ).get().count;

  const unit = await kernel.birthMetabNeutral();
  const resident = kernel.stateStore.getResident('resident:metab');
  const status = await kernel.ensureResidentManager().status('resident:metab');
  const consumer = kernel.stateStore.getBiologicalConsumer('resident:metab');
  const storage = new P1ProductionPersistence({
    stateStore: kernel.stateStore,
    authorization: PRODUCTION_STORAGE_AUTHORIZATION
  }).initialize();
  const persistentChip = storage.readChip('resident:metab');

  assert.equal(unit.residencyId, 'resident:metab');
  assert.equal(kernel.runtimeRevision, 124);
  assert.equal((await kernel.stateStore.readLife('runtime-revision', null)).revision, 124);
  assert.equal(revisionBefore.revision, 124);
  assert.equal(resident.status, 'RUNNING');
  assert.equal(resident.version, neutralManifest.version);
  assert.equal(status.health.mode, 'NEUTRAL');
  assert.equal(status.authorityOwned, false);
  assert.equal(status.observedOutputs, 0);
  assert.deepEqual(consumer.topics, ['runtime.organism.binding']);
  assert.equal(consumer.authorityEpoch, 0);
  assert.equal(kernel.stateStore.getAuthority('METAB'), null);
  assert.equal(kernel.stateStore.getResident('resident:homeos'), null);
  assert.equal(kernel.stateStore.getResident('resident:intero'), null);
  assert.equal(
    kernel.stateStore.db.prepare(
      "SELECT COUNT(*) AS count FROM biological_outbox_intents WHERE producer_core_id='METAB'"
    ).get().count,
    0
  );
  assert.equal(
    kernel.stateStore.db.prepare(
      'SELECT COUNT(*) AS count FROM biological_events'
    ).get().count,
    biologicalEventsBefore
  );
  assert.equal(persistentChip.currentState, 'NEUTRAL');
  assert.equal(persistentChip.mode, 'NEUTRAL');
  assert.equal(persistentChip.checkpointGeneration, String(resident.checkpointGeneration));
  assert.equal(storage.verifyChipHistory('resident:metab'), true);
  assert.match(parentFreeze.recordSha256, /^sha256:[0-9a-f]{64}$/);
});

test('R124-METAB-ENTRY-02 real birth path is fail-closed without its exact gate', async t => {
  const { kernel } = await makeKernelHarness(t);
  kernel.allowMetabNeutralBirth = false;
  await assert.rejects(
    () => kernel.birthMetabNeutral(),
    { code: 'P1_METAB_BIRTH_NOT_AUTHORIZED' }
  );
  assert.equal(kernel.stateStore.getResident('resident:metab'), null);
  assert.equal(
    kernel.stateStore.db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'p1_%'"
    ).get().count,
    0
  );
});

test('R124-METAB-ROLLBACK-01 founder and resident registration roll back together', async t => {
  const { stateStore } = await makeStore(t);
  const storage = new P1ProductionPersistence({
    stateStore,
    authorization: PRODUCTION_STORAGE_AUTHORIZATION
  }).initialize();
  const originalRegister = stateStore.registerResident.bind(stateStore);
  stateStore.registerResident = () => {
    throw Object.assign(new Error('injected registration failure'), {
      code: 'INJECTED_REGISTRATION_FAILURE'
    });
  };
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
  assert.throws(
    () => storage.commitNeutralBirth({
      founder: founderRecord(),
      resident: registration,
      authorization: birthAuthorization()
    }),
    { code: 'INJECTED_REGISTRATION_FAILURE' }
  );
  stateStore.registerResident = originalRegister;
  assert.equal(storage.readFounder({ organismId: IDENTITY.organismId, coreId: 'METAB' }), null);
  assert.equal(stateStore.getResident('resident:metab'), null);
});

test('R124-METAB-ROLLBACK-02 failed acceptance preserves checkpoint and retries forward without reroll', async t => {
  const { root, stateStore } = await makeStore(t, false);
  const storage = new P1ProductionPersistence({
    stateStore,
    authorization: PRODUCTION_STORAGE_AUTHORIZATION
  }).initialize();
  let now = 20_000;
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
  t.after(async () => {
    await manager.shutdown().catch(() => {});
    try { stateStore.close(); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });
  const initialState = createNeutralMetabInitialState({
    binding: binding(),
    founder: founderBinding()
  });
  await assert.rejects(
    () => manager.attach({
      moduleRelativePath: 'cores/p1-r0/metab-neutral/index.js',
      binding: binding(),
      initialState,
      instanceId: '00000000-0000-4000-8000-000000000124',
      registerResident: registration => storage.commitNeutralBirth({
        founder: founderRecord(),
        resident: registration,
        authorization: birthAuthorization()
      }).resident,
      acceptanceCommit: () => {
        throw Object.assign(new Error('injected chip failure'), {
          code: 'INJECTED_CHIP_FAILURE'
        });
      }
    }),
    { code: 'INJECTED_CHIP_FAILURE' }
  );
  const retainedCheckpoint = await stateStore.readResidentCheckpoint('resident:metab');
  assert.equal(stateStore.getResident('resident:metab').status, 'ATTACHED');
  assert.equal(retainedCheckpoint.generation, 1);
  assert.equal(stateStore.getBiologicalConsumer('resident:metab').active, false);
  assert.equal(storage.readChip('resident:metab'), null);
  assert.deepEqual(
    storage.readFounder({ organismId: IDENTITY.organismId, coreId: 'METAB' }),
    founderRecord()
  );
  assert.equal(manager.units.has('resident:metab'), false);

  await manager.recover('resident:metab', binding(), {
    acceptanceCommit: ({ checkpoint }) =>
      storage.appendNeutralChip(chip(checkpoint, '2026-09-02T10:00:02.000Z'))
  });
  const recovered = stateStore.getResident('resident:metab');
  assert.equal(recovered.status, 'RUNNING');
  assert.equal(recovered.instanceId, '00000000-0000-4000-8000-000000000124');
  assert.equal(stateStore.getBiologicalConsumer('resident:metab').active, true);
  assert.equal(storage.readChip('resident:metab').currentState, 'NEUTRAL');
  assert.equal(storage.verifyChipHistory('resident:metab'), true);
  assert.equal(stateStore.getAuthority('METAB'), null);
});

test('R124-METAB-RECOVERY-01 whole-kernel R125 recovery preserves founder, instance and neutral containment', async t => {
  const { kernel, root } = await makeKernelHarness(t);
  await kernel.birthMetabNeutral();
  const bornResident = kernel.stateStore.getResident('resident:metab');
  const bornStorage = new P1ProductionPersistence({
    stateStore: kernel.stateStore,
    authorization: PRODUCTION_STORAGE_AUTHORIZATION
  }).initialize();
  const bornFounder = bornStorage.readFounder({
    organismId: IDENTITY.organismId,
    coreId: 'METAB'
  });
  const bornChip = bornStorage.readChip('resident:metab');
  await kernel.stop();

  const restarted = new LivingKernel({
    dataDir: root,
    releaseRoot: ROOT,
    logger: { log() {}, info() {}, warn() {}, error() {} },
    clock: () => 1_800_000_001_000,
    heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0,
    runtimeFreezeDirectory: path.join(root, 'runtime-freezes')
  });
  try {
    await restarted.start();
    const recoveredResident = restarted.stateStore.getResident('resident:metab');
    const recoveredStatus = await restarted.ensureResidentManager().status('resident:metab');
    const recoveredStorage = new P1ProductionPersistence({
      stateStore: restarted.stateStore,
      authorization: PRODUCTION_STORAGE_AUTHORIZATION
    }).initialize();
    const recoveredChip = recoveredStorage.readChip('resident:metab');
    assert.equal(restarted.runtimeRevision, 125);
    assert.equal(recoveredResident.status, 'RUNNING');
    assert.equal(recoveredResident.instanceId, bornResident.instanceId);
    assert.equal(
      recoveredResident.checkpointGeneration,
      bornResident.checkpointGeneration + 2,
      'orderly shutdown and R125 recovery each persist one monotonic checkpoint'
    );
    assert.deepEqual(
      recoveredStorage.readFounder({ organismId: IDENTITY.organismId, coreId: 'METAB' }),
      bornFounder
    );
    assert.equal(recoveredChip.currentState, 'NEUTRAL');
    assert.equal(recoveredChip.checkpointGeneration, String(recoveredResident.checkpointGeneration));
    assert.notEqual(recoveredChip.historyHeadHash, bornChip.historyHeadHash);
    assert.equal(recoveredStorage.verifyChipHistory('resident:metab'), true);
    assert.equal(recoveredStatus.health.mode, 'NEUTRAL');
    assert.equal(recoveredStatus.authorityOwned, false);
    assert.equal(recoveredStatus.observedOutputs, 0);
    assert.equal(restarted.stateStore.getAuthority('METAB'), null);
    assert.equal(restarted.stateStore.getResident('resident:homeos'), null);
    assert.equal(restarted.stateStore.getResident('resident:intero'), null);
  } finally {
    await restarted.stop().catch(() => {});
  }
});

test('R124-METAB-WEB-01 accepted METAB replaces only its roadmap label with an observation-only NEUTRAL chip', () => {
  const projection = projectObservationChips({
    systems: [{
      id: 'bsf', label: 'BSF', mode: 'LIVE', status: 'RUNNING', running: true,
      healthOk: true
    }],
    residents: [{
      residencyId: 'resident:sntss', coreId: 'sntss', version: '0.5.0-i4g1',
      mode: 'SHADOW', status: 'RUNNING', lifecycle: 'RUNNING', running: true,
      healthOk: true, observedOutputs: 0
    }, {
      residencyId: 'resident:chronobiology', coreId: 'chronobiology',
      version: '1.0.0-c3rc.5', mode: 'SHADOW', status: 'RUNNING',
      lifecycle: 'RUNNING', running: true, healthOk: true
    }, {
      residencyId: 'resident:metab', coreId: 'METAB', version: neutralManifest.version,
      mode: 'NEUTRAL', status: 'RUNNING', lifecycle: 'RUNNING', running: true,
      healthOk: true, checkpointGeneration: 1, handledEvents: 0, observedOutputs: 0
    }]
  });
  assert.deepEqual(
    projection.lifecycle.map(entry => `${entry.label} · ${entry.state}`),
    ['BSF · LIVE', 'SNTSS · SHADOW', 'CHRONOBIOLOGY · SHADOW', 'METAB · NEUTRAL']
  );
  assert.deepEqual(
    projection.roadmap.map(entry => `${entry.label} · ${entry.stage}`),
    ['HOMEOS · LAB QUALIFIED', 'INTERO · LAB QUALIFIED']
  );
  assert.equal(projection.lifecycle.at(-1).symbol, '◇');
  assert.equal(projection.lifecycle.at(-1).observationOnly, true);
  assert.deepEqual(projection.mutationEndpoints, []);
});

test('R124-METAB-RECOVERY-02 R125 resumes a power-loss window after atomic dossier registration and before checkpoint', async t => {
  const {
    kernel,
    root,
    freezeDirectory,
    publicKeyPath,
    certificateFile,
    parentFreeze,
    nowMs
  } = await makeKernelHarness(t);
  const manager = kernel.ensureResidentManager();
  const inspected = await manager.inspect(
    'cores/p1-r0/metab-neutral/index.js',
    'resident:metab'
  );
  const authorization = loadAndVerifyMetabNeutralBirth({
    inspected,
    identity: IDENTITY,
    runtimeRevision: 124,
    parentFreezeRecordSha256: parentFreeze.recordSha256,
    publicKeyPath,
    certificateFile,
    nowMs
  });
  const storage = new P1ProductionPersistence({
    stateStore: kernel.stateStore,
    authorization: PRODUCTION_STORAGE_AUTHORIZATION
  }).initialize();
  storage.commitNeutralBirth({
    founder: authorization.founderRecord,
    authorization,
    resident: {
      residencyId: 'resident:metab',
      coreId: 'METAB',
      role: 'metabolism',
      instanceId: '00000000-0000-4000-8000-000000000125',
      version: inspected.definition.manifest.version,
      stateSchema: inspected.definition.manifest.stateSchema,
      moduleRelativePath: inspected.moduleRelativePath,
      moduleHash: inspected.definition.moduleDigest,
      manifestHash: inspected.manifestHash,
      packagePolicyHash: inspected.definition.packagePolicyHash,
      organismIdentityHash: IDENTITY_HASH
    }
  });
  assert.equal(kernel.stateStore.getResident('resident:metab').status, 'ATTACHED');
  assert.equal(await kernel.stateStore.readResidentCheckpoint('resident:metab'), null);
  assert.equal(storage.readChip('resident:metab'), null);
  await kernel.stop();

  const restarted = new LivingKernel({
    dataDir: root,
    releaseRoot: ROOT,
    logger: { log() {}, info() {}, warn() {}, error() {} },
    clock: () => nowMs + 1_000,
    heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0,
    runtimeFreezeDirectory: freezeDirectory
  });
  try {
    await restarted.start();
    const resident = restarted.stateStore.getResident('resident:metab');
    const status = await restarted.ensureResidentManager().status('resident:metab');
    const recoveredStorage = new P1ProductionPersistence({
      stateStore: restarted.stateStore,
      authorization: PRODUCTION_STORAGE_AUTHORIZATION
    }).initialize();
    assert.equal(restarted.runtimeRevision, 125);
    assert.equal(resident.status, 'RUNNING');
    assert.equal(resident.instanceId, '00000000-0000-4000-8000-000000000125');
    assert.equal(resident.checkpointGeneration, 1);
    assert.equal(status.health.mode, 'NEUTRAL');
    assert.equal(status.authorityOwned, false);
    assert.equal(status.observedOutputs, 0);
    assert.equal(recoveredStorage.readChip('resident:metab').currentState, 'NEUTRAL');
    assert.equal(recoveredStorage.verifyChipHistory('resident:metab'), true);
    assert.equal(restarted.stateStore.getAuthority('METAB'), null);
  } finally {
    await restarted.stop().catch(() => {});
  }
});
