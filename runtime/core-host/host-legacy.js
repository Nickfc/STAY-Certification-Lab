'use strict';

const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { validateManifest } = require('../kernel/manifest');
const { IPC_PROTOCOL, IPC_PROTOCOL_VERSION, assertPayload, errorRecord } = require('../kernel/protocol');

const contextStorage = new AsyncLocalStorage();
let api = null;
let manifest = null;
let mode = 'starting';
let heartbeatTimer = null;
let stopping = false;
let operationChain = Promise.resolve();

const nativeInternalKill = process._kill.bind(process);
process._kill = function guardedCoreHostInternalKill(pid, signal) {
  if (Number(pid) !== process.pid) return -1;
  return nativeInternalKill(Number(pid), signal);
};
const nativeProcessKill = process.kill.bind(process);
process.kill = function guardedCoreHostKill(pid, signal) {
  const target = Number(pid);
  if (target !== process.pid) {
    const error = new Error(`CoreHost may not signal process ${pid}`);
    error.code = 'EPERM';
    error.errno = -1;
    error.syscall = 'kill';
    throw error;
  }
  return nativeProcessKill(target, signal);
};

async function gracefulShutdown(reason, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  try {
    if (api?.stop) await Promise.race([
      api.stop(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('CoreHost graceful stop timed out')), 15000))
    ]);
  } catch (error) {
    try { send({ type: 'fatal', error: errorRecord(error), reason }); } catch {}
    exitCode = exitCode || 1;
  }
  process.exit(exitCode);
}

function send(message) {
  if (!process.connected) return;
  assertPayload(message, 'CoreHost outbound message');
  process.send({ protocol: IPC_PROTOCOL, protocolVersion: IPC_PROTOCOL_VERSION, ...message });
}

function sendAsync(message) {
  if (!process.connected) return Promise.reject(Object.assign(new Error('CoreHost IPC is disconnected'), { code: 'COREHOST_IPC_OFFLINE' }));
  assertPayload(message, 'CoreHost outbound message');
  return new Promise((resolve, reject) => {
    process.send({ protocol: IPC_PROTOCOL, protocolVersion: IPC_PROTOCOL_VERSION, ...message }, error => error ? reject(error) : resolve());
  });
}

function loadDefinition(modulePath) {
  const absolute = path.resolve(modulePath);
  delete require.cache[require.resolve(absolute)];
  const coreModule = require(absolute);
  const checked = validateManifest(coreModule.manifest);
  if (typeof coreModule.createCore !== 'function') throw new Error('core must export createCore(context)');
  return {
    modulePath: absolute,
    manifest: checked,
    createCore: coreModule.createCore,
    migrateState: typeof coreModule.migrateState === 'function' ? coreModule.migrateState : null
  };
}

