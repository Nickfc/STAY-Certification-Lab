'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fs.writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, filePath);
}

class StateStore {
  constructor(rootDir) {
    if (!rootDir) throw new Error('StateStore requires a rootDir');
    this.rootDir = rootDir;
  }

  async init() {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.rootDir, 'life'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.rootDir, 'cores'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.rootDir, 'journal'), { recursive: true, mode: 0o700 });
  }

  lifePath(name) { return path.join(this.rootDir, 'life', name + '.json'); }
  corePath(coreId, channel = 'active') { return path.join(this.rootDir, 'cores', coreId, channel + '.json'); }

  async readJson(filePath, fallback = null) {
    try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }

  async readLife(name, fallback = null) { return this.readJson(this.lifePath(name), fallback); }
  async writeLife(name, value) { await atomicWrite(this.lifePath(name), JSON.stringify(value, null, 2) + '\n'); }
  async readCore(coreId, channel = 'active', fallback = null) { return this.readJson(this.corePath(coreId, channel), fallback); }

  async writeCore(coreId, envelope, channel = 'active') {
    const value = { coreId, writtenAt: new Date().toISOString(), ...envelope };
    await atomicWrite(this.corePath(coreId, channel), JSON.stringify(value, null, 2) + '\n');
  }

  async appendJournal(record) {
    const file = path.join(this.rootDir, 'journal', new Date().toISOString().slice(0, 10) + '.jsonl');
    await fs.appendFile(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
  }
}

module.exports = { StateStore, atomicWrite };
