'use strict';

const PHOTIC_PROFILE = Object.freeze({
  id: 'chronobiology-photic-calibration-c2b-v1',
  integrationQuantumUs: 60_000_000,
  halfSaturationQ31: 268_435_456,
  adaptationRateQ31PerQuantum: 10_737_418,
  recoveryRateQ31PerQuantum: 5_368_709,
  adaptationMaximumReductionQ31: 1_073_741_824,
  phaseLimitPerQuantumQ: 131_072,
  cueCoverageRiseQ31PerQuantum: 2_147_484,
  cueCoverageDecayQ31PerQuantum: 4_294_967,
  evidenceCapacity: 64,
  maximumIntervalUs: 86_400_000_000,
});

module.exports = { PHOTIC_PROFILE };
