'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { stableStringify } = require('../runtime/kernel/canonical-json');
const { deriveAggregate } = require('../cores/chronobiology/c3/aggregate');
const { PROFILE } = require('../cores/chronobiology/c3/calibration-profile');
const {
  advanceTrustedTime,
  bindState,
  emptyState,
  initializeGenesis,
  normalizeState,
  normalizeTrustedTimeEvent,
} = require('../cores/chronobiology/c3/state');

function binding({ identity = 'a', revision = 1, epoch = 9, at = 1 } = {}) {
  return {
    id: `binding-${identity}-${revision}-${epoch}`,
    topic: 'runtime.organism.binding',
    at,
    payload: {
      bindingVersion: 1,
      identitySha256: `sha256:${identity.repeat(64)}`,
      organismLineage: 'STAY/Genesis',
      issuedAt: at,
      runtimeRevision: revision,
      authorityEpoch: epoch,
      kernelVersion: '0.8.11.3',
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: epoch },
  };
}

function trusted({ revision = 1, sequence = 1, timeUs = 10_000_000, epoch = 1, at = 1 } = {}) {
  return {
    id: `trusted-${revision}-${sequence}`,
    topic: 'runtime.trusted-organism-time.pulse',
    at,
    payload: {
      runtimeRevision: revision,
      pulseSequence: sequence,
      status: 'TRUSTED',
      trustedTimeUs: timeUs,
      continuityEpoch: epoch,
      reasonCode: null,
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 9 },
  };
}

function uncertain(sequence = 2) {
  return {
    id: `uncertain-${sequence}`,
    topic: 'runtime.trusted-organism-time.pulse',
    at: 999999,
    payload: {
      runtimeRevision: 1,
      pulseSequence: sequence,
      status: 'TRUSTED_TIME_UNCERTAIN',
      trustedTimeUs: null,
      continuityEpoch: null,
      reasonCode: 'TRUSTED_TIME_CONTINUITY_UNPROVEN',
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 9 },
  };
}

function genesis(event = trusted()) {
  return advanceTrustedTime(bindState(emptyState(), binding()), event);
}

test('CHR-C1-GEN-01 establishes one deterministic 64-unit founder phenotype', () => {
  const first = genesis();
  const retry = genesis();

  assert.equal(first.phenotype.oscillator_count, 64);
  assert.equal(first.phenotype.oscillators.length, 64);
  assert.equal(new Set(first.phenotype.oscillators.map(unit => unit.unit_id)).size, 64);
  assert.equal(stableStringify(first), stableStringify(retry));
  assert.equal(first.genesis.chronobiology_origin_time_us, 10_000_000);
  assert.equal(first.acquired.oscillators[0].phase_q,
    first.phenotype.oscillators[0].initial_phase_q);
});

test('CHR-C1-GEN-02 rejects a second genesis and corrupt founder state', () => {
  const state = genesis();
  const evidence = normalizeTrustedTimeEvent(trusted());
  assert.throws(() => initializeGenesis(state, evidence), {
    code: 'CHRONOBIOLOGY_SECOND_GENESIS',
  });

  const corrupt = structuredClone(state);
  corrupt.phenotype.oscillators[0].intrinsic_period_us += 1;
  assert.throws(() => normalizeState(corrupt), {
    code: 'CHRONOBIOLOGY_FOUNDER_CORRUPT',
  });
});

test('CHR-C1-TIME-01 wall clock cannot influence genesis or advancement', () => {
  const early = genesis(trusted({ at: 1 }));
  const late = genesis(trusted({ at: 9_999_999_999 }));
  assert.equal(stableStringify(early), stableStringify(late));

  const nextEarly = advanceTrustedTime(early, trusted({
    sequence: 2, timeUs: 70_000_000, at: 2,
  }));
  const nextLate = advanceTrustedTime(late, trusted({
    sequence: 2, timeUs: 70_000_000, at: 999_999_999_999,
  }));
  assert.equal(stableStringify(nextEarly), stableStringify(nextLate));
});

test('CHR-C1-TIME-02 duplicate evidence is exactly once and conflicts fail closed', () => {
  const state = genesis();
  assert.equal(stableStringify(advanceTrustedTime(state, trusted())), stableStringify(state));
  assert.throws(() => advanceTrustedTime(state, trusted({ timeUs: 10_000_001 })), {
    code: 'CHRONOBIOLOGY_TIME_CONFLICT',
  });
  assert.throws(() => advanceTrustedTime(state, trusted({
    revision: 0, sequence: 2, timeUs: 20_000_000,
  })), /trusted organism-time evidence is invalid/);
});

test('CHR-C1-TIME-03 uncertainty freezes physiology and trusted advance is endogenous', () => {
  const state = genesis();
  assert.equal(stableStringify(advanceTrustedTime(state, uncertain())), stableStringify(state));

  const advanced = advanceTrustedTime(state, trusted({
    sequence: 2,
    timeUs: 10_000_000 + PROFILE.integrationQuantumUs,
  }));
  assert.notEqual(stableStringify(advanced.acquired.oscillators),
    stableStringify(state.acquired.oscillators));
  assert.equal(advanced.continuity.committed_through_us,
    10_000_000 + PROFILE.integrationQuantumUs);
  assert.equal(deriveAggregate(advanced).model_version, PROFILE.modelVersion);
});

test('CHR-C1-GEN-03 genesis phase is biological state with no civil-time fields', () => {
  const state = genesis();
  const serialized = stableStringify(state);
  for (const forbidden of ['Date.now', 'wallClock', 'timezone', 'localTime', 'civil']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
