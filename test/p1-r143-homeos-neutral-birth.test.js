'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { stableStringify } = require('../runtime/kernel/canonical-json');
const { StateStore } = require('../runtime/kernel/state-store');
const {
  HOMEOS_NEUTRAL_AUTHORIZATION_CLASS,
  HOMEOS_NEUTRAL_BIRTH_FORMAT,
  verifyHomeosNeutralBirthCertificate
} = require('../runtime/p1-r0/homeos-neutral-birth-authority');
const { HOMEOS_NEUTRAL_RESIDENT_CONTRACT } = require('../runtime/p1-r0/homeos-neutral-contract');
const {
  EXPANSION_SCHEMA_NAME,
  PRODUCTION_STORAGE_AUTHORIZATION,
  P1ProductionExpansionPersistence
} = require('../runtime/p1-r0/production-persistence');
const { recordHash } = require('../runtime/p1-r0/records');
const { sha256 } = require('../runtime/p1-r0/resident-support');
const definition = require('../runtime/p1-r0/residents/homeos-neutral');
const profiles = require(
  '../runtime/p1-r0/c0-source-contracts/contracts/founder_profile_templates.json'
).profiles;

const IDENTITY = Object.freeze({
  organismId: 'stay-r143-homeos-birth-test',
  createdAt: '2026-09-03T08:00:00.000Z',
  lineage: 'STAY/Genesis'
});
const IDENTITY_HASH = sha256(IDENTITY);
const PARENT_FREEZE = `sha256:${'4'.repeat(64)}`;
const MODULE_HASH = `sha256:${'5'.repeat(64)}`;
const MANIFEST_HASH = `sha256:${'6'.repeat(64)}`;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function founderBinding() {
  const profile = clone(profiles.HOMEOS);
  profile.profileId = 'homeos.p1-r0.production-founder-r143-test.v1';
  return {
    recordVersion: 'P1ResidentFounderBindingV1',
    coreId: 'HOMEOS',
    organismId: IDENTITY.organismId,
    organismIdentityHash: IDENTITY_HASH,
    founderId: 'founder:homeos:r143:test',
    lineageId: 'lineage:homeos:r143:test',
    residencyId: 'resident:homeos',
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
    founderSchemaId: 'urn:stay:p1-r0:schema:homeos-founder-profile:v1',
    founderSchemaVersion: '1',
    genesisFrame: 0,
    genesisTransactionId: 'tx:homeos:r143:test',
    phenotypeHash: sha256({ coreId: founder.coreId, profile: founder.profile }),
    committed: true,
    previousFounderId: null
  };
}

function body(nowMs = 1_800_000_000_000) {
  return {
    allowedAction: 'birth-homeos-neutral',
    authorizationClass: HOMEOS_NEUTRAL_AUTHORIZATION_CLASS,
    certificateId: 'r143-homeos-neutral-test-certificate',
    expiresAtMs: nowMs + 60_000,
    founderBinding: founderBinding(),
    founderDossierSha256: recordHash({
      status: 'PRODUCTION_FOUNDER_CANDIDATE',
      reviewedProfile: founderBinding().profile,
      noAuthority: true
    }),
    founderRecord: founderRecord(),
    issuedAtMs: nowMs - 1_000,
    manifestHash: MANIFEST_HASH,
    moduleHash: MODULE_HASH,
    organismId: IDENTITY.organismId,
    organismIdentityHash: IDENTITY_HASH,
    packagePolicyHash: HOMEOS_NEUTRAL_RESIDENT_CONTRACT.packagePolicyHash,
    parentFreezeRecordSha256: PARENT_FREEZE,
    parentRevision: 141,
    residencyId: 'resident:homeos',
    targetRevision: 143,
    version: definition.VERSION
  };
}

function signedCertificate(bodyValue, privateKey) {
  return {
    format: HOMEOS_NEUTRAL_BIRTH_FORMAT,
    body: bodyValue,
    signature: crypto.sign(null, Buffer.from(stableStringify(bodyValue)), privateKey).toString('base64')
  };
}

function inspected() {
  return {
    contract: HOMEOS_NEUTRAL_RESIDENT_CONTRACT,
    definition: {
      manifest: definition.manifest,
      moduleDigest: MODULE_HASH,
      packagePolicyHash: HOMEOS_NEUTRAL_RESIDENT_CONTRACT.packagePolicyHash
    },
    manifestHash: MANIFEST_HASH
  };
}

