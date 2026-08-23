'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { injectRuntimeScripts } = require('../server');

const root = path.join(__dirname, '..');

test('GPU v3 performs GPU-side reduction with tiny readback and persistent buffers', () => {
  const source = fs.readFileSync(path.join(root, 'runtime', 'ui', 'gpu-engine.js'), 'utf8');
  assert.match(source, /stay-webgpu-search-v3/);
  assert.match(source, /reductionShader/);
  assert.match(source, /copyBufferToBuffer\(finalResultBuffer, 0, readbackBuffer, 0, 16\)/);
  assert.doesNotMatch(source, /new Float32Array\(readback\.getMappedRange\(\)\)/);
  assert.match(source, /ensureBuffer\('group-results'/);
  assert.match(source, /overlapping GPU jobs are forbidden/);
  assert.match(source, /measuredDuty30s/);
  assert.match(source, /lastCooldownMs/);
});

test('viewer contract observes long tasks, interaction, memory slope and mobile ceilings', () => {
  const source = fs.readFileSync(path.join(root, 'runtime', 'ui', 'compute-governor.js'), 'utf8');
  assert.match(source, /PerformanceObserver/);
  assert.match(source, /duration > 250/);
  assert.match(source, /active-interaction/);
  assert.match(source, /jsHeapSlopeBytesPerMinute/);
  assert.match(source, /mobileCeiling/);
  assert.match(source, /poolSize: concurrency/);
  assert.match(source, /sliceMs = 4/);
});

test('runtime script order installs governor before GPU and client code', () => {
  const output = injectRuntimeScripts('<html><body><script src="/client.js" defer></script></body></html>');
  const governor = output.indexOf('/__stay/compute-governor.js');
  const gpu = output.indexOf('/__stay/gpu-engine.js');
  const client = output.indexOf('/client.js');
  assert.ok(governor > 0 && governor < gpu && gpu < client);
});

test('GPU-only path contains no CPU candidate-search fallback', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const badge = fs.readFileSync(path.join(root, 'runtime', 'ui', 'live-badge.js'), 'utf8');
  assert.match(server, /engineResolved === 'gpu' \? targetShare/);
  assert.match(server, /engineResolved === 'gpu' \? targetShare[\s\S]*: 0;/);
  assert.match(badge, /GPU ONLY selected · CPU fallback OFF/);
});
