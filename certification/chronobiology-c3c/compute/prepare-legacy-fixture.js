#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { SOURCE_FILES } = require('../../../cores/fetus-legacy-0.6');

const root = path.resolve(__dirname, '../../..');
const output = path.resolve(process.argv[2] || '');
const archiveDigestFile = path.join(root, 'legacy/0.6.0/SOURCE_ARCHIVE_SHA256');
const encryptedMaterial = path.resolve(
  process.env.STAY_LEGACY_0_6_SOURCE_TAR_GZ_GPG || '',
);
const passphrase = process.env.STAY_LEGACY_0_6_FIXTURE_PASSPHRASE;

function fail(message) {
  throw Object.assign(new Error(message), { code: 'C3C_LEGACY_FIXTURE_INVALID' });
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function runTar(args) {
  const result = spawnSync('tar', args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) fail('canonical legacy fixture archive could not be processed');
  return result.stdout;
}

function decryptMaterial(encrypted, archive) {
  const result = spawnSync('gpg', [
    '--quiet', '--batch', '--yes', '--pinentry-mode', 'loopback',
    '--passphrase-fd', '0', '--output', archive, '--decrypt', encrypted,
  ], {
    input: `${passphrase}\n`,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) fail('canonical legacy fixture material could not be decrypted');
}

function safeArchiveNames(archive) {
  const names = runTar(['-tzf', archive]).split(/\r?\n/).filter(Boolean);
  if (names.length === 0 || names.length > 256) fail('legacy fixture archive inventory is invalid');
  for (const name of names) {
    if (name.includes('\0') || path.posix.isAbsolute(name)
      || name.split('/').some(part => part === '..')) {
      fail('legacy fixture archive contains an unsafe path');
    }
  }
}

function candidateDirectories(staging) {
  const candidates = new Set([staging, path.join(staging, 'source/0.6.0')]);
  const queue = [{ directory: staging, depth: 0 }];
  while (queue.length) {
    const { directory, depth } = queue.shift();
    if (depth > 4) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail('legacy fixture archive contains a symbolic link');
      if (entry.isDirectory()) queue.push({ directory: target, depth: depth + 1 });
      else if (!entry.isFile()) fail('legacy fixture archive contains a non-file entry');
    }
    if (fs.existsSync(path.join(directory, 'server.js'))) candidates.add(directory);
  }
  return [...candidates];
}

function verifySource(candidate) {
  for (const [relative, expected] of Object.entries(SOURCE_FILES)) {
    const file = path.join(candidate, relative);
    let stat;
    try { stat = fs.lstatSync(file); } catch { return false; }
    if (!stat.isFile() || stat.isSymbolicLink() || sha256(fs.readFileSync(file)) !== expected) {
      return false;
    }
  }
  return true;
}

if (!output || output === path.parse(output).root) fail('legacy fixture output is invalid');
if (!encryptedMaterial || encryptedMaterial === path.parse(encryptedMaterial).root
  || !fs.existsSync(encryptedMaterial) || !fs.lstatSync(encryptedMaterial).isFile()
  || typeof passphrase !== 'string' || passphrase.length < 20) {
  fail('canonical legacy fixture material is unavailable');
}
const expectedArchiveDigest = fs.readFileSync(archiveDigestFile, 'utf8').trim().split(/\s+/)[0];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-c3c-legacy-material-'));
const archivePath = path.join(work, 'source.tar.gz');
const staging = path.join(work, 'staging');
try {
  decryptMaterial(encryptedMaterial, archivePath);
  fs.chmodSync(archivePath, 0o600);
  if (sha256(fs.readFileSync(archivePath)) !== expectedArchiveDigest) {
    fail('canonical legacy fixture archive hash mismatch');
  }
  fs.mkdirSync(staging, { mode: 0o700 });
  safeArchiveNames(archivePath);
  runTar(['-xzf', archivePath, '-C', staging, '--no-same-owner', '--no-same-permissions']);
  const source = candidateDirectories(staging).find(verifySource);
  if (!source) fail('canonical legacy fixture files do not match the sealed inventory');

  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(output, 'public'), { mode: 0o700 });
  fs.mkdirSync(path.join(output, 'data'), { mode: 0o700 });
  for (const relative of Object.keys(SOURCE_FILES)) {
    const target = path.join(output, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(source, relative), target);
    fs.chmodSync(target, 0o444);
  }
  fs.chmodSync(path.join(output, 'data'), 0o555);
  fs.chmodSync(path.join(output, 'public'), 0o555);
  fs.chmodSync(output, 0o555);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
