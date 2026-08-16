'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('./canonical-json');

const HASH = /^sha256:[0-9a-f]{64}$/;
const REASON = /^[A-Z0-9_.-]{3,64}$/;
const GENESIS_HASH = 'sha256:' + '0'.repeat(64);

function sha256(value) {
  return 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
}

function fail(message, code = 'CORE_REVOCATION_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function normalizeHash(value, label, optional = true) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} must be sha256:<64 lowercase hex>`);
  return value;
}

function normalizeSubject(input = {}) {
  const coreId = typeof input.coreId === 'string' ? input.coreId.trim() : '';
  if (!coreId || coreId.length > 128) fail('revocation coreId is invalid');
  const moduleDigest = normalizeHash(input.moduleDigest, 'moduleDigest');
  const packagePolicyHash = normalizeHash(input.packagePolicyHash, 'packagePolicyHash');
  const instanceId = input.instanceId == null ? null : String(input.instanceId).trim();
  if (instanceId !== null && (!instanceId || instanceId.length > 160)) fail('instanceId is invalid');
  if (!moduleDigest && !packagePolicyHash && !instanceId) fail('revocation must identify a module, package policy, or implementation instance');
  return Object.freeze({ coreId, moduleDigest, packagePolicyHash, instanceId });
}

function subjectHash(subject) {
  return sha256(stableStringify({ format: 'stay-core-revocation-subject-v1', ...subject }));
}

function mapRow(row) {
  if (!row) return null;
  return Object.freeze({
    sequence: Number(row.sequence),
    revocationId: row.revocation_id,
    subjectHash: row.subject_hash,
    coreId: row.core_id,
    moduleDigest: row.module_digest,
    packagePolicyHash: row.package_policy_hash,
    instanceId: row.instance_id,
    reasonCode: row.reason_code,
    evidenceHash: row.evidence_hash,
    createdAt: row.created_at,
    previousHash: row.previous_hash,
    recordHash: row.record_hash
  });
}

function recordBody(record) {
  return {
    format: 'stay-core-revocation-record-v1',
    sequence: record.sequence,
    revocationId: record.revocationId,
    subjectHash: record.subjectHash,
    coreId: record.coreId,
    moduleDigest: record.moduleDigest,
    packagePolicyHash: record.packagePolicyHash,
    instanceId: record.instanceId,
    reasonCode: record.reasonCode,
    evidenceHash: record.evidenceHash,
    createdAt: record.createdAt,
    previousHash: record.previousHash
  };
}

function targetMatches(record, target) {
  if (record.coreId !== target.coreId) return false;
  if (record.moduleDigest && record.moduleDigest !== target.moduleDigest) return false;
  if (record.packagePolicyHash && record.packagePolicyHash !== target.packagePolicyHash) return false;
  if (record.instanceId && record.instanceId !== target.instanceId) return false;
  return true;
}

class CoreRevocationRegistry {
  constructor(stateStore) {
    this.stateStore = stateStore;
    this.schemaReady = false;
  }

  ensureSchema() {
    if (this.schemaReady) return;
    if (!this.stateStore?.db) fail('StateStore must be initialized before revocation access', 'CORE_REVOCATION_STORE_UNAVAILABLE');
    this.stateStore.db.exec(`
      CREATE TABLE IF NOT EXISTS core_revocations (
        sequence INTEGER PRIMARY KEY,
        revocation_id TEXT NOT NULL UNIQUE,
        subject_hash TEXT NOT NULL UNIQUE,
        core_id TEXT NOT NULL,
        module_digest TEXT,
        package_policy_hash TEXT,
        instance_id TEXT,
        reason_code TEXT NOT NULL,
        evidence_hash TEXT,
        created_at TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        record_hash TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_core_revocations_core_sequence
        ON core_revocations(core_id, sequence);
    `);
    this.schemaReady = true;
  }

  list(coreId = null) {
    this.ensureSchema();
    const rows = coreId
      ? this.stateStore.db.prepare('SELECT * FROM core_revocations WHERE core_id = ? ORDER BY sequence').all(coreId)
      : this.stateStore.db.prepare('SELECT * FROM core_revocations ORDER BY sequence').all();
    return rows.map(mapRow);
  }

