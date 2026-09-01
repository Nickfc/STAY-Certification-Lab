#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');

const benchmarkV3 = require('../deploy/live-physiology-transplant/p1-physiology-benchmark');

const REPORT_FORMAT = 'stay-physiology-benchmark-adjudication-v4';
const WITNESS_FORMAT = 'stay-physiology-benchmark-outbox-witness-v1';
const STATE_FORMAT = 'stay-physiology-benchmark-state-v3';
const MILESTONE_FORMAT = 'stay-physiology-benchmark-milestone-v3';
const ATTEMPTS_FORMAT = 'stay-physiology-benchmark-collector-attempts-v1';
const COMPLETE_MS = 72 * 60 * 60 * 1000;
const MAX_ADJACENT_SAMPLE_GAP_MS = 75_000;
const MAX_LEDGER_LINE_BYTES = 512 * 1024;
const RECOVERY_FIELDS = Object.freeze([
  'sntssCoreHostFaults',
  'sntssCoreHostTimeouts',
  'chronobiologyCoreHostFaults',
  'chronobiologyCoreHostTimeouts',
  'sntssResyncRows',
  'chronobiologyResyncRows',
  'sntssDeliveryRetryRows',
  'chronobiologyDeliveryRetryRows',
  'maintenanceFailureRows',
  'startupTeardownFailureRows',
  'detachTeardownFailureRows',
  'terminalTeardownFailureRows',
  'shutdownCheckpointFailureRows',
  'shutdownStopFailureRows',
  'outboxPendingRows',
  'duplicateResyncGroups'
]);
const OBSERVED_STATE_FIELDS = Object.freeze([
  'failures',
  'collectorRestarts',
  ...RECOVERY_FIELDS,
  'sntssMemoryHighEvents',
  'sntssMemoryMaxEvents',
  'sntssMemoryOomEvents',
  'sntssMemoryOomKillEvents',
  'sntssPidsMaxEvents',
  'sntssCpuThrottledPeriods',
  'chronobiologyMemoryHighEvents',
  'chronobiologyMemoryMaxEvents',
  'chronobiologyMemoryOomEvents',
  'chronobiologyMemoryOomKillEvents',
  'chronobiologyPidsMaxEvents',
  'chronobiologyCpuThrottledPeriods',
  'sntssProcessTransitions',
  'chronobiologyProcessTransitions',
  'mainPidTransitions'
]);
const REPLAY_STATE_FIELDS = Object.freeze([
  ...OBSERVED_STATE_FIELDS,
  'maxRssBytes',
  'maxDatabaseBytes',
  'maxDatabaseWalBytes',
  'maxDatabaseTotalBytes',
  'maxPendingDeliveries',
  'maxPendingOutboxIntents',
  'maxSntssCgroupBytes',
  'maxChronobiologyCgroupBytes',
  'maxSntssCgroupPeakBytes',
  'maxChronobiologyCgroupPeakBytes',
  'startingSntssCheckpointGeneration',
  'startingChronobiologyCheckpointGeneration',
  'latestSntssCheckpointGeneration',
  'latestChronobiologyCheckpointGeneration'
]);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function evidenceHash(value) {
  return `sha256:${sha256(stable(value))}`;
}

function sampleSha256(sample) {
  return `sha256:${sha256(`${JSON.stringify(sample)}\n`)}`;
}

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function databaseNumber(sample, field) {
  return integer(sample?.database?.[field]);
}

function publicResident(sample, residencyId) {
  return Array.isArray(sample?.meta?.residents)
    ? sample.meta.residents.find(resident => resident?.residencyId === residencyId) || null
    : null;
}

function residentContained(sample, name, expectedMode) {
  const resident = sample?.residents?.[name];
  const visible = publicResident(sample, `resident:${name}`);
  return resident?.running === true && resident?.authorityOwned === false &&
    resident?.health?.ok === true && resident?.resyncRequired !== true &&
    !resident?.terminalPersistenceError && !resident?.teardownError &&
    visible?.running === true && visible?.mode === expectedMode;
}

