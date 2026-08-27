'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WRAPPER = path.join(ROOT,
  'deploy/live-physiology-transplant/stay-p1-production-controller');
const RELEASE_ID = '0.8.11.3-p1a1-resident-control-7d040592ccf1f149';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function makeWritable(root) {
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    const absolute = path.join(entry.parentPath || entry.path, entry.name);
    if (entry.isDirectory()) fs.chmodSync(absolute, 0o700);
    else if (entry.isFile()) fs.chmodSync(absolute, 0o600);
  }
  fs.chmodSync(root, 0o700);
}

function verify(releaseRoot) {
  return spawnSync('/bin/bash', [
    '-c', 'source "$1"; NODE_BIN="$2"; verify_a1_release_identity "$3"',
    'p1-a1-staged-identity-test', WRAPPER, process.execPath, releaseRoot
  ], { encoding: 'utf8' });
}

const stagedReleaseSkip = process.platform !== 'linux'
  ? 'requires Linux release filesystem semantics'
  : process.env.P1_A1_RELEASE_ROOT
    ? false
    : 'requires a freshly built immutable A.1 release';

test('P1-A1-ID-01 real immutable A.1 build permits only the exact excluded data placeholder', {
  skip: stagedReleaseSkip,
}, t => {
  const source = process.env.P1_A1_RELEASE_ROOT;
  assert.equal(path.basename(source), RELEASE_ID);
  assert.equal(fs.statSync(source).isDirectory(), true);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-p1-a1-identity-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const release = path.join(temporary, RELEASE_ID);
  fs.cpSync(source, release, { recursive: true, dereference: false, verbatimSymlinks: true });
  makeWritable(release);

  const placeholder = path.join(release, 'data/.gitkeep');
  const placeholderStat = fs.lstatSync(placeholder);
  assert.equal(placeholderStat.isFile(), true);
  assert.equal(placeholderStat.isSymbolicLink(), false);
  assert.equal(placeholderStat.size, 0);
  assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(placeholder)).digest('hex'), EMPTY_SHA256);

  let result = verify(release);
  assert.equal(result.status, 0, `exact placeholder rejected: ${result.stderr}`);

  fs.writeFileSync(placeholder, 'changed\n');
  result = verify(release);
  assert.notEqual(result.status, 0, 'changed data/.gitkeep must be rejected');
  fs.writeFileSync(placeholder, '');

  const dataExtra = path.join(release, 'data/foo');
  fs.writeFileSync(dataExtra, 'forbidden\n');
  result = verify(release);
  assert.notEqual(result.status, 0, 'extra data/foo must be rejected');
  fs.unlinkSync(dataExtra);

  const inventory = path.join(release, 'RELEASE_INVENTORY.json');
  const inventoryBackup = path.join(temporary, 'RELEASE_INVENTORY.json');
  fs.renameSync(inventory, inventoryBackup);
  result = verify(release);
  assert.notEqual(result.status, 0, 'missing inventory must be rejected');
  fs.renameSync(inventoryBackup, inventory);

  const arbitrary = path.join(release, 'arbitrary-extra-file');
  fs.writeFileSync(arbitrary, 'forbidden\n');
  result = verify(release);
  assert.notEqual(result.status, 0, 'arbitrary extra file must be rejected');
});
