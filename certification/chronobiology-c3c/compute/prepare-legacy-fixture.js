#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { SOURCE_FILES } = require('../../../cores/fetus-legacy-0.6');

const output = path.resolve(process.argv[2] || '');
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
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-c3c-legacy-material-'));
const archivePath = path.join(work, 'source.tar.gz');
const staging = path.join(work, 'staging');
const inventoryPath = path.join(work, 'SOURCE_FILES.json');
try {
  decryptMaterial(encryptedMaterial, archivePath);
  fs.chmodSync(archivePath, 0o600);
  fs.writeFileSync(inventoryPath, JSON.stringify(SOURCE_FILES), { mode: 0o600 });
  const verification = spawnSync('python3', [
    path.join(__dirname, 'legacy-fixture-transport.py'), 'verify-extract',
    '--inventory', inventoryPath, '--input', archivePath, '--output', staging,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (verification.status !== 0 || !verifySource(staging)) {
    fail('canonical legacy fixture files do not match SOURCE_FILES');
  }

  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(output, 'public'), { mode: 0o700 });
  fs.mkdirSync(path.join(output, 'data'), { mode: 0o700 });
  for (const relative of Object.keys(SOURCE_FILES)) {
    const target = path.join(output, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(staging, relative), target);
    fs.chmodSync(target, 0o444);
  }
  fs.chmodSync(path.join(output, 'data'), 0o555);
  fs.chmodSync(path.join(output, 'public'), 0o555);
  fs.chmodSync(output, 0o555);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
