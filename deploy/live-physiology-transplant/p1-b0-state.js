#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { capture, compare } = require('./p1-surgery-a1-state');

const MODULE = 'cores/sntss/i3d/index.js';
const EXPECTED = Object.freeze({
  residencyId: 'resident:sntss',
  coreId: 'sntss',
  version: '0.4.0-i3d3',
  role: 'resident-physiology',
  moduleHash: 'sha256:36f51012ccbb5822d5e0d3da41f8ec6bae9f3d9b9073e08a561128f5a908b284',
  manifestHash: 'sha256:6612fc65862ae310a5c888e9c95c5037daaaaf3ab45c58709c57f6a9699a9797',
  packagePolicyHash: 'sha256:5708b07f711f4d681c67c518e34450d57559b6fe51316060d1c83bd2c8a46765',
  allowedInputs: ['runtime.organism.binding', 'runtime.time.pulse'],
  allowedOutputs: [],
  allowedActions: ['attach-resident'],
  authorizationClass: 'sntss-resident-zero-authority'
});

function identity(databasePath) {
  const db = new DatabaseSync(databasePath, { open: true, readOnly: true });
  db.exec('PRAGMA query_only=ON');
  try {
    const row = db.prepare("SELECT json, sha256 FROM metadata WHERE key='life:identity'").get();
    if (!row) throw Object.assign(new Error('organism identity missing'), { code: 'P1_B0_IDENTITY' });
    return { value: JSON.parse(row.json), metadataHash: `sha256:${row.sha256}` };
  } finally { db.close(); }
}

async function request(releaseRoot, databasePath) {
  const organism = identity(databasePath);
  const { inspectCoreModule } = require(path.join(releaseRoot, 'runtime/kernel/core-loader.js'));
  const { canonicalHash, L0_SNTSS_CONTRACT } = require(path.join(releaseRoot, 'runtime/kernel/resident-manager.js'));
  const { identityHash } = require(path.join(releaseRoot, 'runtime/kernel/resident-promotion-authority.js'));
  const definition = await inspectCoreModule(path.join(releaseRoot, MODULE));
  const actual = {
    residencyId: L0_SNTSS_CONTRACT.residencyId,
    coreId: definition.manifest.coreId,
    version: definition.manifest.version,
    role: L0_SNTSS_CONTRACT.role,
    moduleHash: definition.moduleDigest,
    manifestHash: canonicalHash(definition.manifest),
    packagePolicyHash: definition.packagePolicyHash,
    allowedInputs: [...definition.manifest.inputs],
    allowedOutputs: [...definition.manifest.outputs],
    allowedActions: ['attach-resident'],
    authorizationClass: 'sntss-resident-zero-authority'
  };
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED)) {
    throw Object.assign(new Error('frozen resident contract mismatch'), { code: 'P1_B0_CONTRACT' });
  }
  return {
    format: 'stay-p1-b0-certificate-request-v1',
    bodyTemplate: {
      ...actual,
      organismId: organism.value.organismId,
      organismIdentityHash: identityHash(organism.value)
    },
    offlineSignerMustAdd: ['certificateId', 'issuedAtMs', 'expiresAtMs'],
    privateKeyDestination: 'OFFLINE_ONLY'
  };
}

async function main(argv = process.argv.slice(2)) {
  const [mode, ...args] = argv;
  if (mode === 'capture' && args[0]) return void process.stdout.write(JSON.stringify(capture(args[0])) + '\n');
  if (mode === 'compare' && args[0] && args[1]) return void process.stdout.write(JSON.stringify(compare(JSON.parse(fs.readFileSync(args[0])), JSON.parse(fs.readFileSync(args[1])))) + '\n');
  if (mode === 'request' && args[0] && args[1]) return void process.stdout.write(JSON.stringify(await request(args[0], args[1])) + '\n');
  throw new Error('fixed P1 B.0 state operation required');
}

if (require.main === module) main().catch(error => { console.error(`P1_B0_STATE_ABORT=${error.code || 'FAILED'}`); process.exitCode = 1; });
module.exports = { request, EXPECTED };
