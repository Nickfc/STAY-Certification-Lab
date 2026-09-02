'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DURABILITY,
  createSignal,
  deriveSignal
} = require('../runtime/kernel/biological-fabric');
const { EventFabric } = require('../runtime/kernel/event-fabric');
const { LivingKernel } = require('../runtime/kernel/living-kernel');
const {
  ResidentManager
} = require('../runtime/kernel/resident-manager');
const { StateStore } = require('../runtime/kernel/state-store');
const {
  METAB_NEUTRAL_RESIDENT_CONTRACT
} = require('../runtime/p1-r0/metab-neutral-contract');
const {
  METAB_SHADOW_RESIDENT_CONTRACT
} = require('../runtime/p1-r0/metab-shadow-contract');
const {
  FRAME_INTERVAL_US,
  SOURCE_STATE_KEY,
  commitCapacitySample,
  createCapacityPayloads,
  createCapacitySourceState,
  stageCapacitySample,
  validateCapacitySourceState
} = require('../runtime/p1-r0/metab-capacity-source');
const { publicMetadata } = require('../server');
const {
  createNeutralMetabInitialState
} = require('../runtime/p1-r0/residents/metab-neutral');
const shadow = require('../runtime/p1-r0/residents/metab-shadow');
const {
  enforcePackagePolicy,
  verifyManifestAgainstPackagePolicy
} = require('../runtime/kernel/package-policy');
const { sha256 } = require('../runtime/p1-r0/resident-support');
const packageHashes = require('../runtime/p1-r0/resident-package-hashes.json');
const profiles = require(
  '../runtime/p1-r0/c0-source-contracts/contracts/founder_profile_templates.json'
).profiles;

const ROOT = path.resolve(__dirname, '..');
const INSTANCE_ID = 'd424c722-ef31-44b0-8201-ba68c418d14a';
const IDENTITY = Object.freeze({
  organismId: 'stay-r128-metab-shadow-test',
  createdAt: '2026-09-03T08:00:00.000Z',
  lineage: 'STAY/Genesis'
});
const IDENTITY_HASH = sha256(IDENTITY);
const PARENT_FREEZE = `sha256:${'7'.repeat(64)}`;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function binding() {
  return {
    bindingVersion: 1,
    identitySha256: IDENTITY_HASH,
    organismLineage: IDENTITY.lineage,
    issuedAt: 10_000,
    runtimeRevision: 124,
    authorityEpoch: 124,
    kernelVersion: '0.8.11.3'
  };
}

function founderBinding() {
  const profile = clone(profiles.METAB);
  profile.profileId = 'metab.p1-r0.production-founder-r128-test.v1';
  return {
    recordVersion: 'P1ResidentFounderBindingV1',
    coreId: 'METAB',
    organismId: IDENTITY.organismId,
    organismIdentityHash: IDENTITY_HASH,
    founderId: 'founder:metab:r128:test',
    lineageId: 'lineage:metab:r128:test',
    residencyId: 'resident:metab',
    profileId: profile.profileId,
    profileHash: sha256(profile),
    profile,
    mode: 'NEUTRAL',
    authorityEpoch: '0'
  };
}

function neutralState() {
  return createNeutralMetabInitialState({
    binding: binding(),
    founder: founderBinding()
  });
}

function eventFromSignal(signal, sequence, {
  sourceVersion,
  evidenceHash = null
} = {}) {
  return Object.freeze({
    id: `evt-${sequence}`,
    sequence,
    topic: signal.topic,
    class: 'durable',
    payload: clone(signal.payload),
    at: signal.trustedTime.observedAtMs,
    deadlineAt: null,
    meta: Object.freeze({
      eventClass: 'durable',
      sourceCore: signal.provenance.producerId,
      sourceVersion,
      authorityEpoch: signal.provenance.authorityEpoch,
      evidenceHash,
      biological: clone({
        protocol: signal.protocol,
        signalId: signal.signalId,
        durability: signal.durability,
        trustedTime: signal.trustedTime,
        causality: signal.causality,
        provenance: signal.provenance
      })
    }),
    ledger: Object.freeze({ durable: true })
  });
}

