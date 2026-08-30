'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../kernel/canonical-json');
const q48 = require('./q16-48');
const { validateCausalFrame } = require('./causal-frame');

const INPUT_FIELDS = new Set([
  'frameIndex', 'producerSequence', 'eligibleCapacityQ48', 'safetyCeilingQ48',
  'capacityClass', 'qualityStatus', 'qualityQ48', 'coverageQ48', 'ceilingVerified'
]);
const MISSING_INPUT_FIELDS = new Set(['frameIndex', 'capacity']);
const IDENTITY_FIELDS = new Set([
  'organismId', 'founderLineageId', 'residencyId', 'coreVersion', 'authorityEpoch', 'mode'
]);
const PROFILE_FIELDS = new Set([
  'profileId', 'etaFounderQ48', 'reserve', 'basalPhaseKnotsQ48', 'scarcity',
  'allocationClasses', 'numericPolicy', 'frameMs', 'capacityHoldFrames', 'budgetExpiryMaxMs'
]);
const QUALITY = new Set(['VALID', 'STALE', 'CONFLICT', 'INVALID']);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function exact(value, fields, label, code = 'P1_METAB_INPUT_SCHEMA') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`, code);
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`${label} fields are not exact`, code);
  }
}

function clone(value) {
  return JSON.parse(stableStringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`, 'P1_METAB_INPUT_SCHEMA');
  return value;
}

function raw(value, label, minimum = q48.MIN_RAW, maximum = q48.MAX_RAW) {
  const parsed = q48.parseRaw(value);
  if (parsed < minimum || parsed > maximum) fail(`${label} is outside its range`, 'P1_METAB_INPUT_RANGE');
  return parsed;
}

function unit(value, label) {
  return raw(value, label, 0n, q48.SCALE);
}

function minimum(left, right) {
  return left < right ? left : right;
}

function validateProfile(input) {
  exact(input, PROFILE_FIELDS, 'METAB founder profile', 'P1_METAB_PROFILE');
  if (
    input.numericPolicy !== 'Q16.48-half-even-saturating-v1' ||
    input.frameMs !== 250 ||
    input.capacityHoldFrames !== 4 ||
    input.budgetExpiryMaxMs !== 2000
  ) fail('METAB founder fixed policy is invalid', 'P1_METAB_PROFILE');
  unit(input.etaFounderQ48, 'METAB founder efficiency');
  if (!Array.isArray(input.basalPhaseKnotsQ48) || input.basalPhaseKnotsQ48.length !== 8) {
    fail('METAB basal phase knots are invalid', 'P1_METAB_PROFILE');
  }
  for (const value of input.basalPhaseKnotsQ48) raw(value, 'METAB basal phase knot', 0n);
  if (!input.reserve || !input.scarcity || !Array.isArray(input.allocationClasses) || input.allocationClasses.length !== 4) {
    fail('METAB founder structures are invalid', 'P1_METAB_PROFILE');
  }
  const capacity = raw(input.reserve.capacityQ48, 'METAB reserve capacity', 0n);
  const initialFraction = unit(input.reserve.initialFractionQ48, 'METAB initial reserve fraction');
  unit(input.reserve.chargeEfficiencyQ48, 'METAB charge efficiency');
  unit(input.reserve.dischargeEfficiencyQ48, 'METAB discharge efficiency');
  raw(input.reserve.maxDischargeQ48PerSecond, 'METAB maximum discharge', 0n);
  return { profile: deepFreeze(clone(input)), capacity, initialFraction };
}

function validateIdentity(input) {
  exact(input, IDENTITY_FIELDS, 'METAB identity', 'P1_METAB_IDENTITY');
  for (const field of ['organismId', 'founderLineageId', 'residencyId', 'coreVersion']) {
    if (typeof input[field] !== 'string' || !SAFE_ID.test(input[field])) fail(`METAB ${field} is invalid`, 'P1_METAB_IDENTITY');
  }
  if (input.authorityEpoch !== '0') fail('laboratory METAB must own zero authority', 'P1_METAB_AUTHORITY');
  if (!['NEUTRAL', 'SHADOW'].includes(input.mode)) fail('laboratory METAB mode is invalid', 'P1_METAB_AUTHORITY');
  return deepFreeze(clone(input));
}

