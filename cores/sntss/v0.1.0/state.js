'use strict';

const { validateLaboratoryModel, assertDormantState } = require('./validation');

// This is a laboratory projection guard only. Durable individuality and migration belong to R7.
function projectLaboratoryModel(model) {
  validateLaboratoryModel(model);
  assertDormantState(model);
  return JSON.parse(JSON.stringify(model));
}

module.exports = { stateSchema: 1, stage: 'r4-laboratory-projection-only', projectLaboratoryModel };
