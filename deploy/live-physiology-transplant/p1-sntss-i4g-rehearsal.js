#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '../..');
const MODULE = path.join(ROOT, 'cores/sntss/i4g/index.js');
const DATABASE = '/var/lib/stay/data/continuity.sqlite3';
const DATA_ROOT = '/var/lib/stay/data';
const FREEZE = '/var/lib/stay/evidence/runtime-freezes/R105.json';
const EVIDENCE_ROOT = '/var/lib/stay/evidence/sntss-continuity-rehearsal';
const CURRENT_RELEASE = '/opt/stay/releases/0.8.11.3-p1g-cold-recovery-736a6845b750';
const EXPECTED_FREEZE_SHA256 = '78021d86da8038e298fedb46b7371a46e1bc1e4d1cb0624205a864877ca22875';
const EXPECTED_LIVE_POLICY = 'sha256:5708b07f711f4d681c67c518e34450d57559b6fe51316060d1c83bd2c8a46765';
const EXPECTED_CANDIDATE_POLICY = 'sha256:ba12622fcc9c782c8c48f0544a5b019c96dc198dcbb7fb209c1dad47de64639d';
const AUTHORIZATION = 'R13_SNTSS_CONTINUITY_GENESIS_SHADOW';

const { inspectCoreModule } = require('../../runtime/kernel/core-loader');
const { CoreHostClient } = require('../../runtime/kernel/core-host-client');
const { stableStringify } = require('../../runtime/kernel/canonical-json');
const { validateRevisionFreeze } = require('../../runtime/revision-freeze');

function fail(code, message, detail = null) {
  throw Object.assign(new Error(message), { code, detail });
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function requestJson(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port: 8787, path: pathname, timeout: 5000 },
      response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.once('end', () => {
          if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
          try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
        });
      }
    );
    request.once('timeout', () => request.destroy(new Error('HTTP timeout')));
    request.once('error', reject);
  });
}

function systemdProperties(unit) {
  const fields = [
    'ActiveState', 'SubState', 'MainPID', 'NRestarts',
    'ExecMainStartTimestampMonotonic'
  ];
  const text = execFileSync(
    'systemctl',
    ['show', unit, ...fields.flatMap(field => ['-p', field]), '--no-pager'],
    { encoding: 'utf8', timeout: 5000 }
  );
  return Object.fromEntries(
    text.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    })
  );
}

function benchmarkState() {
  const state = systemdProperties('stay-p1-physiology-benchmark.service');
  return {
    activeState: state.ActiveState,
    subState: state.SubState,
    mainPid: Number(state.MainPID || 0)
  };
}

function checkpointFile(hash) {
  if (!/^[0-9a-f]{64}$/.test(hash)) fail('I4G_LIVE_CHECKPOINT', 'checkpoint hash is invalid');
  return path.join(DATA_ROOT, 'blobs', 'sha256', hash.slice(0, 2), hash);
}

function readCheckpoint(hash, byteLength) {
  const file = checkpointFile(hash);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('I4G_LIVE_CHECKPOINT', 'checkpoint blob is not regular');
  const bytes = fs.readFileSync(file);
  if (bytes.length !== Number(byteLength) || sha256(bytes) !== hash) {
    fail('I4G_LIVE_CHECKPOINT', 'checkpoint blob integrity failed');
  }
  return JSON.parse(bytes.toString('utf8'));
}

