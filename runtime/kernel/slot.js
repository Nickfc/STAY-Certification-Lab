'use strict';

const { RuntimeUnit } = require('./instance');
const { assertUpgradeCompatible } = require('./manifest');

async function buildUnit(definition, state, fabric, mode, logger) {
  const bufferedOutputs = [];
  const emit = async (topic, payload, meta = {}) => {
    if (!definition.manifest.outputs.includes(topic)) throw new Error('undeclared output topic: ' + topic);
    if (unit.mode !== 'active') {
      bufferedOutputs.push({ topic, payload, meta });
      return null;
    }
    return fabric.publish(topic, payload, { ...meta, sourceCore: definition.manifest.coreId, sourceVersion: definition.manifest.version });
  };

  const api = await definition.createCore({
    manifest: definition.manifest,
    initialState: structuredClone(state || {}),
    emit,
    now: () => Date.now(),
    logger
  });

  for (const method of ['start', 'handle', 'snapshot', 'health']) {
    if (!api || typeof api[method] !== 'function') throw new Error('core missing method: ' + method);
  }

  const unit = new RuntimeUnit(definition, api, mode);
  unit.bufferedOutputs = bufferedOutputs;
  await api.start();
  return unit;
}

class RuntimeSlot {
  constructor({ coreId, fabric, stateStore, logger = console }) {
    this.coreId = coreId;
    this.fabric = fabric;
    this.stateStore = stateStore;
    this.logger = logger;
    this.active = null;
    this.candidate = null;
    this.standby = null;
    this.unsubscribe = fabric.subscribeAll((event) => this.dispatch(event));
  }

  async migrate(definition, envelope) {
    if (!envelope) return {};
    if (envelope.stateSchema === definition.manifest.stateSchema) return structuredClone(envelope.state || {});
    if (!definition.migrateState) throw new Error('state migration required but not supplied');
    return definition.migrateState({ state: structuredClone(envelope.state || {}), fromSchema: envelope.stateSchema, toSchema: definition.manifest.stateSchema });
  }

  async installInitial(definition) {
    if (this.active) throw new Error('slot already has an active implementation');
    const stored = await this.stateStore.readCore(this.coreId, 'active', null);
    const state = await this.migrate(definition, stored);
    this.active = await buildUnit(definition, state, this.fabric, 'active', this.logger);
    await this.persistActive();
    return this.active;
  }

  async prepare(definition) {
    if (!this.active) throw new Error('cannot prepare upgrade without active core');
    if (this.candidate) throw new Error('candidate already prepared');
    assertUpgradeCompatible(this.active.manifest, definition.manifest);
    const envelope = { stateSchema: this.active.manifest.stateSchema, state: await this.active.snapshot() };
    const state = await this.migrate(definition, envelope);
    this.candidate = await buildUnit(definition, state, this.fabric, 'shadow', this.logger);
    return this.candidate;
  }

  async dispatch(event) {
    for (const unit of [this.active, this.candidate, this.standby].filter(Boolean)) {
      if (unit.manifest.inputs.includes(event.topic)) await unit.handle(event);
    }
  }

  async candidateHealth(minEvents = 1) {
    if (!this.candidate) throw new Error('no candidate prepared');
    const health = await this.candidate.health();
    if (health && health.ok === false) throw new Error('candidate health check failed');
    if (this.candidate.handledEvents < minEvents) throw new Error('candidate has insufficient shadow evidence');
    return health;
  }

  async commit(minEvents = 1) {
    await this.candidateHealth(minEvents);
    const previous = this.active;
    const next = this.candidate;
    previous.setMode('standby');
    next.setMode('active');
    this.active = next;
    this.candidate = null;
    if (this.standby) await this.standby.stop();
    this.standby = previous;
    await this.persistActive();
    return { active: this.active.manifest, standby: this.standby.manifest };
  }

  async rollback() {
    if (!this.standby) throw new Error('no standby implementation available');
    const current = this.active;
    const previous = this.standby;
    current.setMode('standby');
    previous.setMode('active');
    this.active = previous;
    this.standby = current;
    await this.persistActive();
    return { active: this.active.manifest, standby: this.standby.manifest };
  }

  async abort() {
    if (!this.candidate) return;
    await this.candidate.stop();
    this.candidate = null;
  }

  async persistActive() {
    if (!this.active) return;
    await this.stateStore.writeCore(this.coreId, {
      version: this.active.manifest.version,
      stateSchema: this.active.manifest.stateSchema,
      state: await this.active.snapshot()
    });
  }

  async status() {
    const describe = async (unit) => unit ? { manifest: unit.manifest, mode: unit.mode, handledEvents: unit.handledEvents, bufferedOutputs: unit.bufferedOutputs ? unit.bufferedOutputs.length : 0, health: await unit.health() } : null;
    return { coreId: this.coreId, active: await describe(this.active), candidate: await describe(this.candidate), standby: await describe(this.standby) };
  }

  async stop() {
    if (this.unsubscribe) this.unsubscribe();
    for (const unit of [this.active, this.candidate, this.standby].filter(Boolean)) await unit.stop();
  }
}

module.exports = { RuntimeSlot };
