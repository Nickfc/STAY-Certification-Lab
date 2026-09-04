#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { stableStringify } = require('../../runtime/kernel/canonical-json');
const { validateRevisionFreeze } = require('../../runtime/revision-freeze');
const { recordHash, validateChipRecord, validateFounderRecord } = require(
  '../../runtime/p1-r0/records'
);
const { validateCapacitySourceState } = require('../../runtime/p1-r0/metab-capacity-source');

const EXPECTED = Object.freeze({
  sourceRelease: '/opt/stay/releases/0.8.11.3-p1m-r141-metab-shadow-recovery-6a1e6a9ffbfd',
  sourceRevision: 141,
  homeosRevision: 145,
  interoRevision: 150,
  instances: Object.freeze({
    sntss: '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
    chronobiology: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
    metab: 'd424c722-ef31-44b0-8201-ba68c418d14a',
    fetus: '82202211-8dd6-44d4-a4ec-8f2553d8dc6f'
  }),
  versions: Object.freeze({
    sntss: '0.5.0-i4g1',
    chronobiology: '1.0.0-c3rc.5',
    metabR141: '0.2.0-p1r0-shadow.1',
    metabR145: '0.3.0-p1r0-homeos-feed.1',
    metabR150: '0.4.0-p1r0-intero-feed.1',
    homeosR145: '0.2.0-p1r0-shadow.1',
    homeosR150: '0.3.0-p1r0-intero-feed.1',
    interoR150: '0.2.0-p1r0-shadow.1'
  })
});

function fail(message, code = 'R150_PHYSIOLOGY_PROOF') {
  throw Object.assign(new Error(message), { code });
}
function assert(value, message, code) { if (!value) fail(message, code); }
function hashBytes(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function tableExists(database, name) {
  return Boolean(database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name));
}
function rows(database, table, sql) {
  return tableExists(database, table) ? database.prepare(sql).all() : [];
}
function count(database, table, where = '1=1') {
  return tableExists(database, table)
    ? Number(database.prepare(`SELECT COUNT(*) AS value FROM ${table} WHERE ${where}`).get()?.value || 0)
    : 0;
}
function metadata(database, key, required = true) {
  const row = database.prepare('SELECT json, sha256 FROM metadata WHERE key=?').get(key);
  if (!row && !required) return null;
  assert(row && hashBytes(row.json) === row.sha256,
    `metadata ${key} is absent or corrupt`, 'R150_PHYSIOLOGY_DATABASE');
  try { return JSON.parse(row.json); }
  catch { fail(`metadata ${key} is not JSON`, 'R150_PHYSIOLOGY_DATABASE'); }
}
function readCheckpoint(database, databasePath, residencyId) {
  if (!tableExists(database, 'resident_checkpoints')) return null;
  const checkpoint = database.prepare(`SELECT generation, blob_hash, byte_length, input_cursor
    FROM resident_checkpoints WHERE residency_id=? ORDER BY generation DESC LIMIT 1`).get(residencyId);
  if (!checkpoint) return null;
  const file = path.join(path.dirname(databasePath), 'blobs', 'sha256',
    checkpoint.blob_hash.slice(0, 2), checkpoint.blob_hash);
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(),
    `${residencyId} checkpoint blob type is unsafe`, 'R150_PHYSIOLOGY_DATABASE');
  const bytes = fs.readFileSync(file);
  assert(bytes.length === Number(checkpoint.byte_length) && hashBytes(bytes) === checkpoint.blob_hash,
    `${residencyId} checkpoint blob is corrupt`, 'R150_PHYSIOLOGY_DATABASE');
  let state;
  try { state = JSON.parse(bytes.toString('utf8')); }
  catch { fail(`${residencyId} checkpoint blob is not JSON`, 'R150_PHYSIOLOGY_DATABASE'); }
  return Object.freeze({ ...checkpoint, state });
}

function captureDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { open: true, readOnly: true });
  try {
    database.exec('PRAGMA query_only=ON; BEGIN');
    const result = {
      format: 'stay-r150-homeos-intero-database-proof-v1',
      quickCheck: String(database.prepare('PRAGMA quick_check').get()?.quick_check || '').toLowerCase(),
      queryOnly: true,
      identity: metadata(database, 'life:identity'),
      runtimeRevision: Number(metadata(database, 'life:runtime-revision').revision),
      capacitySource: metadata(database, 'life:p1-r0-metab-capacity-source', false),
      schemas: rows(database, 'schema_versions',
        'SELECT name, version FROM schema_versions ORDER BY name'),
      residents: rows(database, 'resident_instances', `SELECT residency_id, core_id, role,
        instance_id, version, state_schema, module_relative_path, module_hash, manifest_hash,
        package_policy_hash, organism_identity_hash, checkpoint_hash, checkpoint_generation,
        status FROM resident_instances ORDER BY residency_id`),
      consumers: rows(database, 'biological_consumers', `SELECT consumer_id, core_id,
        required, active, topics_json, topics_sha256, cursor, authority_epoch, checkpoint_hash
        FROM biological_consumers ORDER BY consumer_id`),
      authorities: rows(database, 'authority',
        'SELECT core_id, instance_id, version, epoch, barrier_sequence, checkpoint_hash FROM authority ORDER BY core_id'),
      founders: rows(database, 'p1_founders', `SELECT organism_id, core_id, founder_id,
        lineage_id, record_json, record_hash FROM p1_founders ORDER BY organism_id, core_id`),
      dossiersV2: rows(database, 'p1_birth_dossiers_v2', `SELECT residency_id, organism_id,
        core_id, target_revision, certificate_id, dossier_json, dossier_hash
        FROM p1_birth_dossiers_v2 ORDER BY residency_id`),
      chips: rows(database, 'p1_chip_current', `SELECT chip_id, organism_id, core_id,
        history_sequence, history_head_hash, record_json, record_hash, observation_hash,
        semantic_hash FROM p1_chip_current ORDER BY chip_id`),
      checkpoints: Object.freeze({
        metab: readCheckpoint(database, databasePath, 'resident:metab'),
        homeos: readCheckpoint(database, databasePath, 'resident:homeos'),
        intero: readCheckpoint(database, databasePath, 'resident:intero')
      }),
      chipHistory: Object.freeze({
        metab: count(database, 'p1_chip_history', "chip_id='resident:metab'"),
        homeos: count(database, 'p1_chip_history', "chip_id='resident:homeos'"),
        intero: count(database, 'p1_chip_history', "chip_id='resident:intero'")
      }),
      pendingDeliveries: count(database, 'biological_deliveries', "status='PENDING'"),
      failedDeliveries: count(database, 'biological_deliveries', "status='FAILED'"),
      abandonedDeliveries: count(database, 'biological_deliveries', "status='ABANDONED'"),
      pendingOutboxIntents: count(database, 'biological_outbox_intents', "status='PENDING'"),
      p1Authority: count(database, 'authority',
        "core_id IN ('sntss','chronobiology','METAB','HOMEOS','INTERO')"),
      outputs: Object.freeze({
        sntss: count(database, 'biological_outbox_intents', "producer_core_id='sntss'"),
        metab: count(database, 'biological_outbox_intents', "producer_core_id='METAB'"),
        homeos: count(database, 'biological_outbox_intents', "producer_core_id='HOMEOS'"),
        intero: count(database, 'biological_outbox_intents', "producer_core_id='INTERO'")
      }),
      metabImplementationRepair: tableExists(database, 'recovery_records')
        ? database.prepare(`SELECT id, detail_json, created_at FROM recovery_records
            WHERE type='resident.implementation-repaired' AND core_id='METAB'
            ORDER BY id DESC LIMIT 1`).get() || null
        : null
    };
    database.exec('COMMIT');
    return Object.freeze(result);
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { database.close(); }
}

