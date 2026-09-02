'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  EXPECTED,
  validateAfter,
  validateBefore
} = require('../deploy/live-physiology-transplant/p1-r124-metab-neutral-live-proof');
const { sealRevisionFreeze } = require('../runtime/revision-freeze');
const { recordHash } = require('../runtime/p1-r0/records');
const { sha256 } = require('../runtime/p1-r0/resident-support');
const profiles = require(
  '../runtime/p1-r0/c0-source-contracts/contracts/founder_profile_templates.json'
).profiles;

const IDENTITY = Object.freeze({
  organismId: 'stay-r124-proof-test',
  createdAt: '2026-08-15T12:48:11.910Z',
  lineage: 'STAY/Genesis'
});

function row(expected, generation) {
  return {
    residency_id: expected.residencyId,
    core_id: expected.coreId,
    role: expected === EXPECTED.metab ? 'metabolism' : 'observer',
    instance_id: expected.instanceId || 'metab-instance-1',
    version: expected.version,
    state_schema: expected.stateSchema || 2,
    module_relative_path: expected.moduleRelativePath || `cores/${expected.coreId}/index.js`,
    module_hash: expected.moduleHash || `sha256:${'1'.repeat(64)}`,
    manifest_hash: expected.manifestHash || `sha256:${'2'.repeat(64)}`,
    package_policy_hash: expected.packagePolicyHash || `sha256:${'3'.repeat(64)}`,
    organism_identity_hash: sha256(IDENTITY),
    checkpoint_hash: 'a'.repeat(64),
    checkpoint_generation: generation,
    status: 'RUNNING'
  };
}

function resources(expected, instanceId = expected.instanceId) {
  return { ok: true, resident: {
    residencyId: expected.residencyId,
    coreId: expected.coreId,
    version: expected.version,
    status: 'RUNNING', running: true, authorityOwned: false,
    productionEligible: false, signalling: expected === EXPECTED.metab ? 'FORBIDDEN' : 'SHADOW_ONLY',
    declaredOutputs: expected === EXPECTED.metab ? 0 : 1,
    observedOutputs: 0, handledEvents: 0,
    health: expected === EXPECTED.metab
      ? { ok: true, mode: 'NEUTRAL', biologicalOutputs: 0 }
      : { ok: true, biologicalOutputs: 0 },
    host: {
      instanceId, quarantined: false,
      resourceGovernor: { policy: {
        softRamBytes: 64 * 1024 * 1024, hardRamBytes: 96 * 1024 * 1024,
        hardCpuDuty: 0.2, queueCapacity: 256, handlerTimeoutMs: 250, pidsMax: 16
      } },
      osContainment: {
        required: true, available: true, payloadSandboxed: true,
        payloadAttachedBeforeInit: true, supervisorChargedToKernel: true,
        limits: {
          'memory.high': String(64 * 1024 * 1024),
          'memory.max': String(96 * 1024 * 1024),
          'pids.max': '16', 'cpu.max': '20000 100000'
        }
      }
    }
  } };
}

function meta(revision, metab = false) {
  const lifecycle = [
    { coreId: 'bsf', state: 'LIVE' },
    { coreId: 'sntss', state: 'SHADOW' },
    { coreId: 'chronobiology', state: 'SHADOW' }
  ];
  if (metab) lifecycle.push({ coreId: 'metab', state: 'NEUTRAL', born: true });
  else lifecycle.push({ coreId: 'metab', stage: 'LAB QUALIFIED' });
  return {
    ok: true, revision, revisionFrozen: revision === 123,
    chipProjection: { observationOnly: true, mutationEndpoints: [], lifecycle },
    systems: [{ id: 'bsf', mode: 'LIVE', status: 'RUNNING', healthOk: true }],
    cores: [{ id: 'fetus-legacy', ok: true, memoryGuardian: {
      status: 'healthy', warnAtMiB: 192, recycleAtMiB: 256
    } }]
  };
}

