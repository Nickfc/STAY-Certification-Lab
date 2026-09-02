#!/usr/bin/env node
'use strict';

// Offline, scoped authority tool. The private key and entropy file must never
// be copied into a STAY release or onto the production host.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const {
  MAX_VALIDITY_MS,
  MIN_VALIDITY_MS,
  buildMetabNeutralBirthMaterials,
  inspectMetabNeutralCandidate
} = require('../runtime/p1-r0/metab-founder-dossier');
const { recordHash } = require('../runtime/p1-r0/records');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
function required(name) {
  const value = option(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
function safeFile(input, label, secret = false) {
  const file = path.resolve(input);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is unsafe`);
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o022) !== 0) throw new Error(`${label} is writable by group or world`);
    if (secret && (stat.mode & 0o077) !== 0) throw new Error(`${label} permissions are too broad`);
  }
  return file;
}
function readJson(input, label) {
  return JSON.parse(fs.readFileSync(safeFile(input, label), 'utf8'));
}
function assertOutputTarget(input, label) {
  const file = path.resolve(input);
  if (fs.existsSync(file)) throw new Error(`${label} already exists`);
  const parent = fs.lstatSync(path.dirname(file));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error(`${label} parent is unsafe`);
  return file;
}
function writePair({ dossierFile, certificateFile, dossier, certificate }) {
  const nonce = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const dossierTemporary = `${dossierFile}.new-${nonce}`;
  const certificateTemporary = `${certificateFile}.new-${nonce}`;
  try {
    fs.writeFileSync(dossierTemporary, `${stableStringify(dossier)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600
    });
    fs.writeFileSync(certificateTemporary, `${stableStringify(certificate)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600
    });
    fs.renameSync(dossierTemporary, dossierFile);
    try { fs.renameSync(certificateTemporary, certificateFile); }
    catch (error) {
      fs.rmSync(dossierFile, { force: true });
      throw error;
    }
  } finally {
    fs.rmSync(dossierTemporary, { force: true });
    fs.rmSync(certificateTemporary, { force: true });
  }
}

async function main() {
  const issuedAtMs = Number(required('--issued-at-ms'));
  const validityMs = Number(option('--validity-ms') || 6 * 60 * 60 * 1000);
  if (
    !Number.isSafeInteger(issuedAtMs) ||
    Math.abs(Date.now() - issuedAtMs) > 5 * 60 * 1000
  ) throw new Error('issued time must be explicit and within five minutes of now');
  if (
    !Number.isSafeInteger(validityMs) ||
    validityMs < MIN_VALIDITY_MS ||
    validityMs > MAX_VALIDITY_MS
  ) throw new Error('validity is outside the one-minute to 24-hour bound');

  const releaseRoot = path.resolve(required('--release-root'));
  const identity = readJson(required('--identity'), 'identity file');
  const parentFreeze = readJson(required('--parent-freeze'), 'parent freeze file');
  const entropyFile = safeFile(required('--entropy-file'), 'entropy file', true);
  const privateKeyFile = safeFile(required('--private-key'), 'private key', true);
  const dossierFile = assertOutputTarget(required('--dossier-output'), 'dossier output');
  const certificateFile = assertOutputTarget(
    required('--certificate-output'),
    'certificate output'
  );
  const inspected = await inspectMetabNeutralCandidate(releaseRoot);
  const materials = buildMetabNeutralBirthMaterials({
    identity,
    parentFreeze,
    entropy: fs.readFileSync(entropyFile, 'utf8').trim(),
    issuedAtMs,
    validityMs,
    inspected,
    privateKey: fs.readFileSync(privateKeyFile, 'utf8')
  });
  writePair({
    dossierFile,
    certificateFile,
    dossier: materials.dossier,
    certificate: materials.certificate
  });
  process.stdout.write(`${stableStringify({
    result: 'PASS',
    certificateFile,
    certificateSha256: recordHash(materials.certificate),
    dossierFile,
    dossierSha256: materials.founderDossierSha256,
    entropyCommitment: materials.dossier.entropyCommitment,
    founderId: materials.founderRecord.founderId,
    mode: 'NEUTRAL',
    authorityOwned: false,
    outputs: 0,
    targetRevision: 124
  })}\n`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`${error.code || 'P1_METAB_FOUNDER_SIGN'}: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ main, safeFile, writePair });
