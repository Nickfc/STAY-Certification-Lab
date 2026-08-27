'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WORKER_PATH = path.join(__dirname, '..', 'core-host', 'worker.js');

function realPathOrSelf(targetPath) {
  try { return fs.realpathSync.native(targetPath); }
  catch { return targetPath; }
}

function sandboxNodeBinding(execPath = process.execPath) {
  const hostNodePath = realPathOrSelf(execPath);

  // /usr is already exposed read-only inside every native Core sandbox.
  if (hostNodePath.startsWith('/usr/')) {
    return Object.freeze({
      hostNodePath,
      nodePath: hostNodePath,
      args: Object.freeze([])
    });
  }

  // Node may legitimately live outside /usr. Expose only its executable
  // directory through a stable, read-only sandbox mount.
  const hostNodeBin = path.dirname(hostNodePath);
  const sandboxNodeRoot = '/stay-node';
  const sandboxNodeBin = path.posix.join(sandboxNodeRoot, 'bin');
  const nodePath = path.posix.join(
    sandboxNodeBin,
    path.basename(hostNodePath)
  );

  return Object.freeze({
    hostNodePath,
    nodePath,
    args: Object.freeze([
      '--dir', sandboxNodeRoot,
      '--ro-bind', hostNodeBin, sandboxNodeBin
    ])
  });
}

function canonicalCoreModulePath(modulePath) {
  return fs.realpathSync.native(path.resolve(modulePath));
}

function isLegacyCompatibilityCore(modulePath) {
  const normalized = canonicalCoreModulePath(modulePath).split(path.sep).join('/');
  return /\/cores\/fetus-legacy-0\.6\/index\.js$/.test(normalized);
}

function trustedCoreHostExecArgv(modulePath = null) {
  const runtimeRoot = path.resolve(__dirname, '..');
  const args = ['--permission', '--allow-child-process', `--allow-fs-read=${runtimeRoot}`, `--allow-fs-read=${process.env.STAY_BWRAP || '/usr/bin/bwrap'}`];
  if (modulePath) args.push(`--allow-fs-read=${path.dirname(canonicalCoreModulePath(modulePath))}`);
  return args;
}

