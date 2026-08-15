'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { EventFabric } = require('./event-fabric');
const { StateStore } = require('./state-store');
const { RuntimeRegistry } = require('./registry');
const { UpgradeManager } = require('./upgrades');
const { ComputeFabric } = require('../compute/compute-fabric');
const { stableStringify } = require('./canonical-json');

const KERNEL_VERSION = '0.8.11.3';

class LivingKernel {
  constructor({
    dataDir,
    logger = console,
    clock = () => Date.now(),
    allowIdentityBootstrap = false,
    heartbeatIntervalMs = Number(process.env.STAY_HEARTBEAT_INTERVAL_MS || 30000),
    snapshotIntervalMs = Number(process.env.STAY_SNAPSHOT_INTERVAL_MS || 21600000),
    snapshotRetention = Number(process.env.STAY_SNAPSHOT_RETENTION || 24)
  }) {
    this.dataDir = dataDir;
    this.clock = clock;
    this.logger = logger;
    this.stateStore = new StateStore(dataDir);
    this.fabric = new EventFabric({
      clock,
      sequenceAllocator: ({ minimum }) => this.stateStore.reserveEventSequence(minimum),
      durableAppender: envelope => this.stateStore.appendBiologicalEvent(envelope)
    });
    this.registry = new RuntimeRegistry({ fabric: this.fabric, stateStore: this.stateStore, logger });
    this.upgrades = new UpgradeManager({ registry: this.registry, stateStore: this.stateStore });
    this.computeFabric = new ComputeFabric();
    this.identity = null;
    this.allowIdentityBootstrap = allowIdentityBootstrap;
    this.startedAt = null;
    this.runtimeRevision = 0;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.snapshotIntervalMs = snapshotIntervalMs;
    this.snapshotRetention = snapshotRetention;
    this.heartbeatTimer = null;
    this.snapshotTimer = null;
    this.maintenanceErrors = {};
    this.statusCache = null;
    this.statusInFlight = null;
    this.statusCacheTtlMs = 1000;
    this.trustedTimePulseSequence = 0;
    this.lastBiologicalRetention = null;
  }

  async start() {
    if (process.env.STAY_REQUIRE_CGROUPS === '1' && !process.execArgv.includes('--disable-sigusr1')) {
      throw Object.assign(new Error('production Kernel must start Node with --disable-sigusr1'), { code: 'KERNEL_INSPECTOR_SIGNAL_UNSAFE' });
    }
    await this.stateStore.init();
    const storedSequence = await this.stateStore.readLife('event-sequence', { sequence: 0 });
    const authorityHighWater = this.stateStore.listAuthority().reduce((maximum, entry) => Math.max(maximum, Number(entry.barrierSequence) || 0), 0);
    this.fabric.sequence = Math.max(Number(storedSequence?.sequence) || 0, authorityHighWater);
    const existing = await this.stateStore.readLife('identity', null);
    if (!existing && !this.allowIdentityBootstrap) {
      throw Object.assign(new Error('organism identity is missing; refusing to manufacture a replacement identity'), { code: 'IDENTITY_MISSING' });
    }
    this.identity = existing || {
      organismId: 'stay-' + crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      lineage: 'STAY/Genesis'
    };
    if (!existing) await this.stateStore.writeLife('identity', this.identity);
    if (!this.identity.organismId || !this.identity.createdAt || this.identity.lineage !== 'STAY/Genesis') {
      throw Object.assign(new Error('organism identity is incomplete or inconsistent'), { code: 'IDENTITY_INVALID' });
    }

    const revisionState = await this.stateStore.readLife('runtime-revision', { revision: 0 });
    this.runtimeRevision = Number(revisionState && revisionState.revision) || 0;

    this.startedAt = new Date().toISOString();
    await this.bumpRuntimeRevision('kernel.start', { version: KERNEL_VERSION, pid: process.pid });
    await this.stateStore.appendJournal({
      type: 'kernel.start',
      at: this.startedAt,
      version: KERNEL_VERSION,
      runtimeRevision: this.runtimeRevision,
      organismId: this.identity.organismId,
      pid: process.pid
    });

    await this.writeHeartbeat();
    await this.createSnapshot('kernel-start');
    this.startMaintenance();
    return this;
  }

  async bumpRuntimeRevision(reason, details = {}) {
    this.runtimeRevision += 1;
    const record = {
      revision: this.runtimeRevision,
      reason,
      at: new Date().toISOString(),
      kernelVersion: KERNEL_VERSION,
      ...details
    };
    await this.stateStore.writeLife('runtime-revision', record);
    await this.stateStore.appendJournal({ type: 'runtime.revision', ...record });
    return this.runtimeRevision;
  }