function resident(database, id) {
  return database.residents.find(value => value.residency_id === `resident:${id}`);
}
function consumer(database, id) {
  return database.consumers.find(value => value.consumer_id === `resident:${id}`);
}
function chip(meta, id) {
  return meta?.chipProjection?.lifecycle?.find(value => value.coreId === id);
}
function status(statuses, id) { return statuses?.[id]?.resident; }
function instanceIdForCertificate(certificateId) {
  const digest = crypto.createHash('sha256').update(certificateId).digest();
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20)].join('-');
}
function assertContained(statuses, id, { version, mode, zeroOutputs = false } = {}) {
  const value = status(statuses, id);
  const policy = value?.host?.resourceGovernor?.policy;
  const limits = value?.host?.osContainment?.limits;
  assert(value?.status === 'RUNNING' && value.running === true && value.version === version &&
    value.health?.ok === true && value.authorityOwned === false &&
    (mode === undefined || value.health?.mode === mode) && value.host?.quarantined === false &&
    value.host?.osContainment?.required === true && value.host?.osContainment?.available === true &&
    value.host?.osContainment?.payloadSandboxed === true &&
    value.host?.osContainment?.payloadAttachedBeforeInit === true &&
    value.host?.osContainment?.supervisorChargedToKernel === true &&
    policy?.softRamBytes === 67108864 && policy?.hardRamBytes === 100663296 &&
    policy?.hardCpuDuty === 0.2 && policy?.handlerTimeoutMs === 250 && policy?.pidsMax === 16 &&
    limits?.['memory.high'] === '67108864' && limits?.['memory.max'] === '100663296' &&
    limits?.['cpu.max'] === '20000 100000' && limits?.['pids.max'] === '16' &&
    (!zeroOutputs || (value.observedOutputs === 0 && value.health?.biologicalOutputs === 0)),
  `${id} is not running inside the unchanged containment contract`, 'R150_PHYSIOLOGY_CONTAINMENT');
  return value;
}
function assertCommon({ database, statuses, meta }) {
  assert(database.quickCheck === 'ok' && database.queryOnly === true &&
    database.pendingDeliveries === 0 && database.failedDeliveries === 0 &&
    database.pendingOutboxIntents === 0 && database.p1Authority === 0 &&
    database.outputs.sntss === 0 && database.outputs.intero === 0 &&
    meta?.ok === true && chip(meta, 'bsf')?.state === 'LIVE' &&
    chip(meta, 'sntss')?.state === 'SHADOW' && chip(meta, 'chronobiology')?.state === 'SHADOW',
  'database, BSF, or chip containment is not clean', 'R150_PHYSIOLOGY_COMMON');
  const sntss = assertContained(statuses, 'sntss', {
    version: EXPECTED.versions.sntss, zeroOutputs: true
  });
  const chrono = assertContained(statuses, 'chronobiology', {
    version: EXPECTED.versions.chronobiology, mode: 'NEUTRAL'
  });
  assert(resident(database, 'sntss')?.instance_id === EXPECTED.instances.sntss &&
    resident(database, 'chronobiology')?.instance_id === EXPECTED.instances.chronobiology,
  'existing resident identities changed', 'R150_PHYSIOLOGY_CONTINUITY');
  const fetus = meta?.cores?.find(value => value.id === 'fetus-legacy');
  const fetusAuthority = database.authorities.find(value => value.core_id === 'fetus-legacy');
  assert(fetus?.ok === true && fetus?.version === '0.6.0' &&
    fetus?.memoryGuardian?.status === 'healthy' && fetus?.memoryGuardian?.warnAtMiB === 192 &&
    fetus?.memoryGuardian?.recycleAtMiB === 256 &&
    fetusAuthority?.instance_id === EXPECTED.instances.fetus && fetusAuthority?.version === '0.6.0',
  'fetus continuity changed', 'R150_PHYSIOLOGY_FETUS');
  return { sntss, chrono, fetusAuthority };
}
function assertPersistentOrigin(database, id, expectedRevision) {
  const coreId = id.toUpperCase();
  const founderRow = database.founders.find(value => value.core_id === coreId);
  const dossierRow = database.dossiersV2.find(value => value.residency_id === `resident:${id}`);
  const chipRow = database.chips.find(value => value.chip_id === `resident:${id}`);
  const founderRecord = validateFounderRecord(JSON.parse(founderRow?.record_json || 'null'));
  const dossier = JSON.parse(dossierRow?.dossier_json || 'null');
  const chipRecord = validateChipRecord(JSON.parse(chipRow?.record_json || 'null'));
  assert(founderRow?.record_hash === recordHash(founderRecord) &&
    dossier?.recordVersion === 'P1NeutralBirthDossierV2' &&
    dossier?.residencyId === `resident:${id}` && dossier?.coreId === coreId &&
    dossier?.targetRevision === expectedRevision && dossierRow?.dossier_hash === recordHash(dossier) &&
    chipRow?.record_hash === recordHash(chipRecord) && chipRecord.firstResidencyId === `resident:${id}`,
  `${id} persistent origin is incomplete`, 'R150_PHYSIOLOGY_ORIGIN');
  return { founderRecord, dossier, chipRecord };
}