function beforeDatabase() {
  return {
    format: 'stay-r124-metab-neutral-database-proof-v1',
    quickCheck: 'ok', queryOnly: true, identity: IDENTITY, runtimeRevision: 123,
    schemas: [],
    residents: [row(EXPECTED.chronobiology, 9000), row(EXPECTED.sntss, 2_000_000)],
    consumers: [], founders: [], dossiers: [], chips: [],
    metabCheckpoints: 0, metabChipHistory: 0,
    p1Authority: 0, sntssAuthority: 0, chronobiologyAuthority: 0,
    pendingDeliveries: 0, pendingOutboxIntents: 0
  };
}

function freeze() {
  return sealRevisionFreeze({
    format: 'stay-runtime-revision-freeze-v1', result: 'PASS', acceptance: 'ACCEPTED',
    freezeType: 'R123F_AUTHORIZED_PRODUCTION_FREEZE_WITH_DISCLOSED_EXCEPTION',
    runtime: { revision: 123, revisionLabel: 'R123F' }
  });
}

function beforeProof() {
  const parentFreeze = freeze();
  return validateBefore({
    database: beforeDatabase(), freeze: parentFreeze,
    sntssStatus: resources(EXPECTED.sntss),
    chronobiologyStatus: resources(EXPECTED.chronobiology),
    meta: meta(123),
    service: { mainPid: 395571, nRestarts: 0, activeState: 'active',
      subState: 'running', benchmarkActiveState: 'inactive' }
  }, { expectedFreezeRecordSha256: parentFreeze.recordSha256 });
}

function founder() {
  const profile = structuredClone(profiles.METAB);
  profile.profileId = 'metab.p1-r0.founder.r124.proof';
  return {
    recordVersion: 'P1FounderRecordV1', organismId: IDENTITY.organismId,
    coreId: 'METAB', founderId: 'founder:metab:r124:proof',
    lineageId: 'lineage:metab:r124:proof', profileId: profile.profileId,
    profileHash: sha256(profile),
    founderSchemaId: 'urn:stay:p1-r0:schema:metab-founder-profile:v1',
    founderSchemaVersion: '1', genesisFrame: 0,
    genesisTransactionId: 'tx:metab:r124:proof',
    phenotypeHash: sha256({ coreId: 'METAB', profile }),
    committed: true, previousFounderId: null
  };
}

function chipRecord() {
  const body = {
    recordVersion: 'CoreChipRecordV1', chipId: 'resident:metab',
    organismId: IDENTITY.organismId, coreId: 'METAB', publicName: 'METAB', born: true,
    firstActivationFrame: 0, firstResidencyId: 'resident:metab', currentState: 'NEUTRAL',
    mode: 'NEUTRAL', lifecycle: 'RUNNING', healthReasonCode: 'R124_NEUTRAL_ACCEPTED',
    coreVersion: EXPECTED.metab.version, stateSchemaVersion: '1',
    checkpointGeneration: '1', lastTrustedFrame: null, coverageBand: 'UNKNOWN',
    evidenceRefs: [`sha256:${'a'.repeat(64)}`], observedUtc: '2026-09-02T12:00:00.000Z',
    historyHeadHash: `sha256:${'b'.repeat(64)}`
  };
  return body;
}

function afterDatabase() {
  const database = structuredClone(beforeDatabase());
  const record = founder();
  const chip = chipRecord();
  database.runtimeRevision = 124;
  database.schemas = [{ name: 'p1-r0-production', version: 1 }];
  database.residents.push(row(EXPECTED.metab, 1));
  database.consumers.push({
    consumer_id: 'resident:metab', core_id: 'METAB', required: 0, active: 1,
    topics_json: '["runtime.organism.binding"]', topics_sha256: 'unused', cursor: 0,
    authority_epoch: 0, checkpoint_hash: 'a'.repeat(64)
  });
  database.founders.push({
    organism_id: IDENTITY.organismId, core_id: 'METAB', founder_id: record.founderId,
    lineage_id: record.lineageId, record_json: JSON.stringify(record), record_hash: recordHash(record)
  });
  database.dossiers.push({
    residency_id: 'resident:metab', organism_id: IDENTITY.organismId, core_id: 'METAB',
    target_revision: 124, certificate_id: 'r124-metab-neutral:proof',
    dossier_json: JSON.stringify({ founderRecord: record }), dossier_hash: `sha256:${'c'.repeat(64)}`
  });
  database.chips.push({
    chip_id: 'resident:metab', organism_id: IDENTITY.organismId, core_id: 'METAB',
    history_sequence: 1, history_head_hash: chip.historyHeadHash,
    record_json: JSON.stringify(chip), record_hash: recordHash(chip),
    observation_hash: `sha256:${'d'.repeat(64)}`, semantic_hash: `sha256:${'e'.repeat(64)}`
  });
  database.metabCheckpoints = 1;
  database.metabChipHistory = 1;
  return database;
}

