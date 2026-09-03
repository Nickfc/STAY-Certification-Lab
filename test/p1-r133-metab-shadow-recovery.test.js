'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LivingKernel } = require('../runtime/kernel/living-kernel');
const { publicMetadata } = require('../server');

const NORMAL_AUTH =
  'AUTHORIZE_R128_METAB_NEUTRAL_TO_OUTPUT_FIREWALLED_SHADOW_ONLY';
const RECOVERY_AUTH =
  'AUTHORIZE_R133_METAB_NEUTRAL_TO_OUTPUT_FIREWALLED_SHADOW_RECOVERY_ONLY';
const ROOT = path.resolve(__dirname, '..');
const FORWARD = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'p1-r133-metab-shadow-forward-recovery.sh');
const MANIFEST = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'P1_PRODUCTION_HARDENING_R131_TO_R133.sha256');

function guardHarness({
  revision,
  normalAuthorization = '',
  recoveryAuthorization = '',
  runtimeFreezeDirectory
}) {
  return {
    allowMetabShadowPromotion: true,
    metabShadowPromotionAuthorization: normalAuthorization,
    metabShadowRecoveryAuthorization: recoveryAuthorization,
    runtimeRevision: revision,
    runtimeFreezeDirectory
  };
}

test('R133-RECOVERY-01 normal and recovery authorizations remain revision-separated', async t => {
  const freezeDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'stay-r133-promotion-guard-')
  );
  t.after(() => fs.rm(freezeDirectory, { recursive: true, force: true }));

  await assert.rejects(
    () => LivingKernel.prototype.promoteMetabShadow.call(guardHarness({
      revision: 133,
      normalAuthorization: NORMAL_AUTH,
      runtimeFreezeDirectory: freezeDirectory
    })),
    { code: 'P1_METAB_SHADOW_REVISION' }
  );
  await assert.rejects(
    () => LivingKernel.prototype.promoteMetabShadow.call(guardHarness({
      revision: 128,
      recoveryAuthorization: RECOVERY_AUTH,
      runtimeFreezeDirectory: freezeDirectory
    })),
    { code: 'P1_METAB_SHADOW_REVISION' }
  );
  await assert.rejects(
    () => LivingKernel.prototype.promoteMetabShadow.call(guardHarness({
      revision: 133,
      normalAuthorization: NORMAL_AUTH,
      recoveryAuthorization: RECOVERY_AUTH,
      runtimeFreezeDirectory: freezeDirectory
    })),
    { code: 'P1_METAB_SHADOW_NOT_AUTHORIZED' }
  );
});

test('R133-RECOVERY-02 exact recovery authorization reaches the unchanged R127F ancestry fence', async t => {
  const freezeDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'stay-r133-parent-freeze-')
  );
  t.after(() => fs.rm(freezeDirectory, { recursive: true, force: true }));

  await assert.rejects(
    () => LivingKernel.prototype.promoteMetabShadow.call(guardHarness({
      revision: 133,
      recoveryAuthorization: RECOVERY_AUTH,
      runtimeFreezeDirectory: freezeDirectory
    })),
    { code: 'P1_METAB_SHADOW_PARENT_FREEZE' }
  );
});

test('R133-WEB-03 Chronobiology deployment contract projects SHADOW over neutral oscillator health', () => {
  const metadata = publicMetadata({
    kernel: { runtimeRevision: 133 },
    cores: [],
    residencies: [{
      residencyId: 'resident:chronobiology',
      coreId: 'chronobiology',
      version: '1.0.0-c3rc.5',
      status: 'RUNNING',
      lifecycle: 'RUNNING',
      running: true,
      authorityOwned: false,
      observedOutputs: 1,
      health: { ok: true, mode: 'NEUTRAL' }
    }],
    biologicalLedger: {
      protocol: 'stay-biological-ledger-v1',
      events: 1,
      pendingDeliveries: 0,
      activeConsumers: 1
    },
    health: { ok: true, persistence: { ok: true, writeFailureCount: 0 } }
  });
  const resident = metadata.residents.find(row => row.coreId === 'chronobiology');
  const chip = metadata.chipProjection.lifecycle.find(row => row.coreId === 'chronobiology');
  assert.equal(resident.mode, 'SHADOW');
  assert.equal(chip.state, 'SHADOW');
  assert.equal(chip.observationOnly, true);
  assert.deepEqual(metadata.chipProjection.mutationEndpoints, []);
});

