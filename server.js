'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const pkg = require('./package.json');
const { LivingKernel } = require('./runtime');
const { readRevisionFreeze } = require('./runtime/revision-freeze');
const { projectObservationChips } = require('./runtime/ui/chip-projection');

const STAY_VERSION = pkg.stayVersion || pkg.version;
const dataDir = process.env.STAY_DATA_DIR || path.join(process.cwd(), '.stay-data');
const host = process.env.STAY_HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
const legacyProxyPort = Number(process.env.STAY_LEGACY_PORT || 0);
const badgePath = path.join(__dirname, 'runtime', 'ui', 'live-badge.js');
const gpuEnginePath = path.join(__dirname, 'runtime', 'ui', 'gpu-engine.js');
const computeGovernorPath = path.join(__dirname, 'runtime', 'ui', 'compute-governor.js');

function publicMetadata(status) {
  const cores = [];
  for (const slot of status.cores || []) {
    for (const mode of ['active', 'candidate', 'standby']) {
      const unit = slot[mode];
      if (!unit || !unit.manifest) continue;
      const guardian = unit.health && unit.health.memoryGuardian;
      cores.push({
        id: slot.coreId,
        version: unit.manifest.version || '?',
        mode,
        ok: !(unit.health && unit.health.ok === false),
        memoryGuardian: guardian ? {
          status: guardian.status || null,
          rssMiB: Number.isFinite(Number(guardian.rssMiB)) ? Number(guardian.rssMiB) : null,
          peakRssMiB: Number.isFinite(Number(guardian.peakRssMiB)) ? Number(guardian.peakRssMiB) : null,
          warnAtMiB: Number.isFinite(Number(guardian.warnAtMiB)) ? Number(guardian.warnAtMiB) : null,
          recycleAtMiB: Number.isFinite(Number(guardian.recycleAtMiB)) ? Number(guardian.recycleAtMiB) : null,
          guardianRecycles: Number(guardian.guardianRecycles) || 0,
          crashRestarts: Number(guardian.crashRestarts) || 0,
          lastSampleAt: guardian.lastSampleAt || null
        } : null
      });
    }
  }
  const revision = status.kernel ? status.kernel.runtimeRevision : null;
  const revisionFreeze = readRevisionFreeze(revision);
  const residentStatus = Array.isArray(status.residencies)
    ? status.residencies
    : (Array.isArray(status.health?.residencies) ? status.health.residencies : []);
  const residents = residentStatus.filter(Boolean).map((resident) => {
    const observedMode = String(resident.health?.mode || '').toUpperCase();
    const mode = ['LIVE', 'SHADOW', 'NEUTRAL'].includes(observedMode)
      ? observedMode
      : resident.coreId === 'chronobiology' ||
          (resident.coreId === 'sntss' && resident.version === '0.5.0-i4g1')
        ? 'SHADOW'
        : 'NEUTRAL';
    return {
      residencyId: resident.residencyId,
      coreId: resident.coreId,
      version: resident.version,
      status: resident.status,
      lifecycle: resident.lifecycle || resident.status || null,
      running: resident.running === true,
      mode,
      authorityOwned: resident.authorityOwned === true,
      checkpointGeneration: Number(resident.checkpointGeneration || 0),
      handledEvents: Number(resident.handledEvents || 0),
      observedOutputs: Number(resident.observedOutputs || 0),
      healthOk: resident.running === true && resident.health?.ok === true
    };
  });
  const bsfLedger = status.biologicalLedger || status.health?.biologicalLedger || null;
  const bsfOk = status.health?.persistence?.ok !== false &&
    bsfLedger?.protocol === 'stay-biological-ledger-v1';
  const systems = [{
    id: 'bsf',
    label: 'BSF',
    mode: 'LIVE',
    status: bsfOk ? 'RUNNING' : 'DEGRADED',
    running: bsfOk,
    healthOk: bsfOk,
    protocol: bsfLedger?.protocol || null,
    events: Number(bsfLedger?.events || 0),
    pendingDeliveries: Number(bsfLedger?.pendingDeliveries || 0),
    activeConsumers: Number(bsfLedger?.activeConsumers || 0),
    writeFailures: Number(status.health?.persistence?.writeFailureCount || 0)
  }];
  const chipProjection = projectObservationChips({ systems, residents });
  return {
    ok: status.health ? status.health.ok : true,
    version: STAY_VERSION,
    revision,
    revisionFrozen: revisionFreeze.frozen,
    revisionLabel: revisionFreeze.label,
    updatedAt: new Date().toISOString(),
    cores,
    systems,
    residents,
    chipProjection
  };
}

