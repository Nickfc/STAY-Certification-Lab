'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fp = require('../cores/sntss/v0.1.0/fixed-point');
const kinetics = require('../cores/sntss/v0.1.0/kinetics');
const { advanceModel } = require('../cores/sntss/v0.1.0/integrator');
const species = require('../cores/sntss/v0.1.0/species-profile');
const validation = require('../cores/sntss/v0.1.0/validation');
const stimuli = require('../cores/sntss/v0.1.0/stimuli');
const receptors = require('../cores/sntss/v0.1.0/receptors');
const stateProjection = require('../cores/sntss/v0.1.0/state');
const { evaluateInteractions } = require('../cores/sntss/v0.1.0/interactions');
const { advanceLaboratory } = require('../cores/sntss/v0.1.0/laboratory');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const { buildReport } = require('../scripts/sntss-r4-calibration');
const pinnedEvidence = require('../docs/sntss/evidence/R4_CALIBRATION_EVIDENCE.json');

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function assertBoundedState(state) {
  for (const key of kinetics.STATE_KEYS) {
    assert.ok(Number.isSafeInteger(state[key]), `${key} is an integer`);
    assert.ok(state[key] >= 0 && state[key] <= fp.SCALE, `${key} is bounded`);
  }
}
function assertBoundedReadouts(readouts) {
  for (const [key, value] of Object.entries(readouts)) {
    assert.ok(Number.isSafeInteger(value), `${key} is an integer`);
    assert.ok(value >= fp.SIGNED_MIN && value <= fp.SIGNED_MAX, `${key} is bounded`);
  }
}

