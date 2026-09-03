#!/usr/bin/env node
'use strict';

// Offline scoped authority tool. Never copy the private key or entropy input
// into a release, an Actions artifact, or the production host.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const { validateRevisionFreeze } = require('../runtime/revision-freeze');
const { recordHash, validateFounderRecord } = require('../runtime/p1-r0/records');
const { sha256 } = require('../runtime/p1-r0/resident-support');
const profiles = require(
  '../runtime/p1-r0/c0-source-contracts/contracts/founder_profile_templates.json'
).profiles;

const CONFIG = Object.freeze({
  HOMEOS: Object.freeze({
    parentRevision: 141,
    targetRevision: 143,
    allowedAction: 'birth-homeos-neutral',
    authorizationClass: 'homeos-resident-neutral-zero-authority-r143',
    format: 'stay-p1-r0-homeos-neutral-birth-authority-v1',
    residencyId: 'resident:homeos',
    version: '0.1.0-p1r0-neutral.1',
    moduleRelativePath: 'cores/p1-r0/homeos-neutral/index.js',
    contractRelativePath: 'runtime/p1-r0/homeos-neutral-contract.js',
    contractExport: 'HOMEOS_NEUTRAL_RESIDENT_CONTRACT',
    founderSchemaId: 'urn:stay:p1-r0:schema:homeos-founder-profile:v1'
  }),
  INTERO: Object.freeze({
    parentRevision: 145,
    targetRevision: 147,
    allowedAction: 'birth-intero-neutral',
    authorizationClass: 'intero-resident-neutral-zero-authority-r147',
    format: 'stay-p1-r0-intero-neutral-birth-authority-v1',
    residencyId: 'resident:intero',
    version: '0.1.0-p1r0-neutral.1',
    moduleRelativePath: 'cores/p1-r0/intero-neutral/index.js',
    contractRelativePath: 'runtime/p1-r0/intero-neutral-contract.js',
    contractExport: 'INTERO_NEUTRAL_RESIDENT_CONTRACT',
    founderSchemaId: 'urn:stay:p1-r0:schema:intero-founder-profile:v1'
  })
});

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
function required(name) {
  const value = option(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
function safeFile(input, label, { secret = false } = {}) {
  const file = path.resolve(input);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is unsafe`);
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o022) !== 0) throw new Error(`${label} is writable by group or world`);
    if (secret && (stat.mode & 0o077) !== 0) throw new Error(`${label} permissions are too broad`);
  }
  return file;
}
function safeOutput(input, label) {
  const file = path.resolve(input);
  if (fs.existsSync(file)) throw new Error(`${label} already exists`);
  const parent = fs.lstatSync(path.dirname(file));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error(`${label} parent is unsafe`);
  return file;
}
function readJson(file, label) {
  return JSON.parse(fs.readFileSync(safeFile(file, label), 'utf8'));
}
function canonicalManifestHash(manifest) { return sha256(manifest); }
function tokenFor(coreId, entropy) {
  return crypto.createHash('sha256').update(`${coreId}:${entropy}`).digest('hex');
}
function writeExclusive(file, value) {
  fs.writeFileSync(file, `${stableStringify(value)}\n`, {
    encoding: 'utf8', flag: 'wx', mode: 0o600
  });
}

function buildMaterials({ coreId, releaseRoot, identity, parentFreeze, entropy,
  privateKey, issuedAtMs, validityMs }) {
  const config = CONFIG[coreId];
  if (!config) throw new Error('core must be HOMEOS or INTERO');
  if (!validateRevisionFreeze(parentFreeze, config.parentRevision)) {
    throw new Error(`R${config.parentRevision}F parent freeze is invalid`);
  }
  if (!identity || identity.lineage !== 'STAY/Genesis' || typeof identity.organismId !== 'string') {
    throw new Error('organism identity is invalid');
  }
  if (!/^[0-9a-f]{64,256}$/.test(entropy)) throw new Error('entropy must be 32-128 bytes of lowercase hex');
  if (!Number.isSafeInteger(issuedAtMs) || Math.abs(Date.now() - issuedAtMs) > 300000) {
    throw new Error('issued time must be explicit and within five minutes of now');
  }
  if (!Number.isSafeInteger(validityMs) || validityMs < 60000 || validityMs > 86400000) {
    throw new Error('validity must be one minute through 24 hours');
  }
  const definition = require(path.join(releaseRoot, config.moduleRelativePath));
  const contract = require(path.join(releaseRoot, config.contractRelativePath))[config.contractExport];
  const packagePolicy = JSON.parse(fs.readFileSync(
    path.join(path.dirname(path.join(releaseRoot, config.moduleRelativePath)), 'package-policy.json'),
    'utf8'
  ));
  if (
    definition.manifest.coreId !== coreId || definition.manifest.version !== config.version ||
    contract.coreId !== coreId || contract.version !== config.version ||
    contract.authorityMode !== 'neutral' || contract.signalling !== 'FORBIDDEN' ||
    contract.productionEligible !== false || contract.outputs.length !== 0 ||
    packagePolicy.policyHash !== contract.packagePolicyHash
  ) throw new Error('candidate contract is not the exact neutral zero-authority generation');
  const token = tokenFor(coreId, entropy);
  const profile = JSON.parse(stableStringify(profiles[coreId]));
  profile.profileId = `${coreId.toLowerCase()}.p1-r0.production-founder.v1`;
  if (coreId === 'INTERO') {
    profile.noiseKeyHex = token.slice(0, 16);
    if (profile.noiseKeyHex === '0123456789abcdef') throw new Error('INTERO production noise equals the laboratory vector');
  }
  const organismIdentityHash = sha256(identity);
  const founderBinding = {
    recordVersion: 'P1ResidentFounderBindingV1', coreId,
    organismId: identity.organismId, organismIdentityHash,
    founderId: `founder:${coreId.toLowerCase()}:${token.slice(0, 24)}`,
    lineageId: `lineage:${coreId.toLowerCase()}:${token.slice(24, 48)}`,
    residencyId: config.residencyId, profileId: profile.profileId,
    profileHash: sha256(profile), profile, mode: 'NEUTRAL', authorityEpoch: '0'
  };
  const founderRecord = validateFounderRecord({
    recordVersion: 'P1FounderRecordV1', organismId: identity.organismId, coreId,
    founderId: founderBinding.founderId, lineageId: founderBinding.lineageId,
    profileId: founderBinding.profileId, profileHash: founderBinding.profileHash,
    founderSchemaId: config.founderSchemaId, founderSchemaVersion: '1', genesisFrame: 0,
    genesisTransactionId: `tx:${coreId.toLowerCase()}:r${config.targetRevision}:${token.slice(48, 64)}`,
    phenotypeHash: sha256({ coreId, profile }), committed: true, previousFounderId: null
  });
  const dossier = Object.freeze({
    format: 'stay-p1-r0-expansion-founder-dossier-v1', coreId,
    residencyId: config.residencyId, organismId: identity.organismId,
    organismIdentityHash, parentRevision: config.parentRevision,
    parentFreezeRecordSha256: parentFreeze.recordSha256,
    targetRevision: config.targetRevision, founderRecord, founderBinding,
    entropyCommitment: `sha256:${crypto.createHash('sha256').update(entropy).digest('hex')}`,
    noAuthority: true, productionOutputs: 0
  });
  const indexFile = path.join(releaseRoot, config.moduleRelativePath);
  const body = {
    allowedAction: config.allowedAction,
    authorizationClass: config.authorizationClass,
    certificateId: `p1-r${config.targetRevision}-${coreId.toLowerCase()}-${token.slice(0, 24)}`,
    expiresAtMs: issuedAtMs + validityMs,
    founderBinding,
    founderDossierSha256: recordHash(dossier),
    founderRecord,
    issuedAtMs,
    manifestHash: canonicalManifestHash(definition.manifest),
    moduleHash: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(indexFile)).digest('hex')}`,
    organismId: identity.organismId,
    organismIdentityHash,
    packagePolicyHash: packagePolicy.policyHash,
    parentFreezeRecordSha256: parentFreeze.recordSha256,
    parentRevision: config.parentRevision,
    residencyId: config.residencyId,
    targetRevision: config.targetRevision,
    version: config.version
  };
  const certificate = Object.freeze({
    format: config.format,
    body,
    signature: crypto.sign(null, Buffer.from(stableStringify(body)), privateKey).toString('base64')
  });
  return Object.freeze({ config, dossier, certificate });
}

function main() {
  const coreId = required('--core').toUpperCase();
  const releaseRoot = path.resolve(required('--release-root'));
  const identity = readJson(required('--identity'), 'identity file');
  const parentFreeze = readJson(required('--parent-freeze'), 'parent freeze file');
  const entropy = fs.readFileSync(safeFile(required('--entropy-file'), 'entropy file', { secret: true }), 'utf8').trim();
  const privateKey = fs.readFileSync(safeFile(required('--private-key'), 'private key', { secret: true }), 'utf8');
  const issuedAtMs = Number(required('--issued-at-ms'));
  const validityMs = Number(option('--validity-ms') || 86400000);
  const dossierOutput = safeOutput(required('--dossier-output'), 'dossier output');
  const certificateOutput = safeOutput(required('--certificate-output'), 'certificate output');
  const materials = buildMaterials({
    coreId, releaseRoot, identity, parentFreeze, entropy, privateKey, issuedAtMs, validityMs
  });
  try {
    writeExclusive(dossierOutput, materials.dossier);
    writeExclusive(certificateOutput, materials.certificate);
  } catch (error) {
    fs.rmSync(dossierOutput, { force: true });
    fs.rmSync(certificateOutput, { force: true });
    throw error;
  }
  process.stdout.write(`${stableStringify({
    result: 'PASS', coreId, dossierOutput, dossierSha256: recordHash(materials.dossier),
    certificateOutput, certificateSha256: recordHash(materials.certificate),
    certificateId: materials.certificate.body.certificateId,
    parentRevision: materials.config.parentRevision,
    targetRevision: materials.config.targetRevision,
    mode: 'NEUTRAL', authorityOwned: false, productionOutputs: 0
  })}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`${error.code || 'P1_EXPANSION_BIRTH_SIGN'}: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ CONFIG, buildMaterials, main });
