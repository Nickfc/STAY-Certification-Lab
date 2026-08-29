'use strict';

const { integrateCoarseFreeRun } = require('./coarse-free-run');

const DAY_US = 86_400_000_000;
const LONG_GAP_THRESHOLD_US = 30 * DAY_US;
const MAX_LONG_GAP_US = 2 * 365 * DAY_US;

function skipLongInterval(state, targetTimeUs, { evidenceGap = false } = {}) {
  const start = state.continuity.committed_through_us;
  const interval = targetTimeUs - start;
  if (!Number.isSafeInteger(targetTimeUs) || interval <= LONG_GAP_THRESHOLD_US
    || interval > MAX_LONG_GAP_US) {
    throw Object.assign(new Error('long-gap interval is outside its certified bound'), {
      code: 'CHRONOBIOLOGY_LONG_GAP_BOUND',
    });
  }

  const coarse = integrateCoarseFreeRun(state, interval);
  const current = coarse.state;
  const acquired = {
    ...current.acquired,
    photic_activation_q: 0,
  };
  if (evidenceGap) {
    acquired.cue_coverage_q = 0;
    acquired.phase_lock_summary = Object.freeze({ status: 'CUE_UNCERTAIN', strength_q: 0 });
    acquired.alignment_summary = Object.freeze({ status: 'CUE_UNCERTAIN', stability_q: 0 });
    acquired.evidence_gap_summary = Object.freeze({
      gap_count: current.acquired.evidence_gap_summary.gap_count + 1,
      unknown_duration_us:
        current.acquired.evidence_gap_summary.unknown_duration_us + interval,
    });
  }
  return Object.freeze({
    acquired: Object.freeze(acquired),
    steps: coarse.steps,
    coarse_integrated_us: interval,
  });
}

module.exports = {
  LONG_GAP_THRESHOLD_US,
  MAX_LONG_GAP_US,
  skipLongInterval,
};