test('R4-01: six active and two dormant family profiles are immutable, complete and hash-verified', () => {
  assert.equal(species.ACTIVE_FAMILIES.length, 6);
  assert.deepEqual(species.DORMANT_FAMILIES, ['endogenous-opioid-like', 'oxytocin-like']);
  assert.match(species.speciesProfile.profileHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(species.speciesProfile.productionEligible, false);
  assert.equal(species.speciesProfile.review.approval, false);
  assert.equal(species.validateSpeciesProfile(species.speciesProfile).profileHash, species.speciesProfile.profileHash);
  for (const family of species.ALL_FAMILIES) {
    assert.match(species.speciesProfile.families[family].profileHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(Object.isFrozen(species.speciesProfile.families[family].kinetics), true);
    assert.equal(species.speciesProfile.families[family].activation.productionProducerCount, 0);
  }

  const partial = clone(species.speciesProfile);
  delete partial.families['dopamine-like'].kinetics.affinity;
  assert.throws(() => species.validateSpeciesProfile(partial));
  const unknown = clone(species.speciesProfile);
  unknown.families['dopamine-like'].kinetics.operatorSlider = 1;
  assert.throws(() => species.validateSpeciesProfile(unknown));
});

test('R4-02 baseline: all families remain bounded and dormant chemistry remains exactly zero over quiet time', () => {
  const result = advanceLaboratory(species.createInitialModel(), 24 * 60 * 60 * 1000, {});
  assert.equal(result.profileHash, species.speciesProfile.profileHash);
  for (const family of species.ACTIVE_FAMILIES) {
    const current = result.model.transmitters[family];
    assertBoundedState(current);
    assert.equal(current.C, current.B);
  }
  validation.assertDormantState(result.model);
  assertBoundedReadouts(result.interactions.readouts);

  let stepped = species.createInitialModel();
  for (let index = 0; index < 512; index += 1) stepped = advanceLaboratory(stepped, 250, {}).model;
  for (const family of species.ACTIVE_FAMILIES) {
    assert.equal(stepped.transmitters[family].C, stepped.transmitters[family].B);
    assert.equal(stepped.transmitters[family].X, 0);
    assert.equal(stepped.transmitters[family].O, 0);
  }
});

test('R4-03 prediction: positive and negative prediction drives produce bounded opposite dopamine-like responses', () => {
  const birth = species.createInitialModel();
  const positive = advanceLaboratory(birth, 250, { 'dopamine-like': [800000] });
  const negative = advanceLaboratory(birth, 250, { 'dopamine-like': [-800000] });
  assert.ok(positive.transitions['dopamine-like'].release > 0);
  assert.ok(positive.model.transmitters['dopamine-like'].C > birth.transmitters['dopamine-like'].B);
  assert.equal(negative.transitions['dopamine-like'].release, 0);
  assert.ok(negative.model.transmitters['dopamine-like'].C < birth.transmitters['dopamine-like'].B);
});

test('R4-04 uncertainty, vigilance and attention: moderate noradrenaline supports attention while high activation narrows it', () => {
  const uncertain = advanceLaboratory(species.createInitialModel(), 250, { 'noradrenaline-like': [800000] });
  assert.ok(uncertain.transitions['noradrenaline-like'].release > 0);
  const base = evaluateInteractions({ 'acetylcholine-like': 400000 });
  const moderate = evaluateInteractions({ 'acetylcholine-like': 400000, 'noradrenaline-like': 400000 });
  const high = evaluateInteractions({ 'acetylcholine-like': 400000, 'noradrenaline-like': 900000 });
  assert.equal(moderate.limitsApplied.noradrenalineMode, 'support');
  assert.equal(high.limitsApplied.noradrenalineMode, 'narrow');
  assert.ok(moderate.readouts.attentionGain > base.readouts.attentionGain);
  assert.ok(high.readouts.attentionGain < base.readouts.attentionGain);
});

test('R4-05 excitation/inhibition: GABA-like activation bounds glutamate-like excitation without forcing inactivity', () => {
  const excitationOnly = evaluateInteractions({ 'glutamate-like': 800000 });
  const balanced = evaluateInteractions({ 'glutamate-like': 800000, 'gaba-like': 600000 });
  assert.equal(excitationOnly.readouts.excitationTone, 800000);
  assert.equal(balanced.readouts.excitationTone, 200000);
  assert.equal(balanced.readouts.inhibitionTone, 600000);
  assert.ok(balanced.readouts.excitationTone > 0);
  assert.ok(balanced.readouts.excitationInhibitionBalance < 0);
});

test('R4-06 depletion, systemic desensitization and tolerance: repeated equal drives diminish release', () => {
  for (const family of species.ACTIVE_FAMILIES) {
    let model = species.createInitialModel();
    let earlyRelease = 0;
    let lateRelease = 0;
    for (let index = 0; index < 400; index += 1) {
      const result = advanceLaboratory(model, 250, { [family]: [800000] });
      model = result.model;
      if (index < 50) earlyRelease += result.transitions[family].release;
      if (index >= 350) lateRelease += result.transitions[family].release;
    }
    const current = model.transmitters[family];
    assertBoundedState(current);
    assert.ok(current.R < species.speciesProfile.families[family].birthState.R, `${family} reserve depletes`);
    assert.ok(current.X > 0, `${family} acquires exposure/desensitization state`);
    assert.ok(lateRelease < earlyRelease, `${family} late release is smaller`);
  }
});

test('R4-07 rebound and recovery: opponent load creates bounded withdrawal influence and quiet time restores baseline', () => {
  let model = species.createInitialModel();
  for (let index = 0; index < 600; index += 1) model = advanceLaboratory(model, 250, { 'dopamine-like': [900000] }).model;
  let minimumRebound = 0;
  for (let index = 0; index < 100; index += 1) {
    const result = advanceLaboratory(model, 250, {});
    model = result.model;
    minimumRebound = Math.min(minimumRebound, result.transitions['dopamine-like'].relativeEffect);
  }
  assert.ok(minimumRebound < 0);
  const recovered = advanceLaboratory(model, 30 * 24 * 60 * 60 * 1000, {}).model.transmitters['dopamine-like'];
  assert.equal(recovered.C, recovered.B);
  assert.equal(recovered.X, 0);
  assert.equal(recovered.O, 0);
  assert.equal(recovered.F, fp.SCALE);
  assert.equal(recovered.R, fp.SCALE);
});

test('R4-08 parameter sweep: every active family remains stable over the full signed drive region and hard boundaries reject', () => {
  const drives = [-1000000, -750000, -500000, -250000, 0, 250000, 500000, 750000, 1000000];
  for (const family of species.ACTIVE_FAMILIES) {
    for (const drive of drives) {
      let model = species.createInitialModel();
      for (let index = 0; index < 128; index += 1) model = advanceLaboratory(model, 250, { [family]: [drive] }).model;
      for (const active of species.ACTIVE_FAMILIES) assertBoundedState(model.transmitters[active]);
      validation.assertDormantState(model);
    }
  }
  assert.throws(() => advanceLaboratory(species.createInitialModel(), 250, { 'dopamine-like': [1000001] }), error => error.code === 'SNTSS_DRIVE_RANGE');
  const invalidProfile = { ...species.speciesProfile.families['dopamine-like'].kinetics, affinity: 1000001 };
  assert.throws(() => kinetics.validateProfile(invalidProfile), error => error.code === 'SNTSS_KINETIC_RANGE');
});

test('R4-09 dormancy proof: stimulus, receptor, migration and direct replay paths cannot activate dormant families', () => {
  for (const family of species.DORMANT_FAMILIES) {
    assert.throws(() => stimuli.authorizeLaboratoryFamily(family), error => error.code === 'SNTSS_FAMILY_DORMANT');
    assert.throws(() => receptors.authorizeLaboratoryFamily(family), error => error.code === 'SNTSS_FAMILY_DORMANT');
    assert.throws(() => validation.validateDriveMap({ [family]: [1000000] }), error => error.code === 'SNTSS_FAMILY_DORMANT');

    const migrated = species.createInitialModel();
    migrated.transmitters[family].R = 1;
    assert.throws(() => stateProjection.projectLaboratoryModel(migrated), error => error.code === 'SNTSS_FAMILY_DORMANT');

    const replay = advanceModel(species.createInitialModel(), species.kineticProfiles(), 4096 * 250, { [family]: [1000000] });
    assert.deepEqual(replay.model.transmitters[family], { P: 0, R: 0, C: 0, B: 0, X: 0, O: 0, F: 0 });
    assert.equal(replay.transitions[family].release, 0);
    assert.equal(replay.transitions[family].relativeEffect, 0);
  }

  const malicious = clone(species.speciesProfile);
  const dormant = malicious.families['oxytocin-like'];
  dormant.kinetics.synthCap = 1;
  const { profileHash: ignoredFamilyHash, ...familyBody } = dormant;
  dormant.profileHash = species.hash(familyBody);
  const { profileHash: ignoredBundleHash, ...bundleBody } = malicious;
  malicious.profileHash = species.hash(bundleBody);
  assert.throws(() => species.validateSpeciesProfile(malicious), error => error.code === 'SNTSS_FAMILY_DORMANT');
});

test('R4-10 cross-family policy is bounded, serotonin dampens extremes and invalid families fail closed', () => {
  const undamped = evaluateInteractions({ 'dopamine-like': 900000 });
  const damped = evaluateInteractions({ 'dopamine-like': 900000, 'serotonin-like': 800000 });
  assert.ok(damped.readouts.motivationalSalience < undamped.readouts.motivationalSalience);
  assertBoundedReadouts(damped.readouts);
  assert.throws(() => evaluateInteractions({ 'operator-happiness': 1 }), error => error.code === 'SNTSS_FAMILY_UNKNOWN');
  assert.throws(() => evaluateInteractions({ 'oxytocin-like': 1 }), error => error.code === 'SNTSS_FAMILY_DORMANT');
  assert.throws(() => evaluateInteractions({ 'dopamine-like': Number.NaN }), error => error.code === 'SNTSS_FIXED_INTEGER');
});

test('R4-11 identical profile, model, ordered drives and time reproduce the golden family-state hash', () => {
  const run = () => {
    let result = { model: species.createInitialModel(), interactions: evaluateInteractions({}) };
    for (let index = 0; index < 120; index += 1) result = advanceLaboratory(result.model, 250, { 'dopamine-like': [700000], 'acetylcholine-like': [350000] });
    for (let index = 0; index < 80; index += 1) result = advanceLaboratory(result.model, 250, { 'noradrenaline-like': [800000], 'glutamate-like': [500000], 'gaba-like': [250000] });
    for (let index = 0; index < 60; index += 1) result = advanceLaboratory(result.model, 250, { 'dopamine-like': [-600000], 'serotonin-like': [400000] });
    result = advanceLaboratory(result.model, 250000, {});
    return { model: result.model, interactions: result.interactions, profileHash: result.profileHash };
  };
  const first = run();
  const second = run();
  assert.deepEqual(second, first);
  const digest = crypto.createHash('sha256').update(stableStringify(first)).digest('hex');
  assert.equal(digest, 'fdedc30f270628768681c3ef685376aa71bd4cfdff1bd10361d8332467bff16d');
});

test('R4-12 the CoreHost package exposes profile evidence but retains zero chemistry and zero output authority', async () => {
  const definition = require('../cores/sntss/v0.1.0');
  assert.equal(definition.manifest.productionEligible, false);
  assert.deepEqual(definition.manifest.outputs, []);
  assert.equal(definition.manifest.stage, 'laboratory-r4-profile');
  const core = await definition.createCore({ initialState: {} });
  const health = await core.health();
  assert.equal(health.chemistryActive, false);
  assert.equal(health.calibratedFamilies, 6);
  assert.equal(health.dormantFamilies, 2);
  assert.equal(health.profileHash, species.speciesProfile.profileHash);
  assert.deepEqual((await core.snapshot()).transmitters, {});
});

test('R4-13 committed calibration evidence exactly reproduces from the pinned profile and engine', () => {
  assert.deepEqual(buildReport(), pinnedEvidence);
  assert.equal(pinnedEvidence.evidenceHash, 'sha256:3e58b7604f24f0f5e31f59f68248b99f10ef85f07071a702b5f32b4833f0bcd6');
});
