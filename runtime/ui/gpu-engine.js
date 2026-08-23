(() => {
  'use strict';

  const ENGINE_VERSION = 'stay-webgpu-search-v3';
  const INPUTS = 31;
  const HIDDEN = 8;
  const OUTPUTS = 12;
  const GENOME_SIZE = (INPUTS + 1) * HIDDEN + (HIDDEN + 1) * OUTPUTS;
  const WORKGROUP_SIZE = 32;
  const REDUCE_SIZE = 256;
  const GPU_SHARD_ID = 31;
  const MIN_CANDIDATES = WORKGROUP_SIZE;
  const ABSOLUTE_MAX_CANDIDATES = 4194304;
  const MAX_SINGLE_DISPATCH_MS = 50;

  const evaluationShader = `
struct Params {
  seed: u32,
  nodeHash: u32,
  scenarioCount: u32,
  candidateCount: u32,
  rowStride: u32,
  groupsX: u32,
  _pad0: u32,
  _pad1: u32,
};
struct Result { bestScore: f32, bestIndex: u32, scoreSum: f32, scoreSquareSum: f32 };
@group(0) @binding(0) var<storage, read> baseGenome: array<f32>;
@group(0) @binding(1) var<storage, read> scenarios: array<f32>;
@group(0) @binding(2) var<storage, read> targets: array<f32>;
@group(0) @binding(3) var<storage, read_write> groupResults: array<Result>;
@group(0) @binding(4) var<uniform> params: Params;
var<workgroup> localBest: array<f32, ${WORKGROUP_SIZE}>;
var<workgroup> localIndex: array<u32, ${WORKGROUP_SIZE}>;
var<workgroup> localSum: array<f32, ${WORKGROUP_SIZE}>;
var<workgroup> localSquare: array<f32, ${WORKGROUP_SIZE}>;
fn clampf(v: f32, lo: f32, hi: f32) -> f32 { return max(lo, min(hi, v)); }
fn xorshift32(value: u32) -> u32 {
  var x = value; x = x ^ (x << 13u); x = x ^ (x >> 17u); x = x ^ (x << 5u); return x;
}
fn candidateSeed(taskSeed: u32, nodeHash: u32, candidateIndex: u32) -> u32 {
  var x = taskSeed ^ nodeHash ^ ((candidateIndex + 1u) * 0x9e3779b1u);
  return xorshift32(x ^ 0x85ebca6bu);
}
@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(
  @builtin(global_invocation_id) globalId: vec3<u32>,
  @builtin(local_invocation_index) localId: u32,
  @builtin(workgroup_id) groupId: vec3<u32>
) {
  let candidateIndex = globalId.x + globalId.y * params.rowStride;
  var score = 0.0;
  if (candidateIndex < params.candidateCount) {
    var genome: array<f32, ${GENOME_SIZE}>;
    for (var i: u32 = 0u; i < ${GENOME_SIZE}u; i = i + 1u) { genome[i] = baseGenome[i]; }
    var rng = candidateSeed(params.seed, params.nodeHash, candidateIndex);
    for (var m: u32 = 0u; m < 12u; m = m + 1u) {
      rng = xorshift32(rng); let idx = rng % ${GENOME_SIZE}u;
      rng = xorshift32(rng); let unit = f32(rng) / 4294967296.0;
      genome[idx] = clampf(genome[idx] + (unit * 2.0 - 1.0) * 0.13, -2.5, 2.5);
    }
    var mse = 0.0;
    var saturation = 0.0;
    for (var scenarioIndex: u32 = 0u; scenarioIndex < params.scenarioCount; scenarioIndex = scenarioIndex + 1u) {
      var hidden: array<f32, ${HIDDEN}>;
      var outputs: array<f32, ${OUTPUTS}>;
      var p: u32 = 0u;
      for (var h: u32 = 0u; h < ${HIDDEN}u; h = h + 1u) {
        var hiddenSum = genome[p]; p = p + 1u;
        for (var i: u32 = 0u; i < ${INPUTS}u; i = i + 1u) {
          hiddenSum = hiddenSum + genome[p] * (clampf(scenarios[scenarioIndex * ${INPUTS}u + i], 0.0, 1.0) * 2.0 - 1.0);
          p = p + 1u;
        }
        hidden[h] = tanh(hiddenSum);
      }
      for (var o: u32 = 0u; o < ${OUTPUTS}u; o = o + 1u) {
        var outputSum = genome[p]; p = p + 1u;
        for (var h: u32 = 0u; h < ${HIDDEN}u; h = h + 1u) { outputSum = outputSum + genome[p] * hidden[h]; p = p + 1u; }
        outputs[o] = (tanh(outputSum) + 1.0) * 0.5;
      }
      for (var o: u32 = 0u; o < ${OUTPUTS}u; o = o + 1u) {
        let d = outputs[o] - targets[scenarioIndex * ${OUTPUTS}u + o];
        mse = mse + d * d;
        saturation = saturation + max(0.0, abs(outputs[o] - 0.5) * 2.0 - 0.965) * 0.002;
      }
    }
    mse = mse / f32(max(1u, params.scenarioCount) * ${OUTPUTS}u);
    score = clampf(exp(-5.5 * (mse + saturation)), 0.0, 1.0);
  }
  localBest[localId] = score;
  localIndex[localId] = candidateIndex;
  localSum[localId] = score;
  localSquare[localId] = score * score;
  workgroupBarrier();
  var stride = ${WORKGROUP_SIZE / 2}u;
  loop {
    if (localId < stride) {
      let other = localId + stride;
      if (localBest[other] > localBest[localId]) { localBest[localId] = localBest[other]; localIndex[localId] = localIndex[other]; }
      localSum[localId] = localSum[localId] + localSum[other];
      localSquare[localId] = localSquare[localId] + localSquare[other];
    }
    workgroupBarrier();
    if (stride == 1u) { break; }
    stride = stride / 2u;
  }
  if (localId == 0u) {
    let resultIndex = groupId.x + groupId.y * params.groupsX;
    groupResults[resultIndex] = Result(localBest[0], localIndex[0], localSum[0], localSquare[0]);
  }
}`;

  const reductionShader = `
struct Result { bestScore: f32, bestIndex: u32, scoreSum: f32, scoreSquareSum: f32 };
struct ReductionParams { count: u32, _pad0: u32, _pad1: u32, _pad2: u32 };
@group(0) @binding(0) var<storage, read> inputResults: array<Result>;
@group(0) @binding(1) var<storage, read_write> finalResult: array<Result>;
@group(0) @binding(2) var<uniform> params: ReductionParams;
var<workgroup> localBest: array<f32, ${REDUCE_SIZE}>;
var<workgroup> localIndex: array<u32, ${REDUCE_SIZE}>;
var<workgroup> localSum: array<f32, ${REDUCE_SIZE}>;
var<workgroup> localSquare: array<f32, ${REDUCE_SIZE}>;
@compute @workgroup_size(${REDUCE_SIZE})
fn main(@builtin(local_invocation_index) localId: u32) {
  var best = 0.0;
  var bestIndex = 0u;
  var sum = 0.0;
  var square = 0.0;
  var i = localId;
  loop {
    if (i >= params.count) { break; }
    let entry = inputResults[i];
    if (entry.bestScore > best) { best = entry.bestScore; bestIndex = entry.bestIndex; }
    sum = sum + entry.scoreSum;
    square = square + entry.scoreSquareSum;
    i = i + ${REDUCE_SIZE}u;
  }
  localBest[localId] = best; localIndex[localId] = bestIndex; localSum[localId] = sum; localSquare[localId] = square;
  workgroupBarrier();
  var stride = ${REDUCE_SIZE / 2}u;
  loop {
    if (localId < stride) {
      let other = localId + stride;
      if (localBest[other] > localBest[localId]) { localBest[localId] = localBest[other]; localIndex[localId] = localIndex[other]; }
      localSum[localId] = localSum[localId] + localSum[other];
      localSquare[localId] = localSquare[localId] + localSquare[other];
    }
    workgroupBarrier();
    if (stride == 1u) { break; }
    stride = stride / 2u;
  }
  if (localId == 0u) { finalResult[0] = Result(localBest[0], localIndex[0], localSum[0], localSquare[0]); }
}`;

  const state = {
    adapter: null,
    device: null,
    evaluationPipeline: null,
    reductionPipeline: null,
    buffers: new Map(),
    allocatedBytes: 0,
    ready: false,
    initPromise: null,
    inFlight: false,
    reason: '',
    candidatesPerMs: 0,
    lastElapsedMs: 0,
    lastCandidates: 0,
    completedTasks: 0,
    lastError: '',
    adapterInfo: null,
    maxCandidates: ABSOLUTE_MAX_CANDIDATES,
    maxWorkgroupsPerDimension: 65535,
    requestedDuty: 0.05,
    effectiveDuty: 0,
    measuredDuty5s: 0,
    measuredDuty30s: 0,
    lastCooldownMs: 0,
    nextDispatchAt: 0,
    busy: [],
    lastTargetMs: 0,
    deviceLosses: 0
  };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  const nextPow2 = value => 2 ** Math.ceil(Math.log2(Math.max(4, value)));

  function trimBusy() {
    const cutoff = performance.now() - 30000;
    while (state.busy.length && state.busy[0].end < cutoff) state.busy.shift();
    if (state.busy.length > 512) state.busy.splice(0, state.busy.length - 512);
  }

  function measuredDuty(windowMs) {
    trimBusy();
    const now = performance.now();
    const start = now - windowMs;
    const intervals = state.busy.map(item => [Math.max(start, item.start), Math.min(now, item.end)])
      .filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0]);
    let busyMs = 0;
    let from = null;
    let to = null;
    for (const interval of intervals) {
      if (from == null) { [from, to] = interval; continue; }
      if (interval[0] <= to) to = Math.max(to, interval[1]);
      else { busyMs += to - from; [from, to] = interval; }
    }
    if (from != null) busyMs += to - from;
    return Math.max(0, Math.min(1, busyMs / windowMs));
  }

  function publish() {
    state.measuredDuty5s = measuredDuty(5000);
    state.measuredDuty30s = measuredDuty(30000);
    const info = {
      version: ENGINE_VERSION,
      secureContext: Boolean(window.isSecureContext),
      supported: Boolean(navigator.gpu),
      ready: state.ready,
      inFlight: state.inFlight,
      reason: state.reason,
      lastError: state.lastError,
      candidatesPerMs: state.candidatesPerMs,
      lastElapsedMs: state.lastElapsedMs,
      lastCandidates: state.lastCandidates,
      completedTasks: state.completedTasks,
      adapterInfo: state.adapterInfo,
      maxCandidates: state.maxCandidates,
      requestedDuty: state.requestedDuty,
      effectiveDuty: state.effectiveDuty,
      measuredDuty5s: state.measuredDuty5s,
      measuredDuty30s: state.measuredDuty30s,
      measurementBasis: 'queue-submit-to-map-read-wall-clock',
      lastCooldownMs: state.lastCooldownMs,
      lastTargetMs: state.lastTargetMs,
      allocatedBufferBytes: state.allocatedBytes,
      deviceLosses: state.deviceLosses
    };
    window.__stayGpuStatus = info;
    window.dispatchEvent(new CustomEvent('stay-gpu-status', { detail: info }));
    return info;
  }

  function fail(reason, error = null) {
    state.ready = false;
    state.reason = reason;
    state.lastError = error ? String(error?.message || error) : '';
    publish();
    return false;
  }

  function destroyBuffers() {
    for (const entry of state.buffers.values()) { try { entry.buffer.destroy(); } catch {} }
    state.buffers.clear();
    state.allocatedBytes = 0;
  }

  function resetDevice(reason) {
    destroyBuffers();
    state.device = null;
    state.adapter = null;
    state.evaluationPipeline = null;
    state.reductionPipeline = null;
    state.ready = false;
    state.reason = reason;
    state.initPromise = null;
    publish();
  }

  async function checkedModule(device, code) {
    const module = device.createShaderModule({ code });
    if (typeof module.getCompilationInfo === 'function') {
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter(message => message.type === 'error');
      if (errors.length) throw new Error(errors.map(error => error.message).join('; '));
    }
    return module;
  }

  async function init() {
    if (state.ready) return true;
    if (state.initPromise) return state.initPromise;
    state.initPromise = (async () => {
      if (!window.isSecureContext) return fail('HTTPS required');
      if (!navigator.gpu) return fail('WebGPU unavailable');
      try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) return fail('No WebGPU adapter');
        const device = await adapter.requestDevice();
        device.lost.then(info => {
          state.deviceLosses += 1;
          state.lastError = String(info?.message || '');
          resetDevice('GPU device lost');
        });
        const [evaluationModule, reductionModule] = await Promise.all([
          checkedModule(device, evaluationShader),
          checkedModule(device, reductionShader)
        ]);
        const [evaluationPipeline, reductionPipeline] = await Promise.all([
          device.createComputePipelineAsync({ layout: 'auto', compute: { module: evaluationModule, entryPoint: 'main' } }),
          device.createComputePipelineAsync({ layout: 'auto', compute: { module: reductionModule, entryPoint: 'main' } })
        ]);
        state.adapter = adapter;
        state.device = device;
        state.evaluationPipeline = evaluationPipeline;
        state.reductionPipeline = reductionPipeline;
        const storageLimit = Number(device.limits?.maxStorageBufferBindingSize || 0);
        const bufferLimit = Number(device.limits?.maxBufferSize || 0);
        const limit = Math.min(storageLimit || Number.MAX_SAFE_INTEGER, bufferLimit || Number.MAX_SAFE_INTEGER);
        state.maxCandidates = Math.max(MIN_CANDIDATES, Math.min(ABSOLUTE_MAX_CANDIDATES, Math.floor(limit / 16) * WORKGROUP_SIZE));
        state.maxWorkgroupsPerDimension = Math.max(1, Number(device.limits?.maxComputeWorkgroupsPerDimension || 65535));
        const raw = adapter.info || device.adapterInfo || {};
        state.adapterInfo = {
          vendor: String(raw.vendor || ''), architecture: String(raw.architecture || ''),
          device: String(raw.device || ''), description: String(raw.description || '')
        };
        state.ready = true;
        state.reason = 'ready';
        state.lastError = '';
        publish();
        return true;
      } catch (error) { return fail('WebGPU initialization failed', error); }
      finally { state.initPromise = null; }
    })();
    return state.initPromise;
  }

  function ensureBuffer(name, byteLength, usage) {
    const required = Math.max(4, Math.ceil(byteLength / 4) * 4);
    const existing = state.buffers.get(name);
    if (existing && existing.capacity >= required && existing.usage === usage) return existing.buffer;
    if (existing) { existing.buffer.destroy(); state.allocatedBytes -= existing.capacity; }
    const maxBuffer = Number(state.device.limits?.maxBufferSize || Number.MAX_SAFE_INTEGER);
    const maxStorage = usage & GPUBufferUsage.STORAGE
      ? Number(state.device.limits?.maxStorageBufferBindingSize || maxBuffer)
      : maxBuffer;
    const limit = Math.min(maxBuffer, maxStorage);
    if (required > limit) throw new Error(`${name} requires ${required} bytes but device limit is ${limit}`);
    const capacity = Math.min(limit, nextPow2(required));
    const buffer = state.device.createBuffer({ size: capacity, usage });
    state.buffers.set(name, { buffer, capacity, usage });
    state.allocatedBytes += capacity;
    return buffer;
  }

  function writeF32(name, values, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) {
    const data = values instanceof Float32Array ? values : new Float32Array(values);
    const buffer = ensureBuffer(name, data.byteLength, usage);
    state.device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  function writeU32(name, values, usage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST) {
    const data = values instanceof Uint32Array ? values : new Uint32Array(values);
    const buffer = ensureBuffer(name, data.byteLength, usage);
    state.device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  function chooseCandidateCount(duty, scenarioCount) {
    const targetMs = Math.min(MAX_SINGLE_DISPATCH_MS, duty <= 0.05 ? 6 : duty <= 0.20 ? 12 : duty <= 0.50 ? 25 : duty < 1 ? 40 : MAX_SINGLE_DISPATCH_MS);
    state.lastTargetMs = targetMs;
    if (state.candidatesPerMs > 0) {
      return Math.max(MIN_CANDIDATES, Math.min(state.maxCandidates, Math.round(targetMs * state.candidatesPerMs / WORKGROUP_SIZE) * WORKGROUP_SIZE));
    }
    const bootstrap = Math.round(512 / Math.sqrt(Math.max(1, scenarioCount)) / WORKGROUP_SIZE) * WORKGROUP_SIZE;
    return Math.max(MIN_CANDIDATES, Math.min(512, bootstrap, state.maxCandidates));
  }

  async function runTask(task, options = {}) {
    if (state.inFlight) throw Object.assign(new Error('overlapping GPU jobs are forbidden'), { code: 'GPU_JOB_OVERLAP' });
    const ok = await init();
    if (!ok) throw new Error(state.reason || 'GPU unavailable');
    const C = window.GenesisCognitive;
    if (!C || typeof C.evaluateCandidate !== 'function' || typeof C.instinctTargets !== 'function') throw new Error('Genesis cognitive verifier unavailable in browser');
    if (Number(C.GENOME_SIZE) !== GENOME_SIZE) throw new Error(`GPU/cognitive genome contract mismatch: GPU ${GENOME_SIZE}, cognitive ${C.GENOME_SIZE}`);
    const genome = Array.isArray(task.genome) ? task.genome : [];
    const scenarios = Array.isArray(task.scenarios) ? task.scenarios : [];
    if (genome.length !== GENOME_SIZE) throw new Error(`GPU task genome has unexpected size: got ${genome.length}, expected ${GENOME_SIZE}`);
    if (!scenarios.length) throw new Error('GPU task has no scenarios');

    const requestedDuty = Math.max(0.01, Math.min(1, Number(options.share) || 0.05));
    state.requestedDuty = requestedDuty;
    const gate = window.STAYComputeGovernor
      ? await window.STAYComputeGovernor.beforeGpuDispatch(requestedDuty)
      : { effectiveDuty: requestedDuty, reason: 'none' };
    const effectiveDuty = Math.max(0.002, Math.min(requestedDuty, Number(gate.effectiveDuty) || requestedDuty));
    state.effectiveDuty = effectiveDuty;
    await sleep(Math.max(0, state.nextDispatchAt - performance.now()));
    state.inFlight = true;
    try {
      const candidateCount = chooseCandidateCount(effectiveDuty, scenarios.length);
      const flatScenarios = new Float32Array(scenarios.length * INPUTS);
      const flatTargets = new Float32Array(scenarios.length * OUTPUTS);
      for (let s = 0; s < scenarios.length; s++) {
        for (let i = 0; i < INPUTS; i++) flatScenarios[s * INPUTS + i] = Number(scenarios[s]?.[i]) || 0;
        const target = C.instinctTargets(scenarios[s]);
        for (let o = 0; o < OUTPUTS; o++) flatTargets[s * OUTPUTS + o] = Number(target?.[o]) || 0;
      }
      const totalGroups = Math.ceil(candidateCount / WORKGROUP_SIZE);
      const groupsX = Math.min(state.maxWorkgroupsPerDimension, totalGroups);
      const groupsY = Math.ceil(totalGroups / groupsX);
      if (groupsY > state.maxWorkgroupsPerDimension) throw new Error(`GPU dispatch exceeds device workgroup limits: ${groupsX}x${groupsY}`);
      const rowStride = groupsX * WORKGROUP_SIZE;
      const device = state.device;
      const genomeBuffer = writeF32('genome', new Float32Array(genome));
      const scenarioBuffer = writeF32('scenarios', flatScenarios);
      const targetBuffer = writeF32('targets', flatTargets);
      const groupResultBuffer = ensureBuffer('group-results', totalGroups * 16, GPUBufferUsage.STORAGE);
      const finalResultBuffer = ensureBuffer('final-result', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const readbackBuffer = ensureBuffer('readback', 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
      const paramsBuffer = writeU32('params', [
        Number(task.seed) >>> 0, Number(options.workHash) >>> 0, scenarios.length >>> 0,
        candidateCount >>> 0, rowStride >>> 0, groupsX >>> 0, 0, 0
      ]);
      const reduceParams = writeU32('reduce-params', [totalGroups >>> 0, 0, 0, 0]);
      const evaluationBind = device.createBindGroup({
        layout: state.evaluationPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: genomeBuffer } },
          { binding: 1, resource: { buffer: scenarioBuffer } },
          { binding: 2, resource: { buffer: targetBuffer } },
          { binding: 3, resource: { buffer: groupResultBuffer } },
          { binding: 4, resource: { buffer: paramsBuffer } }
        ]
      });
      const reductionBind = device.createBindGroup({
        layout: state.reductionPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: groupResultBuffer } },
          { binding: 1, resource: { buffer: finalResultBuffer } },
          { binding: 2, resource: { buffer: reduceParams } }
        ]
      });
      const started = performance.now();
      const encoder = device.createCommandEncoder();
      const evaluationPass = encoder.beginComputePass();
      evaluationPass.setPipeline(state.evaluationPipeline);
      evaluationPass.setBindGroup(0, evaluationBind);
      evaluationPass.dispatchWorkgroups(groupsX, groupsY, 1);
      evaluationPass.end();
      const reductionPass = encoder.beginComputePass();
      reductionPass.setPipeline(state.reductionPipeline);
      reductionPass.setBindGroup(0, reductionBind);
      reductionPass.dispatchWorkgroups(1, 1, 1);
      reductionPass.end();
      encoder.copyBufferToBuffer(finalResultBuffer, 0, readbackBuffer, 0, 16);
      device.queue.submit([encoder.finish()]);
      await readbackBuffer.mapAsync(GPUMapMode.READ, 0, 16);
      const elapsedMs = Math.max(0.01, performance.now() - started);
      const bytes = readbackBuffer.getMappedRange(0, 16);
      const values = new DataView(bytes);
      const bestIndex = values.getUint32(4, true);
      const scoreSum = values.getFloat32(8, true);
      const scoreSquareSum = values.getFloat32(12, true);
      readbackBuffer.unmap();
      if (bestIndex >= candidateCount) throw new Error('GPU reduction returned an out-of-range winner');
      const exact = C.evaluateCandidate(genome, task.seed, Number(options.workHash) >>> 0, bestIndex, scenarios);
      const measuredRate = candidateCount / elapsedMs;
      state.candidatesPerMs = state.candidatesPerMs > 0 ? state.candidatesPerMs * 0.7 + measuredRate * 0.3 : measuredRate;
      state.lastElapsedMs = elapsedMs;
      state.lastCandidates = candidateCount;
      state.completedTasks += 1;
      state.lastError = '';
      state.busy.push({ start: started, end: started + elapsedMs });
      window.STAYComputeGovernor?.recordGpuJob(elapsedMs);
      const baseCooldown = elapsedMs * (1 - effectiveDuty) / effectiveDuty;
      const overshoot = Math.max(0, measuredDuty(30000) - effectiveDuty) * 30000;
      state.lastCooldownMs = Math.min(30000, Math.max(0, baseCooldown + overshoot * 0.25));
      state.nextDispatchAt = performance.now() + state.lastCooldownMs;
      publish();
      return {
        type: 'work-result', protocol: task.protocol, epoch: Number(task.epoch),
        shardId: Number.isInteger(options.shardId) ? options.shardId : GPU_SHARD_ID,
        candidates: candidateCount, bestIndex, bestScore: exact.score, bestOutputs: exact.outputs,
        scoreSum, scoreSquareSum, scenarioCount: scenarios.length, elapsedMs,
        budgetMs: state.lastTargetMs, startedAt: task.startedAt, engine: 'gpu',
        gpu: {
          candidateCount, elapsedMs, candidatesPerSecond: Math.round(candidateCount * 1000 / elapsedMs),
          requestedDuty, effectiveDuty, measuredDuty5s: measuredDuty(5000), measuredDuty30s: measuredDuty(30000),
          cooldownMs: state.lastCooldownMs, readbackBytes: 16, allocatedBufferBytes: state.allocatedBytes
        }
      };
    } catch (error) {
      state.lastError = String(error?.message || error);
      publish();
      throw error;
    } finally { state.inFlight = false; }
  }

  function status() { return publish(); }
  function setRequestedDuty(share) {
    const previous = state.requestedDuty;
    state.requestedDuty = Math.max(0.01, Math.min(1, Number(share) || 0.05));
    if (state.requestedDuty >= previous) state.nextDispatchAt = Math.min(state.nextDispatchAt, performance.now() + 100);
    else state.nextDispatchAt = Math.max(state.nextDispatchAt, performance.now() + state.lastElapsedMs * (1 - state.requestedDuty) / state.requestedDuty);
    publish();
  }

  window.addEventListener('stay-compute-share-change', event => setRequestedDuty(event.detail?.share));
  window.STAYGpuEngine = { version: ENGINE_VERSION, GPU_SHARD_ID, init, status, runTask, setRequestedDuty, reset: () => resetDevice('manual reset') };
  publish();
})();
