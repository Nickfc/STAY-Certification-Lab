'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { BoundedActorQueue } = require('../runtime/kernel/actor-queue');
const {
  ResourceGovernor,
  normalizePolicy,
  coreHostMemoryPlan,
  resourceEventDeltas,
  sustainedCpuEvidence,
  DEFAULT_HARD_CPU_WINDOW_SAMPLES,
  MIB
} = require('../runtime/kernel/resource-governor');
const {
  attachPayloadProcesses,
  cgroupLimitValues,
  prepareDelegatedHierarchy,
  processDescendants,
  resolveDelegatedLayout,
  quiesceCgroup
} = require('../runtime/kernel/cgroup-governor');
const {
  CoreHostClient,
  COREHOST_IPC_MARGIN_MS,
  coreHostDispatchTimeoutMs,
  coreHostWorkerTimeoutMs,
  signalAndWait
} = require('../runtime/kernel/core-host-client');
const { ResidentManager } = require('../runtime/kernel/resident-manager');
const { statusFor } = require('../runtime/kernel/resident-control-socket');
const { StateStore } = require('../runtime/kernel/state-store');
const { IPC_PROTOCOL, IPC_PROTOCOL_VERSION } = require('../runtime/kernel/protocol');
const benchmark = require('../deploy/live-physiology-transplant/p1-physiology-benchmark');
const liveProof = require('../deploy/live-physiology-transplant/p1-production-hardening-live-proof');
const fixture = require('./fixtures/stateful-core');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'stateful-core.js');
const SANDBOX_HOST_PATH = path.join(__dirname, '..', 'runtime', 'core-host', 'sandbox-host.js');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ipcRequest(child, message) {
  return new Promise((resolve, reject) => {
    const onMessage = response => {
      if (response?.type !== 'response' || response.requestId !== message.requestId) return;
      child.off('message', onMessage);
      resolve(response);
    };
    child.on('message', onMessage);
    child.send(message, error => {
      if (!error) return;
      child.off('message', onMessage);
      reject(error);
    });
  });
}

function fixtureResidentManager(stateStore) {
  const identity = { lineage: 'STAY/Genesis', fixture: 'startup-cleanup' };
  const contract = {
    residencyId: 'resident:hardening-fixture',
    coreId: fixture.manifest.coreId,
    role: 'test-shadow',
    version: fixture.manifest.version,
    stateSchema: fixture.manifest.stateSchema,
    stage: 'test-hardening-fixture',
    priority: fixture.manifest.priority,
    productionEligible: false,
    inputs: [...fixture.manifest.inputs],
    outputs: [...fixture.manifest.outputs],
    signalling: 'LAB_SHADOW_ONLY',
    producerEpoch: 1,
    authorityMode: 'shadow',
    routeCompleteness: false
  };
  const manager = new ResidentManager({
    releaseRoot: path.join(__dirname, '..'),
    stateStore,
    fabric: { subscribeAll: () => () => {} },
    identity,
    contract,
    logger: { log() {}, info() {}, warn() {}, error() {} }
  });
  const resident = {
    residencyId: contract.residencyId,
    instanceId: `hardening-startup-cleanup-${Date.now()}`,
    version: fixture.manifest.version,
    stateSchema: fixture.manifest.stateSchema
  };
  const binding = {
    bindingVersion: 1,
    identitySha256: manager.organismIdentityHash,
    organismLineage: identity.lineage,
    issuedAt: Date.now(),
    runtimeRevision: 111,
    authorityEpoch: 1,
    kernelVersion: '0.8.11.3'
  };
  const inspected = {
    definition: { modulePath: FIXTURE_PATH, manifest: fixture.manifest },
    contract: manager.contract
  };
  return { manager, resident, binding, inspected };
}

async function assertNoNewDescendants(before) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const after = (await processDescendants(process.pid)).sort((a, b) => a - b);
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    await delay(10);
  }
  assert.deepEqual(
    (await processDescendants(process.pid)).sort((a, b) => a - b),
    before,
    'a partial CoreHost generation escaped its initialization failure'
  );
}

test('actor recovery owns one event and preserves exact queue order', async () => {
  const calls = [];
  let first = true;
  const queue = new BoundedActorQueue({
    name: 'ordered-recovery',
    handlerTimeoutMs: 100,
    settlementGraceMs: 100,
    recoveryTimeoutMs: 100,
    handler: async event => {
      calls.push(event.sequence);
      if (event.sequence === 1 && first) {
        first = false;
        throw Object.assign(new Error('worker exited'), { code: 'CORE_WORKER_EXIT' });
      }
      return event.sequence;
    },
    recoverFailure: async error => {
      assert.equal(error.code, 'CORE_WORKER_EXIT');
      await delay(5);
      return true;
    }
  });

  const firstResult = queue.enqueue({ sequence: 1, class: 'durable' });
  const secondResult = queue.enqueue({ sequence: 2, class: 'durable' });
  assert.equal((await firstResult).result, 1);
  assert.equal((await secondResult).result, 2);
  assert.deepEqual(calls, [1, 1, 2]);
  assert.equal(queue.snapshotMetrics().recovered, 1);
  assert.equal(queue.snapshotMetrics().failed, 0);
});

test('repeated recovery cannot overtake, duplicate, or lose a durable event', async () => {
  const durable = [];
  const calls = [];
  const failedOnce = new Set();
  let volatile = 0;
  const queue = new BoundedActorQueue({
    name: 'adversarial-ordered-recovery',
    capacity: 512,
    handlerTimeoutMs: 250,
    settlementGraceMs: 250,
    recoveryTimeoutMs: 250,
    maxAttempts: 3,
    handler: async event => {
      calls.push(event.sequence);
      volatile += 1;
      if (event.sequence % 17 === 0 && !failedOnce.has(event.sequence)) {
        failedOnce.add(event.sequence);
        throw Object.assign(new Error('discard this process image'), {
          code: 'CORE_WORKER_EXIT'
        });
      }
      durable.push(event.sequence);
      return { sequence: event.sequence, volatile };
    },
    recoverFailure: async () => {
      /* Reconstruct the discarded process from the last durable image. */
      volatile = durable.length;
      return true;
    }
  });
  const count = 255;
  const results = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      queue.enqueue({ sequence: index + 1, class: 'durable' })
    )
  );
  assert.deepEqual(durable, Array.from({ length: count }, (_, index) => index + 1));
  assert.deepEqual(
    results.map(value => value.result.sequence),
    durable
  );
  assert.equal(new Set(durable).size, count);
  assert.equal(calls.length, count + Math.floor(count / 17));
  assert.equal(queue.snapshotMetrics().recovered, Math.floor(count / 17));
  assert.equal(queue.snapshotMetrics().failed, 0);
});

test('kernel resource event deltas cannot be hidden by bounded current usage', () => {
  assert.deepEqual(resourceEventDeltas(
    {
      memory: { high: 8, max: 3, oom: 2, oom_kill: 1 },
      pids: { max: 4 },
      cpu: { nr_periods: 20, nr_throttled: 7, throttled_usec: 900 }
    },
    {
      memory: { high: 5, max: 1, oom: 2, oom_kill: 0 },
      pids: { max: 1 },
      cpu: { nr_periods: 16, nr_throttled: 5, throttled_usec: 600 }
    }
  ), {
    memoryHigh: 3,
    memoryMax: 2,
    memoryOom: 0,
    memoryOomKill: 1,
    pidsMax: 3,
    cpuPeriods: 4,
    cpuThrottled: 2,
    cpuThrottledMicros: 300
  });
  assert.deepEqual(resourceEventDeltas(
    { memory: { high: 8, max: 3, oom: 2, oom_kill: 1 }, pids: { max: 4 } },
    { memory: { high: 8, max: 3, oom: 2, oom_kill: 1 }, pids: { max: 4 } }
  ), {
    memoryHigh: 0,
    memoryMax: 0,
    memoryOom: 0,
    memoryOomKill: 0,
    pidsMax: 0,
    cpuPeriods: 0,
    cpuThrottled: 0,
    cpuThrottledMicros: 0
  });
});

test('CPU intervention requires sustained evidence without widening the kernel quota', async () => {
  assert.equal(DEFAULT_HARD_CPU_WINDOW_SAMPLES, 4);
  assert.deepEqual(
    sustainedCpuEvidence([
      { cpuDuty: null },
      { cpuDuty: 0.35 },
      { cpuDuty: 0.22 }
    ]),
    {
      ready: false,
      requiredSamples: 4,
      observedSamples: 2,
      averageDuty: null,
      minimumDuty: null,
      maximumDuty: null
    }
  );
  assert.ok(Math.abs(sustainedCpuEvidence([
    { cpuDuty: 0.25 },
    { cpuDuty: 0.24 },
    { cpuDuty: 0.05 },
    { cpuDuty: 0.06 }
  ]).averageDuty - 0.15) < Number.EPSILON);

  const sustainedProcessSamples = [
    { at: 0, rssBytes: 1, peakRssBytes: 1, swapBytes: 0, cpuTicks: 0 },
    ...Array.from({ length: 5 }, (_, index) => ({
      at: (index + 1) * 2000,
      rssBytes: 1,
      peakRssBytes: 1,
      swapBytes: 0,
      cpuTicks: (index + 1) * 50
    }))
  ];
  let processIndex = 0;
  let processActions = 0;
  const processGovernor = new ResourceGovernor({
    name: 'sustained-process-cpu',
    getPid: () => 1,
    policy: normalizePolicy({
      softRamMiB: 64,
      hardRamMiB: 96,
      softCpuPercent: 5,
      hardCpuPercent: 20,
      pidsMax: 16
    }, 'optional'),
    sampleProcess: async () => sustainedProcessSamples[processIndex++] || null,
    sampleCgroup: async () => null,
    onHardLimit: () => { processActions += 1; },
    logger: { log() {}, info() {}, warn() {}, error() {} }
  });
  for (const ignored of sustainedProcessSamples) await processGovernor.sample();
  assert.equal(processActions, 1, 'a real sustained non-cgroup CPU breach must still be contained');
  assert.equal(processGovernor.lastAction.type, 'hard-cpu-limit');
  assert.equal(processGovernor.lastAction.cpuEvidence.ready, true);
  assert.equal(processGovernor.lastAction.cpuEvidence.averageDuty, 0.25);

  const cgroupSamples = sustainedProcessSamples.map((sample, index) => ({
    ...sample,
    source: 'cgroup-v2',
    cpuTicks: null,
    cpuMicros: index * 500_000,
    cpuStat: {
      usage_usec: index * 500_000,
      nr_periods: index * 20,
      nr_throttled: index,
      throttled_usec: index * 1000
    },
    memoryEvents: {},
    pidsEvents: {}
  }));
  let cgroupIndex = 0;
  let cgroupActions = 0;
  const cgroupGovernor = new ResourceGovernor({
    name: 'kernel-enforced-cpu',
    getPid: () => null,
    getCgroupPath: () => '/synthetic/cgroup',
    policy: processGovernor.policy,
    sampleProcess: async () => null,
    sampleCgroup: async () => cgroupSamples[cgroupIndex++] || null,
    onHardLimit: () => { cgroupActions += 1; },
    logger: { log() {}, info() {}, warn() {}, error() {} }
  });
  for (const ignored of cgroupSamples) await cgroupGovernor.sample();
  assert.equal(cgroupActions, 0, 'kernel-enforced CPU accounting must not trigger destructive duplicate enforcement');
  assert.equal(cgroupGovernor.status().latest.cpuKernelEnforced, true);
  assert.equal(cgroupGovernor.lastWarning.type, 'soft-payload-cpu-throttle');
});

test('resource sampling is single-flight and recovery establishes one clean baseline', async () => {
  const governor = new ResourceGovernor({
    name: 'single-flight-resource-fixture',
    getPid: () => null,
    policy: normalizePolicy({
      softRamMiB: 64,
      hardRamMiB: 96,
      softCpuPercent: 5,
      hardCpuPercent: 20,
      pidsMax: 16
    }, 'optional'),
    logger: { log() {}, info() {}, warn() {}, error() {} }
  });
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  governor.sampleOnce = async () => {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await delay(20);
    active -= 1;
    governor.samples.push({ at: calls, rssBytes: calls });
    return governor.samples.at(-1);
  };

  const shared = await Promise.all([
    governor.sample(),
    governor.sample(),
    governor.sample()
  ]);
  assert.equal(calls, 1);
  assert.equal(maximumActive, 1);
  assert.deepEqual(shared, [shared[0], shared[0], shared[0]]);

  governor.samples.push({ at: 99, rssBytes: 99 });
  await governor.rebaseline();
  assert.equal(calls, 2);
  assert.equal(maximumActive, 1);
  assert.equal(governor.samples.length, 1);
  assert.equal(governor.samples[0].at, 2);
});

