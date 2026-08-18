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

const {
  DatabaseSync
} = require(
  'node:sqlite'
);

const {
  LivingKernel
} = require(
  '../runtime'
);


const MODULE =
  'cores/sntss/i3d/index.js';


async function makeDataDir() {
  return fs.mkdtemp(
    path.join(
      os.tmpdir(),
      'stay-l0-b2-'
    )
  );
}


async function startKernel({
  dataDir,
  now,
  allowIdentityBootstrap,
  allowLaboratoryResidentAttachment =
    true
}) {
  const kernel =
    new LivingKernel({
      dataDir,

      allowIdentityBootstrap,

      heartbeatIntervalMs:
        0,

      snapshotIntervalMs:
        0,

      snapshotRetention:
        4,

      trustedTimePulseIntervalMs:
        0,

      allowLaboratoryResidentAttachment,

      clock:
        () => now.value
    });

  await kernel.start();

  return kernel;
}


async function pulse(
  kernel,
  now,
  wallClockMs
) {
  now.value =
    wallClockMs;

  const event =
    await kernel
      .publishTimePulse(
        'trusted'
      );

  if (
    kernel.residentManager
      ?.units
      .has(
        'resident:sntss'
      )
  ) {
    await kernel.residentManager
      .drain(
        'resident:sntss',
        event.sequence
      );
  }

  return event;
}


test(
  'L0-B2-01: LivingKernel attaches resident SNTSS outside RuntimeRegistry authority topology',
  async t => {
    const dataDir =
      await makeDataDir();

    const now = {
      value:
        1000
    };

    const kernel =
      await startKernel({
        dataDir,
        now,
        allowIdentityBootstrap:
          true
      });

    t.after(
      async () => {
        await kernel
          .stop()
          .catch(
            () => {}
          );

        await fs.rm(
          dataDir,
          {
            recursive:
              true,

            force:
              true
          }
        );
      }
    );


    await kernel.attachResident(
      MODULE
    );


    const status =
      await kernel.status({
        force:
          true
      });


    assert.equal(
      status.residencies.length,
      1
    );


    const resident =
      status.residencies[0];


    assert.equal(
      resident.residencyId,
      'resident:sntss'
    );

    assert.equal(
      resident.status,
      'RUNNING'
    );

    assert.equal(
      resident.authorityOwned,
      false
    );

    assert.equal(
      resident.declaredOutputs,
      0
    );

    assert.equal(
      resident.observedOutputs,
      0
    );


    assert.equal(
      status.cores.some(
        slot =>
          slot.coreId ===
            'sntss'
      ),
      false
    );


    assert.deepEqual(
      status.authority,
      []
    );


    assert.deepEqual(
      kernel.stateStore
        .listAuthority(),
      []
    );


    assert.equal(
      status.health.ok,
      true
    );


    assert.deepEqual(
      status.health
        .unhealthyResidents,
      []
    );
  }
);


test(
  'L0-B2-02: Kernel trusted time advances resident physiology while all three clocks remain aligned',
  async t => {
    const dataDir =
      await makeDataDir();

    const now = {
      value:
        1000
    };

    const kernel =
      await startKernel({
        dataDir,
        now,
        allowIdentityBootstrap:
          true
      });

    t.after(
      async () => {
        await kernel
          .stop()
          .catch(
            () => {}
          );

        await fs.rm(
          dataDir,
          {
            recursive:
              true,

            force:
              true
          }
        );
      }
    );


    await kernel.attachResident(
      MODULE
    );


    /*
     * attachResident bumps the runtime revision.
     * First pulse at that revision anchors.
     */
    await pulse(
      kernel,
      now,
      1000
    );


    let checkpoint =
      await kernel.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.equal(
      checkpoint.state
        .chemistry
        .modelClock,
      0
    );


    await pulse(
      kernel,
      now,
      1250
    );


    checkpoint =
      await kernel.stateStore
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


    assert.deepEqual(
      kernel.stateStore
        .listAuthority(),
      []
    );
  }
);


