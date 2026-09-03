'use strict';

const { RESIDENT_SIGNALLING } = require('../kernel/resident-manager');
const PACKAGE_HASHES = require('./resident-package-hashes.json');
const definition = require('./residents/intero-neutral');

const INTERO_NEUTRAL_RESIDENT_CONTRACT = Object.freeze({
  residencyId: definition.RESIDENCY_ID,
  coreId: definition.CORE_ID,
  role: 'interoception',
  version: definition.VERSION,
  stage: definition.STAGE,
  priority: 'optional',
  productionEligible: false,
  stateSchema: 1,
  inputs: definition.manifest.inputs,
  outputs: Object.freeze([]),
  packagePolicyHash: PACKAGE_HASHES.INTERO_NEUTRAL,
  priorCheckpointRecovery: true,
  signalling: RESIDENT_SIGNALLING.FORBIDDEN,
  authorityMode: 'neutral'
});

module.exports = Object.freeze({ INTERO_NEUTRAL_RESIDENT_CONTRACT });
