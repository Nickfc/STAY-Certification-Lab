#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const RELEASE = '/opt/stay/releases/0.8.11.3-p1m-r119f-chrono-repair-2961f9a48173';
const { sealRevisionFreeze, validateRevisionFreeze } = require(
  path.join(RELEASE, 'runtime/revision-freeze'));

const EXPECTED = Object.freeze({
  release: RELEASE,
  revision: 123,
  servicePid: 395571,
  sntss: Object.freeze({
    residencyId: 'resident:sntss',
    coreId: 'sntss',
    instanceId: '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
    version: '0.5.0-i4g1',
    stateSchema: 5,
    moduleRelativePath: 'cores/sntss/i4g/index.js',
    moduleHash: 'sha256:4e96f1882ddbe35fc0e8f2afcdabae2b5e75812d8e9a392b09bcc8040b335ea7',
    manifestHash: 'sha256:c1d0db3d4520556cb022864f4d1eb487a99628d61f3564942aa65cc0f204499a',
    packagePolicyHash: 'sha256:ba12622fcc9c782c8c48f0544a5b019c96dc198dcbb7fb209c1dad47de64639d',
    lineageSha256: 'sha256:f90aaee3814402dff6d17c69f10b82e96918184eadc7941f66a90ee50f1f550d',
  }),
  chronobiology: Object.freeze({
    residencyId: 'resident:chronobiology',
    coreId: 'chronobiology',
    instanceId: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
    version: '1.0.0-c3rc.5',
    stateSchema: 2,
    moduleRelativePath: 'cores/chronobiology/c3r5/index.js',
    moduleHash: 'sha256:ecac9b25bf5897d6344cbca702a6ce30ab76c5ff69af76ad17f1aea734e54867',
    manifestHash: 'sha256:4f809b9fee2b4099d51250d339fbee15d226ed9aa0126c4a83d47ff580021012',
    packagePolicyHash: 'sha256:887ff83909b360a75abc1ea6f755db597e613186acaa9b7b20d33b1d21d2232b',
  }),
  abandonedSequence: 2466906,
  resyncId: '513c8386-8ca7-40a4-81a6-cfa44437ccbf',
  releaseTag: 'r119f-v4',
  releaseCommit: '833cf2564ed2be040c681a627de24042f9ac1538',
  releaseTree: '97a1f8dbcf596cb98f0bda9af8faacfd709cb9ef',
  archiveSha256: 'sha256:b0da4fa781181f44299ae724dbc364a71a477dcceec860af7faf8d4f909a066b',
  manifestSha256: 'sha256:021c837c3b1d2a1e855e39e6154790e48a0ecc6f5bbb07dddc9776d63ad733eb',
  recoveryControllerSha256: 'sha256:491cb2217af45589113e3b135c4ed677e04dbc49e3f20f64aeca77095a2e0b6b',
});

