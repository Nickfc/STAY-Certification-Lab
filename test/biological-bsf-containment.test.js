'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  acceptEnvelope,
  AUTHORITY_MODE,
  SIGNAL_CLASS,
  DURABILITY_CLASS,
  TEMPORAL_TYPE,
  MAX_PAYLOAD_BYTES
} = require('../runtime/kernel/biological-envelope');

const {
  BSF_PROTOCOL,
  EVIDENCE_ROLE,
  REQUIRED_ORDERING,
  DELIVERY_STATUS,
  normalizeBiologyManifest,
  BiologicalSignallingFabric
} = require('../runtime/kernel/biological-signalling-fabric');

const { validateManifest } = require('../runtime/kernel/manifest');


function producerCapability({
  maxRate = { events: 2, intervalUs: 1_000_000 },
  maxPayloadBytes = 1024,
  modes = [AUTHORITY_MODE.AUTHORITATIVE]
} = {}) {
  return {
    id: 'pulse-beats',
    topic: 'cardiac.beat.raw',
    signalClass: SIGNAL_CLASS.RAW_AFFERENT,
    schemaVersions: [1],
    producerStreamIds: ['pulse:beats'],
    maxRate,
    maxPayloadBytes,
    maxValidityUs: null,
    allowedAuthorityModes: modes
  };
}


function consumerLease({
  lagBudgetUs = 100_000_000,
  durability = DURABILITY_CLASS.EPHEMERAL_REPLAYABLE,
  evidenceRole = EVIDENCE_ROLE.PRIMARY_PHYSIOLOGICAL_INPUT
} = {}) {
  return {
    id: 'pulse-to-interoception',
    consumerCoreId: 'interoception',
    acceptedProducerCoreIds: ['pulse'],
    producerStreamIds: ['pulse:beats'],
    topic: 'cardiac.beat.raw',
    signalClass: SIGNAL_CLASS.RAW_AFFERENT,
    schemaVersions: [1],
    requiredDurability: durability,
    requiredOrdering: REQUIRED_ORDERING.CANONICAL,
    evidenceRole,
    lagBudgetUs,
    activeAuthorityEpochRange: { minimum: 1, maximum: 10 },
    required: true
  };
}


function coreManifest(coreId, {
  producerCapabilities = [],
  consumerRouteLeases = []
} = {}) {
  return validateManifest({
    coreId,
    version: '1.0.0',
    protocol: 'stay-core-v1',
    stateSchema: 1,
    inputs: [],
    outputs: [],
    hotSwap: true,
    biology: {
      protocol: BSF_PROTOCOL,
      producerCapabilities,
      consumerRouteLeases
    }
  });
}


function bsfHarness({
  maxRate,
  maxPayloadBytes,
  lagBudgetUs,
  stateStore = null,
  observerCapacity = 8,
  modes
} = {}) {
  const bsf = new BiologicalSignallingFabric({ stateStore, observerCapacity });
  bsf.installManifest(coreManifest('pulse', {
    producerCapabilities: [producerCapability({ maxRate, maxPayloadBytes, modes })]
  }));
  bsf.installManifest(coreManifest('interoception', {
    consumerRouteLeases: [consumerLease({ lagBudgetUs })]
  }));
  return bsf;
}


function proposal({
  eventChar = 'a',
  sequence = 1,
  payload = { pacemaker_cycle_id: 1 }
} = {}) {
  return {
    producer_event_id: 'sha256:' + eventChar.repeat(64),
    producer_stream_id: 'pulse:beats',
    stream_sequence: sequence,
    topic: 'cardiac.beat.raw',
    signal_class: SIGNAL_CLASS.RAW_AFFERENT,
    schema_version: 1,
    temporal: { type: TEMPORAL_TYPE.INSTANT, at_us: 1_000_000 + sequence },
    valid_from_us: null,
    expires_at_us: null,
    durability_class: DURABILITY_CLASS.EPHEMERAL_REPLAYABLE,
    payload,
    direct_parents: [],
    causal_source_spans: []
  };
}


