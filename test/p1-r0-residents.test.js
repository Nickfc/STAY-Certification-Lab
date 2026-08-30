'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { stableStringify } = require('../runtime/kernel/canonical-json');
const { CoreHostClient } = require('../runtime/kernel/core-host-client');
const { EventFabric } = require('../runtime/kernel/event-fabric');
const { validateManifest } = require('../runtime/kernel/manifest');
const { ResidentManager, createResidentContractRegistry } = require('../runtime/kernel/resident-manager');
const { StateStore } = require('../runtime/kernel/state-store');
const q48 = require('../runtime/p1-r0/q16-48');
const {
  P1_R0_RESIDENT_CONTRACTS
} = require('../runtime/p1-r0/resident-contracts');
const { FOUNDER_TOPICS, RESOURCES, sha256 } = require('../runtime/p1-r0/resident-support');
const metabDefinition = require('../runtime/p1-r0/residents/metab');
const homeosDefinition = require('../runtime/p1-r0/residents/homeos');
const interoDefinition = require('../runtime/p1-r0/residents/intero');
const profiles = require('../runtime/p1-r0/c0-source-contracts/contracts/founder_profile_templates.json').profiles;

const ROOT = path.resolve(__dirname, '..');
const IDENTITY = Object.freeze({ organismId: 'stay-p1-r0-resident-test', lineage: 'STAY/Genesis' });
const IDENTITY_HASH = sha256(IDENTITY);
const MODULES = Object.freeze({
  METAB: 'cores/p1-r0/metab/index.js',
  HOMEOS: 'cores/p1-r0/homeos/index.js',
  INTERO: 'cores/p1-r0/intero/index.js'
});

function binding() {
  return {
    bindingVersion: 1,
    identitySha256: IDENTITY_HASH,
    organismLineage: 'STAY/Genesis',
    issuedAt: 1_000,
    runtimeRevision: 123,
    authorityEpoch: 1,
    kernelVersion: '0.8.11.3'
  };
}

function founder(coreId) {
  const profile = JSON.parse(JSON.stringify(profiles[coreId]));
  return {
    recordVersion: 'P1ResidentFounderBindingV1',
    coreId,
    organismId: IDENTITY.organismId,
    organismIdentityHash: IDENTITY_HASH,
    founderId: `founder:${coreId.toLowerCase()}:0001`,
    lineageId: `lineage:${coreId.toLowerCase()}:0001`,
    residencyId: `resident:${coreId.toLowerCase()}`,
    profileId: profile.profileId,
    profileHash: sha256(profile),
    profile,
    mode: 'SHADOW',
    authorityEpoch: '0'
  };
}

function event(topic, payload, sequence) {
  return {
    id: `p1-r0-event-${sequence}`,
    sequence,
    class: 'durable',
    topic,
    payload,
    meta: { sourceCore: 'p1-r0-laboratory', authorityEpoch: 0 }
  };
}

function eligible(frameIndex, sequence) {
  return event('resource.capacity.eligible.v1', {
    eligibleCapacityQ48: q48.SCALE.toString(),
    safetyCeilingQ48: q48.SCALE.toString(),
    capacityClass: 'STANDARD',
    sampleFrame: frameIndex
  }, sequence);
}

function quality(sequence) {
  return event('resource.capacity.quality.v1', {
    status: 'VALID',
    qualityQ48: q48.SCALE.toString(),
    ceilingVerified: true,
    reasonCodes: []
  }, sequence);
}

async function bindCore(core, coreId, startSequence) {
  await core.handle(event('runtime.organism.binding', binding(), startSequence));
  await core.handle(event(FOUNDER_TOPICS[coreId], founder(coreId), startSequence + 1));
}

async function directPipeline() {
  const metabOutputs = [];
  const metab = await metabDefinition.createCore({
    emit: async (topic, payload, meta) => metabOutputs.push({ topic, payload, meta })
  });
  await bindCore(metab, 'METAB', 1);
  await metab.handle(eligible(1, 3));
  await metab.handle(quality(4));

  const homeosOutputs = [];
  const homeos = await homeosDefinition.createCore({
    emit: async (topic, payload, meta) => homeosOutputs.push({ topic, payload, meta })
  });
  await bindCore(homeos, 'HOMEOS', 5);
  let sequence = 7;
  for (const output of metabOutputs) {
    await homeos.handle(event(output.topic, output.payload, sequence++));
  }

  const intero = await interoDefinition.createCore();
  await bindCore(intero, 'INTERO', sequence);
  sequence += 2;
  for (const output of metabOutputs) {
    await intero.handle(event(output.topic, output.payload, sequence++));
  }
  for (const output of homeosOutputs.filter(value => value.topic === 'homeos.stability.summary.v1')) {
    await intero.handle(event(output.topic, output.payload, sequence++));
  }
  return { metab, metabOutputs, homeos, homeosOutputs, intero };
}

