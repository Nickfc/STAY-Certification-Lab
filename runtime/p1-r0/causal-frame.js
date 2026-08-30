'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../kernel/canonical-json');
const {
  SIGNAL_CLASS,
  DURABILITY_CLASS,
  TEMPORAL_TYPE,
  MAX_PAYLOAD_BYTES,
  MAX_DIRECT_PARENTS,
  MAX_CAUSAL_SOURCE_SPANS
} = require('../kernel/biological-envelope');
const q48 = require('./q16-48');
const { validateFrameRoute } = require('./contract-registry');

const FRAME_PROTOCOL = 'stay-p1-r0-causal-frame-v1';
const FRAME_US = 250_000;
const HASH = /^sha256:[0-9a-f]{64}$/;
const UNSIGNED_TEXT = /^(0|[1-9][0-9]*)$/;
const MODE = new Set(['NEUTRAL', 'SHADOW', 'LIVE']);
const QUALITY = new Set(['ACCEPT', 'HOLD', 'UNKNOWN', 'QUARANTINE']);
const TOPIC_CLASS = Object.freeze({
  SUMMARY: SIGNAL_CLASS.STATE_SUMMARY,
  INTEGRITY: SIGNAL_CLASS.INTEGRATED_EVIDENCE,
  DEMAND: SIGNAL_CLASS.RAW_AFFERENT,
  MODULATION: SIGNAL_CLASS.REGULATORY_EFFERENT,
  FACT: SIGNAL_CLASS.BIOLOGICAL_TRANSITION,
  CONTEXT: SIGNAL_CLASS.CHRONOBIOLOGICAL_CONTEXT,
  OBSERVATION: SIGNAL_CLASS.INTEGRATED_EVIDENCE
});

const FRAME_FIELDS = new Set([
  'frameVersion', 'frameId', 'organismId', 'founderLineageId', 'producer',
  'route', 'topic', 'producerSequence', 'committedFrame', 'visibleFromFrame',
  'sourceWindow', 'causalSpan', 'quality', 'expiresAtFrame', 'payload', 'payloadHash'
]);

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`, 'P1_FRAME_SCHEMA');
  }
  return value;
}

function exact(value, fields, label) {
  object(value, label);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some(key => !fields.has(key))) {
    fail(`${label} fields are not exact`, 'P1_FRAME_SCHEMA');
  }
}

function text(value, label, maximum = 160) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximum) {
    fail(`${label} is invalid`, 'P1_FRAME_SCHEMA');
  }
  return value;
}

function frameIndex(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid`, 'P1_FRAME_SCHEMA');
  return value;
}

