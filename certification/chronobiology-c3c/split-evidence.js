'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHA = /^[0-9a-f]{40}$/;
const TREE = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_CPU_STEAL_PERCENT = 5;
const HANDLER_LIMIT_MS = 250;

function fail(message, code = 'C3C_SPLIT_EVIDENCE_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

function recordSha256(record) {
  const body = structuredClone(record);
  delete body.record_sha256;
  return sha256(canonical(body));
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is not an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonical(actual) !== canonical(wanted)) fail(`${label} fields are not canonical`);
}

function parseTapSummary(text, label) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(?:#|ℹ)\s+(tests|pass|fail|cancelled|skipped|todo|duration_ms)\s+([0-9.]+)\s*$/u);
    if (match) values[match[1]] = Number(match[2]);
  }
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']) {
    if (!Number.isFinite(values[key])) fail(`${label} TAP summary is missing ${key}`);
  }
  const result = values.tests === values.pass
    && values.fail === 0 && values.cancelled === 0
    && values.skipped === 0 && values.todo === 0 ? 'PASS' : 'FAIL';
  return Object.freeze({
    tests: values.tests,
    passed: values.pass,
    failed: values.fail,
    skipped: values.skipped,
    todo: values.todo,
    cancelled: values.cancelled,
    duration_ms: values.duration_ms,
    result,
  });
}

function readCpuTotals(file) {
  const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find(value => value.startsWith('cpu '));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 8 || fields.some(value => !Number.isFinite(value))) return null;
  return { total: fields.reduce((sum, value) => sum + value, 0), steal: fields[7] };
}

function cpuStealPercent(beforeFile, afterFile) {
  const before = readCpuTotals(beforeFile);
  const after = readCpuTotals(afterFile);
  if (!before || !after || after.total <= before.total) return null;
  return Number((((after.steal - before.steal) * 100) / (after.total - before.total)).toFixed(3));
}

function environmentSummary(beforeFile, afterFile) {
  const cpu = os.cpus();
  return Object.freeze({
    cpu_model: cpu[0]?.model?.trim() || 'unavailable',
    vcpu_count: cpu.length,
    ram_bytes: os.totalmem(),
    kernel: `${os.type()} ${os.release()} ${os.arch()}`,
    node_version: process.version,
    load_average: Object.freeze(os.loadavg().map(value => Number(value.toFixed(3)))),
    cpu_steal_percent: cpuStealPercent(beforeFile, afterFile),
  });
}

function validateCandidate(candidate) {
  exactKeys(candidate, ['sha', 'tree'], 'candidate');
  if (!SHA.test(candidate.sha) || !TREE.test(candidate.tree)) fail('candidate identity is invalid');
}

function validateTestResult(value, label) {
  exactKeys(value, ['tests', 'passed', 'failed', 'skipped', 'todo', 'cancelled', 'duration_ms', 'result'], label);
  for (const key of ['tests', 'passed', 'failed', 'skipped', 'todo', 'cancelled']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) fail(`${label}.${key} is invalid`);
  }
  if (!Number.isFinite(value.duration_ms) || value.duration_ms < 0) fail(`${label}.duration_ms is invalid`);
  if (value.result !== 'PASS' || value.tests !== value.passed
    || value.failed !== 0 || value.skipped !== 0 || value.todo !== 0 || value.cancelled !== 0) {
    fail(`${label} is not zero-failure and zero-skip`, 'C3C_SPLIT_TEST_GATE');
  }
}

function validateHashes(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    fail(`${label} is invalid`);
  }
  for (const [name, digest] of Object.entries(value)) {
    if (!/^[a-z0-9_.-]+$/.test(name) || !DIGEST.test(digest)) fail(`${label} contains an invalid hash`);
  }
}