function fail(message, code = 'R123F_FREEZE') {
  throw Object.assign(new Error(message), { code });
}
function assert(value, message, code) { if (!value) fail(message, code); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fileSha256(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}
function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`${label} is invalid: ${error.message}`, 'R123F_FREEZE_INPUT'); }
}
function parseDetail(row) {
  try { return row ? { ...row, detail: JSON.parse(row.detail_json) } : null; }
  catch { return null; }
}
function scalar(database, sql, ...parameters) {
  return Number(database.prepare(sql).get(...parameters)?.value || 0);
}
function resident(database, expected) {
  return database.prepare(`SELECT residency_id, core_id, instance_id, version, state_schema,
    module_relative_path, module_hash, manifest_hash, package_policy_hash,
    checkpoint_generation, checkpoint_hash, status
    FROM resident_instances WHERE residency_id=?`).get(expected.residencyId);
}
function consumer(database, expected) {
  return database.prepare(`SELECT consumer_id, core_id, required, active, cursor,
    authority_epoch, checkpoint_hash FROM biological_consumers WHERE consumer_id=?`)
    .get(expected.residencyId);
}
function checkpoint(database, expected, generation) {
  return database.prepare(`SELECT checkpoint_id, residency_id, instance_id, version,
    state_schema, generation, blob_hash, byte_length, input_cursor
    FROM resident_checkpoints WHERE residency_id=? AND generation=?`)
    .get(expected.residencyId, generation);
}
function validateDurableResident(value, expected, label) {
  assert(value?.residency_id === expected.residencyId
    && value.core_id === expected.coreId
    && value.instance_id === expected.instanceId
    && value.version === expected.version
    && Number(value.state_schema) === expected.stateSchema
    && value.module_relative_path === expected.moduleRelativePath
    && value.module_hash === expected.moduleHash
    && value.manifest_hash === expected.manifestHash
    && value.package_policy_hash === expected.packagePolicyHash
    && Number(value.checkpoint_generation) > 0
    && /^[0-9a-f]{64}$/.test(value.checkpoint_hash)
    && value.status === 'RUNNING',
  `${label} durable identity is not exact and running`, 'R123F_FREEZE_RESIDENT');
}
function validateLiveResident(status, expected, label) {
  const value = status?.resident;
  const policy = value?.host?.resourceGovernor?.policy;
  const limits = value?.host?.osContainment?.limits;
  assert(value?.residencyId === expected.residencyId
    && value.coreId === expected.coreId
    && value.host?.instanceId === expected.instanceId
    && value.version === expected.version
    && value.status === 'RUNNING'
    && value.running === true
    && value.health?.ok === true
    && value.authorityOwned === false
    && value.productionEligible === false
    && value.observedOutputs === 0
    && value.resyncRequired === false
    && value.queue?.depth === 0
    && value.queue?.closed === false
    && value.host?.quarantined === false
    && value.host?.osContainment?.required === true
    && value.host?.osContainment?.available === true
    && value.host?.osContainment?.payloadSandboxed === true
    && value.host?.osContainment?.payloadAttachedBeforeInit === true
    && value.host?.osContainment?.supervisorChargedToKernel === true
    && policy?.softRamBytes === 64 * 1024 * 1024
    && policy?.hardRamBytes === 96 * 1024 * 1024
    && policy?.hardCpuDuty === 0.2
    && policy?.queueCapacity === 256
    && policy?.handlerTimeoutMs === 250
    && policy?.pidsMax === 16
    && limits?.['memory.high'] === String(64 * 1024 * 1024)
    && limits?.['memory.max'] === String(96 * 1024 * 1024)
    && limits?.['pids.max'] === '16'
    && limits?.['cpu.max'] === '20000 100000',
  `${label} live containment contract changed`, 'R123F_FREEZE_LIVE_RESIDENT');
  return value;
}

