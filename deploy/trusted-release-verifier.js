#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const AUTH_FORMAT = 'stay-release-authorization-v1';
const INVENTORY_FORMAT = 'stay-release-inventory-v1';
const PROVENANCE_FORMAT = 'stay-release-provenance-v2';
const GENERATED = new Set(['RELEASE_INVENTORY.json', 'RELEASE_PROVENANCE.json']);

function fail(message, code = 'STAY_TRUSTED_RELEASE_REJECTED') { throw Object.assign(new Error(message), { code }); }
function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('canonical JSON contains non-finite number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || seen.has(value)) fail('canonical JSON contains unsupported/cyclic value');
  seen.add(value);
  const result = Array.isArray(value) ? value.map(entry => canonicalize(entry, seen)) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key], seen)]));
  seen.delete(value);
  return result;
}
function stableStringify(value) { return JSON.stringify(canonicalize(value)); }
function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}
async function sha256File(file) { return sha256(await fsp.readFile(file)); }
function safeRelative(relative) {
  if (typeof relative !== 'string' || !relative || relative.startsWith('/') || relative.includes('\\')) fail(`unsafe inventory path: ${relative}`);
  const normalized = path.posix.normalize(relative);
  if (normalized !== relative || normalized === '..' || normalized.startsWith('../')) fail(`unsafe inventory path: ${relative}`);
  return normalized;
}
async function walk(root, dir = root) {
  const output = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isSymbolicLink()) fail(`release contains forbidden symbolic link: ${relative}`, 'STAY_RELEASE_SYMLINK');
    if (entry.isDirectory()) output.push(...await walk(root, absolute));
    else if (entry.isFile()) output.push({ absolute, relative });
    else fail(`release contains unsupported filesystem object: ${relative}`);
  }
  return output;
}

async function verifyInventory(root, inventory) {
  if (!inventory || inventory.format !== INVENTORY_FORMAT || !Array.isArray(inventory.entries) || !HASH.test(inventory.inventoryHash || '')) fail('release inventory header is invalid');
  const body = { format: inventory.format, entries: inventory.entries };
  if (sha256(stableStringify(body)) !== inventory.inventoryHash) fail('release inventory hash mismatch');
  const declared = new Map();
  let previous = null;
  for (const entry of inventory.entries) {
    const relative = safeRelative(entry.path);
    if (relative === previous) fail(`duplicate inventory path: ${relative}`);
    if (previous != null && previous.localeCompare(relative) > 0) fail('release inventory is not sorted');
    previous = relative;
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !HASH.test(entry.sha256 || '') || typeof entry.role !== 'string') fail(`invalid inventory entry: ${relative}`);
    declared.set(relative, entry);
  }
  const actual = await walk(root);
  const actualPaths = actual.map(file => file.relative).filter(relative => !GENERATED.has(relative)).sort((a, b) => a.localeCompare(b));
  const declaredPaths = [...declared.keys()];
  if (stableStringify(actualPaths) !== stableStringify(declaredPaths)) fail('release filesystem does not exactly match signed inventory');
  for (const file of actual) {
    if (GENERATED.has(file.relative)) continue;
    const entry = declared.get(file.relative);
    const stat = await fsp.stat(file.absolute);
    if (stat.size !== entry.bytes) fail(`release file size mismatch: ${file.relative}`);
    if (await sha256File(file.absolute) !== entry.sha256) fail(`release file hash mismatch: ${file.relative}`);
  }
  return inventory.inventoryHash;
}

function verifyProvenance(provenance, inventoryHash, expectedVersion, expectedCommit) {
  if (!provenance || provenance.format !== PROVENANCE_FORMAT || !HASH.test(provenance.provenanceHash || '')) fail('release provenance header is invalid');
  if (provenance.version !== expectedVersion || provenance.commit !== expectedCommit || !COMMIT.test(provenance.commit)) fail('release provenance version/commit mismatch');
  if (provenance.inventoryHash !== inventoryHash) fail('release provenance inventory mismatch');
  if (provenance.stateRollbackPolicy !== 'preserve-forward-state' || provenance.releaseMutable !== false) fail('release violates immutable/no-rewind contract');
  if (typeof provenance.productionEligible !== 'boolean') fail('release provenance productionEligible must be boolean');
  const body = { ...provenance };
  const dependencies = body.dependencies || {};
  delete body.dependencies;
  delete body.provenanceHash;
  if (sha256(stableStringify(body)) !== provenance.provenanceHash) fail('release provenance hash mismatch');
  if (!HASH.test(provenance.dependencyInventoryHash || '') || sha256(stableStringify(dependencies)) !== provenance.dependencyInventoryHash) fail('release dependency inventory mismatch');
  return provenance.provenanceHash;
}

