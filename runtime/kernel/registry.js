'use strict';

const { RevocationAwareRuntimeSlot } = require('./revocation-aware-slot');
const { CoreRevocationRegistry } = require('./revocation-registry');

class RuntimeRegistry {
  constructor({ fabric, stateStore, logger = console }) {
    this.fabric = fabric;
    this.stateStore = stateStore;
    this.logger = logger;
    this.slots = new Map();
    this.revocations = new CoreRevocationRegistry(stateStore);
  }

  getOrCreate(coreId) {
    if (!this.slots.has(coreId)) {
      this.slots.set(coreId, new RevocationAwareRuntimeSlot({
        coreId,
        fabric: this.fabric,
        stateStore: this.stateStore,
        logger: this.logger,
        revocations: this.revocations
      }));
    }
    return this.slots.get(coreId);
  }

  get(coreId) { return this.slots.get(coreId) || null; }

  revokeCore(input) { return this.revocations.record(input); }
  listCoreRevocations(coreId = null) { return this.revocations.list(coreId); }
  coreRevocationHead() { return this.revocations.head(); }
  verifyCoreRevocations() { return this.revocations.verifyChain(); }

  async status() {
    return Promise.all([...this.slots.values()].map(slot => slot.status()));
  }

  async stop() {
    await Promise.allSettled([...this.slots.values()].map(slot => slot.stop()));
  }
}

module.exports = { RuntimeRegistry };
