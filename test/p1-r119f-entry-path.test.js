'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const script = path.resolve(__dirname,
  '../deploy/live-physiology-transplant/p1-r119f-entry-preflight.js');
const { transitionFailures } = require(script);
const FINAL_COMMITTED_THROUGH_US = (49 * 3_600_000_000) + (6 * 250_000);

test('R119F-ENTRY-00 bounded entry failures retain exact predicate evidence', () => {
  const healthy = {
    committedThroughUs: FINAL_COMMITTED_THROUGH_US,
    expectedCommittedThroughUs: FINAL_COMMITTED_THROUGH_US,
    healthOk: true,
    elapsedMs: 249.999,
    workerTransitionTimeoutMs: 250,
    ipcTransitionTimeoutMs: 1000,
    osSandboxRequired: true,
    inspectorSandboxed: true,
    payloadSandboxed: true,
    cgroupRequired: true,
    payloadCgroupRequired: true,
    payloadCgroupAvailable: true,
    payloadCpuMax: '20000 100000',
    payloadMemoryHigh: String(64 * 1024 * 1024),
    payloadMemoryMax: String(96 * 1024 * 1024),
    payloadPidsMax: '16',
    supervisorChargedToKernel: true,
    payloadAttachedBeforeInit: true,
    payloadProcessCount: 1,
    observedOutputs: 0,
    outputLimitPerEvent: 0,
  };
  assert.deepEqual(transitionFailures(healthy), []);
  assert.deepEqual(transitionFailures({
    ...healthy,
    committedThroughUs: null,
    healthOk: false,
    elapsedMs: 1000,
    inspectorSandboxed: false,
    payloadCpuMax: '20001 100000',
    observedOutputs: 1,
  }), [
    'COMMITTED_THROUGH_US',
    'HEALTH',
    'IPC_DEADLINE',
    'OS_CONTAINMENT',
    'PAYLOAD_CGROUP_CONTAINMENT',
    'OUTPUT_LIMIT',
  ]);
});

test('R119F-ENTRY-01 real CoreHost dispatch drains a 49-hour gap in bounded slices', () => {
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
  assert.equal(proof.version, '1.0.0-c3rc.5');
  assert.equal(proof.committedThroughUs, FINAL_COMMITTED_THROUGH_US);
  assert.equal(proof.elapsedSlicesMs.length, 7);
  assert.ok(Math.max(...proof.elapsedSlicesMs) < 250, JSON.stringify(proof.elapsedSlicesMs));
  assert.equal(proof.declaredHandlerTimeoutMs, 250);
  assert.equal(proof.workerTransitionTimeoutMs, 250);
  assert.equal(proof.ipcTransitionTimeoutMs, 1000);
  assert.equal(proof.productionEligible, false);
  assert.equal(proof.inspectorSandboxed, false);
  assert.equal(proof.payloadSandboxed, false);
  assert.equal(proof.hardCpuPercent, 20);
  assert.equal(proof.hardRamMiB, 96);
});

test('R119F-ENTRY-02 guarded deployment mirrors the independent payload quota topology', () => {
  const forwardPath = path.resolve(__dirname,
    '../deploy/live-physiology-transplant/p1-r119f-forward.sh');
  if (!fs.existsSync(forwardPath)) return;
  const forward = fs.readFileSync(forwardPath, 'utf8');
  assert.match(forward, /systemd-run[\s\S]*--property=Delegate=yes/);
  assert.match(forward, /p1-r119f-entry-preflight\.js/);
  assert.match(forward, /STAY_REQUIRE_OS_CORE_SANDBOX=1/);
  assert.match(forward, /STAY_REQUIRE_CGROUPS=1/);
  assert.match(forward, /STAY_REQUIRE_CORE_PACKAGE_POLICY=1/);
  assert.match(forward, /payloadCpuMax\)" == '20000 100000'/);
  assert.match(forward, /supervisorChargedToKernel\)" == true/);
  assert.match(forward, /payloadAttachedBeforeInit\)" == true/);
  assert.doesNotMatch(forward, /--property=CPUQuota=20%/);
  assert.doesNotMatch(forward, /handlerTimeoutMs\s*[=:]\s*(?:25[1-9]|2[6-9][0-9]|[3-9][0-9]{2,})/);
});

test('R119F-ENTRY-03 Bubblewrap is the real entry path on Linux', {
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
