'use strict';

const i3d = require('./i3d-state');
const i3c = require('./i3c-state');
const { validateIndividuality } = require('./individuality');

const VERSION = '0.5.0-i4g1';
const STAGE = 'i4g-continuity-genesis-shadow';
const MIGRATION = 'schema-4->5:i4g-continuity-genesis-shadow:prenatal-physiology-preserved';

function fail(message, code = 'SNTSS_I4G_STATE_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function clone(value) {
  return structuredClone(value);
}

function toI3D(source) {
  return {
    formatVersion: 1,
    stateSchema: 4,
    protocol: 'stay-sntss-v1',
    coreVersion: '0.4.0-i3d3',
    stage: i3d.STAGE,
    organismBinding: clone(source.organismBinding),
    chemistry: clone(source.chemistry),
    receptorAdaptation: clone(source.receptorAdaptation),
    receptorAvailability: clone(source.receptorAvailability),
    trustedTime: clone(source.trustedTime),
    migrations: clone(source.migrations)
  };
}

function fromI3D(source, individuality, version = VERSION) {
  const state = {
    formatVersion: 1,
    stateSchema: 5,
    protocol: 'stay-sntss-v1',
    coreVersion: version,
    stage: STAGE,
    organismBinding: clone(source.organismBinding),
    individuality: clone(individuality),
    chemistry: clone(source.chemistry),
    receptorAdaptation: clone(source.receptorAdaptation),
    receptorAvailability: clone(source.receptorAvailability),
    trustedTime: clone(source.trustedTime),
    migrations: clone(source.migrations)
  };
  validateIndividuality(state.individuality, state.organismBinding);
  return state;
}

function createState(version = VERSION) {
  return fromI3D(i3d.createState('0.4.0-i3d3'), null, version);
}

function normalizeState(input, version = VERSION) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length === 0) {
    return createState(version);
  }
  const allowed = new Set([
    'formatVersion', 'stateSchema', 'protocol', 'coreVersion', 'stage',
    'organismBinding', 'individuality', 'chemistry', 'receptorAdaptation',
    'receptorAvailability', 'trustedTime', 'migrations'
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail(`I4-G state field is not allowed: ${key}`);
  }
  if (input.formatVersion !== 1 || input.stateSchema !== 5 ||
      input.protocol !== 'stay-sntss-v1' || input.stage !== STAGE) {
    fail('I4-G state header is invalid');
  }
  const inherited = i3d.normalizeState(toI3D(input), '0.4.0-i3d3');
  return clone(fromI3D(inherited, input.individuality, version));
}

function migrateI3DState(input, version = VERSION) {
  const source = i3d.normalizeState(input, '0.4.0-i3d3');
  const history = source.migrations.map(String).slice(-63);
  return clone(fromI3D({ ...source, migrations: [...history, MIGRATION] }, null, version));
}

async function migrateLegacyState(input, fromSchema, version = VERSION) {
  const from = Number(fromSchema);
  if (from === 4) return migrateI3DState(input, version);
  if (from === 3) return migrateI3DState(i3d.migrateI3CState(input, '0.4.0-i3d3'), version);
  if (from === 1 || from === 2) {
    const intermediate = await i3c.migrateState({ state: input, fromSchema: from, toSchema: 3 });
    return migrateI3DState(i3d.migrateI3CState(intermediate, '0.4.0-i3d3'), version);
  }
  fail(`unsupported SNTSS migration ${from}->5`, 'SNTSS_MIGRATION_UNSUPPORTED');
}

function advanceRegulatedPhysiology(inputState, elapsedMs) {
  const current = normalizeState(inputState, inputState?.coreVersion || VERSION);
  const advanced = i3d.advanceRegulatedPhysiology(toI3D(current), elapsedMs);
  return {
    state: clone(fromI3D(advanced.state, current.individuality, current.coreVersion)),
    transition: clone(advanced.transition)
  };
}

module.exports = {
  VERSION,
  STAGE,
  MIGRATION,
  createState,
  normalizeState,
  migrateI3DState,
  migrateLegacyState,
  advanceRegulatedPhysiology
};
