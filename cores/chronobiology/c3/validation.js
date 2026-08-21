'use strict';

const {
  stableStringify,
} = require('../../../runtime/kernel/canonical-json');

const { PROFILE } = require('./calibration-profile');
const { PHOTIC_PROFILE } = require('./photic-calibration-profile');
const {
  ENGINE_VERSION,
  Q31_ONE,
  TRIG_TABLE_HASH,
} = require('./fixed-point');
const {
  GENERATOR_VERSION,
  expandPhenotype,
  sha256,
} = require('./founder');

const STATE_SCHEMA = 'chronobiology.state/v1';
const HASH = /^sha256:[0-9a-f]{64}$/;

function fail(message, code = 'CHRONOBIOLOGY_STATE_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} is outside its canonical range`);
  }
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || !value || value.length > 256) {
    fail(`${label} is invalid`);
  }
  return value;
}

function validateBinding(binding) {
  if (binding === null) return;
  object(binding, 'organism binding');
  text(binding.organism_id, 'binding organism id');
  text(binding.organism_lineage, 'binding organism lineage');
  text(binding.kernel_version, 'binding Kernel version');
  integer(binding.runtime_revision, 'binding runtime revision', 1);
  integer(binding.kernel_authority_epoch, 'binding Kernel authority epoch', 1);
  if (!HASH.test(binding.organism_id)) fail('binding organism identity is not hash-bound');
}

function validatePhenotype(state) {
  const { genesis, phenotype, acquired } = state;
  object(genesis, 'genesis');
  object(phenotype, 'phenotype');
  object(acquired, 'acquired physiology');

  text(genesis.organism_id, 'genesis organism id');
  text(genesis.lineage_id, 'genesis lineage');
  integer(genesis.chronobiology_origin_time_us, 'genesis origin time');
  text(genesis.species_template_id, 'species template');
  if (genesis.phenotype_generator_version !== GENERATOR_VERSION) {
    fail('founder generator version is unsupported', 'CHRONOBIOLOGY_VERSION_UNSUPPORTED');
  }
  if (typeof genesis.founder_seed_hex !== 'string'
    || !/^[0-9a-f]{64}$/.test(genesis.founder_seed_hex)) {
    fail('founder seed is corrupt');
  }
  if (genesis.founder_seed_hash !== sha256(genesis.founder_seed_hex)) {
    fail('founder seed hash mismatch', 'CHRONOBIOLOGY_FOUNDER_CORRUPT');
  }
  if (!HASH.test(genesis.phenotype_hash)) fail('phenotype hash is invalid');

  if (phenotype.oscillator_count !== PROFILE.oscillatorCount
    || !Array.isArray(phenotype.oscillators)
    || phenotype.oscillators.length !== PROFILE.oscillatorCount
    || !Array.isArray(acquired.oscillators)
    || acquired.oscillators.length !== PROFILE.oscillatorCount) {
    fail('oscillator population resolution is invalid');
  }
  if (phenotype.numerical_engine_version !== ENGINE_VERSION
    || phenotype.trig_table_hash !== TRIG_TABLE_HASH
    || phenotype.calibration_profile_id !== PROFILE.id
    || phenotype.model_version !== PROFILE.modelVersion) {
    fail('state model or numerical profile is unsupported', 'CHRONOBIOLOGY_VERSION_UNSUPPORTED');
  }

  const ids = new Set();
  for (let unitId = 0; unitId < PROFILE.oscillatorCount; unitId += 1) {
    const founder = object(phenotype.oscillators[unitId], 'founder oscillator');
    const current = object(acquired.oscillators[unitId], 'acquired oscillator');
    integer(founder.unit_id, 'founder unit id', 0, PROFILE.oscillatorCount - 1);
    if (ids.has(founder.unit_id) || founder.unit_id !== unitId
      || current.unit_id !== founder.unit_id) {
      fail('oscillator identity is duplicated or reordered');
    }
    ids.add(founder.unit_id);
    integer(founder.intrinsic_period_us, 'intrinsic period', 1);
    integer(founder.baseline_amplitude_q, 'baseline amplitude', 0, Q31_ONE);
    integer(founder.amplitude_recovery_q, 'amplitude recovery', 0, Q31_ONE);
    integer(founder.coupling_sensitivity_q, 'coupling sensitivity', 0, (1 << 30) * 2 - 1);
    integer(founder.photic_sensitivity_q, 'photic sensitivity', 0, (1 << 30) * 2 - 1);
    integer(founder.initial_phase_q, 'founder phase', 0, 0xffffffff);
    integer(current.phase_q, 'acquired phase', 0, 0xffffffff);
    integer(current.amplitude_q, 'acquired amplitude', 0, Q31_ONE);
  }

  const graph = object(phenotype.coupling_graph, 'coupling graph');
  if (!Array.isArray(graph.edges) || graph.edges.length < PROFILE.oscillatorCount) {
    fail('coupling graph is incomplete');
  }
  const edges = new Set();
  for (const edge of graph.edges) {
    object(edge, 'coupling edge');
    integer(edge.left_unit_id, 'edge left id', 0, PROFILE.oscillatorCount - 1);
    integer(edge.right_unit_id, 'edge right id', 0, PROFILE.oscillatorCount - 1);
    integer(edge.weight_q30, 'edge weight', 1, (1 << 30) * 2 - 1);
    if (edge.left_unit_id >= edge.right_unit_id) fail('coupling edge is not canonical');
    const key = `${edge.left_unit_id}:${edge.right_unit_id}`;
    if (edges.has(key)) fail('coupling graph contains a duplicate edge');
    edges.add(key);
  }

  const actualHash = sha256(stableStringify(phenotype));
  if (actualHash !== genesis.phenotype_hash) {
    fail('expanded founder phenotype hash mismatch', 'CHRONOBIOLOGY_FOUNDER_CORRUPT');
  }
  const reconstructed = expandPhenotype(genesis.founder_seed_hex);
  if (reconstructed.phenotypeHash !== genesis.phenotype_hash
    || stableStringify(reconstructed.phenotype) !== stableStringify(phenotype)) {
    fail('founder phenotype cannot be reconstructed exactly', 'CHRONOBIOLOGY_FOUNDER_CORRUPT');
  }

  for (const [field, value] of [
    ['photic activation', acquired.photic_activation_q],
    ['photic adaptation', acquired.photic_adaptation_q],
    ['cue coverage', acquired.cue_coverage_q],
  ]) integer(value, field, 0, Q31_ONE);
  object(acquired.phase_lock_summary, 'phase lock summary');
  object(acquired.alignment_summary, 'alignment summary');
  integer(acquired.phase_lock_summary.strength_q, 'phase lock strength', 0, Q31_ONE);
  integer(acquired.alignment_summary.stability_q, 'alignment stability', 0, Q31_ONE);
  if (!Array.isArray(acquired.bounded_entrainment_history)
    || acquired.bounded_entrainment_history.length > PROFILE.entrainmentHistoryCapacity) {
    fail('entrainment history exceeds its bound');
  }
  object(acquired.evidence_gap_summary, 'evidence gap summary');
}

