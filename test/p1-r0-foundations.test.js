'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const q48 = require('../runtime/p1-r0/q16-48');
const noise = require('../runtime/p1-r0/deterministic-noise');
const {
  FRAME_PROTOCOL,
  FRAME_US,
  validateCausalFrame,
  toEnvelopeProposal
} = require('../runtime/p1-r0/causal-frame');
const {
  ENVELOPE_PROTOCOL,
  AUTHORITY_MODE,
  SIGNAL_CLASS,
  DURABILITY_CLASS,
  acceptEnvelope
} = require('../runtime/kernel/biological-envelope');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const { ROUTES, ROUTE_STAGE, FORBIDDEN_EDGES } = require('../runtime/p1-r0/contract-registry');

const q48Vectors = require('./fixtures/p1-r0/q16-48-vectors.json');
const noiseVectors = require('./fixtures/p1-r0/splitmix64-vectors.json');

function fixtureSha256(name) {
  const bytes = require('node:fs').readFileSync(path.join(__dirname, 'fixtures', 'p1-r0', name));
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function frame(overrides = {}) {
  const payload = overrides.payload || { availabilityQ48: q48.SCALE.toString() };
  const base = {
    frameVersion: FRAME_PROTOCOL,
    frameId: `sha256:${'1'.repeat(64)}`,
    organismId: 'stay-p1-r0-test',
    founderLineageId: 'lineage-metab-0001',
    producer: {
      coreId: 'metab',
      residencyId: 'resident:metab',
      coreVersion: '0.1.0-lab',
      authorityEpoch: '1',
      mode: 'SHADOW',
      lifecycle: 'RUNNING'
    },
    route: {
      routeId: 'p1r0.metab-availability.homeos',
      consumerCoreId: 'homeos',
      routeVersion: '1'
    },
    topic: {
      name: 'metab.energy.availability.v1',
      class: 'SUMMARY',
      schemaId: 'urn:stay:p1-r0:schema:metab-energy-availability-payload:v1',
      schemaVersion: '1',
      unit: 'ratio',
      scale: 'Q16.48'
    },
    producerSequence: '9',
    committedFrame: 20,
    visibleFromFrame: 21,
    sourceWindow: { startFrame: 19, endFrame: 20 },
    causalSpan: {
      earliestFrame: 19,
      latestFrame: 20,
      containsNeutral: false,
      containsShadow: false,
      ancestors: []
    },
    quality: {
      status: 'ACCEPT',
      confidenceQ48: q48.SCALE.toString(),
      coverageQ48: q48.SCALE.toString(),
      reasons: []
    },
    expiresAtFrame: null,
    payload,
    payloadHash: hash(payload)
  };
  return { ...base, ...overrides, payload, payloadHash: overrides.payloadHash || hash(payload) };
}

function adapterOptions(value = frame()) {
  return {
    directParents: [],
    causalSourceSpans: [],
    producerBinding: {
      organismId: value.organismId,
      founderLineageId: value.founderLineageId,
      coreId: value.producer.coreId,
      residencyId: value.producer.residencyId,
      coreVersion: value.producer.coreVersion,
      authorityEpoch: value.producer.authorityEpoch,
      mode: value.producer.mode
    }
  };
}

test('P1R0-FND-01 Q16.48 pack vectors and half-even ties are exact', () => {
  assert.equal(fixtureSha256('q16-48-vectors.json'), '2cec339a2f3f630017ea166865e3afb6e1a20461317450a7155c3eb28098dcfe');
  assert.equal(q48Vectors.rounding, 'half-even');
  for (const vector of q48Vectors.vectors) {
    assert.equal(q48.fromDecimal(vector.decimal).toString(), vector.raw, vector.id);
    assert.equal(q48.parseRaw(vector.raw).toString(), vector.raw, vector.id);
  }
  const eighth = q48.fromDecimal('0.125');
  assert.equal(q48.quantize(q48.fromDecimal('0.5625'), eighth), q48.fromDecimal('0.5'));
  assert.equal(q48.quantize(q48.fromDecimal('0.6875'), eighth), q48.fromDecimal('0.75'));
  assert.equal(q48.mul(q48.fromDecimal('0.5'), q48.fromDecimal('0.5')), q48.fromDecimal('0.25'));
});

test('P1R0-FND-02 Q16.48 rejects overflow, noncanonical transport and division by zero', () => {
  assert.throws(() => q48.parseRaw('01'), { code: 'P1_Q48_CANONICAL' });
  assert.throws(() => q48.parseRaw('9'.repeat(1000)), { code: 'P1_Q48_CANONICAL' });
  assert.throws(() => q48.add(q48.MAX_RAW, 1n), { code: 'P1_Q48_OVERFLOW' });
  assert.throws(() => q48.div(q48.SCALE, 0n), { code: 'P1_Q48_DIV_ZERO' });
  assert.equal(q48.saturatingAdd(q48.MAX_RAW, 1n), q48.MAX_RAW);
});

test('P1R0-FND-03 deterministic noise reproduces every pack vector without platform RNG', () => {
  assert.equal(fixtureSha256('splitmix64-vectors.json'), '3120f47ad987b5167e17143e8e074b8da2b0fbece435cf7cfb72b980c4522175');
  assert.equal(noise.fnv1a64(noiseVectors.channelId).toString(16).padStart(16, '0'), noiseVectors.channelHashHex);
  for (const vector of noiseVectors.vectors) {
    assert.deepEqual(
      noise.triangularQ0_48({
        noiseKeyHex: noiseVectors.noiseKeyHex,
        channelId: noiseVectors.channelId,
        frameIndex: vector.frameIndex
      }),
      {
        z0Hex: vector.z0Hex,
        z1Hex: vector.z1Hex,
        splitmix0Hex: vector.splitmix0Hex,
        splitmix1Hex: vector.splitmix1Hex,
        u0Q0_48Raw: vector.u0Q0_48Raw,
        u1Q0_48Raw: vector.u1Q0_48Raw,
        differenceQ0_48Raw: vector.differenceQ0_48Raw
      }
    );
  }
});

test('P1R0-FND-04 future-frame visibility, trusted windows and payload hashes fail closed', () => {
  assert.equal(validateCausalFrame(frame()).visibleFromFrame, 21);
  assert.throws(() => validateCausalFrame(frame({ visibleFromFrame: 20 })), { code: 'P1_FRAME_SAME_FRAME' });
  assert.throws(() => validateCausalFrame(frame({ sourceWindow: { startFrame: 20, endFrame: 21 } })), { code: 'P1_FRAME_FUTURE_SOURCE' });
  assert.throws(() => validateCausalFrame(frame({ payloadHash: `sha256:${'0'.repeat(64)}` })), { code: 'P1_FRAME_PAYLOAD_HASH' });
});

test('P1R0-FND-05 shadow ancestry cannot be laundered into LIVE authority', () => {
  const liveProducer = { ...frame().producer, mode: 'LIVE' };
  assert.throws(() => validateCausalFrame(frame({
    producer: liveProducer,
    causalSpan: { ...frame().causalSpan, containsShadow: true }
  })), { code: 'P1_FRAME_AUTHORITY_LAUNDERING' });
});

test('P1R0-FND-06 adapter preserves the frozen Envelope v2 and maps one future frame exactly', () => {
  assert.equal(ENVELOPE_PROTOCOL, 'stay-biological-envelope-v2');
  const sourceFrame = frame();
  const proposal = toEnvelopeProposal(sourceFrame, adapterOptions(sourceFrame));
  assert.equal(proposal.signal_class, SIGNAL_CLASS.STATE_SUMMARY);
  assert.equal(proposal.durability_class, DURABILITY_CLASS.CHECKPOINT_CRITICAL);
  assert.equal(proposal.temporal.at_us, 20 * FRAME_US);
  assert.equal(proposal.valid_from_us, 21 * FRAME_US);
  assert.equal(proposal.payload.p1Frame.frameVersion, FRAME_PROTOCOL);

  const accepted = acceptEnvelope(proposal, {
    organism_id: 'stay-p1-r0-test',
    producer_core_id: 'metab',
    producer_instance_id: 'metab-instance-0001',
    producer_version: '0.1.0-lab',
    authority_epoch: 1,
    authority_mode: AUTHORITY_MODE.SHADOW,
    accepted_time_us: 21 * FRAME_US,
    fabric_sequence: 1,
    causal_roots: [],
    causal_generation: 0,
    roots_overflow_digest: null,
    lineage_digest: null,
    ancestor_core_set: [],
    causality_validated: false,
    max_causal_order_time_us: 0
  });
  assert.equal(accepted.protocol, ENVELOPE_PROTOCOL);
  assert.equal(accepted.authority_mode, AUTHORITY_MODE.SHADOW);
});

test('P1R0-FND-07 non-accepted quality cannot become a biological proposal', () => {
  const quality = { ...frame().quality, status: 'UNKNOWN', reasons: ['SOURCE_GAP'] };
  assert.doesNotThrow(() => validateCausalFrame(frame({ quality })));
  const held = frame({ quality });
  assert.throws(() => toEnvelopeProposal(held, adapterOptions(held)), { code: 'P1_FRAME_NOT_ACCEPTED' });
});

test('P1R0-FND-08 P1 foundation modules have no runtime RNG or direct StateStore import', () => {
  for (const relative of ['q16-48.js', 'deterministic-noise.js', 'causal-frame.js']) {
    const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'runtime', 'p1-r0', relative), 'utf8');
    assert.doesNotMatch(source, /Math\.random|randomBytes|state-store|continuity\.sqlite/i);
  }
});

