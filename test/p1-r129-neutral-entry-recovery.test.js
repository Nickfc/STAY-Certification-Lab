'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'p1-r129-neutral-entry-recovery.sh');
const source = fs.readFileSync(SCRIPT, 'utf8');

test('R129-ENTRY-01 recovery is exact, forward-only and one-restart bounded', () => {
  assert.match(source, /durable-r129-boundary-invalid/);
  assert.match(source, /sha256sum -c deploy\/live-physiology-transplant\/P1_PRODUCTION_HARDENING_R127F_TO_R128\.sha256/);
  assert.match(source, /"\$\(revision\)" == 129/);
  assert.match(source, /"\$\(revision\)" == 131/);
  assert.equal((source.match(/systemctl restart stay\.service/g) || []).length, 1);
  assert.doesNotMatch(source, /point_current|ln -s|git reset|git checkout|TimeoutStartSec|TimeoutStopSec|CPUQuota=/);
  assert.match(source, /R129_NEUTRAL_ENTRY_FORWARD_RECOVERY_REQUIRED=YES/);
});

test('R129-ENTRY-02 recovery preserves resident identities and containment', () => {
  for (const invariant of [
    'd424c722-ef31-44b0-8201-ba68c418d14a', '0.1.0-p1r0-neutral.1',
    '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f', '0.5.0-i4g1',
    'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a', '1.0.0-c3rc.5',
    'v.pendingDeliveries===0', 'v.pendingOutboxIntents===0', 'v.metabOutboxIntents===0',
    'v.p1Authority===0', 'm?.observedOutputs===0', 'm?.authorityOwned===false',
    "fetus?.version==='0.6.0'", "chip?.state==='NEUTRAL'"
  ]) assert.equal(source.includes(invariant), true, invariant);
});

test('R129-ENTRY-03 shell and embedded JavaScript parse', () => {
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
    : 'bash';
  const shell = spawnSync(bash, ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(shell.status, 0, `${shell.stdout}\n${shell.stderr}`);
  const blocks = [...source.matchAll(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/g)];
  assert.equal(blocks.length, 3);
  for (const block of blocks) {
    const result = spawnSync(process.execPath, ['--check', '-'], { input: block[1], encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
});
