'use strict';

const { RESIDENT_SIGNALLING } = require('../kernel/resident-manager');
const PACKAGE_HASHES = require('./resident-package-hashes.json');
const definition = require('./residents/intero-shadow');

const INTERO_SHADOW_RESIDENT_CONTRACT = Object.freeze({
  residencyId: definition.RESIDENCY_ID,
  coreId: definition.CORE_ID,
  role: 'interoception',
  version: definition.VERSION,
  stage: definition.STAGE,
  priority: 'optional',
  productionEligible: false,
  stateSchema: 2,
  inputs: definition.manifest.inputs,
  outputs: Object.freeze([]),
  packagePolicyHash: PACKAGE_HASHES.INTERO_SHADOW,
  priorCheckpointRecovery: true,
  signalling: RESIDENT_SIGNALLING.FORBIDDEN,
  authorityMode: 'shadow'
});

module.exports = Object.freeze({ INTERO_SHADOW_RESIDENT_CONTRACT });
