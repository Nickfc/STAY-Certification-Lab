'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { stableStringify } = require('../runtime/kernel/canonical-json');
const {
  buildMetabNeutralBirthMaterials,
  createFounderDossier,
  inspectMetabNeutralCandidate,
  SOURCE_PROFILE_HASH,
  VARIATION_BOUNDS
} = require('../runtime/p1-r0/metab-founder-dossier');
const {
  METAB_NEUTRAL_BIRTH_FORMAT,
  verifyMetabNeutralBirthCertificate
} = require('../runtime/p1-r0/metab-neutral-birth-authority');
const {
  METAB_NEUTRAL_RESIDENT_CONTRACT
} = require('../runtime/p1-r0/metab-neutral-contract');
const { sha256 } = require('../runtime/p1-r0/resident-support');
const { manifest } = require('../runtime/p1-r0/residents/metab-neutral');
const { FORMAT: FREEZE_FORMAT, sealRevisionFreeze } = require('../runtime/revision-freeze');
const templates = require(
  '../runtime/p1-r0/c0-source-contracts/contracts/founder_profile_templates.json'
);

const ROOT = path.resolve(__dirname, '..');
const IDENTITY = Object.freeze({
  organismId: 'stay-r124-founder-test',
  createdAt: '2026-09-02T00:00:00.000Z',
  lineage: 'STAY/Genesis'
});
const PARENT_FREEZE = Object.freeze(sealRevisionFreeze({
  format: FREEZE_FORMAT,
  result: 'PASS',
  acceptance: 'ACCEPTED',
  freezeType: 'R123F_72_HOUR_ACCEPTANCE',
  runtime: { revision: 123, revisionLabel: 'R123F' }
}));
const ENTROPY_A = Buffer.from(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  'hex'
);
const ENTROPY_B = Buffer.from(
  'f0e0d0c0b0a09080706050403020100000112233445566778899aabbccddeeff',
  'hex'
);

function inspectedFixture() {
  return Object.freeze({
    definition: Object.freeze({
      manifest,
      moduleDigest: `sha256:${'a'.repeat(64)}`,
      packagePolicyHash: METAB_NEUTRAL_RESIDENT_CONTRACT.packagePolicyHash
    }),
    contract: METAB_NEUTRAL_RESIDENT_CONTRACT,
    moduleRelativePath: 'cores/p1-r0/metab-neutral/index.js',
    manifestHash: sha256(manifest)
  });
}

function keyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

test('R124-METAB-FOUNDER-01 deterministic external variation stays inside every C0 and executable bound', () => {
  const first = createFounderDossier({
    identity: IDENTITY,
    parentFreeze: PARENT_FREEZE,
    entropy: ENTROPY_A,
    issuedAtMs: 1_800_000_000_000
  });
  const second = createFounderDossier({
    identity: IDENTITY,
    parentFreeze: PARENT_FREEZE,
    entropy: ENTROPY_A,
    issuedAtMs: 1_800_000_000_000
  });
  assert.equal(stableStringify(first), stableStringify(second));
  assert.equal(sha256(templates.profiles.METAB), SOURCE_PROFILE_HASH);
  assert.notEqual(first.founderBinding.profileHash, SOURCE_PROFILE_HASH);
  assert.equal(first.founderBinding.mode, 'NEUTRAL');
  assert.equal(first.founderBinding.authorityEpoch, '0');
  assert.equal(first.dossier.noAuthority, true);
  assert.deepEqual(first.dossier.outputs, []);
  for (const [label, maximum] of Object.entries(VARIATION_BOUNDS)) {
    assert.ok(Math.abs(first.dossier.variationBps[label]) <= maximum, label);
  }
  assert.ok(first.dossier.variationBps.etaFounderQ48 <= 0);
  for (const field of [
    first.founderBinding.profile.etaFounderQ48,
    first.founderBinding.profile.reserve.initialFractionQ48,
    first.founderBinding.profile.reserve.chargeEfficiencyQ48,
    first.founderBinding.profile.reserve.dischargeEfficiencyQ48
  ]) assert.ok(BigInt(field) <= (1n << 48n));
  const other = createFounderDossier({
    identity: IDENTITY,
    parentFreeze: PARENT_FREEZE,
    entropy: ENTROPY_B,
    issuedAtMs: 1_800_000_000_000
  });
  assert.notEqual(other.founderBinding.profileHash, first.founderBinding.profileHash);
  assert.notEqual(other.founderRecord.founderId, first.founderRecord.founderId);
});