function sampleBaseHealthy(sample) {
  const bsf = Array.isArray(sample?.meta?.systems)
    ? sample.meta.systems.find(system => system?.id === 'bsf')
    : null;
  return sample?.health?.ok === true && sample?.database?.quickCheck === 'ok' &&
    bsf?.running === true && bsf?.mode === 'LIVE' && bsf?.healthOk === true &&
    integer(bsf?.writeFailures) === 0 &&
    residentContained(sample, 'sntss', 'SHADOW') &&
    residentContained(sample, 'chronobiology', 'SHADOW') &&
    databaseNumber(sample, 'sntssAuthorityRows') === 0 &&
    databaseNumber(sample, 'chronobiologyAuthorityRows') === 0 &&
    databaseNumber(sample, 'sntssOutputRows') === 0;
}

function continuityIdentity(sample) {
  const resident = name => {
    const privateValue = sample?.residents?.[name] || {};
    const publicValue = publicResident(sample, `resident:${name}`) || {};
    return {
      version: privateValue.version || publicValue.version || null,
      instanceId: privateValue.instanceId || publicValue.instanceId || null,
      mode: publicValue.mode || null,
      running: privateValue.running === true && publicValue.running === true,
      authorityOwned: privateValue.authorityOwned === true || publicValue.authorityOwned === true
    };
  };
  return {
    revision: integer(sample?.health?.revision, -1),
    servicePid: integer(sample?.service?.pid, -1),
    sntss: resident('sntss'),
    chronobiology: resident('chronobiology')
  };
}

function recoveryCountersUnchanged(previous, current, next) {
  return RECOVERY_FIELDS.every(field => {
    const before = databaseNumber(previous, field);
    return databaseNumber(current, field) === before && databaseNumber(next, field) === before;
  });
}

function classification(disposition, { failure = false, evidenceComplete = true, detail = null } = {}) {
  return Object.freeze({ disposition, failure, evidenceComplete, detail });
}

function witnessEntry(witness, line) {
  if (!witness || witness.format !== WITNESS_FORMAT || !Array.isArray(witness.entries)) return null;
  const entries = witness.entries.filter(entry => integer(entry?.sampleLine, -1) === line);
  return entries.length === 1 ? entries[0] : null;
}

