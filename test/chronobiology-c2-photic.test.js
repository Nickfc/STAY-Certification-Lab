'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { deriveAggregate } = require('../cores/chronobiology/c3/aggregate');
const {
  integrateEvidence,
  integrateFreeRun,
  integrateGap,
} = require('../cores/chronobiology/c3/entrainment');
const {
  Q31_ONE,
  signedPhaseDifference,
} = require('../cores/chronobiology/c3/fixed-point');
const { phaseResponseQ30 } = require('../cores/chronobiology/c3/phase-response');
const {
  normalizePhoticEvidence,
  saturationQ31,
} = require('../cores/chronobiology/c3/photic-transducer');
const {
  advanceTrustedTime,
  bindState,
  emptyState,
  queuePhoticEvidence,
} = require('../cores/chronobiology/c3/state');
const { createLaboratoryState } = require('../tools/chronobiology-convergence-lab');

const HOUR_US = 3_600_000_000;
const DAY_US = 24 * HOUR_US;

function evidence({
  id = 'light-1',
  fromUs = 0,
  toUs = 6 * HOUR_US,
  levelQ = Q31_ONE,
  qualityQ = Q31_ONE,
  coverageQ = Q31_ONE,
  completeness = 'COMPLETE',
} = {}) {
  const gap = completeness === 'GAP';
  return {
    id,
    topic: 'environment.photic.exposure',
    payload: {
      schema: 'environment.photic.exposure/v1',
      effective_from_us: fromUs,
      effective_to_us: toUs,
      broadband_level_q: gap ? null : levelQ,
      spectral_channels: {},
      source_quality_q: gap ? 0 : qualityQ,
      evidence_completeness: completeness,
      sample_count: gap ? 0 : 60,
      coverage_q: gap ? 0 : coverageQ,
    },
    meta: { sourceCore: 'laboratory-photic-source', authorityMode: 'lab' },
  };
}

function normalized(options) {
  return normalizePhoticEvidence(evidence(options));
}

function phasePrepared(phaseQ) {
  const state = structuredClone(createLaboratoryState());
  state.acquired.oscillators = state.acquired.oscillators.map(unit => ({
    ...unit, phase_q: phaseQ,
  }));
  state.phenotype.oscillators = state.phenotype.oscillators.map(unit => ({
    ...unit, intrinsic_period_us: 87_120_000_000,
  }));
  return state;
}

