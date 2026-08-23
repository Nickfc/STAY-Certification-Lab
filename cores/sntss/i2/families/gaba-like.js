'use strict';

module.exports = {
  profileVersion: 1,
  family: 'gaba-like',
  status: 'active-shadow',
  modeledRole: 'inhibitory balance and runaway-activity protection',
  explicitBoundary: 'not forced inactivity',
  kineticContractVersion: 1,
  kinetics: {
    synthCap: 7600, precursorRecovery: 1700, reserveRetention: 998800,
    maxReleasePerStep: 30000, maxSuppressionPerStep: 15000, concentrationRetention: 940000,
    exposureAlpha: 16000, exposureRetention: 999000, toleranceStrength: 500000,
    opponentBuildAlpha: 5000, opponentRetention: 999400,
    refractoryRecovery: 15000, refractoryRetention: 990000, refractoryCost: 460000,
    affinity: 340000, hill: 2
  },
  birthState: { P: 880000, R: 720000, C: 260000, B: 260000, X: 0, O: 0, F: 1000000 },
  activation: { laboratoryDriveEnabled: true, productionProducerCount: 0, productionActivationEnabled: false }
};
