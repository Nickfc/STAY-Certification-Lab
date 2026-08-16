'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { stableStringify } = require('../kernel/canonical-json');
const { enforcePackagePolicy, auditSourceText, digest } = require('../kernel/package-policy');

const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PROVENANCE_FORMAT = 'stay-release-provenance-v2';
const INVENTORY_FORMAT = 'stay-release-inventory-v1';
const GENERATED = new Set(['RELEASE_PROVENANCE.json', 'RELEASE_INVENTORY.json']);
const EXCLUDED_PREFIXES = Object.freeze(['.git/', '.stay-data/', 'data/', 'release-output/']);
const FORBIDDEN_PATTERNS = Object.freeze([
  /(^|\/)(\.env)(\.|$)/i,
  /(^|\/)(id_rsa|id_ed25519|.*\.pem|.*\.ppk)$/i,
  /(^|\/)(credentials?|secrets?|private[-_]?key)(\.|\/|$)/i,
  /(^|\/)(r[0-9]+-state-|candidate-state-|laboratory-state|failed-state-)/i
]);
const REQUIRED_PATHS = Object.freeze([
  'package.json', 'server.js',
  'cores/sntss/neutral/index.js', 'cores/sntss/v0.1.0/index.js', 'cores/sntss/v0.1.0/package-policy.json',
  'cores/sntss/schemas/acquired-state.schema.json', 'cores/sntss/schemas/neutral-state.schema.json',
  'test/sntss-neutral.test.js', 'test/sntss-containment.test.js', 'test/sntss-observability.test.js', 'test/sntss-release.test.js',
  'docs/sntss/evidence/R8_CONTAINMENT_EVIDENCE.json', 'docs/sntss/evidence/R9_OBSERVABILITY_EVIDENCE.json',
  'docs/sntss/R10_RELEASE_AND_ROLLBACK_CONTRACT.md', 'docs/sntss/R10_OPERATOR_HANDOFF.md'
]);

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}
function fail(message, code = 'SNTSS_RELEASE_INVALID') { throw Object.assign(new Error(message), { code }); }
function normalizeRelative(value) { return String(value).split(path.sep).join('/').replace(/^\.\//, ''); }
function excluded(relative) {
  if (!relative || GENERATED.has(relative)) return true;
  return EXCLUDED_PREFIXES.some(prefix => relative === prefix.slice(0, -1) || relative.startsWith(prefix));
}
function forbidden(relative) { return FORBIDDEN_PATTERNS.some(pattern => pattern.test(relative)); }
function roleFor(relative) {
  if (relative.startsWith('cores/sntss/v0.1.0/')) return 'sntss-source';
  if (relative.startsWith('cores/sntss/neutral/')) return 'sntss-neutral';
  if (relative.startsWith('cores/sntss/schemas/')) return 'sntss-schema';
  if (relative.startsWith('docs/sntss/evidence/')) return 'sntss-evidence';
  if (relative.startsWith('docs/sntss/')) return 'sntss-documentation';
  if (relative.startsWith('test/fixtures/')) return 'fixture';
  if (/^test\/sntss-.*\.test\.js$/.test(relative)) return 'sntss-test';
  if (/^scripts\/sntss-.*\.js$/.test(relative)) return 'sntss-tool';
  if (relative.startsWith('.github/workflows/')) return 'workflow';
  if (relative.startsWith('deploy/') || relative.startsWith('tools/')) return 'release-control';
  return 'runtime-source';
}
async function walk(root, directory = root) {
  const output = [];
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = normalizeRelative(path.relative(root, absolute));
    if (excluded(relative)) continue;
    if (entry.isSymbolicLink()) fail(`release inventory forbids symbolic links: ${relative}`, 'SNTSS_RELEASE_SYMLINK');
    if (entry.isDirectory()) output.push(...await walk(root, absolute));
    else if (entry.isFile()) output.push({ absolute, relative });
  }
  return output;
}
async function buildInventory(rootDir) {
  const root = path.resolve(rootDir);
  const files = await walk(root);
  const entries = [];
  for (const file of files) {
    if (forbidden(file.relative)) fail(`release contains forbidden secret/state path: ${file.relative}`, 'SNTSS_RELEASE_FORBIDDEN_PATH');
    const bytes = await fsp.readFile(file.absolute);
    entries.push(Object.freeze({ path: file.relative, bytes: bytes.length, sha256: sha256(bytes), role: roleFor(file.relative) }));
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const paths = new Set(entries.map(entry => entry.path));
  for (const required of REQUIRED_PATHS) if (!paths.has(required)) fail(`release inventory is missing required artifact: ${required}`, 'SNTSS_RELEASE_ARTIFACT_MISSING');
  const body = { format: INVENTORY_FORMAT, entries };
  return Object.freeze({ ...body, inventoryHash: sha256(stableStringify(body)) });
}
function inventorySubsetHash(inventory, role) {
  const entries = inventory.entries.filter(entry => entry.role === role).map(({ path: p, bytes, sha256: h }) => ({ path: p, bytes, sha256: h }));
  return sha256(stableStringify(entries));
}
function readPackageJson(root) {
  const packagePath = path.join(root, 'package.json');
  const value = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  return { value, version: String(value.stayVersion || value.version || '') };
}
function validateNeutralFallback(root) {
  const neutralPath = path.join(root, 'cores/sntss/neutral/index.js');
  const source = fs.readFileSync(neutralPath, 'utf8');
  auditSourceText(source, []);
  delete require.cache[require.resolve(neutralPath)];
  const neutral = require(neutralPath);
  const manifest = neutral.manifest;
  if (!manifest || manifest.coreId !== 'sntss' || manifest.version !== '0.0.0-neutral' || manifest.stage !== 'neutral-production') fail('neutral fallback manifest is invalid', 'SNTSS_RELEASE_NEUTRAL_INVALID');
  if (!Array.isArray(manifest.outputs) || manifest.outputs.length !== 0) fail('neutral fallback has output authority', 'SNTSS_RELEASE_NEUTRAL_OUTPUT');
  return { version: manifest.version, stateSchema: manifest.stateSchema, outputs: manifest.outputs.length, sourceHash: digest(source) };
}
function sntssAttestation(root, inventory) {
  const entrypoint = path.join(root, 'cores/sntss/v0.1.0/index.js');
  const policyRecord = enforcePackagePolicy(entrypoint);
  if (!policyRecord) fail('SNTSS laboratory package policy is missing', 'SNTSS_RELEASE_POLICY_MISSING');
  const speciesPath = path.join(root, 'cores/sntss/v0.1.0/species-profile.js');
  const sourceRegistryPath = path.join(root, 'cores/sntss/v0.1.0/source-registry.js');
  const receptorPath = path.join(root, 'cores/sntss/v0.1.0/receptor-profiles.js');
  for (const target of [speciesPath, sourceRegistryPath, receptorPath]) delete require.cache[require.resolve(target)];
  const { speciesProfile } = require(speciesPath);
  const { sourceRegistry } = require(sourceRegistryPath);
  const { receptorProfileRegistry } = require(receptorPath);
  for (const value of [speciesProfile.profileHash, sourceRegistry.registryHash, receptorProfileRegistry.registryHash, policyRecord.policy.policyHash]) {
    if (!HASH.test(value)) fail('SNTSS attestation contains an invalid hash');
  }
  return Object.freeze({
    packagePolicyHash: policyRecord.policy.policyHash,
    packageAttestedFiles: policyRecord.attestedFiles,
    speciesProfileHash: speciesProfile.profileHash,
    sourceRegistryHash: sourceRegistry.registryHash,
    receptorProfileRegistryHash: receptorProfileRegistry.registryHash,
    sourceInventoryHash: inventorySubsetHash(inventory, 'sntss-source'),
    neutralInventoryHash: inventorySubsetHash(inventory, 'sntss-neutral'),
    schemaInventoryHash: inventorySubsetHash(inventory, 'sntss-schema'),
    evidenceInventoryHash: inventorySubsetHash(inventory, 'sntss-evidence'),
    testInventoryHash: inventorySubsetHash(inventory, 'sntss-test'),
    neutralFallback: validateNeutralFallback(root)
  });
}
function dependencyInventory(root, attestation) {
  const { value } = readPackageJson(root);
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'cores/sntss/v0.1.0/package-policy.json'), 'utf8'));
  return Object.freeze({
    npmDependencies: Object.fromEntries(Object.entries(value.dependencies || {}).sort()),
    npmDevDependencies: Object.fromEntries(Object.entries(value.devDependencies || {}).sort()),
    sntssAllowedBuiltins: [...(policy.allowedBuiltins || [])],
    packagePolicyHash: attestation.packagePolicyHash
  });
}
async function createReleaseDocuments(rootDir, metadata = {}) {
  const root = path.resolve(rootDir);
  const { version: packageVersion } = readPackageJson(root);
  const version = String(metadata.version || packageVersion);
  const commit = String(metadata.commit || '');
  if (!version || version !== packageVersion) fail('release version does not match package.json', 'SNTSS_RELEASE_VERSION');
  if (!COMMIT.test(commit)) fail('release commit must be a pinned 40-character SHA', 'SNTSS_RELEASE_COMMIT');
  const inventory = await buildInventory(root);
  const sntss = sntssAttestation(root, inventory);
  const dependencies = dependencyInventory(root, sntss);
  const provenanceBody = {
    format: PROVENANCE_FORMAT,
    version,
    commit,
    builder: String(metadata.builder || 'unknown'),
    branch: metadata.branch == null ? null : String(metadata.branch),
    workflow: metadata.workflow == null ? null : String(metadata.workflow),
    runId: metadata.runId == null ? null : String(metadata.runId),
    stateRollbackPolicy: 'preserve-forward-state',
    releaseMutable: false,
    productionEligible: false,
    inventoryHash: inventory.inventoryHash,
    dependencyInventoryHash: sha256(stableStringify(dependencies)),
    sntss
  };
  const provenance = Object.freeze({ ...provenanceBody, provenanceHash: sha256(stableStringify(provenanceBody)) });
  return { inventory, provenance, dependencies };
}
async function writeReleaseDocuments(rootDir, metadata = {}) {
  const root = path.resolve(rootDir);
  const documents = await createReleaseDocuments(root, metadata);
  await fsp.writeFile(path.join(root, 'RELEASE_INVENTORY.json'), `${JSON.stringify(documents.inventory, null, 2)}\n`, { mode: 0o600 });
  await fsp.writeFile(path.join(root, 'RELEASE_PROVENANCE.json'), `${JSON.stringify({ ...documents.provenance, dependencies: documents.dependencies }, null, 2)}\n`, { mode: 0o600 });
  return documents;
}
async function verifyReleaseDocuments(rootDir, provenancePath = null) {
  const root = path.resolve(rootDir);
  const file = provenancePath ? path.resolve(provenancePath) : path.join(root, 'RELEASE_PROVENANCE.json');
  const provenance = JSON.parse(await fsp.readFile(file, 'utf8'));
  if (provenance.format !== PROVENANCE_FORMAT || !HASH.test(provenance.provenanceHash)) fail('release provenance header is invalid', 'SNTSS_RELEASE_PROVENANCE');
  const rebuilt = await createReleaseDocuments(root, provenance);
  const expected = { ...provenance }; delete expected.dependencies;
  if (stableStringify(expected) !== stableStringify(rebuilt.provenance)) fail('release provenance does not reproduce from candidate bytes', 'SNTSS_RELEASE_PROVENANCE_MISMATCH');
  const dependencyHash = sha256(stableStringify(provenance.dependencies || {}));
  if (dependencyHash !== provenance.dependencyInventoryHash) fail('dependency inventory hash mismatch', 'SNTSS_RELEASE_DEPENDENCY_MISMATCH');
  const inventoryPath = path.join(root, 'RELEASE_INVENTORY.json');
  const inventory = JSON.parse(await fsp.readFile(inventoryPath, 'utf8'));
  if (stableStringify(inventory) !== stableStringify(rebuilt.inventory)) fail('release inventory document differs from candidate bytes', 'SNTSS_RELEASE_INVENTORY_MISMATCH');
  return rebuilt;
}
function migrationRehearsal(rootDir) {
  const root = path.resolve(rootDir);
  enforcePackagePolicy(path.join(root, 'cores/sntss/v0.1.0/index.js'));
  const genesisPath = path.join(root, 'cores/sntss/v0.1.0/genesis.js');
  const migrationsPath = path.join(root, 'cores/sntss/v0.1.0/migrations.js');
  const speciesPath = path.join(root, 'cores/sntss/v0.1.0/species-profile.js');
  for (const target of [genesisPath, migrationsPath, speciesPath]) delete require.cache[require.resolve(target)];
  const { prepareGenesis } = require(genesisPath);
  const migrations = require(migrationsPath);
  const { speciesProfile } = require(speciesPath);
  const binding = {
    bindingVersion: 1,
    identitySha256: `sha256:${'1'.repeat(64)}`,
    organismLineage: 'STAY/Genesis', issuedAt: 1000, runtimeRevision: 46,
    authorityEpoch: 1, kernelVersion: '0.8.11.3', bindingEventId: 'evt-binding-r10'
  };
  const transaction = prepareGenesis(null, {
    at: 1000, binding, genesisEventId: 'evt-genesis-r10', genesisSequence: 1,
    neutralCheckpointHash: `sha256:${'2'.repeat(64)}`
  }, {
    authorityEpoch: 1, neutralHandoffVerified: true, productionCommit: false,
    speciesProfileHash: speciesProfile.profileHash, stage: 'laboratory-r7'
  }, '3'.repeat(64));
  const current = transaction.state;
  const legacy = JSON.parse(JSON.stringify(current));
  delete legacy.clampCounters; legacy.stateSchema = 1;
  const before = migrations.biologicalInvariantHash(legacy);
  const forward = migrations.migrateForward(legacy, 2);
  const afterForward = migrations.biologicalInvariantHash(forward.state);
  const projection = migrations.projectBackward(forward.state, 1);
  const afterProjection = migrations.biologicalInvariantHash(projection.state);
  if (before !== afterForward || before !== afterProjection || projection.report.sourceStateRemainsAuthoritative !== true) fail('migration/projection rehearsal rewound acquired biology', 'SNTSS_RELEASE_BIOLOGY_REWIND');
  return Object.freeze({
    status: 'PASS', beforeInvariantHash: before, forwardInvariantHash: afterForward,
    backwardProjectionInvariantHash: afterProjection, sourceStateRemainsAuthoritative: true,
    migrationId: forward.report.migrationId, transformationHash: forward.report.transformationHash
  });
}
async function atomicSymlink(linkPath, targetPath) {
  const parent = path.dirname(linkPath);
  await fsp.mkdir(parent, { recursive: true });
  const temp = `${linkPath}.new-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fsp.symlink(path.resolve(targetPath), temp);
  await fsp.rename(temp, linkPath);
}
async function releaseReplicaRehearsal(workspace, options = {}) {
  const root = path.resolve(workspace);
  const releases = path.join(root, 'releases');
  const candidateStates = path.join(root, 'candidate-state');
  const failedStates = path.join(root, 'failed-state');
  const currentLink = path.join(root, 'current');
  const liveState = path.join(root, 'live-state.json');
  const oldRelease = path.join(releases, 'old');
  const newRelease = path.join(releases, 'new');
  await fsp.mkdir(oldRelease, { recursive: true }); await fsp.mkdir(newRelease, { recursive: true });
  await fsp.writeFile(path.join(oldRelease, 'release.txt'), 'old\n'); await fsp.writeFile(path.join(newRelease, 'release.txt'), 'new\n');
  await fsp.writeFile(liveState, `${JSON.stringify({ identity: 'organism-1', experience: 41, chemistry: { tolerance: 7 } })}\n`);
  await atomicSymlink(currentLink, oldRelease);
  const pointerBefore = await fsp.realpath(currentLink); const stateBefore = await fsp.readFile(liveState, 'utf8');

  // Candidate-state isolation: all rehearsal mutation occurs on a copy before release switch.
  await fsp.mkdir(candidateStates, { recursive: true });
  const candidateState = path.join(candidateStates, 'new.json');
  await fsp.copyFile(liveState, candidateState);
  const isolated = JSON.parse(await fsp.readFile(candidateState, 'utf8'));
  isolated.experience += 1; isolated.chemistry.tolerance += 1;
  await fsp.writeFile(candidateState, `${JSON.stringify(isolated)}\n`);
  if (await fsp.readFile(liveState, 'utf8') !== stateBefore) fail('candidate preflight mutated live state', 'SNTSS_RELEASE_PREFLIGHT_SIDE_EFFECT');

  if (options.failPreflight) {
    return { status: 'PREFLIGHT_REJECTED', pointerUnchanged: (await fsp.realpath(currentLink)) === pointerBefore, stateUnchanged: (await fsp.readFile(liveState, 'utf8')) === stateBefore };
  }

  const safetyBackup = path.join(root, 'safety-backup.json'); await fsp.copyFile(liveState, safetyBackup);
  await atomicSymlink(currentLink, newRelease);
  await fsp.copyFile(candidateState, liveState);
  const postSwitch = JSON.parse(await fsp.readFile(liveState, 'utf8'));
  postSwitch.experience += 1; postSwitch.chemistry.tolerance += 1;
  await fsp.writeFile(liveState, `${JSON.stringify(postSwitch)}\n`);

  if (options.failHealth) {
    await fsp.mkdir(failedStates, { recursive: true });
    const retained = path.join(failedStates, 'new.json'); await fsp.copyFile(liveState, retained);
    await atomicSymlink(currentLink, oldRelease); // Code rollback only. Canonical biology is never restored from backup.
    const after = JSON.parse(await fsp.readFile(liveState, 'utf8'));
    const backup = JSON.parse(await fsp.readFile(safetyBackup, 'utf8'));
    return {
      status: 'ROLLED_BACK', pointerRestored: (await fsp.realpath(currentLink)) === oldRelease,
      identityPreserved: after.identity === backup.identity,
      biologyNotRewound: after.experience > backup.experience && after.chemistry.tolerance > backup.chemistry.tolerance,
      failedStateRetained: JSON.stringify(after) === JSON.stringify(JSON.parse(await fsp.readFile(retained, 'utf8'))),
      safetyBackupRetained: true
    };
  }
  return { status: 'ACCEPTED', pointerSwitched: (await fsp.realpath(currentLink)) === newRelease, identityPreserved: JSON.parse(await fsp.readFile(liveState, 'utf8')).identity === 'organism-1' };
}

async function cli(argv = process.argv.slice(2)) {
  const command = argv.shift();
  const option = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : null; };
  if (command === 'emit') {
    const root = option('--root') || process.cwd();
    const result = await writeReleaseDocuments(root, {
      version: option('--version'), commit: option('--commit'), builder: option('--builder'),
      branch: option('--branch'), workflow: option('--workflow'), runId: option('--run-id')
    });
    process.stdout.write(`${JSON.stringify({ status: 'PASS', inventoryHash: result.inventory.inventoryHash, provenanceHash: result.provenance.provenanceHash })}\n`);
    return;
  }
  if (command === 'verify') {
    const root = option('--root') || process.cwd();
    const result = await verifyReleaseDocuments(root, option('--provenance'));
    const migration = migrationRehearsal(root);
    process.stdout.write(`${JSON.stringify({ status: 'PASS', inventoryHash: result.inventory.inventoryHash, provenanceHash: result.provenance.provenanceHash, migration })}\n`);
    return;
  }
  fail('usage: sntss-r10 release-control emit|verify --root <dir> --version <v> --commit <sha> --builder <name>', 'SNTSS_RELEASE_USAGE');
}

if (require.main === module) cli().catch(error => { console.error(`${error.code || 'ERROR'}: ${error.message}`); process.exitCode = 1; });

module.exports = {
  PROVENANCE_FORMAT, INVENTORY_FORMAT, REQUIRED_PATHS, sha256, buildInventory, createReleaseDocuments,
  writeReleaseDocuments, verifyReleaseDocuments, migrationRehearsal, atomicSymlink, releaseReplicaRehearsal
};
