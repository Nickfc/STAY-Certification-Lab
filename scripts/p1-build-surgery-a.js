#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const releaseControl = require('../runtime/release/sntss-release-control');
const surgery = require('../runtime/release/surgery-a-control');

const SOURCE_ROOT = path.resolve(__dirname, '..');

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function gitObject(object) {
  return execFileSync('git', ['-C', SOURCE_ROOT, 'rev-parse', object], {
    encoding: 'utf8'
  }).trim();
}

function included(source) {
  const relative = path.relative(SOURCE_ROOT, source).split(path.sep).join('/');
  return relative !== '.git' &&
    !relative.startsWith('.git/') &&
    relative !== '.stay-data' &&
    !relative.startsWith('.stay-data/') &&
    relative !== 'release-output' &&
    !relative.startsWith('release-output/');
}

async function makeRelease(outputRoot, metadata, releaseRole) {
  const manifest = surgery.createManifest({ ...metadata, releaseRole });
  const destination = path.join(outputRoot, manifest.releaseId);
  if (fs.existsSync(destination)) {
    throw Object.assign(new Error(`release destination already exists: ${destination}`), {
      code: 'P1_RELEASE_EXISTS'
    });
  }
  await fsp.cp(SOURCE_ROOT, destination, {
    recursive: true,
    filter: included
  });
  await fsp.writeFile(
    path.join(destination, 'P1_SURGERY_A_MANIFEST.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 }
  );
  const documents = await releaseControl.writeReleaseDocuments(destination, {
    commit: metadata.sourceSha,
    branch: surgery.IDENTITIES.branch,
    builder: 'p1-surgery-a-builder',
    productionEligible: true
  });
  surgery.verifyAnchors(destination, { verifyGitTrees: false });
  await releaseControl.verifyReleaseDocuments(destination);

  const entries = await fsp.readdir(destination, { recursive: true, withFileTypes: true });
  const directories = [destination];
  for (const entry of entries) {
    const absolute = path.join(entry.parentPath || entry.path, entry.name);
    if (entry.isDirectory()) directories.push(absolute);
    else if (entry.isFile()) await fsp.chmod(absolute, 0o444);
  }
  directories.sort((a, b) => b.length - a.length);
  for (const directory of directories) await fsp.chmod(directory, 0o555);

  return Object.freeze({
    releaseRole,
    releaseId: manifest.releaseId,
    path: destination,
    sourceSha: metadata.sourceSha,
    sourceTree: metadata.sourceTree,
    manifestHash: manifest.manifestHash,
    inventoryHash: documents.inventory.inventoryHash,
    provenanceHash: documents.provenance.provenanceHash
  });
}

async function main(argv = process.argv.slice(2)) {
  const sourceSha = option(argv, '--source-sha');
  const sourceTree = option(argv, '--source-tree');
  const outputRoot = path.resolve(option(argv, '--output-root') || 'release-output/p1');
  if (!/^[0-9a-f]{40}$/.test(String(sourceSha)) ||
      !/^[0-9a-f]{40}$/.test(String(sourceTree))) {
    throw Object.assign(new Error(
      'usage: p1-build-surgery-a --source-sha <40hex> --source-tree <40hex> [--output-root <dir>]'
    ), { code: 'P1_BUILD_USAGE' });
  }

  const actualTree = gitObject('HEAD^{tree}');
  if (actualTree !== sourceTree) {
    throw Object.assign(new Error(
      `source tree mismatch: expected ${sourceTree}, observed ${actualTree}`
    ), { code: 'P1_BUILD_TREE_MISMATCH' });
  }
  surgery.verifyAnchors(SOURCE_ROOT);
  await fsp.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const metadata = { sourceSha, sourceTree };
  const candidate = await makeRelease(outputRoot, metadata, 'surgery-a-candidate');
  const rollback = await makeRelease(outputRoot, metadata, 'forward-compatible-rollback');
  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    branch: surgery.IDENTITIES.branch,
    baseSha: surgery.IDENTITIES.baseSha,
    schemaMigrationDuringSurgeryA: true,
    forwardCompatibleRollbackRelease: 'BUILT',
    candidate,
    rollback
  }, null, 2)}\n`);
}

main().catch(error => {
  console.error(`${error.code || 'P1_BUILD_FAILED'}: ${error.message}`);
  process.exitCode = 1;
});
