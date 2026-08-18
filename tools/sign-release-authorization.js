#!/usr/bin/env node
'use strict';

// OFFLINE authority tool. Run this from a trusted control checkout, never from
// an untrusted release directory. The private key must never be copied to STAY.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const trusted = require('../deploy/trusted-release-verifier');

function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
function required(name) { const value = option(name); if (!value) throw new Error(`missing ${name}`); return value; }

async function main() {
  const privateKey = fs.readFileSync(required('--private-key'), 'utf8');
  const root = path.resolve(required('--root'));
  const archive = path.resolve(required('--archive'));
  const output = path.resolve(required('--output'));
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'RELEASE_INVENTORY.json'), 'utf8'));
  const provenance = JSON.parse(fs.readFileSync(path.join(root, 'RELEASE_PROVENANCE.json'), 'utf8'));
  const version = String(option('--version') || provenance.version || '');
  const commit = String(option('--commit') || provenance.commit || '');
  if (!/^[0-9a-f]{40}$/.test(commit) || !version) throw new Error('candidate version/commit is invalid');

  // Reproduce the candidate byte inventory with trusted verifier code before
  // applying authority. This intentionally imports no candidate JavaScript.
  const inventoryHash = await trusted.verifyInventory(root, inventory);
  const provenanceHash = trusted.verifyProvenance(provenance, inventoryHash, version, commit);
  const allowedActions = String(option('--actions') || 'activate').split(',').map(value => value.trim()).filter(Boolean).sort();
  if (allowedActions.includes('activate') && provenance.productionEligible !== true) {
    throw new Error('refusing activation authorization for non-production release');
  }
  const archiveSha256 = trusted.sha256(fs.readFileSync(archive));
  const issuedAtMs = Date.now();
  const validityMs = Math.max(60000, Math.min(7 * 86400000, Number(option('--validity-ms') || 24 * 3600000)));
  const body = {
    allowedActions,
    archiveSha256,
    authorizationClass: String(option('--class') || 'release-activation'),
    commit,
    inventoryHash,
    issuedAtMs,
    nonce: crypto.randomBytes(24).toString('hex'),
    provenanceHash,
    version,
    expiresAtMs: issuedAtMs + validityMs
  };
  const signature = crypto.sign(null, Buffer.from(trusted.stableStringify(body)), privateKey).toString('base64');
  fs.writeFileSync(output, JSON.stringify({ format: trusted.AUTH_FORMAT, body, signature }, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(`${output}\n`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
