#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { stableStringify } = require('../../runtime/kernel/canonical-json');
const { validateRevisionFreeze } = require('../../runtime/revision-freeze');
const { recordHash, validateFounderRecord, validateChipRecord } = require(
  '../../runtime/p1-r0/records'
);

const EXPECTED = Object.freeze({
  sourceRelease: '/opt/stay/releases/0.8.11.3-p1m-r119f-chrono-repair-2961f9a48173',
  sourceRevision: 123,
  sourceFreezeRecordSha256:
    'sha256:161b5fe340ef01836447e21c0e77167cac86033973f8a06b3c1af1d7b44fa3cc',
  benchmark: Object.freeze({
    samples: 4312,
    samplesSha256: '47b7b60e91e853fcd1a4c9cf8a5242d8af65bd403e47fe8a45d4dbcf19311136',
    stateSha256: '700f3736ff92f13bbbcfc1427e324160cc7cbc4a48d1de4474c103c67a51ee89',
    attemptsSha256: 'ea418fd91a72bccf4ea4714cf7ba9e595520b97e4e8fd99adfb2b1d581feddd1',
    milestoneSha256: '4d2116da14a18d92f710815d64b23f08e2b48d81acc46c0de8a727390d76961f',
    adjudicationSha256: 'a78cd8281d246d851e3476f8da50964bc7e9556a8760439099dd727ecadfc6e4',
    witnessSha256: '80c383e7b9b15c3da64b29e14d2ca4800d8ad64f19b63dd44ec401afa8564cfc'
  }),
  sntss: Object.freeze({
    residencyId: 'resident:sntss',
    coreId: 'sntss',
    instanceId: '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
    version: '0.5.0-i4g1'
  }),
  chronobiology: Object.freeze({
    residencyId: 'resident:chronobiology',
    coreId: 'chronobiology',
    instanceId: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
    version: '1.0.0-c3rc.5'
  }),
  metab: Object.freeze({
    residencyId: 'resident:metab',
    coreId: 'METAB',
    version: '0.1.0-p1r0-neutral.1',
    stateSchema: 1,
    moduleRelativePath: 'cores/p1-r0/metab-neutral/index.js',
    moduleHash: 'sha256:5359d9c9fc29c64d740232395a6a0b4ec04da63251a5f2575f522b7a27367f48',
    manifestHash: 'sha256:1e666f19de089c352dd3f8a754b6242a90ded3ef518974f5528c345ff25e702a',
    packagePolicyHash: 'sha256:7481afb6f46e9baa1e53c9dfdd8d8f7a0776cde9af45f7989a52dd32c12be1bb'
  })
});

function fail(message, code = 'R124_METAB_PROOF') {
  throw Object.assign(new Error(message), { code });
}
function assert(value, message, code) { if (!value) fail(message, code); }
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`${label} is invalid: ${error.message}`, 'R124_METAB_PROOF_INPUT'); }
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
function metadata(database, key) {
  const row = database.prepare('SELECT json, sha256 FROM metadata WHERE key=?').get(key);
  assert(row && crypto.createHash('sha256').update(row.json).digest('hex') === row.sha256,
    `metadata ${key} is absent or corrupt`, 'R124_METAB_PROOF_DATABASE');
  return JSON.parse(row.json);
}

function captureDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { open: true, readOnly: true });
  try {
    database.exec('PRAGMA query_only=ON');
    const quickCheck = String(database.prepare('PRAGMA quick_check').get()?.quick_check || '');
    const residents = rows(database, 'resident_instances', `
      SELECT residency_id, core_id, role, instance_id, version, state_schema,
             module_relative_path, module_hash, manifest_hash, package_policy_hash,
             organism_identity_hash, checkpoint_hash, checkpoint_generation, status
        FROM resident_instances ORDER BY residency_id`);
    const consumers = rows(database, 'biological_consumers', `
      SELECT consumer_id, core_id, required, active, topics_json, topics_sha256,
             cursor, authority_epoch, checkpoint_hash
        FROM biological_consumers ORDER BY consumer_id`);
    const founders = rows(database, 'p1_founders', `
      SELECT organism_id, core_id, founder_id, lineage_id, record_json, record_hash
        FROM p1_founders ORDER BY organism_id, core_id`);
    const dossiers = rows(database, 'p1_birth_dossiers', `
      SELECT residency_id, organism_id, core_id, target_revision, certificate_id,
             dossier_json, dossier_hash FROM p1_birth_dossiers ORDER BY residency_id`);
    const chips = rows(database, 'p1_chip_current', `
      SELECT chip_id, organism_id, core_id, history_sequence, history_head_hash,
             record_json, record_hash, observation_hash, semantic_hash
        FROM p1_chip_current ORDER BY chip_id`);
    return Object.freeze({
      format: 'stay-r124-metab-neutral-database-proof-v1',
      quickCheck: quickCheck.toLowerCase(),
      queryOnly: true,
      identity: metadata(database, 'life:identity'),
      runtimeRevision: Number(metadata(database, 'life:runtime-revision').revision),
      schemas: rows(database, 'schema_versions',
        'SELECT name, version FROM schema_versions ORDER BY name'),
      residents,
      consumers,
      founders,
      dossiers,
      chips,
      metabCheckpoints: count(database, 'resident_checkpoints',
        "residency_id='resident:metab'"),
      metabChipHistory: count(database, 'p1_chip_history',
        "chip_id='resident:metab'"),
      p1Authority: count(database, 'authority',
        "core_id IN ('METAB','HOMEOS','INTERO')"),
      sntssAuthority: count(database, 'authority', "core_id='sntss'"),
      chronobiologyAuthority: count(database, 'authority', "core_id='chronobiology'"),
      pendingDeliveries: count(database, 'biological_deliveries', "status='PENDING'"),
      pendingOutboxIntents: count(database, 'biological_outbox_intents', "status='PENDING'")
    });
  } finally { database.close(); }
}

function validateBenchmark({ samplesFile, stateFile, attemptsFile, milestoneFile,
  adjudicationFile, witnessFile }) {
  const expected = EXPECTED.benchmark;
  for (const [file, digest, label] of [
    [samplesFile, expected.samplesSha256, 'samples'],
    [stateFile, expected.stateSha256, 'state'],
    [attemptsFile, expected.attemptsSha256, 'attempts'],
    [milestoneFile, expected.milestoneSha256, 'milestone'],
    [adjudicationFile, expected.adjudicationSha256, 'adjudication'],
    [witnessFile, expected.witnessSha256, 'witness']
  ]) assert(sha256File(file) === digest, `${label} evidence hash changed`, 'R124_METAB_PROOF_BENCHMARK');
  const state = readJson(stateFile, 'benchmark state');
  const attempts = readJson(attemptsFile, 'benchmark attempts');
  const milestone = readJson(milestoneFile, 'benchmark milestone');
  const adjudication = readJson(adjudicationFile, 'benchmark adjudication');
  const witness = readJson(witnessFile, 'benchmark witness');
  assert(
    state.format === 'stay-physiology-benchmark-state-v3' &&
    state.runtimeRevision === 123 && state.samples === expected.samples &&
    state.collectorStarts === 1 && state.collectorRestarts === 0 &&
    attempts.format === 'stay-physiology-benchmark-collector-attempts-v1' &&
    attempts.attempts === 1 &&
    milestone.format === 'stay-physiology-benchmark-milestone-v3' &&
    milestone.milestone === '72h' && milestone.samples === expected.samples &&
    adjudication.format === 'stay-physiology-benchmark-adjudication-v4' &&
    adjudication.result === 'PASS' && adjudication.productionMutated === false &&
    adjudication.v4?.observedFailureCount === 0 &&
    adjudication.v4?.hardObservationFailureCount === 0 &&
    adjudication.v4?.evidenceIncompleteCount === 0 &&
    witness.format === 'stay-physiology-benchmark-outbox-witness-v1' &&
    witness.queryOnly === true && witness.productionMutated === false,
    'R123F benchmark closure is not exact', 'R124_METAB_PROOF_BENCHMARK'
  );
  return Object.freeze({ result: 'PASS', samples: expected.samples });
}

function residentRow(capture, expected) {
  return capture.residents.find(value => value.residency_id === expected.residencyId);
}
function assertExistingResident(row, expected, label) {
  assert(row?.core_id === expected.coreId && row.instance_id === expected.instanceId &&
    row.version === expected.version && row.status === 'RUNNING' &&
    Number(row.checkpoint_generation) > 0 && /^[0-9a-f]{64}$/.test(row.checkpoint_hash),
  `${label} durable identity is not exact`, 'R124_METAB_PROOF_CONTINUITY');
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
    limits?.['memory.max'] === String(96 * 1024 * 1024) && limits?.['pids.max'] === '16' &&
    limits?.['cpu.max'] === '20000 100000',
  `${label} containment changed`, 'R124_METAB_PROOF_RESOURCES');
  return value;
}

