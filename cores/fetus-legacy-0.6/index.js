'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SOURCE_SHA256 = '46947ac01d7fa7679f32850dd9c022ab8f129b74baaad89e8974f06ccad51848';
const HIBERNATION_SHA256 = 'b45d6addd70b13bfa684f53c075edb3ca6a76bae7d7384849f84a1df2d7d073d';

const manifest = {
  coreId: 'fetus-legacy',
  version: '0.6.0',
  protocol: 'genesis-core-v1',
  stateSchema: 1,
  hotSwap: false,
  inputs: [],
  outputs: []
};

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
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

async function materializeSource(workDir) {
  const payloadPath = path.join(__dirname, '..', '..', 'legacy', '0.6.0', 'source.tar.gz.b64');
  const encoded = (await fsp.readFile(payloadPath, 'utf8')).replace(/\s+/g, '');
  const archive = Buffer.from(encoded, 'base64');
  const digest = sha256(archive);
  if (digest !== SOURCE_SHA256) throw new Error('stable 0.6 source payload hash mismatch');

  await fsp.rm(workDir, { recursive: true, force: true });
  await fsp.mkdir(workDir, { recursive: true });
  const archivePath = path.join(workDir, 'source.tar.gz');
  await fsp.writeFile(archivePath, archive);
  await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', archivePath, '-C', workDir], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    tar.stderr.setEncoding('utf8');
    tar.stderr.on('data', (chunk) => { stderr += chunk; });
    tar.once('error', reject);
    tar.once('exit', (code) => code === 0 ? resolve() : reject(new Error('could not extract stable 0.6 source: ' + stderr.trim())));
  });
  await fsp.rm(archivePath, { force: true });
  return digest;
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

  const marker = {
    sourceVersion: '0.6.0',
    sourceStateSha256: digest,
    verifiedAt: new Date().toISOString()
  };
  await atomicWrite(markerPath, JSON.stringify(marker, null, 2) + '\n');
  return marker;
}

async function createCore({ initialState = {}, logger = console }) {
  const rootDataDir = path.resolve(process.env.STAY_DATA_DIR || path.join(process.cwd(), '.stay-data'));
  const dataDir = path.join(rootDataDir, 'legacy-0.6.0');
  const statePath = path.join(dataDir, 'genesis-state.json');
  const port = Number(process.env.STAY_LEGACY_PORT || 8788);
  const workDir = path.resolve(process.env.STAY_LEGACY_WORK_DIR || path.join(os.tmpdir(), 'stay-legacy-0.6.0-' + process.pid));
  let child = null;
  let ready = false;
  let startedAt = null;
  let importMarker = null;

  return {
    async start() {
      if (child) throw new Error('0.6 fetus is already running');
      await fsp.mkdir(dataDir, { recursive: true });
      importMarker = await verifyInitialHibernationState(statePath, dataDir);
      await materializeSource(workDir);
      const operatorToken = await loadOrCreateOperatorToken(dataDir);

      child = spawn(process.execPath, ['server.js'], {
        cwd: workDir,
        env: {
          ...process.env,
          HOST: '127.0.0.1',
          PORT: String(port),
          GENESIS_STATE_PATH: statePath,
          GENESIS_OPERATOR_TOKEN: operatorToken
        },
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
      logger.log('[0.6] stable fetus awake behind Living Kernel on internal port ' + port);
    },

    async handle() {},

    async snapshot() {
      return {
        legacyVersion: '0.6.0',
        sourceArchiveSha256: SOURCE_SHA256,
        hibernationSourceSha256: importMarker ? importMarker.sourceStateSha256 : null,
        statePath,
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
        hibernationVerified: Boolean(importMarker)
      };
    },

    async stop() {
      if (!child || child.exitCode !== null) {
        ready = false;
        await fsp.rm(workDir, { recursive: true, force: true });
        return;
      }
      const exiting = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exiting, wait(3500)]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await exiting;
      }
      ready = false;
      child = null;
      await fsp.rm(workDir, { recursive: true, force: true });
    }
  };
}

module.exports = { manifest, createCore, SOURCE_SHA256, HIBERNATION_SHA256 };
