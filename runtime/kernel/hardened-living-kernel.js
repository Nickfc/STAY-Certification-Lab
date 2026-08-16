'use strict';

const crypto = require('node:crypto');
const { LivingKernel: BaseLivingKernel, KERNEL_VERSION } = require('./living-kernel');
const { stableStringify } = require('./canonical-json');

const RESERVED_PROVENANCE_FIELDS = new Set([
  'sourceCore', 'sourceVersion', 'sourceInstanceId', 'authorityEpoch', 'causeSequence', 'causalParent'
]);

class HardenedLivingKernel extends BaseLivingKernel {
  governBiologicalRetentionDebt(maxPending = Number(process.env.STAY_MAX_REQUIRED_EVENT_DEBT || 16384)) {
    const limit = Math.max(8, Math.min(1000000, Number(maxPending) || 16384));
    const rows = this.stateStore.db.prepare(`SELECT c.consumer_id, c.core_id, c.cursor, COUNT(d.sequence) AS pending
      FROM biological_consumers c LEFT JOIN biological_deliveries d
        ON d.consumer_id=c.consumer_id AND d.status='PENDING'
      WHERE c.active=1 AND c.required=1 GROUP BY c.consumer_id, c.core_id, c.cursor
      HAVING COUNT(d.sequence)>?`).all(limit);
    const demotedConsumers = [];
    for (const row of rows) {
      const at = new Date().toISOString();
      this.stateStore.withTransaction(() => {
        this.stateStore.db.prepare('UPDATE biological_consumers SET required=0, active=0, updated_at=? WHERE consumer_id=?').run(at, row.consumer_id);
        this.stateStore.db.prepare('INSERT INTO recovery_records(type, core_id, detail_json, created_at) VALUES(?, ?, ?, ?)')
          .run('biological.consumer-demoted', row.core_id, JSON.stringify({
            consumerId: row.consumer_id, cursor: Number(row.cursor) || 0,
            pending: Number(row.pending) || 0, maximumDebt: limit,
            resynchronizationRequired: true
          }), at);
      });
      const slot = this.registry.get(row.core_id);
      if (slot?.active) {
        slot.active.lifecycle = 'failed';
        slot.active.client.quarantined = true;
        slot.active.client.lifecycle = 'failed';
      }
      demotedConsumers.push({ consumerId: row.consumer_id, coreId: row.core_id, pending: Number(row.pending) || 0 });
    }
    return { maximumRequiredDebt: limit, demotedConsumers };
  }

  async writeHeartbeat() {
    const cores = await this.registry.status();
    const debt = this.governBiologicalRetentionDebt();
    const pruned = this.stateStore.pruneBiologicalEvents({ retainCount: 4096 });
    let unclaimedPrune = { removed: 0, throughSequence: 0 };
    const requiredCount = Number(this.stateStore.db.prepare('SELECT COUNT(*) AS count FROM biological_consumers WHERE active=1 AND required=1').get()?.count || 0);
    if (requiredCount === 0) {
      const boundary = this.stateStore.db.prepare('SELECT sequence FROM biological_events ORDER BY sequence DESC LIMIT 1 OFFSET 4095').get()?.sequence;
      if (boundary != null) {
        const result = this.stateStore.withTransaction(() => this.stateStore.db.prepare('DELETE FROM biological_events WHERE sequence<?').run(Number(boundary)));
        unclaimedPrune = { removed: Number(result.changes) || 0, throughSequence: Number(boundary) - 1 };
      }
    }
    this.lastBiologicalRetention = { ...pruned, ...debt, unclaimedPrune };
    await this.stateStore.writeLife('event-sequence', { sequence: this.fabric.sequence, at: new Date().toISOString() });
    await this.stateStore.heartbeat({
      kernelVersion: KERNEL_VERSION,
      runtimeRevision: this.runtimeRevision,
      organismId: this.identity ? this.identity.organismId : null,
      pid: process.pid,
      startedAt: this.startedAt,
      coreHealth: cores.map(slot => ({ coreId: slot.coreId, ok: !slot.active || !slot.active.health || slot.active.health.ok !== false })),
      biologicalRetention: this.lastBiologicalRetention
    });
    this.clearMaintenanceError('heartbeat');
  }

  async publishKernelEvent(topic, payload, meta = {}) {
    return this.fabric.publish(topic, payload, { ...meta, sourceCore: 'living-kernel', sourceVersion: KERNEL_VERSION });
  }

  async publish(topic, payload, meta = {}) {
    for (const field of RESERVED_PROVENANCE_FIELDS) {
      if (Object.hasOwn(meta, field)) {
        throw Object.assign(new Error(`generic publish may not assert authoritative provenance field: ${field}`), { code: 'EVENT_PROVENANCE_RESERVED' });
      }
    }
    return this.fabric.publish(topic, payload, meta);
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
    return this.publishKernelEvent('runtime.organism.binding', binding, {
      eventClass: 'critical', authorityEpoch: binding.authorityEpoch, evidenceHash: identityHash,
      deduplicationKey: `runtime.organism.binding:v${binding.bindingVersion}:${identityHash}`
    });
  }

  async publishTimePulse(clockStatus = 'trusted') {
    if (!['trusted', 'degraded', 'uncertain'].includes(clockStatus)) {
      throw Object.assign(new Error('invalid runtime clock status'), { code: 'RUNTIME_CLOCK_STATUS' });
    }
    const pulseSequence = ++this.trustedTimePulseSequence;
    const wallClockMs = Number(this.clock());
    return this.publishKernelEvent('runtime.time.pulse', {
      wallClockMs, runtimeRevision: this.runtimeRevision, pulseSequence, clockStatus
    }, {
      eventClass: 'durable', authorityEpoch: this.runtimeRevision,
      deduplicationKey: `runtime.time.pulse:${this.runtimeRevision}:${pulseSequence}`
    });
  }
}

module.exports = { LivingKernel: HardenedLivingKernel, HardenedLivingKernel, KERNEL_VERSION, RESERVED_PROVENANCE_FIELDS };
