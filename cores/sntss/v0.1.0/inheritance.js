'use strict';

const { validateLaboratoryModel } = require('./validation');
const { validateStimulusState } = require('./stimuli');
const { validateReceptorState } = require('./receptors');
const { hash } = require('./species-profile');
const stateContract = require('./state');

function fail(message, code = 'SNTSS_INHERITANCE_INVALID') { throw Object.assign(new Error(message), { code }); }

function applyAcquiredTransition(inputState, transition, context) {
  stateContract.validateAcquiredState(inputState);
  if (!transition || !context || context.stage !== 'laboratory-r7' || context.productionImport === true || !stateContract.HASH.test(context.evidenceHash)) fail('acquired transition is not laboratory-authorized');
  validateLaboratoryModel(transition.model); validateStimulusState(transition.stimulusState); validateReceptorState(transition.receptorState);
  if (transition.receptorState.lineage !== inputState.lineage) fail('receptor history belongs to another lineage', 'SNTSS_LINEAGE_MISMATCH');
  if (!Number.isSafeInteger(transition.inputCursor) || transition.inputCursor < inputState.inputCursor || transition.stimulusState.cursor > transition.inputCursor) fail('acquired transition cursor rewound', 'SNTSS_ROLLBACK_REWIND');
  if (transition.model.modelClock < inputState.modelClock.chemicalElapsedMs) fail('chemical clock rewound', 'SNTSS_ROLLBACK_REWIND');
  const state = stateContract.clone(inputState);
  state.transmitters = stateContract.clone(transition.model.transmitters);
  state.modelClock.chemicalElapsedMs = transition.model.modelClock;
  state.modelClock.remainderMs = transition.model.remainderMs || 0;
  state.inputCursor = transition.inputCursor;
  state.receptors = stateContract.clone(transition.receptorState); state.leases = stateContract.clone(transition.receptorState.leases);
  state.habituation = stateContract.clone(transition.stimulusState.habituation);
  state.circuitBreakers = stateContract.clone(transition.stimulusState.breakers);
  state.sourceHistory.semantic = {
    cursor: transition.stimulusState.cursor, sourceLastSeen: stateContract.clone(transition.stimulusState.sourceLastSeen),
    topicHistory: stateContract.clone(transition.stimulusState.topicHistory), seenEvidence: stateContract.clone(transition.stimulusState.seenEvidence),
    seenClaims: stateContract.clone(transition.stimulusState.seenClaims), causalRecords: stateContract.clone(transition.stimulusState.causalRecords),
    contradictions: stateContract.clone(transition.stimulusState.contradictions), traceHead: transition.stimulusState.traceHead,
    traces: stateContract.clone(transition.stimulusState.traces)
  };
  state.auditChainHead = hash({ previous: state.auditChainHead, transition: 'acquired-laboratory-transition', evidenceHash: context.evidenceHash, inputCursor: transition.inputCursor, beforeStateHash: stateContract.stateHash(inputState) });
  stateContract.validateAcquiredState(state);
  return state;
}

module.exports = { applyAcquiredTransition };
