'use strict';

const { inspectCoreModule } = require('./core-loader');

class UpgradeManager {
  constructor({ registry, stateStore }) {
    this.registry = registry;
    this.stateStore = stateStore;
  }

  async audit(type, detail) {
    await this.stateStore.appendJournal({ type, detail, at: new Date().toISOString() });
  }

  async installInitial(modulePath) {
    const definition = await inspectCoreModule(modulePath);
    const slot = this.registry.getOrCreate(definition.manifest.coreId);
    const unit = await slot.installInitial(definition);
    await this.audit('core.install', { coreId: definition.manifest.coreId, version: definition.manifest.version });
    return unit;
  }

  async stage(modulePath) {
    const definition = await inspectCoreModule(modulePath);
    const slot = this.registry.get(definition.manifest.coreId);
    if (!slot) throw new Error('cannot upgrade an uninstalled core');
    const unit = await slot.prepare(definition);
    await this.audit('core.stage', { coreId: definition.manifest.coreId, version: definition.manifest.version });
    return unit;
  }

  async commit(coreId, options = {}) {
    const slot = this.registry.get(coreId);
    if (!slot) throw new Error('unknown core: ' + coreId);
    const result = await slot.commit(options.minEvents || 1);
    await this.audit('core.commit', { coreId, activeVersion: result.active.version, standbyVersion: result.standby.version });
    return result;
  }

  async rollback(coreId) {
    const slot = this.registry.get(coreId);
    if (!slot) throw new Error('unknown core: ' + coreId);
    const result = await slot.rollback();
    await this.audit('core.rollback', { coreId, activeVersion: result.active.version, standbyVersion: result.standby.version });
    return result;
  }

  async abort(coreId) {
    const slot = this.registry.get(coreId);
    if (!slot) return;
    await slot.abort();
    await this.audit('core.abort', { coreId });
  }
}

module.exports = { UpgradeManager };
