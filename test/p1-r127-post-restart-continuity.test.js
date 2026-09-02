'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LivingKernel } = require('../runtime/kernel/living-kernel');
const { LivingKernel: HardenedLivingKernel } = require('../runtime');

const AUTHORIZATION =
  'AUTHORIZE_R127_POST_RESTART_FETUS_SNTSS_CHRONOBIOLOGY_CONTINUITY_ONLY';
const HIGH_WATER = 3654057;
const COHORT_FIRST = 3652769;
const SNTSS_HASH =
  'dd5921a4b98c054b463daf6216dddb39789773f890db464d0434809c55677acc';
const CHRONOBIOLOGY_HASH =
  '49f3a88b1b811757879e4cdddd25496f2bd4f3f3e4927d9b30d71c4b91c5efc9';
const METAB_HASH =
  '4a16fc393b9846d1dd6f2f9849920053e3d2b5235c066dde3c5cd72699595107';
const FETUS_HASH =
  'dc65f0fff624e08df092620697f230ea28521e8db34614c455f7473e6ed91b7b';
const AT = '2026-09-02T18:58:00.000Z';

const residentRows = Object.freeze([
  Object.freeze({
    residencyId: 'resident:sntss',
    coreId: 'sntss',
    role: 'resident-physiology',
    instanceId: '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
    version: '0.5.0-i4g1',
    stateSchema: 5,
    modulePath: 'cores/sntss/i4g/index.js',
    checkpointHash: SNTSS_HASH,
    checkpointGeneration: 2449921
  }),
  Object.freeze({
    residencyId: 'resident:chronobiology',
    coreId: 'chronobiology',
    role: 'chronobiology',
    instanceId: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
    version: '1.0.0-c3rc.5',
    stateSchema: 2,
    modulePath: 'cores/chronobiology/c3r5/index.js',
    checkpointHash: CHRONOBIOLOGY_HASH,
    checkpointGeneration: 10049
  }),
  Object.freeze({
    residencyId: 'resident:metab',
    coreId: 'METAB',
    role: 'metabolism',
    instanceId: 'd424c722-ef31-44b0-8201-ba68c418d14a',
    version: '0.1.0-p1r0-neutral.1',
    stateSchema: 1,
    modulePath: 'cores/p1-r0/metab-neutral/index.js',
    checkpointHash: METAB_HASH,
    checkpointGeneration: 1
  })
]);

const checkpointProofs = Object.freeze({
  'resident:sntss': Object.freeze({
    generation: 2449921,
    blobHash: SNTSS_HASH,
    inputCursor: 3652768,
    state: Object.freeze({
      trustedTime: Object.freeze({
        lastRuntimeRevision: 127,
        lastPulseSequence: 23828
      })
    })
  }),
  'resident:chronobiology': Object.freeze({
    generation: 10049,
    blobHash: CHRONOBIOLOGY_HASH,
    inputCursor: 3652631,
    state: Object.freeze({
      continuity: Object.freeze({
        last_runtime_revision: 127,
        last_trusted_pulse_sequence: 100
      })
    })
  })
});

function insertResident(db, row) {
  db.prepare(`
    INSERT INTO resident_instances(
      residency_id, core_id, role, instance_id, version, state_schema,
      module_relative_path, module_hash, manifest_hash, package_policy_hash,
      organism_identity_hash, checkpoint_hash, checkpoint_generation, status,
      attached_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?)
  `).run(
    row.residencyId, row.coreId, row.role, row.instanceId, row.version,
    row.stateSchema, row.modulePath, `sha256:module-${row.coreId}`,
    `sha256:manifest-${row.coreId}`, `sha256:policy-${row.coreId}`,
    'sha256:organism', row.checkpointHash, row.checkpointGeneration, AT, AT
  );
}

