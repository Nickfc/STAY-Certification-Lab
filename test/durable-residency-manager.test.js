'use strict';

const test =
  require('node:test');

const assert =
  require('node:assert/strict');

const fs =
  require('node:fs/promises');

const os =
  require('node:os');

const path =
  require('node:path');

const crypto =
  require('node:crypto');

const {
  StateStore
} = require(
  '../runtime/kernel/state-store'
);

const {
  EventFabric
} = require(
  '../runtime/kernel/event-fabric'
);

const {
  stableStringify
} = require(
  '../runtime/kernel/canonical-json'
);

const {
  ResidentManager,
  L0_SNTSS_CONTRACT
} = require(
  '../runtime/kernel/resident-manager'
);


const RELEASE_ROOT =
  path.resolve(
    __dirname,
    '..'
  );

const MODULE =
  'cores/sntss/i3d/index.js';


function hash(
  value
) {
  return (
    'sha256:' +
    crypto
      .createHash('sha256')
      .update(
        stableStringify(
          value
        )
      )
      .digest('hex')
  );
}


function delay(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}


async function waitFor(
  predicate,
  timeoutMs = 5000
) {
  const started =
    Date.now();

  while (
    Date.now() - started <
      timeoutMs
  ) {
    if (
      await predicate()
    ) {
      return;
    }

    await delay(20);
  }

  throw new Error(
    'waitFor timeout'
  );
}


function makeIdentity(
  suffix = 'a'
) {
  return {
    organismId:
      `stay-l0-${suffix}`,

    createdAt:
      '2026-08-18T00:00:00.000Z',

    lineage:
      'STAY/Genesis'
  };
}


function makeBinding(
  identity,
  {
    issuedAt = 1000,
    runtimeRevision = 1,
    authorityEpoch = 1
  } = {}
) {
  return {
    bindingVersion:
      1,

    identitySha256:
      hash(
        identity
      ),

    organismLineage:
      identity.lineage,

    issuedAt,

    runtimeRevision,

    authorityEpoch,

    kernelVersion:
      '0.8.11.3'
  };
}


async function makeRuntime(
  t,
  {
    identity =
      makeIdentity()
  } = {}
) {
  const dataDir =
    await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        'stay-l0-b1-'
      )
    );

  const stateStore =
    new StateStore(
      dataDir
    );

  await stateStore.init();

  let now =
    1000;

  const fabric =
    new EventFabric({
      clock:
        () => now,

      sequenceAllocator:
        ({ minimum }) =>
          stateStore
            .reserveEventSequence(
              minimum
            ),

      durableAppender:
        envelope =>
          stateStore
            .appendBiologicalEvent(
              envelope
            )
    });


  const managers =
    [];


  function createManager(
    managerIdentity =
      identity
  ) {
    const manager =
      new ResidentManager({
        releaseRoot:
          RELEASE_ROOT,

        stateStore,

        fabric,

        identity:
          managerIdentity,

        clock:
          () => now,

        logger: {
          log() {},
          info() {},
          warn() {},
          error() {}
        }
      });

    managers.push(
      manager
    );

    return manager;
  }


  t.after(
    async () => {
      for (
        const manager
        of managers.reverse()
      ) {
        await manager
          .shutdown()
          .catch(
            () => {}
          );
      }

      stateStore.close();

      await fs.rm(
        dataDir,
        {
          recursive: true,
          force: true
        }
      );
    }
  );


  return {
    dataDir,
    stateStore,
    fabric,
    identity,

    binding:
      makeBinding(
        identity
      ),

    createManager,

    setNow(value) {
      now =
        value;
    },

    getNow() {
      return now;
    }
  };
}


async function publishPulse(
  runtime,
  {
    wallClockMs,
    runtimeRevision,
    pulseSequence,
    clockStatus = 'trusted'
  }
) {
  runtime.setNow(
    wallClockMs
  );

  return runtime.fabric
    .publish(
      'runtime.time.pulse',

      {
        wallClockMs,
        runtimeRevision,
        pulseSequence,
        clockStatus
      },

      {
        eventClass:
          'durable',

        sourceCore:
          'living-kernel',

        sourceVersion:
          '0.8.11.3',

        authorityEpoch:
          runtimeRevision,

        deduplicationKey:
          `l0-b1-pulse:${runtimeRevision}:${pulseSequence}:${wallClockMs}`
      }
    );
}


