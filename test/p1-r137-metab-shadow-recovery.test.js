'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LivingKernel,
  R137_METAB_SHADOW_RECOVERY
} = require('../runtime/kernel/living-kernel');

const ROOT = path.resolve(__dirname, '..');
const FORWARD = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'p1-r137-metab-shadow-forward-recovery.sh');
const MANIFEST = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'P1_PRODUCTION_HARDENING_R135_TO_R137.sha256');
const SUCCESSOR_MANIFESTS = [
  'P1_PRODUCTION_HARDENING_R137_TO_R139.sha256',
  'P1_PRODUCTION_HARDENING_R139_TO_R141.sha256',
  'P1_PRODUCTION_HARDENING_R141F_TO_R150.sha256'
].map(name => path.join(ROOT, 'deploy', 'live-physiology-transplant', name));
const R137_AUTH =
  'AUTHORIZE_R137_METAB_NEUTRAL_TO_OUTPUT_FIREWALLED_SHADOW_RECOVERY_ONLY';

function guard({ revision, normal = '', recovery = '', freezeDirectory }) {
  return {
    allowMetabShadowPromotion: true,
    metabShadowPromotionAuthorization: normal,
    metabShadowRecoveryAuthorization: recovery,
    runtimeRevision: revision,
    runtimeFreezeDirectory: freezeDirectory
  };
}

test('R137-RECOVERY-01 exact authorization is fenced to durable revision 137', async t => {
  const freezeDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'stay-r137-guard-'));
  t.after(() => fsp.rm(freezeDirectory, { recursive: true, force: true }));
  await assert.rejects(
    () => LivingKernel.prototype.promoteMetabShadow.call(guard({
      revision: 135,
      recovery: R137_AUTH,
      freezeDirectory
    })),
    { code: 'P1_METAB_SHADOW_REVISION' }
  );
  await assert.rejects(
    () => LivingKernel.prototype.promoteMetabShadow.call(guard({
      revision: 137,
      normal: 'AUTHORIZE_R128_METAB_NEUTRAL_TO_OUTPUT_FIREWALLED_SHADOW_ONLY',
      recovery: R137_AUTH,
      freezeDirectory
    })),
    { code: 'P1_METAB_SHADOW_NOT_AUTHORIZED' }
  );
  await assert.rejects(
    () => LivingKernel.prototype.promoteMetabShadow.call(guard({
      revision: 137,
      recovery: R137_AUTH,
      freezeDirectory
    })),
    { code: 'P1_METAB_SHADOW_PARENT_FREEZE' }
  );
});

test('R137-RECOVERY-02 exact deployed health semantics remain fail closed', () => {
  assert.equal(R137_METAB_SHADOW_RECOVERY.runtimeRevision, 137);
  assert.equal(R137_METAB_SHADOW_RECOVERY.parentRevision, 127);
  assert.equal(R137_METAB_SHADOW_RECOVERY.sntssHealthMode, null);
  assert.equal(R137_METAB_SHADOW_RECOVERY.chronobiologyHealthMode, 'NEUTRAL');
  assert.equal(R137_METAB_SHADOW_RECOVERY.instanceId,
    'd424c722-ef31-44b0-8201-ba68c418d14a');
  assert.equal(R137_METAB_SHADOW_RECOVERY.outputPolicy,
    'FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT');

  const source = fs.readFileSync(path.join(ROOT, 'runtime', 'kernel', 'living-kernel.js'), 'utf8');
  assert.match(source,
    /promotion\.sntssHealthMode === null[\s\S]*sntss\?\.health\?\.mode !== undefined/);
  assert.match(source,
    /chronobiology\?\.health\?\.mode !==[\s\S]*promotion\.chronobiologyHealthMode/);
  assert.match(source, /authorizationCount !== 1/);
});

