'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const FORWARD = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'p1-r141-metab-shadow-forward-recovery.sh');
const MANIFEST = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'P1_PRODUCTION_HARDENING_R139_TO_R141.sha256');
const SUCCESSOR_MANIFEST = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'P1_PRODUCTION_HARDENING_R141F_TO_R150.sha256');

test('R141-RECOVERY-01 is exact forward-only recovery of the existing shadow resident', () => {
  const source = fs.readFileSync(FORWARD, 'utf8');
  for (const exact of [
    "SOURCE_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r139-metab-shadow-recovery-6a343c91a536'",
    "SOURCE_MANIFEST_SHA256='6a343c91a536d9fab8147f9a214d05654e15f0221622b063477f53ea3212c981'",
    "SOURCE_MARKER='/run/stay-r139-metab-shadow-recovery.env'",
    'R139_RELEASE_COMMIT=532467bf2b46f6a992df5c5ea63de57dfd39b156',
    'R139_CONTROLLER_SHA256=sha256:13949ecef06065571296d34848cb54c50d01c741bfd5b5053b47c9fe807426f7',
    'prior_files=(R127.freeze.json R137.failure-marker.env before.proof.json database.before.json',
    '-S "$SOCKET"',
    "stat -Lc '%U:%G:%a' \"$SOCKET\"",
    'ss -xlpn',
    'exact-r139-failed-http-live-control-preflight-invalid',
    'status resident:sntss > "$WORK/sntss.before.current.json"',
    'status resident:chronobiology > "$WORK/chronobiology.before.current.json"',
    'status resident:metab > "$WORK/metab.before.current.json"',
    "s?.host?.instanceId==='8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f'",
    "c?.host?.instanceId==='f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a'",
    "m?.host?.instanceId==='d424c722-ef31-44b0-8201-ba68c418d14a'",
    'm?.host?.instanceId===before.metabInstanceId',
    "db.runtimeRevision===139",
    'db.pendingDeliveries>=0&&db.pendingDeliveries<=8',
    'validateCapacitySourceState(source',
    "row('resident:metab')?.version==='0.2.0-p1r0-shadow.1'",
    'state?.activation?.runtimeRevision===139',
    'source?.runtimeRevision===128',
    'db.runtimeRevision===141',
    'state?.lastAcceptedFrame>=before.metabAcceptedFrame',
    "chip('chronobiology')?.state==='SHADOW'",
    "chip('metab')?.state==='SHADOW'",
    'validateRevisionFreeze(record,141)',
    'repeatedPromotion:false'
  ]) assert.equal(source.includes(exact), true, exact);

  assert.equal((source.match(/systemctl restart stay\.service/g) || []).length, 1);
  assert.equal((source.match(/systemctl start stay\.service/g) || []).length, 0);
  assert.match(source, /RESTART_COMMITTED=1\s+systemctl restart stay\.service/);
  const committed = source.slice(source.indexOf('RESTART_COMMITTED=1'));
  assert.doesNotMatch(committed, /point_current "\$SOURCE_RELEASE"/);
  assert.match(source, /contained\(s\).*s\?\.observedOutputs===0/);
  assert.match(source, /contained\(c\).*c\?\.health\?\.mode==='NEUTRAL'/);
  assert.match(source, /contained\(m\).*m\?\.observedOutputs===0/);
});

test('R141-RECOVERY-02 cannot grant a second promotion capability or mutate biology directly', () => {
  const source = fs.readFileSync(FORWARD, 'utf8');
  assert.doesNotMatch(source,
    /STAY_ALLOW_METAB_SHADOW_PROMOTION|STAY_METAB_SHADOW_(?:PROMOTION|RECOVERY)_AUTHORIZATION|r141-metab-shadow-recovery-once\.conf/);
  assert.doesNotMatch(source,
    /TimeoutStartSec|TimeoutStopSec|CPUQuota=|MemoryMax=|PIDsMax=|git reset|git checkout|sqlite3\s+.*(?:DELETE|UPDATE)/);
  assert.match(source, /curl --fail --silent --max-time 3 http:\/\/127\.0\.0\.1:8788\//);
  assert.match(source, /db\.p1Authority===0/);
  assert.match(source, /db\.metabOutboxIntents===0/);
  assert.match(source, /m\?\.observedOutputs===0/);
});

test('R141-RECOVERY-03 shell and embedded JavaScript parse', () => {
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

test('R141-REL-04 immutable overlay hashes every changed dependency', () => {
  const entries = new Map();
  for (const line of fs.readFileSync(MANIFEST, 'utf8').trim().split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})  \.\/([A-Za-z0-9._/-]+)$/.exec(line);
    assert.ok(match, line);
    entries.set(match[2], match[1]);
  }
  const successorEntries = fs.existsSync(SUCCESSOR_MANIFEST)
    ? new Map(fs.readFileSync(SUCCESSOR_MANIFEST, 'utf8').trim().split(/\r?\n/).map(line => {
      const match = /^([0-9a-f]{64})  \.\/([A-Za-z0-9._/-]+)$/.exec(line);
      assert.ok(match, `invalid R150 successor manifest line: ${line}`);
      return [match[2], match[1]];
    })) : new Map();
  assert.deepEqual([...entries.keys()], [
    'deploy/live-physiology-transplant/p1-r141-metab-shadow-forward-recovery.sh',
    'runtime/kernel/living-kernel.js',
    'test/p1-r118f-release-contract.test.js',
    'test/p1-r119f-release-contract.test.js',
    'test/p1-r124-release-contract.test.js',
    'test/p1-r128-metab-shadow.test.js',
    'test/p1-r128-release-contract.test.js',
    'test/p1-r133-metab-shadow-recovery.test.js',
    'test/p1-r135-metab-shadow-recovery.test.js',
    'test/p1-r137-metab-shadow-recovery.test.js',
    'test/p1-r139-metab-shadow-recovery.test.js',
    'test/p1-r141-metab-shadow-recovery.test.js'
  ]);
  for (const [relative, expected] of entries) {
    const actual = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(ROOT, relative))).digest('hex');
    if (actual !== expected) {
      assert.equal(successorEntries.get(relative), actual,
        `${relative} drifted without exact R150 successor-manifest custody`);
    }
  }
});
