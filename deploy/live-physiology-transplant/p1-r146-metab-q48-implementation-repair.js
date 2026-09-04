#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { stableStringify } = require('../../runtime/kernel/canonical-json');
const { validateCapacitySourceState } = require('../../runtime/p1-r0/metab-capacity-source');
const { enforcePackagePolicy, verifyManifestAgainstPackagePolicy } =
  require('../../runtime/kernel/package-policy');
const { validateManifest } = require('../../runtime/kernel/manifest');

const BASELINE = Object.freeze({
  runtimeRevision: 146,
  residencyId: 'resident:metab',
  coreId: 'METAB',
  instanceId: 'd424c722-ef31-44b0-8201-ba68c418d14a',
  version: '0.2.0-p1r0-shadow.1',
  stateSchema: 2,
  moduleRelativePath: 'cores/p1-r0/metab-shadow/index.js',
  moduleHash: 'sha256:07b0b6d5d6b51f70dec6d224fb46ae62f5b2f0aa0579f7d1aa3dcc24073bdcbe',
  manifestHash: 'sha256:06767143b3eae0760931d93029d4c905c7e811180e818f7236111629e0c1eb69',
  packagePolicyHash: 'sha256:6fb47a6a1fd59d3aa260e0d63c8ae9376465a00fcf04b11062bec40d9086b095',
  checkpointId: 'c81a1a9c-e621-4bff-9be3-84596727f31b',
  checkpointGeneration: 196024,
  checkpointHash: '610da12ffe27f1a4fb2c95da318715255cd0ae8693fecff4999552aebfbbd491',
  checkpointBytes: 3893,
  inputCursor: 4179959,
  failureRecordId: 164,
  failureSequence: 4179960,
  acceptedFrame: 98001,
  pendingFrame: 98002,
  capacityMetadataKey: 'life:p1-r0-metab-capacity-source',
  capacityMetadataSha256: 'ec7fb9ad06ef4dd35cba8a415d75f0f38ddd8bfa02cbf9975aeb2c319998b58c'
});

const REPAIR = Object.freeze({
  repairId: 'metab-q48-saturating-lifetime-r146-v1',
  moduleHash: 'sha256:316ccafbada62b8eb9261d2574833ec0f36eb8232041e9c35320d8cbb419f88d',
  manifestHash: BASELINE.manifestHash,
  packagePolicyHash: 'sha256:7aa327005436f91310176753baf94d783661bb5c156be2d8ace0190456fd55c9',
  checkpointGeneration: 196025,
  checkpointId: 'metab-q48-r146-partial-frame-repair-196025'
});

const PARTIAL_ROUTE = Object.freeze({
  metabVersion: '0.3.0-p1r0-homeos-feed.1',
  metabStateSchema: 3,
  metabModuleRelativePath: 'cores/p1-r0/metab-homeos/index.js',
  metabModuleHash: 'sha256:eba96dd21bc225b9bed97261dc9d3648c9a63ed2b2ddbd2d76fb6d306e2a0622',
  metabManifestHash: 'sha256:ae050626ce7d2e1e1e0d0a6c009a1818e094bfecb792c0bf868bcc14ddd791ac',
  metabPackagePolicyHash: 'sha256:c97cd6f90c444bf1d496d45c7e64ee2547c86a477a76ca28c41ce528d454780e',
  homeosInstanceId: '3f32bdc9-fa49-4eea-8c13-b9afe6b47c0f',
  homeosVersion: '0.1.0-p1r0-neutral.1',
  homeosStateSchema: 1,
  homeosModuleRelativePath: 'cores/p1-r0/homeos-neutral/index.js',
  homeosModuleHash: 'sha256:2470be8ba7572296758638f72abbafd5f0e2f8b0effd4d6d7b9fd0dfed830d30',
  homeosManifestHash: 'sha256:8604f0ea30cca02c1b1f2cf10aa902197389d2a8a508454ff221555c3cde6825',
  homeosPackagePolicyHash: 'sha256:2f8cc1fd91f84bd1ee54ef9e38929a824f5768775fe849816185bcecd2843b8f'
});

const FINAL_HOMEOS = Object.freeze({
  repairId: 'homeos-r146-route-boundary-continuity-v1',
  residencyId: 'resident:homeos',
  coreId: 'HOMEOS',
  instanceId: '3f32bdc9-fa49-4eea-8c13-b9afe6b47c0f',
  version: '0.2.0-p1r0-shadow.1',
  stateSchema: 2,
  moduleRelativePath: 'cores/p1-r0/homeos-shadow/index.js',
  sourceModuleHash: 'sha256:851f3b9dd7351f056011cc183fbda99fd310c05b102d1ec3f28687947160dac8',
  targetModuleHash: 'sha256:28ce93b507a070fef823e40cce3e7368928466077fed943c98a1a88b5a84299a',
  manifestHash: 'sha256:36a34d27e58035063c94cbf2acc7f8646679ee472b1d03f0459c9b4ccaa79179',
  sourcePackagePolicyHash: 'sha256:5f250142eafc5ad5d13463c5752ee3e8f205b5a2e609bfe6c7c59ab151316636',
  targetPackagePolicyHash: 'sha256:1afd6096fed7727491847e702d2506aa9492f8ad7d1424300b99ca3645d8b161',
  sourceCheckpointId: '0078dfa1-607d-4452-80ea-c310f29feeb0',
  sourceCheckpointGeneration: 41,
  sourceCheckpointHash: 'ed9143e79dcfee9025926c07bf48a6ab9a5bd70a0646ca16458cb789662423fd',
  sourceCheckpointBytes: 47261,
  sourceInputCursor: 4241113,
  repairedCheckpointId: 'homeos-r146-route-boundary-repair-42',
  repairedCheckpointGeneration: 42,
  repairedCheckpointHash: '562d336fcf6f7184acaf826d29fe0d890d5705b40c3b49aa4a70a41fa3328046',
  repairedCheckpointBytes: 3926,
  consumerCursor: 4241116,
  consumerTopicsHash: 'abea82189093d4bb54bee213ed9f9a7ebdd9b2b0b76f6f77dcc2762555e75231',
  failureRecordId: 184,
  pendingSequences: Object.freeze([4241117, 4241118]),
  pendingTopics: Object.freeze([
    'metab.energy.availability.v1',
    'metab.energy.reserve.v1'
  ]),
  pendingDeduplicationKeys: Object.freeze([
    'core-output:dd4f1feb2e23462bc77206e91d066aa9e88d41ba145228599d7e64ef0a0ed8dd',
    'core-output:63fadd3d778d1132eed2ec1ff533a69825b2fd2524ec16d2b35d81d01e8aeef9'
  ]),
  prunedConsumerCursor: 4241118,
  publishedIntents: Object.freeze([
    Object.freeze({
      producerEventId: 'dd4f1feb2e23462bc77206e91d066aa9e88d41ba145228599d7e64ef0a0ed8dd',
      streamSequence: 39,
      outputIndex: 1,
      topic: 'metab.energy.availability.v1',
      proposalSha256: '5c2f1d583b2b55cf17104e83ed4f52c019cf5c9f8ee84a798bb1e739b6e182b7',
      intentSha256: '3e2897f3a6dfc26d5ea0faea147d8dbd552cad7a10b9028cae5dc6f78e866e21',
      fabricSequence: 4241117,
      fabricEventId: 'evt-2iwgt-5dfa074d002fd9eb'
    }),
    Object.freeze({
      producerEventId: '63fadd3d778d1132eed2ec1ff533a69825b2fd2524ec16d2b35d81d01e8aeef9',
      streamSequence: 40,
      outputIndex: 2,
      topic: 'metab.energy.reserve.v1',
      proposalSha256: '377e77b8c5c579e36f902ed7232138f6ec696e40aff74bfc312a33fb2b95b776',
      intentSha256: 'e004c64e4fa571ab00e0858dc4e1299ee4b7207f5b24555cf4be778509cad6bc',
      fabricSequence: 4241118,
      fabricEventId: 'evt-2iwgu-554aaf44c4edc5a1'
    })
  ]),
  publishedIntentCommon: Object.freeze({
    producerCoreId: 'METAB',
    producerInstanceId: 'd424c722-ef31-44b0-8201-ba68c418d14a',
    producerVersion: '0.3.0-p1r0-homeos-feed.1',
    authorityEpoch: 1,
    producerStreamId: 'core:METAB:outputs',
    transitionId: 'sha256:add174f19c585bfdc3e96158458dd63445f2b89d3944af6762fbccca107580d2',
    causeSequence: 4241116,
    checkpointId: 'cc2b2a0d-919b-4944-a37d-b23ef9b9fdcb',
    checkpointHash: '45dd76aa69ef778e0672c588781dbf2d754b77ecbe680c4f61a1c59a0ddc81cb',
    checkpointGeneration: 196076
  }),
  fetus: Object.freeze({
    consumerId: 'core:fetus-legacy',
    instanceId: '82202211-8dd6-44d4-a4ec-8f2553d8dc6f',
    version: '0.6.0',
    authorityEpoch: 1,
    consumerCursor: 4194076,
    consumerCheckpointHash: 'dc65f0fff624e08df092620697f230ea28521e8db34614c455f7473e6ed91b7b',
    checkpointGeneration: 203,
    checkpointHash: '4e1e648fb80c66d6c21d5c1c550ae50f702f581ab52bbda60805ce66b33078bf',
    checkpointBytes: 55962,
    demotionId: 167,
    priorConsumerCheckpointHash: 'dc65f0fff624e08df092620697f230ea28521e8db34614c455f7473e6ed91b7b',
    priorResolutionId: 124,
    priorDemotionId: 116,
    pendingAtDemotion: 16464,
    maximumDebt: 16384,
    topicsHash: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
  })
});

