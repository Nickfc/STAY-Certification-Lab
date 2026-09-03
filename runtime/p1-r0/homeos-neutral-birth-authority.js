'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { stableStringify } = require('../kernel/canonical-json');
const { validateFounderRecord } = require('./records');
const { sha256 } = require('./resident-support');
const {
  createNeutralHomeosInitialState,
  normalizeNeutralFounder
} = require('./residents/homeos-neutral');

const HOMEOS_NEUTRAL_BIRTH_FORMAT =
  'stay-p1-r0-homeos-neutral-birth-authority-v1';
const HOMEOS_NEUTRAL_AUTHORIZATION_CLASS =
  'homeos-resident-neutral-zero-authority-r143';
const DEFAULT_CERTIFICATE_FILE =
  '/etc/stay/resident-promotions/resident-homeos-neutral-birth.json';
const DEFAULT_PUBLIC_KEY_FILE =
  '/etc/stay/p1-r0-expansion-birth-authority.pub';
const HASH = /^sha256:[0-9a-f]{64}$/;
const BODY_KEYS = Object.freeze([
  'allowedAction', 'authorizationClass', 'certificateId', 'expiresAtMs',
  'founderBinding', 'founderDossierSha256', 'founderRecord', 'issuedAtMs',
  'manifestHash', 'moduleHash', 'organismId', 'organismIdentityHash',
  'packagePolicyHash', 'parentFreezeRecordSha256', 'parentRevision',
  'residencyId', 'targetRevision', 'version'
].sort());

function fail(message, code = 'P1_HOMEOS_BIRTH_DENIED') {
  throw Object.assign(new Error(message), { code });
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('HOMEOS birth authority body is invalid', code);
  }
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('HOMEOS birth authority body is not canonical', code);
  }
}

function validateFounder(body, identity) {
  let founderRecord;
  let founderBinding;
  try {
    founderRecord = validateFounderRecord(body.founderRecord);
    const runtimeBinding = {
      identitySha256: sha256(identity),
      organismLineage: identity.lineage,
      runtimeRevision: body.targetRevision
    };
    founderBinding = normalizeNeutralFounder(body.founderBinding, runtimeBinding);
    createNeutralHomeosInitialState({ binding: runtimeBinding, founder: founderBinding });
  } catch (error) {
    fail(`HOMEOS founder dossier is invalid: ${error.message}`, 'P1_HOMEOS_BIRTH_FOUNDER');
  }
  if (
    founderRecord.organismId !== identity.organismId ||
    founderRecord.coreId !== 'HOMEOS' ||
    founderRecord.founderId !== founderBinding.founderId ||
    founderRecord.lineageId !== founderBinding.lineageId ||
    founderRecord.profileId !== founderBinding.profileId ||
    founderRecord.profileHash !== founderBinding.profileHash ||
    founderRecord.phenotypeHash !== sha256({ coreId: 'HOMEOS', profile: founderBinding.profile }) ||
    founderRecord.genesisFrame !== 0 ||
    founderBinding.organismId !== identity.organismId ||
    founderBinding.organismIdentityHash !== sha256(identity)
  ) fail('HOMEOS founder record and resident binding disagree', 'P1_HOMEOS_BIRTH_FOUNDER');
  return Object.freeze({ founderRecord, founderBinding });
}

