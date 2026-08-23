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
  StateStore
} = require(
  '../runtime/kernel/state-store'
);


const HASH_A =
  'sha256:' +
  'a'.repeat(64);

const HASH_B =
  'sha256:' +
  'b'.repeat(64);

const HASH_C =
  'sha256:' +
  'c'.repeat(64);

const HASH_D =
  'sha256:' +
  'd'.repeat(64);


async function makeStore(t) {
  const dataDir =
    await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        'stay-l0-residency-'
      )
    );

  const store =
    new StateStore(
      dataDir
    );

  await store.init();

  t.after(async () => {
    store.close();

    await fs.rm(
      dataDir,
      {
        recursive: true,
        force: true
      }
    );
  });

  return {
    store,
    dataDir
  };
}


function identity(
  overrides = {}
) {
  return {
    residencyId:
      'resident:sntss',

    coreId:
      'sntss',

    role:
      'resident-physiology',

    instanceId:
      'resident-instance-1',

    version:
      '0.4.0-i3d3',

    stateSchema:
      4,

    moduleRelativePath:
      'cores/sntss/i3d/index.js',

    moduleHash:
      HASH_A,

    manifestHash:
      HASH_B,

    packagePolicyHash:
      HASH_C,

    organismIdentityHash:
      HASH_D,

    ...overrides
  };
}


test(
  'L0-B0-01: resident identity is durable and does not create organism authority',
  async t => {
    const {
      store
    } = await makeStore(t);

    assert.deepEqual(
      store.listAuthority(),
      []
    );

    const resident =
      store.registerResident(
        identity()
      );

    assert.equal(
      resident.residencyId,
      'resident:sntss'
    );

    assert.equal(
      resident.status,
      'ATTACHED'
    );

    assert.equal(
      resident.checkpointHash,
      null
    );

    assert.equal(
      resident.checkpointGeneration,
      0
    );

    assert.deepEqual(
      store.listAuthority(),
      []
    );

    assert.deepEqual(
      store.listResidents(),
      [resident]
    );
  }
);


test(
  'L0-B0-02: exact resident registration is idempotent and immutable identity drift is rejected',
  async t => {
    const {
      store
    } = await makeStore(t);

    const first =
      store.registerResident(
        identity()
      );

    const repeated =
      store.registerResident(
        identity()
      );

    assert.deepEqual(
      repeated,
      first
    );

    assert.throws(
      () =>
        store.registerResident(
          identity({
            organismIdentityHash:
              HASH_A
          })
        ),

      error =>
        error.code ===
        'RESIDENT_IDENTITY_CONFLICT'
    );
  }
);


test(
  'L0-B0-03: resident checkpoints use a separate durable pointer and preserve authority isolation',
  async t => {
    const {
      store
    } = await makeStore(t);

    store.registerResident(
      identity()
    );

    store.setResidentStatus(
      'resident:sntss',
      'RUNNING'
    );

    const checkpoint =
      await store
        .commitResidentCheckpoint({
          residencyId:
            'resident:sntss',

          instanceId:
            'resident-instance-1',

          version:
            '0.4.0-i3d3',

          stateSchema:
            4,

          state: {
            modelClock:
              250,

            availability:
              956477
          }
        });

    const resident =
      store.getResident(
        'resident:sntss'
      );

    assert.equal(
      resident.checkpointHash,
      checkpoint.blobHash
    );

    assert.equal(
      resident.checkpointGeneration,
      1
    );

    const restored =
      await store
        .readResidentCheckpoint(
          'resident:sntss'
        );

    assert.deepEqual(
      restored.state,
      {
        modelClock:
          250,

        availability:
          956477
      }
    );

    assert.deepEqual(
      store.listAuthority(),
      []
    );

    assert.equal(
      store.db.prepare(
        'SELECT COUNT(*) AS count FROM checkpoints'
      ).get().count,
      0
    );
  }
);


