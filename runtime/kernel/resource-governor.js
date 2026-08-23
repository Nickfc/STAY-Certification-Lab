'use strict';

const fs = require('node:fs/promises');

const MIB = 1024 * 1024;

async function readProcessSample(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const [status, stat] = await Promise.all([
        fs.readFile(`/proc/${pid}/status`, 'utf8'),
        fs.readFile(`/proc/${pid}/stat`, 'utf8')
      ]);
      const kb = name => Number(status.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm'))?.[1] || 0);
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      return {
        at: Date.now(),
        rssBytes: kb('VmRSS') * 1024,
        peakRssBytes: kb('VmHWM') * 1024,
        swapBytes: kb('VmSwap') * 1024,
        cpuTicks: Number(fields[11] || 0) + Number(fields[12] || 0)
      };
    }
    process.kill(pid, 0);
    return { at: Date.now(), rssBytes: null, peakRssBytes: null, swapBytes: null, cpuTicks: null };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

function normalizePolicy(resources = {}, priority = 'normal') {
  const critical = priority === 'critical';
  const optional = priority === 'optional';
  const hardRamCeilingMiB = critical ? 768 : optional ? 256 : 384;
  const requestedHardRamMiB = Number(resources.hardRamMiB) || hardRamCeilingMiB;
  const hardRamMiB = Math.max(64, Math.min(hardRamCeilingMiB, requestedHardRamMiB));
  const requestedSoftRamMiB = Number(resources.softRamMiB) || (critical ? 512 : optional ? 160 : 256);
  const softRamMiB = Math.max(32, Math.min(hardRamMiB - 16, requestedSoftRamMiB));
  const requestedHardCpuDuty = (Number(resources.hardCpuPercent) || (critical ? 100 : optional ? 75 : 90)) / 100;
  const hardCpuDuty = Math.min(1, Math.max(0.02, requestedHardCpuDuty));
  const requestedSoftCpuDuty = (Number(resources.softCpuPercent) || (critical ? 80 : optional ? 35 : 50)) / 100;
  const softCpuDuty = Math.min(hardCpuDuty - 0.01, Math.max(0.01, requestedSoftCpuDuty));
  return {
    priority,
    softRamBytes: softRamMiB * MIB,
    hardRamBytes: hardRamMiB * MIB,
    softCpuDuty,
    hardCpuDuty,
    sampleIntervalMs: Math.max(250, Number(resources.sampleIntervalMs) || 2000),
    hardConfirmations: Math.max(1, Number(resources.hardConfirmations) || 2),
    trendSamples: Math.max(4, Number(resources.trendSamples) || 30),
    storageBytes: Math.max(MIB, Math.min(1024, Number(resources.storageMiB) || 256) * MIB),
    queueCapacity: Math.max(8, Math.min(2048, Number(resources.queueCapacity) || (critical ? 512 : 256))),
    handlerTimeoutMs: Math.max(50, Math.min(30000, Number(resources.handlerTimeoutMs) || (critical ? 3000 : 5000))),
    healthTimeoutMs: Math.max(50, Math.min(10000, Number(resources.healthTimeoutMs) || 1000)),
    outputCapacity: Math.max(8, Math.min(4096, Number(resources.outputCapacity) || (critical ? 1024 : 256))),
    outputLimitPerEvent: Math.max(1, Math.min(256, Number(resources.outputLimitPerEvent) || 64)),
    outputBytesPerEvent: Math.max(1024, Math.min(16 * MIB, Number(resources.outputBytesPerEvent) || MIB)),
    pidsMax: Math.max(1, Math.min(256, Number(resources.pidsMax) || (critical ? 64 : 32))),
    maxRestarts: Math.max(1, Number(resources.maxRestarts) || (critical ? 8 : 5)),
    restartWindowMs: Math.max(1000, Number(resources.restartWindowMs) || 60000),
    restartBackoffMs: Math.max(10, Number(resources.restartBackoffMs) || 250)
  };
}

class ResourceGovernor {
  constructor({ name, getPid, policy, onSoftLimit = () => {}, onHardLimit = () => {}, logger = console }) {
    this.name = name;
    this.getPid = getPid;
    this.policy = normalizePolicy(policy?.resources || policy, policy?.priority || 'normal');
    this.onSoftLimit = onSoftLimit;
    this.onHardLimit = onHardLimit;
    this.logger = logger;
    this.timer = null;
    this.samples = [];
    this.highSamples = 0;
    this.highCpuSamples = 0;
    this.actionInFlight = false;
    this.lastAction = null;
    this.lastError = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample().catch(error => { this.lastError = error.message; }), this.policy.sampleIntervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async sample() {
    const sample = await readProcessSample(this.getPid());
    if (!sample) return null;
    this.samples.push(sample);
    if (this.samples.length > this.policy.trendSamples) this.samples.shift();
    const previous = this.samples.length > 1 ? this.samples.at(-2) : null;
    sample.cpuDuty = previous && sample.cpuTicks != null && previous.cpuTicks != null
      ? Math.max(0, ((sample.cpuTicks - previous.cpuTicks) * 10) / Math.max(1, sample.at - previous.at))
      : null;
    if (sample.rssBytes != null && sample.rssBytes >= this.policy.hardRamBytes) this.highSamples += 1;
    else this.highSamples = 0;

    if (sample.cpuDuty != null && sample.cpuDuty >= this.policy.hardCpuDuty) this.highCpuSamples += 1;
    else this.highCpuSamples = 0;

    if ((sample.rssBytes != null && sample.rssBytes >= this.policy.softRamBytes)
      || (sample.cpuDuty != null && sample.cpuDuty >= this.policy.softCpuDuty)) {
      await Promise.resolve(this.onSoftLimit({ type: 'soft-resource-limit', sample, policy: this.policy, trend: this.trend() })).catch(() => {});
    }
    if ((this.highSamples >= this.policy.hardConfirmations || this.highCpuSamples >= this.policy.hardConfirmations) && !this.actionInFlight) {
      this.actionInFlight = true;
      const type = this.highSamples >= this.policy.hardConfirmations ? 'hard-memory-limit' : 'hard-cpu-limit';
      this.lastAction = { type, at: new Date().toISOString(), rssBytes: sample.rssBytes, cpuDuty: sample.cpuDuty };
      try { await this.onHardLimit({ type, sample, policy: this.policy, trend: this.trend() }); }
      finally { this.actionInFlight = false; this.highSamples = 0; this.highCpuSamples = 0; }
    }
    return sample;
  }

  trend() {
    if (this.samples.length < 2) return { rssBytesPerMinute: null, samples: this.samples.length };
    const first = this.samples[0];
    const last = this.samples.at(-1);
    const minutes = Math.max((last.at - first.at) / 60000, 1 / 60000);
    return {
      rssBytesPerMinute: first.rssBytes == null || last.rssBytes == null ? null : (last.rssBytes - first.rssBytes) / minutes,
      samples: this.samples.length
    };
  }

  status() {
    const sample = this.samples.at(-1) || null;
    return {
      policy: this.policy,
      latest: sample,
      trend: this.trend(),
      lastAction: this.lastAction,
      lastError: this.lastError
    };
  }
}

module.exports = { ResourceGovernor, normalizePolicy, readProcessSample, MIB };