function injectRuntimeScripts(html) {
  if (html.includes('/__stay/gpu-engine.js')) return html;
  const runtimeTags = [
    '<script src="/cognitive-core.js?v=0.6.0" defer></script>',
    '<script src="/__stay/compute-governor.js" defer></script>',
    '<script src="/__stay/gpu-engine.js" defer></script>',
    '<script src="/__stay/live-badge.js" defer></script>'
  ].join('');

  const clientTag = /<script\s+src=["']\/client\.js[^"']*["']\s+defer><\/script>/i;
  if (clientTag.test(html)) {
    return html.replace(clientTag, (match) => runtimeTags + match);
  }
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, runtimeTags + '</body>');
  return html + runtimeTags;
}


function transformLegacyHtml(html) {
  let output = injectRuntimeScripts(html);
  output = output.replace(
    'browser contribution <span id="budget">10% target</span>',
    'browser contribution <span id="budget">5% target</span>'
  );
  output = output.replace(
    'Browsers use an adaptive Worker pool targeting 10% of the logical compute exposed by each device.',
    'Each browser chooses its own live compute contribution from 1% to 100%.'
  );
  return output;
}

function transformLegacyClient(source) {
  const fixedShare = '  const targetShare = 0.10;';
  const adaptiveShare = [
    "  const storedShare = Number(localStorage.getItem('stay-compute-share'));",
    "  const targetShare = Math.max(0.01, Math.min(1, Number.isFinite(storedShare) && storedShare > 0 ? storedShare : 0.05));",
    "  const enginePreference = String(localStorage.getItem('stay-compute-engine') || 'auto').toLowerCase();",
    "  const gpuReady = Boolean(window.__stayGpuStatus?.ready);",
    "  const engineResolved = enginePreference === 'cpu' ? 'cpu' : enginePreference === 'gpu' ? (gpuReady ? 'gpu' : 'gpu-waiting') : enginePreference === 'hybrid' ? (gpuReady ? 'hybrid' : 'hybrid-degraded') : (gpuReady ? 'gpu' : 'cpu');",
    "  const storedHybridGpu = Number(localStorage.getItem('stay-hybrid-gpu-share'));",
    "  const hybridGpuFraction = Math.max(0.1, Math.min(0.9, Number.isFinite(storedHybridGpu) && storedHybridGpu > 0 ? storedHybridGpu : 0.8));",
    "  const cpuShare = engineResolved === 'cpu' ? targetShare : (engineResolved === 'hybrid' || engineResolved === 'hybrid-degraded') ? targetShare * (1 - hybridGpuFraction) : 0;",
    "  const gpuShare = engineResolved === 'gpu' ? targetShare : engineResolved === 'hybrid' ? targetShare * hybridGpuFraction : 0;"
  ].join('\n');

  if (!source.includes(fixedShare)) {
    throw new Error('legacy client compute-share marker not found');
  }

  let output = source.replace(fixedShare, adaptiveShare);

  const stateWorkerMarker = '  workers: new Map(),';
  if (!output.includes(stateWorkerMarker)) {
    throw new Error('legacy client worker-state marker not found');
  }
  output = output.replace(
    stateWorkerMarker,
    "  workers: new Map(),\n  dispatchTimers: new Set(),\n  gpuWasReady: Boolean(window.__stayGpuStatus?.ready),\n  gpuTaskInFlight: false,"
  );

  const oldPool = [
    '  // A bounded pool avoids spawning dozens of Workers on high-core machines.',
    '  // The per-worker duty budget grows instead, so total CPU-time still targets',
    '  // ~10% of the logical compute exposed by the browser.',
    '  let poolSize = Math.max(1, Math.min(logicalCores, 8));',
    '  while (targetCpuMsPerSecond / poolSize > 850 && poolSize < Math.min(logicalCores, 16)) poolSize++;',
    '  const budgetMsPerWorker = Math.max(20, Math.min(850, targetCpuMsPerSecond / poolSize));'
  ].join('\n');

  const quietPool = [
    '  // CPU Quiet Governor constrains aggregate time, concurrency and continuous burst length.',
    '  const quietPolicy = window.STAYComputeGovernor?.cpuPolicy(cpuShare, logicalCores) || {',
    '    poolSize: cpuShare > 0 ? 1 : 0, budgetMsPerWorker: Math.min(250, targetCpuMsPerSecond),',
    '    sliceMs: 4, dispatchWindowMs: 700, effectiveShare: Math.min(cpuShare, 0.01), peakConcurrency: 1, reason: \'fallback\'',
    '  };',
    '  const poolSize = quietPolicy.poolSize;',
    '  const budgetMsPerWorker = quietPolicy.budgetMsPerWorker;',
    '  const sliceMs = quietPolicy.sliceMs;',
    '  const dispatchWindowMs = quietPolicy.dispatchWindowMs;',
    '  const governedEffectiveShare = quietPolicy.effectiveShare;',
    '  const peakConcurrency = quietPolicy.peakConcurrency;',
    '  const governorReason = quietPolicy.reason;',
    "  const mode = engineResolved === 'cpu' ? 'cpu-quiet-spread' : engineResolved === 'hybrid' ? 'hybrid' : engineResolved === 'hybrid-degraded' ? 'hybrid-cpu-only' : engineResolved === 'gpu-waiting' ? 'gpu-waiting' : 'gpu';"
  ].join('\n');

  if (!output.includes(oldPool)) {
    throw new Error('legacy client worker-pool marker not found');
  }
  output = output.replace(oldPool, quietPool);

  const returnMarker = '    budgetMsPerWorker\n  };';
  if (!output.includes(returnMarker)) {
    throw new Error('legacy client compute-plan return marker not found');
  }
  output = output.replace(
    returnMarker,
    '    budgetMsPerWorker,\n    sliceMs,\n    dispatchWindowMs,\n    mode,\n    enginePreference,\n    engineResolved,\n    cpuShare,\n    gpuShare,\n    hybridGpuFraction,\n    governedEffectiveShare,\n    peakConcurrency,\n    governorReason\n  };'
  );

  // Keep the UI's public plan current both at initial boot and after live slider changes.
  output = output.split('  state.computePlan = createComputePlan();').join(
    '  state.computePlan = createComputePlan();\n  window.__stayComputePlan = { ...state.computePlan };'
  );

  const immediateDispatch = '  if (state.latestTask) dispatchTaskToSlot(slot);';
  if (!output.includes(immediateDispatch)) {
    throw new Error('legacy client immediate-dispatch marker not found');
  }
  output = output.replace(immediateDispatch, '');

  const startPoolMarker = [
    "function startWorkerPool(reason = 'startup') {",
    '  for (const slot of state.workers.values()) {'
  ].join('\n');
  if (!output.includes(startPoolMarker)) {
    throw new Error('legacy client start-pool marker not found');
  }
  output = output.replace(
    startPoolMarker,
    [
      "function startWorkerPool(reason = 'startup') {",
      '  clearScheduledDispatches();',
      '  for (const slot of state.workers.values()) {'
    ].join('\n')
  );

  const startPoolTail = [
    '  for (let shardId = 0; shardId < state.computePlan.poolSize; shardId++) {',
    '    makeWorkerSlot(shardId, generation);',
    '  }',
    '}'
  ].join('\n');
  if (!output.includes(startPoolTail)) {
    throw new Error('legacy client start-pool tail marker not found');
  }
  output = output.replace(
    startPoolTail,
    [
      '  for (let shardId = 0; shardId < state.computePlan.poolSize; shardId++) {',
      '    makeWorkerSlot(shardId, generation);',
      '  }',
      '  if (state.latestTask) dispatchLatestTask();',
      '}'
    ].join('\n')
  );

  const dispatchMarker = 'function dispatchTaskToSlot(slot) {';
  if (!output.includes(dispatchMarker)) {
    throw new Error('legacy client dispatch marker not found');
  }

  const schedulerHelpers = [
    'function clearScheduledDispatches() {',
    '  for (const timer of state.dispatchTimers) clearTimeout(timer);',
    '  state.dispatchTimers.clear();',
    '}',
    '',
    'function scheduleTaskForSlot(slot, index, total) {',
    '  if (!slot?.worker || !state.latestTask) return;',
    '  const generation = state.workerGeneration;',
    '  const epoch = Number(state.latestTask.epoch) || -1;',
    '  const plan = state.computePlan;',
    '  const count = Math.max(1, Number(total) || 1);',
    '  const position = Math.max(0, Number(index) || 0);',
    '  const offsetMs = count > 1 ? (plan.dispatchWindowMs * position) / (count - 1) : 0;',
    '  const timer = setTimeout(() => {',
    '    state.dispatchTimers.delete(timer);',
    '    if (generation !== state.workerGeneration) return;',
    '    if (!state.latestTask || Number(state.latestTask.epoch) !== epoch) return;',
    '    dispatchTaskToSlot(slot);',
    '  }, offsetMs);',
    '  state.dispatchTimers.add(timer);',
    '}',
    '',
    dispatchMarker
  ].join('\n');

  output = output.replace(dispatchMarker, schedulerHelpers);

  const budgetMarker = '    budgetMs: state.computePlan.budgetMsPerWorker';
  if (!output.includes(budgetMarker)) {
    throw new Error('legacy client task-budget marker not found');
  }
  output = output.replace(
    budgetMarker,
    '    budgetMs: state.computePlan.budgetMsPerWorker,\n    sliceMs: state.computePlan.sliceMs'
  );

  const oldDispatchLatest = [
    'function dispatchLatestTask() {',
    '  if (!state.latestTask) return;',
    '  for (const slot of state.workers.values()) dispatchTaskToSlot(slot);',
    '}'
  ].join('\n');
  const quietDispatchLatest = [
    'async function dispatchGpuTask() {',
    '  if (!state.latestTask || !state.computePlan || state.computePlan.gpuShare <= 0) return;',
    '  if (state.gpuTaskInFlight) return;',
    '  const engine = window.STAYGpuEngine;',
    '  if (!engine) return;',
    '  const generation = state.workerGeneration;',
    '  const epoch = Number(state.latestTask.epoch) || -1;',
    '  const shardId = 31;',
    '  const workHash = cognitiveHash32(`${state.nodeId}:shard:${shardId}`);',
    '  state.gpuTaskInFlight = true;',
    '  try {',
    '    const task = state.latestTask;',
    '    const result = await engine.runTask(task, { share: state.computePlan.gpuShare, shardId, workHash });',
    '    if (generation !== state.workerGeneration) return;',
    '    state.lastWorkerResultAt = performance.now();',
    '    await submitWorkResult(result, generation, shardId);',
    '  } catch (error) {',
    '    console.warn(`[STAY GPU] ${error?.message || error}`);',
    '    if (state.computePlan.engineResolved === \'gpu\' && window.__stayGpuStatus?.ready === false) {',
    '      startWorkerPool(\'gpu-unavailable\');',
    '    }',
    '  } finally {',
    '    state.gpuTaskInFlight = false;',
    '    if (generation === state.workerGeneration && state.latestTask && Number(state.latestTask.epoch) !== epoch && state.computePlan?.gpuShare > 0) {',
    '      queueMicrotask(() => dispatchGpuTask());',
    '    }',
    '  }',
    '}',
    '',
    'function dispatchLatestTask() {',
    '  if (!state.latestTask) return;',
    '  clearScheduledDispatches();',
    '  const slots = Array.from(state.workers.values()).sort((a, b) => a.shardId - b.shardId);',
    '  for (let index = 0; index < slots.length; index++) {',
    '    scheduleTaskForSlot(slots[index], index, slots.length);',
    '  }',
    '  if (state.computePlan.gpuShare > 0) dispatchGpuTask();',
    '}'
  ].join('\n');
  if (!output.includes(oldDispatchLatest)) {
    throw new Error('legacy client dispatch-latest marker not found');
  }
  output = output.replace(oldDispatchLatest, quietDispatchLatest);

  const restartSlotMarker = '  makeWorkerSlot(shardId, state.workerGeneration);';
  if (!output.includes(restartSlotMarker)) {
    throw new Error('legacy client restart-slot marker not found');
  }
  output = output.replace(
    restartSlotMarker,
    [
      '  const replacement = makeWorkerSlot(shardId, state.workerGeneration);',
      '  if (state.latestTask) scheduleTaskForSlot(replacement, 0, 1);'
    ].join('\n')
  );

  const schedulerMarker = '          budgetMsPerWorker: plan.budgetMsPerWorker';
  if (!output.includes(schedulerMarker)) {
    throw new Error('legacy client scheduler-report marker not found');
  }
  output = output.replace(
    schedulerMarker,
    [
      '          budgetMsPerWorker: plan.budgetMsPerWorker,',
      '          sliceMs: plan.sliceMs,',
      '          dispatchWindowMs: plan.dispatchWindowMs,',
      '          mode: result.engine || plan.mode,\n          engine: result.engine || plan.engineResolved,\n          cpuShare: plan.cpuShare,\n          gpuShare: plan.gpuShare'
    ].join('\n')
  );

  output = output.replace(
    "Math.round((msg.cognitiveBudget?.targetDeviceShare ?? state.computePlan.targetShare) * 100)",
    "Math.round(state.computePlan.targetShare * 100)"
  );


  const workerControlMarker = [
    "} else if (msg.type === 'worker-control' && msg.action === 'restart') {",
    '      if (msg.task) {',
    '        state.latestTask = msg.task;',
    '        state.lastComputeAt = performance.now();',
    '      }',
    "      restartWorkerPool(`server:${msg.reason || 'recovery'}`);",
    '    }'
  ].join('\n');

  const gpuAwareWorkerControl = [
    "} else if (msg.type === 'worker-control' && msg.action === 'restart') {",
    '      if (msg.task) {',
    '        state.latestTask = msg.task;',
    '        state.lastComputeAt = performance.now();',
    '      }',
    "      if (state.computePlan?.engineResolved === 'gpu-waiting') {",
    "        if (window.STAYGpuEngine) window.STAYGpuEngine.init().catch(() => {});",
    '        return;',
    '      }',
    "      restartWorkerPool(`server:${msg.reason || 'recovery'}`);",
    '    }'
  ].join('\n');

  if (!output.includes(workerControlMarker)) {
    throw new Error('legacy client worker-control marker not found');
  }
  output = output.replace(workerControlMarker, gpuAwareWorkerControl);

  output += [
    '',
    "window.addEventListener('stay-compute-share-change', () => {",
    "  startWorkerPool('user-compute-share-change');",
    '});',
    "window.addEventListener('stay-compute-engine-change', () => {",
    "  startWorkerPool('user-engine-change');",
    '});',
    "window.addEventListener('stay-hybrid-split-change', () => {",
    "  startWorkerPool('user-hybrid-split-change');",
    '});',
    "window.addEventListener('stay-gpu-status', (event) => {",
    "  const ready = Boolean(event.detail?.ready);",
    "  if (ready && !state.gpuWasReady) {",
    "    state.gpuWasReady = true;",
    "    startWorkerPool('gpu-became-ready');",
    "  } else if (!ready) {",
    "    state.gpuWasReady = false;",
    "  }",
    '});',
    "if (window.STAYGpuEngine) {",
    "  window.STAYGpuEngine.init().catch(() => {});",
    '}',
    ''
  ].join('\n');

  return output;
}

