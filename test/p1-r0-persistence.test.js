'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { StateStore } = require('../runtime/kernel/state-store');
const {
  LAB_STORAGE_AUTHORIZATION,
  P1LaboratoryPersistence
} = require('../runtime/p1-r0/laboratory-persistence');
const {
  recordHash,
  CHIP_STATES,
  CHIP_MODES,
  COVERAGE_BANDS,
  validateFounderRecord,
  validateChipObservation,
  validateCheckpointProjection,
  validateCheckpointSuccessor
} = require('../runtime/p1-r0/records');

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;

function founder(overrides = {}) {
  return {
    recordVersion: 'P1FounderRecordV1',
    organismId: 'stay-p1-r0-test',
    coreId: 'METAB',
    founderId: 'founder:metab:0001',
    lineageId: 'lineage:metab:0001',
    profileId: 'metab-c0-v1',
    profileHash: HASH_A,
    founderSchemaId: 'urn:stay:p1-r0:schema:metab-founder-profile:v1',
    founderSchemaVersion: '1',
    genesisFrame: 0,
    genesisTransactionId: 'tx:metab:genesis:0001',
    phenotypeHash: HASH_B,
    committed: true,
    previousFounderId: null,
    ...overrides
  };
}

function chip(overrides = {}) {
  return {
    recordVersion: 'CoreChipObservationV1',
    chipId: 'resident:metab',
    organismId: 'stay-p1-r0-test',
    coreId: 'METAB',
    publicName: 'METAB',
    born: true,
    firstActivationFrame: 0,
    firstResidencyId: 'resident:metab',
    currentState: 'NEUTRAL',
    mode: 'NEUTRAL',
    lifecycle: 'ATTACHED',
    healthReasonCode: 'NEUTRAL_ACCEPTED',
    coreVersion: '0.1.0-lab',
    stateSchemaVersion: '1',
    checkpointGeneration: '0',
    lastTrustedFrame: null,
    coverageBand: 'UNKNOWN',
    evidenceRefs: [HASH_C],
    observedUtc: '2026-08-30T10:30:00.000Z',
    ...overrides
  };
}

function checkpoint(overrides = {}) {
  return {
    recordVersion: 'P1CheckpointRecordV1',
    organismId: 'stay-p1-r0-test',
    coreId: 'METAB',
    residencyId: 'resident:metab',
    founderId: 'founder:metab:0001',
    lineageId: 'lineage:metab:0001',
    profileHash: HASH_A,
    stateSchemaVersion: 1,
    implementationVersion: '0.1.0-lab',
    authorityEpoch: '0',
    mode: 'NEUTRAL',
    checkpointGeneration: '1',
    parentCheckpointHash: null,
    trustedFrontier: 0,
    fabricFrontier: '1',
    inputCursors: { 'p1r0.capacity.metab': '1' },
    outputSequence: '1',
    stateHash: HASH_A,
    cursorHash: HASH_B,
    outputLedgerHash: HASH_C,
    causalHighWaterHash: HASH_A,
    commitTransactionId: 'tx:checkpoint:0001',
    complete: true,
    createdUtc: '2026-08-30T10:30:00.000Z',
    ...overrides
  };
}

async function makeStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-p1-r0-store-'));
  const stateStore = new StateStore(root);
  await stateStore.init();
  t.after(async () => {
    stateStore.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, stateStore };
}

