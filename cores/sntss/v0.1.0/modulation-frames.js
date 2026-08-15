'use strict';

const fp = require('./fixed-point');
const { stableStringify } = require('../../../runtime/kernel/canonical-json');
const { receptorProfileRegistry, hash } = require('./receptor-profiles');
const { validateReceptorState, evaluateConsumer } = require('./receptors');
const leases = require('./leases');

const HASH = /^sha256:[0-9a-f]{64}$/;
const FRAME_KEYS = Object.freeze(['authorityEpoch', 'consumerCoreId', 'degradation', 'evidenceCursor', 'frameId', 'frameSequence', 'frameVersion', 'lineage', 'orderingId', 'profileHash', 'receptors', 'validFromMs', 'validUntilMs']);
const SIGNAL_KEYS = Object.freeze(['activation', 'available', 'boundedEffect', 'permittedFunction', 'receptorId', 'sensitivity', 'trend']);

function fail(message, code = 'SNTSS_FRAME_INVALID') { throw Object.assign(new Error(message), { code }); }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} fields are not canonical`);
}
function integer(value, label, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`); return value; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function frameBody(consumer, profile, signals, context, sequence, degradation) {
  const orderingId = hash({ lineage: context.lineage, consumerCoreId: profile.consumerCoreId, profileHash: profile.profileHash, frameSequence: sequence, evidenceCursor: context.evidenceCursor });
  return {
    frameVersion: 1, authorityEpoch: context.authorityEpoch, frameSequence: sequence,
    evidenceCursor: context.evidenceCursor, orderingId, consumerCoreId: profile.consumerCoreId,
    profileHash: profile.profileHash, lineage: context.lineage, validFromMs: context.nowMs,
    validUntilMs: context.nowMs + profile.frameValidityMs, receptors: signals, degradation
  };
}

function contextCheck(state, context) {
  if (!context || context.lineage !== state.lineage || !HASH.test(context.lineage)) fail('frame lineage is invalid', 'SNTSS_LINEAGE_MISMATCH');
  integer(context.authorityEpoch, 'frame authority epoch', 1); integer(context.evidenceCursor, 'frame evidence cursor', 1); integer(context.nowMs, 'frame time');
  if (!['available', 'degraded'].includes(context.availability)) fail('frame availability is invalid');
}

function generateFrame(inputState, consumerCoreId, model, context) {
  validateReceptorState(inputState); contextCheck(inputState, context);
  const consumer = inputState.consumers[consumerCoreId]; const profile = receptorProfileRegistry.profiles[consumerCoreId];
  if (!consumer || !profile) fail('frame target is unregistered', 'SNTSS_CONSUMER_UNREGISTERED');
  if (context.evidenceCursor < consumer.lastEvidenceCursor) fail('frame evidence cursor rewound', 'SNTSS_FRAME_CURSOR_REWIND');
  if (context.evidenceCursor === consumer.lastEvidenceCursor && consumer.lastFrame) return { state: inputState, frame: consumer.lastFrame, status: 'replay', reasonCode: 'SNTSS_FRAME_REPLAY' };
  const inspection = leases.inspectLease(inputState, consumerCoreId, context.nowMs);
  if (!inspection.available) return { state: inputState, frame: null, status: 'degraded', reasonCode: inspection.reasonCode };

  const evaluated = evaluateConsumer(inputState, consumerCoreId, model, context.nowMs); let state = evaluated.state;
  const resynchronizing = context.resynchronizing === true;
  const available = context.availability === 'available';
  const signals = evaluated.signals.map(signal => ({
    ...signal,
    activation: available ? signal.activation : 0,
    boundedEffect: available ? (resynchronizing ? fp.clamp(signal.boundedEffect, -50000, 50000) : signal.boundedEffect) : 0,
    available
  }));
  const degradation = {
    health: available ? (resynchronizing ? 'recovering' : 'healthy') : 'degraded',
    reason: available ? (resynchronizing ? 'bounded-resynchronization' : 'none') : (context.degradationReason || 'upstream-unavailable'),
    fallbackExpectation: 'decay-to-neutral-after-hold', circuitBreaker: inspection.lease.breaker
  };
  const sequence = consumer.frameSequence + 1; const body = frameBody(consumer, profile, signals, context, sequence, degradation);
  const frame = { ...body, frameId: hash(body) };
  state.consumers[consumerCoreId].frameSequence = sequence;
  state.consumers[consumerCoreId].lastEvidenceCursor = context.evidenceCursor;
  state.consumers[consumerCoreId].lastFrame = frame;
  const queued = leases.enqueueFrame(state, frame, context.nowMs); state = queued.state;
  return { state, frame, status: queued.accepted ? 'generated' : 'isolated', reasonCode: queued.reasonCode };
}

