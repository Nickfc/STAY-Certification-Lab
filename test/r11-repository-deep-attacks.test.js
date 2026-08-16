'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { speciesProfile, hash } = require('../cores/sntss/v0.1.0/species-profile');
const genesis = require('../cores/sntss/v0.1.0/genesis');
const migrations = require('../cores/sntss/v0.1.0/migrations');

const IDENTITY = hash({ fixture: 'r11-repository-migration-organism' });
const BINDING = Object.freeze({
  bindingVersion: 1,
  identitySha256: IDENTITY,
  organismLineage: 'STAY/Genesis',
  issuedAt: 500,
  runtimeRevision: 1,
  authorityEpoch: 7,
  kernelVersion: '0.8.11.3',
  bindingEventId: 'r11-binding-1'
});
const REQUEST = Object.freeze({
  binding: BINDING,
  neutralCheckpointHash: hash({ neutral: true }),
  genesisEventId: 'r11-sntss-genesis-1',
  genesisSequence: 1,
  at: 1000
});
const AUTH = Object.freeze({
  stage: 'laboratory-r7',
  productionCommit: false,
  neutralHandoffVerified: true,
  speciesProfileHash: speciesProfile.profileHash,
  authorityEpoch: 7
});

function validCurrentState() {
  return genesis.prepareGenesis(null, REQUEST, AUTH, '44'.repeat(32)).state;
}

test('R11-J-01 oversized migration history is rejected before forward migration', () => {
  const current = validCurrentState();
  const legacy = migrations.projectBackward(current, 1).state;
  const oversized = JSON.parse(JSON.stringify(legacy));
  oversized.migrations = Array.from({ length: 65 }, (_, index) => ({
    type: 'hostile-padding',
    migrationId: `hostile-${index}`,
    fromSchema: 1,
    toSchema: 1,
    inputHash: hash({ index }),
    transformationHash: hash({ padding: index }),
    appliedAtCursor: oversized.inputCursor
  }));

  const before = JSON.stringify(oversized);
  assert.throws(
    () => migrations.migrateForward(oversized, 2),
    error => error.code === 'SNTSS_ACQUIRED_STATE_INVALID' && /migration history is invalid/i.test(error.message)
  );
  assert.equal(JSON.stringify(oversized), before, 'rejected migration input must remain untouched');
  assert.throws(() => migrations.migrateForward(legacy, 99), { code: 'SNTSS_MIGRATION_UNSUPPORTED' });
});
