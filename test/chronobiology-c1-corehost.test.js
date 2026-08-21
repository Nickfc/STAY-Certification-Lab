'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { stableStringify } = require('../runtime/kernel/canonical-json');
const {
  enforcePackagePolicy,
  verifyManifestAgainstPackagePolicy,
} = require('../runtime/kernel/package-policy');
const { manifest, createCore, migrateState } = require('../cores/chronobiology/c3');
const {
  ResidentManager,
  L0_SNTSS_CONTRACT,
  CHRONOBIOLOGY_RESIDENT_CONTRACT,
} = require('../runtime/kernel/resident-manager');

function binding() {
  return {
    id: 'binding-c1',
    topic: 'runtime.organism.binding',
    at: 50,
    payload: {
      bindingVersion: 1,
      identitySha256: `sha256:${'b'.repeat(64)}`,
      organismLineage: 'STAY/Genesis',
      issuedAt: 50,
      runtimeRevision: 1,
      authorityEpoch: 5,
      kernelVersion: '0.8.11.3',
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 5 },
  };
}

function pulse(sequence, trustedTimeUs) {
  return {
    id: `trusted-c1-${sequence}`,
    topic: 'runtime.trusted-organism-time.pulse',
    at: 500_000 + sequence,
    payload: {
      runtimeRevision: 1,
      pulseSequence: sequence,
      status: 'TRUSTED',
      trustedTimeUs,
      continuityEpoch: 1,
      reasonCode: null,
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 5 },
  };
}

test('CHR-C1-HOST-01 manifest is neutral, bounded, production-ineligible signalling resident', () => {
  assert.equal(manifest.coreId, 'chronobiology');
  assert.equal(manifest.stateSchema, 2);
  assert.equal(manifest.productionEligible, false);
  assert.deepEqual(manifest.inputs, [
    'runtime.organism.binding',
    'runtime.trusted-organism-time.pulse',
    'environment.photic.exposure',
  ]);
  assert.deepEqual(manifest.outputs, ['chronobiology.phase.summary']);
  assert.equal(manifest.resources.hardRamMiB, 96);
  assert.equal(manifest.resources.pidsMax, 16);
  assert.equal(manifest.resources.queueCapacity, 256);
});

test('CHR-C1-HOST-02 CoreHost lifecycle persists exact founder through later shadow surface', async () => {
  const core = await createCore();
  await core.start();
  assert.equal(await core.handle(binding()), undefined);
  assert.equal(await core.handle(pulse(1, 1_000_000)), undefined);
  const checkpoint = await core.snapshot();
  assert.equal(checkpoint.genesis !== null, true);

  const restarted = await createCore({ initialState: checkpoint });
  await restarted.start();
  assert.equal(stableStringify(await restarted.snapshot()), stableStringify(checkpoint));
  assert.equal((await restarted.health()).genesisEstablished, true);
  await restarted.stop();
});

test('CHR-C1-HOST-02A package is hash-bound and resource policy matches its manifest', () => {
  const record = enforcePackagePolicy(require.resolve('../cores/chronobiology/c3'));
  assert.equal(record.attestedFiles, 20);
  assert.doesNotThrow(() => verifyManifestAgainstPackagePolicy(record, manifest));
  assert.equal(record.policy.ambientCapabilities.network, false);
  assert.equal(record.policy.bounds.productionOutputs, 0);
});

test('CHR-C1-HOST-02B real package satisfies the additive resident contract', async (t) => {
  const manager = new ResidentManager({
    releaseRoot: require('node:path').resolve(__dirname, '..'),
    stateStore: {},
    fabric: { subscribeAll: () => () => {} },
    identity: { lineage: 'STAY/Genesis' },
    contracts: [L0_SNTSS_CONTRACT, CHRONOBIOLOGY_RESIDENT_CONTRACT],
  });
  t.after(() => manager.shutdown());
  const inspected = await manager.inspect('cores/chronobiology/c3/index.js');
  assert.equal(inspected.contract.residencyId, 'resident:chronobiology');
  assert.equal(inspected.contract.authorityMode, 'shadow');
  assert.equal(inspected.contract.productionEligible, false);
});

test('CHR-C1-HOST-03 replay from same committed checkpoint is byte-identical', async () => {
  const first = await createCore();
  await first.handle(binding());
  await first.handle(pulse(1, 1_000_000));
  const checkpoint = await first.snapshot();

  const left = await createCore({ initialState: checkpoint });
  const right = await createCore({ initialState: checkpoint });
  const event = pulse(2, 61_000_000);
  await left.handle(event);
  await right.handle(event);
  assert.equal(stableStringify(await left.snapshot()), stableStringify(await right.snapshot()));
});

test('C2-PERS-08 schema-v1 representation migrates forward without changing biology', async () => {
  const core = await createCore();
  await core.handle(binding());
  await core.handle(pulse(1, 1_000_000));
  const checkpoint = await core.snapshot();
  assert.equal(stableStringify(await migrateState({
    state: checkpoint, fromSchema: 2, toSchema: 2,
  })), stableStringify(checkpoint));
  const legacy = structuredClone(checkpoint);
  legacy.schema = 'chronobiology.state/v1';
  legacy.continuity.state_schema_version = 1;
  delete legacy.continuity.representation_migrations;
  delete legacy.continuity.deferred_trusted_time_evidence;
  delete legacy.acquired.aggregate_phase_history;
  const before = stableStringify(legacy);
  const migrated = await migrateState({ state: legacy, fromSchema: 1, toSchema: 2 });
  assert.equal(stableStringify(legacy), before);
  assert.equal(migrated.schema, 'chronobiology.state/v2');
  assert.equal(migrated.genesis.phenotype_hash, checkpoint.genesis.phenotype_hash);
  assert.equal(stableStringify(migrated.phenotype), stableStringify(checkpoint.phenotype));
  assert.equal(stableStringify(migrated.acquired.oscillators),
    stableStringify(checkpoint.acquired.oscillators));
  assert.equal(migrated.continuity.committed_through_us,
    checkpoint.continuity.committed_through_us);
  assert.equal(migrated.continuity.representation_migrations[0].migration_id,
    'chronobiology-state-v1-to-v2');
});

test('C2-PERS-09 rollback to older schema refuses without mutating committed state', async () => {
  const core = await createCore();
  await core.handle(binding());
  await core.handle(pulse(1, 1_000_000));
  const checkpoint = await core.snapshot();
  const before = stableStringify(checkpoint);
  await assert.rejects(() => migrateState({
    state: checkpoint, fromSchema: 2, toSchema: 1,
  }), { code: 'CHRONOBIOLOGY_MIGRATION_UNSUPPORTED' });
  assert.equal(stableStringify(checkpoint), before);
});