function activationSignal(sourceCheckpoint, {
  instanceId = INSTANCE_ID,
  organismIdentityHash = IDENTITY_HASH,
  outputPolicy = 'FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT'
} = {}) {
  const sourceHash = `sha256:${sourceCheckpoint.blobHash}`;
  return createSignal({
    signalId:
      `runtime.metab.shadow-activation:r128:g${sourceCheckpoint.generation}:${sourceCheckpoint.blobHash}`,
    topic: shadow.ACTIVATION_TOPIC,
    payload: {
      protocol: 'stay-p1-r0-metab-shadow-activation-v1',
      organismIdentityHash,
      residencyId: 'resident:metab',
      instanceId,
      fromVersion: '0.1.0-p1r0-neutral.1',
      fromStateSchema: 1,
      sourceCheckpointGeneration: sourceCheckpoint.generation,
      sourceCheckpointHash: sourceHash,
      toVersion: shadow.VERSION,
      toStateSchema: 2,
      runtimeRevision: 128,
      parentRevision: 127,
      parentFreezeRecordSha256: PARENT_FREEZE,
      mode: 'SHADOW',
      authorityEpoch: '0',
      outputPolicy
    },
    trustedTime: {
      source: 'kernel',
      observedAtMs: 20_000,
      pulseId:
        `metab-shadow-activation-r128-g${sourceCheckpoint.generation}`
    },
    provenance: {
      producerType: 'kernel',
      producerId: 'living-kernel',
      authorityEpoch: 128
    },
    durability: DURABILITY.DURABLE
  });
}

function capacitySignals(frame, observedAtMs = 21_000) {
  const payloads = createCapacityPayloads({
    sampleFrame: frame,
    metrics: {
      cpuCount: 4,
      loadAverageMilli: 1000,
      freeMemoryBytes: 6_000,
      totalMemoryBytes: 8_000
    }
  });
  const trustedTime = {
    source: 'kernel',
    observedAtMs,
    pulseId: `metab-capacity-r128-f${frame}`
  };
  const provenance = {
    producerType: 'kernel',
    producerId: 'kernel-resource',
    authorityEpoch: 0
  };
  const eligible = createSignal({
    signalId: `runtime.metab.capacity.eligible:r128:f${frame}`,
    topic: shadow.ELIGIBLE_TOPIC,
    payload: payloads.eligiblePayload,
    trustedTime,
    provenance,
    durability: DURABILITY.DURABLE
  });
  const quality = deriveSignal(eligible, {
    signalId: `runtime.metab.capacity.quality:r128:f${frame}`,
    topic: shadow.QUALITY_TOPIC,
    payload: payloads.qualityPayload,
    trustedTime,
    provenance,
    durability: DURABILITY.DURABLE
  });
  return { eligible, quality };
}

async function makeManager(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'stay-r128-metab-shadow-')
  );
  const stateStore = new StateStore(root);
  await stateStore.init();
  let now = 30_000;
  const fabric = new EventFabric({
    clock: () => now++,
    sequenceAllocator: ({ minimum }) =>
      stateStore.reserveEventSequence(minimum),
    durableAppender: envelope =>
      stateStore.appendBiologicalEvent(envelope)
  });
  const manager = new ResidentManager({
    releaseRoot: ROOT,
    stateStore,
    fabric,
    identity: IDENTITY,
    clock: () => now++,
    logger: { log() {}, info() {}, warn() {}, error() {} },
    contracts: [METAB_NEUTRAL_RESIDENT_CONTRACT]
  });
  t.after(async () => {
    await manager.shutdown().catch(() => {});
    try { stateStore.close(); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });

  await manager.attach({
    moduleRelativePath: 'cores/p1-r0/metab-neutral/index.js',
    binding: binding(),
    initialState: neutralState(),
    instanceId: INSTANCE_ID
  });

  return { stateStore, fabric, manager };
}

