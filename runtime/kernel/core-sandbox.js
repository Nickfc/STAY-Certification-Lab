'use strict';

const fs = require('node:fs');
const path = require('node:path');

function realPathOrSelf(targetPath) {
  try { return fs.realpathSync.native(targetPath); }
  catch { return targetPath; }
}

function canonicalCoreModulePath(modulePath) {
  return fs.realpathSync.native(path.resolve(modulePath));
}

function nativeCoreExecArgv(modulePath) {
  const runtimeRoot = path.resolve(__dirname, '..');
  const absoluteModule = canonicalCoreModulePath(modulePath);
  const readRoots = new Set([
    runtimeRoot,
    realPathOrSelf(runtimeRoot),
    path.dirname(absoluteModule)
  ]);
  return [
    '--permission',
    ...Array.from(readRoots, root => `--allow-fs-read=${root}`)
  ];
}

function coreHostEnvironment({ compatibility = false } = {}) {
  if (compatibility) return { ...process.env, STAY_COREHOST: '1', STAY_COREHOST_COMPATIBILITY: '1' };
  const env = { STAY_COREHOST: '1' };
  for (const key of ['PATH', 'NODE_ENV', 'TZ', 'LANG', 'LC_ALL']) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  return env;
}

module.exports = { canonicalCoreModulePath, nativeCoreExecArgv, coreHostEnvironment };
