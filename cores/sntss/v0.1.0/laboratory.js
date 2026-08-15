'use strict';

const { advanceModel } = require('./integrator');
const { evaluateInteractions } = require('./interactions');
const { speciesProfile, kineticProfiles } = require('./species-profile');
const { validateDriveMap, validateLaboratoryModel, assertDormantState } = require('./validation');

function advanceLaboratory(inputModel, elapsedMs, inputDrives = {}) {
  validateLaboratoryModel(inputModel);
  const drives = validateDriveMap(inputDrives);
  const result = advanceModel(inputModel, kineticProfiles(), elapsedMs, drives);
  assertDormantState(result.model);
  const effects = Object.fromEntries(
    speciesProfile.activeFamilies.map(family => [family, result.transitions[family].relativeEffect || 0])
  );
  return {
    ...result,
    profileHash: speciesProfile.profileHash,
    interactions: evaluateInteractions(effects)
  };
}

module.exports = { stage: 'laboratory-r4', advanceLaboratory };
