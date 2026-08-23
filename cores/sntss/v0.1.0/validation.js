'use strict';

const fp = require('./fixed-point');
const kinetics = require('./kinetics');
const { ACTIVE_FAMILIES, DORMANT_FAMILIES, ALL_FAMILIES, validateSpeciesProfile } = require('./species-profile');

function fail(message, code) { throw Object.assign(new Error(message), { code }); }

function assertKnownFamily(family) {
  if (typeof family !== 'string' || !ALL_FAMILIES.includes(family)) fail(`unknown SNTSS family: ${family}`, 'SNTSS_FAMILY_UNKNOWN');
  return family;
}

function assertActiveFamily(family, surface = 'laboratory') {
  assertKnownFamily(family);
  if (DORMANT_FAMILIES.includes(family)) fail(`${family} is dormant on ${surface}`, 'SNTSS_FAMILY_DORMANT');
  return family;
}

function validateDriveMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('drive map must be an object', 'SNTSS_DRIVE_MAP_INVALID');
  const result = {};
  for (const family of Object.keys(input).sort()) {
    assertActiveFamily(family, 'drive');
    const vector = Array.isArray(input[family]) ? input[family] : [input[family]];
    result[family] = vector.map((value, index) => {
      const drive = fp.integer(value, `${family} drive ${index}`);
      if (drive < fp.SIGNED_MIN || drive > fp.SIGNED_MAX) fail(`${family} drive is outside the signed fixed-point range`, 'SNTSS_DRIVE_RANGE');
      return drive;
    });
  }
  return result;
}

function assertDormantState(model) {
  if (!model || !model.transmitters || typeof model.transmitters !== 'object') fail('model is invalid', 'SNTSS_MODEL_INVALID');
  for (const family of DORMANT_FAMILIES) {
    const state = kinetics.validateState(model.transmitters[family]);
    if (kinetics.STATE_KEYS.some(key => state[key] !== 0)) fail(`${family} acquired nonzero state`, 'SNTSS_FAMILY_DORMANT');
  }
  return true;
}

function validateLaboratoryModel(model) {
  if (!model || !model.transmitters || typeof model.transmitters !== 'object' || Array.isArray(model.transmitters)) fail('model is invalid', 'SNTSS_MODEL_INVALID');
  const actual = Object.keys(model.transmitters).sort();
  if (actual.length !== ALL_FAMILIES.length || actual.some((family, index) => family !== ALL_FAMILIES[index])) {
    fail('model family inventory is incomplete or unknown', 'SNTSS_MODEL_FAMILY_INVENTORY');
  }
  for (const family of ACTIVE_FAMILIES) kinetics.validateState(model.transmitters[family]);
  assertDormantState(model);
  return model;
}

module.exports = {
  stage: 'laboratory-r4', validateSpeciesProfile, assertKnownFamily, assertActiveFamily,
  validateDriveMap, assertDormantState, validateLaboratoryModel
};
