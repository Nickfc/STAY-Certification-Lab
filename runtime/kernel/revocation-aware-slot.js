'use strict';

const { RuntimeSlot } = require('./slot');

class RevocationAwareRuntimeSlot extends RuntimeSlot {
  constructor(options = {}) {
    super(options);
    this.revocations = options.revocations;
    if (!this.revocations) throw new Error('revocation registry is required');
  }

  revocationTarget(definition, instanceId = null) {
    return {
      coreId: this.coreId,
      moduleDigest: definition?.moduleDigest || null,
      packagePolicyHash: definition?.packagePolicyHash || null,
      instanceId: instanceId || null
    };
  }

  assertDefinitionNotRevoked(definition, instanceId = null) {
    return this.revocations.assertNotRevoked(this.revocationTarget(definition, instanceId));
  }

  async installInitial(definition) {
    const existing = this.stateStore.getAuthority(this.coreId);
    this.assertDefinitionNotRevoked(definition, existing?.instanceId || null);
    return super.installInitial(definition);
  }

  async prepare(definition) {
    this.assertDefinitionNotRevoked(definition);
    return super.prepare(definition);
  }

  async commit(minEvents = 1) {
    if (!this.candidate) throw new Error('no candidate prepared');
    this.assertDefinitionNotRevoked(this.candidate.definition, this.candidate.instanceId);
    return super.commit(minEvents);
  }

  async rollback() {
    if (!this.standby) throw new Error('no standby implementation available');
    this.assertDefinitionNotRevoked(this.standby.definition, this.standby.instanceId);
    return super.rollback();
  }
}

module.exports = { RevocationAwareRuntimeSlot };