function fail(message, code = 'R146_METAB_Q48_REPAIR') {
  throw Object.assign(new Error(message), { code });
}
function assert(condition, message, code) { if (!condition) fail(message, code); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function metadataRevision(db) {
  const row = db.prepare("SELECT json,sha256 FROM metadata WHERE key='life:runtime-revision'").get();
  assert(row && sha256(row.json) === row.sha256, 'runtime revision metadata is corrupt');
  return Number(JSON.parse(row.json).revision);
}
function scalar(db, sql, ...args) { return Number(db.prepare(sql).get(...args)?.value || 0); }

function verifiedOutboxIntent(row, expected = null) {
  assert(row && typeof row.intent_json === 'string' &&
    sha256(row.intent_json) === row.intent_sha256,
  'biological outbox intent integrity changed', 'R146_HOMEOS_ROUTE_OUTBOX');
  let intent = null;
  try { intent = JSON.parse(row.intent_json); } catch {}
  assert(intent?.format === 'stay-biological-outbox-intent-v1' &&
    intent.producer_event_id === row.producer_event_id &&
    intent.producer_core_id === row.producer_core_id &&
    intent.producer_instance_id === row.producer_instance_id &&
    intent.producer_version === row.producer_version &&
    Number(intent.authority_epoch) === Number(row.authority_epoch) &&
    intent.producer_stream_id === row.producer_stream_id &&
    Number(intent.stream_sequence) === Number(row.stream_sequence) &&
    intent.transition_id === row.transition_id &&
    Number(intent.cause_sequence) === Number(row.cause_sequence) &&
    Number(intent.output_index) === Number(row.output_index) &&
    intent.topic === row.topic &&
    intent.checkpoint?.id === row.checkpoint_id &&
    intent.checkpoint?.hash === row.checkpoint_hash &&
    Number(intent.checkpoint?.generation) === Number(row.checkpoint_generation),
  'biological outbox row disagrees with its immutable intent', 'R146_HOMEOS_ROUTE_OUTBOX');
  if (expected) {
    const common = FINAL_HOMEOS.publishedIntentCommon;
    assert(row.producer_event_id === expected.producerEventId &&
      row.producer_core_id === common.producerCoreId &&
      row.producer_instance_id === common.producerInstanceId &&
      row.producer_version === common.producerVersion &&
      Number(row.authority_epoch) === common.authorityEpoch &&
      row.producer_stream_id === common.producerStreamId &&
      Number(row.stream_sequence) === expected.streamSequence &&
      row.transition_id === common.transitionId &&
      Number(row.cause_sequence) === common.causeSequence &&
      Number(row.output_index) === expected.outputIndex &&
      row.topic === expected.topic &&
      row.proposal_sha256 === expected.proposalSha256 &&
      row.intent_sha256 === expected.intentSha256 &&
      row.checkpoint_id === common.checkpointId &&
      row.checkpoint_hash === common.checkpointHash &&
      Number(row.checkpoint_generation) === common.checkpointGeneration &&
      row.status === 'PUBLISHED' &&
      Number(row.fabric_sequence) === expected.fabricSequence &&
      row.fabric_event_id === expected.fabricEventId,
    'exact R146 published HOMEOS source intent changed', 'R146_HOMEOS_ROUTE_OUTBOX');
  }
  return intent;
}

function assertMovingMetabOutboxContained(db) {
  const rows = db.prepare(`SELECT * FROM biological_outbox_intents
    WHERE producer_core_id IN ('METAB','HOMEOS') AND status='PENDING'
    ORDER BY producer_core_id,stream_sequence`).all();
  if (rows.length === 0) return 0;
  assert(rows.length === 2 && rows.every(row => row.producer_core_id === 'METAB'),
    'pending P1 output is not one bounded METAB pair', 'R146_HOMEOS_ROUTE_CONTAINMENT');
  const intents = rows.map(row => verifiedOutboxIntent(row));
  assert(rows[0].producer_instance_id === BASELINE.instanceId &&
    rows[0].producer_version === PARTIAL_ROUTE.metabVersion &&
    Number(rows[0].authority_epoch) === 1 &&
    rows[0].producer_stream_id === 'core:METAB:outputs' &&
    rows[1].producer_instance_id === rows[0].producer_instance_id &&
    rows[1].producer_version === rows[0].producer_version &&
    Number(rows[1].authority_epoch) === Number(rows[0].authority_epoch) &&
    rows[1].producer_stream_id === rows[0].producer_stream_id &&
    Number(rows[1].stream_sequence) === Number(rows[0].stream_sequence) + 1 &&
    rows[0].transition_id === rows[1].transition_id &&
    Number(rows[0].cause_sequence) === Number(rows[1].cause_sequence) &&
    rows[0].checkpoint_id === rows[1].checkpoint_id &&
    rows[0].checkpoint_hash === rows[1].checkpoint_hash &&
    Number(rows[0].checkpoint_generation) === Number(rows[1].checkpoint_generation) &&
    rows[0].topic === FINAL_HOMEOS.pendingTopics[0] && Number(rows[0].output_index) === 1 &&
    rows[1].topic === FINAL_HOMEOS.pendingTopics[1] && Number(rows[1].output_index) === 2 &&
    intents[0]?.payload?.committedFrame === intents[1]?.payload?.committedFrame,
  'pending METAB output pair lost its containment fence', 'R146_HOMEOS_ROUTE_CONTAINMENT');
  return rows.length;
}
function readBlob(databasePath, checkpoint) {
  const file = path.join(path.dirname(databasePath), 'blobs', 'sha256',
    checkpoint.blob_hash.slice(0, 2), checkpoint.blob_hash);
  const bytes = fs.readFileSync(file);
  assert(bytes.length === Number(checkpoint.byte_length) && sha256(bytes) === checkpoint.blob_hash,
    'METAB checkpoint blob integrity failed', 'R146_METAB_Q48_CHECKPOINT');
  return bytes;
}
function validateRelease(releaseRoot) {
  const entry = path.resolve(releaseRoot, BASELINE.moduleRelativePath);
  const policy = enforcePackagePolicy(entry);
  const definition = require(entry);
  const durable = validateManifest(definition.manifest);
  verifyManifestAgainstPackagePolicy(policy, definition.manifest);
  assert(`sha256:${sha256(fs.readFileSync(entry))}` === REPAIR.moduleHash &&
    `sha256:${sha256(stableStringify(durable))}` === REPAIR.manifestHash &&
    policy.policy.policyHash === REPAIR.packagePolicyHash &&
    definition.manifest.version === BASELINE.version &&
    definition.manifest.stateSchema === BASELINE.stateSchema &&
    definition.manifest.productionEligible === false &&
    definition.manifest.outputs.length === 0,
  'repaired METAB package identity or containment changed', 'R146_METAB_Q48_RELEASE');
  return definition;
}
function validateFinalHomeosRelease(releaseRoot) {
  const entry = path.resolve(releaseRoot, FINAL_HOMEOS.moduleRelativePath);
  const policy = enforcePackagePolicy(entry);
  const definition = require(entry);
  const durable = validateManifest(definition.manifest);
  verifyManifestAgainstPackagePolicy(policy, definition.manifest);
  assert(`sha256:${sha256(fs.readFileSync(entry))}` === FINAL_HOMEOS.targetModuleHash &&
    `sha256:${sha256(stableStringify(durable))}` === FINAL_HOMEOS.manifestHash &&
    policy.policy.policyHash === FINAL_HOMEOS.targetPackagePolicyHash &&
    definition.manifest.version === FINAL_HOMEOS.version &&
    definition.manifest.stateSchema === FINAL_HOMEOS.stateSchema &&
    definition.manifest.productionEligible === false &&
    definition.manifest.outputs.length === 0 &&
    typeof definition.repairExactR146RouteBoundaryState === 'function',
  'repaired HOMEOS package identity or containment changed', 'R146_HOMEOS_ROUTE_RELEASE');
  return definition;
}
function snapshot(db) {
  return {
    resident: db.prepare('SELECT * FROM resident_instances WHERE residency_id=?')
      .get(BASELINE.residencyId),
    checkpoint: db.prepare('SELECT * FROM resident_checkpoints WHERE residency_id=? AND generation=?')
      .get(BASELINE.residencyId, BASELINE.checkpointGeneration),
    repairCheckpoint: db.prepare('SELECT * FROM resident_checkpoints WHERE residency_id=? AND generation=?')
      .get(BASELINE.residencyId, REPAIR.checkpointGeneration),
    consumer: db.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?')
      .get(BASELINE.residencyId),
    capacity: db.prepare('SELECT * FROM metadata WHERE key=?').get(BASELINE.capacityMetadataKey),
    failure: db.prepare("SELECT id,detail_json FROM recovery_records WHERE type='resident.resync-required' AND core_id=? ORDER BY id DESC LIMIT 1")
      .get(BASELINE.coreId)
  };
}
function assertBaseline(db, { repaired = false } = {}) {
  assert(db.prepare('PRAGMA quick_check').get()?.quick_check === 'ok' &&
    metadataRevision(db) === BASELINE.runtimeRevision,
  'database is not the exact healthy R146 storage boundary');
  const value = snapshot(db), resident = value.resident, checkpoint = value.checkpoint,
    consumer = value.consumer, capacity = value.capacity;
  const expectedModule = repaired ? REPAIR.moduleHash : BASELINE.moduleHash;
  const expectedPolicy = repaired ? REPAIR.packagePolicyHash : BASELINE.packagePolicyHash;
  const expectedGeneration = repaired ? REPAIR.checkpointGeneration : BASELINE.checkpointGeneration;
  const expectedCheckpoint = repaired ? value.repairCheckpoint : checkpoint;
  assert(resident?.instance_id === BASELINE.instanceId && resident?.core_id === BASELINE.coreId &&
    resident?.version === BASELINE.version && Number(resident?.state_schema) === BASELINE.stateSchema &&
    resident?.module_relative_path === BASELINE.moduleRelativePath && resident?.module_hash === expectedModule &&
    resident?.manifest_hash === BASELINE.manifestHash && resident?.package_policy_hash === expectedPolicy &&
    resident?.status === 'RESYNC_REQUIRED' && Number(resident?.checkpoint_generation) === expectedGeneration &&
    resident?.checkpoint_hash === expectedCheckpoint?.blob_hash,
  'METAB resident is not the exact R146 repair cohort', 'R146_METAB_Q48_RESIDENT');
  assert(checkpoint?.checkpoint_id === BASELINE.checkpointId &&
    checkpoint?.blob_hash === BASELINE.checkpointHash && Number(checkpoint?.byte_length) === BASELINE.checkpointBytes &&
    Number(checkpoint?.input_cursor) === BASELINE.inputCursor,
  'METAB source checkpoint changed', 'R146_METAB_Q48_CHECKPOINT');
  if (repaired) {
    assert(expectedCheckpoint?.checkpoint_id === REPAIR.checkpointId &&
      expectedCheckpoint?.instance_id === BASELINE.instanceId &&
      expectedCheckpoint?.version === BASELINE.version &&
      Number(expectedCheckpoint?.state_schema) === BASELINE.stateSchema &&
      Number(expectedCheckpoint?.generation) === REPAIR.checkpointGeneration &&
      Number(expectedCheckpoint?.input_cursor) === BASELINE.inputCursor &&
      Number(expectedCheckpoint?.byte_length) > 0,
    'METAB repaired checkpoint tuple changed', 'R146_METAB_Q48_CHECKPOINT');
  }
  assert(consumer?.core_id === BASELINE.coreId && Number(consumer?.required) === 0 &&
    Number(consumer?.active) === 0 && Number(consumer?.cursor) === BASELINE.inputCursor &&
    Number(consumer?.authority_epoch) === 0 && consumer?.checkpoint_hash === expectedCheckpoint?.blob_hash,
  'METAB consumer is not contained', 'R146_METAB_Q48_CONSUMER');
  assert(scalar(db, "SELECT COUNT(*) value FROM biological_deliveries WHERE consumer_id=? AND status='PENDING'",
    BASELINE.residencyId) === 0 && scalar(db,
      "SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id=? AND status='PENDING'",
      BASELINE.coreId) === 0 && scalar(db, 'SELECT COUNT(*) value FROM authority WHERE core_id=?',
      BASELINE.coreId) === 0,
  'METAB repair cohort has debt or authority', 'R146_METAB_Q48_CONTAINMENT');
  let detail = null; try { detail = JSON.parse(value.failure?.detail_json || 'null'); } catch {}
  assert(Number(value.failure?.id) === BASELINE.failureRecordId &&
    detail?.sequence === BASELINE.failureSequence && detail?.topic === 'resource.capacity.quality.v1' &&
    detail?.code === 'P1_Q48_OVERFLOW',
  'METAB terminal failure is not the diagnosed overflow', 'R146_METAB_Q48_FAILURE');
  const source = JSON.parse(capacity?.json || 'null');
  assert(capacity && sha256(capacity.json) === capacity.sha256 &&
    source?.lastCommittedFrame === BASELINE.acceptedFrame &&
    (repaired ? source.pending === null : source?.pending?.sampleFrame === BASELINE.pendingFrame),
  'METAB capacity source is not the exact partial-frame cohort', 'R146_METAB_Q48_SOURCE');
  return { ...value, source };
}

function assertPartialRouteCohort(db, databasePath) {
  assert(db.prepare('PRAGMA quick_check').get()?.quick_check === 'ok' &&
    metadataRevision(db) === BASELINE.runtimeRevision,
  'database is not the exact partial R146 route boundary');
  const metab = db.prepare('SELECT * FROM resident_instances WHERE residency_id=?')
    .get(BASELINE.residencyId);
  const homeos = db.prepare('SELECT * FROM resident_instances WHERE residency_id=?')
    .get('resident:homeos');
  const intero = db.prepare('SELECT * FROM resident_instances WHERE residency_id=?')
    .get('resident:intero');
  const metabCheckpoint = db.prepare(`SELECT * FROM resident_checkpoints
    WHERE residency_id=? AND generation=?`).get(BASELINE.residencyId, metab?.checkpoint_generation);
  const homeosCheckpoint = db.prepare(`SELECT * FROM resident_checkpoints
    WHERE residency_id=? AND generation=?`).get('resident:homeos', homeos?.checkpoint_generation);
  const metabConsumer = db.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?')
    .get(BASELINE.residencyId);
  const homeosConsumer = db.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?')
    .get('resident:homeos');
  const capacity = db.prepare('SELECT json,sha256 FROM metadata WHERE key=?')
    .get(BASELINE.capacityMetadataKey);
  const repair = db.prepare(`SELECT detail_json FROM recovery_records
    WHERE type='resident.implementation-repaired' AND core_id=? ORDER BY id DESC LIMIT 1`)
    .get(BASELINE.coreId);
  const metabRecovery = db.prepare(`SELECT detail_json FROM recovery_records
    WHERE type='resident.recovered' AND core_id=? ORDER BY id DESC LIMIT 1`)
    .get(BASELINE.coreId);
  const homeosBirth = db.prepare(`SELECT detail_json FROM recovery_records
    WHERE type='resident.attached' AND core_id='HOMEOS' ORDER BY id DESC LIMIT 1`).get();
  let repairDetail = null, metabRecoveryDetail = null, homeosBirthDetail = null, source = null;
  try { repairDetail = JSON.parse(repair?.detail_json || 'null'); } catch {}
  try { metabRecoveryDetail = JSON.parse(metabRecovery?.detail_json || 'null'); } catch {}
  try { homeosBirthDetail = JSON.parse(homeosBirth?.detail_json || 'null'); } catch {}
  try {
    assert(capacity && sha256(capacity.json) === capacity.sha256,
      'partial R146 capacity source metadata is corrupt');
    source = validateCapacitySourceState(JSON.parse(capacity.json), {
      instanceId: BASELINE.instanceId,
      residentVersion: BASELINE.version
    });
  } catch (error) {
    fail(`partial R146 capacity source is invalid: ${error.message}`, 'R146_METAB_Q48_PARTIAL_ROUTE');
  }
  const metabState = JSON.parse(readBlob(databasePath, metabCheckpoint));
  const homeosState = JSON.parse(readBlob(databasePath, homeosCheckpoint));
  assert(metab?.instance_id === BASELINE.instanceId &&
    metab?.version === PARTIAL_ROUTE.metabVersion &&
    Number(metab?.state_schema) === PARTIAL_ROUTE.metabStateSchema &&
    metab?.module_relative_path === PARTIAL_ROUTE.metabModuleRelativePath &&
    metab?.module_hash === PARTIAL_ROUTE.metabModuleHash &&
    metab?.manifest_hash === PARTIAL_ROUTE.metabManifestHash &&
    metab?.package_policy_hash === PARTIAL_ROUTE.metabPackagePolicyHash &&
    metab?.status === 'RUNNING' &&
    Number(metab?.checkpoint_generation) > REPAIR.checkpointGeneration &&
    metab?.checkpoint_hash === metabCheckpoint?.blob_hash &&
    metabCheckpoint?.instance_id === BASELINE.instanceId &&
    metabCheckpoint?.version === PARTIAL_ROUTE.metabVersion &&
    Number(metabCheckpoint?.state_schema) === PARTIAL_ROUTE.metabStateSchema &&
    Number(metabCheckpoint?.generation) === Number(metab?.checkpoint_generation) &&
    homeos?.instance_id === PARTIAL_ROUTE.homeosInstanceId &&
    homeos?.version === PARTIAL_ROUTE.homeosVersion &&
    Number(homeos?.state_schema) === PARTIAL_ROUTE.homeosStateSchema &&
    homeos?.module_relative_path === PARTIAL_ROUTE.homeosModuleRelativePath &&
    homeos?.module_hash === PARTIAL_ROUTE.homeosModuleHash &&
    homeos?.manifest_hash === PARTIAL_ROUTE.homeosManifestHash &&
    homeos?.package_policy_hash === PARTIAL_ROUTE.homeosPackagePolicyHash &&
    homeos?.status === 'RUNNING' && Number(homeos?.checkpoint_generation) === 1 &&
    homeos?.checkpoint_hash === homeosCheckpoint?.blob_hash &&
    homeosCheckpoint?.instance_id === PARTIAL_ROUTE.homeosInstanceId &&
    homeosCheckpoint?.version === PARTIAL_ROUTE.homeosVersion &&
    Number(homeosCheckpoint?.state_schema) === PARTIAL_ROUTE.homeosStateSchema &&
    Number(homeosCheckpoint?.generation) === 1 && !intero,
  'resident generations are not the exact partial R146 route cohort', 'R146_METAB_Q48_PARTIAL_ROUTE');
  assert(metabConsumer?.core_id === BASELINE.coreId && Number(metabConsumer?.required) === 0 &&
    Number(metabConsumer?.active) === 1 && Number(metabConsumer?.authority_epoch) === 0 &&
    metabConsumer?.checkpoint_hash === metab?.checkpoint_hash &&
    homeosConsumer?.core_id === 'HOMEOS' && Number(homeosConsumer?.required) === 0 &&
    Number(homeosConsumer?.active) === 1 && Number(homeosConsumer?.authority_epoch) === 0 &&
    homeosConsumer?.checkpoint_hash === null,
  'partial R146 consumers are not contained', 'R146_METAB_Q48_PARTIAL_ROUTE');
  assert(source.runtimeRevision === 128 && source.lastCommittedFrame >= BASELINE.acceptedFrame &&
    source.pending?.sampleFrame === source.lastCommittedFrame + 1 &&
    metabState?.activation?.targetRevision === 144 &&
    metabState?.activation?.fromVersion === BASELINE.version &&
    metabState?.sourceState?.lastAcceptedFrame === source.lastCommittedFrame &&
    metabState?.sourceState?.pendingEligible === null &&
    metabState?.sourceState?.pendingQuality === null &&
    metabState?.sourceState?.engineState?.outputSequence === '0' &&
    metabState?.emittedOutputSequence === '0' &&
    homeosState?.engineState?.frameIndex === 0 &&
    homeosState?.engineState?.outputSequence === '0' &&
    homeosState?.handledEvents === 0,
  'partial R146 capacity or checkpoint boundary changed', 'R146_METAB_Q48_PARTIAL_ROUTE');
  assert(repairDetail?.repairId === REPAIR.repairId &&
    repairDetail?.abandonedCount === 0 && repairDetail?.inventedBiologicalTime === false &&
    repairDetail?.authorityChanged === false &&
    metabRecoveryDetail?.residencyId === BASELINE.residencyId &&
    metabRecoveryDetail?.instanceId === BASELINE.instanceId &&
    metabRecoveryDetail?.version === PARTIAL_ROUTE.metabVersion &&
    metabRecoveryDetail?.checkpointHash === metab?.checkpoint_hash &&
    homeosBirthDetail?.residencyId === 'resident:homeos' &&
    homeosBirthDetail?.instanceId === PARTIAL_ROUTE.homeosInstanceId &&
    homeosBirthDetail?.version === PARTIAL_ROUTE.homeosVersion &&
    homeosBirthDetail?.checkpointHash === homeos?.checkpoint_hash,
  'partial R146 recovery lineage changed', 'R146_METAB_Q48_PARTIAL_ROUTE');
  assert(scalar(db, `SELECT COUNT(*) value FROM biological_deliveries
      WHERE consumer_id IN ('resident:metab','resident:homeos') AND status='PENDING'`) === 0 &&
    scalar(db, `SELECT COUNT(*) value FROM biological_outbox_intents
      WHERE producer_core_id IN ('METAB','HOMEOS') AND status='PENDING'`) === 0 &&
    scalar(db, `SELECT COUNT(*) value FROM authority
      WHERE core_id IN ('METAB','HOMEOS','INTERO')`) === 0,
  'partial R146 recovery has debt or authority', 'R146_METAB_Q48_PARTIAL_ROUTE');
  return { metab, homeos, metabCheckpoint, homeosCheckpoint, source };
}

function assertFinalHomeosCohort(db, databasePath, releaseRoot, { repaired = false } = {}) {
  assert(db.prepare('PRAGMA quick_check').get()?.quick_check === 'ok' &&
    metadataRevision(db) === BASELINE.runtimeRevision,
  'database is not the final R146 HOMEOS recovery boundary');
  const definition = validateFinalHomeosRelease(releaseRoot);
  const metab = db.prepare('SELECT * FROM resident_instances WHERE residency_id=?')
    .get(BASELINE.residencyId);
  const homeos = db.prepare('SELECT * FROM resident_instances WHERE residency_id=?')
    .get(FINAL_HOMEOS.residencyId);
  const intero = db.prepare("SELECT * FROM resident_instances WHERE residency_id='resident:intero'").get();
  const sourceCheckpoint = db.prepare(`SELECT * FROM resident_checkpoints
    WHERE residency_id=? AND generation=?`).get(
    FINAL_HOMEOS.residencyId, FINAL_HOMEOS.sourceCheckpointGeneration);
  const repairedCheckpoint = db.prepare(`SELECT * FROM resident_checkpoints
    WHERE residency_id=? AND generation=?`).get(
    FINAL_HOMEOS.residencyId, FINAL_HOMEOS.repairedCheckpointGeneration);
  const checkpoint = repaired ? repairedCheckpoint : sourceCheckpoint;
  const consumer = db.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?')
    .get(FINAL_HOMEOS.residencyId);
  const failure = db.prepare(`SELECT id,detail_json FROM recovery_records
    WHERE type='resident.resync-required' AND core_id=? ORDER BY id DESC LIMIT 1`)
    .get(FINAL_HOMEOS.coreId);
  const repair = db.prepare(`SELECT detail_json FROM recovery_records
    WHERE type='resident.implementation-repaired' AND core_id=? ORDER BY id DESC LIMIT 1`)
    .get(FINAL_HOMEOS.coreId);
  const pending = db.prepare(`SELECT d.sequence,d.status,e.topic,e.deduplication_key
    FROM biological_deliveries d JOIN biological_events e ON e.sequence=d.sequence
    WHERE d.consumer_id=? AND d.status='PENDING' ORDER BY d.sequence`)
    .all(FINAL_HOMEOS.residencyId);
  const publishedRows = db.prepare(`SELECT * FROM biological_outbox_intents
    WHERE producer_event_id IN (?,?) ORDER BY fabric_sequence`).all(
    ...FINAL_HOMEOS.publishedIntents.map(value => value.producerEventId));
  assert(publishedRows.length === FINAL_HOMEOS.publishedIntents.length,
    'exact R146 published HOMEOS source intents are absent', 'R146_HOMEOS_ROUTE_OUTBOX');
  const publishedPair = publishedRows.map((row, index) => ({
    topic: row.topic,
    payload: verifiedOutboxIntent(row, FINAL_HOMEOS.publishedIntents[index]).payload
  }));
  const retainedEvents = scalar(db, `SELECT COUNT(*) value FROM biological_events
    WHERE sequence IN (?,?)`, ...FINAL_HOMEOS.pendingSequences);
  const capacity = db.prepare('SELECT json,sha256 FROM metadata WHERE key=?')
    .get(BASELINE.capacityMetadataKey);
  const fetusConsumer = db.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?')
    .get(FINAL_HOMEOS.fetus.consumerId);
  const fetusAuthority = db.prepare("SELECT * FROM authority WHERE core_id='fetus-legacy'").get();
  const fetusCheckpoint = db.prepare(`SELECT * FROM checkpoints WHERE core_id='fetus-legacy'
    ORDER BY generation DESC LIMIT 1`).get();
  const fetusDemotion = db.prepare(`SELECT id,detail_json FROM recovery_records
    WHERE type='biological.consumer-demoted' AND core_id='fetus-legacy'
    ORDER BY id DESC LIMIT 1`).get();
  const fetusResolution = db.prepare(`SELECT id,detail_json FROM recovery_records
    WHERE type='biological.consumer-resynchronized' AND core_id='fetus-legacy'
    ORDER BY id DESC LIMIT 1`).get();
  let failureDetail = null, repairDetail = null, fetusDemotionDetail = null;
  let fetusResolutionDetail = null, source = null;
  try { failureDetail = JSON.parse(failure?.detail_json || 'null'); } catch {}
  try { repairDetail = JSON.parse(repair?.detail_json || 'null'); } catch {}
  try { fetusDemotionDetail = JSON.parse(fetusDemotion?.detail_json || 'null'); } catch {}
  try { fetusResolutionDetail = JSON.parse(fetusResolution?.detail_json || 'null'); } catch {}
  try { source = JSON.parse(capacity?.json || 'null'); } catch {}
  const deliveryMode = repaired && repairDetail?.deliveryMode
    ? repairDetail.deliveryMode
    : pending.length === FINAL_HOMEOS.pendingSequences.length
      ? 'retained'
      : pending.length === 0 && retainedEvents === 0
        ? 'pruned'
        : null;
  assert(['retained', 'pruned'].includes(deliveryMode),
    'HOMEOS retained-delivery state is neither exact nor recoverable', 'R146_HOMEOS_ROUTE_PENDING');
  const expectedModuleHash = repaired
    ? FINAL_HOMEOS.targetModuleHash : FINAL_HOMEOS.sourceModuleHash;
  const expectedPolicyHash = repaired
    ? FINAL_HOMEOS.targetPackagePolicyHash : FINAL_HOMEOS.sourcePackagePolicyHash;
  const expectedGeneration = repaired
    ? FINAL_HOMEOS.repairedCheckpointGeneration : FINAL_HOMEOS.sourceCheckpointGeneration;
  assert(metab?.instance_id === BASELINE.instanceId &&
    metab?.version === PARTIAL_ROUTE.metabVersion &&
    Number(metab?.state_schema) === PARTIAL_ROUTE.metabStateSchema &&
    metab?.module_relative_path === PARTIAL_ROUTE.metabModuleRelativePath &&
    metab?.module_hash === PARTIAL_ROUTE.metabModuleHash &&
    metab?.manifest_hash === PARTIAL_ROUTE.metabManifestHash &&
    metab?.package_policy_hash === PARTIAL_ROUTE.metabPackagePolicyHash &&
    metab?.status === 'RUNNING' && !intero,
  'final R146 METAB/HOMEOS cohort changed', 'R146_HOMEOS_ROUTE_RESIDENT');
  assert(homeos?.core_id === FINAL_HOMEOS.coreId &&
    homeos?.instance_id === FINAL_HOMEOS.instanceId &&
    homeos?.version === FINAL_HOMEOS.version &&
    Number(homeos?.state_schema) === FINAL_HOMEOS.stateSchema &&
    homeos?.module_relative_path === FINAL_HOMEOS.moduleRelativePath &&
    homeos?.module_hash === expectedModuleHash &&
    homeos?.manifest_hash === FINAL_HOMEOS.manifestHash &&
    homeos?.package_policy_hash === expectedPolicyHash &&
    homeos?.status === 'RESYNC_REQUIRED' &&
    Number(homeos?.checkpoint_generation) === expectedGeneration &&
    homeos?.checkpoint_hash === checkpoint?.blob_hash,
  'HOMEOS resident is not the exact final R146 repair cohort', 'R146_HOMEOS_ROUTE_RESIDENT');
  assert(sourceCheckpoint?.checkpoint_id === FINAL_HOMEOS.sourceCheckpointId &&
    sourceCheckpoint?.instance_id === FINAL_HOMEOS.instanceId &&
    sourceCheckpoint?.version === FINAL_HOMEOS.version &&
    Number(sourceCheckpoint?.state_schema) === FINAL_HOMEOS.stateSchema &&
    sourceCheckpoint?.blob_hash === FINAL_HOMEOS.sourceCheckpointHash &&
    Number(sourceCheckpoint?.byte_length) === FINAL_HOMEOS.sourceCheckpointBytes &&
    Number(sourceCheckpoint?.input_cursor) === FINAL_HOMEOS.sourceInputCursor,
  'HOMEOS source checkpoint changed', 'R146_HOMEOS_ROUTE_CHECKPOINT');
  if (repaired) {
    const expectedRepairedHash = deliveryMode === 'retained'
      ? FINAL_HOMEOS.repairedCheckpointHash : repairDetail?.repairedCheckpointHash;
    const expectedRepairedBytes = deliveryMode === 'retained'
      ? FINAL_HOMEOS.repairedCheckpointBytes : Number(repairDetail?.repairedCheckpointBytes);
    const expectedInputCursor = deliveryMode === 'retained'
      ? FINAL_HOMEOS.sourceInputCursor : FINAL_HOMEOS.prunedConsumerCursor;
    assert(repairedCheckpoint?.checkpoint_id === FINAL_HOMEOS.repairedCheckpointId &&
      repairedCheckpoint?.instance_id === FINAL_HOMEOS.instanceId &&
      repairedCheckpoint?.version === FINAL_HOMEOS.version &&
      Number(repairedCheckpoint?.state_schema) === FINAL_HOMEOS.stateSchema &&
      Number(repairedCheckpoint?.generation) === FINAL_HOMEOS.repairedCheckpointGeneration &&
      repairedCheckpoint?.blob_hash === expectedRepairedHash &&
      Number(repairedCheckpoint?.byte_length) === expectedRepairedBytes &&
      Number(repairedCheckpoint?.input_cursor) === expectedInputCursor &&
      repairDetail?.repairId === FINAL_HOMEOS.repairId &&
      repairDetail?.deliveryMode === deliveryMode &&
      repairDetail?.sourceCheckpointHash === FINAL_HOMEOS.sourceCheckpointHash &&
      repairDetail?.repairedCheckpointHash === repairedCheckpoint.blob_hash &&
      repairDetail?.abandonedCount === 0 &&
      repairDetail?.inventedBiologicalTime === false &&
      repairDetail?.authorityChanged === false,
    'HOMEOS repaired checkpoint evidence changed', 'R146_HOMEOS_ROUTE_CHECKPOINT');
  }
  const expectedConsumerCursor = repaired && deliveryMode === 'pruned'
    ? FINAL_HOMEOS.prunedConsumerCursor : FINAL_HOMEOS.consumerCursor;
  assert(consumer?.core_id === FINAL_HOMEOS.coreId && Number(consumer?.required) === 0 &&
    Number(consumer?.active) === 0 && Number(consumer?.cursor) === expectedConsumerCursor &&
    Number(consumer?.authority_epoch) === 0 && consumer?.topics_sha256 === FINAL_HOMEOS.consumerTopicsHash &&
    consumer?.checkpoint_hash === checkpoint?.blob_hash,
  'HOMEOS consumer is not contained', 'R146_HOMEOS_ROUTE_CONSUMER');
  assert((deliveryMode === 'retained' && retainedEvents === 2 &&
    pending.length === 2 && pending.every((row, index) =>
      Number(row.sequence) === FINAL_HOMEOS.pendingSequences[index] && row.status === 'PENDING' &&
      row.topic === FINAL_HOMEOS.pendingTopics[index] &&
      row.deduplication_key === FINAL_HOMEOS.pendingDeduplicationKeys[index])) ||
    (deliveryMode === 'pruned' && retainedEvents === 0 && pending.length === 0),
  'HOMEOS retained delivery pair changed', 'R146_HOMEOS_ROUTE_PENDING');
  assert(Number(failure?.id) === FINAL_HOMEOS.failureRecordId &&
    failureDetail?.residencyId === FINAL_HOMEOS.residencyId &&
    failureDetail?.sequence === FINAL_HOMEOS.pendingSequences[0] &&
    failureDetail?.topic === FINAL_HOMEOS.pendingTopics[0] &&
    failureDetail?.code === 'P1_RESIDENT_PENDING_BOUND',
  'HOMEOS route-boundary failure identity changed', 'R146_HOMEOS_ROUTE_FAILURE');
  const movingMetabOutbox = assertMovingMetabOutboxContained(db);
  assert(capacity && sha256(capacity.json) === capacity.sha256 && source?.pending === null &&
    scalar(db, `SELECT COUNT(*) value FROM authority
      WHERE core_id IN ('METAB','HOMEOS','INTERO')`) === 0,
  'final R146 source or authority containment changed', 'R146_HOMEOS_ROUTE_CONTAINMENT');
  const fetusAssignedAfterCursor = scalar(db, `SELECT COUNT(*) value FROM biological_deliveries
    WHERE consumer_id=? AND sequence>?`, FINAL_HOMEOS.fetus.consumerId,
  FINAL_HOMEOS.fetus.consumerCursor);
  const fetusCommon = fetusConsumer?.core_id === 'fetus-legacy' &&
    Number(fetusConsumer?.required) === 0 && Number(fetusConsumer?.active) === 0 &&
    fetusConsumer?.topics_json === '[]' &&
    fetusConsumer?.topics_sha256 === FINAL_HOMEOS.fetus.topicsHash &&
    Number(fetusConsumer?.authority_epoch) === FINAL_HOMEOS.fetus.authorityEpoch &&
    fetusAuthority?.instance_id === FINAL_HOMEOS.fetus.instanceId &&
    fetusAuthority?.version === FINAL_HOMEOS.fetus.version &&
    Number(fetusAuthority?.epoch) === FINAL_HOMEOS.fetus.authorityEpoch &&
    fetusAuthority?.checkpoint_hash === FINAL_HOMEOS.fetus.checkpointHash &&
    fetusCheckpoint?.instance_id === FINAL_HOMEOS.fetus.instanceId &&
    fetusCheckpoint?.version === FINAL_HOMEOS.fetus.version &&
    Number(fetusCheckpoint?.generation) === FINAL_HOMEOS.fetus.checkpointGeneration &&
    fetusCheckpoint?.blob_hash === FINAL_HOMEOS.fetus.checkpointHash &&
    Number(fetusCheckpoint?.byte_length) === FINAL_HOMEOS.fetus.checkpointBytes &&
    Number(fetusDemotion?.id) === FINAL_HOMEOS.fetus.demotionId &&
    fetusDemotionDetail?.consumerId === FINAL_HOMEOS.fetus.consumerId &&
    fetusDemotionDetail?.pending === FINAL_HOMEOS.fetus.pendingAtDemotion &&
    fetusDemotionDetail?.maximumDebt === FINAL_HOMEOS.fetus.maximumDebt &&
    fetusDemotionDetail?.resynchronizationRequired === true &&
    scalar(db, `SELECT COUNT(*) value FROM biological_deliveries
      WHERE consumer_id=? AND status='PENDING'`, FINAL_HOMEOS.fetus.consumerId) === 0 &&
    fetusAssignedAfterCursor === 0;
  const fetusUnresolved = fetusCommon &&
    Number(fetusConsumer?.cursor) === FINAL_HOMEOS.fetus.consumerCursor &&
    fetusConsumer?.checkpoint_hash === FINAL_HOMEOS.fetus.priorConsumerCheckpointHash &&
    Number(fetusResolution?.id) === FINAL_HOMEOS.fetus.priorResolutionId &&
    fetusResolutionDetail?.demotionId === FINAL_HOMEOS.fetus.priorDemotionId;
  const fetusResolved = fetusCommon &&
    Number(fetusResolution?.id) > FINAL_HOMEOS.fetus.demotionId &&
    fetusResolutionDetail?.cohort === 'r146-fetus-empty-input-continuity-v1' &&
    fetusResolutionDetail?.demotionId === FINAL_HOMEOS.fetus.demotionId &&
    fetusResolutionDetail?.consumerId === FINAL_HOMEOS.fetus.consumerId &&
    fetusResolutionDetail?.fromCursor === FINAL_HOMEOS.fetus.consumerCursor &&
    Number.isSafeInteger(fetusResolutionDetail?.toCursor) &&
    fetusResolutionDetail.toCursor >= FINAL_HOMEOS.fetus.consumerCursor &&
    Number(fetusConsumer?.cursor) === fetusResolutionDetail.toCursor &&
    fetusConsumer?.checkpoint_hash === FINAL_HOMEOS.fetus.checkpointHash &&
    Array.isArray(fetusResolutionDetail?.inputs) && fetusResolutionDetail.inputs.length === 0 &&
    fetusResolutionDetail?.checkpointHash === FINAL_HOMEOS.fetus.checkpointHash &&
    fetusResolutionDetail?.checkpointGeneration === FINAL_HOMEOS.fetus.checkpointGeneration &&
    fetusResolutionDetail?.checkpointBytesChanged === false &&
    fetusResolutionDetail?.biologicalStateChanged === false &&
    fetusResolutionDetail?.physiologyApplied === 0 &&
    fetusResolutionDetail?.abandonedCount === 0 &&
    fetusResolutionDetail?.inventedBiologicalTime === false &&
    fetusResolutionDetail?.authorityChanged === false &&
    fetusResolutionDetail?.runtimeRevision === BASELINE.runtimeRevision;
  assert(fetusUnresolved || fetusResolved,
  'fetus empty-input continuity cohort changed', 'R146_HOMEOS_FETUS_CONTINUITY');
  const state = JSON.parse(readBlob(databasePath, checkpoint));
  if (repaired) {
    definition.validateState(state);
    assert(state.neutralState?.engineState?.frameIndex ===
        (deliveryMode === 'retained' ? 98024 : 98025) &&
      state.neutralState?.engineState?.outputSequence === '0' &&
      Object.keys(state.neutralState?.pendingAvailability || {}).length === 0 &&
      Object.keys(state.neutralState?.pendingReserve || {}).length === 0,
    'HOMEOS repaired route-boundary state changed', 'R146_HOMEOS_ROUTE_CHECKPOINT');
  } else {
    definition.repairExactR146RouteBoundaryState(state);
  }
  return { metab, homeos, checkpoint, sourceCheckpoint, repairedCheckpoint, consumer, state,
    definition, deliveryMode, publishedPair, movingMetabOutbox };
}

function repairIncompleteCheckpointState(state, definition, baseline = BASELINE) {
  definition.validateState(state);
  assert(state.lastAcceptedFrame === baseline.acceptedFrame &&
    state.pendingEligible?.sampleFrame === baseline.pendingFrame &&
    state.pendingQuality === null &&
    state.engineState?.frameIndex === baseline.acceptedFrame,
  'METAB checkpoint is not the exact incomplete pair', 'R146_METAB_Q48_CHECKPOINT');
  const repairedState = { ...state, pendingEligible: null, pendingQuality: null };
  definition.validateState(repairedState);
  return repairedState;
}
function prepareRepair(databasePath, releaseRoot) {
  const definition = validateRelease(releaseRoot);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  db.exec('PRAGMA query_only=ON');
  try {
    const value = assertBaseline(db);
    assert(value.capacity.sha256 === BASELINE.capacityMetadataSha256,
      'METAB capacity source identity changed', 'R146_METAB_Q48_SOURCE');
    const state = JSON.parse(readBlob(databasePath, value.checkpoint));
    const repairedState = repairIncompleteCheckpointState(state, definition);
    return { value, repairedState, repairedSource: { ...value.source, pending: null } };
  } finally { db.close(); }
}
function ensureBlob(databasePath, state) {
  const bytes = Buffer.from(JSON.stringify(state)), hash = sha256(bytes);
  const directory = path.join(path.dirname(databasePath), 'blobs', 'sha256', hash.slice(0, 2));
  const target = path.join(directory, hash);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(target)) {
    const temporary = path.join(directory, `.${hash}.${process.pid}.tmp`);
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, target);
  }
  assert(sha256(fs.readFileSync(target)) === hash, 'repaired checkpoint blob verification failed');
  return { hash, bytes: bytes.length };
}
function prepareFinalHomeosRepair(databasePath, releaseRoot) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  db.exec('PRAGMA query_only=ON');
  try {
    const current = assertFinalHomeosCohort(db, databasePath, releaseRoot);
    const boundary = current.definition.repairExactR146RouteBoundaryState(current.state);
    const repaired = current.deliveryMode === 'pruned'
      ? current.definition.applyExactR146PrunedOutboxPair(boundary.state, current.publishedPair)
      : boundary;
    return { current, repaired };
  } finally { db.close(); }
}
function preflightRepair({ databasePath, releaseRoot }) {
  validateRelease(releaseRoot);
  const probe = new DatabaseSync(databasePath, { readOnly: true });
  probe.exec('PRAGMA query_only=ON');
  try {
    const resident = probe.prepare('SELECT module_hash FROM resident_instances WHERE residency_id=?')
      .get(BASELINE.residencyId);
    const homeos = probe.prepare('SELECT module_hash,version,status FROM resident_instances WHERE residency_id=?')
      .get(FINAL_HOMEOS.residencyId);
    if (homeos?.version === FINAL_HOMEOS.version &&
        [FINAL_HOMEOS.sourceModuleHash, FINAL_HOMEOS.targetModuleHash].includes(homeos.module_hash)) {
      const repaired = homeos.module_hash === FINAL_HOMEOS.targetModuleHash;
      const current = assertFinalHomeosCohort(
        probe, databasePath, releaseRoot, { repaired });
      const boundary = repaired
        ? null : current.definition.repairExactR146RouteBoundaryState(current.state);
      const projected = repaired
        ? null
        : current.deliveryMode === 'pruned'
          ? current.definition.applyExactR146PrunedOutboxPair(boundary.state, current.publishedPair)
          : boundary;
      return Object.freeze({
        result: repaired ? 'FINAL_HOMEOS_ALREADY_REPAIRED' :
          current.deliveryMode === 'pruned'
            ? 'FINAL_HOMEOS_PRUNED_RECOVERY_READY'
            : 'FINAL_HOMEOS_RECOVERY_READY',
        repairId: FINAL_HOMEOS.repairId,
        sourceCheckpointHash: FINAL_HOMEOS.sourceCheckpointHash,
        repairedCheckpointHash: repaired
          ? current.repairedCheckpoint.blob_hash
          : sha256(Buffer.from(JSON.stringify(projected.state))),
        deliveryMode: current.deliveryMode,
        pendingDeliveries: current.deliveryMode === 'retained'
          ? FINAL_HOMEOS.pendingSequences.length : 0,
        retainedPairCount: repaired
          ? 16
          : current.deliveryMode === 'retained'
            ? projected.evidence.retainedPairCount
            : 16,
        abandonedCount: 0,
        inventedBiologicalTime: false,
        authorityOwned: false,
        fetusEmptyInputContinuityReady: true
      });
    }
    if (resident?.module_hash === REPAIR.moduleHash) {
      const current = assertBaseline(probe, { repaired: true });
      const state = JSON.parse(readBlob(databasePath, current.repairCheckpoint));
      validateRelease(releaseRoot).validateState(state);
      return Object.freeze({ result: 'ALREADY_APPLIED', repairId: REPAIR.repairId,
        repairedCheckpointHash: current.repairCheckpoint.blob_hash,
        acceptedFrame: BASELINE.acceptedFrame, abandonedCount: 0,
        biologicalAcceptedStateChanged: false, inventedBiologicalTime: false,
        authorityOwned: false });
    }
    if (resident?.module_hash === PARTIAL_ROUTE.metabModuleHash) {
      const current = assertPartialRouteCohort(probe, databasePath);
      return Object.freeze({ result: 'PARTIAL_ROUTE_READY', repairId: REPAIR.repairId,
        repairedCheckpointHash: current.metabCheckpoint.blob_hash,
        acceptedFrame: current.source.lastCommittedFrame, pendingFrame: current.source.pending.sampleFrame,
        abandonedCount: 0, biologicalAcceptedStateChanged: false,
        inventedBiologicalTime: false, authorityOwned: false });
    }
  } finally { probe.close(); }
  const { repairedState } = prepareRepair(databasePath, releaseRoot);
  return Object.freeze({ result: 'PASS', repairId: REPAIR.repairId,
    repairedCheckpointHash: sha256(Buffer.from(JSON.stringify(repairedState))),
    acceptedFrame: BASELINE.acceptedFrame, abandonedCount: 0,
    biologicalAcceptedStateChanged: false, inventedBiologicalTime: false, authorityOwned: false });
}
function applyFinalHomeosRepair({ databasePath, releaseRoot, now = () => new Date().toISOString() }) {
  const prepared = prepareFinalHomeosRepair(databasePath, releaseRoot);
  const blob = ensureBlob(databasePath, prepared.repaired.state);
  assert(prepared.current.deliveryMode === 'pruned' ||
    (blob.hash === FINAL_HOMEOS.repairedCheckpointHash &&
    blob.bytes === FINAL_HOMEOS.repairedCheckpointBytes),
  'HOMEOS repaired checkpoint projection changed', 'R146_HOMEOS_ROUTE_CHECKPOINT');
  const repairedInputCursor = prepared.current.deliveryMode === 'pruned'
    ? FINAL_HOMEOS.prunedConsumerCursor : FINAL_HOMEOS.sourceInputCursor;
  const repairedConsumerCursor = prepared.current.deliveryMode === 'pruned'
    ? FINAL_HOMEOS.prunedConsumerCursor : FINAL_HOMEOS.consumerCursor;
  const at = now();
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  try {
    assertFinalHomeosCohort(db, databasePath, releaseRoot);
    db.prepare(`INSERT INTO resident_checkpoints(checkpoint_id,residency_id,instance_id,version,state_schema,
      generation,blob_hash,byte_length,input_cursor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      FINAL_HOMEOS.repairedCheckpointId, FINAL_HOMEOS.residencyId, FINAL_HOMEOS.instanceId,
      FINAL_HOMEOS.version, FINAL_HOMEOS.stateSchema, FINAL_HOMEOS.repairedCheckpointGeneration,
      blob.hash, blob.bytes, repairedInputCursor, at);
    const residentChanged = db.prepare(`UPDATE resident_instances SET module_hash=?,package_policy_hash=?,
      checkpoint_generation=?,checkpoint_hash=?,updated_at=? WHERE residency_id=? AND instance_id=? AND
      version=? AND state_schema=? AND module_relative_path=? AND module_hash=? AND manifest_hash=? AND
      package_policy_hash=? AND checkpoint_generation=? AND checkpoint_hash=? AND status='RESYNC_REQUIRED'`)
      .run(FINAL_HOMEOS.targetModuleHash, FINAL_HOMEOS.targetPackagePolicyHash,
        FINAL_HOMEOS.repairedCheckpointGeneration, blob.hash, at, FINAL_HOMEOS.residencyId,
        FINAL_HOMEOS.instanceId, FINAL_HOMEOS.version, FINAL_HOMEOS.stateSchema,
        FINAL_HOMEOS.moduleRelativePath, FINAL_HOMEOS.sourceModuleHash, FINAL_HOMEOS.manifestHash,
        FINAL_HOMEOS.sourcePackagePolicyHash, FINAL_HOMEOS.sourceCheckpointGeneration,
        FINAL_HOMEOS.sourceCheckpointHash);
    assert(residentChanged.changes === 1,
      'HOMEOS implementation repair lost its resident fence', 'R146_HOMEOS_ROUTE_ATOMIC');
    const consumerChanged = db.prepare(`UPDATE biological_consumers SET cursor=?,checkpoint_hash=?,updated_at=?
      WHERE consumer_id=? AND core_id=? AND active=0 AND required=0 AND cursor=? AND authority_epoch=0 AND
      topics_sha256=? AND checkpoint_hash=?`).run(repairedConsumerCursor, blob.hash, at,
        FINAL_HOMEOS.residencyId, FINAL_HOMEOS.coreId, FINAL_HOMEOS.consumerCursor,
        FINAL_HOMEOS.consumerTopicsHash,
        FINAL_HOMEOS.sourceCheckpointHash);
    assert(consumerChanged.changes === 1,
      'HOMEOS implementation repair lost its consumer fence', 'R146_HOMEOS_ROUTE_ATOMIC');
    db.prepare(`INSERT INTO recovery_records(type,core_id,detail_json,created_at) VALUES(?,?,?,?)`).run(
      'resident.implementation-repaired', FINAL_HOMEOS.coreId, stableStringify({
        repairId: FINAL_HOMEOS.repairId,
        residencyId: FINAL_HOMEOS.residencyId,
        instanceId: FINAL_HOMEOS.instanceId,
        fromModuleHash: FINAL_HOMEOS.sourceModuleHash,
        toModuleHash: FINAL_HOMEOS.targetModuleHash,
        fromPackagePolicyHash: FINAL_HOMEOS.sourcePackagePolicyHash,
        toPackagePolicyHash: FINAL_HOMEOS.targetPackagePolicyHash,
        sourceCheckpointHash: FINAL_HOMEOS.sourceCheckpointHash,
        repairedCheckpointHash: blob.hash,
        fromCheckpointGeneration: FINAL_HOMEOS.sourceCheckpointGeneration,
        toCheckpointGeneration: FINAL_HOMEOS.repairedCheckpointGeneration,
        repairedCheckpointBytes: blob.bytes,
        deliveryMode: prepared.current.deliveryMode,
        pendingSequences: [...FINAL_HOMEOS.pendingSequences],
        ...prepared.repaired.evidence,
        sourceIntentSha256: FINAL_HOMEOS.publishedIntents.map(value => value.intentSha256),
        pendingDeliveriesPreserved: prepared.current.deliveryMode === 'retained'
          ? FINAL_HOMEOS.pendingSequences.length : 0,
        prunedDeliveriesRecovered: prepared.current.deliveryMode === 'pruned'
          ? FINAL_HOMEOS.pendingSequences.length : 0,
        resourceLimitsChanged: false,
        runtimeRevision: BASELINE.runtimeRevision
      }), at);
    assertFinalHomeosCohort(db, databasePath, releaseRoot, { repaired: true });
    db.exec('COMMIT');
    return Object.freeze({
      result: 'FINAL_HOMEOS_REPAIRED',
      repairId: FINAL_HOMEOS.repairId,
      repairedCheckpointHash: blob.hash,
      deliveryMode: prepared.current.deliveryMode,
      retainedPairCount: prepared.current.deliveryMode === 'retained'
        ? prepared.repaired.evidence.retainedPairCount : 16,
      pendingDeliveriesPreserved: prepared.current.deliveryMode === 'retained'
        ? FINAL_HOMEOS.pendingSequences.length : 0,
      prunedDeliveriesRecovered: prepared.current.deliveryMode === 'pruned'
        ? FINAL_HOMEOS.pendingSequences.length : 0,
      abandonedCount: 0,
      inventedBiologicalTime: false,
      authorityChanged: false
    });
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}
function applyRepair({ databasePath, releaseRoot, now = () => new Date().toISOString() }) {
  validateRelease(releaseRoot);
  const modeProbe = new DatabaseSync(databasePath, { readOnly: true });
  modeProbe.exec('PRAGMA query_only=ON');
  const homeosMode = modeProbe.prepare(
    'SELECT module_hash,version FROM resident_instances WHERE residency_id=?'
  ).get(FINAL_HOMEOS.residencyId);
  modeProbe.close();
  if (homeosMode?.version === FINAL_HOMEOS.version &&
      homeosMode?.module_hash === FINAL_HOMEOS.targetModuleHash) {
    const verified = new DatabaseSync(databasePath, { readOnly: true });
    verified.exec('PRAGMA query_only=ON');
    try {
      const current = assertFinalHomeosCohort(
        verified, databasePath, releaseRoot, { repaired: true });
      return Object.freeze({ result: 'FINAL_HOMEOS_ALREADY_REPAIRED', repairId: FINAL_HOMEOS.repairId,
        repairedCheckpointHash: current.repairedCheckpoint.blob_hash,
        abandonedCount: 0, inventedBiologicalTime: false });
    } finally { verified.close(); }
  }
  if (homeosMode?.version === FINAL_HOMEOS.version &&
      homeosMode?.module_hash === FINAL_HOMEOS.sourceModuleHash) {
    return applyFinalHomeosRepair({ databasePath, releaseRoot, now });
  }
  const probe = new DatabaseSync(databasePath, { readOnly: true });
  probe.exec('PRAGMA query_only=ON');
  try {
    const resident = probe.prepare('SELECT module_hash FROM resident_instances WHERE residency_id=?')
      .get(BASELINE.residencyId);
    if (resident?.module_hash === REPAIR.moduleHash) {
      const current = assertBaseline(probe, { repaired: true });
      return Object.freeze({ result: 'ALREADY_APPLIED', repairId: REPAIR.repairId,
        repairedCheckpointHash: current.repairCheckpoint.blob_hash,
        abandonedCount: 0, inventedBiologicalTime: false });
    }
    if (resident?.module_hash === PARTIAL_ROUTE.metabModuleHash) {
      const current = assertPartialRouteCohort(probe, databasePath);
      return Object.freeze({ result: 'PARTIAL_ROUTE_ALREADY_APPLIED', repairId: REPAIR.repairId,
        repairedCheckpointHash: current.metabCheckpoint.blob_hash,
        acceptedFrame: current.source.lastCommittedFrame, pendingFrame: current.source.pending.sampleFrame,
        abandonedCount: 0, inventedBiologicalTime: false });
    }
  } finally { probe.close(); }
  const prepared = prepareRepair(databasePath, releaseRoot);
  const blob = ensureBlob(databasePath, prepared.repairedState);
  const sourceJson = JSON.stringify(prepared.repairedSource), sourceHash = sha256(sourceJson);
  const mirrorJson = `${JSON.stringify(prepared.repairedSource, null, 2)}\n`, at = now();
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  try {
    assertBaseline(db);
    db.prepare(`INSERT INTO resident_checkpoints(checkpoint_id,residency_id,instance_id,version,state_schema,
      generation,blob_hash,byte_length,input_cursor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      REPAIR.checkpointId, BASELINE.residencyId, BASELINE.instanceId, BASELINE.version,
      BASELINE.stateSchema, REPAIR.checkpointGeneration, blob.hash, blob.bytes, BASELINE.inputCursor, at);
    const updated = db.prepare(`UPDATE resident_instances SET module_hash=?,package_policy_hash=?,
      checkpoint_generation=?,checkpoint_hash=?,updated_at=? WHERE residency_id=? AND instance_id=? AND
      module_hash=? AND package_policy_hash=? AND checkpoint_generation=? AND checkpoint_hash=? AND status='RESYNC_REQUIRED'`)
      .run(REPAIR.moduleHash, REPAIR.packagePolicyHash, REPAIR.checkpointGeneration, blob.hash, at,
        BASELINE.residencyId, BASELINE.instanceId, BASELINE.moduleHash, BASELINE.packagePolicyHash,
        BASELINE.checkpointGeneration, BASELINE.checkpointHash);
    assert(updated.changes === 1, 'METAB implementation repair lost its resident fence');
    assert(db.prepare(`UPDATE biological_consumers SET checkpoint_hash=?,updated_at=? WHERE consumer_id=? AND
      active=0 AND required=0 AND cursor=? AND authority_epoch=0 AND checkpoint_hash=?`).run(
      blob.hash, at, BASELINE.residencyId, BASELINE.inputCursor, BASELINE.checkpointHash).changes === 1,
    'METAB implementation repair lost its consumer fence');
    assert(db.prepare('UPDATE metadata SET json=?,sha256=?,updated_at=? WHERE key=? AND sha256=?').run(
      sourceJson, sourceHash, at, BASELINE.capacityMetadataKey, BASELINE.capacityMetadataSha256).changes === 1,
    'METAB capacity source compare-and-swap failed');
    db.prepare(`INSERT INTO pending_metadata_mirrors(key,relative_path,json,sha256,created_at)
      VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET relative_path=excluded.relative_path,json=excluded.json,
      sha256=excluded.sha256,created_at=excluded.created_at`).run(BASELINE.capacityMetadataKey,
      'life/p1-r0-metab-capacity-source.json', mirrorJson, sha256(mirrorJson), at);
    db.prepare(`INSERT INTO recovery_records(type,core_id,detail_json,created_at) VALUES(?,?,?,?)`).run(
      'resident.implementation-repaired', BASELINE.coreId, stableStringify({
        repairId: REPAIR.repairId, residencyId: BASELINE.residencyId, instanceId: BASELINE.instanceId,
        fromModuleHash: BASELINE.moduleHash, toModuleHash: REPAIR.moduleHash,
        fromPackagePolicyHash: BASELINE.packagePolicyHash, toPackagePolicyHash: REPAIR.packagePolicyHash,
        sourceCheckpointHash: BASELINE.checkpointHash, repairedCheckpointHash: blob.hash,
        fromCheckpointGeneration: BASELINE.checkpointGeneration,
        toCheckpointGeneration: REPAIR.checkpointGeneration, acceptedFrame: BASELINE.acceptedFrame,
        discardedPartialFrame: BASELINE.pendingFrame, discardedPartialInputs: 1,
        capacitySourceBeforeJson: prepared.value.capacity.json,
        capacitySourceBeforeSha256: prepared.value.capacity.sha256,
        biologicalAcceptedStateChanged: false, checkpointBytesChanged: true,
        abandonedCount: 0, inventedBiologicalTime: false, authorityChanged: false,
        resourceLimitsChanged: false, runtimeRevision: BASELINE.runtimeRevision
      }), at);
    assertBaseline(db, { repaired: true });
    db.exec('COMMIT');
    return Object.freeze({ result: 'APPLIED', repairId: REPAIR.repairId,
      repairedCheckpointHash: blob.hash, abandonedCount: 0, inventedBiologicalTime: false });
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}
function rollbackFinalHomeosRepair({ databasePath, releaseRoot, now = () => new Date().toISOString() }) {
  validateFinalHomeosRelease(releaseRoot);
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  try {
    const current = assertFinalHomeosCohort(db, databasePath, releaseRoot, { repaired: true });
    assert(scalar(db, `SELECT COUNT(*) value FROM resident_checkpoints
      WHERE residency_id=? AND generation>?`, FINAL_HOMEOS.residencyId,
    FINAL_HOMEOS.repairedCheckpointGeneration) === 0,
    'HOMEOS advanced beyond rollback fence', 'R146_HOMEOS_ROUTE_ROLLBACK');
    const at = now();
    assert(db.prepare(`UPDATE resident_instances SET module_hash=?,package_policy_hash=?,
      checkpoint_generation=?,checkpoint_hash=?,updated_at=? WHERE residency_id=? AND instance_id=? AND
      module_hash=? AND package_policy_hash=? AND checkpoint_generation=? AND checkpoint_hash=? AND
      status='RESYNC_REQUIRED'`).run(FINAL_HOMEOS.sourceModuleHash,
      FINAL_HOMEOS.sourcePackagePolicyHash, FINAL_HOMEOS.sourceCheckpointGeneration,
      FINAL_HOMEOS.sourceCheckpointHash, at, FINAL_HOMEOS.residencyId, FINAL_HOMEOS.instanceId,
      FINAL_HOMEOS.targetModuleHash, FINAL_HOMEOS.targetPackagePolicyHash,
      FINAL_HOMEOS.repairedCheckpointGeneration, current.repairedCheckpoint.blob_hash).changes === 1,
    'HOMEOS rollback lost its resident fence', 'R146_HOMEOS_ROUTE_ROLLBACK');
    const repairedConsumerCursor = current.deliveryMode === 'pruned'
      ? FINAL_HOMEOS.prunedConsumerCursor : FINAL_HOMEOS.consumerCursor;
    assert(db.prepare(`UPDATE biological_consumers SET cursor=?,checkpoint_hash=?,updated_at=?
      WHERE consumer_id=? AND active=0 AND required=0 AND cursor=? AND authority_epoch=0 AND
      checkpoint_hash=?`).run(FINAL_HOMEOS.consumerCursor, FINAL_HOMEOS.sourceCheckpointHash, at,
      FINAL_HOMEOS.residencyId, repairedConsumerCursor, current.repairedCheckpoint.blob_hash).changes === 1,
    'HOMEOS rollback lost its consumer fence', 'R146_HOMEOS_ROUTE_ROLLBACK');
    db.prepare('DELETE FROM resident_checkpoints WHERE residency_id=? AND generation=?')
      .run(FINAL_HOMEOS.residencyId, FINAL_HOMEOS.repairedCheckpointGeneration);
    db.prepare(`INSERT INTO recovery_records(type,core_id,detail_json,created_at) VALUES(?,?,?,?)`).run(
      'resident.implementation-repair-rolled-back', FINAL_HOMEOS.coreId,
      stableStringify({ repairId: FINAL_HOMEOS.repairId, deliveryMode: current.deliveryMode,
        pendingDeliveriesPreserved: current.deliveryMode === 'retained' ? 2 : 0,
        prunedDeliveriesRecovered: current.deliveryMode === 'pruned' ? 2 : 0,
        abandonedCount: 0, inventedBiologicalTime: false, authorityChanged: false }), at);
    assertFinalHomeosCohort(db, databasePath, releaseRoot);
    db.exec('COMMIT');
    return Object.freeze({ result: 'FINAL_HOMEOS_ROLLED_BACK', repairId: FINAL_HOMEOS.repairId });
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}
function rollbackRepair({ databasePath, releaseRoot, now = () => new Date().toISOString() }) {
  validateRelease(releaseRoot);
  const modeProbe = new DatabaseSync(databasePath, { readOnly: true });
  modeProbe.exec('PRAGMA query_only=ON');
  const homeosMode = modeProbe.prepare(
    'SELECT module_hash,version FROM resident_instances WHERE residency_id=?'
  ).get(FINAL_HOMEOS.residencyId);
  modeProbe.close();
  if (homeosMode?.version === FINAL_HOMEOS.version &&
      homeosMode?.module_hash === FINAL_HOMEOS.targetModuleHash) {
    return rollbackFinalHomeosRepair({ databasePath, releaseRoot, now });
  }
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  try {
    const current = assertBaseline(db, { repaired: true });
    assert(scalar(db, 'SELECT COUNT(*) value FROM resident_checkpoints WHERE residency_id=? AND generation>?',
      BASELINE.residencyId, REPAIR.checkpointGeneration) === 0, 'METAB advanced beyond rollback fence');
    const repairRow = db.prepare("SELECT detail_json FROM recovery_records WHERE type='resident.implementation-repaired' AND core_id=? ORDER BY id DESC LIMIT 1")
      .get(BASELINE.coreId);
    let repairDetail = null; try { repairDetail = JSON.parse(repairRow?.detail_json || 'null'); } catch {}
    assert(repairDetail?.repairId === REPAIR.repairId &&
      repairDetail.capacitySourceBeforeSha256 === BASELINE.capacityMetadataSha256 &&
      sha256(repairDetail.capacitySourceBeforeJson || '') === BASELINE.capacityMetadataSha256,
    'METAB rollback source evidence is incomplete');
    const at = now();
    assert(db.prepare(`UPDATE resident_instances SET module_hash=?,package_policy_hash=?,checkpoint_generation=?,
      checkpoint_hash=?,updated_at=? WHERE residency_id=? AND module_hash=? AND package_policy_hash=? AND
      checkpoint_generation=? AND checkpoint_hash=? AND status='RESYNC_REQUIRED'`).run(BASELINE.moduleHash,
      BASELINE.packagePolicyHash, BASELINE.checkpointGeneration, BASELINE.checkpointHash, at,
      BASELINE.residencyId, REPAIR.moduleHash, REPAIR.packagePolicyHash, REPAIR.checkpointGeneration,
      current.repairCheckpoint.blob_hash).changes === 1, 'METAB rollback lost its resident fence');
    assert(db.prepare(`UPDATE biological_consumers SET checkpoint_hash=?,updated_at=? WHERE consumer_id=? AND
      active=0 AND required=0 AND cursor=? AND authority_epoch=0 AND checkpoint_hash=?`).run(
      BASELINE.checkpointHash, at, BASELINE.residencyId, BASELINE.inputCursor,
      current.repairCheckpoint.blob_hash).changes === 1,
    'METAB rollback lost its consumer fence');
    assert(db.prepare('UPDATE metadata SET json=?,sha256=?,updated_at=? WHERE key=? AND sha256=?').run(
      repairDetail.capacitySourceBeforeJson, BASELINE.capacityMetadataSha256, at,
      BASELINE.capacityMetadataKey, current.capacity.sha256).changes === 1,
    'METAB rollback lost its capacity-source fence');
    const sourceBefore = JSON.parse(repairDetail.capacitySourceBeforeJson);
    const mirrorJson = `${JSON.stringify(sourceBefore, null, 2)}\n`;
    db.prepare(`INSERT INTO pending_metadata_mirrors(key,relative_path,json,sha256,created_at)
      VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET relative_path=excluded.relative_path,json=excluded.json,
      sha256=excluded.sha256,created_at=excluded.created_at`).run(BASELINE.capacityMetadataKey,
      'life/p1-r0-metab-capacity-source.json', mirrorJson, sha256(mirrorJson), at);
    db.prepare('DELETE FROM resident_checkpoints WHERE residency_id=? AND generation=?')
      .run(BASELINE.residencyId, REPAIR.checkpointGeneration);
    db.prepare(`INSERT INTO recovery_records(type,core_id,detail_json,created_at) VALUES(?,?,?,?)`).run(
      'resident.implementation-repair-rolled-back', BASELINE.coreId,
      stableStringify({ repairId: REPAIR.repairId, biologicalAcceptedStateChanged: false,
        abandonedCount: 0, inventedBiologicalTime: false, authorityChanged: false }), at);
    assertBaseline(db);
    db.exec('COMMIT');
    return Object.freeze({ result: 'ROLLED_BACK', repairId: REPAIR.repairId });
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}
function parse(argv) {
  const [mode, databasePath, releaseRoot] = argv.slice(2);
  assert(['preflight', 'apply', 'rollback'].includes(mode) && databasePath && releaseRoot,
    'usage: p1-r146-metab-q48-implementation-repair.js preflight|apply|rollback DATABASE RELEASE_ROOT');
  return { mode, databasePath: path.resolve(databasePath), releaseRoot: path.resolve(releaseRoot) };
}
if (require.main === module) {
  try {
    const { mode, ...options } = parse(process.argv);
    const result = mode === 'preflight' ? preflightRepair(options) :
      mode === 'apply' ? applyRepair(options) : rollbackRepair(options);
    process.stdout.write(`${stableStringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`R146_METAB_Q48_REPAIR_ABORT=${error.code || 'ERROR'}:${error.message}\n`);
    process.exitCode = 1;
  }
}
module.exports = Object.freeze({ BASELINE, REPAIR, PARTIAL_ROUTE, FINAL_HOMEOS, applyRepair,
  preflightRepair, rollbackRepair, assertPartialRouteCohort, assertFinalHomeosCohort,
  repairIncompleteCheckpointState, validateRelease, validateFinalHomeosRelease });