test('R137-REL-03 continuation is exact, one-restart and forward-only', () => {
  const source = fs.readFileSync(FORWARD, 'utf8');
  for (const exact of [
    "SOURCE_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r135-metab-shadow-recovery-0d123d94a809'",
    "SOURCE_MANIFEST_SHA256='0d123d94a809600922e96802be8012a0700260a0f6a5497c51f36c125af528ee'",
    "SOURCE_MARKER='/run/stay-r135-metab-shadow-recovery.env'",
    "PROMOTION_AUTHORIZATION='AUTHORIZE_R137_METAB_NEUTRAL_TO_OUTPUT_FIREWALLED_SHADOW_RECOVERY_ONLY'",
    'R135_CONTROLLER_SHA256=sha256:0cbc82d406e49447e39971dcabf04c7c7e10ce577949c58fe3ca5ab2d7c53f0c',
    "c?.health?.mode==='NEUTRAL'",
    "m?.health?.mode==='NEUTRAL'",
    'db.runtimeRevision===137',
    'state?.activation?.runtimeRevision===137',
    'source?.runtimeRevision===137',
    "chip('chronobiology')?.state==='SHADOW'",
    "chip('metab')?.state==='SHADOW'",
    'validateRevisionFreeze(record,137)'
  ]) assert.equal(source.includes(exact), true, exact);
  assert.equal((source.match(/systemctl restart stay\.service/g) || []).length, 1);
  assert.equal((source.match(/systemctl start stay\.service/g) || []).length, 0);
  assert.match(source, /RESTART_COMMITTED=1\s+systemctl restart stay\.service/);
  const committed = source.slice(source.indexOf('RESTART_COMMITTED=1'));
  assert.doesNotMatch(committed, /point_current "\$SOURCE_RELEASE"/);
  assert.match(source, /curl --fail --silent --max-time 3 http:\/\/127\.0\.0\.1:8788\//);
  assert.doesNotMatch(source, /meta\.before\.json/);
  assert.doesNotMatch(source,
    /TimeoutStartSec|TimeoutStopSec|CPUQuota=|git reset|git checkout|sqlite3\s+.*(?:DELETE|UPDATE)/);
});

test('R137-REL-04 shell and embedded JavaScript parse', () => {
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
    : 'bash';
  const source = fs.readFileSync(FORWARD, 'utf8');
  const shell = spawnSync(bash, ['-n', FORWARD], { encoding: 'utf8' });
  assert.equal(shell.status, 0, `${shell.stdout}\n${shell.stderr}`);
  const blocks = [...source.matchAll(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/g)];
  assert.equal(blocks.length, 6);
  for (const block of blocks) {
    const result = spawnSync(process.execPath, ['--check', '-'], {
      input: block[1], encoding: 'utf8'
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
});

test('R137-REL-05 immutable overlay hashes every changed production dependency', () => {
  const entries = new Map();
  for (const line of fs.readFileSync(MANIFEST, 'utf8').trim().split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})  \.\/([A-Za-z0-9._/-]+)$/.exec(line);
    assert.ok(match, line);
    entries.set(match[2], match[1]);
  }
  assert.deepEqual([...entries.keys()], [
    'cores/p1-r0/metab-shadow/index.js',
    'cores/p1-r0/metab-shadow/package-policy.json',
    'deploy/live-physiology-transplant/p1-r128-metab-shadow-live-proof.js',
    'deploy/live-physiology-transplant/p1-r137-metab-shadow-forward-recovery.sh',
    'runtime/kernel/living-kernel.js',
    'runtime/p1-r0/resident-package-hashes.json',
    'runtime/p1-r0/residents/metab-shadow.js',
    'test/p1-r118f-release-contract.test.js',
    'test/p1-r119f-release-contract.test.js',
    'test/p1-r124-release-contract.test.js',
    'test/p1-r128-metab-shadow.test.js',
    'test/p1-r128-release-contract.test.js',
    'test/p1-r133-metab-shadow-recovery.test.js',
    'test/p1-r135-metab-shadow-recovery.test.js',
    'test/p1-r137-metab-shadow-recovery.test.js'
  ]);
  const successorEntries = new Map();
  for (const successorManifest of SUCCESSOR_MANIFESTS) {
    if (!fs.existsSync(successorManifest)) continue;
    for (const line of fs.readFileSync(successorManifest, 'utf8').trim().split(/\r?\n/)) {
        const match = /^([0-9a-f]{64})  \.\/([A-Za-z0-9._/-]+)$/.exec(line);
        assert.ok(match, `invalid successor manifest line: ${line}`);
        successorEntries.set(match[2], match[1]);
    }
  }
  for (const [relative, expected] of entries) {
    const actual = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(ROOT, relative))).digest('hex');
    if (actual !== expected) {
      assert.equal(successorEntries.get(relative), actual,
        `${relative} drifted without exact successor-manifest custody`);
    }
  }
});
