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
  LivingKernel
} = require(
  '../runtime'
);

const {
  stableStringify
} = require(
  '../runtime/kernel/canonical-json'
);

const {
  FORMAT,
  AUTHORIZATION_CLASS,
  identityHash,
  certificateFileName
} = require(
  '../runtime/kernel/resident-promotion-authority'
);


const MODULE =
  'cores/sntss/i3d/index.js';


async function harness(
  t,
  {
    signed =
      false
  } = {}
) {
  const root =
    await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        'stay-l0-b3b-'
      )
    );

  const dataDir =
    path.join(
      root,
      'state'
    );

  const certDir =
    path.join(
      root,
      'resident-promotions'
    );

  const publicKeyPath =
    path.join(
      root,
      'authority.pub'
    );

  await fs.mkdir(
    certDir,
    {
      recursive:
        true
    }
  );


  let privateKey =
    null;


  if (signed) {
    const pair =
      crypto.generateKeyPairSync(
        'ed25519'
      );

    privateKey =
      pair.privateKey;

    await fs.writeFile(
      publicKeyPath,

      pair.publicKey.export({
        type:
          'spki',

        format:
          'pem'
      })
    );
  }


  const now = {
    value:
      1000
  };


  const kernel =
    new LivingKernel({
      dataDir,

      allowIdentityBootstrap:
        true,

      heartbeatIntervalMs:
        0,

      snapshotIntervalMs:
        0,

      trustedTimePulseIntervalMs:
        0,

      allowLaboratoryResidentAttachment:
        !signed,

      residentPromotionPublicKeyPath:
        publicKeyPath,

      residentPromotionCertificateDir:
        certDir,

      clock:
        () =>
          now.value
    });


  await kernel.start();


  async function writeCertificate(
    action
  ) {
    const manager =
      kernel.ensureResidentManager();

    const inspected =
      await manager.inspect(
        MODULE
      );

    const wall =
      Date.now();

    const body = {
      allowedActions:
        [
          action
        ],

      allowedInputs:
        [
          ...inspected
            .definition
            .manifest
            .inputs
        ],

      allowedOutputs:
        [],

      authorizationClass:
        AUTHORIZATION_CLASS,

      certificateId:
        'resident-life-' +
        crypto.randomUUID(),

      coreId:
        inspected.definition
          .manifest.coreId,

      expiresAtMs:
        wall + 600000,

      issuedAtMs:
        wall - 1000,

      manifestHash:
        inspected.manifestHash,

      moduleHash:
        inspected.definition
          .moduleDigest,

      organismId:
        kernel.identity
          .organismId,

      organismIdentityHash:
        identityHash(
          kernel.identity
        ),

      packagePolicyHash:
        inspected.definition
          .packagePolicyHash,

      residencyId:
        manager.contract
          .residencyId,

      role:
        manager.contract
          .role,

      version:
        inspected.definition
          .manifest.version
    };


    const signature =
      crypto.sign(
        null,

        Buffer.from(
          stableStringify(
            body
          )
        ),

        privateKey
      ).toString(
        'base64'
      );


    await fs.writeFile(
      path.join(
        certDir,

        certificateFileName(
          manager.contract
            .residencyId
        )
      ),

      JSON.stringify(
        {
          format:
            FORMAT,

          body,

          signature
        },
        null,
        2
      ) + '\n'
    );
  }


  async function publishPulse(
    wallClockMs,
    {
      drain =
        true
    } = {}
  ) {
    now.value =
      wallClockMs;

    const event =
      await kernel
        .publishTimePulse(
          'trusted'
        );

    if (
      drain &&
      kernel.residentManager
        ?.units
        .has(
          'resident:sntss'
        )
    ) {
      const resident =
        kernel.stateStore
          .getResident(
            'resident:sntss'
          );

      if (
        resident?.status ===
          'RUNNING'
      ) {
        await kernel
          .residentManager
          .drain(
            'resident:sntss',
            event.sequence
          );
      }
    }

    return event;
  }


  async function waitFor(
    predicate,
    timeoutMs =
      5000
  ) {
    const started =
      Date.now();

    while (
      Date.now() -
        started <
      timeoutMs
    ) {
      if (
        await predicate()
      ) {
        return;
      }

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            20
          )
      );
    }

    throw new Error(
      'waitFor timeout'
    );
  }


  t.after(
    async () => {
      await kernel
        .stop()
        .catch(
          () => {}
        );

      await fs.rm(
        root,
        {
          recursive:
            true,

          force:
            true
        }
      );
    }
  );


  return {
    kernel,
    now,
    writeCertificate,
    publishPulse,
    waitFor
  };
}