test('R128-METAB-SOURCE-01 deterministic capacity mapping is bounded and interval-fenced', () => {
  const payloads = createCapacityPayloads({
    sampleFrame: 1,
    metrics: {
      cpuCount: 4,
      loadAverageMilli: 1000,
      freeMemoryBytes: 6_000,
      totalMemoryBytes: 8_000
    }
  });
  assert.equal(payloads.eligiblePayload.eligibleCapacityQ48, '211106232532992');
  assert.equal(payloads.eligiblePayload.safetyCeilingQ48, '281474976710656');
  assert.equal(payloads.qualityPayload.status, 'VALID');
  assert.equal(payloads.qualityPayload.ceilingVerified, true);

  const first = createCapacitySourceState({
    instanceId: INSTANCE_ID,
    residentVersion: shadow.VERSION
  });
  const staged = stageCapacitySample(first, {
    trustedTimeUs: 1_000_000,
    continuityEpoch: 1,
    metrics: {
      cpuCount: 4,
      loadAverageMilli: 1000,
      freeMemoryBytes: 6_000,
      totalMemoryBytes: 8_000
    }
  });
  assert.equal(staged.pending.sampleFrame, 1);
  const committed = commitCapacitySample(staged);
  assert.equal(committed.lastCommittedFrame, 1);
  assert.equal(committed.lastTrustedTimeUs, 1_000_000);
  assert.equal(committed.lastContinuityEpoch, 1);
  assert.equal(
    stageCapacitySample(committed, {
      trustedTimeUs: 1_000_000 + FRAME_INTERVAL_US - 1,
      continuityEpoch: 1,
      metrics: {
        cpuCount: 4,
        loadAverageMilli: 0,
        freeMemoryBytes: 8_000,
        totalMemoryBytes: 8_000
      }
    }).pending,
    null
  );
  assert.equal(
    stageCapacitySample(committed, {
      trustedTimeUs: 1_000_000 + FRAME_INTERVAL_US,
      continuityEpoch: 1,
      metrics: {
        cpuCount: 4,
        loadAverageMilli: 0,
        freeMemoryBytes: 8_000,
        totalMemoryBytes: 8_000
      }
    }).pending.sampleFrame,
    2
  );
});

test('R128-METAB-SOURCE-02 source state rejects identity drift, invented time and corrupt pending pairs', () => {
  const base = createCapacitySourceState({
    instanceId: INSTANCE_ID,
    residentVersion: shadow.VERSION
  });
  assert.throws(
    () => validateCapacitySourceState(
      { ...base, instanceId: 'other-instance' },
      { instanceId: INSTANCE_ID, residentVersion: shadow.VERSION }
    ),
    { code: 'P1_METAB_CAPACITY_SOURCE_STATE' }
  );
  const staged = stageCapacitySample(base, {
    trustedTimeUs: 1_000_000,
    continuityEpoch: 1,
    metrics: {
      cpuCount: 4,
      loadAverageMilli: 0,
      freeMemoryBytes: 8_000,
      totalMemoryBytes: 8_000
    }
  });
  assert.throws(
    () => validateCapacitySourceState(
      {
        ...staged,
        pending: {
          ...staged.pending,
          pulseId: 'metab-capacity-r128-f2'
        }
      },
      { instanceId: INSTANCE_ID, residentVersion: shadow.VERSION }
    ),
    { code: 'P1_METAB_CAPACITY_SOURCE_STATE' }
  );
  const epochTwo = commitCapacitySample(stageCapacitySample(base, {
    trustedTimeUs: 1_000_000,
    continuityEpoch: 2,
    metrics: {
      cpuCount: 4,
      loadAverageMilli: 0,
      freeMemoryBytes: 8_000,
      totalMemoryBytes: 8_000
    }
  }));
  assert.throws(
    () => stageCapacitySample(epochTwo, {
      trustedTimeUs: 1_250_000,
      continuityEpoch: 1,
      metrics: {
        cpuCount: 4,
        loadAverageMilli: 0,
        freeMemoryBytes: 8_000,
        totalMemoryBytes: 8_000
      }
    }),
    { code: 'P1_METAB_CAPACITY_SOURCE_STATE' }
  );
});

