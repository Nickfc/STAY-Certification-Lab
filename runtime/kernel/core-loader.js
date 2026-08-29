'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { validateManifest } = require('./manifest');
const { IPC_PROTOCOL, IPC_PROTOCOL_VERSION, errorRecord } = require('./protocol');
const {
  HOST_PATH,
  COREHOST_PAYLOAD_ATTACH_TIMEOUT_MS
} = require('./core-host-client');
const { canonicalCoreModulePath, isLegacyCompatibilityCore, trustedCoreHostExecArgv, coreSupervisorEnvironment } = require('./core-sandbox');
const { enforcePackagePolicy, verifyManifestAgainstPackagePolicy } = require('./package-policy');
const { normalizePolicy } = require('./resource-governor');
const { CgroupGovernor, processDescendants } = require('./cgroup-governor');

const CORE_INSPECT_DIAGNOSTIC_LIMIT = 1024;

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
function sha256(bytes) { return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'); }

function diagnosticValue(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); }
  catch { return String(value); }
}

function appendDiagnostic(current, value) {
  if (current.length >= CORE_INSPECT_DIAGNOSTIC_LIMIT) return current;
  const normalized = diagnosticValue(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '?')
    .replace(/\r?\n/g, ' | ')
    .trim();
  if (!normalized) return current;
  const prefix = current ? ' | ' : '';
  return (current + prefix + normalized).slice(0, CORE_INSPECT_DIAGNOSTIC_LIMIT);
}

function inspectionError(message, code, diagnostics) {
  const suffix = diagnostics ? `: ${diagnostics}` : '';
  return Object.assign(new Error(String(message || 'core manifest inspection failed') + suffix), { code: code || null });
}