function validateBefore({ database, freeze, sntssStatus, chronobiologyStatus, meta, service }) {
  assert(database.quickCheck === 'ok' && database.queryOnly === true &&
    database.runtimeRevision === 123 && database.pendingDeliveries === 0 &&
    database.pendingOutboxIntents === 0 && database.p1Authority === 0 &&
    database.sntssAuthority === 0 && database.chronobiologyAuthority === 0 &&
    !residentRow(database, EXPECTED.metab) && database.founders.length === 0 &&
    database.dossiers.length === 0 && database.chips.length === 0,
  'R123F database preflight failed', 'R124_METAB_PROOF_BEFORE');
  assert(validateRevisionFreeze(freeze, 123) &&
    freeze.recordSha256 === EXPECTED.sourceFreezeRecordSha256,
  'R123F parent freeze changed', 'R124_METAB_PROOF_BEFORE');
  assertExistingResident(residentRow(database, EXPECTED.sntss), EXPECTED.sntss, 'SNTSS');
  assertExistingResident(residentRow(database, EXPECTED.chronobiology), EXPECTED.chronobiology,
    'Chronobiology');
  const sntss = assertResources(sntssStatus, 'SNTSS');
  const chronobiology = assertResources(chronobiologyStatus, 'Chronobiology');
  const chip = id => meta?.chipProjection?.lifecycle?.find(value => value.coreId === id);
  const fetus = meta?.cores?.find(value => value.id === 'fetus-legacy');
  const bsf = meta?.systems?.find(value => value.id === 'bsf');
  assert(sntss.version === EXPECTED.sntss.version && sntss.host?.instanceId === EXPECTED.sntss.instanceId &&
    sntss.observedOutputs === 0 && sntss.health?.biologicalOutputs === 0 &&
    chronobiology.version === EXPECTED.chronobiology.version &&
    chronobiology.host?.instanceId === EXPECTED.chronobiology.instanceId &&
    meta?.ok === true && meta.revision === 123 && meta.revisionFrozen === true &&
    chip('bsf')?.state === 'LIVE' && chip('sntss')?.state === 'SHADOW' &&
    chip('chronobiology')?.state === 'SHADOW' && !chip('metab')?.born &&
    bsf?.mode === 'LIVE' && bsf?.status === 'RUNNING' && bsf?.healthOk === true &&
    fetus?.ok === true && fetus?.memoryGuardian?.status === 'healthy' &&
    fetus?.memoryGuardian?.warnAtMiB === 192 && fetus?.memoryGuardian?.recycleAtMiB === 256 &&
    Number(service?.mainPid) > 0 && Number(service?.nRestarts) >= 0 &&
    service?.activeState === 'active' && service?.subState === 'running' &&
    service?.benchmarkActiveState === 'inactive',
  'R123F live preflight failed', 'R124_METAB_PROOF_BEFORE');
  return Object.freeze({ result: 'PASS', runtimeRevision: 123,
    sntssCheckpointGeneration: Number(residentRow(database, EXPECTED.sntss).checkpoint_generation),
    chronobiologyCheckpointGeneration: Number(residentRow(database, EXPECTED.chronobiology).checkpoint_generation) });
}