test('R128-METAB-CORE-01 neutral checkpoint migrates without reroll and activates as output-firewalled SHADOW', async () => {
  const neutral = neutralState();
  const migrated = await shadow.migrateState({
    state: neutral,
    fromSchema: 1,
    toSchema: 2
  });
  assert.deepEqual(migrated.founder, neutral.founder);
  assert.deepEqual(migrated.engineState, neutral.engineState);
  assert.equal(migrated.activation, null);

  const emitted = [];
  const core = await shadow.createCore({
    initialState: migrated,
    emit: (...args) => emitted.push(args)
  });
  await core.start();
  const sourceCheckpoint = {
    generation: 2,
    blobHash: sha256(JSON.stringify(neutral)).slice(7)
  };
  const activation = activationSignal(sourceCheckpoint);
  await core.handle(eventFromSignal(activation, 10, {
    sourceVersion: '0.8.11.3',
    evidenceHash: IDENTITY_HASH
  }));
  assert.equal((await core.health()).mode, 'SHADOW');
  assert.equal((await core.health()).biologicalOutputs, 0);

  const pair = capacitySignals(1);
  await core.handle(eventFromSignal(pair.eligible, 11, {
    sourceVersion: '1.0.0'
  }));
  assert.equal((await core.snapshot()).pendingEligible.sampleFrame, 1);
  await core.handle(eventFromSignal(pair.quality, 12, {
    sourceVersion: '1.0.0'
  }));
  const state = await core.snapshot();
  assert.equal(state.lastAcceptedFrame, 1);
  assert.equal(state.engineState.frameIndex, 1);
  assert.equal(state.engineState.outputSequence, '0');
  assert.equal(state.handledEvents, 2);
  assert.deepEqual(emitted, []);
});

test('R128-METAB-CORE-02 mismatched source frames and forged provenance fail closed', async () => {
  const migrated = await shadow.migrateState({
    state: neutralState(),
    fromSchema: 1,
    toSchema: 2
  });
  const core = await shadow.createCore({ initialState: migrated });
  const sourceCheckpoint = {
    generation: 3,
    blobHash: 'a'.repeat(64)
  };
  const activation = activationSignal(sourceCheckpoint);
  await core.handle(eventFromSignal(activation, 10, {
    sourceVersion: '0.8.11.3',
    evidenceHash: IDENTITY_HASH
  }));
  const pair1 = capacitySignals(1, 21_000);
  const pair2 = capacitySignals(2, 21_250);
  await core.handle(eventFromSignal(pair1.eligible, 11, {
    sourceVersion: '1.0.0'
  }));
  await assert.rejects(
    () => core.handle(eventFromSignal(pair2.quality, 12, {
      sourceVersion: '1.0.0'
    })),
    { code: 'P1_METAB_SHADOW_PAIR' }
  );

  const second = await shadow.createCore({ initialState: migrated });
  const forged = eventFromSignal(activation, 20, {
    sourceVersion: '0.8.11.3',
    evidenceHash: IDENTITY_HASH
  });
  forged.meta.biological.provenance.producerId = 'browser';
  await assert.rejects(
    () => second.handle(forged),
    { code: 'P1_METAB_SHADOW_PROVENANCE' }
  );

  const wrongVersion = await shadow.createCore({ initialState: migrated });
  await assert.rejects(
    () => wrongVersion.handle(eventFromSignal(activation, 21, {
      sourceVersion: '0.8.11.2',
      evidenceHash: IDENTITY_HASH
    })),
    { code: 'P1_METAB_SHADOW_PROVENANCE' }
  );
});

test('R128-METAB-PACKAGE-03 shadow package preserves limits and declares no output or authority surface', () => {
  const packageRoot = path.join(ROOT, 'cores', 'p1-r0', 'metab-shadow');
  const policy = enforcePackagePolicy(path.join(packageRoot, 'index.js'));
  const definition = require(path.join(packageRoot, 'index.js'));
  assert.equal(policy.policy.policyHash, packageHashes.METAB_SHADOW);
  assert.equal(policy.policy.bounds.productionOutputs, 0);
  assert.equal(policy.policy.resourceContract.manifestResources.handlerTimeoutMs, 250);
  assert.equal(policy.policy.resourceContract.manifestResources.hardRamMiB, 96);
  assert.equal(policy.policy.resourceContract.manifestResources.pidsMax, 16);
  assert.equal(verifyManifestAgainstPackagePolicy(policy, definition.manifest), true);
  assert.deepEqual(definition.manifest.outputs, []);
  assert.deepEqual(definition.manifest.biology.producerCapabilities, []);
  assert.deepEqual(definition.manifest.biology.consumerRouteLeases, []);
  assert.deepEqual(
    METAB_SHADOW_RESIDENT_CONTRACT.inputs,
    definition.manifest.inputs
  );
});

