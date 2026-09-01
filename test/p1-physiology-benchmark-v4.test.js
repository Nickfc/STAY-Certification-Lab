'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const benchmark = require('../deploy/live-physiology-transplant/p1-physiology-benchmark');
const benchmarkV4 = require('../scripts/p1-physiology-benchmark-v4');

const MIB = 1024 * 1024;

function benchmarkSample({ generation = 10, capturedAt = '2026-08-25T00:00:00.000Z' } = {}) {
  const memoryPlan = {
    accounting: 'payload-cgroup-plus-kernel-supervisor',
    cgroupSoftBytes: 64 * MIB,
    cgroupHardBytes: 96 * MIB
  };
  const resident = (version, processes, supervisorPid) => ({
    version,
    status: 'RUNNING',
    running: true,
    authorityOwned: false,
    checkpointGeneration: generation,
    handledEvents: generation,
    observedOutputs: version.startsWith('0.5') ? 0 : 1,
    health: { ok: true },
    resyncRequired: false,
    queue: {
      failed: 0,
      timedOut: 0,
      stalled: 0,
      recovered: 0,
      recoveryRejected: 0,
      recoveryTimedOut: 0
    },
    durabilityContract: {
      eventCheckpointConsumerAckAtomic: true,
      outboxIntentInSameCommit: true,
      biologicalPublicationFromCommittedOutboxOnly: true,
      recoveryImageAdvancesAfterCommitOnly: true,
      activationGapBackfillAtomic: true,
      outboxPublicationSingleFlight: true,
      startupFailureTeardownComplete: true
    },
    host: {
      pid: supervisorPid,
      deadlineContract: {
        workerTransitionTimeoutMs: 250,
        ipcTransitionTimeoutMs: 1000,
        eventAndCheckpointCombined: true,
        outputsReleasedAfterCheckpoint: true
      },
      osContainment: {
        memoryPlan,
        required: true,
        available: true,
        payloadPids: processes,
        payloadAttachedBeforeInit: true,
        payloadQuiescedBeforeSpawn: true
      }
    },
    processes
  });
  const sntss = resident('0.5.0-i4g1', [11, 12], 101);
  const chronobiology = resident('1.0.0-c3rc.1', [21, 22], 102);
  return {
    capturedAt,
    health: { ok: true, revision: 111 },
    meta: {
      revisionFrozen: true,
      revisionLabel: 'R111F',
      systems: [{
        id: 'bsf', mode: 'LIVE', status: 'RUNNING', running: true,
        healthOk: true, writeFailures: 0
      }],
      residents: [
        { residencyId: 'resident:sntss', running: true, mode: 'SHADOW' },
        { residencyId: 'resident:chronobiology', running: true, mode: 'SHADOW' }
      ]
    },
    residents: { sntss, chronobiology },
    database: {
      quickCheck: 'ok',
      pendingDeliveries: 0,
      failedDeliveries: 0,
      pendingOutboxIntents: 0,
      sntssAuthorityRows: 0,
      chronobiologyAuthorityRows: 0,
      sntssOutputRows: 0,
      chronobiologyOutputRows: 1,
      sntssCoreHostFaults: 100,
      sntssCoreHostTimeouts: 50,
      chronobiologyCoreHostFaults: 10,
      chronobiologyCoreHostTimeouts: 5,
      sntssResyncRows: 8,
      chronobiologyResyncRows: 2,
      sntssDeliveryRetryRows: 12,
      chronobiologyDeliveryRetryRows: 1,
      maintenanceFailureRows: 4,
      startupTeardownFailureRows: 0,
      detachTeardownFailureRows: 0,
      terminalTeardownFailureRows: 0,
      shutdownCheckpointFailureRows: 0,
      shutdownStopFailureRows: 0,
      outboxPendingRows: 7,
      duplicateResyncGroups: 3,
      recoveryWatermarks: {
        sntssCoreHostFaults: 1000,
        sntssCoreHostTimeouts: 1000,
        chronobiologyCoreHostFaults: 900,
        chronobiologyCoreHostTimeouts: 900,
        sntssResyncRows: 800,
        chronobiologyResyncRows: 700,
        sntssDeliveryRetryRows: 600,
        chronobiologyDeliveryRetryRows: 500,
        maintenanceFailureRows: 400,
        startupTeardownFailureRows: 0,
        detachTeardownFailureRows: 0,
        terminalTeardownFailureRows: 0,
        shutdownCheckpointFailureRows: 0,
        shutdownStopFailureRows: 0,
        outboxPendingRows: 300
      }
    },
    service: {
      pid: 500,
      processTicks: generation,
      systemTicks: generation * 100,
      rssBytes: 80 * MIB,
      cgroup: {
        required: true,
        delegateSubgroup: 'stay-kernel',
        parentProcesses: [],
        subtreeControl: 'cpu memory pids',
        memoryCurrent: 240 * MIB,
        kernelProcesses: [500, 101, 102],
        sntss: {
          ambiguous: false,
          activeLeafCount: 1,
          processes: [11, 12],
          memoryCurrent: 90 * MIB,
          memoryPeak: 95 * MIB,
          memoryHigh: String(memoryPlan.cgroupSoftBytes),
          memoryMax: String(memoryPlan.cgroupHardBytes),
          pidsCurrent: 2,
          pidsMax: '16',
          cpuMax: '20000 100000',
          memoryEvents: { low: 0, high: 4, max: 0, oom: 0, oom_kill: 0 },
          pidsEvents: { max: 2 },
          cpuStat: {
            usage_usec: generation * 1000,
            nr_periods: generation * 10,
            nr_throttled: 3,
            throttled_usec: 300
          }
        },
        chronobiology: {
          ambiguous: false,
          activeLeafCount: 1,
          processes: [21, 22],
          memoryCurrent: 70 * MIB,
          memoryPeak: 75 * MIB,
          memoryHigh: String(memoryPlan.cgroupSoftBytes),
          memoryMax: String(memoryPlan.cgroupHardBytes),
          pidsCurrent: 2,
          pidsMax: '16',
          cpuMax: '20000 100000',
          memoryEvents: { low: 0, high: 1, max: 0, oom: 0, oom_kill: 0 },
          pidsEvents: { max: 0 },
          cpuStat: {
            usage_usec: generation * 500,
            nr_periods: generation * 10,
            nr_throttled: 1,
            throttled_usec: 100
          }
        }
      }
    },
    databaseBytes: 8 * MIB,
    databaseWalBytes: 1 * MIB,
    databaseTotalBytes: 9 * MIB
  };
}