function classifyOutboxObservation({ samples, line, witness }) {
  if (!Array.isArray(samples) || !Number.isSafeInteger(line) || line < 1 || line > samples.length) {
    fail('P1_PHYSIOLOGY_V4_INPUT', 'sample line is outside the ledger');
  }
  const current = samples[line - 1];
  const pending = databaseNumber(current, 'pendingOutboxIntents');
  if (pending === 0) return classification('NOT_PENDING');
  if (pending !== 1) return classification('PENDING_BOUND_EXCEEDED', { failure: true });
  if (databaseNumber(current, 'failedDeliveries') !== 0) {
    return classification('FAILED_DELIVERY', { failure: true });
  }

  const previous = samples[line - 2];
  const next = samples[line];
  if (!previous || !next) {
    return classification('EVIDENCE_INCOMPLETE', {
      evidenceComplete: false,
      detail: 'both adjacent samples are required'
    });
  }
  if (databaseNumber(previous, 'pendingOutboxIntents') !== 0 ||
      databaseNumber(next, 'pendingOutboxIntents') !== 0) {
    return classification('PERSISTENT_PENDING', { failure: true });
  }
  if ([previous, next].some(sample => databaseNumber(sample, 'failedDeliveries') !== 0)) {
    return classification('FAILED_DELIVERY', { failure: true });
  }
  if (databaseNumber(current, 'pendingDeliveries') !== 1 ||
      databaseNumber(previous, 'pendingDeliveries') !== 0 ||
      databaseNumber(next, 'pendingDeliveries') !== 0) {
    return classification('DELIVERY_CONTINUITY_MISMATCH', { failure: true });
  }

  const previousAt = timestamp(previous.capturedAt);
  const currentAt = timestamp(current.capturedAt);
  const nextAt = timestamp(next.capturedAt);
  if (previousAt == null || currentAt == null || nextAt == null ||
      currentAt <= previousAt || nextAt <= currentAt ||
      currentAt - previousAt > MAX_ADJACENT_SAMPLE_GAP_MS ||
      nextAt - currentAt > MAX_ADJACENT_SAMPLE_GAP_MS) {
    return classification('EVIDENCE_INCOMPLETE', {
      evidenceComplete: false,
      detail: 'adjacent one-minute sampling continuity is not proven'
    });
  }
  if (![previous, current, next].every(sampleBaseHealthy)) {
    return classification('CONCURRENT_HEALTH_FAILURE', { failure: true });
  }
  const identity = stable(continuityIdentity(previous));
  if (stable(continuityIdentity(current)) !== identity || stable(continuityIdentity(next)) !== identity) {
    return classification('IDENTITY_DISCONTINUITY', { failure: true });
  }
  if (!recoveryCountersUnchanged(previous, current, next)) {
    return classification('RECOVERY_COUNTER_ADVANCED', { failure: true });
  }

  const entry = witnessEntry(witness, line);
  if (!entry || entry.sampleSha256 !== sampleSha256(current) ||
      entry.previousSampleSha256 !== sampleSha256(previous) ||
      entry.nextSampleSha256 !== sampleSha256(next)) {
    return classification('EVIDENCE_INCOMPLETE', {
      evidenceComplete: false,
      detail: 'exact adjacent sample hashes are not bound by the witness'
    });
  }
  if (!Array.isArray(entry.candidateRows) || entry.candidateRows.length !== 1) {
    return classification('EVIDENCE_INCOMPLETE', {
      evidenceComplete: false,
      detail: 'exactly one durable outbox identity must span the observation window'
    });
  }

  const intent = entry.candidateRows[0];
  if (intent?.producerCoreId !== 'chronobiology') {
    return classification('FORBIDDEN_PRODUCER', { failure: true });
  }
  const requiredStrings = [
    intent.producerEventId,
    intent.producerInstanceId,
    intent.producerVersion,
    intent.producerStreamId,
    intent.transitionId,
    intent.fabricEventId
  ];
  if (requiredStrings.some(value => typeof value !== 'string' || value.length === 0) ||
      intent.status !== 'PUBLISHED' || integer(intent.authorityEpoch, -1) < 1 ||
      integer(intent.streamSequence, -1) < 1 || integer(intent.fabricSequence, -1) < 1) {
    return classification('EVIDENCE_INCOMPLETE', {
      evidenceComplete: false,
      detail: 'durable publication identity is incomplete'
    });
  }

  const createdAt = timestamp(intent.createdAt);
  const publishedAt = timestamp(intent.publishedAt);
  if (createdAt == null || publishedAt == null || createdAt <= previousAt ||
      createdAt > publishedAt || publishedAt < currentAt || publishedAt >= nextAt) {
    return classification('EVIDENCE_INCOMPLETE', {
      evidenceComplete: false,
      detail: 'durable publication timestamps do not span the sampled pending window'
    });
  }
  const priorOutputRows = databaseNumber(previous, 'chronobiologyOutputRows');
  const currentOutputRows = databaseNumber(current, 'chronobiologyOutputRows');
  if (currentOutputRows !== priorOutputRows + 1 ||
      databaseNumber(next, 'chronobiologyOutputRows') !== currentOutputRows) {
    return classification('EVIDENCE_INCOMPLETE', {
      evidenceComplete: false,
      detail: 'the cumulative producer row transition does not identify one intent'
    });
  }
  const priorGeneration = integer(previous?.residents?.chronobiology?.checkpointGeneration, -1);
  const nextGeneration = integer(next?.residents?.chronobiology?.checkpointGeneration, -1);
  const intentGeneration = integer(intent.checkpointGeneration, -1);
  if (intentGeneration <= priorGeneration || intentGeneration > nextGeneration) {
    return classification('EVIDENCE_INCOMPLETE', {
      evidenceComplete: false,
      detail: 'the intent is not bound to the advancing Chronobiology checkpoint interval'
    });
  }
  const observedVersion = current?.residents?.chronobiology?.version;
  const observedInstance = current?.residents?.chronobiology?.instanceId ||
    publicResident(current, 'resident:chronobiology')?.instanceId || null;
  if (intent.producerVersion !== observedVersion ||
      (observedInstance && intent.producerInstanceId !== observedInstance)) {
    return classification('IDENTITY_DISCONTINUITY', { failure: true });
  }

  return classification('COMMITTED_IN_FLIGHT_PUBLISHED', {
    detail: Object.freeze({
      producerEventId: intent.producerEventId,
      producerCoreId: intent.producerCoreId,
      checkpointGeneration: intentGeneration,
      fabricSequence: integer(intent.fabricSequence),
      publishedAt: intent.publishedAt
    })
  });
}

