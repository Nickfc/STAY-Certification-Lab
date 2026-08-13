(() => {
  'use strict';

  const ENGINE_VERSION = 'stay-webgpu-search-v1';
  const INPUTS = 31;
  const HIDDEN = 8;
  const OUTPUTS = 12;
  const GENOME_SIZE = (INPUTS + 1) * HIDDEN + (HIDDEN + 1) * OUTPUTS; // 364
  const WORKGROUP_SIZE = 32;
  const GPU_SHARD_ID = 31;
  const MIN_CANDIDATES = 32;
  const MAX_CANDIDATES = 131072;

  const shader = `
struct Params {
  seed: u32,
  nodeHash: u32,
  scenarioCount: u32,
  candidateCount: u32,
};

@group(0) @binding(0) var<storage, read> baseGenome: array<f32>;
@group(0) @binding(1) var<storage, read> scenarios: array<f32>;
@group(0) @binding(2) var<storage, read> targets: array<f32>;
@group(0) @binding(3) var<storage, read_write> scores: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;

fn clampf(v: f32, lo: f32, hi: f32) -> f32 {
  return max(lo, min(hi, v));
}

fn xorshift32(value: u32) -> u32 {
  var x = value;
  x = x ^ (x << 13u);
  x = x ^ (x >> 17u);
  x = x ^ (x << 5u);
  return x;
}

fn candidateSeed(taskSeed: u32, nodeHash: u32, candidateIndex: u32) -> u32 {
  var x = taskSeed ^ nodeHash ^ ((candidateIndex + 1u) * 0x9e3779b1u);
  x = xorshift32(x ^ 0x85ebca6bu);
  return x;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let candidateIndex = globalId.x;
  if (candidateIndex >= params.candidateCount) {
    return;
  }

  var genome: array<f32, ${GENOME_SIZE}>;
  for (var i: u32 = 0u; i < ${GENOME_SIZE}u; i = i + 1u) {
    genome[i] = baseGenome[i];
  }

  var rng = candidateSeed(params.seed, params.nodeHash, candidateIndex);
  for (var m: u32 = 0u; m < 12u; m = m + 1u) {
    rng = xorshift32(rng);
    let idx = rng % ${GENOME_SIZE}u;
    rng = xorshift32(rng);
    let unit = f32(rng) / 4294967296.0;
    let delta = (unit * 2.0 - 1.0) * 0.13;
    genome[idx] = clampf(genome[idx] + delta, -2.5, 2.5);
  }

  var mse = 0.0;
  var saturation = 0.0;

  for (var scenarioIndex: u32 = 0u; scenarioIndex < params.scenarioCount; scenarioIndex = scenarioIndex + 1u) {
    var hidden: array<f32, ${HIDDEN}>;
    var outputs: array<f32, ${OUTPUTS}>;
    var p: u32 = 0u;

    for (var h: u32 = 0u; h < ${HIDDEN}u; h = h + 1u) {
      var sum = genome[p];
      p = p + 1u;
      for (var i: u32 = 0u; i < ${INPUTS}u; i = i + 1u) {
        let raw = clampf(scenarios[scenarioIndex * ${INPUTS}u + i], 0.0, 1.0);
        let normalized = raw * 2.0 - 1.0;
        sum = sum + genome[p] * normalized;
        p = p + 1u;
      }
      hidden[h] = tanh(sum);
    }

    for (var o: u32 = 0u; o < ${OUTPUTS}u; o = o + 1u) {
      var sum = genome[p];
      p = p + 1u;
      for (var h: u32 = 0u; h < ${HIDDEN}u; h = h + 1u) {
        sum = sum + genome[p] * hidden[h];
        p = p + 1u;
      }
      outputs[o] = (tanh(sum) + 1.0) * 0.5;
    }

    for (var o: u32 = 0u; o < ${OUTPUTS}u; o = o + 1u) {
      let expectedValue = targets[scenarioIndex * ${OUTPUTS}u + o];
      let d = outputs[o] - expectedValue;
      mse = mse + d * d;
      let edge = abs(outputs[o] - 0.5) * 2.0;
      saturation = saturation + max(0.0, edge - 0.965) * 0.002;
    }
  }

  mse = mse / f32(max(1u, params.scenarioCount) * ${OUTPUTS}u);
  let loss = mse + saturation;
  scores[candidateIndex] = clampf(exp(-5.5 * loss), 0.0, 1.0);
}
`;

  const state = {
    adapter: null,
    device: null,
    pipeline: null,
    ready: false,
    initPromise: null,
    reason: '',
    candidatesPerMs: 0,
    lastElapsedMs: 0,
    lastCandidates: 0,
    lastError: '',
    adapterInfo: null,
  };

  function publish() {
    const info = {
      version: ENGINE_VERSION,
      secureContext: Boolean(window.isSecureContext),
      supported: Boolean(navigator.gpu),
      ready: state.ready,
      reason: state.reason,
      lastError: state.lastError,
      candidatesPerMs: state.candidatesPerMs,
      lastElapsedMs: state.lastElapsedMs,
      lastCandidates: state.lastCandidates,
      adapterInfo: state.adapterInfo,
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
        device.lost.then((info) => {
          state.device = null;
          state.pipeline = null;
          state.adapter = null;
          state.ready = false;
          state.reason = 'GPU device lost';
          state.lastError = String(info?.message || '');
          state.initPromise = null;
          publish();
        });

        const module = device.createShaderModule({ code: shader });
        if (typeof module.getCompilationInfo === 'function') {
          const info = await module.getCompilationInfo();
          const errors = info.messages.filter(m => m.type === 'error');
          if (errors.length) throw new Error(errors.map(e => e.message).join('; '));
        }

        const pipeline = await device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: 'main' }
        });

        state.adapter = adapter;
        state.device = device;
        state.pipeline = pipeline;
        const rawInfo = device.adapterInfo || {};
        state.adapterInfo = {
          vendor: String(rawInfo.vendor || ''),
          architecture: String(rawInfo.architecture || ''),
          device: String(rawInfo.device || ''),
          description: String(rawInfo.description || '')
        };
        state.ready = true;
        state.reason = 'ready';
        state.lastError = '';
        publish();
        return true;
      } catch (error) {
        return fail('WebGPU initialization failed', error);
      } finally {
        state.initPromise = null;
      }
    })();

    return state.initPromise;
  }

  function status() {
    return publish();
  }

  function chooseCandidateCount(share, scenarioCount) {
    const fraction = Math.max(0.01, Math.min(1, Number(share) || 0.05));
    const targetMs = Math.max(5, Math.min(800, fraction * 1000));

    if (state.candidatesPerMs > 0) {
      const predicted = Math.round(targetMs * state.candidatesPerMs);
      return Math.max(MIN_CANDIDATES, Math.min(MAX_CANDIDATES, predicted));
    }

    // Conservative first dispatch. Scenario depth can be up to ~24.
    const depthPenalty = Math.max(1, Number(scenarioCount) || 1);
    const bootstrap = Math.round(1536 / Math.sqrt(depthPenalty));
    return Math.max(MIN_CANDIDATES, Math.min(512, bootstrap));
  }

  function createBufferFromF32(device, values, usage) {
    const data = values instanceof Float32Array ? values : new Float32Array(values);
    const size = Math.max(4, Math.ceil(data.byteLength / 4) * 4);
    const buffer = device.createBuffer({ size, usage, mappedAtCreation: true });
    new Float32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    return buffer;
  }

  function createUniformParams(device, seed, nodeHash, scenarioCount, candidateCount) {
    const buffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    const mapped = buffer.getMappedRange();
    const view = new Uint32Array(mapped);
    view[0] = Number(seed) >>> 0;
    view[1] = Number(nodeHash) >>> 0;
    view[2] = Number(scenarioCount) >>> 0;
    view[3] = Number(candidateCount) >>> 0;
    buffer.unmap();
    return buffer;
  }

  async function runTask(task, options = {}) {
    const ok = await init();
    if (!ok) throw new Error(state.reason || 'GPU unavailable');

    const C = window.GenesisCognitive;
    if (!C || typeof C.evaluateCandidate !== 'function' || typeof C.instinctTargets !== 'function') {
      throw new Error('Genesis cognitive verifier unavailable in browser');
    }

    const device = state.device;
    const pipeline = state.pipeline;
    const share = Math.max(0.01, Math.min(1, Number(options.share) || 0.05));
    const shardId = Number.isInteger(options.shardId) ? options.shardId : GPU_SHARD_ID;
    const workHash = Number(options.workHash) >>> 0;
    const genome = Array.isArray(task.genome) ? task.genome : [];
    const scenarios = Array.isArray(task.scenarios) ? task.scenarios : [];

    if (Number(C.GENOME_SIZE) !== GENOME_SIZE) {
      throw new Error(`GPU/cognitive genome contract mismatch: GPU ${GENOME_SIZE}, cognitive ${C.GENOME_SIZE}`);
    }
    if (genome.length !== GENOME_SIZE) {
      throw new Error(`GPU task genome has unexpected size: got ${genome.length}, expected ${GENOME_SIZE}`);
    }
    if (!scenarios.length) throw new Error('GPU task has no scenarios');

    const candidateCount = chooseCandidateCount(share, scenarios.length);
    const flatScenarios = new Float32Array(scenarios.length * INPUTS);
    const flatTargets = new Float32Array(scenarios.length * OUTPUTS);

    for (let s = 0; s < scenarios.length; s++) {
      const scenario = scenarios[s];
      for (let i = 0; i < INPUTS; i++) flatScenarios[s * INPUTS + i] = Number(scenario?.[i]) || 0;
      const target = C.instinctTargets(scenario);
      for (let o = 0; o < OUTPUTS; o++) flatTargets[s * OUTPUTS + o] = Number(target?.[o]) || 0;
    }

    const genomeBuffer = createBufferFromF32(
      device, new Float32Array(genome),
      GPUBufferUsage.STORAGE
    );
    const scenarioBuffer = createBufferFromF32(
      device, flatScenarios,
      GPUBufferUsage.STORAGE
    );
    const targetBuffer = createBufferFromF32(
      device, flatTargets,
      GPUBufferUsage.STORAGE
    );

    const scoreBytes = candidateCount * 4;
    const scoreBuffer = device.createBuffer({
      size: scoreBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    const readback = device.createBuffer({
      size: scoreBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const paramsBuffer = createUniformParams(
      device, task.seed, workHash, scenarios.length, candidateCount
    );

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: genomeBuffer } },
        { binding: 1, resource: { buffer: scenarioBuffer } },
        { binding: 2, resource: { buffer: targetBuffer } },
        { binding: 3, resource: { buffer: scoreBuffer } },
        { binding: 4, resource: { buffer: paramsBuffer } },
      ]
    });

    const started = performance.now();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(candidateCount / WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(scoreBuffer, 0, readback, 0, scoreBytes);
    device.queue.submit([encoder.finish()]);

    await readback.mapAsync(GPUMapMode.READ);
    const elapsedMs = Math.max(0.01, performance.now() - started);
    const mappedScores = new Float32Array(readback.getMappedRange());

    let bestIndex = 0;
    let bestApprox = -Infinity;
    let scoreSum = 0;
    let scoreSquareSum = 0;
    for (let i = 0; i < candidateCount; i++) {
      const score = Number(mappedScores[i]) || 0;
      scoreSum += score;
      scoreSquareSum += score * score;
      if (score > bestApprox) {
        bestApprox = score;
        bestIndex = i;
      }
    }

    readback.unmap();

    // The server verifies winners in JS double precision with a 1e-7 tolerance.
    // Re-score only the GPU-selected winner with the canonical cognitive core so
    // the submitted score is byte-for-byte compatible with server verification.
    const exact = C.evaluateCandidate(genome, task.seed, workHash, bestIndex, scenarios);

    const measuredRate = candidateCount / elapsedMs;
    state.candidatesPerMs = state.candidatesPerMs > 0
      ? state.candidatesPerMs * 0.55 + measuredRate * 0.45
      : measuredRate;
    state.lastElapsedMs = elapsedMs;
    state.lastCandidates = candidateCount;
    state.lastError = '';
    publish();

    genomeBuffer.destroy();
    scenarioBuffer.destroy();
    targetBuffer.destroy();
    scoreBuffer.destroy();
    paramsBuffer.destroy();
    readback.destroy();

    return {
      type: 'work-result',
      protocol: task.protocol,
      epoch: Number(task.epoch),
      shardId,
      candidates: candidateCount,
      bestIndex,
      bestScore: exact.score,
      bestOutputs: exact.outputs,
      scoreSum,
      scoreSquareSum,
      scenarioCount: scenarios.length,
      elapsedMs,
      budgetMs: Math.max(5, Math.min(800, share * 1000)),
      startedAt: task.startedAt,
      engine: 'gpu',
      gpu: {
        candidateCount,
        elapsedMs,
        candidatesPerSecond: Math.round(candidateCount * 1000 / elapsedMs)
      }
    };
  }

  window.STAYGpuEngine = {
    version: ENGINE_VERSION,
    GPU_SHARD_ID,
    init,
    status,
    runTask
  };

  publish();
})();