test(
  'L0-B1-01: frozen I3-D attaches as a real zero-authority resident CoreHost',
  async t => {
    const runtime =
      await makeRuntime(t);

    const manager =
      runtime.createManager();

    await manager.attach({
      moduleRelativePath:
        MODULE,

      binding:
        runtime.binding
    });


    const status =
      await manager.status();


    assert.equal(
      status.status,
      'RUNNING'
    );

    assert.equal(
      status.coreId,
      'sntss'
    );

    assert.equal(
      status.version,
      '0.4.0-i3d3'
    );

    assert.equal(
      status.stateSchema,
      4
    );

    assert.equal(
      status.packagePolicyHash,
      L0_SNTSS_CONTRACT
        .packagePolicyHash
    );

    assert.equal(
      status.declaredOutputs,
      0
    );

    assert.equal(
      status.observedOutputs,
      0
    );

    assert.equal(
      status.authorityOwned,
      false
    );

    assert.deepEqual(
      runtime.stateStore
        .listAuthority(),
      []
    );

    const consumer =
      runtime.stateStore
        .getBiologicalConsumer(
          'resident:sntss'
        );

    assert.equal(
      consumer.required,
      false
    );

    assert.equal(
      status.health.bound,
      true
    );

    assert.equal(
      status.health
        .chemicalModelClock,
      0
    );

    assert.equal(
      status.health
        .receptorModelClock,
      0
    );

    assert.equal(
      status.health
        .receptorAvailabilityModelClock,
      0
    );

    assert.equal(
      status.health
        .declaredOutputs,
      0
    );

    assert.equal(
      status.health
        .biologicalOutputs,
      0
    );
  }
);


test(
  'L0-B1-02: resident durable delivery is non-blocking and checkpointed physiology advances atomically',
  async t => {
    const runtime =
      await makeRuntime(t);

    const manager =
      runtime.createManager();

    await manager.attach({
      moduleRelativePath:
        MODULE,

      binding:
        runtime.binding
    });


    const unit =
      manager.units.get(
        'resident:sntss'
      );


    const originalDispatch =
      unit.client.dispatch
        .bind(
          unit.client
        );


    let release;

    const gate =
      new Promise(
        resolve => {
          release =
            resolve;
        }
      );


    let entered =
      false;


    unit.client.dispatch =
      async (...args) => {
        entered =
          true;

        await gate;

        return originalDispatch(
          ...args
        );
      };


    const firstPublish =
      publishPulse(
        runtime,
        {
          wallClockMs:
            1000,

          runtimeRevision:
            1,

          pulseSequence:
            1
        }
      );


    await waitFor(
      () => entered
    );


    const boundary =
      await Promise.race([
        firstPublish.then(
          () => 'published'
        ),

        delay(100).then(
          () => 'blocked'
        )
      ]);


    assert.equal(
      boundary,
      'published'
    );


    release();


    await firstPublish;


    await manager.drain(
      'resident:sntss',
      runtime.fabric.sequence
    );


    unit.client.dispatch =
      originalDispatch;


    let checkpoint =
      await runtime.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.equal(
      checkpoint.state
        .trustedTime
        .lastPulseSequence,
      1
    );

    assert.equal(
      checkpoint.state
        .chemistry
        .modelClock,
      0
    );


    const second =
      await publishPulse(
        runtime,
        {
          wallClockMs:
            1250,

          runtimeRevision:
            1,

          pulseSequence:
            2
        }
      );


    await manager.drain(
      'resident:sntss',
      second.sequence
    );


    checkpoint =
      await runtime.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.equal(
      checkpoint.state
        .chemistry
        .modelClock,
      250
    );

    assert.equal(
      checkpoint.state
        .receptorAdaptation
        .modelClock,
      250
    );

    assert.equal(
      checkpoint.state
        .receptorAvailability
        .modelClock,
      250
    );


    const delivery =
      runtime.stateStore
        .getBiologicalDelivery(
          'resident:sntss',
          second.sequence
        );


    assert.equal(
      delivery.status,
      'ACKED'
    );

    assert.equal(
      delivery.checkpointHash,
      checkpoint.blobHash
    );

    assert.deepEqual(
      runtime.stateStore
        .listAuthority(),
      []
    );
  }
);


