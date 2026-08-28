'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { validateManifest } = require('./manifest');
const { IPC_PROTOCOL, IPC_PROTOCOL_VERSION, assertPayload, errorRecord } = require('./protocol');
const { ResourceGovernor, normalizePolicy } = require('./resource-governor');
const { canonicalCoreModulePath, trustedCoreHostExecArgv, nativeCoreExecArgv, coreHostEnvironment } = require('./core-sandbox');
const { CgroupGovernor, processDescendants } = require('./cgroup-governor');
const { enforcePackagePolicy, verifyManifestAgainstPackagePolicy } = require('./package-policy');

const HOST_PATH = path.join(__dirname, '..', 'core-host', 'host.js');
const COREHOST_COLD_INIT_TIMEOUT_MS = 10000;
const CHRONOBIOLOGY_GENESIS_TIMEOUT_MS = 5000;
const COREHOST_IPC_MARGIN_MS = 750;
const COREHOST_PAYLOAD_ATTACH_TIMEOUT_MS = 5000;

const REPLAY_RECOVERY_CODES = new Set([
  'COREHOST_TIMEOUT',
  'COREHOST_EXIT',
  'COREHOST_OFFLINE',
  'CORE_WORKER_TIMEOUT',
  'CORE_WORKER_EXIT',
  'CORE_WORKER_OFFLINE'
]);

function coreHostInitTimeoutMs(handlerTimeoutMs) {
  return Math.max(
    COREHOST_COLD_INIT_TIMEOUT_MS,
    Number(handlerTimeoutMs) || 0
  );
}

function isChronobiologyGenesisTransition(coreId, recoveryState, event) {
  return coreId === 'chronobiology' &&
    recoveryState?.genesis == null &&
    event?.topic === 'runtime.trusted-organism-time.pulse';
}

function coreHostHandlerTimeoutMs({ handlerTimeoutMs }) {
  /* Candidate computation remains fenced by the manifest deadline. The
   * separately reported IPC margin covers trusted supervisor transport only. */
  return Math.max(1, Number(handlerTimeoutMs) || 1);
}

function coreHostDispatchTimeoutMs({ coreId, coreVersion, recoveryState, event, handlerTimeoutMs }) {
  const ordinary = coreHostHandlerTimeoutMs({
    coreId,
    coreVersion,
    handlerTimeoutMs
  });
  const workerTimeoutMs = isChronobiologyGenesisTransition(coreId, recoveryState, event)
    ? Math.max(CHRONOBIOLOGY_GENESIS_TIMEOUT_MS, ordinary)
    : ordinary;
  return workerTimeoutMs + COREHOST_IPC_MARGIN_MS;
}

function coreHostWorkerTimeoutMs(options) {
  const ipcTimeoutMs = coreHostDispatchTimeoutMs(options);
  return ipcTimeoutMs - COREHOST_IPC_MARGIN_MS;
}

function replayRecoverableCoreHostError(error) {
  return REPLAY_RECOVERY_CODES.has(String(error?.code || ''));
}

