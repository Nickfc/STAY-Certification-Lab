'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const fp = require('../cores/sntss/v0.1.0/fixed-point');
const kinetics = require('../cores/sntss/v0.1.0/kinetics');
const { advanceModel } = require('../cores/sntss/v0.1.0/integrator');
const species = require('../cores/sntss/v0.1.0/species-profile');
const { advanceLaboratory } = require('../cores/sntss/v0.1.0/laboratory');
const { evaluateInteractions } = require('../cores/sntss/v0.1.0/interactions');
const { stableStringify } = require('../runtime/kernel/canonical-json');

const SWEEP_DRIVES = Object.freeze([-1000000, -750000, -500000, -250000, 0, 250000, 500000, 750000, 1000000]);

function digest(value) { return crypto.createHash('sha256').update(stableStringify(value)).digest('hex'); }
function fileDigest(relativePath) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', relativePath))).digest('hex')}`;
}
function boundedState(state) { return kinetics.STATE_KEYS.every(key => Number.isSafeInteger(state[key]) && state[key] >= 0 && state[key] <= fp.SCALE); }

function runRepeated(family, drive, steps) {
  let model = species.createInitialModel();
  let transition = null;
  let earlyRelease = 0;
  let lateRelease = 0;
  const window = Math.min(50, Math.floor(steps / 2));
  for (let index = 0; index < steps; index += 1) {
    const result = advanceLaboratory(model, 250, { [family]: [drive] });
    model = result.model;
    transition = result.transitions[family];
    if (index < window) earlyRelease += transition.release;
    if (index >= steps - window) lateRelease += transition.release;
  }
  return { model, transition, earlyRelease, lateRelease };
}

function goldenScenario() {
  let result = { model: species.createInitialModel(), interactions: evaluateInteractions({}) };
  for (let index = 0; index < 120; index += 1) result = advanceLaboratory(result.model, 250, { 'dopamine-like': [700000], 'acetylcholine-like': [350000] });
  for (let index = 0; index < 80; index += 1) result = advanceLaboratory(result.model, 250, { 'noradrenaline-like': [800000], 'glutamate-like': [500000], 'gaba-like': [250000] });
  for (let index = 0; index < 60; index += 1) result = advanceLaboratory(result.model, 250, { 'dopamine-like': [-600000], 'serotonin-like': [400000] });
  result = advanceLaboratory(result.model, 250000, {});
  const body = { model: result.model, interactions: result.interactions, profileHash: result.profileHash };
  return { hash: digest(body), finalModelClock: body.model.modelClock, body };
}

function buildSensitivityMap() {
  return Object.fromEntries(species.ACTIVE_FAMILIES.map(family => {
    const points = SWEEP_DRIVES.map(drive => {
      const run = runRepeated(family, drive, 128);
      const state = run.model.transmitters[family];
      return {
        drive,
        concentration: state.C,
        reserve: state.R,
        exposure: state.X,
        opponent: state.O,
        refractory: state.F,
        terminalRelease: run.transition.release,
        terminalRelativeEffect: run.transition.relativeEffect,
        bounded: boundedState(state)
      };
    });
    return [family, points];
  }));
}