test('R128-METAB-PROMOTE-04 atomic promotion preserves instance, lineage and zero-output containment', async t => {
  const { stateStore, fabric, manager } = await makeManager(t);
  const before = stateStore.getResident('resident:metab');
  let activationEvent;
  const unit = await manager.promoteMetabShadow({
    binding: binding(),
    shadowContract: METAB_SHADOW_RESIDENT_CONTRACT,
    publishActivation: async ({ sourceCheckpoint }) => {
      const signal = activationSignal(sourceCheckpoint);
      activationEvent = await fabric.publishBiologicalSignal(signal, {
        eventClass: 'critical',
        sourceVersion: '0.8.11.3',
        evidenceHash: IDENTITY_HASH
      });
      return activationEvent;
    }
  });
  const promoted = stateStore.getResident('resident:metab');
  const checkpoint = await stateStore.readResidentCheckpoint('resident:metab');
  assert.equal(promoted.instanceId, before.instanceId);
  assert.equal(promoted.version, shadow.VERSION);
  assert.equal(promoted.stateSchema, 2);
  assert.equal(promoted.status, 'RUNNING');
  assert.equal(checkpoint.state.activation.eventId, activationEvent.id);
  assert.equal(checkpoint.state.founder.founderId, founderBinding().founderId);
  assert.equal(checkpoint.state.engineState.outputSequence, '0');
  assert.equal(unit.observedOutputs, 0);
  assert.equal(stateStore.getAuthority('METAB'), null);
  assert.deepEqual(
    stateStore.getBiologicalConsumer('resident:metab').topics,
    [...METAB_SHADOW_RESIDENT_CONTRACT.inputs].sort()
  );

  const pair = capacitySignals(1, 31_000);
  await fabric.publishBiologicalSignal(pair.eligible, {
    eventClass: 'durable',
    sourceVersion: '1.0.0'
  });
  const qualityEvent = await fabric.publishBiologicalSignal(pair.quality, {
    eventClass: 'durable',
    sourceVersion: '1.0.0'
  });
  await manager.drain('resident:metab', qualityEvent.sequence);
  const advanced = await stateStore.readResidentCheckpoint('resident:metab');
  assert.equal(advanced.state.lastAcceptedFrame, 1);
  assert.equal(advanced.state.engineState.outputSequence, '0');
  assert.equal(stateStore.getAuthority('METAB'), null);
});

test('R128-METAB-ROLLBACK-05 candidate failure restores the exact neutral generation', async t => {
  const { stateStore, fabric, manager } = await makeManager(t);
  const before = stateStore.getResident('resident:metab');
  const beforeState = (await stateStore.readResidentCheckpoint('resident:metab')).state;

  await assert.rejects(
    () => manager.promoteMetabShadow({
      binding: binding(),
      shadowContract: METAB_SHADOW_RESIDENT_CONTRACT,
      publishActivation: async ({ sourceCheckpoint }) => {
        const signal = activationSignal(sourceCheckpoint, {
          outputPolicy: 'UNAUTHORIZED_OUTPUTS'
        });
        return fabric.publishBiologicalSignal(signal, {
          eventClass: 'critical',
          sourceVersion: '0.8.11.3',
          evidenceHash: IDENTITY_HASH
        });
      }
    }),
    { code: 'P1_METAB_SHADOW_ACTIVATION' }
  );

  const after = stateStore.getResident('resident:metab');
  const afterCheckpoint = await stateStore.readResidentCheckpoint('resident:metab');
  const status = await manager.status('resident:metab');
  assert.equal(after.instanceId, before.instanceId);
  assert.equal(after.version, before.version);
  assert.equal(after.stateSchema, before.stateSchema);
  assert.equal(after.status, 'RUNNING');
  assert.deepEqual(afterCheckpoint.state, beforeState);
  assert.equal(status.health.mode, 'NEUTRAL');
  assert.equal(status.observedOutputs, 0);
  assert.equal(stateStore.getAuthority('METAB'), null);
});

