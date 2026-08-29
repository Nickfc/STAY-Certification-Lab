'use strict';

const { PHOTIC_PROFILE } = require('./photic-calibration-profile');
const {
  Q30_ONE,
  Q31_ONE,
  clamp,
  multiplyQ30,
  multiplyQ31,
  roundDivide,
  sinQ30,
  wrapPhase,
} = require('./fixed-point');

function phaseResponseQ30(founder, phaseQ) {
  const primary = multiplyQ30(
    sinQ30(phaseQ),
    founder.prc_profile.primary_q30,
  );
  const secondary = multiplyQ30(
    sinQ30(wrapPhase(BigInt(phaseQ) * 2n)),
    founder.prc_profile.secondary_q30,
  );
  return clamp(primary + secondary, -Q30_ONE, Q30_ONE);
}

function photicPhaseAdjustment(founder, phaseQ, driveQ31, durationUs) {
  if (!Number.isSafeInteger(driveQ31) || driveQ31 < 0 || driveQ31 > Q31_ONE) {
    throw Object.assign(new Error('photic drive is outside Q0.31'), {
      code: 'CHRONOBIOLOGY_PHOTIC_DRIVE_INVALID',
    });
  }
  const sensitiveDrive = multiplyQ30(driveQ31 >> 1, founder.photic_sensitivity_q);
  const response = multiplyQ30(sensitiveDrive, phaseResponseQ30(founder, phaseQ));
  const durationLimit = Number(roundDivide(
    BigInt(PHOTIC_PROFILE.phaseLimitPerQuantumQ) * BigInt(durationUs),
    BigInt(PHOTIC_PROFILE.integrationQuantumUs),
  ));
  return clamp(Number(roundDivide(
    BigInt(durationLimit) * BigInt(response),
    BigInt(Q30_ONE),
  )), -durationLimit, durationLimit);
}

module.exports = {
  phaseResponseQ30,
  photicPhaseAdjustment,
};