function validateComputeResult(record) {
  exactKeys(record, ['schema', 'result', 'candidate', 'tests', 'performance', 'environment', 'evidence_hashes', 'record_sha256'], 'compute record');
  if (record.schema !== 'stay.chronobiology.c3c-compute-result/v1' || record.result !== 'PASS') {
    fail('compute record did not pass');
  }
  validateCandidate(record.candidate);
  exactKeys(record.tests, ['direct', 'targeted', 'full'], 'compute tests');
  validateTestResult(record.tests.direct, 'direct');
  validateTestResult(record.tests.targeted, 'targeted');
  validateTestResult(record.tests.full, 'full');
  exactKeys(record.performance, ['handler_limit_ms', 'one_year_catchup_ms', 'result'], 'performance');
  if (record.performance.handler_limit_ms !== HANDLER_LIMIT_MS
    || !Number.isFinite(record.performance.one_year_catchup_ms)
    || record.performance.one_year_catchup_ms < 0
    || record.performance.one_year_catchup_ms >= HANDLER_LIMIT_MS
    || record.performance.result !== 'PASS') {
    fail('frozen 250 ms performance gate did not pass', 'C3C_SPLIT_PERFORMANCE_GATE');
  }
  exactKeys(record.environment, ['cpu_model', 'vcpu_count', 'ram_bytes', 'kernel', 'node_version', 'load_average', 'cpu_steal_percent'], 'environment');
  if (typeof record.environment.cpu_model !== 'string'
    || !Number.isSafeInteger(record.environment.vcpu_count) || record.environment.vcpu_count < 1
    || !Number.isSafeInteger(record.environment.ram_bytes) || record.environment.ram_bytes < 1
    || typeof record.environment.kernel !== 'string'
    || typeof record.environment.node_version !== 'string'
    || !Array.isArray(record.environment.load_average) || record.environment.load_average.length !== 3
    || !record.environment.load_average.every(Number.isFinite)
    || !Number.isFinite(record.environment.cpu_steal_percent)
    || record.environment.cpu_steal_percent > MAX_CPU_STEAL_PERCENT) {
    fail('compute environment is not a stable sustained-CPU environment', 'C3C_SPLIT_ENVIRONMENT_GATE');
  }
  validateHashes(record.evidence_hashes, 'compute evidence hashes');
  if (!DIGEST.test(record.record_sha256) || record.record_sha256 !== recordSha256(record)) {
    fail('compute record hash is invalid');
  }
  return record;
}

function validateLiveResult(record) {
  exactKeys(record, ['schema', 'result', 'candidate', 'sentinel', 'compute_record_sha256', 'evidence_hashes', 'record_sha256'], 'live record');
  if (record.schema !== 'stay.chronobiology.c3c-live-sentinel-result/v1' || record.result !== 'PASS') {
    fail('live sentinel record did not pass');
  }
  validateCandidate(record.candidate);
  exactKeys(record.sentinel, ['unchanged'], 'live sentinel');
  if (record.sentinel.unchanged !== true) fail('live sentinel changed', 'C3C_SPLIT_LIVE_GATE');
  if (!DIGEST.test(record.compute_record_sha256)) fail('live record compute binding is invalid');
  validateHashes(record.evidence_hashes, 'live evidence hashes');
  if (!DIGEST.test(record.record_sha256) || record.record_sha256 !== recordSha256(record)) {
    fail('live record hash is invalid');
  }
  return record;
}