function validateRepairBefore({ database, sntssStatus, chronobiologyStatus, meta, service }) {
  assert(database.quickCheck === 'ok' && database.queryOnly === true &&
    database.runtimeRevision === 125 && database.pendingDeliveries === 0 &&
    database.pendingOutboxIntents === 0 && database.p1Authority === 0 &&
    database.sntssAuthority === 0 && database.chronobiologyAuthority === 0 &&
    !residentRow(database, EXPECTED.metab) && database.founders.length === 0 &&
    database.dossiers.length === 0 && database.chips.length === 0,
  'R125 failed-birth database fence failed', 'R124_METAB_PROOF_REPAIR_BEFORE');
  assertExistingResident(residentRow(database, EXPECTED.sntss), EXPECTED.sntss, 'SNTSS');
  assertExistingResident(residentRow(database, EXPECTED.chronobiology), EXPECTED.chronobiology,
    'Chronobiology');
  const sntss = assertResources(sntssStatus, 'SNTSS');
  const chronobiology = assertResources(chronobiologyStatus, 'Chronobiology');
  const chip = id => meta?.chipProjection?.lifecycle?.find(value => value.coreId === id);
  const fetus = meta?.cores?.find(value => value.id === 'fetus-legacy');
  const bsf = meta?.systems?.find(value => value.id === 'bsf');
  assert(sntss.version === EXPECTED.sntss.version &&
    sntss.host?.instanceId === EXPECTED.sntss.instanceId &&
    sntss.observedOutputs === 0 && sntss.health?.biologicalOutputs === 0 &&
    chronobiology.version === EXPECTED.chronobiology.version &&
    chronobiology.host?.instanceId === EXPECTED.chronobiology.instanceId &&
    meta?.ok === true && meta.revision === 125 && meta.revisionFrozen === false &&
    chip('bsf')?.state === 'LIVE' && chip('sntss')?.state === 'SHADOW' &&
    chip('chronobiology')?.state === 'SHADOW' && !chip('metab')?.born &&
    bsf?.mode === 'LIVE' && bsf?.status === 'RUNNING' && bsf?.healthOk === true &&
    fetus?.ok === true && fetus?.memoryGuardian?.status === 'healthy' &&
    fetus?.memoryGuardian?.warnAtMiB === 192 && fetus?.memoryGuardian?.recycleAtMiB === 256 &&
    Number(service?.mainPid) > 0 && Number(service?.nRestarts) >= 0 &&
    service?.activeState === 'active' && service?.subState === 'running',
  'R125 failed-birth live fence failed', 'R124_METAB_PROOF_REPAIR_BEFORE');
  return Object.freeze({
    result: 'PASS',
    runtimeRevision: 125,
    sntssCheckpointGeneration:
      Number(residentRow(database, EXPECTED.sntss).checkpoint_generation),
    chronobiologyCheckpointGeneration:
      Number(residentRow(database, EXPECTED.chronobiology).checkpoint_generation)
  });
}

