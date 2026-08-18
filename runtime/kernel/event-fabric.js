'use strict';

const { assertPayload, normalizeEventClass } = require('./protocol');
const {
  DURABILITY,
  normalizeSignal,
  toEventFabricInput
} = require('./biological-fabric');

class EventFabric {
  constructor({ clock = () => Date.now(), maxPayloadBytes = 1024 * 1024, sequenceAllocator = null, durableAppender = null } = {}) {
    this.clock = clock;
    this.maxPayloadBytes = maxPayloadBytes;
    this.sequenceAllocator = typeof sequenceAllocator === 'function' ? sequenceAllocator : null;
    this.durableAppender = typeof durableAppender === 'function' ? durableAppender : null;
    this.sequence = 0;
    this.topicSubscribers = new Map();
    this.anySubscribers = new Set();
    this.metrics = {
      published: 0,
      deliveryFailures: 0,
      bestEffortFailures: 0,
      durablyAppended: 0,
      deduplicated: 0,
      lastFailure: null
    };
  }

  subscribe(topic, handler) {
    if (!this.topicSubscribers.has(topic)) this.topicSubscribers.set(topic, new Set());
    this.topicSubscribers.get(topic).add(handler);
    return () => this.topicSubscribers.get(topic)?.delete(handler);
  }

  subscribeAll(handler) {
    this.anySubscribers.add(handler);
    return () => this.anySubscribers.delete(handler);
  }

  async publish(topic, payload, meta = {}) {
    if (typeof topic !== 'string' || !topic || topic.length > 200) throw new Error('invalid event topic');
    assertPayload(payload, `event ${topic}`, this.maxPayloadBytes);
    const eventClass = normalizeEventClass(meta.eventClass);
    const at = Number(this.clock());
    if (!Number.isSafeInteger(at) || at < 0) throw Object.assign(new Error('event clock is invalid'), { code: 'EVENT_CLOCK_INVALID' });
    let event;
    let deduplicated = false;
    if (this.durableAppender && (eventClass === 'critical' || eventClass === 'durable')) {
      const appended = await this.durableAppender({ topic, payload, meta, eventClass, at, deadlineAt: Number(meta.deadlineAt) || null, minimum: this.sequence });
      event = appended.event;
      deduplicated = Boolean(appended.deduplicated);
      this.metrics.durablyAppended += deduplicated ? 0 : 1;
      this.metrics.deduplicated += deduplicated ? 1 : 0;
    } else {
      const sequence = this.sequenceAllocator
        ? Number(this.sequenceAllocator({ topic, payload, meta, eventClass, minimum: this.sequence }))
        : this.sequence + 1;
      if (!Number.isSafeInteger(sequence) || sequence <= this.sequence) {
        throw Object.assign(new Error('event sequence allocator did not return a strictly increasing safe integer'), { code: 'EVENT_SEQUENCE_INVALID' });
      }
      event = Object.freeze({
        id: sequence,
        sequence,
        topic,
        class: eventClass,
        payload,
        at,
        deadlineAt: Number(meta.deadlineAt) || null,
        meta: Object.freeze({ ...meta, eventClass })
      });
    }
    const sequence = Number(event.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || (!deduplicated && sequence <= this.sequence)) {
      throw Object.assign(new Error('event ledger did not return a valid sequence'), { code: 'EVENT_SEQUENCE_INVALID' });
    }
    this.sequence = Math.max(this.sequence, sequence);
    this.metrics.published += 1;
    const handlers = [...(this.topicSubscribers.get(topic) || []), ...this.anySubscribers];
    const required = [];
    for (const handler of handlers) {
      try {
        const delivery = Promise.resolve(handler(event));
        if (eventClass === 'critical' || eventClass === 'durable') required.push(delivery);
        else delivery.catch(error => this.recordFailure(error, event, true));
      } catch (error) {
        if (eventClass === 'critical' || eventClass === 'durable') required.push(Promise.reject(error));
        else this.recordFailure(error, event, true);
      }
    }
    if (required.length) {
      const settled = await Promise.allSettled(required);
      const failures = settled.filter(result => result.status === 'rejected');
      if (failures.length) {
        const error = Object.assign(new AggregateError(failures.map(result => result.reason), `event ${sequence} delivery failed`), {
          code: 'EVENT_DELIVERY_FAILED', event
        });
        this.recordFailure(error, event, false);
        throw error;
      }
    }
    return event;
  }

  /*
   * Publish one canonical biological signal through the existing Kernel
   * EventFabric.
   *
   * Durable signals therefore inherit the already-certified biological
   * ledger, delivery fan-out, replay and checkpoint/ACK semantics.
   *
   * The EventFabric, not the biological producer, remains authoritative for
   * ledger sequence and event identity.
   */
  async publishBiologicalSignal(signal) {
    const normalized = normalizeSignal(signal);
    const bridged = toEventFabricInput(normalized);

    const meta = {
      biological: bridged.biological
    };

    if (normalized.durability === DURABILITY.DURABLE) {
      meta.eventClass = 'durable';

      /*
       * A stable signal identity becomes the durable ledger deduplication
       * identity. Re-publication of the same biological cause cannot invent
       * a second durable cause.
       */
      meta.deduplicationKey =
        `biological-signal:${normalized.signalId}`;
    } else {
      /*
       * Biological "ephemeral" describes transport durability, not semantic
       * telemetry. EventFabric's generic non-durable class is best-effort.
       */
      meta.eventClass = 'best-effort';
    }

    return this.publish(
      bridged.topic,
      bridged.payload,
      meta
    );
  }

  recordFailure(error, event, bestEffort) {
    if (bestEffort) this.metrics.bestEffortFailures += 1;
    else this.metrics.deliveryFailures += 1;
    this.metrics.lastFailure = {
      at: new Date().toISOString(),
      sequence: event.sequence,
      topic: event.topic,
      code: error.code || null,
      message: error.message
    };
  }

  status() {
    return {
      protocol: 'stay-event-fabric-v3',
      sequence: this.sequence,
      subscribers: [...this.topicSubscribers.values()].reduce((sum, set) => sum + set.size, 0) + this.anySubscribers.size,
      ...this.metrics
    };
  }
}

module.exports = { EventFabric };