test(
  'L0-B0-04: resident state transition and biological acknowledgement commit together',
  async t => {
    const {
      store
    } = await makeStore(t);

    store.registerResident(
      identity()
    );

    store.setResidentStatus(
      'resident:sntss',
      'RUNNING'
    );

    const consumer =
      store.registerBiologicalConsumer({
        consumerId:
          'resident:sntss',

        coreId:
          'sntss',

        topics: [
          'runtime.time.pulse'
        ],

        required:
          false,

        authorityEpoch:
          0
      });

    assert.equal(
      consumer.required,
      false
    );

    const event =
      store.appendBiologicalEvent({
        topic:
          'runtime.time.pulse',

        payload: {
          wallClockMs:
            1250
        },

        meta: {
          deduplicationKey:
            'l0-b0-time-1'
        },

        eventClass:
          'durable',

        at:
          1250
      }).event;

    const before =
      store.getBiologicalDelivery(
        'resident:sntss',
        event.sequence
      );

    assert.equal(
      before.status,
      'PENDING'
    );

    const checkpoint =
      await store
        .commitResidentCheckpoint({
          residencyId:
            'resident:sntss',

          instanceId:
            'resident-instance-1',

          version:
            '0.4.0-i3d3',

          stateSchema:
            4,

          state: {
            modelClock:
              250
          },

          consumerAck: {
            consumerId:
              'resident:sntss',

            sequence:
              event.sequence,

            transitionId:
              'sha256:' +
              'e'.repeat(64)
          }
        });

    const delivery =
      store.getBiologicalDelivery(
        'resident:sntss',
        event.sequence
      );

    assert.equal(
      delivery.status,
      'ACKED'
    );

    assert.equal(
      delivery.checkpointHash,
      checkpoint.blobHash
    );

    const afterConsumer =
      store.getBiologicalConsumer(
        'resident:sntss'
      );

    assert.equal(
      afterConsumer.checkpointHash,
      checkpoint.blobHash
    );

    assert.ok(
      afterConsumer.cursor >=
        event.sequence
    );

    assert.deepEqual(
      store.listAuthority(),
      []
    );
  }
);


test(
  'L0-B0-05: checkpoint identity cannot cross resident instance, version or schema',
  async t => {
    const {
      store
    } = await makeStore(t);

    store.registerResident(
      identity()
    );

    store.setResidentStatus(
      'resident:sntss',
      'RUNNING'
    );

    for (
      const options
      of [
        {
          instanceId:
            'wrong-instance',

          version:
            '0.4.0-i3d3',

          stateSchema:
            4
        },

        {
          instanceId:
            'resident-instance-1',

          version:
            'wrong-version',

          stateSchema:
            4
        },

        {
          instanceId:
            'resident-instance-1',

          version:
            '0.4.0-i3d3',

          stateSchema:
            3
        }
      ]
    ) {
      await assert.rejects(
        () =>
          store
            .commitResidentCheckpoint({
              residencyId:
                'resident:sntss',

              ...options,

              state: {}
            }),

        error =>
          error.code ===
          'RESIDENT_CHECKPOINT_IDENTITY'
      );
    }
  }
);


test(
  'L0-B0-06: corrupt resident checkpoint fails closed instead of manufacturing replacement state',
  async t => {
    const {
      store
    } = await makeStore(t);

    store.registerResident(
      identity()
    );

    store.setResidentStatus(
      'resident:sntss',
      'RUNNING'
    );

    const checkpoint =
      await store
        .commitResidentCheckpoint({
          residencyId:
            'resident:sntss',

          instanceId:
            'resident-instance-1',

          version:
            '0.4.0-i3d3',

          stateSchema:
            4,

          state: {
            modelClock:
              500
          }
        });

    await fs.writeFile(
      store.blobPath(
        checkpoint.blobHash
      ),
      'corrupt'
    );

    await assert.rejects(
      () =>
        store
          .readResidentCheckpoint(
            'resident:sntss'
          ),

      error =>
        error.code ===
        'CHECKPOINT_CORRUPT'
    );

    assert.equal(
      store.getResident(
        'resident:sntss'
      ).checkpointHash,
      checkpoint.blobHash
    );
  }
);