test(
  'L0-B3B-01: detach stops resident input and preserves exact physiology without authority mutation',
  async t => {
    const h =
      await harness(t);


    await h.kernel
      .attachResident(
        MODULE
      );


    await h.publishPulse(
      1000
    );

    await h.publishPulse(
      1250
    );


    const before =
      await h.kernel
        .stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.equal(
      before.state
        .chemistry
        .modelClock,
      250
    );


    const instanceId =
      h.kernel
        .stateStore
        .getResident(
          'resident:sntss'
        )
        .instanceId;


    await h.kernel
      .detachResident();


    const detached =
      h.kernel
        .stateStore
        .getResident(
          'resident:sntss'
        );


    assert.equal(
      detached.status,
      'DETACHED'
    );


    assert.equal(
      detached.instanceId,
      instanceId
    );


    const consumer =
      h.kernel
        .stateStore
        .getBiologicalConsumer(
          'resident:sntss'
        );


    assert.equal(
      consumer.active,
      false
    );


    assert.equal(
      consumer.required,
      false
    );


    const generation =
      detached.checkpointGeneration;


    await h.publishPulse(
      5000
    );


    await h.publishPulse(
      5250
    );


    const after =
      await h.kernel
        .stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.equal(
      h.kernel
        .stateStore
        .getResident(
          'resident:sntss'
        )
        .checkpointGeneration,
      generation
    );


    assert.deepEqual(
      after.state,
      before.state
    );


    assert.deepEqual(
      h.kernel
        .stateStore
        .listAuthority(),
      []
    );


    const status =
      await h.kernel
        .status({
          force:
            true
        });


    assert.equal(
      status.health.ok,
      true
    );


    assert.equal(
      status.residencies[0]
        .host,
      null
    );
  }
);


test(
  'L0-B3B-02: signed reattach requires reattach authorization and restores same resident history',
  async t => {
    const h =
      await harness(
        t,
        {
          signed:
            true
        }
      );


    await h.writeCertificate(
      'attach-resident'
    );


    await h.kernel
      .attachResident(
        MODULE
      );


    await h.publishPulse(
      1000
    );

    await h.publishPulse(
      1250
    );


    const before =
      await h.kernel
        .stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    const instanceId =
      h.kernel
        .stateStore
        .getResident(
          'resident:sntss'
        )
        .instanceId;


    await h.kernel
      .detachResident();


    /*
     * Old attach certificate cannot be reused as
     * reattach authority.
     */
    await assert.rejects(
      () =>
        h.kernel
          .reattachResident(),

      error =>
        error.code ===
        'RESIDENT_PROMOTION_ACTION'
    );


    assert.equal(
      h.kernel
        .stateStore
        .getResident(
          'resident:sntss'
        )
        .status,
      'DETACHED'
    );


    await h.writeCertificate(
      'reattach-resident'
    );


    h.now.value =
      50001250;


    await h.kernel
      .reattachResident();


    const resident =
      h.kernel
        .stateStore
        .getResident(
          'resident:sntss'
        );


    assert.equal(
      resident.status,
      'RUNNING'
    );


    assert.equal(
      resident.instanceId,
      instanceId
    );


    let recovered =
      await h.kernel
        .stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.deepEqual(
      recovered.state,
      before.state
    );


    /*
     * First pulse after reattach is a new-runtime
     * anchor despite the long detached interval.
     */
    await h.publishPulse(
      50001250
    );


    recovered =
      await h.kernel
        .stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.equal(
      recovered.state
        .chemistry
        .modelClock,
      250
    );


    await h.publishPulse(
      50001500
    );


    recovered =
      await h.kernel
        .stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.equal(
      recovered.state
        .chemistry
        .modelClock,
      500
    );


    assert.equal(
      recovered.state
        .receptorAdaptation
        .modelClock,
      500
    );


    assert.equal(
      recovered.state
        .receptorAvailability
        .modelClock,
      500
    );


    assert.deepEqual(
      h.kernel
        .stateStore
        .listAuthority(),
      []
    );
  }
);


