'use strict';

const { EventEmitter } = require('node:events');

class EventFabric {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.emitter = new EventEmitter({ captureRejections: true });
    this.sequence = 0;
    this.anySubscribers = new Set();
  }

  subscribe(topic, handler) {
    this.emitter.on(topic, handler);
    return () => this.emitter.off(topic, handler);
  }

  subscribeAll(handler) {
    this.anySubscribers.add(handler);
    return () => this.anySubscribers.delete(handler);
  }

  async publish(topic, payload, meta = {}) {
    const event = Object.freeze({ id: ++this.sequence, topic, payload, at: this.clock(), meta: Object.freeze({ ...meta }) });
    const handlers = [...this.emitter.listeners(topic), ...this.anySubscribers];
    await Promise.all(handlers.map((handler) => handler(event)));
    return event;
  }
}

module.exports = { EventFabric };
