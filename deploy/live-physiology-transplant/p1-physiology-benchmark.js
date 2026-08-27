#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATABASE = process.env.STAY_DATABASE || '/var/lib/stay/data/continuity.sqlite3';
const SOCKET = process.env.STAY_RESIDENT_CONTROL_SOCKET || '/run/stay/resident-control.sock';
const EVIDENCE_ROOT = process.env.STAY_PHYSIOLOGY_BENCHMARK_ROOT || '/var/lib/stay/evidence/physiology-benchmark';
const SERVICE_CGROUP = process.env.STAY_SERVICE_CGROUP || '/sys/fs/cgroup/system.slice/stay.service';
const INTERVAL_MS = 60_000;
const COMPLETE_MS = 72 * 60 * 60 * 1000;
const CORE_HOST_FAULT_CODES = Object.freeze([
  'COREHOST_TIMEOUT',
  'COREHOST_EXIT',
  'COREHOST_OFFLINE',
  'CORE_WORKER_TIMEOUT',
  'CORE_WORKER_EXIT',
  'CORE_WORKER_OFFLINE',
  'ACTOR_HANDLER_STALLED',
  'ACTOR_RECOVERY_TIMEOUT',
  'ACTOR_RECOVERY_STALLED',
  'RESIDENT_REPLAY_COREHOST_RECOVERY_TIMEOUT'
]);
const CORE_HOST_TIMEOUT_CODES = Object.freeze([
  'COREHOST_TIMEOUT',
  'CORE_WORKER_TIMEOUT',
  'ACTOR_HANDLER_STALLED',
  'ACTOR_RECOVERY_TIMEOUT',
  'ACTOR_RECOVERY_STALLED',
  'RESIDENT_REPLAY_COREHOST_RECOVERY_TIMEOUT'
]);
const MILESTONES = Object.freeze([
  Object.freeze({ name: '15m', elapsedMs: 15 * 60 * 1000 }),
  Object.freeze({ name: '12h', elapsedMs: 12 * 60 * 60 * 1000 }),
  Object.freeze({ name: '72h', elapsedMs: COMPLETE_MS })
]);

function requestHttp(requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: 8787, path: requestPath, timeout: 5000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.once('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.once('timeout', () => request.destroy(new Error('HTTP timeout')));
    request.once('error', reject);
  });
}

function residentStatus(residencyId) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET);
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy(new Error('resident status timeout')));
    let body = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify({
      format: 'stay-resident-control-v1', operation: 'status', residencyId
    }) + '\n'));
    socket.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > 65536) socket.destroy(new Error('resident response too large'));
    });
    socket.once('end', () => {
      try {
        const value = JSON.parse(body);
        if (value.ok !== true) throw new Error(`resident status failed: ${value.code || 'unknown'}`);
        resolve(value.resident);
      } catch (error) { reject(error); }
    });
  });
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
}

function readNumber(file) {
  const value = Number(readText(file));
  return Number.isFinite(value) ? value : null;
}

