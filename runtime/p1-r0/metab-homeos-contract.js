'use strict';

const { RESIDENT_SIGNALLING } = require('../kernel/resident-manager');
const PACKAGE_HASHES = require('./resident-package-hashes.json');
const definition = require('./residents/metab-homeos');

const METAB_HOMEOS_RESIDENT_CONTRACT = Object.freeze({
  residencyId: definition.RESIDENCY_ID,
  coreId: definition.CORE_ID,
  role: 'metabolism',
  version: definition.VERSION,
  stage: definition.STAGE,
  priority: 'optional',
  productionEligible: false,
  stateSchema: 3,
  inputs: definition.manifest.inputs,
  outputs: definition.manifest.outputs,
  packagePolicyHash: PACKAGE_HASHES.METAB_HOMEOS,
  routeCompleteness: true,
  priorCheckpointRecovery: true,
  signalling: RESIDENT_SIGNALLING.LAB_SHADOW_ONLY,
  producerEpoch: 1,
  authorityMode: 'shadow'
});

module.exports = Object.freeze({ METAB_HOMEOS_RESIDENT_CONTRACT });