function buildComputeResult({ root, candidateSha, candidateTree }) {
  const raw = path.join(root, 'raw');
  const logs = path.join(raw, 'logs');
  const performance = JSON.parse(fs.readFileSync(path.join(raw, 'performance.json'), 'utf8'));
  const tests = {
    direct: parseTapSummary(fs.readFileSync(path.join(logs, 'direct.tap'), 'utf8'), 'direct'),
    targeted: parseTapSummary(fs.readFileSync(path.join(logs, 'targeted.tap'), 'utf8'), 'targeted'),
    full: parseTapSummary(fs.readFileSync(path.join(logs, 'full.tap'), 'utf8'), 'full'),
  };
  for (const [label, value] of Object.entries(tests)) validateTestResult(value, label);
  const environment = environmentSummary(
    path.join(raw, 'cpu-stat-before.txt'),
    path.join(raw, 'cpu-stat-after.txt'),
  );
  const files = {
    direct_tap: path.join(logs, 'direct.tap'),
    targeted_tap: path.join(logs, 'targeted.tap'),
    full_tap: path.join(logs, 'full.tap'),
    performance: path.join(raw, 'performance.json'),
    source_tree: path.join(raw, 'source-tree.txt'),
    source_status: path.join(raw, 'source-status.txt'),
    environment_before: path.join(raw, 'environment-before.txt'),
    environment_after: path.join(raw, 'environment-after.txt'),
    cpu_stat_before: path.join(raw, 'cpu-stat-before.txt'),
    cpu_stat_after: path.join(raw, 'cpu-stat-after.txt'),
    node_pids_before: path.join(raw, 'node-pids-before.txt'),
    node_pids_after: path.join(raw, 'node-pids-after.txt'),
    new_node_pids: path.join(raw, 'new-node-pids.txt'),
    processes_before: path.join(raw, 'processes-before.txt'),
    processes_after: path.join(raw, 'processes-after.txt'),
  };
  const evidenceHashes = Object.fromEntries(Object.entries(files)
    .map(([name, file]) => [name, fileSha256(file)]));
  const record = {
    schema: 'stay.chronobiology.c3c-compute-result/v1',
    result: 'PASS',
    candidate: { sha: candidateSha, tree: candidateTree },
    tests,
    performance,
    environment,
    evidence_hashes: evidenceHashes,
  };
  record.record_sha256 = recordSha256(record);
  validateComputeResult(record);
  return record;
}

function buildLiveResult({ candidateSha, candidateTree, compute, beforeFile, afterFile, processBeforeFile, processAfterFile }) {
  validateComputeResult(compute);
  if (compute.candidate.sha !== candidateSha || compute.candidate.tree !== candidateTree) {
    fail('live sentinel candidate differs from compute candidate', 'C3C_SPLIT_CANDIDATE_MISMATCH');
  }
  if (!fs.readFileSync(beforeFile).equals(fs.readFileSync(afterFile))) {
    fail('live sentinel changed', 'C3C_SPLIT_LIVE_GATE');
  }
  const record = {
    schema: 'stay.chronobiology.c3c-live-sentinel-result/v1',
    result: 'PASS',
    candidate: { sha: candidateSha, tree: candidateTree },
    sentinel: { unchanged: true },
    compute_record_sha256: compute.record_sha256,
    evidence_hashes: {
      live_before: fileSha256(beforeFile),
      live_after: fileSha256(afterFile),
      processes_before: fileSha256(processBeforeFile),
      processes_after: fileSha256(processAfterFile),
    },
  };
  record.record_sha256 = recordSha256(record);
  validateLiveResult(record);
  return record;
}

function bindSplitEvidence(compute, live) {
  validateComputeResult(compute);
  validateLiveResult(live);
  if (compute.candidate.sha !== live.candidate.sha
    || compute.candidate.tree !== live.candidate.tree
    || compute.record_sha256 !== live.compute_record_sha256) {
    fail('compute and live evidence do not bind the same candidate', 'C3C_SPLIT_CANDIDATE_MISMATCH');
  }
  return Object.freeze({
    schema: 'stay.chronobiology.c3c-split-binding/v1',
    result: 'CANDIDATE_CERTIFIED_UNSEALED',
    release_sealed: false,
    candidate: structuredClone(compute.candidate),
    compute_record_sha256: compute.record_sha256,
    live_record_sha256: live.record_sha256,
  });
}

function writePrivateJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

module.exports = {
  HANDLER_LIMIT_MS,
  MAX_CPU_STEAL_PERCENT,
  bindSplitEvidence,
  buildComputeResult,
  buildLiveResult,
  cpuStealPercent,
  parseTapSummary,
  recordSha256,
  validateComputeResult,
  validateLiveResult,
  writePrivateJson,
};