function validateCapacity(input) {
  exact(input, INPUT_FIELDS, 'METAB capacity input');
  integer(input.frameIndex, 'METAB frame index', 1);
  if (typeof input.producerSequence !== 'string' || !/^[1-9][0-9]*$/.test(input.producerSequence)) {
    fail('METAB producer sequence is invalid', 'P1_METAB_INPUT_SCHEMA');
  }
  raw(input.eligibleCapacityQ48, 'eligible capacity', 0n);
  raw(input.safetyCeilingQ48, 'capacity safety ceiling', 0n);
  if (typeof input.capacityClass !== 'string' || !SAFE_ID.test(input.capacityClass)) {
    fail('capacity class is invalid', 'P1_METAB_INPUT_SCHEMA');
  }
  if (!QUALITY.has(input.qualityStatus) || typeof input.ceilingVerified !== 'boolean') {
    fail('capacity quality is invalid', 'P1_METAB_INPUT_SCHEMA');
  }
  unit(input.qualityQ48, 'capacity quality');
  unit(input.coverageQ48, 'capacity coverage');
  return deepFreeze(clone(input));
}

function initialState(profile, reserveCapacity, initialFraction) {
  const reserve = q48.mul(reserveCapacity, initialFraction);
  return {
    frameIndex: 0,
    smoothedCapacityQ48: '0',
    productionQ48: '0',
    demandQ48: profile.basalPhaseKnotsQ48[0],
    serviceQ48: '0',
    reserveQ48: reserve.toString(),
    availabilityQ48: '0',
    debtQ48: '0',
    lifecycle: 'INITIALIZING',
    cumulativeChargeQ48: '0',
    cumulativeDischargeQ48: '0',
    saturationLossQ48: '0',
    inputCursors: { 'p1r0.capacity.metab': '0' },
    outputSequence: '0'
  };
}

function validateStateShape(input) {
  const fields = new Set([
    'frameIndex', 'smoothedCapacityQ48', 'productionQ48', 'demandQ48',
    'serviceQ48', 'reserveQ48', 'availabilityQ48', 'debtQ48', 'lifecycle',
    'cumulativeChargeQ48', 'cumulativeDischargeQ48', 'saturationLossQ48',
    'inputCursors', 'outputSequence'
  ]);
  exact(input, fields, 'METAB state', 'P1_METAB_STATE');
  integer(input.frameIndex, 'METAB state frame');
  for (const field of [
    'smoothedCapacityQ48', 'productionQ48', 'demandQ48', 'serviceQ48',
    'reserveQ48', 'availabilityQ48', 'debtQ48', 'cumulativeChargeQ48',
    'cumulativeDischargeQ48', 'saturationLossQ48'
  ]) raw(input[field], `METAB state ${field}`, 0n);
  if (!input.inputCursors || typeof input.inputCursors !== 'object' || Array.isArray(input.inputCursors)) {
    fail('METAB state cursors are invalid', 'P1_METAB_STATE');
  }
  if (!/^(0|[1-9][0-9]*)$/.test(input.outputSequence)) fail('METAB output sequence is invalid', 'P1_METAB_STATE');
  return clone(input);
}

