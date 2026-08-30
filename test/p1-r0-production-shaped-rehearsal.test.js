'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EventFabric } = require('../runtime/kernel/event-fabric');
const { ResidentManager } = require('../runtime/kernel/resident-manager');
const { StateStore } = require('../runtime/kernel/state-store');
const q48 = require('../runtime/p1-r0/q16-48');
const {
  LAB_STORAGE_AUTHORIZATION,
  P1LaboratoryPersistence
} = require('../runtime/p1-r0/laboratory-persistence');
const { P1_R0_RESIDENT_CONTRACTS } = require('../runtime/p1-r0/resident-contracts');
const { FOUNDER_TOPICS, sha256 } = require('../runtime/p1-r0/resident-support');
const { createSntssInteroReceptor } = require('../runtime/p1-r0/sntss-receptor');
const profiles = require('../runtime/p1-r0/c0-source-contracts/contracts/founder_profile_templates.json').profiles;

const ROOT = path.resolve(__dirname, '..');
const IDENTITY = Object.freeze({ organismId: 'stay-p1-r0-rehearsal', lineage: 'STAY/Genesis' });
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
    issuedAt: 10_000,
    runtimeRevision: 123,
    authorityEpoch: 1,
    kernelVersion: '0.8.11.3'
  };
}

function founderBinding(coreId) {
  const profile = JSON.parse(JSON.stringify(profiles[coreId]));
  return {
    recordVersion: 'P1ResidentFounderBindingV1',
    coreId,
    organismId: IDENTITY.organismId,
    organismIdentityHash: IDENTITY_HASH,
    founderId: `founder:${coreId.toLowerCase()}:rehearsal`,
    lineageId: `lineage:${coreId.toLowerCase()}:rehearsal`,
    residencyId: `resident:${coreId.toLowerCase()}`,
    profileId: profile.profileId,
    profileHash: sha256(profile),
    profile,
    mode: 'SHADOW',
    authorityEpoch: '0'
  };
}

function founderRecord(coreId) {
  const bindingRecord = founderBinding(coreId);
  return {
    recordVersion: 'P1FounderRecordV1',
    organismId: bindingRecord.organismId,
    coreId,
    founderId: bindingRecord.founderId,
    lineageId: bindingRecord.lineageId,
    profileId: bindingRecord.profileId,
    profileHash: bindingRecord.profileHash,
    founderSchemaId: `urn:stay:p1-r0:schema:${coreId.toLowerCase()}-founder-profile:v1`,
    founderSchemaVersion: '1',
    genesisFrame: 0,
    genesisTransactionId: `tx:${coreId.toLowerCase()}:rehearsal-genesis`,
    phenotypeHash: sha256({ coreId, profile: bindingRecord.profile }),
    committed: true,
    previousFounderId: null
  };
}

function chipObservation(coreId, checkpoint, state, observedUtc) {
  const active = state === 'SHADOW';
  const offline = state === 'OFFLINE';
  return {
    recordVersion: 'CoreChipObservationV1',
    chipId: `resident:${coreId.toLowerCase()}`,
    organismId: IDENTITY.organismId,
    coreId,
    publicName: coreId,
    born: true,
    firstActivationFrame: 0,
    firstResidencyId: `resident:${coreId.toLowerCase()}`,
    currentState: state,
    mode: active ? 'SHADOW' : offline ? 'NONE' : 'NEUTRAL',
    lifecycle: offline ? 'DETACHED' : active ? 'RUNNING' : 'ATTACHED',
    healthReasonCode: offline ? 'LAB_REMOVAL' : active ? 'LAB_SHADOW_HEALTHY' : 'LAB_NEUTRAL_ACCEPTED',
    coreVersion: '0.1.0-p1r0-lab',
    stateSchemaVersion: '1',
    checkpointGeneration: String(checkpoint.generation),
    lastTrustedFrame: checkpoint.state.engineState ? checkpoint.state.engineState.frameIndex : null,
    coverageBand: active ? 'FULL' : offline ? 'NOT_APPLICABLE' : 'UNKNOWN',
    evidenceRefs: [`sha256:${checkpoint.blobHash}`],
    observedUtc
  };
}

function databaseDigest(root) {
  return fs.readFile(path.join(root, 'continuity.sqlite3')).then(bytes =>
    crypto.createHash('sha256').update(bytes).digest('hex'));
}

function createFabric(stateStore, clock) {
  return new EventFabric({
    clock,
    sequenceAllocator: ({ minimum }) => stateStore.reserveEventSequence(minimum),
    durableAppender: envelope => stateStore.appendBiologicalEvent(envelope)
  });
}

function createManager(stateStore, fabric, clock) {
  return new ResidentManager({
    releaseRoot: ROOT,
    stateStore,
    fabric,
    identity: IDENTITY,
    clock,
    logger: { log() {}, info() {}, warn() {}, error() {} },
    contracts: P1_R0_RESIDENT_CONTRACTS
  });
}

async function publish(fabric, topic, payload, key) {
  return fabric.publish(topic, payload, {
    sourceCore: 'p1-r0-laboratory',
    sourceVersion: '0.1.0-p1r0-lab',
    authorityEpoch: 0,
    eventClass: 'durable',
    deduplicationKey: key
  });
}