function transitionServiceIsValid(service, before, targetRelease) {
  if (!service?.recovery) {
    return service?.beforePid === before.servicePid && Number(service?.afterPid) > 0 &&
      service.afterPid !== service.beforePid && service?.beforeRestarts === service?.afterRestarts &&
      service?.restartCommands === 1 && targetRelease === service?.currentRelease;
  }
  const recoveryCommands = Number(service.recoveryRestartCommands);
  return service.originalBeforePid === before.servicePid && Number(service.afterPid) > 0 &&
    [0, 1].includes(recoveryCommands) && service.restartCommands === 1 + recoveryCommands &&
    (recoveryCommands === 0
      ? service.afterPid === service.recoveryBeforePid
      : service.afterPid !== service.recoveryBeforePid) &&
    service.originalBeforeRestarts === before.serviceRestarts &&
    service.recoveryBeforeRestarts === service.afterRestarts &&
    targetRelease === service.currentRelease;
}

function validateR141Before({ database, statuses, meta, freeze, service, currentRelease }) {
  const common = assertCommon({ database, statuses, meta });
  const metab = resident(database, 'metab');
  const metabStatus = assertContained(statuses, 'metab', {
    version: EXPECTED.versions.metabR141, mode: 'SHADOW', zeroOutputs: true
  });
  assert(currentRelease === EXPECTED.sourceRelease && database.runtimeRevision === 141 &&
    validateRevisionFreeze(freeze, 141) && meta.revision === 141 && meta.revisionFrozen === true &&
    freeze.release?.path === EXPECTED.sourceRelease &&
    metab?.instance_id === EXPECTED.instances.metab && Number(metab?.state_schema) === 2 &&
    metab?.module_relative_path === 'cores/p1-r0/metab-shadow/index.js' &&
    metabStatus.health?.outputPolicy === 'FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT' &&
    !resident(database, 'homeos') && !resident(database, 'intero') &&
    !database.founders.some(value => ['HOMEOS', 'INTERO'].includes(value.core_id)) &&
    chip(meta, 'metab')?.state === 'SHADOW' &&
    meta.chipProjection?.roadmap?.some(value => value.coreId === 'homeos') &&
    meta.chipProjection?.roadmap?.some(value => value.coreId === 'intero') &&
    Number(service?.pid) > 0 && Number.isSafeInteger(Number(service?.restarts)),
  'R141F production boundary is not exact', 'R150_PHYSIOLOGY_R141');
  return Object.freeze({
    result: 'PASS', revision: 141, parentFreezeRecordSha256: freeze.recordSha256,
    servicePid: Number(service.pid), serviceRestarts: Number(service.restarts),
    abandonedDeliveries: database.abandonedDeliveries,
    checkpoints: Object.freeze({
      sntss: Number(resident(database, 'sntss').checkpoint_generation),
      chronobiology: Number(resident(database, 'chronobiology').checkpoint_generation),
      metab: Number(metab.checkpoint_generation)
    }),
    fetusCheckpointHash: common.fetusAuthority.checkpoint_hash,
    metabChipHistory: database.chipHistory.metab
  });
}

