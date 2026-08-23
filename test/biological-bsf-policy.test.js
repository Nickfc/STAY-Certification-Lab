'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateManifest
} = require('../runtime/kernel/manifest');

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
  normalizeBiologyManifest,
  BiologicalSignallingFabric
} = require('../runtime/kernel/biological-signalling-fabric');


function coreManifest(
  coreId,
  biology = null
) {
  return {
    coreId,
    version: '1.0.0',
    protocol: 'stay-core-v1',
    stateSchema: 1,
    inputs: [],
    outputs: [],
    hotSwap: true,
    ...(biology ? { biology } : {})
  };
}


function capability({
  id = 'pulse-beats',
  topic = 'cardiac.beat.raw',
  topicPrefix,
  signalClass = SIGNAL_CLASS.RAW_AFFERENT,
  schemaVersions = [1],
  producerStreamIds = ['pulse:beats'],
  maxRate = { events: 8, intervalUs: 1_000_000 },
  maxPayloadBytes = 2048,
  maxValidityUs = null,
  allowedAuthorityModes = [
    AUTHORITY_MODE.LABORATORY,
    AUTHORITY_MODE.SHADOW,
    AUTHORITY_MODE.AUTHORITATIVE
  ]
} = {}) {
  return {
    id,
    ...(topicPrefix ? { topicPrefix } : { topic }),
    signalClass,
    schemaVersions,
    producerStreamIds,
    maxRate,
    maxPayloadBytes,
    maxValidityUs,
    allowedAuthorityModes
  };
}


function route({
  id = 'pulse-to-interoception',
  consumerCoreId = 'interoception',
  acceptedProducerCoreIds = ['pulse'],
  producerStreamIds = ['pulse:beats'],
  topic = 'cardiac.beat.raw',
  topicPrefix,
  signalClass = SIGNAL_CLASS.RAW_AFFERENT,
  schemaVersions = [1],
  requiredDurability = DURABILITY_CLASS.EPHEMERAL_REPLAYABLE,
  evidenceRole = EVIDENCE_ROLE.PRIMARY_PHYSIOLOGICAL_INPUT,
  lagBudgetUs = 10_000_000,
  activeAuthorityEpochRange = { minimum: 1, maximum: 100 },
  required = true
} = {}) {
  return {
    id,
    consumerCoreId,
    acceptedProducerCoreIds,
    producerStreamIds,
    ...(topicPrefix ? { topicPrefix } : { topic }),
    signalClass,
    schemaVersions,
    requiredDurability,
    requiredOrdering: REQUIRED_ORDERING.CANONICAL,
    evidenceRole,
    lagBudgetUs,
    activeAuthorityEpochRange,
    required
  };
}


function biology({
  producerCapabilities = [],
  consumerRouteLeases = []
} = {}) {
  return {
    protocol: BSF_PROTOCOL,
    producerCapabilities,
    consumerRouteLeases
  };
}


function pulseProposal(
  overrides = {}
) {
  return {
    producer_event_id: 'sha256:' + 'a'.repeat(64),
    producer_stream_id: 'pulse:beats',
    stream_sequence: 1,
    topic: 'cardiac.beat.raw',
    signal_class: SIGNAL_CLASS.RAW_AFFERENT,
    schema_version: 1,
    temporal: {
      type: TEMPORAL_TYPE.INSTANT,
      at_us: 1_000_000
    },
    valid_from_us: null,
    expires_at_us: null,
    durability_class: DURABILITY_CLASS.EPHEMERAL_REPLAYABLE,
    payload: { pacemaker_cycle_id: 1 },
    direct_parents: [],
    causal_source_spans: [],
    ...overrides
  };
}


function acceptedPulse({
  mode = AUTHORITY_MODE.AUTHORITATIVE,
  epoch = 4,
  signalSeed = 'b',
  eventSeed = 'c',
  sequence = 1,
  acceptedTimeUs = 1_000_010,
  validFromUs = null,
  expiresAtUs = null,
  durabilityClass = DURABILITY_CLASS.EPHEMERAL_REPLAYABLE,
  topic = 'cardiac.beat.raw',
  signalClass = SIGNAL_CLASS.RAW_AFFERENT,
  streamId = 'pulse:beats',
  schemaVersion = 1
} = {}) {
  const accepted = acceptEnvelope(
    {
      ...pulseProposal({
        producer_event_id: 'sha256:' + eventSeed.repeat(64),
        producer_stream_id: streamId,
        stream_sequence: sequence,
        topic,
        signal_class: signalClass,
        schema_version: schemaVersion,
        valid_from_us: validFromUs,
        expires_at_us: expiresAtUs,
        durability_class: durabilityClass,
        temporal: {
          type: TEMPORAL_TYPE.INSTANT,
          at_us: 1_000_000 + sequence
        }
      })
    },
    {
      organism_id: 'stay-bsf-policy',
      producer_core_id: 'pulse',
      producer_instance_id: 'pulse-1',
      producer_version: '1.0.0',
      authority_epoch: epoch,
      authority_mode: mode,
      accepted_time_us: acceptedTimeUs,
      fabric_sequence: 20 + sequence,
      causal_roots: [],
      causal_generation: 0,
      roots_overflow_digest: null,
      lineage_digest: null,
      ancestor_core_set: [],
      causality_validated: false,
      max_causal_order_time_us: 0
    }
  );

  // signalSeed is accepted for caller readability; identity remains canonical.
  void signalSeed;
  return accepted;
}


