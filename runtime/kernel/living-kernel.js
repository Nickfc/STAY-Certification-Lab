'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { EventFabric } = require('./event-fabric');
const { StateStore } = require('./state-store');
const { RuntimeRegistry } = require('./registry');
const { UpgradeManager } = require('./upgrades');

const KERNEL_VERSION = '0.7.1';

class LivingKernel {
  constructor({
    dataDir,
    logger = console,
    clock = () => Date.now(),
    heartbeatIntervalMs = Number(process.env.STAY_HEARTBEAT_INTERVAL_MS || 30000),
    snapshotIntervalMs = Number(process.env.STAY_SNAPSHOT_INTERVAL_MS || 21600000),
    snapshotRetention = Number(process.env.STAY_SNAPSHOT_RETENTION || 24)
  }) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.stateStore = new StateStore(dataDir);
    this.fabric = new EventFabric({ clock });
    this.registry = new RuntimeRegistry({ fabric: this.fabric, stateStore: this.stateStore, logger });
    this.upgrades = new UpgradeManager({ registry: this.registry, stateStore: this.stateStore });
    this.identity = null;
    this.startedAt = null;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.snapshotIntervalMs = snapshotIntervalMs;
    this.snapshotRetention = snapshotRetention;
    this.heartbeatTimer = null;
    this.snapshotTimer = null;
    this.maintenanceError = null;
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
    await this.stateStore.appendJournal({ type: 'kernel.start', at: this.startedAt, version: KERNEL_VERSION, organismId: this.identity.organismId, pid: process.pid });
    await this.writeHeartbeat();
    await this.createSnapshot('kernel-start');
    this.startMaintenance();
    return this;
  }

  startMaintenance() {
    if (this.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.writeHeartbeat().catch((error) => this.recordMaintenanceError('heartbeat', error));
      }, this.heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    }
    if (this.snapshotIntervalMs > 0) {
      this.snapshotTimer = setInterval(() => {
        this.createSnapshot('periodic').catch((error) => this.recordMaintenanceError('snapshot', error));
      }, this.snapshotIntervalMs);
      this.snapshotTimer.unref?.();
    }
  }

  recordMaintenanceError(operation, error) {
    this.maintenanceError = { operation, at: new Date().toISOString(), code: error.code || null, message: error.message };
    this.logger.error('[STAY] maintenance failure [' + operation + '] ' + error.message);
  }

  async writeHeartbeat() {
    const cores = await this.registry.status();
    await this.stateStore.heartbeat({
      kernelVersion: KERNEL_VERSION,
      organismId: this.identity ? this.identity.organismId : null,
      pid: process.pid,
      startedAt: this.startedAt,
      coreHealth: cores.map((slot) => ({ coreId: slot.coreId, ok: !slot.active || !slot.active.health || slot.active.health.ok !== false }))
    });
    this.maintenanceError = null;
  }

  async createSnapshot(reason) {
    const snapshot = await this.stateStore.createSnapshot({ reason, retention: this.snapshotRetention });
    await this.stateStore.appendJournal({ type: 'state.snapshot', at: snapshot.createdAt, reason, snapshot: snapshot.name });
    return snapshot;
  }

  async installCore(modulePath) { return this.upgrades.installInitial(path.resolve(modulePath)); }
  async stageCoreUpgrade(modulePath) { return this.upgrades.stage(path.resolve(modulePath)); }
  async commitCoreUpgrade(coreId, options) { return this.upgrades.commit(coreId, options); }
  async rollbackCore(coreId) { return this.upgrades.rollback(coreId); }
  async publish(topic, payload, meta) { return this.fabric.publish(topic, payload, meta); }

  async health() {
    const cores = await this.registry.status();
    const persistence = await this.stateStore.persistenceStatus(Math.max(120000, this.heartbeatIntervalMs * 4));
    const unhealthyCores = cores.filter((slot) => slot.active && slot.active.health && slot.active.health.ok === false).map((slot) => slot.coreId);
    const ok = persistence.ok && unhealthyCores.length === 0 && !this.maintenanceError;
    return {
      ok,
      kernelVersion: KERNEL_VERSION,
      persistence,
      maintenanceError: this.maintenanceError,
      unhealthyCores
    };
  }

  async status() {
    return {
      kernel: {
        version: KERNEL_VERSION,
        organismId: this.identity ? this.identity.organismId : null,
        startedAt: this.startedAt,
        pid: process.pid,
        dataDir: this.dataDir
      },
      health: await this.health(),
      snapshots: await this.stateStore.snapshotStatus(),
      cores: await this.registry.status()
    };
  }

  async stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.heartbeatTimer = null;
    this.snapshotTimer = null;
    for (const slot of this.registry.slots.values()) await slot.persistActive();
    await this.writeHeartbeat();
    await this.createSnapshot('kernel-stop');
    await this.registry.stop();
    await this.stateStore.appendJournal({ type: 'kernel.stop', at: new Date().toISOString(), version: KERNEL_VERSION, organismId: this.identity ? this.identity.organismId : null });
  }
}

module.exports = { LivingKernel, KERNEL_VERSION };
