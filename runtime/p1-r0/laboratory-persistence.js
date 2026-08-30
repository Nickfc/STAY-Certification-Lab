'use strict';

const { stableStringify } = require('../kernel/canonical-json');
const {
  recordHash,
  validateFounderRecord,
  validateChipObservation,
  validateChipRecord,
  materializeChipRecord,
  chipRecordToObservation
} = require('./records');

const LAB_STORAGE_AUTHORIZATION = 'P1_R0_LABORATORY_STORAGE_V1';
const LAB_SCHEMA_NAME = 'p1-r0-laboratory';
const LAB_SCHEMA_VERSION = 1;
const CHIP_CHAIN_PROTOCOL = 'stay-p1-r0-chip-history-v1';

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function parse(json) {
  return freeze(JSON.parse(json));
}

function chipProjection(row) {
  if (!row) return null;
  let record;
  let observation;
  try {
    record = validateChipRecord(JSON.parse(row.record_json));
    observation = chipRecordToObservation(record);
  } catch {
    fail('current chip projection is invalid', 'P1_CHIP_HISTORY_TAMPER');
  }
  if (
    record.historyHeadHash !== row.history_head_hash ||
    (row.record_hash !== undefined && row.record_hash !== recordHash(record)) ||
    (row.observation_hash !== undefined && row.observation_hash !== recordHash(observation)) ||
    (row.semantic_hash !== undefined && row.semantic_hash !== recordHash(chipSemanticObservation(observation)))
  ) {
    fail('current chip projection disagrees with its history head', 'P1_CHIP_HISTORY_TAMPER');
  }
  return record;
}

function chipSemanticObservation(record) {
  const { observedUtc: _observedUtc, ...semantic } = record;
  return semantic;
}

class P1LaboratoryPersistence {
  constructor({ stateStore, authorization }) {
    if (authorization !== LAB_STORAGE_AUTHORIZATION) {
      fail('P1-R0 laboratory storage authorization is absent', 'P1_LAB_STORAGE_AUTHORIZATION');
    }
    if (!stateStore || typeof stateStore.assertOpen !== 'function' || typeof stateStore.withTransaction !== 'function') {
      fail('an initialized StateStore boundary is required', 'P1_LAB_STORAGE_STATESTORE');
    }
    stateStore.assertOpen();
    this.stateStore = stateStore;
    this.initialized = false;
  }