function exactAuthorizationBody(body) {
  const allowed = ['allowedActions', 'archiveSha256', 'authorizationClass', 'commit', 'inventoryHash', 'issuedAtMs', 'nonce', 'provenanceHash', 'version', 'expiresAtMs'];
  const actual = Object.keys(body || {}).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail('release authorization body is not canonical');
}
function verifyAuthorization(record, publicKey, expectations, nowMs = Date.now()) {
  if (!record || record.format !== AUTH_FORMAT || typeof record.signature !== 'string' || !record.body) fail('release authorization header is invalid');
  exactAuthorizationBody(record.body);
  const body = record.body;
  if (!Array.isArray(body.allowedActions) || !body.allowedActions.includes(expectations.action)) fail(`release authorization does not permit ${expectations.action}`);
  for (const key of ['archiveSha256', 'inventoryHash', 'provenanceHash']) if (!HASH.test(body[key] || '')) fail(`release authorization ${key} is invalid`);
  if (!COMMIT.test(body.commit || '') || typeof body.version !== 'string' || !body.version) fail('release authorization version/commit is invalid');
  if (!Number.isSafeInteger(body.issuedAtMs) || !Number.isSafeInteger(body.expiresAtMs) || body.issuedAtMs > nowMs + 300000 || body.expiresAtMs < nowMs || body.expiresAtMs <= body.issuedAtMs) fail('release authorization is outside its validity window');
  if (typeof body.nonce !== 'string' || body.nonce.length < 16 || body.nonce.length > 200 || typeof body.authorizationClass !== 'string' || !body.authorizationClass) fail('release authorization identity is invalid');
  for (const [key, expected] of Object.entries(expectations)) {
    if (key === 'action') continue;
    if (expected != null && body[key] !== expected) fail(`release authorization ${key} mismatch`);
  }
  let signature;
  try { signature = Buffer.from(record.signature, 'base64'); } catch { fail('release authorization signature encoding is invalid'); }
  const valid = crypto.verify(null, Buffer.from(stableStringify(body)), publicKey, signature);
  if (!valid) fail('release authorization signature is invalid', 'STAY_RELEASE_SIGNATURE_INVALID');
  return body;
}

function option(argv, name) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : null; }
async function verifyCli(argv) {
  const root = path.resolve(option(argv, '--root') || '');
  const archive = path.resolve(option(argv, '--archive') || '');
  const authorizationPath = path.resolve(option(argv, '--authorization') || '');
  const publicKeyPath = path.resolve(option(argv, '--public-key') || '');
  const expectedVersion = String(option(argv, '--expected-version') || '');
  const expectedCommit = String(option(argv, '--expected-commit') || '');
  const action = String(option(argv, '--action') || 'activate');
  if (!root || !archive || !authorizationPath || !publicKeyPath || !expectedVersion || !COMMIT.test(expectedCommit)) fail('trusted verifier arguments are incomplete');
  const [inventory, provenance, authorization, publicKey, archiveSha256] = await Promise.all([
    fsp.readFile(path.join(root, 'RELEASE_INVENTORY.json'), 'utf8').then(JSON.parse),
    fsp.readFile(path.join(root, 'RELEASE_PROVENANCE.json'), 'utf8').then(JSON.parse),
    fsp.readFile(authorizationPath, 'utf8').then(JSON.parse),
    fsp.readFile(publicKeyPath, 'utf8'),
    sha256File(archive)
  ]);
  const inventoryHash = await verifyInventory(root, inventory);
  const provenanceHash = verifyProvenance(provenance, inventoryHash, expectedVersion, expectedCommit);
  if (action === 'activate' && provenance.productionEligible !== true) {
    fail(
      'release is not production eligible for activation',
      'STAY_RELEASE_NOT_PRODUCTION_ELIGIBLE'
    );
  }
  const body = verifyAuthorization(authorization, publicKey, {
    action, archiveSha256, inventoryHash, provenanceHash, version: expectedVersion, commit: expectedCommit
  });
  return { status: 'PASS', archiveSha256, inventoryHash, provenanceHash, authorizationClass: body.authorizationClass, action };
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command !== 'verify') fail('usage: trusted-release-verifier verify --root <dir> --archive <tgz> --authorization <json> --public-key <pem> --expected-version <v> --expected-commit <sha> --action activate');
  const result = await verifyCli(argv);
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (require.main === module) main().catch(error => { console.error(`${error.code || 'ERROR'}: ${error.message}`); process.exitCode = 1; });

module.exports = { AUTH_FORMAT, stableStringify, sha256, verifyInventory, verifyProvenance, verifyAuthorization, verifyCli };
