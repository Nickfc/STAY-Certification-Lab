'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { validateManifest } = require('./manifest');
const { IPC_PROTOCOL, IPC_PROTOCOL_VERSION, assertPayload } = require('./protocol');
const { ResourceGovernor, normalizePolicy } = require('./resource-governor');
const { canonicalCoreModulePath, nativeCoreExecArgv, coreHostEnvironment } = require('./core-sandbox');
const { CgroupGovernor } = require('./cgroup-governor');

const HOST_PATH = path.join(__dirname, '..', 'core-host', 'host.js');

function reviveError(record) {
  const error = new Error(record?.message || 'CoreHost request failed');
  error.name = record?.name || 'Error';
  error.code = record?.code || null;
  if (record?.stack) error.stack = record.stack;
  return error;
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function hasExited(child) { return !child || child.exitCode != null || child.signalCode != null; }
async function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return;
  let timer;
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })
  ]).finally(() => clearTimeout(timer));
}

class CoreHostClient extends EventEmitter {
  constructor({ modulePath, expectedManifest = null, instanceId = crypto.randomUUID(), mode = 'standby', logger = console, policy = {} }) {
    super();
    this.modulePath = canonicalCoreModulePath(modulePath);
    this.expectedManifest = expectedManifest;
    this.instanceId = instanceId;
    this.mode = mode;
    this.logger = logger;
    this.policy = normalizePolicy(policy.resources || policy, policy.priority || 'normal');
    this.child = null;
    this.manifest = null;
    this.lifecycle = 'starting';
    this.pending = new Map();
    this.pendingOutputs = new Set();
    this.outputsByEvent = new Map();
    this.requestCounter = 0;
    this.stopping = false;
    this.restarting = false;
    this.quarantined = false;
    this.restartHistory = [];
    this.recoveryState = {};
    this.recoveryStateSchema = expectedManifest?.stateSchema || null;
    this.lastHeartbeat = null;
    this.lastExit = null;
    this.generation = 0;
    this.logWindowStartedAt = Date.now();
    this.logMessagesInWindow = 0;
    this.logBytesInWindow = 0;
    this.suppressedLogs = 0;
    this.governor = new ResourceGovernor({
      name: `${expectedManifest?.coreId || path.basename(modulePath)}:${instanceId}`,
      getPid: () => this.child?.pid || null,
      policy: this.policy,
      logger,
      onSoftLimit: detail => this.emit('resource-warning', detail),
      onHardLimit: detail => this.recycle(detail.type || 'hard-resource-limit', detail)
    });
    this.cgroup = new CgroupGovernor({
      name: `${expectedManifest?.coreId || path.basename(modulePath)}-${instanceId}`,
      policy: this.policy
    });
  }

  get pid() { return this.child?.pid || null; }

  async start(initialState = {}, fromStateSchema = null) {
    this.recoveryState = structuredClone(initialState || {});
    this.recoveryStateSchema = Number(fromStateSchema) || this.expectedManifest?.stateSchema || null;
    await this.spawn();
    this.governor.start();
    return this;
  }