function capture(databasePath, releaseRoot, sntssFile, chronobiologyFile, metaFile,
  identityFile, serviceFile, helperFile, shellFile) {
  assert(path.resolve(releaseRoot) === EXPECTED.release,
    'release path is not the immutable production release', 'R123F_FREEZE_RELEASE');
  const releaseStat = fs.lstatSync(releaseRoot);
  assert(releaseStat.isDirectory() && !releaseStat.isSymbolicLink(),
    'release path is not an immutable directory', 'R123F_FREEZE_RELEASE');
  const sntssStatus = readJson(sntssFile, 'SNTSS status');
  const chronobiologyStatus = readJson(chronobiologyFile, 'Chronobiology status');
  const meta = readJson(metaFile, 'public metadata');
  const identity = readJson(identityFile, 'source identity');
  const service = readJson(serviceFile, 'service fence');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec('PRAGMA query_only=ON');
  let proof;
  try {
    assert(database.prepare('PRAGMA quick_check').get()?.quick_check === 'ok',
      'SQLite quick-check failed', 'R123F_FREEZE_DATABASE');
    const revisionRow = database.prepare(
      "SELECT json,sha256 FROM metadata WHERE key='life:runtime-revision'").get();
    assert(revisionRow && sha256(revisionRow.json) === revisionRow.sha256,
      'runtime revision metadata hash is invalid', 'R123F_FREEZE_REVISION');
    const revision = JSON.parse(revisionRow.json);
    assert(revision.revision === EXPECTED.revision && revision.reason === 'core.install'
      && revision.coreId === 'fetus-legacy' && revision.coreVersion === '0.6.0',
    'runtime is not the exact durable R123 boundary', 'R123F_FREEZE_REVISION');

    const durableSntss = resident(database, EXPECTED.sntss);
    const durableChronobiology = resident(database, EXPECTED.chronobiology);
    validateDurableResident(durableSntss, EXPECTED.sntss, 'SNTSS');
    validateDurableResident(durableChronobiology, EXPECTED.chronobiology, 'Chronobiology');
    const sntssConsumer = consumer(database, EXPECTED.sntss);
    const chronobiologyConsumer = consumer(database, EXPECTED.chronobiology);
    const sntssCheckpoint = checkpoint(database, EXPECTED.sntss,
      Number(durableSntss.checkpoint_generation));
    const chronobiologyCheckpoint = checkpoint(database, EXPECTED.chronobiology,
      Number(durableChronobiology.checkpoint_generation));
    for (const [name, value, durable, currentCheckpoint] of [
      ['SNTSS', sntssConsumer, durableSntss, sntssCheckpoint],
      ['Chronobiology', chronobiologyConsumer, durableChronobiology, chronobiologyCheckpoint],
    ]) {
      assert(value?.active === 1 && Number(value.required) === 0
        && Number(value.authority_epoch) === 0
        && Number(value.cursor) > 0
        && value.checkpoint_hash === durable.checkpoint_hash
        && currentCheckpoint?.instance_id === durable.instance_id
        && currentCheckpoint.version === durable.version
        && Number(currentCheckpoint.generation) === Number(durable.checkpoint_generation)
        && currentCheckpoint.blob_hash === durable.checkpoint_hash
        && Number(currentCheckpoint.byte_length) > 0
        && Number(currentCheckpoint.input_cursor) > EXPECTED.abandonedSequence
        && Number(currentCheckpoint.input_cursor) <= Number(value.cursor),
      `${name} consumer/checkpoint continuity changed`, 'R123F_FREEZE_CONTINUITY');
    }

    const pendingDeliveries = scalar(database,
      "SELECT COUNT(*) value FROM biological_deliveries WHERE status='PENDING'");
    const pendingOutbox = scalar(database,
      "SELECT COUNT(*) value FROM biological_outbox_intents WHERE status='PENDING'");
    const sntssOutputs = scalar(database,
      "SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id='sntss'");
    const authorityRows = scalar(database,
      "SELECT COUNT(*) value FROM authority WHERE core_id IN ('sntss','chronobiology')");
    assert(pendingDeliveries === 0 && pendingOutbox === 0
      && sntssOutputs === 0 && authorityRows === 0,
    'unresolved debt, SNTSS output, or authority leakage exists', 'R123F_FREEZE_CONTAINMENT');

    const head = database.prepare(`SELECT * FROM biological_outbox_stream_heads
      WHERE producer_core_id='chronobiology' AND authority_epoch=1
        AND producer_stream_id='core:chronobiology:outputs'`).get();
    const chronobiologyOutputRows = scalar(database,
      "SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id='chronobiology'");
    assert(head?.producer_instance_id === EXPECTED.chronobiology.instanceId
      && head.producer_version === EXPECTED.chronobiology.version
      && Number(head.last_stream_sequence) >= 341
      && Number(head.last_stream_sequence) === chronobiologyOutputRows
      && scalar(database, `SELECT COUNT(*) value FROM biological_outbox_intents
        WHERE producer_core_id='chronobiology' AND status!='PUBLISHED'`) === 0,
    'Chronobiology output-stream continuity changed', 'R123F_FREEZE_OUTPUT_STREAM');

    const recovery = id => parseDetail(database.prepare(
      'SELECT id,type,core_id,detail_json,created_at FROM recovery_records WHERE id=?').get(id));
    const failure = recovery(102);
    const outputRepair = recovery(103);
    const biologicalResync = recovery(104);
    const residentResync = recovery(106);
    assert(failure?.type === 'resident.resync-required'
      && failure.core_id === EXPECTED.chronobiology.coreId
      && Number(failure.detail?.sequence) === EXPECTED.abandonedSequence
      && failure.detail?.code === 'RESIDENT_COMMIT_FAILED'
      && outputRepair?.type === 'resident.output-stream-identity-repaired'
      && outputRepair.detail?.repairId === 'chronobiology-c3r5-output-stream-r120-fenced'
      && outputRepair.detail?.instanceId === EXPECTED.chronobiology.instanceId
      && outputRepair.detail?.fromVersion === '1.0.0-c3rc.1'
      && outputRepair.detail?.toVersion === EXPECTED.chronobiology.version
      && outputRepair.detail?.authorityChanged === false
      && outputRepair.detail?.biologicalStateChanged === false
      && outputRepair.detail?.abandonedCount === 0
      && outputRepair.detail?.inventedBiologicalTime === false
      && biologicalResync?.type === 'resident.biological-resync'
      && biologicalResync.detail?.resyncId === EXPECTED.resyncId
      && biologicalResync.detail?.abandonedCount === 1
      && Number(biologicalResync.detail?.firstAbandonedSequence) === EXPECTED.abandonedSequence
      && Number(biologicalResync.detail?.lastAbandonedSequence) === EXPECTED.abandonedSequence
      && biologicalResync.detail?.inventedBiologicalTime === false
      && residentResync?.type === 'resident.resynchronized'
      && residentResync.detail?.resyncId === EXPECTED.resyncId
      && residentResync.detail?.abandonedCount === 1
      && residentResync.detail?.inventedBiologicalTime === false,
    'the disclosed recovery exception evidence changed', 'R123F_FREEZE_EXCEPTION');
    assert(scalar(database, `SELECT COUNT(*) value FROM recovery_records
      WHERE id>106 AND json_valid(detail_json)
        AND COALESCE(json_extract(detail_json,'$.abandonedCount'),0)>0`) === 0,
    'a later abandonment exists outside the authorized exception', 'R123F_FREEZE_EXCEPTION');
    const replayableLedgerRowPresent = scalar(database,
      'SELECT COUNT(*) value FROM biological_events WHERE sequence=?', EXPECTED.abandonedSequence) > 0;
    const replayableDeliveryRowPresent = scalar(database,
      'SELECT COUNT(*) value FROM biological_deliveries WHERE sequence=?', EXPECTED.abandonedSequence) > 0;
    assert(replayableLedgerRowPresent === false && replayableDeliveryRowPresent === false,
      'the historical abandoned pulse unexpectedly remains replayable', 'R123F_FREEZE_EXCEPTION');

    const liveSntss = validateLiveResident(sntssStatus, EXPECTED.sntss, 'SNTSS');
    const liveChronobiology = validateLiveResident(
      chronobiologyStatus, EXPECTED.chronobiology, 'Chronobiology');
    assert(liveSntss.declaredOutputs === 0
      && liveSntss.health?.lineageSha256 === EXPECTED.sntss.lineageSha256
      && liveSntss.health?.biologicalOutputs === 0
      && liveSntss.health?.runtimeRevision === EXPECTED.revision,
    'SNTSS lineage or zero-output contract changed', 'R123F_FREEZE_SNTSS');
    assert(liveChronobiology.health?.stage === 'c3-shadow-jitless-bounded-catchup-repair'
      && Number(liveChronobiology.handledEvents) > 0,
    'Chronobiology is not running the contained repair', 'R123F_FREEZE_CHRONOBIOLOGY');

    const bsf = meta.systems?.find(value => value.id === 'bsf');
    const fetus = meta.cores?.find(value => value.id === 'fetus-legacy');
    const chip = id => meta.chipProjection?.lifecycle?.find(value => value.coreId === id);
    assert(meta.ok === true && meta.revision === EXPECTED.revision
      && meta.revisionFrozen === false && meta.revisionLabel === 'R123'
      && bsf?.mode === 'LIVE' && bsf.status === 'RUNNING'
      && bsf.running === true && bsf.healthOk === true && Number(bsf.writeFailures) === 0
      && Number(bsf.pendingDeliveries) === 0
      && fetus?.ok === true && fetus.memoryGuardian?.status === 'healthy'
      && fetus.memoryGuardian?.warnAtMiB === 192
      && fetus.memoryGuardian?.recycleAtMiB === 256
      && meta.chipProjection?.observationOnly === true
      && meta.chipProjection?.mutationEndpoints?.length === 0
      && chip('bsf')?.state === 'LIVE'
      && chip('sntss')?.state === 'SHADOW'
      && chip('chronobiology')?.state === 'SHADOW',
    'public BSF/resident/fetus/chip acceptance is invalid', 'R123F_FREEZE_PUBLIC');

    assert(service.mainPid === EXPECTED.servicePid && service.nRestarts === 0
      && service.activeState === 'active' && service.subState === 'running'
      && service.release === EXPECTED.release
      && service.benchmarkActiveState === 'inactive'
      && service.benchmarkSubState === 'dead'
      && service.currentControllerSha256 === EXPECTED.recoveryControllerSha256,
    'service generation or benchmark fence changed', 'R123F_FREEZE_SERVICE');

    assert(identity.releaseTag === EXPECTED.releaseTag
      && identity.releaseCommit === EXPECTED.releaseCommit
      && identity.releaseTree === EXPECTED.releaseTree
      && identity.archiveSha256 === EXPECTED.archiveSha256
      && identity.manifestSha256 === EXPECTED.manifestSha256
      && identity.r120RecoveryTag === 'r120f-recovery-v2'
      && identity.r120RecoveryCommit === '92edf850231743f4c7a149f56cf5288d4cf81f5c'
      && identity.r122OperationalTag === 'r122-operational-recovery-v1'
      && identity.r122OperationalCommit === '4d87973d15640189dd9346a4a0d2b7b835c21960'
      && identity.r123FreezeTag === 'r123f-authorized-freeze-v2'
      && /^[0-9a-f]{40}$/.test(identity.r123FreezeCommit)
      && /^[0-9a-f]{40}$/.test(identity.r123FreezeTree)
      && identity.helperSha256 === fileSha256(helperFile)
      && identity.shellSha256 === fileSha256(shellFile),
    'source or release identity is invalid', 'R123F_FREEZE_IDENTITY');

    proof = {
      quickCheck: 'ok',
      runtimeRevisionMetadataSha256: `sha256:${revisionRow.sha256}`,
      sntssCheckpointGeneration: Number(durableSntss.checkpoint_generation),
      sntssCheckpointInputCursor: Number(sntssCheckpoint.input_cursor),
      sntssConsumerCursor: Number(sntssConsumer.cursor),
      chronobiologyCheckpointGeneration: Number(durableChronobiology.checkpoint_generation),
      chronobiologyCheckpointInputCursor: Number(chronobiologyCheckpoint.input_cursor),
      chronobiologyConsumerCursor: Number(chronobiologyConsumer.cursor),
      chronobiologyOutboxStreamSequence: Number(head.last_stream_sequence),
      unresolvedPendingDeliveries: pendingDeliveries,
      pendingOutboxIntents: pendingOutbox,
      sntssOutputs,
      authorityRows,
      historicalAbandonedDeliveries: 1,
      abandonedSequences: [EXPECTED.abandonedSequence],
      replayableLedgerRowPresent,
      replayableDeliveryRowPresent,
      inventedBiologicalTime: false,
    };
  } finally { database.close(); }

  const record = sealRevisionFreeze({
    format: 'stay-runtime-revision-freeze-v1',
    result: 'PASS',
    acceptance: 'ACCEPTED',
    freezeType: 'R123F_EXPLICITLY_AUTHORIZED_CHRONOBIOLOGY_RECOVERY_EXCEPTION',
    runtime: {
      revision: EXPECTED.revision,
      revisionLabel: 'R123F',
      progression: [118, 119, 120, 121, 122, 123],
      serviceMainPid: service.mainPid,
      serviceNRestarts: service.nRestarts,
      restartCommandsForFreeze: 0,
    },
    authorization: {
      source: 'USER_EXPLICIT',
      scope: 'FREEZE_CURRENT_R123_WITH_ONE_DISCLOSED_HISTORICAL_ABANDONMENT',
      historicalAbandonmentAccepted: true,
      benchmarkStartAuthorized: false,
    },
    exception: {
      recoveryResyncId: EXPECTED.resyncId,
      historicalAbandonedDeliveries: 1,
      abandonedSequences: [EXPECTED.abandonedSequence],
      replayableLedgerRowPresent: false,
      replayableDeliveryRowPresent: false,
      unresolvedPendingDeliveries: 0,
      inventedBiologicalTime: false,
      evidenceRecoveryRecordIds: [102, 104, 106],
    },
    release: {
      path: EXPECTED.release,
      tag: EXPECTED.releaseTag,
      commit: EXPECTED.releaseCommit,
      tree: EXPECTED.releaseTree,
      archiveSha256: EXPECTED.archiveSha256,
      manifestSha256: EXPECTED.manifestSha256,
    },
    recovery: {
      outputStreamRecordId: 103,
      outputStreamFromVersion: '1.0.0-c3rc.1',
      outputStreamToVersion: EXPECTED.chronobiology.version,
      outputStreamAuthorityChanged: false,
      outputStreamBiologicalStateChanged: false,
      r120Source: { tag: identity.r120RecoveryTag, commit: identity.r120RecoveryCommit },
      r122Source: { tag: identity.r122OperationalTag, commit: identity.r122OperationalCommit },
      currentControllerSha256: EXPECTED.recoveryControllerSha256,
    },
    freezeSource: {
      tag: identity.r123FreezeTag,
      commit: identity.r123FreezeCommit,
      tree: identity.r123FreezeTree,
      helperSha256: identity.helperSha256,
      shellSha256: identity.shellSha256,
    },
    continuity: proof,
    residents: {
      bsf: { mode: 'LIVE', status: 'RUNNING' },
      sntss: { instanceId: EXPECTED.sntss.instanceId, version: EXPECTED.sntss.version,
        mode: 'SHADOW', status: 'RUNNING', outputs: 0, authority: 'NONE' },
      chronobiology: { instanceId: EXPECTED.chronobiology.instanceId,
        version: EXPECTED.chronobiology.version, mode: 'SHADOW', status: 'RUNNING',
        authority: 'NONE' },
      fetus: { status: 'healthy', warnAtMiB: 192, recycleAtMiB: 256 },
    },
    chips: { bsf: 'LIVE', sntss: 'SHADOW', chronobiology: 'SHADOW' },
    benchmark: { started: false, activeState: 'inactive', authorizationRequired: true },
    capturedAt: new Date().toISOString(),
  });
  assert(validateRevisionFreeze(record, EXPECTED.revision),
    'generated freeze record is invalid', 'R123F_FREEZE_VERIFY');
  return record;
}