test('delegated cgroup layout keeps supervisors in kernel and discovers the full payload tree', async () => {
  assert.deepEqual(
    resolveDelegatedLayout({
      root: '/sys/fs/cgroup',
      relative: '/system.slice/stay.service/stay-kernel',
      subgroup: 'stay-kernel'
    }),
    {
      current: '/sys/fs/cgroup/system.slice/stay.service',
      kernel: '/sys/fs/cgroup/system.slice/stay.service/stay-kernel',
      cores: '/sys/fs/cgroup/system.slice/stay.service/stay-cores',
      moveKernelProcess: false
    }
  );

  const operations = [];
  const hierarchyIo = {
    mkdir: async (target, options) => operations.push(['mkdir', target, options]),
    writeFile: async (target, value) => operations.push(['write', target, value])
  };
  await prepareDelegatedHierarchy({
    current: '/cg/service',
    kernel: '/cg/service/stay-kernel',
    cores: '/cg/service/stay-cores',
    pid: 99,
    moveKernelProcess: false,
    io: hierarchyIo
  });
  assert.deepEqual(operations, [
    ['mkdir', '/cg/service/stay-kernel', { recursive: true }],
    ['write', '/cg/service/cgroup.subtree_control', '+cpu +memory +pids'],
    ['mkdir', '/cg/service/stay-cores', { recursive: true }],
    ['write', '/cg/service/stay-cores/cgroup.subtree_control', '+cpu +memory +pids']
  ]);

  const children = new Map([
    ['/proc/10/task/10/children', '11 12\n'],
    ['/proc/11/task/11/children', '13\n'],
    ['/proc/12/task/12/children', ''],
    ['/proc/13/task/13/children', '14\n'],
    ['/proc/14/task/14/children', '']
  ]);
  const descendants = await processDescendants(10, {
    readFile: async target => {
      if (children.has(target)) return children.get(target);
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
  });
  assert.deepEqual(descendants.sort((left, right) => left - right), [10, 11, 12, 13, 14]);
});

test('payload containment tolerates only vanished launch helpers and proves every survivor', async () => {
  const directory = '/sys/fs/cgroup/stay-cores/chronobiology-fixture';
  const processFile = `${directory}/cgroup.procs`;
  const live = new Set([701, 703]);
  const members = new Set();
  const writes = [];
  const vanished = Object.assign(new Error('synthetic launch helper exited'), { code: 'ESRCH' });
  const missing = Object.assign(new Error('synthetic process is gone'), { code: 'ENOENT' });
  const io = {
    writeFile: async (file, value) => {
      assert.equal(file, processFile);
      const pid = Number(value);
      writes.push(pid);
      if (pid === 702) throw vanished;
      members.add(pid);
    },
    readFile: async file => {
      if (file === processFile) return [...members].join('\n') + '\n';
      const pid = Number(file.match(/^\/proc\/(\d+)\/stat$/)?.[1]);
      if (!live.has(pid)) throw missing;
      return `${pid} (fixture) S`;
    }
  };

  assert.deepEqual(
    await attachPayloadProcesses(directory, [701, 702, 703], io),
    [701, 703]
  );
  assert.deepEqual(writes, [701, 702, 703]);
});

test('payload containment fails closed when a live process is not in the target cgroup', async () => {
  const directory = '/sys/fs/cgroup/stay-cores/sntss-fixture';
  const processFile = `${directory}/cgroup.procs`;
  const io = {
    writeFile: async (_file, value) => {
      if (Number(value) === 802) {
        throw Object.assign(new Error('synthetic failed move'), { code: 'ESRCH' });
      }
    },
    readFile: async file => file === processFile ? '801\n' : 'live'
  };

  await assert.rejects(
    attachPayloadProcesses(directory, [801, 802], io),
    error => error.code === 'CGROUP_PAYLOAD_UNCONTAINED' &&
      JSON.stringify(error.pids) === JSON.stringify([802])
  );
});

test('cold recovery includes an authority-contained quarantined Chronobiology resident', async () => {
  const calls = [];
  const kernel = Object.create(require('../runtime/kernel/living-kernel').LivingKernel.prototype);
  kernel.runtimeRevision = 113;
  kernel.statusCache = {};
  kernel.stateStore = {
    getResident(residencyId) {
      return residencyId === 'resident:chronobiology'
        ? { residencyId, coreId: 'chronobiology', status: 'QUARANTINED' }
        : null;
    }
  };
  kernel.ensureOrganismBinding = async () => ({ identitySha256: 'sha256:' + '1'.repeat(64) });
  kernel.ensureResidentManager = () => ({
    async resynchronize(residencyId, _binding, revision, options) {
      calls.push({ residencyId, revision, options });
      return { record: { abandonedCount: 0 } };
    }
  });

  const previous = process.env.STAY_RECOVER_COLD_RESIDENTS_AT_REVISION;
  process.env.STAY_RECOVER_COLD_RESIDENTS_AT_REVISION = '113';
  try {
    assert.deepEqual(await kernel.recoverColdFailedResidents(), [{
      residencyId: 'resident:chronobiology',
      recovered: true,
      coldRecovery: true,
      abandonedCount: 0,
      status: 'RUNNING'
    }]);
  } finally {
    if (previous == null) delete process.env.STAY_RECOVER_COLD_RESIDENTS_AT_REVISION;
    else process.env.STAY_RECOVER_COLD_RESIDENTS_AT_REVISION = previous;
  }
  assert.deepEqual(calls, [{
    residencyId: 'resident:chronobiology',
    revision: 113,
    options: { allowColdQuarantine: true }
  }]);
});

test('an authority-free empty outbox is quiet while an orphaned pending intent fails closed', () => {
  let pending = null;
  const store = Object.create(StateStore.prototype);
  store.assertOpen = () => {};
  store.db = {
    prepare() {
      return { get: () => pending };
    }
  };

  assert.deepEqual(store.listDrainableBiologicalOutboxIntents({
    producerCoreId: 'sntss',
    currentAuthorityEpoch: null
  }), []);

  pending = { producer_event_id: 'orphaned-output' };
  assert.throws(
    () => store.listDrainableBiologicalOutboxIntents({
      producerCoreId: 'sntss',
      currentAuthorityEpoch: null
    }),
    error => error.code === 'BIOLOGICAL_OUTBOX_DRAIN_AUTHORITY' &&
      error.producerEventId === 'orphaned-output'
  );
});

test('a reused payload cgroup is killed and proven empty before the next generation', async () => {
  let processes = '4401\n4402\n';
  const writes = [];
  const io = {
    readFile: async file => {
      assert.match(file, /cgroup\.procs$/);
      return processes;
    },
    writeFile: async (file, value) => {
      writes.push([file, String(value)]);
      assert.match(file, /cgroup\.kill$/);
      assert.equal(String(value), '1');
      processes = '';
    }
  };

  const killed = await quiesceCgroup('/sys/fs/cgroup/stay-cores/sntss', {
    io,
    timeoutMs: 50,
    pollIntervalMs: 1
  });
  assert.deepEqual(killed, [4401, 4402]);
  assert.equal(writes.length, 1);
});

test('a CoreHost generation cannot advance until its supervisor exit is observed', async () => {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.pid = 5511;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = signal => {
    assert.equal(signal, 'SIGKILL');
    setImmediate(() => {
      child.signalCode = signal;
      child.emit('exit', null, signal);
    });
    return true;
  };

  assert.equal(
    await signalAndWait(child, 'SIGKILL', 50),
    true
  );
  assert.equal(child.signalCode, 'SIGKILL');
});

test('sandbox initialization cannot begin before the payload attachment acknowledgement', async t => {
  const child = fork(SANDBOX_HOST_PATH, [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      STAY_REQUIRE_OS_CORE_SANDBOX: '0'
    }
  });
  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  });

  let initialized = false;
  let readyResolve;
  let responseResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const response = new Promise(resolve => { responseResolve = resolve; });
  const requestId = 'pre-init-containment-fixture';
  child.on('message', message => {
    if (message?.type === 'payload-ready') readyResolve(message);
    if (message?.type === 'response' && message.requestId === requestId) {
      initialized = true;
      responseResolve(message);
    }
  });
  child.send({
    protocol: IPC_PROTOCOL,
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId,
    operation: 'init',
    payload: {
      modulePath: FIXTURE_PATH,
      expectedCoreId: fixture.manifest.coreId,
      expectedVersion: fixture.manifest.version,
      expectedManifest: fixture.manifest,
      initialState: { count: 0 },
      fromStateSchema: 1,
      mode: 'standby',
      workerInitTimeoutMs: 1000,
      payloadAttachTimeoutMs: 1000,
      workerMemoryPlan: { workerOldSpaceMiB: 32, workerSemiSpaceMiB: 4 }
    }
  });
  const attachment = await ready;
  assert.equal(Number.isSafeInteger(Number(attachment.workerLauncherPid)), true);
  await delay(30);
  assert.equal(initialized, false);
  child.send({
    protocol: IPC_PROTOCOL,
    protocolVersion: IPC_PROTOCOL_VERSION,
    type: 'payload-attached',
    attachToken: attachment.attachToken,
    ok: true,
    attached: true
  });
  const result = await response;
  assert.equal(result.ok, true);
  assert.equal(result.result.payloadAttachmentAcknowledged, true);
  assert.equal(result.result.payloadAttached, true);
});

test('sandbox initialization fails closed when payload attachment is rejected', async t => {
  const child = fork(SANDBOX_HOST_PATH, [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      STAY_REQUIRE_OS_CORE_SANDBOX: '0'
    }
  });
  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  });

  let readyResolve;
  let responseResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const response = new Promise(resolve => { responseResolve = resolve; });
  const requestId = 'pre-init-containment-rejection-fixture';
  child.on('message', message => {
    if (message?.type === 'payload-ready') readyResolve(message);
    if (message?.type === 'response' && message.requestId === requestId) {
      responseResolve(message);
    }
  });
  child.send({
    protocol: IPC_PROTOCOL,
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId,
    operation: 'init',
    payload: {
      modulePath: FIXTURE_PATH,
      expectedCoreId: fixture.manifest.coreId,
      expectedVersion: fixture.manifest.version,
      expectedManifest: fixture.manifest,
      initialState: { count: 0 },
      fromStateSchema: 1,
      mode: 'standby',
      workerInitTimeoutMs: 1000,
      payloadAttachTimeoutMs: 1000,
      workerMemoryPlan: { workerOldSpaceMiB: 32, workerSemiSpaceMiB: 4 }
    }
  });
  const attachment = await ready;
  child.send({
    protocol: IPC_PROTOCOL,
    protocolVersion: IPC_PROTOCOL_VERSION,
    type: 'payload-attached',
    attachToken: attachment.attachToken,
    ok: false,
    error: {
      name: 'Error',
      code: 'CGROUP_PREINIT_ATTACHMENT',
      message: 'forced attachment rejection'
    }
  });
  const result = await response;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CGROUP_PREINIT_ATTACHMENT');
});

test('sandbox routes an unrecognized durable event through the canonical checkpoint fence', async t => {
  const child = fork(SANDBOX_HOST_PATH, [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      STAY_REQUIRE_OS_CORE_SANDBOX: '0'
    }
  });
  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  });
  child.on('message', message => {
    if (message?.type !== 'payload-ready') return;
    child.send({
      protocol: IPC_PROTOCOL,
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: 'payload-attached',
      attachToken: message.attachToken,
      ok: true,
      attached: true
    });
  });

  const init = await ipcRequest(child, {
    protocol: IPC_PROTOCOL,
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId: 'ignored-event-init',
    operation: 'init',
    payload: {
      modulePath: FIXTURE_PATH,
      expectedCoreId: fixture.manifest.coreId,
      expectedVersion: fixture.manifest.version,
      expectedManifest: fixture.manifest,
      initialState: { count: 7 },
      fromStateSchema: 1,
      mode: 'standby',
      workerInitTimeoutMs: 1000,
      payloadAttachTimeoutMs: 1000,
      workerMemoryPlan: { workerOldSpaceMiB: 32, workerSemiSpaceMiB: 4 }
    }
  });
  assert.equal(init.ok, true);

  const ignored = await ipcRequest(child, {
    protocol: IPC_PROTOCOL,
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId: 'ignored-event-transition',
    operation: 'event',
    payload: {
      event: {
        id: 'ignored-event',
        sequence: 1,
        class: 'durable',
        topic: 'test.unrecognized',
        payload: {}
      },
      context: { eventSequence: 1, eventId: 'ignored-event' },
      includeCheckpoint: true,
      workerTimeoutMs: 500
    }
  });
  assert.equal(ignored.ok, true);
  assert.deepEqual(ignored.result, {
    result: { ignored: true },
    checkpoint: { count: 7 }
  });
});

