'use strict';

const fs = require('node:fs/promises');

const MIB = 1024 * 1024;
const CORE_HOST_SUPERVISOR_RESERVE_MIB = 64;
const DEFAULT_HARD_CPU_WINDOW_SAMPLES = 4;

function coreHostMemoryPlan(policy) {
  const payloadSoftBytes = Number(policy.softRamBytes);
  const payloadHardBytes = Number(policy.hardRamBytes);
  const payloadHardMiB = Math.max(16, Math.floor(payloadHardBytes / MIB));
  const supervisorReserveBytes = CORE_HOST_SUPERVISOR_RESERVE_MIB * MIB;
  return Object.freeze({
    accounting: 'payload-cgroup-plus-kernel-supervisor',
    payloadSoftBytes,
    payloadHardBytes,
    supervisorReserveBytes,
    cgroupSoftBytes: payloadSoftBytes,
    cgroupHardBytes: payloadHardBytes,
    totalSoftEnvelopeBytes: payloadSoftBytes + supervisorReserveBytes,
    totalHardEnvelopeBytes: payloadHardBytes + supervisorReserveBytes,
    supervisorSoftBytes: 48 * MIB,
    supervisorHardBytes: supervisorReserveBytes,
    supervisorOldSpaceMiB: 16,
    supervisorSemiSpaceMiB: 2,
    workerOldSpaceMiB: Math.max(16, Math.min(64, Math.floor(payloadHardMiB * 2 / 3))),
    workerSemiSpaceMiB: 8
  });
}

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

function parseFlatKeyValues(text, numeric = true) {
  const value = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const [key, raw] = line.trim().split(/\s+/, 2);
    if (!key || raw == null) continue;
    value[key] = numeric && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return value;
}