test(
  'L0-B1-03: unrelated durable biology is acknowledged administratively and never enters SNTSS',
  async t => {
    const runtime =
      await makeRuntime(t);

    const manager =
      runtime.createManager();

    await manager.attach({
      moduleRelativePath:
        MODULE,

      binding:
        runtime.binding
    });


    const before =
      runtime.stateStore
        .getResident(
          'resident:sntss'
        );


    const unit =
      manager.units.get(
        'resident:sntss'
      );


    const handledBefore =
      unit.handledEvents;


    const event =
      await runtime.fabric
        .publish(
          'bio.unrelated',

          {
            value:
              42
          },

          {
            eventClass:
              'durable',

            sourceCore:
              'test-producer',

            deduplicationKey:
              'l0-b1-unrelated'
          }
        );


    const delivery =
      runtime.stateStore
        .getBiologicalDelivery(
          'resident:sntss',
          event.sequence
        );


    assert.equal(
      delivery.status,
      'ACKED'
    );


    const after =
      runtime.stateStore
        .getResident(
          'resident:sntss'
        );


    assert.equal(
      after.checkpointGeneration,
      before.checkpointGeneration
    );

    assert.equal(
      unit.handledEvents,
      handledBefore
    );

    assert.ok(
      unit.ignoredEvents >=
        1
    );
  }
);


test(
  'L0-B1-04: trusted pulse failure is contained and never rejects the STAY publication boundary',
  async t => {
    const runtime =
      await makeRuntime(t);

    const manager =
      runtime.createManager();

    await manager.attach({
      moduleRelativePath:
        MODULE,

      binding:
        runtime.binding
    });


    const first =
      await publishPulse(
        runtime,
        {
          wallClockMs:
            1000,

          runtimeRevision:
            1,

          pulseSequence:
            1
        }
      );


    await manager.drain(
      'resident:sntss',
      first.sequence
    );


    /*
     * Deliberately skip pulse sequence 2.
     *
     * EventFabric publication itself MUST still
     * succeed because resident delivery is optional.
     */
    const bad =
      await publishPulse(
        runtime,
        {
          wallClockMs:
            1250,

          runtimeRevision:
            1,

          pulseSequence:
            3
        }
      );


    assert.ok(
      bad.sequence > 0
    );


    await waitFor(
      () =>
        runtime.stateStore
          .getResident(
            'resident:sntss'
          )
          .status ===
            'RESYNC_REQUIRED'
    );


    const delivery =
      runtime.stateStore
        .getBiologicalDelivery(
          'resident:sntss',
          bad.sequence
        );


    assert.equal(
      delivery.status,
      'PENDING'
    );


    assert.equal(
      runtime.fabric.metrics
        .deliveryFailures,
      0
    );


    assert.deepEqual(
      runtime.stateStore
        .listAuthority(),
      []
    );
  }
);