function replayV3(samples, transientLines = new Set()) {
  if (!Array.isArray(samples) || samples.length === 0) {
    fail('P1_PHYSIOLOGY_V4_LEDGER', 'sample ledger is empty');
  }
  const firstAt = timestamp(samples[0]?.capturedAt);
  if (firstAt == null) fail('P1_PHYSIOLOGY_V4_LEDGER', 'first sample timestamp is invalid');
  const state = benchmarkV3.initialState(samples[0]);
  let priorAt = null;
  for (let index = 0; index < samples.length; index += 1) {
    const capturedAt = timestamp(samples[index]?.capturedAt);
    if (capturedAt == null || (priorAt != null && capturedAt <= priorAt)) {
      fail('P1_PHYSIOLOGY_V4_LEDGER', `sample timestamps are not strictly increasing at line ${index + 1}`);
    }
    priorAt = capturedAt;
    const sample = {
      ...samples[index],
      database: transientLines.has(index + 1)
        ? { ...samples[index].database, pendingOutboxIntents: 0 }
        : samples[index].database
    };
    benchmarkV3.updateState(state, sample, Math.max(0, capturedAt - firstAt));
  }
  return state;
}

function assertSourceState(sourceState, replayed, samples) {
  if (sourceState?.format !== STATE_FORMAT || integer(sourceState.samples, -1) !== samples.length ||
      integer(sourceState.runtimeRevision, -1) !== integer(replayed.runtimeRevision, -2) ||
      sourceState.startedAt !== samples[0].capturedAt) {
    fail('P1_PHYSIOLOGY_V4_STATE_BINDING', 'V3 state does not match a deterministic ledger replay');
  }
  for (const field of REPLAY_STATE_FIELDS) {
    if (integer(sourceState[field]) !== integer(replayed[field])) {
      fail('P1_PHYSIOLOGY_V4_STATE_BINDING', `V3 state counter differs from ledger replay: ${field}`);
    }
  }
}

function milestoneComplete(milestone, sourceState, samples, sourceObservedFailureCount, attempts) {
  if (!milestone) return false;
  const elapsedByLedger = timestamp(samples.at(-1).capturedAt) - timestamp(samples[0].capturedAt);
  const checkpointProgress = {
    sntss: integer(sourceState.latestSntssCheckpointGeneration) -
      integer(sourceState.startingSntssCheckpointGeneration),
    chronobiology: integer(sourceState.latestChronobiologyCheckpointGeneration) -
      integer(sourceState.startingChronobiologyCheckpointGeneration)
  };
  const expectedResult = sourceObservedFailureCount === 0 ? 'PASS' : 'OBSERVED_FAILURES';
  if (milestone.format !== MILESTONE_FORMAT || milestone.milestone !== '72h' ||
      integer(milestone.elapsedMs, -1) < COMPLETE_MS ||
      elapsedByLedger < COMPLETE_MS ||
      integer(milestone.samples, -1) !== samples.length ||
      integer(milestone.runtimeRevision, -1) !== integer(sourceState.runtimeRevision, -2) ||
      integer(milestone.failures, -1) !== integer(sourceState.failures, -2) ||
      integer(milestone.observedFailureCount, -1) !== sourceObservedFailureCount ||
      milestone.startedAt !== sourceState.startedAt ||
      milestone.capturedAt !== samples.at(-1).capturedAt ||
      sampleSha256(milestone.final) !== sampleSha256(samples.at(-1)) ||
      milestone.progressOk !== true ||
      integer(milestone.checkpointProgress?.sntss, -1) !== checkpointProgress.sntss ||
      integer(milestone.checkpointProgress?.chronobiology, -1) !== checkpointProgress.chronobiology ||
      checkpointProgress.sntss < 1 || checkpointProgress.chronobiology < 1 ||
      milestone.result !== expectedResult ||
      sourceState.milestones?.['72h'] !== milestone.capturedAt) {
    fail('P1_PHYSIOLOGY_V4_MILESTONE_BINDING', '72-hour milestone is incomplete or not bound to the ledger');
  }
  if (attempts?.format !== ATTEMPTS_FORMAT || integer(attempts.attempts, -1) !== 1 ||
      integer(sourceState.collectorStarts, -1) !== 1 || integer(sourceState.collectorRestarts, -1) !== 0 ||
      integer(milestone.collector?.starts, -1) !== 1 || integer(milestone.collector?.restarts, -1) !== 0) {
    fail('P1_PHYSIOLOGY_V4_COLLECTOR_IDENTITY', 'one uninterrupted collector is required');
  }
  return true;
}

