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

const EXPECTED = Object.freeze({
  sourceRelease:
    '/opt/stay/releases/0.8.11.3-p1m-r127-metab-final-fb27ce309f77',
  sourceRevision: 127,
  targetRevision: 128,
  sntss: Object.freeze({
    residencyId: 'resident:sntss', coreId: 'sntss',
    instanceId: '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
    version: '0.5.0-i4g1', minimumGeneration: 2449921
  }),
  chronobiology: Object.freeze({
    residencyId: 'resident:chronobiology', coreId: 'chronobiology',
    instanceId: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
    version: '1.0.0-c3rc.5', minimumGeneration: 10049
  }),
  fetus: Object.freeze({
    coreId: 'fetus-legacy', instanceId: '82202211-8dd6-44d4-a4ec-8f2553d8dc6f',
    version: '0.6.0', authorityEpoch: 1
  }),
  metabNeutral: Object.freeze({
    residencyId: 'resident:metab', coreId: 'METAB',
    instanceId: 'd424c722-ef31-44b0-8201-ba68c418d14a',
    version: '0.1.0-p1r0-neutral.1', stateSchema: 1,
    moduleRelativePath: 'cores/p1-r0/metab-neutral/index.js',
    checkpointHash:
      '4a16fc393b9846d1dd6f2f9849920053e3d2b5235c066dde3c5cd72699595107'
  }),
  metabShadow: Object.freeze({
    residencyId: 'resident:metab', coreId: 'METAB',
    instanceId: 'd424c722-ef31-44b0-8201-ba68c418d14a',
    version: '0.2.0-p1r0-shadow.1', stateSchema: 2,
    moduleRelativePath: 'cores/p1-r0/metab-shadow/index.js',
    moduleHash:
      'sha256:8b3e8f5c9ecb96192245831808c82be973692b304968ab0dd5023ee117442464',
    manifestHash:
      'sha256:06767143b3eae0760931d93029d4c905c7e811180e818f7236111629e0c1eb69',
    packagePolicyHash:
      'sha256:f698eb41b540aaf0d56695f4c09559787c9cda8d49b75793017dcb970df0ec0e'
  })
});

function fail(message, code = 'R128_METAB_PROOF') {
  throw Object.assign(new Error(message), { code });
}
function assert(value, message, code) { if (!value) fail(message, code); }
function hashBytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
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
    `metadata ${key} is absent or corrupt`, 'R128_METAB_PROOF_DATABASE');
  try { return JSON.parse(row.json); }
  catch { fail(`metadata ${key} is not JSON`, 'R128_METAB_PROOF_DATABASE'); }
}
function readCheckpointBlob(databasePath, checkpoint) {
  if (!checkpoint) return null;
  const file = path.join(path.dirname(databasePath), 'blobs', 'sha256',
    checkpoint.blob_hash.slice(0, 2), checkpoint.blob_hash);
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(),
    'METAB checkpoint blob type is unsafe', 'R128_METAB_PROOF_DATABASE');
  const bytes = fs.readFileSync(file);
  assert(bytes.length === Number(checkpoint.byte_length) &&
    hashBytes(bytes) === checkpoint.blob_hash,
  'METAB checkpoint blob is corrupt', 'R128_METAB_PROOF_DATABASE');
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { fail('METAB checkpoint blob is not JSON', 'R128_METAB_PROOF_DATABASE'); }
}

function captureDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { open: true, readOnly: true });
  try {
    database.exec('PRAGMA query_only=ON; BEGIN');
    const latestMetabCheckpoint = tableExists(database, 'resident_checkpoints')
      ? database.prepare(`SELECT * FROM resident_checkpoints
          WHERE residency_id='resident:metab' ORDER BY generation DESC LIMIT 1`).get()
      : null;
    const result = {
      format: 'stay-r128-metab-shadow-database-proof-v1',
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
      chips: rows(database, 'p1_chip_current', `SELECT chip_id, organism_id, core_id,
        history_sequence, history_head_hash, record_json, record_hash, observation_hash,
        semantic_hash FROM p1_chip_current ORDER BY chip_id`),
      metabCheckpoint: latestMetabCheckpoint || null,
      metabCheckpointState: readCheckpointBlob(databasePath, latestMetabCheckpoint),
      metabChipHistory: count(database, 'p1_chip_history', "chip_id='resident:metab'"),
      p1Authority: count(database, 'authority', "core_id IN ('METAB','HOMEOS','INTERO')"),
      sntssAuthority: count(database, 'authority', "core_id='sntss'"),
      chronobiologyAuthority: count(database, 'authority', "core_id='chronobiology'"),
      pendingDeliveries: count(database, 'biological_deliveries', "status='PENDING'"),
      failedDeliveries: count(database, 'biological_deliveries', "status='FAILED'"),
      abandonedDeliveries: count(database, 'biological_deliveries', "status='ABANDONED'"),
      pendingOutboxIntents: count(database, 'biological_outbox_intents', "status='PENDING'"),
      metabOutboxIntents: count(database, 'biological_outbox_intents', "producer_core_id='METAB'")
    };
    database.exec('COMMIT');
    return Object.freeze(result);
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { database.close(); }
}

