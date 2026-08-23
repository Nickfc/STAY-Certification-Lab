'use strict';

const { receptorProfileRegistry, hash } = require('./receptor-profiles');
const { validateReceptorState } = require('./receptors');

const MAX_LEASE_MS = 60000;
const PRESSURE_LIMIT = 3;

function fail(message, code = 'SNTSS_LEASE_INVALID') { throw Object.assign(new Error(message), { code }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function trusted(context, consumerCoreId, profileHash) {
  const record = context?.consumerAuthority?.[consumerCoreId];
  if (context?.trustedRuntime !== true || !record || record.active !== true || record.profileHash !== profileHash) fail('lease grant lacks trusted runtime authority', 'SNTSS_LEASE_AUTHORITY');
  if (!Number.isSafeInteger(context.authorityEpoch) || context.authorityEpoch < 1) fail('lease authority epoch is invalid', 'SNTSS_LEASE_AUTHORITY');
}

function grantLease(inputState, consumerCoreId, profileHash, nowMs, durationMs, context) {
  validateReceptorState(inputState); trusted(context, consumerCoreId, profileHash);
  const consumer = inputState.consumers[consumerCoreId]; const profile = receptorProfileRegistry.profiles[consumerCoreId];
  if (!consumer || !profile || consumer.profileHash !== profileHash) fail('lease target profile is not registered', 'SNTSS_PROFILE_MISMATCH');
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(durationMs) || durationMs < profile.frameValidityMs || durationMs > MAX_LEASE_MS) fail('lease window is invalid');
  const state = clone(inputState);
  state.leases[consumerCoreId] = {
    leaseVersion: 1,
    leaseId: hash({ lineage: state.lineage, consumerCoreId, profileHash, authorityEpoch: context.authorityEpoch, grantedAt: nowMs }),
    consumerCoreId, profileHash, authorityEpoch: context.authorityEpoch, grantedAt: nowMs, expiresAt: nowMs + durationMs,
    status: 'active', queue: [], pressureCount: 0, breaker: 'closed', droppedFrames: 0, disconnectedAt: null
  };
  return state;
}

function disconnectLease(inputState, consumerCoreId, nowMs) {
  validateReceptorState(inputState); const current = inputState.leases[consumerCoreId];
  if (!current) return inputState;
  const state = clone(inputState); state.leases[consumerCoreId] = { ...current, status: 'disconnected', queue: [], disconnectedAt: nowMs };
  return state;
}

function inspectLease(inputState, consumerCoreId, nowMs) {
  validateReceptorState(inputState); const lease = inputState.leases[consumerCoreId];
  if (!lease) return { available: false, reasonCode: 'SNTSS_LEASE_MISSING', lease: null };
  if (lease.status !== 'active') return { available: false, reasonCode: 'SNTSS_CONSUMER_DISCONNECTED', lease };
  if (nowMs > lease.expiresAt) return { available: false, reasonCode: 'SNTSS_LEASE_EXPIRED', lease };
  if (lease.breaker === 'open') return { available: false, reasonCode: 'SNTSS_CONSUMER_BREAKER_OPEN', lease };
  return { available: true, reasonCode: 'SNTSS_LEASE_ACTIVE', lease };
}

function enqueueFrame(inputState, frame, nowMs) {
  validateReceptorState(inputState); const profile = receptorProfileRegistry.profiles[frame.consumerCoreId];
  const inspection = inspectLease(inputState, frame.consumerCoreId, nowMs);
  if (!inspection.available) return { state: inputState, accepted: false, reasonCode: inspection.reasonCode };
  const state = clone(inputState); const lease = state.leases[frame.consumerCoreId];
  lease.queue = lease.queue.filter(current => current.validUntilMs >= nowMs);
  if (lease.queue.some(current => current.frameId === frame.frameId)) return { state: inputState, accepted: false, reasonCode: 'SNTSS_FRAME_REPLAY' };
  if (lease.queue.length >= profile.queueCapacity) {
    lease.queue.shift(); lease.droppedFrames += 1; lease.pressureCount += 1;
    if (lease.pressureCount >= PRESSURE_LIMIT) lease.breaker = 'open';
  }
  lease.queue.push(frame);
  return { state, accepted: true, reasonCode: lease.breaker === 'open' ? 'SNTSS_CONSUMER_BREAKER_OPENED' : lease.pressureCount ? 'SNTSS_CONSUMER_BACKPRESSURE' : 'SNTSS_FRAME_QUEUED' };
}

function readLeaseFrames(inputState, consumerCoreId, nowMs) {
  validateReceptorState(inputState); const state = clone(inputState); const lease = state.leases[consumerCoreId];
  if (!lease) return { state: inputState, frames: [], reasonCode: 'SNTSS_LEASE_MISSING' };
  const frames = lease.queue.filter(current => current.validUntilMs >= nowMs);
  lease.queue = [];
  return { state, frames, reasonCode: frames.length ? 'SNTSS_FRAMES_READ' : 'SNTSS_NO_LIVE_FRAMES' };
}

module.exports = { MAX_LEASE_MS, PRESSURE_LIMIT, grantLease, disconnectLease, inspectLease, enqueueFrame, readLeaseFrames };