function adjudicateSamples({
  samples,
  sourceState,
  milestone = null,
  attempts = null,
  witness = null,
  sourceLedgerSha256 = null,
  inputHashes = null
}) {
  if (witness && witness.sourceLedgerSha256 !== sourceLedgerSha256) {
    fail('P1_PHYSIOLOGY_V4_WITNESS_BINDING', 'outbox witness belongs to another sample ledger');
  }
  if (witness?.revisionLabel && samples.some(sample => sample?.meta?.revisionLabel !== witness.revisionLabel)) {
    fail('P1_PHYSIOLOGY_V4_WITNESS_BINDING', 'outbox witness belongs to another frozen revision label');
  }
  const replayedSource = replayV3(samples);
  replayedSource.collectorStarts = integer(sourceState?.collectorStarts);
  replayedSource.collectorRestarts = integer(sourceState?.collectorRestarts);
  assertSourceState(sourceState, replayedSource, samples);

  const pendingLines = [];
  for (let index = 0; index < samples.length; index += 1) {
    if (databaseNumber(samples[index], 'pendingOutboxIntents') > 0) pendingLines.push(index + 1);
  }
  const observations = pendingLines.map(line => ({
    line,
    capturedAt: samples[line - 1].capturedAt,
    ...classifyOutboxObservation({ samples, line, witness })
  }));
  const transientLines = new Set(
    observations.filter(value => value.disposition === 'COMMITTED_IN_FLIGHT_PUBLISHED').map(value => value.line)
  );
  const replayedV4 = replayV3(samples, transientLines);
  replayedV4.collectorStarts = integer(sourceState.collectorStarts);
  replayedV4.collectorRestarts = integer(sourceState.collectorRestarts);
  const sourceObservedFailureCount = benchmarkV3.observedFailures(replayedSource);
  const v4ObservedFailureCount = benchmarkV3.observedFailures(replayedV4);
  const complete = milestoneComplete(
    milestone,
    sourceState,
    samples,
    sourceObservedFailureCount,
    attempts
  );
  const evidenceIncomplete = observations.some(value => value.evidenceComplete !== true);
  const observationFailure = observations.some(value => value.failure === true);
  let result = 'IN_PROGRESS';
  if (complete) {
    if (observationFailure || v4ObservedFailureCount !== 0) result = 'OBSERVED_FAILURES';
    else if (evidenceIncomplete) result = 'EVIDENCE_INCOMPLETE';
    else result = 'PASS';
  }
  const body = {
    format: REPORT_FORMAT,
    result,
    productionMutated: false,
    sourceContract: STATE_FORMAT,
    sourceLedgerSha256,
    inputHashes,
    sourceV3: {
      result: milestone?.result || 'IN_PROGRESS',
      samples: samples.length,
      failures: integer(sourceState.failures),
      observedFailureCount: sourceObservedFailureCount,
      collectorStarts: integer(sourceState.collectorStarts),
      collectorRestarts: integer(sourceState.collectorRestarts)
    },
    v4: {
      observedFailureCount: v4ObservedFailureCount,
      adjudicatedTransientCount: transientLines.size,
      evidenceIncompleteCount: observations.filter(value => !value.evidenceComplete).length,
      hardObservationFailureCount: observations.filter(value => value.failure).length
    },
    checkpointProgress: milestone?.checkpointProgress || {
      sntss: integer(replayedV4.latestSntssCheckpointGeneration) -
        integer(replayedV4.startingSntssCheckpointGeneration),
      chronobiology: integer(replayedV4.latestChronobiologyCheckpointGeneration) -
        integer(replayedV4.startingChronobiologyCheckpointGeneration)
    },
    observations
  };
  return Object.freeze({ ...body, evidenceHash: evidenceHash(body) });
}

async function assertRegularFile(file, label) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('P1_PHYSIOLOGY_V4_INPUT_PATH', `${label} must be a regular non-link file`);
  }
  return stat;
}

