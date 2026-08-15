'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { fork, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
const { LivingKernel } = require('../runtime');
const { readProcessSample } = require('../runtime/kernel/resource-governor');
const { hash } = require('../cores/sntss/v0.1.0/species-profile');

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '..');
const workerPath = path.join(__dirname, 'sntss-r8-pressure-worker.js');

function option(name, fallback) { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; }
function percentile(values, fraction) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 0; }
function regressionPerHour(samples, field) {
  if (samples.length < 3) return null;
  const origin = samples[0].atMs; const points = samples.map(sample => ({ x: (sample.atMs - origin) / 3600000, y: Number(sample[field]) }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  return denominator > 0 ? points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator : null;
}
function parseKeyValues(text) {
  return Object.fromEntries(String(text).trim().split(/\r?\n/).filter(Boolean).map(line => { const [key, value] = line.trim().split(/\s+/, 2); return [key, Number(value)]; }));
}
async function readText(file) { return fs.readFile(file, 'utf8'); }
async function httpJson(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: 8787, path: pathname, timeout: 3000 }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`active runtime ${pathname} returned ${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.once('timeout', () => request.destroy(new Error('active runtime request timed out'))); request.once('error', reject);
  });
}
async function activeFoundation() {
  const [{ stdout }, status] = await Promise.all([
    execFileAsync('systemctl', ['show', 'stay.service', '--property=ActiveState,SubState,MainPID']),
    httpJson('/runtime/status')
  ]);
  const service = Object.fromEntries(stdout.trim().split(/\r?\n/).map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
  const fetus = (status.cores || []).find(core => core.coreId === 'fetus-legacy')?.active || null;
  return {
    activeState: service.ActiveState, subState: service.SubState, mainPid: Number(service.MainPID), healthOk: status.health?.ok === true,
    persistenceOk: status.health?.persistence?.ok === true, kernelVersion: status.kernel?.version,
    runtimeRevision: status.kernel?.runtimeRevision,
    fetus: fetus ? { instanceId: fetus.instanceId, version: fetus.manifest?.version, lifecycle: fetus.host?.lifecycle, pid: fetus.host?.pid } : null,
    authority: (status.authority || []).map(entry => ({ coreId: entry.coreId, epoch: entry.epoch, instanceId: entry.instanceId })).sort((a, b) => a.coreId.localeCompare(b.coreId))
  };
}
function foundationStable(before, after) { return JSON.stringify(before) === JSON.stringify(after); }

async function waitForExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('pressure worker timed out')); }, timeoutMs);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
}
async function removeCgroup(directory) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await fs.rmdir(directory); return; } catch (error) { if (error.code !== 'EBUSY' && error.code !== 'ENOTEMPTY') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`pressure cgroup did not drain: ${path.basename(directory)}`);
}
async function runPressure(coresRoot, kind, runId) {
  const directory = path.join(coresRoot, `r8-${kind}-${runId}`.replace(/[^a-zA-Z0-9_.-]/g, '-'));
  await fs.mkdir(directory);
  const limits = kind === 'oom'
    ? { 'memory.max': String(48 * 1024 * 1024), 'pids.max': '16', 'cpu.max': '50000 100000' }
    : kind === 'pids'
      ? { 'memory.max': String(96 * 1024 * 1024), 'pids.max': '8', 'cpu.max': '50000 100000' }
      : { 'memory.max': String(96 * 1024 * 1024), 'pids.max': '16', 'cpu.max': '20000 100000' };
  for (const [name, value] of Object.entries(limits)) await fs.writeFile(path.join(directory, name), value);
  const beforeCpu = parseKeyValues(await readText(path.join(directory, 'cpu.stat')));
  const child = fork(workerPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let message = null; child.on('message', value => { message = value; });
  try {
    await fs.writeFile(path.join(directory, 'cgroup.procs'), String(child.pid));
    child.send({ kind });
    const startedAt = Date.now(); const exit = await waitForExit(child, kind === 'oom' ? 20000 : 15000); const wallMs = Date.now() - startedAt;
    const [memoryEvents, pidsEvents, afterCpu] = await Promise.all([
      readText(path.join(directory, 'memory.events')).then(parseKeyValues),
      readText(path.join(directory, 'pids.events')).then(parseKeyValues),
      readText(path.join(directory, 'cpu.stat')).then(parseKeyValues)
    ]);
    const cpuUsageDeltaUsec = (afterCpu.usage_usec || 0) - (beforeCpu.usage_usec || 0);
    const result = { kind, limits, exit, message, wallMs, memoryEvents, pidsEvents, cpuStat: afterCpu, cpuUsageDeltaUsec, cpuDuty: cpuUsageDeltaUsec / Math.max(1, wallMs * 1000) };
    result.contained = kind === 'oom' ? (memoryEvents.oom_kill || 0) >= 1 && exit.signal === 'SIGKILL'
      : kind === 'pids' ? (pidsEvents.max || 0) >= 1 && Number(message?.errors || 0) >= 1
        : result.cpuDuty <= 0.25 && (afterCpu.nr_throttled || 0) > (beforeCpu.nr_throttled || 0);
    return result;
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 100));
    await removeCgroup(directory);
  }
}

async function main() {
  const durationSeconds = Math.max(180, Number(option('--duration-seconds', 600)) || 600);
  const output = path.resolve(option('--output', path.join(process.cwd(), 'R8_HOST_EVIDENCE.json')));
  const runId = String(process.env.STAY_R8_RUN_ID || crypto.randomUUID()).replace(/[^a-zA-Z0-9_.-]/g, '-');
  const workRoot = await fs.mkdtemp(path.join(process.cwd(), `r8-state-${runId}-`));
  const dataDir = path.join(workRoot, 'disposable-state');
  const report = {
    format: 'stay-sntss-r8-host-evidence-v1', evidenceVersion: 1, runId,
    sourceCommit: process.env.STAY_R8_HOST_COMMIT || null, startedAt: new Date().toISOString(),
    activeStatePathTouched: false, activeReleasePointerChanged: false, serviceRestarted: false,
    disposableState: true, productionEligible: false, requestedSteadyDurationSeconds: durationSeconds,
    limits: { steadyRssBytes: 64 * 1024 * 1024, hardRssBytes: 96 * 1024 * 1024, rssSlopeBytesPerHour: 1024 * 1024, sustainedCpuDuty: 0.05, handlerP99Ms: 25, queueDepth: 64, checkpointBytes: 1024 * 1024 },
    failures: []
  };
  const kernel = new LivingKernel({ dataDir, allowIdentityBootstrap: true, heartbeatIntervalMs: 1000, snapshotIntervalMs: 5000, snapshotRetention: 4 });
  try {
    report.foundationBefore = await activeFoundation();
    await kernel.start(); await kernel.installCore(path.join(root, 'cores/sntss/v0.1.0/index.js'));
    const slot = kernel.registry.get('sntss'); const client = slot.active.client;
    if (!client.cgroup.available || !client.cgroup.directory || !client.cgroup.coresRoot) report.failures.push('SNTSS per-instance delegated cgroup is unavailable');
    report.cgroup = {
      coresRoot: path.basename(client.cgroup.coresRoot || ''), leaf: path.basename(client.cgroup.directory || ''),
      memoryHigh: await readText(path.join(client.cgroup.directory, 'memory.high')),
      memoryMax: await readText(path.join(client.cgroup.directory, 'memory.max')),
      pidsMax: await readText(path.join(client.cgroup.directory, 'pids.max')),
      cpuMax: await readText(path.join(client.cgroup.directory, 'cpu.max'))
    };
    const expected = { memoryHigh: String(64 * 1024 * 1024), memoryMax: String(96 * 1024 * 1024), pidsMax: '16', cpuMax: '20000 100000' };
    for (const [key, value] of Object.entries(expected)) if (report.cgroup[key].trim() !== value) report.failures.push(`cgroup ${key} differs from contract`);

    const initialGeneration = client.generation; client.child.kill('SIGKILL');
    const restartDeadline = Date.now() + 10000;
    while (Date.now() < restartDeadline && client.generation === initialGeneration) await new Promise(resolve => setTimeout(resolve, 50));
    report.sigkill = { generationBefore: initialGeneration, generationAfter: client.generation, recovered: client.generation > initialGeneration && client.lifecycle === 'active' };
    if (!report.sigkill.recovered) report.failures.push('SNTSS did not recover locally after SIGKILL');

    await new Promise(resolve => setTimeout(resolve, 30000));
    const samples = []; const handlerLatenciesMs = []; const startTicks = (await readProcessSample(client.pid))?.cpuTicks || 0; const startedAtMs = Date.now();
    const sample = async () => {
      const before = performance.now(); const health = await client.health(); handlerLatenciesMs.push(performance.now() - before);
      const processSample = await readProcessSample(client.pid); const status = await slot.status();
      samples.push({ at: new Date().toISOString(), atMs: Date.now(), rssBytes: processSample?.rssBytes, cpuTicks: processSample?.cpuTicks, queueDepth: status.active?.queue?.depth || 0, healthOk: health.ok === true });
    };
    await sample(); const sampleEnd = Date.now() + durationSeconds * 1000;
    while (Date.now() < sampleEnd) { await new Promise(resolve => setTimeout(resolve, 5000)); await sample(); }
    const finalProcess = await readProcessSample(client.pid); const elapsedMs = Date.now() - startedAtMs;
    const clockTicks = Number((await execFileAsync('getconf', ['CLK_TCK'])).stdout.trim()) || 100;
    const cpuDuty = Math.max(0, ((finalProcess?.cpuTicks || startTicks) - startTicks) / clockTicks) / Math.max(0.001, elapsedMs / 1000);
    const checkpoint = await client.snapshot(); const checkpointBytes = Buffer.byteLength(JSON.stringify(checkpoint));
    report.steady = {
      observedDurationMs: elapsedMs, samples: samples.length, rssMinimumBytes: Math.min(...samples.map(entry => entry.rssBytes)),
      rssPeakBytes: Math.max(...samples.map(entry => entry.rssBytes)), rssSlopeBytesPerHour: regressionPerHour(samples, 'rssBytes'),
      cpuDuty, handlerP99Ms: percentile(handlerLatenciesMs, 0.99), queuePeak: Math.max(...samples.map(entry => entry.queueDepth)), checkpointBytes,
      allHealthOk: samples.every(entry => entry.healthOk)
    };
    if (report.steady.rssPeakBytes >= report.limits.steadyRssBytes) report.failures.push('steady SNTSS RSS reached or exceeded 64 MiB');
    if (report.steady.rssPeakBytes >= report.limits.hardRssBytes) report.failures.push('SNTSS RSS crossed 96 MiB hard ceiling');
    if (report.steady.rssSlopeBytesPerHour > report.limits.rssSlopeBytesPerHour) report.failures.push('SNTSS RSS slope exceeded 1 MiB/hour');
    if (report.steady.cpuDuty >= report.limits.sustainedCpuDuty) report.failures.push('SNTSS sustained CPU reached or exceeded 5%');
    if (report.steady.handlerP99Ms >= report.limits.handlerP99Ms) report.failures.push('SNTSS handler p99 reached or exceeded 25 ms');
    if (report.steady.queuePeak >= report.limits.queueDepth) report.failures.push('SNTSS queue reached 25% capacity');
    if (checkpointBytes >= report.limits.checkpointBytes) report.failures.push('SNTSS checkpoint reached 1 MiB');
    if (!report.steady.allHealthOk) report.failures.push('SNTSS health was not continuously healthy');

    report.pressure = {};
    for (const kind of ['oom', 'pids', 'cpu']) {
      report.pressure[kind] = await runPressure(client.cgroup.coresRoot, kind, runId);
      if (!report.pressure[kind].contained) report.failures.push(`${kind} pressure was not contained by its sacrificial cgroup`);
      const health = await kernel.health(); if (!health.ok || !health.persistence?.ok) report.failures.push(`disposable Kernel/StateStore degraded after ${kind} pressure`);
    }
    await kernel.stop();
    report.foundationAfter = await activeFoundation();
    report.foundationStable = foundationStable(report.foundationBefore, report.foundationAfter);
    if (!report.foundationStable) report.failures.push('active foundation snapshot changed during isolated drill');
    report.completedAt = new Date().toISOString(); report.status = report.failures.length ? 'FAIL' : 'PASS';
    const body = { ...report }; delete body.evidenceHash; report.evidenceHash = hash(body);
    await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ status: report.status, evidenceHash: report.evidenceHash, output, failures: report.failures })}\n`);
    if (report.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    report.failures.push(error.code || error.message); report.completedAt = new Date().toISOString(); report.status = 'FAIL';
    const body = { ...report }; delete body.evidenceHash; report.evidenceHash = hash(body);
    await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => {});
    throw error;
  } finally {
    if (kernel.stateStore.db) await kernel.stop().catch(() => {});
    await fs.rm(workRoot, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { regressionPerHour, foundationStable, parseKeyValues };
