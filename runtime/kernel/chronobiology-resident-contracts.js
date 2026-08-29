'use strict';

const {
  CHRONOBIOLOGY_RESIDENT_CONTRACT
} = require('./resident-manager');

const CHRONOBIOLOGY_R2_RESIDENT_CONTRACT =
  Object.freeze({
    ...CHRONOBIOLOGY_RESIDENT_CONTRACT,

    version:
      '1.0.0-c3rc.2',

    stage:
      'c3-shadow-performance-repair',

    packagePolicyHash:
      'sha256:0d2ae2f1d1c5fbab8d4c62d83924fcfb9dbf50f1656e73188b3a8b5b1b76b635'
  });

const CHRONOBIOLOGY_R3_RESIDENT_CONTRACT =
  Object.freeze({
    ...CHRONOBIOLOGY_RESIDENT_CONTRACT,

    version:
      '1.0.0-c3rc.3',

    stage:
      'c3-shadow-jitless-performance-repair',

    packagePolicyHash:
      'sha256:195a9a9e0b4a4a3a33023a30f0f8be9431951b3c43b774c1161f6f9d556ab316'
  });

const CHRONOBIOLOGY_R4_RESIDENT_CONTRACT =
  Object.freeze({
    ...CHRONOBIOLOGY_RESIDENT_CONTRACT,

    version:
      '1.0.0-c3rc.4',

    stage:
      'c3-shadow-jitless-topology-performance-repair',

    packagePolicyHash:
      'sha256:b4a309490e276df8916475549c796f624c9bb06c4c34507beeddb03121dfbd3e'
  });

module.exports = Object.freeze({
  CHRONOBIOLOGY_R2_RESIDENT_CONTRACT,
  CHRONOBIOLOGY_R3_RESIDENT_CONTRACT,
  CHRONOBIOLOGY_R4_RESIDENT_CONTRACT
});
