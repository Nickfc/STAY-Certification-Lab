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
const { normalizeNeutralFounder } = require('./residents/metab-neutral');

const PRODUCTION_STORAGE_AUTHORIZATION =
  'P1_R0_PRODUCTION_STORAGE_R124_NEUTRAL_V1';
const PRODUCTION_SCHEMA_NAME =
  'p1-r0-production';
const METAB_NEUTRAL_AUTHORIZATION_CLASS =
  'metab-resident-neutral-zero-authority-r124';
const HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;

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
}

module.exports = Object.freeze({
  PRODUCTION_STORAGE_AUTHORIZATION,
  PRODUCTION_SCHEMA_NAME,
  P1ProductionPersistence
});
