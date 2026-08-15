'use strict';

const { advanceModel } = require('./integrator');
const { kineticProfiles, hash } = require('./species-profile');
const { evaluateConsumer } = require('./receptors');
const stateContract = require('./state');

function fail(message, code = 'SNTSS_RECOVERY_INVALID') { throw Object.assign(new Error(message), { code }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function recoverCheckpoint(primary, backups, expected) {
  if (!Array.isArray(backups) || backups.length > 32) fail('backup set is invalid');
  const candidates = [{ source: 'primary', checkpoint: primary }, ...backups.map((checkpoint, index) => ({ source: `backup-${index}`, checkpoint }))];
  const failures = [];
  for (const candidate of candidates) {
    try {
      const checkpoint = stateContract.validateCheckpoint(candidate.checkpoint, expected);
      const reportBody = {
        recoveryVersion: 1, selectedSource: candidate.source, selectedCheckpointHash: checkpoint.checkpointHash,
        lineage: checkpoint.lineage, identitySha256: checkpoint.identitySha256, inputCursor: checkpoint.inputCursor,
        rejectedCandidates: failures
      };
      return { state: clone(checkpoint.state), checkpoint, report: { ...reportBody, reportHash: hash(reportBody) } };
    } catch (error) { failures.push({ source: candidate.source, reasonCode: error.code || 'SNTSS_CHECKPOINT_INVALID' }); }
  }
  fail('no verified checkpoint exists; fresh chemistry is forbidden', 'SNTSS_RECOVERY_NO_VERIFIED_STATE');
}

function advanceDowntime(inputState, context) {
  stateContract.validateAcquiredState(inputState);
  const required = ['clockStatus', 'elapsedMs', 'expectedIdentitySha256', 'expectedLineage', 'resumeAtMs'];
  if (!context || Object.keys(context).sort().join('|') !== required.sort().join('|')) fail('downtime context is not canonical');
  if (context.clockStatus !== 'trusted') fail('downtime cannot advance on an uncertain clock', 'SNTSS_DOWNTIME_CLOCK_UNTRUSTED');
  if (context.expectedLineage !== inputState.lineage || context.expectedIdentitySha256 !== inputState.organismBinding.identitySha256) fail('downtime recovery lineage mismatch', 'SNTSS_LINEAGE_MISMATCH');
  if (!Number.isSafeInteger(context.elapsedMs) || context.elapsedMs < 0 || !Number.isSafeInteger(context.resumeAtMs) || context.resumeAtMs - inputState.modelClock.lastTrustedWallClockMs !== context.elapsedMs) fail('downtime interval is invalid');
  const model = {
    modelClock: inputState.modelClock.chemicalElapsedMs,
    remainderMs: inputState.modelClock.remainderMs,
    transmitters: inputState.transmitters
  };
  const advanced = advanceModel(model, kineticProfiles(), context.elapsedMs, {}); const state = clone(inputState);
  state.transmitters = advanced.model.transmitters;
  state.modelClock = { chemicalElapsedMs: advanced.model.modelClock, remainderMs: advanced.model.remainderMs, lastTrustedWallClockMs: context.resumeAtMs };
  state.developmentalClock.lastTrustedWallClockMs = context.resumeAtMs;
  let receptorState = state.receptors;
  for (const consumerCoreId of Object.keys(receptorState.consumers).sort()) receptorState = evaluateConsumer(receptorState, consumerCoreId, advanced.model, context.resumeAtMs).state;
  for (const lease of Object.values(receptorState.leases)) {
    lease.status = 'disconnected'; lease.queue = []; lease.disconnectedAt = context.resumeAtMs;
  }
  state.receptors = receptorState; state.leases = clone(receptorState.leases);
  state.auditChainHead = hash({ previous: state.auditChainHead, transition: 'trusted-downtime-recovery', elapsedMs: context.elapsedMs, resumeAtMs: context.resumeAtMs, beforeStateHash: stateContract.stateHash(inputState) });
  stateContract.validateAcquiredState(state);
  return {
    state,
    report: {
      status: 'advanced-without-stimulus', elapsedMs: context.elapsedMs, chemicalSteps: advanced.steps,
      developmentalExperienceAddedMs: 0, inputCursorUnchanged: state.inputCursor === inputState.inputCursor,
      sourceHistoryUnchanged: hash(state.sourceHistory) === hash(inputState.sourceHistory),
      habituationUnchanged: hash(state.habituation) === hash(inputState.habituation), outputHash: stateContract.stateHash(state)
    }
  };
}

function verifyRestart(checkpoint, expected) {
  const validated = stateContract.validateCheckpoint(checkpoint, expected);
  return { state: clone(validated.state), checkpointHash: validated.checkpointHash, stateHash: stateContract.stateHash(validated.state) };
}

module.exports = { recoverCheckpoint, advanceDowntime, verifyRestart };