function captureDatabase() {
  const database = new DatabaseSync(DATABASE, { open: true, readOnly: true });
  database.exec('PRAGMA query_only=ON');
  database.exec('BEGIN');
  try {
    const resident = database.prepare(`SELECT residency_id, core_id, role, instance_id, version,
      state_schema, module_relative_path, module_hash, manifest_hash, package_policy_hash,
      organism_identity_hash, checkpoint_hash, checkpoint_generation, status, updated_at
      FROM resident_instances WHERE residency_id='resident:sntss'`).get() || null;
    const checkpoint = database.prepare(`SELECT generation, blob_hash, byte_length, input_cursor,
      created_at FROM resident_checkpoints WHERE residency_id='resident:sntss'
      ORDER BY generation DESC LIMIT 1`).get() || null;
    const identity = database.prepare("SELECT json, sha256 FROM metadata WHERE key='life:identity'").get() || null;
    const outputCount = Number(database.prepare(`SELECT COUNT(*) count FROM biological_outbox_intents
      WHERE producer_core_id='sntss'`).get()?.count || 0);
    const authorityCount = Number(database.prepare(`SELECT COUNT(*) count FROM authority
      WHERE core_id='sntss'`).get()?.count || 0);
    const state = checkpoint ? readCheckpoint(checkpoint.blob_hash, checkpoint.byte_length) : null;
    const identityValue = identity?.json ? JSON.parse(identity.json) : null;
    const identitySha256 = identityValue
      ? `sha256:${sha256(Buffer.from(stableStringify(identityValue)))}`
      : null;
    return {
      quickCheck: database.prepare('PRAGMA quick_check').get()?.quick_check || null,
      identity: identityValue,
      identitySha256,
      metadataSha256: identity?.sha256 ? `sha256:${identity.sha256}` : null,
      resident,
      checkpoint,
      outputCount,
      authorityCount,
      state
    };
  } finally {
    try { database.exec('ROLLBACK'); } catch {}
    database.close();
  }
}

function assertLiveDatabase(sample) {
  const resident = sample.resident;
  const checkpoint = sample.checkpoint;
  const state = sample.state;
  const checks = {
    quickCheck: sample.quickCheck === 'ok',
    identity: /^sha256:[0-9a-f]{64}$/.test(sample.identitySha256 || '') &&
      sample.identity?.lineage === 'STAY/Genesis',
    residency: resident?.residency_id === 'resident:sntss' && resident?.core_id === 'sntss',
    version: resident?.version === '0.4.0-i3d3' && Number(resident?.state_schema) === 4,
    module: resident?.module_relative_path === 'cores/sntss/i3d/index.js',
    policy: resident?.package_policy_hash === EXPECTED_LIVE_POLICY,
    running: resident?.status === 'RUNNING',
    checkpoint: Number(checkpoint?.generation) === Number(resident?.checkpoint_generation) &&
      checkpoint?.blob_hash === resident?.checkpoint_hash,
    state: state?.stateSchema === 4 && state?.stage === 'i3d-durable-receptor-regulation',
    binding: state?.organismBinding?.identitySha256 === sample.identitySha256 &&
      resident?.organism_identity_hash === sample.identitySha256,
    clocks: Number(state?.chemistry?.modelClock) === Number(state?.receptorAdaptation?.modelClock) &&
      Number(state?.chemistry?.modelClock) === Number(state?.receptorAvailability?.modelClock),
    output: sample.outputCount === 0,
    authority: sample.authorityCount === 0
  };
  const failures = Object.entries(checks).filter(([, value]) => !value).map(([name]) => name);
  if (failures.length) fail('I4G_LIVE_BASELINE', 'R105F live SNTSS baseline is invalid', failures);
  return sample;
}

async function captureLive() {
  const [health, meta] = await Promise.all([requestJson('/healthz'), requestJson('/__stay/meta')]);
  return {
    capturedAt: new Date().toISOString(),
    service: systemdProperties('stay.service'),
    benchmark: benchmarkState(),
    currentRelease: fs.realpathSync('/opt/stay/current'),
    health,
    meta,
    database: assertLiveDatabase(captureDatabase())
  };
}

function assertLiveEnvelope(sample) {
  let freezeValid = false;
  try {
    const stat = fs.lstatSync(FREEZE);
    const record = JSON.parse(fs.readFileSync(FREEZE, 'utf8'));
    freezeValid = stat.isFile() && !stat.isSymbolicLink() &&
      validateRevisionFreeze(record, 105) &&
      record.recordSha256 === `sha256:${EXPECTED_FREEZE_SHA256}`;
  } catch {}
  const checks = {
    service: sample.service.ActiveState === 'active' && sample.service.SubState === 'running' &&
      Number(sample.service.MainPID) > 1,
    release: sample.currentRelease === CURRENT_RELEASE,
    health: sample.health?.ok === true && Number(sample.health?.revision) === 105,
    metadata: sample.meta?.revisionFrozen === true && sample.meta?.revisionLabel === 'R105F' &&
      Number(sample.meta?.revision) === 105,
    benchmark: sample.benchmark.activeState === 'active',
    freeze: freezeValid
  };
  const failures = Object.entries(checks).filter(([, value]) => !value).map(([name]) => name);
  if (failures.length) fail('I4G_LIVE_ENVELOPE', 'R105F live envelope is invalid', failures);
}

