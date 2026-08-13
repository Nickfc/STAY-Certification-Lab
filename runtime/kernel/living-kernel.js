'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { EventFabric } = require('./event-fabric');
const { StateStore } = require('./state-store');
const { RuntimeRegistry } = require('./registry');
const { UpgradeManager } = require('./upgrades');

class LivingKernel {
  constructor({ dataDir, logger = console, clock = () => Date.now() }) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.stateStore = new StateStore(dataDir);
    this.fabric = new EventFabric({ clock });
    this.registry = new RuntimeRegistry({ fabric: this.fabric, stateStore: this.stateStore, logger });
    this.upgrades = new UpgradeManager({ registry: this.registry, stateStore: this.stateStore });
    this.identity = null;
    this.startedAt = null;
  }

  async start() {
    await this.stateStore.init();
    const existing = await this.stateStore.readLife('identity', null);
    this.identity = existing || {
      organismId: 'stay-' + crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      lineage: 'STAY/Genesis'
    };
    if (!existing) await this.stateStore.writeLife('identity', this.identity);
    this.startedAt = new Date().toISOString();
    await this.stateStore.appendJournal({ type: 'kernel.start', at: this.startedAt, organismId: this.identity.organismId, pid: process.pid });
    return this;
  }

  async installCore(modulePath) { return this.upgrades.installInitial(path.resolve(modulePath)); }
  async stageCoreUpgrade(modulePath) { return this.upgrades.stage(path.resolve(modulePath)); }
  async commitCoreUpgrade(coreId, options) { return this.upgrades.commit(coreId, options); }
  async rollbackCore(coreId) { return this.upgrades.rollback(coreId); }
  async publish(topic, payload, meta) { return this.fabric.publish(topic, payload, meta); }

  async status() {
    return {
      kernel: {
        version: '0.7.0',
        organismId: this.identity ? this.identity.organismId : null,
        startedAt: this.startedAt,
        pid: process.pid,
        dataDir: this.dataDir
      },
      cores: await this.registry.status()
    };
  }

  async stop() {
    for (const slot of this.registry.slots.values()) await slot.persistActive();
    await this.registry.stop();
    await this.stateStore.appendJournal({ type: 'kernel.stop', at: new Date().toISOString(), organismId: this.identity ? this.identity.organismId : null });
  }
}

module.exports = { LivingKernel };
