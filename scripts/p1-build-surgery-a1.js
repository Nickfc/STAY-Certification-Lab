#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const releaseControl = require('../runtime/release/sntss-release-control');

const EXACT_SHA = '7d040592ccf1f149f0f0a170f79cf76bb5f05d92';
const EXACT_TREE = '450cc22f70b7abf3b5733fe882049d88cd52de74';
const BASE_ID = `0.8.11.3-p1a-surgery-a-candidate-${EXACT_SHA}`;
const RELEASE_ID = '0.8.11.3-p1a1-resident-control-7d040592ccf1f149';
const OVERLAY_FILES = Object.freeze([
  'server-secure.js',
  'runtime/kernel/resident-control-socket.js'
]);
const PROTECTED_PATHS = Object.freeze([
  'runtime/kernel/biological-signalling-fabric.js',
  'runtime/kernel/resident-manager.js',
  'runtime/kernel/state-store.js',
  'cores/fetus-legacy-0.6',
  'cores/sntss/i3d',
  'cores/chronobiology'
]);

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function treeDigest(root) {
  const records = [];
  async function visit(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) records.push(`${relative}\0${fileHash(absolute)}`);
      else throw Object.assign(new Error(`special file is forbidden: ${absolute}`), { code: 'P1_A1_SPECIAL_FILE' });
    }
  }
  const stat = await fsp.stat(root);
  if (stat.isDirectory()) await visit(root);
  else records.push(`${path.basename(root)}\0${fileHash(root)}`);
  return crypto.createHash('sha256').update(records.join('\n')).digest('hex');
}

async function removeWritable(root) {
  const entries = await fsp.readdir(root, { recursive: true, withFileTypes: true });
  const directories = [root];
  for (const entry of entries) {
    const absolute = path.join(entry.parentPath || entry.path, entry.name);
    if (entry.isDirectory()) directories.push(absolute);
    else if (entry.isFile()) await fsp.chmod(absolute, 0o444);
    else throw Object.assign(new Error(`special file is forbidden: ${absolute}`), { code: 'P1_A1_SPECIAL_FILE' });
  }
  directories.sort((a, b) => b.length - a.length);
  for (const directory of directories) await fsp.chmod(directory, 0o555);
}

async function makeWritable(root) {
  if (!fs.existsSync(root)) return;
  const entries = await fsp.readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(entry.parentPath || entry.path, entry.name);
    if (entry.isDirectory()) await fsp.chmod(absolute, 0o700);
    else if (entry.isFile()) await fsp.chmod(absolute, 0o600);
  }
  await fsp.chmod(root, 0o700);
}