test('R124-METAB-PROOF-01 exact R123F baseline remains read-only, frozen and contained', () => {
  assert.deepEqual(beforeProof(), {
    result: 'PASS', runtimeRevision: 123,
    sntssCheckpointGeneration: 2_000_000,
    chronobiologyCheckpointGeneration: 9000
  });
  const leaking = beforeDatabase();
  leaking.p1Authority = 1;
  const parentFreeze = freeze();
  assert.throws(() => validateBefore({
    database: leaking, freeze: parentFreeze, sntssStatus: resources(EXPECTED.sntss),
    chronobiologyStatus: resources(EXPECTED.chronobiology), meta: meta(123),
    service: { mainPid: 1, nRestarts: 0, activeState: 'active', subState: 'running',
      benchmarkActiveState: 'inactive' }
  }, { expectedFreezeRecordSha256: parentFreeze.recordSha256 }),
  { code: 'R124_METAB_PROOF_BEFORE' });
});

test('R124-METAB-PROOF-02 acceptance preserves prior residents and proves one neutral zero-authority birth', () => {
  const database = afterDatabase();
  const proof = validateAfter({
    before: beforeProof(), database,
    sntssStatus: resources(EXPECTED.sntss),
    chronobiologyStatus: resources(EXPECTED.chronobiology),
    metabStatus: resources(EXPECTED.metab, 'metab-instance-1'),
    meta: meta(124, true),
    service: { beforePid: 395571, afterPid: 400000, beforeRestarts: 0,
      afterRestarts: 0, restartCommands: 1 }
  });
  assert.equal(proof.result, 'PASS');
  assert.equal(proof.runtimeRevision, 124);
  assert.equal(proof.authorityOwned, false);
  assert.equal(proof.observedOutputs, 0);
  assert.equal(proof.chipState, 'NEUTRAL');
  const output = structuredClone(database);
  output.p1Authority = 1;
  assert.throws(() => validateAfter({
    before: beforeProof(), database: output,
    sntssStatus: resources(EXPECTED.sntss),
    chronobiologyStatus: resources(EXPECTED.chronobiology),
    metabStatus: resources(EXPECTED.metab, 'metab-instance-1'), meta: meta(124, true),
    service: { beforePid: 1, afterPid: 2, beforeRestarts: 0, afterRestarts: 0,
      restartCommands: 1 }
  }), { code: 'R124_METAB_PROOF_AFTER' });
});

test('R124-METAB-PROOF-03 forward R125 recovery is accepted only with the same founder and resident', () => {
  const database = afterDatabase();
  database.runtimeRevision = 125;
  const result = validateAfter({
    before: beforeProof(), database,
    sntssStatus: resources(EXPECTED.sntss),
    chronobiologyStatus: resources(EXPECTED.chronobiology),
    metabStatus: resources(EXPECTED.metab, 'metab-instance-1'), meta: meta(125, true),
    service: { beforePid: 395571, afterPid: 400001, beforeRestarts: 0,
      afterRestarts: 0, restartCommands: 1 }
  });
  assert.equal(result.runtimeRevision, 125);
  const rewound = structuredClone(database);
  rewound.residents.find(value => value.residency_id === 'resident:sntss')
    .checkpoint_generation = 1;
  assert.throws(() => validateAfter({
    before: beforeProof(), database: rewound,
    sntssStatus: resources(EXPECTED.sntss),
    chronobiologyStatus: resources(EXPECTED.chronobiology),
    metabStatus: resources(EXPECTED.metab, 'metab-instance-1'), meta: meta(125, true),
    service: { beforePid: 1, afterPid: 2, beforeRestarts: 0, afterRestarts: 0,
      restartCommands: 1 }
  }), { code: 'R124_METAB_PROOF_CONTINUITY' });
});
