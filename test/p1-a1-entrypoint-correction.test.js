'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { LivingKernel } = require('../runtime');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const {
  DEFAULT_SOCKET_PATH,
  createResidentControlDispatcher,
  createResidentControlServer
} = require('../runtime/kernel/resident-control-socket');

const ROOT = path.resolve(__dirname, '..');
const CORRECT = path.join(ROOT, 'deploy/live-physiology-transplant/p1-a1-entrypoint-correct.sh');
const PREFLIGHT = path.join(ROOT, 'deploy/live-physiology-transplant/p1-a1-entrypoint-preflight.sh');
const ROLLBACK = path.join(ROOT, 'deploy/live-physiology-transplant/p1-a1-entrypoint-rollback.sh');

test('P1-A1-ENTRY-01 fixed drop-in changes only ExecStart from legacy to secure entrypoint', () => {
  const correction = fs.readFileSync(CORRECT, 'utf8');
  const preflight = fs.readFileSync(PREFLIGHT, 'utf8');
  const legacy = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const secure = fs.readFileSync(path.join(ROOT, 'server-secure.js'), 'utf8');
  const heredoc = correction.match(/<<'DROPIN'\n([\s\S]*?)\nDROPIN/);
  assert.ok(heredoc, 'fixed systemd drop-in must be embedded literally');
  assert.equal(heredoc[1], [
    '[Service]',
    'ExecStart=',
    'ExecStart=/usr/bin/env node --disable-sigusr1 /opt/stay/current/server-secure.js'
  ].join('\n'));
  assert.deepEqual(heredoc[1].split('\n').filter(line => line && line !== '[Service]')
    .map(line => line.split('=')[0]), ['ExecStart', 'ExecStart']);
  assert.doesNotMatch(legacy, /installResidentControlSocket/);
  assert.match(secure, /installResidentControlSocket\(\)/);
  assert.match(preflight, /resident-control-socket-unexpected/);
});

test('P1-A1-ENTRY-02 secure startup creates the local socket and status attaches neither allowlisted resident', async t => {
  let listened = null;
  let socketMode = null;
  class FakeServer extends EventEmitter {
    listen(socketPath, callback) { listened = socketPath; callback(); }
    close(callback) { callback(); }
  }
  t.mock.method(net, 'createServer', () => new FakeServer());
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'lstat', async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); });
  t.mock.method(fsp, 'chmod', async (_file, mode) => { socketMode = mode; });
  t.mock.method(fsp, 'unlink', async () => {});

  const contracts = new Map([
    ['resident:sntss', { residencyId: 'resident:sntss', coreId: 'sntss', version: '0.4.0-i3d3', stateSchema: 4, priority: 'optional', productionEligible: false, signalling: 'FORBIDDEN', outputs: [] }],
    ['resident:chronobiology', { residencyId: 'resident:chronobiology', coreId: 'chronobiology', version: '1.0.0-c3rc.1', stateSchema: 2, priority: 'optional', productionEligible: false, signalling: 'LAB_SHADOW_ONLY', outputs: ['chronobiology.phase.summary'] }]
  ]);
  let mutations = 0;
  const kernel = {
    ensureResidentManager: () => ({ contractRegistry: { byResidencyId: contracts }, units: new Map() }),
    stateStore: { getResident: () => null },
    attachResident: async () => { mutations += 1; },
    detachResident: async () => { mutations += 1; }
  };
  const control = createResidentControlServer({ kernel, logger: { warn() {}, error() {} } });
  await control.start();
  assert.equal(control.started, true);
  assert.equal(listened, DEFAULT_SOCKET_PATH);
  assert.equal(socketMode, 0o600);
  const dispatch = createResidentControlDispatcher(kernel);
  for (const residencyId of ['resident:sntss', 'resident:chronobiology']) {
    const result = await dispatch({ format: 'stay-resident-control-v1', operation: 'status', residencyId });
    assert.equal(result.ok, true);
    assert.equal(result.resident.present, false);
  }
  assert.equal(mutations, 0);
  await control.stop();
});

test('P1-A1-ENTRY-03 correction is one restart and rollback removes only the exact drop-in without restart', () => {
  const correction = fs.readFileSync(CORRECT, 'utf8');
  const rollback = fs.readFileSync(ROLLBACK, 'utf8');
  assert.equal((correction.match(/systemctl restart stay\.service/g) || []).length, 1);
  assert.equal((correction.match(/systemctl daemon-reload/g) || []).length, 1);
  assert.match(correction, /p1-a1-resident-control\.conf/);
  assert.doesNotMatch(correction, /attachResident|detachResident|\b(?:INSERT|UPDATE|DELETE)\b|\/opt\/stay\/current.*(?:ln|mv)/);
  assert.match(rollback, /rm -- "\$DROPIN"/);
  assert.equal((rollback.match(/systemctl daemon-reload/g) || []).length, 1);
  assert.doesNotMatch(rollback, /systemctl (?:restart|start|stop) stay\.service|\brestore\b|\bsnapshot\b|attachResident|detachResident/);
});

test('P1-A1-ENTRY-04 controlled entrypoint restart preserves authority identity and advances checkpoints only forward', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stay-p1-a1-entrypoint-restart-'));
  const dataDir = path.join(root, 'state');
  const corePath = path.join(ROOT, 'test/fixtures/cores/counter-v1.js');
  let first = new LivingKernel({ dataDir, allowIdentityBootstrap: true, heartbeatIntervalMs: 0, snapshotIntervalMs: 0, trustedTimePulseIntervalMs: 0 });
  let restarted = null;
  t.after(async () => {
    if (first?.stateStore?.db) await first.stop().catch(() => {});
    if (restarted?.stateStore?.db) await restarted.stop().catch(() => {});
    await fsp.rm(root, { recursive: true, force: true });
  });
  await first.start();
  await first.installCore(corePath);
  await first.publish('test.tick', {});
  const authorityBefore = first.stateStore.getAuthority('test-counter');
  const checkpointBefore = await first.stateStore.readAuthoritativeCheckpoint('test-counter');
  const identityBefore = crypto.createHash('sha256').update(stableStringify(first.identity)).digest('hex');
  const tuple = value => ({ coreId: value.coreId, instanceId: value.instanceId, version: value.version, epoch: value.epoch, barrierSequence: value.barrierSequence });
  await first.stop();
  first = null;
  restarted = new LivingKernel({ dataDir, heartbeatIntervalMs: 0, snapshotIntervalMs: 0, trustedTimePulseIntervalMs: 0 });
  await restarted.start();
  await restarted.installCore(corePath);
  const authorityAfter = restarted.stateStore.getAuthority('test-counter');
  const checkpointAfter = await restarted.stateStore.readAuthoritativeCheckpoint('test-counter');
  const identityAfter = crypto.createHash('sha256').update(stableStringify(restarted.identity)).digest('hex');
  assert.deepEqual(tuple(authorityAfter), tuple(authorityBefore));
  assert.equal(identityAfter, identityBefore);
  assert.ok(checkpointAfter.generation >= checkpointBefore.generation);
  assert.equal(checkpointAfter.instanceId, checkpointBefore.instanceId);
  assert.equal(checkpointAfter.authorityEpoch, checkpointBefore.authorityEpoch);
});