function buildFrame({ identity, state, routeId, consumerCoreId, topic, schemaId, payload, sequence, qualityStatus, confidenceQ48, coverageQ48 }) {
  const sourceFrame = Math.max(0, state.frameIndex - 1);
  const payloadHash = sha256(payload);
  const withoutId = {
    frameVersion: 'stay-p1-r0-causal-frame-v1',
    organismId: identity.organismId,
    founderLineageId: identity.founderLineageId,
    producer: {
      coreId: 'METAB',
      residencyId: identity.residencyId,
      coreVersion: identity.coreVersion,
      authorityEpoch: identity.authorityEpoch,
      mode: identity.mode,
      lifecycle: state.lifecycle
    },
    route: { routeId, consumerCoreId, routeVersion: '1' },
    topic: {
      name: topic,
      class: 'SUMMARY',
      schemaId,
      schemaVersion: '1',
      unit: 'ratio',
      scale: 'Q16.48'
    },
    producerSequence: sequence.toString(),
    committedFrame: state.frameIndex,
    visibleFromFrame: state.frameIndex + 1,
    sourceWindow: { startFrame: sourceFrame, endFrame: sourceFrame },
    causalSpan: {
      earliestFrame: sourceFrame,
      latestFrame: sourceFrame,
      containsNeutral: false,
      containsShadow: false,
      ancestors: []
    },
    quality: {
      status: qualityStatus,
      confidenceQ48,
      coverageQ48,
      reasons: qualityStatus === 'ACCEPT' ? [] : [qualityStatus === 'HOLD' ? 'CAPACITY_HOLD' : 'CAPACITY_UNKNOWN']
    },
    expiresAtFrame: null,
    payload,
    payloadHash
  };
  return validateCausalFrame({ frameId: sha256(withoutId), ...withoutId });
}