test('P1R0-FND-09 route declarations are closed, revocable and absent by default', () => {
  assert.equal(Object.keys(ROUTES).length, 9);
  for (const route of Object.values(ROUTES)) {
    assert.equal(route.stage, ROUTE_STAGE);
    assert.equal(route.stage, 'ABSENT');
    assert.equal(route.revocable, true);
    assert.equal(route.minDelayFrames, 1);
  }
  assert.equal(ROUTES['p1r0.intero.sntss-receptor'].requirement, 'GATED');
  assert.equal(Object.values(ROUTES).some(route => ['AUTON', 'CARD', 'RESP'].includes(route.producer)), false);
  assert.equal(Object.isFrozen(FORBIDDEN_EDGES), true);
  assert.throws(() => FORBIDDEN_EDGES.push('METAB->HOMEOS'), TypeError);
});

test('P1R0-FND-10 unknown and producer-mismatched routes fail before Envelope adaptation', () => {
  assert.throws(() => validateCausalFrame(frame({
    route: { ...frame().route, routeId: 'p1r0.unknown' }
  })), { code: 'P1_ROUTE_UNKNOWN' });
  assert.throws(() => validateCausalFrame(frame({
    producer: { ...frame().producer, coreId: 'sntss' }
  })), { code: 'P1_ROUTE_FORBIDDEN' });
});

