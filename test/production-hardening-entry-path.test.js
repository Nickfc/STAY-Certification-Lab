'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const PREFLIGHT_PATH = path.join(
  __dirname,
  '..',
  'deploy',
  'live-physiology-transplant',
  'p1-production-hardening-preflight.js'
);

function runPreflight(args, env) {
  return spawnSync(process.execPath, [PREFLIGHT_PATH, ...args], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true
  });
}

test('the production preflight candidate inspection traverses the real Core loader', () => {
  const script = `
    'use strict';
    const preflight = require(${JSON.stringify(PREFLIGHT_PATH)});
    preflight.inspectFrozenI4().then(definition => {
      process.stdout.write(JSON.stringify({
        coreId: definition.manifest.coreId,
        version: definition.manifest.version,
        stateSchema: definition.manifest.stateSchema
      }));
    }).catch(error => {
      console.error(String(error && error.stack || error));
      process.exitCode = 1;
    });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      STAY_REQUIRE_OS_CORE_SANDBOX: '0',
      STAY_REQUIRE_CORE_PACKAGE_POLICY: '1',
      STAY_REQUIRE_CGROUPS: '0'
    },
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    coreId: 'sntss',
    version: '0.5.0-i4g1',
    stateSchema: 5
  });
});

test('the guarded forward path runs the real entry probe before the full preflight', () => {
  const forward = fs.readFileSync(path.join(
    __dirname,
    '..',
    'deploy',
    'live-physiology-transplant',
    'p1-production-hardening-forward.sh'
  ), 'utf8');
  const entryPhase = forward.indexOf("phase 'REAL ENTRY-PATH CANDIDATE INSPECTION'");
  const fullPhase = forward.indexOf("phase 'REAL OS-SANDBOX PREFLIGHT'");
  assert.ok(entryPhase >= 0 && fullPhase > entryPhase);
  const entryBlock = forward.slice(entryPhase, fullPhase);
  assert.match(entryBlock, /runuser -u staydeploy -- env -i/);
  assert.match(entryBlock, /STAY_REQUIRE_OS_CORE_SANDBOX=1/);
  assert.match(entryBlock, /STAY_REQUIRE_CORE_PACKAGE_POLICY=1/);
  assert.match(entryBlock, /STAY_REQUIRE_CGROUPS=0/);
  assert.match(entryBlock, /--candidate-inspection-only/);
  assert.match(entryBlock, /entry-path-preflight\.json/);
  assert.doesNotMatch(entryBlock, /STAY_REQUIRE_OS_CORE_SANDBOX=0/);
});

test('the real preflight CLI entry fails closed when its OS sandbox is unavailable', {
  skip: process.platform === 'linux'
}, () => {
  const result = runPreflight(['--candidate-inspection-only'], {
    NODE_ENV: 'production',
    STAY_REQUIRE_OS_CORE_SANDBOX: '1',
    STAY_REQUIRE_CORE_PACKAGE_POLICY: '1',
    STAY_REQUIRE_CGROUPS: '0',
    STAY_BWRAP: process.execPath
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(
    result.stderr,
    /P1_PRODUCTION_HARDENING_PREFLIGHT_ABORT=CORE_OS_SANDBOX_REQUIRED:/
  );
  assert.doesNotMatch(result.stderr, /path is not defined/);
});

test('the real preflight CLI entry passes through Bubblewrap on Linux', {
  skip: process.platform !== 'linux' || !fs.existsSync(process.env.STAY_BWRAP || '/usr/bin/bwrap')
}, () => {
  const result = runPreflight(['--candidate-inspection-only'], {
    NODE_ENV: 'production',
    STAY_REQUIRE_OS_CORE_SANDBOX: '1',
    STAY_REQUIRE_CORE_PACKAGE_POLICY: '1',
    STAY_REQUIRE_CGROUPS: '0',
    STAY_BWRAP: process.env.STAY_BWRAP || '/usr/bin/bwrap'
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.format, 'stay-production-hardening-entry-path-v1');
  assert.equal(proof.result, 'PASS');
  assert.equal(proof.osSandboxRequired, true);
  assert.equal(proof.packagePolicyRequired, true);
  assert.equal(proof.cgroupMutationDisabled, true);
  assert.equal(proof.coreId, 'sntss');
  assert.equal(proof.version, '0.5.0-i4g1');
  assert.equal(proof.stateSchema, 5);
});
