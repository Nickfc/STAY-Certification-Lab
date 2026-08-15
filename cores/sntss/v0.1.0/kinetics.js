'use strict';

const fp = require('./fixed-point');

const STATE_KEYS = Object.freeze(['P', 'R', 'C', 'B', 'X', 'O', 'F']);

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw Object.assign(new Error('transmitter state is invalid'), { code: 'SNTSS_KINETIC_STATE' });
  const result = {};
  for (const key of STATE_KEYS) result[key] = fp.clamp(fp.integer(state[key], `state.${key}`));
  return result;
}

function validateProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw Object.assign(new Error('kinetic profile is invalid'), { code: 'SNTSS_KINETIC_PROFILE' });
  const normalized = {
    synthCap: fp.clamp(fp.integer(profile.synthCap, 'profile.synthCap')),
    precursorRecovery: fp.clamp(fp.integer(profile.precursorRecovery, 'profile.precursorRecovery')),
    reserveRetention: fp.clamp(fp.integer(profile.reserveRetention, 'profile.reserveRetention')),
    maxReleasePerStep: fp.clamp(fp.integer(profile.maxReleasePerStep, 'profile.maxReleasePerStep')),
    maxSuppressionPerStep: fp.clamp(fp.integer(profile.maxSuppressionPerStep, 'profile.maxSuppressionPerStep')),
    concentrationRetention: fp.clamp(fp.integer(profile.concentrationRetention, 'profile.concentrationRetention')),
    exposureAlpha: fp.clamp(fp.integer(profile.exposureAlpha, 'profile.exposureAlpha')),
    exposureRetention: fp.clamp(fp.integer(profile.exposureRetention, 'profile.exposureRetention')),
    toleranceStrength: fp.clamp(fp.integer(profile.toleranceStrength, 'profile.toleranceStrength')),
    opponentBuildAlpha: fp.clamp(fp.integer(profile.opponentBuildAlpha, 'profile.opponentBuildAlpha')),
    opponentRetention: fp.clamp(fp.integer(profile.opponentRetention, 'profile.opponentRetention')),
    refractoryRecovery: fp.clamp(fp.integer(profile.refractoryRecovery, 'profile.refractoryRecovery')),
    refractoryRetention: fp.clamp(fp.integer(profile.refractoryRetention, 'profile.refractoryRetention')),
    refractoryCost: fp.clamp(fp.integer(profile.refractoryCost, 'profile.refractoryCost')),
    affinity: fp.clamp(fp.integer(profile.affinity, 'profile.affinity'), 1, fp.SCALE),
    hill: fp.integer(profile.hill, 'profile.hill')
  };
  if (normalized.hill < 1 || normalized.hill > 4) throw Object.assign(new Error('profile.hill must be 1..4'), { code: 'SNTSS_KINETIC_PROFILE' });
  return normalized;
}

function step(inputState, inputProfile, driveValue) {
  const state = validateState(inputState);
  const profile = validateProfile(inputProfile);
  const drive = fp.clamp(fp.integer(driveValue, 'drive'), fp.SIGNED_MIN, fp.SIGNED_MAX);
  const precursorRecovery = Math.min(fp.SCALE - state.P, profile.precursorRecovery);
  const precursorAvailable = state.P + precursorRecovery;
  const reserveDemand = fp.SCALE - state.R;
  const synthesis = Math.min(precursorAvailable, fp.mul(profile.synthCap, reserveDemand));
  const toleranceGate = fp.clamp(fp.SCALE - fp.mul(state.X, profile.toleranceStrength));
  const positiveDrive = fp.mul(Math.max(0, drive), toleranceGate);
  const releaseGate = fp.mul(positiveDrive, state.F);
  const release = Math.min(state.R, fp.mul(profile.maxReleasePerStep, releaseGate));
  const suppression = fp.mul(profile.maxSuppressionPerStep, Math.max(0, -drive));
  const retainedDeviation = fp.mul(state.C - state.B, profile.concentrationRetention);
  const C = fp.clamp(state.B + retainedDeviation + release - suppression);
  const R = fp.clamp(state.R + synthesis - release);
  const P = fp.clamp(precursorAvailable - synthesis);
  const occupancy = fp.hill(C, profile.affinity, profile.hill);
  const tonicOccupancy = fp.hill(state.B, profile.affinity, profile.hill);
  const X = fp.clamp(state.X + fp.mul(occupancy - state.X, profile.exposureAlpha));
  const opponentTarget = occupancy;
  const O = opponentTarget >= state.O
    ? fp.clamp(state.O + fp.mul(opponentTarget - state.O, profile.opponentBuildAlpha))
    : fp.clamp(state.O + fp.mul(opponentTarget - state.O, fp.SCALE - profile.opponentRetention));
  const refractoryLoss = fp.mul(release, profile.refractoryCost);
  const refractoryGain = fp.mul(fp.SCALE - state.F, profile.refractoryRecovery);
  const F = fp.clamp(state.F + refractoryGain - refractoryLoss);
  const relativeEffect = fp.clamp(occupancy - tonicOccupancy - O, fp.SIGNED_MIN, fp.SIGNED_MAX);
  return {
    state: { P, R, C, B: state.B, X, O, F },
    transition: { drive, toleranceGate, precursorRecovery, synthesis, release, suppression, occupancy, tonicOccupancy, relativeEffect }
  };
}

function quietAdvance(inputState, inputProfile, steps) {
  const state = validateState(inputState);
  const profile = validateProfile(inputProfile);
  const count = fp.integer(steps, 'quiet steps');
  if (count < 0) throw Object.assign(new Error('quiet steps must be nonnegative'), { code: 'SNTSS_KINETIC_TIME' });
  if (count === 0) return { state, transition: { quietSteps: 0, synthesis: 0, release: 0 } };
  const recoveredP = fp.approach(state.P, fp.SCALE, fp.SCALE - profile.precursorRecovery, count);
  const desiredR = fp.approach(state.R, fp.SCALE, profile.reserveRetention, count);
  const synthesis = Math.min(recoveredP, Math.max(0, desiredR - state.R));
  const next = {
    P: fp.clamp(recoveredP - synthesis),
    R: fp.clamp(state.R + synthesis),
    C: fp.clamp(fp.approach(state.C, state.B, profile.concentrationRetention, count)),
    B: state.B,
    X: fp.clamp(fp.approach(state.X, 0, profile.exposureRetention, count)),
    O: fp.clamp(fp.approach(state.O, 0, profile.opponentRetention, count)),
    F: fp.clamp(fp.approach(state.F, fp.SCALE, profile.refractoryRetention, count))
  };
  return { state: next, transition: { quietSteps: count, synthesis, release: 0 } };
}

module.exports = { STATE_KEYS, validateState, validateProfile, step, quietAdvance };
