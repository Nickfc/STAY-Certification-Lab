'use strict';

module.exports = {
  profileVersion: 1,
  family: 'noradrenaline-like',
  status: 'active-shadow',
  modeledRole: 'arousal, uncertainty, vigilance and interrupt priority',
  explicitBoundary: 'not fear',
  kineticContractVersion: 1,
  kinetics: {
    synthCap: 7000, precursorRecovery: 1600, reserveRetention: 998800,
    maxReleasePerStep: 30000, maxSuppressionPerStep: 15000, concentrationRetention: 900000,
    exposureAlpha: 22000, exposureRetention: 998800, toleranceStrength: 600000,
    opponentBuildAlpha: 7000, opponentRetention: 999200,
    refractoryRecovery: 15000, refractoryRetention: 988000, refractoryCost: 540000,
    affinity: 340000, hill: 2
  },
  birthState: { P: 800000, R: 580000, C: 160000, B: 160000, X: 0, O: 0, F: 1000000 },
  activation: { laboratoryDriveEnabled: true, productionProducerCount: 0, productionActivationEnabled: false }
};
