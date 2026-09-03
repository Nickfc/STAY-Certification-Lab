#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { inspectCoreModule } = require('../../runtime/kernel/core-loader');
const { stableStringify } = require('../../runtime/kernel/canonical-json');
const { validateRevisionFreeze } = require('../../runtime/revision-freeze');

const CONFIG = Object.freeze({
  HOMEOS: Object.freeze({
    parentRevision: 141, targetRevision: 143,
    moduleRelativePath: 'cores/p1-r0/homeos-neutral/index.js',
    contractRelativePath: 'runtime/p1-r0/homeos-neutral-contract.js',
    contractExport: 'HOMEOS_NEUTRAL_RESIDENT_CONTRACT',
    authorityRelativePath: 'runtime/p1-r0/homeos-neutral-birth-authority.js',
    verifyExport: 'verifyHomeosNeutralBirthCertificate'
  }),
  INTERO: Object.freeze({
    parentRevision: 145, targetRevision: 147,
    moduleRelativePath: 'cores/p1-r0/intero-neutral/index.js',
    contractRelativePath: 'runtime/p1-r0/intero-neutral-contract.js',
    contractExport: 'INTERO_NEUTRAL_RESIDENT_CONTRACT',
    authorityRelativePath: 'runtime/p1-r0/intero-neutral-birth-authority.js',
    verifyExport: 'verifyInteroNeutralBirthCertificate'
  })
});

function fail(message, code = 'P1_EXPANSION_BIRTH_PREFLIGHT') {
  throw Object.assign(new Error(message), { code });
}
function safeFile(input, label) {
  const file = path.resolve(input);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() ||
    (process.platform !== 'win32' && (stat.mode & 0o022) !== 0)) {
    fail(`${label} is unsafe`);
  }
  return file;
}
function metadata(database, key) {
  const row = database.prepare('SELECT json, sha256 FROM metadata WHERE key=?').get(key);
  if (!row || crypto.createHash('sha256').update(row.json).digest('hex') !== row.sha256) {
    fail(`${key} metadata is absent or corrupt`);
  }
  return JSON.parse(row.json);
}

async function verify({ coreId, releaseRoot, databaseFile, freezeFile, certificateFile,
  publicKeyFile, nowMs = Date.now() }) {
  const config = CONFIG[coreId];
  if (!config) fail('core must be HOMEOS or INTERO');
  const root = path.resolve(releaseRoot);
  const databasePath = safeFile(databaseFile, 'database');
  const parentFreeze = JSON.parse(fs.readFileSync(safeFile(freezeFile, 'parent freeze'), 'utf8'));
  const certificate = JSON.parse(fs.readFileSync(safeFile(certificateFile, 'certificate'), 'utf8'));
  const publicKey = fs.readFileSync(safeFile(publicKeyFile, 'public key'), 'utf8');
  if (!validateRevisionFreeze(parentFreeze, config.parentRevision)) {
    fail(`R${config.parentRevision}F parent freeze is invalid`);
  }
  const database = new DatabaseSync(databasePath, { open: true, readOnly: true });
  let identity;
  let runtimeRevision;
  try {
    database.exec('PRAGMA query_only=ON; BEGIN');
    if (String(database.prepare('PRAGMA quick_check').get()?.quick_check || '').toLowerCase() !== 'ok') {
      fail('database quick-check failed');
    }
    identity = metadata(database, 'life:identity');
    runtimeRevision = Number(metadata(database, 'life:runtime-revision').revision);
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { database.close(); }
  if (runtimeRevision !== config.parentRevision && runtimeRevision !== config.targetRevision - 1) {
    fail('durable revision is outside the exact birth boundary');
  }
  const definition = await inspectCoreModule(path.join(root, config.moduleRelativePath));
  const contract = require(path.join(root, config.contractRelativePath))[config.contractExport];
  const manifestHash = `sha256:${crypto.createHash('sha256')
    .update(stableStringify(definition.manifest)).digest('hex')}`;
  const inspected = { definition, contract, manifestHash };
  const verifyCertificate = require(path.join(root, config.authorityRelativePath))[config.verifyExport];
  const authorization = verifyCertificate(certificate, publicKey, {
    inspected, identity, runtimeRevision: config.targetRevision,
    parentFreezeRecordSha256: parentFreeze.recordSha256, nowMs
  });
  return Object.freeze({
    result: 'PASS', coreId, runtimeRevision, parentRevision: config.parentRevision,
    targetRevision: config.targetRevision, certificateId: authorization.certificateId,
    founderDossierSha256: authorization.founderDossierSha256,
    certificateSha256: `sha256:${crypto.createHash('sha256')
      .update(fs.readFileSync(certificateFile)).digest('hex')}`,
    parentFreezeRecordSha256: parentFreeze.recordSha256,
    organismIdentityHash: certificate.body.organismIdentityHash,
    moduleHash: definition.moduleDigest, manifestHash,
    packagePolicyHash: definition.packagePolicyHash,
    mode: 'NEUTRAL', authorityOwned: false, productionOutputs: 0
  });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 6) {
    fail('usage: p1-r150-verify-birth-certificate.js <HOMEOS|INTERO> <release-root> <database> <parent-freeze> <certificate> <public-key>');
  }
  process.stdout.write(`${stableStringify(await verify({
    coreId: argv[0].toUpperCase(), releaseRoot: argv[1], databaseFile: argv[2],
    freezeFile: argv[3], certificateFile: argv[4], publicKeyFile: argv[5]
  }))}\n`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`${error.code || 'P1_EXPANSION_BIRTH_PREFLIGHT'}: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ CONFIG, verify });
