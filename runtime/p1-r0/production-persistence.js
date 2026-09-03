'use strict';

const { stableStringify } = require('../kernel/canonical-json');
const {
  LAB_STORAGE_AUTHORIZATION,
  P1LaboratoryPersistence
} = require('./laboratory-persistence');
const {
  recordHash,
  validateFounderRecord,
  validateChipObservation
} = require('./records');
const { METAB_NEUTRAL_RESIDENT_CONTRACT } = require('./metab-neutral-contract');
const { METAB_SHADOW_RESIDENT_CONTRACT } = require('./metab-shadow-contract');
const { HOMEOS_NEUTRAL_RESIDENT_CONTRACT } = require('./homeos-neutral-contract');
const { HOMEOS_SHADOW_RESIDENT_CONTRACT } = require('./homeos-shadow-contract');
const { METAB_HOMEOS_RESIDENT_CONTRACT } = require('./metab-homeos-contract');
const { METAB_INTERO_RESIDENT_CONTRACT } = require('./metab-intero-contract');
const { HOMEOS_INTERO_RESIDENT_CONTRACT } = require('./homeos-intero-contract');
const { INTERO_NEUTRAL_RESIDENT_CONTRACT } = require('./intero-neutral-contract');
const { INTERO_SHADOW_RESIDENT_CONTRACT } = require('./intero-shadow-contract');
const { normalizeNeutralFounder } = require('./residents/metab-neutral');
const { normalizeNeutralFounder: normalizeHomeosFounder } = require('./residents/homeos-neutral');
const { normalizeNeutralFounder: normalizeInteroFounder } = require('./residents/intero-neutral');

const PRODUCTION_STORAGE_AUTHORIZATION =
  'P1_R0_PRODUCTION_STORAGE_R124_NEUTRAL_V1';
const PRODUCTION_SCHEMA_NAME =
  'p1-r0-production';
const METAB_NEUTRAL_AUTHORIZATION_CLASS =
  'metab-resident-neutral-zero-authority-r124';
const HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const EXPANSION_SCHEMA_NAME = 'p1-r0-production-expansion';
const EXPANSION_SCHEMA_VERSION = 1;

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function normalizeBirthDossier(authorization, founder) {
  if (
    !authorization ||
    authorization.ok !== true ||
    authorization.authorizationClass !==
      METAB_NEUTRAL_AUTHORIZATION_CLASS ||
    typeof authorization.certificateId !== 'string' ||
    !SAFE_ID.test(authorization.certificateId) ||
    authorization.targetRevision !== 124 ||
    !HASH.test(String(authorization.parentFreezeRecordSha256 || '')) ||
    !HASH.test(String(authorization.founderDossierSha256 || ''))
  ) {
    fail('METAB neutral birth dossier authority is invalid', 'P1_PRODUCTION_BIRTH_DOSSIER');
  }
  const founderRecord = validateFounderRecord(authorization.founderRecord);
  if (stableStringify(founderRecord) !== stableStringify(founder)) {
    fail('METAB neutral birth dossier founder disagrees', 'P1_PRODUCTION_BIRTH_DOSSIER');
  }
  let founderBinding;
  try {
    founderBinding = normalizeNeutralFounder(authorization.founderBinding, {
      identitySha256: authorization.founderBinding?.organismIdentityHash,
      organismLineage: 'STAY/Genesis',
      runtimeRevision: 124
    });
  } catch (error) {
    fail(`METAB neutral birth dossier binding is invalid: ${error.message}`, 'P1_PRODUCTION_BIRTH_DOSSIER');
  }
  if (
    founderBinding.organismId !== founder.organismId ||
    founderBinding.coreId !== founder.coreId ||
    founderBinding.founderId !== founder.founderId ||
    founderBinding.lineageId !== founder.lineageId ||
    founderBinding.profileId !== founder.profileId ||
    founderBinding.profileHash !== founder.profileHash
  ) {
    fail('METAB neutral birth dossier identities disagree', 'P1_PRODUCTION_BIRTH_DOSSIER');
  }
  return Object.freeze({
    recordVersion: 'P1NeutralBirthDossierV1',
    residencyId: 'resident:metab',
    organismId: founder.organismId,
    coreId: 'METAB',
    targetRevision: 124,
    certificateId: authorization.certificateId,
    authorizationClass: authorization.authorizationClass,
    parentFreezeRecordSha256: authorization.parentFreezeRecordSha256,
    founderDossierSha256: authorization.founderDossierSha256,
    founderRecord,
    founderBinding
  });
}