function binding() {
  return {
    id: 'photic-binding',
    topic: 'runtime.organism.binding',
    payload: {
      bindingVersion: 1,
      identitySha256: `sha256:${'d'.repeat(64)}`,
      organismLineage: 'STAY/Genesis',
      runtimeRevision: 1,
      authorityEpoch: 1,
      kernelVersion: '0.8.11.3',
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
  };
}

function pulse(sequence, timeUs) {
  return {
    id: `photic-pulse-${sequence}`,
    topic: 'runtime.trusted-organism-time.pulse',
    payload: {
      runtimeRevision: 1,
      pulseSequence: sequence,
      status: 'TRUSTED',
      trustedTimeUs: timeUs,
      continuityEpoch: 1,
      reasonCode: null,
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
  };
}

function routeCompleteness({ frontierUs, pendingEvidence = false, complete = true } = {}) {
  return {
    complete,
    unconstrained: false,
    configured: true,
    frontierUs: frontierUs ?? null,
    pendingEvidence,
    activeRoutes: [{
      routeId: 'route:lab-photic',
      producerStreamId: 'laboratory:photic',
      frontierUs: frontierUs ?? 0,
      progressId: `progress-${frontierUs ?? 0}`,
    }],
    blockers: complete ? [] : [{
      routeId: 'route:lab-photic', state: 'ACTIVE',
      reason: 'STREAM_PROGRESS_INCOMPLETE', routeBarrierUs: null,
    }],
    releasedRoutes: [],
  };
}

function withRoute(event, context) {
  return { ...event, meta: { ...(event.meta || {}), residentRouteCompleteness: context } };
}

test('C2-PHOT-01 cue at advance-sensitive phase produces bounded advance', () => {
  const state = phasePrepared(0x40000000);
  const free = integrateFreeRun(state, 6 * HOUR_US);
  const cued = integrateEvidence(state, normalized(), 6 * HOUR_US);
  const shift = signedPhaseDifference(
    deriveAggregate(cued).central_phase_q,
    deriveAggregate(free).central_phase_q,
  );
  assert.ok(shift > 0 && shift < 0x10000000);
});

test('C2-PHOT-02 same cue at delay-sensitive phase produces bounded delay', () => {
  const state = phasePrepared(0xc0000000);
  const free = integrateFreeRun(state, 6 * HOUR_US);
  const cued = integrateEvidence(state, normalized(), 6 * HOUR_US);
  const shift = signedPhaseDifference(
    deriveAggregate(cued).central_phase_q,
    deriveAggregate(free).central_phase_q,
  );
  assert.ok(shift < 0 && shift > -0x10000000);
});

test('C2-PHOT-03 continuous PRC has advance, delay and weak-response phases', () => {
  const founder = createLaboratoryState().phenotype.oscillators[0];
  assert.equal(phaseResponseQ30(founder, 0), 0);
  assert.ok(phaseResponseQ30(founder, 0x40000000) > 0);
  assert.ok(phaseResponseQ30(founder, 0xc0000000) < 0);
});

test('C2-PHOT-04 intensity response is nonlinear, monotonic and saturating', () => {
  const low = saturationQ31(Math.floor(Q31_ONE / 10));
  const medium = saturationQ31(Math.floor(Q31_ONE / 2));
  const high = saturationQ31(Q31_ONE);
  assert.ok(low > 0 && low < medium && medium < high && high < Q31_ONE);
  assert.ok(high - medium < medium - low);
});

test('C2-PHOT-05 adaptation persists across restart and reduces repeated response', () => {
  const first = integrateEvidence(createLaboratoryState(), normalized({ toUs: HOUR_US }), HOUR_US);
  const checkpoint = structuredClone(first);
  const second = integrateEvidence(checkpoint, normalized({
    id: 'light-2', fromUs: HOUR_US, toUs: 2 * HOUR_US,
  }), HOUR_US);
  const replay = integrateEvidence(structuredClone(first), normalized({
    id: 'light-2', fromUs: HOUR_US, toUs: 2 * HOUR_US,
  }), HOUR_US);
  assert.ok(second.acquired.photic_adaptation_q > first.acquired.photic_adaptation_q);
  assert.ok(second.acquired.photic_activation_q < first.acquired.photic_activation_q);
  assert.deepEqual(second, replay);
});

test('C2-PHOT-06 measured darkness differs physiologically from an evidence gap', () => {
  const adapted = integrateEvidence(createLaboratoryState(), normalized({ toUs: HOUR_US }), HOUR_US);
  const darkness = integrateEvidence(adapted, normalized({
    id: 'dark', fromUs: HOUR_US, toUs: 2 * HOUR_US, levelQ: 0,
  }), HOUR_US);
  const gap = integrateGap(adapted, HOUR_US);
  assert.equal(darkness.acquired.photic_activation_q, 0);
  assert.equal(gap.acquired.photic_activation_q, 0);
  assert.ok(darkness.acquired.photic_adaptation_q < adapted.acquired.photic_adaptation_q);
  assert.equal(gap.acquired.photic_adaptation_q, adapted.acquired.photic_adaptation_q);
  assert.equal(gap.acquired.phase_lock_summary.status, 'CUE_UNCERTAIN');
});

test('C2-PHOT-07 gap free-runs oscillator state while degrading cue quality', () => {
  const lit = integrateEvidence(createLaboratoryState(), normalized({ toUs: HOUR_US }), HOUR_US);
  const free = integrateFreeRun(lit, HOUR_US);
  const gap = integrateGap(lit, HOUR_US);
  assert.deepEqual(gap.acquired.oscillators, free.acquired.oscillators);
  assert.ok(gap.acquired.cue_coverage_q < lit.acquired.cue_coverage_q);
  assert.equal(gap.acquired.evidence_gap_summary.unknown_duration_us, HOUR_US);
});

test('C2-PHOT-08 stable recurring cues can produce an entrained summary', () => {
  let state = createLaboratoryState();
  let frontier = 0;
  for (let day = 0; day < 8; day += 1) {
    state = integrateEvidence(state, normalized({
      id: `stable-${day}`, fromUs: frontier, toUs: frontier + 6 * HOUR_US,
    }), 6 * HOUR_US);
    frontier += 6 * HOUR_US;
    state = integrateFreeRun(state, 18 * HOUR_US);
    frontier += 18 * HOUR_US;
  }
  assert.equal(state.acquired.phase_lock_summary.status, 'ENTRAINED');
  assert.ok(state.acquired.phase_lock_summary.strength_q > Math.floor(Q31_ONE * 3 / 4));
});

test('C2-PHOT-09 abrupt schedule shift causes gradual re-entrainment, never phase set', () => {
  let state = createLaboratoryState();
  let frontier = 0;
  for (let day = 0; day < 7; day += 1) {
    state = integrateEvidence(state, normalized({
      id: `pre-shift-${day}`, fromUs: frontier, toUs: frontier + 6 * HOUR_US,
    }), 6 * HOUR_US);
    frontier += DAY_US;
    state = integrateFreeRun(state, 18 * HOUR_US);
  }
  const before = deriveAggregate(state).central_phase_q;
  state = integrateFreeRun(state, 6 * HOUR_US);
  frontier += 6 * HOUR_US;
  state = integrateEvidence(state, normalized({
    id: 'shifted', fromUs: frontier, toUs: frontier + 6 * HOUR_US,
  }), 6 * HOUR_US);
  const after = deriveAggregate(state).central_phase_q;
  assert.equal(state.acquired.phase_lock_summary.status, 'REENTRAINING');
  assert.notEqual(after, before);
  assert.notEqual(after, 0x40000000);
});

test('C2-PHOT-10 chaotic cues remain bounded with bounded retained history', () => {
  let state = createLaboratoryState();
  let frontier = 0;
  for (let index = 0; index < 80; index += 1) {
    const duration = (index % 3 + 1) * HOUR_US;
    state = integrateEvidence(state, normalized({
      id: `chaotic-${index}`,
      fromUs: frontier,
      toUs: frontier + duration,
      levelQ: Math.floor(Q31_ONE * ((index % 7) + 1) / 8),
      qualityQ: Math.floor(Q31_ONE * ((index % 5) + 1) / 6),
      completeness: index % 11 === 0 ? 'PARTIAL' : 'COMPLETE',
    }), duration);
    frontier += duration;
  }
  assert.equal(state.acquired.bounded_entrainment_history.length, 64);
  for (const unit of state.acquired.oscillators) {
    assert.ok(unit.phase_q >= 0 && unit.phase_q <= 0xffffffff);
    assert.ok(unit.amplitude_q >= 0 && unit.amplitude_q <= Q31_ONE);
  }
});

test('C2-PHOT-11 malformed and untrusted evidence is rejected before state change', () => {
  assert.throws(() => normalizePhoticEvidence({
    ...evidence(), meta: { sourceCore: 'laboratory-photic-source', authorityMode: 'authoritative' },
  }), { code: 'CHRONOBIOLOGY_PHOTIC_EVIDENCE_INVALID' });
  assert.throws(() => normalizePhoticEvidence(evidence({ toUs: 0 })),
    { code: 'CHRONOBIOLOGY_PHOTIC_EVIDENCE_INVALID' });
  const inventedGap = evidence({ completeness: 'GAP' });
  inventedGap.payload.broadband_level_q = Q31_ONE;
  assert.throws(() => normalizePhoticEvidence(inventedGap),
    { code: 'CHRONOBIOLOGY_PHOTIC_EVIDENCE_INVALID' });
});

test('C2-PHOT-12 photic evidence waits for Kernel trusted time before physiology advances', () => {
  let state = advanceTrustedTime(bindState(emptyState(), binding()), pulse(1, 0));
  const before = structuredClone(state.acquired.oscillators);
  state = queuePhoticEvidence(state, evidence({ toUs: HOUR_US }));
  assert.deepEqual(state.acquired.oscillators, before);
  assert.equal(state.continuity.pending_photic_evidence.length, 1);
  state = advanceTrustedTime(state, pulse(2, HOUR_US));
  assert.equal(state.continuity.pending_photic_evidence.length, 0);
  assert.equal(state.continuity.committed_through_us, HOUR_US);
  assert.notDeepEqual(state.acquired.oscillators, before);
  assert.equal(state.acquired.bounded_entrainment_history.length, 1);
});

test('C2-PHOT-13 cue flood is bounded and exact queued duplicates are idempotent', () => {
  let state = advanceTrustedTime(bindState(emptyState(), binding()), pulse(1, 0));
  const first = evidence({ id: 'bounded-0', fromUs: 0, toUs: 60_000_000 });
  state = queuePhoticEvidence(state, first);
  assert.deepEqual(queuePhoticEvidence(state, first), state);
  const conflicting = structuredClone(first);
  conflicting.payload.broadband_level_q -= 1;
  assert.throws(() => queuePhoticEvidence(state, conflicting), {
    code: 'CHRONOBIOLOGY_PHOTIC_CONFLICT',
  });
  for (let index = 1; index < 64; index += 1) {
    state = queuePhoticEvidence(state, evidence({
      id: `bounded-${index}`,
      fromUs: index * 60_000_000,
      toUs: (index + 1) * 60_000_000,
    }));
  }
  assert.equal(state.continuity.pending_photic_evidence.length, 64);
  assert.throws(() => queuePhoticEvidence(state, evidence({
    id: 'bounded-overflow',
    fromUs: 64 * 60_000_000,
    toUs: 65 * 60_000_000,
  })), { code: 'CHRONOBIOLOGY_PHOTIC_BACKPRESSURE' });
});

test('C2-PHOT-14 trusted time cannot pass a required photic finalization frontier', () => {
  let state = bindState(emptyState(), binding());
  state = advanceTrustedTime(state, pulse(1, 0));
  state = advanceTrustedTime(state, withRoute(
    pulse(2, 6 * HOUR_US),
    routeCompleteness({ frontierUs: 3 * HOUR_US }),
  ));
  assert.equal(state.continuity.committed_through_us, 0);
  assert.equal(state.continuity.deferred_trusted_time_evidence.trusted_time_us, 6 * HOUR_US);
  assert.equal(state.continuity.photic_route_configured, true);
});

test('C2-PHOT-15 late-accepted route evidence is applied before deferred trusted advance', async () => {
  const outputs = [];
  const { createCore } = require('../cores/chronobiology/c3');
  const core = await createCore({ emit: async (_topic, payload) => outputs.push(payload) });
  await core.handle(binding());
  await core.handle(pulse(1, 0));
  await core.handle(withRoute(
    pulse(2, 6 * HOUR_US),
    routeCompleteness({ frontierUs: 6 * HOUR_US, pendingEvidence: true }),
  ));
  assert.equal((await core.snapshot()).continuity.committed_through_us, 0);

  await core.handle(withRoute(
    evidence({ id: 'late-accepted', fromUs: 0, toUs: 6 * HOUR_US }),
    routeCompleteness({ frontierUs: 6 * HOUR_US, pendingEvidence: false }),
  ));
  const recovered = await core.snapshot();
  assert.equal(recovered.continuity.committed_through_us, 6 * HOUR_US);
  assert.equal(recovered.continuity.deferred_trusted_time_evidence, null);
  assert.equal(recovered.continuity.pending_photic_evidence.length, 0);
  assert.ok(recovered.acquired.cue_coverage_q > 0);
});

test('C2-PHOT-16 evidence behind a genuinely committed finalized frontier fails closed', () => {
  let state = bindState(emptyState(), binding());
  state = advanceTrustedTime(state, pulse(1, 0));
  state = advanceTrustedTime(state, withRoute(
    pulse(2, 6 * HOUR_US),
    routeCompleteness({ frontierUs: 6 * HOUR_US }),
  ));
  assert.throws(() => queuePhoticEvidence(state,
    evidence({ id: 'impossible-late', fromUs: 0, toUs: HOUR_US })), {
    code: 'CHRONOBIOLOGY_PHOTIC_LATE',
  });
});