async function fileSha256(file) {
  await assertRegularFile(file, path.basename(file));
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(file);
    input.on('data', bytes => hash.update(bytes));
    input.once('error', reject);
    input.once('end', resolve);
  });
  return `sha256:${hash.digest('hex')}`;
}

async function loadLedger(file) {
  const stat = await assertRegularFile(file, 'sample ledger');
  if (stat.size === 0) fail('P1_PHYSIOLOGY_V4_LEDGER', 'sample ledger is empty');
  const descriptor = await fsp.open(file, 'r');
  try {
    const finalByte = Buffer.alloc(1);
    await descriptor.read(finalByte, 0, 1, stat.size - 1);
    if (finalByte[0] !== 0x0a) fail('P1_PHYSIOLOGY_V4_LEDGER', 'sample ledger final record is incomplete');
  } finally {
    await descriptor.close();
  }
  const samples = [];
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line || Buffer.byteLength(line) > MAX_LEDGER_LINE_BYTES) {
      fail('P1_PHYSIOLOGY_V4_LEDGER', `invalid sample record size at line ${lineNumber}`);
    }
    try {
      samples.push(JSON.parse(line));
    } catch (error) {
      fail('P1_PHYSIOLOGY_V4_LEDGER', `invalid JSON at sample line ${lineNumber}: ${error.message}`);
    }
  }
  return { samples, sha256: await fileSha256(file) };
}

async function readJson(file, expectedFormat) {
  await assertRegularFile(file, path.basename(file));
  let value;
  try {
    value = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    fail('P1_PHYSIOLOGY_V4_JSON', `invalid JSON evidence ${path.basename(file)}: ${error.message}`);
  }
  if (expectedFormat && value?.format !== expectedFormat) {
    fail('P1_PHYSIOLOGY_V4_FORMAT', `${path.basename(file)} has the wrong evidence format`);
  }
  return value;
}

function rowWitness(row) {
  return Object.freeze({
    producerEventId: row.producer_event_id,
    producerCoreId: row.producer_core_id,
    producerInstanceId: row.producer_instance_id,
    producerVersion: row.producer_version,
    authorityEpoch: integer(row.authority_epoch),
    producerStreamId: row.producer_stream_id,
    streamSequence: integer(row.stream_sequence),
    transitionId: row.transition_id,
    checkpointGeneration: integer(row.checkpoint_generation),
    status: row.status,
    fabricSequence: integer(row.fabric_sequence, -1),
    fabricEventId: row.fabric_event_id,
    createdAt: row.created_at,
    publishedAt: row.published_at
  });
}

async function buildWitness({ samplesFile, databaseFile, revisionLabel = null }) {
  const ledger = await loadLedger(samplesFile);
  await assertRegularFile(databaseFile, 'continuity database');
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    database.exec('PRAGMA query_only=ON');
    const quickCheck = database.prepare('PRAGMA quick_check').get()?.quick_check || null;
    if (quickCheck !== 'ok') fail('P1_PHYSIOLOGY_V4_DATABASE', 'continuity database quick-check failed');
    const query = database.prepare(`
      SELECT producer_event_id, producer_core_id, producer_instance_id, producer_version,
             authority_epoch, producer_stream_id, stream_sequence, transition_id,
             checkpoint_generation, status, fabric_sequence, fabric_event_id,
             created_at, published_at
      FROM biological_outbox_intents
      WHERE created_at>? AND created_at<?
      ORDER BY created_at, producer_event_id
    `);
    const entries = [];
    for (let index = 0; index < ledger.samples.length; index += 1) {
      const current = ledger.samples[index];
      if (databaseNumber(current, 'pendingOutboxIntents') === 0) continue;
      const previous = ledger.samples[index - 1];
      const next = ledger.samples[index + 1];
      const candidates = previous && next ? query.all(previous.capturedAt, next.capturedAt) : [];
      entries.push(Object.freeze({
        sampleLine: index + 1,
        sampleSha256: sampleSha256(current),
        previousSampleSha256: previous ? sampleSha256(previous) : null,
        nextSampleSha256: next ? sampleSha256(next) : null,
        candidateRows: candidates.map(rowWitness)
      }));
    }
    const body = {
      format: WITNESS_FORMAT,
      revisionLabel,
      sourceLedgerSha256: ledger.sha256,
      capturedAt: new Date().toISOString(),
      databaseQuickCheck: quickCheck,
      queryOnly: true,
      productionMutated: false,
      entries
    };
    return Object.freeze({ ...body, evidenceHash: evidenceHash(body) });
  } finally {
    database.close();
  }
}

