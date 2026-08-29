'use strict';

const { deriveAggregate } = require('./aggregate');

const SUMMARY_TOPIC = 'chronobiology.phase.summary';
const SUMMARY_MODE = 'SHADOW';
const SUMMARY_CADENCE_US = 900_000_000;

function shouldEmitPhaseSummary(state) {
  if (!state?.genesis || !state?.continuity) return false;
  const last = state.continuity.last_summary_emitted_us;
  return last === null
    || state.continuity.committed_through_us - last >= SUMMARY_CADENCE_US;
}

function buildPhaseSummary(state) {
  const aggregate = deriveAggregate(state);
  return Object.freeze({
    schema: 'chronobiology.phase-summary/v1',
    mode: SUMMARY_MODE,
    central_phase_q: aggregate.central_phase_q,
    phase_resolvability_q: aggregate.phase_resolvability_q,
    effective_period_us: aggregate.effective_period_us,
    oscillator_coherence_q: aggregate.oscillator_coherence_q,
    rhythm_amplitude_q: aggregate.rhythm_amplitude_q,
    entrainment_strength_q: aggregate.entrainment_strength_q,
    cue_coverage_q: aggregate.cue_coverage_q,
    alignment_stability_q: aggregate.alignment_stability_q,
    phase_velocity_q: aggregate.phase_velocity_q,
    evidence_quality: aggregate.evidence_quality,
    model_version: aggregate.model_version,
    calibration_profile_id: aggregate.calibration_profile_id,
  });
}

module.exports = {
  SUMMARY_CADENCE_US,
  SUMMARY_MODE,
  SUMMARY_TOPIC,
  buildPhaseSummary,
  shouldEmitPhaseSummary,
};
