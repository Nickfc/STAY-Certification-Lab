'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LivingKernel } = require('../runtime');

function numericOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? Number(process.argv[index + 1]) : fallback;
}

function textOption(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}

function regressionSlope(samples, field) {
  const points = samples.map(sample => ({ x: Date.parse(sample.at), y: Number(sample[field]) }))
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length < 3) return null;
  const origin = points[0].x;
  const scaled = points.map(point => ({ x: (point.x - origin) / 60000, y: point.y }));
  const meanX = scaled.reduce((sum, point) => sum + point.x, 0) / scaled.length;
  const meanY = scaled.reduce((sum, point) => sum + point.y, 0) / scaled.length;
  const denominator = scaled.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  return denominator > 0
    ? scaled.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator
    : null;
}

function validateHardwareEvidence(evidence, qualification, requiredDurationMs, expectedRunId = null) {
  const failures = [];
  if (!evidence || evidence.format !== 'stay-hardware-evidence-v1') failures.push('hardware evidence format is missing or unsupported');
  const runId = String(evidence?.runId || '');
  if (!/^[A-Za-z0-9._:-]{16,200}$/.test(runId)) failures.push('hardware evidence runId is missing or invalid');
  if (expectedRunId && runId !== expectedRunId) failures.push('hardware evidence runId does not match the endurance challenge');
  const nodes = Array.isArray(evidence?.nodes) ? evidence.nodes : [];
  const kinds = new Set(nodes.map(node => node.kind));
  for (const required of ['ryzen-desktop', 'desktop-gpu', 'second-gpu', 'cpu-only', 'mobile']) {
    if (!kinds.has(required)) failures.push(`required hardware node missing: ${required}`);
  }
  if (Number(evidence?.durationMs) < requiredDurationMs * 0.99) failures.push(`hardware evidence is shorter than ${qualification}`);
  const startedAt = Date.parse(evidence?.startedAt);
  const completedAt = Date.parse(evidence?.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt <= startedAt) {
    failures.push('hardware evidence start/completion timestamps are missing or invalid');
  } else {
    const observed = completedAt - startedAt;
    if (observed < requiredDurationMs * 0.99) failures.push(`hardware evidence timestamp span is shorter than ${qualification}`);
    if (Math.abs(observed - Number(evidence?.durationMs || 0)) > Math.max(60000, observed * 0.01)) {
      failures.push('hardware evidence duration does not match its timestamp span');
    }
  }
  const nodeIds = new Set();
  for (const node of nodes) {
    const nodeId = String(node?.id || '');
    if (!nodeId || nodeIds.has(nodeId)) failures.push(`hardware node id is missing or duplicated: ${nodeId || '<missing>'}`);
    nodeIds.add(nodeId);
    const samples = Array.isArray(node?.samples) ? node.samples : [];
    if (samples.length < 12) {
      failures.push(`hardware node has insufficient raw samples: ${nodeId || node?.kind || '<unknown>'}`);
      continue;
    }
    const times = samples.map(sample => Date.parse(sample?.at)).filter(Number.isFinite).sort((a, b) => a - b);
    if (times.length !== samples.length) failures.push(`hardware node contains invalid sample timestamps: ${nodeId}`);
    if (Number.isFinite(startedAt) && Number.isFinite(completedAt) && times.length) {
      if (times[0] > startedAt + requiredDurationMs * 0.02 || times.at(-1) < completedAt - requiredDurationMs * 0.02) {
        failures.push(`hardware node samples do not span the run: ${nodeId}`);
      }
      for (let index = 1; index < times.length; index++) {
        if (times[index] === times[index - 1]) { failures.push(`hardware node contains duplicate sample timestamps: ${nodeId}`); break; }
      }
    }
  }
  for (const check of ['gpuDutyTolerance', 'cpuQuietRyzen', 'viewerFreezeBackoff', 'memoryStable', 'reconnects', 'faultRecovery']) {
    if (evidence?.checks?.[check] !== true) failures.push(`hardware check did not pass: ${check}`);
  }
  return failures;
}