test(
  'L0-B3B-03: sequence-gap resynchronization preserves physiology, abandons debt explicitly and creates a new no-catch-up anchor',
  async t => {
    const h =
      await harness(t);


    await h.kernel
      .attachResident(
        MODULE
      );


    await h.publishPulse(
      1000
    );


    const before =
      await h.kernel
        .stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.equal(
      before.state
        .chemistry
        .modelClock,
      0
    );


    /*
     * Manufacture a trusted-time sequence gap.
     */
    h.kernel
      .trustedTimePulseSequence =
        2;


    /*
     * This pulse is intentionally invalid.
     *
     * Do NOT call drainThrough() on its sequence:
     * BoundedActorQueue correctly remembers the
     * failed handler and rejects such a drain with
     * ACTOR_DRAIN_FAILED.
     *
     * We instead wait for the contained resident
     * fault to transition into RESYNC_REQUIRED.
     */
    const bad =
      await h.publishPulse(
        1250,
        {
          drain:
            false
        }
      );


    assert.ok(
      bad.sequence > 0
    );


    await h.waitFor(
      () =>
        h.kernel
          .stateStore
          .getResident(
            'resident:sntss'
          )
          ?.status ===
            'RESYNC_REQUIRED'
    );


    assert.equal(
      h.kernel
        .stateStore
        .getResident(
          'resident:sntss'
        )
        .status,
      'RESYNC_REQUIRED'
    );


    const consumerAfterFault =
      h.kernel
        .stateStore
        .getBiologicalConsumer(
          'resident:sntss'
        );


    assert.equal(
      consumerAfterFault.active,
      false
    );


    const pending =
      h.kernel
        .stateStore
        .getBiologicalDelivery(
          'resident:sntss',
          bad.sequence
        );


    assert.equal(
      pending.status,
      'PENDING'
    );


    const result =
      await h.kernel
        .resynchronizeResident();


    assert.equal(
      result.record
        .abandonedCount,
      1
    );


    const resyncHistory =
      h.kernel
        .stateStore
        .listResidentResynchronizations(
          'resident:sntss'
        );


    assert.equal(
      resyncHistory.length,
      1
    );


    assert.equal(
      resyncHistory[0]
        .abandonedCount,
      1
    );


    const abandoned =
      h.kernel
        .stateStore
        .getBiologicalDelivery(
          'resident:sntss',
          bad.sequence
        );


    assert.equal(
      abandoned.status,
      'ACKED'
    );


    assert.match(
      abandoned.transitionId,
      /^resident-resync-abandon:/
    );


    let after =
      await h.kernel
        .stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    /*
     * Resync itself does not invent physiology.
     */
    assert.deepEqual(
      after.state,
      before.state
    );


    assert.equal(
      h.kernel
        .stateStore
        .getResident(
          'resident:sntss'
        )
        .status,
      'RUNNING'
    );


    assert.equal(
      h.kernel
        .stateStore
        .getBiologicalConsumer(
          'resident:sntss'
        )
        .active,
      true
    );


    /*
     * New runtime revision: anchor only.
     */
    await h.publishPulse(
      50001250
    );


    after =
      await h.kernel
        .stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.equal(
      after.state
        .chemistry
        .modelClock,
      0
    );


    await h.publishPulse(
      50001500
    );


    after =
      await h.kernel
        .stateStore
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


    assert.deepEqual(
      h.kernel
        .stateStore
        .listAuthority(),
      []
    );
  }
);


test(
  'L0-B3B-04: quarantined resident may not use chronology resynchronization as an authority bypass',
  async t => {
    const h =
      await harness(t);


    await h.kernel
      .attachResident(
        MODULE
      );


    const unit =
      h.kernel
        .residentManager
        .units
        .get(
          'resident:sntss'
        );


    await unit.client
      .emitAsync(
        'output',
        {
          topic:
            'forbidden.output',

          payload:
            {},

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


    assert.equal(
      h.kernel
        .stateStore
        .getResident(
          'resident:sntss'
        )
        .status,
      'QUARANTINED'
    );


    assert.equal(
      h.kernel
        .stateStore
        .getBiologicalConsumer(
          'resident:sntss'
        )
        .active,
      false
    );


    await assert.rejects(
      () =>
        h.kernel
          .resynchronizeResident(),

      error =>
        error.code ===
        'RESIDENT_RESYNC_STATE'
    );


    assert.deepEqual(
      h.kernel
        .stateStore
        .listAuthority(),
      []
    );
  }
);


test(
  'L0-B3B-05: detached resident remains durable across whole Kernel reconstruction and requires explicit reattach',
  async t => {
    const root =
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'stay-l0-b3b-restart-'
        )
      );

    const now = {
      value:
        1000
    };

    let kernel =
      new LivingKernel({
        dataDir:
          root,

        allowIdentityBootstrap:
          true,

        heartbeatIntervalMs:
          0,

        snapshotIntervalMs:
          0,

        trustedTimePulseIntervalMs:
          0,

        allowLaboratoryResidentAttachment:
          true,

        clock:
          () =>
            now.value
      });


    await kernel.start();


    await kernel
      .attachResident(
        MODULE
      );


    const pulse1 =
      await kernel
        .publishTimePulse();

    await kernel
      .residentManager
      .drain(
        'resident:sntss',
        pulse1.sequence
      );


    now.value =
      1250;


    const pulse2 =
      await kernel
        .publishTimePulse();

    await kernel
      .residentManager
      .drain(
        'resident:sntss',
        pulse2.sequence
      );


    await kernel
      .detachResident();


    const before =
      await kernel
        .stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    await kernel.stop();


    kernel =
      new LivingKernel({
        dataDir:
          root,

        allowIdentityBootstrap:
          false,

        heartbeatIntervalMs:
          0,

        snapshotIntervalMs:
          0,

        trustedTimePulseIntervalMs:
          0,

        allowLaboratoryResidentAttachment:
          true,

        clock:
          () =>
            now.value
      });


    await kernel.start();


    t.after(
      async () => {
        await kernel
          .stop()
          .catch(
            () => {}
          );

        await fs.rm(
          root,
          {
            recursive:
              true,

            force:
              true
          }
        );
      }
    );


    const status =
      await kernel
        .status({
          force:
            true
        });


    assert.equal(
      status.residencies[0]
        .status,
      'DETACHED'
    );


    assert.equal(
      status.residencies[0]
        .host,
      null
    );


    const after =
      await kernel
        .stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.deepEqual(
      after.state,
      before.state
    );


    assert.deepEqual(
      kernel.stateStore
        .listAuthority(),
      []
    );
  }
);