function createMetabEngine(options = {}) {
  exact(options, new Set(['profile', 'identity']), 'METAB engine options', 'P1_METAB_OPTIONS');
  const validatedProfile = validateProfile(options.profile);
  const profile = validatedProfile.profile;
  const identity = validateIdentity(options.identity);
  const reserveCapacity = validatedProfile.capacity;
  const frameFraction = q48.fromDecimal('0.25');
  let state = initialState(profile, reserveCapacity, validatedProfile.initialFraction);
  let lastCapacity = null;
  let lastCapacityFrame = null;
  const seen = new Map();

  function snapshot() {
    return deepFreeze(clone(state));
  }

  function restore(input) {
    const next = validateStateShape(input);
    if (
      next.frameIndex < state.frameIndex ||
      q48.parseRaw(next.reserveQ48) < 0n ||
      q48.parseRaw(next.debtQ48) < q48.parseRaw(state.debtQ48) && next.frameIndex === state.frameIndex ||
      q48.parseRaw(next.cumulativeChargeQ48) < q48.parseRaw(state.cumulativeChargeQ48) ||
      q48.parseRaw(next.cumulativeDischargeQ48) < q48.parseRaw(state.cumulativeDischargeQ48) ||
      BigInt(next.outputSequence) < BigInt(state.outputSequence)
    ) fail('METAB restore would rewind acquired biology', 'P1_METAB_REWIND');
    state = next;
    return snapshot();
  }

  function advance(input) {
    let sample = null;
    let frameIndex;
    if (input && Object.keys(input).length === 2 && Object.hasOwn(input, 'capacity')) {
      exact(input, MISSING_INPUT_FIELDS, 'METAB missing-capacity input');
      frameIndex = integer(input.frameIndex, 'METAB frame index', 1);
      if (input.capacity !== null) fail('nested METAB capacity is forbidden', 'P1_METAB_INPUT_SCHEMA');
    } else {
      sample = validateCapacity(input);
      frameIndex = sample.frameIndex;
      const replayKey = sample.producerSequence;
      const inputHash = sha256(sample);
      if (seen.has(replayKey)) {
        if (seen.get(replayKey) !== inputHash) fail('METAB sequence was replayed with conflicting content', 'P1_METAB_REPLAY_CONFLICT');
        return deepFreeze({ state: snapshot(), outputs: [], duplicate: true });
      }
    }
    if (frameIndex !== state.frameIndex + 1) fail('METAB frame progression is not contiguous', 'P1_METAB_FRAME_SEQUENCE');

    const previousReserve = q48.parseRaw(state.reserveQ48);
    let capacity = 0n;
    let qualityStatus = 'UNKNOWN';
    let confidence = 0n;
    let coverage = 0n;
    let fresh = false;
    if (sample) {
      seen.set(sample.producerSequence, sha256(sample));
      lastCapacity = sample;
      lastCapacityFrame = frameIndex;
      fresh = sample.qualityStatus === 'VALID' && sample.ceilingVerified;
      if (fresh) {
        capacity = minimum(raw(sample.eligibleCapacityQ48, 'eligible capacity', 0n), raw(sample.safetyCeilingQ48, 'capacity ceiling', 0n));
        qualityStatus = 'ACCEPT';
      }
      confidence = unit(sample.qualityQ48, 'capacity quality');
      coverage = unit(sample.coverageQ48, 'capacity coverage');
    } else if (lastCapacity && frameIndex - lastCapacityFrame <= profile.capacityHoldFrames) {
      capacity = minimum(raw(lastCapacity.eligibleCapacityQ48, 'held eligible capacity', 0n), raw(lastCapacity.safetyCeilingQ48, 'held capacity ceiling', 0n));
      qualityStatus = 'HOLD';
      confidence = unit(lastCapacity.qualityQ48, 'held capacity quality');
      coverage = unit(lastCapacity.coverageQ48, 'held capacity coverage');
    }

    const production = q48.mul(capacity, raw(profile.etaFounderQ48, 'METAB efficiency', 0n, q48.SCALE));
    const demand = raw(profile.basalPhaseKnotsQ48[frameIndex % profile.basalPhaseKnotsQ48.length], 'METAB demand', 0n);
    const directService = minimum(production, demand);
    let service = directService;
    let reserve = previousReserve;
    let cumulativeCharge = q48.parseRaw(state.cumulativeChargeQ48);
    let cumulativeDischarge = q48.parseRaw(state.cumulativeDischargeQ48);
    let saturationLoss = q48.parseRaw(state.saturationLossQ48);

    const deficit = demand - directService;
    if (deficit > 0n && reserve > 0n) {
      const efficiency = unit(profile.reserve.dischargeEfficiencyQ48, 'METAB discharge efficiency');
      const maximumWithdrawal = q48.mul(raw(profile.reserve.maxDischargeQ48PerSecond, 'METAB maximum discharge', 0n), frameFraction);
      const withdrawalForDeficit = efficiency === 0n ? 0n : q48.div(deficit, efficiency);
      const withdrawal = minimum(reserve, minimum(maximumWithdrawal, withdrawalForDeficit));
      const delivered = q48.mul(withdrawal, efficiency);
      reserve -= withdrawal;
      cumulativeDischarge = q48.add(cumulativeDischarge, withdrawal);
      service = q48.add(service, delivered);
    }

    const surplus = production - directService;
    if (fresh && surplus > 0n && reserve < reserveCapacity) {
      const charge = minimum(reserveCapacity - reserve, q48.mul(surplus, unit(profile.reserve.chargeEfficiencyQ48, 'METAB charge efficiency')));
      reserve = q48.add(reserve, charge);
      cumulativeCharge = q48.add(cumulativeCharge, charge);
      saturationLoss = q48.add(saturationLoss, surplus - charge);
    } else if (surplus > 0n) {
      saturationLoss = q48.add(saturationLoss, surplus);
    }

    const unmet = demand > service ? demand - service : 0n;
    let debt = q48.parseRaw(state.debtQ48);
    if (unmet > 0n) {
      debt = q48.saturatingAdd(debt, q48.mul(unmet, raw(profile.scarcity.debtGainQ48, 'METAB debt gain', 0n)));
    } else {
      const recovery = q48.mul(raw(profile.scarcity.debtRecoveryQ48, 'METAB debt recovery', 0n), frameFraction);
      debt = debt > recovery ? debt - recovery : 0n;
    }
    const availability = demand === 0n ? q48.SCALE : q48.clamp(q48.div(service, demand), 0n, q48.SCALE);
    const reserveFraction = reserveCapacity === 0n ? 0n : q48.clamp(q48.div(reserve, reserveCapacity), 0n, q48.SCALE);
    let lifecycle = 'BALANCED';
    if (qualityStatus === 'UNKNOWN') lifecycle = 'UNRESOLVED';
    else if (qualityStatus === 'HOLD') lifecycle = 'PROTECTED';
    else if (reserveFraction <= raw(profile.scarcity.reserveDepletedThresholdQ48, 'METAB depleted threshold', 0n)) lifecycle = 'DEPLETED';
    else if (reserveFraction <= raw(profile.scarcity.reserveConservingThresholdQ48, 'METAB conserving threshold', 0n)) lifecycle = 'CONSERVING';

    state = {
      frameIndex,
      smoothedCapacityQ48: capacity.toString(),
      productionQ48: production.toString(),
      demandQ48: demand.toString(),
      serviceQ48: service.toString(),
      reserveQ48: reserve.toString(),
      availabilityQ48: availability.toString(),
      debtQ48: debt.toString(),
      lifecycle,
      cumulativeChargeQ48: cumulativeCharge.toString(),
      cumulativeDischargeQ48: cumulativeDischarge.toString(),
      saturationLossQ48: saturationLoss.toString(),
      inputCursors: { 'p1r0.capacity.metab': sample ? sample.producerSequence : state.inputCursors['p1r0.capacity.metab'] },
      outputSequence: state.outputSequence
    };

    const outputs = [];
    if (identity.mode === 'SHADOW') {
      const firstSequence = BigInt(state.outputSequence) + 1n;
      const frameQuality = qualityStatus;
      const availabilityPayload = {
        availabilityQ48: state.availabilityQ48,
        debtQ48: state.debtQ48,
        scarcityState: lifecycle,
        confidenceQ48: confidence.toString(),
        coverageQ48: coverage.toString()
      };
      const reservePayload = {
        reserveQ48: state.reserveQ48,
        reserveFractionQ48: reserveFraction.toString(),
        trendQ48PerSecond: q48.div(reserve - previousReserve, frameFraction).toString(),
        cumulativeChargeQ48: state.cumulativeChargeQ48,
        cumulativeDischargeQ48: state.cumulativeDischargeQ48,
        confidenceQ48: confidence.toString()
      };
      outputs.push(buildFrame({
        identity,
        state,
        routeId: 'p1r0.metab-availability.homeos',
        consumerCoreId: 'HOMEOS',
        topic: 'metab.energy.availability.v1',
        schemaId: 'urn:stay:p1-r0:schema:metab-energy-availability-payload:v1',
        payload: availabilityPayload,
        sequence: firstSequence,
        qualityStatus: frameQuality,
        confidenceQ48: confidence.toString(),
        coverageQ48: coverage.toString()
      }));
      outputs.push(buildFrame({
        identity,
        state,
        routeId: 'p1r0.metab-reserve.homeos',
        consumerCoreId: 'HOMEOS',
        topic: 'metab.energy.reserve.v1',
        schemaId: 'urn:stay:p1-r0:schema:metab-energy-reserve-payload:v1',
        payload: reservePayload,
        sequence: firstSequence + 1n,
        qualityStatus: frameQuality,
        confidenceQ48: confidence.toString(),
        coverageQ48: coverage.toString()
      }));
      outputs.push(buildFrame({
        identity,
        state,
        routeId: 'p1r0.metab-availability.intero',
        consumerCoreId: 'INTERO',
        topic: 'metab.energy.availability.v1',
        schemaId: 'urn:stay:p1-r0:schema:metab-energy-availability-payload:v1',
        payload: availabilityPayload,
        sequence: firstSequence + 2n,
        qualityStatus: frameQuality,
        confidenceQ48: confidence.toString(),
        coverageQ48: coverage.toString()
      }));
      outputs.push(buildFrame({
        identity,
        state,
        routeId: 'p1r0.metab-reserve.intero',
        consumerCoreId: 'INTERO',
        topic: 'metab.energy.reserve.v1',
        schemaId: 'urn:stay:p1-r0:schema:metab-energy-reserve-payload:v1',
        payload: reservePayload,
        sequence: firstSequence + 3n,
        qualityStatus: frameQuality,
        confidenceQ48: confidence.toString(),
        coverageQ48: coverage.toString()
      }));
      state.outputSequence = (firstSequence + 3n).toString();
    }
    return deepFreeze({ state: snapshot(), outputs: deepFreeze(outputs), duplicate: false });
  }

  return Object.freeze({ advance, snapshot, restore });
}

module.exports = Object.freeze({ createMetabEngine });