function verifyHomeosNeutralBirthCertificate(record, publicKey, {
  inspected,
  identity,
  runtimeRevision,
  parentFreezeRecordSha256,
  nowMs = Date.now()
} = {}) {
  if (
    !record || record.format !== HOMEOS_NEUTRAL_BIRTH_FORMAT ||
    !record.body || typeof record.signature !== 'string'
  ) fail('HOMEOS birth certificate header is invalid');
  const body = record.body;
  exactKeys(body, BODY_KEYS, 'P1_HOMEOS_BIRTH_CERTIFICATE');
  if (
    body.allowedAction !== 'birth-homeos-neutral' ||
    body.authorizationClass !== HOMEOS_NEUTRAL_AUTHORIZATION_CLASS ||
    body.residencyId !== 'resident:homeos' ||
    body.parentRevision !== 141 || body.targetRevision !== 143 ||
    runtimeRevision !== body.targetRevision ||
    !HASH.test(String(parentFreezeRecordSha256 || '')) ||
    body.parentFreezeRecordSha256 !== parentFreezeRecordSha256 ||
    !HASH.test(String(body.founderDossierSha256 || ''))
  ) fail('HOMEOS birth revision or authority fence is invalid', 'P1_HOMEOS_BIRTH_REVISION');
  if (!identity || body.organismId !== identity.organismId || body.organismIdentityHash !== sha256(identity)) {
    fail('HOMEOS birth organism identity is invalid', 'P1_HOMEOS_BIRTH_ORGANISM');
  }
  const contract = inspected?.contract;
  const definition = inspected?.definition;
  const manifest = definition?.manifest;
  if (
    contract?.residencyId !== 'resident:homeos' || contract?.coreId !== 'HOMEOS' ||
    contract?.authorityMode !== 'neutral' || contract?.signalling !== 'FORBIDDEN' ||
    contract?.productionEligible !== false ||
    stableStringify(contract?.inputs) !== stableStringify([
      'runtime.organism.binding',
      'metab.energy.availability.v1',
      'metab.energy.reserve.v1'
    ]) ||
    stableStringify(contract?.outputs) !== stableStringify([]) ||
    manifest?.coreId !== 'HOMEOS' || manifest?.version !== body.version ||
    manifest?.version !== contract.version || body.moduleHash !== definition?.moduleDigest ||
    body.manifestHash !== inspected?.manifestHash ||
    body.packagePolicyHash !== definition?.packagePolicyHash ||
    body.packagePolicyHash !== contract.packagePolicyHash ||
    !HASH.test(String(body.moduleHash || '')) ||
    !HASH.test(String(body.manifestHash || '')) ||
    !HASH.test(String(body.packagePolicyHash || ''))
  ) fail('HOMEOS birth executable identity is invalid', 'P1_HOMEOS_BIRTH_CANDIDATE');
  const founder = validateFounder(body, identity);
  if (
    !Number.isSafeInteger(body.issuedAtMs) || !Number.isSafeInteger(body.expiresAtMs) ||
    body.issuedAtMs > nowMs + 300000 || body.expiresAtMs < nowMs ||
    body.expiresAtMs <= body.issuedAtMs ||
    typeof body.certificateId !== 'string' ||
    body.certificateId.length < 16 || body.certificateId.length > 200
  ) fail('HOMEOS birth certificate window is invalid', 'P1_HOMEOS_BIRTH_WINDOW');
  let signature;
  try { signature = Buffer.from(record.signature, 'base64'); } catch {
    fail('HOMEOS birth signature encoding is invalid', 'P1_HOMEOS_BIRTH_SIGNATURE');
  }
  if (!signature.length || !crypto.verify(null, Buffer.from(stableStringify(body)), publicKey, signature)) {
    fail('HOMEOS birth signature is invalid', 'P1_HOMEOS_BIRTH_SIGNATURE');
  }
  return Object.freeze({
    ok: true,
    certificateId: body.certificateId,
    authorizationClass: body.authorizationClass,
    founderDossierSha256: body.founderDossierSha256,
    founderRecord: founder.founderRecord,
    founderBinding: founder.founderBinding,
    targetRevision: body.targetRevision,
    parentFreezeRecordSha256: body.parentFreezeRecordSha256
  });
}

function loadAndVerifyHomeosNeutralBirth({
  inspected,
  identity,
  runtimeRevision,
  parentFreezeRecordSha256,
  publicKeyPath = process.env.STAY_HOMEOS_NEUTRAL_BIRTH_PUBLIC_KEY || DEFAULT_PUBLIC_KEY_FILE,
  certificateFile = process.env.STAY_HOMEOS_NEUTRAL_BIRTH_CERTIFICATE || DEFAULT_CERTIFICATE_FILE,
  nowMs = Date.now()
} = {}) {
  let publicKey;
  let record;
  try {
    const keyStat = fs.lstatSync(publicKeyPath);
    const certStat = fs.lstatSync(certificateFile);
    if (
      !keyStat.isFile() || keyStat.isSymbolicLink() ||
      !certStat.isFile() || certStat.isSymbolicLink() ||
      (keyStat.mode & 0o022) !== 0 || (certStat.mode & 0o022) !== 0
    ) fail('HOMEOS birth trust material is unsafe', 'P1_HOMEOS_BIRTH_AUTHORITY_MISSING');
    publicKey = fs.readFileSync(publicKeyPath, 'utf8');
    record = JSON.parse(fs.readFileSync(certificateFile, 'utf8'));
  } catch (error) {
    if (error?.code?.startsWith?.('P1_HOMEOS_')) throw error;
    fail(`HOMEOS birth authority is unavailable: ${error.message}`, 'P1_HOMEOS_BIRTH_AUTHORITY_MISSING');
  }
  return verifyHomeosNeutralBirthCertificate(record, publicKey, {
    inspected,
    identity,
    runtimeRevision,
    parentFreezeRecordSha256,
    nowMs
  });
}

module.exports = Object.freeze({
  DEFAULT_CERTIFICATE_FILE,
  DEFAULT_PUBLIC_KEY_FILE,
  HOMEOS_NEUTRAL_AUTHORIZATION_CLASS,
  HOMEOS_NEUTRAL_BIRTH_FORMAT,
  loadAndVerifyHomeosNeutralBirth,
  verifyHomeosNeutralBirthCertificate
});
