'use strict';

const fp = require('./fixed-point');
const { assertActiveFamily, validateDriveMap } = require('./validation');
const { sourceRegistry, hash } = require('./source-registry');
const { validateAuthoritativeEvent } = require('./causal-validator');
const breakers = require('./circuit-breakers');

const EMPTY_TRACE = hash({ stage: 'r5', trace: 'genesis' });
const MAX_INDEX = 2048;
const MAX_TRACES = 256;

function fail(message, code = 'SNTSS_STIMULUS_STATE') { throw Object.assign(new Error(message), { code }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function boundedEntries(input, maximum = MAX_INDEX) {
  return Object.fromEntries(Object.entries(input).sort((a, b) => (a[1].sequence || 0) - (b[1].sequence || 0)).slice(-maximum));
}

function createStimulusState(startCursor = 0) {
  if (!Number.isSafeInteger(startCursor) || startCursor < 0) fail('stimulus cursor is invalid');
  return {
    stateVersion: 1, cursor: startCursor, breakers: {}, topicHistory: {}, sourceLastSeen: {}, habituation: {},
    causalRecords: {}, seenEvidence: {}, seenClaims: {}, contradictions: {}, traceHead: EMPTY_TRACE, traces: []
  };
}

function validateStimulusState(state) {
  const keys = ['breakers', 'causalRecords', 'contradictions', 'habituation', 'seenClaims', 'seenEvidence', 'sourceLastSeen', 'topicHistory'];
  if (!state || state.stateVersion !== 1 || !Number.isSafeInteger(state.cursor) || state.cursor < 0 || !Array.isArray(state.traces)
    || typeof state.traceHead !== 'string') fail('stimulus state is invalid');
  for (const key of keys) if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) fail(`stimulus ${key} is invalid`);
  return state;
}

function eventHash(event) {
  try { return hash(event); } catch { return hash({ invalidEnvelope: true }); }
}

function appendTrace(state, event, status, reasonCode, extra = {}) {
  const traceBody = {
    previousTraceHash: state.traceHead, sequence: Number.isSafeInteger(event?.sequence) ? event.sequence : null,
    topic: typeof event?.topic === 'string' ? event.topic : null, inputHash: eventHash(event), status, reasonCode,
    ancestryHash: extra.ancestryHash || null, driveHash: hash(extra.drives || {}), stateCursor: state.cursor
  };
  const traceHash = hash(traceBody);
  const trace = { ...traceBody, traceHash };
  state.traceHead = traceHash;
  state.traces = [...state.traces, trace].slice(-MAX_TRACES);
  return trace;
}

function breakerFor(state, key) { return state.breakers[key] || breakers.createBreaker(); }
function setBreaker(state, key, breaker) { state.breakers[key] = breaker; }

function reject(state, event, code, atMs, sourceKey, extra = {}) {
  if (Number.isSafeInteger(event?.sequence) && event.sequence > state.cursor) state.cursor = event.sequence;
  if (sourceKey) setBreaker(state, sourceKey, breakers.recordFailure(breakerFor(state, sourceKey), atMs, code));
  const trace = appendTrace(state, event, 'rejected', code, extra);
  return { state, decision: { status: 'rejected', accepted: false, reasonCode: code, sequence: event?.sequence ?? null, topic: event?.topic ?? null, drives: {}, trace } };
}

function semanticSignal(payload, policy) {
  const rule = policy.signal;
  if (rule.kind === 'enum') return rule.values[payload[rule.field]];
  return payload[rule.field];
}

function recoveredHabituation(entry, atMs, policy) {
  if (!entry) return 0;
  const seconds = Math.max(0, Math.floor((atMs - entry.updatedAt) / 1000));
  return fp.mul(entry.burden, fp.powScaled(policy.limits.habituationRetentionPerSecond, seconds));
}

function deriveDrives(event, policy, burden) {
  const signal = semanticSignal(event.payload, policy);
  const novelty = Math.abs(signal);
  const magnitude = event.payload[policy.signal.magnitudeField];
  const confidence = event.payload[policy.signal.confidenceField];
  const habituation = fp.clamp(fp.SCALE - fp.mul(policy.limits.habituationStrength, burden));
  let dose = fp.mul(confidence, novelty);
  dose = fp.mul(dose, magnitude);
  dose = fp.mul(dose, habituation);
  dose = Math.min(dose, policy.limits.maxDose);
  const weights = signal >= 0 ? policy.positiveWeights : policy.negativeWeights;
  const drives = {};
  for (const [family, weight] of Object.entries(weights).sort()) drives[family] = fp.saturatingCombine([fp.mul(weight, dose)]);
  validateDriveMap(drives);
  return { drives, dose, signal, habituation };
}

function historyViolation(history, atMs, limits) {
  const recent = (history?.recent || []).filter(value => atMs - value < limits.rateWindowMs);
  if (recent.length >= limits.maxEventsPerWindow) return { code: 'SNTSS_RATE_LIMITED', recent };
  if (history?.lastAcceptedAt != null && atMs - history.lastAcceptedAt < limits.cooldownMs) return { code: 'SNTSS_COOLDOWN', recent };
  return { code: null, recent };
}

function processSemanticEvent(inputState, event, context = {}) {
  validateStimulusState(inputState);
  const state = clone(inputState);
  const now = Number.isSafeInteger(context.trustedNowMs) ? context.trustedNowMs : 0;
  if (Number.isSafeInteger(event?.sequence) && event.sequence <= state.cursor) {
    return { state: inputState, decision: { status: 'replay', accepted: false, reasonCode: 'SNTSS_REPLAY_SEQUENCE', sequence: event.sequence, topic: event.topic ?? null, drives: {}, trace: null } };
  }
  const policy = sourceRegistry.policies[event?.topic];
  const sourceKey = policy ? `source:${policy.sourceCore}` : null;
  if (!policy) return reject(state, event, 'SNTSS_TOPIC_UNREGISTERED', now, sourceKey);

  const gate = breakers.inspectBreaker(breakerFor(state, sourceKey), now);
  if (gate.blocked) return reject(state, event, 'SNTSS_BREAKER_OPEN', now, null);

  let verified;
  try { verified = validateAuthoritativeEvent(event, policy, context, state); }
  catch (error) { return reject(state, event, error.code || 'SNTSS_EVENT_REJECTED', now, sourceKey); }

  if (gate.probeRequired) {
    state.cursor = event.sequence;
    setBreaker(state, sourceKey, breakers.closeAfterProbe(breakerFor(state, sourceKey)));
    state.sourceLastSeen[policy.sourceCore] = { atMs: now, sequence: event.sequence };
    const trace = appendTrace(state, event, 'probe', 'SNTSS_BREAKER_RECOVERY_PROBE', verified);
    return { state, decision: { status: 'probe', accepted: false, reasonCode: 'SNTSS_BREAKER_RECOVERY_PROBE', sequence: event.sequence, topic: event.topic, drives: {}, trace } };
  }

  const evidenceKey = event.meta.evidenceHash;
  const claimKey = hash({ sourceCore: policy.sourceCore, topic: event.topic, causalParent: event.meta.causalParent, deduplicationKey: event.meta.deduplicationKey });
  if (state.seenEvidence[evidenceKey]) return reject(state, event, 'SNTSS_DUPLICATE_EVIDENCE', now, sourceKey, verified);
  if (state.seenClaims[claimKey]) return reject(state, event, 'SNTSS_DUPLICATE_CLAIM', now, sourceKey, verified);

  const history = state.topicHistory[event.topic] || { recent: [], lastAcceptedAt: null };
  const violation = historyViolation(history, now, policy.limits);
  if (violation.code) return reject(state, event, violation.code, now, sourceKey, verified);

  if (policy.contradictionField) {
    const contradictionKey = hash({ sourceCore: policy.sourceCore, topic: event.topic, causalParent: event.meta.causalParent });
    const prior = state.contradictions[contradictionKey];
    const value = event.payload[policy.contradictionField];
    if (prior && now - prior.atMs <= policy.limits.contradictionWindowMs && prior.value !== value) {
      return reject(state, event, 'SNTSS_EVIDENCE_CONTRADICTION', now, sourceKey, verified);
    }
    state.contradictions[contradictionKey] = { value, atMs: now, sequence: event.sequence };
  }

  const currentBurden = recoveredHabituation(state.habituation[event.topic], now, policy);
  const derived = deriveDrives(event, policy, currentBurden);
  const nextBurden = fp.clamp(currentBurden + fp.mul(policy.limits.habituationGain, fp.SCALE - currentBurden));
  state.habituation[event.topic] = { burden: nextBurden, updatedAt: now, exposures: (state.habituation[event.topic]?.exposures || 0) + 1 };
  state.topicHistory[event.topic] = { recent: [...violation.recent, now], lastAcceptedAt: now, sequence: event.sequence };
  state.sourceLastSeen[policy.sourceCore] = { atMs: now, sequence: event.sequence };
  state.seenEvidence[evidenceKey] = { sequence: event.sequence };
  state.seenClaims[claimKey] = { sequence: event.sequence };
  state.causalRecords[event.id] = verified.record;
  state.seenEvidence = boundedEntries(state.seenEvidence);
  state.seenClaims = boundedEntries(state.seenClaims);
  state.causalRecords = boundedEntries(state.causalRecords);
  state.cursor = event.sequence;
  setBreaker(state, sourceKey, breakers.recordSuccess(breakerFor(state, sourceKey), now));
  const trace = appendTrace(state, event, 'accepted', 'SNTSS_ACCEPTED', { ...verified, drives: derived.drives });
  return {
    state,
    decision: {
      status: 'accepted', accepted: true, reasonCode: 'SNTSS_ACCEPTED', sequence: event.sequence, topic: event.topic,
      semanticClass: policy.semanticClass, drives: derived.drives, dose: derived.dose, signal: derived.signal,
      habituationFactor: derived.habituation, dreamOrigin: policy.dreamOrigin, trace
    }
  };
}

function assessProducerAvailability(inputState, trustedNowMs) {
  validateStimulusState(inputState);
  if (!Number.isSafeInteger(trustedNowMs) || trustedNowMs < 0) fail('trusted availability time is invalid');
  const producers = {};
  for (const policy of Object.values(sourceRegistry.policies)) {
    if (producers[policy.sourceCore]) continue;
    const seen = inputState.sourceLastSeen[policy.sourceCore];
    const gate = breakers.inspectBreaker(breakerFor(inputState, `source:${policy.sourceCore}`), trustedNowMs);
    producers[policy.sourceCore] = {
      status: gate.blocked ? 'quarantined' : (!seen ? 'missing' : trustedNowMs - seen.atMs > policy.limits.missingAfterMs ? 'late' : 'available'),
      lastVerifiedAt: seen?.atMs ?? null
    };
  }
  return { mode: Object.values(producers).every(item => item.status === 'available') ? 'normal' : 'degraded', producers, drives: {}, stateHash: hash(inputState) };
}

function authorizeLaboratoryFamily(family) { return assertActiveFamily(family, 'laboratory stimulus'); }

module.exports = {
  stage: 'laboratory-r5-semantic-boundary', EMPTY_TRACE, createStimulusState, validateStimulusState,
  processSemanticEvent, assessProducerAvailability, authorizeLaboratoryFamily, validateDriveMap
};