function resident(capture, expected) {
  return capture.residents.find(value => value.residency_id === expected.residencyId);
}
function consumer(capture, id) {
  return capture.consumers.find(value => value.consumer_id === id);
}
function assertResident(row, expected, label) {
  assert(row?.core_id === expected.coreId && row.instance_id === expected.instanceId &&
    row.version === expected.version && row.status === 'RUNNING' &&
    Number(row.checkpoint_generation) >= Number(expected.minimumGeneration || 1) &&
    /^[0-9a-f]{64}$/.test(String(row.checkpoint_hash || '')),
  `${label} durable identity changed`, 'R128_METAB_PROOF_CONTINUITY');
}
function assertResources(status, label) {
  const value = status?.resident;
  const policy = value?.host?.resourceGovernor?.policy;
  const limits = value?.host?.osContainment?.limits;
  assert(value?.status === 'RUNNING' && value.running === true &&
    value.authorityOwned === false && value.host?.quarantined === false &&
    value.host?.osContainment?.required === true &&
    value.host?.osContainment?.available === true &&
    value.host?.osContainment?.payloadSandboxed === true &&
    value.host?.osContainment?.payloadAttachedBeforeInit === true &&
    value.host?.osContainment?.supervisorChargedToKernel === true &&
    policy?.softRamBytes === 64 * 1024 * 1024 &&
    policy?.hardRamBytes === 96 * 1024 * 1024 && policy?.hardCpuDuty === 0.2 &&
    policy?.queueCapacity === 256 && policy?.handlerTimeoutMs === 250 &&
    policy?.pidsMax === 16 && limits?.['memory.high'] === String(64 * 1024 * 1024) &&
    limits?.['memory.max'] === String(96 * 1024 * 1024) &&
    limits?.['pids.max'] === '16' && limits?.['cpu.max'] === '20000 100000',
  `${label} containment changed`, 'R128_METAB_PROOF_RESOURCES');
  return value;
}
function assertFetus(database, meta) {
  const authority = database.authorities.find(value => value.core_id === EXPECTED.fetus.coreId);
  const fetus = meta?.cores?.find(value => value.id === EXPECTED.fetus.coreId);
  assert(authority?.instance_id === EXPECTED.fetus.instanceId &&
    authority?.version === EXPECTED.fetus.version &&
    Number(authority?.epoch) === EXPECTED.fetus.authorityEpoch &&
    fetus?.version === EXPECTED.fetus.version && fetus?.ok === true &&
    fetus?.memoryGuardian?.status === 'healthy' &&
    fetus?.memoryGuardian?.warnAtMiB === 192 &&
    fetus?.memoryGuardian?.recycleAtMiB === 256,
  'fetus continuity changed', 'R128_METAB_PROOF_FETUS');
  return authority;
}
function assertSharedLive(database, { sntssStatus, chronobiologyStatus, meta }) {
  assertResident(resident(database, EXPECTED.sntss), EXPECTED.sntss, 'SNTSS');
  assertResident(resident(database, EXPECTED.chronobiology), EXPECTED.chronobiology,
    'Chronobiology');
  const sntss = assertResources(sntssStatus, 'SNTSS');
  const chrono = assertResources(chronobiologyStatus, 'Chronobiology');
  const chip = id => meta?.chipProjection?.lifecycle?.find(value => value.coreId === id);
  const bsf = meta?.systems?.find(value => value.id === 'bsf');
  assert(sntss.version === EXPECTED.sntss.version && sntss.observedOutputs === 0 &&
    sntss.health?.biologicalOutputs === 0 &&
    chrono.version === EXPECTED.chronobiology.version &&
    database.sntssAuthority === 0 && database.chronobiologyAuthority === 0 &&
    bsf?.mode === 'LIVE' && bsf?.status === 'RUNNING' && bsf?.healthOk === true &&
    chip('bsf')?.state === 'LIVE' && chip('sntss')?.state === 'SHADOW' &&
    chip('chronobiology')?.state === 'SHADOW',
  'shared resident or BSF continuity changed', 'R128_METAB_PROOF_CONTINUITY');
  return { sntss, chrono, chip };
}