function accepted({
  eventChar = 'a',
  sequence = 1,
  acceptedTimeUs = 1_000_100,
  mode = AUTHORITY_MODE.AUTHORITATIVE,
  durability = DURABILITY_CLASS.EPHEMERAL_REPLAYABLE
} = {}) {
  const p = proposal({ eventChar, sequence });
  p.durability_class = durability;
  return acceptEnvelope(p, {
    organism_id: 'stay-bsf-containment',
    producer_core_id: 'pulse',
    producer_instance_id: 'pulse-1',
    producer_version: '1.0.0',
    authority_epoch: 4,
    authority_mode: mode,
    accepted_time_us: acceptedTimeUs,
    fabric_sequence: 100 + sequence,
    causal_roots: [],
    causal_generation: 0,
    roots_overflow_digest: null,
    lineage_digest: null,
    ancestor_core_set: [],
    causality_validated: false,
    max_causal_order_time_us: 0
  });
}


function flushMicrotasks() {
  return new Promise(resolve => setImmediate(resolve));
}


test('P0-B2 capability declaration cannot exceed the universal 8 KiB biological payload ceiling', () => {
  assert.throws(
    () => normalizeBiologyManifest({
      protocol: BSF_PROTOCOL,
      producerCapabilities: [producerCapability({ maxPayloadBytes: MAX_PAYLOAD_BYTES + 1 })],
      consumerRouteLeases: []
    }, 'pulse'),
    error => error?.code === 'BIOLOGICAL_BSF_MANIFEST'
  );
});


test('P0-B2 oversize payload is rejected at BSF policy before biological routing', () => {
  const bsf = bsfHarness({ maxPayloadBytes: 64 });
  assert.throws(
    () => bsf.validateProposal({
      producer: { coreId: 'pulse', authorityMode: AUTHORITY_MODE.AUTHORITATIVE },
      proposal: proposal({ payload: { data: 'x'.repeat(100) } })
    }),
    error => error?.code === 'BIOLOGICAL_BSF_PAYLOAD'
  );
  assert.equal(bsf.telemetry().deliveriesEvaluated, 0);
});


test('P0-B2 producer rate flood is bounded by manifested fixed-window admission without growing a transport queue', () => {
  const bsf = bsfHarness({ maxRate: { events: 2, intervalUs: 1_000_000 } });
  const first = bsf.evaluateDelivery({ consumerCoreId: 'interoception', envelope: accepted({ eventChar: '1', sequence: 1 }), nowUs: 1_100_000 });
  const second = bsf.evaluateDelivery({ consumerCoreId: 'interoception', envelope: accepted({ eventChar: '2', sequence: 2 }), nowUs: 1_100_000 });
  const third = bsf.evaluateDelivery({ consumerCoreId: 'interoception', envelope: accepted({ eventChar: '3', sequence: 3 }), nowUs: 1_100_000 });
  assert.equal(first.status, DELIVERY_STATUS.DELIVER);
  assert.equal(second.status, DELIVERY_STATUS.DELIVER);
  assert.equal(third.status, DELIVERY_STATUS.RATE_LIMITED);
  assert.equal(bsf.telemetry().rateBucketCount, 1);
  assert.equal(bsf.telemetry().rateLimited, 1);
  assert.equal(Object.hasOwn(bsf, 'deliveryQueue'), false);
});


test('P0-B2 redelivery of the same accepted signal does not consume producer rate budget twice', () => {
  const bsf = bsfHarness({ maxRate: { events: 1, intervalUs: 1_000_000 } });
  const same = accepted({ eventChar: '4', sequence: 4 });
  assert.equal(bsf.evaluateDelivery({ consumerCoreId: 'interoception', envelope: same, nowUs: 1_200_000 }).status, DELIVERY_STATUS.DELIVER);
  assert.equal(bsf.evaluateDelivery({ consumerCoreId: 'interoception', envelope: same, nowUs: 1_200_000 }).status, DELIVERY_STATUS.DELIVER);
  const different = accepted({ eventChar: '5', sequence: 5 });
  assert.equal(bsf.evaluateDelivery({ consumerCoreId: 'interoception', envelope: different, nowUs: 1_200_000 }).status, DELIVERY_STATUS.RATE_LIMITED);
});


test('P0-B2 non-authoritative traffic cannot consume the authoritative producer rate budget', () => {
  const bsf = bsfHarness({
    maxRate: { events: 1, intervalUs: 1_000_000 },
    modes: [AUTHORITY_MODE.SHADOW, AUTHORITY_MODE.AUTHORITATIVE]
  });
  const shadow = accepted({ eventChar: '0', sequence: 20, mode: AUTHORITY_MODE.SHADOW });
  const live = accepted({ eventChar: 'f', sequence: 21, mode: AUTHORITY_MODE.AUTHORITATIVE });
  assert.equal(bsf.evaluateDelivery({ consumerCoreId: 'interoception', envelope: shadow, nowUs: 1_200_000 }).status, DELIVERY_STATUS.DELIVER);
  assert.equal(bsf.evaluateDelivery({ consumerCoreId: 'interoception', envelope: live, nowUs: 1_200_000 }).status, DELIVERY_STATUS.DELIVER);
  assert.equal(bsf.telemetry().rateBucketCount, 2);
});