function validateHomeosAfter({ before, database, statuses, meta, service, targetRelease }, expectedRevision) {
  assert(before?.result === 'PASS' && before.revision === 141,
    'R145 before evidence is invalid', 'R150_PHYSIOLOGY_R145');
  assertCommon({ database, statuses, meta });
  const metab = resident(database, 'metab');
  const homeos = resident(database, 'homeos');
  const metabStatus = assertContained(statuses, 'metab', {
    version: EXPECTED.versions.metabR145, mode: 'SHADOW'
  });
  const homeosStatus = assertContained(statuses, 'homeos', {
    version: EXPECTED.versions.homeosR145, mode: 'SHADOW', zeroOutputs: true
  });
  const origin = assertPersistentOrigin(database, 'homeos', 143);
  const source = validateCapacitySourceState(database.capacitySource, {
    instanceId: EXPECTED.instances.metab, residentVersion: EXPECTED.versions.metabR145
  });
  let repair = null;
  try { repair = JSON.parse(database.metabImplementationRepair?.detail_json || 'null'); } catch {}
  const exactR146Repair = expectedRevision !== 146 || (
    repair?.repairId === 'metab-q48-saturating-lifetime-r146-v1' &&
    repair?.fromCheckpointGeneration === 196024 &&
    repair?.toCheckpointGeneration === 196025 &&
    repair?.acceptedFrame === 98001 && repair?.discardedPartialFrame === 98002 &&
    repair?.biologicalAcceptedStateChanged === false && repair?.abandonedCount === 0 &&
    repair?.inventedBiologicalTime === false && repair?.authorityChanged === false &&
    repair?.resourceLimitsChanged === false
  );
  assert(database.runtimeRevision === expectedRevision && meta.revision === expectedRevision && meta.revisionFrozen === false &&
    metab?.instance_id === EXPECTED.instances.metab && Number(metab?.state_schema) === 3 &&
    metab?.module_relative_path === 'cores/p1-r0/metab-homeos/index.js' &&
    homeos?.instance_id === instanceIdForCertificate(origin.dossier.certificateId) &&
    Number(homeos?.state_schema) === 2 && homeos?.module_relative_path === 'cores/p1-r0/homeos-shadow/index.js' &&
    metabStatus.health?.outputPolicy === 'HOMEOS_ONLY_SHADOW_SUMMARIES' &&
    homeosStatus.health?.outputPolicy === 'FORBIDDEN_UNTIL_INTERO_ATTACHMENT' &&
    source.pending === null &&
    source.lastCommittedFrame === database.checkpoints.metab?.state?.sourceState?.lastAcceptedFrame &&
    database.checkpoints.homeos?.state?.activation?.targetRevision === 145 &&
    database.checkpoints.homeos?.state?.neutralState?.engineState?.outputSequence === '0' &&
    consumer(database, 'homeos')?.active === 1 && Number(consumer(database, 'homeos')?.authority_epoch) === 0 &&
    chip(meta, 'homeos')?.state === 'SHADOW' && chip(meta, 'metab')?.state === 'SHADOW' &&
    !meta.chipProjection?.roadmap?.some(value => value.coreId === 'homeos') &&
    meta.chipProjection?.roadmap?.some(value => value.coreId === 'intero') &&
    database.chipHistory.homeos >= 2 && database.chipHistory.metab > before.metabChipHistory &&
    Number(resident(database, 'sntss').checkpoint_generation) >= before.checkpoints.sntss &&
    Number(resident(database, 'chronobiology').checkpoint_generation) >= before.checkpoints.chronobiology &&
    Number(metab.checkpoint_generation) >= before.checkpoints.metab &&
    database.abandonedDeliveries === before.abandonedDeliveries &&
    exactR146Repair &&
    transitionServiceIsValid(service, before, targetRelease),
  'R145 HOMEOS acceptance is incomplete', 'R150_PHYSIOLOGY_R145');
  return Object.freeze({
    result: 'PASS', revision: expectedRevision, homeosInstanceId: homeos.instance_id,
    homeosFounderId: origin.founderRecord.founderId,
    parentFreezeRecordSha256: before.parentFreezeRecordSha256,
    servicePid: Number(service.afterPid), serviceRestarts: Number(service.afterRestarts),
    abandonedDeliveries: database.abandonedDeliveries,
    checkpoints: Object.freeze({
      sntss: Number(resident(database, 'sntss').checkpoint_generation),
      chronobiology: Number(resident(database, 'chronobiology').checkpoint_generation),
      metab: Number(metab.checkpoint_generation), homeos: Number(homeos.checkpoint_generation)
    }),
    chipHistory: database.chipHistory
  });
}

function validateR145After(args) { return validateHomeosAfter(args, 145); }
function validateR146After(args) { return validateHomeosAfter(args, 146); }
function validateR147After(args) { return validateHomeosAfter(args, 147); }