function transformLegacyWorker(source) {
  const messageMarker = 'self.onmessage = (event) => {';
  const budgetMarker = 'const budgetMs = Math.max(5, Math.min(900, Number(task.budgetMs) || 100));';
  const deadlineMarker = [
    '    const workStarted = performance.now();',
    '    const deadline = workStarted + budgetMs;'
  ].join('\n');

  if (!source.includes(messageMarker) || !source.includes(budgetMarker) || !source.includes(deadlineMarker)) {
    throw new Error('legacy worker quiet-scheduler markers not found');
  }

  let output = source.replace(messageMarker, 'self.onmessage = async (event) => {');
  output = output.replace(
    budgetMarker,
    [
      'const budgetMs = Math.max(1, Math.min(800, Number(task.budgetMs) || 100));',
      '    const sliceMs = Math.max(4, Math.min(10, Number(task.sliceMs) || 4));'
    ].join('\n')
  );
  output = output.replace(
    deadlineMarker,
    [
      '    const workStarted = performance.now();',
      '    let activeWorkMs = 0;'
    ].join('\n')
  );

  const oldLoop = [
    '    while (performance.now() < deadline) {',
    '      for (let batch = 0; batch < 32; batch++) {',
    '        const result = C.evaluateCandidate(genome, task.seed, workHash, candidates, scenarios);',
    '        const score = result.score;',
    '        scoreSum += score;',
    '        scoreSquareSum += score * score;',
    '        if (score > bestScore) {',
    '          bestScore = score;',
    '          bestIndex = candidates;',
    '          bestOutputs = result.outputs;',
    '        }',
    '        candidates++;',
    '      }',
    '    }'
  ].join('\n');

  const quietLoop = [
    '    while (activeWorkMs < budgetMs) {',
    '      const sliceStarted = performance.now();',
    '      const activeTarget = Math.min(sliceMs, budgetMs - activeWorkMs);',
    '      const sliceDeadline = sliceStarted + activeTarget;',
    '      while (performance.now() < sliceDeadline) {',
      '        for (let batch = 0; batch < 4; batch++) {',
    '          const result = C.evaluateCandidate(genome, task.seed, workHash, candidates, scenarios);',
    '          const score = result.score;',
    '          scoreSum += score;',
    '          scoreSquareSum += score * score;',
    '          if (score > bestScore) {',
    '            bestScore = score;',
    '            bestIndex = candidates;',
    '            bestOutputs = result.outputs;',
    '          }',
    '          candidates++;',
    '        }',
    '      }',
    '      const sliceElapsedMs = Math.max(0, performance.now() - sliceStarted);',
    '      activeWorkMs += sliceElapsedMs;',
    "      self.postMessage({ type: 'stay-worker-telemetry', activeMs: sliceElapsedMs });",
      '      if (activeWorkMs < budgetMs) await new Promise((resolve) => setTimeout(resolve, 2));',
    '    }'
  ].join('\n');

  if (!output.includes(oldLoop)) {
    throw new Error('legacy worker compute-loop marker not found');
  }

  return output.replace(oldLoop, quietLoop);
}