test('CoreHost rejects a payload PID outside its own descendant tree', {
  skip: process.platform !== 'linux'
}, async t => {
  const child = fork(SANDBOX_HOST_PATH, [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      STAY_REQUIRE_OS_CORE_SANDBOX: '0'
    }
  });
  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  });

  const client = Object.create(CoreHostClient.prototype);
  client.child = child;
  client.generation = 1;
  client.spawning = true;
  client.payloadAttachmentGeneration = 0;
  client.payloadAttachmentTokens = new Set();
  let attached = false;
  let acknowledgement = null;
  client.cgroup = {
    required: true,
    attachPayloadTree: async () => {
      attached = true;
      return true;
    }
  };
  client.sendPayloadAttachment = async (_child, message) => {
    acknowledgement = message;
  };

  await assert.rejects(
    client.handlePayloadReady({
      attachToken: 'foreign-payload-fixture',
      workerLauncherPid: process.pid
    }, child),
    error => error.code === 'COREHOST_PAYLOAD_ATTACH_ANCESTRY'
  );
  assert.equal(attached, false);
  assert.equal(acknowledgement.ok, false);
  assert.equal(acknowledgement.error.code, 'COREHOST_PAYLOAD_ATTACH_ANCESTRY');
});

test('a late handler completion is accepted without replay', async () => {
  let calls = 0;
  let recoveries = 0;
  const queue = new BoundedActorQueue({
    name: 'late-settlement',
    handlerTimeoutMs: 5,
    settlementGraceMs: 100,
    handler: async () => {
      calls += 1;
      await delay(25);
      return 'committed-once';
    },
    recoverFailure: async () => { recoveries += 1; return true; }
  });
  const result = await queue.enqueue({ sequence: 1, class: 'durable' });
  assert.equal(result.result, 'committed-once');
  assert.equal(calls, 1);
  assert.equal(recoveries, 0);
  assert.equal(queue.snapshotMetrics().lateCompleted, 1);
  assert.equal(queue.snapshotMetrics().timedOut, 1);
});

test('an unsettled handler fails closed and is never replayed', async () => {
  let calls = 0;
  let faults = 0;
  const queue = new BoundedActorQueue({
    name: 'stalled-handler',
    handlerTimeoutMs: 5,
    settlementGraceMs: 5,
    handler: () => { calls += 1; return new Promise(() => {}); },
    recoverFailure: async () => true,
    onFault: () => { faults += 1; }
  });
  await assert.rejects(
    queue.enqueue({ sequence: 7, class: 'durable' }),
    error => error.code === 'ACTOR_HANDLER_STALLED'
  );
  assert.equal(calls, 1);
  assert.equal(faults, 1);
  assert.equal(queue.snapshotMetrics().stalled, 1);
});

test('manifest memory remains the exact payload budget and the supervisor has a separate bound', () => {
  const policy = normalizePolicy({
    softRamMiB: 64,
    hardRamMiB: 96,
    softCpuPercent: 5,
    hardCpuPercent: 20,
    pidsMax: 16
  }, 'optional');
  assert.strictEqual(normalizePolicy(policy, 'optional'), policy);
  assert.deepEqual(policy.memoryPlan, coreHostMemoryPlan(policy));
  assert.equal(policy.memoryPlan.payloadSoftBytes, 64 * MIB);
  assert.equal(policy.memoryPlan.payloadHardBytes, 96 * MIB);
  assert.equal(policy.memoryPlan.accounting, 'payload-cgroup-plus-kernel-supervisor');
  assert.equal(policy.memoryPlan.cgroupSoftBytes, 64 * MIB);
  assert.equal(policy.memoryPlan.cgroupHardBytes, 96 * MIB);
  assert.equal(policy.memoryPlan.totalSoftEnvelopeBytes, 128 * MIB);
  assert.equal(policy.memoryPlan.totalHardEnvelopeBytes, 160 * MIB);
  assert.equal(policy.memoryPlan.supervisorSoftBytes, 48 * MIB);
  assert.equal(policy.memoryPlan.supervisorHardBytes, 64 * MIB);
  assert.equal(policy.memoryPlan.supervisorOldSpaceMiB, 12);
  assert.equal(policy.memoryPlan.supervisorSemiSpaceMiB, 1);
  assert.equal(policy.memoryPlan.workerOldSpaceMiB, 64);
  assert.equal(policy.hardCpuWindowSamples, 4);
  assert.equal(cgroupLimitValues(policy)['memory.high'], String(64 * MIB));
  assert.equal(cgroupLimitValues(policy)['memory.max'], String(96 * MIB));
  assert.equal(cgroupLimitValues(policy)['cpu.max'], '20000 100000');
});

test('I4-G1 keeps its declared worker deadline while IPC overhead is separately bounded', () => {
  const options = {
    coreId: 'sntss',
    coreVersion: '0.5.0-i4g1',
    recoveryState: null,
    event: { topic: 'runtime.time.pulse' },
    handlerTimeoutMs: 250
  };
  assert.equal(coreHostWorkerTimeoutMs(options), 250);
  assert.equal(coreHostDispatchTimeoutMs(options), 250 + COREHOST_IPC_MARGIN_MS);
});

test('combined event and checkpoint discards an uncommitted timed-out process', async t => {
  const client = new CoreHostClient({
    modulePath: FIXTURE_PATH,
    expectedManifest: fixture.manifest,
    instanceId: 'hardening-fixture',
    policy: { resources: fixture.manifest.resources, priority: fixture.manifest.priority },
    logger: { log() {}, info() {}, warn() {}, error() {} }
  });
  client.on('error', () => {});
  t.after(() => client.stop().catch(() => {}));
  await client.start({ count: 0 }, 1);
  const failedGeneration = client.generation;

  let failure;
  try {
    await client.dispatch(
      {
        id: 'event-timeout',
        sequence: 1,
        topic: 'test.event',
        class: 'durable',
        payload: { mutateBeforeDelay: true, delayMs: COREHOST_IPC_MARGIN_MS + 200 }
      },
      { eventSequence: 1 }
    );
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 'COREHOST_TIMEOUT');
  await client.ensureRecovery(failure);
  assert.ok(client.generation > failedGeneration);

  const committed = await client.dispatch(
    {
      id: 'event-commit',
      sequence: 1,
      topic: 'test.event',
      class: 'durable',
      payload: {}
    },
    { eventSequence: 1 }
  );
  assert.deepEqual(committed.checkpoint, { count: 1 });
  assert.equal(committed.result.handled, true);
  assert.equal(client.status().deadlineContract.eventAndCheckpointCombined, true);
});

test('a discarded transition cannot leak speculative biological output', async t => {
  const client = new CoreHostClient({
    modulePath: FIXTURE_PATH,
    expectedManifest: fixture.manifest,
    instanceId: 'hardening-output-fence',
    policy: { resources: fixture.manifest.resources, priority: fixture.manifest.priority },
    logger: { log() {}, info() {}, warn() {}, error() {} }
  });
  const outputs = [];
  client.on('output', message => outputs.push(message));
  client.on('error', () => {});
  t.after(() => client.stop().catch(() => {}));
  await client.start({ count: 0 }, 1);

  let failure;
  try {
    await client.dispatch({
      id: 'speculative-output',
      sequence: 1,
      topic: 'test.event',
      class: 'durable',
      payload: {
        mutateBeforeDelay: true,
        emitBeforeDelay: true,
        delayMs: COREHOST_IPC_MARGIN_MS + 200
      }
    }, { eventSequence: 1 });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, 'COREHOST_TIMEOUT');
  await client.ensureRecovery(failure);
  assert.equal(outputs.length, 0);

  const committed = await client.dispatch({
    id: 'committed-output',
    sequence: 1,
    topic: 'test.event',
    class: 'durable',
    payload: { emitBeforeDelay: true }
  }, { eventSequence: 1 });
  assert.deepEqual(committed.checkpoint, { count: 1 });
  assert.equal(outputs.length, 1);
  assert.deepEqual(outputs[0].payload, { count: 0 });
});

test('a failed dispatch erases every speculative output intent before retry', async () => {
  const manager = Object.create(ResidentManager.prototype);
  manager.withRouteCompleteness = (_unit, event) => event;
  const event = {
    id: 'evt-dispatch-failure',
    sequence: 41,
    topic: 'runtime.trusted-organism-time.pulse',
    class: 'durable',
    ledger: { durable: true }
  };
  const pendingOutputIntents = new Map();
  const unit = {
    manifest: { coreId: 'chronobiology' },
    resident: { instanceId: 'fixture-chronobiology' },
    contract: { signalling: 'LAB_SHADOW_ONLY', producerEpoch: 7 },
    outputViolation: false,
    pendingOutputIntents,
    client: {
      async dispatch() {
        pendingOutputIntents.set(event.sequence, [{ outputIndex: 1 }]);
        throw Object.assign(new Error('synthetic protocol failure'), {
          code: 'COREHOST_OUTPUT_DELIVERY_FAILED'
        });
      }
    }
  };

  await assert.rejects(
    manager.processEvent(unit, event),
    { code: 'COREHOST_OUTPUT_DELIVERY_FAILED' }
  );
  assert.equal(pendingOutputIntents.has(event.sequence), false);
});

test('resident output intent, checkpoint, and input ACK cross one durable commit boundary', async () => {
  const order = [];
  let committedInput = null;
  const stateStore = {
    commitResidentCheckpoint: async input => {
      order.push('commit');
      committedInput = structuredClone(input);
      return { blobHash: 'committed', outboxIntents: structuredClone(input.outboxIntents) };
    },
    getResident: () => ({
      residencyId: 'resident:chronobiology',
      instanceId: 'chronobiology-instance',
      checkpointGeneration: 2
    })
  };
  const manager = {
    stateStore,
    withRouteCompleteness: ResidentManager.prototype.withRouteCompleteness,
    handleSignallingOutput: ResidentManager.prototype.handleSignallingOutput,
    tryDrainResidentOutbox: async () => { order.push('drain'); return 1; }
  };
  const unit = {
    residencyId: 'resident:chronobiology',
    resident: { instanceId: 'chronobiology-instance' },
    manifest: {
      coreId: 'chronobiology', version: '1.0.0-c3rc.1', stateSchema: 2,
      outputs: ['chronobiology.phase.summary']
    },
    contract: {
      signalling: 'LAB_SHADOW_ONLY', producerEpoch: 1, routeCompleteness: false
    },
    outputViolation: false,
    pendingOutputIntents: new Map(),
    replaySequence: null,
    observedOutputs: 0,
    handledEvents: 0,
    client: {
      dispatch: async (_event, context) => {
        order.push('dispatch');
        manager.handleSignallingOutput(unit, {
          topic: 'chronobiology.phase.summary',
          payload: { phase: 7 },
          meta: { outputIndex: 1 },
          context
        });
        return { checkpoint: { stateSchema: 2, phase: 7 } };
      },
      setRecoveryState: state => {
        order.push('recovery-state');
        assert.deepEqual(state, { stateSchema: 2, phase: 7 });
      }
    }
  };
  const event = {
    id: 'pulse-7', sequence: 7, topic: 'runtime.trusted-organism-time.pulse',
    class: 'durable', ledger: { durable: true }
  };
  const persisted = await ResidentManager.prototype.processEvent.call(manager, unit, event);
  assert.deepEqual(order, ['dispatch', 'commit', 'recovery-state', 'drain']);
  assert.equal(persisted.blobHash, 'committed');
  assert.deepEqual(committedInput.consumerAck, {
    consumerId: 'resident:chronobiology',
    sequence: 7,
    transitionId: committedInput.producerTransitionId
  });
  assert.deepEqual(committedInput.outboxIntents, [{
    outputIndex: 1,
    topic: 'chronobiology.phase.summary',
    payload: { phase: 7 },
    causeSequence: 7,
    causalParent: 'pulse-7'
  }]);
  assert.equal(unit.pendingOutputIntents.size, 0);
  assert.equal(unit.handledEvents, 1);
});

