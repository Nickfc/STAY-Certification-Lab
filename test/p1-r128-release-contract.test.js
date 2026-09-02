'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'P1_PRODUCTION_HARDENING_R127F_TO_R128.sha256');
const FORWARD = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'p1-r128-metab-shadow-forward.sh');
const RECOVERY = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'p1-r128-metab-shadow-forward-recovery.sh');
const PROOF = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'p1-r128-metab-shadow-live-proof.js');

const EXPECTED_OVERLAY = Object.freeze([
  'cores/p1-r0/metab-neutral/index.js',
  'cores/p1-r0/metab-neutral/package-policy.json',
  'cores/p1-r0/metab-shadow/index.js',
  'cores/p1-r0/metab-shadow/package-policy.json',
  'deploy/live-physiology-transplant/p1-r128-metab-shadow-forward-recovery.sh',
  'deploy/live-physiology-transplant/p1-r128-metab-shadow-forward.sh',
  'deploy/live-physiology-transplant/p1-r128-metab-shadow-live-proof.js',
  'deploy/live-physiology-transplant/p1-resident-control-client.js',
  'runtime/kernel/biological-fabric.js',
  'runtime/kernel/canonical-json.js',
  'runtime/kernel/event-fabric.js',
  'runtime/kernel/hardened-living-kernel.js',
  'runtime/kernel/living-kernel.js',
  'runtime/kernel/package-policy.js',
  'runtime/kernel/resident-control-socket.js',
  'runtime/kernel/resident-manager.js',
  'runtime/kernel/resource-governor.js',
  'runtime/kernel/state-store.js',
  'runtime/kernel/trusted-organism-time.js',
  'runtime/kernel/upgrades.js',
  'runtime/p1-r0/c0-source-contracts/contracts/founder_profile_templates.json',
  'runtime/p1-r0/causal-frame.js',
  'runtime/p1-r0/contract-registry.js',
  'runtime/p1-r0/laboratory-persistence.js',
  'runtime/p1-r0/metab-capacity-source.js',
  'runtime/p1-r0/metab-engine.js',
  'runtime/p1-r0/metab-founder-dossier.js',
  'runtime/p1-r0/metab-neutral-birth-authority.js',
  'runtime/p1-r0/metab-neutral-contract.js',
  'runtime/p1-r0/metab-shadow-contract.js',
  'runtime/p1-r0/production-persistence.js',
  'runtime/p1-r0/q16-48.js',
  'runtime/p1-r0/records.js',
  'runtime/p1-r0/resident-package-hashes.json',
  'runtime/p1-r0/resident-support.js',
  'runtime/p1-r0/residents/metab-neutral.js',
  'runtime/p1-r0/residents/metab-shadow.js',
  'runtime/release/surgery-a-control.js',
  'runtime/revision-freeze.js',
  'runtime/ui/chip-projection.js',
  'scripts/build-p1-r0-resident-packages.js',
  'server.js',
  'test/p1-r118f-release-contract.test.js',
  'test/p1-r119f-release-contract.test.js',
  'test/p1-r124-release-contract.test.js',
  'test/p1-r127-post-restart-continuity.test.js',
  'test/p1-r128-metab-shadow.test.js',
  'test/p1-r128-release-contract.test.js',
  'test/p1-resident-control-socket.test.js',
  'test/p1-surgery-a-transplant.test.js',
  'test/production-hardening-entry-path.test.js',
  'test/production-hardening.test.js',
  'test/server.test.js'
]);