async function initialize(payload) {
  const definition = loadDefinition(payload.modulePath);
  manifest = definition.manifest;
  if (payload.expectedCoreId && payload.expectedCoreId !== manifest.coreId) throw new Error('CoreHost coreId mismatch');
  if (payload.expectedVersion && payload.expectedVersion !== manifest.version) throw new Error('CoreHost version mismatch');
  if (payload.expectedManifest && JSON.stringify(validateManifest(payload.expectedManifest)) !== JSON.stringify(manifest)) {
    throw Object.assign(new Error('CoreHost runtime manifest differs from inspected manifest'), { code: 'COREHOST_MANIFEST_MISMATCH' });
  }
  if (payload.inspectOnly) return { manifest };

  mode = payload.mode || 'standby';
  const emit = async (topic, outputPayload, meta = {}) => {
    if (!manifest.outputs.includes(topic)) throw new Error('undeclared output topic: ' + topic);
    const execution = contextStorage.getStore();
    const context = execution?.context || null;
    if (!execution) throw Object.assign(new Error('CoreHost output has no causal event context'), { code: 'COREHOST_OUTPUT_CONTEXT' });
    const outputBytes = Buffer.byteLength(JSON.stringify({ topic, payload: outputPayload, meta }));
    execution.outputCount += 1;
    execution.outputBytes += outputBytes;
    if (execution.outputCount > Math.max(1, Number(payload.outputLimitPerEvent) || 64)
      || execution.outputBytes > Math.max(1024, Number(payload.outputBytesPerEvent) || 1024 * 1024)) {
      throw Object.assign(new Error('CoreHost per-event output quota exceeded'), { code: 'COREHOST_OUTPUT_QUOTA' });
    }
    execution.outputs.push({
      type: 'output',
      topic,
      payload: outputPayload,
      meta: { ...meta, outputIndex: execution.outputCount },
      context,
      mode
    });
    return null;
  };
  let initialState = structuredClone(payload.initialState || {});
  const fromStateSchema = Number(payload.fromStateSchema) || manifest.stateSchema;
  if (fromStateSchema !== manifest.stateSchema) {
    if (!definition.migrateState) throw new Error('state migration required but not supplied');
    initialState = await definition.migrateState({
      state: initialState,
      fromSchema: fromStateSchema,
      toSchema: manifest.stateSchema
    });
  }
  api = await definition.createCore({
    manifest,
    initialState,
    emit,
    now: () => Date.now(),
    logger: {
      log: (...args) => send({ type: 'log', level: 'log', args: args.map(value => String(value).slice(0, 2000)).slice(0, 12) }),
      info: (...args) => send({ type: 'log', level: 'info', args: args.map(value => String(value).slice(0, 2000)).slice(0, 12) }),
      warn: (...args) => send({ type: 'log', level: 'warn', args: args.map(value => String(value).slice(0, 2000)).slice(0, 12) }),
      error: (...args) => send({ type: 'log', level: 'error', args: args.map(value => String(value).slice(0, 2000)).slice(0, 12) })
    }
  });
  for (const method of ['start', 'handle', 'snapshot', 'health']) {
    if (!api || typeof api[method] !== 'function') throw new Error('core missing method: ' + method);
  }
  await api.start();
  heartbeatTimer = setInterval(() => {
    send({ type: 'heartbeat', at: Date.now(), mode, memory: process.memoryUsage() });
  }, Math.max(250, Number(payload.heartbeatIntervalMs) || 1000));
  heartbeatTimer.unref?.();
  return { manifest, pid: process.pid, mode };
}

async function execute(operation, payload) {
  if (operation === 'inspect') return initialize({ ...payload, inspectOnly: true });
  if (operation === 'init') return initialize(payload);
  if (!api) throw new Error('CoreHost is not initialized');
  if (operation === 'event') {
    const event = payload.event;
    if (!manifest.inputs.includes(event.topic)) {
      return {
        result: { ignored: true },
        checkpoint: payload.includeCheckpoint === true ? await api.snapshot() : null
      };
    }
    return contextStorage.run({
      context: payload.context || null,
      outputCount: 0,
      outputBytes: 0,
      outputs: []
    }, async () => {
      const execution = contextStorage.getStore();
      await api.handle(event);
      const result = {
        result: { handled: true, sequence: event.sequence || event.id },
        checkpoint: payload.includeCheckpoint === true ? await api.snapshot() : null
      };
      for (const output of execution.outputs) await sendAsync(output);
      return result;
    });
  }
  if (operation === 'snapshot') return api.snapshot();
  if (operation === 'health') return api.health();
  if (operation === 'mode') { mode = payload.mode; return { mode }; }
  if (operation === 'stop') {
    stopping = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (api.stop) await api.stop();
    setImmediate(() => process.exit(0));
    return { stopped: true };
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
    if (message.operation === 'inspect') setImmediate(() => process.exit(0));
  } catch (error) {
    send({ type: 'response', requestId, ok: false, error: errorRecord(error) });
    if (message.operation === 'init' || message.operation === 'inspect') setImmediate(() => process.exit(1));
  }
}

process.on('message', message => {
  operationChain = operationChain.then(
    () => handleRequest(message),
    () => handleRequest(message)
  );
});

process.on('disconnect', () => { if (!stopping) gracefulShutdown('parent-disconnect').catch(() => process.exit(1)); });
process.once('SIGTERM', () => gracefulShutdown('SIGTERM').catch(() => process.exit(1)));
process.once('SIGINT', () => gracefulShutdown('SIGINT').catch(() => process.exit(1)));

process.on('uncaughtException', error => {
  try { send({ type: 'fatal', error: errorRecord(error) }); } catch {}
  gracefulShutdown('uncaughtException', 1).catch(() => process.exit(1));
});

process.on('unhandledRejection', error => {
  try { send({ type: 'fatal', error: errorRecord(error) }); } catch {}
  gracefulShutdown('unhandledRejection', 1).catch(() => process.exit(1));
});