async function main() {
  const seconds = numericOption('--seconds', 0);
  const hours = numericOption('--hours', 0);
  const durationMs = Math.max(1000, seconds > 0 ? seconds * 1000 : (hours > 0 ? hours : 24) * 3600000);
  const qualification = durationMs >= 72 * 3600000 ? '72h' : durationMs >= 24 * 3600000 ? '24h' : 'smoke';
  const certificationRun = qualification !== 'smoke';
  const evidencePath = textOption('--evidence');
  const runId = textOption('--run-id');
  const root = path.join(__dirname, '..');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-endurance-'));
  const kernel = new LivingKernel({
    dataDir: dir,
    allowIdentityBootstrap: true,
    heartbeatIntervalMs: 1000,
    snapshotIntervalMs: 5000,
    snapshotRetention: 4
  });
  const report = {
    format: 'stay-endurance-report-v2',
    runtimeVersion: '0.8.11.3',
    runId: runId || null,
    qualification,
    certificationEligible: certificationRun,
    startedAt: new Date().toISOString(),
    requestedDurationMs: durationMs,
    samples: [],
    assertions: {},
    failures: []
  };
  let ticker;
  let sampler;
  try {
    await kernel.start();
    const identity = kernel.identity.organismId;
    if (certificationRun) {
      if (!evidencePath) throw Object.assign(new Error('24h/72h certification requires --evidence <hardware-evidence.json>'), { code: 'HARDWARE_EVIDENCE_REQUIRED' });
      if (!/^[A-Za-z0-9._:-]{16,200}$/.test(String(runId || ''))) {
        throw Object.assign(new Error('24h/72h certification requires --run-id <unique-challenge-id>'), { code: 'RUN_ID_REQUIRED' });
      }
      await kernel.installCore(path.join(root, 'cores', 'fetus-legacy-0.6', 'index.js'));
    } else {
      await kernel.installCore(path.join(root, 'test', 'fixtures', 'cores', 'counter-v1.js'));
      ticker = setInterval(() => kernel.publish('test.tick', {}, { eventClass: 'best-effort' }).catch(() => {}), 50);
    }
    const sampleStatus = async () => {
      try {
        const memory = process.memoryUsage();
        const status = await kernel.status({ force: true });
        report.samples.push({
          at: new Date().toISOString(), rss: memory.rss, heapUsed: memory.heapUsed,
          eventSequence: status.eventFabric.sequence,
          coreHosts: status.cores.filter(core => core.active?.host).map(core => ({
            coreId: core.coreId,
            rssBytes: core.active.host.resourceGovernor?.latest?.rssBytes || null,
            queueDepth: core.active.queue?.depth || 0,
            staleOutputs: core.active.staleOutputs || 0
          }))
        });
        if (report.samples.length > 20000) report.samples.shift();
      } catch (error) {
        report.failures.push(`sampler: ${error.code || error.message}`);
      }
    };
    await sampleStatus();
    sampler = setInterval(sampleStatus, 5000);
    await new Promise(resolve => setTimeout(resolve, durationMs));
    clearInterval(ticker);
    clearInterval(sampler);
    await kernel.writeHeartbeat();
    const final = await kernel.status({ force: true });
    report.completedAt = new Date().toISOString();
    report.observedDurationMs = Date.parse(report.completedAt) - Date.parse(report.startedAt);
    report.kernelRssSlopeBytesPerMinute = regressionSlope(report.samples, 'rss');
    report.kernelHeapSlopeBytesPerMinute = regressionSlope(report.samples, 'heapUsed');
    report.assertions.identityPreserved = kernel.identity.organismId === identity;
    report.assertions.persistenceHealthy = final.health.persistence.ok === true;
    report.assertions.singleAuthority = final.authority.every(entry => Number.isInteger(entry.epoch) && entry.epoch >= 1 && Boolean(entry.instanceId));
    report.assertions.noStaleAuthorityOutputs = final.cores.every(core => !core.active || Number(core.active.staleOutputs || 0) === 0);
    for (const [name, passed] of Object.entries(report.assertions)) if (!passed) report.failures.push(`runtime assertion failed: ${name}`);

    if (certificationRun) {
      const evidence = JSON.parse(await fs.readFile(path.resolve(evidencePath), 'utf8'));
      report.hardwareEvidence = { path: path.resolve(evidencePath), format: evidence.format, runId: evidence.runId, durationMs: evidence.durationMs };
      report.failures.push(...validateHardwareEvidence(evidence, qualification, durationMs, runId));
      report.status = report.failures.length ? 'FAIL' : 'PASS-CERTIFICATION-EVIDENCE';
    } else {
      report.status = report.failures.length ? 'FAIL' : 'PASS-SMOKE-NOT-CERTIFICATION';
    }
    await kernel.stop();
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'FAIL') process.exitCode = 1;
  } finally {
    clearInterval(ticker);
    clearInterval(sampler);
    if (kernel.stateStore.db) await kernel.stop().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({ format: 'stay-endurance-report-v2', status: 'FAIL', code: error.code || null, error: error.message }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = { regressionSlope, validateHardwareEvidence };
