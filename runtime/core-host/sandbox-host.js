'use strict';

const { validateManifest } = require('../kernel/manifest');
const { IPC_PROTOCOL, IPC_PROTOCOL_VERSION, assertPayload, errorRecord } = require('../kernel/protocol');
const { spawnCoreWorker, isLegacyCompatibilityCore } = require('../kernel/core-sandbox');

const MAX_WORKER_LINE_BYTES = 2 * 1024 * 1024;
let worker = null;
let workerModulePath = null;
let manifest = null;
let mode = 'starting';
let stopping = false;
let operationChain = Promise.resolve();
let workerBuffer = '';
let workerCounter = 0;
const workerPending = new Map();
let currentEvent = null;
let outputLimitPerEvent = 64;
let outputBytesPerEvent = 1024 * 1024;

function send(message) {
  if (!process.connected) return;
  assertPayload(message, 'CoreHost outbound message');
  process.send({ protocol: IPC_PROTOCOL, protocolVersion: IPC_PROTOCOL_VERSION, ...message });
}
function workerError(record) {
  const error = new Error(record?.message || 'Core worker request failed');
  error.name = record?.name || 'Error';
  error.code = record?.code || null;
  return error;
}

function rejectWorkerPending(error) {
  for (const pending of workerPending.values()) pending.reject(error);
  workerPending.clear();
}

function terminateWorker(reason = 'terminated') {
  const current = worker;
  worker = null;
  workerModulePath = null;
  if (current && current.exitCode == null && current.signalCode == null) current.kill('SIGKILL');
  rejectWorkerPending(Object.assign(new Error(`Core worker ${reason}`), { code: 'CORE_WORKER_EXIT' }));
}

function handleWorkerMessage(message) {
  assertPayload(message, 'Core worker inbound message');
  if (message.type === 'response') {
    const pending = workerPending.get(message.requestId);
    if (!pending) return;
    workerPending.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(workerError(message.error));
    return;
  }
  if (message.type === 'output') {
    if (!currentEvent || !manifest) {
      terminateWorker('emitted outside a causal event');
      throw Object.assign(new Error('Core worker output has no causal event'), { code: 'COREHOST_OUTPUT_CONTEXT' });
    }
    if (!manifest.outputs.includes(message.topic)) {
      terminateWorker('emitted undeclared output');
      throw Object.assign(new Error(`Core worker emitted undeclared output: ${message.topic}`), { code: 'COREHOST_OUTPUT_UNDECLARED' });
    }
    const bytes = Buffer.byteLength(JSON.stringify({ topic: message.topic, payload: message.payload, meta: message.meta || {} }));
    currentEvent.outputCount += 1;
    currentEvent.outputBytes += bytes;
    if (currentEvent.outputCount > outputLimitPerEvent || currentEvent.outputBytes > outputBytesPerEvent) {
      terminateWorker('exceeded causal output quota');
      throw Object.assign(new Error('Core worker per-event output quota exceeded'), { code: 'COREHOST_OUTPUT_QUOTA' });
    }
    send({
      type: 'output',
      topic: message.topic,
      payload: message.payload,
      meta: { ...(message.meta || {}), outputIndex: currentEvent.outputCount },
      context: currentEvent.context,
      mode
    });
    return;
  }
  if (message.type === 'heartbeat') { send(message); return; }
  if (message.type === 'log') {
    send({ type: 'log', level: message.level, args: Array.isArray(message.args) ? message.args : [] });
    return;
  }
  if (message.type === 'fatal') { send({ type: 'fatal', error: message.error }); return; }
  terminateWorker('sent an unknown protocol message');
  throw Object.assign(new Error('unknown Core worker protocol message'), { code: 'CORE_WORKER_PROTOCOL' });
}