test('P1R0-FND-11 producer identity is Kernel-bound and ancestry budgets remain frozen', () => {
  const sourceFrame = frame();
  assert.throws(() => toEnvelopeProposal(sourceFrame, {
    ...adapterOptions(sourceFrame),
    producerBinding: { ...adapterOptions(sourceFrame).producerBinding, authorityEpoch: '2' }
  }), { code: 'P1_FRAME_PRODUCER_BINDING' });
  assert.throws(() => toEnvelopeProposal(sourceFrame, {
    ...adapterOptions(sourceFrame),
    directParents: Array.from({ length: 5 }, () => `sha256:${'a'.repeat(64)}`)
  }), { code: 'P1_FRAME_ANCESTRY_REQUIRED' });
});

test('P1R0-FND-12 duplicate causal ancestry is rejected rather than double-counted', () => {
  const ancestor = {
    producerCoreId: 'metab',
    residencyId: 'resident:metab',
    topic: 'metab.energy.availability.v1',
    routeId: 'p1r0.metab-availability.homeos',
    producerSequence: '8',
    sourceWindow: { startFrame: 18, endFrame: 19 },
    mode: 'SHADOW',
    shadowAncestry: true,
    confidenceQ48: q48.SCALE.toString()
  };
  assert.throws(() => validateCausalFrame(frame({
    causalSpan: { ...frame().causalSpan, containsShadow: true, ancestors: [ancestor, { ...ancestor }] }
  })), { code: 'P1_FRAME_CAUSAL_SPAN' });
});

test('P1R0-FND-12b claimed P1 ancestry requires Kernel-resolved Envelope evidence', () => {
  const claimed = frame({
    causalSpan: { ...frame().causalSpan, containsShadow: true }
  });
  assert.throws(() => toEnvelopeProposal(claimed, adapterOptions(claimed)), { code: 'P1_FRAME_ANCESTRY_REQUIRED' });
  assert.doesNotThrow(() => toEnvelopeProposal(claimed, {
    ...adapterOptions(claimed),
    directParents: [`sha256:${'d'.repeat(64)}`]
  }));
});

test('P1R0-FND-13 causal windows and non-authoritative flags cannot be omitted', () => {
  const ancestor = {
    producerCoreId: 'METAB',
    residencyId: 'resident:metab',
    topic: 'metab.energy.reserve.v1',
    routeId: 'p1r0.metab-reserve.homeos',
    producerSequence: '8',
    sourceWindow: { startFrame: 19, endFrame: 20 },
    mode: 'SHADOW',
    shadowAncestry: false,
    confidenceQ48: q48.SCALE.toString()
  };
  assert.throws(() => validateCausalFrame(frame({
    causalSpan: {
      earliestFrame: 19,
      latestFrame: 20,
      containsNeutral: false,
      containsShadow: false,
      ancestors: [ancestor]
    }
  })), { code: 'P1_FRAME_AUTHORITY_LAUNDERING' });
  assert.throws(() => validateCausalFrame(frame({
    causalSpan: {
      earliestFrame: 20,
      latestFrame: 20,
      containsNeutral: false,
      containsShadow: true,
      ancestors: []
    }
  })), { code: 'P1_FRAME_CAUSAL_SPAN' });
  assert.throws(() => validateCausalFrame(frame({
    causalSpan: {
      earliestFrame: 19,
      latestFrame: 20,
      containsNeutral: false,
      containsShadow: true,
      ancestors: [{ ...ancestor, sourceWindow: { startFrame: 19, endFrame: 21 } }]
    }
  })), { code: 'P1_FRAME_CAUSAL_SPAN' });
});