test(
  'L0-B0-07: detach preserves resident history and prevents detached state mutation',
  async t => {
    const {
      store
    } = await makeStore(t);

    store.registerResident(
      identity()
    );

    store.setResidentStatus(
      'resident:sntss',
      'RUNNING'
    );

    const checkpoint =
      await store
        .commitResidentCheckpoint({
          residencyId:
            'resident:sntss',

          instanceId:
            'resident-instance-1',

          version:
            '0.4.0-i3d3',

          stateSchema:
            4,

          state: {
            modelClock:
              750
          }
        });

    store.setResidentStatus(
      'resident:sntss',
      'DETACHED'
    );

    const resident =
      store.getResident(
        'resident:sntss'
      );

    assert.equal(
      resident.status,
      'DETACHED'
    );

    assert.equal(
      resident.checkpointHash,
      checkpoint.blobHash
    );

    const restored =
      await store
        .readResidentCheckpoint(
          'resident:sntss'
        );

    assert.equal(
      restored.state.modelClock,
      750
    );

    await assert.rejects(
      () =>
        store
          .commitResidentCheckpoint({
            residencyId:
              'resident:sntss',

            instanceId:
              'resident-instance-1',

            version:
              '0.4.0-i3d3',

            stateSchema:
              4,

            state: {
              modelClock:
                1000
            }
          }),

      error =>
        error.code ===
        'RESIDENT_CHECKPOINT_STATE'
    );
  }
);


test(
  'L0-B0-08: L0 deliberately exposes no resident purge operation',
  async t => {
    const {
      store
    } = await makeStore(t);

    assert.equal(
      typeof store.purgeResident,
      'undefined'
    );

    assert.equal(
      typeof store.deleteResident,
      'undefined'
    );

    assert.equal(
      typeof store.removeResident,
      'undefined'
    );
  }
);


test(
  'L0-B0-09: runtime snapshot contains resident checkpoint blob and resident identity',
  async t => {
    const {
      store
    } = await makeStore(t);

    const registered =
      store.registerResident(
        identity()
      );

    store.setResidentStatus(
      'resident:sntss',
      'RUNNING'
    );

    const checkpoint =
      await store
        .commitResidentCheckpoint({
          residencyId:
            'resident:sntss',

          instanceId:
            'resident-instance-1',

          version:
            '0.4.0-i3d3',

          stateSchema:
            4,

          state: {
            modelClock:
              1000,

            durableResidentHistory:
              true
          }
        });

    const snapshot =
      await store.createSnapshot({
        reason:
          'l0-b0-resident-closure',

        retention:
          2
      });

    const manifest =
      JSON.parse(
        await fs.readFile(
          path.join(
            snapshot.path,
            'SNAPSHOT_MANIFEST.json'
          ),
          'utf8'
        )
      );

    assert.deepEqual(
      manifest.authority,
      []
    );

    assert.equal(
      Array.isArray(
        manifest.residents
      ),
      true
    );

    assert.equal(
      manifest.residents.length,
      1
    );

    assert.equal(
      manifest.residents[0]
        .residencyId,
      registered.residencyId
    );

    assert.equal(
      manifest.residents[0]
        .checkpointHash,
      checkpoint.blobHash
    );

    const relativeBlob =
      path.relative(
        store.rootDir,
        store.blobPath(
          checkpoint.blobHash
        )
      );

    assert.equal(
      typeof manifest.files[
        relativeBlob
      ],
      'string'
    );

    const snapBlob =
      path.join(
        snapshot.path,
        relativeBlob
      );

    const bytes =
      await fs.readFile(
        snapBlob,
        'utf8'
      );

    assert.deepEqual(
      JSON.parse(bytes),
      {
        modelClock:
          1000,

        durableResidentHistory:
          true
      }
    );

    assert.equal(
      manifest.files[
        relativeBlob
      ],
      await require(
        '../runtime/kernel/state-store'
      ).sha256File(
        snapBlob
      )
    );
  }
);