test('a first-checkpoint failure tears down the partial CoreHost before consumer activation', async () => {
  const before = (await processDescendants(process.pid)).sort((a, b) => a - b);
  let deactivations = 0;
  const stateStore = {
    async commitResidentCheckpoint() {
      throw Object.assign(new Error('forced first-checkpoint failure'), {
        code: 'FIRST_CHECKPOINT_FIXTURE'
      });
    },
    deactivateBiologicalConsumer() { deactivations += 1; }
  };
  const { manager, resident, binding, inspected } = fixtureResidentManager(stateStore);
  await assert.rejects(
    manager.startUnit({ resident, inspected, binding }),
    error => error.code === 'FIRST_CHECKPOINT_FIXTURE'
  );
  assert.equal(deactivations, 0);
  assert.equal(manager.units.has(resident.residencyId), false);
  await assertNoNewDescendants(before);
});

test('a replay-start failure deactivates the consumer and tears down the activated CoreHost', async () => {
  const before = (await processDescendants(process.pid)).sort((a, b) => a - b);
  let deactivations = 0;
  const stateStore = {
    async commitResidentCheckpoint() { return { blobHash: 'fixture-checkpoint' }; },
    registerBiologicalConsumer() { return { activationBackfilled: 3 }; },
    getResident() { return { status: 'RECOVERING' }; },
    deactivateBiologicalConsumer() { deactivations += 1; }
  };
  const { manager, resident, binding, inspected } = fixtureResidentManager(stateStore);
  manager.replayFinalizedResidentEvents = async () => {
    throw Object.assign(new Error('forced replay-start failure'), {
      code: 'REPLAY_START_FIXTURE'
    });
  };
  await assert.rejects(
    manager.startUnit({ resident, inspected, binding, backfillInactiveGap: true }),
    error => error.code === 'REPLAY_START_FIXTURE'
  );
  assert.equal(deactivations, 1);
  assert.equal(manager.units.has(resident.residencyId), false);
  await assertNoNewDescendants(before);
});

test('StateStore rejects a future schema before mutating its database', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-hardening-future-schema-'));
  const databasePath = path.join(root, 'continuity.sqlite3');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const seed = new DatabaseSync(databasePath);
  seed.exec(`
    CREATE TABLE schema_versions (
      name TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE future_sentinel (value TEXT NOT NULL);
    INSERT INTO schema_versions(name, version, updated_at)
      VALUES('continuity', 5, 'future');
    INSERT INTO future_sentinel(value) VALUES('preserve-me');
  `);
  seed.close();

  const store = new StateStore(root);
  await assert.rejects(
    store.init(),
    error => error.code === 'STATE_SCHEMA_UNSUPPORTED'
  );
  assert.equal(store.db, null);

  const observed = new DatabaseSync(databasePath, { readOnly: true });
  assert.deepEqual(
    observed.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map(row => row.name),
    ['future_sentinel', 'schema_versions']
  );
  assert.equal(
    observed.prepare('SELECT value FROM future_sentinel').get().value,
    'preserve-me'
  );
  assert.equal(
    observed.prepare("SELECT version FROM schema_versions WHERE name='continuity'").get().version,
    5
  );
  observed.close();
});

test('StateStore rolls back the entire schema bootstrap when a migration is ambiguous', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-hardening-migration-rollback-'));
  const databasePath = path.join(root, 'continuity.sqlite3');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const seed = new DatabaseSync(databasePath);
  seed.exec(`
    CREATE TABLE schema_versions (
      name TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO schema_versions(name, version, updated_at)
      VALUES('biological-outbox', 1, 'legacy');

    CREATE TABLE biological_outbox_intents (
      producer_event_id TEXT PRIMARY KEY,
      producer_core_id TEXT NOT NULL,
      producer_instance_id TEXT NOT NULL,
      producer_version TEXT NOT NULL,
      authority_epoch INTEGER NOT NULL,
      producer_stream_id TEXT NOT NULL,
      stream_sequence INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    INSERT INTO biological_outbox_intents VALUES
      ('event-1', 'chronobiology', 'instance-a', '1.0.0', 1, 'stream-a', 1, 'PENDING'),
      ('event-2', 'chronobiology', 'instance-b', '1.0.0', 1, 'stream-a', 2, 'PENDING');
  `);
  seed.close();

  const store = new StateStore(root);
  await assert.rejects(
    store.init(),
    error => error.code === 'STATE_BIOLOGICAL_OUTBOX_MIGRATION'
  );
  assert.equal(store.db, null);

  const observed = new DatabaseSync(databasePath, { readOnly: true });
  assert.deepEqual(
    observed.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map(row => row.name),
    ['biological_outbox_intents', 'schema_versions']
  );
  assert.deepEqual(
    observed.prepare('SELECT name, version, updated_at FROM schema_versions').all()
      .map(row => ({ ...row })),
    [{ name: 'biological-outbox', version: 1, updated_at: 'legacy' }]
  );
  assert.equal(
    observed.prepare('SELECT COUNT(*) count FROM biological_outbox_intents').get().count,
    2
  );
  observed.close();
});

test('the real StateStore transaction is atomic and outbox replay is idempotent', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-hardening-state-'));
  const store = new StateStore(root);
  await store.init();
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const hash = character => `sha256:${character.repeat(64)}`;
  store.registerResident({
    residencyId: 'resident:chronobiology',
    coreId: 'chronobiology',
    role: 'optional-shadow',
    instanceId: 'chronobiology-atomic-fixture',
    version: '1.0.0-c3rc.1',
    stateSchema: 2,
    moduleRelativePath: 'cores/chronobiology/c3/index.js',
    moduleHash: hash('1'),
    manifestHash: hash('2'),
    packagePolicyHash: hash('3'),
    organismIdentityHash: hash('4')
  });
  store.setResidentStatus('resident:chronobiology', 'RUNNING');
  store.registerBiologicalConsumer({
    consumerId: 'resident:chronobiology',
    coreId: 'chronobiology',
    topics: ['runtime.trusted-organism-time.pulse'],
    required: false,
    authorityEpoch: 0
  });

  const firstInput = store.appendBiologicalEvent({
    topic: 'runtime.trusted-organism-time.pulse',
    payload: { trustedTimeUs: 1_000_000 },
    eventClass: 'durable',
    at: Date.now()
  }).event;
  const firstTransitionId = 'chronobiology-transition-1';
  const committed = await store.commitResidentCheckpoint({
    residencyId: 'resident:chronobiology',
    instanceId: 'chronobiology-atomic-fixture',
    version: '1.0.0-c3rc.1',
    stateSchema: 2,
    state: { stateSchema: 2, generation: 1 },
    consumerAck: {
      consumerId: 'resident:chronobiology',
      sequence: firstInput.sequence,
      transitionId: firstTransitionId
    },
    producerEpoch: 1,
    producerTransitionId: firstTransitionId,
    outboxIntents: [{
      outputIndex: 1,
      topic: 'chronobiology.phase.summary',
      payload: { phase: 7 },
      causeSequence: firstInput.sequence,
      causalParent: firstInput.id
    }]
  });
  assert.equal(committed.generation, 1);
  assert.equal(
    store.getBiologicalDelivery('resident:chronobiology', firstInput.sequence).status,
    'ACKED'
  );
  assert.equal(committed.outboxIntents.length, 1);

  const intent = store.listDrainableBiologicalOutboxIntents({
    producerCoreId: 'chronobiology',
    currentAuthorityEpoch: 1
  })[0];
  const firstPublish = store.appendBiologicalEvent({
    topic: intent.topic,
    payload: intent.payload,
    meta: intent.publishMeta,
    eventClass: 'durable',
    at: Date.now()
  });
  const replayedPublish = store.appendBiologicalEvent({
    topic: intent.topic,
    payload: intent.payload,
    meta: intent.publishMeta,
    eventClass: 'durable',
    at: Date.now() + 1
  });
  assert.equal(replayedPublish.deduplicated, true);
  assert.equal(replayedPublish.event.id, firstPublish.event.id);
  assert.equal(replayedPublish.event.sequence, firstPublish.event.sequence);
  store.markBiologicalOutboxPublished({
    producerEventId: intent.producerEventId,
    event: replayedPublish.event
  });
  store.markBiologicalOutboxPublished({
    producerEventId: intent.producerEventId,
    event: firstPublish.event
  });

  const secondInput = store.appendBiologicalEvent({
    topic: 'runtime.trusted-organism-time.pulse',
    payload: { trustedTimeUs: 2_000_000 },
    eventClass: 'durable',
    at: Date.now() + 2
  }).event;
  const duplicateOutputs = [1, 1].map(outputIndex => ({
    outputIndex,
    topic: 'chronobiology.phase.summary',
    payload: { phase: outputIndex },
    causeSequence: secondInput.sequence,
    causalParent: secondInput.id
  }));
  const blobsBeforeRollback = (await fs.readdir(
    path.join(root, 'blobs', 'sha256'),
    { recursive: true }
  )).filter(value => /^[0-9a-f]{64}$/.test(path.basename(String(value))));
  await assert.rejects(store.commitResidentCheckpoint({
    residencyId: 'resident:chronobiology',
    instanceId: 'chronobiology-atomic-fixture',
    version: '1.0.0-c3rc.1',
    stateSchema: 2,
    state: { stateSchema: 2, generation: 2 },
    consumerAck: {
      consumerId: 'resident:chronobiology',
      sequence: secondInput.sequence,
      transitionId: 'chronobiology-transition-2'
    },
    producerEpoch: 1,
    producerTransitionId: 'chronobiology-transition-2',
    outboxIntents: duplicateOutputs
  }));
  assert.equal(store.getResident('resident:chronobiology').checkpointGeneration, 1);
  assert.equal(
    store.getBiologicalDelivery('resident:chronobiology', secondInput.sequence).status,
    'PENDING'
  );
  assert.equal(
    Number(store.db.prepare(`
      SELECT COUNT(*) count
      FROM biological_outbox_intents
      WHERE producer_core_id='chronobiology'
    `).get().count),
    1
  );
  const blobsAfterRollback = (await fs.readdir(
    path.join(root, 'blobs', 'sha256'),
    { recursive: true }
  )).filter(value => /^[0-9a-f]{64}$/.test(path.basename(String(value))));
  assert.deepEqual(blobsAfterRollback.sort(), blobsBeforeRollback.sort());
});

test('terminal resident state, consumer deactivation, and evidence commit atomically', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-hardening-terminal-'));
  const store = new StateStore(root);
  await store.init();
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const hash = character => `sha256:${character.repeat(64)}`;
  store.registerResident({
    residencyId: 'resident:sntss',
    coreId: 'sntss',
    role: 'optional-shadow',
    instanceId: 'sntss-terminal-fixture',
    version: '0.5.0-i4g1',
    stateSchema: 5,
    moduleRelativePath: 'cores/sntss/i4g/index.js',
    moduleHash: hash('1'),
    manifestHash: hash('2'),
    packagePolicyHash: hash('3'),
    organismIdentityHash: hash('4')
  });
  store.setResidentStatus('resident:sntss', 'RUNNING');
  store.registerBiologicalConsumer({
    consumerId: 'resident:sntss',
    coreId: 'sntss',
    topics: ['runtime.time.pulse'],
    required: false,
    authorityEpoch: 0
  });

  store.db.exec(`
    CREATE TRIGGER force_terminal_record_failure
    BEFORE INSERT ON recovery_records
    WHEN NEW.type='resident.resync-required'
    BEGIN
      SELECT RAISE(ABORT, 'forced terminal evidence failure');
    END
  `);
  assert.throws(() => store.transitionResidentToTerminal({
    residencyId: 'resident:sntss',
    status: 'RESYNC_REQUIRED',
    recoveryType: 'resident.resync-required',
    coreId: 'sntss',
    detail: { sequence: 91, code: 'COREHOST_EXIT' }
  }));
  assert.equal(store.writeFailureCount, 1);
  assert.equal(store.getResident('resident:sntss').status, 'RUNNING');
  assert.equal(store.getBiologicalConsumer('resident:sntss').active, true);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) count FROM recovery_records WHERE type='resident.resync-required'").get().count,
    0
  );

  store.db.exec('DROP TRIGGER force_terminal_record_failure');
  const committed = store.transitionResidentToTerminal({
    residencyId: 'resident:sntss',
    status: 'RESYNC_REQUIRED',
    recoveryType: 'resident.resync-required',
    coreId: 'sntss',
    detail: { sequence: 91, code: 'COREHOST_EXIT' }
  });
  assert.equal(committed.resident.status, 'RESYNC_REQUIRED');
  assert.equal(committed.consumer.active, false);
  assert.equal(committed.consumer.required, false);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) count FROM recovery_records WHERE type='resident.resync-required'").get().count,
    1
  );
  assert.equal(store.writeFailureCount, 1, 'a later successful write must not erase fault history');
});

