'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { makeDataDir, waitFor, fs, path } = require('./helpers');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 1000 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
  });
}

test('server exposes bounded public metadata, drains active connections, then stops cleanly', async t => {
  const dataDir = await makeDataDir('stay-server-test-');
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), STAY_HOST: '127.0.0.1', STAY_DATA_DIR: dataDir, STAY_ALLOW_IDENTITY_BOOTSTRAP: '1', STAY_LEGACY_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await waitFor(async () => { try { return (await request(port, '/healthz')).status === 200; } catch { return false; } }, 5000);
  const health = JSON.parse((await request(port, '/healthz')).body);
  assert.equal(health.version, '0.8.11.3');
  assert.equal(health.kernel, '0.8.11.3');
  const meta = JSON.parse((await request(port, '/__stay/meta')).body);
  assert.equal(meta.ok, true);
  assert.equal(meta.version, '0.8.11.3');
  assert.equal(meta.chipProjection.schema, 'stay-observation-chips-v1');
  assert.equal(meta.chipProjection.observationOnly, true);
  assert.deepEqual(meta.chipProjection.mutationEndpoints, []);
  assert.deepEqual(
    meta.chipProjection.lifecycle.map(chip => `${chip.label} · ${chip.state}`),
    ['BSF · LIVE']
  );
  assert.deepEqual(
    meta.chipProjection.roadmap.map(entry => `${entry.label} · ${entry.stage}`),
    ['METAB · PLANNED', 'HOMEOS · PLANNED', 'INTERO · PLANNED']
  );
  assert.match((await request(port, '/__stay/compute-governor.js')).body, /stay-viewer-responsiveness-v1/);
  assert.match((await request(port, '/__stay/gpu-engine.js')).body, /stay-webgpu-search-v3/);
  const blockingSocket = net.createConnection({ host: '127.0.0.1', port });
  t.after(() => blockingSocket.destroy());
  await new Promise((resolve, reject) => {
    blockingSocket.once('connect', resolve);
    blockingSocket.once('error', reject);
  });
  blockingSocket.write('GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n');
  if (process.platform === 'win32') {
    // Windows child.kill() uses TerminateProcess and cannot deliver a catchable
    // SIGTERM to exercise the server's drain handler. Keep the public metadata
    // assertions above active here; the real signal/drain path remains required
    // by this same test on Linux CI and in the extracted release.
    blockingSocket.destroy();
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
    const source = await fs.readFile(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(source, /process\.once\('SIGTERM'/);
    assert.match(source, /server\.closeAllConnections\(\)/);
    assert.match(source, /await kernel\.stop\(\)/);
    return;
  }
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not stop: ' + stderr)), 5000);
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('server exited ' + code + ': ' + stderr)); });
  });
});