function nativeCoreExecArgv(modulePath) {
  const runtimeRoot = path.resolve(__dirname, '..');
  const absoluteModule = canonicalCoreModulePath(modulePath);
  const readRoots = new Set([
    runtimeRoot,
    realPathOrSelf(runtimeRoot),
    path.dirname(absoluteModule)
  ]);
  // The trusted CoreHost supervisor may spawn bubblewrap, but the untrusted
  // candidate worker itself never needs process-spawn authority.
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

function coreSupervisorEnvironment({ compatibility = false } = {}) {
  if (compatibility) return { ...process.env, STAY_COREHOST: '1', STAY_COREHOST_COMPATIBILITY: '1' };
  const env = coreHostEnvironment();
  for (const key of ['STAY_REQUIRE_OS_CORE_SANDBOX', 'STAY_BWRAP']) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  return env;
}

function releaseRootFor(modulePath) {
  const runtimeRoot = path.resolve(__dirname, '..');
  const repositoryRoot = path.resolve(runtimeRoot, '..');
  const absoluteModule = canonicalCoreModulePath(modulePath);
  if (absoluteModule === repositoryRoot || absoluteModule.startsWith(repositoryRoot + path.sep)) return repositoryRoot;
  throw Object.assign(new Error('Core module is outside the immutable release root'), { code: 'CORE_SANDBOX_RELEASE_ROOT' });
}

function sandboxWorkerPlan(modulePath, { maxOldSpaceMiB = 64, maxSemiSpaceMiB = 8 } = {}) {
  const absoluteModule = canonicalCoreModulePath(modulePath);
  const releaseRoot = releaseRootFor(absoluteModule);
  const relativeModule = path.relative(releaseRoot, absoluteModule);
  const workerRelative = path.relative(releaseRoot, WORKER_PATH);
  if (relativeModule.startsWith('..') || workerRelative.startsWith('..')) {
    throw Object.assign(new Error('Core sandbox paths escape the release root'), { code: 'CORE_SANDBOX_PATH' });
  }
  const sandboxRoot = '/stay-release';
  const sandboxModulePath = path.posix.join(sandboxRoot, relativeModule.split(path.sep).join('/'));
  const sandboxWorkerPath = path.posix.join(sandboxRoot, workerRelative.split(path.sep).join('/'));
  const nodeBinding = sandboxNodeBinding();
  const execArgv = [
    '--disable-sigusr1',
    `--max-old-space-size=${Math.max(16, Math.floor(maxOldSpaceMiB))}`,
    `--max-semi-space-size=${Math.max(1, Math.floor(maxSemiSpaceMiB))}`,
    ...nativeCoreExecArgv(absoluteModule).map(value => value
      .replaceAll(releaseRoot, sandboxRoot)
      .replaceAll(path.resolve(__dirname, '..'), path.posix.join(sandboxRoot, 'runtime')))
  ];
  const args = [
    '--die-with-parent', '--new-session', '--unshare-all', '--unshare-user', '--disable-userns', '--cap-drop', 'ALL',
    '--proc', '/proc', '--dev', '/dev', '--dir', '/tmp', '--dir', '/var', '--dir', '/run',
    '--ro-bind', '/usr', '/usr',
    ...nodeBinding.args,
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind', releaseRoot, sandboxRoot,
    '--chdir', path.posix.dirname(sandboxModulePath),
    '--clearenv', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'STAY_COREHOST', '1'
  ];
  for (const key of ['NODE_ENV', 'TZ', 'LANG', 'LC_ALL']) {
    if (process.env[key] != null) args.push('--setenv', key, String(process.env[key]));
  }
  args.push(nodeBinding.nodePath, ...execArgv, sandboxWorkerPath);
  return Object.freeze({
    executable: process.env.STAY_BWRAP || '/usr/bin/bwrap',
    args: Object.freeze(args),
    releaseRoot,
    sandboxRoot,
    sandboxModulePath,
    sandboxWorkerPath,
    networkShared: false,
    stateStoreVisible: false
  });
}

function spawnCoreWorker(modulePath, { compatibility = false, maxOldSpaceMiB = 64, maxSemiSpaceMiB = 8 } = {}) {
  const absoluteModule = canonicalCoreModulePath(modulePath);
  const requireOsSandbox = process.env.STAY_REQUIRE_OS_CORE_SANDBOX === '1' && !compatibility;
  if (!requireOsSandbox) {
    const args = [
      '--disable-sigusr1',
      `--max-old-space-size=${Math.max(16, Math.floor(maxOldSpaceMiB))}`,
      `--max-semi-space-size=${Math.max(1, Math.floor(maxSemiSpaceMiB))}`,
      ...(compatibility ? [] : nativeCoreExecArgv(absoluteModule)),
      WORKER_PATH
    ];
    return {
      child: spawn(process.execPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: coreHostEnvironment({ compatibility })
      }),
      modulePath: absoluteModule,
      sandboxed: false,
      plan: null
    };
  }
  if (process.platform !== 'linux') {
    throw Object.assign(new Error('required OS Core sandbox is only supported on Linux'), { code: 'CORE_OS_SANDBOX_REQUIRED' });
  }
  const plan = sandboxWorkerPlan(absoluteModule, { maxOldSpaceMiB, maxSemiSpaceMiB });
  if (!fs.existsSync(plan.executable)) {
    throw Object.assign(new Error(`required bubblewrap executable is missing: ${plan.executable}`), { code: 'CORE_OS_SANDBOX_REQUIRED' });
  }
  return {
    child: spawn(plan.executable, plan.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' }
    }),
    modulePath: plan.sandboxModulePath,
    sandboxed: true,
    plan
  };
}

module.exports = {
  WORKER_PATH, sandboxNodeBinding, canonicalCoreModulePath, isLegacyCompatibilityCore, trustedCoreHostExecArgv, nativeCoreExecArgv, coreHostEnvironment, coreSupervisorEnvironment,
  releaseRootFor, sandboxWorkerPlan, spawnCoreWorker
};
