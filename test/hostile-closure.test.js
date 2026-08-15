'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { LivingKernel } = require('../runtime');
const { CoreHostClient } = require('../runtime/kernel/core-host-client');
const { inspectCoreModule } = require('../runtime/kernel/core-loader');
const { validateHardwareEvidence } = require('../scripts/endurance-runner');

const fixture = name => path.join(__dirname, 'fixtures', 'cores', name);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function makeKernel(prefix) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const kernel = new LivingKernel({ dataDir, allowIdentityBootstrap: true, heartbeatIntervalMs: 0, snapshotIntervalMs: 0 });
  await kernel.start();
  return { kernel, dataDir };
}

test('H-01: required shadow overflow permanently blocks authority commit', async t => {
  const { kernel, dataDir } = await makeKernel('stay-shadow-closure-');
  t.after(async () => { if (kernel.stateStore.db) await kernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  await kernel.installCore(fixture('counter-v1.js'));
  await kernel.stageCoreUpgrade(fixture('slow-candidate.js'));
  for (let index = 0; index < 24; index++) await kernel.publish('test.tick', {});
  const slot = kernel.registry.get('test-counter');
  assert.equal((await slot.active.snapshot()).ticks, 24);
  await assert.rejects(() => kernel.commitCoreUpgrade('test-counter', { minEvents: 1 }), error => error.code === 'SHADOW_INCOMPLETE');
  assert.equal(kernel.stateStore.getAuthority('test-counter').epoch, 1);
  assert.equal(slot.active.manifest.version, '1.0.0');
});

test('H-02: abrupt Kernel restart preserves state and strictly advances sequence', async () => {
  const { kernel, dataDir } = await makeKernel('stay-restart-closure-');
  let restarted;
  try {
    await kernel.installCore(fixture('counter-v1.js'));
    for (let index = 0; index < 3; index++) await kernel.publish('test.tick', {});
    const beforeSequence = kernel.fabric.sequence;
    await kernel.registry.stop();
    kernel.stateStore.close();
    restarted = new LivingKernel({ dataDir, heartbeatIntervalMs: 0, snapshotIntervalMs: 0 });
    await restarted.start();
    assert.equal(restarted.fabric.sequence, beforeSequence);
    await restarted.installCore(fixture('counter-v1.js'));
    const values = [];
    restarted.fabric.subscribe('test.pulse', event => values.push(event.payload.ticks));
    const input = await restarted.publish('test.tick', {});
    assert.ok(input.sequence > beforeSequence);
    assert.equal(values.at(-1), 4);
  } finally {
    if (restarted?.stateStore.db) await restarted.stop().catch(() => {});
    if (kernel.stateStore.db) kernel.stateStore.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('H-03: unexpected CoreHost exit recovers the last acknowledged state', async t => {
  const { kernel, dataDir } = await makeKernel('stay-core-recovery-');
  t.after(async () => { if (kernel.stateStore.db) await kernel.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  await kernel.installCore(fixture('state-crash-core.js'));
  const values = [];
  kernel.fabric.subscribe('state.value', event => values.push(event.payload.value));
  for (let index = 0; index < 3; index++) await kernel.publish('state.tick', {});
  const slot = kernel.registry.get('test-state-crash');
  const generation = slot.active.client.generation;
  await kernel.publish('state.crash', {}).catch(() => {});
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && slot.active.client.generation === generation) await pause(20);
  await kernel.publish('state.tick', {});
  assert.equal(values.at(-1), 4);
});

test('H-04: production start refuses a Kernel without the SIGUSR1 inspector guard', () => {
  const script = `const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const {LivingKernel}=require('./runtime');(async()=>{const d=await fs.mkdtemp(path.join(os.tmpdir(),'stay-guard-'));try{await new LivingKernel({dataDir:d,allowIdentityBootstrap:true}).start()}catch(e){console.log(e.code);process.exit(e.code==='KERNEL_INSPECTOR_SIGNAL_UNSAFE'?0:2)}process.exit(3)})()`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, STAY_REQUIRE_CGROUPS: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /KERNEL_INSPECTOR_SIGNAL_UNSAFE/);
});

test('H-05: --disable-sigusr1 prevents a native core from activating the Kernel inspector', () => {
  const result = spawnSync(process.execPath, ['--disable-sigusr1', path.join(__dirname, 'fixtures', 'kernel-inspector-harness.js')], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Debugger listening/);
});

test('H-06: empty asserted hardware evidence cannot pass certification validation', () => {
  const evidence = {
    format: 'stay-hardware-evidence-v1', runId: 'stay-audit-run-0001', durationMs: 72 * 3600000,
    startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-04T00:00:00.000Z',
    nodes: ['ryzen-desktop', 'desktop-gpu', 'second-gpu', 'cpu-only', 'mobile'].map((kind, index) => ({ id: `n${index}`, kind, samples: [] })),
    checks: { gpuDutyTolerance: true, cpuQuietRyzen: true, viewerFreezeBackoff: true, memoryStable: true, reconnects: true, faultRecovery: true }
  };
  const failures = validateHardwareEvidence(evidence, '72h', 72 * 3600000);
  assert.ok(failures.some(failure => failure.includes('insufficient raw samples')));
  assert.ok(validateHardwareEvidence(evidence, '72h', 72 * 3600000, 'different-run-0002')
    .some(failure => failure.includes('does not match')));
});

test('H-07: CoreHost log forwarding is rate and byte bounded', () => {
  let forwarded = 0;
  const logger = { log: () => { forwarded++; }, info: () => { forwarded++; }, warn: () => { forwarded++; }, error: () => { forwarded++; } };
  const client = new CoreHostClient({ modulePath: fixture('counter-v1.js'), logger });
  for (let index = 0; index < 1000; index++) client.forwardLog('info', ['x'.repeat(2000)]);
  assert.ok(forwarded <= 40);
  assert.ok(client.suppressedLogs >= 960);
});

test('H-08: timed-out manifest inspection reaps its child', async () => {
  await assert.rejects(() => inspectCoreModule(fixture('blocking-inspector-core.js'), 100), error => error.code === 'CORE_INSPECT_TIMEOUT');
});

test('H-08b: manifest inspection authorizes the immutable target behind a release symlink', async t => {
  const linkRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-release-link-'));
  t.after(() => fs.rm(linkRoot, { recursive: true, force: true }));
  const current = path.join(linkRoot, 'current');
  await fs.symlink(path.join(__dirname, '..'), current, 'dir');
  const inspected = await inspectCoreModule(path.join(current, 'test', 'fixtures', 'cores', 'counter-v1.js'));
  assert.equal(inspected.modulePath, fixture('counter-v1.js'));
  assert.equal(inspected.manifest.coreId, 'test-counter');
  assert.equal(inspected.manifest.version, '1.0.0');
});

test('H-09: third-party workflow actions are pinned to immutable commits', async () => {
  const workflowDir = path.join(__dirname, '..', '.github', 'workflows');
  for (const name of await fs.readdir(workflowDir)) {
    const source = await fs.readFile(path.join(workflowDir, name), 'utf8');
    for (const match of source.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)) {
      assert.match(match[1], /^[0-9a-f]{40}$/, `${name} contains a mutable action reference: ${match[0].trim()}`);
    }
  }
});

test('H-10: workflows with remote writes require explicit manual dispatch', async () => {
  const workflowDir = path.join(__dirname, '..', '.github', 'workflows');
  for (const name of await fs.readdir(workflowDir)) {
    const source = await fs.readFile(path.join(workflowDir, name), 'utf8');
    if (!/\b(?:scp|ssh)\b/.test(source)) continue;
    assert.match(source, /^\s{2}workflow_dispatch:\s*$/m, `${name} is not manual-only`);
    assert.doesNotMatch(source, /^\s{2}push:\s*$/m, `${name} writes remotely on push`);
  }
});

test('H-11: staging archive includes tests and release provenance', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', '.github', 'workflows', 'stage-lightsail-0.7.yml'), 'utf8');
  assert.match(source, /RELEASE_PROVENANCE\.json/);
  assert.match(source, /\.github runtime cores deploy docs scripts legacy test\s*$/m);
  assert.match(source, /"\$ARCHIVE" "\$ARCHIVE\.sha256"/);
});

test('H-12: production launcher and deployer enforce inspector, digest and provenance guards', async () => {
  const root = path.join(__dirname, '..');
  const service = await fs.readFile(path.join(root, 'deploy', 'systemd', 'stay.service'), 'utf8');
  const deployer = await fs.readFile(path.join(root, 'deploy', 'stay-deploy.sh'), 'utf8');
  const gitDeployer = await fs.readFile(path.join(root, 'deploy', 'stay-deploy-git.sh'), 'utf8');
  assert.match(service, /ExecStart=.*node --disable-sigusr1 .*server\.js/);
  assert.match(deployer, /ARCHIVE\.sha256/);
  assert.match(deployer, /RELEASE_PROVENANCE\.json/);
  assert.match(deployer, /manual recovery is required/);
  assert.match(deployer, /Pre-v3 dataset detected; validating migration inputs/);
  assert.match(deployer, /StateStore v3 database was not created by the candidate/);
  assert.match(deployer, /StateStore v3 migration\/integrity: OK/);
  assert.match(gitDeployer, /install -d -o "\$STAY_USER" -g "\$STAY_USER" -m 0750 "\$INCOMING"/);
  assert.ok(gitDeployer.indexOf('chown "$STAY_USER:$STAY_USER" "$BUILD_DIR"') < gitDeployer.indexOf('git -C "$SOURCE" archive'));
});
