'use strict';

const { RESIDENT_SIGNALLING } = require('../kernel/resident-manager');
const PACKAGE_HASHES = require('./resident-package-hashes.json');
const { VERSION, STAGE } = require('./residents/metab-neutral');

const METAB_NEUTRAL_RESIDENT_CONTRACT = Object.freeze({
  residencyId: 'resident:metab',
  coreId: 'METAB',
  role: 'metabolism',
  version: VERSION,
  stage: STAGE,
  priority: 'optional',
  productionEligible: false,
  stateSchema: 1,
  inputs: Object.freeze(['runtime.organism.binding']),
  outputs: Object.freeze([]),
  packagePolicyHash: PACKAGE_HASHES.METAB_NEUTRAL,
  priorCheckpointRecovery: true,
  signalling: RESIDENT_SIGNALLING.FORBIDDEN,
  authorityMode: 'neutral'
});

module.exports = Object.freeze({ METAB_NEUTRAL_RESIDENT_CONTRACT });
