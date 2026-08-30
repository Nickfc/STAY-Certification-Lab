'use strict';

const { stableStringify } = require('../kernel/canonical-json');
const q48 = require('./q16-48');
const { validateCausalFrame } = require('./causal-frame');
const contract = require('./intero-contract.json');

const PROFILE_FIELDS = new Set([
  'profileId', 'noiseKeyHex', 'transformVersion', 'channels', 'axes',
  'minimumConfidenceQ48', 'adaptationConfidenceQ48', 'adaptationMinimumFrames',
  'maxAdaptationPer24hQ48', 'maxLifetimeAdaptationQ48', 'numericPolicy', 'frameMs'
]);
const CHANNEL_FIELDS = new Set([
  'channelId', 'required', 'source', 'sourceLowQ48', 'sourceHighQ48', 'delayFrames',
  'resolutionQ48', 'imperfectionAmplitudeQ48', 'alphaQ48', 'trendWindowFrames',
  'trendMaxQ48', 'baselinePolicy', 'founderBaselineQ48', 'lifetimeDriftMaxQ48',
  'persistenceLoadQ48', 'persistenceReliefQ48', 'salienceWeights', 'freshnessMs'
]);
const SOURCE_FIELDS = new Set(['producerCoreId', 'topic', 'schemaId', 'unit', 'mode']);
const SALIENCE_FIELDS = new Set(['deviationQ48', 'trendQ48', 'persistenceQ48']);
const AXIS_FIELDS = new Set(['axisId', 'requiredCoverageQ48', 'weights']);
const AXIS_WEIGHT_FIELDS = new Set(['channelId', 'levelQ48', 'trendQ48', 'persistenceQ48']);
const SOURCE_BY_ROUTE = new Map(contract.sources.map(source => [source.routeId, Object.freeze(source)]));
const SOURCE_BY_CHANNEL = new Map(contract.sources.map(source => [source.channelId, Object.freeze(source)]));
const SCARCITY = new Set(['ABUNDANT', 'BALANCED', 'CONSERVING', 'DEPLETED', 'UNRESOLVED', 'PROTECTED']);
const HOMEOS_STATE = new Set(['INITIALIZING', 'STABLE', 'STRAINED', 'UNRESOLVED', 'PROTECTED', 'RECOVERING']);
const HEX_64 = /^[0-9a-f]{16}$/;

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function exact(value, fields, label, code = 'P1_INTERO_CONTRACT_SCHEMA') {
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

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} is invalid`, 'P1_INTERO_CONTRACT_RANGE');
  }
  return value;
}

function raw(value, label, minimum = q48.MIN_RAW, maximum = q48.MAX_RAW) {
  const parsed = q48.parseRaw(value);
  if (parsed < minimum || parsed > maximum) fail(`${label} is outside its range`, 'P1_INTERO_CONTRACT_RANGE');
  return parsed;
}

function unit(value, label) {
  return raw(value, label, 0n, q48.SCALE);
}

function validatePayload(source, frame) {
  exact(frame.payload, new Set(source.payloadFields), `${source.key} payload`, 'P1_INTERO_INPUT_SCHEMA');
  if (source.key === 'availability') {
    unit(frame.payload.availabilityQ48, 'INTERO availability');
    raw(frame.payload.debtQ48, 'INTERO metabolic debt', 0n);
    unit(frame.payload.confidenceQ48, 'INTERO availability confidence');
    unit(frame.payload.coverageQ48, 'INTERO availability coverage');
    if (!SCARCITY.has(frame.payload.scarcityState)) fail('INTERO scarcity state is invalid', 'P1_INTERO_INPUT_SCHEMA');
    if (
      frame.payload.confidenceQ48 !== frame.quality.confidenceQ48 ||
      frame.payload.coverageQ48 !== frame.quality.coverageQ48
    ) fail('INTERO availability quality disagrees with its frame', 'P1_INTERO_INPUT_QUALITY');
  } else if (source.key === 'reserve') {
    raw(frame.payload.reserveQ48, 'INTERO reserve', 0n);
    unit(frame.payload.reserveFractionQ48, 'INTERO reserve fraction');
    raw(frame.payload.trendQ48PerSecond, 'INTERO reserve trend');
    raw(frame.payload.cumulativeChargeQ48, 'INTERO cumulative reserve charge', 0n);
    raw(frame.payload.cumulativeDischargeQ48, 'INTERO cumulative reserve discharge', 0n);
    unit(frame.payload.confidenceQ48, 'INTERO reserve confidence');
    if (frame.payload.confidenceQ48 !== frame.quality.confidenceQ48) {
      fail('INTERO reserve quality disagrees with its frame', 'P1_INTERO_INPUT_QUALITY');
    }
  } else {
    unit(frame.payload.stabilityLoadQ48, 'INTERO stability load');
    integer(frame.payload.activePressureCount, 'INTERO active pressure count');
    unit(frame.payload.confidenceQ48, 'INTERO stability confidence');
    unit(frame.payload.coverageQ48, 'INTERO stability coverage');
    if (!HOMEOS_STATE.has(frame.payload.state)) fail('INTERO HOMEOS state is invalid', 'P1_INTERO_INPUT_SCHEMA');
    if (
      frame.payload.confidenceQ48 !== frame.quality.confidenceQ48 ||
      frame.payload.coverageQ48 !== frame.quality.coverageQ48
    ) fail('INTERO stability quality disagrees with its frame', 'P1_INTERO_INPUT_QUALITY');
  }
}

function validateInteroInputFrame(input, consumerFrame) {
  integer(consumerFrame, 'INTERO consumer frame');
  const frame = validateCausalFrame(input);
  const source = SOURCE_BY_ROUTE.get(frame.route.routeId);
  if (!source) fail('frame is not a reviewed INTERO input', 'P1_INTERO_INPUT_ROUTE');
  if (
    frame.producer.coreId.toUpperCase().replaceAll('-', '_') !== source.producer ||
    frame.producer.mode !== source.producerMode ||
    frame.producer.authorityEpoch !== '0' ||
    frame.route.consumerCoreId.toUpperCase().replaceAll('-', '_') !== contract.consumer ||
    frame.topic.name !== source.topic ||
    frame.topic.class !== source.topicClass ||
    frame.topic.schemaId !== source.schemaId ||
    frame.topic.schemaVersion !== '1' ||
    frame.topic.unit !== source.unit ||
    frame.topic.scale !== 'Q16.48'
  ) fail('INTERO input identity does not match its frozen source', 'P1_INTERO_INPUT_IDENTITY');
  if (frame.quality.status !== 'ACCEPT') fail('INTERO cannot consume unresolved evidence', 'P1_INTERO_INPUT_UNKNOWN');
  if (consumerFrame < frame.visibleFromFrame || consumerFrame < frame.committedFrame + source.delayFrames) {
    fail('INTERO founder delay is not satisfied', 'P1_INTERO_INPUT_DELAY');
  }
  validatePayload(source, frame);
  return deepFreeze({ source: source.key, channelId: source.channelId, frame });
}

function sameProducer(left, right) {
  return ['coreId', 'residencyId', 'coreVersion', 'authorityEpoch', 'mode']
    .every(field => left.producer[field] === right.producer[field]);
}

function validateCoherence(bySource) {
  const availability = bySource.get('availability');
  const reserve = bySource.get('reserve');
  const stability = bySource.get('stability');
  if ([reserve, stability].some(frame => frame.organismId !== availability.organismId)) {
    fail('INTERO evidence crosses organism identity', 'P1_INTERO_INPUT_COHERENCE');
  }
  if (
    reserve.founderLineageId !== availability.founderLineageId ||
    reserve.committedFrame !== availability.committedFrame ||
    !sameProducer(availability, reserve)
  ) fail('INTERO METAB evidence is not producer-coherent', 'P1_INTERO_INPUT_COHERENCE');
  if (stability.committedFrame !== availability.committedFrame + 1) {
    fail('INTERO HOMEOS evidence is not descended from the METAB frame', 'P1_INTERO_INPUT_COHERENCE');
  }
  if (stability.causalSpan.latestFrame !== availability.committedFrame) {
    fail('INTERO HOMEOS causal frontier does not match METAB', 'P1_INTERO_INPUT_COHERENCE');
  }
  const metabAncestors = stability.causalSpan.ancestors.filter(ancestor => ancestor.producerCoreId === 'METAB');
  for (const topic of ['metab.energy.availability.v1', 'metab.energy.reserve.v1']) {
    const ancestor = metabAncestors.find(candidate => candidate.topic === topic);
    if (
      !ancestor ||
      ancestor.residencyId !== availability.producer.residencyId ||
      ancestor.mode !== 'SHADOW' ||
      ancestor.shadowAncestry !== true ||
      ancestor.sourceWindow.startFrame !== availability.sourceWindow.startFrame ||
      ancestor.sourceWindow.endFrame !== availability.sourceWindow.endFrame
    ) fail('INTERO HOMEOS ancestry does not bind the common METAB frame', 'P1_INTERO_INPUT_COHERENCE');
  }
}

function collectInteroInputs(inputs, consumerFrame) {
  if (!Array.isArray(inputs) || inputs.length !== contract.sources.length) {
    fail('INTERO requires exactly one frame for each founder channel', 'P1_INTERO_INPUT_COVERAGE');
  }
  const validated = inputs.map(input => validateInteroInputFrame(input, consumerFrame));
  const bySource = new Map();
  for (const item of validated) {
    if (bySource.has(item.source)) fail('INTERO received duplicate canonical evidence', 'P1_INTERO_INPUT_CONFLICT');
    bySource.set(item.source, item.frame);
  }
  if (contract.sources.some(source => !bySource.has(source.key))) {
    fail('INTERO source coverage is incomplete', 'P1_INTERO_INPUT_COVERAGE');
  }
  validateCoherence(bySource);
  return deepFreeze({
    consumerFrame,
    organismId: bySource.get('availability').organismId,
    channels: contract.sources.map(source => ({
      channelId: source.channelId,
      valueQ48: bySource.get(source.key).payload[source.valueField],
      frame: clone(bySource.get(source.key))
    }))
  });
}

function validateInteroFounderProfile(input) {
  exact(input, PROFILE_FIELDS, 'INTERO founder profile');
  if (
    input.frameMs !== 250 ||
    input.numericPolicy !== 'Q16.48-half-even-saturating-v1' ||
    input.transformVersion !== 'splitmix64-fnv1a64-q0.48-triangular-v1' ||
    !HEX_64.test(input.noiseKeyHex) ||
    integer(input.adaptationMinimumFrames, 'INTERO adaptation minimum', 172800) !== input.adaptationMinimumFrames
  ) fail('INTERO founder policy is invalid', 'P1_INTERO_PROFILE');
  for (const field of ['minimumConfidenceQ48', 'adaptationConfidenceQ48', 'maxAdaptationPer24hQ48', 'maxLifetimeAdaptationQ48']) {
    unit(input[field], `INTERO ${field}`);
  }
  if (!Array.isArray(input.channels) || input.channels.length !== contract.sources.length) {
    fail('INTERO must have exactly the reviewed channels', 'P1_INTERO_PROFILE');
  }
  const channelIds = new Set();
  for (const channel of input.channels) {
    exact(channel, CHANNEL_FIELDS, 'INTERO channel');
    exact(channel.source, SOURCE_FIELDS, 'INTERO channel source');
    exact(channel.salienceWeights, SALIENCE_FIELDS, 'INTERO salience weights');
    const source = SOURCE_BY_CHANNEL.get(channel.channelId);
    if (
      !source || channelIds.has(channel.channelId) || channel.required !== true ||
      channel.source.producerCoreId !== source.producer ||
      channel.source.topic !== source.topic ||
      channel.source.schemaId !== source.schemaId ||
      channel.source.unit !== source.unit ||
      channel.source.mode !== source.producerMode ||
      channel.delayFrames !== source.delayFrames
    ) fail('INTERO channel lacks one canonical frozen source', 'P1_INTERO_PROFILE_SOURCE');
    channelIds.add(channel.channelId);
    integer(channel.delayFrames, 'INTERO channel delay', 1, 20);
    integer(channel.trendWindowFrames, 'INTERO trend window', 1, 240);
    integer(channel.freshnessMs, 'INTERO freshness', 250, 2000);
    const low = raw(channel.sourceLowQ48, 'INTERO source low');
    const high = raw(channel.sourceHighQ48, 'INTERO source high');
    if (high <= low) fail('INTERO source range is invalid', 'P1_INTERO_PROFILE');
    raw(channel.founderBaselineQ48, 'INTERO founder baseline', low, high);
    for (const field of ['resolutionQ48', 'imperfectionAmplitudeQ48', 'alphaQ48', 'lifetimeDriftMaxQ48', 'persistenceLoadQ48', 'persistenceReliefQ48', 'trendMaxQ48']) {
      unit(channel[field], `INTERO ${field}`);
    }
    for (const field of SALIENCE_FIELDS) unit(channel.salienceWeights[field], `INTERO salience ${field}`);
    if (!['FIXED', 'PHASED', 'SLOW_ADAPT'].includes(channel.baselinePolicy)) {
      fail('INTERO baseline policy is invalid', 'P1_INTERO_PROFILE');
    }
  }
  if (!Array.isArray(input.axes) || input.axes.length < 1 || input.axes.length > 16) {
    fail('INTERO axes are invalid', 'P1_INTERO_PROFILE');
  }
  const axisIds = new Set();
  for (const axis of input.axes) {
    exact(axis, AXIS_FIELDS, 'INTERO axis');
    if (typeof axis.axisId !== 'string' || axis.axisId.length === 0 || axisIds.has(axis.axisId)) {
      fail('INTERO axis identity is invalid', 'P1_INTERO_PROFILE');
    }
    axisIds.add(axis.axisId);
    unit(axis.requiredCoverageQ48, 'INTERO axis required coverage');
    if (!Array.isArray(axis.weights) || axis.weights.length < 1 || axis.weights.length > 32) {
      fail('INTERO axis weights are invalid', 'P1_INTERO_PROFILE');
    }
    const weightedChannels = new Set();
    for (const weight of axis.weights) {
      exact(weight, AXIS_WEIGHT_FIELDS, 'INTERO axis weight');
      if (!channelIds.has(weight.channelId) || weightedChannels.has(weight.channelId)) {
        fail('INTERO axis has an invalid channel binding', 'P1_INTERO_PROFILE_SOURCE');
      }
      weightedChannels.add(weight.channelId);
      for (const field of ['levelQ48', 'trendQ48', 'persistenceQ48']) unit(weight[field], `INTERO axis ${field}`);
    }
  }
  return deepFreeze(clone(input));
}

module.exports = Object.freeze({
  contract: deepFreeze(clone(contract)),
  validateInteroInputFrame,
  collectInteroInputs,
  validateInteroFounderProfile
});