function installedFabric({
  pulseCapability = capability(),
  interoceptionRoute = route(),
  stateStore = null
} = {}) {
  const bsf = new BiologicalSignallingFabric({ stateStore });
  bsf.installManifest(validateManifest(coreManifest(
    'pulse',
    biology({ producerCapabilities: [pulseCapability] })
  )));
  bsf.installManifest(validateManifest(coreManifest(
    'interoception',
    biology({ consumerRouteLeases: [interoceptionRoute] })
  )));
  return bsf;
}


test('P0-B0 manifest biology section normalizes and deep-freezes producer capabilities and route leases', () => {
  const manifest = validateManifest(coreManifest('interoception', biology({
    producerCapabilities: [capability({
      id: 'intero-evidence',
      topicPrefix: 'interoception.cardiac.',
      topic: undefined,
      signalClass: SIGNAL_CLASS.INTEGRATED_EVIDENCE,
      producerStreamIds: ['interoception:cardiac']
    })],
    consumerRouteLeases: [route()]
  })));

  assert.equal(manifest.biology.protocol, BSF_PROTOCOL);
  assert.equal(manifest.biology.producerCapabilities[0].selector.type, 'PREFIX');
  assert.equal(manifest.biology.consumerRouteLeases[0].evidenceRole, EVIDENCE_ROLE.PRIMARY_PHYSIOLOGICAL_INPUT);
  assert.equal(Object.isFrozen(manifest.biology), true);
  assert.equal(Object.isFrozen(manifest.biology.producerCapabilities[0]), true);
});


test('P0-B0 legacy core manifests remain valid when no biological section exists', () => {
  const manifest = validateManifest(coreManifest('legacy-core'));
  assert.equal(Object.hasOwn(manifest, 'biology'), false);
});


test('P0-B0 authoritative global wildcard producer capability is rejected', () => {
  assert.throws(
    () => normalizeBiologyManifest(biology({ producerCapabilities: [capability({ topic: '*' })] }), 'pulse'),
    error => error?.code === 'BIOLOGICAL_BSF_WILDCARD'
  );
});


test('P0-B0 bounded namespace prefix capability accepts only its declared namespace', () => {
  const cap = capability({
    id: 'pulse-state',
    topic: undefined,
    topicPrefix: 'cardiac.rhythm.',
    signalClass: SIGNAL_CLASS.STATE_SUMMARY,
    producerStreamIds: ['pulse:rhythm']
  });
  const bsf = new BiologicalSignallingFabric();
  bsf.installManifest(validateManifest(coreManifest('pulse', biology({ producerCapabilities: [cap] }))));

  assert.doesNotThrow(() => bsf.validateProposal({
    producer: { coreId: 'pulse', authorityMode: AUTHORITY_MODE.SHADOW },
    proposal: pulseProposal({
      topic: 'cardiac.rhythm.summary',
      signal_class: SIGNAL_CLASS.STATE_SUMMARY,
      producer_stream_id: 'pulse:rhythm'
    })
  }));

  assert.throws(() => bsf.validateProposal({
    producer: { coreId: 'pulse', authorityMode: AUTHORITY_MODE.SHADOW },
    proposal: pulseProposal({
      topic: 'cardiac.health',
      signal_class: SIGNAL_CLASS.STATE_SUMMARY,
      producer_stream_id: 'pulse:rhythm'
    })
  }), error => error?.code === 'BIOLOGICAL_BSF_CAPABILITY');
});


test('P0-B0 overlapping producer capabilities are rejected instead of creating ambiguous authority', () => {
  assert.throws(
    () => normalizeBiologyManifest(biology({
      producerCapabilities: [
        capability({ id: 'a', topic: 'cardiac.beat.raw' }),
        capability({ id: 'b', topic: undefined, topicPrefix: 'cardiac.beat.' })
      ]
    }), 'pulse'),
    error => error?.code === 'BIOLOGICAL_BSF_AMBIGUOUS_CAPABILITY'
  );
});


