'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  LivingKernel,
  MAX_AUXILIARY_CORES,
  parseAuxiliaryCorePaths,
  installAuxiliaryCores,
  installPrimaryAndAuxiliary
} = require('../runtime');

test('auxiliary Core configuration is empty by default', () => {
  const paths = parseAuxiliaryCorePaths('');
  assert.deepEqual(paths, []);
  assert.equal(Object.isFrozen(paths), true);
});

test('auxiliary Core paths resolve deterministically and preserve declared order', () => {
  const cwd = path.join(process.cwd(), 'test-runtime-root');
  const paths = parseAuxiliaryCorePaths('cores/alpha/index.js, ./cores/beta/index.js', { cwd });
  assert.deepEqual(paths, [
    path.resolve(cwd, 'cores/alpha/index.js'),
    path.resolve(cwd, 'cores/beta/index.js')
  ]);
});

test('duplicate auxiliary Core paths fail closed', () => {
  assert.throws(
    () => parseAuxiliaryCorePaths(['cores/sntss/neutral/index.js', './cores/sntss/neutral/index.js']),
    error => error?.code === 'AUXILIARY_CORE_DUPLICATE'
  );
});

test('empty entries in auxiliary Core configuration fail closed', () => {
  assert.throws(
    () => parseAuxiliaryCorePaths('cores/sntss/neutral/index.js,'),
    error => error?.code === 'AUXILIARY_CORE_PATH_EMPTY'
  );
});

test('auxiliary Core count is bounded before installation', () => {
  const paths = Array.from({ length: MAX_AUXILIARY_CORES + 1 }, (_, index) => `cores/core-${index}/index.js`);
  assert.throws(
    () => parseAuxiliaryCorePaths(paths),
    error => error?.code === 'AUXILIARY_CORE_LIMIT'
  );
});

test('primary Core installs before auxiliary Cores in deterministic order', async () => {
  const primaryPath = path.resolve('cores/fetus-legacy-0.6/index.js');
  const auxiliaryCorePaths = [
    path.resolve('cores/sntss/neutral/index.js'),
    path.resolve('cores/kernel-probe/v1/index.js')
  ];
  const calls = [];

  const result = await installPrimaryAndAuxiliary({
    primaryPath,
    auxiliaryCorePaths,
    install: async modulePath => {
      calls.push(modulePath);
      return Object.freeze({ modulePath });
    }
  });

  assert.deepEqual(calls, [primaryPath, ...auxiliaryCorePaths]);
  assert.equal(result.primaryUnit.modulePath, primaryPath);
  assert.deepEqual(result.auxiliaryUnits.map(unit => unit.modulePath), auxiliaryCorePaths);
  assert.equal(Object.isFrozen(result.auxiliaryUnits), true);
});

test('primary/auxiliary duplicate is rejected before any Core is installed', async () => {
  const primaryPath = path.resolve('cores/sntss/neutral/index.js');
  let installCalls = 0;

  await assert.rejects(
    installPrimaryAndAuxiliary({
      primaryPath,
      auxiliaryCorePaths: [primaryPath],
      install: async () => {
        installCalls += 1;
        return {};
      }
    }),
    error => error?.code === 'AUXILIARY_CORE_PRIMARY_DUPLICATE'
  );

  assert.equal(installCalls, 0);
});

test('auxiliary-only boot installs every configured Core exactly once in order', async () => {
  const auxiliaryCorePaths = [
    path.resolve('cores/sntss/neutral/index.js'),
    path.resolve('cores/kernel-probe/v1/index.js')
  ];
  const calls = [];

  const units = await installAuxiliaryCores({
    auxiliaryCorePaths,
    install: async modulePath => {
      calls.push(modulePath);
      return { modulePath };
    }
  });

  assert.deepEqual(calls, auxiliaryCorePaths);
  assert.deepEqual(units.map(unit => unit.modulePath), auxiliaryCorePaths);
});

test('runtime refuses a different primary Core while configured auxiliaries are pending', async () => {
  const cwd = process.cwd();
  const kernel = new LivingKernel({
    dataDir: path.join(cwd, '.tmp-auxiliary-core-mismatch-not-started'),
    primaryBootCorePath: 'cores/fetus-legacy-0.6/index.js',
    auxiliaryCorePaths: ['cores/sntss/neutral/index.js'],
    auxiliaryCoreCwd: cwd,
    heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0
  });

  await assert.rejects(
    kernel.installCore(path.resolve(cwd, 'cores/kernel-probe/v1/index.js')),
    error => error?.code === 'AUXILIARY_CORE_PRIMARY_MISMATCH'
  );
});