function inheritedPhysiology(state) {
  return {
    organismBinding: state.organismBinding,
    chemistry: state.chemistry,
    receptorAdaptation: state.receptorAdaptation,
    receptorAvailability: state.receptorAvailability,
    trustedTime: state.trustedTime
  };
}

function clientFor(definition, instanceId) {
  return new CoreHostClient({
    modulePath: definition.modulePath,
    expectedManifest: definition.manifest,
    instanceId,
    mode: 'standby',
    logger: { log() {}, info() {}, warn() {}, error() {} },
    policy: {
      resources: definition.manifest.resources,
      priority: definition.manifest.priority
    }
  });
}

async function stopClient(client) {
  if (!client) return;
  client.stopping = true;
  await client.stop();
}

async function rehearseCandidate(before) {
  process.env.STAY_REQUIRE_CGROUPS = '0';
  process.env.STAY_CGROUP_ROOT = '/dev/null';
  process.env.STAY_REQUIRE_CORE_PACKAGE_POLICY = '1';

  const definition = await inspectCoreModule(MODULE);
  if (definition.manifest.version !== '0.5.0-i4g1' || definition.manifest.stateSchema !== 5 ||
      definition.manifest.productionEligible !== false || definition.manifest.outputs.length !== 0 ||
      definition.packagePolicyHash !== EXPECTED_CANDIDATE_POLICY) {
    fail('I4G_CANDIDATE_IDENTITY', 'candidate manifest or package identity is invalid');
  }

  const source = before.database.state;
  const checkpoint = before.database.checkpoint;
  let outputs = 0;
  let first = clientFor(definition, 'r105f-i4g-rehearsal-a');
  first.on('output', async () => { outputs += 1; });
  try {
    await first.start(source, 4);
    const migrated = await first.snapshot();
    if (stableStringify(inheritedPhysiology(migrated)) !== stableStringify(inheritedPhysiology(source)) ||
        migrated.stateSchema !== 5 || migrated.individuality !== null) {
      fail('I4G_MIGRATION_CONTINUITY', 'schema-5 migration altered prenatal physiology');
    }

    const seedHex = crypto.randomBytes(32).toString('hex');
    const eventSequence = Math.max(1, Number(checkpoint.input_cursor || 0) + 1);
    const eventAt = Math.max(Date.now(), Number(source.organismBinding.issuedAt));
    const event = {
      id: `r105f-i4g-rehearsal:${checkpoint.blob_hash}`,
      sequence: eventSequence,
      class: 'durable',
      topic: 'runtime.sntss.continuity-genesis',
      at: eventAt,
      payload: {
        formatVersion: 1,
        authorization: AUTHORIZATION,
        organismIdentitySha256: before.database.identitySha256,
        parentFreezeRevision: 105,
        parentFreezeRecordSha256: `sha256:${EXPECTED_FREEZE_SHA256}`,
        runtimeRevision: 106,
        seedHex,
        sourceCheckpointGeneration: Number(checkpoint.generation),
        sourceCheckpointHash: `sha256:${checkpoint.blob_hash}`
      },
      ledger: { durable: true },
      meta: { sourceCore: 'living-kernel', authorityEpoch: 106 }
    };

    const accepted = await first.dispatch(event, { eventSequence });
    const born = accepted.checkpoint || await first.snapshot();
    if (!born.individuality || born.individuality.seedCommitmentSha256 == null ||
        stableStringify(inheritedPhysiology(born)) !== stableStringify(inheritedPhysiology(source)) ||
        stableStringify(born).includes(seedHex)) {
      fail('I4G_GENESIS_CONTINUITY', 'continuity genesis did not preserve prenatal physiology');
    }

    const replay = await first.dispatch(event, { eventSequence });
    if (stableStringify(replay.checkpoint) !== stableStringify(born)) {
      fail('I4G_GENESIS_REPLAY', 'exact genesis replay is not idempotent');
    }
    let secondGenesisCode = null;
    try {
      await first.dispatch({ ...event, id: `${event.id}:second`, sequence: eventSequence + 1 },
        { eventSequence: eventSequence + 1 });
    } catch (error) {
      secondGenesisCode = error?.code || null;
    }
    if (secondGenesisCode !== 'SNTSS_SECOND_GENESIS') {
      fail('I4G_SECOND_GENESIS', 'different second genesis did not fail closed', secondGenesisCode);
    }

    const firstHealth = await first.health();
    await stopClient(first);
    first = null;

    let restarted = clientFor(definition, 'r105f-i4g-rehearsal-b');
    restarted.on('output', async () => { outputs += 1; });
    try {
      await restarted.start(born, 5);
      const restored = await restarted.snapshot();
      if (stableStringify(restored.individuality) !== stableStringify(born.individuality)) {
        fail('I4G_RESTART_CONTINUITY', 'individuality changed across isolated restart');
      }

      const anchorAt = Math.max(Date.now(), Number(restored.trustedTime.lastWallClockMs) + 60000);
      const anchor = {
        id: 'i4g-isolated-pulse-106-1', sequence: eventSequence + 2, class: 'durable',
        topic: 'runtime.time.pulse', at: anchorAt,
        payload: { wallClockMs: anchorAt, runtimeRevision: 106, pulseSequence: 1, clockStatus: 'trusted' },
        meta: { sourceCore: 'living-kernel', authorityEpoch: 106 }
      };
      const advance = {
        ...anchor,
        id: 'i4g-isolated-pulse-106-2',
        sequence: eventSequence + 3,
        at: anchorAt + 250,
        payload: { ...anchor.payload, wallClockMs: anchorAt + 250, pulseSequence: 2 }
      };
      await restarted.dispatch(anchor, { eventSequence: anchor.sequence });
      const advanced = await restarted.dispatch(advance, { eventSequence: advance.sequence });
      const finalState = advanced.checkpoint || await restarted.snapshot();
      const finalHealth = await restarted.health();
      if (finalState.chemistry.modelClock !== born.chemistry.modelClock + 250 ||
          stableStringify(finalState.individuality) !== stableStringify(born.individuality) ||
          finalHealth.continuityGenesisEstablished !== true || outputs !== 0) {
        fail('I4G_POST_GENESIS_PHYSIOLOGY', 'post-genesis physiology or zero-output boundary failed');
      }
      return {
        candidate: {
          moduleSha256: definition.moduleDigest,
          packagePolicySha256: definition.packagePolicyHash,
          manifest: definition.manifest
        },
        source: {
          checkpointGeneration: Number(checkpoint.generation),
          checkpointSha256: `sha256:${checkpoint.blob_hash}`,
          modelClock: source.chemistry.modelClock,
          physiologySha256: `sha256:${sha256(Buffer.from(stableStringify(inheritedPhysiology(source))))}`
        },
        genesis: born.individuality,
        firstHealth,
        finalHealth,
        postGenesisModelClock: finalState.chemistry.modelClock,
        exactReplay: 'PASS',
        secondGenesisRejection: secondGenesisCode,
        outputs
      };
    } finally {
      await stopClient(restarted);
    }
  } finally {
    await stopClient(first);
  }
}