function proxyToLegacy(req, res) {
  if (!legacyProxyPort) {
    res.statusCode = 404;
    res.end('not found\n');
    return;
  }

  const headers = {
    ...req.headers,
    host: '127.0.0.1:' + legacyProxyPort,
    'accept-encoding': 'identity'
  };

  const upstream = http.request({
    host: '127.0.0.1',
    port: legacyProxyPort,
    method: req.method,
    path: req.url,
    headers
  }, (upstreamRes) => {
    const contentType = String(upstreamRes.headers['content-type'] || '');
    const pathname = String(req.url || '').split('?')[0];
    const transformHtml = req.method === 'GET' && /text\/html/i.test(contentType);
    const transformClient = req.method === 'GET' && pathname === '/client.js';
    const transformWorker = req.method === 'GET' && pathname === '/worker.js';
    const shouldTransform = transformHtml || transformClient || transformWorker;

    if (!shouldTransform) {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
      return;
    }

    const chunks = [];
    let transformedBytes = 0;
    let transformFailed = false;
    const maximumTransformedBytes = 5 * 1024 * 1024;
    upstreamRes.on('data', chunk => {
      transformedBytes += chunk.length;
      if (transformedBytes > maximumTransformedBytes) {
        transformFailed = true;
        upstreamRes.destroy(Object.assign(new Error('legacy transform response exceeded 5 MiB'), { code: 'LEGACY_TRANSFORM_LIMIT' }));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    upstreamRes.on('error', error => {
      transformFailed = true;
      if (res.headersSent) return res.destroy(error);
      res.statusCode = error.code === 'LEGACY_TRANSFORM_LIMIT' ? 502 : 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('STAY legacy response transformation failed\n');
    });
    upstreamRes.on('end', () => {
      if (transformFailed) return;
      const original = Buffer.concat(chunks).toString('utf8');
      const body = transformHtml
        ? transformLegacyHtml(original)
        : transformClient
          ? transformLegacyClient(original)
          : transformLegacyWorker(original);
      const responseHeaders = { ...upstreamRes.headers };
      delete responseHeaders['content-length'];
      delete responseHeaders['transfer-encoding'];
      delete responseHeaders.etag;
      responseHeaders['cache-control'] = 'no-store';
      responseHeaders['content-length'] = Buffer.byteLength(body);
      res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
      res.end(body);
    });
  });

  upstream.on('error', (error) => {
    if (res.headersSent) return res.destroy(error);
    res.statusCode = 502;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('STAY fetus is not reachable through the Living Kernel\n');
  });

  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

async function main() {
  const localDefaultData = path.resolve(dataDir) === path.resolve(path.join(process.cwd(), '.stay-data'));
  const kernel = new LivingKernel({
    dataDir,
    allowIdentityBootstrap: process.env.STAY_ALLOW_IDENTITY_BOOTSTRAP === '1' || localDefaultData
  });
  await kernel.start();

  if (
    process.env.STAY_ALLOW_METAB_NEUTRAL_RECOVERY === '1' &&
    !kernel.stateStore.getResident('resident:metab')
  ) {
    await kernel.recoverMetabNeutralBirth();
  }

  if (process.env.STAY_BOOT_CORE) {
    await kernel.installCore(process.env.STAY_BOOT_CORE);
  }

  if (
    process.env.STAY_ALLOW_METAB_SHADOW_PROMOTION === '1' &&
    kernel.stateStore.getResident('resident:metab')?.version ===
      '0.1.0-p1r0-neutral.1'
  ) {
    await kernel.promoteMetabShadow();
  }

  const badgeSource = await fs.readFile(badgePath, 'utf8');
  const gpuEngineSource = await fs.readFile(gpuEnginePath, 'utf8');
  const computeGovernorSource = await fs.readFile(computeGovernorPath, 'utf8');

  const upgradedSockets = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = String(req.url || '').split('?')[0];

      if (pathname === '/__stay/live-badge.js') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/javascript; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(badgeSource);
        return;
      }

      if (pathname === '/__stay/gpu-engine.js') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/javascript; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(gpuEngineSource);
        return;
      }

      if (pathname === '/__stay/compute-governor.js') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/javascript; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(computeGovernorSource);
        return;
      }

      if (pathname === '/__stay/meta') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(publicMetadata(await kernel.status())));
        return;
      }

      if (pathname === '/healthz') {
        const status = await kernel.status();
        const ok = status.health ? status.health.ok : true;
        res.statusCode = ok ? 200 : 503;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          ok,
          version: STAY_VERSION,
          kernel: status.kernel.version,
          revision: status.kernel.runtimeRevision
        }));
        return;
      }

      if (pathname === '/runtime/status') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(await kernel.status(), null, 2));
        return;
      }

      proxyToLegacy(req, res);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
  });

  server.on('upgrade', (req, socket, head) => {
    if (!legacyProxyPort) return socket.destroy();
    const upstream = http.request({
      host: '127.0.0.1',
      port: legacyProxyPort,
      method: req.method || 'GET',
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${legacyProxyPort}` }
    });
    upstream.once('upgrade', (response, upstreamSocket, upstreamHead) => {
      upgradedSockets.add(socket);
      upgradedSockets.add(upstreamSocket);
      const status = `HTTP/1.1 ${response.statusCode || 101} ${response.statusMessage || 'Switching Protocols'}\r\n`;
      const headers = [];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        headers.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`);
      }
      socket.write(status + headers.join('') + '\r\n');
      if (head?.length) upstreamSocket.write(head);
      if (upstreamHead?.length) socket.write(upstreamHead);
      socket.pipe(upstreamSocket).pipe(socket);
      const closeBoth = () => {
        upgradedSockets.delete(socket);
        upgradedSockets.delete(upstreamSocket);
        socket.destroy();
        upstreamSocket.destroy();
      };
      socket.on('error', closeBoth);
      upstreamSocket.on('error', closeBoth);
    });
    upstream.once('response', response => { response.resume(); socket.destroy(); });
    upstream.once('error', () => socket.destroy());
    upstream.end();
  });

  server.listen(port, host, () => {
    console.log('[STAY] Living Kernel ' + STAY_VERSION + ' listening on ' + host + ':' + port);
  });

  let shutdownPromise = null;
  const shutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      console.log('[STAY] ' + signal + ': persisting active state');
      for (const socket of upgradedSockets) socket.destroy();
      upgradedSockets.clear();
      await new Promise((resolve, reject) => {
        // Stop accepting first, then terminate active proxied HTTP requests.
        // Upgraded sockets are tracked and closed separately above.
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      await kernel.stop();
    })();
    return shutdownPromise;
  };

  const requestShutdown = signal => {
    shutdown(signal).then(
      () => process.exit(0),
      error => {
        console.error('[STAY] shutdown failed', error);
        process.exit(1);
      }
    );
  };
  process.once('SIGTERM', () => requestShutdown('SIGTERM'));
  process.once('SIGINT', () => requestShutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[STAY] fatal kernel error', error);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  publicMetadata,
  injectRuntimeScripts,
  transformLegacyHtml,
  transformLegacyClient,
  transformLegacyWorker
};