function validateBefore({ database, freeze, sntssStatus, chronobiologyStatus, metabStatus,
  meta, service, currentRelease }) {
  const expected = EXPECTED.metabNeutral;
  const metab = resident(database, expected);
  const metabConsumer = consumer(database, expected.residencyId);
  assert(database.quickCheck === 'ok' && database.queryOnly === true &&
    database.runtimeRevision === EXPECTED.sourceRevision && database.pendingDeliveries === 0 &&
    database.pendingOutboxIntents === 0 && database.p1Authority === 0 &&
    database.metabOutboxIntents === 0 && currentRelease === EXPECTED.sourceRelease,
  'R127F database or release preflight failed', 'R128_METAB_PROOF_BEFORE');
  assert(validateRevisionFreeze(freeze, EXPECTED.sourceRevision),
    'R127F parent freeze is absent or corrupt', 'R128_METAB_PROOF_BEFORE');
  assert(metab?.instance_id === expected.instanceId && metab?.version === expected.version &&
    Number(metab?.state_schema) === expected.stateSchema &&
    metab?.module_relative_path === expected.moduleRelativePath &&
    metab?.checkpoint_hash === expected.checkpointHash &&
    Number(metab?.checkpoint_generation) === 2 && metab?.status === 'RUNNING' &&
    database.metabCheckpoint?.blob_hash === expected.checkpointHash &&
    database.metabCheckpointState?.engineState?.frameIndex === 0 &&
    database.metabCheckpointState?.engineState?.outputSequence === '0' &&
    metabConsumer?.core_id === 'METAB' && Number(metabConsumer?.active) === 1 &&
    Number(metabConsumer?.required) === 0 && Number(metabConsumer?.authority_epoch) === 0 &&
    metabConsumer?.topics_json === '["runtime.organism.binding"]' &&
    database.capacitySource === null,
  'R127F neutral METAB boundary changed', 'R128_METAB_PROOF_BEFORE');
  const metabLive = assertResources(metabStatus, 'METAB');
  const shared = assertSharedLive(database, { sntssStatus, chronobiologyStatus, meta });
  const fetus = assertFetus(database, meta);
  assert(metabLive.version === expected.version && metabLive.health?.mode === 'NEUTRAL' &&
    metabLive.observedOutputs === 0 && meta?.ok === true &&
    meta.revision === EXPECTED.sourceRevision && meta.revisionFrozen === true &&
    shared.chip('metab')?.state === 'NEUTRAL' && shared.chip('metab')?.born === true &&
    Number(service?.mainPid) > 0 && Number(service?.nRestarts) >= 0 &&
    service?.activeState === 'active' && service?.subState === 'running',
  'R127F live preflight failed', 'R128_METAB_PROOF_BEFORE');
  return Object.freeze({
    result: 'PASS', runtimeRevision: EXPECTED.sourceRevision,
    parentFreezeRecordSha256: freeze.recordSha256,
    sntssCheckpointGeneration: Number(resident(database, EXPECTED.sntss).checkpoint_generation),
    chronobiologyCheckpointGeneration:
      Number(resident(database, EXPECTED.chronobiology).checkpoint_generation),
    fetusCheckpointHash: fetus.checkpoint_hash,
    abandonedDeliveries: database.abandonedDeliveries,
    founder: database.metabCheckpointState.founder,
    metabChipHistory: database.metabChipHistory
  });
}

