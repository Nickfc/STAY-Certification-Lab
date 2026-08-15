'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function safeName(value) {
  return String(value || 'core').replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120);
}

async function readUnifiedCgroup() {
  if (process.platform !== 'linux') return null;
  const text = await fs.readFile('/proc/self/cgroup', 'utf8');
  const row = text.split(/\r?\n/).find(line => line.startsWith('0::'));
  return row ? row.slice(3).trim() || '/' : null;
}

let delegatedRootPromise = null;

async function prepareDelegatedRoot() {
  if (delegatedRootPromise) return delegatedRootPromise;
  delegatedRootPromise = (async () => {
    const relative = await readUnifiedCgroup();
    if (!relative) throw Object.assign(new Error('cgroup v2 is unavailable'), { code: 'CGROUP_UNAVAILABLE' });
    const root = path.resolve(process.env.STAY_CGROUP_ROOT || '/sys/fs/cgroup');
    const current = path.resolve(root, '.' + relative);
    if (current !== root && !current.startsWith(root + path.sep)) throw new Error('current cgroup resolves outside cgroup root');
    const kernel = path.join(current, 'stay-kernel');
    const cores = path.join(current, 'stay-cores');
    await fs.mkdir(kernel, { recursive: true });
    await fs.mkdir(cores, { recursive: true });
    await fs.writeFile(path.join(kernel, 'cgroup.procs'), String(process.pid));
    await fs.writeFile(path.join(current, 'cgroup.subtree_control'), '+cpu +memory +pids');
    return cores;
  })();
  try { return await delegatedRootPromise; }
  catch (error) { delegatedRootPromise = null; throw error; }
}

class CgroupGovernor {
  constructor({ name, policy, required = process.env.STAY_REQUIRE_CGROUPS === '1' }) {
    this.name = safeName(name);
    this.policy = policy;
    this.required = required;
    this.directory = null;
    this.available = false;
    this.lastError = null;
    this.coresRoot = null;
  }

  async prepare() {
    try {
      this.coresRoot = await prepareDelegatedRoot();
      return true;
    } catch (error) {
      this.lastError = { code: error.code || null, message: error.message };
      if (this.required) {
        throw Object.assign(new Error(`required OS cgroup containment failed: ${error.message}`), {
          code: 'CGROUP_REQUIRED', cause: error
        });
      }
      return false;
    }
  }

  async attach(pid) {
    try {
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid CoreHost pid');
      if (!this.coresRoot && !(await this.prepare())) return false;
      const directory = path.join(this.coresRoot, this.name);
      await fs.mkdir(directory, { recursive: true });
      const period = 100000;
      const quota = Math.max(1000, Math.floor(this.policy.hardCpuDuty * period));
      await Promise.all([
        fs.writeFile(path.join(directory, 'memory.high'), String(this.policy.softRamBytes)),
        fs.writeFile(path.join(directory, 'memory.max'), String(this.policy.hardRamBytes)),
        fs.writeFile(path.join(directory, 'pids.max'), String(this.policy.pidsMax || 32)),
        fs.writeFile(path.join(directory, 'cpu.max'), `${quota} ${period}`)
      ]);
      await fs.writeFile(path.join(directory, 'cgroup.procs'), String(pid));
      this.directory = directory;
      this.available = true;
      this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = { code: error.code || null, message: error.message };
      if (this.required) {
        throw Object.assign(new Error(`required OS cgroup containment failed: ${error.message}`), {
          code: 'CGROUP_REQUIRED', cause: error
        });
      }
      return false;
    }
  }

  async stop() {
    if (!this.directory) return;
    await fs.rmdir(this.directory).catch(() => {});
    this.directory = null;
  }

  status() {
    return { required: this.required, available: this.available, directory: this.directory, lastError: this.lastError };
  }
}

module.exports = { CgroupGovernor, readUnifiedCgroup, safeName, prepareDelegatedRoot };
