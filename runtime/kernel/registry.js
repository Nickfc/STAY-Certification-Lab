'use strict';

const { RuntimeSlot } = require('./slot');

class RuntimeRegistry {
  constructor({ fabric, stateStore, logger = console }) {
    this.fabric = fabric;
    this.stateStore = stateStore;
    this.logger = logger;
    this.slots = new Map();
  }

  getOrCreate(coreId) {
    if (!this.slots.has(coreId)) {
      this.slots.set(coreId, new RuntimeSlot({ coreId, fabric: this.fabric, stateStore: this.stateStore, logger: this.logger }));
    }
    return this.slots.get(coreId);
  }

  get(coreId) { return this.slots.get(coreId) || null; }

  async status() {
    const result = [];
    for (const slot of this.slots.values()) result.push(await slot.status());
    return result;
  }

  async stop() {
    for (const slot of this.slots.values()) await slot.stop();
  }
}

module.exports = { RuntimeRegistry };