function validateR145Current({ database, statuses, meta, freeze, service, currentRelease }) {
  assertCommon({ database, statuses, meta });
  const metab = resident(database, 'metab');
  const homeos = resident(database, 'homeos');
  const metabStatus = assertContained(statuses, 'metab', {
    version: EXPECTED.versions.metabR145, mode: 'SHADOW'
  });
  const homeosStatus = assertContained(statuses, 'homeos', {
    version: EXPECTED.versions.homeosR145, mode: 'SHADOW', zeroOutputs: true
  });
  const origin = assertPersistentOrigin(database, 'homeos', 143);
  const source = validateCapacitySourceState(database.capacitySource, {
    instanceId: EXPECTED.instances.metab, residentVersion: EXPECTED.versions.metabR145
  });
  assert(database.runtimeRevision === 145 && validateRevisionFreeze(freeze, 145) &&
    meta.revision === 145 && meta.revisionFrozen === true &&
    metab?.instance_id === EXPECTED.instances.metab && Number(metab?.state_schema) === 3 &&
    metab?.module_relative_path === 'cores/p1-r0/metab-homeos/index.js' &&
    homeos?.instance_id === instanceIdForCertificate(origin.dossier.certificateId) &&
    Number(homeos?.state_schema) === 2 && homeos?.module_relative_path === 'cores/p1-r0/homeos-shadow/index.js' &&
    metabStatus.health?.outputPolicy === 'HOMEOS_ONLY_SHADOW_SUMMARIES' &&
    homeosStatus.health?.outputPolicy === 'FORBIDDEN_UNTIL_INTERO_ATTACHMENT' &&
    source.pending === null &&
    source.lastCommittedFrame === database.checkpoints.metab?.state?.sourceState?.lastAcceptedFrame &&
    database.checkpoints.homeos?.state?.activation?.targetRevision === 145 &&
    chip(meta, 'metab')?.state === 'SHADOW' && chip(meta, 'homeos')?.state === 'SHADOW' &&
    meta.chipProjection?.roadmap?.some(value => value.coreId === 'intero') &&
    !resident(database, 'intero') && Number(service?.pid) > 0 &&
    Number.isSafeInteger(Number(service?.restarts)) && currentRelease === service?.currentRelease,
  'R145F current boundary is not exact', 'R150_PHYSIOLOGY_R145_CURRENT');
  return Object.freeze({
    result: 'PASS', revision: 145, parentFreezeRecordSha256: freeze.recordSha256,
    homeosInstanceId: homeos.instance_id, homeosFounderId: origin.founderRecord.founderId,
    servicePid: Number(service.pid), serviceRestarts: Number(service.restarts),
    abandonedDeliveries: database.abandonedDeliveries,
    checkpoints: Object.freeze({
      sntss: Number(resident(database, 'sntss').checkpoint_generation),
      chronobiology: Number(resident(database, 'chronobiology').checkpoint_generation),
      metab: Number(metab.checkpoint_generation), homeos: Number(homeos.checkpoint_generation)
    }),
    chipHistory: database.chipHistory
  });
}