function validateStoredBirthDossier(input) {
  const fields = [
    'recordVersion', 'residencyId', 'organismId', 'coreId', 'targetRevision',
    'certificateId', 'authorizationClass', 'parentFreezeRecordSha256',
    'founderDossierSha256', 'founderRecord', 'founderBinding'
  ].sort();
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    stableStringify(Object.keys(input).sort()) !== stableStringify(fields)
  ) {
    fail('committed METAB neutral birth dossier is invalid', 'P1_PRODUCTION_BIRTH_DOSSIER_TAMPER');
  }
  try {
    return normalizeBirthDossier({
      ok: true,
      certificateId: input.certificateId,
      authorizationClass: input.authorizationClass,
      parentFreezeRecordSha256: input.parentFreezeRecordSha256,
      founderDossierSha256: input.founderDossierSha256,
      founderRecord: input.founderRecord,
      founderBinding: input.founderBinding,
      targetRevision: input.targetRevision
    }, input.founderRecord);
  } catch (error) {
    fail(`committed METAB neutral birth dossier is invalid: ${error.message}`, 'P1_PRODUCTION_BIRTH_DOSSIER_TAMPER');
  }
}

class P1ProductionPersistence extends P1LaboratoryPersistence {
  constructor({ stateStore, authorization }) {
    if (authorization !== PRODUCTION_STORAGE_AUTHORIZATION) {
      fail(
        'P1-R0 production storage authorization is absent',
        'P1_PRODUCTION_STORAGE_AUTHORIZATION'
      );
    }
    super({
      stateStore,
      authorization: LAB_STORAGE_AUTHORIZATION,
      schemaName: PRODUCTION_SCHEMA_NAME
    });
  }

  schemaExtensions() {
    return Object.freeze({
      ddl: `
        CREATE TABLE IF NOT EXISTS p1_birth_dossiers (
          residency_id TEXT PRIMARY KEY,
          organism_id TEXT NOT NULL,
          core_id TEXT NOT NULL,
          target_revision INTEGER NOT NULL CHECK(target_revision = 124),
          certificate_id TEXT NOT NULL UNIQUE,
          dossier_json TEXT NOT NULL,
          dossier_hash TEXT NOT NULL,
          committed_at TEXT NOT NULL
        );
      `,
      requiredColumns: Object.freeze({
        p1_birth_dossiers: Object.freeze([
          'residency_id', 'organism_id', 'core_id', 'target_revision',
          'certificate_id', 'dossier_json', 'dossier_hash', 'committed_at'
        ])
      })
    });
  }

  initialize() {
    super.initialize();
    return this;
  }

