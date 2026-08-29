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

module.exports = Object.freeze({
  CHRONOBIOLOGY_R2_RESIDENT_CONTRACT
});
