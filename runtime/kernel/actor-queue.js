'use strict';

const { normalizeEventClass } = require('./protocol');

function withTimeout(promise, timeoutMs, label) {
  if (!(timeoutMs > 0)) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} exceeded ${timeoutMs} ms`);
      error.code = 'ACTOR_HANDLER_TIMEOUT';
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function timeoutError(label, timeoutMs, code) {
  return Object.assign(
    new Error(`${label} exceeded ${timeoutMs} ms`),
    { code }
  );
}

/*
 * A deadline is an observation, not cancellation.
 *
 * Promise.race() alone is unsafe for a stateful actor: the timed-out handler
 * keeps running and a retry can overtake it, applying one durable event twice.
 * Keep ownership of the original promise, allow a bounded settlement window,
 * and refuse replay if the original work cannot be proven settled.
 */
async function settleThroughDeadline({
  promise,
  timeoutMs,
  settlementGraceMs,
  label,
  timeoutCode,
  stalledCode,
  onDeadline = () => {}
}) {
  const settled = Promise.resolve(promise).then(
    value => ({ status: 'fulfilled', value }),
    error => ({ status: 'rejected', error })
  );
  let deadlineTimer;
  const first = await Promise.race([
    settled,
    new Promise(resolve => {
      deadlineTimer = setTimeout(
        () => resolve({ status: 'deadline' }),
        timeoutMs
      );
      deadlineTimer.unref?.();
    })
  ]);
  clearTimeout(deadlineTimer);

  if (first.status === 'fulfilled') {
    return { value: first.value, exceededDeadline: false };
  }
  if (first.status === 'rejected') throw first.error;

  const observed = timeoutError(label, timeoutMs, timeoutCode);
  try { onDeadline(observed); } catch {}

  let graceTimer;
  const late = await Promise.race([
    settled,
    new Promise(resolve => {
      graceTimer = setTimeout(
        () => resolve({ status: 'stalled' }),
        settlementGraceMs
      );
      graceTimer.unref?.();
    })
  ]);
  clearTimeout(graceTimer);

  if (late.status === 'fulfilled') {
    return { value: late.value, exceededDeadline: true };
  }
  if (late.status === 'rejected') throw late.error;

  throw Object.assign(
    timeoutError(
      `${label} did not settle after its deadline`,
      settlementGraceMs,
      stalledCode
    ),
    {
      deadlineCode: timeoutCode,
      deadlineMs: timeoutMs,
      settlementGraceMs
    }
  );
}

class BoundedActorQueue {
  constructor({
    name,
    handler,
    capacity = 256,
    handlerTimeoutMs = 5000,
    settlementGraceMs = 5000,
    recoveryTimeoutMs = 15000,
    recoverySettlementGraceMs = 5000,
    maxAttempts = 3,
    clock = () => Date.now(),
    recoverFailure = null,
    onSlow = () => {},
    onFault = () => {}
  }) {
    if (typeof handler !== 'function') throw new Error('actor queue requires a handler');
    this.name = name || 'actor';
    this.handler = handler;
    this.capacity = Math.max(1, Number(capacity) || 256);
    this.handlerTimeoutMs = Math.max(1, Number(handlerTimeoutMs) || 5000);
    this.settlementGraceMs = Math.max(1, Number(settlementGraceMs) || 5000);
    this.recoveryTimeoutMs = Math.max(1, Number(recoveryTimeoutMs) || 15000);
    this.recoverySettlementGraceMs = Math.max(
      1,
      Number(recoverySettlementGraceMs) || 5000
    );
    this.maxAttempts = Math.max(1, Math.min(8, Number(maxAttempts) || 3));
    this.clock = clock;
    this.recoverFailure = typeof recoverFailure === 'function'
      ? recoverFailure
      : null;
    this.onSlow = onSlow;
    this.onFault = onFault;
    this.items = [];
    this.running = false;
    this.runningSequence = null;
    this.closed = false;
    this.lastCompletedSequence = 0;
    this.lastDrainedSequence = 0;
    this.failures = [];
    this.waiters = [];
    this.metrics = {
      enqueued: 0,
      completed: 0,
      dropped: 0,
      coalesced: 0,
      failed: 0,
      timedOut: 0,
      stalled: 0,
      attempts: 0,
      recoveryAttempts: 0,
      recovered: 0,
      recoveryRejected: 0,
      recoveryTimedOut: 0,
      lateCompleted: 0,
      maxDepth: 0,
      maxLatencyMs: 0,
      lastLatencyMs: 0,
      lastError: null
    };
  }

  enqueue(event) {
    if (this.closed) return Promise.reject(Object.assign(new Error(`${this.name} queue is closed`), { code: 'ACTOR_QUEUE_CLOSED' }));
    const eventClass = normalizeEventClass(event?.class || event?.meta?.eventClass);
    const coalesceKey = eventClass === 'telemetry'
      ? String(event?.meta?.coalesceKey || event?.topic || '')
      : null;

    if (coalesceKey) {
      const existing = this.items.find(item => item.coalesceKey === coalesceKey);
      if (existing) {
        existing.event = event;
        existing.enqueuedAt = this.clock();
        this.metrics.coalesced += 1;
        return existing.promise;
      }
    }

    if (this.depth >= this.capacity) {
      if (eventClass === 'best-effort' || eventClass === 'telemetry') {
        this.metrics.dropped += 1;
        return Promise.resolve({ delivered: false, dropped: true, reason: 'queue-capacity' });
      }
      const error = new Error(`${this.name} queue capacity ${this.capacity} exceeded for ${eventClass} event`);
      error.code = 'ACTOR_QUEUE_OVERFLOW';
      this.metrics.failed += 1;
      this.metrics.lastError = { code: error.code, message: error.message, at: new Date().toISOString() };
      this.onFault(error, event);
      return Promise.reject(error);
    }

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.items.push({ event, eventClass, coalesceKey, enqueuedAt: this.clock(), promise, resolve, reject });
    this.metrics.enqueued += 1;
    this.metrics.maxDepth = Math.max(this.metrics.maxDepth, this.depth);
    this.pump();
    return promise;
  }

  get depth() { return this.items.length + (this.running ? 1 : 0); }

  async runHandlerAttempt(item, attempt) {
    this.metrics.attempts += 1;
    const transition = Promise.resolve().then(() => this.handler(item.event));
    return settleThroughDeadline({
      promise: transition,
      timeoutMs: this.handlerTimeoutMs,
      settlementGraceMs: this.settlementGraceMs,
      label: `${this.name} handler`,
      timeoutCode: 'ACTOR_HANDLER_TIMEOUT',
      stalledCode: 'ACTOR_HANDLER_STALLED',
      onDeadline: error => {
        this.metrics.timedOut += 1;
        this.onSlow(error, item.event, { attempt });
      }
    });
  }

  async recover(item, error, attempt) {
    if (
      !this.recoverFailure ||
      attempt >= this.maxAttempts ||
      ['ACTOR_HANDLER_STALLED', 'ACTOR_RECOVERY_STALLED'].includes(error?.code)
    ) return false;
    this.metrics.recoveryAttempts += 1;
    let result;
    try {
      result = await settleThroughDeadline({
        promise: Promise.resolve().then(() => this.recoverFailure(
          error,
          item.event,
          {
            attempt,
            nextAttempt: attempt + 1,
            maxAttempts: this.maxAttempts,
            eventSequence: this.runningSequence
          }
        )),
        timeoutMs: this.recoveryTimeoutMs,
        settlementGraceMs: this.recoverySettlementGraceMs,
        label: `${this.name} recovery`,
        timeoutCode: 'ACTOR_RECOVERY_TIMEOUT',
        stalledCode: 'ACTOR_RECOVERY_STALLED',
        onDeadline: () => { this.metrics.recoveryTimedOut += 1; }
      });
    } catch (recoveryError) {
      this.metrics.recoveryRejected += 1;
      recoveryError.cause ||= error;
      throw recoveryError;
    }
    if (result.value !== true) {
      this.metrics.recoveryRejected += 1;
      return false;
    }
    this.metrics.recovered += 1;
    return true;
  }

  recordTerminalFailure(item, error) {
    this.metrics.failed += 1;
    if (error.code === 'ACTOR_HANDLER_STALLED' || error.code === 'ACTOR_RECOVERY_STALLED') {
      this.metrics.stalled += 1;
    }
    this.metrics.lastError = {
      code: error.code || null,
      message: error.message,
      at: new Date().toISOString()
    };
    this.failures.push({ sequence: this.runningSequence, error });
    if (this.failures.length > 128) this.failures.shift();
    item.reject(error);
    this.resolveWaiters();
    try { this.onFault(error, item.event); } catch {}
  }

  async pump() {
    if (this.running || this.closed) return;
    this.running = true;
    while (!this.closed && this.items.length) {
      const item = this.items.shift();
      this.runningSequence = Number(item.event?.sequence || item.event?.id) || 0;
      const latencyMs = Math.max(0, this.clock() - item.enqueuedAt);
      this.metrics.lastLatencyMs = latencyMs;
      this.metrics.maxLatencyMs = Math.max(this.metrics.maxLatencyMs, latencyMs);
      try {
        let result;
        let attempt = 1;
        for (;;) {
          try {
            const completed = await this.runHandlerAttempt(item, attempt);
            result = completed.value;
            if (completed.exceededDeadline) this.metrics.lateCompleted += 1;
            break;
          } catch (error) {
            const shouldRetry = await this.recover(item, error, attempt);
            if (!shouldRetry) throw error;
            attempt += 1;
          }
        }
        this.metrics.completed += 1;
        this.lastCompletedSequence = Math.max(this.lastCompletedSequence, Number(item.event?.sequence || item.event?.id) || 0);
        item.resolve({ delivered: true, result });
      } catch (error) {
        this.recordTerminalFailure(item, error);
      }
      this.runningSequence = null;
      this.resolveWaiters();
    }
    this.running = false;
    this.resolveWaiters();
  }

  resolveWaiters() {
    const remaining = [];
    for (const waiter of this.waiters) {
      const failed = this.failures.find(entry => entry.sequence > waiter.failureFloor && entry.sequence <= waiter.sequence);
      if (failed) {
        waiter.reject(Object.assign(new AggregateError([failed.error], `${this.name} failed before cutover barrier ${waiter.sequence}`), {
          code: 'ACTOR_DRAIN_FAILED', eventSequence: failed.sequence
        }));
        continue;
      }
      const queuedThroughTarget = this.items.some(item => (Number(item.event?.sequence || item.event?.id) || 0) <= waiter.sequence);
      const runningThroughTarget = this.runningSequence != null && this.runningSequence <= waiter.sequence;
      if (!queuedThroughTarget && !runningThroughTarget) {
        this.lastDrainedSequence = Math.max(this.lastDrainedSequence, waiter.sequence);
        waiter.resolve();
      } else remaining.push(waiter);
    }
    this.waiters = remaining;
  }

  resolveRetriedFailure(sequence, allowedCodes = ['COREHOST_TIMEOUT', 'COREHOST_EXIT']) {
    const target = Number(sequence) || 0;
    if (!(target > 0) || this.lastCompletedSequence < target) {
      throw Object.assign(new Error(`${this.name} retry cannot clear an uncompleted failure`), {
        code: 'ACTOR_RETRY_NOT_COMPLETED', eventSequence: target
      });
    }
    const allowed = new Set(allowedCodes.map(value => String(value)));
    const matching = this.failures.filter(entry => entry.sequence === target);
    const blocked = matching.find(entry => !allowed.has(String(entry.error?.code || '')));
    if (blocked) {
      throw Object.assign(new Error(`${this.name} retry cannot clear non-retryable failure`), {
        code: 'ACTOR_RETRY_FAILURE_CLASS', eventSequence: target, failureCode: blocked.error?.code || null
      });
    }
    const before = this.failures.length;
    this.failures = this.failures.filter(entry => !(entry.sequence === target && allowed.has(String(entry.error?.code || ''))));
    return before - this.failures.length;
  }

  drainThrough(sequence, timeoutMs = 5000) {
    const target = Number(sequence) || 0;
    const failureFloor = this.lastDrainedSequence;
    const failed = this.failures.find(entry => entry.sequence > failureFloor && entry.sequence <= target);
    if (failed) return Promise.reject(Object.assign(new AggregateError([failed.error], `${this.name} failed before cutover barrier ${target}`), {
      code: 'ACTOR_DRAIN_FAILED', eventSequence: failed.sequence
    }));
    const queuedThroughTarget = this.items.some(item => (Number(item.event?.sequence || item.event?.id) || 0) <= target);
    const runningThroughTarget = this.runningSequence != null && this.runningSequence <= target;
    if (!queuedThroughTarget && !runningThroughTarget) {
      this.lastDrainedSequence = Math.max(this.lastDrainedSequence, target);
      return Promise.resolve();
    }
    const promise = new Promise((resolve, reject) => this.waiters.push({ sequence: target, failureFloor, resolve, reject }));
    return withTimeout(promise, timeoutMs, `${this.name} cutover drain`);
  }

  snapshotMetrics() {
    return {
      ...this.metrics,
      depth: this.depth,
      capacity: this.capacity,
      closed: this.closed,
      runningSequence: this.runningSequence,
      lastCompletedSequence: this.lastCompletedSequence,
      lastDrainedSequence: this.lastDrainedSequence,
      contract: {
        handlerTimeoutMs: this.handlerTimeoutMs,
        settlementGraceMs: this.settlementGraceMs,
        recoveryTimeoutMs: this.recoveryTimeoutMs,
        recoverySettlementGraceMs: this.recoverySettlementGraceMs,
        maxAttempts: this.maxAttempts
      }
    };
  }

  close(error = Object.assign(new Error(`${this.name} queue closed`), { code: 'ACTOR_QUEUE_CLOSED' })) {
    this.closed = true;
    for (const item of this.items.splice(0)) item.reject(error);
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

module.exports = { BoundedActorQueue, withTimeout, settleThroughDeadline };