function insertConsumer(db, {
  consumerId,
  coreId,
  topics,
  topicsHash,
  cursor,
  authorityEpoch,
  checkpointHash,
  active
}) {
  db.prepare(`
    INSERT INTO biological_consumers(
      consumer_id, core_id, required, active, topics_json, topics_sha256,
      cursor, authority_epoch, checkpoint_hash, registered_at, updated_at
    ) VALUES(?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    consumerId, coreId, active ? 1 : 0, JSON.stringify(topics), topicsHash,
    cursor, authorityEpoch, checkpointHash, AT, AT
  );
}

async function makeExactCohort(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r127-restart-'));
  const kernel = new LivingKernel({
    dataDir: root,
    releaseRoot: path.resolve(__dirname, '..'),
    logger: { log() {}, info() {}, warn() {}, error() {} },
    heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0,
    r127PostRestartContinuityAuthorization: AUTHORIZATION
  });
  await kernel.stateStore.init();
  t.after(async () => {
    try { kernel.stateStore.close(); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });

  kernel.runtimeRevision = 127;
  kernel.startedAt = AT;
  kernel.metabNeutralRecoveryRevisionPreserved = true;
  kernel.r127PostRestartContinuityRecovery = true;

  const db = kernel.stateStore.db;
  kernel.stateStore.withTransaction(() => {
    for (const row of residentRows) insertResident(db, row);
    db.prepare(`
      UPDATE resident_instances SET status='RESYNC_REQUIRED'
      WHERE residency_id IN ('resident:sntss', 'resident:chronobiology')
    `).run();

    insertConsumer(db, {
      consumerId: 'resident:sntss',
      coreId: 'sntss',
      topics: [
        'runtime.organism.binding',
        'runtime.sntss.continuity-genesis',
        'runtime.time.pulse'
      ],
      topicsHash: 'b752d8eebb09ac925c4c193810d31f5527315e42e36fbedafa1f30ef25a97501',
      cursor: 3652769,
      authorityEpoch: 0,
      checkpointHash: SNTSS_HASH,
      active: false
    });
    insertConsumer(db, {
      consumerId: 'resident:chronobiology',
      coreId: 'chronobiology',
      topics: [
        'environment.photic.exposure',
        'runtime.organism.binding',
        'runtime.trusted-organism-time.pulse'
      ],
      topicsHash: 'a0897ae1c2f0bdf9f94e5491cf681820cda4a0126afcb47511cc4a538d5a281e',
      cursor: 3652768,
      authorityEpoch: 0,
      checkpointHash: CHRONOBIOLOGY_HASH,
      active: false
    });
    insertConsumer(db, {
      consumerId: 'resident:metab',
      coreId: 'METAB',
      topics: ['runtime.organism.binding'],
      topicsHash: '77da4c72943c31758d15cf829c4e4e19ec655ae35fd69baae6c5336528ce0819',
      cursor: HIGH_WATER,
      authorityEpoch: 0,
      checkpointHash: null,
      active: true
    });
    insertConsumer(db, {
      consumerId: 'core:fetus-legacy',
      coreId: 'fetus-legacy',
      topics: [],
      topicsHash: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      cursor: 3620902,
      authorityEpoch: 1,
      checkpointHash: null,
      active: false
    });

    const trustedSequences = new Set([3652769, 3653009, 3653249, 3653489, 3653729, 3653970]);
    let timePulse = 0;
    let trustedPulse = 0;
    const insertEvent = db.prepare(`
      INSERT INTO biological_events(
        sequence, event_id, topic, event_class, at_ms, deadline_at_ms,
        envelope_json, envelope_sha256, payload_sha256, provenance_sha256,
        deduplication_key, deduplication_sha256, created_at
      ) VALUES(?, ?, ?, 'durable', ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let sequence = COHORT_FIRST; sequence <= HIGH_WATER; sequence += 1) {
      const trusted = trustedSequences.has(sequence);
      const topic = trusted
        ? 'runtime.trusted-organism-time.pulse'
        : 'runtime.time.pulse';
      const pulseSequence = trusted ? ++trustedPulse : ++timePulse;
      const eventId = `evt-r127-${sequence}`;
      const deduplicationKey = `${topic}:127:${pulseSequence}`;
      const envelope = {
        id: eventId,
        sequence,
        topic,
        class: 'durable',
        payload: { runtimeRevision: 127, pulseSequence },
        meta: { sourceCore: 'living-kernel' }
      };
      insertEvent.run(
        sequence, eventId, topic, 1788375136684 + sequence - COHORT_FIRST,
        JSON.stringify(envelope), `envelope-${sequence}`, `payload-${sequence}`,
        `provenance-${sequence}`, deduplicationKey, `dedup-${sequence}`, AT
      );
    }
    assert.equal(timePulse, 1283);
    assert.equal(trustedPulse, 6);

    db.prepare(`
      INSERT INTO biological_deliveries(sequence, consumer_id)
      VALUES(3652769, 'resident:chronobiology')
    `).run();
    db.prepare(`
      INSERT INTO biological_deliveries(sequence, consumer_id)
      VALUES(3652770, 'resident:sntss')
    `).run();

    db.prepare(`
      INSERT INTO recovery_records(id, type, core_id, detail_json, created_at)
      VALUES(116, 'biological.consumer-demoted', 'fetus-legacy', ?, ?)
    `).run(JSON.stringify({
      consumerId: 'core:fetus-legacy',
      cursor: 3620902,
      pending: 16464,
      maximumDebt: 16384,
      resynchronizationRequired: true
    }), AT);
    db.prepare(`
      INSERT INTO recovery_records(id, type, core_id, detail_json, created_at)
      VALUES(119, 'resident.resync-required', 'chronobiology', ?, ?)
    `).run(JSON.stringify({
      residencyId: 'resident:chronobiology',
      sequence: 3652769,
      code: 'CHRONOBIOLOGY_TIME_REWIND'
    }), AT);
    db.prepare(`
      INSERT INTO recovery_records(id, type, core_id, detail_json, created_at)
      VALUES(120, 'resident.resync-required', 'sntss', ?, ?)
    `).run(JSON.stringify({
      residencyId: 'resident:sntss',
      sequence: 3652770,
      code: 'SNTSS_TIME_REWIND'
    }), AT);

    db.prepare(`
      INSERT INTO authority(
        core_id, instance_id, version, epoch, barrier_sequence,
        checkpoint_hash, updated_at
      ) VALUES('fetus-legacy', ?, '0.6.0', 1, 0, ?, ?)
    `).run('82202211-8dd6-44d4-a4ec-8f2553d8dc6f', FETUS_HASH, AT);
    db.prepare(`
      INSERT INTO checkpoints(
        checkpoint_id, core_id, instance_id, version, authority_epoch,
        state_schema, generation, blob_hash, byte_length, input_cursor, created_at
      ) VALUES('checkpoint:fetus:185', 'fetus-legacy', ?, '0.6.0', 1, 1, 185, ?, 47330, 0, ?)
    `).run('82202211-8dd6-44d4-a4ec-8f2553d8dc6f', FETUS_HASH, AT);
  });

  kernel.stateStore.readResidentCheckpoint = async residencyId =>
    checkpointProofs[residencyId] || null;
  return kernel;
}