function outboxWitness(samples, line, overrides = {}) {
  const previous = samples[line - 2];
  const current = samples[line - 1];
  const next = samples[line];
  return {
    format: 'stay-physiology-benchmark-outbox-witness-v1',
    sourceLedgerSha256: 'sha256:fixture-ledger',
    entries: [{
      sampleLine: line,
      sampleSha256: benchmarkV4.sampleSha256(current),
      previousSampleSha256: benchmarkV4.sampleSha256(previous),
      nextSampleSha256: benchmarkV4.sampleSha256(next),
      candidateRows: [{
        producerEventId: 'chronobiology:event:fixture-1',
        producerCoreId: 'chronobiology',
        producerInstanceId: 'fixture-chronobiology',
        producerVersion: current.residents.chronobiology.version,
        authorityEpoch: 1,
        producerStreamId: 'chronobiology:fixture-stream',
        streamSequence: 89,
        transitionId: 'chronobiology:transition:fixture-1',
        checkpointGeneration: current.residents.chronobiology.checkpointGeneration,
        status: 'PUBLISHED',
        fabricSequence: 9001,
        fabricEventId: 'event:chronobiology:fixture-1',
        createdAt: '2026-09-02T09:54:30.250Z',
        publishedAt: '2026-09-02T09:54:30.750Z'
      }],
      ...overrides
    }]
  };
}

function outboxSamples() {
  const first = benchmarkSample({ generation: 1, capturedAt: '2026-08-30T09:55:30.000Z' });
  const previous = benchmarkSample({ generation: 99, capturedAt: '2026-09-02T09:53:30.000Z' });
  const pending = benchmarkSample({ generation: 100, capturedAt: '2026-09-02T09:54:30.000Z' });
  const next = benchmarkSample({ generation: 101, capturedAt: '2026-09-02T09:55:30.000Z' });
  previous.database.chronobiologyOutputRows = 88;
  pending.database.chronobiologyOutputRows = 89;
  next.database.chronobiologyOutputRows = 89;
  pending.database.pendingOutboxIntents = 1;
  pending.database.pendingDeliveries = 1;
  return [first, previous, pending, next];
}

