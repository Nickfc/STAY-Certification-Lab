'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeKernel, fs, path } = require('./helpers');
const { speciesProfile, hash } = require('../cores/sntss/v0.1.0/species-profile');
const genesis = require('../cores/sntss/v0.1.0/genesis');
const migrations = require('../cores/sntss/v0.1.0/migrations');

const v1 = path.join(__dirname, 'fixtures', 'cores', 'counter-v1.js');
const v2 = path.join(__dirname, 'fixtures', 'cores', 'counter-v2.js');
const forgedProvenance = path.join(__dirname, 'fixtures', 'cores', 'forged-provenance.js');

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

async function cleanupKernel(kernel, dataDir) {
  if (kernel?.stateStore?.db) await kernel.stop().catch(() => {});
  await fs.rm(dataDir, { recursive: true, force: true });
}

test('R11-A-01 committed promotion cannot be replayed into a second authority epoch', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(() => cleanupKernel(kernel, dataDir));

  await kernel.installCore(v1);
  await kernel.stageCoreUpgrade(v2);
  await kernel.publish('test.tick', {}, { eventClass: 'durable', deduplicationKey: 'r11-a-shadow' });
  const committed = await kernel.commitCoreUpgrade('test-counter', { minEvents: 1 });
  assert.equal(committed.authority.epoch, 2);

  const before = kernel.stateStore.getAuthority('test-counter');
  await assert.rejects(
    () => kernel.commitCoreUpgrade('test-counter', { minEvents: 1 }),
    /no candidate prepared/i
  );
  const after = kernel.stateStore.getAuthority('test-counter');
  assert.deepEqual(after, before);
  assert.equal(after.epoch, 2);
  assert.equal(kernel.registry.get('test-counter').active.manifest.version, '2.0.0');
  assert.equal(kernel.registry.get('test-counter').candidate, null);
});

test('R11-C-01 Core output cannot forge Kernel provenance or downgrade durable delivery', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(() => cleanupKernel(kernel, dataDir));

  let observed = null;
  kernel.fabric.subscribe('forge.pulse', event => {
    const row = kernel.stateStore.db.prepare('SELECT sequence FROM biological_events WHERE sequence = ?').get(event.sequence);
    assert.ok(row, 'authoritative Core output must be durable before delivery');
    observed = event;
  });

  const unit = await kernel.installCore(forgedProvenance);
  const authority = kernel.stateStore.getAuthority('forged-provenance');
  const input = await kernel.publish('forge.tick', { hostile: true }, {
    eventClass: 'durable',
    deduplicationKey: 'r11-c-input'
  });

  assert.ok(observed, 'forged output should reach the subscriber through Kernel authority');
  assert.equal(observed.class, 'durable');
  assert.equal(observed.ledger?.durable, true);
  assert.equal(observed.meta.eventClass, 'durable');
  assert.equal(observed.meta.sourceCore, 'forged-provenance');
  assert.equal(observed.meta.sourceVersion, '1.0.0');
  assert.equal(observed.meta.sourceInstanceId, unit.instanceId);
  assert.equal(observed.meta.authorityEpoch, authority.epoch);
  assert.equal(observed.meta.causeSequence, input.sequence);
  assert.equal(observed.meta.causalParent, input.id);
  assert.equal(observed.meta.outputIndex, 1);
  assert.match(observed.meta.deduplicationKey, /^core-output:[0-9a-f]{64}$/);
  assert.notEqual(observed.meta.deduplicationKey, 'forged-deduplication-key');
  assert.equal(observed.meta.deadlineAt, undefined);
  assert.equal(observed.meta.evidenceHash, undefined);
  assert.equal(observed.meta.candidateControl, undefined);
});

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