async function readCgroupSample(directory) {
  if (!directory || process.platform !== 'linux') return null;
  try {
    const [memoryCurrent, memoryPeak, memoryEvents, pidsEvents, cpuStat, memoryPressure] = await Promise.all([
      fs.readFile(`${directory}/memory.current`, 'utf8'),
      fs.readFile(`${directory}/memory.peak`, 'utf8').catch(() => null),
      fs.readFile(`${directory}/memory.events`, 'utf8'),
      fs.readFile(`${directory}/pids.events`, 'utf8').catch(() => null),
      fs.readFile(`${directory}/cpu.stat`, 'utf8'),
      fs.readFile(`${directory}/memory.pressure`, 'utf8').catch(() => null)
    ]);
    const cpu = parseFlatKeyValues(cpuStat);
    return {
      at: Date.now(),
      source: 'cgroup-v2',
      directory,
      rssBytes: Number(memoryCurrent),
      peakRssBytes: memoryPeak == null ? null : Number(memoryPeak),
      swapBytes: null,
      cpuTicks: null,
      cpuMicros: Number(cpu.usage_usec || 0),
      cpuStat: cpu,
      memoryEvents: parseFlatKeyValues(memoryEvents),
      pidsEvents: pidsEvents == null ? null : parseFlatKeyValues(pidsEvents),
      memoryPressure: memoryPressure == null ? null : String(memoryPressure).trim()
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function normalizePolicy(resources = {}, priority = 'normal') {
  if (resources?._normalizedResourcePolicy === true) return resources;
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
  const normalized = {
    _normalizedResourcePolicy: true,
    priority,
    softRamBytes: softRamMiB * MIB,
    hardRamBytes: hardRamMiB * MIB,
    softCpuDuty,
    hardCpuDuty,
    sampleIntervalMs: Math.max(250, Number(resources.sampleIntervalMs) || 2000),
    hardConfirmations: Math.max(1, Number(resources.hardConfirmations) || 2),
    hardCpuWindowSamples: Math.max(
      3,
      Math.min(30, Number(resources.hardCpuWindowSamples) || DEFAULT_HARD_CPU_WINDOW_SAMPLES)
    ),
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
  return Object.freeze({
    ...normalized,
    memoryPlan: coreHostMemoryPlan(normalized)
  });
}

function resourceEventDeltas(current = {}, previous = {}) {
  const delta = (next, before) => Math.max(0, Number(next || 0) - Number(before || 0));
  return Object.freeze({
    memoryHigh: delta(current.memory?.high, previous.memory?.high),
    memoryMax: delta(current.memory?.max, previous.memory?.max),
    memoryOom: delta(current.memory?.oom, previous.memory?.oom),
    memoryOomKill: delta(current.memory?.oom_kill, previous.memory?.oom_kill),
    pidsMax: delta(current.pids?.max, previous.pids?.max),
    cpuPeriods: delta(current.cpu?.nr_periods, previous.cpu?.nr_periods),
    cpuThrottled: delta(current.cpu?.nr_throttled, previous.cpu?.nr_throttled),
    cpuThrottledMicros: delta(current.cpu?.throttled_usec, previous.cpu?.throttled_usec)
  });
}

function sustainedCpuEvidence(samples, windowSamples = DEFAULT_HARD_CPU_WINDOW_SAMPLES) {
  const required = Math.max(3, Math.min(30, Number(windowSamples) || DEFAULT_HARD_CPU_WINDOW_SAMPLES));
  const window = samples.slice(-required);
  const values = window.map(sample =>
    typeof sample?.cpuDuty === 'number' && Number.isFinite(sample.cpuDuty)
      ? sample.cpuDuty
      : Number.NaN
  );
  const ready = window.length === required && values.every(Number.isFinite);
  return Object.freeze({
    ready,
    requiredSamples: required,
    observedSamples: ready ? values.length : values.filter(Number.isFinite).length,
    averageDuty: ready ? values.reduce((total, value) => total + value, 0) / values.length : null,
    minimumDuty: ready ? Math.min(...values) : null,
    maximumDuty: ready ? Math.max(...values) : null
  });
}

class ResourceGovernor {
  constructor({
    name,
    getPid,
    getCgroupPath = () => null,
    policy,
    onSoftLimit = () => {},
    onHardLimit = () => {},
    logger = console,
    sampleProcess = readProcessSample,
    sampleCgroup = readCgroupSample
  }) {
    this.name = name;
    this.getPid = getPid;
    this.getCgroupPath = getCgroupPath;
    this.policy = normalizePolicy(policy?.resources || policy, policy?.priority || 'normal');
    this.onSoftLimit = onSoftLimit;
    this.onHardLimit = onHardLimit;
    this.logger = logger;
    this.sampleProcess = sampleProcess;
    this.sampleCgroup = sampleCgroup;
    this.timer = null;
    this.samples = [];
    this.highSamples = 0;
    this.highCpuSamples = 0;
    this.highSupervisorSamples = 0;
    this.actionInFlight = false;
    this.lastAction = null;
    this.lastWarning = null;
    this.lastError = null;
    this.sampleInFlight = null;
  }

  start({ sampleImmediately = true } = {}) {
    if (this.timer) return;
    const sample = () => this.sample().catch(error => { this.lastError = error.message; });
    /*
     * Establish the cumulative cgroup-event baseline immediately after the
     * payload is attached. Waiting one full interval leaves a blind window;
     * treating a reused leaf's existing counters as new events causes a false
     * recovery storm. The first sample is therefore a baseline, never a delta.
     */
    if (sampleImmediately) sample();
    this.timer = setInterval(sample, this.policy.sampleIntervalMs);
    this.timer.unref?.();
  }

  resetSamplingWindow() {
    this.samples = [];
    this.highSamples = 0;
    this.highCpuSamples = 0;
    this.highSupervisorSamples = 0;
  }

  async rebaseline() {
    /*
     * A recovery may overlap the interval sampler. Let the old read settle,
     * erase its generation-local window, then establish exactly one baseline
     * for the newly attached payload. Concurrent callers share sampleInFlight,
     * so cumulative cgroup counters cannot be reordered into false deltas.
     */
    if (this.sampleInFlight) {
      await this.sampleInFlight.catch(() => {});
    }
    this.resetSamplingWindow();
    return this.sample();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  sample() {
    if (this.sampleInFlight) return this.sampleInFlight;
    const run = this.sampleOnce();
    const tracked = run.finally(() => {
      if (this.sampleInFlight === tracked) this.sampleInFlight = null;
    });
    this.sampleInFlight = tracked;
    return tracked;
  }

  async sampleOnce() {
    const processSample = await this.sampleProcess(this.getPid());
    const cgroupSample = await this.sampleCgroup(this.getCgroupPath());
    const sample = cgroupSample
      ? { ...cgroupSample, process: processSample }
      : processSample;
    if (!sample) return null;
    this.samples.push(sample);
    if (this.samples.length > this.policy.trendSamples) this.samples.shift();
    const previous = this.samples.length > 1 ? this.samples.at(-2) : null;
    const currentEvents = {
      memory: sample.memoryEvents,
      pids: sample.pidsEvents,
      cpu: sample.cpuStat
    };
    sample.resourceEventDeltas = previous
      ? resourceEventDeltas(currentEvents, {
          memory: previous.memoryEvents,
          pids: previous.pidsEvents,
          cpu: previous.cpuStat
        })
      : resourceEventDeltas(currentEvents, currentEvents);
    sample.cpuDuty = previous && sample.cpuMicros != null && previous.cpuMicros != null
      ? Math.max(0, ((sample.cpuMicros - previous.cpuMicros) / 1000) / Math.max(1, sample.at - previous.at))
      : previous && sample.cpuTicks != null && previous.cpuTicks != null
        ? Math.max(0, ((sample.cpuTicks - previous.cpuTicks) * 10) / Math.max(1, sample.at - previous.at))
        : null;
    const memoryPlan = this.policy.memoryPlan;
    const softRamBytes = cgroupSample
      ? memoryPlan.cgroupSoftBytes
      : this.policy.softRamBytes;
    const hardRamBytes = cgroupSample
      ? memoryPlan.cgroupHardBytes
      : this.policy.hardRamBytes;
    if (sample.rssBytes != null && sample.rssBytes >= hardRamBytes) this.highSamples += 1;
    else this.highSamples = 0;

    /*
     * cpu.max is the production payload ceiling. Once cgroup v2 is active the
     * kernel already enforces that ceiling every 100 ms; recycling the CoreHost
     * because a coarse accounting window lands slightly above the same quota
     * converts healthy throttling into destructive restart churn. Keep the
     * exact quota, surface every throttle as evidence, and reserve userspace
     * recycling for hosts without kernel CPU containment. There, require a
     * complete rolling window plus the manifest's confirmation count so JIT or
     * initialization bursts cannot masquerade as sustained overload.
     */
    sample.cpuEvidence = sustainedCpuEvidence(
      this.samples,
      this.policy.hardCpuWindowSamples
    );
    sample.cpuKernelEnforced = sample.source === 'cgroup-v2';
    const sustainedCpuBreach = !sample.cpuKernelEnforced &&
      sample.cpuEvidence.ready &&
      sample.cpuEvidence.averageDuty >= this.policy.hardCpuDuty;
    if (sustainedCpuBreach) this.highCpuSamples += 1;
    else this.highCpuSamples = 0;

    const supervisorRssBytes = cgroupSample
      ? Number(processSample?.rssBytes)
      : null;
    if (
      supervisorRssBytes != null &&
      supervisorRssBytes >= memoryPlan.supervisorHardBytes
    ) this.highSupervisorSamples += 1;
    else this.highSupervisorSamples = 0;

    const softMemoryKernelEvent = sample.resourceEventDeltas.memoryHigh > 0;
    const softCpuKernelEvent = sample.resourceEventDeltas.cpuThrottled > 0 ||
      sample.resourceEventDeltas.cpuThrottledMicros > 0;
    if ((sample.rssBytes != null && sample.rssBytes >= softRamBytes)
      || (sample.cpuDuty != null && sample.cpuDuty >= this.policy.softCpuDuty)
      || (supervisorRssBytes != null && supervisorRssBytes >= memoryPlan.supervisorSoftBytes)
      || softMemoryKernelEvent
      || softCpuKernelEvent) {
      this.lastWarning = {
        type: softMemoryKernelEvent
          ? 'soft-payload-memory-event'
          : softCpuKernelEvent
            ? 'soft-payload-cpu-throttle'
            : 'soft-resource-limit',
        at: new Date().toISOString(),
        payloadBytes: sample.rssBytes,
        supervisorRssBytes,
        cpuDuty: sample.cpuDuty,
        cpuEvidence: sample.cpuEvidence,
        cpuKernelEnforced: sample.cpuKernelEnforced,
        resourceEventDeltas: sample.resourceEventDeltas
      };
      await Promise.resolve(this.onSoftLimit({
        type: this.lastWarning.type,
        sample,
        policy: this.policy,
        trend: this.trend()
      })).catch(() => {});
    }
    const hardKernelEvent = sample.resourceEventDeltas.memoryMax > 0 ||
      sample.resourceEventDeltas.memoryOom > 0 ||
      sample.resourceEventDeltas.memoryOomKill > 0 ||
      sample.resourceEventDeltas.pidsMax > 0;
    if ((hardKernelEvent || this.highSamples >= this.policy.hardConfirmations
      || this.highCpuSamples >= this.policy.hardConfirmations
      || this.highSupervisorSamples >= this.policy.hardConfirmations) && !this.actionInFlight) {
      this.actionInFlight = true;
      const type = hardKernelEvent
        ? sample.resourceEventDeltas.pidsMax > 0
          ? 'hard-payload-pids-event'
          : 'hard-payload-memory-event'
        : this.highSamples >= this.policy.hardConfirmations
        ? 'hard-payload-memory-limit'
        : this.highSupervisorSamples >= this.policy.hardConfirmations
          ? 'hard-supervisor-memory-limit'
          : 'hard-cpu-limit';
      this.lastAction = {
        type,
        at: new Date().toISOString(),
        payloadBytes: sample.rssBytes,
        supervisorRssBytes,
        cpuDuty: sample.cpuDuty,
        cpuEvidence: sample.cpuEvidence,
        cpuKernelEnforced: sample.cpuKernelEnforced,
        resourceEventDeltas: sample.resourceEventDeltas
      };
      try { await this.onHardLimit({ type, sample, policy: this.policy, trend: this.trend() }); }
      finally {
        this.actionInFlight = false;
        this.highSamples = 0;
        this.highCpuSamples = 0;
        this.highSupervisorSamples = 0;
      }
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
      lastWarning: this.lastWarning,
      lastAction: this.lastAction,
      lastError: this.lastError
    };
  }
}

module.exports = {
  ResourceGovernor,
  normalizePolicy,
  coreHostMemoryPlan,
  readProcessSample,
  readCgroupSample,
  parseFlatKeyValues,
  resourceEventDeltas,
  sustainedCpuEvidence,
  DEFAULT_HARD_CPU_WINDOW_SAMPLES,
  CORE_HOST_SUPERVISOR_RESERVE_MIB,
  MIB
};