test('R124-METAB-FOUNDER-02 signed birth binds one dossier, exact package, R123F and R124', () => {
  const { privateKey, publicKey } = keyPair();
  const inspected = inspectedFixture();
  const materials = buildMetabNeutralBirthMaterials({
    identity: IDENTITY,
    parentFreeze: PARENT_FREEZE,
    entropy: ENTROPY_A,
    issuedAtMs: 1_800_000_000_000,
    validityMs: 60_000,
    inspected,
    privateKey
  });
  assert.equal(materials.certificate.format, METAB_NEUTRAL_BIRTH_FORMAT);
  assert.equal(
    materials.certificate.body.founderDossierSha256,
    materials.founderDossierSha256
  );
  const verified = verifyMetabNeutralBirthCertificate(
    materials.certificate,
    publicKey,
    {
      inspected,
      identity: IDENTITY,
      runtimeRevision: 124,
      parentFreezeRecordSha256: PARENT_FREEZE.recordSha256,
      nowMs: 1_800_000_000_000
    }
  );
  assert.equal(verified.ok, true);
  assert.equal(verified.founderRecord.founderId, materials.founderRecord.founderId);
  const changed = structuredClone(materials.certificate);
  changed.body.targetRevision = 125;
  assert.throws(() => verifyMetabNeutralBirthCertificate(changed, publicKey, {
    inspected,
    identity: IDENTITY,
    runtimeRevision: 125,
    parentFreezeRecordSha256: PARENT_FREEZE.recordSha256,
    nowMs: 1_800_000_000_000
  }), { code: 'P1_METAB_BIRTH_REVISION' });
});

test('R124-METAB-FOUNDER-03 entropy, identity, parent freeze, validity and candidate drift fail closed', () => {
  assert.throws(() => createFounderDossier({
    identity: IDENTITY,
    parentFreeze: PARENT_FREEZE,
    entropy: Buffer.alloc(31),
    issuedAtMs: 1
  }), { code: 'P1_METAB_FOUNDER_ENTROPY' });
  assert.throws(() => createFounderDossier({
    identity: { ...IDENTITY, extra: true },
    parentFreeze: PARENT_FREEZE,
    entropy: ENTROPY_A,
    issuedAtMs: 1
  }), { code: 'P1_METAB_FOUNDER_DOSSIER' });
  assert.throws(() => createFounderDossier({
    identity: IDENTITY,
    parentFreeze: { ...PARENT_FREEZE, recordSha256: `sha256:${'0'.repeat(64)}` },
    entropy: ENTROPY_A,
    issuedAtMs: 1
  }), { code: 'P1_METAB_FOUNDER_PARENT_FREEZE' });
  const { privateKey } = keyPair();
  assert.throws(() => buildMetabNeutralBirthMaterials({
    identity: IDENTITY,
    parentFreeze: PARENT_FREEZE,
    entropy: ENTROPY_A,
    issuedAtMs: 1,
    validityMs: 59_999,
    inspected: inspectedFixture(),
    privateKey
  }), { code: 'P1_METAB_FOUNDER_TIME' });
  const drifted = structuredClone(inspectedFixture());
  drifted.manifestHash = `sha256:${'b'.repeat(64)}`;
  drifted.contract = METAB_NEUTRAL_RESIDENT_CONTRACT;
  assert.throws(() => buildMetabNeutralBirthMaterials({
    identity: IDENTITY,
    parentFreeze: PARENT_FREEZE,
    entropy: ENTROPY_A,
    issuedAtMs: 1,
    validityMs: 60_000,
    inspected: drifted,
    privateKey
  }), { code: 'P1_METAB_FOUNDER_CANDIDATE' });
});

test('R124-METAB-FOUNDER-04 real package inspection and offline CLI emit only scoped immutable artifacts', async t => {
  const inspected = await inspectMetabNeutralCandidate(ROOT);
  assert.equal(inspected.definition.moduleDigest, `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, 'cores/p1-r0/metab-neutral/index.js')))
    .digest('hex')}`);
  assert.equal(inspected.contract, METAB_NEUTRAL_RESIDENT_CONTRACT);

  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'stay-r124-founder-cli-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const identityFile = path.join(directory, 'identity.json');
  const freezeFile = path.join(directory, 'R123.json');
  const entropyFile = path.join(directory, 'entropy.hex');
  const privateKeyFile = path.join(directory, 'metab-birth-private.pem');
  const dossierFile = path.join(directory, 'dossier.json');
  const certificateFile = path.join(directory, 'certificate.json');
  const { privateKey } = keyPair();
  await fsp.writeFile(identityFile, `${stableStringify(IDENTITY)}\n`, { mode: 0o600 });
  await fsp.writeFile(freezeFile, `${stableStringify(PARENT_FREEZE)}\n`, { mode: 0o600 });
  await fsp.writeFile(entropyFile, `${ENTROPY_A.toString('hex')}\n`, { mode: 0o600 });
  await fsp.writeFile(privateKeyFile, privateKey.export({
    type: 'pkcs8', format: 'pem'
  }), { mode: 0o600 });
  const args = [
    path.join(ROOT, 'tools/sign-metab-neutral-birth.js'),
    '--release-root', ROOT,
    '--identity', identityFile,
    '--parent-freeze', freezeFile,
    '--entropy-file', entropyFile,
    '--private-key', privateKeyFile,
    '--issued-at-ms', String(Date.now()),
    '--validity-ms', '60000',
    '--dossier-output', dossierFile,
    '--certificate-output', certificateFile
  ];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.result, 'PASS');
  assert.equal(result.mode, 'NEUTRAL');
  assert.equal(result.authorityOwned, false);
  assert.equal(result.outputs, 0);
  assert.ok(fs.existsSync(dossierFile));
  assert.ok(fs.existsSync(certificateFile));
  assert.equal(fs.existsSync(path.join(directory, 'private-key-copy.pem')), false);
  const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists/);
});
