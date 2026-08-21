'use strict';

const crypto = require('node:crypto');

const {
  stableStringify,
} = require('../../../runtime/kernel/canonical-json');

const { PROFILE } = require('./calibration-profile');
const {
  ENGINE_VERSION,
  Q30_ONE,
  Q31_ONE,
  TRIG_TABLE_HASH,
  wrapPhase,
} = require('./fixed-point');

const GENERATOR_VERSION = 'chronobiology-founder-splitmix64-v1';
const SPECIES_TEMPLATE_ID = 'stay.synthetic-circadian.v1';
const LINEAGE_ID = 'chronobiology:central:v1';
const SEED_HEX = /^[0-9a-f]{64}$/;
const MASK_64 = (1n << 64n) - 1n;

function fail(message, code = 'CHRONOBIOLOGY_GENESIS_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function deriveFounderSeed({
  organismId,
  trustedTimeUs,
  runtimeRevision,
  pulseSequence,
  continuityEpoch,
}) {
  return crypto.createHash('sha256').update(stableStringify({
    domain: 'STAY/Chronobiology/founder/v1',
    organism_id: organismId,
    trusted_time_us: trustedTimeUs,
    runtime_revision: runtimeRevision,
    pulse_sequence: pulseSequence,
    continuity_epoch: continuityEpoch,
  })).digest('hex');
}

function seedState(seedHex) {
  if (typeof seedHex !== 'string' || !SEED_HEX.test(seedHex)) {
    fail('founder seed must be 256 canonical bits');
  }
  let state = 0n;
  for (let offset = 0; offset < 64; offset += 16) {
    state ^= BigInt(`0x${seedHex.slice(offset, offset + 16)}`);
  }
  return state & MASK_64;
}

function createPrng(seedHex) {
  let state = seedState(seedHex);

  function nextU64() {
    state = (state + 0x9e3779b97f4a7c15n) & MASK_64;
    let value = state;
    value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
    value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
    return (value ^ (value >> 31n)) & MASK_64;
  }

  function range(maximumExclusive) {
    if (!Number.isSafeInteger(maximumExclusive) || maximumExclusive < 1) {
      fail('founder PRNG range is invalid');
    }
    const limit = BigInt(maximumExclusive);
    const rejection = (1n << 64n) % limit;
    for (;;) {
      const value = nextU64();
      if (value >= rejection) return Number(value % limit);
    }
  }

  function signed(halfRange) {
    if (!Number.isSafeInteger(halfRange) || halfRange < 0) {
      fail('founder signed range is invalid');
    }
    return range(halfRange * 2 + 1) - halfRange;
  }

  return Object.freeze({ nextU64, range, signed });
}

function canonicalEdge(left, right, weightQ30, kind) {
  const first = Math.min(left, right);
  const second = Math.max(left, right);
  if (first === second) fail('founder graph contains a self-edge');
  return Object.freeze({
    left_unit_id: first,
    right_unit_id: second,
    weight_q30: weightQ30,
    kind,
  });
}