test('R128-METAB-SOURCE-06 Kernel source commits pairs and replays a post-checkpoint power-loss window exactly once', async t => {
  const { stateStore, fabric, manager } = await makeManager(t);
  await manager.promoteMetabShadow({
    binding: binding(),
    shadowContract: METAB_SHADOW_RESIDENT_CONTRACT,
    publishActivation: async ({ sourceCheckpoint }) =>
      fabric.publishBiologicalSignal(
        activationSignal(sourceCheckpoint),
        {
          eventClass: 'critical',
          sourceVersion: '0.8.11.3',
          evidenceHash: IDENTITY_HASH
        }
      )
  });

  const trustedTimes = [1_000_000, 1_250_000];
  const harness = {
    stateStore,
    residentManager: manager,
    fabric,
    trustedOrganismTime: {
      async sample() {
        return {
          status: 'TRUSTED',
          trustedTimeUs: trustedTimes.shift(),
          continuityEpoch: 1
        };
      }
    },
    metabCapacitySampler: () => ({
      cpuCount: 4,
      loadAverageMilli: 1000,
      freeMemoryBytes: 6_000,
      totalMemoryBytes: 8_000
    }),
    lastMetabCapacitySource: null,
    statusCache: null,
    sampleTrustedTimeEvidence:
      LivingKernel.prototype.sampleTrustedTimeEvidence
  };

  assert.equal(
    await LivingKernel.prototype.runMetabCapacitySample.call(harness),
    true
  );
  assert.equal(
    (await stateStore.readLife(SOURCE_STATE_KEY)).lastCommittedFrame,
    1
  );
  assert.equal(
    (await stateStore.readResidentCheckpoint('resident:metab'))
      .state.lastAcceptedFrame,
    1
  );

  const eventsBeforePowerLoss = stateStore.db.prepare(
    'SELECT COUNT(*) AS count FROM biological_events'
  ).get().count;
  const originalWriteLife = stateStore.writeLife.bind(stateStore);
  stateStore.writeLife = async (name, value) => {
    if (
      name === SOURCE_STATE_KEY &&
      value?.lastCommittedFrame === 2 &&
      value?.pending === null
    ) {
      throw Object.assign(
        new Error('simulated power loss after resident checkpoint'),
        { code: 'TEST_POST_CHECKPOINT_POWER_LOSS' }
      );
    }
    return originalWriteLife(name, value);
  };
  await assert.rejects(
    () => LivingKernel.prototype.runMetabCapacitySample.call(harness),
    { code: 'TEST_POST_CHECKPOINT_POWER_LOSS' }
  );
  stateStore.writeLife = originalWriteLife;

  const pending = await stateStore.readLife(SOURCE_STATE_KEY);
  assert.equal(pending.lastCommittedFrame, 1);
  assert.equal(pending.pending.sampleFrame, 2);
  assert.equal(
    (await stateStore.readResidentCheckpoint('resident:metab'))
      .state.lastAcceptedFrame,
    2
  );
  assert.equal(
    stateStore.db.prepare(
      'SELECT COUNT(*) AS count FROM biological_events'
    ).get().count,
    eventsBeforePowerLoss + 2
  );

  assert.equal(
    await LivingKernel.prototype.runMetabCapacitySample.call(harness),
    true
  );
  const committed = await stateStore.readLife(SOURCE_STATE_KEY);
  assert.equal(committed.lastCommittedFrame, 2);
  assert.equal(committed.pending, null);
  assert.equal(
    stateStore.db.prepare(
      'SELECT COUNT(*) AS count FROM biological_events'
    ).get().count,
    eventsBeforePowerLoss + 2
  );
  assert.equal(stateStore.getAuthority('METAB'), null);
  assert.equal(
    stateStore.db.prepare(`
      SELECT COUNT(*) AS count FROM biological_outbox_intents
      WHERE producer_core_id='METAB'
    `).get().count,
    0
  );
  const status = await manager.status('resident:metab');
  assert.equal(status.health.mode, 'SHADOW');
  assert.equal(status.observedOutputs, 0);
});

