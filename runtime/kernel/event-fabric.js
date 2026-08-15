'use strict';

const { assertPayload, normalizeEventClass } = require('./protocol');

class EventFabric {
  constructor({ clock = () => Date.now(), maxPayloadBytes = 1024 * 1024, sequenceAllocator = null } = {}) {
    this.clock = clock;
    this.maxPayloadBytes = maxPayloadBytes;
    this.sequenceAllocator = typeof sequenceAllocator === 'function' ? sequenceAllocator : null;
    this.sequence = 0;
    this.topicSubscribers = new Map();
    this.anySubscribers = new Set();
    this.metrics = {
      published: 0,
      deliveryFailures: 0,
      bestEffortFailures: 0,
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
    const sequence = this.sequenceAllocator
      ? Number(this.sequenceAllocator({ topic, payload, meta, eventClass, minimum: this.sequence }))
      : this.sequence + 1;
    if (!Number.isSafeInteger(sequence) || sequence <= this.sequence) {
      throw Object.assign(new Error('event sequence allocator did not return a strictly increasing safe integer'), { code: 'EVENT_SEQUENCE_INVALID' });
    }
    this.sequence = sequence;
    const event = Object.freeze({
      id: sequence,
      sequence,
      topic,
      class: eventClass,
      payload,
      at: this.clock(),
      deadlineAt: Number(meta.deadlineAt) || null,
      meta: Object.freeze({ ...meta, eventClass })
    });
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
      protocol: 'stay-event-fabric-v2',
      sequence: this.sequence,
      subscribers: [...this.topicSubscribers.values()].reduce((sum, set) => sum + set.size, 0) + this.anySubscribers.size,
      ...this.metrics
    };
  }
}

module.exports = { EventFabric };