function read(file) { return fs.readFileSync(file, 'utf8'); }
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function manifestEntries() {
  const entries = new Map();
  for (const line of read(MANIFEST).trim().split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})  \.\/([A-Za-z0-9._/-]+)$/.exec(line);
    assert.ok(match, `invalid R128 manifest line: ${line}`);
    assert.equal(entries.has(match[2]), false, `duplicate R128 path: ${match[2]}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

test('R128-REL-01 manifest is exact, hash-complete and excludes future resident attachment', () => {
  const entries = manifestEntries();
  assert.deepEqual([...entries.keys()], EXPECTED_OVERLAY);
  for (const [relative, expected] of entries) {
    assert.equal(sha256(path.join(ROOT, relative)), expected, relative);
  }
  for (const forbidden of [
    'cores/p1-r0/homeos/index.js', 'cores/p1-r0/intero/index.js',
    'runtime/p1-r0/residents/homeos.js', 'runtime/p1-r0/residents/intero.js',
    'runtime/p1-r0/homeos-engine.js', 'runtime/p1-r0/intero-engine.js',
    'runtime/p1-r0/sntss-receptor.js'
  ]) assert.equal(entries.has(forbidden), false, forbidden);
});

test('R128-REL-02 forward path is exact, one-restart, startup-only and precommit-rollback-only', () => {
  const source = read(FORWARD);
  for (const identity of [
    "EXPECTED_PRIVATE_IPV4='172.26.9.207'",
    "DATABASE='/var/lib/stay/data/continuity.sqlite3'",
    "'/opt/stay/releases/0.8.11.3-p1m-r127-metab-final-fb27ce309f77'",
    'AUTHORIZE_R128_METAB_OUTPUT_FIREWALLED_SHADOW_FORWARD_ONLY',
    'AUTHORIZE_R128_METAB_NEUTRAL_TO_OUTPUT_FIREWALLED_SHADOW_ONLY',
    'STAY_ALLOW_METAB_SHADOW_PROMOTION=1',
    'STAY_METAB_SHADOW_PROMOTION_AUTHORIZATION=',
    'R128_METAB_OUTPUT_FIREWALLED_SHADOW',
    "'PROMOTION_AUTHORITY_ACTIVE=NO'"
  ]) assert.equal(source.includes(identity), true, identity);
  assert.equal((source.match(/systemctl restart stay\.service/g) || []).length, 1);
  assert.equal((source.match(/systemctl start stay\.service/g) || []).length, 0);
  assert.match(source, /RESTART_COMMITTED=1\s+systemctl restart stay\.service/);
  assert.match(source, /RESTART_COMMITTED" -eq 0[\s\S]*?point_current "\$STAY_R128_SOURCE_RELEASE"/);
  const committed = source.slice(source.indexOf('RESTART_COMMITTED=1'));
  assert.doesNotMatch(committed, /point_current "\$STAY_R128_SOURCE_RELEASE"/);
  assert.match(source, /remove_dropin \|\| abort promotion-authority-revocation-failed/);
  assert.match(source, /sha256sum -c "\$MANIFEST"/);
  assert.match(source, /validateBefore/);
  assert.match(source, /validateAfter/);
  assert.match(source, /chip\('metab'\)\?\.state==='SHADOW'/);
  assert.doesNotMatch(source,
    /TimeoutStartSec|TimeoutStopSec|CPUQuota=|handlerTimeoutMs\s*=|git reset|sqlite3\s+.*(?:DELETE|UPDATE)/);
});

test('R128-REL-03 recovery never rewinds, admits only R128/R129 and starts at most once', () => {
  const source = read(RECOVERY);
  assert.equal((source.match(/systemctl start stay\.service/g) || []).length, 1);
  assert.equal((source.match(/systemctl restart stay\.service/g) || []).length, 0);
  assert.doesNotMatch(source, /point_current|ln -s|mv -Tf.*\/opt\/stay\/current/);
  assert.match(source, /boundary_revision=.*durable_runtime_revision/);
  assert.match(source, /"\$boundary_revision" =~ \^12\[89\]\$/);
  assert.match(source, /second-recovery-restart-forbidden/);
  assert.match(source, /existing-freeze-unsafe/);
  assert.match(source, /validateRevisionFreeze\(record, revision\)/);
  assert.match(source, /target-recovery-freeze-already-present/);
  assert.match(source, /pointerRewound:false/);
  assert.match(source, /R128_METAB_SHADOW_RECOVERY=PASS/);
  assert.doesNotMatch(source,
    /TimeoutStartSec|TimeoutStopSec|CPUQuota=|handlerTimeoutMs\s*=|git reset|sqlite3\s+.*(?:DELETE|UPDATE)/);
});

test('R128-REL-04 shell and JavaScript release entry paths parse', () => {
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
    : 'bash';
  for (const file of [FORWARD, RECOVERY]) {
    const result = spawnSync(bash, ['-n', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}\n${result.stdout}\n${result.stderr}`);
  }
  const result = spawnSync(process.execPath, ['--check', PROOF], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('R128-REL-05 package preserves resource limits, zero outputs and zero authority surface', () => {
  const policy = JSON.parse(read(path.join(ROOT,
    'cores/p1-r0/metab-shadow/package-policy.json')));
  const definition = require(path.join(ROOT, 'cores/p1-r0/metab-shadow/index.js'));
  assert.deepEqual(policy.resourceContract.manifestResources, {
    hardCpuPercent: 20, hardRamMiB: 96, handlerTimeoutMs: 250,
    healthTimeoutMs: 1000, maxRestarts: 4, outputBytesPerEvent: 65536,
    outputCapacity: 128, outputLimitPerEvent: 16, pidsMax: 16,
    queueCapacity: 256, restartBackoffMs: 250, restartWindowMs: 60000,
    softCpuPercent: 5, softRamMiB: 64, storageMiB: 4
  });
  assert.equal(policy.bounds.productionOutputs, 0);
  assert.deepEqual(definition.manifest.outputs, []);
  assert.deepEqual(definition.manifest.biology.producerCapabilities, []);
  assert.deepEqual(definition.manifest.biology.consumerRouteLeases, []);
  assert.equal(Object.hasOwn(definition.manifest, 'authority'), false);
});

function residentRow(expected, generation, overrides = {}) {
  return {
    residency_id: expected.residencyId,
    core_id: expected.coreId,
    instance_id: expected.instanceId,
    version: expected.version,
    state_schema: expected.stateSchema || 1,
    module_relative_path: expected.moduleRelativePath || 'sealed/module.js',
    module_hash: expected.moduleHash || null,
    manifest_hash: expected.manifestHash || null,
    package_policy_hash: expected.packagePolicyHash || null,
    checkpoint_hash: 'b'.repeat(64),
    checkpoint_generation: generation,
    status: 'RUNNING',
    ...overrides
  };
}

function status(expected, mode, observedOutputs = 0) {
  return {
    resident: {
      status: 'RUNNING', running: true, authorityOwned: false,
      version: expected.version, declaredOutputs: 0, observedOutputs,
      health: {
        mode, biologicalOutputs: mode === 'SHADOW' && expected.coreId === 'METAB' ? 0 : observedOutputs,
        ...(expected.coreId === 'METAB' && mode === 'SHADOW'
          ? { outputPolicy: 'FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT' } : {})
      },
      host: {
        quarantined: false,
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
    }
  };
}

function meta(revision, metabState, metabVersion, frozen) {
  const chip = (coreId, state) => ({ coreId, state, born: coreId !== 'bsf' });
  return {
    ok: true, revision, revisionFrozen: frozen,
    cores: [{
      id: 'fetus-legacy', version: '0.6.0', ok: true,
      memoryGuardian: { status: 'healthy', warnAtMiB: 192, recycleAtMiB: 256 }
    }],
    systems: [{ id: 'bsf', mode: 'LIVE', status: 'RUNNING', healthOk: true }],
    residents: [{ coreId: 'METAB', version: metabVersion }],
    chipProjection: { lifecycle: [
      chip('bsf', 'LIVE'), chip('sntss', 'SHADOW'),
      chip('chronobiology', 'SHADOW'), chip('metab', metabState)
    ] }
  };
}

function proofFixtures() {
  const { EXPECTED } = require(PROOF);
  const { recordHash } = require('../runtime/p1-r0/records');
  const { sealRevisionFreeze } = require('../runtime/revision-freeze');
  const founderState = {
    founderId: 'founder:metab:r124:production',
    lineageId: 'lineage:metab:production'
  };
  const founderRecord = {
    recordVersion: 'P1FounderRecordV1', organismId: 'stay-production-organism',
    coreId: 'METAB', founderId: founderState.founderId,
    lineageId: founderState.lineageId, profileId: 'metab.p1-r0.production.v1',
    profileHash: `sha256:${'1'.repeat(64)}`, founderSchemaId: 'p1r0.metab.founder.v1',
    founderSchemaVersion: '1', genesisFrame: 0,
    genesisTransactionId: 'metab-genesis-production',
    phenotypeHash: `sha256:${'2'.repeat(64)}`, committed: true,
    previousFounderId: null
  };
  const chipRecord = {
    recordVersion: 'CoreChipRecordV1', chipId: 'resident:metab',
    organismId: founderRecord.organismId, coreId: 'METAB', publicName: 'METAB',
    born: true, firstActivationFrame: 0, firstResidencyId: 'resident:metab',
    currentState: 'SHADOW', mode: 'SHADOW', lifecycle: 'RUNNING',
    healthReasonCode: 'R128_SHADOW_RUNNING_OUTPUT_FIREWALLED',
    coreVersion: EXPECTED.metabShadow.version, stateSchemaVersion: '2',
    checkpointGeneration: '5', lastTrustedFrame: 4, coverageBand: 'FULL',
    evidenceRefs: [`sha256:${'3'.repeat(64)}`],
    observedUtc: '2026-09-03T00:00:00.000Z',
    historyHeadHash: `sha256:${'4'.repeat(64)}`
  };
  const sntssBefore = residentRow(EXPECTED.sntss, EXPECTED.sntss.minimumGeneration);
  const chronoBefore = residentRow(EXPECTED.chronobiology,
    EXPECTED.chronobiology.minimumGeneration);
  const neutral = residentRow(EXPECTED.metabNeutral, 2, {
    checkpoint_hash: EXPECTED.metabNeutral.checkpointHash
  });
  const common = {
    format: 'stay-r128-metab-shadow-database-proof-v1', quickCheck: 'ok',
    queryOnly: true, identity: { organismId: founderRecord.organismId }, schemas: [],
    authorities: [{
      core_id: EXPECTED.fetus.coreId, instance_id: EXPECTED.fetus.instanceId,
      version: EXPECTED.fetus.version, epoch: EXPECTED.fetus.authorityEpoch,
      checkpoint_hash: 'c'.repeat(64)
    }],
    p1Authority: 0, sntssAuthority: 0, chronobiologyAuthority: 0,
    pendingDeliveries: 0, failedDeliveries: 0, abandonedDeliveries: 0,
    pendingOutboxIntents: 0, metabOutboxIntents: 0
  };
  const beforeDatabase = {
    ...common, runtimeRevision: 127, capacitySource: null,
    residents: [chronoBefore, neutral, sntssBefore],
    consumers: [{
      consumer_id: 'resident:metab', core_id: 'METAB', active: 1, required: 0,
      authority_epoch: 0, topics_json: '["runtime.organism.binding"]',
      checkpoint_hash: EXPECTED.metabNeutral.checkpointHash
    }],
    founders: [], chips: [],
    metabCheckpoint: { blob_hash: EXPECTED.metabNeutral.checkpointHash, generation: 2 },
    metabCheckpointState: {
      founder: founderState, engineState: { frameIndex: 0, outputSequence: '0' }
    },
    metabChipHistory: 1
  };
  const shadowCheckpoint = 'd'.repeat(64);
  const afterDatabase = {
    ...common, runtimeRevision: 128,
    residents: [
      residentRow(EXPECTED.chronobiology, EXPECTED.chronobiology.minimumGeneration + 2),
      residentRow(EXPECTED.metabShadow, 5, { checkpoint_hash: shadowCheckpoint }),
      residentRow(EXPECTED.sntss, EXPECTED.sntss.minimumGeneration + 2)
    ],
    consumers: [{
      consumer_id: 'resident:metab', core_id: 'METAB', active: 1, required: 0,
      authority_epoch: 0,
      topics_json: '["resource.capacity.eligible.v1","resource.capacity.quality.v1","runtime.metab.shadow-activation","runtime.organism.binding"]',
      checkpoint_hash: shadowCheckpoint
    }],
    founders: [{ core_id: 'METAB', record_json: JSON.stringify(founderRecord),
      record_hash: recordHash(founderRecord) }],
    chips: [{ chip_id: 'resident:metab', history_sequence: 2,
      record_json: JSON.stringify(chipRecord), record_hash: recordHash(chipRecord) }],
    metabCheckpoint: { blob_hash: shadowCheckpoint, generation: 5 },
    metabCheckpointState: {
      founder: founderState,
      activation: {
        instanceId: EXPECTED.metabShadow.instanceId, runtimeRevision: 128,
        sourceCheckpointHash: `sha256:${EXPECTED.metabNeutral.checkpointHash}`
      },
      lastAcceptedFrame: 4, engineState: { outputSequence: '0' }
    },
    capacitySource: {
      protocol: 'stay-p1-r0-metab-capacity-source-v1',
      instanceId: EXPECTED.metabShadow.instanceId,
      residentVersion: EXPECTED.metabShadow.version, runtimeRevision: 128,
      pending: null, lastCommittedFrame: 4
    },
    metabChipHistory: 2
  };
  const beforeArgs = {
    database: beforeDatabase,
    freeze: sealRevisionFreeze({
      format: 'stay-runtime-revision-freeze-v1', result: 'PASS',
      acceptance: 'ACCEPTED', freezeType: 'R127_METAB_FINAL',
      runtime: { revision: 127, revisionLabel: 'R127F' }
    }),
    sntssStatus: status(EXPECTED.sntss, 'SHADOW'),
    chronobiologyStatus: status(EXPECTED.chronobiology, 'SHADOW', 8),
    metabStatus: status(EXPECTED.metabNeutral, 'NEUTRAL'),
    meta: meta(127, 'NEUTRAL', EXPECTED.metabNeutral.version, true),
    service: { mainPid: 100, nRestarts: 3, activeState: 'active', subState: 'running' },
    currentRelease: EXPECTED.sourceRelease
  };
  return { EXPECTED, beforeArgs, afterDatabase,
    afterStatuses: {
      sntssStatus: status(EXPECTED.sntss, 'SHADOW'),
      chronobiologyStatus: status(EXPECTED.chronobiology, 'SHADOW', 8),
      metabStatus: status(EXPECTED.metabShadow, 'SHADOW')
    } };
}

test('R128-REL-06 live proof accepts exact continuity and rejects authority or restart drift', () => {
  const { validateBefore, validateAfter } = require(PROOF);
  const fixture = proofFixtures();
  const before = validateBefore(fixture.beforeArgs);
  const exact = {
    before, database: fixture.afterDatabase, ...fixture.afterStatuses,
    meta: meta(128, 'SHADOW', fixture.EXPECTED.metabShadow.version, false),
    service: { beforePid: 100, afterPid: 200, beforeRestarts: 3,
      afterRestarts: 3, restartCommands: 1 },
    currentRelease: '/opt/stay/releases/0.8.11.3-p1m-r128-metab-shadow-aaaaaaaaaaaa',
    targetRelease: '/opt/stay/releases/0.8.11.3-p1m-r128-metab-shadow-aaaaaaaaaaaa'
  };
  const accepted = validateAfter(exact);
  assert.equal(accepted.result, 'PASS');
  assert.equal(accepted.runtimeRevision, 128);
  assert.equal(accepted.observedOutputs, 0);
  assert.equal(accepted.authorityOwned, false);
  assert.throws(() => validateAfter({
    ...exact, database: { ...clone(exact.database), p1Authority: 1 }
  }), { code: 'R128_METAB_PROOF_AFTER' });
  assert.throws(() => validateAfter({
    ...exact, service: { ...exact.service, restartCommands: 2 }
  }), { code: 'R128_METAB_PROOF_AFTER' });
});

test('R128-REL-07 clean extracted overlay loads the production proof in isolation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-r128-overlay-'));
  try {
    for (const relative of manifestEntries().keys()) {
      const target = path.join(directory, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(ROOT, relative), target);
    }
    const proof = path.join(directory, 'deploy', 'live-physiology-transplant',
      'p1-r128-metab-shadow-live-proof.js');
    const result = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', proof], {
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

module.exports = Object.freeze({ EXPECTED_OVERLAY });