  initialize() {
    const { stateStore } = this;
    stateStore.assertOpen();
    const existing = stateStore.db.prepare('SELECT version FROM schema_versions WHERE name=?').get(LAB_SCHEMA_NAME);
    const existingVersion = Number(existing?.version ?? 0);
    if (existing && (!Number.isSafeInteger(existingVersion) || existingVersion !== LAB_SCHEMA_VERSION)) {
      fail('P1-R0 laboratory schema version is unsupported', 'P1_LAB_STORAGE_SCHEMA');
    }
    const preexistingTables = stateStore.db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name IN ('p1_founders', 'p1_chip_history', 'p1_chip_current')
    `).get().count;
    if (!existing && preexistingTables !== 0) {
      fail('unversioned P1-R0 laboratory tables are forbidden', 'P1_LAB_STORAGE_SCHEMA');
    }
    const requiredColumns = {
      p1_founders: ['organism_id', 'core_id', 'founder_id', 'lineage_id', 'record_json', 'record_hash', 'committed_at'],
      p1_chip_history: ['chip_id', 'history_sequence', 'organism_id', 'core_id', 'record_json', 'record_hash', 'observation_hash', 'semantic_hash', 'previous_history_hash', 'history_hash', 'observed_at'],
      p1_chip_current: ['chip_id', 'organism_id', 'core_id', 'history_sequence', 'history_head_hash', 'record_json', 'record_hash', 'observation_hash', 'semantic_hash']
    };
    stateStore.withTransaction(() => {
      stateStore.db.exec(`
        CREATE TABLE IF NOT EXISTS p1_founders (
          organism_id TEXT NOT NULL,
          core_id TEXT NOT NULL,
          founder_id TEXT NOT NULL UNIQUE,
          lineage_id TEXT NOT NULL UNIQUE,
          record_json TEXT NOT NULL,
          record_hash TEXT NOT NULL,
          committed_at TEXT NOT NULL,
          PRIMARY KEY(organism_id, core_id)
        );
        CREATE TABLE IF NOT EXISTS p1_chip_history (
          chip_id TEXT NOT NULL,
          history_sequence INTEGER NOT NULL CHECK(history_sequence >= 1),
          organism_id TEXT NOT NULL,
          core_id TEXT NOT NULL,
          record_json TEXT NOT NULL,
          record_hash TEXT NOT NULL,
          observation_hash TEXT NOT NULL,
          semantic_hash TEXT NOT NULL,
          previous_history_hash TEXT,
          history_hash TEXT NOT NULL UNIQUE,
          observed_at TEXT NOT NULL,
          PRIMARY KEY(chip_id, history_sequence)
        );
        CREATE TABLE IF NOT EXISTS p1_chip_current (
          chip_id TEXT PRIMARY KEY,
          organism_id TEXT NOT NULL,
          core_id TEXT NOT NULL,
          history_sequence INTEGER NOT NULL CHECK(history_sequence >= 1),
          history_head_hash TEXT NOT NULL,
          record_json TEXT NOT NULL,
          record_hash TEXT NOT NULL,
          observation_hash TEXT NOT NULL,
          semantic_hash TEXT NOT NULL,
          FOREIGN KEY(chip_id, history_sequence)
            REFERENCES p1_chip_history(chip_id, history_sequence)
            ON DELETE RESTRICT
        );
      `);
      for (const [table, expected] of Object.entries(requiredColumns)) {
        const actual = stateStore.db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
        if (stableStringify(actual) !== stableStringify(expected)) {
          fail('P1-R0 laboratory schema structure is invalid', 'P1_LAB_STORAGE_SCHEMA');
        }
      }
      stateStore.db.prepare(`
        INSERT INTO schema_versions(name, version, updated_at)
        VALUES(?, ?, ?)
        ON CONFLICT(name) DO NOTHING
      `).run(LAB_SCHEMA_NAME, LAB_SCHEMA_VERSION, new Date().toISOString());
    });
    this.initialized = true;
    return this;
  }

  assertInitialized() {
    this.stateStore.assertOpen();
    if (!this.initialized) fail('P1-R0 laboratory storage is not initialized', 'P1_LAB_STORAGE_NOT_INITIALIZED');
  }

  commitFounder(input) {
    this.assertInitialized();
    const record = validateFounderRecord(input);
    const json = stableStringify(record);
    const hash = recordHash(record);
    return this.stateStore.withTransaction(() => {
      const existing = this.stateStore.db.prepare(`
        SELECT record_json, record_hash FROM p1_founders
        WHERE organism_id=? AND core_id=?
      `).get(record.organismId, record.coreId);
      if (existing) {
        let existingRecord;
        try {
          existingRecord = validateFounderRecord(JSON.parse(existing.record_json));
        } catch {
          fail('committed founder record is invalid', 'P1_FOUNDER_TAMPER');
        }
        if (
          existing.record_hash !== recordHash(existingRecord) ||
          existing.record_hash !== hash ||
          existing.record_json !== json
        ) {
          fail('founder reroll or replacement is forbidden', 'P1_FOUNDER_REROLL');
        }
        return parse(existing.record_json);
      }
      try {
        this.stateStore.db.prepare(`
          INSERT INTO p1_founders(
            organism_id, core_id, founder_id, lineage_id,
            record_json, record_hash, committed_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.organismId,
          record.coreId,
          record.founderId,
          record.lineageId,
          json,
          hash,
          new Date().toISOString()
        );
      } catch (error) {
        if (/constraint failed/i.test(String(error?.message || ''))) {
          fail(`founder identity conflicts with committed lineage: ${error.message}`, 'P1_FOUNDER_CONFLICT');
        }
        throw error;
      }
      return record;
    });
  }

  readFounder({ organismId, coreId }) {
    this.assertInitialized();
    const row = this.stateStore.db.prepare(`
      SELECT record_json, record_hash FROM p1_founders WHERE organism_id=? AND core_id=?
    `).get(organismId, coreId);
    if (!row) return null;
    let record;
    try {
      record = validateFounderRecord(JSON.parse(row.record_json));
    } catch {
      fail('committed founder record is invalid', 'P1_FOUNDER_TAMPER');
    }
    if (row.record_hash !== recordHash(record)) fail('committed founder hash is invalid', 'P1_FOUNDER_TAMPER');
    return record;
  }

  readChip(chipId) {
    this.assertInitialized();
    return chipProjection(this.stateStore.db.prepare(`
      SELECT record_json, record_hash, observation_hash, semantic_hash,
             history_sequence, history_head_hash
      FROM p1_chip_current WHERE chip_id=?
    `).get(chipId));
  }

  appendChipObservation(input) {
    this.assertInitialized();
    const observation = validateChipObservation(input);
    if (observation.mode === 'LIVE' || observation.currentState === 'LIVE') {
      fail('laboratory chip history cannot assert LIVE authority', 'P1_LAB_LIVE_FORBIDDEN');
    }
    const observationJson = stableStringify(observation);
    const observationHash = recordHash(observation);
    const semanticHash = recordHash(chipSemanticObservation(observation));
    return this.stateStore.withTransaction(() => {
      const current = this.stateStore.db.prepare(`
        SELECT record_json, record_hash, observation_hash, semantic_hash,
               history_sequence, history_head_hash
        FROM p1_chip_current WHERE chip_id=?
      `).get(observation.chipId);
      if (current) {
        const previousRecord = chipProjection(current);
        const previousObservation = chipRecordToObservation(previousRecord);
        if (
          current.observation_hash === observationHash &&
          stableStringify(previousObservation) === observationJson
        ) return chipProjection(current);
        for (const field of ['organismId', 'coreId', 'publicName', 'born', 'firstActivationFrame', 'firstResidencyId']) {
          if (observation[field] !== previousObservation[field]) fail(`chip ${field} identity drift`, 'P1_CHIP_IDENTITY_DRIFT');
        }
        const previousTrustedFrame = previousObservation.lastTrustedFrame;
        if (
          BigInt(observation.checkpointGeneration) < BigInt(previousObservation.checkpointGeneration) ||
          (previousTrustedFrame !== null && (observation.lastTrustedFrame === null || observation.lastTrustedFrame < previousTrustedFrame)) ||
          BigInt(observation.stateSchemaVersion) < BigInt(previousObservation.stateSchemaVersion)
        ) {
          fail('chip observation would rewind persistent history', 'P1_CHIP_REWIND');
        }
        if (current.semantic_hash === semanticHash) return chipProjection(current);
      }
      const historySequence = Number(current?.history_sequence || 0) + 1;
      const previousHistoryHash = current?.history_head_hash || null;
      const historyHeadHash = recordHash({
        protocol: CHIP_CHAIN_PROTOCOL,
        chipId: observation.chipId,
        historySequence,
        previousHistoryHash,
        observationHash
      });
      const record = materializeChipRecord(observation, historyHeadHash);
      const json = stableStringify(record);
      const hash = recordHash(record);
      this.stateStore.db.prepare(`
        INSERT INTO p1_chip_history(
          chip_id, history_sequence, organism_id, core_id, record_json,
          record_hash, observation_hash, semantic_hash, previous_history_hash,
          history_hash, observed_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.chipId,
        historySequence,
        record.organismId,
        record.coreId,
        json,
        hash,
        observationHash,
        semanticHash,
        previousHistoryHash,
        historyHeadHash,
        record.observedUtc
      );
      this.stateStore.db.prepare(`
        INSERT INTO p1_chip_current(
          chip_id, organism_id, core_id, history_sequence,
          history_head_hash, record_json, record_hash, observation_hash, semantic_hash
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chip_id) DO UPDATE SET
          organism_id=excluded.organism_id,
          core_id=excluded.core_id,
          history_sequence=excluded.history_sequence,
          history_head_hash=excluded.history_head_hash,
          record_json=excluded.record_json,
          record_hash=excluded.record_hash,
          observation_hash=excluded.observation_hash,
          semantic_hash=excluded.semantic_hash
      `).run(
        record.chipId,
        record.organismId,
        record.coreId,
        historySequence,
        historyHeadHash,
        json,
        hash,
        observationHash,
        semanticHash
      );
      return record;
    });
  }

  listChipHistory(chipId, { afterSequence = 0, limit = 256 } = {}) {
    this.assertInitialized();
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 4096
    ) {
      fail('chip history page is invalid', 'P1_CHIP_HISTORY_PAGE');
    }
    return freeze(this.stateStore.db.prepare(`
      SELECT * FROM p1_chip_history
      WHERE chip_id=? AND history_sequence>?
      ORDER BY history_sequence ASC LIMIT ?
    `).all(chipId, afterSequence, limit).map(row => freeze({
      historySequence: Number(row.history_sequence),
      previousHistoryHash: row.previous_history_hash,
      record: validateChipRecord(JSON.parse(row.record_json))
    })));
  }

  verifyChipHistory(chipId) {
    this.assertInitialized();
    const rows = this.stateStore.db.prepare(`
      SELECT * FROM p1_chip_history WHERE chip_id=? ORDER BY history_sequence ASC
    `).iterate(chipId);
    let previousHistoryHash = null;
    let rowCount = 0;
    let lastRow = null;
    for (const row of rows) {
      rowCount += 1;
      const historySequence = rowCount;
      let record;
      let observation;
      try {
        record = validateChipRecord(JSON.parse(row.record_json));
        observation = chipRecordToObservation(record);
      } catch {
        return false;
      }
      if (
        Number(row.history_sequence) !== historySequence ||
        row.previous_history_hash !== previousHistoryHash ||
        row.record_hash !== recordHash(record) ||
        row.observation_hash !== recordHash(observation) ||
        row.semantic_hash !== recordHash(chipSemanticObservation(observation))
      ) return false;
      const expected = recordHash({
        protocol: CHIP_CHAIN_PROTOCOL,
        chipId,
        historySequence,
        previousHistoryHash,
        observationHash: row.observation_hash
      });
      if (row.history_hash !== expected || record.historyHeadHash !== expected) return false;
      previousHistoryHash = expected;
      lastRow = row;
    }
    const current = this.stateStore.db.prepare(`
      SELECT history_sequence, history_head_hash, record_json, record_hash,
             observation_hash, semantic_hash
      FROM p1_chip_current WHERE chip_id=?
    `).get(chipId);
    if (rowCount === 0) return current == null;
    if (
      Number(current?.history_sequence) !== rowCount ||
      current?.history_head_hash !== previousHistoryHash
    ) return false;
    return current.record_json === lastRow.record_json &&
      current.record_hash === lastRow.record_hash &&
      current.observation_hash === lastRow.observation_hash &&
      current.semantic_hash === lastRow.semantic_hash;
  }
}

module.exports = Object.freeze({
  LAB_STORAGE_AUTHORIZATION,
  LAB_SCHEMA_NAME,
  LAB_SCHEMA_VERSION,
  CHIP_CHAIN_PROTOCOL,
  P1LaboratoryPersistence
});