test('P1R0-PERS-01 default StateStore remains continuity schema 4 with no P1 tables', async t => {
  const { stateStore } = await makeStore(t);
  assert.equal(stateStore.db.prepare("SELECT version FROM schema_versions WHERE name='continuity'").get().version, 4);
  assert.equal(stateStore.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'p1_%'").get().count, 0);
});

test('P1R0-PERS-02 laboratory storage requires exact authorization before DDL', async t => {
  const { stateStore } = await makeStore(t);
  assert.throws(() => new P1LaboratoryPersistence({ stateStore, authorization: 'wrong' }), { code: 'P1_LAB_STORAGE_AUTHORIZATION' });
  assert.equal(stateStore.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'p1_%'").get().count, 0);
});

test('P1R0-PERS-03 opt-in schema is additive and leaves P0 continuity version unchanged', async t => {
  const { stateStore } = await makeStore(t);
  const storage = new P1LaboratoryPersistence({ stateStore, authorization: LAB_STORAGE_AUTHORIZATION });
  storage.initialize();
  assert.equal(stateStore.db.prepare("SELECT version FROM schema_versions WHERE name='continuity'").get().version, 4);
  assert.equal(stateStore.db.prepare("SELECT version FROM schema_versions WHERE name='p1-r0-laboratory'").get().version, 1);
  assert.deepEqual(
    stateStore.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'p1_%' ORDER BY name").all().map(row => row.name),
    ['p1_chip_current', 'p1_chip_history', 'p1_founders']
  );
  const versionTimestamp = stateStore.db.prepare("SELECT updated_at FROM schema_versions WHERE name='p1-r0-laboratory'").get().updated_at;
  storage.initialize();
  assert.equal(stateStore.db.prepare("SELECT updated_at FROM schema_versions WHERE name='p1-r0-laboratory'").get().updated_at, versionTimestamp);
});

test('P1R0-PERS-03b pack-canonical founder and chip observation field types are exact', () => {
  for (const values of [CHIP_STATES, CHIP_MODES, COVERAGE_BANDS]) {
    assert.equal(Object.isFrozen(values), true);
    assert.throws(() => values.push('MUTATED'), TypeError);
  }
  assert.deepEqual(validateFounderRecord(founder()), founder());
  assert.deepEqual(validateChipObservation(chip()), chip());
  assert.throws(() => validateFounderRecord(founder({ founderSchemaVersion: 1 })), { code: 'P1_RECORD_SCHEMA' });
  assert.throws(() => validateFounderRecord(founder({ coreId: 'metab' })), { code: 'P1_RECORD_SCHEMA' });
  assert.throws(() => validateChipObservation(chip({ checkpointGeneration: 0 })), { code: 'P1_RECORD_SCHEMA' });
  assert.throws(() => validateChipObservation(chip({ evidenceRefs: [] })), { code: 'P1_RECORD_SCHEMA' });
  assert.equal(validateChipObservation(chip({
    currentState: 'OFFLINE',
    mode: 'NONE',
    coverageBand: 'NOT_APPLICABLE'
  })).mode, 'NONE');
});

test('P1R0-PERS-03c unversioned or structurally partial laboratory schema fails without adoption', async t => {
  const { stateStore } = await makeStore(t);
  stateStore.db.exec('CREATE TABLE p1_founders (wrong TEXT)');
  const storage = new P1LaboratoryPersistence({ stateStore, authorization: LAB_STORAGE_AUTHORIZATION });
  assert.throws(() => storage.initialize(), { code: 'P1_LAB_STORAGE_SCHEMA' });
  assert.equal(stateStore.db.prepare("SELECT COUNT(*) AS count FROM schema_versions WHERE name='p1-r0-laboratory'").get().count, 0);
  assert.deepEqual(
    stateStore.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'p1_%' ORDER BY name").all().map(row => row.name),
    ['p1_founders']
  );
});

test('P1R0-PERS-04 one founder is idempotent but reroll and forbidden semantics fail closed', async t => {
  const { stateStore } = await makeStore(t);
  const storage = new P1LaboratoryPersistence({ stateStore, authorization: LAB_STORAGE_AUTHORIZATION });
  storage.initialize();
  assert.deepEqual(storage.commitFounder(founder()), storage.commitFounder(founder()));
  assert.throws(() => storage.commitFounder(founder({ phenotypeHash: HASH_C })), { code: 'P1_FOUNDER_REROLL' });
  assert.throws(() => storage.commitFounder({ ...founder(), owner: 'viewer' }), { code: 'P1_RECORD_SCHEMA' });
  assert.throws(() => storage.commitFounder(founder({ coreId: 'HOMEOS' })), { code: 'P1_FOUNDER_CONFLICT' });
  assert.deepEqual(storage.readFounder({ organismId: 'stay-p1-r0-test', coreId: 'METAB' }), founder());
  stateStore.db.prepare("UPDATE p1_founders SET record_json='{}' WHERE organism_id=? AND core_id=?")
    .run('stay-p1-r0-test', 'METAB');
  assert.throws(() => storage.readFounder({ organismId: 'stay-p1-r0-test', coreId: 'METAB' }), { code: 'P1_FOUNDER_TAMPER' });
});

test('P1R0-PERS-05 chip history is append-only, identity-fenced and survives OFFLINE', async t => {
  const { stateStore } = await makeStore(t);
  const storage = new P1LaboratoryPersistence({ stateStore, authorization: LAB_STORAGE_AUTHORIZATION });
  storage.initialize();
  const first = storage.appendChipObservation(chip());
  const offline = storage.appendChipObservation(chip({
    currentState: 'OFFLINE',
    lifecycle: 'DETACHED',
    healthReasonCode: 'LAB_REMOVAL',
    checkpointGeneration: '2',
    lastTrustedFrame: 8,
    observedUtc: '2026-08-30T10:31:00.000Z'
  }));
  assert.equal(first.recordVersion, 'CoreChipRecordV1');
  assert.equal(first.checkpointGeneration, '0');
  assert.equal(first.lastTrustedFrame, null);
  assert.equal(offline.currentState, 'OFFLINE');
  assert.match(offline.historyHeadHash, /^sha256:[0-9a-f]{64}$/);
  const history = storage.listChipHistory('resident:metab');
  assert.deepEqual(history.map(entry => entry.historySequence), [1, 2]);
  assert.deepEqual(history.map(entry => entry.record.recordVersion), ['CoreChipRecordV1', 'CoreChipRecordV1']);
  assert.throws(() => storage.appendChipObservation(chip({
    firstResidencyId: 'resident:metab:replacement',
    checkpointGeneration: '3',
    observedUtc: '2026-08-30T10:32:00.000Z'
  })), { code: 'P1_CHIP_IDENTITY_DRIFT' });
  assert.throws(() => storage.appendChipObservation(chip({
    checkpointGeneration: '1',
    observedUtc: '2026-08-30T10:32:00.000Z'
  })), { code: 'P1_CHIP_REWIND' });
});

test('P1R0-PERS-06 exact chip retry is idempotent and reopening preserves its chain', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-p1-r0-reopen-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let stateStore = new StateStore(root);
  await stateStore.init();
  let storage = new P1LaboratoryPersistence({ stateStore, authorization: LAB_STORAGE_AUTHORIZATION });
  storage.initialize();
  const first = storage.appendChipObservation(chip());
  assert.deepEqual(storage.appendChipObservation(chip()), first);
  assert.deepEqual(storage.appendChipObservation(chip({
    observedUtc: '2026-08-30T10:30:30.000Z'
  })), first);
  assert.equal(storage.listChipHistory('resident:metab').length, 1);
  assert.throws(() => storage.listChipHistory('resident:metab', { limit: 4097 }), { code: 'P1_CHIP_HISTORY_PAGE' });
  stateStore.close();

  stateStore = new StateStore(root);
  await stateStore.init();
  storage = new P1LaboratoryPersistence({ stateStore, authorization: LAB_STORAGE_AUTHORIZATION });
  storage.initialize();
  assert.deepEqual(storage.readChip('resident:metab'), first);
  assert.equal(storage.verifyChipHistory('resident:metab'), true);
  stateStore.close();
});

test('P1R0-PERS-07 persistence surface exposes no erase, route, mode or attachment operation', async t => {
  const { stateStore } = await makeStore(t);
  const storage = new P1LaboratoryPersistence({ stateStore, authorization: LAB_STORAGE_AUTHORIZATION });
  storage.initialize();
  for (const name of ['deleteFounder', 'deleteChip', 'createRoute', 'changeMode', 'attachResident', 'writeCheckpoint']) {
    assert.equal(storage[name], undefined, name);
  }
});

test('P1R0-PERS-08 future laboratory schema and chip-history tampering fail visibly', async t => {
  const { stateStore } = await makeStore(t);
  let storage = new P1LaboratoryPersistence({ stateStore, authorization: LAB_STORAGE_AUTHORIZATION });
  storage.initialize();
  storage.appendChipObservation(chip());
  stateStore.db.prepare("UPDATE p1_chip_history SET record_json='{}' WHERE chip_id=?").run('resident:metab');
  assert.equal(storage.verifyChipHistory('resident:metab'), false);

  stateStore.db.prepare("UPDATE schema_versions SET version=2 WHERE name='p1-r0-laboratory'").run();
  storage = new P1LaboratoryPersistence({ stateStore, authorization: LAB_STORAGE_AUTHORIZATION });
  assert.throws(() => storage.initialize(), { code: 'P1_LAB_STORAGE_SCHEMA' });
  assert.equal(stateStore.db.prepare("SELECT version FROM schema_versions WHERE name='continuity'").get().version, 4);
});

test('P1R0-PERS-08b semantic and current-head tampering fail visible verification', async t => {
  const { stateStore } = await makeStore(t);
  const storage = new P1LaboratoryPersistence({ stateStore, authorization: LAB_STORAGE_AUTHORIZATION });
  storage.initialize();
  const original = chip();
  storage.appendChipObservation(original);

  stateStore.db.prepare(`
    UPDATE p1_chip_history SET semantic_hash=? WHERE chip_id=? AND history_sequence=1
  `).run(HASH_A, original.chipId);
  assert.equal(storage.verifyChipHistory(original.chipId), false);

  const { observedUtc: _observedUtc, ...semantic } = original;
  stateStore.db.prepare(`
    UPDATE p1_chip_history SET semantic_hash=? WHERE chip_id=? AND history_sequence=1
  `).run(recordHash(semantic), original.chipId);
  stateStore.db.prepare(`
    UPDATE p1_chip_current SET record_json=? WHERE chip_id=?
  `).run(JSON.stringify({ ...original, healthReasonCode: 'TAMPERED' }), original.chipId);
  assert.equal(storage.verifyChipHistory(original.chipId), false);
  assert.throws(() => storage.readChip(original.chipId), { code: 'P1_CHIP_HISTORY_TAMPER' });
});

test('P1R0-PERS-08c impossible UTC calendar dates fail closed', async t => {
  const { stateStore } = await makeStore(t);
  const storage = new P1LaboratoryPersistence({ stateStore, authorization: LAB_STORAGE_AUTHORIZATION });
  storage.initialize();
  assert.throws(() => storage.appendChipObservation(chip({
    observedUtc: '2026-02-31T12:00:00.000Z'
  })), { code: 'P1_RECORD_SCHEMA' });
  assert.throws(() => validateCheckpointProjection(checkpoint({
    createdUtc: '2026-02-31T12:00:00.000Z'
  })), { code: 'P1_RECORD_SCHEMA' });
});

test('P1R0-PERS-09 checkpoint projection binds one forward state/cursor/output transaction', () => {
  const first = validateCheckpointProjection(checkpoint());
  const next = checkpoint({
    checkpointGeneration: '2',
    parentCheckpointHash: recordHash(first),
    trustedFrontier: 1,
    fabricFrontier: '2',
    inputCursors: { 'p1r0.capacity.metab': '2' },
    outputSequence: '2',
    commitTransactionId: 'tx:checkpoint:0002',
    createdUtc: '2026-08-30T10:31:00.000Z'
  });
  assert.deepEqual(validateCheckpointSuccessor(first, next), next);
  assert.throws(() => validateCheckpointSuccessor(first, { ...next, fabricFrontier: '0' }), { code: 'P1_CHECKPOINT_REWIND' });
  assert.throws(() => validateCheckpointSuccessor(first, { ...next, lineageId: 'lineage:metab:replacement' }), { code: 'P1_CHECKPOINT_IDENTITY' });
  assert.throws(() => validateCheckpointSuccessor(first, { ...next, parentCheckpointHash: HASH_C }), { code: 'P1_CHECKPOINT_PARENT' });
});

test('P1R0-PERS-10 laboratory chip history cannot assert LIVE authority', async t => {
  const { stateStore } = await makeStore(t);
  const storage = new P1LaboratoryPersistence({ stateStore, authorization: LAB_STORAGE_AUTHORIZATION });
  storage.initialize();
  assert.throws(() => storage.appendChipObservation(chip({
    currentState: 'LIVE',
    mode: 'LIVE'
  })), { code: 'P1_LAB_LIVE_FORBIDDEN' });
  assert.equal(storage.readChip('resident:metab'), null);
});