test('BENCH-V4-01 adjudicates only one exact identity-bound committed publication window', () => {
  const samples = outboxSamples();
  const witness = outboxWitness(samples, 3);
  const classification = benchmarkV4.classifyOutboxObservation({ samples, line: 3, witness });
  assert.deepEqual(
    [classification.disposition, classification.failure, classification.evidenceComplete],
    ['COMMITTED_IN_FLIGHT_PUBLISHED', false, true]
  );

  const sourceState = benchmarkV4.replayV3(samples);
  sourceState.collectorStarts = 1;
  sourceState.collectorRestarts = 0;
  const milestone = benchmark.summary(sourceState, samples.at(-1), '72h', 72 * 60 * 60 * 1000);
  sourceState.milestones['72h'] = samples.at(-1).capturedAt;
  assert.equal(milestone.result, 'OBSERVED_FAILURES');
  assert.equal(sourceState.failures, 1);

  const report = benchmarkV4.adjudicateSamples({
    samples,
    sourceState,
    attempts: {
      format: 'stay-physiology-benchmark-collector-attempts-v1',
      attempts: 1,
      lastAttemptAt: samples[0].capturedAt
    },
    milestone,
    witness,
    sourceLedgerSha256: 'sha256:fixture-ledger'
  });
  assert.equal(report.result, 'PASS', JSON.stringify(report));
  assert.equal(report.sourceV3.result, 'OBSERVED_FAILURES');
  assert.equal(report.sourceV3.observedFailureCount, 1);
  assert.equal(report.v4.observedFailureCount, 0);
  assert.equal(report.v4.adjudicatedTransientCount, 1);
  assert.equal(report.productionMutated, false);
});

test('BENCH-V4-02 rejects repeated pending outbox debt even with a publication witness', () => {
  const samples = outboxSamples();
  samples[3].database.pendingOutboxIntents = 1;
  samples[3].database.pendingDeliveries = 1;
  const result = benchmarkV4.classifyOutboxObservation({
    samples,
    line: 3,
    witness: outboxWitness(samples, 3)
  });
  assert.equal(result.disposition, 'PERSISTENT_PENDING');
  assert.equal(result.failure, true);
});

test('BENCH-V4-03 rejects failed delivery beside an otherwise transient observation', () => {
  const samples = outboxSamples();
  samples[2].database.failedDeliveries = 1;
  const result = benchmarkV4.classifyOutboxObservation({
    samples,
    line: 3,
    witness: outboxWitness(samples, 3)
  });
  assert.equal(result.disposition, 'FAILED_DELIVERY');
  assert.equal(result.failure, true);
});

test('BENCH-V4-04 remains evidence-incomplete when durable outbox identity is missing', () => {
  const result = benchmarkV4.classifyOutboxObservation({
    samples: outboxSamples(),
    line: 3,
    witness: null
  });
  assert.equal(result.disposition, 'EVIDENCE_INCOMPLETE');
  assert.equal(result.failure, false);
  assert.equal(result.evidenceComplete, false);
});

test('BENCH-V4-05 rejects ambiguous, non-Chronobiology, or unbound witnesses', () => {
  const samples = outboxSamples();
  const exact = outboxWitness(samples, 3);
  const ambiguous = structuredClone(exact);
  ambiguous.entries[0].candidateRows.push({
    ...ambiguous.entries[0].candidateRows[0],
    producerEventId: 'other'
  });
  assert.equal(
    benchmarkV4.classifyOutboxObservation({ samples, line: 3, witness: ambiguous }).evidenceComplete,
    false
  );

  const sntss = structuredClone(exact);
  sntss.entries[0].candidateRows[0].producerCoreId = 'sntss';
  assert.equal(benchmarkV4.classifyOutboxObservation({ samples, line: 3, witness: sntss }).failure, true);

  const unbound = structuredClone(exact);
  unbound.entries[0].sampleSha256 = 'sha256:wrong';
  assert.equal(
    benchmarkV4.classifyOutboxObservation({ samples, line: 3, witness: unbound }).evidenceComplete,
    false
  );
});