function validateContinuity(state) {
  const continuity = object(state.continuity, 'continuity');
  integer(continuity.committed_through_us, 'committed trusted frontier');
  integer(continuity.last_trusted_pulse_sequence, 'trusted pulse sequence', 1);
  integer(continuity.last_runtime_revision, 'runtime revision', 1);
  integer(continuity.trusted_time_continuity_epoch, 'trusted continuity epoch', 1);
  if (!HASH.test(continuity.last_trusted_evidence_hash)) {
    fail('trusted evidence hash is invalid');
  }
  object(continuity.consumed_stream_cursors, 'consumed stream cursors');
  object(continuity.input_route_states, 'input route states');
  const summaryTime = continuity.last_summary_emitted_us;
  const summaryHash = continuity.last_summary_payload_hash;
  if ((summaryTime === null) !== (summaryHash === null)) {
    fail('summary continuity fields are incomplete');
  }
  if (summaryTime !== null) {
    integer(summaryTime, 'last summary frontier', 0, continuity.committed_through_us);
    if (!HASH.test(summaryHash)) fail('last summary payload hash is invalid');
  }
  if (typeof continuity.photic_route_configured !== 'boolean'
    || !Array.isArray(continuity.pending_photic_evidence)
    || continuity.pending_photic_evidence.length > PHOTIC_PROFILE.evidenceCapacity
    || !Array.isArray(continuity.recent_photic_evidence)
    || continuity.recent_photic_evidence.length > PHOTIC_PROFILE.evidenceCapacity) {
    fail('pending photic evidence is outside its durable bound');
  }
  let previousEnd = continuity.committed_through_us;
  const eventIds = new Set();
  for (const evidence of continuity.pending_photic_evidence) {
    object(evidence, 'pending photic evidence');
    text(evidence.event_id, 'photic event id');
    if (!HASH.test(evidence.evidence_hash)) fail('pending photic evidence hash is invalid');
    integer(evidence.effective_from_us, 'photic evidence start', previousEnd);
    integer(evidence.effective_to_us, 'photic evidence end', evidence.effective_from_us + 1);
    if (eventIds.has(evidence.event_id) || evidence.effective_from_us < previousEnd) {
      fail('pending photic evidence overlaps or duplicates identity');
    }
    eventIds.add(evidence.event_id);
    previousEnd = evidence.effective_to_us;
  }
  for (const evidence of continuity.recent_photic_evidence) {
    object(evidence, 'recent photic evidence identity');
    text(evidence.event_id, 'recent photic event id');
    if (!HASH.test(evidence.evidence_hash)) fail('recent photic evidence hash is invalid');
  }
  if (continuity.state_schema_version !== 1) {
    fail('state schema is unsupported', 'CHRONOBIOLOGY_VERSION_UNSUPPORTED');
  }
  if (continuity.committed_through_us < state.genesis.chronobiology_origin_time_us) {
    fail('trusted frontier precedes genesis');
  }
}

function validateState(input) {
  const state = object(input, 'Chronobiology state');
  if (state.schema !== STATE_SCHEMA || state.mode !== 'NEUTRAL') {
    fail('state header is invalid');
  }
  validateBinding(state.binding);
  const absent = state.genesis === null && state.phenotype === null
    && state.acquired === null && state.continuity === null;
  if (absent) return state;
  if (state.genesis === null || state.phenotype === null
    || state.acquired === null || state.continuity === null) {
    fail('partial genesis state is forbidden');
  }
  if (!state.binding || state.genesis.organism_id !== state.binding.organism_id) {
    fail('genesis does not match Kernel-bound organism identity');
  }
  validatePhenotype(state);
  validateContinuity(state);
  return state;
}

module.exports = {
  STATE_SCHEMA,
  fail,
  integer,
  object,
  text,
  validateState,
};
