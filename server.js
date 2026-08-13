'use strict';

const path = require('node:path');
const http = require('node:http');
const { LivingKernel } = require('./runtime');

const dataDir = process.env.STAY_DATA_DIR || path.join(process.cwd(), '.stay-data');
const port = Number(process.env.PORT || 8787);

async function main() {
  const kernel = new LivingKernel({ dataDir });
  await kernel.start();

  if (process.env.STAY_BOOT_CORE) await kernel.installCore(process.env.STAY_BOOT_CORE);

  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, kernel: '0.7.0', pid: process.pid }));
      return;
    }
    if (req.url === '/runtime/status') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(await kernel.status(), null, 2));
      return;
    }
    res.statusCode = 404;
    res.end('not found\n');
  });

  server.listen(port, () => console.log('[STAY] Living Kernel 0.7.0 listening on :' + port));

  const shutdown = async (signal) => {
    console.log('[STAY] ' + signal + ': persisting active state');
    server.close();
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