test('full resident lifecycle preserves inputs, outputs, and checkpoint state across database reopen', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-hardening-lifecycle-'));
  let store = new StateStore(root);
  let manager = null;
  t.after(async () => {
    await manager?.shutdown().catch(() => {});
    store?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await store.init();

  const hash = character => `sha256:${character.repeat(64)}`;
  const first = fixtureResidentManager(store);
  const instanceId = 'hardening-lifecycle-resident';
  first.resident.instanceId = instanceId;
  store.registerResident({
    residencyId: first.resident.residencyId,
    coreId: fixture.manifest.coreId,
    role: first.manager.contract.role,
    instanceId,
    version: fixture.manifest.version,
    stateSchema: fixture.manifest.stateSchema,
    moduleRelativePath: 'test/fixtures/stateful-core.js',
    moduleHash: hash('1'),
    manifestHash: hash('2'),
    packagePolicyHash: hash('3'),
    organismIdentityHash: first.manager.organismIdentityHash
  });

  const published = [];
  const fabric = {
    sequence: 0,
    subscribeAll() { return () => {}; },
    async publish(topic, payload, meta) {
      const result = store.appendBiologicalEvent({
        topic,
        payload,
        meta,
        eventClass: 'durable',
        at: Date.now()
      });
      this.sequence = Math.max(this.sequence, result.event.sequence);
      published.push(result.event);
      return result.event;
    }
  };
  first.manager.fabric = fabric;
  manager = first.manager;
  const firstUnit = await manager.startUnit({
    resident: first.resident,
    inspected: first.inspected,
    binding: first.binding
  });

  const inputEvents = [];
  async function deliver(unit, ordinal, emit = false) {
    const result = store.appendBiologicalEvent({
      topic: 'test.event',
      payload: { ordinal, emitBeforeDelay: emit },
      eventClass: 'durable',
      at: Date.now() + ordinal
    });
    fabric.sequence = Math.max(fabric.sequence, result.event.sequence);
    inputEvents.push(result.event);
    await unit.queue.enqueue(result.event);
  }

  await deliver(firstUnit, 1);
  await deliver(firstUnit, 2, true);
  await deliver(firstUnit, 3);
  assert.equal((await store.readResidentCheckpoint(first.resident.residencyId)).state.count, 3);
  assert.equal(published.length, 1);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) count FROM biological_outbox_intents WHERE status='PUBLISHED'").get().count,
    1
  );

  await manager.shutdown();
  manager = null;
  store.close();

  store = new StateStore(root);
  await store.init();
  const second = fixtureResidentManager(store);
  second.manager.fabric = fabric;
  manager = second.manager;
  const persistedResident = store.getResident(first.resident.residencyId);
  const persistedCheckpoint = await store.readResidentCheckpoint(first.resident.residencyId);
  assert.equal(persistedResident.instanceId, instanceId);
  assert.equal(persistedCheckpoint.state.count, 3);
  const secondUnit = await manager.startUnit({
    resident: persistedResident,
    inspected: second.inspected,
    binding: second.binding,
    checkpoint: persistedCheckpoint
  });
  assert.equal((await secondUnit.client.health()).count, 3);

  await deliver(secondUnit, 4);
  await deliver(secondUnit, 5, true);
  await deliver(secondUnit, 6);
  const finalCheckpoint = await store.readResidentCheckpoint(first.resident.residencyId);
  assert.equal(finalCheckpoint.state.count, 6);
  assert.equal(published.length, 2);
  assert.equal(new Set(published.map(event => event.id)).size, 2);
  assert.deepEqual(
    inputEvents.map(event =>
      store.getBiologicalDelivery(first.resident.residencyId, event.sequence).status
    ),
    Array(6).fill('ACKED')
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) count FROM biological_outbox_intents WHERE status='PUBLISHED'").get().count,
    2
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) count FROM biological_outbox_intents WHERE status='PENDING'").get().count,
    0
  );

  await manager.shutdown();
  manager = null;
  store.close();
  store = new StateStore(root);
  await store.init();
  assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal((await store.readResidentCheckpoint(first.resident.residencyId)).state.count, 6);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) count FROM recovery_records WHERE type='resident.shutdown-checkpoint-failed'").get().count,
    0
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) count FROM recovery_records WHERE type IN ('resident.shutdown-stop-failed', 'resident.startup-teardown-failed')").get().count,
    0
  );
});

test('resident reactivation atomically backfills every event from its inactive chronology gap', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-hardening-gap-'));
  const store = new StateStore(root);
  await store.init();
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  store.registerBiologicalConsumer({
    consumerId: 'resident:gap-fixture',
    coreId: 'gap-fixture',
    topics: ['runtime.time.pulse'],
    required: false,
    authorityEpoch: 0
  });

  const before = store.appendBiologicalEvent({
    topic: 'runtime.time.pulse',
    payload: { tick: 1 },
    eventClass: 'durable',
    at: Date.now()
  }).event;
  store.acknowledgeBiologicalEvent({
    consumerId: 'resident:gap-fixture',
    sequence: before.sequence,
    transitionId: 'gap-before'
  });
  assert.equal(store.getBiologicalConsumer('resident:gap-fixture').cursor, before.sequence);

  store.deactivateBiologicalConsumer('resident:gap-fixture');
  const gap = [2, 3].map(tick => store.appendBiologicalEvent({
    topic: 'runtime.time.pulse',
    payload: { tick },
    eventClass: 'durable',
    at: Date.now() + tick
  }).event);
  for (const event of gap) {
    assert.equal(
      store.getBiologicalDelivery('resident:gap-fixture', event.sequence),
      null
    );
  }

  const activation = store.registerBiologicalConsumer({
    consumerId: 'resident:gap-fixture',
    coreId: 'gap-fixture',
    topics: ['runtime.time.pulse'],
    required: false,
    authorityEpoch: 0,
    backfillInactiveGap: true
  });
  assert.equal(activation.activationBackfilled, gap.length);
  assert.equal(activation.active, true);
  assert.deepEqual(
    store.listPendingBiologicalEvents('resident:gap-fixture').map(event => event.sequence),
    gap.map(event => event.sequence)
  );

  const duplicateActivation = store.registerBiologicalConsumer({
    consumerId: 'resident:gap-fixture',
    coreId: 'gap-fixture',
    topics: ['runtime.time.pulse'],
    required: false,
    authorityEpoch: 0,
    backfillInactiveGap: true
  });
  assert.equal(duplicateActivation.activationBackfilled, 0);
});

test('durable outbox publication is single-flight across transition and heartbeat maintenance', async () => {
  const manager = Object.create(ResidentManager.prototype);
  const unit = { outboxDrainPromise: null };
  let calls = 0;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  manager.drainResidentOutbox = async () => {
    calls += 1;
    await blocked;
    return 7;
  };

  const drains = [1, 2, 3].map(() =>
    manager.drainResidentOutboxSingleFlight(unit)
  );
  await delay(10);
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all(drains), [7, 7, 7]);
  assert.equal(unit.outboxDrainPromise, null);

  manager.drainResidentOutbox = async () => { calls += 1; return 1; };
  assert.equal(await manager.drainResidentOutboxSingleFlight(unit), 1);
  assert.equal(calls, 2);
});

test('quiet committed outbox tails are retried by maintenance and persistent failure is health-visible', async () => {
  const recovery = [];
  const unit = {
    residencyId: 'resident:chronobiology',
    manifest: { coreId: 'chronobiology' },
    outboxFailureSignature: null
  };
  const manager = Object.create(ResidentManager.prototype);
  manager.closed = false;
  manager.units = new Map([[unit.residencyId, unit]]);
  manager.stateStore = {
    getResident: () => ({ status: 'RUNNING' }),
    recordRecovery: (...args) => recovery.push(args)
  };

  const publicationFailure = Object.assign(
    new Error('fabric unavailable'),
    { code: 'FABRIC_UNAVAILABLE' }
  );
  manager.drainResidentOutbox = async () => { throw publicationFailure; };

  await assert.rejects(
    manager.maintainResidentOutboxes(),
    error => error.code === 'RESIDENT_OUTBOX_MAINTENANCE' &&
      error.failures?.[0]?.residencyId === unit.residencyId
  );
  await assert.rejects(
    manager.maintainResidentOutboxes(),
    error => error.code === 'RESIDENT_OUTBOX_MAINTENANCE'
  );
  assert.equal(recovery.length, 1, 'an unchanged fault must not grow the recovery ledger every heartbeat');
  assert.equal(recovery[0][0], 'resident.outbox-pending');

  manager.drainResidentOutbox = async () => 1;
  assert.equal(await manager.maintainResidentOutboxes(), 1);
  assert.equal(unit.outboxFailureSignature, null);
});

test('post-commit retention failure cannot turn a durable transition into a replay', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-hardening-maintenance-'));
  const store = new StateStore(root);
  await store.init();
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const hash = character => `sha256:${character.repeat(64)}`;
  store.registerResident({
    residencyId: 'resident:sntss',
    coreId: 'sntss',
    role: 'optional-shadow',
    instanceId: 'sntss-maintenance-fixture',
    version: '0.5.0-i4g1',
    stateSchema: 5,
    moduleRelativePath: 'cores/sntss/i4g/index.js',
    moduleHash: hash('1'),
    manifestHash: hash('2'),
    packagePolicyHash: hash('3'),
    organismIdentityHash: hash('4')
  });
  store.setResidentStatus('resident:sntss', 'RUNNING');
  store.registerBiologicalConsumer({
    consumerId: 'resident:sntss',
    coreId: 'sntss',
    topics: ['runtime.time.pulse'],
    required: false,
    authorityEpoch: 0
  });

  const input = store.appendBiologicalEvent({
    topic: 'runtime.time.pulse',
    payload: { wallClockMs: 250 },
    eventClass: 'durable',
    at: Date.now()
  }).event;
  const originalPrune = store.pruneResidentCheckpoints.bind(store);
  store.pruneResidentCheckpoints = async () => {
    throw Object.assign(new Error('forced retention failure'), {
      code: 'RETENTION_FIXTURE'
    });
  };

  const committed = await store.commitResidentCheckpoint({
    residencyId: 'resident:sntss',
    instanceId: 'sntss-maintenance-fixture',
    version: '0.5.0-i4g1',
    stateSchema: 5,
    state: { stateSchema: 5, generation: 1 },
    consumerAck: {
      consumerId: 'resident:sntss',
      sequence: input.sequence,
      transitionId: 'sntss-maintenance-transition-1'
    },
    producerTransitionId: 'sntss-maintenance-transition-1'
  });
  assert.equal(committed.generation, 1);
  assert.equal(
    store.getBiologicalDelivery('resident:sntss', input.sequence).status,
    'ACKED'
  );
  assert.equal(store.getResident('resident:sntss').checkpointGeneration, 1);
  assert.equal(store.maintenanceErrors.size, 1);
  await store.heartbeat({ runtimeRevision: 111 });
  const unhealthy = await store.persistenceStatus();
  assert.equal(unhealthy.ok, false);
  assert.equal(unhealthy.maintenanceErrors[0].code, 'RETENTION_FIXTURE');

  store.pruneResidentCheckpoints = originalPrune;
  const nextInput = store.appendBiologicalEvent({
    topic: 'runtime.time.pulse',
    payload: { wallClockMs: 500 },
    eventClass: 'durable',
    at: Date.now() + 1
  }).event;
  const next = await store.commitResidentCheckpoint({
    residencyId: 'resident:sntss',
    instanceId: 'sntss-maintenance-fixture',
    version: '0.5.0-i4g1',
    stateSchema: 5,
    state: { stateSchema: 5, generation: 2 },
    consumerAck: {
      consumerId: 'resident:sntss',
      sequence: nextInput.sequence,
      transitionId: 'sntss-maintenance-transition-2'
    },
    producerTransitionId: 'sntss-maintenance-transition-2'
  });
  assert.equal(next.generation, 2);
  assert.equal(store.maintenanceErrors.size, 0);
});

