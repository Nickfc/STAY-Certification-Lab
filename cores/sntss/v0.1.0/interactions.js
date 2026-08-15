'use strict';

const fp = require('./fixed-point');
const { ACTIVE_FAMILIES, DORMANT_FAMILIES, speciesProfile } = require('./species-profile');

function fail(message, code) { throw Object.assign(new Error(message), { code }); }

function signed(value, label) {
  const result = fp.integer(value, label);
  if (result < fp.SIGNED_MIN || result > fp.SIGNED_MAX) fail(`${label} is outside the signed fixed-point range`, 'SNTSS_INTERACTION_RANGE');
  return result;
}

function dampExtreme(value, serotonin, policy) {
  const magnitude = Math.abs(value);
  if (magnitude <= policy.serotoninExtremeThreshold || serotonin <= 0) return value;
  const excess = magnitude - policy.serotoninExtremeThreshold;
  const damping = fp.mul(excess, fp.mul(serotonin, policy.serotoninDampingStrength));
  return Math.sign(value) * Math.max(0, magnitude - damping);
}

function evaluateInteractions(input) {
  const policy = speciesProfile.interactionPolicy;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('interaction activation map is invalid', 'SNTSS_INTERACTION_INPUT');
  const known = new Set([...ACTIVE_FAMILIES, ...DORMANT_FAMILIES]);
  for (const family of Object.keys(input)) if (!known.has(family)) fail(`unknown interaction family: ${family}`, 'SNTSS_FAMILY_UNKNOWN');
  for (const family of DORMANT_FAMILIES) {
    if (Object.prototype.hasOwnProperty.call(input, family)) fail(`${family} cannot enter interactions`, 'SNTSS_FAMILY_DORMANT');
  }
  const raw = Object.fromEntries(ACTIVE_FAMILIES.map(family => [
    family,
    signed(Object.prototype.hasOwnProperty.call(input, family) ? input[family] : 0, family)
  ]));
  const serotonin = Math.max(0, raw['serotonin-like']);
  const bounded = Object.fromEntries(ACTIVE_FAMILIES.map(family => [family, dampExtreme(raw[family], serotonin, policy)]));

  const excitation = Math.max(0, bounded['glutamate-like']);
  const inhibition = Math.max(0, bounded['gaba-like']);
  const gabaBrake = Math.min(excitation, fp.mul(inhibition, policy.gabaBrakeStrength));
  const boundedExcitation = excitation - gabaBrake;

  const acetylcholine = Math.max(0, bounded['acetylcholine-like']);
  const noradrenaline = Math.max(0, bounded['noradrenaline-like']);
  let attentionGain;
  let noradrenalineMode;
  if (noradrenaline <= policy.noradrenalineModerateCeiling) {
    const support = fp.mul(noradrenaline, policy.noradrenalineAttentionSupport);
    attentionGain = fp.saturatingCombine([acetylcholine, support]);
    noradrenalineMode = 'support';
  } else {
    const excess = noradrenaline - policy.noradrenalineModerateCeiling;
    attentionGain = Math.max(0, acetylcholine - fp.mul(excess, policy.noradrenalineHighNarrowing));
    noradrenalineMode = 'narrow';
  }
  attentionGain = Math.max(0, dampExtreme(attentionGain, serotonin, policy));

  return {
    activations: bounded,
    readouts: {
      motivationalSalience: bounded['dopamine-like'],
      longHorizonStability: bounded['serotonin-like'],
      vigilance: bounded['noradrenaline-like'],
      attentionGain,
      excitationTone: boundedExcitation,
      inhibitionTone: inhibition,
      excitationInhibitionBalance: fp.clamp(boundedExcitation - inhibition, fp.SIGNED_MIN, fp.SIGNED_MAX)
    },
    limitsApplied: { gabaBrake, noradrenalineMode, serotoninDampingActive: serotonin > 0 }
  };
}

module.exports = { stage: 'laboratory-r4', evaluateInteractions };
