'use strict';

const path = require('node:path');
const readline = require('node:readline');
const { validateManifest } = require('../kernel/manifest');

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const nativeWrite = process.stdout.write.bind(process.stdout);
let api = null;
let manifest = null;
let mode = 'starting';
let heartbeatTimer = null;
let stopping = false;
let operationChain = Promise.resolve();
const supervisorPid = process.ppid;

function errorRecord(error) {
  return { name: error?.name || 'Error', message: String(error?.message || error), code: error?.code || null };
}
function write(message) {
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw Object.assign(new Error('worker protocol message exceeds bound'), { code: 'CORE_WORKER_PROTOCOL_LIMIT' });
  nativeWrite(line + '\n');
}

// Candidate console output is converted to bounded protocol logs rather than sharing
// the protocol stream as arbitrary text.
global.console = Object.freeze({
  log: (...args) => write({ type: 'log', level: 'log', args: args.map(String).map(value => value.slice(0, 2000)).slice(0, 12) }),
  info: (...args) => write({ type: 'log', level: 'info', args: args.map(String).map(value => value.slice(0, 2000)).slice(0, 12) }),
  warn: (...args) => write({ type: 'log', level: 'warn', args: args.map(String).map(value => value.slice(0, 2000)).slice(0, 12) }),
  error: (...args) => write({ type: 'log', level: 'error', args: args.map(String).map(value => value.slice(0, 2000)).slice(0, 12) })
});

const nativeInternalKill = process._kill?.bind(process);
if (nativeInternalKill) {
  process._kill = function guardedWorkerInternalKill(pid, signal) {
    if (Number(pid) !== process.pid) return -1;
    return nativeInternalKill(Number(pid), signal);
  };
}
const nativeProcessKill = process.kill.bind(process);
process.kill = function guardedWorkerKill(pid, signal) {
  const target = Number(pid);
  if (target !== process.pid) {
    const error = new Error(`Core worker may not signal process ${pid}`);
    error.code = 'EPERM'; error.errno = -1; error.syscall = 'kill';
    throw error;
  }
  return nativeProcessKill(target, signal);
};

function loadDefinition(modulePath) {
  const absolute = path.resolve(modulePath);
  delete require.cache[require.resolve(absolute)];
  const coreModule = require(absolute);
  const checked = validateManifest(coreModule.manifest);
  if (typeof coreModule.createCore !== 'function') throw new Error('core must export createCore(context)');
  return {
    manifest: checked,
    createCore: coreModule.createCore,
    migrateState: typeof coreModule.migrateState === 'function' ? coreModule.migrateState : null
  };
}

async function initialize(payload) {
  const definition = loadDefinition(payload.modulePath);
  manifest = definition.manifest;
  if (payload.expectedCoreId && payload.expectedCoreId !== manifest.coreId) throw new Error('Core worker coreId mismatch');
  if (payload.expectedVersion && payload.expectedVersion !== manifest.version) throw new Error('Core worker version mismatch');
  if (payload.expectedManifest && JSON.stringify(validateManifest(payload.expectedManifest)) !== JSON.stringify(manifest)) {
    throw Object.assign(new Error('Core worker runtime manifest differs from inspected manifest'), { code: 'COREHOST_MANIFEST_MISMATCH' });
  }
  if (payload.inspectOnly) return { manifest };

  mode = payload.mode || 'standby';
  const emit = async (topic, outputPayload, meta = {}) => {
    if (!manifest.outputs.includes(topic)) throw new Error('undeclared output topic: ' + topic);
    write({ type: 'output', topic, payload: outputPayload, meta });
    return null;
  };
  let initialState = structuredClone(payload.initialState || {});
  const fromStateSchema = Number(payload.fromStateSchema) || manifest.stateSchema;
  if (fromStateSchema !== manifest.stateSchema) {
    if (!definition.migrateState) throw new Error('state migration required but not supplied');
    initialState = await definition.migrateState({ state: initialState, fromSchema: fromStateSchema, toSchema: manifest.stateSchema });
  }
  api = await definition.createCore({
    manifest,
    initialState,
    emit,
    now: () => Date.now(),
    logger: global.console
  });
  for (const method of ['start', 'handle', 'snapshot', 'health']) {
    if (!api || typeof api[method] !== 'function') throw new Error('core missing method: ' + method);
  }
  await api.start();
  heartbeatTimer = setInterval(() => {
    if (process.ppid !== supervisorPid) return process.exit(1);
    write({ type: 'heartbeat', at: Date.now(), mode, memory: process.memoryUsage() });
  }, Math.max(250, Number(payload.heartbeatIntervalMs) || 1000));
  heartbeatTimer.unref?.();
  return { manifest, pid: process.pid, mode };
}

async function execute(operation, payload) {
  if (operation === 'inspect') return initialize({ ...payload, inspectOnly: true });
  if (operation === 'init') return initialize(payload);
  if (!api) throw new Error('Core worker is not initialized');
  if (operation === 'event') {
    const event = payload.event;
    if (!manifest.inputs.includes(event.topic)) return { ignored: true };
    await api.handle(event);
    return { handled: true, sequence: event.sequence || event.id };
  }
  if (operation === 'snapshot') return api.snapshot();
  if (operation === 'health') return api.health();
  if (operation === 'mode') { mode = payload.mode; return { mode }; }
  if (operation === 'stop') {
    stopping = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (api.stop) await api.stop();
    return { stopped: true };
  }
  throw new Error('unknown Core worker operation: ' + operation);
}

async function handle(line) {
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw Object.assign(new Error('worker request exceeds bound'), { code: 'CORE_WORKER_PROTOCOL_LIMIT' });
  const message = JSON.parse(line);
  const requestId = String(message?.requestId || '');
  if (!requestId) return;
  try {
    const result = await execute(message.operation, message.payload || {});
    write({ type: 'response', requestId, ok: true, result });
    if (message.operation === 'inspect' || message.operation === 'stop') setImmediate(() => process.exit(0));
  } catch (error) {
    write({ type: 'response', requestId, ok: false, error: errorRecord(error) });
    if (message.operation === 'init' || message.operation === 'inspect') setImmediate(() => process.exit(1));
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  operationChain = operationChain.then(() => handle(line), () => handle(line)).catch(error => {
    try { write({ type: 'fatal', error: errorRecord(error) }); } catch {}
    process.exit(1);
  });
});
input.on('close', async () => {
  if (stopping) return;
  try { if (api?.stop) await api.stop(); } catch {}
  process.exit(1);
});
process.once('SIGTERM', () => { try { if (api?.stop) Promise.resolve(api.stop()).finally(() => process.exit(0)); else process.exit(0); } catch { process.exit(1); } });
process.once('SIGINT', () => process.exit(1));
process.on('uncaughtException', error => { try { write({ type: 'fatal', error: errorRecord(error) }); } catch {} process.exit(1); });
process.on('unhandledRejection', error => { try { write({ type: 'fatal', error: errorRecord(error) }); } catch {} process.exit(1); });