  startMaintenance() {
    if (this.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.writeHeartbeat().catch(error => this.recordMaintenanceError('heartbeat', error));
      }, this.heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    }

    if (this.snapshotIntervalMs > 0) {
      this.snapshotTimer = setInterval(() => {
        this.createSnapshot('periodic').catch(error => this.recordMaintenanceError('snapshot', error));
      }, this.snapshotIntervalMs);
      this.snapshotTimer.unref?.();
    }
  }

  recordMaintenanceError(operation, error) {
    this.maintenanceErrors[operation] = {
      operation,
      at: new Date().toISOString(),
      code: error.code || null,
      message: error.message
    };
    this.logger.error('[STAY] maintenance failure [' + operation + '] ' + error.message);
  }

  clearMaintenanceError(operation) {
    delete this.maintenanceErrors[operation];
  }

  async writeHeartbeat() {
    const cores = await this.registry.status();
    this.lastBiologicalRetention = this.stateStore.pruneBiologicalEvents({ retainCount: 4096 });
    await this.stateStore.writeLife('event-sequence', {
      sequence: this.fabric.sequence,
      at: new Date().toISOString()
    });
    await this.stateStore.heartbeat({
      kernelVersion: KERNEL_VERSION,
      runtimeRevision: this.runtimeRevision,
      organismId: this.identity ? this.identity.organismId : null,
      pid: process.pid,
      startedAt: this.startedAt,
      coreHealth: cores.map(slot => ({
        coreId: slot.coreId,
        ok: !slot.active || !slot.active.health || slot.active.health.ok !== false
      })),
      biologicalRetention: this.lastBiologicalRetention
    });
    this.clearMaintenanceError('heartbeat');
  }

  async createSnapshot(reason) {
    await Promise.all([...this.registry.slots.values()].map(slot => slot.persistActive()));
    const snapshot = await this.stateStore.createSnapshot({
      reason,
      retention: this.snapshotRetention
    });
    await this.stateStore.appendJournal({
      type: 'state.snapshot',
      at: snapshot.createdAt,
      reason,
      snapshot: snapshot.name
    });
    this.clearMaintenanceError('snapshot');
    return snapshot;
  }

  async installCore(modulePath) {
    const unit = await this.upgrades.installInitial(path.resolve(modulePath));
    await this.bumpRuntimeRevision('core.install', {
      coreId: unit.manifest ? unit.manifest.coreId : null,
      coreVersion: unit.manifest ? unit.manifest.version : null
    });
    if (unit.manifest?.coreId === 'sntss') await this.publishOrganismBinding();
    return unit;
  }

  async publishOrganismBinding() {
    const identityHash = 'sha256:' + crypto.createHash('sha256').update(stableStringify(this.identity)).digest('hex');
    let binding = await this.stateStore.readLife('organism-binding', null);
    if (!binding) {
      binding = {
        bindingVersion: 1,
        identitySha256: identityHash,
        organismLineage: this.identity.lineage,
        issuedAt: Number(this.clock()),
        runtimeRevision: this.runtimeRevision,
        authorityEpoch: this.runtimeRevision,
        kernelVersion: KERNEL_VERSION
      };
      await this.stateStore.writeLife('organism-binding', binding);
    }
    if (binding.identitySha256 !== identityHash || binding.organismLineage !== this.identity.lineage) {
      throw Object.assign(new Error('persisted organism binding does not match living identity'), { code: 'ORGANISM_BINDING_MISMATCH' });
    }
    return this.publish('runtime.organism.binding', binding, {
      eventClass: 'critical',
      sourceCore: 'living-kernel',
      sourceVersion: binding.kernelVersion,
      authorityEpoch: binding.authorityEpoch,
      evidenceHash: identityHash,
      deduplicationKey: `runtime.organism.binding:v${binding.bindingVersion}:${identityHash}`
    });
  }

  async publishTimePulse(clockStatus = 'trusted') {
    if (!['trusted', 'degraded', 'uncertain'].includes(clockStatus)) throw Object.assign(new Error('invalid runtime clock status'), { code: 'RUNTIME_CLOCK_STATUS' });
    const pulseSequence = ++this.trustedTimePulseSequence;
    const wallClockMs = Number(this.clock());
    return this.publish('runtime.time.pulse', {
      wallClockMs,
      runtimeRevision: this.runtimeRevision,
      pulseSequence,
      clockStatus
    }, {
      eventClass: 'durable',
      sourceCore: 'living-kernel',
      sourceVersion: KERNEL_VERSION,
      authorityEpoch: this.runtimeRevision,
      deduplicationKey: `runtime.time.pulse:${this.runtimeRevision}:${pulseSequence}`
    });
  }

  async stageCoreUpgrade(modulePath) {
    const unit = await this.upgrades.stage(path.resolve(modulePath));
    await this.bumpRuntimeRevision('core.stage', {
      coreId: unit.manifest ? unit.manifest.coreId : null,
      coreVersion: unit.manifest ? unit.manifest.version : null
    });
    return unit;
  }

  async commitCoreUpgrade(coreId, options) {
    const result = await this.upgrades.commit(coreId, options);
    await this.bumpRuntimeRevision('core.commit', {
      coreId,
      coreVersion: result.active ? result.active.version : null
    });
    return result;
  }

  async rollbackCore(coreId) {
    const result = await this.upgrades.rollback(coreId);
    await this.bumpRuntimeRevision('core.rollback', {
      coreId,
      coreVersion: result.active ? result.active.version : null
    });
    return result;
  }

  async publish(topic, payload, meta) {
    return this.fabric.publish(topic, payload, meta);
  }

  async health(knownCores = null) {
    const cores = knownCores || await this.registry.status();
    const persistence = await this.stateStore.persistenceStatus(
      Math.max(120000, this.heartbeatIntervalMs * 4)
    );
    const unhealthyCores = cores
      .filter(slot => slot.active && slot.active.health && slot.active.health.ok === false)
      .map(slot => slot.coreId);
    const blockingCores = cores
      .filter(slot => slot.active && slot.active.manifest?.priority === 'critical' && slot.active.health && slot.active.health.ok === false)
      .map(slot => slot.coreId);
    const maintenanceErrors = Object.values(this.maintenanceErrors);

    return {
      ok: persistence.ok && blockingCores.length === 0 && maintenanceErrors.length === 0,
      kernelVersion: KERNEL_VERSION,
      runtimeRevision: this.runtimeRevision,
      persistence,
      maintenanceErrors,
      unhealthyCores,
      blockingCores,
      eventFabric: this.fabric.status(),
      biologicalLedger: this.stateStore.biologicalLedgerStatus(),
      biologicalRetention: this.lastBiologicalRetention,
      authority: this.stateStore.listAuthority(),
      computeFabric: this.computeFabric.status()
    };
  }

  async buildStatus() {
    const realCores = await this.registry.status();
    const health = await this.health(realCores);

    const persistenceContract = {
      coreId: 'kernel-persistence',
      active: {
        manifest: {
          coreId: 'kernel-persistence',
          version: KERNEL_VERSION,
          protocol: 'genesis-kernel-health-v2',
          stateSchema: 2,
          hotSwap: false,
          inputs: [],
          outputs: []
        },
        mode: 'active',
        handledEvents: 0,
        bufferedOutputs: 0,
        health: {
          ok: health.persistence.ok && health.maintenanceErrors.length === 0,
          persistence: health.persistence,
          maintenanceErrors: health.maintenanceErrors
        }
      },
      candidate: null,
      standby: null
    };

    return {
      kernel: {
        version: KERNEL_VERSION,
        runtimeRevision: this.runtimeRevision,
        organismId: this.identity ? this.identity.organismId : null,
        startedAt: this.startedAt,
        pid: process.pid,
        dataDir: this.dataDir
      },
      health,
      snapshots: await this.stateStore.snapshotStatus(),
      authority: this.stateStore.listAuthority(),
      eventFabric: this.fabric.status(),
      biologicalLedger: this.stateStore.biologicalLedgerStatus(),
      computeFabric: this.computeFabric.status(),
      cores: [persistenceContract, ...realCores]
    };
  }

  async status({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.statusCache && now - this.statusCache.at < this.statusCacheTtlMs) return this.statusCache.value;
    if (this.statusInFlight) return this.statusInFlight;
    this.statusInFlight = this.buildStatus();
    try {
      const value = await this.statusInFlight;
      this.statusCache = { at: Date.now(), value };
      return value;
    } finally {
      this.statusInFlight = null;
    }
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

    await this.stateStore.appendJournal({
      type: 'kernel.stop',
      at: new Date().toISOString(),
      version: KERNEL_VERSION,
      runtimeRevision: this.runtimeRevision,
      organismId: this.identity ? this.identity.organismId : null
    });
    this.stateStore.close();
  }
}

module.exports = { LivingKernel, KERNEL_VERSION };