async function makeStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r143-homeos-birth-'));
  const stateStore = new StateStore(root);
  await stateStore.init();
  t.after(async () => {
    try { stateStore.close(); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });
  return stateStore;
}

test('R143-HOMEOS-BIRTH-01 signed authority binds R141F, R143, executable and founder', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const nowMs = 1_800_000_000_000;
  const certificate = signedCertificate(body(nowMs), privateKey);
  const verified = verifyHomeosNeutralBirthCertificate(certificate, publicKey, {
    inspected: inspected(),
    identity: IDENTITY,
    runtimeRevision: 143,
    parentFreezeRecordSha256: PARENT_FREEZE,
    nowMs
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.founderRecord.coreId, 'HOMEOS');
  assert.equal(verified.founderBinding.mode, 'NEUTRAL');
  const wrongRevision = clone(certificate);
  wrongRevision.body.targetRevision = 144;
  wrongRevision.signature = crypto.sign(
    null,
    Buffer.from(stableStringify(wrongRevision.body)),
    privateKey
  ).toString('base64');
  assert.throws(() => verifyHomeosNeutralBirthCertificate(wrongRevision, publicKey, {
    inspected: inspected(),
    identity: IDENTITY,
    runtimeRevision: 144,
    parentFreezeRecordSha256: PARENT_FREEZE,
    nowMs
  }), { code: 'P1_HOMEOS_BIRTH_REVISION' });
});

test('R143-HOMEOS-BIRTH-02 additive persistence preserves legacy dossier and atomically commits HOMEOS origin', async t => {
  const stateStore = await makeStore(t);
  const storage = new P1ProductionExpansionPersistence({
    stateStore,
    authorization: PRODUCTION_STORAGE_AUTHORIZATION
  }).initialize();
  assert.equal(
    stateStore.db.prepare('SELECT version FROM schema_versions WHERE name=?').get(EXPANSION_SCHEMA_NAME).version,
    1
  );
  assert.ok(stateStore.db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='p1_birth_dossiers'"
  ).get());
  const authorization = {
    ok: true,
    certificateId: body().certificateId,
    authorizationClass: HOMEOS_NEUTRAL_AUTHORIZATION_CLASS,
    founderDossierSha256: body().founderDossierSha256,
    founderRecord: founderRecord(),
    founderBinding: founderBinding(),
    targetRevision: 143,
    parentFreezeRecordSha256: PARENT_FREEZE
  };
  const registration = {
    residencyId: 'resident:homeos',
    coreId: 'HOMEOS',
    role: 'homeostasis',
    instanceId: '00000000-0000-4000-8000-000000000143',
    version: definition.VERSION,
    stateSchema: definition.manifest.stateSchema,
    moduleRelativePath: 'cores/p1-r0/homeos-neutral/index.js',
    moduleHash: MODULE_HASH,
    manifestHash: MANIFEST_HASH,
    packagePolicyHash: HOMEOS_NEUTRAL_RESIDENT_CONTRACT.packagePolicyHash,
    organismIdentityHash: IDENTITY_HASH
  };
  const committed = storage.commitHomeosNeutralBirth({
    founder: founderRecord(),
    resident: registration,
    authorization
  });
  assert.equal(committed.resident.status, 'ATTACHED');
  assert.equal(storage.readFounder({ organismId: IDENTITY.organismId, coreId: 'HOMEOS' }).founderId,
    founderBinding().founderId);
  assert.equal(storage.readBirthDossier('resident:homeos').certificateId, authorization.certificateId);
  assert.equal(stateStore.db.prepare('SELECT COUNT(*) AS count FROM p1_birth_dossiers').get().count, 0);

  const conflicting = clone(authorization);
  conflicting.certificateId = 'r143-homeos-neutral-conflicting-certificate';
  assert.throws(() => storage.commitHomeosNeutralBirth({
    founder: founderRecord(),
    resident: registration,
    authorization: conflicting
  }), { code: 'P1_PRODUCTION_EXPANSION_DOSSIER_CONFLICT' });
  assert.equal(stateStore.getResident('resident:homeos').instanceId, registration.instanceId);
});
