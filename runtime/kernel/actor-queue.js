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

class BoundedActorQueue {
  constructor({
    name,
    handler,
    capacity = 256,
    handlerTimeoutMs = 5000,
    clock = () => Date.now(),
    onFault = () => {}
  }) {
    if (typeof handler !== 'function') throw new Error('actor queue requires a handler');
    this.name = name || 'actor';
    this.handler = handler;
    this.capacity = Math.max(1, Number(capacity) || 256);
    this.handlerTimeoutMs = Math.max(1, Number(handlerTimeoutMs) || 5000);
    this.clock = clock;
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
        const result = await withTimeout(
          Promise.resolve().then(() => this.handler(item.event)),
          this.handlerTimeoutMs,
          `${this.name} handler`
        );
        this.metrics.completed += 1;
        this.lastCompletedSequence = Math.max(this.lastCompletedSequence, Number(item.event?.sequence || item.event?.id) || 0);
        item.resolve({ delivered: true, result });
      } catch (error) {
        this.metrics.failed += 1;
        if (error.code === 'ACTOR_HANDLER_TIMEOUT') this.metrics.timedOut += 1;
        this.metrics.lastError = { code: error.code || null, message: error.message, at: new Date().toISOString() };
        this.failures.push({ sequence: this.runningSequence, error });
        if (this.failures.length > 128) this.failures.shift();
        item.reject(error);
        this.onFault(error, item.event);
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
    return { ...this.metrics, depth: this.depth, capacity: this.capacity, lastCompletedSequence: this.lastCompletedSequence };
  }

  close(error = Object.assign(new Error(`${this.name} queue closed`), { code: 'ACTOR_QUEUE_CLOSED' })) {
    this.closed = true;
    for (const item of this.items.splice(0)) item.reject(error);
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

module.exports = { BoundedActorQueue, withTimeout };