  async spawn() {
    if (this.quarantined) throw Object.assign(new Error('CoreHost is quarantined after a restart storm'), { code: 'COREHOST_QUARANTINED' });
    this.lifecycle = this.generation ? 'recovering' : 'starting';
    await this.cgroup.prepare();
    const child = fork(HOST_PATH, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'advanced',
      execArgv: [
        '--disable-sigusr1',
        `--max-old-space-size=${Math.max(16, Math.floor(this.policy.hardRamBytes / (1024 * 1024) * 0.8))}`,
        ...(this.expectedManifest?.coreId === 'fetus-legacy' ? [] : nativeCoreExecArgv(this.modulePath))
      ],
      env: coreHostEnvironment({ compatibility: this.expectedManifest?.coreId === 'fetus-legacy' })
    });
    this.child = child;
    try { await this.cgroup.attach(child.pid); }
    catch (error) { child.kill('SIGKILL'); this.child = null; throw error; }
    this.generation += 1;
    child.stdout?.on('data', chunk => this.forwardLog('info', [String(chunk).slice(0, 8192).trim()]));
    child.stderr?.on('data', chunk => this.forwardLog('warn', [String(chunk).slice(0, 8192).trim()]));
    child.on('message', message => this.onMessage(message, child));
    child.once('exit', (code, signal) => this.onExit(child, code, signal));
    child.once('error', error => this.emit('error', error));
    const result = await this.request('init', {
      modulePath: this.modulePath,
      expectedCoreId: this.expectedManifest?.coreId || null,
      expectedVersion: this.expectedManifest?.version || null,
      expectedManifest: this.expectedManifest,
      initialState: this.recoveryState,
      fromStateSchema: this.recoveryStateSchema,
      mode: this.mode,
      heartbeatIntervalMs: Math.min(2000, Math.max(250, this.policy.healthTimeoutMs)),
      outputLimitPerEvent: this.policy.outputLimitPerEvent,
      outputBytesPerEvent: this.policy.outputBytesPerEvent
    }, Math.max(2000, this.policy.handlerTimeoutMs));
    this.manifest = validateManifest(result.manifest);
    this.recoveryStateSchema = this.manifest.stateSchema;
    this.lifecycle = this.mode === 'active' ? 'active' : this.mode === 'shadow' ? 'shadow' : 'standby';
    this.emit('lifecycle', this.lifecycle);
  }

  onMessage(message, child) {
    if (child !== this.child || !message || message.protocol !== IPC_PROTOCOL || message.protocolVersion !== IPC_PROTOCOL_VERSION) return;
    try { assertPayload(message, 'CoreHost inbound message'); }
    catch (error) { this.emit('protocol-error', error); this.recycle('protocol-payload-limit').catch(() => {}); return; }
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(reviveError(message.error));
      return;
    }
    if (message.type === 'output') {
      if (this.pendingOutputs.size >= this.policy.outputCapacity) {
        const error = Object.assign(new Error('CoreHost pending output limit exceeded'), { code: 'COREHOST_OUTPUT_LIMIT' });
        this.emit('output-error', error);
        this.recycle('output-backpressure', { pendingOutputs: this.pendingOutputs.size }).catch(() => {});
        return;
      }
      const promise = Promise.resolve().then(() => this.emitAsync('output', message));
      const eventSequence = Number(message.context?.eventSequence) || 0;
      if (!this.outputsByEvent.has(eventSequence)) this.outputsByEvent.set(eventSequence, new Set());
      this.outputsByEvent.get(eventSequence).add(promise);
      promise.catch(error => this.emit('output-error', error));
      this.pendingOutputs.add(promise);
      promise.then(
        () => this.pendingOutputs.delete(promise),
        () => this.pendingOutputs.delete(promise)
      );
      return;
    }
    if (message.type === 'heartbeat') { this.lastHeartbeat = message; return; }
    if (message.type === 'log') {
      const method = ['warn', 'error', 'info'].includes(message.level) ? message.level : 'log';
      this.forwardLog(method, message.args || []);
      return;
    }
    if (message.type === 'fatal') this.emit('fatal', message.error);
  }

  forwardLog(method, args) {
    const now = Date.now();
    if (now - this.logWindowStartedAt >= 1000) {
      if (this.suppressedLogs > 0) this.logger.warn?.(`[CoreHost ${this.instanceId}] suppressed ${this.suppressedLogs} rate-limited log messages`);
      this.logWindowStartedAt = now;
      this.logMessagesInWindow = 0;
      this.logBytesInWindow = 0;
      this.suppressedLogs = 0;
    }
    const values = args.map(value => String(value).slice(0, 2000)).slice(0, 12);
    const bytes = Buffer.byteLength(values.join(' '));
    if (this.logMessagesInWindow >= 40 || this.logBytesInWindow + bytes > 64 * 1024) {
      this.suppressedLogs += 1;
      return false;
    }
    this.logMessagesInWindow += 1;
    this.logBytesInWindow += bytes;
    this.logger[method]?.(`[CoreHost ${this.instanceId}]`, ...values);
    return true;
  }

  async emitAsync(name, ...args) {
    for (const listener of this.listeners(name)) await listener(...args);
  }

  onExit(child, code, signal) {
    if (child !== this.child) return;
    this.child = null;
    this.lastExit = { at: new Date().toISOString(), code, signal };
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error(`CoreHost exited (${code ?? signal})`), { code: 'COREHOST_EXIT' }));
    }
    this.pending.clear();
    this.outputsByEvent.clear();
    if (this.stopping || this.restarting) return;
    this.scheduleRestart('unexpected-exit').catch(error => this.emit('error', error));
  }

  request(operation, payload = {}, timeoutMs = this.policy.handlerTimeoutMs) {
    if (!this.child?.connected) return Promise.reject(Object.assign(new Error('CoreHost is not connected'), { code: 'COREHOST_OFFLINE' }));
    if (this.pending.size >= 128) return Promise.reject(Object.assign(new Error('CoreHost pending request limit exceeded'), { code: 'COREHOST_PENDING_LIMIT' }));
    const requestId = `${process.pid}-${++this.requestCounter}-${crypto.randomBytes(4).toString('hex')}`;
    const message = { protocol: IPC_PROTOCOL, protocolVersion: IPC_PROTOCOL_VERSION, requestId, operation, payload };
    assertPayload(message, 'CoreHost outbound message');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = Object.assign(new Error(`CoreHost ${operation} exceeded ${timeoutMs} ms`), { code: 'COREHOST_TIMEOUT' });
        reject(error);
        if (operation === 'event' || operation === 'health') this.recycle(`timeout:${operation}`).catch(() => {});
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer, operation });
      this.child.send(message, error => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async dispatch(event, context) {
    const eventSequence = Number(context?.eventSequence || event?.sequence || event?.id) || 0;
    let result;
    let requestError = null;
    try { result = await this.request('event', { event, context }, this.policy.handlerTimeoutMs); }
    catch (error) { requestError = error; }
    try {
      const outputs = [...(this.outputsByEvent.get(eventSequence) || [])];
      if (outputs.length) {
        const settled = await Promise.allSettled(outputs);
        const failures = settled.filter(entry => entry.status === 'rejected');
        if (failures.length) {
          throw Object.assign(new AggregateError(failures.map(entry => entry.reason), 'CoreHost output delivery failed'), {
            code: 'COREHOST_OUTPUT_DELIVERY_FAILED'
          });
        }
      }
      if (requestError) throw requestError;
      let checkpoint = null;
      if (['critical', 'durable'].includes(event.class)) {
        checkpoint = await this.request('snapshot', {}, this.policy.handlerTimeoutMs);
      }
      return { result, checkpoint };
    } finally { this.outputsByEvent.delete(eventSequence); }
  }

  async snapshot() {
    const value = await this.request('snapshot', {}, this.policy.handlerTimeoutMs);
    this.recoveryState = structuredClone(value || {});
    return value;
  }

  async health() { return this.request('health', {}, this.policy.healthTimeoutMs); }

  async setMode(mode) {
    this.mode = mode;
    if (this.child?.connected) await this.request('mode', { mode }, this.policy.healthTimeoutMs);
    this.lifecycle = mode === 'active' ? 'active' : mode === 'shadow' ? 'shadow' : 'standby';
    this.emit('lifecycle', this.lifecycle);
  }

  setRecoveryState(state, stateSchema = this.manifest?.stateSchema) {
    this.recoveryState = structuredClone(state || {});
    this.recoveryStateSchema = Number(stateSchema) || this.recoveryStateSchema;
  }

  async recycle(reason, detail = null) {
    if (this.stopping || this.restarting || this.quarantined) return;
    this.restarting = true;
    this.lifecycle = 'recovering';
    this.emit('lifecycle', this.lifecycle, { reason, detail });
    try {
      if (this.child?.connected && !['timeout:event', 'timeout:health', 'actor-handler-timeout', 'uncommitted-transition'].includes(reason)) {
        try { this.recoveryState = await this.request('snapshot', {}, Math.min(1000, this.policy.handlerTimeoutMs)); }
        catch {}
      }
      const old = this.child;
      if (old) {
        if (['timeout:event', 'timeout:health', 'actor-handler-timeout', 'uncommitted-transition'].includes(reason)) {
          old.kill('SIGKILL');
          await waitForExit(old, 1000);
        } else {
          try { if (old.connected) await this.request('stop', {}, Math.max(15000, this.policy.handlerTimeoutMs)); }
          catch { old.kill('SIGTERM'); }
          await waitForExit(old, 16000);
          if (old.exitCode == null && old.signalCode == null) old.kill('SIGKILL');
        }
      }
      this.child = null;
      await this.noteRestart(reason);
      if (!this.quarantined && !this.stopping) await this.spawn();
    } finally {
      this.restarting = false;
    }
  }

  async scheduleRestart(reason) {
    if (this.stopping || this.restarting || this.quarantined) return;
    this.restarting = true;
    this.lifecycle = 'recovering';
    try {
      await this.noteRestart(reason);
      if (!this.quarantined && !this.stopping) await this.spawn();
    } finally { this.restarting = false; }
  }

  async noteRestart(reason) {
    const now = Date.now();
    this.restartHistory.push({ at: now, reason });
    this.restartHistory = this.restartHistory.filter(entry => entry.at >= now - this.policy.restartWindowMs);
    if (this.restartHistory.length > this.policy.maxRestarts) {
      this.quarantined = true;
      this.lifecycle = 'failed';
      this.emit('quarantined', { reason: 'restart-storm', restarts: this.restartHistory.length });
      return;
    }
    const backoff = Math.min(10000, this.policy.restartBackoffMs * (2 ** Math.max(0, this.restartHistory.length - 1)));
    await delay(backoff);
  }

  status() {
    return {
      instanceId: this.instanceId,
      pid: this.pid,
      generation: this.generation,
      lifecycle: this.lifecycle,
      mode: this.mode,
      quarantined: this.quarantined,
      restartCountInWindow: this.restartHistory.length,
      lastHeartbeat: this.lastHeartbeat,
      lastExit: this.lastExit,
      resourceGovernor: this.governor.status(),
      osContainment: this.cgroup.status(),
      logRateLimit: { messagesPerSecond: 40, bytesPerSecond: 64 * 1024, suppressed: this.suppressedLogs }
    };
  }

  async stop() {
    this.stopping = true;
    this.governor.stop();
    const child = this.child;
    if (!child) { await this.cgroup.stop(); return; }
    const stopTimeoutMs = this.expectedManifest?.coreId === 'fetus-legacy'
      ? Math.max(15000, this.policy.handlerTimeoutMs)
      : Math.max(500, Math.min(2000, this.policy.handlerTimeoutMs));
    try { await this.request('stop', {}, stopTimeoutMs); } catch {}
    await waitForExit(child, stopTimeoutMs + 500);
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
    await waitForExit(child, 1000);
    await this.cgroup.stop();
    this.child = null;
    this.lifecycle = 'failed';
  }
}

module.exports = { CoreHostClient, HOST_PATH };