test(
  'L0-B1-05: manager reconstruction restores exact physiology and a new runtime revision anchors without downtime catch-up',
  async t => {
    const runtime =
      await makeRuntime(t);

    const firstManager =
      runtime.createManager();

    await firstManager.attach({
      moduleRelativePath:
        MODULE,

      binding:
        runtime.binding
    });


    const pulse1 =
      await publishPulse(
        runtime,
        {
          wallClockMs:
            1000,

          runtimeRevision:
            1,

          pulseSequence:
            1
        }
      );

    await firstManager.drain(
      'resident:sntss',
      pulse1.sequence
    );


    const pulse2 =
      await publishPulse(
        runtime,
        {
          wallClockMs:
            1250,

          runtimeRevision:
            1,

          pulseSequence:
            2
        }
      );

    await firstManager.drain(
      'resident:sntss',
      pulse2.sequence
    );


    const before =
      await runtime.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    const instanceId =
      runtime.stateStore
        .getResident(
          'resident:sntss'
        )
        .instanceId;


    assert.equal(
      before.state
        .chemistry
        .modelClock,
      250
    );


    await firstManager
      .shutdown();


    runtime.setNow(
      50001250
    );


    const secondManager =
      runtime.createManager();


    await secondManager.recover(
      'resident:sntss',
      runtime.binding
    );


    const recovered =
      await runtime.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.equal(
      runtime.stateStore
        .getResident(
          'resident:sntss'
        )
        .instanceId,
      instanceId
    );


    assert.equal(
      recovered.state
        .chemistry
        .modelClock,
      250
    );

    assert.equal(
      recovered.state
        .receptorAdaptation
        .modelClock,
      250
    );

    assert.equal(
      recovered.state
        .receptorAvailability
        .modelClock,
      250
    );


    /*
     * 50,000,000 ms later, new Kernel revision.
     * Must anchor, not synthesize downtime biology.
     */
    const anchor =
      await publishPulse(
        runtime,
        {
          wallClockMs:
            50001250,

          runtimeRevision:
            2,

          pulseSequence:
            1
        }
      );


    await secondManager.drain(
      'resident:sntss',
      anchor.sequence
    );


    let after =
      await runtime.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.equal(
      after.state
        .chemistry
        .modelClock,
      250
    );

    assert.equal(
      after.state
        .receptorAdaptation
        .modelClock,
      250
    );

    assert.equal(
      after.state
        .receptorAvailability
        .modelClock,
      250
    );


    const next =
      await publishPulse(
        runtime,
        {
          wallClockMs:
            50001500,

          runtimeRevision:
            2,

          pulseSequence:
            2
        }
      );


    await secondManager.drain(
      'resident:sntss',
      next.sequence
    );


    after =
      await runtime.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.equal(
      after.state
        .chemistry
        .modelClock,
      500
    );

    assert.equal(
      after.state
        .receptorAdaptation
        .modelClock,
      500
    );

    assert.equal(
      after.state
        .receptorAvailability
        .modelClock,
      500
    );
  }
);


test(
  'L0-B1-06: recovery under another organism identity is rejected without replacing resident history',
  async t => {
    const runtime =
      await makeRuntime(t);

    const firstManager =
      runtime.createManager();

    await firstManager.attach({
      moduleRelativePath:
        MODULE,

      binding:
        runtime.binding
    });


    const before =
      await runtime.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    await firstManager
      .shutdown();


    const wrongIdentity =
      makeIdentity(
        'wrong'
      );


    const wrongManager =
      runtime.createManager(
        wrongIdentity
      );


    await assert.rejects(
      () =>
        wrongManager.recover(
          'resident:sntss',

          makeBinding(
            wrongIdentity
          )
        ),

      error =>
        error.code ===
        'RESIDENT_IDENTITY_MISMATCH'
    );


    const after =
      await runtime.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.equal(
      after.blobHash,
      before.blobHash
    );

    assert.deepEqual(
      after.state,
      before.state
    );

    assert.deepEqual(
      runtime.stateStore
        .listAuthority(),
      []
    );
  }
);


test(
  'L0-B1-07: resident output firewall quarantines attempted output without publishing it to Event Fabric',
  async t => {
    const runtime =
      await makeRuntime(t);

    const manager =
      runtime.createManager();

    await manager.attach({
      moduleRelativePath:
        MODULE,

      binding:
        runtime.binding
    });


    const unit =
      manager.units.get(
        'resident:sntss'
      );


    const publishedBefore =
      runtime.fabric.metrics
        .published;


    /*
     * Inject directly at the trusted CoreHost-client
     * boundary to prove that even a hypothetical
     * output message has no EventFabric route.
     */
    await unit.client
      .emitAsync(
        'output',
        {
          topic:
            'forbidden.biological.output',

          payload: {
            value:
              1
          },

          context: {
            coreId:
              'sntss',

            implementationInstanceId:
              unit.resident
                .instanceId,

            authorityEpoch:
              0,

            eventSequence:
              1
          }
        }
      );


    await waitFor(
      () =>
        runtime.stateStore
          .getResident(
            'resident:sntss'
          )
          .status ===
            'QUARANTINED'
    );


    const status =
      await manager.status();


    assert.equal(
      status.observedOutputs,
      1
    );

    assert.equal(
      status.declaredOutputs,
      0
    );

    assert.equal(
      status.authorityOwned,
      false
    );

    assert.equal(
      runtime.fabric.metrics
        .published,
      publishedBefore
    );

    assert.deepEqual(
      runtime.stateStore
        .listAuthority(),
      []
    );
  }
);


