'use strict';

const { RESIDENT_SIGNALLING } = require('../kernel/resident-manager');
const PACKAGE_HASHES = require('./resident-package-hashes.json');
const {
  ACTIVATION_TOPIC,
  ELIGIBLE_TOPIC,
  QUALITY_TOPIC,
  VERSION,
  STAGE
} = require('./residents/metab-shadow');

const METAB_SHADOW_RESIDENT_CONTRACT = Object.freeze({
  residencyId: 'resident:metab',
  coreId: 'METAB',
  role: 'metabolism',
  version: VERSION,
  stage: STAGE,
  priority: 'optional',
  productionEligible: false,
  stateSchema: 2,
  inputs: Object.freeze([
    'runtime.organism.binding',
    ACTIVATION_TOPIC,
    ELIGIBLE_TOPIC,
    QUALITY_TOPIC
  ]),
  outputs: Object.freeze([]),
  packagePolicyHash: PACKAGE_HASHES.METAB_SHADOW,
  priorCheckpointRecovery: true,
  signalling: RESIDENT_SIGNALLING.FORBIDDEN,
  authorityMode: 'shadow'
});

module.exports = Object.freeze({
  METAB_SHADOW_RESIDENT_CONTRACT
});
