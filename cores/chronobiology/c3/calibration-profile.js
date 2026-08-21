'use strict';

/*
 * C2-A selected model-v1 calibration. Every biological coefficient lives here
 * so no operator input or hidden runtime default can alter a phenotype.
 */
const PROFILE = Object.freeze({
  id: 'chronobiology-calibration-c2a-v1',
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
  couplingSensitivityMinimumQ30: 85_899_344,
  couplingSensitivityRangeQ30: 214_748_368,
  photicSensitivityMinimumQ30: 805_306_368,
  photicSensitivityRangeQ30: 536_870_912,
  localEdgeWeightQ30: 134_217_728,
  longRangeEdgeWeightMinimumQ30: 67_108_864,
  longRangeEdgeWeightRangeQ30: 67_108_864,
  couplingResponseLimitQ30: 67_108_864,
  phaseResolvableMinimumQ31: 214_748_365,
  trigTableResolution: 4096,
  entrainmentHistoryCapacity: 64,
  resolutionConvergencePhaseToleranceQ: 47_721_859,
  resolutionConvergenceCoherenceToleranceQ31: 107_374_182,
  resolutionConvergenceAmplitudeToleranceQ31: 107_374_182,
  quantumConvergencePhaseToleranceQ: 5_965_232,
  quantumConvergenceCoherenceToleranceQ31: 10_737_418,
  quantumConvergenceAmplitudeToleranceQ31: 2_147_484,
});

module.exports = { PROFILE };