test('a failed durable commit discards pending output intent and reconstructs the worker', async () => {
  let recycled = 0;
  let recoveryAdvanced = 0;
  const manager = {
    stateStore: {
      commitResidentCheckpoint: async () => {
        throw Object.assign(new Error('forced transaction failure'), { code: 'SQLITE_BUSY' });
      }
    },
    withRouteCompleteness: ResidentManager.prototype.withRouteCompleteness,
    handleSignallingOutput: ResidentManager.prototype.handleSignallingOutput,
    tryDrainResidentOutbox: async () => 0
  };
  const unit = {
    residencyId: 'resident:chronobiology',
    resident: { instanceId: 'chronobiology-instance' },
    manifest: {
      coreId: 'chronobiology', version: '1.0.0-c3rc.1', stateSchema: 2,
      outputs: ['chronobiology.phase.summary']
    },
    contract: {
      signalling: 'LAB_SHADOW_ONLY', producerEpoch: 1, routeCompleteness: false
    },
    outputViolation: false,
    pendingOutputIntents: new Map(),
    replaySequence: null,
    observedOutputs: 0,
    handledEvents: 0,
    client: {
      dispatch: async (_event, context) => {
        manager.handleSignallingOutput(unit, {
          topic: 'chronobiology.phase.summary', payload: { phase: 9 },
          meta: { outputIndex: 1 }, context
        });
        return { checkpoint: { stateSchema: 2, phase: 9 } };
      },
      recycle: async () => { recycled += 1; },
      setRecoveryState: () => { recoveryAdvanced += 1; }
    }
  };
  const event = {
    id: 'pulse-9', sequence: 9, topic: 'runtime.trusted-organism-time.pulse',
    class: 'durable', ledger: { durable: true }
  };
  await assert.rejects(
    ResidentManager.prototype.processEvent.call(manager, unit, event),
    error => error.code === 'RESIDENT_COMMIT_FAILED' && error.cause?.code === 'SQLITE_BUSY'
  );
  assert.equal(recycled, 1);
  assert.equal(recoveryAdvanced, 0);
  assert.equal(unit.pendingOutputIntents.size, 0);
  assert.equal(unit.handledEvents, 0);
});

test('health deadline starts when serialized health work begins, not while an event is queued', async t => {
  const client = new CoreHostClient({
    modulePath: FIXTURE_PATH,
    expectedManifest: fixture.manifest,
    instanceId: 'serialized-health-fixture',
    policy: { resources: fixture.manifest.resources, priority: fixture.manifest.priority },
    logger: { log() {}, info() {}, warn() {}, error() {} }
  });
  client.on('error', () => {});
  t.after(() => client.stop().catch(() => {}));
  await client.start({ count: 0 }, 1);

  const event = client.dispatch(
    {
      id: 'slow-but-bounded',
      sequence: 1,
      topic: 'test.event',
      class: 'durable',
      /* Longer than the 50 ms health deadline, but with ample IPC headroom. */
      payload: { delayMs: 500 }
    },
    { eventSequence: 1 }
  );
  const health = client.health();
  const [transition, healthValue] = await Promise.all([event, health]);
  assert.deepEqual(transition.checkpoint, { count: 1 });
  assert.deepEqual(healthValue, { ok: true, count: 1 });
  assert.equal(client.generation, 1);
});

test('serialized status work cannot enter a recovering CoreHost generation', async () => {
  const client = Object.create(CoreHostClient.prototype);
  client.operationChain = Promise.resolve();
  let releaseRecovery;
  client.recoveryPromise = new Promise(resolve => { releaseRecovery = resolve; });
  let entered = false;
  const health = client.serializeOperation('health', async () => {
    entered = true;
    return { ok: true };
  });
  await delay(20);
  assert.equal(entered, false);
  releaseRecovery({ generation: 2 });
  assert.deepEqual(await health, { ok: true });
  assert.equal(entered, true);
});

test('terminal resync is idempotent and closes the resident queue once', () => {
  const calls = { terminal: 0, stop: 0, close: 0 };
  const stateStore = {
    getResident: () => ({ status: 'RUNNING' })
  };
  const manager = {
    stateStore,
    persistTerminalTransition: () => { calls.terminal += 1; return true; },
    stopTerminalUnit: () => { calls.stop += 1; }
  };
  const unit = {
    residencyId: 'resident:sntss',
    manifest: { coreId: 'sntss' },
    queue: { close: () => { calls.close += 1; } },
    resyncRequired: false,
    lastError: null
  };
  const mark = ResidentManager.prototype.markResyncRequired.bind(manager);
  assert.equal(mark(unit, Object.assign(new Error('fault'), { code: 'CORE_WORKER_EXIT' }), { sequence: 9 }), true);
  assert.equal(mark(unit, Object.assign(new Error('offline'), { code: 'COREHOST_OFFLINE' }), { sequence: 10 }), false);
  assert.deepEqual(calls, { terminal: 1, stop: 1, close: 1 });
});

test('resident control preserves durability and activation evidence at the public status boundary', async () => {
  const contract = {
    residencyId: 'resident:sntss',
    coreId: 'sntss',
    version: '0.5.0-i4g1',
    stateSchema: 5,
    priority: 'optional',
    productionEligible: false,
    signalling: 'FORBIDDEN',
    outputs: []
  };
  const durabilityContract = {
    eventCheckpointConsumerAckAtomic: true,
    activationGapBackfillAtomic: true,
    outboxPublicationSingleFlight: true,
    startupFailureTeardownComplete: true
  };
  const record = {
    residencyId: contract.residencyId,
    moduleRelativePath: 'cores/sntss/i4g/index.js',
    status: 'RUNNING',
    checkpointGeneration: 17,
    checkpointHash: 'fixture-checkpoint'
  };
  const runtimeUnit = { lifecycle: 'standby', terminalPersistenceError: null };
  const manager = {
    contractRegistry: { byResidencyId: new Map([[contract.residencyId, contract]]) },
    units: new Map([[contract.residencyId, runtimeUnit]]),
    async status() {
      return {
        running: !runtimeUnit.terminalPersistenceError,
        observedOutputs: 0,
        authorityOwned: false,
        handledEvents: 9,
        health: { ok: true },
        queue: { failed: 0 },
        host: { pid: 123 },
        terminalPersistenceError: runtimeUnit.terminalPersistenceError,
        durabilityContract,
        activationBackfilled: 4
      };
    }
  };
  const kernel = {
    ensureResidentManager: () => manager,
    stateStore: { getResident: () => record }
  };
  const status = await statusFor(kernel, contract.residencyId);
  assert.deepEqual(status.durabilityContract, durabilityContract);
  assert.equal(status.activationBackfilled, 4);
  assert.equal(status.running, true);
  runtimeUnit.terminalPersistenceError = { code: 'SQLITE_BUSY' };
  const failed = await statusFor(kernel, contract.residencyId);
  assert.equal(failed.running, false);
  assert.equal(failed.terminalPersistenceError.code, 'SQLITE_BUSY');
});

test('resident shutdown checkpoint failure becomes durable recovery evidence', async () => {
  const records = [];
  let queueClosed = false;
  let clientStopped = false;
  const manager = {
    closed: false,
    unsubscribe() {},
    fabric: { sequence: 91 },
    units: new Map([['resident:sntss', {
      residencyId: 'resident:sntss',
      queue: {
        async drainThrough(sequence) { assert.equal(sequence, 91); },
        close() { queueClosed = true; }
      },
      client: {
        async snapshot() {
          throw Object.assign(new Error('injected shutdown snapshot failure'), {
            code: 'CORE_WORKER_EXIT'
          });
        },
        async stop() {
          clientStopped = true;
          throw Object.assign(new Error('injected shutdown stop failure'), {
            code: 'COREHOST_STOP_TIMEOUT'
          });
        }
      }
    }]]),
    stateStore: {
      getResident() {
        return {
          residencyId: 'resident:sntss',
          instanceId: 'shutdown-fixture',
          coreId: 'sntss',
          version: '0.5.0-i4g1',
          stateSchema: 5,
          status: 'RUNNING',
          checkpointGeneration: 44
        };
      },
      recordRecovery(type, coreId, detail) { records.push({ type, coreId, detail }); }
    },
    logger: { warn() {} }
  };

  await ResidentManager.prototype.shutdown.call(manager);
  assert.equal(manager.closed, true);
  assert.equal(manager.units.size, 0);
  assert.equal(queueClosed, true);
  assert.equal(clientStopped, true);
  assert.deepEqual(records, [
    {
      type: 'resident.shutdown-checkpoint-failed',
      coreId: 'sntss',
      detail: {
        residencyId: 'resident:sntss',
        instanceId: 'shutdown-fixture',
        checkpointGeneration: 44,
        code: 'CORE_WORKER_EXIT',
        message: 'injected shutdown snapshot failure'
      }
    },
    {
      type: 'resident.shutdown-stop-failed',
      coreId: 'sntss',
      detail: {
        residencyId: 'resident:sntss',
        instanceId: 'shutdown-fixture',
        code: 'COREHOST_STOP_TIMEOUT',
        message: 'injected shutdown stop failure'
      }
    }
  ]);
});