test(
  'L0-B1-08: manager reconstruction replays a durable resident delivery that was pending across manager loss',
  async t => {
    const runtime =
      await makeRuntime(t);


    const firstManager =
      runtime.createManager();


    await firstManager.attach({
      moduleRelativePath:
        MODULE,

      binding:
        runtime.binding
    });


    /*
     * Establish trusted-time anchor.
     */
    const first =
      await publishPulse(
        runtime,
        {
          wallClockMs:
            1000,

          runtimeRevision:
            1,

          pulseSequence:
            1
        }
      );


    await firstManager.drain(
      'resident:sntss',
      first.sequence
    );


    const committedBefore =
      await runtime.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.equal(
      committedBefore.state
        .trustedTime
        .lastPulseSequence,
      1
    );


    assert.equal(
      committedBefore.state
        .chemistry
        .modelClock,
      0
    );


    /*
     * Simulate loss of only the resident manager.
     *
     * We intentionally DO NOT call manager.shutdown(),
     * because shutdown creates a final resident
     * checkpoint. The persistent resident row remains
     * RUNNING exactly as it would after abrupt process
     * disappearance.
     */
    const firstUnit =
      firstManager.units.get(
        'resident:sntss'
      );


    firstManager.unsubscribe();

    firstManager.closed =
      true;

    firstUnit.queue.close();

    await firstUnit.client.stop();

    firstManager.units.clear();


    /*
     * Kernel/EventFabric remains alive.
     *
     * This durable event is appended while no resident
     * manager exists, therefore its delivery remains
     * PENDING.
     */
    const second =
      await publishPulse(
        runtime,
        {
          wallClockMs:
            1250,

          runtimeRevision:
            1,

          pulseSequence:
            2
        }
      );


    const pending =
      runtime.stateStore
        .getBiologicalDelivery(
          'resident:sntss',
          second.sequence
        );


    assert.equal(
      pending.status,
      'PENDING'
    );


    const stillOld =
      await runtime.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.equal(
      stillOld.state
        .trustedTime
        .lastPulseSequence,
      1
    );


    assert.equal(
      stillOld.state
        .chemistry
        .modelClock,
      0
    );


    /*
     * A new manager did not observe the old publish.
     * recover() must discover the durable pending
     * ledger entry itself and replay it.
     */
    const secondManager =
      runtime.createManager();


    await secondManager.recover(
      'resident:sntss',
      runtime.binding
    );


    const recovered =
      await runtime.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.equal(
      recovered.state
        .trustedTime
        .lastPulseSequence,
      2
    );


    assert.equal(
      recovered.state
        .chemistry
        .modelClock,
      250
    );


    assert.equal(
      recovered.state
        .receptorAdaptation
        .modelClock,
      250
    );


    assert.equal(
      recovered.state
        .receptorAvailability
        .modelClock,
      250
    );


    const acknowledged =
      runtime.stateStore
        .getBiologicalDelivery(
          'resident:sntss',
          second.sequence
        );


    assert.equal(
      acknowledged.status,
      'ACKED'
    );


    assert.equal(
      acknowledged.checkpointHash,
      recovered.blobHash
    );


    assert.deepEqual(
      runtime.stateStore
        .listAuthority(),
      []
    );


    const status =
      await secondManager.status();


    assert.equal(
      status.status,
      'RUNNING'
    );


    assert.equal(
      status.authorityOwned,
      false
    );


    assert.equal(
      status.declaredOutputs,
      0
    );


    assert.equal(
      status.observedOutputs,
      0
    );
  }
);