test('P1-REHEARSAL-01 cloned StateStore survives crash, replay, removal and reattachment without authority', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-p1-r0-shaped-'));
  const sourceRoot = path.join(root, 'source');
  const cloneRoot = path.join(root, 'clone');
  await fs.mkdir(sourceRoot);
  let stateStore = null;
  const managers = [];
  t.after(async () => {
    for (const residentManager of managers.reverse()) await residentManager.shutdown().catch(() => {});
    try { stateStore?.close(); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });

  let now = 10_000;
  const clock = () => now++;
  const sourceStore = new StateStore(sourceRoot);
  await sourceStore.init();
  const sourceFabric = createFabric(sourceStore, clock);
  await publish(sourceFabric, 'runtime.rehearsal.baseline', { baseline: 'R123F-CLONE' }, 'baseline-1');
  sourceStore.close();
  const sourceHashBefore = await databaseDigest(sourceRoot);
  await fs.cp(sourceRoot, cloneRoot, { recursive: true, errorOnExist: true });

  stateStore = new StateStore(cloneRoot);
  await stateStore.init();
  const storage = new P1LaboratoryPersistence({
    stateStore,
    authorization: LAB_STORAGE_AUTHORIZATION
  }).initialize();
  for (const coreId of ['METAB', 'HOMEOS', 'INTERO']) storage.commitFounder(founderRecord(coreId));

  const fabric = createFabric(stateStore, clock);
  const observed = [];
  fabric.subscribeAll(event => observed.push(event));
  let manager = createManager(stateStore, fabric, clock);
  managers.push(manager);
  for (const coreId of ['METAB', 'HOMEOS', 'INTERO']) {
    await manager.attach({ moduleRelativePath: MODULES[coreId], binding: binding() });
    const checkpoint = await stateStore.readResidentCheckpoint(`resident:${coreId.toLowerCase()}`);
    storage.appendChipObservation(chipObservation(coreId, checkpoint, 'NEUTRAL', '2026-08-30T12:00:00.000Z'));
  }
  for (const coreId of ['METAB', 'HOMEOS', 'INTERO']) {
    const founderEvent = await publish(
      fabric,
      FOUNDER_TOPICS[coreId],
      founderBinding(coreId),
      `founder-${coreId.toLowerCase()}`
    );
    await manager.drain(`resident:${coreId.toLowerCase()}`, founderEvent.sequence);
  }

  const eligible = await publish(fabric, 'resource.capacity.eligible.v1', {
    eligibleCapacityQ48: q48.SCALE.toString(),
    safetyCeilingQ48: q48.SCALE.toString(),
    capacityClass: 'STANDARD',
    sampleFrame: 1
  }, 'capacity-eligible-1');
  await manager.drain('resident:metab', eligible.sequence);

  const originalPublish = fabric.publish.bind(fabric);
  let failOneMetabOutput = true;
  fabric.publish = async (topic, payload, meta) => {
    if (failOneMetabOutput && meta?.sourceCore === 'METAB') {
      failOneMetabOutput = false;
      throw Object.assign(new Error('simulated crash boundary'), { code: 'P1_REHEARSAL_CRASH' });
    }
    return originalPublish(topic, payload, meta);
  };
  const quality = await publish(fabric, 'resource.capacity.quality.v1', {
    status: 'VALID',
    qualityQ48: q48.SCALE.toString(),
    ceilingVerified: true,
    reasonCodes: []
  }, 'capacity-quality-1');
  await manager.drain('resident:metab', quality.sequence);
  const pendingBeforeCrash = stateStore.listPendingBiologicalOutboxIntents({ producerCoreId: 'METAB' });
  assert.equal(pendingBeforeCrash.length, 4);
  const pendingEventIds = pendingBeforeCrash.map(intent => intent.producerEventId);

  await manager.shutdown();
  fabric.publish = originalPublish;
  manager = createManager(stateStore, fabric, clock);
  managers.push(manager);
  for (const coreId of ['METAB', 'HOMEOS', 'INTERO']) {
    await manager.recover(`resident:${coreId.toLowerCase()}`, binding());
  }
  const metabEvents = observed.filter(event => event.meta?.sourceCore === 'METAB');
  const homeosEvents = observed.filter(event => event.meta?.sourceCore === 'HOMEOS');
  assert.equal(metabEvents.length, 4);
  assert.equal(homeosEvents.length, 3);
  assert.deepEqual(
    metabEvents.map(event => event.meta.deduplicationKey).sort(),
    pendingEventIds.map(id => `core-output:${id}`).sort()
  );
  assert.equal(metabEvents.every(event => event.meta.authorityMode === 'shadow'), true);
  assert.equal(homeosEvents.every(event => event.payload.causalSpan.containsShadow), true);
  assert.equal(homeosEvents.every(event => event.payload.causalSpan.ancestors.length === 2), true);
  assert.equal(stateStore.listPendingBiologicalOutboxIntents({ producerCoreId: 'METAB' }).length, 0);
  assert.equal(stateStore.listPendingBiologicalOutboxIntents({ producerCoreId: 'HOMEOS' }).length, 0);
  assert.deepEqual(stateStore.listAuthority(), []);

  for (const coreId of ['METAB', 'HOMEOS', 'INTERO']) {
    const checkpoint = await stateStore.readResidentCheckpoint(`resident:${coreId.toLowerCase()}`);
    storage.appendChipObservation(chipObservation(coreId, checkpoint, 'SHADOW', '2026-08-30T12:01:00.000Z'));
    assert.equal(checkpoint.state.founder.lineageId, founderBinding(coreId).lineageId);
  }
  const interoCheckpoint = await stateStore.readResidentCheckpoint('resident:intero');
  assert.equal(interoCheckpoint.state.engineState.frameIndex, 4);
  assert.ok(interoCheckpoint.state.lastProjection);

  const beforeRemoval = interoCheckpoint.state;
  await manager.detach('resident:intero');
  const detachedCheckpoint = await stateStore.readResidentCheckpoint('resident:intero');
  storage.appendChipObservation(chipObservation('INTERO', detachedCheckpoint, 'OFFLINE', '2026-08-30T12:02:00.000Z'));
  const receptor = createSntssInteroReceptor();
  const revoked = receptor.revoke();
  assert.equal(revoked.routeStage, 'ABSENT');
  assert.equal(revoked.revocationGeneration, 1);
  await manager.reattach('resident:intero', binding());
  const reattachedCheckpoint = await stateStore.readResidentCheckpoint('resident:intero');
  assert.equal(JSON.stringify(reattachedCheckpoint.state.engineState), JSON.stringify(beforeRemoval.engineState));
  storage.appendChipObservation(chipObservation('INTERO', reattachedCheckpoint, 'SHADOW', '2026-08-30T12:03:00.000Z'));

  assert.deepEqual(
    storage.listChipHistory('resident:intero').map(entry => entry.record.currentState),
    ['NEUTRAL', 'SHADOW', 'OFFLINE', 'SHADOW']
  );
  for (const coreId of ['METAB', 'HOMEOS', 'INTERO']) {
    assert.equal(storage.verifyChipHistory(`resident:${coreId.toLowerCase()}`), true);
  }
  await manager.shutdown();
  stateStore.close();
  assert.equal(await databaseDigest(sourceRoot), sourceHashBefore);
});

