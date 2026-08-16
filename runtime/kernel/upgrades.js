'use strict';

const { inspectCoreModule } = require('./core-loader');
const { loadAndVerifyPromotion } = require('./promotion-authority');

class UpgradeManager {
  constructor({ registry, stateStore }) {
    this.registry = registry;
    this.stateStore = stateStore;
  }

  async audit(type, detail) {
    await this.stateStore.appendJournal({ type, detail, at: new Date().toISOString() });
  }

  async authorize(definition, action) {
    if (action !== 'stage') {
      const demotion = this.stateStore.db.prepare(`SELECT id, detail_json, created_at FROM recovery_records
        WHERE type='biological.consumer-demoted' AND core_id=? ORDER BY id DESC LIMIT 1`).get(definition.manifest.coreId);
      if (demotion) {
        throw Object.assign(new Error(`core ${definition.manifest.coreId} requires explicit biological resynchronization after retention-debt quarantine`), {
          code: 'BIOLOGICAL_RESYNC_REQUIRED', detail: JSON.parse(demotion.detail_json || '{}')
        });
      }
    }
    const identity = await this.stateStore.readLife('identity', null);
    if (!identity) throw Object.assign(new Error('organism identity is unavailable for promotion authorization'), { code: 'CORE_PROMOTION_IDENTITY_MISSING' });
    const result = loadAndVerifyPromotion({ definition, action, identity });
    await this.audit('core.promotion-authorized', {
      coreId: definition.manifest.coreId,
      version: definition.manifest.version,
      action,
      certificateId: result.certificateId || null,
      authorizationClass: result.authorizationClass || null,
      laboratoryBypass: result.laboratoryBypass === true,
      legacyExemption: result.legacyExemption === true
    });
    return result;
  }

  async installInitial(modulePath) {
    const definition = await inspectCoreModule(modulePath);
    await this.authorize(definition, 'install');
    const slot = this.registry.getOrCreate(definition.manifest.coreId);
    const unit = await slot.installInitial(definition);
    await this.audit('core.install', { coreId: definition.manifest.coreId, version: definition.manifest.version });
    return unit;
  }

  async stage(modulePath) {
    const definition = await inspectCoreModule(modulePath);
    await this.authorize(definition, 'stage');
    const slot = this.registry.get(definition.manifest.coreId);
    if (!slot) throw new Error('cannot upgrade an uninstalled core');
    const unit = await slot.prepare(definition);
    await this.audit('core.stage', { coreId: definition.manifest.coreId, version: definition.manifest.version });
    return unit;
  }

  async commit(coreId, options = {}) {
    const slot = this.registry.get(coreId);
    if (!slot) throw new Error('unknown core: ' + coreId);
    if (!slot.candidate) throw new Error('no candidate prepared');
    await this.authorize(slot.candidate.definition, 'commit');
    const result = await slot.commit(options.minEvents || 1);
    await this.audit('core.commit', { coreId, activeVersion: result.active.version, standbyVersion: result.standby.version });
    return result;
  }

  async rollback(coreId) {
    const slot = this.registry.get(coreId);
    if (!slot) throw new Error('unknown core: ' + coreId);
    // Rollback reactivates an already-authorized standby. Requiring a fresh
    // certificate here would turn the emergency safety path into a liveness risk.
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