async function main(argv = process.argv.slice(2)) {
  const baseRelease = path.resolve(option(argv, '--base-release') || '');
  const overlayRoot = path.resolve(option(argv, '--overlay-root') || path.resolve(__dirname, '..'));
  const outputRoot = path.resolve(option(argv, '--output-root') || 'release-output/p1-a1');
  if (path.basename(baseRelease) !== BASE_ID || !fs.statSync(baseRelease).isDirectory()) {
    throw Object.assign(new Error('exact Surgery A base release is required'), { code: 'P1_A1_BASE' });
  }
  const baseManifest = JSON.parse(await fsp.readFile(path.join(baseRelease, 'P1_SURGERY_A_MANIFEST.json'), 'utf8'));
  if (baseManifest.sourceSha !== EXACT_SHA || baseManifest.sourceTree !== EXACT_TREE || baseManifest.releaseRole !== 'surgery-a-candidate') {
    throw Object.assign(new Error('Surgery A base identity mismatch'), { code: 'P1_A1_BASE_IDENTITY' });
  }

  const before = {};
  for (const relative of PROTECTED_PATHS) before[relative] = await treeDigest(path.join(baseRelease, relative));
  await fsp.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const destination = path.join(outputRoot, RELEASE_ID);
  if (fs.existsSync(destination)) throw Object.assign(new Error('A.1 release destination exists'), { code: 'P1_A1_EXISTS' });
  const stagingParent = await fsp.mkdtemp(path.join(outputRoot, '.p1-a1-stage-'));
  const staging = path.join(stagingParent, RELEASE_ID);
  try {
    await fsp.cp(baseRelease, staging, { recursive: true, dereference: false, verbatimSymlinks: true });
    await makeWritable(staging);
    for (const relative of OVERLAY_FILES) {
      const source = path.join(overlayRoot, relative);
      const target = path.join(staging, relative);
      if (!fs.statSync(source).isFile()) throw new Error(`A.1 overlay is missing: ${relative}`);
      await fsp.chmod(target, 0o644).catch(() => {});
      await fsp.copyFile(source, target);
    }

    const after = {};
    for (const relative of PROTECTED_PATHS) {
      after[relative] = await treeDigest(path.join(staging, relative));
      if (after[relative] !== before[relative]) {
        throw Object.assign(new Error(`protected A.1 path changed: ${relative}`), { code: 'P1_A1_PROTECTED_CHANGE' });
      }
    }
    const overlayHashes = Object.fromEntries(OVERLAY_FILES.map(relative => [relative, `sha256:${fileHash(path.join(staging, relative))}`]));
    const manifestBody = {
      format: 'stay-p1-surgery-a1-release-v1',
      releaseId: RELEASE_ID,
      releaseRole: 'resident-control-plane-enablement',
      baseReleaseId: BASE_ID,
      baseSourceSha: EXACT_SHA,
      baseSourceTree: EXACT_TREE,
      socketPath: '/run/stay/resident-control.sock',
      fixedOperations: ['status', 'attach', 'detach'],
      allowlistedResidencies: ['resident:sntss', 'resident:chronobiology'],
      physiologyActivated: false,
      stateStoreSchemaChanged: false,
      authorityOwnershipChanged: false,
      sntssPackageTree: '5efc31371cfdca9e650ad3c8bc6d749f8f4df618',
      overlayHashes,
      protectedDigests: after
    };
    const manifest = {
      ...manifestBody,
      manifestHash: 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(manifestBody)).digest('hex')
    };
    await fsp.chmod(path.join(staging, 'P1_SURGERY_A_MANIFEST.json'), 0o644).catch(() => {});
    await fsp.unlink(path.join(staging, 'P1_SURGERY_A_MANIFEST.json'));
    await fsp.writeFile(path.join(staging, 'P1_SURGERY_A1_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    for (const document of ['RELEASE_INVENTORY.json', 'RELEASE_PROVENANCE.json']) {
      await fsp.chmod(path.join(staging, document), 0o644).catch(() => {});
      await fsp.unlink(path.join(staging, document)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    const documents = await releaseControl.writeReleaseDocuments(staging, {
      commit: EXACT_SHA,
      branch: 'feature/live-physiology-transplant',
      builder: 'p1-surgery-a1-builder',
      productionEligible: true
    });
    await releaseControl.verifyReleaseDocuments(staging);
    await fsp.rename(staging, destination);
    await removeWritable(destination);
    process.stdout.write(JSON.stringify({
      status: 'PASS',
      releaseId: RELEASE_ID,
      path: destination,
      baseReleaseId: BASE_ID,
      manifestHash: manifest.manifestHash,
      overlayHashes,
      protectedDigests: after,
      inventoryHash: documents.inventory.inventoryHash,
      provenanceHash: documents.provenance.provenanceHash,
      productionTouched: false
    }, null, 2) + '\n');
  } finally {
    await makeWritable(stagingParent);
    await fsp.rm(stagingParent, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => {
  console.error(`${error.code || 'P1_A1_BUILD_FAILED'}: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { EXACT_SHA, EXACT_TREE, BASE_ID, RELEASE_ID, OVERLAY_FILES, PROTECTED_PATHS, treeDigest };