async function writeExclusive(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const descriptor = await fsp.open(file, 'wx', 0o400);
  try {
    await descriptor.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  if (process.platform !== 'win32') await fsp.chmod(file, 0o400);
}

async function adjudicateFiles({
  samplesFile,
  stateFile,
  attemptsFile = null,
  milestoneFile = null,
  witnessFile = null,
  outputFile = null
}) {
  const ledger = await loadLedger(samplesFile);
  const state = await readJson(stateFile, STATE_FORMAT);
  const attempts = attemptsFile ? await readJson(attemptsFile, ATTEMPTS_FORMAT) : null;
  const milestone = milestoneFile ? await readJson(milestoneFile, MILESTONE_FORMAT) : null;
  const witness = witnessFile ? await readJson(witnessFile, WITNESS_FORMAT) : null;
  if (witness) {
    const witnessBody = { ...witness };
    delete witnessBody.evidenceHash;
    if (witness.evidenceHash !== evidenceHash(witnessBody)) {
      fail('P1_PHYSIOLOGY_V4_WITNESS_HASH', 'outbox witness evidence hash mismatch');
    }
  }
  const inputHashes = {
    samples: ledger.sha256,
    state: await fileSha256(stateFile),
    attempts: attemptsFile ? await fileSha256(attemptsFile) : null,
    milestone: milestoneFile ? await fileSha256(milestoneFile) : null,
    witness: witnessFile ? await fileSha256(witnessFile) : null
  };
  const report = adjudicateSamples({
    samples: ledger.samples,
    sourceState: state,
    attempts,
    milestone,
    witness,
    sourceLedgerSha256: ledger.sha256,
    inputHashes
  });
  if (outputFile) await writeExclusive(outputFile, report);
  return report;
}

function option(argv, name, required = false) {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : null;
  if (required && (!value || value.startsWith('--'))) {
    fail('P1_PHYSIOLOGY_V4_USAGE', `${name} is required`);
  }
  return value;
}

async function main(argv = process.argv.slice(2)) {
  const operation = argv[0];
  if (operation === 'witness') {
    const outputFile = path.resolve(option(argv, '--output', true));
    const witness = await buildWitness({
      samplesFile: path.resolve(option(argv, '--samples', true)),
      databaseFile: path.resolve(option(argv, '--database', true)),
      revisionLabel: option(argv, '--revision-label')
    });
    await writeExclusive(outputFile, witness);
    process.stdout.write(`${JSON.stringify({ result: 'WITNESS_CAPTURED', outputFile, evidenceHash: witness.evidenceHash })}\n`);
    return;
  }
  if (operation === 'adjudicate') {
    const output = option(argv, '--output');
    const report = await adjudicateFiles({
      samplesFile: path.resolve(option(argv, '--samples', true)),
      stateFile: path.resolve(option(argv, '--state', true)),
      attemptsFile: path.resolve(option(argv, '--attempts', true)),
      milestoneFile: option(argv, '--milestone') ? path.resolve(option(argv, '--milestone')) : null,
      witnessFile: option(argv, '--witness') ? path.resolve(option(argv, '--witness')) : null,
      outputFile: output ? path.resolve(output) : null
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  fail('P1_PHYSIOLOGY_V4_USAGE', 'witness or adjudicate operation is required');
}

if (require.main === module) main().catch(error => {
  console.error(`P1_PHYSIOLOGY_BENCHMARK_V4_ABORT=${error.code || 'FAILED'}:${error.message}`);
  process.exitCode = 1;
});

module.exports = Object.freeze({
  COMPLETE_MS,
  MAX_ADJACENT_SAMPLE_GAP_MS,
  REPORT_FORMAT,
  WITNESS_FORMAT,
  adjudicateFiles,
  adjudicateSamples,
  buildWitness,
  classifyOutboxObservation,
  evidenceHash,
  loadLedger,
  replayV3,
  sampleSha256,
  writeExclusive
});
