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
  const memoryPlan = policy.memoryPlan || {
    cgroupSoftBytes: policy.softRamBytes,
    cgroupHardBytes: policy.hardRamBytes
  };
  return Object.freeze({
    'memory.high': String(memoryPlan.cgroupSoftBytes),
    'memory.max': String(memoryPlan.cgroupHardBytes),
    'pids.max': String(policy.pidsMax || 32),
    'cpu.max': `${quota} ${period}`
  });
}

function resolveDelegatedLayout({ root, relative, subgroup = process.env.STAY_CGROUP_DELEGATE_SUBGROUP || '' }) {
  // Cgroup paths are Linux paths even when this pure layout function is
  // exercised by a cross-platform release validator.
  const cgroupPath = path.posix;
  const resolvedRoot = cgroupPath.resolve(root);
  const processGroup = cgroupPath.resolve(resolvedRoot, '.' + relative);
  if (processGroup !== resolvedRoot && !processGroup.startsWith(resolvedRoot + cgroupPath.sep)) {
    throw new Error('current cgroup resolves outside cgroup root');
  }

  if (subgroup) {
    if (safeName(subgroup) !== subgroup || subgroup.includes('/') || subgroup === '.' || subgroup === '..') {
      throw Object.assign(new Error('delegated cgroup subgroup is invalid'), { code: 'CGROUP_DELEGATE_SUBGROUP' });
    }
    if (cgroupPath.basename(processGroup) !== subgroup) {
      throw Object.assign(new Error('process is outside the configured delegated subgroup'), {
        code: 'CGROUP_DELEGATE_SUBGROUP'
      });
    }
    const current = cgroupPath.dirname(processGroup);
    if (current !== resolvedRoot && !current.startsWith(resolvedRoot + cgroupPath.sep)) {
      throw new Error('delegated cgroup parent resolves outside cgroup root');
    }
    return Object.freeze({
      current,
      kernel: processGroup,
      cores: cgroupPath.join(current, 'stay-cores'),
      moveKernelProcess: false
    });
  }

  return Object.freeze({
    current: processGroup,
    kernel: cgroupPath.join(processGroup, 'stay-kernel'),
    cores: cgroupPath.join(processGroup, 'stay-cores'),
    moveKernelProcess: true
  });
}

async function prepareDelegatedHierarchy({ current, kernel, cores, pid, moveKernelProcess = true, io = fs }) {
  // A controller governs the immediate children of the cgroup where it is
  // enabled. DelegateSubgroup= places the Kernel in stay-kernel before
  // ExecStart, so the service cgroup is empty from the first instruction and
  // the no-internal-process rule is never crossed. The legacy move remains for
  // isolated hosts that do not opt into the systemd subgroup contract.
  await io.mkdir(kernel, { recursive: true });
  if (moveKernelProcess) await io.writeFile(path.posix.join(kernel, 'cgroup.procs'), String(pid));
  await io.writeFile(path.posix.join(current, 'cgroup.subtree_control'), REQUIRED_CONTROLLERS);
  await io.mkdir(cores, { recursive: true });
  await io.writeFile(path.posix.join(cores, 'cgroup.subtree_control'), REQUIRED_CONTROLLERS);
}

async function prepareDelegatedRoot() {
  if (delegatedRootPromise) return delegatedRootPromise;
  delegatedRootPromise = (async () => {
    const relative = await readUnifiedCgroup();
    if (!relative) throw Object.assign(new Error('cgroup v2 is unavailable'), { code: 'CGROUP_UNAVAILABLE' });
    const layout = resolveDelegatedLayout({
      root: process.env.STAY_CGROUP_ROOT || '/sys/fs/cgroup',
      relative,
      subgroup: process.env.STAY_CGROUP_DELEGATE_SUBGROUP || ''
    });
    await prepareDelegatedHierarchy({ ...layout, pid: process.pid });
    return layout.cores;
  })();
  try { return await delegatedRootPromise; }
  catch (error) { delegatedRootPromise = null; throw error; }
}

async function processDescendants(rootPid, io = fs) {
  const root = Number(rootPid);
  if (!Number.isSafeInteger(root) || root <= 0) return [];
  const discovered = new Set([root]);
  const pending = [root];
  while (pending.length > 0) {
    const pid = pending.shift();
    let text;
    try {
      text = await io.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      throw error;
    }
    for (const value of String(text).trim().split(/\s+/)) {
      const child = Number(value);
      if (!Number.isSafeInteger(child) || child <= 0 || discovered.has(child)) continue;
      discovered.add(child);
      pending.push(child);
    }
  }
  return [...discovered];
}