function benchmarkSample({ generation = 10, capturedAt = '2026-08-25T00:00:00.000Z' } = {}) {
  const memoryPlan = {
    accounting: 'payload-cgroup-plus-kernel-supervisor',
    cgroupSoftBytes: 64 * MIB,
    cgroupHardBytes: 96 * MIB
  };
  const resident = (version, processes, supervisorPid) => ({
    version,
    status: 'RUNNING',
    running: true,
    authorityOwned: false,
    checkpointGeneration: generation,
    handledEvents: generation,
    observedOutputs: version.startsWith('0.5') ? 0 : 1,
    health: { ok: true },
    resyncRequired: false,
    queue: {
      failed: 0,
      timedOut: 0,
      stalled: 0,
      recovered: 0,
      recoveryRejected: 0,
      recoveryTimedOut: 0
    },
    durabilityContract: {
      eventCheckpointConsumerAckAtomic: true,
      outboxIntentInSameCommit: true,
      biologicalPublicationFromCommittedOutboxOnly: true,
      recoveryImageAdvancesAfterCommitOnly: true,
      activationGapBackfillAtomic: true,
      outboxPublicationSingleFlight: true,
      startupFailureTeardownComplete: true
    },
    host: {
      pid: supervisorPid,
      deadlineContract: {
        workerTransitionTimeoutMs: 250,
        ipcTransitionTimeoutMs: 1000,
        eventAndCheckpointCombined: true,
        outputsReleasedAfterCheckpoint: true
      },
      osContainment: {
        memoryPlan,
        required: true,
        available: true,
        payloadPids: processes,
        payloadAttachedBeforeInit: true,
        payloadQuiescedBeforeSpawn: true
      }
    },
    processes
  });
  const sntss = resident('0.5.0-i4g1', [11, 12], 101);
  const chronobiology = resident('1.0.0-c3rc.1', [21, 22], 102);
  return {
    capturedAt,
    health: { ok: true, revision: 111 },
    meta: {
      revisionFrozen: true,
      revisionLabel: 'R111F',
      systems: [{
        id: 'bsf', mode: 'LIVE', status: 'RUNNING', running: true,
        healthOk: true, writeFailures: 0
      }],
      residents: [
        { residencyId: 'resident:sntss', running: true, mode: 'SHADOW' },
        { residencyId: 'resident:chronobiology', running: true, mode: 'SHADOW' }
      ]
    },
    residents: { sntss, chronobiology },
    database: {
      quickCheck: 'ok',
      pendingDeliveries: 0,
      failedDeliveries: 0,
      pendingOutboxIntents: 0,
      sntssAuthorityRows: 0,
      chronobiologyAuthorityRows: 0,
      sntssOutputRows: 0,
      chronobiologyOutputRows: 1,
      sntssCoreHostFaults: 100,
      sntssCoreHostTimeouts: 50,
      chronobiologyCoreHostFaults: 10,
      chronobiologyCoreHostTimeouts: 5,
      sntssResyncRows: 8,
      chronobiologyResyncRows: 2,
      sntssDeliveryRetryRows: 12,
      chronobiologyDeliveryRetryRows: 1,
      maintenanceFailureRows: 4,
      startupTeardownFailureRows: 0,
      detachTeardownFailureRows: 0,
      terminalTeardownFailureRows: 0,
      shutdownCheckpointFailureRows: 0,
      shutdownStopFailureRows: 0,
      outboxPendingRows: 7,
      duplicateResyncGroups: 3,
      recoveryWatermarks: {
        sntssCoreHostFaults: 1000,
        sntssCoreHostTimeouts: 1000,
        chronobiologyCoreHostFaults: 900,
        chronobiologyCoreHostTimeouts: 900,
        sntssResyncRows: 800,
        chronobiologyResyncRows: 700,
        sntssDeliveryRetryRows: 600,
        chronobiologyDeliveryRetryRows: 500,
        maintenanceFailureRows: 400,
        startupTeardownFailureRows: 0,
        detachTeardownFailureRows: 0,
        terminalTeardownFailureRows: 0,
        shutdownCheckpointFailureRows: 0,
        shutdownStopFailureRows: 0,
        outboxPendingRows: 300
      }
    },
    service: {
      pid: 500,
      processTicks: generation,
      systemTicks: generation * 100,
      rssBytes: 80 * MIB,
      cgroup: {
        required: true,
        delegateSubgroup: 'stay-kernel',
        parentProcesses: [],
        subtreeControl: 'cpu memory pids',
        memoryCurrent: 240 * MIB,
        kernelProcesses: [500, 101, 102],
        sntss: {
          ambiguous: false,
          activeLeafCount: 1,
          processes: [11, 12],
          memoryCurrent: 90 * MIB,
          memoryPeak: 95 * MIB,
          memoryHigh: String(memoryPlan.cgroupSoftBytes),
          memoryMax: String(memoryPlan.cgroupHardBytes),
          pidsCurrent: 2,
          pidsMax: '16',
          cpuMax: '20000 100000',
          memoryEvents: { low: 0, high: 4, max: 0, oom: 0, oom_kill: 0 },
          pidsEvents: { max: 2 },
          cpuStat: {
            usage_usec: generation * 1000,
            nr_periods: generation * 10,
            nr_throttled: 3,
            throttled_usec: 300
          }
        },
        chronobiology: {
          ambiguous: false,
          activeLeafCount: 1,
          processes: [21, 22],
          memoryCurrent: 70 * MIB,
          memoryPeak: 75 * MIB,
          memoryHigh: String(memoryPlan.cgroupSoftBytes),
          memoryMax: String(memoryPlan.cgroupHardBytes),
          pidsCurrent: 2,
          pidsMax: '16',
          cpuMax: '20000 100000',
          memoryEvents: { low: 0, high: 1, max: 0, oom: 0, oom_kill: 0 },
          pidsEvents: { max: 0 },
          cpuStat: {
            usage_usec: generation * 500,
            nr_periods: generation * 10,
            nr_throttled: 1,
            throttled_usec: 100
          }
        }
      }
    },
    databaseBytes: 8 * MIB,
    databaseWalBytes: 1 * MIB,
    databaseTotalBytes: 9 * MIB
  };
}

function terminalR110BenchmarkFixture() {
  const startedAt = '2026-08-24T16:42:18.454Z';
  const capturedAt = '2026-08-27T16:42:22.647Z';
  const evidence = {
    format: 'stay-physiology-benchmark-milestone-v2',
    milestone: '72h',
    result: 'OBSERVED_FAILURES',
    recoveryAware: true,
    startedAt,
    capturedAt,
    elapsedMs: 259204207,
    runtimeRevision: 110,
    samples: 4311,
    failures: 3596,
    observedFailureCount: 3606,
    progressOk: true,
    coreHostFaults: { sntss: 6, chronobiology: 0 },
    coreHostTimeouts: { sntss: 4, chronobiology: 0 },
    processTransitions: { main: 0, sntss: 4, chronobiology: 0 },
    final: {
      health: { ok: true, revision: 110 },
      meta: {
        revision: 110,
        revisionFrozen: true,
        revisionLabel: 'R110F',
        systems: [{
          id: 'bsf', mode: 'LIVE', status: 'RUNNING', running: true, healthOk: true
        }],
        residents: [
          {
            residencyId: 'resident:chronobiology', version: '1.0.0-c3rc.1',
            status: 'RUNNING', running: true, mode: 'SHADOW', authorityOwned: false,
            observedOutputs: 290, healthOk: true
          },
          {
            residencyId: 'resident:sntss', version: '0.5.0-i4g1',
            status: 'RESYNC_REQUIRED', running: false, mode: 'SHADOW', authorityOwned: false,
            observedOutputs: 0, healthOk: true
          }
        ]
      },
      database: {
        quickCheck: 'ok', pendingDeliveries: 0, failedDeliveries: 0,
        sntssAuthorityRows: 0, chronobiologyAuthorityRows: 0, sntssOutputRows: 0
      }
    }
  };
  const state = {
    format: 'stay-physiology-benchmark-state-v2',
    startedAt,
    runtimeRevision: 110,
    samples: 4311,
    failures: 3596,
    milestones: { '72h': capturedAt },
    sntssCoreHostFaults: 6,
    chronobiologyCoreHostFaults: 0,
    sntssCoreHostTimeouts: 4,
    chronobiologyCoreHostTimeouts: 0,
    sntssProcessTransitions: 4,
    chronobiologyProcessTransitions: 0,
    mainPidTransitions: 0
  };
  return { evidence, state };
}

test('completed R110 benchmark acceptance is exact, terminal, and authority-contained', () => {
  const { evidence, state } = terminalR110BenchmarkFixture();
  assert.deepEqual(liveProof.validateTerminalBenchmark(evidence, state, 4311), {
    elapsedMs: 259204207,
    samples: 4311,
    failures: 3596,
    observedFailureCount: 3606,
    completedAt: '2026-08-27T16:42:22.647Z'
  });

  const mutations = [
    value => { value.evidence.result = 'PASS'; },
    value => { value.evidence.elapsedMs = 72 * 60 * 60 * 1000 - 1; },
    value => { value.evidence.final.meta.systems[0].healthOk = false; },
    value => { value.evidence.final.meta.residents[0].authorityOwned = true; },
    value => { value.evidence.final.meta.residents[1].running = true; },
    value => { value.evidence.final.meta.residents[1].observedOutputs = 1; },
    value => { value.evidence.final.database.quickCheck = 'corrupt'; },
    value => { value.evidence.final.database.sntssAuthorityRows = 1; },
    value => { value.evidence.final.database.failedDeliveries = 1; },
    value => { value.state.samples = 4310; },
    value => { value.state.sntssCoreHostFaults = 5; },
    value => { value.sampleLedgerRecords = 4310; }
  ];
  for (const mutate of mutations) {
    const candidate = {
      evidence: structuredClone(evidence),
      state: structuredClone(state),
      sampleLedgerRecords: 4311
    };
    mutate(candidate);
    assert.throws(
      () => liveProof.validateTerminalBenchmark(
        candidate.evidence,
        candidate.state,
        candidate.sampleLedgerRecords
      ),
      error => error?.code === 'P1_PRODUCTION_HARDENING_R110_TERMINAL_EVIDENCE'
    );
  }
});

test('benchmark v3 baselines history and fails on new nested/resource/process faults', () => {
  const previousExpected = process.env.STAY_PHYSIOLOGY_EXPECT_SNTSS_VERSION;
  process.env.STAY_PHYSIOLOGY_EXPECT_SNTSS_VERSION = '0.5.0-i4g1';
  try {
    const baseline = benchmarkSample();
    const state = benchmark.initialState(baseline);
    const healthy = benchmarkSample({ generation: 11, capturedAt: '2026-08-25T00:01:00.000Z' });
    benchmark.updateState(state, healthy, 60_000);
    assert.equal(benchmark.observedFailures(state), 0);
    assert.equal(benchmark.summary(state, healthy, '15m', 900_000).result, 'PASS');

    const faulted = benchmarkSample({ generation: 12, capturedAt: '2026-08-25T00:02:00.000Z' });
    faulted.database.sntssCoreHostFaults += 1;
    faulted.database.sntssCoreHostTimeouts += 1;
    faulted.database.sntssDeliveryRetryRows += 1;
    faulted.database.maintenanceFailureRows += 1;
    faulted.database.startupTeardownFailureRows += 1;
    faulted.database.detachTeardownFailureRows += 1;
    faulted.database.terminalTeardownFailureRows += 1;
    faulted.database.shutdownCheckpointFailureRows += 1;
    faulted.database.shutdownStopFailureRows += 1;
    faulted.database.outboxPendingRows += 1;
    faulted.database.duplicateResyncGroups += 1;
    faulted.service.cgroup.sntss.memoryEvents.high += 1;
    faulted.service.cgroup.sntss.pidsEvents.max += 1;
    faulted.service.cgroup.sntss.cpuStat.nr_throttled += 1;
    faulted.service.cgroup.sntss.processes = [31, 32];
    benchmark.updateState(state, faulted, 120_000);
    const evidence = benchmark.summary(state, faulted, '15m', 900_000);
    assert.equal(evidence.result, 'OBSERVED_FAILURES');
    assert.equal(evidence.coreHostFaults.sntss, 1);
    assert.equal(evidence.recoveryRecords.deliveryRetries.sntss, 1);
    assert.equal(evidence.recoveryRecords.maintenanceFailures, 1);
    assert.equal(evidence.recoveryRecords.startupTeardownFailures, 1);
    assert.equal(evidence.recoveryRecords.detachTeardownFailures, 1);
    assert.equal(evidence.recoveryRecords.terminalTeardownFailures, 1);
    assert.equal(evidence.recoveryRecords.shutdownCheckpointFailures, 1);
    assert.equal(evidence.recoveryRecords.shutdownStopFailures, 1);
    assert.equal(evidence.recoveryRecords.outboxPublicationFailures, 1);
    assert.equal(evidence.recoveryRecords.duplicateResyncGroups, 1);
    assert.equal(evidence.cgroupMemoryEvents.sntss.high, 1);
    assert.equal(evidence.cgroupPidsEvents.sntss.max, 1);
    assert.equal(evidence.cgroupCpuThrottleEvents.sntss.periods, 1);
    assert.equal(evidence.processTransitions.sntss, 1);

    state.collectorStarts = 2;
    state.collectorRestarts = 1;
    assert.equal(benchmark.summary(state, faulted, '12h', 43_200_000).collector.restarts, 1);
    assert.ok(benchmark.observedFailures(state) >= 1);

    const contractBaseline = benchmarkSample();
    const contractState = benchmark.initialState(contractBaseline);
    const contractBroken = benchmarkSample({
      generation: 11,
      capturedAt: '2026-08-25T00:01:00.000Z'
    });
    contractBroken.residents.sntss.durabilityContract.outboxIntentInSameCommit = false;
    benchmark.updateState(contractState, contractBroken, 60_000);
    assert.equal(contractState.failures, 1);
    assert.equal(
      benchmark.summary(contractState, contractBroken, '15m', 900_000).result,
      'OBSERVED_FAILURES'
    );

    const stuckBaseline = benchmarkSample();
    const stuckState = benchmark.initialState(stuckBaseline);
    const stuck = benchmarkSample({
      generation: 11,
      capturedAt: '2026-08-25T00:01:00.000Z'
    });
    stuck.database.pendingOutboxIntents = 1;
    benchmark.updateState(stuckState, stuck, 60_000);
    assert.equal(stuckState.failures, 1);
    assert.equal(stuckState.maxPendingOutboxIntents, 1);
    assert.equal(
      benchmark.summary(stuckState, stuck, '15m', 900_000).result,
      'OBSERVED_FAILURES'
    );

    const retentionBaseline = benchmarkSample();
    const retentionState = benchmark.initialState(retentionBaseline);
    const retainedFault = benchmarkSample({
      generation: 11,
      capturedAt: '2026-08-25T00:01:00.000Z'
    });
    retainedFault.database.sntssCoreHostFaults -= 1;
    retainedFault.database.recoveryWatermarks.sntssCoreHostFaults += 10;
    benchmark.updateState(retentionState, retainedFault, 60_000);
    assert.equal(retentionState.sntssCoreHostFaults, 1);
    assert.equal(
      benchmark.summary(retentionState, retainedFault, '15m', 900_000).result,
      'OBSERVED_FAILURES'
    );

    const writeBaseline = benchmarkSample();
    const writeState = benchmark.initialState(writeBaseline);
    const writeFault = benchmarkSample({
      generation: 11,
      capturedAt: '2026-08-25T00:01:00.000Z'
    });
    writeFault.meta.systems[0].writeFailures = 1;
    benchmark.updateState(writeState, writeFault, 60_000);
    assert.equal(writeState.failures, 1);
  } finally {
    if (previousExpected == null) delete process.env.STAY_PHYSIOLOGY_EXPECT_SNTSS_VERSION;
    else process.env.STAY_PHYSIOLOGY_EXPECT_SNTSS_VERSION = previousExpected;
  }
});