function createCouplingGraph(prng, count = PROFILE.oscillatorCount) {
  const edges = [];
  const seen = new Set();

  function add(left, right, weightQ30, kind) {
    const edge = canonicalEdge(left, right, weightQ30, kind);
    const key = `${edge.left_unit_id}:${edge.right_unit_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  }

  for (let unit = 0; unit < count; unit += 1) {
    add(unit, (unit + 1) % count, PROFILE.localEdgeWeightQ30, 'local-1');
    add(unit, (unit + 2) % count, PROFILE.localEdgeWeightQ30, 'local-2');
  }

  const offsets = [7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31]
    .filter(offset => offset < count / 2);
  if (offsets.length === 0) fail('laboratory resolution cannot form long-range edges');
  const chordOffset = offsets[prng.range(offsets.length)];
  for (let unit = 0; unit < count; unit += 1) {
    add(
      unit,
      (unit + chordOffset) % count,
      PROFILE.longRangeEdgeWeightMinimumQ30
        + prng.range(PROFILE.longRangeEdgeWeightRangeQ30 + 1),
      'founder-long-range',
    );
  }

  edges.sort((left, right) =>
    left.left_unit_id - right.left_unit_id
      || left.right_unit_id - right.right_unit_id);

  return Object.freeze({
    generator_version: 'small-world-ring-chord-v1',
    chord_offset: chordOffset,
    edges: Object.freeze(edges),
  });
}

function expandPhenotype(seedHex, { oscillatorCount = PROFILE.oscillatorCount } = {}) {
  if (!Number.isSafeInteger(oscillatorCount) || oscillatorCount < 16
    || oscillatorCount > 256 || oscillatorCount % 2 !== 0) {
    fail('oscillator resolution is outside the bounded laboratory range');
  }
  const prng = createPrng(seedHex);
  const oscillators = [];

  for (let pair = 0; pair < oscillatorCount / 2; pair += 1) {
    const periodDelta = prng.range(PROFILE.intrinsicPeriodHalfRangeUs + 1);
    const baselineAmplitude = PROFILE.baselineAmplitudeMinimumQ31
      + prng.range(PROFILE.baselineAmplitudeRangeQ31 + 1);
    const amplitudeRecovery = PROFILE.amplitudeRecoveryMinimumQ31
      + prng.range(PROFILE.amplitudeRecoveryRangeQ31 + 1);
    const couplingSensitivity = PROFILE.couplingSensitivityMinimumQ30
      + prng.range(PROFILE.couplingSensitivityRangeQ30 + 1);
    const photicSensitivity = PROFILE.photicSensitivityMinimumQ30
      + prng.range(PROFILE.photicSensitivityRangeQ30 + 1);
    const phaseDelta = prng.range(PROFILE.initialPhaseHalfRangeQ + 1);

    for (const sign of [-1, 1]) {
      const unitId = oscillators.length;
      oscillators.push(Object.freeze({
        unit_id: unitId,
        intrinsic_period_us: PROFILE.intrinsicPeriodMeanUs + sign * periodDelta,
        baseline_amplitude_q: baselineAmplitude,
        amplitude_recovery_q: amplitudeRecovery,
        coupling_sensitivity_q: couplingSensitivity,
        photic_sensitivity_q: photicSensitivity,
        initial_phase_q: wrapPhase(sign * phaseDelta),
        prc_profile: Object.freeze({
          id: 'continuous-harmonic-prc-v1',
          primary_q30: Q30_ONE,
          secondary_q30: Q30_ONE >> 2,
        }),
      }));
    }
  }

  const phenotype = Object.freeze({
    oscillator_count: oscillatorCount,
    oscillators: Object.freeze(oscillators),
    coupling_graph: createCouplingGraph(prng, oscillatorCount),
    numerical_engine_version: ENGINE_VERSION,
    trig_table_hash: TRIG_TABLE_HASH,
    calibration_profile_id: PROFILE.id,
    model_version: PROFILE.modelVersion,
  });

  return Object.freeze({
    phenotype,
    phenotypeHash: sha256(stableStringify(phenotype)),
  });
}

function createFounderState({
  organismId,
  trustedTimeUs,
  runtimeRevision,
  pulseSequence,
  continuityEpoch,
  founderSeedHex,
}) {
  if (typeof organismId !== 'string' || !organismId) {
    fail('Kernel-bound organism identity is missing');
  }
  for (const [label, value, minimum] of [
    ['trusted genesis time', trustedTimeUs, 0],
    ['runtime revision', runtimeRevision, 1],
    ['trusted pulse sequence', pulseSequence, 1],
    ['continuity epoch', continuityEpoch, 1],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`);
  }

  const seed = founderSeedHex || deriveFounderSeed({
    organismId,
    trustedTimeUs,
    runtimeRevision,
    pulseSequence,
    continuityEpoch,
  });

  const { phenotype, phenotypeHash } = expandPhenotype(seed);
  const acquiredOscillators = phenotype.oscillators.map(unit => Object.freeze({
    unit_id: unit.unit_id,
    phase_q: unit.initial_phase_q,
    amplitude_q: Math.min(Q31_ONE, unit.baseline_amplitude_q),
  }));

  return Object.freeze({
    genesis: Object.freeze({
      organism_id: organismId,
      lineage_id: LINEAGE_ID,
      chronobiology_origin_time_us: trustedTimeUs,
      species_template_id: SPECIES_TEMPLATE_ID,
      phenotype_generator_version: GENERATOR_VERSION,
      founder_seed_hex: seed,
      founder_seed_hash: sha256(seed),
      phenotype_hash: phenotypeHash,
    }),
    phenotype,
    acquired: Object.freeze({
      oscillators: Object.freeze(acquiredOscillators),
      photic_activation_q: 0,
      photic_adaptation_q: 0,
      cue_coverage_q: 0,
      phase_lock_summary: Object.freeze({ status: 'UNKNOWN', strength_q: 0 }),
      alignment_summary: Object.freeze({ status: 'UNKNOWN', stability_q: 0 }),
      bounded_entrainment_history: Object.freeze([]),
      aggregate_phase_history: Object.freeze([]),
      evidence_gap_summary: Object.freeze({ gap_count: 0, unknown_duration_us: 0 }),
    }),
    continuity: Object.freeze({
      committed_through_us: trustedTimeUs,
      last_trusted_pulse_sequence: pulseSequence,
      last_runtime_revision: runtimeRevision,
      trusted_time_continuity_epoch: continuityEpoch,
      last_trusted_evidence_hash: null,
      consumed_stream_cursors: Object.freeze({}),
      input_route_states: Object.freeze({}),
      state_schema_version: 1,
    }),
  });
}

module.exports = {
  GENERATOR_VERSION,
  LINEAGE_ID,
  SPECIES_TEMPLATE_ID,
  createFounderState,
  createCouplingGraph,
  createPrng,
  deriveFounderSeed,
  expandPhenotype,
  sha256,
};
