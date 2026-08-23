'use strict';

module.exports = {
  profileVersion: 1,
  family: 'acetylcholine-like',
  status: 'active-shadow',
  modeledRole: 'attention, sensory gain, encoding and plasticity',
  explicitBoundary: 'not intelligence',
  kineticContractVersion: 1,
  kinetics: {
    synthCap: 6500, precursorRecovery: 1400, reserveRetention: 999000,
    maxReleasePerStep: 26000, maxSuppressionPerStep: 13000, concentrationRetention: 920000,
    exposureAlpha: 16000, exposureRetention: 999100, toleranceStrength: 520000,
    opponentBuildAlpha: 5000, opponentRetention: 999400,
    refractoryRecovery: 14000, refractoryRetention: 990000, refractoryCost: 480000,
    affinity: 360000, hill: 2
  },
  birthState: { P: 840000, R: 620000, C: 190000, B: 190000, X: 0, O: 0, F: 1000000 },
  activation: { laboratoryDriveEnabled: true, productionProducerCount: 0, productionActivationEnabled: false }
};
