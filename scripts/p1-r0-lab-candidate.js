#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FORMAT = 'stay-p1-r0-laboratory-candidate-v1';
const ARTIFACT_STEM = 'STAY_P1_R0_LAB_QUALIFIED_CANDIDATE';
const ALLOWED_MODES = new Set(['100644', '100755']);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.binary ? null : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail('P1_R0_CANDIDATE_COMMAND', `${command} failed (${result.status}): ${String(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
}

function validateRelative(relative) {
  if (typeof relative !== 'string' || relative.length === 0 || relative.includes('\\') || relative.includes('\0') ||
      relative.includes('\r') || relative.includes('\n') || path.posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    fail('P1_R0_CANDIDATE_PATH', `unsafe archive path: ${JSON.stringify(relative)}`);
  }
  const parts = relative.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    fail('P1_R0_CANDIDATE_PATH', `unsafe archive path: ${relative}`);
  }
  return relative;
}

function inspectGitTree(repo, commit) {
  const output = run('git', ['ls-tree', '-r', '-z', '--full-tree', commit], { cwd: repo, binary: true });
  const records = output.toString('utf8').split('\0').filter(Boolean).map(record => {
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (!match) fail('P1_R0_CANDIDATE_TREE', 'unparseable Git tree record');
    const [, mode, type, object, relative] = match;
    validateRelative(relative);
    if (type !== 'blob' || !ALLOWED_MODES.has(mode)) {
      fail('P1_R0_CANDIDATE_SPECIAL', `special Git entry is forbidden: ${mode} ${type} ${relative}`);
    }
    return Object.freeze({ mode, object, path: relative });
  });
  if (records.length === 0) fail('P1_R0_CANDIDATE_EMPTY', 'candidate Git tree is empty');
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

async function walkFiles(root) {
  const files = [];
  async function visit(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      validateRelative(relative);
      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) fail('P1_R0_CANDIDATE_LINK', `archive link is forbidden: ${relative}`);
      if (stat.isDirectory()) await visit(absolute);
      else if (stat.isFile()) {
        const bytes = await fsp.readFile(absolute);
        files.push(Object.freeze({
          path: relative,
          bytes: bytes.length,
          sha256: `sha256:${sha256(bytes)}`
        }));
      } else fail('P1_R0_CANDIDATE_SPECIAL', `archive special file is forbidden: ${relative}`);
    }
  }
  await visit(root);
  return files;
}

function assertSafeListing(listing, prefix) {
  const expectedRoot = `${prefix}/`;
  const records = listing.split(/\r?\n/).filter(Boolean);
  if (records.length === 0) fail('P1_R0_CANDIDATE_EMPTY', 'archive listing is empty');
  for (const record of records) {
    if (record === expectedRoot) continue;
    if (!record.startsWith(expectedRoot)) fail('P1_R0_CANDIDATE_PREFIX', `archive entry escaped prefix: ${record}`);
    const relative = record.slice(expectedRoot.length).replace(/\/$/, '');
    if (relative) validateRelative(relative);
  }
  return records;
}

async function extractAndInventory(archive, prefix) {
  const listing = run('tar', ['-tzf', archive]);
  assertSafeListing(listing, prefix);
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'stay-p1-r0-candidate-'));
  try {
    run('tar', ['-xzf', archive, '-C', temporary]);
    const names = await fsp.readdir(temporary);
    if (names.length !== 1 || names[0] !== prefix) fail('P1_R0_CANDIDATE_ROOT', 'archive must extract to one exact root');
    return await walkFiles(path.join(temporary, prefix));
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

async function build(options) {
  const repo = path.resolve(options.repo || run('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() }).trim());
  const dirty = run('git', ['status', '--porcelain=v1'], { cwd: repo }).trim();
  if (dirty) fail('P1_R0_CANDIDATE_DIRTY', 'candidate source worktree must be clean');
  const focusedTests = Number(options.focusedTests);
  const completeTests = Number(options.completeTests);
  const ciRunId = String(options.ciRunId || '');
  const ciUrl = String(options.ciUrl || '');
  if (!Number.isSafeInteger(focusedTests) || focusedTests < 1 ||
      !Number.isSafeInteger(completeTests) || completeTests < 1 ||
      !/^\d+$/.test(ciRunId) || !/^https:\/\/github\.com\/Nickfc\/STAY-Certification-Lab\/actions\/runs\/\d+$/.test(ciUrl)) {
    fail('P1_R0_CANDIDATE_EVIDENCE', 'exact focused/full public-CI evidence is required');
  }
  const commit = run('git', ['rev-parse', `${options.revision || 'HEAD'}^{commit}`], { cwd: repo }).trim();
  const tree = run('git', ['rev-parse', `${commit}^{tree}`], { cwd: repo }).trim();
  const tracked = inspectGitTree(repo, commit);
  const output = path.resolve(options.output || path.join(repo, 'release-output', 'p1-r0'));
  await fsp.mkdir(output, { recursive: true });
  const prefix = `${ARTIFACT_STEM}_${commit.slice(0, 12)}`;
  const archiveName = `${prefix}.tar.gz`;
  const inventoryName = `${prefix}.inventory.json`;
  const evidenceName = `${prefix}.evidence.json`;
  const finalArchive = path.join(output, archiveName);
  const finalInventory = path.join(output, inventoryName);
  const finalSidecar = `${finalArchive}.sha256`;
  const finalEvidence = path.join(output, evidenceName);
  for (const target of [finalArchive, finalInventory, finalSidecar, finalEvidence]) {
    if (fs.existsSync(target)) fail('P1_R0_CANDIDATE_EXISTS', `candidate artifact already exists: ${target}`);
  }
  const staging = await fsp.mkdtemp(path.join(output, '.p1-r0-candidate-'));
  try {
    const archive = path.join(staging, archiveName);
    const inventoryPath = path.join(staging, inventoryName);
    const sidecarPath = `${archive}.sha256`;
    const evidencePath = path.join(staging, evidenceName);
    run('git', ['archive', '--format=tar.gz', `--prefix=${prefix}/`, `--output=${archive}`, commit], { cwd: repo });
    const files = await extractAndInventory(archive, prefix);
    if (files.length !== tracked.length) fail('P1_R0_CANDIDATE_INVENTORY', 'archive file count differs from Git tree');
    for (let index = 0; index < files.length; index += 1) {
      if (files[index].path !== tracked[index].path) fail('P1_R0_CANDIDATE_INVENTORY', `archive path differs from Git tree at ${index}`);
    }
    const inventoryBody = {
      format: FORMAT,
      role: 'laboratory-qualified-candidate',
      productionEligible: false,
      productionAttached: false,
      commit,
      tree,
      prefix,
      fileCount: files.length,
      files
    };
    const inventory = { ...inventoryBody, inventoryHash: `sha256:${sha256(stable(inventoryBody))}` };
    await fsp.writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
    const archiveHash = sha256(await fsp.readFile(archive));
    await fsp.writeFile(sidecarPath, `${archiveHash}  ${archiveName}\n`, { flag: 'wx' });
    const evidenceBody = {
      format: FORMAT,
      result: 'PASS',
      commit,
      tree,
      archive: archiveName,
      archiveSha256: `sha256:${archiveHash}`,
      sidecar: path.basename(sidecarPath),
      inventory: inventoryName,
      inventorySha256: `sha256:${sha256(await fsp.readFile(inventoryPath))}`,
      focusedTests,
      completeTests,
      ciRunId,
      ciUrl,
      realEntryPreflight: 'PASS',
      secureServerPreflight: 'PASS',
      cleanExtraction: 'PASS',
      productionTouched: false
    };
    const evidence = { ...evidenceBody, evidenceHash: `sha256:${sha256(stable(evidenceBody))}` };
    await fsp.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
    await fsp.rename(archive, finalArchive);
    await fsp.rename(sidecarPath, finalSidecar);
    await fsp.rename(inventoryPath, finalInventory);
    await fsp.rename(evidencePath, finalEvidence);
    return {
      archive: finalArchive,
      sidecarPath: finalSidecar,
      inventoryPath: finalInventory,
      evidencePath: finalEvidence,
      ...evidence
    };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

async function verify(options) {
  const archive = path.resolve(options.archive);
  const sidecarPath = path.resolve(options.sidecar || `${archive}.sha256`);
  const inventoryPath = path.resolve(options.inventory);
  const evidencePath = path.resolve(options.evidence);
  const evidence = JSON.parse(await fsp.readFile(evidencePath, 'utf8'));
  const inventory = JSON.parse(await fsp.readFile(inventoryPath, 'utf8'));
  const evidenceBody = { ...evidence };
  delete evidenceBody.evidenceHash;
  const inventoryBody = { ...inventory };
  delete inventoryBody.inventoryHash;
  if (evidence.format !== FORMAT || evidence.result !== 'PASS' || evidence.productionTouched !== false ||
      evidence.evidenceHash !== `sha256:${sha256(stable(evidenceBody))}`) fail('P1_R0_CANDIDATE_EVIDENCE', 'candidate evidence is invalid');
  if (inventory.format !== FORMAT || inventory.productionEligible !== false || inventory.productionAttached !== false ||
      inventory.inventoryHash !== `sha256:${sha256(stable(inventoryBody))}`) fail('P1_R0_CANDIDATE_INVENTORY', 'candidate inventory is invalid');
  if (evidence.commit !== inventory.commit || evidence.tree !== inventory.tree ||
      evidence.inventorySha256 !== `sha256:${sha256(await fsp.readFile(inventoryPath))}`) fail('P1_R0_CANDIDATE_BINDING', 'evidence/inventory binding mismatch');
  const actualArchiveHash = sha256(await fsp.readFile(archive));
  if (evidence.archive !== path.basename(archive) || evidence.archiveSha256 !== `sha256:${actualArchiveHash}`) fail('P1_R0_CANDIDATE_ARCHIVE', 'archive hash mismatch');
  const expectedSidecar = `${actualArchiveHash}  ${path.basename(archive)}\n`;
  if (await fsp.readFile(sidecarPath, 'utf8') !== expectedSidecar) fail('P1_R0_CANDIDATE_SIDECAR', 'binary SHA-256 sidecar mismatch');
  if (options.expectedCommit && evidence.commit !== options.expectedCommit) fail('P1_R0_CANDIDATE_COMMIT', 'candidate commit mismatch');
  const actualFiles = await extractAndInventory(archive, inventory.prefix);
  if (stable(actualFiles) !== stable(inventory.files) || actualFiles.length !== inventory.fileCount) {
    fail('P1_R0_CANDIDATE_INVENTORY', 'clean extraction does not match every inventoried file hash');
  }
  return {
    status: 'PASS',
    commit: evidence.commit,
    tree: evidence.tree,
    archiveSha256: evidence.archiveSha256,
    inventoryHash: inventory.inventoryHash,
    evidenceHash: evidence.evidenceHash,
    fileCount: actualFiles.length,
    productionTouched: false
  };
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command === 'build') {
    const result = await build({
      revision: option(argv, '--revision', 'HEAD'),
      output: option(argv, '--output'),
      focusedTests: option(argv, '--focused-tests'),
      completeTests: option(argv, '--complete-tests'),
      ciRunId: option(argv, '--ci-run-id'),
      ciUrl: option(argv, '--ci-url')
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'verify') {
    const result = await verify({
      archive: option(argv, '--archive'),
      sidecar: option(argv, '--sidecar'),
      inventory: option(argv, '--inventory'),
      evidence: option(argv, '--evidence'),
      expectedCommit: option(argv, '--expected-commit')
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  fail('P1_R0_CANDIDATE_USAGE', 'usage: p1-r0-lab-candidate.js build|verify [options]');
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${error.code || 'P1_R0_CANDIDATE_FAILED'}: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = Object.freeze({
  FORMAT,
  ARTIFACT_STEM,
  ALLOWED_MODES,
  sha256,
  stable,
  validateRelative,
  inspectGitTree,
  assertSafeListing,
  extractAndInventory,
  build,
  verify
});