test(
  'L0-B2-03: whole LivingKernel stop/start reconstructs exact resident history and new revision performs zero downtime catch-up',
  async t => {
    const dataDir =
      await makeDataDir();

    const now = {
      value:
        1000
    };

    let kernel =
      await startKernel({
        dataDir,
        now,
        allowIdentityBootstrap:
          true
      });


    await kernel.attachResident(
      MODULE
    );


    await pulse(
      kernel,
      now,
      1000
    );


    await pulse(
      kernel,
      now,
      1250
    );


    const before =
      await kernel.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    const beforeResident =
      kernel.stateStore
        .getResident(
          'resident:sntss'
        );


    assert.equal(
      before.state
        .chemistry
        .modelClock,
      250
    );


    const instanceId =
      beforeResident.instanceId;


    await kernel.stop();


    now.value =
      50001250;


    kernel =
      await startKernel({
        dataDir,
        now,
        allowIdentityBootstrap:
          false
      });


    t.after(
      async () => {
        await kernel
          .stop()
          .catch(
            () => {}
          );

        await fs.rm(
          dataDir,
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
      await kernel.status({
        force:
          true
      });


    assert.equal(
      status.residencies.length,
      1
    );


    assert.equal(
      status.residencies[0]
        .status,
      'RUNNING'
    );


    assert.equal(
      status.residencies[0]
        .instanceId,
      instanceId
    );


    assert.equal(
      kernel.lastResidentRecovery
        [0]
        .recovered,
      true
    );


    let recovered =
      await kernel.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
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
     * 50,000,000 ms later, first pulse in the new
     * Kernel revision MUST anchor only.
     */
    await pulse(
      kernel,
      now,
      50001250
    );


    recovered =
      await kernel.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
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


    await pulse(
      kernel,
      now,
      50001500
    );


    recovered =
      await kernel.stateStore
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
      kernel.stateStore
        .listAuthority(),
      []
    );
  }
);


test(
  'L0-B2-04: DETACHED resident remains durable but is not auto-recovered by Kernel start',
  async t => {
    const dataDir =
      await makeDataDir();

    const now = {
      value:
        1000
    };

    let kernel =
      await startKernel({
        dataDir,
        now,
        allowIdentityBootstrap:
          true
      });


    await kernel.attachResident(
      MODULE
    );


    const checkpoint =
      await kernel.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    kernel.stateStore
      .setResidentStatus(
        'resident:sntss',
        'DETACHED'
      );


    await kernel.stop();


    kernel =
      await startKernel({
        dataDir,
        now,
        allowIdentityBootstrap:
          false
      });


    t.after(
      async () => {
        await kernel
          .stop()
          .catch(
            () => {}
          );

        await fs.rm(
          dataDir,
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
      await kernel.status({
        force:
          true
      });


    assert.equal(
      status.residencies.length,
      1
    );


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
      await kernel.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.equal(
      after.blobHash,
      checkpoint.blobHash
    );


    assert.deepEqual(
      after.state,
      checkpoint.state
    );


    assert.equal(
      status.health.ok,
      true
    );


    assert.deepEqual(
      status.health
        .unhealthyResidents,
      []
    );
  }
);


test(
  'L0-B2-05: resident package identity failure is quarantined without failing organism Kernel start',
  async t => {
    const dataDir =
      await makeDataDir();

    const now = {
      value:
        1000
    };

    let kernel =
      await startKernel({
        dataDir,
        now,
        allowIdentityBootstrap:
          true
      });


    await kernel.attachResident(
      MODULE
    );


    const before =
      await kernel.stateStore
        .readResidentCheckpoint(
          'resident:sntss'
        );


    await kernel.stop();


    /*
     * Corrupt only the persisted resident executable
     * identity record. Do not alter the actual frozen
     * SNTSS package.
     */
    const db =
      new DatabaseSync(
        path.join(
          dataDir,
          'continuity.sqlite3'
        )
      );


    db.prepare(`
      UPDATE resident_instances
      SET module_hash=?
      WHERE residency_id=?
    `).run(
      'sha256:' +
        'f'.repeat(64),

      'resident:sntss'
    );


    db.close();


    kernel =
      await startKernel({
        dataDir,
        now,
        allowIdentityBootstrap:
          false
      });


    t.after(
      async () => {
        await kernel
          .stop()
          .catch(
            () => {}
          );

        await fs.rm(
          dataDir,
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
      await kernel.status({
        force:
          true
      });


    assert.equal(
      status.health.ok,
      true
    );


    assert.deepEqual(
      status.health
        .unhealthyResidents,
      [
        'resident:sntss'
      ]
    );


    assert.equal(
      status.residencies[0]
        .status,
      'QUARANTINED'
    );


    assert.equal(
      status.residencies[0]
        .host,
      null
    );


    assert.equal(
      kernel.lastResidentRecovery
        [0]
        .recovered,
      false
    );


    const after =
      await kernel.stateStore
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
      kernel.stateStore
        .listAuthority(),
      []
    );
  }
);


test(
  'L0-B2-06: production-style promotion requirement refuses uncertified initial residency attachment',
  async t => {
    const dataDir =
      await makeDataDir();

    const now = {
      value:
        1000
    };

    const kernel =
      await startKernel({
        dataDir,
        now,
        allowIdentityBootstrap:
          true,

        allowLaboratoryResidentAttachment:
          false
      });


    t.after(
      async () => {
        await kernel
          .stop()
          .catch(
            () => {}
          );

        await fs.rm(
          dataDir,
          {
            recursive:
              true,

            force:
              true
          }
        );
      }
    );


    await assert.rejects(
      () =>
        kernel.attachResident(
          MODULE
        ),

      error =>
        error.code ===
        'RESIDENT_PROMOTION_AUTHORITY_MISSING'
    );


    assert.deepEqual(
      kernel.stateStore
        .listResidents(),
      []
    );


    assert.deepEqual(
      kernel.stateStore
        .listAuthority(),
      []
    );


    const status =
      await kernel.status({
        force:
          true
      });


    assert.equal(
      status.residencies.length,
      0
    );


    assert.equal(
      status.health.ok,
      true
    );
  }
);