function assertUnchangedFailureCohort(kernel) {
  const db = kernel.stateStore.db;
  assert.equal(db.prepare(
    "SELECT COUNT(*) count FROM biological_deliveries WHERE status='PENDING'"
  ).get().count, 2);
  assert.equal(kernel.stateStore.getResident('resident:sntss').status, 'RESYNC_REQUIRED');
  assert.equal(kernel.stateStore.getResident('resident:chronobiology').status, 'RESYNC_REQUIRED');
  assert.equal(kernel.stateStore.getBiologicalConsumer('resident:sntss').cursor, 3652769);
  assert.equal(kernel.stateStore.getBiologicalConsumer('resident:chronobiology').cursor, 3652768);
  assert.equal(kernel.stateStore.getBiologicalConsumer('core:fetus-legacy').cursor, 3620902);
  assert.equal(db.prepare(
    "SELECT COUNT(*) count FROM recovery_records WHERE type='biological.consumer-resynchronized'"
  ).get().count, 0);
}

test('R127-POST-RESTART-01 exact failed-process pulse cohort is repaired with zero abandonment', async t => {
  const kernel = await makeExactCohort(t);
  const pulses = await kernel.restoreTrustedPulseSequencesFromDurableState();
  assert.deepEqual(pulses, {
    trustedTimePulseSequence: 23828,
    trustedOrganismTimePulseSequence: 100
  });

  const repaired = await kernel.repairExactR127PostRestartContinuity();
  assert.deepEqual(repaired, {
    cohort: 'r127-post-restart-continuity-v1',
    runtimeRevision: 127,
    fetusDemotionId: 116,
    fetusFromCursor: 3620902,
    fetusToCursor: HIGH_WATER,
    sntssCheckpointHash: SNTSS_HASH,
    chronobiologyCheckpointHash: CHRONOBIOLOGY_HASH,
    acknowledgedPendingDeliveryCount: 2,
    supersededInputPulseCount: 1289,
    nonInputEventCount: 1288,
    abandonedCount: 0,
    inventedBiologicalTime: false,
    authorityChanged: false
  });
  for (const id of ['resident:sntss', 'resident:chronobiology']) {
    assert.equal(kernel.stateStore.getResident(id).status, 'RECOVERING');
    assert.equal(kernel.stateStore.getBiologicalConsumer(id).cursor, HIGH_WATER);
    assert.equal(kernel.stateStore.countPendingBiologicalEvents(id), 0);
  }
  const fetus = kernel.stateStore.getBiologicalConsumer('core:fetus-legacy');
  assert.equal(fetus.cursor, HIGH_WATER);
  assert.equal(fetus.checkpointHash, FETUS_HASH);
  assert.equal(kernel.upgrades.unresolvedBiologicalConsumerDemotion('fetus-legacy'), null);
  assert.equal(kernel.stateStore.getAuthority('fetus-legacy').checkpointHash, FETUS_HASH);

  const idempotent = await kernel.repairExactR127PostRestartContinuity();
  assert.equal(idempotent.idempotent, true);
  assert.equal(idempotent.abandonedCount, 0);
});