function consumeWorkerStdout(chunk) {
  workerBuffer += String(chunk);
  if (Buffer.byteLength(workerBuffer) > MAX_WORKER_LINE_BYTES * 2) {
    terminateWorker('protocol buffer exceeded bound');
    return;
  }
  for (;;) {
    const index = workerBuffer.indexOf('\n');
    if (index < 0) break;
    const line = workerBuffer.slice(0, index);
    workerBuffer = workerBuffer.slice(index + 1);
    if (!line) continue;
    if (Buffer.byteLength(line) > MAX_WORKER_LINE_BYTES) {
      terminateWorker('protocol line exceeded bound');
      return;
    }
    let parsed;
    try { parsed = JSON.parse(line); }
    catch {
      terminateWorker('corrupted protocol stream');
      return;
    }
    try { handleWorkerMessage(parsed); }
    catch (error) { try { send({ type: 'fatal', error: errorRecord(error) }); } catch {} }
  }
}

function ensureWorker(modulePath, expectedCoreId = null, hardRamMiB = 64) {
  if (worker) {
    if (workerModulePath !== modulePath) throw Object.assign(new Error('CoreHost worker module changed after spawn'), { code: 'CORE_WORKER_MODULE_MISMATCH' });
    return worker;
  }
  const compatibility = expectedCoreId === 'fetus-legacy' || isLegacyCompatibilityCore(modulePath);
  const launched = spawnCoreWorker(modulePath, { compatibility, maxOldSpaceMiB: Math.max(16, hardRamMiB * 0.8) });
  worker = launched.child;
  workerModulePath = modulePath;
  workerBuffer = '';
  worker.stdout.on('data', consumeWorkerStdout);
  worker.stderr.on('data', chunk => send({ type: 'log', level: 'warn', args: [String(chunk).slice(0, 8192)] }));
  worker.once('error', error => {
    try { send({ type: 'fatal', error: errorRecord(error) }); } catch {}
    terminateWorker('spawn error');
    if (!stopping) setImmediate(() => process.exit(1));
  });
  worker.once('exit', (code, signal) => {
    const unexpected = !stopping;
    const error = Object.assign(new Error(`Core worker exited (${code ?? signal})`), { code: 'CORE_WORKER_EXIT' });
    worker = null;
    workerModulePath = null;
    rejectWorkerPending(error);
    if (unexpected) {
      try { send({ type: 'fatal', error: errorRecord(error) }); } catch {}
      setImmediate(() => process.exit(1));
    }
  });
  launched.modulePathInside = launched.modulePath;
  worker._stayLaunch = launched;
  return worker;
}

