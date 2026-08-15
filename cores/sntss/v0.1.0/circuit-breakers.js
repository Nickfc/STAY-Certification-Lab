'use strict';

const { BREAKER_POLICY } = require('./source-registry');

const SEVERE_CODES = new Set([
  'SNTSS_DIRECT_CHEMICAL_COMMAND', 'SNTSS_AUTHORITY_STALE', 'SNTSS_PROVENANCE_FORGED',
  'SNTSS_CAUSAL_CIRCULAR', 'SNTSS_CAUSAL_DESCENDANT', 'SNTSS_EVIDENCE_CONTRADICTION'
]);

function createBreaker() {
  return { mode: 'closed', failureWindowStartedAt: null, failureCount: 0, openedAt: null, reasonCode: null, probes: 0 };
}

function validateBreaker(input) {
  if (!input || !['closed', 'open'].includes(input.mode) || !Number.isSafeInteger(input.failureCount) || input.failureCount < 0) {
    throw Object.assign(new Error('circuit breaker state is invalid'), { code: 'SNTSS_BREAKER_STATE' });
  }
  return input;
}

function inspectBreaker(input, atMs) {
  const breaker = validateBreaker(input);
  if (breaker.mode === 'closed') return { blocked: false, probeRequired: false };
  const elapsed = atMs - breaker.openedAt;
  if (!Number.isSafeInteger(elapsed) || elapsed < BREAKER_POLICY.recoveryMs) return { blocked: true, probeRequired: false };
  return { blocked: false, probeRequired: true };
}

function recordFailure(input, atMs, reasonCode) {
  const breaker = { ...validateBreaker(input) };
  const newWindow = breaker.failureWindowStartedAt == null || atMs - breaker.failureWindowStartedAt >= BREAKER_POLICY.violationWindowMs;
  if (newWindow) { breaker.failureWindowStartedAt = atMs; breaker.failureCount = 0; }
  breaker.failureCount += 1;
  if (SEVERE_CODES.has(reasonCode) || breaker.failureCount >= BREAKER_POLICY.violationThreshold) {
    breaker.mode = 'open';
    breaker.openedAt = atMs;
    breaker.reasonCode = reasonCode;
  }
  return breaker;
}

function closeAfterProbe(input) {
  const breaker = validateBreaker(input);
  return { ...createBreaker(), probes: Number(breaker.probes || 0) + 1 };
}

function recordSuccess(input, atMs) {
  const breaker = { ...validateBreaker(input) };
  if (breaker.mode === 'open') return breaker;
  if (breaker.failureWindowStartedAt != null && atMs - breaker.failureWindowStartedAt >= BREAKER_POLICY.violationWindowMs) {
    breaker.failureWindowStartedAt = null;
    breaker.failureCount = 0;
  }
  return breaker;
}

module.exports = { SEVERE_CODES, createBreaker, validateBreaker, inspectBreaker, recordFailure, closeAfterProbe, recordSuccess };
