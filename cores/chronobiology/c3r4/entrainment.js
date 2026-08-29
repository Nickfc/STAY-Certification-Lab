'use strict';

const { deriveAggregate } = require('./aggregate');
const { PROFILE } = require('./calibration-profile');
const {
  Q31_ONE,
  clamp,
  roundDivide,
  signedPhaseDifference,
  wrapPhase,
} = require('./fixed-point');
const { integratePopulationDuration, stepPopulation } = require('./oscillator');
const { photicPhaseAdjustment } = require('./phase-response');
const { stepEvidenceGap, stepTransducer } = require('./photic-transducer');

function withAcquired(state, acquired) {
  return Object.freeze({ ...state, acquired: Object.freeze(acquired) });
}

function integrateFreeRun(state, durationUs) {
  const integrated = integratePopulationDuration(state.acquired, state.phenotype, durationUs);
  return withAcquired(state, integrated.acquired);
}

function integrateGap(state, durationUs) {
  let current = state;
  let remaining = durationUs;
  let first = true;
  while (remaining > 0) {
    const duration = Math.min(remaining, PROFILE.integrationQuantumUs);
    const oscillated = stepPopulation(current, duration);
    current = withAcquired(current, stepEvidenceGap(oscillated, duration, { newGap: first }));
    first = false;
    remaining -= duration;
  }
  return withAcquired(current, {
    ...current.acquired,
    phase_lock_summary: Object.freeze({
      status: 'CUE_UNCERTAIN',
      strength_q: Math.min(
        current.acquired.phase_lock_summary.strength_q,
        current.acquired.cue_coverage_q,
      ),
    }),
    alignment_summary: Object.freeze({
      status: 'CUE_UNCERTAIN',
      stability_q: Math.min(
        current.acquired.alignment_summary.stability_q,
        current.acquired.cue_coverage_q,
      ),
    }),
  });
}

function summaryFromHistory(acquired) {
  const measured = acquired.bounded_entrainment_history
    .filter(entry => entry.evidence_completeness !== 'GAP'
      && entry.central_phase_q !== null)
    .slice(-16);
  if (measured.length < 3) {
    return Object.freeze({
      phase_lock_summary: Object.freeze({ status: 'ACQUIRING', strength_q: 0 }),
      alignment_summary: Object.freeze({ status: 'ACQUIRING', stability_q: 0 }),
    });
  }
  let totalDifference = 0n;
  let lastDifference = 0n;
  for (let index = 1; index < measured.length; index += 1) {
    lastDifference = BigInt(Math.abs(signedPhaseDifference(
      measured[index].central_phase_q,
      measured[index - 1].central_phase_q,
    )));
    totalDifference += lastDifference;
  }
  const average = roundDivide(totalDifference, BigInt(measured.length - 1));
  const instability = clamp(Number(roundDivide(
    average * BigInt(Q31_ONE),
    0x80000000n,
  )), 0, Q31_ONE);
  const lastInstability = clamp(Number(roundDivide(
    lastDifference * BigInt(Q31_ONE),
    0x80000000n,
  )), 0, Q31_ONE);
  const stability = Math.min(Q31_ONE - instability, Q31_ONE - lastInstability);
  const status = measured.length >= 7 && stability >= Math.floor(Q31_ONE * 3 / 4)
    ? 'ENTRAINED' : 'REENTRAINING';
  return Object.freeze({
    phase_lock_summary: Object.freeze({ status, strength_q: stability }),
    alignment_summary: Object.freeze({ status, stability_q: stability }),
  });
}

function recordEvidence(state, evidence) {
  const aggregate = deriveAggregate(state);
  const history = [...state.acquired.bounded_entrainment_history, Object.freeze({
    event_id: evidence.event_id,
    effective_to_us: evidence.effective_to_us,
    evidence_completeness: evidence.evidence_completeness,
    central_phase_q: aggregate.central_phase_q,
    activation_q: state.acquired.photic_activation_q,
    source_quality_q: evidence.source_quality_q,
  })].slice(-PROFILE.entrainmentHistoryCapacity);
  const acquired = Object.freeze({
    ...state.acquired,
    bounded_entrainment_history: Object.freeze(history),
  });
  return withAcquired(state, {
    ...acquired,
    ...summaryFromHistory(acquired),
  });
}

function integrateEvidence(state, evidence, durationUs, { record = true } = {}) {
  if (evidence.evidence_completeness === 'GAP') {
    const integrated = integrateGap(state, durationUs);
    return record ? recordEvidence(integrated, evidence) : integrated;
  }
  let current = state;
  let remaining = durationUs;
  while (remaining > 0) {
    const duration = Math.min(remaining, PROFILE.integrationQuantumUs);
    const transduced = stepTransducer(current.acquired, evidence, duration);
    const oscillated = stepPopulation(current, duration);
    const entrainedOscillators = oscillated.oscillators.map((unit, unitId) => Object.freeze({
      ...unit,
      phase_q: wrapPhase(BigInt(unit.phase_q) + BigInt(photicPhaseAdjustment(
        current.phenotype.oscillators[unitId],
        current.acquired.oscillators[unitId].phase_q,
        transduced.activation_q,
        duration,
      ))),
    }));
    current = withAcquired(current, {
      ...oscillated,
      oscillators: Object.freeze(entrainedOscillators),
      photic_activation_q: transduced.activation_q,
      photic_adaptation_q: transduced.adaptation_q,
      cue_coverage_q: transduced.coverage_q,
    });
    remaining -= duration;
  }
  return record ? recordEvidence(current, evidence) : current;
}

function integrateEvidencePlan(state, targetTimeUs) {
  let current = state;
  let cursor = state.continuity.committed_through_us;
  const remainingEvidence = [];
  for (const evidence of state.continuity.pending_photic_evidence) {
    if (evidence.effective_from_us >= targetTimeUs) {
      remainingEvidence.push(evidence);
      continue;
    }
    if (evidence.effective_from_us > cursor) {
      const duration = evidence.effective_from_us - cursor;
      current = state.continuity.photic_route_configured
        ? integrateGap(current, duration) : integrateFreeRun(current, duration);
      cursor = evidence.effective_from_us;
    }
    const end = Math.min(evidence.effective_to_us, targetTimeUs);
    if (end > cursor) {
      current = integrateEvidence(current, evidence, end - cursor, {
        record: end === evidence.effective_to_us,
      });
      cursor = end;
    }
    if (evidence.effective_to_us > targetTimeUs) {
      remainingEvidence.push(Object.freeze({
        ...evidence,
        effective_from_us: targetTimeUs,
      }));
    }
  }
  if (cursor < targetTimeUs) {
    const duration = targetTimeUs - cursor;
    current = state.continuity.photic_route_configured
      ? integrateGap(current, duration) : integrateFreeRun(current, duration);
  }
  return Object.freeze({
    acquired: current.acquired,
    pending_photic_evidence: Object.freeze(remainingEvidence),
  });
}

module.exports = {
  integrateEvidence,
  integrateEvidencePlan,
  integrateFreeRun,
  integrateGap,
  summaryFromHistory,
};
