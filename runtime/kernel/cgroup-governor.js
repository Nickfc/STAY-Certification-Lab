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

const REQUIRED_CONTROLLERS = '+cpu +memory +pids';

function cgroupLimitValues(policy) {
  const period = 100000;
  const quota = Math.max(1000, Math.floor(policy.hardCpuDuty * period));
  return Object.freeze({
    'memory.high': String(policy.softRamBytes),
    'memory.max': String(policy.hardRamBytes),
    'pids.max': String(policy.pidsMax || 32),
    'cpu.max': `${quota} ${period}`
  });
}

async function prepareDelegatedHierarchy({ current, kernel, cores, pid, io = fs }) {
  // A controller governs the immediate children of the cgroup where it is
  // enabled. Keep the service cgroup empty, then enable controllers at both
  // distribution levels so each per-Core cgroup receives its limit files.
  await io.mkdir(kernel, { recursive: true });
  await io.writeFile(path.join(kernel, 'cgroup.procs'), String(pid));
  await io.writeFile(path.join(current, 'cgroup.subtree_control'), REQUIRED_CONTROLLERS);
  await io.mkdir(cores, { recursive: true });
  await io.writeFile(path.join(cores, 'cgroup.subtree_control'), REQUIRED_CONTROLLERS);
}

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
    await prepareDelegatedHierarchy({ current, kernel, cores, pid: process.pid });
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
      const limits = cgroupLimitValues(this.policy);
      await Promise.all(Object.entries(limits).map(([name, value]) => fs.writeFile(path.join(directory, name), value)));
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

module.exports = { CgroupGovernor, readUnifiedCgroup, safeName, cgroupLimitValues, prepareDelegatedHierarchy, prepareDelegatedRoot };