test('P0-B0 direct Pulse to SNTSS biological route is constitutionally rejected', () => {
  assert.throws(
    () => normalizeBiologyManifest(biology({ consumerRouteLeases: [route({
      consumerCoreId: 'sntss',
      acceptedProducerCoreIds: ['pulse']
    })] }), 'sntss'),
    error => error?.code === 'BIOLOGICAL_BSF_FORBIDDEN_ANATOMY'
  );
});


test('P0-B0 direct SNTSS to Pulse biological route is constitutionally rejected', () => {
  assert.throws(
    () => normalizeBiologyManifest(biology({ consumerRouteLeases: [route({
      consumerCoreId: 'pulse',
      acceptedProducerCoreIds: ['sntss']
    })] }), 'pulse'),
    error => error?.code === 'BIOLOGICAL_BSF_FORBIDDEN_ANATOMY'
  );
});


test('P0-B0 producer proposal without an exact manifested capability fails closed', () => {
  const bsf = installedFabric();
  assert.throws(
    () => bsf.validateProposal({
      producer: { coreId: 'pulse', authorityMode: AUTHORITY_MODE.AUTHORITATIVE },
      proposal: pulseProposal({ schema_version: 2 })
    }),
    error => error?.code === 'BIOLOGICAL_BSF_CAPABILITY'
  );
});


test('P0-B0 producer-specific payload bound is enforced below the universal 8 KiB ceiling', () => {
  const bsf = installedFabric({ pulseCapability: capability({ maxPayloadBytes: 64 }) });
  assert.throws(
    () => bsf.validateProposal({
      producer: { coreId: 'pulse', authorityMode: AUTHORITY_MODE.AUTHORITATIVE },
      proposal: pulseProposal({ payload: { body: 'x'.repeat(100) } })
    }),
    error => error?.code === 'BIOLOGICAL_BSF_PAYLOAD'
  );
});


test('P0-B0 expiring modulation classes require explicit bounded validity', () => {
  const bsf = new BiologicalSignallingFabric();
  bsf.installManifest(validateManifest(coreManifest('autonomic', biology({
    producerCapabilities: [capability({
      id: 'autonomic-cardiac',
      topic: 'autonomic.cardiac.modulation',
      signalClass: SIGNAL_CLASS.REGULATORY_EFFERENT,
      producerStreamIds: ['autonomic:cardiac'],
      maxValidityUs: 500_000
    })]
  }))));

  assert.throws(() => bsf.validateProposal({
    producer: { coreId: 'autonomic', authorityMode: AUTHORITY_MODE.AUTHORITATIVE },
    proposal: pulseProposal({
      topic: 'autonomic.cardiac.modulation',
      signal_class: SIGNAL_CLASS.REGULATORY_EFFERENT,
      producer_stream_id: 'autonomic:cardiac'
    })
  }), error => error?.code === 'BIOLOGICAL_BSF_VALIDITY');
});


test('P0-B0 producer capability rejects modulation validity that exceeds its declared maximum', () => {
  const bsf = new BiologicalSignallingFabric();
  bsf.installManifest(validateManifest(coreManifest('autonomic', biology({
    producerCapabilities: [capability({
      id: 'autonomic-cardiac',
      topic: 'autonomic.cardiac.modulation',
      signalClass: SIGNAL_CLASS.REGULATORY_EFFERENT,
      producerStreamIds: ['autonomic:cardiac'],
      maxValidityUs: 100
    })]
  }))));

  assert.throws(() => bsf.validateProposal({
    producer: { coreId: 'autonomic', authorityMode: AUTHORITY_MODE.AUTHORITATIVE },
    proposal: pulseProposal({
      topic: 'autonomic.cardiac.modulation',
      signal_class: SIGNAL_CLASS.REGULATORY_EFFERENT,
      producer_stream_id: 'autonomic:cardiac',
      valid_from_us: 10,
      expires_at_us: 111
    })
  }), error => error?.code === 'BIOLOGICAL_BSF_VALIDITY');
});


test('P0-B0 stream progress can be declared only for a manifested producer stream and authority mode', () => {
  const bsf = installedFabric();
  assert.equal(bsf.validateStreamProgress({
    producer: { coreId: 'pulse', authorityMode: AUTHORITY_MODE.AUTHORITATIVE },
    progress: { producer_stream_id: 'pulse:beats', finalized_through_us: 100 }
  }), true);

  assert.throws(() => bsf.validateStreamProgress({
    producer: { coreId: 'pulse', authorityMode: AUTHORITY_MODE.AUTHORITATIVE },
    progress: { producer_stream_id: 'pulse:secret', finalized_through_us: 100 }
  }), error => error?.code === 'BIOLOGICAL_BSF_STREAM_PROGRESS');
});