function generateAllFrames(inputState, model, context) {
  validateReceptorState(inputState); let state = inputState; const outcomes = {};
  for (const consumerCoreId of Object.keys(state.consumers).sort()) {
    const result = generateFrame(state, consumerCoreId, model, context); state = result.state; outcomes[consumerCoreId] = { frame: result.frame, status: result.status, reasonCode: result.reasonCode };
  }
  return { state, outcomes };
}

function validateFrameForConsumer(frame, consumerCoreId, profileHash, nowMs, authorityEpoch) {
  exactKeys(frame, FRAME_KEYS, 'modulation frame');
  const { frameId, ...body } = frame;
  if (!HASH.test(frameId) || frameId !== hash(body) || !HASH.test(frame.orderingId)) fail('frame hash is invalid', 'SNTSS_FRAME_HASH_MISMATCH');
  if (frame.frameVersion !== 1 || frame.consumerCoreId !== consumerCoreId || consumerCoreId.includes('*')) fail('frame target mismatch', 'SNTSS_FRAME_UNTARGETED');
  if (frame.profileHash !== profileHash || !receptorProfileRegistry.profiles[consumerCoreId] || receptorProfileRegistry.profiles[consumerCoreId].profileHash !== profileHash) fail('frame profile mismatch', 'SNTSS_PROFILE_MISMATCH');
  integer(frame.authorityEpoch, 'frame authority epoch', 1); integer(frame.frameSequence, 'frame sequence', 1); integer(frame.evidenceCursor, 'evidence cursor', 1);
  if (frame.authorityEpoch !== authorityEpoch) fail('frame authority is stale', 'SNTSS_FRAME_AUTHORITY_STALE');
  if (!Number.isSafeInteger(nowMs) || nowMs < frame.validFromMs) fail('frame is not yet valid', 'SNTSS_FRAME_NOT_YET_VALID');
  if (nowMs > frame.validUntilMs) fail('frame expired', 'SNTSS_FRAME_EXPIRED');
  if (!Array.isArray(frame.receptors) || frame.receptors.length < 1) fail('frame signal inventory is invalid');
  const profile = receptorProfileRegistry.profiles[consumerCoreId];
  for (let index = 0; index < frame.receptors.length; index += 1) {
    const signal = frame.receptors[index]; exactKeys(signal, SIGNAL_KEYS, 'frame receptor signal');
    if (signal.receptorId !== profile.receptors[index]?.receptorId || signal.permittedFunction !== profile.receptors[index]?.permittedFunction) fail('frame receptor does not match profile', 'SNTSS_PROFILE_MISMATCH');
    for (const key of ['activation', 'boundedEffect']) if (!Number.isSafeInteger(signal[key]) || Math.abs(signal[key]) > fp.SCALE) fail('frame effect is unbounded', 'SNTSS_FRAME_EFFECT_RANGE');
    if (!Number.isSafeInteger(signal.sensitivity) || signal.sensitivity < 0 || signal.sensitivity > fp.SCALE || ![-1, 0, 1].includes(signal.trend) || typeof signal.available !== 'boolean') fail('frame signal is invalid');
  }
  exactKeys(frame.degradation, ['circuitBreaker', 'fallbackExpectation', 'health', 'reason'], 'frame degradation');
  return true;
}

function sameFrame(left, right) { return stableStringify(left) === stableStringify(right); }

module.exports = { FRAME_KEYS, generateFrame, generateAllFrames, validateFrameForConsumer, sameFrame };
