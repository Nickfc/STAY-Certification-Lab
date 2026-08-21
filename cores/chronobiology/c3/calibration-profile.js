'use strict';

/*
 * C1/C2 provisional model-v1 calibration. Every biological coefficient lives
 * here so no operator input or hidden runtime default can alter a phenotype.
 */
const PROFILE = Object.freeze({
  id: 'chronobiology-calibration-c1-provisional-v1',
  modelVersion: 'chronobiology-model-v1',
  oscillatorCount: 64,
  integrationQuantumUs: 60_000_000,
  intrinsicPeriodMeanUs: 87_120_000_000,
  intrinsicPeriodHalfRangeUs: 4_500_000_000,
  initialPhaseHalfRangeQ: 67_108_864,
  baselineAmplitudeMinimumQ31: 1_610_612_735,
  baselineAmplitudeRangeQ31: 536_870_912,
  amplitudeRecoveryMinimumQ31: 2_147_484,
  amplitudeRecoveryRangeQ31: 4_294_968,
  couplingSensitivityMinimumQ30: 10_737_418,
  couplingSensitivityRangeQ30: 26_843_546,
  photicSensitivityMinimumQ30: 805_306_368,
  photicSensitivityRangeQ30: 536_870_912,
  localEdgeWeightQ30: 134_217_728,
  longRangeEdgeWeightMinimumQ30: 67_108_864,
  longRangeEdgeWeightRangeQ30: 67_108_864,
  couplingResponseLimitQ30: 67_108_864,
  phaseResolvableMinimumQ31: 214_748_365,
  trigTableResolution: 4096,
  entrainmentHistoryCapacity: 64,
});

module.exports = { PROFILE };
