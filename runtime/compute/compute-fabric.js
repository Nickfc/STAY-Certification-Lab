'use strict';

const crypto = require('node:crypto');
const { assertPayload } = require('../kernel/protocol');

const WORKLOAD_CLASSES = new Set(['policy-search', 'simulation', 'dreaming', 'memory-consolidation', 'model-training', 'probe']);

function boundedNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function normalizeCapabilities(input = {}) {
  assertPayload(input, 'compute capability profile', 64 * 1024);
  const gpu = input.gpu && typeof input.gpu === 'object' ? input.gpu : {};
  const cpu = input.cpu && typeof input.cpu === 'object' ? input.cpu : {};
  return Object.freeze({
    platform: String(input.platform || 'unknown').slice(0, 80),
    mobile: Boolean(input.mobile),
    memoryGiB: boundedNumber(input.memoryGiB, 0, 1024, 0),
    latencyMs: boundedNumber(input.latencyMs, 0, 60000, 0),
    reliability: boundedNumber(input.reliability, 0, 1, 0.5),
    cpu: Object.freeze({
      logicalThreads: Math.floor(boundedNumber(cpu.logicalThreads, 1, 512, 1)),
      throughput: boundedNumber(cpu.throughput, 0, Number.MAX_SAFE_INTEGER, 0),
      safeDuty: boundedNumber(cpu.safeDuty, 0, 1, 0)
    }),
    gpu: Object.freeze({
      available: Boolean(gpu.available),
      adapterKey: String(gpu.adapterKey || '').slice(0, 200),
      throughput: boundedNumber(gpu.throughput, 0, Number.MAX_SAFE_INTEGER, 0),
      safeDuty: boundedNumber(gpu.safeDuty, 0, 1, 0),
      maxBufferBytes: Math.floor(boundedNumber(gpu.maxBufferBytes, 0, 2 ** 40, 0))
    })
  });
}