function unsignedText(value, label) {
  if (typeof value !== 'string' || !UNSIGNED_TEXT.test(value)) {
    fail(`${label} is invalid`, 'P1_FRAME_SCHEMA');
  }
  return BigInt(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
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

function validateWindow(value, label) {
  exact(value, new Set(['startFrame', 'endFrame']), label);
  const startFrame = frameIndex(value.startFrame, `${label}.startFrame`);
  const endFrame = frameIndex(value.endFrame, `${label}.endFrame`);
  if (endFrame < startFrame) fail(`${label} ends before it starts`, 'P1_FRAME_WINDOW');
  return { startFrame, endFrame };
}

function validateAncestor(value) {
  const fields = new Set([
    'producerCoreId', 'residencyId', 'topic', 'routeId', 'producerSequence',
    'sourceWindow', 'mode', 'shadowAncestry', 'confidenceQ48'
  ]);
  exact(value, fields, 'causal ancestor');
  text(value.producerCoreId, 'ancestor producer core id');
  text(value.residencyId, 'ancestor residency id');
  text(value.topic, 'ancestor topic');
  text(value.routeId, 'ancestor route id');
  unsignedText(value.producerSequence, 'ancestor producer sequence');
  validateWindow(value.sourceWindow, 'ancestor source window');
  if (!MODE.has(value.mode)) fail('ancestor mode is invalid', 'P1_FRAME_SCHEMA');
  if (typeof value.shadowAncestry !== 'boolean') fail('ancestor shadow ancestry is invalid', 'P1_FRAME_SCHEMA');
  const confidence = q48.parseRaw(value.confidenceQ48);
  if (confidence < 0n || confidence > q48.SCALE) fail('ancestor confidence is outside 0..1', 'P1_FRAME_QUALITY');
}

function validateCausalFrame(input) {
  exact(input, FRAME_FIELDS, 'P1 causal frame');
  if (input.frameVersion !== FRAME_PROTOCOL) fail('P1 frame protocol is invalid', 'P1_FRAME_PROTOCOL');
  if (!HASH.test(input.frameId)) fail('P1 frame id is invalid', 'P1_FRAME_SCHEMA');
  text(input.organismId, 'organism id');
  text(input.founderLineageId, 'founder lineage id');

  exact(input.producer, new Set(['coreId', 'residencyId', 'coreVersion', 'authorityEpoch', 'mode', 'lifecycle']), 'producer');
  text(input.producer.coreId, 'producer core id');
  text(input.producer.residencyId, 'producer residency id');
  text(input.producer.coreVersion, 'producer version');
  unsignedText(input.producer.authorityEpoch, 'producer authority epoch');
  if (!MODE.has(input.producer.mode)) fail('producer mode is invalid', 'P1_FRAME_SCHEMA');
  text(input.producer.lifecycle, 'producer lifecycle');

  exact(input.route, new Set(['routeId', 'consumerCoreId', 'routeVersion']), 'route');
  text(input.route.routeId, 'route id');
  text(input.route.consumerCoreId, 'consumer core id');
  text(input.route.routeVersion, 'route version');

  exact(input.topic, new Set(['name', 'class', 'schemaId', 'schemaVersion', 'unit', 'scale']), 'topic');
  text(input.topic.name, 'topic name', 96);
  if (!Object.hasOwn(TOPIC_CLASS, input.topic.class)) fail('topic class has no Envelope v2 mapping', 'P1_FRAME_TOPIC_CLASS');
  text(input.topic.schemaId, 'topic schema id');
  unsignedText(input.topic.schemaVersion, 'topic schema version');
  text(input.topic.unit, 'topic unit');
  if (input.topic.scale !== 'Q16.48') fail('topic scale is invalid', 'P1_FRAME_SCHEMA');
  unsignedText(input.producerSequence, 'producer sequence');

  const committedFrame = frameIndex(input.committedFrame, 'committed frame');
  const visibleFromFrame = frameIndex(input.visibleFromFrame, 'visible-from frame');
  if (visibleFromFrame < committedFrame + 1) {
    fail('P1 output cannot be consumed in its commit frame', 'P1_FRAME_SAME_FRAME');
  }
  const sourceWindow = validateWindow(input.sourceWindow, 'source window');
  if (sourceWindow.endFrame > committedFrame) {
    fail('P1 source window reaches into an uncommitted future frame', 'P1_FRAME_FUTURE_SOURCE');
  }

  exact(input.causalSpan, new Set(['earliestFrame', 'latestFrame', 'containsNeutral', 'containsShadow', 'ancestors']), 'causal span');
  const earliestFrame = frameIndex(input.causalSpan.earliestFrame, 'causal earliest frame');
  const latestFrame = frameIndex(input.causalSpan.latestFrame, 'causal latest frame');
  if (latestFrame < earliestFrame || latestFrame > committedFrame) {
    fail('causal span is temporally invalid', 'P1_FRAME_CAUSAL_SPAN');
  }
  if (typeof input.causalSpan.containsNeutral !== 'boolean' || typeof input.causalSpan.containsShadow !== 'boolean') {
    fail('causal authority flags are invalid', 'P1_FRAME_SCHEMA');
  }
  if (sourceWindow.startFrame < earliestFrame || sourceWindow.endFrame > latestFrame) {
    fail('source window is outside its declared causal span', 'P1_FRAME_CAUSAL_SPAN');
  }
  if (!Array.isArray(input.causalSpan.ancestors) || input.causalSpan.ancestors.length > 32) {
    fail('causal ancestor set is invalid', 'P1_FRAME_CAUSAL_SPAN');
  }
  const ancestorKeys = new Set();
  for (const ancestor of input.causalSpan.ancestors) {
    validateAncestor(ancestor);
    if (
      ancestor.sourceWindow.startFrame < earliestFrame ||
      ancestor.sourceWindow.endFrame > latestFrame ||
      ancestor.sourceWindow.endFrame > committedFrame
    ) fail('ancestor window is outside its declared causal span', 'P1_FRAME_CAUSAL_SPAN');
    if (ancestor.mode === 'NEUTRAL' && !input.causalSpan.containsNeutral) {
      fail('neutral ancestry was omitted from the causal flags', 'P1_FRAME_AUTHORITY_LAUNDERING');
    }
    if ((ancestor.mode === 'SHADOW' || ancestor.shadowAncestry) && !input.causalSpan.containsShadow) {
      fail('shadow ancestry was omitted from the causal flags', 'P1_FRAME_AUTHORITY_LAUNDERING');
    }
    const key = stableStringify([
      ancestor.producerCoreId,
      ancestor.residencyId,
      ancestor.topic,
      ancestor.routeId,
      ancestor.producerSequence
    ]);
    if (ancestorKeys.has(key)) fail('causal ancestor is duplicated', 'P1_FRAME_CAUSAL_SPAN');
    ancestorKeys.add(key);
  }
  if (input.producer.mode === 'LIVE' && (input.causalSpan.containsNeutral || input.causalSpan.containsShadow || input.causalSpan.ancestors.some(value => value.mode !== 'LIVE' || value.shadowAncestry))) {
    fail('non-authoritative ancestry cannot become LIVE', 'P1_FRAME_AUTHORITY_LAUNDERING');
  }

  exact(input.quality, new Set(['status', 'confidenceQ48', 'coverageQ48', 'reasons']), 'quality');
  if (!QUALITY.has(input.quality.status)) fail('quality status is invalid', 'P1_FRAME_QUALITY');
  for (const field of ['confidenceQ48', 'coverageQ48']) {
    const value = q48.parseRaw(input.quality[field]);
    if (value < 0n || value > q48.SCALE) fail(`${field} is outside 0..1`, 'P1_FRAME_QUALITY');
  }
  if (!Array.isArray(input.quality.reasons) || input.quality.reasons.length > 32) fail('quality reasons are invalid', 'P1_FRAME_QUALITY');
  for (const reason of input.quality.reasons) text(reason, 'quality reason', 128);

  if (input.expiresAtFrame !== null) {
    const expiresAtFrame = frameIndex(input.expiresAtFrame, 'expiry frame');
    if (expiresAtFrame < visibleFromFrame) fail('frame expires before it becomes visible', 'P1_FRAME_EXPIRY');
  }
  object(input.payload, 'payload');
  if (!HASH.test(input.payloadHash) || input.payloadHash !== sha256(input.payload)) {
    fail('P1 frame payload hash is invalid', 'P1_FRAME_PAYLOAD_HASH');
  }
  validateFrameRoute(input);
  return deepFreeze(clone(input));
}

function safeFrameUs(value, label) {
  const result = value * FRAME_US;
  if (!Number.isSafeInteger(result)) fail(`${label} exceeds trusted-time range`, 'P1_FRAME_TIME_RANGE');
  return result;
}

function toEnvelopeProposal(input, options = {}) {
  const frame = validateCausalFrame(input);
  const { directParents, causalSourceSpans, producerBinding } = options;
  if (frame.quality.status !== 'ACCEPT') {
    fail('only accepted P1 quality may become a biological proposal', 'P1_FRAME_NOT_ACCEPTED');
  }
  exact(producerBinding, new Set([
    'organismId', 'founderLineageId', 'coreId', 'residencyId',
    'coreVersion', 'authorityEpoch', 'mode'
  ]), 'Kernel producer binding');
  const expectedBinding = {
    organismId: frame.organismId,
    founderLineageId: frame.founderLineageId,
    coreId: frame.producer.coreId,
    residencyId: frame.producer.residencyId,
    coreVersion: frame.producer.coreVersion,
    authorityEpoch: frame.producer.authorityEpoch,
    mode: frame.producer.mode
  };
  if (Object.keys(expectedBinding).some(field => producerBinding[field] !== expectedBinding[field])) {
    fail('producer-authored frame identity disagrees with Kernel binding', 'P1_FRAME_PRODUCER_BINDING');
  }
  if (
    !Array.isArray(directParents) ||
    !Array.isArray(causalSourceSpans) ||
    directParents.length > MAX_DIRECT_PARENTS ||
    causalSourceSpans.length > MAX_CAUSAL_SOURCE_SPANS
  ) {
    fail('resolved Envelope v2 ancestry is required', 'P1_FRAME_ANCESTRY_REQUIRED');
  }
  if (
    (frame.causalSpan.ancestors.length > 0 || frame.causalSpan.containsNeutral || frame.causalSpan.containsShadow) &&
    directParents.length === 0 &&
    causalSourceSpans.length === 0
  ) {
    fail('claimed P1 ancestry lacks Kernel-resolved Envelope v2 evidence', 'P1_FRAME_ANCESTRY_REQUIRED');
  }
  const sequence = BigInt(frame.producerSequence);
  const schemaVersion = BigInt(frame.topic.schemaVersion);
  if (sequence < 1n || sequence > BigInt(Number.MAX_SAFE_INTEGER) || schemaVersion < 1n || schemaVersion > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('P1 sequence or schema version exceeds Envelope v2 range', 'P1_FRAME_ENVELOPE_RANGE');
  }
  const payload = {
    schema: 'stay-p1-r0-frame-payload/v1',
    p1Frame: frame
  };
  if (Buffer.byteLength(stableStringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) {
    fail('P1 frame exceeds the frozen Envelope v2 payload ceiling', 'P1_FRAME_PAYLOAD_LIMIT');
  }
  const producerStreamId = `p1r0:${frame.producer.coreId}:${frame.topic.name}`;
  if (Buffer.byteLength(producerStreamId, 'utf8') > 96) {
    fail('P1 producer stream id exceeds Envelope v2 range', 'P1_FRAME_ENVELOPE_RANGE');
  }
  const proposal = {
    producer_event_id: sha256(frame),
    producer_stream_id: producerStreamId,
    stream_sequence: Number(sequence),
    topic: frame.topic.name,
    signal_class: TOPIC_CLASS[frame.topic.class],
    schema_version: Number(schemaVersion),
    temporal: {
      type: TEMPORAL_TYPE.STATE_AS_OF,
      at_us: safeFrameUs(frame.committedFrame, 'committed frame')
    },
    valid_from_us: safeFrameUs(frame.visibleFromFrame, 'visible-from frame'),
    expires_at_us: frame.expiresAtFrame === null ? null : safeFrameUs(frame.expiresAtFrame, 'expiry frame'),
    durability_class: frame.topic.class === 'FACT'
      ? DURABILITY_CLASS.DURABLE_TRANSITION
      : DURABILITY_CLASS.CHECKPOINT_CRITICAL,
    payload,
    direct_parents: clone(directParents),
    causal_source_spans: clone(causalSourceSpans)
  };
  return deepFreeze(proposal);
}

module.exports = Object.freeze({
  FRAME_PROTOCOL,
  FRAME_US,
  TOPIC_CLASS,
  validateCausalFrame,
  toEnvelopeProposal
});