async function makeManagedRuntime(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-p1-r0-residents-'));
  const stateStore = new StateStore(dataDir);
  await stateStore.init();
  let now = 1_000;
  const fabric = new EventFabric({
    clock: () => now++,
    sequenceAllocator: ({ minimum }) => stateStore.reserveEventSequence(minimum),
    durableAppender: envelope => stateStore.appendBiologicalEvent(envelope)
  });
  const manager = new ResidentManager({
    releaseRoot: ROOT,
    stateStore,
    fabric,
    identity: IDENTITY,
    clock: () => now++,
    logger: { log() {}, info() {}, warn() {}, error() {} },
    contracts: P1_R0_RESIDENT_CONTRACTS
  });
  t.after(async () => {
    await manager.shutdown().catch(() => {});
    stateStore.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, stateStore, fabric, manager };
}

async function publish(runtime, topic, payload, key) {
  return runtime.fabric.publish(topic, payload, {
    sourceCore: 'p1-r0-laboratory',
    sourceVersion: '0.1.0-p1r0-lab',
    authorityEpoch: 0,
    eventClass: 'durable',
    deduplicationKey: key
  });
}

test('P1-RES-01 manifests and registry retain the unchanged optional-resident resource envelope', () => {
  const definitions = [metabDefinition, homeosDefinition, interoDefinition];
  const registry = createResidentContractRegistry(P1_R0_RESIDENT_CONTRACTS);
  assert.equal(registry.byCoreId.size, 3);
  for (const definition of definitions) {
    const checked = validateManifest(definition.manifest);
    assert.deepEqual(checked.resources, RESOURCES);
    assert.equal(checked.productionEligible, false);
    assert.equal(checked.priority, 'optional');
    assert.equal(checked.resources.handlerTimeoutMs, 250);
    assert.equal(checked.resources.hardRamMiB, 96);
    assert.equal(checked.resources.pidsMax, 16);
  }
  assert.equal(interoDefinition.manifest.outputs.length, 0);
});

test('P1-RES-02 external founder binding drives a real contained METAB->HOMEOS->INTERO pipeline', async () => {
  const pipeline = await directPipeline();
  assert.equal(pipeline.metabOutputs.length, 4);
  assert.equal(pipeline.metabOutputs.every(output => output.payload.producer.mode === 'SHADOW'), true);
  assert.equal(pipeline.homeosOutputs.length, 3);
  assert.equal(pipeline.homeosOutputs.every(output => output.payload.causalSpan.containsShadow), true);
  const interoState = await pipeline.intero.snapshot();
  assert.equal(interoState.engineState.frameIndex, 4);
  assert.ok(interoState.lastProjection);
  assert.deepEqual(interoDefinition.manifest.outputs, []);
  assert.doesNotMatch(stableStringify(interoState.lastProjection), /fear|pain|emotion|diagnosis|cause|self|action/i);
});

test('P1-RES-03 checkpoints preserve founder lineage and acquired state byte-identically across restart', async () => {
  const pipeline = await directPipeline();
  for (const [definition, core] of [
    [metabDefinition, pipeline.metab],
    [homeosDefinition, pipeline.homeos],
    [interoDefinition, pipeline.intero]
  ]) {
    const checkpoint = await core.snapshot();
    const restarted = await definition.createCore({ initialState: checkpoint });
    assert.equal(stableStringify(await restarted.snapshot()), stableStringify(checkpoint));
    assert.equal((await restarted.health()).foundered, true);
    assert.equal((await restarted.health()).authorityOwned, false);
  }
});

test('P1-RES-04 founder identity and runtime identity drift fail closed', async () => {
  const core = await metabDefinition.createCore();
  await bindCore(core, 'METAB', 1);
  const changedFounder = founder('METAB');
  changedFounder.founderId = 'founder:metab:other';
  await assert.rejects(
    () => core.handle(event(FOUNDER_TOPICS.METAB, changedFounder, 3)),
    { code: 'P1_METAB_FOUNDER_FENCE' }
  );
  const changedBinding = binding();
  changedBinding.identitySha256 = `sha256:${'a'.repeat(64)}`;
  await assert.rejects(
    () => core.handle(event('runtime.organism.binding', changedBinding, 4)),
    { code: 'P1_METAB_IDENTITY_FENCE' }
  );
});

test('P1-RES-05 real CoreHost executes METAB under the unchanged policy and returns durable checkpoints', async t => {
  const client = new CoreHostClient({
    modulePath: path.join(ROOT, 'runtime', 'p1-r0', 'residents', 'metab.js'),
    expectedManifest: metabDefinition.manifest,
    policy: metabDefinition.manifest,
    mode: 'standby',
    logger: { info() {}, warn() {}, error() {} }
  });
  t.after(() => client.stop().catch(() => {}));
  const outputs = [];
  client.on('output', message => outputs.push(message));
  await client.start({}, 1);
  let sequence = 1;
  for (const input of [
    event('runtime.organism.binding', binding(), sequence++),
    event(FOUNDER_TOPICS.METAB, founder('METAB'), sequence++),
    eligible(1, sequence++),
    quality(sequence++)
  ]) {
    const result = await client.dispatch(input, {
      coreId: 'METAB',
      implementationInstanceId: client.instanceId,
      authorityEpoch: 1,
      eventSequence: input.sequence,
      eventId: input.id
    });
    assert.ok(result.checkpoint);
    client.setRecoveryState(result.checkpoint, 1);
  }
  assert.equal(outputs.length, 4);
  assert.deepEqual(outputs.map(output => output.meta.outputIndex), [1, 2, 3, 4]);
  assert.equal((await client.health()).authorityOwned, false);
});

test('P1-RES-06 ResidentManager commits checkpoints, ACKs and shadow outbox frames through a real StateStore', async t => {
  const runtime = await makeManagedRuntime(t);
  const observed = [];
  runtime.fabric.subscribeAll(event => observed.push(event));
  for (const coreId of ['METAB', 'HOMEOS', 'INTERO']) {
    await runtime.manager.attach({ moduleRelativePath: MODULES[coreId], binding: binding() });
  }
  for (const coreId of ['METAB', 'HOMEOS', 'INTERO']) {
    const founderEvent = await publish(
      runtime,
      FOUNDER_TOPICS[coreId],
      founder(coreId),
      `p1-r0-founder-${coreId.toLowerCase()}`
    );
    await runtime.manager.drain(`resident:${coreId.toLowerCase()}`, founderEvent.sequence);
  }
  const eligibleEvent = await publish(runtime, 'resource.capacity.eligible.v1', eligible(1, 1).payload, 'capacity-eligible-1');
  await runtime.manager.drain('resident:metab', eligibleEvent.sequence);
  const qualityEvent = await publish(runtime, 'resource.capacity.quality.v1', quality(2).payload, 'capacity-quality-1');
  await runtime.manager.drain('resident:metab', qualityEvent.sequence);

  const metabFrames = observed.filter(value => value.meta?.sourceCore === 'METAB');
  assert.equal(metabFrames.length, 4);
  await runtime.manager.drain('resident:homeos', Math.max(...metabFrames.map(value => value.sequence)));
  const homeosFrames = observed.filter(value => value.meta?.sourceCore === 'HOMEOS');
  assert.equal(homeosFrames.length, 3);
  await runtime.manager.drain('resident:intero', Math.max(
    ...metabFrames.map(value => value.sequence),
    ...homeosFrames.map(value => value.sequence)
  ));

  for (const coreId of ['METAB', 'HOMEOS', 'INTERO']) {
    const residencyId = `resident:${coreId.toLowerCase()}`;
    const status = await runtime.manager.status(residencyId);
    const checkpoint = await runtime.stateStore.readResidentCheckpoint(residencyId);
    assert.equal(status.status, 'RUNNING');
    assert.equal(status.authorityOwned, false);
    assert.equal(status.packagePolicyHash, P1_R0_RESIDENT_CONTRACTS.find(value => value.coreId === coreId).packagePolicyHash);
    assert.ok(checkpoint.generation >= 3);
    assert.equal(checkpoint.state.founder.coreId, coreId);
  }
  const interoCheckpoint = await runtime.stateStore.readResidentCheckpoint('resident:intero');
  assert.equal(interoCheckpoint.state.engineState.frameIndex, 4);
  assert.ok(interoCheckpoint.state.lastProjection);
  assert.deepEqual(runtime.stateStore.listAuthority(), []);
  assert.equal(runtime.stateStore.listPendingBiologicalOutboxIntents({ producerCoreId: 'METAB' }).length, 0);
  assert.equal(runtime.stateStore.listPendingBiologicalOutboxIntents({ producerCoreId: 'HOMEOS' }).length, 0);
});

test('P1-RES-07 production package-policy enforcement accepts only the hash-bound resident package', async t => {
  const previous = process.env.STAY_REQUIRE_CORE_PACKAGE_POLICY;
  process.env.STAY_REQUIRE_CORE_PACKAGE_POLICY = '1';
  const manager = new ResidentManager({
    releaseRoot: ROOT,
    stateStore: {},
    fabric: { subscribeAll: () => () => {} },
    identity: IDENTITY,
    contracts: P1_R0_RESIDENT_CONTRACTS
  });
  t.after(async () => {
    await manager.shutdown();
    if (previous === undefined) delete process.env.STAY_REQUIRE_CORE_PACKAGE_POLICY;
    else process.env.STAY_REQUIRE_CORE_PACKAGE_POLICY = previous;
  });
  const inspected = await manager.inspect(MODULES.METAB);
  assert.equal(inspected.definition.packagePolicyHash, P1_R0_RESIDENT_CONTRACTS[0].packagePolicyHash);
  assert.deepEqual(Object.keys(inspected.definition.packagePolicy.files), ['index.js']);
});