test(
  'L0-B3A1-01: continuity schema 3 upgrades to schema 4 without losing resident physiology',
  async t => {
    const dataDir =
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'stay-l0-schema4-upgrade-'
        )
      );


    let store =
      new StateStore(
        dataDir
      );


    await store.init();


    store.registerResident(
      identity()
    );


    store.setResidentStatus(
      'resident:sntss',
      'RUNNING'
    );


    const committed =
      await store
        .commitResidentCheckpoint({
          residencyId:
            'resident:sntss',

          instanceId:
            'resident-instance-1',

          version:
            '0.4.0-i3d3',

          stateSchema:
            4,

          state: {
            modelClock:
              1250,

            durableHistory:
              true
          }
        });


    /*
     * Simulate the immediately preceding continuity
     * schema marker while preserving all actual
     * database contents.
     */
    store.db.prepare(`
      UPDATE schema_versions
      SET version=3
      WHERE name='continuity'
    `).run();


    store.close();


    store =
      new StateStore(
        dataDir
      );


    await store.init();


    t.after(
      async () => {
        store.close();

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


    const schema =
      store.db.prepare(`
        SELECT version
        FROM schema_versions
        WHERE name='continuity'
      `).get();


    assert.equal(
      Number(
        schema.version
      ),
      4
    );


    const resident =
      store.getResident(
        'resident:sntss'
      );


    assert.equal(
      resident.checkpointHash,
      committed.blobHash
    );


    assert.equal(
      resident.checkpointGeneration,
      1
    );


    const recovered =
      await store
        .readResidentCheckpoint(
          'resident:sntss'
        );


    assert.deepEqual(
      recovered.state,
      {
        modelClock:
          1250,

        durableHistory:
          true
      }
    );


    assert.deepEqual(
      store.listAuthority(),
      []
    );
  }
);


test(
  'L0-B3A1-02: continuity schema newer than 4 fails closed',
  async t => {
    const dataDir =
      await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          'stay-l0-schema4-forward-'
        )
      );


    const first =
      new StateStore(
        dataDir
      );


    await first.init();


    first.db.prepare(`
      UPDATE schema_versions
      SET version=5
      WHERE name='continuity'
    `).run();


    first.close();


    const future =
      new StateStore(
        dataDir
      );


    t.after(
      async () => {
        future.close();

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
        future.init(),

      error =>
        error.code ===
        'STATE_SCHEMA_UNSUPPORTED'
    );


    /*
     * Failed open must not downgrade or rewrite the
     * unknown future schema marker.
     */
    const row =
      future.db.prepare(`
        SELECT version
        FROM schema_versions
        WHERE name='continuity'
      `).get();


    assert.equal(
      Number(
        row.version
      ),
      5
    );
  }
);


