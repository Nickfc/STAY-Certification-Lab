'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BoundedActorQueue } = require('../runtime/kernel/actor-queue');
const { ShadowEvidence } = require('../runtime/kernel/shadow-evidence');
const { ComputeFabric } = require('../runtime/compute/compute-fabric');

test('telemetry coalesces, disposable events drop, and critical overflow is fail-visible', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const queue = new BoundedActorQueue({ name: 'bounded-test', capacity: 2, handlerTimeoutMs: 1000, handler: () => gate });
  const first = queue.enqueue({ sequence: 1, topic: 'telemetry.cursor', class: 'telemetry', meta: { coalesceKey: 'cursor' } });
  const promises = [];
  for (let i = 2; i < 50; i++) promises.push(queue.enqueue({ sequence: i, topic: 'telemetry.cursor', class: 'telemetry', meta: { coalesceKey: 'cursor' } }));
  const criticalA = queue.enqueue({ sequence: 50, topic: 'critical.a', class: 'critical' });
  await assert.rejects(() => queue.enqueue({ sequence: 51, topic: 'critical.b', class: 'critical' }), error => error.code === 'ACTOR_QUEUE_OVERFLOW');
  assert.ok(queue.snapshotMetrics().coalesced > 0 || queue.snapshotMetrics().dropped > 0);
  release();
  await Promise.allSettled([first, criticalA, ...promises]);
  queue.close();
});

test('shadow evidence remains flat-bounded across high-output runs', () => {
  const evidence = new ShadowEvidence({ sampleLimit: 32, activeWindow: 64 });
  for (let i = 1; i <= 10000; i++) {
    evidence.recordActive({ eventSequence: i, topic: 'pulse', payload: { value: i } });
    evidence.recordShadow({ eventSequence: i, topic: 'pulse', payload: { value: i } });
  }
  const summary = evidence.summary();
  assert.equal(summary.count, 10000);
  assert.equal(summary.agreementRate, 1);
  assert.equal(summary.retainedSamples, 32);
  assert.equal(evidence.active.size, 64);
});

test('capability-aware scheduler isolates stale and malformed mixed-node work', () => {
  const fabric = new ComputeFabric({ maxTaskHistory: 32 });
  fabric.registerNode('desktop-gpu', {
    platform: 'desktop', reliability: 0.99, latencyMs: 12,
    cpu: { logicalThreads: 24, throughput: 5000, safeDuty: 0.2 },
    gpu: { available: true, throughput: 100000, safeDuty: 0.8, maxBufferBytes: 1024 ** 3 }
  });
  fabric.registerNode('old-cpu', {
    platform: 'desktop', reliability: 0.9, latencyMs: 30,
    cpu: { logicalThreads: 4, throughput: 1200, safeDuty: 0.2 }, gpu: { available: false }
  });
  fabric.registerNode('phone', {
    platform: 'mobile', mobile: true, reliability: 0.8, latencyMs: 60,
    cpu: { logicalThreads: 8, throughput: 800, safeDuty: 0.08 },
    gpu: { available: true, throughput: 5000, safeDuty: 0.1, maxBufferBytes: 32 * 1024 ** 2 }
  });
  const task = fabric.submitTask({ taskId: 'gpu-1', workloadClass: 'policy-search', resource: 'gpu', epoch: 4, memoryBytes: 64 * 1024 ** 2, payload: {} });
  assert.equal(fabric.assign(task.taskId).nodeId, 'desktop-gpu');
  assert.equal(fabric.acceptResult({ nodeId: 'desktop-gpu', taskId: 'gpu-1', epoch: 3, result: {} }).reason, 'stale-epoch');
  const cpu = fabric.submitTask({ taskId: 'cpu-1', workloadClass: 'probe', resource: 'cpu', epoch: 5, payload: {} });
  const assignment = fabric.assign(cpu.taskId);
  assert.notEqual(assignment.nodeId, null);
  assert.equal(fabric.acceptResult({ nodeId: assignment.nodeId, taskId: cpu.taskId, epoch: 5, result: { ok: true } }, result => result.ok).accepted, true);
  assert.ok(fabric.status().retainedHistory <= 32);
});

test('compute fabric bounds live tasks, expires leases and requires verification', () => {
  let now = 1000;
  const fabric = new ComputeFabric({
    maxTaskHistory: 2, maxTasks: 2, assignmentLeaseMs: 1000, taskTtlMs: 5000, clock: () => now
  });
  fabric.registerNode('node', {
    reliability: 1,
    cpu: { logicalThreads: 4, throughput: 100, safeDuty: 0.5 },
    gpu: { available: false }
  });
  fabric.submitTask({ taskId: 'one', workloadClass: 'probe', resource: 'cpu', epoch: 1, deadlineAt: 10000, payload: {} });
  fabric.submitTask({ taskId: 'two', workloadClass: 'probe', resource: 'cpu', epoch: 1, deadlineAt: 10000, payload: {} });
  assert.throws(() => fabric.submitTask({ taskId: 'three', workloadClass: 'probe', resource: 'cpu', epoch: 1, deadlineAt: 10000, payload: {} }), error => error.code === 'COMPUTE_TASK_CAPACITY');
  assert.equal(fabric.assign('one').nodeId, 'node');
  now += 1001;
  assert.equal(fabric.assign('one').nodeId, 'node');
  assert.deepEqual(fabric.acceptResult({ nodeId: 'node', taskId: 'one', epoch: 1, result: { ok: true } }), { accepted: false, reason: 'verifier-required' });
  assert.ok(fabric.status().taskCapacity === 2);
});