test('P0-B0 route matching binds producer identity, stream, topic, class, schema, durability and authority epoch', () => {
  const bsf = installedFabric();
  const accepted = acceptedPulse();
  const yes = bsf.evaluateDelivery({
    consumerCoreId: 'interoception',
    envelope: accepted,
    nowUs: 1_000_020
  });
  assert.equal(yes.status, DELIVERY_STATUS.DELIVER);

  const wrongEpoch = acceptedPulse({ epoch: 101, eventSeed: 'd', sequence: 2 });
  const no = bsf.evaluateDelivery({
    consumerCoreId: 'interoception',
    envelope: wrongEpoch,
    nowUs: 1_000_020
  });
  assert.equal(no.status, DELIVERY_STATUS.REJECTED);
  assert.equal(no.reason, 'NO_ROUTE');
});


test('P0-B0 evidence role is receiver-owned route metadata and never becomes producer-authored meaning', () => {
  const bsf = installedFabric();
  const decision = bsf.evaluateDelivery({
    consumerCoreId: 'interoception',
    envelope: acceptedPulse(),
    nowUs: 1_000_020
  });
  assert.equal(decision.evidenceRole, EVIDENCE_ROLE.PRIMARY_PHYSIOLOGICAL_INPUT);
  assert.equal(Object.hasOwn(acceptedPulse(), 'evidence_role'), false);
});


test('P0-B0 LABORATORY and SHADOW use the same route protocol but are never eligible for authoritative biological effect', () => {
  const bsf = installedFabric();
  for (const mode of [AUTHORITY_MODE.LABORATORY, AUTHORITY_MODE.SHADOW]) {
    const decision = bsf.evaluateDelivery({
      consumerCoreId: 'interoception',
      envelope: acceptedPulse({ mode, eventSeed: mode === AUTHORITY_MODE.LABORATORY ? 'e' : 'f' }),
      nowUs: 1_000_020
    });
    assert.equal(decision.status, DELIVERY_STATUS.DELIVER);
    assert.equal(decision.effectEligible, false);
  }
});


test('P0-B0 AUTHORITATIVE envelope on a primary leased route is eligible for receiver-owned effect', () => {
  const bsf = installedFabric();
  const decision = bsf.evaluateDelivery({
    consumerCoreId: 'interoception',
    envelope: acceptedPulse(),
    nowUs: 1_000_020
  });
  assert.equal(decision.effectEligible, true);
});


test('P0-B0 OBSERVER_ONLY route can see an authoritative envelope but cannot become biological effect', () => {
  const bsf = installedFabric({
    interoceptionRoute: route({ evidenceRole: EVIDENCE_ROLE.OBSERVER_ONLY, required: false })
  });
  const decision = bsf.evaluateDelivery({
    consumerCoreId: 'interoception',
    envelope: acceptedPulse(),
    nowUs: 1_000_020
  });
  assert.equal(decision.status, DELIVERY_STATUS.OBSERVE_ONLY);
  assert.equal(decision.effectEligible, false);
});


test('P0-B0 required declared routes bind to durable StateStore route identities without inventing a second transport', () => {
  const calls = [];
  const fakeStore = {
    registerBiologicalRoute(value) {
      calls.push(value);
      return Object.freeze({ ...value, state: 'ACTIVE' });
    }
  };
  const bsf = installedFabric({ stateStore: fakeStore });
  const bound = bsf.bindRequiredRoutes({
    consumerCoreId: 'interoception',
    consumerId: 'core:interoception',
    organismId: 'stay-bsf-policy',
    authorityEpochByProducer: { pulse: 4 },
    activeFromUs: 100
  });
  assert.equal(bound.length, 1);
  assert.equal(calls[0].producerStreamId, 'pulse:beats');
  assert.equal(calls[0].authorityEpoch, 4);
  assert.equal(calls[0].required, true);
  assert.match(calls[0].routeId, /^bsf:pulse-to-interoception:/);
});


test('P0-B0 overlapping consumer leases are rejected to prevent duplicate biological routing', () => {
  assert.throws(
    () => normalizeBiologyManifest(biology({
      consumerRouteLeases: [
        route({ id: 'one' }),
        route({ id: 'two', topic: undefined, topicPrefix: 'cardiac.beat.' })
      ]
    }), 'interoception'),
    error => error?.code === 'BIOLOGICAL_BSF_AMBIGUOUS_ROUTE'
  );
});