  verifyChain() {
    const records = this.list();
    let previousHash = GENESIS_HASH;
    let previousSequence = 0;
    for (const record of records) {
      if (record.sequence !== previousSequence + 1) fail('revocation sequence is not contiguous', 'CORE_REVOCATION_CHAIN_INVALID');
      if (record.previousHash !== previousHash) fail('revocation previous hash mismatch', 'CORE_REVOCATION_CHAIN_INVALID');
      const expected = sha256(stableStringify(recordBody(record)));
      if (record.recordHash !== expected) fail('revocation record hash mismatch', 'CORE_REVOCATION_CHAIN_INVALID');
      if (record.subjectHash !== subjectHash(normalizeSubject(record))) fail('revocation subject hash mismatch', 'CORE_REVOCATION_CHAIN_INVALID');
      previousHash = record.recordHash;
      previousSequence = record.sequence;
    }
    return Object.freeze({ count: records.length, headHash: previousHash });
  }

  head() {
    return this.verifyChain();
  }

  record(input = {}) {
    this.ensureSchema();
    this.verifyChain();
    const subject = normalizeSubject(input);
    const reasonCode = typeof input.reasonCode === 'string' ? input.reasonCode.trim() : '';
    if (!REASON.test(reasonCode)) fail('reasonCode must be 3-64 uppercase policy characters');
    const evidenceHash = normalizeHash(input.evidenceHash, 'evidenceHash');
    const createdAt = input.createdAt == null ? new Date().toISOString() : String(input.createdAt);
    if (!Number.isFinite(Date.parse(createdAt))) fail('createdAt is invalid');
    const sHash = subjectHash(subject);

    const existingRow = this.stateStore.db.prepare('SELECT * FROM core_revocations WHERE subject_hash = ?').get(sHash);
    if (existingRow) return Object.freeze({ created: false, record: mapRow(existingRow), head: this.head() });

    let inserted;
    this.stateStore.withTransaction(() => {
      const last = this.stateStore.db.prepare('SELECT sequence, record_hash FROM core_revocations ORDER BY sequence DESC LIMIT 1').get();
      const sequence = Number(last?.sequence || 0) + 1;
      const previousHash = last?.record_hash || GENESIS_HASH;
      const revocationId = 'rev-' + crypto.randomUUID();
      const draft = {
        sequence,
        revocationId,
        subjectHash: sHash,
        ...subject,
        reasonCode,
        evidenceHash,
        createdAt,
        previousHash
      };
      const recordHash = sha256(stableStringify(recordBody(draft)));
      this.stateStore.db.prepare(`
        INSERT INTO core_revocations (
          sequence, revocation_id, subject_hash, core_id, module_digest, package_policy_hash,
          instance_id, reason_code, evidence_hash, created_at, previous_hash, record_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sequence, revocationId, sHash, subject.coreId, subject.moduleDigest, subject.packagePolicyHash,
        subject.instanceId, reasonCode, evidenceHash, createdAt, previousHash, recordHash
      );
      inserted = mapRow(this.stateStore.db.prepare('SELECT * FROM core_revocations WHERE sequence = ?').get(sequence));
    });
    this.stateStore.markWriteSuccess?.();
    this.stateStore.recordRecovery?.('core.revocation.recorded', subject.coreId, {
      revocationId: inserted.revocationId,
      subjectHash: inserted.subjectHash,
      reasonCode: inserted.reasonCode,
      recordHash: inserted.recordHash
    });
    return Object.freeze({ created: true, record: inserted, head: this.head() });
  }

  find(targetInput = {}) {
    this.ensureSchema();
    const target = normalizeSubject(targetInput);
    const records = this.list(target.coreId);
    return records.find(record => targetMatches(record, target)) || null;
  }

  assertNotRevoked(targetInput = {}) {
    const target = normalizeSubject(targetInput);
    this.verifyChain();
    const record = this.find(target);
    if (!record) return true;
    throw Object.assign(new Error(`core ${target.coreId} is revoked by ${record.reasonCode}`), {
      code: 'CORE_REVOKED',
      revocation: {
        revocationId: record.revocationId,
        subjectHash: record.subjectHash,
        reasonCode: record.reasonCode,
        createdAt: record.createdAt,
        recordHash: record.recordHash
      }
    });
  }
}

module.exports = {
  CoreRevocationRegistry,
  GENESIS_HASH,
  normalizeSubject,
  subjectHash,
  targetMatches
};
