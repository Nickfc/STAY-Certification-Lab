'use strict';

const fp = require('./fixed-point');
const { assertActiveFamily, validateLaboratoryModel } = require('./validation');
const { receptorProfileRegistry, validateReceptorProfile } = require('./receptor-profiles');

function authorizeLaboratoryFamily(family) { return assertActiveFamily(family, 'laboratory receptor'); }

function fail(message, code = 'SNTSS_RECEPTOR_STATE') { throw Object.assign(new Error(message), { code }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} fields are invalid`);
}
function createPopulation(receptor, nowMs) {
  return {
    density: receptor.densityBirth, sensitivity: receptor.sensitivityBirth, occupancy: 0,
    exposure: 0, longExposure: 0, opponent: 0, lastEffect: 0, updatedAt: nowMs, dormant: false
  };
}

function createReceptorState(lineage, nowMs = 0) {
  if (typeof lineage !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(lineage) || !Number.isSafeInteger(nowMs) || nowMs < 0) fail('receptor lineage or clock is invalid');
  return { stateVersion: 1, lineage, consumers: {}, removedConsumers: {}, leases: {} };
}

function validatePopulation(population) {
  exactKeys(population, ['density', 'dormant', 'exposure', 'lastEffect', 'longExposure', 'occupancy', 'opponent', 'sensitivity', 'updatedAt'], 'receptor population');
  if (!population || typeof population !== 'object' || typeof population.dormant !== 'boolean' || !Number.isSafeInteger(population.updatedAt) || population.updatedAt < 0) fail('receptor population is invalid');
  for (const key of ['density', 'sensitivity', 'occupancy', 'exposure', 'longExposure']) if (!Number.isSafeInteger(population[key]) || population[key] < 0 || population[key] > fp.SCALE) fail(`receptor ${key} is invalid`);
  for (const key of ['opponent', 'lastEffect']) if (!Number.isSafeInteger(population[key]) || population[key] < -fp.SCALE || population[key] > fp.SCALE) fail(`receptor ${key} is invalid`);
  return population;
}

function validateReceptorState(state) {
  exactKeys(state, ['consumers', 'leases', 'lineage', 'removedConsumers', 'stateVersion'], 'receptor state');
  if (state.stateVersion !== 1 || !/^sha256:[0-9a-f]{64}$/.test(state.lineage)) fail('receptor state is invalid');
  for (const map of [state.consumers, state.removedConsumers, state.leases]) if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length > 64) fail('receptor state map is invalid');
  for (const [key, consumer] of Object.entries(state.consumers)) {
    exactKeys(consumer, ['consumerCoreId', 'frameSequence', 'lastEvidenceCursor', 'lastFrame', 'populations', 'profileHash', 'status'], 'consumer receptor state');
    const profile = validateReceptorProfile(receptorProfileRegistry.profiles[consumer.consumerCoreId]);
    if (key !== consumer.consumerCoreId || consumer.profileHash !== profile.profileHash || consumer.status !== 'active' || !Number.isSafeInteger(consumer.frameSequence) || consumer.frameSequence < 0 || !Number.isSafeInteger(consumer.lastEvidenceCursor) || consumer.lastEvidenceCursor < 0) fail('consumer receptor state is invalid');
    exactKeys(consumer.populations, profile.receptors.map(current => current.receptorId), 'consumer receptor populations');
    for (const receptor of profile.receptors) validatePopulation(consumer.populations[receptor.receptorId]);
  }
  for (const [key, consumer] of Object.entries(state.removedConsumers)) {
    const profile = receptorProfileRegistry.profiles[key];
    if (!profile || consumer.consumerCoreId !== key || consumer.profileHash !== profile.profileHash || consumer.status !== 'dormant') fail('removed receptor history is invalid');
    for (const population of Object.values(consumer.populations || {})) if (validatePopulation(population).dormant !== true) fail('removed receptor history is not dormant');
  }
  for (const [key, lease] of Object.entries(state.leases)) {
    if (!lease || lease.consumerCoreId !== key || !Array.isArray(lease.queue) || lease.queue.length > 32 || !['active', 'disconnected'].includes(lease.status) || !['closed', 'open'].includes(lease.breaker)) fail('lease state is invalid');
  }
  return state;
}

function registerConsumer(inputState, consumerCoreId, profileHash, nowMs) {
  validateReceptorState(inputState);
  const profile = receptorProfileRegistry.profiles[consumerCoreId];
  if (!profile || profile.profileHash !== profileHash) fail('consumer profile is not registered', 'SNTSS_PROFILE_MISMATCH');
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail('registration clock is invalid');
  if (inputState.consumers[consumerCoreId]) return inputState;
  const state = clone(inputState); const preserved = state.removedConsumers[consumerCoreId];
  if (preserved) {
    if (preserved.profileHash !== profileHash) fail('rollback profile does not match preserved history', 'SNTSS_PROFILE_MISMATCH');
    state.consumers[consumerCoreId] = { ...preserved, status: 'active' };
    for (const population of Object.values(state.consumers[consumerCoreId].populations)) population.dormant = false;
    delete state.removedConsumers[consumerCoreId];
  } else {
    state.consumers[consumerCoreId] = {
      consumerCoreId, profileHash, status: 'active', frameSequence: 0, lastEvidenceCursor: 0, lastFrame: null,
      populations: Object.fromEntries(profile.receptors.map(current => [current.receptorId, createPopulation(current, nowMs)]))
    };
  }
  return state;
}

function removeConsumer(inputState, consumerCoreId) {
  validateReceptorState(inputState);
  if (!inputState.consumers[consumerCoreId]) return inputState;
  const state = clone(inputState); const consumer = state.consumers[consumerCoreId];
  consumer.status = 'dormant';
  for (const population of Object.values(consumer.populations)) population.dormant = true;
  state.removedConsumers[consumerCoreId] = consumer;
  delete state.consumers[consumerCoreId]; delete state.leases[consumerCoreId];
  return state;
}

function approach(value, target, rate, steps) {
  return fp.clamp(fp.approach(value, target, fp.SCALE - rate, Math.max(0, steps)), fp.SIGNED_MIN, fp.SIGNED_MAX);
}

function advancePopulation(input, receptor, transmitter, nowMs) {
  const population = validatePopulation(input); const elapsed = nowMs - population.updatedAt;
  if (!Number.isSafeInteger(elapsed) || elapsed < 0) fail('receptor clock rewound', 'SNTSS_RECEPTOR_CLOCK');
  const steps = Math.floor(elapsed / 250);
  const occupancy = fp.hill(transmitter.C, receptor.affinity, receptor.hill);
  const tonicOccupancy = fp.hill(transmitter.B, receptor.affinity, receptor.hill);
  const exposure = approach(population.exposure, occupancy, receptor.exposureAlpha, Math.max(1, steps));
  const longExposure = approach(population.longExposure, occupancy, receptor.densityAdaptationRate, Math.max(1, steps));
  const sensitivityTarget = fp.clamp(fp.SCALE - fp.mul(exposure, receptor.desensitizationStrength));
  const sensitivityRate = sensitivityTarget < population.sensitivity ? receptor.exposureAlpha : receptor.recoveryRate;
  const sensitivity = approach(population.sensitivity, sensitivityTarget, sensitivityRate, Math.max(1, steps));
  const densityTarget = fp.clamp(fp.SCALE - fp.mul(longExposure, Math.floor(receptor.desensitizationStrength / 2)));
  const density = approach(population.density, densityTarget, receptor.densityAdaptationRate, Math.max(1, steps));
  const activation = receptor.polarity * fp.mul(fp.mul(fp.mul(receptor.efficacy, occupancy), density), sensitivity);
  const tonicActivation = receptor.polarity * fp.mul(fp.mul(fp.mul(receptor.efficacy, tonicOccupancy), density), sensitivity);
  const rawEffect = fp.clamp(activation - tonicActivation, fp.SIGNED_MIN, fp.SIGNED_MAX);
  const opponentTarget = -rawEffect;
  const opponent = approach(population.opponent, opponentTarget, receptor.densityAdaptationRate, Math.max(1, steps));
  const boundedEffect = fp.clamp(rawEffect + opponent, fp.SIGNED_MIN, fp.SIGNED_MAX);
  return {
    population: { density, sensitivity, occupancy, exposure, longExposure, opponent, lastEffect: boundedEffect, updatedAt: nowMs, dormant: false },
    signal: {
      receptorId: receptor.receptorId, permittedFunction: receptor.permittedFunction,
      activation, sensitivity, boundedEffect, trend: Math.sign(boundedEffect - population.lastEffect), available: true
    }
  };
}

function evaluateConsumer(inputState, consumerCoreId, model, nowMs) {
  validateReceptorState(inputState); validateLaboratoryModel(model);
  const consumer = inputState.consumers[consumerCoreId]; const profile = receptorProfileRegistry.profiles[consumerCoreId];
  if (!consumer || !profile) fail('consumer receptor state is unavailable', 'SNTSS_CONSUMER_UNREGISTERED');
  const state = clone(inputState); const signals = [];
  for (const receptor of profile.receptors) {
    const result = advancePopulation(consumer.populations[receptor.receptorId], receptor, model.transmitters[receptor.family], nowMs);
    state.consumers[consumerCoreId].populations[receptor.receptorId] = result.population; signals.push(result.signal);
  }
  return { state, signals };
}

module.exports = {
  stage: 'laboratory-r6-receptors', authorizeLaboratoryFamily, createReceptorState, validateReceptorState,
  registerConsumer, removeConsumer, evaluateConsumer
};