  commitNeutralBirth({ founder, resident, authorization } = {}) {
    this.assertInitialized();
    const normalizedFounder = validateFounderRecord(founder);
    const contract = METAB_NEUTRAL_RESIDENT_CONTRACT;
    if (
      normalizedFounder.coreId !== 'METAB' ||
      !resident ||
      resident.residencyId !== contract.residencyId ||
      resident.coreId !== contract.coreId ||
      resident.role !== contract.role ||
      resident.version !== contract.version ||
      resident.stateSchema !== contract.stateSchema ||
      resident.moduleRelativePath !== 'cores/p1-r0/metab-neutral/index.js' ||
      resident.packagePolicyHash !== contract.packagePolicyHash ||
      resident.organismIdentityHash == null
    ) {
      fail('METAB neutral birth registration is not exact', 'P1_PRODUCTION_BIRTH_REGISTRATION');
    }
    return this.stateStore.withTransaction(() => {
      const committedFounder = super.commitFounder(normalizedFounder);
      const dossier = normalizeBirthDossier(authorization, committedFounder);
      const dossierJson = stableStringify(dossier);
      const dossierHash = recordHash(dossier);
      const existingDossier = this.stateStore.db.prepare(`
        SELECT dossier_json, dossier_hash FROM p1_birth_dossiers
        WHERE residency_id=?
      `).get('resident:metab');
      if (existingDossier) {
        const committedDossier = validateStoredBirthDossier(
          JSON.parse(existingDossier.dossier_json)
        );
        if (
          existingDossier.dossier_hash !== recordHash(committedDossier) ||
          existingDossier.dossier_hash !== dossierHash ||
          existingDossier.dossier_json !== dossierJson
        ) {
          fail('METAB neutral birth dossier replacement is forbidden', 'P1_PRODUCTION_BIRTH_DOSSIER_CONFLICT');
        }
      } else {
        this.stateStore.db.prepare(`
          INSERT INTO p1_birth_dossiers(
            residency_id, organism_id, core_id, target_revision,
            certificate_id, dossier_json, dossier_hash, committed_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          dossier.residencyId,
          dossier.organismId,
          dossier.coreId,
          dossier.targetRevision,
          dossier.certificateId,
          dossierJson,
          dossierHash,
          new Date().toISOString()
        );
      }
      const committedResident = this.stateStore.registerResident(resident);
      return Object.freeze({
        founder: committedFounder,
        resident: committedResident,
        dossier
      });
    });
  }

  readBirthDossier(residencyId = 'resident:metab') {
    this.assertInitialized();
    const row = this.stateStore.db.prepare(`
      SELECT dossier_json, dossier_hash FROM p1_birth_dossiers
      WHERE residency_id=?
    `).get(residencyId);
    if (!row) return null;
    let dossier;
    try {
      dossier = validateStoredBirthDossier(JSON.parse(row.dossier_json));
    } catch (error) {
      if (error?.code === 'P1_PRODUCTION_BIRTH_DOSSIER_TAMPER') throw error;
      fail('committed METAB neutral birth dossier is invalid', 'P1_PRODUCTION_BIRTH_DOSSIER_TAMPER');
    }
    if (
      row.dossier_hash !== recordHash(dossier) ||
      row.dossier_json !== stableStringify(dossier)
    ) {
      fail('committed METAB neutral birth dossier hash is invalid', 'P1_PRODUCTION_BIRTH_DOSSIER_TAMPER');
    }
    return dossier;
  }

  appendNeutralChip(input) {
    this.assertInitialized();
    const observation = validateChipObservation(input);
    const resident = this.stateStore.getResident('resident:metab');
    if (
      observation.coreId !== 'METAB' ||
      observation.chipId !== 'resident:metab' ||
      observation.firstResidencyId !== 'resident:metab' ||
      observation.currentState !== 'NEUTRAL' ||
      observation.mode !== 'NEUTRAL' ||
      observation.lastTrustedFrame !== null ||
      observation.coverageBand !== 'UNKNOWN' ||
      observation.coreVersion !== METAB_NEUTRAL_RESIDENT_CONTRACT.version ||
      !resident ||
      resident.status !== 'RUNNING' ||
      resident.version !== observation.coreVersion ||
      String(resident.stateSchema) !== observation.stateSchemaVersion ||
      String(resident.checkpointGeneration) !== observation.checkpointGeneration
    ) {
      fail('METAB neutral chip acceptance is not exact', 'P1_PRODUCTION_CHIP');
    }
    return super.appendChipObservation(observation);
  }

  appendShadowChip(input) {
    this.assertInitialized();
    const observation = validateChipObservation(input);
    const resident = this.stateStore.getResident('resident:metab');
    if (
      observation.coreId !== 'METAB' ||
      observation.chipId !== 'resident:metab' ||
      observation.firstResidencyId !== 'resident:metab' ||
      observation.currentState !== 'SHADOW' ||
      observation.mode !== 'SHADOW' ||
      (
        observation.lastTrustedFrame === null
          ? observation.coverageBand !== 'UNKNOWN'
          : (
              observation.lastTrustedFrame < 1 ||
              observation.coverageBand !== 'FULL'
            )
      ) ||
      observation.coreVersion !== METAB_SHADOW_RESIDENT_CONTRACT.version ||
      observation.stateSchemaVersion !==
        String(METAB_SHADOW_RESIDENT_CONTRACT.stateSchema) ||
      !resident ||
      resident.status !== 'RUNNING' ||
      resident.version !== observation.coreVersion ||
      resident.instanceId == null ||
      String(resident.stateSchema) !== observation.stateSchemaVersion ||
      String(resident.checkpointGeneration) !== observation.checkpointGeneration
    ) {
      fail('METAB shadow chip acceptance is not exact', 'P1_PRODUCTION_CHIP');
    }
    return super.appendChipObservation(observation);
  }
}

function normalizeExpansionBirthDossier(authorization, founder, {
  coreId,
  residencyId,
  targetRevision,
  authorizationClass,
  normalizeFounder
}) {
  if (
    !authorization || authorization.ok !== true ||
    authorization.authorizationClass !== authorizationClass ||
    authorization.targetRevision !== targetRevision ||
    typeof authorization.certificateId !== 'string' ||
    !SAFE_ID.test(authorization.certificateId) ||
    !HASH.test(String(authorization.parentFreezeRecordSha256 || '')) ||
    !HASH.test(String(authorization.founderDossierSha256 || ''))
  ) fail(`${coreId} neutral birth dossier authority is invalid`, 'P1_PRODUCTION_EXPANSION_DOSSIER');
  const founderRecord = validateFounderRecord(authorization.founderRecord);
  if (stableStringify(founderRecord) !== stableStringify(founder)) {
    fail(`${coreId} neutral birth dossier founder disagrees`, 'P1_PRODUCTION_EXPANSION_DOSSIER');
  }
  let founderBinding;
  try {
    founderBinding = normalizeFounder(authorization.founderBinding, {
      identitySha256: authorization.founderBinding?.organismIdentityHash,
      organismLineage: 'STAY/Genesis',
      runtimeRevision: targetRevision
    });
  } catch (error) {
    fail(`${coreId} neutral birth dossier binding is invalid: ${error.message}`, 'P1_PRODUCTION_EXPANSION_DOSSIER');
  }
  if (
    founderBinding.organismId !== founderRecord.organismId ||
    founderBinding.coreId !== coreId || founderRecord.coreId !== coreId ||
    founderBinding.residencyId !== residencyId ||
    founderBinding.founderId !== founderRecord.founderId ||
    founderBinding.lineageId !== founderRecord.lineageId ||
    founderBinding.profileId !== founderRecord.profileId ||
    founderBinding.profileHash !== founderRecord.profileHash
  ) fail(`${coreId} neutral birth dossier identities disagree`, 'P1_PRODUCTION_EXPANSION_DOSSIER');
  return Object.freeze({
    recordVersion: 'P1NeutralBirthDossierV2',
    residencyId,
    organismId: founderRecord.organismId,
    coreId,
    targetRevision,
    certificateId: authorization.certificateId,
    authorizationClass,
    parentFreezeRecordSha256: authorization.parentFreezeRecordSha256,
    founderDossierSha256: authorization.founderDossierSha256,
    founderRecord,
    founderBinding
  });
}

class P1ProductionExpansionPersistence {
  constructor({ stateStore, authorization }) {
    if (authorization !== PRODUCTION_STORAGE_AUTHORIZATION) {
      fail('P1-R0 production expansion storage authorization is absent', 'P1_PRODUCTION_STORAGE_AUTHORIZATION');
    }
    this.stateStore = stateStore;
    this.legacy = new P1ProductionPersistence({ stateStore, authorization });
    this.initialized = false;
  }

  initialize() {
    this.legacy.initialize();
    const existing = this.stateStore.db.prepare(
      'SELECT version FROM schema_versions WHERE name=?'
    ).get(EXPANSION_SCHEMA_NAME);
    if (existing && Number(existing.version) !== EXPANSION_SCHEMA_VERSION) {
      fail('P1-R0 production expansion schema version is unsupported', 'P1_PRODUCTION_EXPANSION_SCHEMA');
    }
    const table = this.stateStore.db.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type='table' AND name='p1_birth_dossiers_v2'
    `).get();
    if (!existing && table) {
      fail('unversioned P1-R0 production expansion table is forbidden', 'P1_PRODUCTION_EXPANSION_SCHEMA');
    }
    this.stateStore.withTransaction(() => {
      this.stateStore.db.exec(`
        CREATE TABLE IF NOT EXISTS p1_birth_dossiers_v2 (
          residency_id TEXT PRIMARY KEY,
          organism_id TEXT NOT NULL,
          core_id TEXT NOT NULL,
          target_revision INTEGER NOT NULL CHECK(target_revision >= 143),
          certificate_id TEXT NOT NULL UNIQUE,
          dossier_json TEXT NOT NULL,
          dossier_hash TEXT NOT NULL,
          committed_at TEXT NOT NULL
        );
      `);
      const columns = this.stateStore.db.prepare(
        'PRAGMA table_info(p1_birth_dossiers_v2)'
      ).all().map(column => column.name);
      const expected = [
        'residency_id', 'organism_id', 'core_id', 'target_revision',
        'certificate_id', 'dossier_json', 'dossier_hash', 'committed_at'
      ];
      if (stableStringify(columns) !== stableStringify(expected)) {
        fail('P1-R0 production expansion schema structure is invalid', 'P1_PRODUCTION_EXPANSION_SCHEMA');
      }
      this.stateStore.db.prepare(`
        INSERT INTO schema_versions(name, version, updated_at)
        VALUES(?, ?, ?) ON CONFLICT(name) DO NOTHING
      `).run(EXPANSION_SCHEMA_NAME, EXPANSION_SCHEMA_VERSION, new Date().toISOString());
    });
    this.initialized = true;
    return this;
  }

  assertInitialized() {
    this.stateStore.assertOpen();
    if (!this.initialized) {
      fail('P1-R0 production expansion storage is not initialized', 'P1_PRODUCTION_EXPANSION_NOT_INITIALIZED');
    }
  }

  readFounder(query) {
    this.assertInitialized();
    return this.legacy.readFounder(query);
  }

  commitHomeosNeutralBirth({ founder, resident, authorization } = {}) {
    this.assertInitialized();
    const normalizedFounder = validateFounderRecord(founder);
    const contract = HOMEOS_NEUTRAL_RESIDENT_CONTRACT;
    if (
      normalizedFounder.coreId !== 'HOMEOS' || !resident ||
      resident.residencyId !== contract.residencyId || resident.coreId !== contract.coreId ||
      resident.role !== contract.role || resident.version !== contract.version ||
      resident.stateSchema !== contract.stateSchema ||
      resident.moduleRelativePath !== 'cores/p1-r0/homeos-neutral/index.js' ||
      resident.packagePolicyHash !== contract.packagePolicyHash ||
      resident.organismIdentityHash == null
    ) fail('HOMEOS neutral birth registration is not exact', 'P1_PRODUCTION_HOMEOS_REGISTRATION');
    return this.stateStore.withTransaction(() => {
      const committedFounder = this.legacy.commitFounder(normalizedFounder);
      const dossier = normalizeExpansionBirthDossier(authorization, committedFounder, {
        coreId: 'HOMEOS',
        residencyId: 'resident:homeos',
        targetRevision: 143,
        authorizationClass: 'homeos-resident-neutral-zero-authority-r143',
        normalizeFounder: normalizeHomeosFounder
      });
      const dossierJson = stableStringify(dossier);
      const dossierHash = recordHash(dossier);
      const existing = this.stateStore.db.prepare(`
        SELECT dossier_json, dossier_hash FROM p1_birth_dossiers_v2
        WHERE residency_id=?
      `).get('resident:homeos');
      if (existing) {
        if (
          existing.dossier_hash !== dossierHash ||
          existing.dossier_json !== dossierJson
        ) fail('HOMEOS neutral birth dossier replacement is forbidden', 'P1_PRODUCTION_EXPANSION_DOSSIER_CONFLICT');
      } else {
        this.stateStore.db.prepare(`
          INSERT INTO p1_birth_dossiers_v2(
            residency_id, organism_id, core_id, target_revision,
            certificate_id, dossier_json, dossier_hash, committed_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          dossier.residencyId, dossier.organismId, dossier.coreId,
          dossier.targetRevision, dossier.certificateId, dossierJson,
          dossierHash, new Date().toISOString()
        );
      }
      const committedResident = this.stateStore.registerResident(resident);
      return Object.freeze({ founder: committedFounder, resident: committedResident, dossier });
    });
  }

  commitInteroNeutralBirth({ founder, resident, authorization } = {}) {
    this.assertInitialized();
    const normalizedFounder = validateFounderRecord(founder);
    const contract = INTERO_NEUTRAL_RESIDENT_CONTRACT;
    if (
      normalizedFounder.coreId !== 'INTERO' || !resident ||
      resident.residencyId !== contract.residencyId || resident.coreId !== contract.coreId ||
      resident.role !== contract.role || resident.version !== contract.version ||
      resident.stateSchema !== contract.stateSchema ||
      resident.moduleRelativePath !== 'cores/p1-r0/intero-neutral/index.js' ||
      resident.packagePolicyHash !== contract.packagePolicyHash ||
      resident.organismIdentityHash == null
    ) fail('INTERO neutral birth registration is not exact', 'P1_PRODUCTION_INTERO_REGISTRATION');
    return this.stateStore.withTransaction(() => {
      const committedFounder = this.legacy.commitFounder(normalizedFounder);
      const dossier = normalizeExpansionBirthDossier(authorization, committedFounder, {
        coreId: 'INTERO',
        residencyId: 'resident:intero',
        targetRevision: 147,
        authorizationClass: 'intero-resident-neutral-zero-authority-r147',
        normalizeFounder: normalizeInteroFounder
      });
      const dossierJson = stableStringify(dossier);
      const dossierHash = recordHash(dossier);
      const existing = this.stateStore.db.prepare(`
        SELECT dossier_json, dossier_hash FROM p1_birth_dossiers_v2
        WHERE residency_id=?
      `).get('resident:intero');
      if (existing) {
        if (existing.dossier_hash !== dossierHash || existing.dossier_json !== dossierJson) {
          fail('INTERO neutral birth dossier replacement is forbidden', 'P1_PRODUCTION_EXPANSION_DOSSIER_CONFLICT');
        }
      } else {
        this.stateStore.db.prepare(`
          INSERT INTO p1_birth_dossiers_v2(
            residency_id, organism_id, core_id, target_revision,
            certificate_id, dossier_json, dossier_hash, committed_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          dossier.residencyId, dossier.organismId, dossier.coreId,
          dossier.targetRevision, dossier.certificateId, dossierJson,
          dossierHash, new Date().toISOString()
        );
      }
      const committedResident = this.stateStore.registerResident(resident);
      return Object.freeze({ founder: committedFounder, resident: committedResident, dossier });
    });
  }

  readBirthDossier(residencyId) {
    this.assertInitialized();
    const row = this.stateStore.db.prepare(`
      SELECT dossier_json, dossier_hash FROM p1_birth_dossiers_v2
      WHERE residency_id=?
    `).get(residencyId);
    if (!row) return null;
    let dossier;
    try { dossier = JSON.parse(row.dossier_json); } catch {
      fail('committed expansion birth dossier is invalid', 'P1_PRODUCTION_EXPANSION_DOSSIER_TAMPER');
    }
    if (
      dossier?.recordVersion !== 'P1NeutralBirthDossierV2' ||
      dossier?.residencyId !== residencyId ||
      row.dossier_hash !== recordHash(dossier) ||
      row.dossier_json !== stableStringify(dossier)
    ) fail('committed expansion birth dossier hash is invalid', 'P1_PRODUCTION_EXPANSION_DOSSIER_TAMPER');
    return Object.freeze(dossier);
  }

  appendHomeosChip(input, { shadow = false } = {}) {
    this.assertInitialized();
    const observation = validateChipObservation(input);
    const contract = shadow ? HOMEOS_SHADOW_RESIDENT_CONTRACT : HOMEOS_NEUTRAL_RESIDENT_CONTRACT;
    const resident = this.stateStore.getResident('resident:homeos');
    const expectedState = shadow ? 'SHADOW' : 'NEUTRAL';
    if (
      observation.coreId !== 'HOMEOS' || observation.chipId !== 'resident:homeos' ||
      observation.firstResidencyId !== 'resident:homeos' ||
      observation.currentState !== expectedState || observation.mode !== expectedState ||
      observation.coreVersion !== contract.version ||
      observation.stateSchemaVersion !== String(contract.stateSchema) ||
      !resident || resident.status !== 'RUNNING' ||
      resident.version !== observation.coreVersion ||
      String(resident.stateSchema) !== observation.stateSchemaVersion ||
      String(resident.checkpointGeneration) !== observation.checkpointGeneration ||
      (shadow && observation.coverageBand === 'NOT_APPLICABLE')
    ) fail('HOMEOS chip acceptance is not exact', 'P1_PRODUCTION_HOMEOS_CHIP');
    return this.legacy.appendChipObservation(observation);
  }

  appendMetabHomeosChip(input) {
    this.assertInitialized();
    const observation = validateChipObservation(input);
    const resident = this.stateStore.getResident('resident:metab');
    if (
      observation.coreId !== 'METAB' || observation.chipId !== 'resident:metab' ||
      observation.firstResidencyId !== 'resident:metab' ||
      observation.currentState !== 'SHADOW' || observation.mode !== 'SHADOW' ||
      observation.coreVersion !== METAB_HOMEOS_RESIDENT_CONTRACT.version ||
      observation.stateSchemaVersion !== String(METAB_HOMEOS_RESIDENT_CONTRACT.stateSchema) ||
      !resident || resident.status !== 'RUNNING' ||
      resident.version !== observation.coreVersion ||
      String(resident.stateSchema) !== observation.stateSchemaVersion ||
      String(resident.checkpointGeneration) !== observation.checkpointGeneration
    ) fail('METAB HOMEOS chip acceptance is not exact', 'P1_PRODUCTION_METAB_HOMEOS_CHIP');
    return this.legacy.appendChipObservation(observation);
  }

  appendInteroChip(input, { shadow = false } = {}) {
    this.assertInitialized();
    const observation = validateChipObservation(input);
    const contract = shadow ? INTERO_SHADOW_RESIDENT_CONTRACT : INTERO_NEUTRAL_RESIDENT_CONTRACT;
    const resident = this.stateStore.getResident('resident:intero');
    const expectedState = shadow ? 'SHADOW' : 'NEUTRAL';
    if (
      observation.coreId !== 'INTERO' || observation.chipId !== 'resident:intero' ||
      observation.firstResidencyId !== 'resident:intero' ||
      observation.currentState !== expectedState || observation.mode !== expectedState ||
      observation.coreVersion !== contract.version ||
      observation.stateSchemaVersion !== String(contract.stateSchema) ||
      !resident || resident.status !== 'RUNNING' ||
      resident.version !== observation.coreVersion ||
      String(resident.stateSchema) !== observation.stateSchemaVersion ||
      String(resident.checkpointGeneration) !== observation.checkpointGeneration ||
      (shadow && observation.coverageBand === 'NOT_APPLICABLE')
    ) fail('INTERO chip acceptance is not exact', 'P1_PRODUCTION_INTERO_CHIP');
    return this.legacy.appendChipObservation(observation);
  }

  appendMetabInteroChip(input) {
    this.assertInitialized();
    const observation = validateChipObservation(input);
    const resident = this.stateStore.getResident('resident:metab');
    if (
      observation.coreId !== 'METAB' || observation.chipId !== 'resident:metab' ||
      observation.firstResidencyId !== 'resident:metab' ||
      observation.currentState !== 'SHADOW' || observation.mode !== 'SHADOW' ||
      observation.coreVersion !== METAB_INTERO_RESIDENT_CONTRACT.version ||
      observation.stateSchemaVersion !== String(METAB_INTERO_RESIDENT_CONTRACT.stateSchema) ||
      !resident || resident.status !== 'RUNNING' ||
      resident.version !== observation.coreVersion ||
      String(resident.stateSchema) !== observation.stateSchemaVersion ||
      String(resident.checkpointGeneration) !== observation.checkpointGeneration
    ) fail('METAB INTERO chip acceptance is not exact', 'P1_PRODUCTION_METAB_INTERO_CHIP');
    return this.legacy.appendChipObservation(observation);
  }

  appendHomeosInteroChip(input) {
    this.assertInitialized();
    const observation = validateChipObservation(input);
    const resident = this.stateStore.getResident('resident:homeos');
    if (
      observation.coreId !== 'HOMEOS' || observation.chipId !== 'resident:homeos' ||
      observation.firstResidencyId !== 'resident:homeos' ||
      observation.currentState !== 'SHADOW' || observation.mode !== 'SHADOW' ||
      observation.coreVersion !== HOMEOS_INTERO_RESIDENT_CONTRACT.version ||
      observation.stateSchemaVersion !== String(HOMEOS_INTERO_RESIDENT_CONTRACT.stateSchema) ||
      !resident || resident.status !== 'RUNNING' ||
      resident.version !== observation.coreVersion ||
      String(resident.stateSchema) !== observation.stateSchemaVersion ||
      String(resident.checkpointGeneration) !== observation.checkpointGeneration
    ) fail('HOMEOS INTERO chip acceptance is not exact', 'P1_PRODUCTION_HOMEOS_INTERO_CHIP');
    return this.legacy.appendChipObservation(observation);
  }
}

module.exports = Object.freeze({
  EXPANSION_SCHEMA_NAME,
  EXPANSION_SCHEMA_VERSION,
  PRODUCTION_STORAGE_AUTHORIZATION,
  PRODUCTION_SCHEMA_NAME,
  P1ProductionPersistence,
  P1ProductionExpansionPersistence
});