test(
  'L0-C221-01: resident lifecycle checkpoints preserve biological input provenance without copying administrative consumer cursor',
  async t => {
    const {
      store
    } = await makeStore(t);

    const residencyId =
      'resident:sntss';

    const readCheckpoint =
      () =>
        store.readResidentCheckpoint(
          residencyId
        );

    store.registerResident(
      identity()
    );

    store.setResidentStatus(
      residencyId,
      'RUNNING'
    );

    store.registerBiologicalConsumer({
      consumerId:
        residencyId,

      coreId:
        'sntss',

      topics: [
        'runtime.time.pulse'
      ],

      required:
        false,

      authorityEpoch:
        0
    });

    /*
     * Genuine physiological transition #1.
     */
    const firstEvent =
      store.appendBiologicalEvent({
        topic:
          'runtime.time.pulse',

        payload: {
          wallClockMs:
            1250
        },

        meta: {
          deduplicationKey:
            'l0-c221-provenance-1'
        },

        eventClass:
          'durable',

        at:
          1250
      }).event;

    await store.commitResidentCheckpoint({
      residencyId,

      instanceId:
        'resident-instance-1',

      version:
        '0.4.0-i3d3',

      stateSchema:
        4,

      state: {
        modelClock:
          250,

        biologicalTransitions:
          1
      },

      consumerAck: {
        consumerId:
          residencyId,

        sequence:
          firstEvent.sequence,

        transitionId:
          'sha256:' +
          'e'.repeat(64)
      }
    });

    const biologicalOne =
      await readCheckpoint();

    assert.equal(
      biologicalOne.inputCursor,
      firstEvent.sequence
    );

    /*
     * No new biology. A lifecycle checkpoint must
     * retain the prior physiological provenance.
     */
    await store.commitResidentCheckpoint({
      residencyId,

      instanceId:
        'resident-instance-1',

      version:
        '0.4.0-i3d3',

      stateSchema:
        4,

      state: {
        modelClock:
          250,

        biologicalTransitions:
          1,

        lifecycle:
          'snapshot-one'
      }
    });

    const lifecycleOne =
      await readCheckpoint();

    assert.equal(
      lifecycleOne.inputCursor,
      firstEvent.sequence,
      'lifecycle checkpoint must inherit biological input provenance'
    );

    /*
     * Durable event #2 exists, but physiology will NOT
     * consume it. Instead we administratively resync.
     */
    const administrativeEvent =
      store.appendBiologicalEvent({
        topic:
          'runtime.time.pulse',

        payload: {
          wallClockMs:
            1500
        },

        meta: {
          deduplicationKey:
            'l0-c221-provenance-admin'
        },

        eventClass:
          'durable',

        at:
          1500
      }).event;

    const resync =
      store.resynchronizeResidentBiologicalConsumer({
        residencyId,

        checkpointHash:
          lifecycleOne.blobHash,

        runtimeRevision:
          1
      });

    assert.equal(
      resync.toCursor,
      administrativeEvent.sequence
    );

    assert.equal(
      store.getBiologicalConsumer(
        residencyId
      ).cursor,
      administrativeEvent.sequence
    );

    /*
     * Consumer cursor is now 2 administratively.
     * Physiology still only incorporates sequence 1.
     */
    await store.commitResidentCheckpoint({
      residencyId,

      instanceId:
        'resident-instance-1',

      version:
        '0.4.0-i3d3',

      stateSchema:
        4,

      state: {
        modelClock:
          250,

        biologicalTransitions:
          1,

        lifecycle:
          'after-administrative-resync'
      }
    });

    const afterResync =
      await readCheckpoint();

    assert.equal(
      afterResync.inputCursor,
      firstEvent.sequence,
      'administrative consumer progress must not invent physiological provenance'
    );

    /*
     * Reactivate and apply genuine physiological
     * transition #3.
     */
    store.registerBiologicalConsumer({
      consumerId:
        residencyId,

      coreId:
        'sntss',

      topics: [
        'runtime.time.pulse'
      ],

      required:
        false,

      authorityEpoch:
        0
    });

    const nextBiologicalEvent =
      store.appendBiologicalEvent({
        topic:
          'runtime.time.pulse',

        payload: {
          wallClockMs:
            1750
        },

        meta: {
          deduplicationKey:
            'l0-c221-provenance-2'
        },

        eventClass:
          'durable',

        at:
          1750
      }).event;

    await store.commitResidentCheckpoint({
      residencyId,

      instanceId:
        'resident-instance-1',

      version:
        '0.4.0-i3d3',

      stateSchema:
        4,

      state: {
        modelClock:
          500,

        biologicalTransitions:
          2
      },

      consumerAck: {
        consumerId:
          residencyId,

        sequence:
          nextBiologicalEvent.sequence,

        transitionId:
          'sha256:' +
          'f'.repeat(64)
      }
    });

    const biologicalTwo =
      await readCheckpoint();

    assert.equal(
      biologicalTwo.inputCursor,
      nextBiologicalEvent.sequence
    );

    /*
     * Another lifecycle snapshot must retain #3.
     */
    await store.commitResidentCheckpoint({
      residencyId,

      instanceId:
        'resident-instance-1',

      version:
        '0.4.0-i3d3',

      stateSchema:
        4,

      state: {
        modelClock:
          500,

        biologicalTransitions:
          2,

        lifecycle:
          'final'
      }
    });

    const lifecycleFinal =
      await readCheckpoint();

    assert.equal(
      lifecycleFinal.inputCursor,
      nextBiologicalEvent.sequence
    );

    const lineage =
      store.db.prepare(`
        SELECT
          generation,
          input_cursor
        FROM resident_checkpoints
        WHERE residency_id=?
        ORDER BY generation
      `).all(
        residencyId
      );

    assert.deepEqual(
      lineage.map(row => ({
        generation:
          Number(row.generation),

        inputCursor:
          Number(row.input_cursor)
      })),

      [
        {
          generation: 1,
          inputCursor:
            firstEvent.sequence
        },
        {
          generation: 2,
          inputCursor:
            firstEvent.sequence
        },
        {
          generation: 3,
          inputCursor:
            firstEvent.sequence
        },
        {
          generation: 4,
          inputCursor:
            nextBiologicalEvent.sequence
        },
        {
          generation: 5,
          inputCursor:
            nextBiologicalEvent.sequence
        }
      ]
    );
  }
);