test('P1-REHEARSAL-02 corrupt newest checkpoint falls back and replays forward without biological rewind', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-p1-r0-rollback-'));
  const stateStore = new StateStore(root);
  await stateStore.init();
  let now = 20_000;
  const clock = () => now++;
  const fabric = createFabric(stateStore, clock);
  const observed = [];
  fabric.subscribeAll(event => {
    if (event.meta?.sourceCore === 'METAB') observed.push(event);
  });
  const managers = [];
  t.after(async () => {
    for (const manager of managers.reverse()) await manager.shutdown().catch(() => {});
    try { stateStore.close(); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });

  const first = createManager(stateStore, fabric, clock);
  managers.push(first);
  await first.attach({ moduleRelativePath: MODULES.METAB, binding: binding() });
  const founderEvent = await publish(fabric, FOUNDER_TOPICS.METAB, founderBinding('METAB'), 'rollback-founder');
  await first.drain('resident:metab', founderEvent.sequence);
  const eligibleEvent = await publish(fabric, 'resource.capacity.eligible.v1', {
    eligibleCapacityQ48: q48.SCALE.toString(),
    safetyCeilingQ48: q48.SCALE.toString(),
    capacityClass: 'STANDARD',
    sampleFrame: 1
  }, 'rollback-eligible');
  await first.drain('resident:metab', eligibleEvent.sequence);
  const qualityEvent = await publish(fabric, 'resource.capacity.quality.v1', {
    status: 'VALID',
    qualityQ48: q48.SCALE.toString(),
    ceilingVerified: true,
    reasonCodes: []
  }, 'rollback-quality');
  await first.drain('resident:metab', qualityEvent.sequence);
  const expected = await stateStore.readResidentCheckpoint('resident:metab');
  const expectedState = JSON.stringify(expected.state);
  assert.equal(observed.length, 4);
  await first.shutdown();
  await fs.writeFile(stateStore.blobPath(expected.blobHash), 'corrupt-newest-checkpoint');

  const recovered = createManager(stateStore, fabric, clock);
  managers.push(recovered);
  await recovered.recover('resident:metab', binding());
  const actual = await stateStore.readResidentCheckpoint('resident:metab');
  assert.equal(JSON.stringify(actual.state), expectedState);
  assert.equal(actual.state.engineState.frameIndex, 1);
  assert.equal(actual.state.engineState.outputSequence, '4');
  assert.equal(observed.length, 4);
  assert.deepEqual(stateStore.listAuthority(), []);
  assert.ok(actual.generation > expected.generation);
  const repairedBlob = await fs.readFile(stateStore.blobPath(actual.blobHash));
  assert.equal(crypto.createHash('sha256').update(repairedBlob).digest('hex'), actual.blobHash);
});
