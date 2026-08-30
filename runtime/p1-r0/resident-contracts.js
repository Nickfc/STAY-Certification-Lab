'use strict';

const { RESIDENT_SIGNALLING } = require('../kernel/resident-manager');
const { FOUNDER_TOPICS } = require('./resident-support');
const PACKAGE_HASHES = require('./resident-package-hashes.json');

function freezeContract(value) {
  return Object.freeze({
    ...value,
    inputs: Object.freeze([...value.inputs]),
    outputs: Object.freeze([...value.outputs])
  });
}

const METAB_RESIDENT_CONTRACT = freezeContract({
  residencyId: 'resident:metab',
  coreId: 'METAB',
  role: 'metabolism',
  version: '0.1.0-p1r0-lab',
  stage: 'p1-r0-lab-shadow',
  priority: 'optional',
  productionEligible: false,
  stateSchema: 1,
  inputs: [
    'runtime.organism.binding',
    FOUNDER_TOPICS.METAB,
    'resource.capacity.eligible.v1',
    'resource.capacity.quality.v1'
  ],
  outputs: [
    'metab.energy.availability.v1',
    'metab.energy.reserve.v1'
  ],
  packagePolicyHash: PACKAGE_HASHES.METAB,
  priorCheckpointRecovery: true,
  signalling: RESIDENT_SIGNALLING.LAB_SHADOW_ONLY,
  producerEpoch: 1,
  authorityMode: 'shadow'
});

const HOMEOS_RESIDENT_CONTRACT = freezeContract({
  residencyId: 'resident:homeos',
  coreId: 'HOMEOS',
  role: 'homeostasis',
  version: '0.1.0-p1r0-lab',
  stage: 'p1-r0-lab-shadow',
  priority: 'optional',
  productionEligible: false,
  stateSchema: 1,
  inputs: [
    'runtime.organism.binding',
    FOUNDER_TOPICS.HOMEOS,
    'metab.energy.availability.v1',
    'metab.energy.reserve.v1'
  ],
  outputs: [
    'homeos.dimension.summary.v1',
    'homeos.stability.summary.v1'
  ],
  packagePolicyHash: PACKAGE_HASHES.HOMEOS,
  priorCheckpointRecovery: true,
  signalling: RESIDENT_SIGNALLING.LAB_SHADOW_ONLY,
  producerEpoch: 1,
  authorityMode: 'shadow'
});

const INTERO_RESIDENT_CONTRACT = freezeContract({
  residencyId: 'resident:intero',
  coreId: 'INTERO',
  role: 'interoception',
  version: '0.1.0-p1r0-lab',
  stage: 'p1-r0-lab-shadow-contained',
  priority: 'optional',
  productionEligible: false,
  stateSchema: 1,
  inputs: [
    'runtime.organism.binding',
    FOUNDER_TOPICS.INTERO,
    'metab.energy.availability.v1',
    'metab.energy.reserve.v1',
    'homeos.stability.summary.v1'
  ],
  outputs: [],
  packagePolicyHash: PACKAGE_HASHES.INTERO,
  priorCheckpointRecovery: true,
  signalling: RESIDENT_SIGNALLING.FORBIDDEN
});

const P1_R0_RESIDENT_CONTRACTS = Object.freeze([
  METAB_RESIDENT_CONTRACT,
  HOMEOS_RESIDENT_CONTRACT,
  INTERO_RESIDENT_CONTRACT
]);

module.exports = Object.freeze({
  METAB_RESIDENT_CONTRACT,
  HOMEOS_RESIDENT_CONTRACT,
  INTERO_RESIDENT_CONTRACT,
  P1_R0_RESIDENT_CONTRACTS
});