function readKeyValues(file) {
  const result = {};
  for (const line of String(readText(file) || '').split(/\r?\n/)) {
    const [key, raw] = line.trim().split(/\s+/, 2);
    if (!key || raw == null) continue;
    result[key] = Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return result;
}

function hasNumericKeys(value, keys) {
  return value && keys.every(key =>
    Object.prototype.hasOwnProperty.call(value, key) &&
    Number.isFinite(Number(value[key]))
  );
}

function sameProcesses(left, right) {
  return JSON.stringify(normalizeProcesses(left)) === JSON.stringify(normalizeProcesses(right));
}

function processSetsDisjoint(left, right) {
  const rightSet = new Set(normalizeProcesses(right));
  return normalizeProcesses(left).every(pid => !rightSet.has(pid));
}

function queueHealthy(queue) {
  return [
    'failed',
    'timedOut',
    'stalled',
    'recovered',
    'recoveryRejected',
    'recoveryTimedOut'
  ].every(field => Number(queue?.[field] || 0) === 0);
}

function procSample(pid) {
  const stat = readText(`/proc/${pid}/stat`);
  const status = readText(`/proc/${pid}/status`) || '';
  const system = readText('/proc/stat')?.split(/\r?\n/)[0]?.trim().split(/\s+/).slice(1).map(Number) || [];
  const close = stat?.lastIndexOf(')') ?? -1;
  const fields = close >= 0 ? stat.slice(close + 2).split(/\s+/) : [];
  const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  return {
    processTicks: fields.length > 12 ? Number(fields[11]) + Number(fields[12]) : null,
    systemTicks: system.length ? system.reduce((sum, value) => sum + value, 0) : null,
    rssBytes: rss ? Number(rss[1]) * 1024 : null
  };
}

function mainServicePid(kernelProcesses, health = {}, read = readText) {
  const members = new Set(
    (kernelProcesses || []).map(Number).filter(value => Number.isSafeInteger(value) && value > 1)
  );
  const recorded = Number(read('/run/stay/main.pid'));
  if (members.has(recorded)) return recorded;
  for (const pid of kernelProcesses) {
    const command = read(`/proc/${pid}/cmdline`)?.replaceAll('\0', ' ') || '';
    if (/\bserver-secure\.js\b/.test(command)) return pid;
  }
  const advertised = Number(health.pid);
  if (members.has(advertised)) return advertised;
  return null;
}

function cgroupLeaf(prefix, root = path.join(SERVICE_CGROUP, 'stay-cores')) {
  try {
    const names = fs.readdirSync(root).filter(candidate => candidate.startsWith(prefix + '-'))
      .filter(candidate => (readText(path.join(root, candidate, 'cgroup.procs')) || '').length > 0)
      .sort();
    if (names.length === 0) return null;
    if (names.length !== 1) {
      return {
        ambiguous: true,
        activeLeafCount: names.length,
        activeDirectories: names.map(name => path.join(root, name)),
        processes: names.flatMap(name =>
          (readText(path.join(root, name, 'cgroup.procs')) || '')
            .split(/\s+/).filter(Boolean).map(Number)
        )
      };
    }
    const [name] = names;
    const directory = path.join(root, name);
    return {
      ambiguous: false,
      activeLeafCount: 1,
      activeDirectories: [directory],
      directory,
      memoryCurrent: readNumber(path.join(directory, 'memory.current')),
      memoryPeak: readNumber(path.join(directory, 'memory.peak')),
      memoryHigh: readText(path.join(directory, 'memory.high')),
      memoryMax: readText(path.join(directory, 'memory.max')),
      memoryEvents: readKeyValues(path.join(directory, 'memory.events')),
      memoryPressure: readText(path.join(directory, 'memory.pressure')),
      pidsCurrent: readNumber(path.join(directory, 'pids.current')),
      pidsMax: readText(path.join(directory, 'pids.max')),
      pidsEvents: readKeyValues(path.join(directory, 'pids.events')),
      cpuMax: readText(path.join(directory, 'cpu.max')),
      cpuStat: readKeyValues(path.join(directory, 'cpu.stat')),
      processes: (readText(path.join(directory, 'cgroup.procs')) || '').split(/\s+/).filter(Boolean).map(Number)
    };
  } catch { return null; }
}

function databaseSample() {
  const database = new DatabaseSync(DATABASE, { open: true, readOnly: true });
  database.exec('PRAGMA query_only=ON');
  try {
    const value = sql => Number(database.prepare(sql).get()?.value || 0);
    const codeList = codes => codes.map(code => `'${code}'`).join(', ');
    const coreHostMetric = (coreId, codes, aggregate) => Number(database.prepare(`
      SELECT ${aggregate} value
      FROM recovery_records
      WHERE core_id=?
        AND json_valid(detail_json)
        AND json_extract(detail_json, '$.code') IN (${codeList(codes)})
    `).get(coreId)?.value || 0);
    const coreHostFaults = coreId => coreHostMetric(coreId, CORE_HOST_FAULT_CODES, 'COUNT(*)');
    const coreHostTimeouts = coreId => coreHostMetric(coreId, CORE_HOST_TIMEOUT_CODES, 'COUNT(*)');
    const coreHostFaultMaxId = coreId => coreHostMetric(
      coreId, CORE_HOST_FAULT_CODES, 'COALESCE(MAX(id), 0)'
    );
    const coreHostTimeoutMaxId = coreId => coreHostMetric(
      coreId, CORE_HOST_TIMEOUT_CODES, 'COALESCE(MAX(id), 0)'
    );
    const maxRecoveryId = (where, ...parameters) => Number(database.prepare(`
      SELECT COALESCE(MAX(id), 0) value
      FROM recovery_records
      WHERE ${where}
    `).get(...parameters)?.value || 0);
    const latestCoreHostFault = database.prepare(`
      SELECT id, type, core_id, detail_json, created_at
      FROM recovery_records
      WHERE core_id IN ('sntss', 'chronobiology')
        AND json_valid(detail_json)
        AND json_extract(detail_json, '$.code') IN (
          'COREHOST_TIMEOUT',
          'COREHOST_EXIT',
          'COREHOST_OFFLINE',
          'CORE_WORKER_TIMEOUT',
          'CORE_WORKER_EXIT',
          'CORE_WORKER_OFFLINE',
          'ACTOR_HANDLER_STALLED',
          'ACTOR_RECOVERY_TIMEOUT',
          'ACTOR_RECOVERY_STALLED',
          'RESIDENT_REPLAY_COREHOST_RECOVERY_TIMEOUT'
        )
      ORDER BY id DESC
      LIMIT 1
    `).get() || null;
    return {
      quickCheck: database.prepare('PRAGMA quick_check').get()?.quick_check || null,
      pendingDeliveries: value("SELECT COUNT(*) value FROM biological_deliveries WHERE status='PENDING'"),
      failedDeliveries: value("SELECT COUNT(*) value FROM biological_deliveries WHERE status='FAILED'"),
      pendingOutboxIntents: value("SELECT COUNT(*) value FROM biological_outbox_intents WHERE status='PENDING'"),
      sntssAuthorityRows: value("SELECT COUNT(*) value FROM authority WHERE core_id='sntss'"),
      chronobiologyAuthorityRows: value("SELECT COUNT(*) value FROM authority WHERE core_id='chronobiology'"),
      sntssOutputRows: value("SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id='sntss'"),
      chronobiologyOutputRows: value("SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id='chronobiology'"),
      retainedSntssCheckpoints: value("SELECT COUNT(*) value FROM resident_checkpoints WHERE residency_id='resident:sntss'"),
      retainedChronobiologyCheckpoints: value("SELECT COUNT(*) value FROM resident_checkpoints WHERE residency_id='resident:chronobiology'"),
      sntssCoreHostFaults: coreHostFaults('sntss'),
      sntssCoreHostTimeouts: coreHostTimeouts('sntss'),
      chronobiologyCoreHostFaults: coreHostFaults('chronobiology'),
      chronobiologyCoreHostTimeouts: coreHostTimeouts('chronobiology'),
      sntssResyncRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.resync-required' AND core_id='sntss'"),
      chronobiologyResyncRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.resync-required' AND core_id='chronobiology'"),
      sntssDeliveryRetryRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.delivery-retry' AND core_id='sntss'"),
      chronobiologyDeliveryRetryRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.delivery-retry' AND core_id='chronobiology'"),
      maintenanceFailureRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='maintenance.failed'"),
      startupTeardownFailureRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.startup-teardown-failed'"),
      detachTeardownFailureRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.detach-teardown-failed'"),
      terminalTeardownFailureRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.terminal-teardown-failed'"),
      shutdownCheckpointFailureRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.shutdown-checkpoint-failed'"),
      shutdownStopFailureRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.shutdown-stop-failed'"),
      outboxPendingRows: value("SELECT COUNT(*) value FROM recovery_records WHERE type='resident.outbox-pending' AND core_id IN ('sntss', 'chronobiology')"),
      duplicateResyncGroups: value(`
        SELECT COUNT(*) value
        FROM (
          SELECT core_id,
                 json_extract(detail_json, '$.sequence') sequence,
                 COUNT(*) count
          FROM recovery_records
          WHERE type='resident.resync-required'
            AND core_id IN ('sntss', 'chronobiology')
            AND json_valid(detail_json)
          GROUP BY core_id, json_extract(detail_json, '$.sequence')
          HAVING COUNT(*) > 1
        )
      `),
      recoveryWatermarks: {
        sntssCoreHostFaults: coreHostFaultMaxId('sntss'),
        sntssCoreHostTimeouts: coreHostTimeoutMaxId('sntss'),
        chronobiologyCoreHostFaults: coreHostFaultMaxId('chronobiology'),
        chronobiologyCoreHostTimeouts: coreHostTimeoutMaxId('chronobiology'),
        sntssResyncRows: maxRecoveryId("type='resident.resync-required' AND core_id='sntss'"),
        chronobiologyResyncRows: maxRecoveryId("type='resident.resync-required' AND core_id='chronobiology'"),
        sntssDeliveryRetryRows: maxRecoveryId("type='resident.delivery-retry' AND core_id='sntss'"),
        chronobiologyDeliveryRetryRows: maxRecoveryId("type='resident.delivery-retry' AND core_id='chronobiology'"),
        maintenanceFailureRows: maxRecoveryId("type='maintenance.failed'"),
        startupTeardownFailureRows: maxRecoveryId("type='resident.startup-teardown-failed'"),
        detachTeardownFailureRows: maxRecoveryId("type='resident.detach-teardown-failed'"),
        terminalTeardownFailureRows: maxRecoveryId("type='resident.terminal-teardown-failed'"),
        shutdownCheckpointFailureRows: maxRecoveryId("type='resident.shutdown-checkpoint-failed'"),
        shutdownStopFailureRows: maxRecoveryId("type='resident.shutdown-stop-failed'"),
        outboxPendingRows: maxRecoveryId(
          "type='resident.outbox-pending' AND core_id IN ('sntss', 'chronobiology')"
        )
      },
      latestCoreHostFault: latestCoreHostFault ? {
        ...latestCoreHostFault,
        detail: JSON.parse(latestCoreHostFault.detail_json)
      } : null
    };
  } finally { database.close(); }
}

async function capture() {
  const [health, meta, sntss, chronobiology] = await Promise.all([
    requestHttp('/healthz'), requestHttp('/__stay/meta'),
    residentStatus('resident:sntss'), residentStatus('resident:chronobiology')
  ]);
  const kernelProcesses = (readText(path.join(SERVICE_CGROUP, 'stay-kernel', 'cgroup.procs')) || '')
    .split(/\s+/).filter(Boolean).map(Number);
  const pid = mainServicePid(kernelProcesses, health);
  return {
    capturedAt: new Date().toISOString(),
    health,
    meta,
    residents: { sntss, chronobiology },
    database: databaseSample(),
    service: {
      pid,
      ...procSample(pid),
      cgroup: {
        required: process.env.STAY_REQUIRE_CGROUPS === '1',
        delegateSubgroup: process.env.STAY_CGROUP_DELEGATE_SUBGROUP || null,
        parentProcesses: (readText(path.join(SERVICE_CGROUP, 'cgroup.procs')) || '').split(/\s+/).filter(Boolean).map(Number),
        kernelProcesses,
        subtreeControl: readText(path.join(SERVICE_CGROUP, 'cgroup.subtree_control')),
        memoryCurrent: readNumber(path.join(SERVICE_CGROUP, 'memory.current')),
        pidsCurrent: readNumber(path.join(SERVICE_CGROUP, 'pids.current')),
        sntss: cgroupLeaf('sntss'),
        chronobiology: cgroupLeaf('chronobiology')
      }
    },
    databaseBytes: fs.statSync(DATABASE).size,
    databaseWalBytes: (() => {
      try { return fs.statSync(`${DATABASE}-wal`).size; } catch { return 0; }
    })(),
    databaseTotalBytes: [DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`]
      .reduce((sum, file) => {
        try { return sum + fs.statSync(file).size; } catch { return sum; }
      }, 0)
  };
}

function initialState(sample) {
  return {
    format: 'stay-physiology-benchmark-state-v3',
    startedAt: sample.capturedAt,
    runtimeRevision: Number(sample.health.revision),
    samples: 0,
    failures: 0,
    collectorStarts: 0,
    collectorRestarts: 0,
    maxRssBytes: 0,
    maxDatabaseBytes: 0,
    maxDatabaseWalBytes: 0,
    maxDatabaseTotalBytes: 0,
    maxPendingDeliveries: 0,
    maxPendingOutboxIntents: 0,
    maxSntssCgroupBytes: 0,
    maxChronobiologyCgroupBytes: 0,
    maxSntssCgroupPeakBytes: 0,
    maxChronobiologyCgroupPeakBytes: 0,
    lastProcessTicks: null,
    lastSystemTicks: null,
    maxCpuPercent: 0,
    sntssCoreHostFaults: 0,
    sntssCoreHostTimeouts: 0,
    chronobiologyCoreHostFaults: 0,
    chronobiologyCoreHostTimeouts: 0,
    sntssResyncRows: 0,
    chronobiologyResyncRows: 0,
    sntssDeliveryRetryRows: 0,
    chronobiologyDeliveryRetryRows: 0,
    maintenanceFailureRows: 0,
    startupTeardownFailureRows: 0,
    detachTeardownFailureRows: 0,
    terminalTeardownFailureRows: 0,
    shutdownCheckpointFailureRows: 0,
    shutdownStopFailureRows: 0,
    outboxPendingRows: 0,
    duplicateResyncGroups: 0,
    sntssMemoryHighEvents: 0,
    sntssMemoryMaxEvents: 0,
    sntssMemoryOomEvents: 0,
    sntssMemoryOomKillEvents: 0,
    sntssPidsMaxEvents: 0,
    sntssCpuThrottledPeriods: 0,
    chronobiologyMemoryHighEvents: 0,
    chronobiologyMemoryMaxEvents: 0,
    chronobiologyMemoryOomEvents: 0,
    chronobiologyMemoryOomKillEvents: 0,
    chronobiologyPidsMaxEvents: 0,
    chronobiologyCpuThrottledPeriods: 0,
    sntssProcessTransitions: 0,
    chronobiologyProcessTransitions: 0,
    mainPidTransitions: 0,
    lastSntssCoreHostFaults: Number(sample.database?.sntssCoreHostFaults || 0),
    lastSntssCoreHostTimeouts: Number(sample.database?.sntssCoreHostTimeouts || 0),
    lastChronobiologyCoreHostFaults: Number(sample.database?.chronobiologyCoreHostFaults || 0),
    lastChronobiologyCoreHostTimeouts: Number(sample.database?.chronobiologyCoreHostTimeouts || 0),
    lastSntssResyncRows: Number(sample.database?.sntssResyncRows || 0),
    lastChronobiologyResyncRows: Number(sample.database?.chronobiologyResyncRows || 0),
    lastSntssDeliveryRetryRows: Number(sample.database?.sntssDeliveryRetryRows || 0),
    lastChronobiologyDeliveryRetryRows: Number(sample.database?.chronobiologyDeliveryRetryRows || 0),
    lastMaintenanceFailureRows: Number(sample.database?.maintenanceFailureRows || 0),
    lastStartupTeardownFailureRows: Number(sample.database?.startupTeardownFailureRows || 0),
    lastDetachTeardownFailureRows: Number(sample.database?.detachTeardownFailureRows || 0),
    lastTerminalTeardownFailureRows: Number(sample.database?.terminalTeardownFailureRows || 0),
    lastShutdownCheckpointFailureRows: Number(
      sample.database?.shutdownCheckpointFailureRows || 0
    ),
    lastShutdownStopFailureRows: Number(sample.database?.shutdownStopFailureRows || 0),
    lastOutboxPendingRows: Number(sample.database?.outboxPendingRows || 0),
    lastDuplicateResyncGroups: Number(sample.database?.duplicateResyncGroups || 0),
    lastRecoveryWatermarks: { ...(sample.database?.recoveryWatermarks || {}) },
    lastSntssMemoryEvents: { ...(sample.service?.cgroup?.sntss?.memoryEvents || {}) },
    lastChronobiologyMemoryEvents: { ...(sample.service?.cgroup?.chronobiology?.memoryEvents || {}) },
    lastSntssPidsEvents: { ...(sample.service?.cgroup?.sntss?.pidsEvents || {}) },
    lastChronobiologyPidsEvents: {
      ...(sample.service?.cgroup?.chronobiology?.pidsEvents || {})
    },
    lastSntssCpuStat: { ...(sample.service?.cgroup?.sntss?.cpuStat || {}) },
    lastChronobiologyCpuStat: { ...(sample.service?.cgroup?.chronobiology?.cpuStat || {}) },
    lastSntssProcesses: normalizeProcesses(sample.service?.cgroup?.sntss?.processes),
    lastChronobiologyProcesses: normalizeProcesses(sample.service?.cgroup?.chronobiology?.processes),
    lastMainPid: Number(sample.service?.pid) || null,
    startingSntssCheckpointGeneration: Number(sample.residents?.sntss?.checkpointGeneration || 0),
    startingChronobiologyCheckpointGeneration: Number(
      sample.residents?.chronobiology?.checkpointGeneration || 0
    ),
    latestSntssCheckpointGeneration: Number(sample.residents?.sntss?.checkpointGeneration || 0),
    latestChronobiologyCheckpointGeneration: Number(
      sample.residents?.chronobiology?.checkpointGeneration || 0
    ),
    milestones: {}
  };
}

function normalizeProcesses(input) {
  return Array.isArray(input)
    ? [...new Set(input.map(Number).filter(Number.isSafeInteger))].sort((left, right) => left - right)
    : [];
}

function processListChanged(before, after) {
  return before.length > 0 && after.length > 0 &&
    JSON.stringify(before) !== JSON.stringify(after);
}

function positiveDelta(current, previous) {
  return Math.max(0, Number(current || 0) - Number(previous || 0));
}

function recoveryDelta(current, previous, currentWatermark, previousWatermark) {
  const countDelta = positiveDelta(current, previous);
  if (countDelta > 0) return countDelta;
  return Number(currentWatermark || 0) > Number(previousWatermark || 0) ? 1 : 0;
}

function updateMemoryEventDeltas(state, resident, current) {
  const prefix = resident === 'sntss' ? 'sntss' : 'chronobiology';
  const previousKey = resident === 'sntss'
    ? 'lastSntssMemoryEvents'
    : 'lastChronobiologyMemoryEvents';
  const previous = state[previousKey] || {};
  for (const [event, suffix] of [
    ['high', 'MemoryHighEvents'],
    ['max', 'MemoryMaxEvents'],
    ['oom', 'MemoryOomEvents'],
    ['oom_kill', 'MemoryOomKillEvents']
  ]) {
    const key = `${prefix}${suffix}`;
    state[key] = Number(state[key] || 0) + positiveDelta(current?.[event], previous?.[event]);
  }
  state[previousKey] = { ...(current || {}) };
}

function updateBoundEventDeltas(state, resident, cgroup = {}) {
  const prefix = resident === 'sntss' ? 'sntss' : 'chronobiology';
  const title = resident === 'sntss' ? 'Sntss' : 'Chronobiology';
  const pidsPreviousKey = `last${title}PidsEvents`;
  const cpuPreviousKey = `last${title}CpuStat`;
  const currentPids = cgroup.pidsEvents || {};
  const currentCpu = cgroup.cpuStat || {};
  state[`${prefix}PidsMaxEvents`] = Number(state[`${prefix}PidsMaxEvents`] || 0) +
    positiveDelta(currentPids.max, state[pidsPreviousKey]?.max);
  state[`${prefix}CpuThrottledPeriods`] = Number(
    state[`${prefix}CpuThrottledPeriods`] || 0
  ) + positiveDelta(currentCpu.nr_throttled, state[cpuPreviousKey]?.nr_throttled);
  state[pidsPreviousKey] = { ...currentPids };
  state[cpuPreviousKey] = { ...currentCpu };
}

function observedFailures(state) {
  return Number(state.failures || 0) +
    Number(state.collectorRestarts || 0) +
    Number(state.sntssCoreHostFaults || 0) +
    Number(state.chronobiologyCoreHostFaults || 0) +
    Number(state.sntssCoreHostTimeouts || 0) +
    Number(state.chronobiologyCoreHostTimeouts || 0) +
    Number(state.sntssResyncRows || 0) +
    Number(state.chronobiologyResyncRows || 0) +
    Number(state.sntssDeliveryRetryRows || 0) +
    Number(state.chronobiologyDeliveryRetryRows || 0) +
    Number(state.maintenanceFailureRows || 0) +
    Number(state.startupTeardownFailureRows || 0) +
    Number(state.detachTeardownFailureRows || 0) +
    Number(state.terminalTeardownFailureRows || 0) +
    Number(state.shutdownCheckpointFailureRows || 0) +
    Number(state.shutdownStopFailureRows || 0) +
    Number(state.outboxPendingRows || 0) +
    Number(state.duplicateResyncGroups || 0) +
    Number(state.sntssMemoryHighEvents || 0) +
    Number(state.sntssMemoryMaxEvents || 0) +
    Number(state.sntssMemoryOomEvents || 0) +
    Number(state.sntssMemoryOomKillEvents || 0) +
    Number(state.sntssPidsMaxEvents || 0) +
    Number(state.sntssCpuThrottledPeriods || 0) +
    Number(state.chronobiologyMemoryHighEvents || 0) +
    Number(state.chronobiologyMemoryMaxEvents || 0) +
    Number(state.chronobiologyMemoryOomEvents || 0) +
    Number(state.chronobiologyMemoryOomKillEvents || 0) +
    Number(state.chronobiologyPidsMaxEvents || 0) +
    Number(state.chronobiologyCpuThrottledPeriods || 0) +
    Number(state.sntssProcessTransitions || 0) +
    Number(state.chronobiologyProcessTransitions || 0) +
    Number(state.mainPidTransitions || 0);
}

function updateState(state, sample, elapsedMs) {
  state.samples += 1;
  const expectedSntssVersion = process.env.STAY_PHYSIOLOGY_EXPECT_SNTSS_VERSION || null;
  const bsf = Array.isArray(sample.meta?.systems)
    ? sample.meta.systems.find(value => value.id === 'bsf')
    : null;
  const publicSntss = Array.isArray(sample.meta?.residents)
    ? sample.meta.residents.find(value => value.residencyId === 'resident:sntss')
    : null;
  const publicChronobiology = Array.isArray(sample.meta?.residents)
    ? sample.meta.residents.find(value => value.residencyId === 'resident:chronobiology')
    : null;
  const sntssDeadline = sample.residents?.sntss?.host?.deadlineContract || {};
  const chronobiologyDeadline = sample.residents?.chronobiology?.host?.deadlineContract || {};
  const sntssDurability = sample.residents?.sntss?.durabilityContract || {};
  const chronobiologyDurability = sample.residents?.chronobiology?.durabilityContract || {};
  const sntssMemoryPlan = sample.residents?.sntss?.host?.osContainment?.memoryPlan || {};
  const chronobiologyMemoryPlan = sample.residents?.chronobiology?.host?.osContainment?.memoryPlan || {};
  const sntssContainment = sample.residents?.sntss?.host?.osContainment || {};
  const chronobiologyContainment = sample.residents?.chronobiology?.host?.osContainment || {};
  const kernelProcesses = sample.service?.cgroup?.kernelProcesses || [];
  const runtimeContractsHealthy = [
    [sntssDeadline, sntssDurability, sntssMemoryPlan, sntssContainment, sample.service?.cgroup?.sntss],
    [chronobiologyDeadline, chronobiologyDurability, chronobiologyMemoryPlan, chronobiologyContainment, sample.service?.cgroup?.chronobiology]
  ].every(([deadline, durability, memory, containment, cgroup]) =>
    deadline.eventAndCheckpointCombined === true &&
    deadline.outputsReleasedAfterCheckpoint === true &&
    durability.eventCheckpointConsumerAckAtomic === true &&
    durability.outboxIntentInSameCommit === true &&
    durability.biologicalPublicationFromCommittedOutboxOnly === true &&
    durability.recoveryImageAdvancesAfterCommitOnly === true &&
    durability.activationGapBackfillAtomic === true &&
    durability.outboxPublicationSingleFlight === true &&
    durability.startupFailureTeardownComplete === true &&
    containment.required === true && containment.available === true &&
    containment.payloadAttachedBeforeInit === true &&
    containment.payloadQuiescedBeforeSpawn === true &&
    cgroup?.ambiguous === false && Number(cgroup?.activeLeafCount) === 1 &&
    Array.isArray(cgroup?.processes) && cgroup.processes.length >= 1 &&
    hasNumericKeys(cgroup?.memoryEvents, ['low', 'high', 'max', 'oom', 'oom_kill']) &&
    hasNumericKeys(cgroup?.pidsEvents, ['max']) &&
    hasNumericKeys(cgroup?.cpuStat, ['usage_usec', 'nr_periods', 'nr_throttled', 'throttled_usec']) &&
    Number.isFinite(Number(cgroup?.memoryCurrent)) && Number(cgroup.memoryCurrent) >= 0 &&
    Number(cgroup.memoryCurrent) <= Number(memory.cgroupHardBytes) &&
    Number.isSafeInteger(Number(cgroup?.pidsCurrent)) && Number(cgroup.pidsCurrent) >= 1 &&
    Number(cgroup.pidsCurrent) <= Number(cgroup.pidsMax) &&
    String(cgroup?.pidsMax) === '16' && String(cgroup?.cpuMax) === '20000 100000' &&
    sameProcesses(cgroup.processes, containment.payloadPids) &&
    Number(deadline.workerTransitionTimeoutMs) > 0 &&
    Number(deadline.ipcTransitionTimeoutMs) > Number(deadline.workerTransitionTimeoutMs) &&
    memory.accounting === 'payload-cgroup-plus-kernel-supervisor' &&
    Number(cgroup?.memoryHigh) === Number(memory.cgroupSoftBytes) &&
    Number(cgroup?.memoryMax) === Number(memory.cgroupHardBytes)
  );
  const residentSupervisorsHealthy = [
    [sample.residents?.sntss, sample.service?.cgroup?.sntss],
    [sample.residents?.chronobiology, sample.service?.cgroup?.chronobiology]
  ].every(([resident, cgroup]) => {
    const supervisorPid = Number(resident?.host?.pid);
    return Number.isSafeInteger(supervisorPid) && supervisorPid > 1 &&
      kernelProcesses.includes(supervisorPid) &&
      !normalizeProcesses(cgroup?.processes).includes(supervisorPid);
  });
  const physiologyHealthy = (
    Number(sample.health.revision) === Number(state.runtimeRevision) &&
    sample.meta?.revisionFrozen === true &&
    Number.isSafeInteger(Number(sample.service?.pid)) && Number(sample.service.pid) > 1 &&
    sample.service?.cgroup?.required === true &&
    sample.service?.cgroup?.delegateSubgroup === 'stay-kernel' &&
    Array.isArray(sample.service?.cgroup?.parentProcesses) &&
    sample.service.cgroup.parentProcesses.length === 0 &&
    Array.isArray(sample.service?.cgroup?.kernelProcesses) &&
    sample.service.cgroup.kernelProcesses.includes(Number(sample.service.pid)) &&
    ['cpu', 'memory', 'pids'].every(name =>
      String(sample.service?.cgroup?.subtreeControl || '').includes(name)
    ) &&
    bsf?.running === true && bsf?.mode === 'LIVE' && bsf?.healthOk === true &&
    Number(bsf?.writeFailures || 0) === 0 &&
    sample.residents?.sntss?.running === true &&
    (!expectedSntssVersion || sample.residents?.sntss?.version === expectedSntssVersion) &&
    Number(sample.residents?.sntss?.observedOutputs) === 0 &&
    sample.residents?.sntss?.authorityOwned === false &&
    sample.residents?.sntss?.health?.ok === true &&
    sample.residents?.sntss?.resyncRequired !== true &&
    !sample.residents?.sntss?.terminalPersistenceError &&
    !sample.residents?.sntss?.teardownError &&
    queueHealthy(sample.residents?.sntss?.queue) &&
    publicSntss?.running === true && publicSntss?.mode === 'SHADOW' &&
    sample.residents?.chronobiology?.running === true &&
    sample.residents?.chronobiology?.authorityOwned === false &&
    sample.residents?.chronobiology?.health?.ok === true &&
    sample.residents?.chronobiology?.resyncRequired !== true &&
    !sample.residents?.chronobiology?.terminalPersistenceError &&
    !sample.residents?.chronobiology?.teardownError &&
    queueHealthy(sample.residents?.chronobiology?.queue) &&
    publicChronobiology?.running === true && publicChronobiology?.mode === 'SHADOW' &&
    Number(sample.database?.sntssAuthorityRows) === 0 &&
    Number(sample.database?.sntssOutputRows) === 0 &&
    Number(sample.database?.chronobiologyAuthorityRows) === 0 &&
    Number(sample.database?.failedDeliveries) === 0 &&
    Number(sample.database?.pendingOutboxIntents) === 0 &&
    Number(sample.database?.pendingDeliveries) <= 32 &&
    Number(sample.database?.chronobiologyOutputRows) >= 1 &&
    residentSupervisorsHealthy &&
    processSetsDisjoint(
      sample.service?.cgroup?.sntss?.processes,
      sample.service?.cgroup?.chronobiology?.processes
    ) &&
    runtimeContractsHealthy
  );
  state.failures += sample.health.ok === true && sample.database.quickCheck === 'ok' && physiologyHealthy ? 0 : 1;
  const currentSntssFaults = Number(sample.database?.sntssCoreHostFaults || 0);
  const currentSntssTimeouts = Number(sample.database?.sntssCoreHostTimeouts || 0);
  const currentChronobiologyFaults = Number(sample.database?.chronobiologyCoreHostFaults || 0);
  const currentChronobiologyTimeouts = Number(sample.database?.chronobiologyCoreHostTimeouts || 0);
  const watermarks = sample.database?.recoveryWatermarks || {};
  const priorWatermarks = state.lastRecoveryWatermarks || {};
  state.sntssCoreHostFaults += recoveryDelta(
    currentSntssFaults, state.lastSntssCoreHostFaults,
    watermarks.sntssCoreHostFaults, priorWatermarks.sntssCoreHostFaults
  );
  state.sntssCoreHostTimeouts += recoveryDelta(
    currentSntssTimeouts, state.lastSntssCoreHostTimeouts,
    watermarks.sntssCoreHostTimeouts, priorWatermarks.sntssCoreHostTimeouts
  );
  state.chronobiologyCoreHostFaults += recoveryDelta(
    currentChronobiologyFaults,
    state.lastChronobiologyCoreHostFaults,
    watermarks.chronobiologyCoreHostFaults,
    priorWatermarks.chronobiologyCoreHostFaults
  );
  state.chronobiologyCoreHostTimeouts += recoveryDelta(
    currentChronobiologyTimeouts,
    state.lastChronobiologyCoreHostTimeouts,
    watermarks.chronobiologyCoreHostTimeouts,
    priorWatermarks.chronobiologyCoreHostTimeouts
  );
  state.lastSntssCoreHostFaults = currentSntssFaults;
  state.lastSntssCoreHostTimeouts = currentSntssTimeouts;
  state.lastChronobiologyCoreHostFaults = currentChronobiologyFaults;
  state.lastChronobiologyCoreHostTimeouts = currentChronobiologyTimeouts;

  for (const [field, lastField] of [
    ['sntssResyncRows', 'lastSntssResyncRows'],
    ['chronobiologyResyncRows', 'lastChronobiologyResyncRows'],
    ['sntssDeliveryRetryRows', 'lastSntssDeliveryRetryRows'],
    ['chronobiologyDeliveryRetryRows', 'lastChronobiologyDeliveryRetryRows'],
    ['maintenanceFailureRows', 'lastMaintenanceFailureRows'],
    ['startupTeardownFailureRows', 'lastStartupTeardownFailureRows'],
    ['detachTeardownFailureRows', 'lastDetachTeardownFailureRows'],
    ['terminalTeardownFailureRows', 'lastTerminalTeardownFailureRows'],
    ['shutdownCheckpointFailureRows', 'lastShutdownCheckpointFailureRows'],
    ['shutdownStopFailureRows', 'lastShutdownStopFailureRows'],
    ['outboxPendingRows', 'lastOutboxPendingRows'],
    ['duplicateResyncGroups', 'lastDuplicateResyncGroups']
  ]) {
    const current = Number(sample.database?.[field] || 0);
    state[field] = Number(state[field] || 0) + recoveryDelta(
      current,
      state[lastField],
      watermarks[field],
      priorWatermarks[field]
    );
    state[lastField] = current;
  }
  state.lastRecoveryWatermarks = { ...watermarks };
  updateMemoryEventDeltas(
    state,
    'sntss',
    sample.service?.cgroup?.sntss?.memoryEvents || {}
  );
  updateMemoryEventDeltas(
    state,
    'chronobiology',
    sample.service?.cgroup?.chronobiology?.memoryEvents || {}
  );
  updateBoundEventDeltas(state, 'sntss', sample.service?.cgroup?.sntss || {});
  updateBoundEventDeltas(
    state,
    'chronobiology',
    sample.service?.cgroup?.chronobiology || {}
  );

  const sntssProcesses = normalizeProcesses(sample.service?.cgroup?.sntss?.processes);
  const chronobiologyProcesses = normalizeProcesses(sample.service?.cgroup?.chronobiology?.processes);
  const mainPid = Number(sample.service?.pid) || null;
  if (processListChanged(state.lastSntssProcesses || [], sntssProcesses)) {
    state.sntssProcessTransitions += 1;
  }
  if (processListChanged(state.lastChronobiologyProcesses || [], chronobiologyProcesses)) {
    state.chronobiologyProcessTransitions += 1;
  }
  if (state.lastMainPid && mainPid && state.lastMainPid !== mainPid) {
    state.mainPidTransitions += 1;
  }
  state.lastSntssProcesses = sntssProcesses;
  state.lastChronobiologyProcesses = chronobiologyProcesses;
  state.lastMainPid = mainPid;
  state.latestSntssCheckpointGeneration = Math.max(
    Number(state.latestSntssCheckpointGeneration || 0),
    Number(sample.residents?.sntss?.checkpointGeneration || 0)
  );
  state.latestChronobiologyCheckpointGeneration = Math.max(
    Number(state.latestChronobiologyCheckpointGeneration || 0),
    Number(sample.residents?.chronobiology?.checkpointGeneration || 0)
  );
  state.maxRssBytes = Math.max(state.maxRssBytes, Number(sample.service.rssBytes || 0));
  state.maxDatabaseBytes = Math.max(state.maxDatabaseBytes, Number(sample.databaseBytes || 0));
  state.maxDatabaseWalBytes = Math.max(
    Number(state.maxDatabaseWalBytes || 0),
    Number(sample.databaseWalBytes || 0)
  );
  state.maxDatabaseTotalBytes = Math.max(
    Number(state.maxDatabaseTotalBytes || 0),
    Number(sample.databaseTotalBytes || 0)
  );
  state.maxPendingDeliveries = Math.max(state.maxPendingDeliveries, Number(sample.database.pendingDeliveries || 0));
  state.maxPendingOutboxIntents = Math.max(
    state.maxPendingOutboxIntents,
    Number(sample.database.pendingOutboxIntents || 0)
  );
  state.maxSntssCgroupBytes = Math.max(state.maxSntssCgroupBytes, Number(sample.service.cgroup.sntss?.memoryCurrent || 0));
  state.maxChronobiologyCgroupBytes = Math.max(state.maxChronobiologyCgroupBytes, Number(sample.service.cgroup.chronobiology?.memoryCurrent || 0));
  state.maxSntssCgroupPeakBytes = Math.max(state.maxSntssCgroupPeakBytes, Number(sample.service.cgroup.sntss?.memoryPeak || 0));
  state.maxChronobiologyCgroupPeakBytes = Math.max(state.maxChronobiologyCgroupPeakBytes, Number(sample.service.cgroup.chronobiology?.memoryPeak || 0));
  const processDelta = Number(sample.service.processTicks) - Number(state.lastProcessTicks);
  const systemDelta = Number(sample.service.systemTicks) - Number(state.lastSystemTicks);
  const cpuPercent = state.lastProcessTicks != null && state.lastSystemTicks != null && systemDelta > 0
    ? Math.max(0, processDelta / systemDelta * 100) : null;
  if (cpuPercent != null) state.maxCpuPercent = Math.max(state.maxCpuPercent, cpuPercent);
  state.lastProcessTicks = sample.service.processTicks;
  state.lastSystemTicks = sample.service.systemTicks;
  sample.elapsedMs = elapsedMs;
  sample.cpuPercent = cpuPercent;
}

function writeAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o400);
    fs.writeFileSync(descriptor, JSON.stringify(value) + '\n');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    fsyncDirectory(path.dirname(file));
  } catch (error) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function fsyncDirectory(directory) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    const unsupported = ['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code) ||
      (process.platform === 'win32' && error.code === 'EPERM');
    if (!unsupported) throw error;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function appendJsonLine(file, value) {
  const descriptor = fs.openSync(file, 'a', 0o400);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value) + '\n');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readEvidenceJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Object.assign(
      new Error(`benchmark evidence is corrupt: ${path.basename(file)}`),
      { code: 'P1_PHYSIOLOGY_BENCHMARK_EVIDENCE_CORRUPT', cause: error }
    );
  }
}

function countJsonLines(file) {
  try {
    const bytes = fs.readFileSync(file, 'utf8');
    if (!bytes) return 0;
    if (!bytes.endsWith('\n')) {
      throw new Error('sample ledger has an incomplete final record');
    }
    return bytes.split('\n').length - 1;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw Object.assign(
      new Error('benchmark sample ledger is corrupt'),
      { code: 'P1_PHYSIOLOGY_BENCHMARK_EVIDENCE_CORRUPT', cause: error }
    );
  }
}

function summary(state, sample, milestone, elapsedMs) {
  const observedFailureCount = observedFailures(state);
  const checkpointProgress = {
    sntss: Number(state.latestSntssCheckpointGeneration || 0) -
      Number(state.startingSntssCheckpointGeneration || 0),
    chronobiology: Number(state.latestChronobiologyCheckpointGeneration || 0) -
      Number(state.startingChronobiologyCheckpointGeneration || 0)
  };
  const progressOk = checkpointProgress.sntss > 0 && checkpointProgress.chronobiology > 0;
  return {
    format: 'stay-physiology-benchmark-milestone-v3',
    milestone,
    result: observedFailureCount === 0 && progressOk ? 'PASS' : 'OBSERVED_FAILURES',
    recoveryAware: true,
    startedAt: state.startedAt,
    capturedAt: sample.capturedAt,
    elapsedMs,
    runtimeRevision: state.runtimeRevision,
    samples: state.samples,
    failures: state.failures,
    observedFailureCount,
    checkpointProgress,
    progressOk,
    coreHostFaults: {
      sntss: state.sntssCoreHostFaults,
      chronobiology: state.chronobiologyCoreHostFaults
    },
    coreHostTimeouts: {
      sntss: state.sntssCoreHostTimeouts,
      chronobiology: state.chronobiologyCoreHostTimeouts
    },
    recoveryRecords: {
      resyncRequired: {
        sntss: state.sntssResyncRows,
        chronobiology: state.chronobiologyResyncRows
      },
      deliveryRetries: {
        sntss: state.sntssDeliveryRetryRows,
        chronobiology: state.chronobiologyDeliveryRetryRows
      },
      maintenanceFailures: state.maintenanceFailureRows,
      startupTeardownFailures: state.startupTeardownFailureRows,
      detachTeardownFailures: state.detachTeardownFailureRows,
      terminalTeardownFailures: state.terminalTeardownFailureRows,
      shutdownCheckpointFailures: state.shutdownCheckpointFailureRows,
      shutdownStopFailures: state.shutdownStopFailureRows,
      outboxPublicationFailures: state.outboxPendingRows,
      duplicateResyncGroups: state.duplicateResyncGroups
    },
    cgroupMemoryEvents: {
      sntss: {
        high: state.sntssMemoryHighEvents,
        max: state.sntssMemoryMaxEvents,
        oom: state.sntssMemoryOomEvents,
        oomKill: state.sntssMemoryOomKillEvents
      },
      chronobiology: {
        high: state.chronobiologyMemoryHighEvents,
        max: state.chronobiologyMemoryMaxEvents,
        oom: state.chronobiologyMemoryOomEvents,
        oomKill: state.chronobiologyMemoryOomKillEvents
      }
    },
    cgroupPidsEvents: {
      sntss: { max: state.sntssPidsMaxEvents },
      chronobiology: { max: state.chronobiologyPidsMaxEvents }
    },
    cgroupCpuThrottleEvents: {
      sntss: { periods: state.sntssCpuThrottledPeriods },
      chronobiology: { periods: state.chronobiologyCpuThrottledPeriods }
    },
    processTransitions: {
      main: state.mainPidTransitions,
      sntss: state.sntssProcessTransitions,
      chronobiology: state.chronobiologyProcessTransitions
    },
    collector: {
      starts: Number(state.collectorStarts || 0),
      restarts: Number(state.collectorRestarts || 0),
      lastStartedAt: state.lastCollectorStartedAt || null
    },
    maxCpuPercent: state.maxCpuPercent,
    maxRssBytes: state.maxRssBytes,
    maxDatabaseBytes: state.maxDatabaseBytes,
    maxDatabaseWalBytes: state.maxDatabaseWalBytes,
    maxDatabaseTotalBytes: state.maxDatabaseTotalBytes,
    maxPendingDeliveries: state.maxPendingDeliveries,
    maxPendingOutboxIntents: state.maxPendingOutboxIntents,
    maxSntssCgroupBytes: state.maxSntssCgroupBytes,
    maxChronobiologyCgroupBytes: state.maxChronobiologyCgroupBytes,
    maxSntssCgroupPeakBytes: state.maxSntssCgroupPeakBytes,
    maxChronobiologyCgroupPeakBytes: state.maxChronobiologyCgroupPeakBytes,
    final: sample
  };
}

async function run() {
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true, mode: 0o700 });
  const stateFile = path.join(EVIDENCE_ROOT, 'state.json');
  const samplesFile = path.join(EVIDENCE_ROOT, 'samples.jsonl');
  const attemptsFile = path.join(EVIDENCE_ROOT, 'collector-attempts.json');
  const priorAttempts = readEvidenceJson(attemptsFile);
  const priorState = readEvidenceJson(stateFile);
  const attempt = Math.max(
    Number(priorAttempts?.attempts || 0),
    Number(priorState?.collectorStarts || 0)
  ) + 1;
  writeAtomic(attemptsFile, {
    format: 'stay-physiology-benchmark-collector-attempts-v1',
    attempts: attempt,
    lastAttemptAt: new Date().toISOString()
  });

  if (priorState && countJsonLines(samplesFile) !== Number(priorState.samples || 0)) {
    throw Object.assign(
      new Error('benchmark state and append-only sample ledger diverged'),
      { code: 'P1_PHYSIOLOGY_BENCHMARK_EVIDENCE_DIVERGED' }
    );
  }
  if (!priorState && countJsonLines(samplesFile) !== 0) {
    throw Object.assign(
      new Error('benchmark sample ledger exists without canonical state'),
      { code: 'P1_PHYSIOLOGY_BENCHMARK_EVIDENCE_DIVERGED' }
    );
  }

  let first = await capture();
  const state = priorState || initialState(first);
  if (
    state.format !== 'stay-physiology-benchmark-state-v3' ||
    Number(state.runtimeRevision) !== Number(first.health.revision)
  ) {
    throw Object.assign(
      new Error('benchmark state belongs to a different collector contract or runtime revision'),
      { code: 'P1_PHYSIOLOGY_BENCHMARK_STATE_IDENTITY' }
    );
  }
  state.collectorStarts = attempt;
  state.collectorRestarts = Math.max(0, attempt - 1);
  state.lastCollectorStartedAt = new Date().toISOString();
  writeAtomic(stateFile, state);
  const startedMs = Date.parse(state.startedAt);

  while (true) {
    const sample = first || await capture();
    first = null;
    const elapsedMs = Math.max(0, Date.now() - startedMs);
    updateState(state, sample, elapsedMs);
    appendJsonLine(samplesFile, sample);
    for (const milestone of MILESTONES) {
      if (elapsedMs >= milestone.elapsedMs && !state.milestones[milestone.name]) {
        const file = path.join(EVIDENCE_ROOT, `${milestone.name}.json`);
        writeAtomic(file, summary(state, sample, milestone.name, elapsedMs));
        state.milestones[milestone.name] = sample.capturedAt;
      }
    }
    writeAtomic(stateFile, state);
    if (elapsedMs >= COMPLETE_MS) return;
    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === 'sample') {
    process.stdout.write(JSON.stringify(await capture()) + '\n');
    return;
  }
  if (argv.length === 1 && argv[0] === 'run') return run();
  throw Object.assign(new Error('sample or run required'), { code: 'P1_PHYSIOLOGY_BENCHMARK_USAGE' });
}

if (require.main === module) main().catch(error => {
  console.error(`P1_PHYSIOLOGY_BENCHMARK_ABORT=${error.code || 'FAILED'}:${error.message}`);
  process.exitCode = 1;
});

module.exports = {
  capture,
  cgroupLeaf,
  countJsonLines,
  databaseSample,
  initialState,
  mainServicePid,
  normalizeProcesses,
  observedFailures,
  positiveDelta,
  recoveryDelta,
  processSetsDisjoint,
  queueHealthy,
  readEvidenceJson,
  sameProcesses,
  updateMemoryEventDeltas,
  summary,
  updateState,
  writeAtomic
};
