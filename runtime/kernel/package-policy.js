'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stableStringify } = require('./canonical-json');

const POLICY_FILE = 'package-policy.json';
const HASH = /^sha256:[0-9a-f]{64}$/;
const POLICY_KEYS = Object.freeze([
  'allowedBuiltins', 'ambientCapabilities', 'bounds', 'coreId', 'diagnostics', 'entrypoint',
  'environmentAllowlist', 'files', 'formatVersion', 'policyHash', 'resourceContract'
]);
const EXPECTED_ENVIRONMENT = Object.freeze(['LANG', 'LC_ALL', 'NODE_ENV', 'PATH', 'STAY_COREHOST', 'TZ']);
const CAPABILITY_KEYS = Object.freeze(['filesystemWrite', 'network', 'processSpawn']);
// This source audit is deliberately defense-in-depth only. The production security
// boundary is the OS sandbox in core-sandbox.js; JavaScript syntax filtering is not
// treated as a hostile-code sandbox.
const FORBIDDEN_SOURCE = Object.freeze([
  /\bprocess\s*(?:\.|\[)/, /\bsetInterval\s*\(/, /\bsetTimeout\s*\(/, /\bsetImmediate\s*\(/,
  /\beval\s*\(/, /\bnew\s+Function\b/, /\bimport\s*\(/, /\bfetch\s*\(/, /\bWebSocket\b/
]);
const SHARED_ABI_RELATIVE = '../../../runtime/kernel/canonical-json.js';

function fail(message, code = 'CORE_PACKAGE_POLICY_INVALID') {
  throw Object.assign(new Error(message), { code });
}
function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} fields are not canonical`);
}
function digest(bytes) { return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`; }
function inside(root, target) { return target === root || target.startsWith(root + path.sep); }
function resolveDependency(parent, request) {
  const base = path.resolve(path.dirname(parent), request);
  for (const candidate of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return fs.realpathSync.native(candidate);
  }
  fail(`package dependency cannot be resolved: ${request}`, 'CORE_PACKAGE_DEPENDENCY_DENIED');
}

function auditSourceText(source, allowedBuiltins = [], allowedRelativeDependencies = null) {
  if (typeof source !== 'string') fail('package source must be text');
  for (const pattern of FORBIDDEN_SOURCE) if (pattern.test(source)) fail(`package source contains forbidden capability syntax: ${pattern}`, 'CORE_PACKAGE_CAPABILITY_DENIED');
  const literalRequires = [...source.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)].map(match => match[2]);
  const requireCalls = [...source.matchAll(/\brequire\s*\(/g)].length;
  const aliasedRequire = /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*require\b(?!\s*\()/.test(source);
  if (requireCalls !== literalRequires.length || aliasedRequire) {
    fail('aliased or dynamic require is forbidden', 'CORE_PACKAGE_DEPENDENCY_DENIED');
  }
  for (const request of literalRequires) {
    if (!request.startsWith('.') && !allowedBuiltins.includes(request)) fail(`builtin or external dependency is not allowlisted: ${request}`, 'CORE_PACKAGE_DEPENDENCY_DENIED');
    if (request.startsWith('.') && allowedRelativeDependencies && !allowedRelativeDependencies.has(request)) fail(`relative dependency is not allowlisted: ${request}`, 'CORE_PACKAGE_DEPENDENCY_DENIED');
  }
  return literalRequires;
}

function readPackagePolicy(modulePath) {
  const entrypoint = fs.realpathSync.native(path.resolve(modulePath));
  const policyPath = path.join(path.dirname(entrypoint), POLICY_FILE);
  if (!fs.existsSync(policyPath)) return null;
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  exactKeys(policy, POLICY_KEYS, 'package policy');
  if (policy.formatVersion !== 1 || typeof policy.coreId !== 'string' || !policy.coreId || !HASH.test(policy.policyHash)) fail('package policy header is invalid');
  if (!Array.isArray(policy.allowedBuiltins) || [...policy.allowedBuiltins].sort().join('|') !== policy.allowedBuiltins.join('|')) fail('builtin allowlist must be sorted');
  if (stableStringify(policy.environmentAllowlist) !== stableStringify(EXPECTED_ENVIRONMENT)) fail('package environment allowlist differs from the sanitized CoreHost environment');
  exactKeys(policy.ambientCapabilities, CAPABILITY_KEYS, 'ambient capabilities');
  if (Object.values(policy.ambientCapabilities).some(value => value !== false) || policy.diagnostics !== false) fail('ambient or diagnostic capability is enabled', 'CORE_PACKAGE_CAPABILITY_DENIED');
  const { policyHash, ...body } = policy;
  if (policyHash !== digest(stableStringify(body))) fail('package policy hash mismatch', 'CORE_PACKAGE_POLICY_HASH_MISMATCH');
  const root = path.dirname(policyPath);
  const expectedEntry = fs.realpathSync.native(path.resolve(root, policy.entrypoint));
  if (entrypoint !== expectedEntry || !inside(root, expectedEntry)) fail('entrypoint is outside the canonical package root', 'CORE_PACKAGE_PATH_DENIED');
  return { policy, policyPath: fs.realpathSync.native(policyPath), root, entrypoint };
}

function enforcePackagePolicy(modulePath) {
  const record = readPackagePolicy(modulePath);
  if (!record) return null;
  const { policy, policyPath, root, entrypoint } = record;
  exactKeys(policy.files, Object.keys(policy.files), 'package file inventory');
  const allowedFiles = new Map();
  const releaseRoot = path.resolve(root, '../../..');
  const sharedAbiPath = path.resolve(root, SHARED_ABI_RELATIVE);
  const sharedAbiCanonical = fs.existsSync(sharedAbiPath) ? fs.realpathSync.native(sharedAbiPath) : null;
  for (const [relative, expectedHash] of Object.entries(policy.files)) {
    if (!HASH.test(expectedHash)) fail(`package file hash is invalid: ${relative}`);
    const candidate = path.resolve(root, relative);
    if (!fs.existsSync(candidate)) fail(`package file is missing: ${relative}`, 'CORE_PACKAGE_FILE_MISSING');
    const canonical = fs.realpathSync.native(candidate);
    const trustedSharedAbi = relative === SHARED_ABI_RELATIVE
      && sharedAbiCanonical !== null
      && canonical === sharedAbiCanonical
      && inside(releaseRoot, canonical);
    if (!inside(root, canonical) && !trustedSharedAbi) {
      fail(`package file escapes its package and trusted ABI: ${relative}`, 'CORE_PACKAGE_PATH_DENIED');
    }
    if (canonical === policyPath) fail('package policy cannot self-attest');
    const bytes = fs.readFileSync(canonical);
    if (digest(bytes) !== expectedHash) fail(`package file hash mismatch: ${relative}`, 'CORE_PACKAGE_FILE_HASH_MISMATCH');
    allowedFiles.set(canonical, relative);
  }
  if (!allowedFiles.has(entrypoint)) fail('entrypoint is absent from the package file inventory');
  for (const [canonical, relative] of allowedFiles) {
    if (path.extname(canonical) !== '.js') continue;
    const requests = auditSourceText(fs.readFileSync(canonical, 'utf8'), policy.allowedBuiltins);
    for (const request of requests) {
      if (!request.startsWith('.')) continue;
      const resolved = resolveDependency(canonical, request);
      if (resolved === policyPath) continue;
      if (!allowedFiles.has(resolved)) fail(`dependency is outside the allowlist: ${relative} -> ${request}`, 'CORE_PACKAGE_DEPENDENCY_DENIED');
    }
  }
  return Object.freeze({ policy, policyPath, root, entrypoint, attestedFiles: allowedFiles.size });
}

function verifyManifestAgainstPackagePolicy(record, manifest) {
  const policyRequired = manifest?.coreId === 'sntss'
    || (process.env.STAY_REQUIRE_CORE_PACKAGE_POLICY === '1' && manifest?.coreId !== 'fetus-legacy');
  if (!record) {
    if (policyRequired) fail(`package policy is required for core ${manifest?.coreId || 'unknown'}`, 'CORE_PACKAGE_POLICY_REQUIRED');
    return true;
  }
  if (manifest.coreId !== record.policy.coreId) fail('manifest core identity differs from package policy');
  if (stableStringify(manifest.resources) !== stableStringify(record.policy.resourceContract.manifestResources)) fail('manifest resources differ from the package resource contract', 'CORE_PACKAGE_RESOURCE_MISMATCH');
  return true;
}

module.exports = {
  POLICY_FILE, EXPECTED_ENVIRONMENT, SHARED_ABI_RELATIVE, auditSourceText, readPackagePolicy, enforcePackagePolicy,
  verifyManifestAgainstPackagePolicy, digest
};
