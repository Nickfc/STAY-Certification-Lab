'use strict';

const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { validateManifest } = require('./manifest');
const { IPC_PROTOCOL, IPC_PROTOCOL_VERSION } = require('./protocol');
const { HOST_PATH } = require('./core-host-client');
const { canonicalCoreModulePath, nativeCoreExecArgv, coreHostEnvironment } = require('./core-sandbox');
const { enforcePackagePolicy, verifyManifestAgainstPackagePolicy } = require('./package-policy');

function hasExited(child) { return !child || child.exitCode != null || child.signalCode != null; }
async function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return true;
  let timer;
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })
  ]).finally(() => clearTimeout(timer));
  return hasExited(child);
}

async function inspectCoreModule(modulePath, timeoutMs = 5000) {
  // Pin the inspected and subsequently launched Core to the immutable target.
  // Node's permission model otherwise rejects a require through /opt/stay/current,
  // and retaining the symlink would permit a retarget between inspection and use.
  const absolute = canonicalCoreModulePath(modulePath);
  const packagePolicy = enforcePackagePolicy(absolute);
  const child = fork(HOST_PATH, [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'advanced',
    execArgv: ['--disable-sigusr1', '--max-old-space-size=64', ...nativeCoreExecArgv(absolute)],
    env: coreHostEnvironment()
  });
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      const requestId = `inspect-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      timer = setTimeout(() => reject(Object.assign(new Error('core manifest inspection timed out'), { code: 'CORE_INSPECT_TIMEOUT' })), timeoutMs);
      timer.unref?.();
      child.stderr?.on('data', () => {});
      child.on('message', message => {
        if (message?.requestId !== requestId || message.type !== 'response') return;
        if (message.ok) resolve(message.result);
        else reject(Object.assign(new Error(message.error?.message || 'core manifest inspection failed'), { code: message.error?.code || null }));
      });
      child.once('exit', code => { if (code && code !== 0) reject(new Error(`core manifest inspector exited ${code}`)); });
      child.send({
        protocol: IPC_PROTOCOL,
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId,
        operation: 'inspect',
        payload: { modulePath: absolute }
      });
    });
    const manifest = validateManifest(result.manifest);
    verifyManifestAgainstPackagePolicy(packagePolicy, manifest);
    return { modulePath: absolute, manifest, packagePolicy: packagePolicy?.policy || null };
  } finally {
    clearTimeout(timer);
    if (!hasExited(child)) child.kill('SIGTERM');
    if (!(await waitForExit(child, 500))) {
      child.kill('SIGKILL');
      if (!(await waitForExit(child, 1000))) {
        throw Object.assign(new Error('core manifest inspector could not be reaped'), { code: 'CORE_INSPECT_REAP_FAILED' });
      }
    }
  }
}

module.exports = { inspectCoreModule };
