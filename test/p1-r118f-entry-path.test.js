'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const script = path.resolve(__dirname,
  '../deploy/live-physiology-transplant/p1-r118f-entry-preflight.js');

test('R118F-ENTRY-01 real CoreHost dispatch crosses the unchanged 36-hour gap', () => {
  const result = spawnSync(process.execPath, [script], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      STAY_REQUIRE_OS_CORE_SANDBOX: '0',
      STAY_REQUIRE_CORE_PACKAGE_POLICY: '1',
      STAY_REQUIRE_CGROUPS: '0',
    },
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.result, 'PASS');
  assert.equal(proof.version, '1.0.0-c3rc.3');
  assert.equal(proof.committedThroughUs, 36 * 3_600_000_000);
  assert.equal(proof.declaredHandlerTimeoutMs, 250);
  assert.equal(proof.workerTransitionTimeoutMs, 250);
  assert.equal(proof.ipcTransitionTimeoutMs, 1000);
  assert.equal(proof.productionEligible, false);
  assert.equal(proof.inspectorSandboxed, false);
  assert.equal(proof.payloadSandboxed, false);
  assert.equal(proof.hardCpuPercent, 20);
  assert.equal(proof.hardRamMiB, 96);
});

test('R118F-ENTRY-02 guarded deployment includes an independent 20-percent quota entry path', () => {
  const forwardPath = path.resolve(__dirname,
    '../deploy/live-physiology-transplant/p1-r118f-forward.sh');
  if (!fs.existsSync(forwardPath)) return;
  const forward = fs.readFileSync(forwardPath, 'utf8');
  assert.match(forward, /systemd-run[\s\S]*CPUQuota=20%/);
  assert.match(forward, /p1-r118f-entry-preflight\.js/);
  assert.match(forward, /STAY_REQUIRE_OS_CORE_SANDBOX=1/);
  assert.match(forward, /STAY_REQUIRE_CORE_PACKAGE_POLICY=1/);
  assert.doesNotMatch(forward, /handlerTimeoutMs\s*[=:]\s*(?:25[1-9]|2[6-9][0-9]|[3-9][0-9]{2,})/);
});

test('R118F-ENTRY-03 Bubblewrap is the real entry path on Linux', {
  skip: process.platform !== 'linux' || !fs.existsSync(process.env.STAY_BWRAP || '/usr/bin/bwrap'),
}, () => {
  const result = spawnSync(process.execPath, [script], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      STAY_REQUIRE_OS_CORE_SANDBOX: '1',
      STAY_REQUIRE_CORE_PACKAGE_POLICY: '1',
      STAY_REQUIRE_CGROUPS: '0',
      STAY_BWRAP: process.env.STAY_BWRAP || '/usr/bin/bwrap',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.result, 'PASS');
  assert.equal(proof.osSandboxRequired, true);
  assert.equal(proof.inspectorSandboxed, true);
  assert.equal(proof.payloadSandboxed, true);
  assert.equal(proof.packagePolicyRequired, true);
});
