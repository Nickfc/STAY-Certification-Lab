(() => {
  'use strict';

  if (window.STAYComputeGovernor) return;
  const VERSION = 'stay-viewer-responsiveness-v1';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') || Math.min(screen.width || 9999, screen.height || 9999) < 700;
  const state = {
    interactionUntil: 0,
    longTasks: [],
    gpuJobs: [],
    cpuSlices: [],
    memory: [],
    contentionScale: 1,
    lastBackoffReason: 'none',
    freezes: 0,
    longestTaskMs: 0,
    hidden: document.visibilityState !== 'visible',
    updatedAt: performance.now()
  };

  const trim = (array, cutoff, limit = 256) => {
    while (array.length && array[0].at < cutoff) array.shift();
    if (array.length > limit) array.splice(0, array.length - limit);
  };

  function markInteraction() {
    state.interactionUntil = Math.max(state.interactionUntil, performance.now() + (mobile ? 1400 : 700));
  }

  for (const name of ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'wheel', 'scroll', 'keydown', 'input']) {
    window.addEventListener(name, markInteraction, { passive: true, capture: true });
  }
  document.addEventListener('visibilitychange', () => { state.hidden = document.visibilityState !== 'visible'; publish(); });

  try {
    const observer = new PerformanceObserver(list => {
      const now = performance.now();
      for (const entry of list.getEntries()) {
        const duration = Number(entry.duration) || 0;
        state.longTasks.push({ at: now, duration });
        state.longestTaskMs = Math.max(state.longestTaskMs, duration);
        if (duration > 250) state.freezes += 1;
      }
      trim(state.longTasks, now - 30000);
      recompute();
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {}

  function memorySlope() {
    if (state.memory.length < 3) return null;
    const first = state.memory[0];
    const last = state.memory.at(-1);
    const minutes = Math.max((last.at - first.at) / 60000, 1 / 60000);
    return (last.bytes - first.bytes) / minutes;
  }

  function recompute() {
    const now = performance.now();
    trim(state.longTasks, now - 30000);
    trim(state.gpuJobs, now - 30000);
    trim(state.cpuSlices, now - 30000);
    const recent = state.longTasks.filter(task => task.at >= now - 5000);
    const freeze = recent.some(task => task.duration > 250);
    const pressure = recent.filter(task => task.duration > 50).length;
    const meanGpu = state.gpuJobs.length ? state.gpuJobs.reduce((sum, job) => sum + job.duration, 0) / state.gpuJobs.length : 0;
    let scale = 1;
    let reason = 'none';
    if (freeze) { scale = 0.05; reason = 'main-thread-freeze'; }
    else if (performance.now() < state.interactionUntil) { scale = 0.15; reason = 'active-interaction'; }
    else if (pressure >= 3) { scale = 0.35; reason = 'long-task-pressure'; }
    else if (pressure >= 1) { scale = 0.7; reason = 'long-task-warning'; }
    else if (meanGpu > 120) { scale = 0.5; reason = 'gpu-latency-inflation'; }
    if (state.hidden) { scale = Math.min(scale, 0.25); reason = 'page-hidden'; }
    if (mobile) scale = Math.min(scale, 0.6);
    const slope = memorySlope();
    if (slope != null && slope > 8 * 1024 * 1024) { scale = Math.min(scale, 0.35); reason = 'heap-growth'; }
    state.contentionScale = Math.max(0.02, scale);
    state.lastBackoffReason = reason;
    state.updatedAt = now;
    publish();
  }

  function measuredDuty(entries, windowMs) {
    const now = performance.now();
    const cutoff = now - windowMs;
    trim(entries, cutoff);
    const intervals = entries.map(entry => [Math.max(entry.at, cutoff), Math.min(entry.at + entry.duration, now)])
      .filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
    let busy = 0;
    let start = null;
    let end = null;
    for (const interval of intervals) {
      if (start == null) { [start, end] = interval; continue; }
      if (interval[0] <= end) end = Math.max(end, interval[1]);
      else { busy += end - start; [start, end] = interval; }
    }
    if (start != null) busy += end - start;
    return Math.max(0, Math.min(1, busy / windowMs));
  }

  async function beforeGpuDispatch(requestedDuty) {
    recompute();
    const requested = Math.max(0.01, Math.min(1, Number(requestedDuty) || 0.05));
    if (performance.now() < state.interactionUntil) {
      await new Promise(resolve => setTimeout(resolve, mobile ? 120 : 60));
      recompute();
    }
    const mobileCeiling = mobile ? 0.16 : 1;
    const effectiveDuty = Math.max(0.002, Math.min(requested, requested * state.contentionScale, mobileCeiling));
    return { requestedDuty: requested, effectiveDuty, reason: state.lastBackoffReason, mobile, hidden: state.hidden };
  }

  function cpuPolicy(requestedShare, logicalThreads) {
    recompute();
    const requested = Math.max(0, Math.min(1, Number(requestedShare) || 0));
    const threads = Math.max(1, Math.min(64, Number(logicalThreads) || 1));
    const safeRequested = requested * state.contentionScale;
    let concurrency;
    let sliceMs;
    let maxDutyPerWorker;
    if (safeRequested <= 0.05) { concurrency = 1; sliceMs = 4; maxDutyPerWorker = mobile ? 120 : 250; }
    else if (safeRequested <= 0.10) { concurrency = Math.min(2, threads); sliceMs = mobile ? 4 : 6; maxDutyPerWorker = mobile ? 150 : 350; }
    else if (safeRequested <= 0.25) { concurrency = Math.min(mobile ? 2 : 4, threads); sliceMs = mobile ? 4 : 8; maxDutyPerWorker = mobile ? 180 : 500; }
    else { concurrency = Math.min(mobile ? 3 : 16, threads, Math.max(2, Math.ceil(threads * safeRequested))); sliceMs = mobile ? 5 : 10; maxDutyPerWorker = mobile ? 220 : 800; }
    if (requested === 0) concurrency = 0;
    const desiredMs = safeRequested * threads * 1000;
    const budgetMsPerWorker = concurrency ? Math.max(1, Math.min(maxDutyPerWorker, desiredMs / concurrency)) : 0;
    const effectiveShare = concurrency ? (budgetMsPerWorker * concurrency) / (threads * 1000) : 0;
    return {
      requestedShare: requested,
      effectiveShare,
      poolSize: concurrency,
      peakConcurrency: concurrency,
      sliceMs,
      budgetMsPerWorker,
      dispatchWindowMs: Math.max(0, 950 - budgetMsPerWorker),
      reason: state.lastBackoffReason,
      mobile
    };
  }

  function recordGpuJob(duration) {
    state.gpuJobs.push({ at: performance.now() - Math.max(0, duration), duration: Math.max(0, Number(duration) || 0) });
    trim(state.gpuJobs, performance.now() - 30000);
    recompute();
  }

  function recordCpuSlice(duration) {
    state.cpuSlices.push({ at: performance.now() - Math.max(0, duration), duration: Math.max(0, Number(duration) || 0) });
    trim(state.cpuSlices, performance.now() - 30000);
  }

  if (typeof window.Worker === 'function' && !window.Worker.__stayGoverned) {
    const NativeWorker = window.Worker;
    function GovernedWorker(...args) {
      const worker = new NativeWorker(...args);
      worker.addEventListener('message', event => {
        if (event.data?.type !== 'stay-worker-telemetry') return;
        recordCpuSlice(event.data.activeMs);
        event.stopImmediatePropagation();
      }, true);
      return worker;
    }
    GovernedWorker.prototype = NativeWorker.prototype;
    Object.setPrototypeOf(GovernedWorker, NativeWorker);
    Object.defineProperty(GovernedWorker, '__stayGoverned', { value: true });
    window.Worker = GovernedWorker;
  }

  function sampleMemory() {
    const bytes = Number(performance.memory?.usedJSHeapSize);
    if (Number.isFinite(bytes) && bytes > 0) {
      state.memory.push({ at: performance.now(), bytes });
      trim(state.memory, performance.now() - 10 * 60 * 1000, 120);
      recompute();
    }
  }

  function status() {
    return {
      version: VERSION,
      mobile,
      hidden: state.hidden,
      interacting: performance.now() < state.interactionUntil,
      contentionScale: state.contentionScale,
      backoffReason: state.lastBackoffReason,
      longestTaskMs: state.longestTaskMs,
      freezes: state.freezes,
      longTasks5s: state.longTasks.filter(task => task.at >= performance.now() - 5000 && task.duration > 50).length,
      gpuDuty5s: measuredDuty(state.gpuJobs, 5000),
      gpuDuty30s: measuredDuty(state.gpuJobs, 30000),
      cpuDuty5s: measuredDuty(state.cpuSlices, 5000),
      cpuDuty30s: measuredDuty(state.cpuSlices, 30000),
      jsHeapBytes: state.memory.at(-1)?.bytes || null,
      jsHeapSlopeBytesPerMinute: memorySlope()
    };
  }

  function publish() {
    const detail = status();
    window.__stayResponsivenessStatus = detail;
    window.dispatchEvent(new CustomEvent('stay-responsiveness-status', { detail }));
    return detail;
  }

  setInterval(sampleMemory, 10000);
  setInterval(recompute, 2000);
  window.STAYComputeGovernor = { version: VERSION, beforeGpuDispatch, cpuPolicy, recordGpuJob, recordCpuSlice, status, publish };
  recompute();
})();
