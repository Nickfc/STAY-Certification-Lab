'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BiologicalAcceptanceBoundary
} = require('../runtime/kernel/biological-acceptance');

const {
  acceptEnvelope,
  AUTHORITY_MODE,
  SIGNAL_CLASS,
  DURABILITY_CLASS,
  TEMPORAL_TYPE
} = require('../runtime/kernel/biological-envelope');

const {
  BSF_PROTOCOL,
  EVIDENCE_ROLE,
  REQUIRED_ORDERING,
  DELIVERY_MODE,
  DELIVERY_STATUS,
  canonicalDeliveryOrder,
  BiologicalSignallingFabric
} = require('../runtime/kernel/biological-signalling-fabric');

const { validateManifest } = require('../runtime/kernel/manifest');


function manifest(coreId, {
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


function cap({
  id,
  topic,
  signalClass,
  streamId,
  maxRate = { events: 20, intervalUs: 1_000_000 },
  maxValidityUs = null
}) {
  return {
    id,
    topic,
    signalClass,
    schemaVersions: [1],
    producerStreamIds: [streamId],
    maxRate,
    maxPayloadBytes: 4096,
    maxValidityUs,
    allowedAuthorityModes: [
      AUTHORITY_MODE.LABORATORY,
      AUTHORITY_MODE.SHADOW,
      AUTHORITY_MODE.AUTHORITATIVE
    ]
  };
}


function lease({
  id,
  consumerCoreId,
  producerCoreId,
  streamId,
  topic,
  signalClass,
  evidenceRole = EVIDENCE_ROLE.PRIMARY_PHYSIOLOGICAL_INPUT,
  lagBudgetUs = 5_000_000,
  required = true
}) {
  return {
    id,
    consumerCoreId,
    acceptedProducerCoreIds: [producerCoreId],
    producerStreamIds: [streamId],
    topic,
    signalClass,
    schemaVersions: [1],
    requiredDurability: DURABILITY_CLASS.EPHEMERAL_REPLAYABLE,
    requiredOrdering: REQUIRED_ORDERING.CANONICAL,
    evidenceRole,
    lagBudgetUs,
    activeAuthorityEpochRange: { minimum: 1, maximum: 20 },
    required
  };
}


function pulseProposal({
  eventChar = 'a',
  sequence = 1,
  atUs = 1_000_000,
  validFromUs = null,
  expiresAtUs = null
} = {}) {
  return {
    producer_event_id: 'sha256:' + eventChar.repeat(64),
    producer_stream_id: 'pulse:beats',
    stream_sequence: sequence,
    topic: 'cardiac.beat.raw',
    signal_class: SIGNAL_CLASS.RAW_AFFERENT,
    schema_version: 1,
    temporal: { type: TEMPORAL_TYPE.INSTANT, at_us: atUs },
    valid_from_us: validFromUs,
    expires_at_us: expiresAtUs,
    durability_class: DURABILITY_CLASS.EPHEMERAL_REPLAYABLE,
    payload: { pacemaker_cycle_id: sequence },
    direct_parents: [],
    causal_source_spans: []
  };
}


function modulationProposal({
  eventChar = 'f',
  sequence = 1,
  startUs = 1_000_000,
  endUs = 1_500_000
} = {}) {
  return {
    producer_event_id: 'sha256:' + eventChar.repeat(64),
    producer_stream_id: 'autonomic:cardiac',
    stream_sequence: sequence,
    topic: 'autonomic.cardiac.modulation',
    signal_class: SIGNAL_CLASS.REGULATORY_EFFERENT,
    schema_version: 1,
    temporal: { type: TEMPORAL_TYPE.INTERVAL, start_us: startUs, end_us: endUs },
    valid_from_us: startUs,
    expires_at_us: endUs,
    durability_class: DURABILITY_CLASS.CHECKPOINT_CRITICAL,
    payload: {
      sympathetic_influence_q: 1,
      parasympathetic_influence_q: 0,
      rise_tau_us: 10_000,
      decay_tau_us: 30_000,
      confidence_q: 1
    },
    direct_parents: [],
    causal_source_spans: []
  };
}


function bsfHarness() {
  const bsf = new BiologicalSignallingFabric();

  bsf.installManifest(manifest('pulse', {
    producerCapabilities: [cap({
      id: 'pulse-beats',
      topic: 'cardiac.beat.raw',
      signalClass: SIGNAL_CLASS.RAW_AFFERENT,
      streamId: 'pulse:beats'
    })]
  }));

  bsf.installManifest(manifest('autonomic', {
    producerCapabilities: [cap({
      id: 'autonomic-cardiac',
      topic: 'autonomic.cardiac.modulation',
      signalClass: SIGNAL_CLASS.REGULATORY_EFFERENT,
      streamId: 'autonomic:cardiac',
      maxValidityUs: 1_000_000
    })]
  }));

  bsf.installManifest(manifest('interoception', {
    consumerRouteLeases: [lease({
      id: 'pulse-to-interoception',
      consumerCoreId: 'interoception',
      producerCoreId: 'pulse',
      streamId: 'pulse:beats',
      topic: 'cardiac.beat.raw',
      signalClass: SIGNAL_CLASS.RAW_AFFERENT
    })]
  }));

  bsf.installManifest(manifest('pulse-target', {
    consumerRouteLeases: [lease({
      id: 'autonomic-to-pulse-target',
      consumerCoreId: 'pulse-target',
      producerCoreId: 'autonomic',
      streamId: 'autonomic:cardiac',
      topic: 'autonomic.cardiac.modulation',
      signalClass: SIGNAL_CLASS.REGULATORY_EFFERENT
    })]
  }));

  return bsf;
}


function acceptanceHarness({
  mode = AUTHORITY_MODE.LABORATORY,
  bsf = bsfHarness(),
  trustedTimeUs = 2_000_000,
  existingByEvent = new Map(),
  evidenceById = new Map(),
  startFabricSequence = 100
} = {}) {
  let sequence = startFabricSequence;
  let allocations = 0;

  const boundary = new BiologicalAcceptanceBoundary({
    organismId: 'stay-bsf-lab',
    trustedTime: {
      async sample() {
        return { status: 'TRUSTED', trustedTimeUs };
      }
    },
    async resolveProducer(handle) {
      if (handle !== 'pulse-handle') return null;
      return {
        coreId: 'pulse',
        instanceId: 'pulse-instance-1',
        version: '1.0.0',
        authorityEpoch: 4,
        authorityMode: mode
      };
    },
    async resolveSignal(signalId) {
      return evidenceById.get(signalId) || null;
    },
    async resolveStreamRange() {
      return [];
    },
    async resolveProducerEvent({ producerEventId }) {
      return existingByEvent.get(producerEventId) || null;
    },
    async allocateFabricSequence() {
      allocations += 1;
      return sequence++;
    },
    bsfPolicy: bsf
  });

  return {
    boundary,
    existingByEvent,
    evidenceById,
    allocations: () => allocations
  };
}


function acceptedModulation({
  mode = AUTHORITY_MODE.AUTHORITATIVE,
  startUs = 1_000_000,
  endUs = 1_500_000,
  acceptedTimeUs = 1_100_000,
  sequence = 1,
  eventChar = '7'
} = {}) {
  return acceptEnvelope(
    modulationProposal({ eventChar, sequence, startUs, endUs }),
    {
      organism_id: 'stay-bsf-lab',
      producer_core_id: 'autonomic',
      producer_instance_id: 'autonomic-1',
      producer_version: '1.0.0',
      authority_epoch: 4,
      authority_mode: mode,
      accepted_time_us: acceptedTimeUs,
      fabric_sequence: 500 + sequence,
      causal_roots: [],
      causal_generation: 0,
      roots_overflow_digest: null,
      lineage_digest: null,
      ancestor_core_set: [],
      causality_validated: false,
      max_causal_order_time_us: 0
    }
  );
}


test('P0-B1 LABORATORY, SHADOW and AUTHORITATIVE submissions use one BSF proposal validation plus one UBE acceptance path', async () => {
  const signalIds = [];
  for (const mode of [AUTHORITY_MODE.LABORATORY, AUTHORITY_MODE.SHADOW, AUTHORITY_MODE.AUTHORITATIVE]) {
    const bsf = bsfHarness();
    const { boundary } = acceptanceHarness({ mode, bsf });
    const accepted = await boundary.accept({ producerHandle: 'pulse-handle', proposal: pulseProposal() });
    signalIds.push(accepted.signal_id);
    assert.equal(accepted.authority_mode, mode);
    assert.equal(bsf.telemetry().proposalsValidated, 1);
  }
  assert.equal(new Set(signalIds).size, 3, 'authority mode remains immutable accepted content');
});


test('P0-B1 BSF rejects an unmanifested proposal before a Fabric sequence can be allocated', async () => {
  const { boundary, allocations } = acceptanceHarness();
  await assert.rejects(
    () => boundary.accept({
      producerHandle: 'pulse-handle',
      proposal: pulseProposal({}) && { ...pulseProposal(), topic: 'cardiac.secret' }
    }),
    error => error?.code === 'BIOLOGICAL_BSF_CAPABILITY'
  );
  assert.equal(allocations(), 0);
});


test('P0-B1 exact retry traverses BSF validation again and returns the original accepted signal identity', async () => {
  const bsf = bsfHarness();
  const harness = acceptanceHarness({ bsf });
  const proposal = pulseProposal();
  const first = await harness.boundary.accept({ producerHandle: 'pulse-handle', proposal });
  harness.existingByEvent.set(proposal.producer_event_id, first);
  const preparedRetry = await harness.boundary.prepare({ producerHandle: 'pulse-handle', proposal });
  const second = harness.boundary.finalizePrepared(preparedRetry, first.fabric_sequence);
  assert.equal(second.signal_id, first.signal_id);
  assert.equal(second.fabric_sequence, first.fabric_sequence);
  assert.equal(bsf.telemetry().proposalsValidated, 2);
});


test('P0-B1 conflicting retry content remains rejected even though its producer capability is valid', async () => {
  const bsf = bsfHarness();
  const harness = acceptanceHarness({ bsf });
  const proposal = pulseProposal();
  const first = await harness.boundary.accept({ producerHandle: 'pulse-handle', proposal });
  harness.existingByEvent.set(proposal.producer_event_id, first);
  await assert.rejects(
    () => harness.boundary.accept({
      producerHandle: 'pulse-handle',
      proposal: { ...proposal, payload: { pacemaker_cycle_id: 99 } }
    }),
    error => error?.code === 'BIOLOGICAL_PRODUCER_EVENT_CONFLICT'
  );
});


test('P0-B1 canonical delivery order ignores arrival order and sorts by order_time_us then fabric_sequence', () => {
  const one = acceptEnvelope(pulseProposal({ eventChar: '1', sequence: 1, atUs: 100 }), {
    organism_id: 'stay-bsf-lab', producer_core_id: 'pulse', producer_instance_id: 'p1', producer_version: '1.0.0',
    authority_epoch: 4, authority_mode: AUTHORITY_MODE.LABORATORY, accepted_time_us: 200, fabric_sequence: 8,
    causal_roots: [], causal_generation: 0, roots_overflow_digest: null, lineage_digest: null,
    ancestor_core_set: [], causality_validated: false, max_causal_order_time_us: 0
  });
  const two = acceptEnvelope(pulseProposal({ eventChar: '2', sequence: 2, atUs: 90 }), {
    organism_id: 'stay-bsf-lab', producer_core_id: 'pulse', producer_instance_id: 'p1', producer_version: '1.0.0',
    authority_epoch: 4, authority_mode: AUTHORITY_MODE.LABORATORY, accepted_time_us: 200, fabric_sequence: 9,
    causal_roots: [], causal_generation: 0, roots_overflow_digest: null, lineage_digest: null,
    ancestor_core_set: [], causality_validated: false, max_causal_order_time_us: 0
  });
  const three = acceptEnvelope(pulseProposal({ eventChar: '3', sequence: 3, atUs: 100 }), {
    organism_id: 'stay-bsf-lab', producer_core_id: 'pulse', producer_instance_id: 'p1', producer_version: '1.0.0',
    authority_epoch: 4, authority_mode: AUTHORITY_MODE.LABORATORY, accepted_time_us: 200, fabric_sequence: 7,
    causal_roots: [], causal_generation: 0, roots_overflow_digest: null, lineage_digest: null,
    ancestor_core_set: [], causality_validated: false, max_causal_order_time_us: 0
  });

  const ordered = canonicalDeliveryOrder([one, two, three]);
  assert.deepEqual(ordered.map(item => item.signal_id), [two.signal_id, three.signal_id, one.signal_id]);
});


test('P0-B1 canonical ordering rejects duplicate accepted signal identity rather than double-delivering it', () => {
  const one = acceptEnvelope(pulseProposal(), {
    organism_id: 'stay-bsf-lab', producer_core_id: 'pulse', producer_instance_id: 'p1', producer_version: '1.0.0',
    authority_epoch: 4, authority_mode: AUTHORITY_MODE.LABORATORY, accepted_time_us: 2_000_000, fabric_sequence: 1,
    causal_roots: [], causal_generation: 0, roots_overflow_digest: null, lineage_digest: null,
    ancestor_core_set: [], causality_validated: false, max_causal_order_time_us: 0
  });
  assert.throws(() => canonicalDeliveryOrder([one, one]), error => error?.code === 'BIOLOGICAL_BSF_ORDERING');
});


test('P0-B1 live interval arriving late is clipped to the remaining original validity window, never shifted forward', () => {
  const bsf = bsfHarness();
  const envelope = acceptedModulation({ startUs: 1_000_000, endUs: 1_500_000, acceptedTimeUs: 1_100_000 });
  const decision = bsf.evaluateDelivery({
    consumerCoreId: 'pulse-target', envelope, nowUs: 1_300_000, deliveryMode: DELIVERY_MODE.LIVE
  });
  assert.equal(decision.status, DELIVERY_STATUS.DELIVER_CLIPPED);
  assert.equal(decision.effectiveValidFromUs, 1_300_000);
  assert.equal(decision.effectiveExpiresAtUs, 1_500_000);
});


test('P0-B1 expired live modulation is rejected instead of being applied in the wrong present', () => {
  const bsf = bsfHarness();
  const envelope = acceptedModulation({ startUs: 1_000_000, endUs: 1_100_000, acceptedTimeUs: 1_050_000 });
  const decision = bsf.evaluateDelivery({
    consumerCoreId: 'pulse-target', envelope, nowUs: 1_100_001, deliveryMode: DELIVERY_MODE.LIVE
  });
  assert.equal(decision.status, DELIVERY_STATUS.REJECTED);
  assert.equal(decision.reason, 'EXPIRED_LIVE_INFLUENCE');
});


test('P0-B1 recovery replay reconstructs only the original interval that remains beyond the committed frontier', () => {
  const bsf = bsfHarness();
  const envelope = acceptedModulation({ startUs: 1_000_000, endUs: 1_500_000, acceptedTimeUs: 1_100_000 });
  const decision = bsf.evaluateDelivery({
    consumerCoreId: 'pulse-target', envelope, nowUs: 2_000_000,
    deliveryMode: DELIVERY_MODE.RECOVERY_REPLAY, committedThroughUs: 1_200_000
  });
  assert.equal(decision.status, DELIVERY_STATUS.DELIVER_CLIPPED);
  assert.equal(decision.effectiveValidFromUs, 1_200_001);
  assert.equal(decision.effectiveExpiresAtUs, 1_500_000);
});


test('P0-B1 recovery replay cannot mutate an interval already entirely behind committed biology', () => {
  const bsf = bsfHarness();
  const envelope = acceptedModulation({ startUs: 1_000_000, endUs: 1_500_000, acceptedTimeUs: 1_100_000 });
  const decision = bsf.evaluateDelivery({
    consumerCoreId: 'pulse-target', envelope, nowUs: 2_000_000,
    deliveryMode: DELIVERY_MODE.RECOVERY_REPLAY, committedThroughUs: 1_500_000
  });
  assert.equal(decision.status, DELIVERY_STATUS.REJECTED);
  assert.equal(decision.reason, 'REPLAY_BEHIND_COMMITTED_FRONTIER');
});


test('P0-B1 non-authoritative modes traverse the same consumer route but remain effect-ineligible', () => {
  const bsf = bsfHarness();
  for (const mode of [AUTHORITY_MODE.LABORATORY, AUTHORITY_MODE.SHADOW]) {
    const envelope = acceptedModulation({ mode, eventChar: mode === AUTHORITY_MODE.LABORATORY ? '8' : '9' });
    const decision = bsf.evaluateDelivery({ consumerCoreId: 'pulse-target', envelope, nowUs: 1_100_000 });
    assert.equal(decision.status, DELIVERY_STATUS.DELIVER_CLIPPED);
    assert.equal(decision.effectEligible, false);
  }
});


test('P0-B1 authoritative mode becomes effect-eligible only after the receiver lease accepts it', () => {
  const bsf = bsfHarness();
  const decision = bsf.evaluateDelivery({
    consumerCoreId: 'pulse-target', envelope: acceptedModulation(), nowUs: 1_100_000
  });
  assert.equal(decision.effectEligible, true);
});


test('P0-B1 route lag budget produces explicit degradation instead of silently buffering forever', () => {
  const bsf = bsfHarness();
  const envelope = acceptedModulation({ acceptedTimeUs: 1_000_000 });
  const decision = bsf.evaluateDelivery({
    consumerCoreId: 'pulse-target', envelope, nowUs: 7_000_001
  });
  assert.equal(decision.status, DELIVERY_STATUS.DEGRADED);
  assert.equal(decision.reason, 'ROUTE_LAG_BUDGET_EXCEEDED');
  assert.equal(decision.degraded, true);
});


test('P0-B1 StateStore completeness frontier remains the authority for required-route progress', () => {
  const fake = {
    computeBiologicalSafeCompletenessFrontier({ consumerId }) {
      assert.equal(consumerId, 'core:interoception');
      return Object.freeze({ frontierUs: 900, blockers: [], activeRoutes: [{ routeId: 'r', frontierUs: 900 }] });
    }
  };
  const bsf = new BiologicalSignallingFabric({ stateStore: fake });
  assert.equal(bsf.evaluateCompleteness({ consumerId: 'core:interoception' }).frontierUs, 900);
});


test('P0-B1 authority laundering remains blocked at the acceptance boundary even when BSF capability validation passes', async () => {
  const bsf = bsfHarness();
  const shadowParent = acceptEnvelope(pulseProposal({ eventChar: '4', sequence: 4, atUs: 900_000 }), {
    organism_id: 'stay-bsf-lab', producer_core_id: 'interoception', producer_instance_id: 'i1', producer_version: '1.0.0',
    authority_epoch: 4, authority_mode: AUTHORITY_MODE.SHADOW, accepted_time_us: 900_100, fabric_sequence: 40,
    causal_roots: [], causal_generation: 0, roots_overflow_digest: null, lineage_digest: null,
    ancestor_core_set: [], causality_validated: false, max_causal_order_time_us: 0
  });

  // Use a Pulse-shaped envelope only as causal evidence identity. The acceptance boundary owns taint rejection.
  const evidenceById = new Map([[shadowParent.signal_id, shadowParent]]);
  const harness = acceptanceHarness({
    mode: AUTHORITY_MODE.AUTHORITATIVE,
    bsf,
    evidenceById,
    trustedTimeUs: 2_000_000
  });

  await assert.rejects(
    () => harness.boundary.accept({
      producerHandle: 'pulse-handle',
      proposal: { ...pulseProposal({ eventChar: '5', sequence: 5 }), direct_parents: [shadowParent.signal_id] }
    }),
    error => error?.code === 'BIOLOGICAL_ACCEPTANCE_AUTHORITY_LAUNDERING'
  );
});


test('P0-B1 stream progress uses the same BSF manifested-stream policy before Kernel progress capability is minted', async () => {
  const bsf = bsfHarness();
  const harness = acceptanceHarness({ bsf });
  const progress = await harness.boundary.prepareStreamProgress({
    producerHandle: 'pulse-handle',
    progress: { producer_stream_id: 'pulse:beats', finalized_through_us: 1_500_000 }
  });
  assert.equal(harness.boundary.finalizePreparedStreamProgress(progress).producer_stream_id, 'pulse:beats');

  await assert.rejects(
    () => harness.boundary.prepareStreamProgress({
      producerHandle: 'pulse-handle',
      progress: { producer_stream_id: 'pulse:unmanifested', finalized_through_us: 1_500_000 }
    }),
    error => error?.code === 'BIOLOGICAL_BSF_STREAM_PROGRESS'
  );
});
