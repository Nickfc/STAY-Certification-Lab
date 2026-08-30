'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../kernel/canonical-json');
const q48 = require('./q16-48');
const { triangularQ0_48 } = require('./deterministic-noise');
const { contract, collectInteroInputs, validateInteroFounderProfile } = require('./intero-contract');

const OPTION_FIELDS = new Set(['profile', 'identity']);
const IDENTITY_FIELDS = new Set([
  'organismId', 'founderLineageId', 'residencyId', 'coreVersion', 'authorityEpoch', 'mode'
]);
const ADVANCE_FIELDS = new Set(['frameIndex', 'inputs']);
const STATE_FIELDS = new Set([
  'frameIndex', 'counterFrontier', 'channels', 'lifecycle', 'inputCursors', 'outputSequence'
]);
const CHANNEL_STATE_FIELDS = new Set([
  'channelId', 'delayRingHash', 'delayIndex', 'filteredQ48', 'trendQ48', 'baselineQ48',
  'lifetimeDriftQ48', 'persistenceQ48', 'salienceQ48', 'saturated', 'quality', 'sourceSequence'
]);
const QUALITY = new Set(['ACCEPT', 'HOLD', 'UNKNOWN', 'QUARANTINE']);
const LIFECYCLE = new Set([
  'UNFOUNDED', 'INITIALIZING', 'SENSING', 'PARTIAL', 'SATURATED',
  'UNRESOLVED', 'PROTECTED', 'RECOVERING'
]);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function exact(value, fields, label, code = 'P1_INTERO_ENGINE_SCHEMA') {
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
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`, 'P1_INTERO_ENGINE_SCHEMA');
  return value;
}

function raw(value, label, minimum = q48.MIN_RAW, maximum = q48.MAX_RAW) {
  const parsed = q48.parseRaw(value);
  if (parsed < minimum || parsed > maximum) fail(`${label} is outside its range`, 'P1_INTERO_ENGINE_RANGE');
  return parsed;
}

function unit(value, label) {
  return raw(value, label, 0n, q48.SCALE);
}

function minimum(left, right) {
  return left < right ? left : right;
}

function absolute(value) {
  return value < 0n ? -value : value;
}

function validateIdentity(input) {
  exact(input, IDENTITY_FIELDS, 'INTERO identity', 'P1_INTERO_IDENTITY');
  for (const field of ['organismId', 'founderLineageId', 'residencyId', 'coreVersion']) {
    if (typeof input[field] !== 'string' || !SAFE_ID.test(input[field])) fail(`INTERO ${field} is invalid`, 'P1_INTERO_IDENTITY');
  }
  if (input.authorityEpoch !== '0') fail('laboratory INTERO must own zero authority', 'P1_INTERO_AUTHORITY');
  if (!['NEUTRAL', 'SHADOW'].includes(input.mode)) fail('laboratory INTERO mode is invalid', 'P1_INTERO_AUTHORITY');
  return deepFreeze(clone(input));
}

function initialState(profile) {
  return {
    frameIndex: 0,
    counterFrontier: 0,
    channels: profile.channels.map(channel => ({
      channelId: channel.channelId,
      delayRingHash: sha256([]),
      delayIndex: 0,
      filteredQ48: channel.founderBaselineQ48,
      trendQ48: '0',
      baselineQ48: channel.founderBaselineQ48,
      lifetimeDriftQ48: '0',
      persistenceQ48: '0',
      salienceQ48: '0',
      saturated: false,
      quality: 'UNKNOWN',
      sourceSequence: '0'
    })),
    lifecycle: 'INITIALIZING',
    inputCursors: Object.fromEntries(contract.sources.map(source => [source.routeId, '0'])),
    outputSequence: '0'
  };
}

function validateState(input, profile) {
  exact(input, STATE_FIELDS, 'INTERO state', 'P1_INTERO_STATE');
  integer(input.frameIndex, 'INTERO state frame');
  integer(input.counterFrontier, 'INTERO counter frontier');
  if (!LIFECYCLE.has(input.lifecycle)) fail('INTERO lifecycle is invalid', 'P1_INTERO_STATE');
  if (!Array.isArray(input.channels) || input.channels.length !== profile.channels.length) {
    fail('INTERO state channels are invalid', 'P1_INTERO_STATE');
  }
  for (let index = 0; index < input.channels.length; index += 1) {
    const channel = input.channels[index];
    exact(channel, CHANNEL_STATE_FIELDS, 'INTERO channel state', 'P1_INTERO_STATE');
    if (
      channel.channelId !== profile.channels[index].channelId ||
      !/^sha256:[0-9a-f]{64}$/.test(channel.delayRingHash) ||
      !QUALITY.has(channel.quality) ||
      typeof channel.saturated !== 'boolean' ||
      !/^(0|[1-9][0-9]*)$/.test(channel.sourceSequence)
    ) fail('INTERO channel state identity is invalid', 'P1_INTERO_STATE');
    integer(channel.delayIndex, 'INTERO delay index');
    raw(channel.filteredQ48, 'INTERO filtered state');
    raw(channel.trendQ48, 'INTERO trend state');
    raw(channel.baselineQ48, 'INTERO baseline state');
    raw(channel.lifetimeDriftQ48, 'INTERO lifetime drift');
    unit(channel.persistenceQ48, 'INTERO persistence');
    unit(channel.salienceQ48, 'INTERO salience');
  }
  if (!input.inputCursors || typeof input.inputCursors !== 'object' || Array.isArray(input.inputCursors)) {
    fail('INTERO input cursors are invalid', 'P1_INTERO_STATE');
  }
  const cursorKeys = Object.keys(input.inputCursors).sort();
  const expectedCursorKeys = contract.sources.map(source => source.routeId).sort();
  if (
    cursorKeys.length !== expectedCursorKeys.length ||
    cursorKeys.some((key, index) => key !== expectedCursorKeys[index])
  ) fail('INTERO input cursor routes are invalid', 'P1_INTERO_STATE');
  for (const cursor of Object.values(input.inputCursors)) {
    if (!/^(0|[1-9][0-9]*)$/.test(cursor)) fail('INTERO input cursor is invalid', 'P1_INTERO_STATE');
  }
  if (!/^(0|[1-9][0-9]*)$/.test(input.outputSequence)) fail('INTERO output sequence is invalid', 'P1_INTERO_STATE');
  return clone(input);
}

function boundedNoise(profile, descriptor, frameIndex) {
  const vector = triangularQ0_48({
    noiseKeyHex: profile.noiseKeyHex,
    channelId: descriptor.channelId,
    frameIndex
  });
  return q48.mul(
    unit(descriptor.imperfectionAmplitudeQ48, 'INTERO imperfection amplitude'),
    q48.parseRaw(vector.differenceQ0_48Raw)
  );
}

function adaptation(previous, descriptor, filtered, confidence, counterFrontier, profile) {
  let baseline = raw(previous.baselineQ48, 'INTERO prior baseline');
  let drift = raw(previous.lifetimeDriftQ48, 'INTERO prior lifetime drift');
  const persistence = unit(previous.persistenceQ48, 'INTERO prior persistence');
  const eligible =
    descriptor.baselinePolicy === 'SLOW_ADAPT' &&
    counterFrontier >= profile.adaptationMinimumFrames &&
    confidence >= unit(profile.adaptationConfidenceQ48, 'INTERO adaptation confidence') &&
    persistence <= unit(descriptor.resolutionQ48, 'INTERO adaptation protection threshold');
  if (!eligible) return { baseline, drift };
  const framesPer24h = Math.floor(86_400_000 / profile.frameMs);
  const maximumStep = q48.roundHalfEven(
    unit(profile.maxAdaptationPer24hQ48, 'INTERO daily adaptation'),
    BigInt(framesPer24h)
  );
  const desired = filtered - baseline;
  const step = q48.clamp(desired, -maximumStep, maximumStep);
  const descriptorLimit = unit(descriptor.lifetimeDriftMaxQ48, 'INTERO channel drift limit');
  const profileLimit = unit(profile.maxLifetimeAdaptationQ48, 'INTERO profile drift limit');
  const limit = minimum(descriptorLimit, profileLimit);
  const nextDrift = q48.clamp(drift + step, -limit, limit);
  baseline = q48.add(baseline, nextDrift - drift);
  drift = nextDrift;
  return { baseline, drift };
}

function updateChannel(previous, descriptor, evidence, frameIndex, counterFrontier, profile) {
  const low = raw(descriptor.sourceLowQ48, 'INTERO source low');
  const high = raw(descriptor.sourceHighQ48, 'INTERO source high');
  const resolution = unit(descriptor.resolutionQ48, 'INTERO resolution');
  const sample = raw(evidence.valueQ48, `INTERO ${descriptor.channelId} sample`, low, high);
  const perceived = q48.clamp(q48.quantize(q48.saturatingAdd(sample, boundedNoise(profile, descriptor, frameIndex)), resolution), low, high);
  const oldFiltered = raw(previous.filteredQ48, 'INTERO prior filtered state');
  const alpha = unit(descriptor.alphaQ48, 'INTERO filter alpha');
  const filtered = q48.add(oldFiltered, q48.mul(alpha, perceived - oldFiltered));
  const instantTrend = q48.div(filtered - oldFiltered, q48.fromDecimal('0.25'));
  const trendMaximum = unit(descriptor.trendMaxQ48, 'INTERO trend maximum');
  const boundedTrend = q48.clamp(instantTrend, -trendMaximum, trendMaximum);
  const trendAlpha = q48.roundHalfEven(q48.SCALE, BigInt(descriptor.trendWindowFrames));
  const oldTrend = raw(previous.trendQ48, 'INTERO prior trend');
  const trend = q48.add(oldTrend, q48.mul(trendAlpha, boundedTrend - oldTrend));
  const confidence = unit(evidence.frame.quality.confidenceQ48, 'INTERO source confidence');
  const adapted = adaptation(previous, descriptor, filtered, confidence, counterFrontier, profile);
  const deviation = absolute(filtered - adapted.baseline);
  let persistence = unit(previous.persistenceQ48, 'INTERO prior persistence');
  if (deviation > resolution) {
    const load = q48.mul(
      q48.mul(unit(descriptor.persistenceLoadQ48, 'INTERO persistence load'), deviation),
      q48.fromDecimal('0.25')
    );
    persistence = q48.clamp(q48.saturatingAdd(persistence, load), 0n, q48.SCALE);
  } else {
    const relief = q48.mul(unit(descriptor.persistenceReliefQ48, 'INTERO persistence relief'), q48.fromDecimal('0.25'));
    persistence = persistence > relief ? persistence - relief : 0n;
  }
  const weights = descriptor.salienceWeights;
  const totalWeight = unit(weights.deviationQ48, 'INTERO deviation weight') +
    unit(weights.trendQ48, 'INTERO trend weight') +
    unit(weights.persistenceQ48, 'INTERO persistence weight');
  const weighted = q48.mul(deviation, unit(weights.deviationQ48, 'INTERO deviation weight')) +
    q48.mul(absolute(trend), unit(weights.trendQ48, 'INTERO trend weight')) +
    q48.mul(persistence, unit(weights.persistenceQ48, 'INTERO persistence weight'));
  const salience = totalWeight === 0n ? 0n : q48.clamp(q48.div(weighted, totalWeight), 0n, q48.SCALE);
  const saturated = perceived === low || perceived === high;
  const next = {
    channelId: descriptor.channelId,
    delayRingHash: sha256({ previous: previous.delayRingHash, frameId: evidence.frame.frameId, delayFrames: descriptor.delayFrames }),
    delayIndex: (previous.delayIndex + 1) % descriptor.trendWindowFrames,
    filteredQ48: filtered.toString(),
    trendQ48: trend.toString(),
    baselineQ48: adapted.baseline.toString(),
    lifetimeDriftQ48: adapted.drift.toString(),
    persistenceQ48: persistence.toString(),
    salienceQ48: salience.toString(),
    saturated,
    quality: 'ACCEPT',
    sourceSequence: evidence.frame.producerSequence
  };
  return {
    state: next,
    coverageQ48: evidence.frame.quality.coverageQ48,
    payload: {
      channelId: descriptor.channelId,
      levelQ48: next.filteredQ48,
      trendQ48: next.trendQ48,
      baselineDeltaQ48: (filtered - adapted.baseline).toString(),
      persistenceQ48: next.persistenceQ48,
      salienceQ48: next.salienceQ48,
      confidenceQ48: evidence.frame.quality.confidenceQ48,
      validity: 'VALID',
      saturated,
      sourceWindow: clone(evidence.frame.sourceWindow)
    }
  };
}

function buildAxes(profile, channelPayloads) {
  const byChannel = new Map(channelPayloads.map(channel => [channel.channelId, channel]));
  return profile.axes.map(axis => {
    let numerator = 0n;
    let denominator = 0n;
    let confidence = q48.SCALE;
    for (const weight of axis.weights) {
      const channel = byChannel.get(weight.channelId);
      const levelWeight = unit(weight.levelQ48, 'INTERO axis level weight');
      const trendWeight = unit(weight.trendQ48, 'INTERO axis trend weight');
      const persistenceWeight = unit(weight.persistenceQ48, 'INTERO axis persistence weight');
      numerator += q48.mul(unit(channel.levelQ48, 'INTERO axis level'), levelWeight);
      numerator += q48.mul(absolute(raw(channel.trendQ48, 'INTERO axis trend')), trendWeight);
      numerator += q48.mul(unit(channel.persistenceQ48, 'INTERO axis persistence'), persistenceWeight);
      denominator += levelWeight + trendWeight + persistenceWeight;
      confidence = minimum(confidence, unit(channel.confidenceQ48, 'INTERO axis confidence'));
    }
    const value = denominator === 0n ? 0n : q48.clamp(q48.div(numerator, denominator), 0n, q48.SCALE);
    return {
      axisId: axis.axisId,
      valueQ48: value.toString(),
      confidenceQ48: confidence.toString(),
      requiredCoverageQ48: axis.requiredCoverageQ48,
      channelIds: axis.weights.map(weight => weight.channelId)
    };
  });
}

function band(value) {
  const low = q48.roundHalfEven(q48.SCALE, 3n);
  const high = q48.roundHalfEven(q48.SCALE * 2n, 3n);
  return value < low ? 'LOW' : value > high ? 'HIGH' : 'MID';
}

function buildProjection(profile, state, updates) {
  const channels = updates.map(update => update.payload);
  const axes = buildAxes(profile, channels);
  const confidence = channels.reduce(
    (value, channel) => minimum(value, unit(channel.confidenceQ48, 'INTERO body confidence')),
    q48.SCALE
  );
  const coverage = updates.reduce(
    (value, update) => minimum(value, unit(update.coverageQ48, 'INTERO body coverage')),
    q48.SCALE
  );
  const bodyFrame = {
    frameFrontier: state.frameIndex,
    frameIndex: state.frameIndex,
    channels,
    axes,
    profileHash: sha256(profile),
    transformVersion: profile.transformVersion,
    requiredCoverageQ48: axes.reduce(
      (value, axis) => minimum(value, unit(axis.requiredCoverageQ48, 'INTERO required coverage')),
      q48.SCALE
    ).toString()
  };
  const bodySummary = {
    axisBands: Object.fromEntries(axes.map(axis => [axis.axisId, band(unit(axis.valueQ48, 'INTERO axis value'))])),
    coverageQ48: coverage.toString(),
    confidenceQ48: confidence.toString(),
    validChannelCount: channels.length
  };
  return deepFreeze({ bodyFrame, bodySummary });
}

function createInteroEngine(options = {}) {
  exact(options, OPTION_FIELDS, 'INTERO engine options', 'P1_INTERO_OPTIONS');
  const profile = validateInteroFounderProfile(options.profile);
  const identity = validateIdentity(options.identity);
  let state = initialState(profile);
  const seen = new Map();
  const sourceSequences = new Map();

  function snapshot() {
    return deepFreeze(clone(state));
  }

  function restore(input) {
    const next = validateState(input, profile);
    if (
      next.frameIndex < state.frameIndex ||
      next.counterFrontier < state.counterFrontier ||
      BigInt(next.outputSequence) < BigInt(state.outputSequence) ||
      next.channels.some((channel, index) => BigInt(channel.sourceSequence) < BigInt(state.channels[index].sourceSequence))
    ) fail('INTERO restore would rewind acquired perception', 'P1_INTERO_REWIND');
    state = next;
    return snapshot();
  }

  function advance(input) {
    exact(input, ADVANCE_FIELDS, 'INTERO advance input');
    const frameIndex = integer(input.frameIndex, 'INTERO frame index', 1);
    if (input.inputs !== null && !Array.isArray(input.inputs)) fail('INTERO inputs are invalid', 'P1_INTERO_ENGINE_SCHEMA');
    const inputHash = input.inputs === null ? null : sha256(input.inputs);
    if (inputHash && seen.has(inputHash)) {
      return deepFreeze({ state: snapshot(), projection: null, outputs: [], duplicate: true });
    }
    if (state.frameIndex !== 0 && frameIndex !== state.frameIndex + 1) {
      fail('INTERO frame progression is not contiguous', 'P1_INTERO_FRAME_SEQUENCE');
    }

    if (input.inputs === null) {
      state = {
        ...state,
        frameIndex,
        channels: state.channels.map(channel => ({ ...channel, quality: 'UNKNOWN' })),
        lifecycle: 'UNRESOLVED'
      };
      return deepFreeze({ state: snapshot(), projection: null, outputs: [], duplicate: false });
    }

    const collected = collectInteroInputs(input.inputs, frameIndex);
    if (collected.organismId !== identity.organismId) fail('INTERO cannot cross organism identity', 'P1_INTERO_INPUT_IDENTITY');
    const minimumConfidence = unit(profile.minimumConfidenceQ48, 'INTERO minimum confidence');
    for (const evidence of collected.channels) {
      if (unit(evidence.frame.quality.confidenceQ48, 'INTERO source confidence') < minimumConfidence) {
        fail('INTERO source confidence is below its founder minimum', 'P1_INTERO_INPUT_CONFIDENCE');
      }
      const cursorKey = `${evidence.frame.route.routeId}:${evidence.frame.producerSequence}`;
      const previousFrameId = sourceSequences.get(cursorKey);
      if (previousFrameId && previousFrameId !== evidence.frame.frameId) {
        fail('INTERO source sequence was replayed with conflicting content', 'P1_INTERO_REPLAY_CONFLICT');
      }
      const currentCursor = BigInt(state.inputCursors[evidence.frame.route.routeId]);
      if (BigInt(evidence.frame.producerSequence) <= currentCursor) {
        fail('INTERO source sequence does not advance its committed cursor', 'P1_INTERO_REPLAY_CONFLICT');
      }
    }
    seen.set(inputHash, true);
    for (const evidence of collected.channels) {
      sourceSequences.set(`${evidence.frame.route.routeId}:${evidence.frame.producerSequence}`, evidence.frame.frameId);
    }
    const byChannel = new Map(collected.channels.map(channel => [channel.channelId, channel]));
    const counterFrontier = state.counterFrontier + 1;
    const updates = profile.channels.map((descriptor, index) =>
      updateChannel(state.channels[index], descriptor, byChannel.get(descriptor.channelId), frameIndex, counterFrontier, profile)
    );
    const lifecycle = updates.some(update => update.state.saturated)
      ? 'SATURATED'
      : state.lifecycle === 'UNRESOLVED' ? 'RECOVERING' : 'SENSING';
    state = {
      frameIndex,
      counterFrontier,
      channels: updates.map(update => update.state),
      lifecycle,
      inputCursors: Object.fromEntries(collected.channels.map(evidence => [
        evidence.frame.route.routeId, evidence.frame.producerSequence
      ]).sort(([left], [right]) => left.localeCompare(right))),
      outputSequence: state.outputSequence
    };
    const projection = buildProjection(profile, state, updates);

    // The single INTERO->SNTSS route remains ABSENT in this tranche. A contained
    // projection is returned for laboratory qualification but no routed frame exists.
    return deepFreeze({ state: snapshot(), projection, outputs: [], duplicate: false });
  }

  return Object.freeze({ advance, snapshot, restore });
}

module.exports = Object.freeze({ createInteroEngine });