function reviveError(record) {
  const error = new Error(record?.message || 'CoreHost request failed');
  error.name = record?.name || 'Error';
  error.code = record?.code || null;
  error.coreHostOperation = record?.operation || null;
  error.timeoutMs = Number(record?.timeoutMs) || null;
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

async function signalAndWait(
  child,
  signal,
  timeoutMs
) {
  if (hasExited(child)) return true;

  try {
    child.kill(signal);
  } catch (error) {
    if (
      error.code !== 'ESRCH'
    ) {
      throw error;
    }
  }

  await waitForExit(
    child,
    timeoutMs
  );

  return hasExited(child);
}

class CoreHostClient extends EventEmitter {
  constructor({ modulePath, expectedManifest = null, instanceId = crypto.randomUUID(), mode = 'standby', logger = console, policy = {} }) {
    super();
    this.modulePath = canonicalCoreModulePath(modulePath);
    this.packagePolicy = enforcePackagePolicy(this.modulePath);
    this.expectedManifest = expectedManifest;
    this.instanceId = instanceId;
    this.mode = mode;
    this.logger = logger;
    this.policy = normalizePolicy(policy.resources || policy, policy.priority || 'normal');
    this.handlerTimeoutMs = coreHostHandlerTimeoutMs({
      coreId: expectedManifest?.coreId,
      coreVersion: expectedManifest?.version,
      handlerTimeoutMs: this.policy.handlerTimeoutMs
    });
    if (expectedManifest) verifyManifestAgainstPackagePolicy(this.packagePolicy, expectedManifest);
    this.child = null;
    this.manifest = null;
    this.lifecycle = 'starting';
    this.pending = new Map();
    this.pendingOutputs = new Set();
    this.outputsByEvent = new Map();
    this.requestCounter = 0;
    this.stopping = false;
    this.restarting = false;
    this.spawning = false;
    this.recoveryPromise = null;
    this.operationChain = Promise.resolve();
    this.quarantined = false;
    this.restartHistory = [];
    this.recoveryState = {};
    this.recoveryStateSchema = expectedManifest?.stateSchema || null;
    this.payloadAttachmentGeneration = 0;
    this.payloadAttachmentTokens = new Set();
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
      getCgroupPath: () => this.cgroup?.directory || null,
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
    if (this.spawning) throw Object.assign(new Error('CoreHost spawn is already in progress'), { code: 'COREHOST_SPAWN_IN_FLIGHT' });
    if (this.child && !hasExited(this.child)) {
      throw Object.assign(new Error('CoreHost is already running'), { code: 'COREHOST_ALREADY_RUNNING' });
    }
    this.spawning = true;
    this.lifecycle = this.generation ? 'recovering' : 'starting';
    let child = null;
    try {
      await this.cgroup.prepare();
      await this.cgroup.configure();
      await this.cgroup.quiesce();
      const memoryPlan = this.policy.memoryPlan;
      child = fork(HOST_PATH, [], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        serialization: 'advanced',
        execArgv: [
          '--disable-sigusr1',
          '--jitless',
          `--max-old-space-size=${memoryPlan.supervisorOldSpaceMiB}`,
          `--max-semi-space-size=${memoryPlan.supervisorSemiSpaceMiB}`,
          ...(this.expectedManifest?.coreId === 'fetus-legacy'
            ? []
            : process.env.STAY_REQUIRE_OS_CORE_SANDBOX === '1'
              ? trustedCoreHostExecArgv(this.modulePath)
              : nativeCoreExecArgv(this.modulePath))
        ],
        env: coreHostEnvironment({ compatibility: this.expectedManifest?.coreId === 'fetus-legacy' })
      });
      this.child = child;
      this.generation += 1;
      child.stdout?.on('data', chunk => this.forwardLog('info', [String(chunk).slice(0, 8192).trim()]));
      child.stderr?.on('data', chunk => this.forwardLog('warn', [String(chunk).slice(0, 8192).trim()]));
      child.on('message', message => this.onMessage(message, child));
      child.once('exit', (code, signal) => this.onExit(child, code, signal));
      child.once('error', error => this.emit('error', error));
      const initTimeoutMs = coreHostInitTimeoutMs(this.policy.handlerTimeoutMs);
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
        outputBytesPerEvent: this.policy.outputBytesPerEvent,
        workerMemoryPlan: memoryPlan,
        workerInitTimeoutMs: initTimeoutMs,
        payloadAttachTimeoutMs: COREHOST_PAYLOAD_ATTACH_TIMEOUT_MS
      }, initTimeoutMs + COREHOST_PAYLOAD_ATTACH_TIMEOUT_MS + COREHOST_IPC_MARGIN_MS);
      if (result.payloadAttachmentAcknowledged === true) {
        if (
          this.cgroup.required &&
          this.payloadAttachmentGeneration !== this.generation
        ) {
          throw Object.assign(
            new Error('Core payload initialized without required pre-init cgroup attachment'),
            { code: 'CGROUP_PREINIT_ATTACHMENT' }
          );
        }
      } else {
        /*
         * Compatibility/direct hosts contain the core in the supervisor
         * process and do not implement the two-process pre-init handshake.
         */
        try {
          await this.cgroup.attachPayloadTree(child.pid, []);
        } catch (error) {
          child.kill('SIGKILL');
          this.child = null;
          throw error;
        }
      }
      if (hasExited(child) || this.child !== child) {
        throw Object.assign(new Error('CoreHost exited while its payload containment was being established'), {
          code: 'COREHOST_EXIT_DURING_SPAWN',
          coreHostGeneration: this.generation
        });
      }
      this.manifest = validateManifest(result.manifest);
      this.recoveryStateSchema = this.manifest.stateSchema;
      this.lifecycle = this.mode === 'active' ? 'active' : this.mode === 'shadow' ? 'shadow' : 'standby';
      this.emit('lifecycle', this.lifecycle);
    } catch (error) {
      const stopped =
        await signalAndWait(
          child,
          'SIGKILL',
          2000
        ).catch(() => false);

      if (this.child === child) this.child = null;

      if (child && !stopped) {
        throw Object.assign(
          new Error(
            'CoreHost spawn failure left a live supervisor process'
          ),
          {
            code:
              'COREHOST_SPAWN_TEARDOWN',
            cause:
              error,
            coreHostPid:
              child.pid
          }
        );
      }

      throw error;
    } finally {
      this.spawning = false;
    }
  }

  onMessage(message, child) {
    if (child !== this.child || !message || message.protocol !== IPC_PROTOCOL || message.protocolVersion !== IPC_PROTOCOL_VERSION) return;
    try { assertPayload(message, 'CoreHost inbound message'); }
    catch (error) { this.emit('protocol-error', error); this.recycle('protocol-payload-limit').catch(() => {}); return; }
    if (message.type === 'payload-ready') {
      this.handlePayloadReady(message, child).catch(() => {});
      return;
    }
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else {
        const error = reviveError(message.error);
        error.coreHostOperation ||= pending.operation;
        error.coreHostGeneration = pending.generation;
        pending.reject(error);
      }
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

  sendPayloadAttachment(child, message) {
    if (child !== this.child || !child?.connected) {
      return Promise.reject(Object.assign(new Error('CoreHost disconnected during payload attachment'), {
        code: 'COREHOST_OFFLINE'
      }));
    }
    const payload = {
      protocol: IPC_PROTOCOL,
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: 'payload-attached',
      ...message
    };
    assertPayload(payload, 'CoreHost payload attachment acknowledgement');
    return new Promise((resolve, reject) => {
      child.send(payload, error => error ? reject(error) : resolve());
    });
  }

  async handlePayloadReady(message, child) {
    const token = String(message.attachToken || '');
    const workerLauncherPid = Number(message.workerLauncherPid);
    if (
      !/^[a-zA-Z0-9._:-]{1,160}$/.test(token) ||
      !Number.isSafeInteger(workerLauncherPid) ||
      workerLauncherPid <= 1 ||
      this.payloadAttachmentTokens.has(token) ||
      !this.spawning ||
      this.payloadAttachmentGeneration === this.generation
    ) {
      const error = Object.assign(new Error('CoreHost payload attachment request is invalid'), {
        code: 'COREHOST_PAYLOAD_ATTACH_PROTOCOL'
      });
      await this.sendPayloadAttachment(child, {
        attachToken: token,
        ok: false,
        error: errorRecord(error)
      }).catch(() => {});
      throw error;
    }
    this.payloadAttachmentTokens.add(token);
    try {
      if (process.platform === 'linux') {
        const supervisorTree = await processDescendants(child.pid);
        if (
          workerLauncherPid === child.pid ||
          !supervisorTree.includes(workerLauncherPid)
        ) {
          throw Object.assign(
            new Error('Core payload launcher is not a CoreHost descendant'),
            { code: 'COREHOST_PAYLOAD_ATTACH_ANCESTRY' }
          );
        }
      }
      const attached = await this.cgroup.attachPayloadTree(workerLauncherPid, []);
      if (this.cgroup.required && attached !== true) {
        throw Object.assign(new Error('required pre-init payload cgroup attachment failed'), {
          code: 'CGROUP_PREINIT_ATTACHMENT'
        });
      }
      if (attached === true) {
        /* Establish zero-event baselines before candidate initialization. */
        await this.governor.rebaseline();
        this.governor.start({ sampleImmediately: false });
        this.payloadAttachmentGeneration = this.generation;
      }
      await this.sendPayloadAttachment(child, {
        attachToken: token,
        ok: true,
        attached
      });
    } catch (error) {
      await this.sendPayloadAttachment(child, {
        attachToken: token,
        ok: false,
        error: errorRecord(error)
      }).catch(() => {});
      throw error;
    } finally {
      this.payloadAttachmentTokens.delete(token);
    }
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
    const exitedGeneration = this.generation;
    this.child = null;
    this.lastExit = { at: new Date().toISOString(), code, signal, generation: exitedGeneration };
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error(`CoreHost exited (${code ?? signal})`), {
        code: 'COREHOST_EXIT',
        coreHostOperation: pending.operation,
        coreHostGeneration: pending.generation
      }));
    }
    this.pending.clear();
    this.outputsByEvent.clear();
    if (this.stopping || this.restarting || this.spawning) return;
    this.scheduleRestart('unexpected-exit', { code, signal }, exitedGeneration)
      .catch(error => this.emit('error', error));
  }

  serializeOperation(operation, task) {
    const guarded = async () => {
      if (this.recoveryPromise) await this.recoveryPromise;
      return task();
    };
    const run = this.operationChain.then(guarded, guarded);
    this.operationChain = run.catch(() => {});
    return run.catch(error => {
      error.coreHostOperation ||= operation;
      throw error;
    });
  }

  request(operation, payload = {}, timeoutMs = this.policy.handlerTimeoutMs) {
    const child = this.child;
    const generation = this.generation;
    if (!child?.connected) return Promise.reject(Object.assign(new Error('CoreHost is not connected'), {
      code: 'COREHOST_OFFLINE', coreHostOperation: operation, coreHostGeneration: generation
    }));
    if (this.pending.size >= 128) return Promise.reject(Object.assign(new Error('CoreHost pending request limit exceeded'), { code: 'COREHOST_PENDING_LIMIT' }));
    const requestId = `${process.pid}-${++this.requestCounter}-${crypto.randomBytes(4).toString('hex')}`;
    const message = { protocol: IPC_PROTOCOL, protocolVersion: IPC_PROTOCOL_VERSION, requestId, operation, payload };
    assertPayload(message, 'CoreHost outbound message');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = Object.assign(new Error(`CoreHost ${operation} exceeded ${timeoutMs} ms`), {
          code: 'COREHOST_TIMEOUT',
          coreHostOperation: operation,
          coreHostGeneration: generation,
          timeoutMs
        });
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer, operation, generation });
      child.send(message, error => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(timer);
        error.coreHostOperation ||= operation;
        error.coreHostGeneration = generation;
        reject(error);
      });
    });
  }

  async dispatch(event, context) {
    return this.serializeOperation('event', async () => {
      const eventSequence = Number(context?.eventSequence || event?.sequence || event?.id) || 0;
      const deadlineOptions = {
        coreId: this.expectedManifest?.coreId,
        coreVersion: this.expectedManifest?.version,
        recoveryState: this.recoveryState,
        event,
        handlerTimeoutMs: this.handlerTimeoutMs
      };
      const workerTimeoutMs = coreHostWorkerTimeoutMs(deadlineOptions);
      const dispatchTimeoutMs = coreHostDispatchTimeoutMs(deadlineOptions);
      const includeCheckpoint = ['critical', 'durable'].includes(event.class);

      try {
        const transition = await this.request(
          'event',
          {
            event,
            context,
            includeCheckpoint,
            workerTimeoutMs
          },
          dispatchTimeoutMs
        );

        const outputs = [...(this.outputsByEvent.get(eventSequence) || [])];
        if (outputs.length) {
          const settled = await Promise.allSettled(outputs);
          const failures = settled.filter(entry => entry.status === 'rejected');
          if (failures.length) {
            throw Object.assign(
              new AggregateError(
                failures.map(entry => entry.reason),
                'CoreHost output delivery failed'
              ),
              {
                code: 'COREHOST_OUTPUT_DELIVERY_FAILED',
                coreHostGeneration: this.generation
              }
            );
          }
        }

        if (includeCheckpoint && transition?.checkpoint == null) {
          throw Object.assign(new Error('CoreHost event transition omitted its checkpoint'), {
            code: 'COREHOST_CHECKPOINT_MISSING',
            coreHostGeneration: this.generation
          });
        }

        return {
          result: transition?.result ?? transition,
          checkpoint: includeCheckpoint ? transition.checkpoint : null
        };
      } catch (error) {
        error.coreHostOperation ||= 'event';
        error.eventSequence = eventSequence;
        if (
          replayRecoverableCoreHostError(error) ||
          error.code === 'COREHOST_OUTPUT_DELIVERY_FAILED' ||
          error.code === 'COREHOST_CHECKPOINT_MISSING'
        ) {
          this.ensureRecovery(error).catch(recoveryError => this.emit('error', recoveryError));
        }
        throw error;
      } finally {
        this.outputsByEvent.delete(eventSequence);
      }
    });
  }

  async snapshot() {
    return this.serializeOperation('snapshot', async () => {
      const workerTimeoutMs = this.handlerTimeoutMs;
      const value = await this.request(
        'snapshot',
        { workerTimeoutMs },
        workerTimeoutMs + COREHOST_IPC_MARGIN_MS
      );
      this.recoveryState = structuredClone(value || {});
      return value;
    });
  }

  async health() {
    return this.serializeOperation('health', async () => {
      const workerTimeoutMs = this.policy.healthTimeoutMs;
      try {
        return await this.request(
          'health',
          { workerTimeoutMs },
          workerTimeoutMs + COREHOST_IPC_MARGIN_MS
        );
      } catch (error) {
        if (replayRecoverableCoreHostError(error)) {
          this.ensureRecovery(error).catch(recoveryError => this.emit('error', recoveryError));
        }
        throw error;
      }
    });
  }

  async setMode(mode) {
    return this.serializeOperation('mode', async () => {
      this.mode = mode;
      if (this.child?.connected) {
        await this.request(
          'mode',
          { mode, workerTimeoutMs: this.policy.healthTimeoutMs },
          this.policy.healthTimeoutMs + COREHOST_IPC_MARGIN_MS
        );
      }
      this.lifecycle = mode === 'active' ? 'active' : mode === 'shadow' ? 'shadow' : 'standby';
      this.emit('lifecycle', this.lifecycle);
    });
  }

  setRecoveryState(state, stateSchema = this.manifest?.stateSchema) {
    this.recoveryState = structuredClone(state || {});
    this.recoveryStateSchema = Number(stateSchema) || this.recoveryStateSchema;
  }

  ensureRecovery(error) {
    const failedGeneration = Number(error?.coreHostGeneration) || this.generation;
    if (
      this.generation > failedGeneration &&
      !this.restarting &&
      this.child?.connected &&
      this.lifecycle !== 'recovering'
    ) {
      return Promise.resolve({ generation: this.generation, alreadyRecovered: true });
    }
    return this.recycle(
      `fault:${error?.code || 'unknown'}`,
      {
        operation: error?.coreHostOperation || null,
        eventSequence: Number(error?.eventSequence) || null
      },
      failedGeneration
    );
  }

  async recycle(reason, detail = null, failedGeneration = this.generation) {
    if (this.stopping) {
      throw Object.assign(new Error('CoreHost is stopping'), { code: 'COREHOST_STOPPING' });
    }
    if (this.quarantined) {
      throw Object.assign(new Error('CoreHost is quarantined'), { code: 'COREHOST_QUARANTINED' });
    }
    if (this.recoveryPromise) return this.recoveryPromise;

    this.recoveryPromise = (async () => {
      if (
        this.generation > failedGeneration &&
        this.child?.connected &&
        this.lifecycle !== 'recovering'
      ) {
        return { generation: this.generation, alreadyRecovered: true };
      }
      this.restarting = true;
      this.lifecycle = 'recovering';
      this.emit('lifecycle', this.lifecycle, { reason, detail, failedGeneration });
      try {
        /*
         * Never snapshot a faulted process. recoveryState advances only after
         * StateStore has committed the event checkpoint and ledger ACK.
         */
        const old = this.child;
        if (
          old &&
          !await signalAndWait(
            old,
            'SIGKILL',
            2000
          )
        ) {
          throw Object.assign(
            new Error(
              'faulted CoreHost supervisor did not terminate'
            ),
            {
              code:
                'COREHOST_RECOVERY_TEARDOWN',
              coreHostPid:
                old.pid,
              failedGeneration
            }
          );
        }
        if (this.child === old) this.child = null;
        await this.noteRestart(reason);
        if (this.quarantined) {
          throw Object.assign(new Error('CoreHost restart storm'), { code: 'COREHOST_QUARANTINED' });
        }
        if (this.stopping) {
          throw Object.assign(new Error('CoreHost stopped during recovery'), { code: 'COREHOST_STOPPING' });
        }
        await this.spawn();
        if (!(this.generation > failedGeneration) || !this.child?.connected) {
          throw Object.assign(new Error('CoreHost recovery generation did not advance'), {
            code: 'COREHOST_RECOVERY_GENERATION',
            failedGeneration,
            generation: this.generation
          });
        }
        return { generation: this.generation, failedGeneration, alreadyRecovered: false };
      } finally {
        this.restarting = false;
      }
    })();
    try { return await this.recoveryPromise; }
    finally { this.recoveryPromise = null; }
  }

  async scheduleRestart(reason, detail = null, failedGeneration = this.generation) {
    return this.recycle(reason, detail, failedGeneration);
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
      deadlineContract: {
        declaredHandlerTimeoutMs: this.policy.handlerTimeoutMs,
        workerTransitionTimeoutMs: this.handlerTimeoutMs,
        ipcMarginMs: COREHOST_IPC_MARGIN_MS,
        ipcTransitionTimeoutMs: this.handlerTimeoutMs + COREHOST_IPC_MARGIN_MS,
        workerHealthTimeoutMs: this.policy.healthTimeoutMs,
        ipcHealthTimeoutMs: this.policy.healthTimeoutMs + COREHOST_IPC_MARGIN_MS,
        eventAndCheckpointCombined: true,
        outputsReleasedAfterCheckpoint: true
      },
      recoveryInFlight: Boolean(this.recoveryPromise),
      resourceGovernor: this.governor.status(),
      osContainment: {
        ...this.cgroup.status(),
        payloadAttachedBeforeInit:
          this.payloadAttachmentGeneration === this.generation &&
          this.generation > 0
      },
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
    try { await this.request('stop', { workerTimeoutMs: stopTimeoutMs }, stopTimeoutMs + COREHOST_IPC_MARGIN_MS); } catch {}
    await waitForExit(child, stopTimeoutMs + 500);
    if (!hasExited(child)) {
      await signalAndWait(
        child,
        'SIGTERM',
        1000
      );
    }
    if (
      !hasExited(child) &&
      !await signalAndWait(
        child,
        'SIGKILL',
        2000
      )
    ) {
      throw Object.assign(
        new Error(
          'CoreHost supervisor did not terminate during stop'
        ),
        {
          code:
            'COREHOST_STOP_TEARDOWN',
          coreHostPid:
            child.pid
        }
      );
    }
    await this.cgroup.stop();
    this.child = null;
    this.lifecycle = 'failed';
  }
}

module.exports = {
  CoreHostClient,
  HOST_PATH,
  COREHOST_COLD_INIT_TIMEOUT_MS,
  CHRONOBIOLOGY_GENESIS_TIMEOUT_MS,
  COREHOST_IPC_MARGIN_MS,
  COREHOST_PAYLOAD_ATTACH_TIMEOUT_MS,
  REPLAY_RECOVERY_CODES,
  coreHostInitTimeoutMs,
  isChronobiologyGenesisTransition,
  coreHostHandlerTimeoutMs,
  coreHostDispatchTimeoutMs,
  coreHostWorkerTimeoutMs,
  replayRecoverableCoreHostError,
  signalAndWait
};
