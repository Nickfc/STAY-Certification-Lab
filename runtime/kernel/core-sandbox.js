'use strict';

const path = require('node:path');

function nativeCoreExecArgv(modulePath) {
  const runtimeRoot = path.resolve(__dirname, '..');
  const coreRoot = path.dirname(path.resolve(modulePath));
  return [
    '--permission',
    `--allow-fs-read=${runtimeRoot}`,
    `--allow-fs-read=${coreRoot}`
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

module.exports = { nativeCoreExecArgv, coreHostEnvironment };
