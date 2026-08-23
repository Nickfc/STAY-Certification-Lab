'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { EventFabric } =
  require('../runtime/kernel/event-fabric');

const {
  DURABILITY,
  createSignal
} = require('../runtime/kernel/biological-fabric');

function trustedTime(ms = 5000) {
  return {
    source: 'kernel',
    observedAtMs: ms,
    monotonicMs: ms,
    pulseId: `pulse-${ms}`
  };
}

function provenance(epoch = 3) {
  return {
    producerType: 'core',
    producerId: 'sntss',
    authorityEpoch: epoch
  };
}

function durableLedgerHarness() {
  const rows = new Map();
  const calls = [];

  return {
    calls,

    async append(input) {
      calls.push(input);

      const key = input.meta.deduplicationKey;

      if (rows.has(key)) {
        return {
          event: rows.get(key),
          deduplicated: true
        };
      }

      const sequence = rows.size + 1;

      const event = Object.freeze({
        id: sequence,
        sequence,
        topic: input.topic,
        class: input.eventClass,
        payload: input.payload,
        at: input.at,
        deadlineAt: input.deadlineAt,
        meta: Object.freeze({
          ...input.meta,
          eventClass: input.eventClass
        }),
        ledger: Object.freeze({
          durable: true
        })
      });

      rows.set(key, event);

      return {
        event,
        deduplicated: false
      };
    }
  };
}

test(
  'F0.2 durable biological signal enters the existing durable EventFabric path',
  async () => {
    const ledger = durableLedgerHarness();

    const fabric = new EventFabric({
      clock: () => 6000,
      durableAppender:
        input => ledger.append(input)
    });

    const signal = createSignal({
      signalId: 'bio-f02-durable',
      topic: 'physiology.stimulus',
      payload: {
        intensity: 0.75
      },
      trustedTime: trustedTime(5999),
      provenance: provenance(8)
    });

    const event =
      await fabric.publishBiologicalSignal(signal);

    assert.equal(ledger.calls.length, 1);
    assert.equal(
      ledger.calls[0].eventClass,
      'durable'
    );

    assert.equal(
      ledger.calls[0].meta.deduplicationKey,
      'bio-f02-durable'
    );

    assert.equal(
      event.meta.biological.signalId,
      'bio-f02-durable'
    );

    assert.equal(
      event.meta.biological.provenance.authorityEpoch,
      8
    );

    assert.equal(event.ledger.durable, true);
  }
);

test(
  'F0.2 repeated durable biological identity deduplicates at the ledger boundary',
  async () => {
    const ledger = durableLedgerHarness();

    const fabric = new EventFabric({
      clock: () => 7000,
      durableAppender:
        input => ledger.append(input)
    });

    const signal = createSignal({
      signalId: 'bio-f02-once',
      topic: 'physiology.stimulus',
      payload: {
        value: 1
      },
      trustedTime: trustedTime(6999),
      provenance: provenance()
    });

    const first =
      await fabric.publishBiologicalSignal(signal);

    const second =
      await fabric.publishBiologicalSignal(signal);

    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 1);

    assert.equal(
      fabric.status().durablyAppended,
      1
    );

    assert.equal(
      fabric.status().deduplicated,
      1
    );
  }
);

test(
  'F0.2 biological metadata survives EventFabric delivery intact',
  async () => {
    const ledger = durableLedgerHarness();

    const fabric = new EventFabric({
      clock: () => 8000,
      durableAppender:
        input => ledger.append(input)
    });

    let delivered = null;

    fabric.subscribeAll(event => {
      delivered = event;
    });

    const signal = createSignal({
      signalId: 'bio-f02-delivery',
      topic: 'homeostasis.input',
      payload: {
        pressure: 4
      },
      trustedTime: trustedTime(7999),
      provenance: {
        producerType: 'organism',
        producerId: 'fetus',
        authorityEpoch: 1
      }
    });

    await fabric.publishBiologicalSignal(signal);

    assert.ok(delivered);

    assert.equal(
      delivered.meta.biological.protocol,
      'stay-biological-signal-v1'
    );

    assert.equal(
      delivered.meta.biological.causality.rootEventId,
      'bio-f02-delivery'
    );

    assert.equal(
      delivered.meta.biological.trustedTime.source,
      'kernel'
    );
  }
);

test(
  'F0.2 malformed biological signal fails before durable append',
  async () => {
    const ledger = durableLedgerHarness();

    const fabric = new EventFabric({
      clock: () => 9000,
      durableAppender:
        input => ledger.append(input)
    });

    await assert.rejects(
      fabric.publishBiologicalSignal({
        signalId: 'bio-f02-bad-time',
        topic: 'physiology.stimulus',
        durability: DURABILITY.DURABLE,
        payload: {},
        trustedTime: {
          source: 'core',
          observedAtMs: 9000
        },
        provenance: provenance()
      }),
      error =>
        error.code ===
        'BIOLOGICAL_FABRIC_UNTRUSTED_TIME'
    );

    assert.equal(ledger.calls.length, 0);
  }
);

test(
  'F0.2 ephemeral biological signal bypasses durable ledger but keeps provenance',
  async () => {
    let durableCalls = 0;

    const fabric = new EventFabric({
      clock: () => 10000,
      durableAppender: async () => {
        durableCalls += 1;
        throw new Error(
          'ephemeral signal reached durable ledger'
        );
      }
    });

    const signal = createSignal({
      signalId: 'bio-f02-ephemeral',
      topic: 'physiology.telemetry',
      payload: {
        value: 12
      },
      trustedTime: trustedTime(9999),
      provenance: provenance(),
      durability: DURABILITY.EPHEMERAL
    });

    const event =
      await fabric.publishBiologicalSignal(signal);

    assert.equal(durableCalls, 0);

    assert.equal(
      event.class,
      'best-effort'
    );

    assert.equal(
      event.meta.eventClass,
      'best-effort'
    );

    assert.equal(
      event.meta.biological.durability,
      DURABILITY.EPHEMERAL
    );

    assert.equal(
      event.meta.biological.signalId,
      'bio-f02-ephemeral'
    );
  }
);

test(
  'F0.2 ordinary EventFabric publishing remains backward compatible',
  async () => {
    const fabric = new EventFabric({
      clock: () => 11000
    });

    const event = await fabric.publish(
      'legacy.event',
      {
        untouched: true
      }
    );

    assert.equal(
      event.payload.untouched,
      true
    );

    assert.equal(
      event.meta.biological,
      undefined
    );

    assert.equal(event.sequence, 1);
  }
);
