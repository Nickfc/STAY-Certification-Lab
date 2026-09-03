'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stableStringify } = require('../kernel/canonical-json');
const { inspectCoreModule } = require('../kernel/core-loader');
const { validateRevisionFreeze } = require('../revision-freeze');
const q48 = require('./q16-48');
const {
  METAB_NEUTRAL_AUTHORIZATION_CLASS,
  METAB_NEUTRAL_BIRTH_FORMAT,
  verifyMetabNeutralBirthCertificate
} = require('./metab-neutral-birth-authority');
const { METAB_NEUTRAL_RESIDENT_CONTRACT } = require('./metab-neutral-contract');
const { recordHash, validateFounderRecord } = require('./records');
const { clone, sha256 } = require('./resident-support');
const {
  createNeutralMetabInitialState,
  manifest: neutralManifest,
  normalizeNeutralFounder
} = require('./residents/metab-neutral');
const templates = require(
  './c0-source-contracts/contracts/founder_profile_templates.json'
);

const FORMAT = 'stay-p1-r0-metab-founder-dossier-v1';
const VARIATION_ALGORITHM =
  'hmac-sha256-labelled-unbiased-basis-points-v1';
const SOURCE_PROFILE_HASH =
  'sha256:4340f251151b356c8d38f0ae34ee8b5fe91c92353eba84a0928772b9172aea9c';
const DOMAIN = Buffer.from('STAY/P1-R0/METAB/FOUNDER/R124/V1', 'utf8');
const MAX_VALIDITY_MS = 24 * 60 * 60 * 1000;
const MIN_VALIDITY_MS = 60 * 1000;
const HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTITY_FIELDS = Object.freeze(['createdAt', 'lineage', 'organismId']);
const VARIATION_BOUNDS = Object.freeze({
  etaFounderQ48: 300,
  reserveCapacityQ48: 500,
  reserveInitialFractionQ48: 500,
  reserveChargeEfficiencyQ48: 200,
  reserveDischargeEfficiencyQ48: 200
});