function validateTaskEnvelope(input) {
  assertPayload(input, 'compute task envelope', 1024 * 1024);
  if (!input || typeof input !== 'object') throw new Error('task envelope must be an object');
  const workloadClass = String(input.workloadClass || 'probe');
  if (!WORKLOAD_CLASSES.has(workloadClass)) throw new Error('unknown workload class: ' + workloadClass);
  const resource = ['cpu', 'gpu', 'either'].includes(input.resource) ? input.resource : 'either';
  const epoch = Number(input.epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('task epoch must be a non-negative integer');
  return Object.freeze({
    taskId: String(input.taskId || crypto.randomUUID()).slice(0, 120),
    workloadClass,
    resource,
    epoch,
    deadlineAt: boundedNumber(input.deadlineAt, 0, Number.MAX_SAFE_INTEGER, Date.now() + 30000),
    staleAfterEpoch: Number.isSafeInteger(Number(input.staleAfterEpoch)) ? Number(input.staleAfterEpoch) : epoch,
    verification: String(input.verification || 'canonical').slice(0, 80),
    memoryBytes: Math.floor(boundedNumber(input.memoryBytes, 0, 2 ** 40, 0)),
    payload: input.payload
  });
}

class ComputeFabric {
  constructor({
    maxNodes = 10000,
    maxTaskHistory = 2048,
    maxTasks = maxTaskHistory * 2,
    nodeTtlMs = 120000,
    taskTtlMs = 300000,
    assignmentLeaseMs = 30000,
    verifiers = {},
    clock = () => Date.now()
  } = {}) {
    this.maxNodes = maxNodes;
    this.maxTaskHistory = maxTaskHistory;
    this.nodeTtlMs = nodeTtlMs;
    this.taskTtlMs = Math.max(1000, Number(taskTtlMs) || 300000);
    this.assignmentLeaseMs = Math.max(1000, Number(assignmentLeaseMs) || 30000);
    this.maxTasks = Math.max(1, Number(maxTasks) || maxTaskHistory * 2);
    this.verifiers = new Map(Object.entries(verifiers));
    this.clock = clock;
    this.nodes = new Map();
    this.tasks = new Map();
    this.history = [];
    this.currentEpoch = 0;
    this.metrics = { assigned: 0, completed: 0, rejected: 0, stale: 0, duplicate: 0, malformed: 0 };
  }

  registerNode(nodeId, capabilities) {
    this.reapExpired();
    const id = String(nodeId || '').slice(0, 160);
    if (!id) throw new Error('compute node id is required');
    if (!this.nodes.has(id) && this.nodes.size >= this.maxNodes) this.evictNode();
    const previous = this.nodes.get(id);
    const record = {
      nodeId: id,
      capabilities: normalizeCapabilities(capabilities),
      connectedAt: previous?.connectedAt || this.clock(),
      lastSeenAt: this.clock(),
      inFlight: [...this.tasks.values()].filter(task => task.status === 'assigned' && task.assignedNodeId === id).length,
      completed: previous?.completed || 0,
      failures: previous?.failures || 0,
      quarantinedUntil: previous?.quarantinedUntil || 0
    };
    this.nodes.set(id, record);
    return this.publicNode(record);
  }

  evictNode() {
    const candidates = [...this.nodes.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    const target = candidates.find(node => node.inFlight === 0);
    if (!target) throw Object.assign(new Error('all compute nodes have in-flight work'), { code: 'COMPUTE_NODE_CAPACITY' });
    this.nodes.delete(target.nodeId);
  }

  touchNode(nodeId) { const node = this.nodes.get(nodeId); if (node) node.lastSeenAt = this.clock(); return node || null; }

  submitTask(envelope) {
    this.reapExpired();
    const task = validateTaskEnvelope(envelope);
    if (this.tasks.has(task.taskId)) throw new Error('duplicate task id');
    this.trimTasks();
    if (this.tasks.size >= this.maxTasks) {
      throw Object.assign(new Error(`compute task capacity ${this.maxTasks} exhausted`), { code: 'COMPUTE_TASK_CAPACITY' });
    }
    this.currentEpoch = Math.max(this.currentEpoch, task.epoch);
    const record = { envelope: task, status: 'queued', assignedNodeId: null, createdAt: this.clock(), assignedAt: null, leaseExpiresAt: null, completedAt: null };
    this.tasks.set(task.taskId, record);
    this.trimTasks();
    return task;
  }

  scoreNode(node, task) {
    const caps = node.capabilities;
    if (node.quarantinedUntil > this.clock() || this.clock() - node.lastSeenAt > this.nodeTtlMs) return -Infinity;
    if (task.resource === 'gpu' && !caps.gpu.available) return -Infinity;
    if (task.memoryBytes > 0 && caps.gpu.available && task.resource === 'gpu' && caps.gpu.maxBufferBytes < task.memoryBytes) return -Infinity;
    const gpuScore = caps.gpu.available ? caps.gpu.throughput * caps.gpu.safeDuty : 0;
    const cpuScore = caps.cpu.throughput * caps.cpu.safeDuty;
    const throughput = task.resource === 'gpu' ? gpuScore : task.resource === 'cpu' ? cpuScore : Math.max(gpuScore, cpuScore);
    const headroom = 1 / (1 + node.inFlight);
    const latencyPenalty = 1 / (1 + caps.latencyMs / 1000);
    const mobilePenalty = caps.mobile && task.workloadClass === 'model-training' ? 0.25 : 1;
    return throughput * headroom * latencyPenalty * Math.max(0.05, caps.reliability) * mobilePenalty;
  }

  assign(taskId) {
    this.reapExpired();
    const record = this.tasks.get(taskId);
    if (!record || record.status !== 'queued') return null;
    const task = record.envelope;
    if (task.deadlineAt <= this.clock() || task.staleAfterEpoch < this.currentEpoch) {
      record.status = 'stale'; this.metrics.stale += 1; return null;
    }
    const ranked = [...this.nodes.values()].map(node => ({ node, score: this.scoreNode(node, task) }))
      .filter(entry => Number.isFinite(entry.score) && entry.score >= 0).sort((a, b) => b.score - a.score);
    if (!ranked.length) return null;
    const node = ranked[0].node;
    node.inFlight += 1;
    node.lastSeenAt = this.clock();
    record.status = 'assigned';
    record.assignedNodeId = node.nodeId;
    record.assignedAt = this.clock();
    record.leaseExpiresAt = record.assignedAt + this.assignmentLeaseMs;
    this.metrics.assigned += 1;
    return { nodeId: node.nodeId, task };
  }

  acceptResult({ nodeId, taskId, epoch, result }, verify = null) {
    this.reapExpired();
    const record = this.tasks.get(String(taskId));
    const node = this.touchNode(String(nodeId));
    if (!record || !node) { this.metrics.malformed += 1; return { accepted: false, reason: 'unknown-task-or-node' }; }
    if (record.status === 'completed') { this.metrics.duplicate += 1; return { accepted: false, reason: 'duplicate' }; }
    if (record.assignedNodeId !== node.nodeId) { this.metrics.rejected += 1; return { accepted: false, reason: 'wrong-node' }; }
    node.inFlight = Math.max(0, node.inFlight - 1);
    if (Number(epoch) !== record.envelope.epoch || record.envelope.staleAfterEpoch < this.currentEpoch) {
      record.status = 'stale'; this.metrics.stale += 1; return { accepted: false, reason: 'stale-epoch' };
    }
    try { assertPayload(result, 'compute result', 1024 * 1024); }
    catch {
      node.failures += 1;
      record.status = 'rejected';
      this.metrics.malformed += 1;
      return { accepted: false, reason: 'malformed-result' };
    }
    const verifier = typeof verify === 'function' ? verify : this.verifiers.get(record.envelope.verification);
    if (typeof verifier !== 'function') {
      node.failures += 1;
      record.status = 'rejected';
      this.metrics.rejected += 1;
      return { accepted: false, reason: 'verifier-required' };
    }
    let valid = false;
    try { valid = verifier(result, record.envelope, node.capabilities) === true; }
    catch { valid = false; }
    if (!valid) {
      node.failures += 1;
      if (node.failures >= 3) node.quarantinedUntil = this.clock() + 60000;
      record.status = 'rejected'; this.metrics.rejected += 1;
      return { accepted: false, reason: 'verification' };
    }
    node.completed += 1;
    record.status = 'completed';
    record.completedAt = this.clock();
    this.metrics.completed += 1;
    this.history.push({ taskId: record.envelope.taskId, nodeId: node.nodeId, epoch: record.envelope.epoch, completedAt: record.completedAt });
    if (this.history.length > this.maxTaskHistory) this.history.splice(0, this.history.length - this.maxTaskHistory);
    return { accepted: true };
  }

  trimTasks() {
    if (this.tasks.size < this.maxTasks) return;
    for (const [id, task] of this.tasks) {
      if (task.status !== 'queued' && task.status !== 'assigned') this.tasks.delete(id);
      if (this.tasks.size < this.maxTasks) break;
    }
  }

  reapExpired() {
    const now = this.clock();
    for (const [id, task] of this.tasks) {
      if (task.status === 'assigned' && task.leaseExpiresAt <= now) {
        const node = this.nodes.get(task.assignedNodeId);
        if (node) { node.inFlight = Math.max(0, node.inFlight - 1); node.failures += 1; }
        task.assignedNodeId = null;
        task.assignedAt = null;
        task.leaseExpiresAt = null;
        if (task.envelope.deadlineAt <= now || task.envelope.staleAfterEpoch < this.currentEpoch) {
          task.status = 'stale';
          this.metrics.stale += 1;
        } else task.status = 'queued';
      }
      if (task.status === 'queued' && (task.envelope.deadlineAt <= now || now - task.createdAt > this.taskTtlMs)) {
        task.status = 'stale';
        this.metrics.stale += 1;
      }
      if (!['queued', 'assigned'].includes(task.status) && now - (task.completedAt || task.createdAt) > this.taskTtlMs) this.tasks.delete(id);
    }
    for (const [id, node] of this.nodes) {
      if (node.inFlight === 0 && now - node.lastSeenAt > this.nodeTtlMs * 2) this.nodes.delete(id);
    }
  }

  publicNode(node) {
    return { nodeId: node.nodeId, capabilities: node.capabilities, lastSeenAt: node.lastSeenAt, inFlight: node.inFlight, completed: node.completed, failures: node.failures };
  }

  status() {
    this.reapExpired();
    const now = this.clock();
    const activeNodes = [...this.nodes.values()].filter(node => now - node.lastSeenAt <= this.nodeTtlMs).length;
    return {
      protocol: 'stay-compute-fabric-v1',
      currentEpoch: this.currentEpoch,
      nodes: this.nodes.size,
      activeNodes,
      queuedTasks: [...this.tasks.values()].filter(task => task.status === 'queued').length,
      assignedTasks: [...this.tasks.values()].filter(task => task.status === 'assigned').length,
      retainedHistory: this.history.length,
      historyLimit: this.maxTaskHistory,
      taskCapacity: this.maxTasks,
      metrics: { ...this.metrics }
    };
  }
}

module.exports = { ComputeFabric, normalizeCapabilities, validateTaskEnvelope, WORKLOAD_CLASSES };