test('P0-B2 rate-window rollover replaces bounded state rather than accumulating historical event identities forever', () => {
  const bsf = bsfHarness({ maxRate: { events: 2, intervalUs: 100 } });
  bsf.evaluateDelivery({ consumerCoreId: 'interoception', envelope: accepted({ eventChar: '6', sequence: 6 }), nowUs: 100 });
  bsf.evaluateDelivery({ consumerCoreId: 'interoception', envelope: accepted({ eventChar: '7', sequence: 7 }), nowUs: 250 });
  bsf.evaluateDelivery({ consumerCoreId: 'interoception', envelope: accepted({ eventChar: '8', sequence: 8 }), nowUs: 450 });
  assert.equal(bsf.rateBuckets.size, 1);
  assert.equal([...bsf.rateBuckets.values()][0].signalIds.size, 1);
});


test('P0-B2 observer queue is explicitly bounded and drops excess observer-plane records instead of blocking physiology', () => {
  const bsf = new BiologicalSignallingFabric({ observerCapacity: 2 });
  assert.equal(bsf.enqueueObserver({ type: 'one' }), true);
  assert.equal(bsf.enqueueObserver({ type: 'two' }), true);
  assert.equal(bsf.enqueueObserver({ type: 'three' }), false);
  assert.equal(bsf.observerQueue.length, 2);
  assert.equal(bsf.telemetry().observerDropped, 1);
});


test('P0-B2 throwing observer cannot reject or alter a biological route decision', async () => {
  const bsf = bsfHarness();
  bsf.subscribeObserver(() => { throw new Error('observer boom'); });
  const decision = bsf.evaluateDelivery({ consumerCoreId: 'interoception', envelope: accepted({ eventChar: '9', sequence: 9 }), nowUs: 1_100_000 });
  assert.equal(decision.status, DELIVERY_STATUS.DELIVER);
  await flushMicrotasks();
  assert.ok(bsf.telemetry().observerErrors >= 1);
});


test('P0-B2 rejected asynchronous observer work is detached and never becomes physiology backpressure', async () => {
  const bsf = bsfHarness();
  bsf.subscribeObserver(async () => { throw new Error('async observer boom'); });
  const decision = bsf.evaluateDelivery({ consumerCoreId: 'interoception', envelope: accepted({ eventChar: 'a', sequence: 10 }), nowUs: 1_100_000 });
  assert.equal(decision.status, DELIVERY_STATUS.DELIVER);
  await flushMicrotasks();
  await flushMicrotasks();
  assert.ok(bsf.telemetry().observerErrors >= 1);
});


test('P0-B2 route lag over budget degrades explicitly and leaves no unbounded in-memory required-consumer queue', () => {
  const bsf = bsfHarness({ lagBudgetUs: 10 });
  const decision = bsf.evaluateDelivery({
    consumerCoreId: 'interoception',
    envelope: accepted({ eventChar: 'b', sequence: 11, acceptedTimeUs: 1_000_000 }),
    nowUs: 1_000_011
  });
  assert.equal(decision.status, DELIVERY_STATUS.DEGRADED);
  assert.equal(decision.reason, 'ROUTE_LAG_BUDGET_EXCEEDED');
  assert.equal(bsf.telemetry().lagDegraded, 1);
  assert.equal(Object.hasOwn(bsf, 'requiredConsumerQueue'), false);
});


test('P0-B2 required-route EVIDENCE_GAP blocker is surfaced from durable StateStore completeness, never inferred away by silence', () => {
  const fakeStore = {
    computeBiologicalSafeCompletenessFrontier() {
      return Object.freeze({
        frontierUs: 500,
        blockers: [Object.freeze({ routeId: 'r', state: 'EVIDENCE_GAP', reason: 'ROUTE_BOUNDARY_UNACKNOWLEDGED', routeBarrierUs: 500 })],
        activeRoutes: [],
        releasedRoutes: []
      });
    }
  };
  const bsf = new BiologicalSignallingFabric({ stateStore: fakeStore });
  const result = bsf.evaluateCompleteness({ consumerId: 'core:interoception' });
  assert.equal(result.frontierUs, 500);
  assert.equal(result.blockers[0].state, 'EVIDENCE_GAP');
});