test('R127-POST-RESTART-02 any pulse-cohort drift fails before state changes', async t => {
  const kernel = await makeExactCohort(t);
  const db = kernel.stateStore.db;
  const row = db.prepare(
    'SELECT envelope_json FROM biological_events WHERE sequence=?'
  ).get(HIGH_WATER);
  const envelope = JSON.parse(row.envelope_json);
  envelope.payload.pulseSequence += 1;
  db.prepare('UPDATE biological_events SET envelope_json=? WHERE sequence=?')
    .run(JSON.stringify(envelope), HIGH_WATER);

  await assert.rejects(
    () => kernel.repairExactR127PostRestartContinuity(),
    { code: 'P1_R127_POST_RESTART_LEDGER' }
  );
  assertUnchangedFailureCohort(kernel);
});

test('R127-POST-RESTART-03 transaction failure preserves every checkpoint, cursor and delivery', async t => {
  const kernel = await makeExactCohort(t);
  const db = kernel.stateStore.db;
  db.exec(`
    CREATE TRIGGER fail_r127_fetus_resolution
    BEFORE INSERT ON recovery_records
    WHEN NEW.type='biological.consumer-resynchronized'
    BEGIN
      SELECT RAISE(ABORT, 'injected resolution failure');
    END
  `);

  await assert.rejects(
    () => kernel.repairExactR127PostRestartContinuity(),
    /injected resolution failure/
  );
  assertUnchangedFailureCohort(kernel);
  assert.equal(kernel.stateStore.getAuthority('fetus-legacy').checkpointHash, FETUS_HASH);
});

