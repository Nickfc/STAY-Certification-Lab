'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { deriveAggregate } = require('../cores/chronobiology/c3/aggregate');
const { integrateEvidencePlan } = require('../cores/chronobiology/c3/entrainment');
const { MAX_LONG_GAP_US } = require('../cores/chronobiology/c3/long-gap');
const {
  advanceTrustedTime,
  bindState,
  emptyState,
  normalizeState,
  queuePhoticEvidence,
} = require('../cores/chronobiology/c3/state');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const {
  QUANTUM_TOLERANCE,
  macroDifference,
  withinTolerance,
} = require('../tools/chronobiology-convergence-lab');

const DAY_US = 86_400_000_000;

function binding() {
  return {
    id: 'persistence-binding',
    topic: 'runtime.organism.binding',
    payload: {
      bindingVersion: 1,
      identitySha256: `sha256:${'f'.repeat(64)}`,
      organismLineage: 'STAY/Genesis',
      runtimeRevision: 1,
      authorityEpoch: 1,
      kernelVersion: '0.8.11.3',
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
  };
}

function pulse(sequence, trustedTimeUs) {
  return {
    id: `persistence-pulse-${sequence}`,
    topic: 'runtime.trusted-organism-time.pulse',
    payload: {
      runtimeRevision: 1,
      pulseSequence: sequence,
      status: 'TRUSTED',
      trustedTimeUs,
      continuityEpoch: 1,
      reasonCode: null,
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
  };
}

function light(id, levelQ = 1_000_000_000) {
  return {
    id,
    topic: 'environment.photic.exposure',
    payload: {
      schema: 'environment.photic.exposure/v1',
      effective_from_us: 0,
      effective_to_us: 3_600_000_000,
      broadband_level_q: levelQ,
      spectral_channels: {},
      source_quality_q: 2_000_000_000,
      evidence_completeness: 'COMPLETE',
      sample_count: 60,
      coverage_q: 2_000_000_000,
    },
    meta: { sourceCore: 'laboratory-photic-source', authorityMode: 'lab' },
  };
}

function genesis() {
  return advanceTrustedTime(bindState(emptyState(), binding()), pulse(1, 0));
}

test('C2-PERS-01 founder, oscillator and adaptation checkpoint restart byte-identically', () => {
  let state = queuePhoticEvidence(genesis(), light('persistent-light'));
  state = advanceTrustedTime(state, pulse(2, 3_600_000_000));
  const restored = normalizeState(structuredClone(state));
  assert.equal(stableStringify(restored), stableStringify(state));
  assert.ok(restored.acquired.photic_adaptation_q > 0);
  assert.equal(restored.genesis.phenotype_hash, state.genesis.phenotype_hash);
});

test('C2-PERS-02 exact consumed photic duplicate is idempotent and conflict fails closed', () => {
  const event = light('consumed-light');
  let state = queuePhoticEvidence(genesis(), event);
  state = advanceTrustedTime(state, pulse(2, 3_600_000_000));
  assert.equal(state.continuity.recent_photic_evidence.length, 1);
  assert.equal(stableStringify(queuePhoticEvidence(state, event)), stableStringify(state));
  assert.throws(() => queuePhoticEvidence(state, light('consumed-light', 999_999_999)), {
    code: 'CHRONOBIOLOGY_PHOTIC_CONFLICT',
  });
});

test('C2-PERS-03 pre-photic schema-v1 checkpoint upgrades deterministically without reroll', () => {
  const original = genesis();
  const legacy = structuredClone(original);
  delete legacy.continuity.photic_route_configured;
  delete legacy.continuity.pending_photic_evidence;
  delete legacy.continuity.recent_photic_evidence;
  const upgraded = normalizeState(legacy);
  assert.equal(upgraded.genesis.phenotype_hash, original.genesis.phenotype_hash);
  assert.deepEqual(upgraded.continuity.pending_photic_evidence, []);
  assert.deepEqual(upgraded.continuity.recent_photic_evidence, []);
  assert.equal(upgraded.continuity.photic_route_configured, false);
});

test('C2-PERS-04 corrupt oscillator never local-rerolls or interpolates', () => {
  const corrupt = structuredClone(genesis());
  corrupt.acquired.oscillators[7].phase_q = -1;
  assert.throws(() => normalizeState(corrupt), {
    code: 'CHRONOBIOLOGY_STATE_INVALID',
  });
});

test('C2-PERS-05 bounded coarse long-gap matches canonical 60-second macro physiology', () => {
  const state = genesis();
  const target = 90 * DAY_US;
  const exact = integrateEvidencePlan(state, target);
  const coarse = advanceTrustedTime(state, pulse(2, target));
  const exactState = { ...state, acquired: exact.acquired };
  const difference = macroDifference(exactState, coarse);
  assert.equal(withinTolerance(difference, QUANTUM_TOLERANCE), true,
    `long-gap divergence ${JSON.stringify(difference)}`);
  assert.equal(coarse.continuity.committed_through_us, target);
  assert.notEqual(deriveAggregate(coarse).central_phase_q, null);
});

test('C2-PERS-06 long-gap path is deterministic, bounded and rejects uncertified span', () => {
  const state = genesis();
  const target = 365 * DAY_US;
  const left = advanceTrustedTime(state, pulse(2, target));
  const right = advanceTrustedTime(state, pulse(2, target));
  assert.equal(stableStringify(left), stableStringify(right));
  assert.throws(() => advanceTrustedTime(state, pulse(2, MAX_LONG_GAP_US + DAY_US)), {
    code: 'CHRONOBIOLOGY_LONG_GAP_BOUND',
  });
});

test('C2-PERS-07 corrupt founder seed/hash fails closed rather than generating replacement', () => {
  const corrupt = structuredClone(genesis());
  corrupt.genesis.founder_seed_hex = '0'.repeat(64);
  assert.throws(() => normalizeState(corrupt), {
    code: 'CHRONOBIOLOGY_FOUNDER_CORRUPT',
  });
});