test('benchmark evidence is durable and corruption cannot reset its history', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-hardening-benchmark-evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const samplesFile = path.join(root, 'samples.jsonl');

  benchmark.writeAtomic(stateFile, { format: 'fixture', samples: 1 });
  assert.deepEqual(benchmark.readEvidenceJson(stateFile), { format: 'fixture', samples: 1 });
  const evidenceMode = (await fs.stat(stateFile)).mode & 0o777;
  if (process.platform === 'win32') {
    assert.equal(evidenceMode & 0o222, 0);
    assert.notEqual(evidenceMode & 0o400, 0);
  } else {
    assert.equal(evidenceMode, 0o400);
  }
  assert.deepEqual(
    (await fs.readdir(root)).filter(name => name.includes('.tmp-')),
    []
  );

  await fs.writeFile(samplesFile, '{"sample":1}\n', { mode: 0o400 });
  assert.equal(benchmark.countJsonLines(samplesFile), 1);

  await fs.chmod(stateFile, 0o600);
  await fs.writeFile(stateFile, '{"format":');
  assert.throws(
    () => benchmark.readEvidenceJson(stateFile),
    error => error?.code === 'P1_PHYSIOLOGY_BENCHMARK_EVIDENCE_CORRUPT'
  );

  await fs.chmod(samplesFile, 0o600);
  await fs.writeFile(samplesFile, '{"sample":1}');
  assert.throws(
    () => benchmark.countJsonLines(samplesFile),
    error => error?.code === 'P1_PHYSIOLOGY_BENCHMARK_EVIDENCE_CORRUPT'
  );
});

test('benchmark main PID selection rejects stale pidfiles and never mistakes a supervisor for the service', () => {
  const values = new Map([
    ['/run/stay/main.pid', '99'],
    ['/proc/20/cmdline', 'node\0runtime/core-host/host.js\0'],
    ['/proc/21/cmdline', 'node\0/opt/stay/current/server-secure.js\0']
  ]);
  const read = file => values.get(file) ?? null;
  assert.equal(benchmark.mainServicePid([20, 21], {}, read), 21);
  values.set('/proc/21/cmdline', 'node\0unrelated.js\0');
  assert.equal(benchmark.mainServicePid([20, 21], { pid: 22 }, read), null);
  assert.equal(benchmark.mainServicePid([20, 21], { pid: 20 }, read), 20);
});

test('benchmark exposes multiple live payload cgroup generations instead of selecting one', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-hardening-cgroup-observation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, processes] of [
    ['sntss-generation-a', '101\n102\n'],
    ['sntss-generation-b', '201\n202\n']
  ]) {
    const directory = path.join(root, name);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'cgroup.procs'), processes);
  }
  const ambiguous = benchmark.cgroupLeaf('sntss', root);
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.activeLeafCount, 2);
  assert.deepEqual(ambiguous.processes, [101, 102, 201, 202]);

  await fs.writeFile(path.join(root, 'sntss-generation-a', 'cgroup.procs'), '');
  const exact = benchmark.cgroupLeaf('sntss', root);
  assert.equal(exact.ambiguous, false);
  assert.equal(exact.activeLeafCount, 1);
  assert.deepEqual(exact.processes, [201, 202]);
});

test('the release overlay promotes the complete CoreHost cohort atomically', async () => {
  const forward = await fs.readFile(
    path.join(
      __dirname,
      '..',
      'deploy',
      'live-physiology-transplant',
      'p1-production-hardening-forward.sh'
    ),
    'utf8'
  );
  const overlay = forward.slice(
    forward.indexOf('PRODUCTION_OVERLAY_FILES=('),
    forward.indexOf('RELEASE_AUXILIARY_FILES=(')
  );
  for (const relative of [
    'runtime/core-host/host.js',
    'runtime/core-host/host-legacy.js',
    'runtime/core-host/sandbox-host.js',
    'runtime/core-host/worker.js',
    'runtime/kernel/core-host-client.js',
    'runtime/kernel/core-sandbox.js',
    'runtime/kernel/manifest.js',
    'runtime/kernel/package-policy.js',
    'runtime/kernel/protocol.js',
    'runtime/kernel/resource-governor.js'
  ]) {
    assert.ok(
      overlay.includes(`'${relative}'`),
      `CoreHost cohort member is absent from the production overlay: ${relative}`
    );
  }
});

test('the frozen I4-G1 package retains exact physiology through the hardened commit fence', async t => {
  const pulseCount = 5_000;
  const sustainedPulseIntervalMs = 50;
  const modulePath = path.join(__dirname, '..', 'cores', 'sntss', 'i4g', 'index.js');
  const definition = require(modulePath);
  const { createState } = require('../cores/sntss/i4g/durable-state');
  const identitySha256 = `sha256:${'1'.repeat(64)}`;
  const client = new CoreHostClient({
    modulePath,
    expectedManifest: definition.manifest,
    instanceId: 'i4g-hardened-continuity',
    policy: { resources: definition.manifest.resources, priority: definition.manifest.priority },
    logger: { log() {}, info() {}, warn() {}, error() {} }
  });
  let outputs = 0;
  const resourceWarnings = [];
  const lifecycleTransitions = [];
  const clientErrors = [];
  client.on('output', () => { outputs += 1; });
  client.on('resource-warning', detail => { resourceWarnings.push(detail); });
  client.on('lifecycle', (lifecycle, detail) => {
    lifecycleTransitions.push({ lifecycle, detail: detail || null });
  });
  client.on('error', error => {
    clientErrors.push({ code: error?.code || null, message: error?.message || String(error) });
  });
  let replayClient = null;
  t.after(async () => {
    await client.stop().catch(() => {});
    await replayClient?.stop().catch(() => {});
  });
  await client.start(createState(), 5);

  const binding = {
    id: 'binding',
    sequence: 1,
    class: 'critical',
    topic: 'runtime.organism.binding',
    at: 1000,
    payload: {
      bindingVersion: 1,
      identitySha256,
      organismLineage: 'STAY/Genesis',
      issuedAt: 1000,
      runtimeRevision: 108,
      authorityEpoch: 1,
      kernelVersion: '0.8.11.3'
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 1 }
  };
  const bound = await client.dispatch(binding, { eventSequence: binding.sequence });
  client.setRecoveryState(bound.checkpoint, 5);

  const genesis = {
    id: 'genesis',
    sequence: 2,
    class: 'durable',
    topic: 'runtime.sntss.continuity-genesis',
    at: 1001,
    ledger: { durable: true },
    payload: {
      formatVersion: 1,
      authorization: 'R13_SNTSS_CONTINUITY_GENESIS_SHADOW',
      organismIdentitySha256: identitySha256,
      parentFreezeRevision: 105,
      parentFreezeRecordSha256: 'sha256:78021d86da8038e298fedb46b7371a46e1bc1e4d1cb0624205a864877ca22875',
      runtimeRevision: 108,
      seedHex: '2'.repeat(64),
      sourceCheckpointGeneration: 1,
      sourceCheckpointHash: `sha256:${'3'.repeat(64)}`
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 108 }
  };
  const born = await client.dispatch(genesis, { eventSequence: genesis.sequence });
  client.setRecoveryState(born.checkpoint, 5);
  assert.equal(born.checkpoint.individuality.authorityMode, 'NONE');
  assert.equal(born.checkpoint.individuality.outputs, 0);
  const startingClock = born.checkpoint.chemistry.modelClock;

  const anchorAt = 60_000;
  const anchored = await client.dispatch({
    id: 'pulse-1', sequence: 3, class: 'durable', topic: 'runtime.time.pulse', at: anchorAt,
    payload: { wallClockMs: anchorAt, runtimeRevision: 111, pulseSequence: 1, clockStatus: 'trusted' },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 111 }
  }, { eventSequence: 3 });
  client.setRecoveryState(anchored.checkpoint, 5);

  const acceleratedStartedAt = Date.now();
  let final;
  for (let index = 1; index <= pulseCount; index += 1) {
    const wallClockMs = anchorAt + index * 250;
    final = await client.dispatch({
      id: `pulse-${index + 1}`,
      sequence: index + 3,
      class: 'durable',
      topic: 'runtime.time.pulse',
      at: wallClockMs,
      payload: {
        wallClockMs,
        runtimeRevision: 111,
        pulseSequence: index + 1,
        clockStatus: 'trusted'
      },
      meta: { sourceCore: 'living-kernel', authorityEpoch: 111 }
    }, { eventSequence: index + 3 });
    /*
     * CoreHostClient deliberately advances its recovery watermark only after
     * the caller's atomic StateStore commit. This isolated proof is that
     * caller, so every accepted combined event/checkpoint is committed before
     * another event or a possible resource recycle can observe it.
     */
    client.setRecoveryState(final.checkpoint, 5);
    if (index < pulseCount) {
      await delay(sustainedPulseIntervalMs);
    }
  }
  const acceleratedElapsedMs = Date.now() - acceleratedStartedAt;
  const host = client.status();
  const diagnostic = JSON.stringify({
    generation: client.generation,
    lifecycle: host.lifecycle,
    lastExit: host.lastExit,
    resourceGovernor: host.resourceGovernor,
    resourceWarnings: resourceWarnings.slice(-8),
    lifecycleTransitions,
    clientErrors
  });
  assert.equal(client.generation, 1, `unexpected CoreHost recycle during sustained proof: ${diagnostic}`);
  assert.equal(host.resourceGovernor.lastAction, null, `resource hard action during sustained proof: ${diagnostic}`);
  assert.equal(final.checkpoint.chemistry.modelClock, startingClock + 1_250_000);
  assert.equal(final.checkpoint.receptorAdaptation.modelClock, startingClock + 1_250_000);
  assert.equal(final.checkpoint.receptorAvailability.modelClock, startingClock + 1_250_000);
  assert.equal(final.checkpoint.individuality.genesisEventId, 'genesis');
  assert.equal(outputs, 0);
  assert.ok(acceleratedElapsedMs >= (pulseCount - 1) * sustainedPulseIntervalMs);

  await client.stop();
  replayClient = new CoreHostClient({
    modulePath,
    expectedManifest: definition.manifest,
    instanceId: 'i4g-hardened-continuity-replay',
    policy: { resources: definition.manifest.resources, priority: definition.manifest.priority },
    logger: { log() {}, info() {}, warn() {}, error() {} }
  });
  let replayOutputs = 0;
  replayClient.on('output', () => { replayOutputs += 1; });
  replayClient.on('error', () => {});
  await replayClient.start(final.checkpoint, 5);
  assert.deepEqual(await replayClient.snapshot(), final.checkpoint);
  const nextWallClockMs = anchorAt + 5_001 * 250;
  const afterReplay = await replayClient.dispatch({
    id: 'pulse-after-replay',
    sequence: 5_004,
    class: 'durable',
    topic: 'runtime.time.pulse',
    at: nextWallClockMs,
    payload: {
      wallClockMs: nextWallClockMs,
      runtimeRevision: 111,
      pulseSequence: 5_002,
      clockStatus: 'trusted'
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 111 }
  }, { eventSequence: 5_004 });
  assert.equal(afterReplay.checkpoint.chemistry.modelClock, startingClock + 1_250_250);
  assert.deepEqual(afterReplay.checkpoint.individuality, final.checkpoint.individuality);
  assert.equal(replayOutputs, 0);
});
