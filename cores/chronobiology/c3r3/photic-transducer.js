'use strict';

const { PHOTIC_PROFILE } = require('./photic-calibration-profile');
const {
  Q31_ONE,
  clamp,
  multiplyQ31,
  roundDivide,
} = require('./fixed-point');

const PHOTIC_TOPIC = 'environment.photic.exposure';
const PHOTIC_SCHEMA = 'environment.photic.exposure/v1';
const COMPLETENESS = Object.freeze(['COMPLETE', 'PARTIAL', 'GAP']);
const ALLOWED_FIELDS = Object.freeze(new Set([
  'schema', 'effective_from_us', 'effective_to_us', 'broadband_level_q',
  'spectral_channels', 'source_quality_q', 'evidence_completeness',
  'sample_count', 'coverage_q',
]));

function fail(message, code = 'CHRONOBIOLOGY_PHOTIC_EVIDENCE_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function q31(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > Q31_ONE) {
    fail(`${label} is outside Q0.31`);
  }
  return value;
}

function normalizePhoticEvidence(event) {
  const payload = event?.payload;
  if (event?.topic !== PHOTIC_TOPIC || !payload || typeof payload !== 'object'
    || Array.isArray(payload) || event.meta?.sourceCore === 'living-kernel'
    || !['lab', 'shadow'].includes(event.meta?.authorityMode)) {
    fail('photic evidence is not an accepted LAB/SHADOW envelope');
  }
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_FIELDS.has(key)) fail(`photic evidence field is not allowed: ${key}`);
  }
  if (payload.schema !== PHOTIC_SCHEMA
    || !Number.isSafeInteger(payload.effective_from_us) || payload.effective_from_us < 0
    || !Number.isSafeInteger(payload.effective_to_us)
    || payload.effective_to_us <= payload.effective_from_us
    || payload.effective_to_us - payload.effective_from_us > PHOTIC_PROFILE.maximumIntervalUs
    || !COMPLETENESS.includes(payload.evidence_completeness)
    || !Number.isSafeInteger(payload.sample_count) || payload.sample_count < 0
    || payload.sample_count > 4096) {
    fail('photic evidence interval or header is invalid');
  }
  if (payload.spectral_channels !== null
    && (typeof payload.spectral_channels !== 'object'
      || Array.isArray(payload.spectral_channels)
      || Object.keys(payload.spectral_channels).length !== 0)) {
    fail('spectral channels are not calibrated in model-v1');
  }

  const gap = payload.evidence_completeness === 'GAP';
  if (gap) {
    if (payload.broadband_level_q !== null || payload.source_quality_q !== 0
      || payload.coverage_q !== 0 || payload.sample_count !== 0) {
      fail('evidence gap cannot contain an invented measurement');
    }
  } else {
    q31(payload.broadband_level_q, 'broadband level');
    q31(payload.source_quality_q, 'source quality');
    q31(payload.coverage_q, 'evidence coverage');
    if (payload.sample_count < 1) fail('measured evidence requires samples');
  }

  return Object.freeze({
    event_id: String(event.id),
    schema: payload.schema,
    effective_from_us: payload.effective_from_us,
    effective_to_us: payload.effective_to_us,
    broadband_level_q: payload.broadband_level_q,
    spectral_channels: Object.freeze({}),
    source_quality_q: payload.source_quality_q,
    evidence_completeness: payload.evidence_completeness,
    sample_count: payload.sample_count,
    coverage_q: payload.coverage_q,
  });
}

function saturationQ31(levelQ31) {
  q31(levelQ31, 'photic level');
  if (levelQ31 === 0) return 0;
  return clamp(Number(roundDivide(
    BigInt(levelQ31) * BigInt(Q31_ONE),
    BigInt(levelQ31 + PHOTIC_PROFILE.halfSaturationQ31),
  )), 0, Q31_ONE);
}

function scaledRate(rateQ31, durationUs) {
  return clamp(Number(roundDivide(
    BigInt(rateQ31) * BigInt(durationUs),
    BigInt(PHOTIC_PROFILE.integrationQuantumUs),
  )), 0, Q31_ONE);
}

function stepTransducer(acquired, evidence, durationUs) {
  if (evidence.evidence_completeness === 'GAP') {
    return Object.freeze({
      activation_q: 0,
      adaptation_q: acquired.photic_adaptation_q,
      coverage_q: acquired.cue_coverage_q,
    });
  }
  const raw = saturationQ31(evidence.broadband_level_q);
  const adaptationTarget = raw;
  const adapting = adaptationTarget >= acquired.photic_adaptation_q;
  const adaptationRate = scaledRate(
    adapting ? PHOTIC_PROFILE.adaptationRateQ31PerQuantum
      : PHOTIC_PROFILE.recoveryRateQ31PerQuantum,
    durationUs,
  );
  const adaptation = clamp(
    acquired.photic_adaptation_q
      + multiplyQ31(adaptationTarget - acquired.photic_adaptation_q, adaptationRate),
    0,
    Q31_ONE,
  );
  const reduction = multiplyQ31(adaptation, PHOTIC_PROFILE.adaptationMaximumReductionQ31);
  const gain = Q31_ONE - reduction;
  const quality = multiplyQ31(evidence.source_quality_q, evidence.coverage_q);
  const partialWeight = evidence.evidence_completeness === 'PARTIAL'
    ? Q31_ONE >> 1 : Q31_ONE;
  const activation = multiplyQ31(
    multiplyQ31(multiplyQ31(raw, gain), quality),
    partialWeight,
  );
  const coverageTarget = multiplyQ31(quality, partialWeight);
  const coverageRate = scaledRate(PHOTIC_PROFILE.cueCoverageRiseQ31PerQuantum, durationUs);
  const coverage = clamp(acquired.cue_coverage_q
    + multiplyQ31(coverageTarget - acquired.cue_coverage_q, coverageRate), 0, Q31_ONE);
  return Object.freeze({
    activation_q: activation,
    adaptation_q: adaptation,
    coverage_q: coverage,
  });
}

function stepEvidenceGap(acquired, durationUs, { newGap = false } = {}) {
  const decay = scaledRate(PHOTIC_PROFILE.cueCoverageDecayQ31PerQuantum, durationUs);
  return Object.freeze({
    ...acquired,
    photic_activation_q: 0,
    cue_coverage_q: clamp(acquired.cue_coverage_q
      - multiplyQ31(acquired.cue_coverage_q, decay), 0, Q31_ONE),
    evidence_gap_summary: Object.freeze({
      gap_count: acquired.evidence_gap_summary.gap_count + (newGap ? 1 : 0),
      unknown_duration_us: acquired.evidence_gap_summary.unknown_duration_us + durationUs,
    }),
  });
}

module.exports = {
  COMPLETENESS,
  PHOTIC_SCHEMA,
  PHOTIC_TOPIC,
  normalizePhoticEvidence,
  saturationQ31,
  stepEvidenceGap,
  stepTransducer,
};
