'use strict';

const { RESIDENT_SIGNALLING } = require('../kernel/resident-manager');
const PACKAGE_HASHES = require('./resident-package-hashes.json');
const definition = require('./residents/homeos-shadow');

const HOMEOS_SHADOW_RESIDENT_CONTRACT = Object.freeze({
  residencyId: definition.RESIDENCY_ID,
  coreId: definition.CORE_ID,
  role: 'homeostasis',
  version: definition.VERSION,
  stage: definition.STAGE,
  priority: 'optional',
  productionEligible: false,
  stateSchema: 2,
  inputs: definition.manifest.inputs,
  outputs: Object.freeze([]),
  packagePolicyHash: PACKAGE_HASHES.HOMEOS_SHADOW,
  priorCheckpointRecovery: true,
  signalling: RESIDENT_SIGNALLING.FORBIDDEN,
  authorityMode: 'shadow'
});

module.exports = Object.freeze({ HOMEOS_SHADOW_RESIDENT_CONTRACT });
