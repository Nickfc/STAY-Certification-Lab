'use strict';

const crypto = require('node:crypto');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function divergence(a, b) {
  if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b);
  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.max(a.length, b.length);
    if (!length) return 0;
    let total = 0;
    for (let i = 0; i < length; i++) total += divergence(a[i], b[i]);
    return total / length;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    if (!keys.size) return 0;
    let total = 0;
    for (const key of keys) total += divergence(a[key], b[key]);
    return total / keys.size;
  }
  return Object.is(a, b) ? 0 : 1;
}

class ShadowEvidence {
  constructor({ sampleLimit = 128, activeWindow = 512 } = {}) {
    this.sampleLimit = Math.max(1, sampleLimit);
    this.activeWindow = Math.max(this.sampleLimit, activeWindow);
    this.active = new Map();
    this.samples = [];
    this.count = 0;
    this.matches = 0;
    this.divergenceSum = 0;
    this.maxDivergence = 0;
    this.latencySumMs = 0;
    this.maxLatencyMs = 0;
    this.invariantFailures = 0;
    this.rolling = crypto.createHash('sha256');
    this.rollingDigest = digest('empty');
  }

  key(eventSequence, topic) { return `${Number(eventSequence) || 0}:${topic}`; }

  recordActive({ eventSequence, topic, payload, at = Date.now() }) {
    const key = this.key(eventSequence, topic);
    this.active.set(key, { payload: structuredClone(payload), digest: digest(payload), at });
    while (this.active.size > this.activeWindow) this.active.delete(this.active.keys().next().value);
  }

  recordShadow({ eventSequence, topic, payload, at = Date.now(), invariantOk = true }) {
    const key = this.key(eventSequence, topic);
    const reference = this.active.get(key);
    const candidateDigest = digest(payload);
    const delta = reference ? divergence(reference.payload, payload) : 1;
    const matched = Boolean(reference) && reference.digest === candidateDigest;
    const latencyMs = reference ? Math.max(0, at - reference.at) : 0;
    this.count += 1;
    if (matched) this.matches += 1;
    this.divergenceSum += delta;
    this.maxDivergence = Math.max(this.maxDivergence, delta);
    this.latencySumMs += latencyMs;
    this.maxLatencyMs = Math.max(this.maxLatencyMs, latencyMs);
    if (!invariantOk) this.invariantFailures += 1;
    const compact = { eventSequence, topic, matched, divergence: delta, latencyMs, candidateDigest, activeDigest: reference?.digest || null };
    this.samples.push(compact);
    if (this.samples.length > this.sampleLimit) this.samples.shift();
    this.rolling.update(JSON.stringify(compact));
    this.rollingDigest = digest([this.rollingDigest, compact]);
    return compact;
  }

  summary() {
    return {
      count: this.count,
      agreementRate: this.count ? this.matches / this.count : null,
      meanDivergence: this.count ? this.divergenceSum / this.count : null,
      maxDivergence: this.maxDivergence,
      meanLatencyMs: this.count ? this.latencySumMs / this.count : null,
      maxLatencyMs: this.maxLatencyMs,
      invariantFailures: this.invariantFailures,
      rollingDigest: this.rollingDigest,
      retainedSamples: this.samples.length,
      sampleLimit: this.sampleLimit,
      recent: this.samples.slice()
    };
  }
}

module.exports = { ShadowEvidence, digest, divergence };