test('R127-POST-RESTART-04 exact resident recovery enables only the fenced fetus install at R127', async t => {
  const kernel = await makeExactCohort(t);
  await kernel.repairExactR127PostRestartContinuity();
  const db = kernel.stateStore.db;
  db.prepare(`
    UPDATE resident_instances SET status='RUNNING', checkpoint_generation=?
    WHERE residency_id='resident:sntss'
  `).run(2449922);
  db.prepare(`
    UPDATE resident_instances SET status='RUNNING', checkpoint_generation=?
    WHERE residency_id='resident:chronobiology'
  `).run(10050);
  db.prepare(`
    UPDATE resident_instances SET status='RUNNING', checkpoint_generation=2
    WHERE residency_id='resident:metab'
  `).run();
  db.prepare(`
    UPDATE biological_consumers SET active=1
    WHERE consumer_id IN ('resident:sntss', 'resident:chronobiology')
  `).run();

  const runtimeStatus = new Map(residentRows.map(row => [row.residencyId, {
    status: 'RUNNING',
    running: true,
    checkpointGeneration: row.checkpointGeneration + 1,
    checkpointHash: row.checkpointHash,
    pendingDeliveries: 0,
    observedOutputs: 0,
    authorityOwned: false,
    activationBackfilled: 0,
    lastError: null,
    health: row.coreId === 'METAB' ? { mode: 'NEUTRAL' } : { ok: true }
  }]));
  const drainCalls = [];
  kernel.ensureResidentManager = () => ({
    status: async residencyId => runtimeStatus.get(residencyId),
    drain: async (residencyId, throughSequence) => {
      drainCalls.push({ residencyId, throughSequence });
    }
  });
  const ordinaryRecovery = residentRows.map(row => ({
    residencyId: row.residencyId,
    recovered: true,
    status: 'RUNNING'
  }));
  await kernel.completeExactR127PostRestartResidentRecovery({
    ordinaryRecovery,
    coldRecovery: []
  });
  assert.equal(kernel.metabNeutralRecoveryCompletedAtPreservedRevision, true);

  const anchorHash = 'a'.repeat(64);
  const beforeAnchorState = {
    chemistry: { modelClock: 555219750 },
    trustedTime: {
      lastWallClockMs: 1788375134831,
      lastPulseSequence: 23828,
      lastRuntimeRevision: 127,
      lastClockStatus: 'trusted',
      acceptedPulses: 2449877,
      integratedIntervals: 2214506
    }
  };
  const afterAnchorState = {
    chemistry: { modelClock: 555219750 },
    trustedTime: {
      ...beforeAnchorState.trustedTime,
      lastWallClockMs: 1788381000000,
      lastPulseSequence: 23829,
      lastClockStatus: 'uncertain',
      acceptedPulses: 2449878
    }
  };
  let anchorCommitted = false;
  kernel.trustedTimePulseSequence = 23828;
  db.prepare(`
    INSERT INTO resident_checkpoints(
      checkpoint_id, residency_id, instance_id, version, state_schema,
      generation, blob_hash, byte_length, input_cursor, created_at
    ) VALUES('checkpoint:sntss:2449922', 'resident:sntss', ?, '0.5.0-i4g1',
      5, 2449922, ?, 4974, ?, ?)
  `).run(
    '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
    SNTSS_HASH,
    3652768,
    AT
  );
  kernel.stateStore.readResidentCheckpoint = async residencyId => {
    if (residencyId !== 'resident:sntss') return checkpointProofs[residencyId] || null;
    return anchorCommitted ? {
      generation: 2449923,
      blobHash: anchorHash,
      inputCursor: HIGH_WATER + 1,
      state: afterAnchorState
    } : {
      generation: 2449922,
      blobHash: SNTSS_HASH,
      inputCursor: 3652768,
      state: beforeAnchorState
    };
  };
  kernel.publishTimePulse = async clockStatus => {
    assert.equal(clockStatus, 'uncertain');
    const sequence = HIGH_WATER + 1;
    const eventId = `runtime.time.pulse:127:23829`;
    const envelope = {
      id: eventId,
      sequence,
      topic: 'runtime.time.pulse',
      class: 'durable',
      payload: {
        runtimeRevision: 127,
        pulseSequence: 23829,
        clockStatus
      },
      meta: { sourceCore: 'living-kernel' }
    };
    db.prepare(`
      INSERT INTO biological_events(
        sequence, event_id, topic, event_class, at_ms, deadline_at_ms,
        envelope_json, envelope_sha256, payload_sha256, provenance_sha256,
        deduplication_key, deduplication_sha256, created_at
      ) VALUES(?, ?, 'runtime.time.pulse', 'durable', ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sequence, eventId, 1788381000000, JSON.stringify(envelope),
      'anchor-envelope', 'anchor-payload', 'anchor-provenance', eventId,
      'anchor-deduplication', AT
    );
    db.prepare(`
      UPDATE resident_instances SET checkpoint_generation=2449923, checkpoint_hash=?
      WHERE residency_id='resident:sntss'
    `).run(anchorHash);
    db.prepare(`
      UPDATE biological_consumers SET cursor=?, checkpoint_hash=?
      WHERE consumer_id='resident:sntss'
    `).run(sequence, anchorHash);
    db.prepare(`
      INSERT INTO resident_checkpoints(
        checkpoint_id, residency_id, instance_id, version, state_schema,
        generation, blob_hash, byte_length, input_cursor, created_at
      ) VALUES('checkpoint:sntss:2449923', 'resident:sntss', ?, '0.5.0-i4g1',
        5, 2449923, ?, 4974, ?, ?)
    `).run(
      '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
      anchorHash,
      sequence,
      AT
    );
    runtimeStatus.set('resident:sntss', {
      ...runtimeStatus.get('resident:sntss'),
      checkpointGeneration: 2449923,
      checkpointHash: anchorHash,
      lastError: null
    });
    kernel.trustedTimePulseSequence = 23829;
    anchorCommitted = true;
  };
  const anchor = await kernel.anchorExactR127PostRestartTrustedTime();
  assert.deepEqual(drainCalls, [
    { residencyId: 'resident:sntss', throughSequence: HIGH_WATER },
    { residencyId: 'resident:sntss', throughSequence: HIGH_WATER + 1 }
  ]);
  assert.equal(anchor.clockStatus, 'uncertain');
  assert.equal(anchor.physiologyApplied, 0);
  assert.equal(anchor.inventedBiologicalTime, false);
  assert.equal(anchor.physiologyStateHashAfter, anchor.physiologyStateHashBefore);
  const anchorRecord = db.prepare(`
    SELECT detail_json FROM recovery_records
    WHERE type='resident.r127-restart-clock-anchored'
  `).get();
  assert.equal(JSON.parse(anchorRecord.detail_json).toPulseSequence, 23829);

  let installs = 0;
  kernel.upgrades.installInitial = async () => {
    installs += 1;
    return { manifest: { coreId: 'fetus-legacy', version: '0.6.0' } };
  };
  await kernel.installCore(path.join(
    path.resolve(__dirname, '..'),
    'cores/fetus-legacy-0.6/index.js'
  ));
  assert.equal(installs, 1);
  assert.equal(kernel.runtimeRevision, 127);
  assert.equal(kernel.metabNeutralRecoveryFetusInstallPreserved, true);
});

test('R127-POST-RESTART-ENTRY-05 real stopped-state clone starts every preserved entry path', {
  skip: !process.env.STAY_R127_POST_RESTART_REHEARSAL_DATA_DIR
}, async () => {
  const dataDir = path.resolve(process.env.STAY_R127_POST_RESTART_REHEARSAL_DATA_DIR);
  const freezeDirectory = path.resolve(process.env.STAY_RUNTIME_FREEZE_DIR);
  const kernel = new HardenedLivingKernel({
    dataDir,
    releaseRoot: path.resolve(__dirname, '..'),
    runtimeFreezeDirectory: freezeDirectory,
    logger: { log() {}, info() {}, warn() {}, error() {} },
    heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0,
    trustedTimePulseIntervalMs: 250,
    trustedOrganismTimePulseIntervalMs: 60000,
    enableTrustedOrganismTime: true,
    allowMetabNeutralBirth: true,
    allowMetabNeutralRecovery: true,
    allowMetabNeutralRecoveryRevisionPreservation: true,
    r127PostRestartContinuityAuthorization: AUTHORIZATION,
    metabNeutralRecoveryMarkerFile:
      process.env.STAY_METAB_NEUTRAL_RECOVERY_MARKER,
    metabNeutralRecoveryMarkerSha256:
      process.env.STAY_METAB_NEUTRAL_RECOVERY_MARKER_SHA256
  });
  try {
    await kernel.start();
    const fetus = await kernel.installCore(path.join(
      path.resolve(__dirname, '..'),
      'cores/fetus-legacy-0.6/index.js'
    ));
    assert.equal(fetus.manifest.coreId, 'fetus-legacy');
    assert.equal(fetus.manifest.version, '0.6.0');
    assert.equal(kernel.runtimeRevision, 127);

    let statuses;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      statuses = await Promise.all([
        'resident:sntss',
        'resident:chronobiology',
        'resident:metab'
      ].map(id => kernel.ensureResidentManager().status(id)));
      if (statuses.every(value => value.pendingDeliveries === 0)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(kernel.trustedTimePulseSequence >= 23829, true);
    assert.equal(kernel.trustedOrganismTimePulseSequence >= 101, true);
    for (const status of statuses) {
      assert.equal(status.status, 'RUNNING', `${status.residencyId} must remain running`);
      assert.equal(status.running, true);
      assert.equal(status.pendingDeliveries, 0);
      assert.equal(
        status.observedOutputs,
        status.residencyId === 'resident:chronobiology' ? 1 : 0,
        `${status.residencyId} must preserve its exact shadow-output contract`
      );
      assert.equal(status.authorityOwned, false);
      assert.equal(status.lastError, null);
      assert.equal(status.host.osContainment.required, true);
      assert.equal(status.host.osContainment.available, true);
      assert.equal(status.host.osContainment.payloadSandboxed, true);
      assert.equal(status.host.osContainment.payloadAttachedBeforeInit, true);
    }
    const anchor = kernel.stateStore.db.prepare(`
      SELECT detail_json FROM recovery_records
      WHERE type='resident.r127-restart-clock-anchored'
      ORDER BY id DESC LIMIT 1
    `).get();
    const anchorDetail = JSON.parse(anchor?.detail_json || 'null');
    const firstTimePulse = kernel.stateStore.db.prepare(`
      SELECT envelope_json FROM biological_events
      WHERE sequence>? AND topic='runtime.time.pulse'
      ORDER BY sequence LIMIT 1
    `).get(HIGH_WATER);
    const firstTimeEnvelope = JSON.parse(firstTimePulse?.envelope_json || 'null');
    assert.equal(anchorDetail.clockStatus, 'uncertain');
    assert.equal(anchorDetail.physiologyApplied, 0);
    assert.equal(anchorDetail.inventedBiologicalTime, false);
    assert.equal(
      anchorDetail.physiologyStateHashAfter,
      anchorDetail.physiologyStateHashBefore
    );
    assert.equal(firstTimeEnvelope.payload.runtimeRevision, 127);
    assert.equal(firstTimeEnvelope.payload.pulseSequence, 23829);
    assert.equal(firstTimeEnvelope.payload.clockStatus, 'uncertain');
    const fetusAuthority = kernel.stateStore.getAuthority('fetus-legacy');
    assert.equal(fetusAuthority.instanceId, '82202211-8dd6-44d4-a4ec-8f2553d8dc6f');
    assert.equal(fetusAuthority.version, '0.6.0');
    assert.equal(fetusAuthority.epoch, 1);
    assert.equal(kernel.stateStore.db.prepare(
      "SELECT COUNT(*) count FROM biological_deliveries WHERE status='PENDING'"
    ).get().count, 0);
    assert.equal(kernel.stateStore.listAuthority().filter(entry =>
      ['METAB', 'HOMEOS', 'INTERO'].includes(entry.coreId)
    ).length, 0);
    const recovered = kernel.stateStore.db.prepare(`
      SELECT detail_json FROM recovery_records
      WHERE type='runtime.r127-post-restart-continuity-recovered'
      ORDER BY id DESC LIMIT 1
    `).get();
    const detail = JSON.parse(recovered.detail_json);
    assert.equal(detail.abandonedCount, 0);
    assert.equal(detail.inventedBiologicalTime, false);
    assert.equal(detail.authorityChanged, false);
  } finally {
    await kernel.stop().catch(() => {});
  }
});