function validateAfter({ before, database, sntssStatus, chronobiologyStatus, metabStatus, meta, service }) {
  const metab = residentRow(database, EXPECTED.metab);
  const consumer = database.consumers.find(value => value.consumer_id === EXPECTED.metab.residencyId);
  const schema = database.schemas.find(value => value.name === 'p1-r0-production');
  assert(database.quickCheck === 'ok' && database.queryOnly === true &&
    [124, 125, 127].includes(database.runtimeRevision) && database.pendingDeliveries === 0 &&
    database.pendingOutboxIntents === 0 && database.p1Authority === 0 &&
    database.sntssAuthority === 0 && database.chronobiologyAuthority === 0 &&
    Number(schema?.version) === 1 && database.founders.length === 1 &&
    database.dossiers.length === 1 && database.chips.length === 1 &&
    database.metabCheckpoints >= 1 && database.metabChipHistory >= 1,
  'R124 METAB database acceptance failed', 'R124_METAB_PROOF_AFTER');
  assert(metab?.core_id === EXPECTED.metab.coreId && metab.role === 'metabolism' &&
    metab.version === EXPECTED.metab.version && Number(metab.state_schema) === 1 &&
    metab.module_relative_path === EXPECTED.metab.moduleRelativePath &&
    metab.module_hash === EXPECTED.metab.moduleHash &&
    metab.manifest_hash === EXPECTED.metab.manifestHash &&
    metab.package_policy_hash === EXPECTED.metab.packagePolicyHash &&
    metab.status === 'RUNNING' && Number(metab.checkpoint_generation) >= 1 &&
    consumer?.core_id === 'METAB' && Number(consumer.required) === 0 &&
    Number(consumer.active) === 1 && consumer.topics_json === '["runtime.organism.binding"]' &&
    Number(consumer.authority_epoch) === 0 && consumer.checkpoint_hash === metab.checkpoint_hash,
  'R124 METAB durable identity is invalid', 'R124_METAB_PROOF_AFTER');
  const founder = validateFounderRecord(JSON.parse(database.founders[0].record_json));
  assert(database.founders[0].record_hash === recordHash(founder) &&
    founder.organismId === database.identity.organismId && founder.coreId === 'METAB' &&
    founder.founderId === JSON.parse(database.dossiers[0].dossier_json).founderRecord.founderId,
  'R124 founder custody is invalid', 'R124_METAB_PROOF_AFTER');
  const chipRecord = validateChipRecord(JSON.parse(database.chips[0].record_json));
  assert(database.chips[0].record_hash === recordHash(chipRecord) &&
    chipRecord.currentState === 'NEUTRAL' && chipRecord.mode === 'NEUTRAL' &&
    chipRecord.historyHeadHash === database.chips[0].history_head_hash,
  'R124 chip custody is invalid', 'R124_METAB_PROOF_AFTER');
  assertExistingResident(residentRow(database, EXPECTED.sntss), EXPECTED.sntss, 'SNTSS');
  assertExistingResident(residentRow(database, EXPECTED.chronobiology), EXPECTED.chronobiology,
    'Chronobiology');
  assert(Number(residentRow(database, EXPECTED.sntss).checkpoint_generation) >=
    before.sntssCheckpointGeneration &&
    Number(residentRow(database, EXPECTED.chronobiology).checkpoint_generation) >=
    before.chronobiologyCheckpointGeneration,
  'existing resident checkpoint continuity rewound', 'R124_METAB_PROOF_CONTINUITY');
  const sntss = assertResources(sntssStatus, 'SNTSS');
  const chronobiology = assertResources(chronobiologyStatus, 'Chronobiology');
  const metabLive = assertResources(metabStatus, 'METAB');
  const chip = id => meta?.chipProjection?.lifecycle?.find(value => value.coreId === id);
  const fetus = meta?.cores?.find(value => value.id === 'fetus-legacy');
  assert(sntss.observedOutputs === 0 && sntss.health?.biologicalOutputs === 0 &&
    chronobiology.version === EXPECTED.chronobiology.version &&
    metabLive.version === EXPECTED.metab.version && metabLive.host?.instanceId === metab.instance_id &&
    metabLive.productionEligible === false && metabLive.signalling === 'FORBIDDEN' &&
    metabLive.declaredOutputs === 0 && metabLive.observedOutputs === 0 &&
    metabLive.handledEvents === 0 && metabLive.health?.mode === 'NEUTRAL' &&
    metabLive.health?.biologicalOutputs === 0 &&
    meta?.ok === true && meta.revision === database.runtimeRevision &&
    chip('bsf')?.state === 'LIVE' && chip('sntss')?.state === 'SHADOW' &&
    chip('chronobiology')?.state === 'SHADOW' && chip('metab')?.state === 'NEUTRAL' &&
    chip('metab')?.born === true && fetus?.ok === true &&
    fetus?.memoryGuardian?.status === 'healthy' &&
    fetus?.memoryGuardian?.warnAtMiB === 192 && fetus?.memoryGuardian?.recycleAtMiB === 256 &&
    Number(service?.beforePid) > 0 && Number(service?.afterPid) > 0 &&
    service.beforePid !== service.afterPid &&
    (database.runtimeRevision === 124
      ? service.beforeRestarts === service.afterRestarts
      : Number.isSafeInteger(service.beforeRestarts) &&
        Number.isSafeInteger(service.afterRestarts) &&
        service.afterRestarts >= service.beforeRestarts &&
        service.afterRestarts <= service.beforeRestarts + 1) &&
    service.restartCommands === (database.runtimeRevision === 127 ? 2 : 1),
  'R124 live acceptance failed', 'R124_METAB_PROOF_AFTER');
  return Object.freeze({
    result: 'PASS', runtimeRevision: database.runtimeRevision,
    founderId: founder.founderId, instanceId: metab.instance_id,
    checkpointGeneration: Number(metab.checkpoint_generation), authorityOwned: false,
    observedOutputs: 0, chipState: 'NEUTRAL'
  });
}

function validateMarkerRecoveryAfter(input) {
  assert(input?.database?.runtimeRevision === 127 &&
    input?.service?.restartCommands === 3,
  'R127 marker-recovery restart evidence is invalid', 'R127_METAB_MARKER_PROOF');
  const accepted = validateAfter({
    ...input,
    service: { ...input.service, restartCommands: 2 }
  });
  return Object.freeze({ ...accepted, restartCommands: 3 });
}

function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'capture' && argv.length === 2) {
    process.stdout.write(`${stableStringify(captureDatabase(argv[1]))}\n`);
    return;
  }
  fail('usage: p1-r124-metab-neutral-live-proof.js capture <database>', 'R124_METAB_PROOF_USAGE');
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`${error.code || 'R124_METAB_PROOF'}: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  EXPECTED,
  captureDatabase,
  validateAfter,
  validateMarkerRecoveryAfter,
  validateBefore,
  validateRepairBefore,
  validateBenchmark
});
