'use strict';

/*
 * STAY / SNTSS I2-A
 *
 * Internal chemical-state engine only.
 *
 * This module:
 *   - owns no organism output authority
 *   - consumes no Event Fabric topics
 *   - performs no filesystem/network/process I/O
 *   - cannot activate dormant transmitter families
 *   - advances only deterministic SNTSS kinetics
 *
 * Runtime attachment comes later.
 */

const fp = require('../v0.1.0/fixed-point');
const kinetics = require('../v0.1.0/kinetics');

const {
  ACTIVE_FAMILIES,
  DORMANT_FAMILIES,
  ALL_FAMILIES,
  speciesProfile,
  createInitialModel,
  kineticProfiles
} = require('../v0.1.0/species-profile');

const QUANTUM_MS =
  speciesProfile.integrationQuantumMs;

const MAX_STEPS_PER_ADVANCE = 4096;

const PROFILES =
  Object.freeze(kineticProfiles());

function fail(message, code) {
  throw Object.assign(
    new Error(message),
    { code }
  );
}

function exactFamilyInventory(value, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    fail(
      `${label} must be an object`,
      'SNTSS_I2_STATE_INVALID'
    );
  }

  const actual =
    Object.keys(value).sort();

  const expected =
    [...ALL_FAMILIES].sort();

  if (
    actual.length !== expected.length ||
    actual.some(
      (name, index) =>
        name !== expected[index]
    )
  ) {
    fail(
      `${label} family inventory changed`,
      'SNTSS_I2_FAMILY_INVENTORY'
    );
  }
}

function clone(value) {
  return JSON.parse(
    JSON.stringify(value)
  );
}

function validateChemicalState(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  ) {
    fail(
      'chemical state is invalid',
      'SNTSS_I2_STATE_INVALID'
    );
  }

  if (
    !Number.isSafeInteger(input.modelClock) ||
    input.modelClock < 0
  ) {
    fail(
      'chemical model clock is invalid',
      'SNTSS_I2_TIME_INVALID'
    );
  }

  if (
    !Number.isSafeInteger(input.remainderMs) ||
    input.remainderMs < 0 ||
    input.remainderMs >= QUANTUM_MS
  ) {
    fail(
      'chemical clock remainder is invalid',
      'SNTSS_I2_TIME_INVALID'
    );
  }

  exactFamilyInventory(
    input.transmitters,
    'chemical state'
  );

  for (const family of ALL_FAMILIES) {
    kinetics.validateState(
      input.transmitters[family]
    );
  }

  /*
   * Dormant families are not merely undriven.
   * Their complete state must remain zero.
   */
  for (const family of DORMANT_FAMILIES) {
    const state =
      input.transmitters[family];

    for (const key of kinetics.STATE_KEYS) {
      if (state[key] !== 0) {
        fail(
          `dormant family acquired state: ${family}.${key}`,
          'SNTSS_I2_DORMANT_ACTIVATION'
        );
      }
    }
  }

  return input;
}

function normalizeDrives(input = {}) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  ) {
    fail(
      'drive vector is invalid',
      'SNTSS_I2_DRIVE_INVALID'
    );
  }

  const result =
    Object.fromEntries(
      ALL_FAMILIES.map(
        family => [family, 0]
      )
    );

  for (
    const [family, rawValue]
    of Object.entries(input)
  ) {
    if (!ALL_FAMILIES.includes(family)) {
      fail(
        `unknown transmitter family: ${family}`,
        'SNTSS_I2_DRIVE_FAMILY'
      );
    }

    if (!Number.isSafeInteger(rawValue)) {
      fail(
        `drive is not an integer: ${family}`,
        'SNTSS_I2_DRIVE_INVALID'
      );
    }

    if (
      rawValue < fp.SIGNED_MIN ||
      rawValue > fp.SIGNED_MAX
    ) {
      fail(
        `drive is outside fixed-point range: ${family}`,
        'SNTSS_I2_DRIVE_RANGE'
      );
    }

    if (
      DORMANT_FAMILIES.includes(family) &&
      rawValue !== 0
    ) {
      fail(
        `dormant family cannot receive drive: ${family}`,
        'SNTSS_I2_DORMANT_DRIVE'
      );
    }

    result[family] = rawValue;
  }

  return Object.freeze(result);
}

function createChemicalState(
  modelClock = 0
) {
  const state =
    createInitialModel(modelClock);

  validateChemicalState(state);

  return clone(state);
}

function advanceChemicalState(
  inputState,
  elapsedMs,
  inputDrives = {}
) {
  validateChemicalState(inputState);

  if (
    !Number.isSafeInteger(elapsedMs) ||
    elapsedMs < 0
  ) {
    fail(
      'elapsed chemical time is invalid',
      'SNTSS_I2_TIME_INVALID'
    );
  }

  const drives =
    normalizeDrives(inputDrives);

  const state =
    clone(inputState);

  const totalMs =
    state.remainderMs +
    elapsedMs;

  const steps =
    Math.floor(
      totalMs / QUANTUM_MS
    );

  if (
    steps >
    MAX_STEPS_PER_ADVANCE
  ) {
    fail(
      'chemical advance exceeds bounded work limit',
      'SNTSS_I2_ADVANCE_BOUNDED'
    );
  }

  state.remainderMs =
    totalMs % QUANTUM_MS;

  const transitions =
    Object.fromEntries(
      ALL_FAMILIES.map(
        family => [family, null]
      )
    );

  for (
    let stepIndex = 0;
    stepIndex < steps;
    stepIndex += 1
  ) {
    for (
      const family
      of ALL_FAMILIES
    ) {
      const drive =
        DORMANT_FAMILIES.includes(family)
          ? 0
          : drives[family];

      const result =
        kinetics.step(
          state.transmitters[family],
          PROFILES[family],
          drive
        );

      state.transmitters[family] =
        result.state;

      transitions[family] =
        result.transition;
    }
  }

  state.modelClock +=
    steps * QUANTUM_MS;

  validateChemicalState(state);

  return {
    state,
    transition: {
      elapsedMs,
      quantumMs: QUANTUM_MS,
      steps,
      drives: { ...drives },
      families: transitions
    }
  };
}

module.exports = {
  QUANTUM_MS,
  MAX_STEPS_PER_ADVANCE,
  ACTIVE_FAMILIES,
  DORMANT_FAMILIES,
  ALL_FAMILIES,
  createChemicalState,
  validateChemicalState,
  normalizeDrives,
  advanceChemicalState
};
