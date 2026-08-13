'use strict';

const path = require('node:path');
const http = require('node:http');
const { LivingKernel } = require('./runtime');

const dataDir = process.env.STAY_DATA_DIR || path.join(process.cwd(), '.stay-data');
const host = process.env.STAY_HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
const legacyProxyPort = Number(process.env.STAY_LEGACY_PORT || 0);

function proxyToLegacy(req, res) {
  if (!legacyProxyPort) {
    res.statusCode = 404;
    res.end('not found\n');
    return;
  }

  const headers = { ...req.headers, host: '127.0.0.1:' + legacyProxyPort };
  const upstream = http.request({
    host: '127.0.0.1',
    port: legacyProxyPort,
    method: req.method,
    path: req.url,
    headers
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
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

  if (process.env.STAY_BOOT_CORE) await kernel.installCore(process.env.STAY_BOOT_CORE);

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/healthz') {
        const status = await kernel.status();
        const unhealthyCore = status.cores.find((slot) => slot.active && slot.active.health && slot.active.health.ok === false);
        res.statusCode = unhealthyCore ? 503 : 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: !unhealthyCore, kernel: '0.7.0', pid: process.pid, organismId: kernel.identity.organismId }));
        return;
      }
      if (req.url === '/runtime/status') {
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

  server.listen(port, host, () => console.log('[STAY] Living Kernel 0.7.0 listening on ' + host + ':' + port));

  const shutdown = async (signal) => {
    console.log('[STAY] ' + signal + ': persisting active state');
    await new Promise((resolve) => server.close(resolve));
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
