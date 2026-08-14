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

const MIB = 1024 * 1024;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isAlive(proc) {
  return Boolean(proc && proc.exitCode === null && proc.signalCode === null);
}

function finitePositive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function readProcMemory(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const text = await fsp.readFile(`/proc/${pid}/status`, 'utf8');
    const kb = (name) => {
      const match = text.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm'));
      return match ? Number(match[1]) : 0;
    };
    return {
      rssBytes: kb('VmRSS') * 1024,
      peakRssBytes: kb('VmHWM') * 1024,
      swapBytes: kb('VmSwap') * 1024
    };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

async function waitForHttp(port, child, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (!isAlive(child)) throw new Error('0.6 fetus exited before becoming reachable');
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
  const guardianPath = path.join(dataDir, 'memory-guardian.json');
  const guardianBackupDir = path.join(dataDir, 'guardian-backups');
  const sourceDir = path.resolve(process.env.STAY_LEGACY_SOURCE_DIR || '/opt/stay/legacy/0.6.0');
  const port = Number(process.env.STAY_LEGACY_PORT || 8788);

  const guardianIntervalMs = Math.max(5000, finitePositive(process.env.STAY_FETUS_GUARDIAN_INTERVAL_MS, 15000));
  const guardianHistoryMs = Math.max(30000, finitePositive(process.env.STAY_FETUS_GUARDIAN_HISTORY_MS, 60000));
  const warnRssBytes = Math.max(128 * MIB, finitePositive(process.env.STAY_FETUS_WARN_RSS_MIB, 512) * MIB);
  const recycleRssBytes = Math.max(warnRssBytes + 64 * MIB, finitePositive(process.env.STAY_FETUS_RECYCLE_RSS_MIB, 700) * MIB);
  const highRssConfirmations = Math.max(1, Math.floor(finitePositive(process.env.STAY_FETUS_RECYCLE_CONFIRMATIONS, 2)));
  const gracefulStopMs = Math.max(3000, finitePositive(process.env.STAY_FETUS_GRACEFUL_STOP_MS, 8000));
  const crashWindowMs = Math.max(60000, finitePositive(process.env.STAY_FETUS_CRASH_WINDOW_MS, 600000));
  const maxCrashRestarts = Math.max(2, Math.floor(finitePositive(process.env.STAY_FETUS_MAX_CRASH_RESTARTS, 5)));

  let child = null;
  let ready = false;
  let startedAt = null;
  let importMarker = null;
  let sourceVerified = null;
  let operatorToken = null;
  let guardianTimer = null;
  let restartTimer = null;
  let stopping = false;
  let recycleInFlight = false;
  let highRssSamples = 0;
  let memoryWarned = false;
  let lastMemory = null;
  let lastMemoryHistoryAt = 0;
  let memoryHistory = [];
  let guardianRecycleCount = 0;
  let crashRestartCount = 0;
  let crashHistory = [];
  let lastExit = null;
  let lastRecycle = null;
  let lastGuardianError = null;
  let restartSuppressedUntil = null;

  function toMiB(bytes) {
    return bytes == null ? null : Math.round((bytes / MIB) * 10) / 10;
  }

  function guardianSummary() {
    return {
      status: recycleInFlight ? 'recycling' : restartTimer ? 'recovering' : ready ? 'healthy' : 'offline',
      rssMiB: lastMemory ? toMiB(lastMemory.rssBytes) : null,
      peakRssMiB: lastMemory ? toMiB(lastMemory.peakRssBytes) : null,
      swapMiB: lastMemory ? toMiB(lastMemory.swapBytes) : null,
      warnAtMiB: toMiB(warnRssBytes),
      recycleAtMiB: toMiB(recycleRssBytes),
      guardianRecycles: guardianRecycleCount,
      crashRestarts: crashRestartCount,
      lastSampleAt: lastMemory ? lastMemory.at : null,
      lastRecycle,
      lastExit,
      lastError: lastGuardianError,
      restartSuppressedUntil,
      historySamples: memoryHistory.length
    };
  }

  async function persistGuardian() {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      ...guardianSummary(),
      history: memoryHistory.slice(-720)
    };
    await atomicWrite(guardianPath, JSON.stringify(payload, null, 2) + '\n', 0o600);
  }

  async function loadGuardian() {
    try {
      const parsed = JSON.parse(await fsp.readFile(guardianPath, 'utf8'));
      if (Array.isArray(parsed.history)) memoryHistory = parsed.history.slice(-720);
      guardianRecycleCount = Number(parsed.guardianRecycles) || 0;
      crashRestartCount = Number(parsed.crashRestarts) || 0;
      lastRecycle = parsed.lastRecycle || null;
      lastExit = parsed.lastExit || null;
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn('[0.6 guardian] previous telemetry could not be loaded: ' + error.message);
    }
  }

  async function backupState(reason) {
    if (!(await exists(statePath))) return null;
    await fsp.mkdir(guardianBackupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
    const target = path.join(guardianBackupDir, `${reason}-${stamp}.json`);
    await fsp.copyFile(statePath, target);
    await fsp.chmod(target, 0o600).catch(() => {});

    const files = (await fsp.readdir(guardianBackupDir))
      .filter((name) => name.endsWith('.json'))
      .sort();
    for (const oldName of files.slice(0, Math.max(0, files.length - 3))) {
      await fsp.rm(path.join(guardianBackupDir, oldName), { force: true });
    }
    return target;
  }

  async function stateMtimeMs() {
    try { return (await fsp.stat(statePath)).mtimeMs; }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  }

  function clearGuardianTimer() {
    if (guardianTimer) clearInterval(guardianTimer);
    guardianTimer = null;
  }

  async function waitForExit(proc, timeoutMs) {
    if (!isAlive(proc)) return true;
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.removeListener('exit', onExit);
        resolve(value);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      proc.once('exit', onExit);
    });
  }

  async function terminateCurrentChild(reason, { backup = false } = {}) {
    const proc = child;
    if (!isAlive(proc)) return { persisted: false, backupPath: null };

    clearGuardianTimer();
    ready = false;
    const beforeMtime = await stateMtimeMs();
    const backupPath = backup ? await backupState('pre-' + reason) : null;

    logger.warn(`[0.6 guardian] graceful stop requested: ${reason}`);
    proc.kill('SIGTERM');
    let exited = await waitForExit(proc, gracefulStopMs);
    if (!exited && isAlive(proc)) {
      logger.error(`[0.6 guardian] fetus did not stop within ${gracefulStopMs}ms; forcing SIGKILL`);
      proc.kill('SIGKILL');
      exited = await waitForExit(proc, 3000);
    }

    const afterMtime = await stateMtimeMs();
    const persisted = afterMtime > beforeMtime;
    if (persisted) logger.log('[0.6 guardian] active state persisted before restart');
    else logger.warn('[0.6 guardian] state mtime did not advance during graceful stop; restarting from last durable save');

    return { persisted, backupPath, exited };
  }

  function scheduleUnexpectedRestart(reason) {
    if (stopping || recycleInFlight || restartTimer) return;

    const now = Date.now();
    crashHistory = crashHistory.filter((at) => now - at < crashWindowMs);
    const recent = crashHistory.length;
    crashHistory.push(now);
    crashRestartCount += 1;

    let delayMs = Math.min(30000, 1000 * (2 ** Math.min(recent, 5)));
    if (recent >= maxCrashRestarts) {
      const oldest = crashHistory[0] || now;
      delayMs = Math.max(delayMs, crashWindowMs - (now - oldest) + 1000);
      restartSuppressedUntil = new Date(now + delayMs).toISOString();
      logger.error(`[0.6 guardian] restart storm protection engaged; next attempt in ${Math.round(delayMs / 1000)}s`);
    } else {
      restartSuppressedUntil = null;
      logger.warn(`[0.6 guardian] scheduling fetus restart in ${Math.round(delayMs / 1000)}s (${reason})`);
    }

    persistGuardian().catch((error) => logger.warn('[0.6 guardian] telemetry save failed: ' + error.message));

    restartTimer = setTimeout(async () => {
      restartTimer = null;
      restartSuppressedUntil = null;
      if (stopping || recycleInFlight) return;
      try {
        await spawnLegacy('auto-restart:' + reason);
      } catch (error) {
        lastGuardianError = { at: new Date().toISOString(), operation: 'auto-restart', message: error.message };
        logger.error('[0.6 guardian] automatic restart failed: ' + error.message);
        scheduleUnexpectedRestart('restart-failed');
      }
    }, delayMs);
    restartTimer.unref?.();
  }

  async function controlledRecycle(reason) {
    if (stopping || recycleInFlight || !isAlive(child)) return;
    recycleInFlight = true;
    highRssSamples = 0;
    const before = lastMemory;
    guardianRecycleCount += 1;
    logger.warn(`[0.6 guardian] memory pressure recycle ${guardianRecycleCount}: ${toMiB(before?.rssBytes)} MiB RSS`);

    try {
      const result = await terminateCurrentChild(reason, { backup: true });
      lastRecycle = {
        at: new Date().toISOString(),
        reason,
        rssMiB: toMiB(before?.rssBytes),
        peakRssMiB: toMiB(before?.peakRssBytes),
        statePersisted: result.persisted,
        backup: result.backupPath ? path.basename(result.backupPath) : null
      };
      await persistGuardian();
      if (!stopping) {
        await wait(500);
        await spawnLegacy('guardian-recycle');
      }
    } catch (error) {
      lastGuardianError = { at: new Date().toISOString(), operation: 'memory-recycle', message: error.message };
      logger.error('[0.6 guardian] controlled recycle failed: ' + error.message);
    } finally {
      recycleInFlight = false;
      await persistGuardian().catch(() => {});
      if (!stopping && !isAlive(child)) scheduleUnexpectedRestart('memory-recycle-failed');
    }
  }

  async function sampleMemory() {
    if (!isAlive(child) || recycleInFlight || stopping) return;
    try {
      const reading = await readProcMemory(child.pid);
      if (!reading) return;
      const now = Date.now();
      lastMemory = { ...reading, at: new Date(now).toISOString(), pid: child.pid };

      if (reading.rssBytes >= warnRssBytes && !memoryWarned) {
        memoryWarned = true;
        logger.warn(`[0.6 guardian] memory warning: ${toMiB(reading.rssBytes)} MiB RSS (recycle at ${toMiB(recycleRssBytes)} MiB)`);
      } else if (reading.rssBytes < warnRssBytes * 0.85) {
        memoryWarned = false;
      }

      if (reading.rssBytes >= recycleRssBytes) highRssSamples += 1;
      else highRssSamples = 0;

      if (now - lastMemoryHistoryAt >= guardianHistoryMs) {
        lastMemoryHistoryAt = now;
        memoryHistory.push({
          at: lastMemory.at,
          rssMiB: toMiB(reading.rssBytes),
          peakRssMiB: toMiB(reading.peakRssBytes),
          swapMiB: toMiB(reading.swapBytes)
        });
        memoryHistory = memoryHistory.slice(-720);
        await persistGuardian();
      }

      if (highRssSamples >= highRssConfirmations) {
        void controlledRecycle('memory-pressure');
      }
    } catch (error) {
      lastGuardianError = { at: new Date().toISOString(), operation: 'memory-sample', message: error.message };
      logger.warn('[0.6 guardian] memory sample failed: ' + error.message);
    }
  }

  function startGuardianTimer() {
    clearGuardianTimer();
    guardianTimer = setInterval(() => {
      sampleMemory().catch((error) => logger.warn('[0.6 guardian] sample loop failed: ' + error.message));
    }, guardianIntervalMs);
    guardianTimer.unref?.();
    void sampleMemory();
  }

  async function spawnLegacy(reason) {
    if (isAlive(child)) throw new Error('0.6 fetus is already running');
    if (!operatorToken) operatorToken = await loadOrCreateOperatorToken(dataDir);

    const proc = spawn(process.execPath, ['server.js'], {
      cwd: sourceDir,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        GENESIS_STATE_PATH: statePath,
        GENESIS_OPERATOR_TOKEN: operatorToken
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child = proc;
    attachRedactedLogs(proc.stdout, logger, 'log');
    attachRedactedLogs(proc.stderr, logger, 'warn');

    proc.once('exit', (code, signal) => {
      const wasCurrent = child === proc;
      if (wasCurrent) child = null;
      ready = false;
      clearGuardianTimer();
      lastExit = {
        at: new Date().toISOString(),
        code,
        signal,
        expected: stopping || recycleInFlight
      };
      persistGuardian().catch(() => {});

      if (stopping || recycleInFlight) return;
      logger.error('[0.6] fetus process exited code=' + code + ' signal=' + signal);
      scheduleUnexpectedRestart(signal === 'SIGABRT' ? 'crash-sigabrt' : 'unexpected-exit');
    });

    try {
      await waitForHttp(port, proc);
    } catch (error) {
      if (isAlive(proc)) proc.kill('SIGTERM');
      if (child === proc) child = null;
      throw error;
    }

    if (child !== proc || !isAlive(proc)) throw new Error('0.6 fetus disappeared during startup');
    ready = true;
    startedAt = new Date().toISOString();
    highRssSamples = 0;
    memoryWarned = false;
    lastGuardianError = null;
    restartSuppressedUntil = null;
    startGuardianTimer();
    logger.log(`[0.6] verified stable fetus awake behind Living Kernel on internal port ${port} (${reason})`);
    await persistGuardian().catch((error) => logger.warn('[0.6 guardian] telemetry save failed: ' + error.message));
  }

  return {
    async start() {
      if (isAlive(child)) throw new Error('0.6 fetus is already running');
      stopping = false;
      await fsp.mkdir(dataDir, { recursive: true });
      await loadGuardian();
      sourceVerified = await verifyStableSource(sourceDir);
      importMarker = await verifyInitialHibernationState(statePath, dataDir);
      operatorToken = await loadOrCreateOperatorToken(dataDir);
      await spawnLegacy('core-start');
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
        memoryGuardian: guardianSummary(),
        previousAdapterState: initialState || {}
      };
    },

    async health() {
      if (isAlive(child) && !recycleInFlight) {
        const reading = await readProcMemory(child.pid).catch(() => null);
        if (reading) lastMemory = { ...reading, at: new Date().toISOString(), pid: child.pid };
      }
      return {
        ok: Boolean(isAlive(child) && ready && !recycleInFlight),
        legacyVersion: '0.6.0',
        pid: isAlive(child) ? child.pid : null,
        internalPort: port,
        sourceVerified: Boolean(sourceVerified),
        hibernationVerified: Boolean(importMarker),
        memoryGuardian: guardianSummary()
      };
    },

    async stop() {
      stopping = true;
      clearGuardianTimer();
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      restartSuppressedUntil = null;
      if (isAlive(child)) await terminateCurrentChild('core-stop', { backup: false });
      child = null;
      ready = false;
      recycleInFlight = false;
      await persistGuardian().catch(() => {});
    }
  };
}

module.exports = {
  manifest,
  createCore,
  SOURCE_FILES,
  HIBERNATION_SHA256,
  readProcMemory
};