function buildScenarios() {
  const birth = species.createInitialModel();
  const baseline = advanceLaboratory(birth, 24 * 60 * 60 * 1000, {});
  const positive = advanceLaboratory(birth, 250, { 'dopamine-like': [800000] });
  const negative = advanceLaboratory(birth, 250, { 'dopamine-like': [-800000] });
  const uncertainty = advanceLaboratory(birth, 250, { 'noradrenaline-like': [800000] });
  const attentionBase = evaluateInteractions({ 'acetylcholine-like': 400000 });
  const attentionModerate = evaluateInteractions({ 'acetylcholine-like': 400000, 'noradrenaline-like': 400000 });
  const attentionHigh = evaluateInteractions({ 'acetylcholine-like': 400000, 'noradrenaline-like': 900000 });
  const excitation = evaluateInteractions({ 'glutamate-like': 800000, 'gaba-like': 600000 });
  const serotoninDamping = evaluateInteractions({ 'dopamine-like': 900000, 'serotonin-like': 800000 });
  const adaptation = Object.fromEntries(species.ACTIVE_FAMILIES.map(family => {
    const run = runRepeated(family, 800000, 400);
    const current = run.model.transmitters[family];
    return [family, {
      earlyRelease: run.earlyRelease,
      lateRelease: run.lateRelease,
      terminalReserve: current.R,
      terminalExposure: current.X,
      terminalOpponent: current.O,
      diminishingResponse: run.lateRelease < run.earlyRelease
    }];
  }));

  let reboundModel = species.createInitialModel();
  for (let index = 0; index < 600; index += 1) reboundModel = advanceLaboratory(reboundModel, 250, { 'dopamine-like': [900000] }).model;
  let minimumRebound = 0;
  for (let index = 0; index < 100; index += 1) {
    const result = advanceLaboratory(reboundModel, 250, {});
    reboundModel = result.model;
    minimumRebound = Math.min(minimumRebound, result.transitions['dopamine-like'].relativeEffect);
  }
  const recovered = advanceLaboratory(reboundModel, 30 * 24 * 60 * 60 * 1000, {}).model.transmitters['dopamine-like'];

  return {
    baseline: {
      quietHours: 24,
      allActiveConcentrationsAtBaseline: species.ACTIVE_FAMILIES.every(family => baseline.model.transmitters[family].C === baseline.model.transmitters[family].B)
    },
    positivePrediction: { release: positive.transitions['dopamine-like'].release, concentration: positive.model.transmitters['dopamine-like'].C },
    negativePrediction: { release: negative.transitions['dopamine-like'].release, concentration: negative.model.transmitters['dopamine-like'].C },
    uncertaintyVigilance: { release: uncertainty.transitions['noradrenaline-like'].release, vigilance: uncertainty.interactions.readouts.vigilance },
    attention: {
      base: attentionBase.readouts.attentionGain,
      moderateNoradrenaline: attentionModerate.readouts.attentionGain,
      highNoradrenaline: attentionHigh.readouts.attentionGain
    },
    excitationInhibition: {
      excitationTone: excitation.readouts.excitationTone,
      inhibitionTone: excitation.readouts.inhibitionTone,
      balance: excitation.readouts.excitationInhibitionBalance,
      gabaBrake: excitation.limitsApplied.gabaBrake
    },
    serotoninDamping: { dopamineInput: 900000, boundedMotivationalSalience: serotoninDamping.readouts.motivationalSalience },
    depletionDesensitizationTolerance: adaptation,
    reboundRecovery: {
      minimumRelativeEffect: minimumRebound,
      recoveredConcentration: recovered.C,
      baseline: recovered.B,
      recoveredExposure: recovered.X,
      recoveredOpponent: recovered.O,
      recoveredRefractory: recovered.F,
      recoveredReserve: recovered.R
    }
  };
}

function buildDormancyProof() {
  return Object.fromEntries(species.DORMANT_FAMILIES.map(family => {
    const result = advanceModel(species.createInitialModel(), species.kineticProfiles(), 4096 * 250, { [family]: [1000000] });
    const state = result.model.transmitters[family];
    return [family, {
      malformedDrive: 1000000,
      replayQuanta: 4096,
      terminalState: state,
      release: result.transitions[family].release,
      relativeEffect: result.transitions[family].relativeEffect,
      exactlyZero: kinetics.STATE_KEYS.every(key => state[key] === 0)
    }];
  }));
}

function buildReport() {
  const golden = goldenScenario();
  const body = {
    evidenceVersion: 1,
    phase: 'R4',
    status: 'laboratory-candidate-not-production-authorized',
    profileHash: species.speciesProfile.profileHash,
    familyHashes: Object.fromEntries(species.ALL_FAMILIES.map(family => [family, species.speciesProfile.families[family].profileHash])),
    implementationHashes: Object.fromEntries([
      'cores/sntss/v0.1.0/fixed-point.js',
      'cores/sntss/v0.1.0/kinetics.js',
      'cores/sntss/v0.1.0/integrator.js',
      'cores/sntss/v0.1.0/species-profile.js',
      'cores/sntss/v0.1.0/validation.js',
      'cores/sntss/v0.1.0/interactions.js',
      'cores/sntss/v0.1.0/laboratory.js',
      'cores/sntss/schemas/species-profile.schema.json'
    ].map(relativePath => [relativePath, fileDigest(relativePath)])),
    goldenScenarioHash: golden.hash,
    goldenFinalModelClock: golden.finalModelClock,
    sweepDrives: [...SWEEP_DRIVES],
    sensitivityMap: buildSensitivityMap(),
    scenarios: buildScenarios(),
    dormancyProof: buildDormancyProof()
  };
  return { ...body, evidenceHash: `sha256:${digest(body)}` };
}

if (require.main === module) process.stdout.write(JSON.stringify(buildReport(), null, 2) + '\n');

module.exports = { SWEEP_DRIVES, buildReport, goldenScenario };
