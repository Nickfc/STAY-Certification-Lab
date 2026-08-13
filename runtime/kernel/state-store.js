'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

async function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fs.writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, filePath);
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; }
  catch { return false; }
}

async function sha256File(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

async function collectFiles(rootDir) {
  const result = [];
  if (!(await exists(rootDir))) return result;
  for (const entry of await fs.readdir(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) result.push(...await collectFiles(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

class StateStore {
  constructor(rootDir) {
    if (!rootDir) throw new Error('StateStore requires a rootDir');
    this.rootDir = rootDir;
    this.lastSuccessfulWriteAt = null;
    this.lastWriteError = null;
  }

  async init() {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.rootDir, 'life'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.rootDir, 'cores'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.rootDir, 'journal'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.rootDir, 'snapshots'), { recursive: true, mode: 0o700 });
  }

  lifePath(name) { return path.join(this.rootDir, 'life', name + '.json'); }
  corePath(coreId, channel = 'active') { return path.join(this.rootDir, 'cores', coreId, channel + '.json'); }

  markWriteSuccess() {
    this.lastSuccessfulWriteAt = new Date().toISOString();
    this.lastWriteError = null;
  }

  markWriteFailure(error) {
    this.lastWriteError = { at: new Date().toISOString(), code: error.code || null, message: error.message };
  }

  async checkedAtomicWrite(filePath, data) {
    try {
      await atomicWrite(filePath, data);
      this.markWriteSuccess();
    } catch (error) {
      this.markWriteFailure(error);
      throw error;
    }
  }

  async readJson(filePath, fallback = null) {
    try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }

  async readLife(name, fallback = null) { return this.readJson(this.lifePath(name), fallback); }
  async writeLife(name, value) { await this.checkedAtomicWrite(this.lifePath(name), JSON.stringify(value, null, 2) + '\n'); }
  async readCore(coreId, channel = 'active', fallback = null) { return this.readJson(this.corePath(coreId, channel), fallback); }

  async writeCore(coreId, envelope, channel = 'active') {
    const value = { coreId, writtenAt: new Date().toISOString(), ...envelope };
    await this.checkedAtomicWrite(this.corePath(coreId, channel), JSON.stringify(value, null, 2) + '\n');
  }

  async appendJournal(record) {
    const file = path.join(this.rootDir, 'journal', new Date().toISOString().slice(0, 10) + '.jsonl');
    try {
      await fs.appendFile(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
      this.markWriteSuccess();
    } catch (error) {
      this.markWriteFailure(error);
      throw error;
    }
  }

  async heartbeat(payload = {}) {
    const value = { at: new Date().toISOString(), ...payload };
    await this.writeLife('runtime-heartbeat', value);
    return value;
  }

  async persistenceStatus(maxHeartbeatAgeMs = 120000) {
    const heartbeat = await this.readLife('runtime-heartbeat', null);
    const heartbeatAt = heartbeat && heartbeat.at ? heartbeat.at : null;
    const heartbeatAgeMs = heartbeatAt ? Math.max(0, Date.now() - Date.parse(heartbeatAt)) : null;
    const healthy = Boolean(heartbeatAt) && heartbeatAgeMs <= maxHeartbeatAgeMs && !this.lastWriteError;
    return {
      ok: healthy,
      heartbeatAt,
      heartbeatAgeMs,
      lastSuccessfulWriteAt: this.lastSuccessfulWriteAt,
      lastWriteError: this.lastWriteError
    };
  }

  async createSnapshot({ reason = 'periodic', retention = 24 } = {}) {
    const snapshotsRoot = path.join(this.rootDir, 'snapshots');
    await fs.mkdir(snapshotsRoot, { recursive: true, mode: 0o700 });
    const createdAt = new Date().toISOString();
    const safeReason = String(reason).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 48) || 'snapshot';
    const name = createdAt.replace(/[:.]/g, '-') + '-' + safeReason;
    const finalDir = path.join(snapshotsRoot, name);
    const tempDir = finalDir + '.tmp-' + process.pid;
    await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });

    const selected = [];
    for (const relative of ['life/identity.json', 'life/runtime-heartbeat.json', 'legacy-0.6.0/genesis-state.json']) {
      const source = path.join(this.rootDir, relative);
      if (await exists(source)) selected.push(source);
    }
    selected.push(...await collectFiles(path.join(this.rootDir, 'cores')));

    const manifest = { format: 'stay-runtime-snapshot-v1', createdAt, reason, files: {} };
    for (const source of selected) {
      const relative = path.relative(this.rootDir, source);
      const target = path.join(tempDir, relative);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.copyFile(source, target);
      manifest.files[relative] = await sha256File(target);
    }
    await atomicWrite(path.join(tempDir, 'SNAPSHOT_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
    await fs.rename(tempDir, finalDir);
    this.markWriteSuccess();
    await this.pruneSnapshots(retention);
    return { name, path: finalDir, createdAt, reason, fileCount: Object.keys(manifest.files).length };
  }

  async pruneSnapshots(retention = 24) {
    const snapshotsRoot = path.join(this.rootDir, 'snapshots');
    const entries = (await fs.readdir(snapshotsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.includes('.tmp-'))
      .map((entry) => entry.name)
      .sort();
    const remove = entries.slice(0, Math.max(0, entries.length - Math.max(1, retention)));
    for (const name of remove) await fs.rm(path.join(snapshotsRoot, name), { recursive: true, force: true });
  }

  async snapshotStatus() {
    const snapshotsRoot = path.join(this.rootDir, 'snapshots');
    const entries = (await fs.readdir(snapshotsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.includes('.tmp-'))
      .map((entry) => entry.name)
      .sort();
    return { count: entries.length, latest: entries.length ? entries.at(-1) : null };
  }
}

module.exports = { StateStore, atomicWrite, sha256File };
