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

  const oldPool = [
    '  let poolSize = Math.max(1, Math.min(logicalCores, 8));',
    '  while (targetCpuMsPerSecond / poolSize > 850 && poolSize < Math.min(logicalCores, 16)) poolSize++;',
    '  const budgetMsPerWorker = Math.max(20, Math.min(850, targetCpuMsPerSecond / poolSize));'
  ].join('\n');

  const newPool = [
    '  const maxPoolSize = Math.max(1, Math.min(logicalCores, 32));',
    '  const poolSize = Math.max(1, Math.min(maxPoolSize, Math.ceil(targetCpuMsPerSecond / 1000)));',
    '  const budgetMsPerWorker = Math.max(5, Math.min(1000, targetCpuMsPerSecond / poolSize));'
  ].join('\n');

  if (!output.includes(oldPool)) {
    throw new Error('legacy client worker-pool marker not found');
  }
  output = output.replace(oldPool, newPool);

  output = output.replace(
    '  state.computePlan = createComputePlan();',
    '  state.computePlan = createComputePlan();\n  window.__stayComputePlan = { ...state.computePlan };'
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
  const marker = 'Math.min(900, Number(task.budgetMs) || 100)';
  if (!source.includes(marker)) {
    throw new Error('legacy worker budget marker not found');
  }
  return source.replace(marker, 'Math.min(1000, Number(task.budgetMs) || 100)');
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
