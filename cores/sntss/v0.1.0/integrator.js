'use strict';

const fp = require('./fixed-point');
const kinetics = require('./kinetics');

const QUANTUM_MS = 250;
const MAX_ACTIVE_STEPS = 4096;

function validateModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw Object.assign(new Error('SNTSS model is invalid'), { code: 'SNTSS_MODEL_INVALID' });
  const modelClock = fp.integer(model.modelClock, 'model clock');
  const remainderMs = fp.integer(model.remainderMs || 0, 'model remainder');
  if (modelClock < 0 || remainderMs < 0 || remainderMs >= QUANTUM_MS) throw Object.assign(new Error('SNTSS model clock is invalid'), { code: 'SNTSS_MODEL_CLOCK' });
  if (!model.transmitters || typeof model.transmitters !== 'object' || Array.isArray(model.transmitters)) throw Object.assign(new Error('SNTSS transmitter map is invalid'), { code: 'SNTSS_MODEL_INVALID' });
  const transmitters = {};
  for (const family of Object.keys(model.transmitters).sort()) transmitters[family] = kinetics.validateState(model.transmitters[family]);
  return { modelClock, remainderMs, transmitters };
}

function advanceModel(inputModel, profiles, elapsedMs, driveVectors = {}) {
  const model = validateModel(inputModel);
  const elapsed = fp.integer(elapsedMs, 'elapsed milliseconds');
  if (elapsed < 0) throw Object.assign(new Error('elapsed time must be nonnegative'), { code: 'SNTSS_MODEL_TIME' });
  const total = model.remainderMs + elapsed;
  const steps = Math.floor(total / QUANTUM_MS);
  const remainderMs = total % QUANTUM_MS;
  const transmitters = {};
  const transitions = {};
  for (const family of Object.keys(model.transmitters).sort()) {
    if (!profiles || !profiles[family]) throw Object.assign(new Error(`missing kinetic profile: ${family}`), { code: 'SNTSS_PROFILE_MISSING' });
    const vector = driveVectors[family] == null ? [] : driveVectors[family];
    const drive = fp.saturatingCombine(Array.isArray(vector) ? vector : [vector]);
    let state = model.transmitters[family];
    let last = { drive, synthesis: 0, release: 0 };
    if (drive === 0 && steps > MAX_ACTIVE_STEPS) {
      const quiet = kinetics.quietAdvance(state, profiles[family], steps);
      state = quiet.state;
      last = { ...quiet.transition, drive };
    } else {
      if (steps > MAX_ACTIVE_STEPS) throw Object.assign(new Error('active integration span exceeds bounded step budget'), { code: 'SNTSS_ACTIVE_TIME_LIMIT' });
      for (let index = 0; index < steps; index += 1) {
        const result = kinetics.step(state, profiles[family], drive);
        state = result.state;
        last = result.transition;
      }
    }
    transmitters[family] = state;
    transitions[family] = last;
  }
  return {
    model: { modelClock: model.modelClock + steps * QUANTUM_MS, remainderMs, transmitters },
    transitions,
    steps
  };
}

module.exports = { QUANTUM_MS, MAX_ACTIVE_STEPS, validateModel, advanceModel };
