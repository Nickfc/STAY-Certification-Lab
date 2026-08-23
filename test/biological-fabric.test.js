'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SIGNAL_PROTOCOL,
  DURABILITY,
  createSignal,
  deriveSignal,
  normalizeSignal,
  toEventFabricInput
} = require('../runtime/kernel/biological-fabric');

function trustedTime(ms = 1000) {
  return {
    source: 'kernel',
    observedAtMs: ms,
    monotonicMs: ms,
    pulseId: `pulse-${ms}`
  };
}

function provenance(epoch = 4) {
  return {
    producerType: 'core',
    producerId: 'sntss',
    authorityEpoch: epoch
  };
}

test('F0.1 biological signal is canonical and immutable', () => {
  const signal = createSignal({
    signalId: 'bio-0001',
    topic: 'physiology.stimulus',
    payload: {
      z: 2,
      a: 1
    },
    trustedTime: trustedTime(),
    provenance: provenance()
  });

  assert.equal(signal.protocol, SIGNAL_PROTOCOL);
  assert.equal(signal.durability, DURABILITY.DURABLE);
  assert.deepEqual(Object.keys(signal.payload), ['a', 'z']);

  assert.equal(Object.isFrozen(signal), true);
  assert.equal(Object.isFrozen(signal.payload), true);
  assert.equal(Object.isFrozen(signal.trustedTime), true);
  assert.equal(Object.isFrozen(signal.provenance), true);
});

test('F0.1 biological systems cannot invent wall-clock time', () => {
  assert.throws(
    () => createSignal({
      signalId: 'bio-0002',
      topic: 'physiology.stimulus',
      payload: {},
      trustedTime: {
        source: 'core',
        observedAtMs: Date.now()
      },
      provenance: provenance()
    }),
    error =>
      error.code ===
      'BIOLOGICAL_FABRIC_UNTRUSTED_TIME'
  );

  assert.throws(
    () => createSignal({
      signalId: 'bio-0003',
      topic: 'physiology.stimulus',
      payload: {},
      provenance: provenance()
    }),
    /trustedTime/
  );
});

test('F0.1 derived signals preserve causal root and increase depth', () => {
  const root = createSignal({
    signalId: 'bio-root',
    topic: 'sensory.input',
    payload: { intensity: 0.4 },
    trustedTime: trustedTime(2000),
    provenance: {
      producerType: 'organism',
      producerId: 'fetus',
      authorityEpoch: 1
    }
  });

  const child = deriveSignal(root, {
    signalId: 'bio-child',
    topic: 'physiology.modulation',
    payload: { family: 'dopamine-like' },
    trustedTime: trustedTime(2001),
    provenance: provenance(7)
  });

  assert.equal(
    child.causality.parentEventId,
    'bio-root'
  );

  assert.equal(
    child.causality.rootEventId,
    'bio-root'
  );

  assert.equal(child.causality.depth, 1);
});

test('F0.1 EventFabric bridge preserves biological provenance', () => {
  const signal = createSignal({
    signalId: 'bio-bridge',
    topic: 'physiology.stimulus',
    payload: { value: 7 },
    trustedTime: trustedTime(),
    provenance: provenance(9)
  });

  const event = toEventFabricInput(signal);

  assert.equal(
    event.biological.protocol,
    SIGNAL_PROTOCOL
  );

  assert.equal(
    event.biological.signalId,
    'bio-bridge'
  );

  assert.equal(
    event.biological.provenance.authorityEpoch,
    9
  );

  assert.deepEqual(
    event.payload,
    { value: 7 }
  );
});

test('F0.1 signal payload must remain deterministic JSON', () => {
  assert.throws(
    () => createSignal({
      signalId: 'bio-bad-json',
      topic: 'physiology.stimulus',
      payload: {
        value: Number.NaN
      },
      trustedTime: trustedTime(),
      provenance: provenance()
    }),
    /non-finite/
  );

  assert.throws(
    () => createSignal({
      signalId: 'bio-bad-function',
      topic: 'physiology.stimulus',
      payload: {
        fn() {}
      },
      trustedTime: trustedTime(),
      provenance: provenance()
    }),
    /JSON-safe/
  );
});

test('F0.1 producer authority provenance is mandatory', () => {
  assert.throws(
    () => createSignal({
      signalId: 'bio-no-provenance',
      topic: 'physiology.stimulus',
      payload: {},
      trustedTime: trustedTime(),
      provenance: {
        producerType: 'unknown',
        producerId: 'thing',
        authorityEpoch: 1
      }
    }),
    error =>
      error.code ===
      'BIOLOGICAL_FABRIC_PROVENANCE'
  );
});

test('F0.1 malformed causal chains fail closed', () => {
  assert.throws(
    () => normalizeSignal({
      signalId: 'bio-causal-bad',
      topic: 'physiology.stimulus',
      payload: {},
      trustedTime: trustedTime(),
      provenance: provenance(),
      causality: {
        parentEventId: null,
        rootEventId: 'bio-causal-bad',
        depth: 1
      }
    }),
    error =>
      error.code ===
      'BIOLOGICAL_FABRIC_CAUSALITY'
  );
});

test('F0.1 ephemeral signals are explicit rather than inferred', () => {
  const signal = createSignal({
    signalId: 'bio-ephemeral',
    topic: 'physiology.telemetry',
    payload: {},
    trustedTime: trustedTime(),
    provenance: provenance(),
    durability: DURABILITY.EPHEMERAL
  });

  assert.equal(
    signal.durability,
    DURABILITY.EPHEMERAL
  );
});