test('P0-B2 optional OBSERVER_ONLY route remains effect-ineligible and therefore cannot pin biological meaning', () => {
  const bsf = new BiologicalSignallingFabric();
  bsf.installManifest(coreManifest('pulse', { producerCapabilities: [producerCapability()] }));
  bsf.installManifest(coreManifest('interoception', { consumerRouteLeases: [consumerLease({ evidenceRole: EVIDENCE_ROLE.OBSERVER_ONLY })] }));
  const decision = bsf.evaluateDelivery({ consumerCoreId: 'interoception', envelope: accepted({ eventChar: 'c', sequence: 12 }), nowUs: 1_100_000 });
  assert.equal(decision.status, DELIVERY_STATUS.OBSERVE_ONLY);
  assert.equal(decision.effectEligible, false);
});


test('P0-B2 lower-than-required durability is rejected before consumer effect', () => {
  const bsf = new BiologicalSignallingFabric();
  bsf.installManifest(coreManifest('pulse', { producerCapabilities: [producerCapability()] }));
  bsf.installManifest(coreManifest('interoception', {
    consumerRouteLeases: [consumerLease({ durability: DURABILITY_CLASS.CHECKPOINT_CRITICAL })]
  }));
  const decision = bsf.evaluateDelivery({ consumerCoreId: 'interoception', envelope: accepted({ eventChar: 'd', sequence: 13 }), nowUs: 1_100_000 });
  assert.equal(decision.status, DELIVERY_STATUS.REJECTED);
  assert.equal(decision.reason, 'NO_ROUTE');
});


test('P0-B2 authority mode outside producer capability is rejected even when topic/schema/stream match', () => {
  const bsf = bsfHarness({ modes: [AUTHORITY_MODE.SHADOW] });
  assert.throws(
    () => bsf.validateProposal({
      producer: { coreId: 'pulse', authorityMode: AUTHORITY_MODE.AUTHORITATIVE },
      proposal: proposal()
    }),
    error => error?.code === 'BIOLOGICAL_BSF_CAPABILITY'
  );
});


test('P0-B2 manifest cardinality bounds reject capability explosions before they can become resource pressure', () => {
  const caps = Array.from({ length: 65 }, (_, index) => ({
    ...producerCapability(),
    id: `cap-${index}`,
    topic: `cardiac.test.${index}`
  }));
  assert.throws(
    () => normalizeBiologyManifest({ protocol: BSF_PROTOCOL, producerCapabilities: caps, consumerRouteLeases: [] }, 'pulse'),
    error => error?.code === 'BIOLOGICAL_BSF_MANIFEST'
  );
});


test('P0-B2 malformed or unknown manifest fields fail closed rather than being best-effort parsed', () => {
  assert.throws(
    () => normalizeBiologyManifest({
      protocol: BSF_PROTOCOL,
      producerCapabilities: [{ ...producerCapability(), magicOverride: true }],
      consumerRouteLeases: []
    }, 'pulse'),
    error => error?.code === 'BIOLOGICAL_BSF_MANIFEST'
  );
});


test('P0-B2 uninstalling a core drops its bounded rate state and capabilities without touching other cores', () => {
  const bsf = bsfHarness();
  bsf.evaluateDelivery({ consumerCoreId: 'interoception', envelope: accepted({ eventChar: 'e', sequence: 14 }), nowUs: 1_100_000 });
  assert.equal(bsf.telemetry().rateBucketCount, 1);
  bsf.uninstallCore('pulse');
  assert.equal(bsf.getManifest('pulse'), null);
  assert.equal(bsf.telemetry().rateBucketCount, 0);
  assert.notEqual(bsf.getManifest('interoception'), null);
});


test('P0-B2 telemetry is a frozen observer projection and BSF exposes no publish method back into biology', () => {
  const bsf = bsfHarness();
  const telemetry = bsf.telemetry();
  assert.equal(Object.isFrozen(telemetry), true);
  assert.equal(typeof bsf.publish, 'undefined');
  assert.equal(typeof bsf.publishBiologicalSignal, 'undefined');
});