test('BENCH-V4-06 captures a query-only witness and binds an exclusive immutable report', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-benchmark-v4-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const samples = outboxSamples();
  const samplesFile = path.join(root, 'samples.jsonl');
  const stateFile = path.join(root, 'state.json');
  const attemptsFile = path.join(root, 'collector-attempts.json');
  const milestoneFile = path.join(root, '72h.json');
  const witnessFile = path.join(root, 'outbox-witness.json');
  const reportFile = path.join(root, 'adjudication-v4.json');
  await fs.writeFile(samplesFile, `${samples.map(sample => JSON.stringify(sample)).join('\n')}\n`);

  const databaseFile = path.join(root, 'continuity.sqlite3');
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    CREATE TABLE biological_outbox_intents (
      producer_event_id TEXT PRIMARY KEY,
      producer_core_id TEXT NOT NULL,
      producer_instance_id TEXT NOT NULL,
      producer_version TEXT NOT NULL,
      authority_epoch INTEGER NOT NULL,
      producer_stream_id TEXT NOT NULL,
      stream_sequence INTEGER NOT NULL,
      transition_id TEXT NOT NULL,
      checkpoint_generation INTEGER NOT NULL,
      status TEXT NOT NULL,
      fabric_sequence INTEGER,
      fabric_event_id TEXT,
      created_at TEXT NOT NULL,
      published_at TEXT
    );
    INSERT INTO biological_outbox_intents VALUES (
      'chronobiology:event:fixture-1', 'chronobiology', 'fixture-chronobiology',
      '1.0.0-c3rc.1', 1, 'chronobiology:fixture-stream', 89,
      'chronobiology:transition:fixture-1', 100, 'PUBLISHED', 9001,
      'event:chronobiology:fixture-1', '2026-09-02T09:54:30.250Z',
      '2026-09-02T09:54:30.750Z'
    );
  `);
  database.close();
  const databaseBefore = await fs.readFile(databaseFile);
  const witness = await benchmarkV4.buildWitness({
    samplesFile,
    databaseFile,
    revisionLabel: 'R111F'
  });
  assert.equal(witness.queryOnly, true);
  assert.equal(witness.productionMutated, false);
  assert.equal(witness.entries.length, 1);
  assert.equal(witness.entries[0].candidateRows[0].producerEventId, 'chronobiology:event:fixture-1');
  assert.deepEqual(await fs.readFile(databaseFile), databaseBefore);
  await benchmarkV4.writeExclusive(witnessFile, witness);

  const sourceState = benchmarkV4.replayV3(samples);
  sourceState.collectorStarts = 1;
  sourceState.collectorRestarts = 0;
  const milestone = benchmark.summary(sourceState, samples.at(-1), '72h', 72 * 60 * 60 * 1000);
  sourceState.milestones['72h'] = samples.at(-1).capturedAt;
  const attempts = {
    format: 'stay-physiology-benchmark-collector-attempts-v1',
    attempts: 1,
    lastAttemptAt: samples[0].capturedAt
  };
  await fs.writeFile(stateFile, `${JSON.stringify(sourceState)}\n`);
  await fs.writeFile(attemptsFile, `${JSON.stringify(attempts)}\n`);
  await fs.writeFile(milestoneFile, `${JSON.stringify(milestone)}\n`);

  const report = await benchmarkV4.adjudicateFiles({
    samplesFile,
    stateFile,
    attemptsFile,
    milestoneFile,
    witnessFile,
    outputFile: reportFile
  });
  assert.equal(report.result, 'PASS');
  assert.equal(report.inputHashes.samples, witness.sourceLedgerSha256);
  assert.equal(JSON.parse(await fs.readFile(reportFile, 'utf8')).evidenceHash, report.evidenceHash);
  await assert.rejects(
    benchmarkV4.writeExclusive(reportFile, report),
    error => error?.code === 'EEXIST'
  );

  const restarted = structuredClone(attempts);
  restarted.attempts = 2;
  assert.throws(
    () => benchmarkV4.adjudicateSamples({
      samples,
      sourceState,
      attempts: restarted,
      milestone,
      witness,
      sourceLedgerSha256: witness.sourceLedgerSha256
    }),
    error => error?.code === 'P1_PHYSIOLOGY_V4_COLLECTOR_IDENTITY'
  );

  const substitutedState = structuredClone(sourceState);
  substitutedState.maxPendingOutboxIntents = 0;
  assert.throws(
    () => benchmarkV4.adjudicateSamples({
      samples,
      sourceState: substitutedState,
      attempts,
      milestone,
      witness,
      sourceLedgerSha256: witness.sourceLedgerSha256
    }),
    error => error?.code === 'P1_PHYSIOLOGY_V4_STATE_BINDING'
  );

  const relabelledMilestone = structuredClone(milestone);
  relabelledMilestone.result = 'PASS';
  assert.throws(
    () => benchmarkV4.adjudicateSamples({
      samples,
      sourceState,
      attempts,
      milestone: relabelledMilestone,
      witness,
      sourceLedgerSha256: witness.sourceLedgerSha256
    }),
    error => error?.code === 'P1_PHYSIOLOGY_V4_MILESTONE_BINDING'
  );

  const foreignRevisionWitness = structuredClone(witness);
  foreignRevisionWitness.revisionLabel = 'R123F';
  assert.throws(
    () => benchmarkV4.adjudicateSamples({
      samples,
      sourceState,
      attempts,
      milestone,
      witness: foreignRevisionWitness,
      sourceLedgerSha256: witness.sourceLedgerSha256
    }),
    error => error?.code === 'P1_PHYSIOLOGY_V4_WITNESS_BINDING'
  );
});
