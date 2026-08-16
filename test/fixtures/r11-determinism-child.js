'use strict';

const crypto = require('node:crypto');
const { advanceModel } = require('../../cores/sntss/v0.1.0/integrator');
const { stableStringify } = require('../../runtime/kernel/canonical-json');

const profile = Object.freeze({
  synthCap: 5000,
  precursorRecovery: 1000,
  reserveRetention: 999000,
  maxReleasePerStep: 20000,
  maxSuppressionPerStep: 10000,
  concentrationRetention: 950000,
  exposureAlpha: 20000,
  exposureRetention: 999000,
  toleranceStrength: 700000,
  opponentBuildAlpha: 5000,
  opponentRetention: 999500,
  refractoryRecovery: 10000,
  refractoryRetention: 990000,
  refractoryCost: 500000,
  affinity: 400000,
  hill: 2
});
const birth = Object.freeze({ P: 800000, R: 600000, C: 200000, B: 200000, X: 0, O: 0, F: 1000000 });

let model = { modelClock: 0, remainderMs: 0, transmitters: { test: { ...birth } } };
for (let index = 0; index < 200; index += 1) model = advanceModel(model, { test: profile }, 250, { test: [650000] }).model;
for (let index = 0; index < 800; index += 1) model = advanceModel(model, { test: profile }, 250, { test: [] }).model;

process.stdout.write(crypto.createHash('sha256').update(stableStringify(model)).digest('hex') + '\n');