test('R133-REL-04 recovery is one-restart, forward-only after commit and preserves all limits', () => {
  const source = fsSync.readFileSync(FORWARD, 'utf8');
  assert.equal((source.match(/systemctl restart stay\.service/g) || []).length, 1);
  assert.equal((source.match(/systemctl start stay\.service/g) || []).length, 0);
  assert.match(source, /RESTART_COMMITTED=1\s+systemctl restart stay\.service/);
  assert.match(source, /RESTART_COMMITTED" -eq 0[\s\S]*?point_current "\$SOURCE_RELEASE"/);
  const committed = source.slice(source.indexOf('RESTART_COMMITTED=1'));
  assert.doesNotMatch(committed, /point_current "\$SOURCE_RELEASE"/);
  assert.match(source, /"\$\(durable_runtime_revision\)" == 131/);
  assert.match(source, /"\$\(durable_runtime_revision\)" == 133/);
  assert.match(source, /R133_METAB_SHADOW_FORWARD_RECOVERY_REQUIRED=YES/);
  assert.match(source, /STAY_METAB_SHADOW_PROMOTION_AUTHORIZATION=/);
  assert.match(source, /STAY_METAB_SHADOW_RECOVERY_AUTHORIZATION=/);
  assert.doesNotMatch(source,
    /TimeoutStartSec|TimeoutStopSec|CPUQuota=|handlerTimeoutMs\s*=(?!=)|git reset|git checkout|sqlite3\s+.*(?:DELETE|UPDATE)/);

  const policy = JSON.parse(fsSync.readFileSync(path.join(ROOT,
    'cores', 'p1-r0', 'metab-shadow', 'package-policy.json'), 'utf8'));
  assert.deepEqual(policy.resourceContract.manifestResources, {
    hardCpuPercent: 20, hardRamMiB: 96, handlerTimeoutMs: 250,
    healthTimeoutMs: 1000, maxRestarts: 4, outputBytesPerEvent: 65536,
    outputCapacity: 128, outputLimitPerEvent: 16, pidsMax: 16,
    queueCapacity: 256, restartBackoffMs: 250, restartWindowMs: 60000,
    softCpuPercent: 5, softRamMiB: 64, storageMiB: 4
  });
});

test('R133-REL-05 shell, embedded JavaScript and immutable overlay parse and hash exactly', () => {
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
    : 'bash';
  const source = fsSync.readFileSync(FORWARD, 'utf8');
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

  const entries = new Map();
  for (const line of fsSync.readFileSync(MANIFEST, 'utf8').trim().split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})  \.\/([A-Za-z0-9._/-]+)$/.exec(line);
    assert.ok(match, line);
    entries.set(match[2], match[1]);
  }
  assert.deepEqual([...entries.keys()], [
    'deploy/live-physiology-transplant/p1-r133-metab-shadow-forward-recovery.sh',
    'runtime/kernel/living-kernel.js',
    'server.js',
    'test/p1-r118f-release-contract.test.js',
    'test/p1-r119f-release-contract.test.js',
    'test/p1-r124-release-contract.test.js',
    'test/p1-r128-release-contract.test.js',
    'test/p1-r133-metab-shadow-recovery.test.js'
  ]);
  for (const [relative, expected] of entries) {
    const actual = crypto.createHash('sha256')
      .update(fsSync.readFileSync(path.join(ROOT, relative))).digest('hex');
    assert.equal(actual, expected, relative);
  }
});
