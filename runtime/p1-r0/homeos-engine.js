'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../kernel/canonical-json');
const q48 = require('./q16-48');
const { validateCausalFrame } = require('./causal-frame');
const { collectHomeosInputs, validateHomeosFounderProfile } = require('./homeos-contract');

const OPTION_FIELDS = new Set(['profile', 'identity']);
const IDENTITY_FIELDS = new Set([
  'organismId', 'founderLineageId', 'residencyId', 'coreVersion', 'authorityEpoch', 'mode'
]);
const ADVANCE_FIELDS = new Set(['frameIndex', 'inputs']);
const STATE_FIELDS = new Set([
  'frameIndex', 'dimensions', 'stabilityLoadQ48', 'lifecycle', 'inputCursors', 'outputSequence'
]);
const DIMENSION_STATE_FIELDS = new Set([
  'dimensionId', 'filteredQ48', 'deviationQ48', 'burdenLowQ48', 'burdenHighQ48',
  'pressureQ48', 'adaptedCenterQ48', 'lifetimeDriftQ48', 'quality', 'sourceSequence'
]);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const QUALITY = new Set(['ACCEPT', 'HOLD', 'UNKNOWN', 'QUARANTINE']);

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function exact(value, fields, label, code = 'P1_HOMEOS_ENGINE_SCHEMA') {
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
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`, 'P1_HOMEOS_ENGINE_SCHEMA');
  return value;
}

function raw(value, label, minimum = q48.MIN_RAW, maximum = q48.MAX_RAW) {
  const parsed = q48.parseRaw(value);
  if (parsed < minimum || parsed > maximum) fail(`${label} is outside its range`, 'P1_HOMEOS_ENGINE_RANGE');
  return parsed;
}

function unit(value, label) {
  return raw(value, label, 0n, q48.SCALE);
}

function minimum(left, right) {
  return left < right ? left : right;
}

function maximum(left, right) {
  return left > right ? left : right;
}

function validateIdentity(input) {
  exact(input, IDENTITY_FIELDS, 'HOMEOS identity', 'P1_HOMEOS_IDENTITY');
  for (const field of ['organismId', 'founderLineageId', 'residencyId', 'coreVersion']) {
    if (typeof input[field] !== 'string' || !SAFE_ID.test(input[field])) fail(`HOMEOS ${field} is invalid`, 'P1_HOMEOS_IDENTITY');
  }
  if (input.authorityEpoch !== '0') fail('laboratory HOMEOS must own zero authority', 'P1_HOMEOS_AUTHORITY');
  if (!['NEUTRAL', 'SHADOW'].includes(input.mode)) fail('laboratory HOMEOS mode is invalid', 'P1_HOMEOS_AUTHORITY');
  return deepFreeze(clone(input));
}

function descriptorCenter(descriptor) {
  const low = raw(descriptor.targetLowQ48, 'HOMEOS target low');
  const high = raw(descriptor.targetHighQ48, 'HOMEOS target high');
  if (high < low) fail('HOMEOS target band is inverted', 'P1_HOMEOS_PROFILE');
  return q48.roundHalfEven(low + high, 2n);
}

function initialState(profile) {
  return {
    frameIndex: 0,
    dimensions: profile.dimensions.map(descriptor => {
      const center = descriptorCenter(descriptor).toString();
      return {
        dimensionId: descriptor.dimensionId,
        filteredQ48: center,
        deviationQ48: '0',
        burdenLowQ48: '0',
        burdenHighQ48: '0',
        pressureQ48: '0',
        adaptedCenterQ48: center,
        lifetimeDriftQ48: '0',
        quality: 'UNKNOWN',
        sourceSequence: '0'
      };
    }),
    stabilityLoadQ48: '0',
    lifecycle: 'INITIALIZING',
    inputCursors: {
      'p1r0.metab-availability.homeos': '0',
      'p1r0.metab-reserve.homeos': '0'
    },
    outputSequence: '0'
  };
}

function validateState(input, profile) {
  exact(input, STATE_FIELDS, 'HOMEOS state', 'P1_HOMEOS_STATE');
  integer(input.frameIndex, 'HOMEOS state frame');
  unit(input.stabilityLoadQ48, 'HOMEOS stability load');
  if (!['INITIALIZING', 'STABLE', 'STRAINED', 'UNRESOLVED', 'PROTECTED', 'RECOVERING'].includes(input.lifecycle)) {
    fail('HOMEOS state lifecycle is invalid', 'P1_HOMEOS_STATE');
  }
  if (!Array.isArray(input.dimensions) || input.dimensions.length !== profile.dimensions.length) {
    fail('HOMEOS state dimensions are invalid', 'P1_HOMEOS_STATE');
  }
  for (let index = 0; index < input.dimensions.length; index += 1) {
    const dimension = input.dimensions[index];
    exact(dimension, DIMENSION_STATE_FIELDS, 'HOMEOS dimension state', 'P1_HOMEOS_STATE');
    if (dimension.dimensionId !== profile.dimensions[index].dimensionId || !QUALITY.has(dimension.quality)) {
      fail('HOMEOS dimension identity or quality is invalid', 'P1_HOMEOS_STATE');
    }
    raw(dimension.filteredQ48, 'HOMEOS filtered state');
    raw(dimension.deviationQ48, 'HOMEOS deviation');
    unit(dimension.burdenLowQ48, 'HOMEOS low burden');
    unit(dimension.burdenHighQ48, 'HOMEOS high burden');
    unit(dimension.pressureQ48, 'HOMEOS pressure');
    raw(dimension.adaptedCenterQ48, 'HOMEOS adapted center');
    raw(dimension.lifetimeDriftQ48, 'HOMEOS lifetime drift');
    if (!/^(0|[1-9][0-9]*)$/.test(dimension.sourceSequence)) fail('HOMEOS source sequence is invalid', 'P1_HOMEOS_STATE');
  }
  if (!input.inputCursors || typeof input.inputCursors !== 'object' || Array.isArray(input.inputCursors)) {
    fail('HOMEOS state cursors are invalid', 'P1_HOMEOS_STATE');
  }
  if (!/^(0|[1-9][0-9]*)$/.test(input.outputSequence)) fail('HOMEOS output sequence is invalid', 'P1_HOMEOS_STATE');
  return clone(input);
}

function sourceValue(dimensionId, collected) {
  if (dimensionId === 'energy.availability') return collected.availability.availabilityQ48;
  if (dimensionId === 'energy.reserve') return collected.reserve.reserveFractionQ48;
  fail('HOMEOS dimension lacks a reviewed METAB source', 'P1_HOMEOS_PROFILE_SOURCE');
}

function updateBurden(previous, active, loadRate, reliefRate, magnitude, frameFraction) {
  if (active) {
    const increment = q48.mul(q48.mul(loadRate, magnitude), frameFraction);
    return q48.clamp(q48.saturatingAdd(previous, increment), 0n, q48.SCALE);
  }
  const relief = q48.mul(reliefRate, frameFraction);
  return previous > relief ? previous - relief : 0n;
}

function updateDimension(previous, descriptor, value, sourceFrame, frameFraction) {
  const sample = unit(value, `HOMEOS ${descriptor.dimensionId} sample`);
  const alpha = unit(descriptor.alphaQ48, `HOMEOS ${descriptor.dimensionId} alpha`);
  const oldFiltered = raw(previous.filteredQ48, 'HOMEOS previous filtered state');
  const filtered = q48.add(oldFiltered, q48.mul(alpha, sample - oldFiltered));
  const targetLow = raw(descriptor.targetLowQ48, 'HOMEOS target low');
  const targetHigh = raw(descriptor.targetHighQ48, 'HOMEOS target high');
  const lowMagnitude = filtered < targetLow ? targetLow - filtered : 0n;
  const highMagnitude = filtered > targetHigh ? filtered - targetHigh : 0n;
  const deviation = lowMagnitude > 0n ? -lowMagnitude : highMagnitude;
  const loadRate = unit(descriptor.loadRateQ48, 'HOMEOS load rate');
  const reliefRate = unit(descriptor.reliefRateQ48, 'HOMEOS relief rate');
  const burdenLow = updateBurden(unit(previous.burdenLowQ48, 'HOMEOS prior low burden'), lowMagnitude > 0n, loadRate, reliefRate, lowMagnitude, frameFraction);
  const burdenHigh = updateBurden(unit(previous.burdenHighQ48, 'HOMEOS prior high burden'), highMagnitude > 0n, loadRate, reliefRate, highMagnitude, frameFraction);
  const proportional = q48.mul(unit(descriptor.pressureKpQ48, 'HOMEOS pressure kp'), maximum(lowMagnitude, highMagnitude));
  const burden = q48.clamp(burdenLow + burdenHigh, 0n, q48.SCALE);
  const accumulated = q48.mul(unit(descriptor.pressureKbQ48, 'HOMEOS pressure kb'), burden);
  const pressure = q48.clamp(proportional + accumulated, 0n, q48.SCALE);
  return {
    state: {
      dimensionId: descriptor.dimensionId,
      filteredQ48: filtered.toString(),
      deviationQ48: deviation.toString(),
      burdenLowQ48: burdenLow.toString(),
      burdenHighQ48: burdenHigh.toString(),
      pressureQ48: pressure.toString(),
      adaptedCenterQ48: previous.adaptedCenterQ48,
      lifetimeDriftQ48: previous.lifetimeDriftQ48,
      quality: 'ACCEPT',
      sourceSequence: sourceFrame.producerSequence
    },
    summary: {
      dimensionId: descriptor.dimensionId,
      filteredQ48: filtered.toString(),
      deviationQ48: deviation.toString(),
      burdenLowQ48: burdenLow.toString(),
      burdenHighQ48: burdenHigh.toString(),
      pressureQ48: pressure.toString(),
      recoveryEligible: lowMagnitude === 0n && highMagnitude === 0n && burden > 0n,
      confidenceQ48: sourceFrame.quality.confidenceQ48,
      coverageQ48: sourceFrame.quality.coverageQ48
    },
    pressure,
    weight: unit(descriptor.weightQ48, 'HOMEOS dimension weight')
  };
}

function ancestors(inputs) {
  return inputs.map(frame => ({
    producerCoreId: 'METAB',
    residencyId: frame.producer.residencyId,
    topic: frame.topic.name,
    routeId: frame.route.routeId,
    producerSequence: frame.producerSequence,
    sourceWindow: clone(frame.sourceWindow),
    mode: frame.producer.mode,
    shadowAncestry: true,
    confidenceQ48: frame.quality.confidenceQ48
  }));
}

function buildFrame({ identity, state, routeId, topic, schemaId, payload, sequence, inputs, confidenceQ48, coverageQ48 }) {
  const sourceFrame = inputs[0].committedFrame;
  const causalAncestors = ancestors(inputs);
  const earliest = Math.min(sourceFrame, ...causalAncestors.map(value => value.sourceWindow.startFrame));
  const withoutId = {
    frameVersion: 'stay-p1-r0-causal-frame-v1',
    organismId: identity.organismId,
    founderLineageId: identity.founderLineageId,
    producer: {
      coreId: 'HOMEOS',
      residencyId: identity.residencyId,
      coreVersion: identity.coreVersion,
      authorityEpoch: identity.authorityEpoch,
      mode: identity.mode,
      lifecycle: state.lifecycle
    },
    route: { routeId, consumerCoreId: 'INTERO', routeVersion: '1' },
    topic: { name: topic, class: 'SUMMARY', schemaId, schemaVersion: '1', unit: 'ratio', scale: 'Q16.48' },
    producerSequence: sequence.toString(),
    committedFrame: state.frameIndex,
    visibleFromFrame: state.frameIndex + 1,
    sourceWindow: { startFrame: sourceFrame, endFrame: sourceFrame },
    causalSpan: {
      earliestFrame: earliest,
      latestFrame: sourceFrame,
      containsNeutral: false,
      containsShadow: true,
      ancestors: causalAncestors
    },
    quality: { status: 'ACCEPT', confidenceQ48, coverageQ48, reasons: [] },
    expiresAtFrame: null,
    payload,
    payloadHash: sha256(payload)
  };
  return validateCausalFrame({ frameId: sha256(withoutId), ...withoutId });
}

function createHomeosEngine(options = {}) {
  exact(options, OPTION_FIELDS, 'HOMEOS engine options', 'P1_HOMEOS_OPTIONS');
  const profile = validateHomeosFounderProfile(options.profile);
  const identity = validateIdentity(options.identity);
  const frameFraction = q48.fromDecimal('0.25');
  let state = initialState(profile);
  const seen = new Map();

  function snapshot() {
    return deepFreeze(clone(state));
  }

  function restore(input) {
    const next = validateState(input, profile);
    if (
      next.frameIndex < state.frameIndex ||
      BigInt(next.outputSequence) < BigInt(state.outputSequence) ||
      next.dimensions.some((dimension, index) =>
        unit(dimension.burdenLowQ48, 'HOMEOS restored low burden') < unit(state.dimensions[index].burdenLowQ48, 'HOMEOS current low burden') ||
        unit(dimension.burdenHighQ48, 'HOMEOS restored high burden') < unit(state.dimensions[index].burdenHighQ48, 'HOMEOS current high burden') ||
        dimension.adaptedCenterQ48 !== state.dimensions[index].adaptedCenterQ48 ||
        dimension.lifetimeDriftQ48 !== state.dimensions[index].lifetimeDriftQ48
      )
    ) fail('HOMEOS restore would rewind acquired burden or adaptation', 'P1_HOMEOS_REWIND');
    state = next;
    return snapshot();
  }

  function advance(input) {
    exact(input, ADVANCE_FIELDS, 'HOMEOS advance input');
    const frameIndex = integer(input.frameIndex, 'HOMEOS frame index', 1);
    if (input.inputs !== null && !Array.isArray(input.inputs)) fail('HOMEOS inputs are invalid', 'P1_HOMEOS_ENGINE_SCHEMA');
    const inputHash = input.inputs === null ? null : sha256(input.inputs);
    if (inputHash && seen.has(inputHash)) return deepFreeze({ state: snapshot(), outputs: [], duplicate: true });
    if (
      (state.frameIndex === 0 && frameIndex < 1) ||
      (state.frameIndex !== 0 && frameIndex !== state.frameIndex + 1)
    ) fail('HOMEOS frame progression is not contiguous', 'P1_HOMEOS_FRAME_SEQUENCE');

    if (input.inputs === null) {
      state = {
        ...state,
        frameIndex,
        dimensions: state.dimensions.map(dimension => ({ ...dimension, quality: 'UNKNOWN' })),
        lifecycle: 'UNRESOLVED'
      };
      return deepFreeze({ state: snapshot(), outputs: [], duplicate: false });
    }

    const collected = collectHomeosInputs(input.inputs, frameIndex);
    if (input.inputs.some(frame => frame.organismId !== identity.organismId)) {
      fail('HOMEOS cannot consume evidence from another organism', 'P1_HOMEOS_INPUT_IDENTITY');
    }
    const minimumConfidence = unit(profile.minimumConfidenceQ48, 'HOMEOS minimum confidence');
    if (input.inputs.some(frame => unit(frame.quality.confidenceQ48, 'HOMEOS source confidence') < minimumConfidence)) {
      fail('HOMEOS source confidence is below its founder minimum', 'P1_HOMEOS_INPUT_CONFIDENCE');
    }
    seen.set(inputHash, true);
    const byTopic = new Map(input.inputs.map(frame => [frame.topic.name, frame]));
    const updates = profile.dimensions.map((descriptor, index) => {
      const sourceFrame = byTopic.get(descriptor.source.topic);
      if (!sourceFrame) fail('HOMEOS source disappeared after contract validation', 'P1_HOMEOS_INPUT_COVERAGE');
      return updateDimension(state.dimensions[index], descriptor, sourceValue(descriptor.dimensionId, collected), sourceFrame, frameFraction);
    });
    const totalWeight = updates.reduce((sum, update) => sum + update.weight, 0n);
    const weightedPressure = updates.reduce((sum, update) => sum + q48.mul(update.pressure, update.weight), 0n);
    const stabilityLoad = totalWeight === 0n ? 0n : q48.clamp(q48.div(weightedPressure, totalWeight), 0n, q48.SCALE);
    const activePressureCount = updates.filter(update => update.pressure > 0n).length;
    const previousLifecycle = state.lifecycle;
    let lifecycle = activePressureCount > 0 ? 'STRAINED' : previousLifecycle === 'STRAINED' ? 'RECOVERING' : 'STABLE';
    const confidence = input.inputs.reduce((value, frame) => minimum(value, unit(frame.quality.confidenceQ48, 'HOMEOS confidence')), q48.SCALE);
    const coverage = input.inputs.reduce((value, frame) => minimum(value, unit(frame.quality.coverageQ48, 'HOMEOS coverage')), q48.SCALE);
    state = {
      frameIndex,
      dimensions: updates.map(update => update.state),
      stabilityLoadQ48: stabilityLoad.toString(),
      lifecycle,
      inputCursors: Object.fromEntries(input.inputs.map(frame => [frame.route.routeId, frame.producerSequence]).sort(([left], [right]) => left.localeCompare(right))),
      outputSequence: state.outputSequence
    };

    const outputs = [];
    if (identity.mode === 'SHADOW') {
      let sequence = BigInt(state.outputSequence);
      for (const update of updates) {
        sequence += 1n;
        outputs.push(buildFrame({
          identity,
          state,
          routeId: 'p1r0.homeos-dimension.intero',
          topic: 'homeos.dimension.summary.v1',
          schemaId: 'urn:stay:p1-r0:schema:homeos-dimension-summary-payload:v1',
          payload: update.summary,
          sequence,
          inputs: input.inputs,
          confidenceQ48: update.summary.confidenceQ48,
          coverageQ48: update.summary.coverageQ48
        }));
      }
      sequence += 1n;
      outputs.push(buildFrame({
        identity,
        state,
        routeId: 'p1r0.homeos-stability.intero',
        topic: 'homeos.stability.summary.v1',
        schemaId: 'urn:stay:p1-r0:schema:homeos-stability-summary-payload:v1',
        payload: {
          stabilityLoadQ48: state.stabilityLoadQ48,
          state: lifecycle,
          activePressureCount,
          confidenceQ48: confidence.toString(),
          coverageQ48: coverage.toString()
        },
        sequence,
        inputs: input.inputs,
        confidenceQ48: confidence.toString(),
        coverageQ48: coverage.toString()
      }));
      state.outputSequence = sequence.toString();
    }
    return deepFreeze({ state: snapshot(), outputs: deepFreeze(outputs), duplicate: false });
  }

  return Object.freeze({ advance, snapshot, restore });
}

module.exports = Object.freeze({ createHomeosEngine });