async function inspectCoreModule(modulePath, timeoutMs = 5000) {
  // Static package attestation happens in the trusted Kernel process. Executable
  // manifest inspection happens in the CoreHost worker, which is OS-sandboxed
  // whenever production requires hostile-code containment.
  const absolute = canonicalCoreModulePath(modulePath);
  const moduleDigest = sha256(fs.readFileSync(absolute));
  const packagePolicy = enforcePackagePolicy(absolute);
  const compatibility = isLegacyCompatibilityCore(absolute);
  const inspectionPolicy = normalizePolicy(
    packagePolicy?.policy?.resourceContract?.manifestResources || {},
    'optional'
  );
  const inspectionCgroup = new CgroupGovernor({
    name: `inspect-${path.basename(absolute)}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
    policy: inspectionPolicy
  });
  await inspectionCgroup.prepare();
  const child = fork(HOST_PATH, [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'advanced',
    execArgv: [
      '--disable-sigusr1',
      '--max-old-space-size=16',
      '--max-semi-space-size=2',
      ...(compatibility ? [] : trustedCoreHostExecArgv(absolute))
    ],
    env: coreSupervisorEnvironment({ compatibility })
  });
  let timer;
  let diagnostics = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', chunk => { diagnostics = appendDiagnostic(diagnostics, chunk); });
  try {
    const result = await new Promise((resolve, reject) => {
      const requestId = `inspect-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      timer = setTimeout(
        () => reject(Object.assign(new Error('core manifest inspection timed out'), { code: 'CORE_INSPECT_TIMEOUT' })),
        timeoutMs
      );
      timer.unref?.();
      child.on('message', message => {
        if (message?.type === 'payload-ready') {
          Promise.resolve()
            .then(async () => {
              const token = String(message.attachToken || '');
              const workerLauncherPid = Number(message.workerLauncherPid);
              if (
                message.protocol !== IPC_PROTOCOL ||
                message.protocolVersion !== IPC_PROTOCOL_VERSION ||
                !/^[a-zA-Z0-9._:-]{1,160}$/.test(token) ||
                !Number.isSafeInteger(workerLauncherPid) ||
                workerLauncherPid <= 1
              ) {
                throw Object.assign(
                  new Error('inspection payload attachment request is invalid'),
                  { code: 'COREHOST_PAYLOAD_ATTACH_PROTOCOL' }
                );
              }
              if (process.platform === 'linux') {
                const supervisorTree = await processDescendants(child.pid);
                if (
                  workerLauncherPid === child.pid ||
                  !supervisorTree.includes(workerLauncherPid)
                ) {
                  throw Object.assign(
                    new Error('inspection payload launcher is not a CoreHost descendant'),
                    { code: 'COREHOST_PAYLOAD_ATTACH_ANCESTRY' }
                  );
                }
              }
              const attached = await inspectionCgroup.attachPayloadTree(
                workerLauncherPid,
                []
              );
              if (inspectionCgroup.required && attached !== true) {
                throw Object.assign(new Error('required inspection payload cgroup attachment failed'), {
                  code: 'CGROUP_PREINIT_ATTACHMENT'
                });
              }
              child.send({
                protocol: IPC_PROTOCOL,
                protocolVersion: IPC_PROTOCOL_VERSION,
                type: 'payload-attached',
                attachToken: token,
                ok: true,
                attached
              });
            })
            .catch(error => {
              if (!child.connected) return;
              child.send({
                protocol: IPC_PROTOCOL,
                protocolVersion: IPC_PROTOCOL_VERSION,
                type: 'payload-attached',
                attachToken: message.attachToken,
                ok: false,
                error: errorRecord(error)
              });
            });
          return;
        }
        if (message?.type === 'log') {
          diagnostics = appendDiagnostic(diagnostics, Array.isArray(message.args) ? message.args.map(diagnosticValue).join(' ') : message.args);
          return;
        }
        if (message?.type === 'fatal') {
          diagnostics = appendDiagnostic(diagnostics, message.error?.message || message.error || 'CoreHost fatal error');
          return;
        }
        if (message?.requestId !== requestId || message.type !== 'response') return;
        if (message.ok) resolve(message.result);
        else reject(inspectionError(message.error?.message, message.error?.code, diagnostics));
      });
      child.once('exit', code => {
        if (code && code !== 0) {
          reject(inspectionError(`core manifest inspector exited ${code}`, 'CORE_INSPECT_EXIT', diagnostics));
        }
      });
      child.send({
        protocol: IPC_PROTOCOL,
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId,
        operation: 'inspect',
        payload: {
          modulePath: absolute,
          workerInitTimeoutMs: timeoutMs,
          payloadAttachTimeoutMs: COREHOST_PAYLOAD_ATTACH_TIMEOUT_MS,
          workerMemoryPlan: {
            workerOldSpaceMiB: 64,
            workerSemiSpaceMiB: 8
          }
        }
      });
    });
    const osSandboxRequired = process.env.STAY_REQUIRE_OS_CORE_SANDBOX === '1'
      && !compatibility;
    if (osSandboxRequired && result.sandboxed !== true) {
      throw Object.assign(
        new Error('required inspection OS sandbox was not attested by the supervisor'),
        { code: 'CORE_INSPECT_OS_SANDBOX_ATTESTATION' }
      );
    }
    const manifest = validateManifest(result.manifest);
    verifyManifestAgainstPackagePolicy(packagePolicy, manifest);
    return Object.freeze({
      modulePath: absolute,
      moduleDigest,
      packagePolicyHash: packagePolicy?.policy?.policyHash || null,
      sandboxed: result.sandboxed === true,
      manifest,
      packagePolicy: packagePolicy?.policy || null
    });
  } finally {
    clearTimeout(timer);
    if (!hasExited(child)) child.kill('SIGTERM');
    if (!(await waitForExit(child, 500))) {
      child.kill('SIGKILL');
      if (!(await waitForExit(child, 1000))) {
        throw Object.assign(new Error('core manifest inspector could not be reaped'), { code: 'CORE_INSPECT_REAP_FAILED' });
      }
    }
    await inspectionCgroup.stop();
  }
}

module.exports = { inspectCoreModule };
