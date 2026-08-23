'use strict';

module.exports = {
  profileVersion: 1,
  family: 'oxytocin-like',
  status: 'dormant',
  modeledRole: 'future familiarity, attachment and social-safety modulation',
  explicitBoundary: 'cannot grant trust or obedience',
  kineticContractVersion: 1,
  kinetics: {
    synthCap: 0, precursorRecovery: 0, reserveRetention: 1000000,
    maxReleasePerStep: 0, maxSuppressionPerStep: 0, concentrationRetention: 1000000,
    exposureAlpha: 0, exposureRetention: 1000000, toleranceStrength: 0,
    opponentBuildAlpha: 0, opponentRetention: 1000000,
    refractoryRecovery: 0, refractoryRetention: 1000000, refractoryCost: 0,
    affinity: 1000000, hill: 1
  },
  birthState: { P: 0, R: 0, C: 0, B: 0, X: 0, O: 0, F: 0 },
  activation: { laboratoryDriveEnabled: false, productionProducerCount: 0, productionActivationEnabled: false }
};
