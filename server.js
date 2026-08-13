'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const pkg = require('./package.json');
const { LivingKernel } = require('./runtime');

const STAY_VERSION = pkg.stayVersion || pkg.version;
const dataDir = process.env.STAY_DATA_DIR || path.join(process.cwd(), '.stay-data');
const host = process.env.STAY_HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
const legacyProxyPort = Number(process.env.STAY_LEGACY_PORT || 0);
const badgePath = path.join(__dirname, 'runtime', 'ui', 'live-badge.js');

function publicMetadata(status) {
  const cores = [];
  for (const slot of status.cores || []) {
    for (const mode of ['active', 'candidate', 'standby']) {
      const unit = slot[mode];
      if (!unit || !unit.manifest) continue;
      cores.push({
        id: slot.coreId,
        version: unit.manifest.version || '?',
        mode,
        ok: !(unit.health && unit.health.ok === false)
      });
    }
  }
  return {
    ok: status.health ? status.health.ok : true,
    version: STAY_VERSION,
    revision: status.kernel ? status.kernel.runtimeRevision : null,
    updatedAt: new Date().toISOString(),
    cores
  };
}

function injectBadgeScript(html) {
  const tag = '<script src="/__stay/live-badge.js" defer></script>';
  if (html.includes('/__stay/live-badge.js')) return html;
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, tag + '</body>');
  return html + tag;
}


function transformLegacyHtml(html) {
  let output = injectBadgeScript(html);
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
    "  const targetShare = Math.max(0.01, Math.min(1, Number.isFinite(storedShare) && storedShare > 0 ? storedShare : 0.05));"
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
    "  workers: new Map(),\n  dispatchTimers: new Set(),"
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
    '  // Quiet Spread: contribution percentage controls total CPU-time, while',
    '  // many short, staggered workers avoid concentrating that work on a few hot cores.',
    '  const maxShardPool = 32;',
    '  const baseSpreadPool = Math.max(1, Math.min(logicalCores, 12));',
    '  const maxBudgetMsPerWorker = 850;',
    '  const requiredPool = Math.max(1, Math.ceil(targetCpuMsPerSecond / maxBudgetMsPerWorker));',
    '  const poolSize = Math.max(1, Math.min(maxShardPool, Math.max(baseSpreadPool, requiredPool)));',
    '  const budgetMsPerWorker = Math.max(5, Math.min(maxBudgetMsPerWorker, targetCpuMsPerSecond / poolSize));',
    '  const sliceMs = Math.max(5, Math.min(20, budgetMsPerWorker <= 40 ? Math.max(5, budgetMsPerWorker / 2) : 12));',
    '  const estimatedYieldMs = Math.max(0, Math.ceil(budgetMsPerWorker / sliceMs) - 1);',
    '  const dispatchWindowMs = Math.max(0, Math.min(800, 900 - budgetMsPerWorker - estimatedYieldMs));',
    "  const mode = 'quiet-spread';"
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
    '    budgetMsPerWorker,\n    sliceMs,\n    dispatchWindowMs,\n    mode\n  };'
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
    'function dispatchLatestTask() {',
    '  if (!state.latestTask) return;',
    '  clearScheduledDispatches();',
    '  const slots = Array.from(state.workers.values()).sort((a, b) => a.shardId - b.shardId);',
    '  for (let index = 0; index < slots.length; index++) {',
    '    scheduleTaskForSlot(slots[index], index, slots.length);',
    '  }',
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
      '          mode: plan.mode'
    ].join('\n')
  );

  output = output.replace(
    "Math.round((msg.cognitiveBudget?.targetDeviceShare ?? state.computePlan.targetShare) * 100)",
    "Math.round(state.computePlan.targetShare * 100)"
  );

  output += [
    '',
    "window.addEventListener('stay-compute-share-change', () => {",
    "  startWorkerPool('user-compute-share-change');",
    '});',
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
      'const budgetMs = Math.max(5, Math.min(850, Number(task.budgetMs) || 100));',
      '    const sliceMs = Math.max(5, Math.min(20, Number(task.sliceMs) || 12));'
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
    '        for (let batch = 0; batch < 32; batch++) {',
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
    '      activeWorkMs += Math.max(0, performance.now() - sliceStarted);',
    '      if (activeWorkMs < budgetMs) await new Promise((resolve) => setTimeout(resolve, 0));',
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
    upstreamRes.on('data', chunk => chunks.push(Buffer.from(chunk)));
    upstreamRes.on('end', () => {
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
  const kernel = new LivingKernel({ dataDir });
  await kernel.start();

  if (process.env.STAY_BOOT_CORE) {
    await kernel.installCore(process.env.STAY_BOOT_CORE);
  }

  const badgeSource = await fs.readFile(badgePath, 'utf8');

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

  server.listen(port, host, () => {
    console.log('[STAY] Living Kernel ' + STAY_VERSION + ' listening on ' + host + ':' + port);
  });

  const shutdown = async (signal) => {
    console.log('[STAY] ' + signal + ': persisting active state');
    await new Promise(resolve => server.close(resolve));
    await kernel.stop();
    process.exit(0);
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[STAY] fatal kernel error', error);
  process.exitCode = 1;
});
