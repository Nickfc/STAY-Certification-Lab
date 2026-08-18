'use strict';

/*
 * STAY Biological Fabric
 * ----------------------
 *
 * This module defines the common Kernel-owned signal contract used by
 * biological systems.
 *
 * It intentionally does NOT:
 *   - invent time;
 *   - persist events;
 *   - assign ledger sequence numbers;
 *   - grant authority;
 *   - acknowledge durable delivery.
 *
 * Those responsibilities remain with the trusted Kernel EventFabric,
 * StateStore and residency machinery.
 *
 * SNTSS, instincts, pain, homeostasis and later biological systems consume
 * this contract rather than creating private event planes.
 */

const SIGNAL_PROTOCOL = 'stay-biological-signal-v1';

const DURABILITY = Object.freeze({
  DURABLE: 'durable',
  EPHEMERAL: 'ephemeral'
});

const PRODUCER_TYPES = new Set([
  'kernel',
  'core',
  'organism',
  'operator'
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const TOPIC_PATTERN =
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,31}$/;

const MAX_SIGNAL_BYTES = 64 * 1024;
const MAX_CAUSAL_DEPTH = 1024;
const MAX_AUTHORITY_EPOCH = Number.MAX_SAFE_INTEGER;

function fail(message, code = 'BIOLOGICAL_FABRIC_INVALID_SIGNAL') {
  throw Object.assign(new Error(message), { code });
}

function assertPlainObject(value, label) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label} must be a plain object`);
  }
}

function normalizeJson(value, path = 'payload') {
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;

    case 'number':
      if (!Number.isFinite(value)) {
        fail(`${path} contains a non-finite number`);
      }
      return value;

    case 'object':
      break;

    default:
      fail(`${path} is not JSON-safe`);
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      normalizeJson(entry, `${path}[${index}]`)
    );
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${path} contains a non-plain object`);
  }

  const output = {};

  for (const key of Object.keys(value).sort()) {
    if (!key || key.length > 128) {
      fail(`${path} contains an invalid object key`);
    }

    output[key] = normalizeJson(
      value[key],
      `${path}.${key}`
    );
  }

  return output;
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.isFrozen(value)
  ) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function assertId(value, label, required = true) {
  if (value == null && !required) return null;

  if (
    typeof value !== 'string' ||
    !ID_PATTERN.test(value)
  ) {
    fail(`${label} is invalid`);
  }

  return value;
}

function assertTopic(value) {
  if (
    typeof value !== 'string' ||
    !TOPIC_PATTERN.test(value)
  ) {
    fail('biological topic is invalid');
  }

  return value;
}

function normalizeTrustedTime(value) {
  assertPlainObject(value, 'trustedTime');

  /*
   * Biological code is forbidden from manufacturing its own clock.
   * The Kernel must explicitly provide a trusted timestamp/pulse.
   */
  if (
    value.source !== 'kernel' ||
    !Number.isSafeInteger(value.observedAtMs) ||
    value.observedAtMs < 0
  ) {
    fail(
      'biological signal requires Kernel trusted time',
      'BIOLOGICAL_FABRIC_UNTRUSTED_TIME'
    );
  }

  const result = {
    source: 'kernel',
    observedAtMs: value.observedAtMs
  };

  if (value.pulseId != null) {
    result.pulseId = assertId(
      value.pulseId,
      'trusted time pulseId'
    );
  }

  if (value.monotonicMs != null) {
    if (
      !Number.isSafeInteger(value.monotonicMs) ||
      value.monotonicMs < 0
    ) {
      fail(
        'trusted time monotonicMs is invalid',
        'BIOLOGICAL_FABRIC_UNTRUSTED_TIME'
      );
    }

    result.monotonicMs = value.monotonicMs;
  }

  return result;
}

function normalizeCausality(value, signalId) {
  if (value == null) {
    return {
      parentEventId: null,
      rootEventId: signalId,
      depth: 0
    };
  }

  assertPlainObject(value, 'causality');

  const parentEventId =
    assertId(
      value.parentEventId,
      'causal parentEventId',
      false
    );

  const rootEventId =
    assertId(
      value.rootEventId,
      'causal rootEventId',
      false
    ) || signalId;

  const depth =
    value.depth == null ? 0 : value.depth;

  if (
    !Number.isSafeInteger(depth) ||
    depth < 0 ||
    depth > MAX_CAUSAL_DEPTH
  ) {
    fail(
      'causal depth is invalid',
      'BIOLOGICAL_FABRIC_CAUSALITY'
    );
  }

  if (!parentEventId && depth !== 0) {
    fail(
      'root biological signal cannot have non-zero causal depth',
      'BIOLOGICAL_FABRIC_CAUSALITY'
    );
  }

  if (parentEventId && depth < 1) {
    fail(
      'derived biological signal requires positive causal depth',
      'BIOLOGICAL_FABRIC_CAUSALITY'
    );
  }

  return {
    parentEventId,
    rootEventId,
    depth
  };
}

