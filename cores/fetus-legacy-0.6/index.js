'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const HIBERNATION_SHA256 = 'b45d6addd70b13bfa684f53c075edb3ca6a76bae7d7384849f84a1df2d7d073d';
const SOURCE_FILES = Object.freeze({
  'server.js': '8ff32ab431f494ff1eb9cab05a9e9a64dd77ab9ce43e7059893266ab4f56fc01',
  'world-core.js': '3557d2d7505442caae958312ebf2f096157a74cb7509026a87ced919e7c4cff1',
  'package.json': '2c67a3f1c2dfedb37dc06829ed98e014bbf75f863469ed576298832b7afdd1d2',
  'public/client.js': 'e336bc76421921b53cb5baf430af8ddcc5702f5874644352512852724dafcea8',
  'public/cognitive-core.js': 'efd17d7f4ef5408e92d96725b9d1726b3615370f74b543374f3124b9d5b28324',
  'public/index.html': 'fa4b33a2a4bbbef9d2a6e90761095bf3c160c69b0534c30cdd6ef2c00d041318',
  'public/style.css': '42063ec91705009dbccf332572f87b06d62ae0b2654af8aa9536f00ec1cfccb6',
  'public/worker.js': '36b1108aa76894b1b727c6b5f837ead8a954f3cd8af6c6cfa1c67d3629a1f251'
});

const manifest = Object.freeze({
  coreId: 'fetus-legacy',
  version: '0.6.0',
  protocol: 'genesis-core-v1',
  stateSchema: 1,
  hotSwap: false,
  inputs: [],
  outputs: []
});

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function exists(filePath) {
  try { await fsp.access(filePath); return true; }
  catch { return false; }
}

async function atomicWrite(filePath, data, mode) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  await fsp.writeFile(tmp, data, mode ? { mode } : undefined);
  await fsp.rename(tmp, filePath);
}

async function verifyStableSource(sourceDir) {
  const verified = {};
  for (const [relative, expected] of Object.entries(SOURCE_FILES)) {
    const filePath = path.join(sourceDir, relative);
    const bytes = await fsp.readFile(filePath);
    const actual = sha256(bytes);
    if (actual !== expected) throw new Error('stable 0.6 source mismatch: ' + relative);
    verified[relative] = actual;
  }
  return verified;
}

async function loadOrCreateOperatorToken(dataDir) {
  const filePath = path.join(dataDir, 'operator-token.txt');
  try {
    const existing = (await fsp.readFile(filePath, 'utf8')).trim();
    if (existing) return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = crypto.randomBytes(18).toString('base64url');
  await atomicWrite(filePath, token + '\n', 0o600);
  return token;
}

async function verifyInitialHibernationState(statePath, dataDir) {
  const markerPath = path.join(dataDir, 'hibernation-import.json');
  if (await exists(markerPath)) return JSON.parse(await fsp.readFile(markerPath, 'utf8'));
  if (!(await exists(statePath))) {
    if (process.env.STAY_REQUIRE_HIBERNATION_STATE === '1') throw new Error('required 0.6 hibernation state is missing at ' + statePath);
    return null;
  }

  const bytes = await fsp.readFile(statePath);
  const digest = sha256(bytes);
  const expected = String(process.env.STAY_EXPECTED_HIBERNATION_SHA256 || HIBERNATION_SHA256).trim();
  if (expected && digest !== expected) throw new Error('0.6 hibernation state hash mismatch; refusing to awaken a different state');

  const marker = { sourceVersion: '0.6.0', sourceStateSha256: digest, verifiedAt: new Date().toISOString() };
  await atomicWrite(markerPath, JSON.stringify(marker, null, 2) + '\n');
  return marker;
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForHttp(port, child, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('0.6 fetus exited before becoming reachable');
    try {
      await new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
          res.resume();
          if ((res.statusCode || 500) < 500) resolve();
          else reject(new Error('legacy HTTP status ' + res.statusCode));
        });
        req.on('timeout', () => req.destroy(new Error('legacy HTTP timeout')));
        req.on('error', reject);
      });
      return;
    } catch (error) {
      lastError = error;
      await wait(120);
    }
  }
  throw new Error('0.6 fetus did not become reachable: ' + (lastError ? lastError.message : 'timeout'));
}

function attachRedactedLogs(stream, logger, method) {
  if (!stream) return;
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (let line of lines) {
      if (/^Operator token:/i.test(line.trim())) line = 'Operator token: [redacted]';
      if (line.trim()) (logger[method] || logger.log).call(logger, '[0.6] ' + line);
    }
  });
}

async function createCore({ initialState = {}, logger = console }) {
  const rootDataDir = path.resolve(process.env.STAY_DATA_DIR || path.join(process.cwd(), '.stay-data'));
  const dataDir = path.join(rootDataDir, 'legacy-0.6.0');
  const statePath = path.join(dataDir, 'genesis-state.json');
  const sourceDir = path.resolve(process.env.STAY_LEGACY_SOURCE_DIR || '/opt/stay/legacy/0.6.0');
  const port = Number(process.env.STAY_LEGACY_PORT || 8788);
  let child = null;
  let ready = false;
  let startedAt = null;
  let importMarker = null;
  let sourceVerified = null;

  return {
    async start() {
      if (child) throw new Error('0.6 fetus is already running');
      await fsp.mkdir(dataDir, { recursive: true });
      sourceVerified = await verifyStableSource(sourceDir);
      importMarker = await verifyInitialHibernationState(statePath, dataDir);
      const operatorToken = await loadOrCreateOperatorToken(dataDir);

      child = spawn(process.execPath, ['server.js'], {
        cwd: sourceDir,
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), GENESIS_STATE_PATH: statePath, GENESIS_OPERATOR_TOKEN: operatorToken },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      attachRedactedLogs(child.stdout, logger, 'log');
      attachRedactedLogs(child.stderr, logger, 'warn');
      child.once('exit', (code, signal) => {
        ready = false;
        if (code !== 0 && signal !== 'SIGTERM') logger.error('[0.6] fetus process exited code=' + code + ' signal=' + signal);
      });
      await waitForHttp(port, child);
      ready = true;
      startedAt = new Date().toISOString();
      logger.log('[0.6] verified stable fetus awake behind Living Kernel on internal port ' + port);
    },

    async handle() {},

    async snapshot() {
      return {
        legacyVersion: '0.6.0',
        sourceVerified: Boolean(sourceVerified),
        hibernationSourceSha256: importMarker ? importMarker.sourceStateSha256 : null,
        statePath,
        sourceDir,
        internalPort: port,
        startedAt,
        previousAdapterState: initialState || {}
      };
    },

    async health() {
      return {
        ok: Boolean(child && child.exitCode === null && ready),
        legacyVersion: '0.6.0',
        pid: child && child.exitCode === null ? child.pid : null,
        internalPort: port,
        sourceVerified: Boolean(sourceVerified),
        hibernationVerified: Boolean(importMarker)
      };
    },

    async stop() {
      if (!child || child.exitCode !== null) { ready = false; return; }
      const exiting = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exiting, wait(3500)]);
      if (child.exitCode === null) { child.kill('SIGKILL'); await exiting; }
      ready = false;
      child = null;
    }
  };
}

module.exports = { manifest, createCore, SOURCE_FILES, HIBERNATION_SHA256 };