function verify(record) {
  assert(validateRevisionFreeze(record, EXPECTED.revision)
    && record.freezeType === 'R123F_EXPLICITLY_AUTHORIZED_CHRONOBIOLOGY_RECOVERY_EXCEPTION'
    && record.authorization?.source === 'USER_EXPLICIT'
    && record.authorization?.historicalAbandonmentAccepted === true
    && record.authorization?.benchmarkStartAuthorized === false
    && record.exception?.historicalAbandonedDeliveries === 1
    && record.exception?.abandonedSequences?.length === 1
    && record.exception.abandonedSequences[0] === EXPECTED.abandonedSequence
    && record.exception?.unresolvedPendingDeliveries === 0
    && record.exception?.inventedBiologicalTime === false
    && record.runtime?.restartCommandsForFreeze === 0
    && record.residents?.sntss?.outputs === 0
    && record.residents?.sntss?.authority === 'NONE'
    && record.residents?.chronobiology?.authority === 'NONE'
    && record.benchmark?.started === false,
  'R123F freeze record failed verification', 'R123F_FREEZE_VERIFY');
  return {
    R123F_AUTHORIZED_FREEZE: 'PASS',
    REVISION_LABEL: 'R123F',
    RECORD_SHA256: record.recordSha256,
    HISTORICAL_ABANDONED_DELIVERIES: 1,
    ABANDONED_SEQUENCE: EXPECTED.abandonedSequence,
    UNRESOLVED_PENDING_DELIVERIES: 0,
    INVENTED_BIOLOGICAL_TIME: false,
    BENCHMARK_STARTED: 'NO',
  };
}

function main(argv = process.argv.slice(2)) {
  const operation = argv.shift();
  if (operation === 'capture' && argv.length === 9) {
    process.stdout.write(`${JSON.stringify(capture(...argv))}\n`);
    return;
  }
  if (operation === 'verify' && argv.length === 1) {
    for (const [key, value] of Object.entries(verify(readJson(argv[0], 'freeze record')))) {
      process.stdout.write(`${key}=${value}\n`);
    }
    return;
  }
  fail('capture or verify arguments required', 'R123F_FREEZE_USAGE');
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`R123F_FREEZE_ABORT=${error.code || 'FAILED'}:${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { EXPECTED, capture, verify };
