'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('./canonical-json');

const HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const REASON_CODE = /^[A-Z0-9][A-Z0-9._:-]{0,127}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const FORENSIC_READ_CAPABILITY = 'sntss.forensic.read';
const MAX_ARRAY = 32;
const MAX_RECORD_BYTES = 16384;
const MAX_PUBLIC_BYTES = 2048;
const MAX_OPERATOR_BYTES = 8192;

const TOP_LEVEL_KEYS = new Set([
  'transitionId', 'observedAtMs', 'input', 'beforeStateHash', 'afterStateHash', 'clamps',
  'circuitChanges', 'migrations', 'emittedFrameIds', 'evidenceCursor', 'profileHash',
  'candidateVersion', 'checkpointHash', 'auditHeadHash'
]);
const INPUT_KEYS = new Set(['eventId', 'sequence', 'topic', 'status', 'reasonCode']);
const STATUSES = new Set(['accepted', 'rejected', 'probe', 'replay', 'migration', 'internal']);

function fail(message, code = 'SNTSS_OBSERVABILITY_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function assertHash(value, label, nullable = false) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} is not a canonical sha256 hash`, 'SNTSS_FORENSIC_HASH');
  return value;
}
function assertIdentifier(value, label, nullable = false) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(`${label} is invalid`, 'SNTSS_FORENSIC_IDENTIFIER');
  return value;
}
function assertReason(value) {
  if (typeof value !== 'string' || !REASON_CODE.test(value)) fail('reason code is invalid', 'SNTSS_FORENSIC_REASON');
  return value;
}
function assertInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`, 'SNTSS_FORENSIC_INTEGER');
  return value;
}
function assertAllowedKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`, 'SNTSS_FORENSIC_SHAPE');
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} contains forbidden field: ${key}`, 'SNTSS_PRIVATE_FIELD');
}
function boundedIdentifiers(values, label) {
  if (values == null) return [];
  if (!Array.isArray(values) || values.length > MAX_ARRAY) fail(`${label} exceeds its bound`, 'SNTSS_FORENSIC_BOUND');
  return values.map((value, index) => assertIdentifier(value, `${label}[${index}]`));
}

function normalizeTransition(transition) {
  assertAllowedKeys(transition, TOP_LEVEL_KEYS, 'transition');
  assertAllowedKeys(transition.input, INPUT_KEYS, 'transition.input');
  const input = {
    eventId: assertIdentifier(transition.input.eventId, 'input event id', true),
    sequence: transition.input.sequence == null ? null : assertInteger(transition.input.sequence, 'input sequence'),
    topic: assertIdentifier(transition.input.topic, 'input topic', true),
    status: String(transition.input.status || '')
  };
  if (!STATUSES.has(input.status)) fail('input status is invalid', 'SNTSS_FORENSIC_STATUS');
  input.reasonCode = assertReason(transition.input.reasonCode);
  const candidateVersion = String(transition.candidateVersion || '');
  if (!VERSION.test(candidateVersion)) fail('candidate version is invalid', 'SNTSS_FORENSIC_VERSION');
  return {
    transitionId: assertIdentifier(transition.transitionId, 'transition id'),
    observedAtMs: assertInteger(transition.observedAtMs, 'observed time'),
    input,
    beforeStateHash: assertHash(transition.beforeStateHash, 'before state hash'),
    afterStateHash: assertHash(transition.afterStateHash, 'after state hash'),
    clamps: boundedIdentifiers(transition.clamps, 'clamps'),
    circuitChanges: boundedIdentifiers(transition.circuitChanges, 'circuit changes'),
    migrations: boundedIdentifiers(transition.migrations, 'migrations'),
    emittedFrameIds: boundedIdentifiers(transition.emittedFrameIds, 'emitted frame ids'),
    evidenceCursor: assertInteger(transition.evidenceCursor, 'evidence cursor'),
    profileHash: assertHash(transition.profileHash, 'profile hash'),
    candidateVersion,
    checkpointHash: assertHash(transition.checkpointHash, 'checkpoint hash', true),
    auditHeadHash: assertHash(transition.auditHeadHash, 'audit head hash')
  };
}

function buildRecord(normalized, sequence, previousRecordHash, chainAnchorHash) {
  const body = {
    format: 'stay-sntss-forensic-record-v1',
    sequence,
    previousRecordHash,
    chainAnchorHash,
    transitionId: normalized.transitionId,
    observedAtMs: normalized.observedAtMs,
    input: normalized.input,
    state: { beforeHash: normalized.beforeStateHash, afterHash: normalized.afterStateHash },
    effects: {
      clampIds: normalized.clamps,
      circuitChangeIds: normalized.circuitChanges,
      migrationIds: normalized.migrations,
      emittedFrameIds: normalized.emittedFrameIds
    },
    evidence: {
      cursor: normalized.evidenceCursor,
      profileHash: normalized.profileHash,
      candidateVersion: normalized.candidateVersion,
      checkpointHash: normalized.checkpointHash,
      auditHeadHash: normalized.auditHeadHash
    }
  };
  const recordHash = hash(body);
  const record = Object.freeze({ ...body, recordHash });
  if (Buffer.byteLength(stableStringify(record)) > MAX_RECORD_BYTES) fail('forensic record exceeds byte bound', 'SNTSS_FORENSIC_BOUND');
  return record;
}

function verifyRecordHash(record) {
  const body = { ...record };
  delete body.recordHash;
  return HASH.test(record.recordHash || '') && hash(body) === record.recordHash;
}

function verifySegmentManifest(manifest) {
  const body = { ...manifest };
  delete body.manifestHash;
  return manifest?.format === 'stay-sntss-forensic-segment-v1' && HASH.test(manifest.manifestHash || '') && hash(body) === manifest.manifestHash;
}

function verifyForensicBundle(bundle, expectations = {}) {
  if (!bundle || bundle.format !== 'stay-sntss-forensic-bundle-v1' || !Array.isArray(bundle.records) || !Array.isArray(bundle.segments)) {
    fail('forensic bundle shape is invalid', 'SNTSS_FORENSIC_BUNDLE');
  }
  const initialAnchor = assertHash(expectations.expectedAnchorHash || bundle.initialAnchorHash, 'expected anchor hash');
  if (bundle.initialAnchorHash !== initialAnchor) fail('forensic initial anchor mismatch', 'SNTSS_FORENSIC_CHAIN');
  let segmentAnchor = initialAnchor;
  let segmentSequence = 0;
  let segmentIndex = 0;
  for (const segment of bundle.segments) {
    if (!verifySegmentManifest(segment)) fail('forensic segment manifest is corrupt', 'SNTSS_FORENSIC_SEGMENT');
    segmentIndex += 1;
    if (segment.segmentIndex !== segmentIndex) fail('forensic segment omission or reorder', 'SNTSS_FORENSIC_SEGMENT');
    if (segment.anchorHash !== segmentAnchor) fail('forensic segment chain break', 'SNTSS_FORENSIC_CHAIN');
    if (segment.firstSequence !== segmentSequence + 1 || segment.lastSequence !== segment.firstSequence + segment.recordCount - 1) {
      fail('forensic segment sequence gap', 'SNTSS_FORENSIC_SEQUENCE');
    }
    segmentAnchor = segment.headHash;
    segmentSequence = segment.lastSequence;
  }
  if (bundle.currentAnchorHash !== segmentAnchor || Number(bundle.currentAnchorSequence || 0) !== segmentSequence) {
    fail('forensic current anchor does not follow retained segment manifests', 'SNTSS_FORENSIC_CHAIN');
  }
  let previous = bundle.currentAnchorHash;
  let previousSequence = Number(bundle.currentAnchorSequence || 0);
  for (const record of bundle.records) {
    if (!verifyRecordHash(record)) fail('forensic record hash mismatch', 'SNTSS_FORENSIC_TAMPER');
    if (record.chainAnchorHash !== bundle.currentAnchorHash) fail('forensic record anchor mismatch', 'SNTSS_FORENSIC_CHAIN');
    if (record.previousRecordHash !== previous) fail('forensic record chain break', 'SNTSS_FORENSIC_CHAIN');
    if (record.sequence !== previousSequence + 1) fail('forensic sequence omission or reorder', 'SNTSS_FORENSIC_SEQUENCE');
    if (expectations.expectedCandidateVersion && record.evidence.candidateVersion !== expectations.expectedCandidateVersion) {
      fail('forensic candidate version mismatch', 'SNTSS_FORENSIC_CANDIDATE');
    }
    if (expectations.expectedProfileHash && record.evidence.profileHash !== expectations.expectedProfileHash) {
      fail('forensic profile hash mismatch', 'SNTSS_FORENSIC_PROFILE');
    }
    previous = record.recordHash;
    previousSequence = record.sequence;
  }
  const headHash = bundle.records.length ? bundle.records.at(-1).recordHash : bundle.currentAnchorHash;
  if (bundle.headHash !== headHash) fail('forensic bundle head is inconsistent', 'SNTSS_FORENSIC_HEAD');
  if (expectations.expectedHeadHash && headHash !== expectations.expectedHeadHash) fail('forensic head mismatch', 'SNTSS_FORENSIC_HEAD');
  if (expectations.expectedCount != null && bundle.totalRecords !== expectations.expectedCount) fail('forensic record count mismatch', 'SNTSS_FORENSIC_COUNT');
  if (bundle.totalRecords !== previousSequence) fail('forensic total count does not match retained chain position', 'SNTSS_FORENSIC_COUNT');
  return { ok: true, headHash, currentRecords: bundle.records.length, totalRecords: bundle.totalRecords };
}

function explainTransition(bundle, transitionId, expectations = {}) {
  const verified = verifyForensicBundle(bundle, expectations);
  const matches = bundle.records.filter(record => record.transitionId === transitionId);
  if (matches.length !== 1) fail('transition is absent or ambiguous in retained forensic records', 'SNTSS_FORENSIC_EXPLAIN');
  const record = matches[0];
  return Object.freeze({
    format: 'stay-sntss-transition-explanation-v1',
    transitionId: record.transitionId,
    recordHash: record.recordHash,
    chainHeadHash: verified.headHash,
    input: clone(record.input),
    stateBeforeHash: record.state.beforeHash,
    stateAfterHash: record.state.afterHash,
    clampIds: [...record.effects.clampIds],
    circuitChangeIds: [...record.effects.circuitChangeIds],
    migrationIds: [...record.effects.migrationIds],
    emittedFrameIds: [...record.effects.emittedFrameIds],
    evidenceCursor: record.evidence.cursor,
    profileHash: record.evidence.profileHash,
    candidateVersion: record.evidence.candidateVersion,
    checkpointHash: record.evidence.checkpointHash,
    auditHeadHash: record.evidence.auditHeadHash
  });
}

class SntssObservabilityPlane {
  constructor({ anchorHash, sink = null, forensicCapacity = 4096, segmentCapacity = 128 } = {}) {
    this.initialAnchorHash = assertHash(anchorHash, 'forensic anchor hash');
    this.currentAnchorHash = this.initialAnchorHash;
    this.currentAnchorSequence = 0;
    this.headHash = this.initialAnchorHash;
    this.sink = typeof sink === 'function' ? sink : null;
    this.forensicCapacity = Math.max(8, Math.min(65536, Number(forensicCapacity) || 4096));
    this.segmentCapacity = Math.max(1, Math.min(1024, Number(segmentCapacity) || 128));
    this.records = [];
    this.segments = [];
    this.totalRecords = 0;
    this.counters = { accepted: 0, rejected: 0, probe: 0, replay: 0, migration: 0, internal: 0 };
    this.telemetryDrops = 0;
    this.sinkFailures = 0;
    this.lastReasonCode = null;
    this.lastStatus = null;
    this.lastProfileHash = null;
    this.lastCandidateVersion = null;
  }

  rotate() {
    if (!this.records.length) return null;
    const first = this.records[0];
    const last = this.records.at(-1);
    const body = {
      format: 'stay-sntss-forensic-segment-v1',
      segmentIndex: this.segments.length + 1,
      firstSequence: first.sequence,
      lastSequence: last.sequence,
      recordCount: this.records.length,
      anchorHash: this.currentAnchorHash,
      headHash: last.recordHash
    };
    const manifest = Object.freeze({ ...body, manifestHash: hash(body) });
    this.segments = [...this.segments, manifest].slice(-this.segmentCapacity);
    this.currentAnchorHash = last.recordHash;
    this.currentAnchorSequence = last.sequence;
    this.records = [];
    return manifest;
  }

  capture(transition) {
    let record;
    try {
      const normalized = normalizeTransition(transition);
      if (this.records.length >= this.forensicCapacity) this.rotate();
      const sequence = this.totalRecords + 1;
      record = buildRecord(normalized, sequence, this.headHash, this.currentAnchorHash);
      this.records.push(record);
      this.totalRecords = sequence;
      this.headHash = record.recordHash;
      this.counters[normalized.input.status] += 1;
      this.lastReasonCode = normalized.input.reasonCode;
      this.lastStatus = normalized.input.status;
      this.lastProfileHash = normalized.profileHash;
      this.lastCandidateVersion = normalized.candidateVersion;
    } catch (error) {
      this.telemetryDrops += 1;
      return Object.freeze({ captured: false, degraded: true, code: error.code || 'SNTSS_OBSERVABILITY_CAPTURE' });
    }
    if (this.sink) {
      try {
        const pending = this.sink(record);
        if (pending && typeof pending.then === 'function') pending.catch(() => { this.sinkFailures += 1; });
      } catch { this.sinkFailures += 1; }
    }
    return Object.freeze({ captured: true, degraded: this.sinkFailures > 0, recordHash: record.recordHash, sequence: record.sequence });
  }

  publicSummary() {
    const summary = {
      format: 'stay-sntss-public-summary-v1',
      observability: this.telemetryDrops || this.sinkFailures ? 'degraded' : 'ok',
      transitionCount: Math.min(this.totalRecords, 999999999),
      acceptedCount: Math.min(this.counters.accepted, 999999999),
      rejectedCount: Math.min(this.counters.rejected, 999999999),
      probeCount: Math.min(this.counters.probe, 999999999),
      telemetryDropCount: Math.min(this.telemetryDrops + this.sinkFailures, 999999999)
    };
    if (Buffer.byteLength(stableStringify(summary)) > MAX_PUBLIC_BYTES) fail('public summary exceeds byte bound', 'SNTSS_PUBLIC_BOUND');
    return Object.freeze(summary);
  }

  operatorHealth() {
    const health = {
      format: 'stay-sntss-operator-health-v1',
      ok: this.telemetryDrops === 0 && this.sinkFailures === 0,
      transitionCount: this.totalRecords,
      retainedForensicRecords: this.records.length,
      rotatedSegments: this.segments.length,
      telemetryDrops: this.telemetryDrops,
      sinkFailures: this.sinkFailures,
      chainHeadHash: this.headHash,
      lastStatus: this.lastStatus,
      lastReasonCode: this.lastReasonCode,
      profileHash: this.lastProfileHash,
      candidateVersion: this.lastCandidateVersion,
      alerts: [
        ...(this.telemetryDrops ? ['SNTSS_TELEMETRY_DROPPED'] : []),
        ...(this.sinkFailures ? ['SNTSS_TELEMETRY_SINK_FAILED'] : [])
      ]
    };
    if (Buffer.byteLength(stableStringify(health)) > MAX_OPERATOR_BYTES) fail('operator health exceeds byte bound', 'SNTSS_OPERATOR_BOUND');
    return Object.freeze(health);
  }

  forensicBundle(capability) {
    if (capability !== FORENSIC_READ_CAPABILITY) fail('forensic access denied', 'SNTSS_FORENSIC_ACCESS');
    return clone({
      format: 'stay-sntss-forensic-bundle-v1',
      initialAnchorHash: this.initialAnchorHash,
      currentAnchorHash: this.currentAnchorHash,
      currentAnchorSequence: this.currentAnchorSequence,
      headHash: this.headHash,
      totalRecords: this.totalRecords,
      segments: this.segments,
      records: this.records
    });
  }
}

module.exports = {
  FORENSIC_READ_CAPABILITY,
  MAX_RECORD_BYTES,
  hash,
  normalizeTransition,
  verifyRecordHash,
  verifySegmentManifest,
  verifyForensicBundle,
  explainTransition,
  SntssObservabilityPlane
};