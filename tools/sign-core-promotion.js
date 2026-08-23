#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { stableStringify } = require('../runtime/kernel/canonical-json');

function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
function required(name) { const value = option(name); if (!value) throw new Error(`missing ${name}`); return value; }
function list(name) { return String(option(name) || '').split(',').map(value => value.trim()).filter(Boolean); }
function main() {
  const key = fs.readFileSync(required('--private-key'), 'utf8');
  const issuedAtMs = Date.now();
  const body = {
    allowedActions: list('--actions').sort(),
    allowedInputs: list('--inputs'),
    allowedOutputs: list('--outputs'),
    authorizationClass: required('--class'),
    certificateId: crypto.randomBytes(24).toString('hex'),
    coreId: required('--core-id'),
    expiresAtMs: issuedAtMs + Math.max(60000, Number(option('--validity-ms') || 24 * 3600000)),
    issuedAtMs,
    manifestHash: required('--manifest-hash'),
    moduleHash: required('--module-hash'),
    organismId: required('--organism-id'),
    organismIdentityHash: required('--organism-identity-hash'),
    packagePolicyHash: required('--package-policy-hash'),
    r11CertificationHash: option('--r11-certification-hash') || null,
    version: required('--version')
  };
  const signature = crypto.sign(null, Buffer.from(stableStringify(body)), key).toString('base64');
  const output = required('--output');
  fs.writeFileSync(output, JSON.stringify({ format: 'stay-core-promotion-v1', body, signature }, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(`${output}\n`);
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