function validateAfter({ before, database, sntssStatus, chronobiologyStatus, metabStatus,
  meta, service, currentRelease, targetRelease }) {
  const expected = EXPECTED.metabShadow;
  const metab = resident(database, expected);
  const metabConsumer = consumer(database, expected.residencyId);
  const state = database.metabCheckpointState;
  const source = database.capacitySource;
  const cleanR128 = database.runtimeRevision === EXPECTED.targetRevision &&
    service?.restartCommands === 1;
  const recoveredR129 = database.runtimeRevision === EXPECTED.targetRevision + 1 &&
    service?.restartCommands === 2;
  assert(before?.result === 'PASS' && database.quickCheck === 'ok' && database.queryOnly === true &&
    (cleanR128 || recoveredR129) && database.pendingDeliveries === 0 &&
    database.pendingOutboxIntents === 0 && database.failedDeliveries === 0 &&
    database.abandonedDeliveries === before.abandonedDeliveries &&
    database.p1Authority === 0 && database.metabOutboxIntents === 0 &&
    currentRelease === targetRelease,
  'R128 database acceptance failed', 'R128_METAB_PROOF_AFTER');
  assert(metab?.instance_id === expected.instanceId && metab?.version === expected.version &&
    Number(metab?.state_schema) === expected.stateSchema &&
    metab?.module_relative_path === expected.moduleRelativePath &&
    metab?.module_hash === expected.moduleHash && metab?.manifest_hash === expected.manifestHash &&
    metab?.package_policy_hash === expected.packagePolicyHash && metab?.status === 'RUNNING' &&
    database.metabCheckpoint?.blob_hash === metab?.checkpoint_hash &&
    Number(database.metabCheckpoint?.generation) === Number(metab?.checkpoint_generation) &&
    stableStringify(state?.founder) === stableStringify(before.founder) &&
    state?.activation?.instanceId === expected.instanceId &&
    state?.activation?.runtimeRevision === EXPECTED.targetRevision &&
    state?.activation?.sourceCheckpointHash ===
      `sha256:${EXPECTED.metabNeutral.checkpointHash}` &&
    Number(state?.lastAcceptedFrame) >= 1 && state?.engineState?.outputSequence === '0' &&
    source?.protocol === 'stay-p1-r0-metab-capacity-source-v1' &&
    source?.instanceId === expected.instanceId && source?.residentVersion === expected.version &&
    source?.runtimeRevision === EXPECTED.targetRevision && source?.pending === null &&
    source?.lastCommittedFrame === state?.lastAcceptedFrame &&
    source?.lastCommittedFrame >= 1,
  'R128 METAB state or capacity-source continuity failed', 'R128_METAB_PROOF_AFTER');
  assert(metabConsumer?.core_id === 'METAB' && Number(metabConsumer?.active) === 1 &&
    Number(metabConsumer?.required) === 0 && Number(metabConsumer?.authority_epoch) === 0 &&
    metabConsumer?.topics_json ===
      '["resource.capacity.eligible.v1","resource.capacity.quality.v1","runtime.metab.shadow-activation","runtime.organism.binding"]' &&
    metabConsumer?.checkpoint_hash === metab?.checkpoint_hash,
  'R128 METAB consumer containment failed', 'R128_METAB_PROOF_AFTER');
  const founderRow = database.founders.find(value => value.core_id === 'METAB');
  const chipRow = database.chips.find(value => value.chip_id === 'resident:metab');
  const founder = validateFounderRecord(JSON.parse(founderRow?.record_json || 'null'));
  const chipRecord = validateChipRecord(JSON.parse(chipRow?.record_json || 'null'));
  assert(founderRow?.record_hash === recordHash(founder) &&
    founder.founderId === state.founder.founderId &&
    chipRow?.record_hash === recordHash(chipRecord) &&
    chipRecord.currentState === 'SHADOW' && chipRecord.mode === 'SHADOW' &&
    chipRecord.coreVersion === expected.version &&
    Number(chipRow.history_sequence) > Number(before.metabChipHistory),
  'R128 founder or chip custody failed', 'R128_METAB_PROOF_AFTER');
  assert(Number(resident(database, EXPECTED.sntss)?.checkpoint_generation) >=
    before.sntssCheckpointGeneration &&
    Number(resident(database, EXPECTED.chronobiology)?.checkpoint_generation) >=
    before.chronobiologyCheckpointGeneration,
  'existing resident checkpoint continuity rewound', 'R128_METAB_PROOF_CONTINUITY');
  const metabLive = assertResources(metabStatus, 'METAB');
  const shared = assertSharedLive(database, { sntssStatus, chronobiologyStatus, meta });
  const fetus = assertFetus(database, meta);
  assert(metabLive.version === expected.version && metabLive.health?.mode === 'SHADOW' &&
    metabLive.health?.outputPolicy === 'FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT' &&
    metabLive.declaredOutputs === 0 && metabLive.observedOutputs === 0 &&
    metabLive.health?.biologicalOutputs === 0 && meta?.ok === true &&
    meta.revision === database.runtimeRevision && meta.revisionFrozen === false &&
    shared.chip('metab')?.state === 'SHADOW' && shared.chip('metab')?.born === true &&
    fetus.instance_id === EXPECTED.fetus.instanceId &&
    Number(service?.beforePid) > 0 && Number(service?.afterPid) > 0 &&
    service.beforePid !== service.afterPid &&
    service.beforeRestarts === service.afterRestarts,
  'R128 live acceptance failed', 'R128_METAB_PROOF_AFTER');
  return Object.freeze({
    result: 'PASS', runtimeRevision: database.runtimeRevision,
    instanceId: expected.instanceId, version: expected.version,
    checkpointGeneration: Number(metab.checkpoint_generation),
    acceptedFrame: state.lastAcceptedFrame, authorityOwned: false,
    observedOutputs: 0, chipState: 'SHADOW',
    parentFreezeRecordSha256: before.parentFreezeRecordSha256,
    forwardRecovery: recoveredR129
  });
}

function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'capture' && argv.length === 2) {
    process.stdout.write(`${stableStringify(captureDatabase(argv[1]))}\n`);
    return;
  }
  fail('usage: p1-r128-metab-shadow-live-proof.js capture <database>',
    'R128_METAB_PROOF_USAGE');
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`${error.code || 'R128_METAB_PROOF'}: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ EXPECTED, captureDatabase, validateBefore, validateAfter });
