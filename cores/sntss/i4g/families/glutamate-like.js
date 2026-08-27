'use strict';

module.exports = {
  profileVersion: 1,
  family: 'glutamate-like',
  status: 'active-shadow',
  modeledRole: 'excitatory tone and association readiness',
  explicitBoundary: 'never unbounded excitation',
  kineticContractVersion: 1,
  kinetics: {
    synthCap: 8000, precursorRecovery: 1800, reserveRetention: 998600,
    maxReleasePerStep: 28000, maxSuppressionPerStep: 16000, concentrationRetention: 930000,
    exposureAlpha: 18000, exposureRetention: 998900, toleranceStrength: 560000,
    opponentBuildAlpha: 6000, opponentRetention: 999300,
    refractoryRecovery: 15000, refractoryRetention: 989000, refractoryCost: 500000,
    affinity: 350000, hill: 2
  },
  birthState: { P: 880000, R: 700000, C: 240000, B: 240000, X: 0, O: 0, F: 1000000 },
  activation: { laboratoryDriveEnabled: true, productionProducerCount: 0, productionActivationEnabled: false }
};