function normalizeProvenance(value) {
  assertPlainObject(value, 'provenance');

  if (!PRODUCER_TYPES.has(value.producerType)) {
    fail(
      'biological producer type is invalid',
      'BIOLOGICAL_FABRIC_PROVENANCE'
    );
  }

  const producerId =
    assertId(value.producerId, 'producerId');

  const authorityEpoch =
    value.authorityEpoch == null
      ? 0
      : value.authorityEpoch;

  if (
    !Number.isSafeInteger(authorityEpoch) ||
    authorityEpoch < 0 ||
    authorityEpoch > MAX_AUTHORITY_EPOCH
  ) {
    fail(
      'biological authority epoch is invalid',
      'BIOLOGICAL_FABRIC_PROVENANCE'
    );
  }

  return {
    producerType: value.producerType,
    producerId,
    authorityEpoch
  };
}

function normalizeSignal(input) {
  assertPlainObject(input, 'biological signal');

  if (
    input.protocol != null &&
    input.protocol !== SIGNAL_PROTOCOL
  ) {
    fail('biological signal protocol is invalid');
  }

  const signalId =
    assertId(input.signalId, 'signalId');

  const durability =
    input.durability || DURABILITY.DURABLE;

  if (
    durability !== DURABILITY.DURABLE &&
    durability !== DURABILITY.EPHEMERAL
  ) {
    fail('biological durability is invalid');
  }

  const signal = {
    protocol: SIGNAL_PROTOCOL,
    signalId,
    topic: assertTopic(input.topic),
    durability,
    trustedTime: normalizeTrustedTime(
      input.trustedTime
    ),
    causality: normalizeCausality(
      input.causality,
      signalId
    ),
    provenance: normalizeProvenance(
      input.provenance
    ),
    payload: normalizeJson(input.payload)
  };

  const encoded = JSON.stringify(signal);

  if (
    Buffer.byteLength(encoded, 'utf8') >
    MAX_SIGNAL_BYTES
  ) {
    fail(
      `biological signal exceeds ${MAX_SIGNAL_BYTES} byte bound`,
      'BIOLOGICAL_FABRIC_SIGNAL_TOO_LARGE'
    );
  }

  return deepFreeze(signal);
}

function createSignal({
  signalId,
  topic,
  payload,
  trustedTime,
  provenance,
  durability = DURABILITY.DURABLE
}) {
  return normalizeSignal({
    protocol: SIGNAL_PROTOCOL,
    signalId,
    topic,
    payload,
    trustedTime,
    provenance,
    durability,
    causality: null
  });
}

function deriveSignal(parent, {
  signalId,
  topic,
  payload,
  trustedTime,
  provenance,
  durability = DURABILITY.DURABLE
}) {
  const normalizedParent = normalizeSignal(parent);

  return normalizeSignal({
    protocol: SIGNAL_PROTOCOL,
    signalId,
    topic,
    payload,
    trustedTime,
    provenance,
    durability,
    causality: {
      parentEventId: normalizedParent.signalId,
      rootEventId:
        normalizedParent.causality.rootEventId,
      depth:
        normalizedParent.causality.depth + 1
    }
  });
}

/*
 * Kernel bridge.
 *
 * This creates the payload that may be handed to the existing EventFabric.
 * It does not publish or persist anything itself. The EventFabric remains
 * the single sequencing and durable-ledger authority.
 */
function toEventFabricInput(signal) {
  const normalized = normalizeSignal(signal);

  return deepFreeze({
    topic: normalized.topic,
    payload: normalized.payload,
    biological: {
      protocol: normalized.protocol,
      signalId: normalized.signalId,
      durability: normalized.durability,
      trustedTime: normalized.trustedTime,
      causality: normalized.causality,
      provenance: normalized.provenance
    }
  });
}

module.exports = {
  SIGNAL_PROTOCOL,
  DURABILITY,
  MAX_SIGNAL_BYTES,
  createSignal,
  deriveSignal,
  normalizeSignal,
  toEventFabricInput
};