async function quiesceCgroup(
  directory,
  {
    io = fs,
    timeoutMs = 2000,
    pollIntervalMs = 10
  } = {}
) {
  if (!directory) return [];

  const processFile =
    path.posix.join(directory, 'cgroup.procs');

  const readProcesses = async () => {
    try {
      return String(
        await io.readFile(
          processFile,
          'utf8'
        )
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
        .filter(
          value =>
            Number.isSafeInteger(value) &&
            value > 0
        );
    } catch (error) {
      if (
        error.code === 'ENOENT' ||
        error.code === 'ESRCH'
      ) {
        return [];
      }

      throw error;
    }
  };

  const initial =
    await readProcesses();

  if (initial.length === 0) {
    return initial;
  }

  await io.writeFile(
    path.posix.join(directory, 'cgroup.kill'),
    '1'
  );

  const deadline =
    Date.now() +
    Math.max(
      1,
      Number(timeoutMs) ||
        2000
    );

  for (;;) {
    const remaining =
      await readProcesses();

    if (remaining.length === 0) {
      return initial;
    }

    if (Date.now() >= deadline) {
      throw Object.assign(
        new Error(
          `payload cgroup did not quiesce; remaining pids: ${remaining.join(',')}`
        ),
        {
          code:
            'CGROUP_PAYLOAD_NOT_QUIESCENT',
          remainingPids:
            remaining
        }
      );
    }

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          Math.max(
            1,
            Number(pollIntervalMs) ||
              10
          )
        )
    );
  }
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
    this.payloadPids = [];
    this.lastQuiescence = null;
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
      if (!(await this.configure())) return false;
      await fs.writeFile(path.posix.join(this.directory, 'cgroup.procs'), String(pid));
      this.payloadPids = [pid];
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

  async configure() {
    try {
      if (!this.coresRoot && !(await this.prepare())) return false;
      const directory = path.posix.join(this.coresRoot, this.name);
      await fs.mkdir(directory, { recursive: true });
      const limits = cgroupLimitValues(this.policy);
      await Promise.all(
        Object.entries(limits).map(([name, value]) =>
          fs.writeFile(path.posix.join(directory, name), value)
        )
      );
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

  async attachPayloadTree(rootPid, additionalPids = []) {
    try {
      if (!(await this.configure())) return false;
      const roots = [rootPid, ...additionalPids]
        .map(Number)
        .filter(value => Number.isSafeInteger(value) && value > 0);
      const pids = new Set();
      for (const root of roots) {
        for (const pid of await processDescendants(root)) pids.add(pid);
      }
      if (pids.size === 0) throw new Error('Core payload process tree is empty');
      for (const pid of [...pids].sort((left, right) => left - right)) {
        await fs.writeFile(path.posix.join(this.directory, 'cgroup.procs'), String(pid));
      }
      this.payloadPids = [...pids].sort((left, right) => left - right);
      this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = { code: error.code || null, message: error.message };
      if (this.required) {
        throw Object.assign(new Error(`required OS payload cgroup attachment failed: ${error.message}`), {
          code: 'CGROUP_REQUIRED', cause: error
        });
      }
      return false;
    }
  }

  async quiesce() {
    try {
      if (!this.directory) return [];
      const killed =
        await quiesceCgroup(
          this.directory
        );
      this.payloadPids = [];
      this.lastQuiescence = {
        at:
          new Date().toISOString(),
        killedPids:
          [...killed]
      };
      this.lastError = null;
      return killed;
    } catch (error) {
      this.lastError = {
        code:
          error.code ||
          null,
        message:
          error.message
      };

      if (this.required) {
        throw Object.assign(
          new Error(
            `required OS payload cgroup quiescence failed: ${error.message}`
          ),
          {
            code:
              'CGROUP_REQUIRED',
            cause:
              error
          }
        );
      }

      return [];
    }
  }

  async stop() {
    if (!this.directory) return;
    await this.quiesce();
    try {
      await fs.rmdir(this.directory);
    } catch (error) {
      if (error.code !== 'ENOENT' && this.required) {
        throw Object.assign(
          new Error(
            `required OS payload cgroup removal failed: ${error.message}`
          ),
          {
            code:
              'CGROUP_REQUIRED',
            cause:
              error
          }
        );
      }
    }
    this.directory = null;
    this.payloadPids = [];
  }

  status() {
    return {
      required: this.required,
      available: this.available,
      directory: this.directory,
      limits: cgroupLimitValues(this.policy),
      memoryPlan: this.policy.memoryPlan || null,
      supervisorChargedToKernel: true,
      payloadPids: this.payloadPids || [],
      payloadQuiescedBeforeSpawn:
        Boolean(this.lastQuiescence),
      lastQuiescence:
        this.lastQuiescence,
      lastError: this.lastError
    };
  }
}

module.exports = {
  CgroupGovernor,
  readUnifiedCgroup,
  safeName,
  cgroupLimitValues,
  resolveDelegatedLayout,
  prepareDelegatedHierarchy,
  prepareDelegatedRoot,
  processDescendants,
  quiesceCgroup
};