function validateR150After({ before, database, statuses, meta, service, targetRelease }) {
  assert(before?.result === 'PASS' && before.revision === 145,
    'R150 before evidence is invalid', 'R150_PHYSIOLOGY_R150');
  assertCommon({ database, statuses, meta });
  const metab = resident(database, 'metab');
  const homeos = resident(database, 'homeos');
  const intero = resident(database, 'intero');
  const metabStatus = assertContained(statuses, 'metab', {
    version: EXPECTED.versions.metabR150, mode: 'SHADOW'
  });
  const homeosStatus = assertContained(statuses, 'homeos', {
    version: EXPECTED.versions.homeosR150, mode: 'SHADOW'
  });
  const interoStatus = assertContained(statuses, 'intero', {
    version: EXPECTED.versions.interoR150, mode: 'SHADOW', zeroOutputs: true
  });
  const homeosOrigin = assertPersistentOrigin(database, 'homeos', 143);
  const interoOrigin = assertPersistentOrigin(database, 'intero', 147);
  const source = validateCapacitySourceState(database.capacitySource, {
    instanceId: EXPECTED.instances.metab, residentVersion: EXPECTED.versions.metabR150
  });
  assert(database.runtimeRevision === 150 && meta.revision === 150 && meta.revisionFrozen === false &&
    metab?.instance_id === EXPECTED.instances.metab && Number(metab?.state_schema) === 4 &&
    metab?.module_relative_path === 'cores/p1-r0/metab-intero/index.js' &&
    homeos?.instance_id === before.homeosInstanceId && Number(homeos?.state_schema) === 3 &&
    homeos?.module_relative_path === 'cores/p1-r0/homeos-intero/index.js' &&
    intero?.instance_id === instanceIdForCertificate(interoOrigin.dossier.certificateId) &&
    Number(intero?.state_schema) === 2 && intero?.module_relative_path === 'cores/p1-r0/intero-shadow/index.js' &&
    homeosOrigin.founderRecord.founderId === before.homeosFounderId &&
    metabStatus.health?.outputPolicy === 'HOMEOS_AND_INTERO_SHADOW_SUMMARIES' &&
    homeosStatus.health?.outputPolicy === 'INTERO_STABILITY_ONLY_SHADOW_SUMMARY' &&
    interoStatus.health?.outputPolicy === 'PERCEPTION_ONLY_NO_OUTPUT' &&
    interoStatus.health?.receptorRoute === 'ABSENT' && interoStatus.health?.projectionAvailable === true &&
    source.pending === null &&
    source.lastCommittedFrame === database.checkpoints.metab?.state?.homeosFeedState?.sourceState?.lastAcceptedFrame &&
    database.checkpoints.intero?.state?.activation?.targetRevision === 150 &&
    database.checkpoints.intero?.state?.engineState?.outputSequence === '0' &&
    consumer(database, 'intero')?.active === 1 && Number(consumer(database, 'intero')?.authority_epoch) === 0 &&
    chip(meta, 'metab')?.state === 'SHADOW' && chip(meta, 'homeos')?.state === 'SHADOW' &&
    chip(meta, 'intero')?.state === 'SHADOW' &&
    !meta.chipProjection?.roadmap?.some(value => ['homeos', 'intero'].includes(value.coreId)) &&
    database.chipHistory.homeos > before.chipHistory.homeos &&
    database.chipHistory.metab > before.chipHistory.metab && database.chipHistory.intero >= 2 &&
    Number(resident(database, 'sntss').checkpoint_generation) >= before.checkpoints.sntss &&
    Number(resident(database, 'chronobiology').checkpoint_generation) >= before.checkpoints.chronobiology &&
    Number(metab.checkpoint_generation) >= before.checkpoints.metab &&
    Number(homeos.checkpoint_generation) >= before.checkpoints.homeos &&
    database.abandonedDeliveries === before.abandonedDeliveries &&
    transitionServiceIsValid(service, before, targetRelease),
  'R150 INTERO acceptance is incomplete', 'R150_PHYSIOLOGY_R150');
  return Object.freeze({
    result: 'PASS', revision: 150, homeosInstanceId: homeos.instance_id,
    interoInstanceId: intero.instance_id, interoFounderId: interoOrigin.founderRecord.founderId,
    servicePid: Number(service.afterPid), serviceRestarts: Number(service.afterRestarts),
    abandonedDeliveries: database.abandonedDeliveries,
    checkpoints: Object.freeze({
      sntss: Number(resident(database, 'sntss').checkpoint_generation),
      chronobiology: Number(resident(database, 'chronobiology').checkpoint_generation),
      metab: Number(metab.checkpoint_generation), homeos: Number(homeos.checkpoint_generation),
      intero: Number(intero.checkpoint_generation)
    }),
    chipHistory: database.chipHistory
  });
}

function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'capture' && argv.length === 2) {
    process.stdout.write(`${stableStringify(captureDatabase(argv[1]))}\n`);
    return;
  }
  fail('usage: p1-r150-homeos-intero-live-proof.js capture <database>',
    'R150_PHYSIOLOGY_USAGE');
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`${error.code || 'R150_PHYSIOLOGY_PROOF'}: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  EXPECTED, captureDatabase, validateR141Before, validateR145After, validateR146After,
  validateR147After,
  validateR145Current, validateR150After
});
