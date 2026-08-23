'use strict';

module.exports = {
  profileVersion: 1,
  family: 'dopamine-like',
  status: 'active-shadow',
  modeledRole: 'prediction error, motivational salience, action vigor and learning sensitivity',
  explicitBoundary: 'not pleasure or happiness',
  kineticContractVersion: 1,
  kinetics: {
    synthCap: 6000, precursorRecovery: 1200, reserveRetention: 999000,
    maxReleasePerStep: 24000, maxSuppressionPerStep: 12000, concentrationRetention: 940000,
    exposureAlpha: 18000, exposureRetention: 999200, toleranceStrength: 650000,
    opponentBuildAlpha: 6000, opponentRetention: 999500,
    refractoryRecovery: 12000, refractoryRetention: 992000, refractoryCost: 500000,
    affinity: 380000, hill: 2
  },
  birthState: { P: 820000, R: 650000, C: 180000, B: 180000, X: 0, O: 0, F: 1000000 },
  activation: { laboratoryDriveEnabled: true, productionProducerCount: 0, productionActivationEnabled: false }
};