test('R128-METAB-WEB-07 validated resident health projects the same born METAB chip as SHADOW', () => {
  const metadata = publicMetadata({
    kernel: { runtimeRevision: 128 },
    cores: [],
    residencies: [{
      residencyId: 'resident:metab',
      coreId: 'METAB',
      version: shadow.VERSION,
      status: 'RUNNING',
      running: true,
      authorityOwned: false,
      checkpointGeneration: 9,
      handledEvents: 8,
      observedOutputs: 0,
      health: {
        ok: true,
        mode: 'SHADOW'
      }
    }],
    biologicalLedger: {
      protocol: 'stay-biological-ledger-v1',
      events: 10,
      pendingDeliveries: 0,
      activeConsumers: 1
    },
    health: {
      ok: true,
      persistence: { ok: true, writeFailureCount: 0 }
    }
  });
  const resident = metadata.residents.find(item => item.coreId === 'METAB');
  const chip = metadata.chipProjection.lifecycle.find(item => item.coreId === 'metab');
  assert.equal(resident.mode, 'SHADOW');
  assert.equal(chip.state, 'SHADOW');
  assert.equal(chip.symbol, '◐');
  assert.equal(chip.observationOnly, true);
  assert.equal(
    metadata.chipProjection.roadmap.some(item => item.coreId === 'metab'),
    false
  );
  assert.deepEqual(metadata.chipProjection.mutationEndpoints, []);
});

test('R128-METAB-FORWARD-08 post-promotion acceptance failure never rewinds and recovers the same shadow generation', async t => {
  const { stateStore, fabric, manager } = await makeManager(t);
  const before = stateStore.getResident('resident:metab');
  await assert.rejects(
    () => manager.promoteMetabShadow({
      binding: binding(),
      shadowContract: METAB_SHADOW_RESIDENT_CONTRACT,
      publishActivation: async ({ sourceCheckpoint }) =>
        fabric.publishBiologicalSignal(
          activationSignal(sourceCheckpoint),
          {
            eventClass: 'critical',
            sourceVersion: '0.8.11.3',
            evidenceHash: IDENTITY_HASH
          }
        ),
      acceptanceCommit: () => {
        throw Object.assign(
          new Error('simulated acceptance persistence failure'),
          { code: 'TEST_SHADOW_ACCEPTANCE_FAILURE' }
        );
      }
    }),
    { code: 'TEST_SHADOW_ACCEPTANCE_FAILURE' }
  );

  const advanced = stateStore.getResident('resident:metab');
  const advancedCheckpoint =
    await stateStore.readResidentCheckpoint('resident:metab');
  assert.equal(advanced.instanceId, before.instanceId);
  assert.equal(advanced.version, shadow.VERSION);
  assert.equal(advanced.stateSchema, 2);
  assert.equal(advanced.status, 'ATTACHED');
  assert.equal(advancedCheckpoint.state.activation.instanceId, before.instanceId);
  assert.equal(advancedCheckpoint.state.engineState.outputSequence, '0');
  assert.equal(
    stateStore.getBiologicalConsumer('resident:metab').active,
    false
  );
  assert.equal(stateStore.getAuthority('METAB'), null);

  const recovered = await manager.recover(
    'resident:metab',
    binding()
  );
  const after = stateStore.getResident('resident:metab');
  const afterCheckpoint =
    await stateStore.readResidentCheckpoint('resident:metab');
  const status = await manager.status('resident:metab');
  assert.equal(recovered.residencyId, 'resident:metab');
  assert.equal(after.instanceId, before.instanceId);
  assert.equal(after.version, shadow.VERSION);
  assert.equal(after.status, 'RUNNING');
  assert.equal(
    afterCheckpoint.state.activation.signalId,
    advancedCheckpoint.state.activation.signalId
  );
  assert.equal(afterCheckpoint.state.engineState.outputSequence, '0');
  assert.equal(status.health.mode, 'SHADOW');
  assert.equal(status.observedOutputs, 0);
  assert.equal(status.authorityOwned, false);
});
