'use strict';

const { stableStringify } = require('../kernel/canonical-json');
const q48 = require('./q16-48');
const { validateCausalFrame } = require('./causal-frame');
const contract = require('./homeos-contract.json');

const SCARCITY = new Set(['ABUNDANT', 'BALANCED', 'CONSERVING', 'DEPLETED', 'UNRESOLVED', 'PROTECTED']);
const SOURCE_BY_ROUTE = new Map(contract.sources.map(source => [source.routeId, Object.freeze(source)]));
const HOMEOS_PROFILE_FIELDS = new Set([
  'profileId', 'dimensions', 'minimumConfidenceQ48', 'adaptationConfidenceQ48',
  'holdFrames', 'adaptationMinimumFrames', 'maxAdaptationPer24hQ48',
  'maxLifetimeAdaptationQ48', 'numericPolicy', 'frameMs'
]);

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function exact(value, fields, label, code = 'P1_HOMEOS_CONTRACT_SCHEMA') {
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

function raw(value, label, { minimum = q48.MIN_RAW, maximum = q48.MAX_RAW } = {}) {
  const parsed = q48.parseRaw(value);
  if (parsed < minimum || parsed > maximum) fail(`${label} is outside its contract range`, 'P1_HOMEOS_CONTRACT_RANGE');
  return parsed;
}

function unitInterval(value, label) {
  return raw(value, label, { minimum: 0n, maximum: q48.SCALE });
}

function validatePayload(source, frame) {
  exact(frame.payload, new Set(source.payloadFields), `${source.key} payload`, 'P1_HOMEOS_INPUT_SCHEMA');
  if (source.key === 'availability') {
    unitInterval(frame.payload.availabilityQ48, 'availability');
    raw(frame.payload.debtQ48, 'metabolic debt', { minimum: 0n });
    unitInterval(frame.payload.confidenceQ48, 'availability confidence');
    unitInterval(frame.payload.coverageQ48, 'availability coverage');
    if (!SCARCITY.has(frame.payload.scarcityState)) fail('availability scarcity state is invalid', 'P1_HOMEOS_INPUT_SCHEMA');
    if (
      frame.payload.confidenceQ48 !== frame.quality.confidenceQ48 ||
      frame.payload.coverageQ48 !== frame.quality.coverageQ48
    ) fail('availability quality disagrees with its frame', 'P1_HOMEOS_INPUT_QUALITY');
  } else {
    raw(frame.payload.reserveQ48, 'reserve', { minimum: 0n });
    unitInterval(frame.payload.reserveFractionQ48, 'reserve fraction');
    raw(frame.payload.trendQ48PerSecond, 'reserve trend');
    raw(frame.payload.cumulativeChargeQ48, 'cumulative reserve charge', { minimum: 0n });
    raw(frame.payload.cumulativeDischargeQ48, 'cumulative reserve discharge', { minimum: 0n });
    unitInterval(frame.payload.confidenceQ48, 'reserve confidence');
    if (frame.payload.confidenceQ48 !== frame.quality.confidenceQ48) {
      fail('reserve quality disagrees with its frame', 'P1_HOMEOS_INPUT_QUALITY');
    }
  }
}

function validateHomeosInputFrame(input, consumerFrame) {
  if (!Number.isSafeInteger(consumerFrame) || consumerFrame < 0) {
    fail('HOMEOS consumer frame is invalid', 'P1_HOMEOS_CONSUMER_FRAME');
  }
  const frame = validateCausalFrame(input);
  const source = SOURCE_BY_ROUTE.get(frame.route.routeId);
  if (!source) fail('frame is not a HOMEOS METAB input', 'P1_HOMEOS_INPUT_ROUTE');
  if (
    frame.producer.coreId.toUpperCase().replaceAll('-', '_') !== source.producer ||
    frame.producer.mode !== source.producerMode ||
    frame.route.consumerCoreId.toUpperCase().replaceAll('-', '_') !== contract.consumer ||
    frame.topic.name !== source.topic ||
    frame.topic.class !== source.topicClass ||
    frame.topic.schemaId !== source.schemaId ||
    frame.topic.schemaVersion !== '1' ||
    frame.topic.unit !== source.unit ||
    frame.topic.scale !== 'Q16.48'
  ) fail('HOMEOS input identity does not match its frozen source', 'P1_HOMEOS_INPUT_IDENTITY');
  if (frame.quality.status !== 'ACCEPT') fail('HOMEOS cannot consume unresolved METAB evidence', 'P1_HOMEOS_INPUT_UNKNOWN');
  if (consumerFrame < frame.visibleFromFrame || consumerFrame < frame.committedFrame + contract.consumerDelayFrames) {
    fail('HOMEOS cannot consume a same-frame or future METAB summary', 'P1_HOMEOS_INPUT_DELAY');
  }
  validatePayload(source, frame);
  return deepFreeze({ source: source.key, frame });
}

function collectHomeosInputs(inputs, consumerFrame) {
  if (!Array.isArray(inputs) || inputs.length !== contract.sources.length) {
    fail('HOMEOS requires exactly one frame from each METAB source', 'P1_HOMEOS_INPUT_COVERAGE');
  }
  const validated = inputs.map(input => validateHomeosInputFrame(input, consumerFrame));
  const bySource = new Map();
  for (const item of validated) {
    if (bySource.has(item.source)) fail('HOMEOS received duplicate canonical METAB evidence', 'P1_HOMEOS_INPUT_CONFLICT');
    bySource.set(item.source, item.frame);
  }
  if (bySource.size !== contract.sources.length || contract.sources.some(source => !bySource.has(source.key))) {
    fail('HOMEOS source coverage is incomplete', 'P1_HOMEOS_INPUT_COVERAGE');
  }
  const [first, ...rest] = [...bySource.values()];
  for (const frame of rest) {
    for (const field of ['organismId', 'founderLineageId', 'committedFrame']) {
      if (frame[field] !== first[field]) fail('HOMEOS METAB evidence is not frame-coherent', 'P1_HOMEOS_INPUT_COHERENCE');
    }
    for (const field of ['coreId', 'residencyId', 'coreVersion', 'authorityEpoch', 'mode']) {
      if (frame.producer[field] !== first.producer[field]) fail('HOMEOS METAB producer identity is incoherent', 'P1_HOMEOS_INPUT_COHERENCE');
    }
  }
  return deepFreeze({
    consumerFrame,
    producer: clone(first.producer),
    committedFrame: first.committedFrame,
    availability: clone(bySource.get('availability').payload),
    reserve: clone(bySource.get('reserve').payload),
    evidence: contract.sources.map(source => Object.freeze({
      routeId: source.routeId,
      frameId: bySource.get(source.key).frameId,
      producerSequence: bySource.get(source.key).producerSequence
    }))
  });
}

function validateHomeosFounderProfile(input) {
  exact(input, HOMEOS_PROFILE_FIELDS, 'HOMEOS founder profile');
  if (
    input.frameMs !== 250 ||
    input.holdFrames !== 4 ||
    input.numericPolicy !== 'Q16.48-half-even-saturating-v1' ||
    !Number.isSafeInteger(input.adaptationMinimumFrames) ||
    input.adaptationMinimumFrames < 172800
  ) fail('HOMEOS founder policy is invalid', 'P1_HOMEOS_PROFILE');
  for (const field of ['minimumConfidenceQ48', 'adaptationConfidenceQ48', 'maxAdaptationPer24hQ48', 'maxLifetimeAdaptationQ48']) {
    unitInterval(input[field], `HOMEOS ${field}`);
  }
  if (!Array.isArray(input.dimensions) || input.dimensions.length !== contract.sources.length) {
    fail('HOMEOS must have exactly the reviewed METAB dimensions', 'P1_HOMEOS_PROFILE');
  }
  const identities = new Set();
  for (const dimension of input.dimensions) {
    const source = contract.sources.find(candidate => candidate.topic === dimension?.source?.topic);
    if (!source || dimension.source.producerCoreId !== source.producer || dimension.source.schemaId !== source.schemaId || dimension.source.mode !== source.producerMode) {
      fail('HOMEOS dimension source is not canonical METAB evidence', 'P1_HOMEOS_PROFILE_SOURCE');
    }
    if (identities.has(source.key)) fail('HOMEOS has two canonical sources for one dimension', 'P1_HOMEOS_PROFILE_SOURCE');
    identities.add(source.key);
  }
  return deepFreeze(clone(input));
}

module.exports = Object.freeze({
  contract: deepFreeze(clone(contract)),
  validateHomeosInputFrame,
  collectHomeosInputs,
  validateHomeosFounderProfile
});