function requestWorker(operation, payload, timeoutMs = 15000) {
  if (!worker?.stdin?.writable) return Promise.reject(Object.assign(new Error('Core worker is offline'), { code: 'CORE_WORKER_OFFLINE' }));
  const requestId = `worker-${process.pid}-${++workerCounter}`;
  const message = { requestId, operation, payload };
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line) > MAX_WORKER_LINE_BYTES) return Promise.reject(Object.assign(new Error('Core worker request exceeds bound'), { code: 'CORE_WORKER_PROTOCOL_LIMIT' }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      workerPending.delete(requestId);
      terminateWorker(`request ${operation} timed out`);
      reject(Object.assign(new Error(`Core worker ${operation} timed out`), { code: 'CORE_WORKER_TIMEOUT' }));
    }, timeoutMs);
    timer.unref?.();
    workerPending.set(requestId, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); }
    });
    worker.stdin.write(line + '\n', error => {
      if (!error) return;
      const pending = workerPending.get(requestId);
      if (!pending) return;
      workerPending.delete(requestId);
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function initialize(payload, inspectOnly = false) {
  const expectedCoreId = payload.expectedCoreId || null;
  const hardRamMiB = Number(payload.expectedManifest?.resources?.hardRamMiB) || 64;
  const current = ensureWorker(payload.modulePath, expectedCoreId, hardRamMiB);
  const launch = current._stayLaunch;
  const workerPayload = { ...payload, modulePath: launch.modulePath, inspectOnly };
  const result = await requestWorker(inspectOnly ? 'inspect' : 'init', workerPayload, Math.max(5000, Number(payload.handlerTimeoutMs) || 0));
  const checked = validateManifest(result.manifest);
  if (payload.expectedCoreId && payload.expectedCoreId !== checked.coreId) throw new Error('CoreHost coreId mismatch');
  if (payload.expectedVersion && payload.expectedVersion !== checked.version) throw new Error('CoreHost version mismatch');
  if (payload.expectedManifest && JSON.stringify(validateManifest(payload.expectedManifest)) !== JSON.stringify(checked)) {
    throw Object.assign(new Error('CoreHost runtime manifest differs from inspected manifest'), { code: 'COREHOST_MANIFEST_MISMATCH' });
  }
  manifest = checked;
  mode = payload.mode || 'standby';
  outputLimitPerEvent = Math.max(1, Number(payload.outputLimitPerEvent) || 64);
  outputBytesPerEvent = Math.max(1024, Number(payload.outputBytesPerEvent) || 1024 * 1024);
  return { ...result, manifest: checked, sandboxed: Boolean(launch.sandboxed) };
}

async function execute(operation, payload) {
  if (operation === 'inspect') return initialize(payload, true);
  if (operation === 'init') return initialize(payload, false);
  if (!worker || !manifest) throw new Error('CoreHost is not initialized');
  if (operation === 'event') {
    const event = payload.event;
    if (!manifest.inputs.includes(event.topic)) return { ignored: true };
    currentEvent = { context: payload.context || null, outputCount: 0, outputBytes: 0 };
    try { return await requestWorker('event', { event }, Math.max(1000, Number(payload.timeoutMs) || 0)); }
    finally { currentEvent = null; }
  }
  if (operation === 'snapshot') return requestWorker('snapshot', {});
  if (operation === 'health') return requestWorker('health', {});
  if (operation === 'mode') { mode = payload.mode; return requestWorker('mode', { mode }); }
  if (operation === 'stop') {
    stopping = true;
    try { return await requestWorker('stop', {}, 15000); }
    finally { if (worker && worker.exitCode == null && worker.signalCode == null) worker.kill('SIGTERM'); }
  }
  throw new Error('unknown CoreHost operation: ' + operation);
}

async function handleRequest(message) {
  if (!message || message.protocol !== IPC_PROTOCOL || message.protocolVersion !== IPC_PROTOCOL_VERSION) return;
  const requestId = String(message.requestId || '');
  if (!requestId) return;
  try {
    assertPayload(message, 'CoreHost inbound message');
    const result = await execute(message.operation, message.payload || {});
    send({ type: 'response', requestId, ok: true, result });
    if (message.operation === 'inspect') setImmediate(() => { stopping = true; terminateWorker('inspection complete'); process.exit(0); });
    if (message.operation === 'stop') setImmediate(() => process.exit(0));
  } catch (error) {
    send({ type: 'response', requestId, ok: false, error: errorRecord(error) });
    if (message.operation === 'init' || message.operation === 'inspect') setImmediate(() => process.exit(1));
  }
}

process.on('message', message => {
  operationChain = operationChain.then(() => handleRequest(message), () => handleRequest(message));
});
process.on('disconnect', () => { stopping = true; terminateWorker('parent disconnected'); process.exit(1); });
process.once('SIGTERM', () => { stopping = true; terminateWorker('SIGTERM'); process.exit(0); });
process.once('SIGINT', () => { stopping = true; terminateWorker('SIGINT'); process.exit(1); });
process.on('uncaughtException', error => { try { send({ type: 'fatal', error: errorRecord(error) }); } catch {} terminateWorker('uncaught exception'); process.exit(1); });
process.on('unhandledRejection', error => { try { send({ type: 'fatal', error: errorRecord(error) }); } catch {} terminateWorker('unhandled rejection'); process.exit(1); });