function assertLiveUnchanged(before, after) {
  const checks = {
    service: after.service.ActiveState === 'active' && after.service.SubState === 'running',
    pid: after.service.MainPID === before.service.MainPID,
    restarts: after.service.NRestarts === before.service.NRestarts,
    start: after.service.ExecMainStartTimestampMonotonic === before.service.ExecMainStartTimestampMonotonic,
    release: after.currentRelease === before.currentRelease,
    revision: Number(after.health?.revision) === 105 && after.meta?.revisionLabel === 'R105F',
    benchmark: after.benchmark.activeState === 'active' &&
      after.benchmark.mainPid === before.benchmark.mainPid,
    resident: after.database.resident?.instance_id === before.database.resident?.instance_id &&
      after.database.resident?.version === '0.4.0-i3d3' &&
      Number(after.database.resident?.state_schema) === 4,
    output: after.database.outputCount === 0,
    authority: after.database.authorityCount === 0
  };
  const failures = Object.entries(checks).filter(([, value]) => !value).map(([name]) => name);
  if (failures.length) fail('I4G_LIVE_CHANGED', 'isolated rehearsal changed the live envelope', failures);
}

function writeEvidence(record) {
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true, mode: 0o700 });
  const stamp = record.completedAt.replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z');
  const directory = path.join(EVIDENCE_ROOT, `R105F-${stamp}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
  const recordFile = path.join(directory, 'record.json');
  fs.writeFileSync(recordFile, bytes, { mode: 0o400, flag: 'wx' });
  const recordSha256 = `sha256:${sha256(bytes)}`;
  fs.writeFileSync(path.join(directory, 'record.sha256'), `${recordSha256.slice(7)}  record.json\n`,
    { mode: 0o400, flag: 'wx' });
  return { directory, recordSha256 };
}

async function run() {
  if (process.getuid?.() !== 0) fail('I4G_ROOT_REQUIRED', 'root is required for host rehearsal');
  const before = await captureLive();
  assertLiveEnvelope(before);
  const rehearsal = await rehearseCandidate(before);
  const after = await captureLive();
  assertLiveEnvelope(after);
  assertLiveUnchanged(before, after);
  const record = {
    format: 'stay-sntss-i4g-continuity-rehearsal-v1',
    result: 'PASS',
    startedAt: before.capturedAt,
    completedAt: after.capturedAt,
    parent: {
      revision: 105,
      revisionLabel: 'R105F',
      release: before.currentRelease,
      freezeRecordSha256: `sha256:${EXPECTED_FREEZE_SHA256}`
    },
    rehearsal,
    liveContinuity: {
      revisionChanged: false,
      releaseChanged: false,
      serviceRestarted: false,
      benchmarkInterrupted: false,
      liveResidentReplaced: false,
      sntssAuthority: 'NONE',
      sntssOutputs: 0
    },
    before: {
      service: before.service,
      benchmark: before.benchmark,
      checkpointGeneration: Number(before.database.checkpoint.generation)
    },
    after: {
      service: after.service,
      benchmark: after.benchmark,
      checkpointGeneration: Number(after.database.checkpoint.generation)
    }
  };
  const evidence = writeEvidence(record);
  return { record, evidence };
}

if (require.main === module) {
  run().then(({ record, evidence }) => {
    process.stdout.write([
      'P1_SNTSS_I4G_REHEARSAL_RESULT=PASS',
      'LIVE_REVISION=R105F',
      `SOURCE_CHECKPOINT_GENERATION=${record.rehearsal.source.checkpointGeneration}`,
      `SOURCE_CHECKPOINT_SHA256=${record.rehearsal.source.checkpointSha256}`,
      `CANDIDATE_VERSION=${record.rehearsal.candidate.manifest.version}`,
      `CANDIDATE_STATE_SCHEMA=${record.rehearsal.candidate.manifest.stateSchema}`,
      `CANDIDATE_PACKAGE_POLICY_SHA256=${record.rehearsal.candidate.packagePolicySha256}`,
      `LINEAGE_SHA256=${record.rehearsal.genesis.lineageSha256}`,
      `SEED_COMMITMENT_SHA256=${record.rehearsal.genesis.seedCommitmentSha256}`,
      `PRENATAL_STATE_SHA256=${record.rehearsal.genesis.prenatalStateSha256}`,
      'EXACT_REPLAY=PASS',
      'SECOND_GENESIS_REJECTION=SNTSS_SECOND_GENESIS',
      'POST_GENESIS_PHYSIOLOGY_ADVANCE=PASS',
      'CANDIDATE_OUTPUTS=0',
      'LIVE_SERVICE_RESTARTED=NO',
      'LIVE_REVISION_CHANGED=NO',
      'LIVE_RESIDENT_REPLACED=NO',
      'BENCHMARK_INTERRUPTED=NO',
      `EVIDENCE=${evidence.directory}`,
      `EVIDENCE_SHA256=${evidence.recordSha256}`
    ].join('\n') + '\n');
  }).catch(error => {
    process.stderr.write(`P1_SNTSS_I4G_REHEARSAL_ABORT=${error?.code || 'failed'}\n`);
    if (error?.detail) process.stderr.write(`DETAIL=${JSON.stringify(error.detail)}\n`);
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED_FREEZE_SHA256,
  EXPECTED_CANDIDATE_POLICY,
  inheritedPhysiology,
  assertLiveDatabase,
  assertLiveEnvelope,
  assertLiveUnchanged,
  rehearseCandidate,
  run
};
