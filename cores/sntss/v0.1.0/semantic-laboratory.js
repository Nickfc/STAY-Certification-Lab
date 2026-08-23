'use strict';

const { advanceLaboratory } = require('./laboratory');
const { processSemanticEvent } = require('./stimuli');

function advanceSemanticLaboratory(inputModel, inputStimulusState, event, context, elapsedMs) {
  const stimulus = processSemanticEvent(inputStimulusState, event, context);
  const chemistry = advanceLaboratory(inputModel, elapsedMs, stimulus.decision.accepted ? stimulus.decision.drives : {});
  return { stimulus, chemistry };
}

module.exports = { stage: 'laboratory-r5', advanceSemanticLaboratory };
