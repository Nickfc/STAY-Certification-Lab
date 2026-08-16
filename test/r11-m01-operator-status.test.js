'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { makeDataDir, waitFor, fs, path } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'r11-m01-operator-capability-0123456789abcdef0123456789abcdef';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 1500
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

async function startServer(t, extraEnv = {}) {
  const dataDir = await makeDataDir('stay-r11-m01-data-');
  const port = await freePort();
  const child = spawn(process.execPath, ['server-secure.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      STAY_HOST: '127.0.0.1',
      STAY_DATA_DIR: dataDir,
      STAY_ALLOW_IDENTITY_BOOTSTRAP: '1',
      STAY_LEGACY_PORT: '0',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await waitFor(async () => {
    try { return (await request(port, '/healthz')).status === 200; } catch { return false; }
  }, 5000);
  return { child, port, stderr: () => stderr };
}

test('R11-M01-01 privileged runtime status requires a header capability while public health remains open', async t => {
  const credentialDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r11-m01-token-'));
  const tokenFile = path.join(credentialDir, 'operator-status.token');
  await fs.writeFile(tokenFile, TOKEN + '\n', { mode: 0o600 });
  t.after(() => fs.rm(credentialDir, { recursive: true, force: true }));

  const { port } = await startServer(t, { STAY_OPERATOR_STATUS_TOKEN_FILE: tokenFile });

  assert.equal((await request(port, '/healthz')).status, 200);
  assert.equal((await request(port, '/__stay/meta')).status, 200);

  const missing = await request(port, '/runtime/status');
  assert.equal(missing.status, 401);
  assert.match(String(missing.headers['www-authenticate']), /^Bearer /);
  assert.doesNotMatch(missing.body, new RegExp(TOKEN));

  const wrong = await request(port, '/runtime/status', {
    headers: { authorization: 'Bearer definitely-not-the-operator-token' }
  });
  assert.equal(wrong.status, 401);

  const queryLeakAttempt = await request(port, '/runtime/status?token=' + encodeURIComponent(TOKEN));
  assert.equal(queryLeakAttempt.status, 401, 'query-string credentials must never authenticate');

  const allowed = await request(port, '/runtime/status', {
    headers: { authorization: 'Bearer ' + TOKEN }
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['cache-control'], 'no-store');
  assert.equal(allowed.headers.pragma, 'no-cache');
  const status = JSON.parse(allowed.body);
  assert.ok(status.kernel);
  assert.doesNotMatch(allowed.body, new RegExp(TOKEN));

  const wrongMethod = await request(port, '/runtime/status', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN }
  });
  assert.equal(wrongMethod.status, 405);
});

test('R11-M01-02 absent operator credential fails closed without taking public health down', async t => {
  const { port } = await startServer(t, { STAY_OPERATOR_STATUS_TOKEN_FILE: '' });
  const status = await request(port, '/runtime/status');
  assert.equal(status.status, 503);
  assert.match(status.body, /operator credential unavailable/i);
  assert.equal((await request(port, '/healthz')).status, 200);
});

test('R11-M01-03 production execution paths use secure entrypoint and systemd credential rather than a token environment value', async () => {
  const unit = await fs.readFile(path.join(ROOT, 'deploy/systemd/stay.service'), 'utf8');
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const guard = await fs.readFile(path.join(ROOT, 'runtime/operator-status-guard.js'), 'utf8');

  assert.match(unit, /ExecStart=.*server-secure\.js/);
  assert.match(unit, /LoadCredential=operator-status-token:\/etc\/stay\/operator-status\.token/);
  assert.match(unit, /STAY_OPERATOR_STATUS_TOKEN_FILE=\/run\/credentials\/stay\.service\/operator-status-token/);
  assert.doesNotMatch(unit, /STAY_OPERATOR_STATUS_TOKEN=/);
  assert.equal(pkg.main, 'server.js', 'library entrypoint must remain side-effect free');
  assert.equal(pkg.scripts.start, 'node server-secure.js');
  assert.match(guard, /timingSafeEqual/);
  assert.match(guard, /sha256/);
  assert.doesNotMatch(guard, /console\.log|console\.error/);
});
