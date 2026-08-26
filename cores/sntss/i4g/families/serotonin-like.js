'use strict';

module.exports = {
  profileVersion: 1,
  family: 'serotonin-like',
  status: 'active-shadow',
  modeledRole: 'long-horizon stability, patience, persistence and restraint',
  explicitBoundary: 'not happiness',
  kineticContractVersion: 1,
  kinetics: {
    synthCap: 3500, precursorRecovery: 800, reserveRetention: 999400,
    maxReleasePerStep: 14000, maxSuppressionPerStep: 7000, concentrationRetention: 970000,
    exposureAlpha: 10000, exposureRetention: 999600, toleranceStrength: 480000,
    opponentBuildAlpha: 3000, opponentRetention: 999700,
    refractoryRecovery: 8000, refractoryRetention: 995000, refractoryCost: 380000,
    affinity: 430000, hill: 2
  },
  birthState: { P: 850000, R: 720000, C: 220000, B: 220000, X: 0, O: 0, F: 1000000 },
  activation: { laboratoryDriveEnabled: true, productionProducerCount: 0, productionActivationEnabled: false }
};