function fail(message, code = 'P1_METAB_FOUNDER_DOSSIER') {
  throw Object.assign(new Error(message), { code });
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} is invalid`);
  }
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    fail(`${label} fields are not exact`);
  }
}

function normalizeIdentity(input) {
  exactKeys(input, IDENTITY_FIELDS, 'organism identity');
  if (
    input.lineage !== 'STAY/Genesis' ||
    typeof input.organismId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,160}$/.test(input.organismId) ||
    typeof input.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(input.createdAt))
  ) {
    fail('organism identity is invalid', 'P1_METAB_FOUNDER_IDENTITY');
  }
  return Object.freeze(clone(input));
}

function normalizeEntropy(input) {
  const bytes = Buffer.isBuffer(input)
    ? Buffer.from(input)
    : Buffer.from(String(input || '').trim(), 'hex');
  if (
    bytes.length !== 32 ||
    (!Buffer.isBuffer(input) && !/^[0-9a-fA-F]{64}$/.test(String(input || '').trim()))
  ) {
    fail('founder entropy must be exactly 32 bytes', 'P1_METAB_FOUNDER_ENTROPY');
  }
  return bytes;
}

function drawBasisPoints(entropy, label, maximum) {
  const span = BigInt(maximum * 2 + 1);
  const space = 1n << 64n;
  const limit = (space / span) * span;
  for (let counter = 0; counter < 256; counter += 1) {
    const digest = crypto
      .createHmac('sha256', entropy)
      .update(DOMAIN)
      .update(Buffer.from([0]))
      .update(label, 'utf8')
      .update(Buffer.from([counter]))
      .digest();
    const value = digest.readBigUInt64BE(0);
    if (value < limit) return Number(value % span) - maximum;
  }
  fail('founder variation sampler exhausted', 'P1_METAB_FOUNDER_VARIATION');
}

function scaleByBasisPoints(rawValue, basisPoints) {
  const parsed = q48.parseRaw(rawValue);
  const numerator = parsed * BigInt(10_000 + basisPoints);
  return q48.checked(q48.roundHalfEven(numerator, 10_000n)).toString();
}

function deriveToken({ entropy, identity, parentFreezeRecordSha256 }) {
  return crypto
    .createHash('sha256')
    .update(DOMAIN)
    .update(entropy)
    .update(stableStringify({
      organismId: identity.organismId,
      organismIdentityHash: sha256(identity),
      parentFreezeRecordSha256
    }))
    .digest('hex')
    .slice(0, 24);
}

function createFounderDossier({
  identity: identityInput,
  parentFreeze,
  entropy: entropyInput,
  issuedAtMs
} = {}) {
  const identity = normalizeIdentity(identityInput);
  if (!validateRevisionFreeze(parentFreeze, 123)) {
    fail('R123F parent freeze is invalid', 'P1_METAB_FOUNDER_PARENT_FREEZE');
  }
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 1) {
    fail('founder issue time is invalid', 'P1_METAB_FOUNDER_TIME');
  }
  const entropy = normalizeEntropy(entropyInput);
  const sourceProfile = templates?.profiles?.METAB;
  if (
    templates?.laboratoryOnly !== true ||
    sha256(sourceProfile) !== SOURCE_PROFILE_HASH ||
    sourceProfile?.profileId !== 'metab.p1-r0.normalized-lab.v1'
  ) {
    fail('METAB founder source template identity changed', 'P1_METAB_FOUNDER_TEMPLATE');
  }

  const sampledVariationBps = Object.fromEntries(
    Object.entries(VARIATION_BOUNDS).map(([label, maximum]) => [
      label,
      drawBasisPoints(entropy, label, maximum)
    ])
  );
  // etaFounder is a unit interval in the executable contract. The C0 +/-3%
  // envelope is therefore intersected with the executable's <=1 ceiling.
  sampledVariationBps.etaFounderQ48 = Math.min(
    0,
    sampledVariationBps.etaFounderQ48
  );
  const variationBps = Object.freeze(sampledVariationBps);
  const token = deriveToken({
    entropy,
    identity,
    parentFreezeRecordSha256: parentFreeze.recordSha256
  });
  const profile = clone(sourceProfile);
  profile.profileId = `metab.p1-r0.founder.r124.${token}`;
  profile.etaFounderQ48 = scaleByBasisPoints(
    sourceProfile.etaFounderQ48,
    variationBps.etaFounderQ48
  );
  profile.reserve.capacityQ48 = scaleByBasisPoints(
    sourceProfile.reserve.capacityQ48,
    variationBps.reserveCapacityQ48
  );
  profile.reserve.initialFractionQ48 = scaleByBasisPoints(
    sourceProfile.reserve.initialFractionQ48,
    variationBps.reserveInitialFractionQ48
  );
  profile.reserve.chargeEfficiencyQ48 = scaleByBasisPoints(
    sourceProfile.reserve.chargeEfficiencyQ48,
    variationBps.reserveChargeEfficiencyQ48
  );
  profile.reserve.dischargeEfficiencyQ48 = scaleByBasisPoints(
    sourceProfile.reserve.dischargeEfficiencyQ48,
    variationBps.reserveDischargeEfficiencyQ48
  );
  if (
    q48.parseRaw(profile.etaFounderQ48) > q48.SCALE ||
    q48.parseRaw(profile.reserve.initialFractionQ48) > q48.SCALE ||
    q48.parseRaw(profile.reserve.chargeEfficiencyQ48) > q48.SCALE ||
    q48.parseRaw(profile.reserve.dischargeEfficiencyQ48) > q48.SCALE
  ) {
    fail('METAB founder variation exceeded a unit bound', 'P1_METAB_FOUNDER_VARIATION');
  }

  const organismIdentityHash = sha256(identity);
  const profileHash = sha256(profile);
  const founderBinding = Object.freeze({
    recordVersion: 'P1ResidentFounderBindingV1',
    coreId: 'METAB',
    organismId: identity.organismId,
    organismIdentityHash,
    founderId: `founder:metab:r124:${token}`,
    lineageId: `lineage:metab:r124:${token}`,
    residencyId: 'resident:metab',
    profileId: profile.profileId,
    profileHash,
    profile: Object.freeze(profile),
    mode: 'NEUTRAL',
    authorityEpoch: '0'
  });
  const founderRecord = validateFounderRecord({
    recordVersion: 'P1FounderRecordV1',
    organismId: identity.organismId,
    coreId: 'METAB',
    founderId: founderBinding.founderId,
    lineageId: founderBinding.lineageId,
    profileId: founderBinding.profileId,
    profileHash,
    founderSchemaId: 'urn:stay:p1-r0:schema:metab-founder-profile:v1',
    founderSchemaVersion: '1',
    genesisFrame: 0,
    genesisTransactionId: `tx:metab:r124:${token}`,
    phenotypeHash: sha256({ coreId: 'METAB', profile }),
    committed: true,
    previousFounderId: null
  });
  const runtimeBinding = {
    identitySha256: organismIdentityHash,
    organismLineage: identity.lineage,
    runtimeRevision: 124
  };
  normalizeNeutralFounder(founderBinding, runtimeBinding);
  createNeutralMetabInitialState({ binding: runtimeBinding, founder: founderBinding });

  const dossier = Object.freeze({
    format: FORMAT,
    status: 'PRODUCTION_FOUNDER_CANDIDATE',
    variationAlgorithm: VARIATION_ALGORITHM,
    sourceProfileId: sourceProfile.profileId,
    sourceProfileHash: SOURCE_PROFILE_HASH,
    entropyCommitment: `sha256:${crypto.createHash('sha256').update(entropy).digest('hex')}`,
    variationBps,
    organismId: identity.organismId,
    organismIdentityHash,
    coreId: 'METAB',
    residencyId: 'resident:metab',
    parentRevision: 123,
    targetRevision: 124,
    parentFreezeRecordSha256: parentFreeze.recordSha256,
    founderId: founderBinding.founderId,
    lineageId: founderBinding.lineageId,
    reviewedProfile: Object.freeze(clone(profile)),
    mode: 'NEUTRAL',
    authorityEpoch: '0',
    inputs: Object.freeze(['runtime.organism.binding']),
    outputs: Object.freeze([]),
    noAuthority: true,
    issuedAtMs
  });
  return Object.freeze({
    dossier,
    founderDossierSha256: recordHash(dossier),
    founderBinding,
    founderRecord
  });
}

function normalizeInspected(input) {
  const definition = input?.definition;
  if (
    input?.contract !== METAB_NEUTRAL_RESIDENT_CONTRACT ||
    input?.moduleRelativePath !== 'cores/p1-r0/metab-neutral/index.js' ||
    definition?.manifest?.coreId !== 'METAB' ||
    definition?.manifest?.version !== neutralManifest.version ||
    !HASH.test(String(definition?.moduleDigest || '')) ||
    !HASH.test(String(definition?.packagePolicyHash || '')) ||
    input?.manifestHash !== sha256(definition.manifest) ||
    definition.packagePolicyHash !== METAB_NEUTRAL_RESIDENT_CONTRACT.packagePolicyHash
  ) {
    fail('inspected METAB neutral package is invalid', 'P1_METAB_FOUNDER_CANDIDATE');
  }
  return input;
}

async function inspectMetabNeutralCandidate(releaseRoot) {
  const root = path.resolve(releaseRoot || '');
  let stat;
  try { stat = fs.lstatSync(root); } catch {}
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    fail('release root is invalid', 'P1_METAB_FOUNDER_RELEASE_ROOT');
  }
  const moduleRelativePath = 'cores/p1-r0/metab-neutral/index.js';
  const definition = await inspectCoreModule(path.join(root, moduleRelativePath));
  return normalizeInspected(Object.freeze({
    definition,
    contract: METAB_NEUTRAL_RESIDENT_CONTRACT,
    moduleRelativePath,
    manifestHash: sha256(definition.manifest)
  }));
}

function buildMetabNeutralBirthMaterials({
  identity,
  parentFreeze,
  entropy,
  issuedAtMs,
  validityMs,
  inspected: inspectedInput,
  privateKey
} = {}) {
  const inspected = normalizeInspected(inspectedInput);
  if (
    !Number.isSafeInteger(validityMs) ||
    validityMs < MIN_VALIDITY_MS ||
    validityMs > MAX_VALIDITY_MS
  ) {
    fail('METAB birth validity is outside its bound', 'P1_METAB_FOUNDER_TIME');
  }
  const normalizedIdentity = normalizeIdentity(identity);
  const materials = createFounderDossier({
    identity: normalizedIdentity,
    parentFreeze,
    entropy,
    issuedAtMs
  });
  let signingKey;
  try {
    signingKey = privateKey instanceof crypto.KeyObject
      ? privateKey
      : crypto.createPrivateKey(privateKey);
  }
  catch (error) {
    fail(`METAB birth private key is invalid: ${error.message}`, 'P1_METAB_FOUNDER_KEY');
  }
  if (signingKey.asymmetricKeyType !== 'ed25519') {
    fail('METAB birth key must be Ed25519', 'P1_METAB_FOUNDER_KEY');
  }
  const certificateToken = crypto.createHash('sha256')
    .update(materials.founderDossierSha256)
    .update(String(issuedAtMs))
    .digest('hex')
    .slice(0, 32);
  const body = Object.freeze({
    allowedAction: 'birth-metab-neutral',
    authorizationClass: METAB_NEUTRAL_AUTHORIZATION_CLASS,
    certificateId: `r124-metab-neutral:${certificateToken}`,
    expiresAtMs: issuedAtMs + validityMs,
    founderBinding: materials.founderBinding,
    founderDossierSha256: materials.founderDossierSha256,
    founderRecord: materials.founderRecord,
    issuedAtMs,
    manifestHash: inspected.manifestHash,
    moduleHash: inspected.definition.moduleDigest,
    organismId: normalizedIdentity.organismId,
    organismIdentityHash: sha256(normalizedIdentity),
    packagePolicyHash: inspected.definition.packagePolicyHash,
    parentFreezeRecordSha256: parentFreeze.recordSha256,
    parentRevision: 123,
    residencyId: 'resident:metab',
    targetRevision: 124,
    version: neutralManifest.version
  });
  const certificate = Object.freeze({
    format: METAB_NEUTRAL_BIRTH_FORMAT,
    body,
    signature: crypto.sign(
      null,
      Buffer.from(stableStringify(body)),
      signingKey
    ).toString('base64')
  });
  const publicKey = crypto.createPublicKey(signingKey);
  verifyMetabNeutralBirthCertificate(certificate, publicKey, {
    inspected,
    identity: normalizedIdentity,
    runtimeRevision: 124,
    parentFreezeRecordSha256: parentFreeze.recordSha256,
    nowMs: issuedAtMs
  });
  return Object.freeze({ ...materials, certificate, publicKey });
}

module.exports = Object.freeze({
  FORMAT,
  MAX_VALIDITY_MS,
  MIN_VALIDITY_MS,
  SOURCE_PROFILE_HASH,
  VARIATION_ALGORITHM,
  VARIATION_BOUNDS,
  buildMetabNeutralBirthMaterials,
  createFounderDossier,
  drawBasisPoints,
  inspectMetabNeutralCandidate,
  normalizeEntropy,
  scaleByBasisPoints
});
