'use strict';


const {
  normalizeAcceptedEnvelope,
  DURABILITY_CLASS
} = require('./biological-envelope');

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { stableStringify } = require('./canonical-json');

async function fsyncDirectory(dirPath) {
  let handle;
  try { handle = await fs.open(dirPath, 'r'); await handle.sync(); }
  catch (error) {
    const unsupported = ['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code) ||
      (process.platform === 'win32' && error.code === 'EPERM');
    if (!unsupported) throw error;
  }
  finally { await handle?.close(); }
}

async function atomicWrite(filePath, data, mode = 0o600, { acceptIdenticalExisting = false } = {}) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const handle = await fs.open(tmp, 'wx', mode);
  try { await handle.writeFile(data); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await fs.rename(tmp, filePath);
  } catch (error) {
    let identicalExisting = false;
    if (acceptIdenticalExisting && ['EEXIST', 'EPERM'].includes(error.code)) {
      try {
        const existing = await fs.readFile(filePath);
        const intended = Buffer.isBuffer(data) ? data : Buffer.from(data);
        identicalExisting = existing.equals(intended);
      } catch {}
    }
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (!identicalExisting) throw error;
  }
  await fsyncDirectory(dir);
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; }
  catch { return false; }
}

function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
async function sha256File(filePath) {
  const handle = await fs.open(filePath, 'r');
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    return digest.digest('hex');
  } finally {
    await handle.close();
  }
}


function biologicalProducerProposal(
  envelope
) {
  return {
    producer_event_id:
      envelope.producer_event_id,

    producer_stream_id:
      envelope.producer_stream_id,

    stream_sequence:
      envelope.stream_sequence,

    topic:
      envelope.topic,

    signal_class:
      envelope.signal_class,

    schema_version:
      envelope.schema_version,

    temporal:
      envelope.temporal,

    valid_from_us:
      envelope.valid_from_us,

    expires_at_us:
      envelope.expires_at_us,

    durability_class:
      envelope.durability_class,

    payload:
      envelope.payload,

    direct_parents:
      envelope.direct_parents,

    causal_source_spans:
      envelope.causal_source_spans
  };
}

function biologicalProducerProposalHash(
  envelope
) {
  return sha256(
    stableStringify(
      biologicalProducerProposal(
        envelope
      )
    )
  );
}

function biologicalRetrySemanticProjection(
  envelope
) {
  return {
    protocol:
      envelope.protocol,

    organism_id:
      envelope.organism_id,

    producer_core_id:
      envelope.producer_core_id,

    producer_instance_id:
      envelope.producer_instance_id,

    producer_version:
      envelope.producer_version,

    authority_epoch:
      envelope.authority_epoch,

    authority_mode:
      envelope.authority_mode,

    ...biologicalProducerProposal(
      envelope
    ),

    order_time_us:
      envelope.order_time_us,

    payload_hash:
      envelope.payload_hash,

    causal_roots:
      envelope.causal_roots,

    causal_generation:
      envelope.causal_generation,

    roots_overflow_digest:
      envelope.roots_overflow_digest,

    lineage_digest:
      envelope.lineage_digest,

    ancestor_core_set:
      envelope.ancestor_core_set,

    causality_validated:
      (
        Array.isArray(
          envelope.direct_parents
        ) &&
        envelope.direct_parents.length > 0
      ) ||
      (
        Array.isArray(
          envelope.causal_source_spans
        ) &&
        envelope.causal_source_spans.length > 0
      )
  };
}

function biologicalStreamProgressHeadBody(
  value
) {
  return {
    organismId:
      value.organismId,

    producerStreamId:
      value.producerStreamId,

    authorityEpoch:
      value.authorityEpoch,

    producerCoreId:
      value.producerCoreId,

    producerInstanceId:
      value.producerInstanceId,

    producerVersion:
      value.producerVersion,

    authorityMode:
      value.authorityMode,

    finalizedThroughUs:
      value.finalizedThroughUs,

    finalizedSignalCount:
      value.finalizedSignalCount,

    finalizedLastStreamSequence:
      value.finalizedLastStreamSequence,

    progressId:
      value.progressId
  };
}



function biologicalOutboxStreamHeadBody(
  value
) {
  return {
    producerCoreId:
      value.producerCoreId,

    authorityEpoch:
      value.authorityEpoch,

    producerStreamId:
      value.producerStreamId,

    producerInstanceId:
      value.producerInstanceId,

    producerVersion:
      value.producerVersion,

    lastStreamSequence:
      value.lastStreamSequence,

    lastProducerEventId:
      value.lastProducerEventId
  };
}


function biologicalCutoverSpoolBody(
  value
) {
  return {
    transactionId:
      value.transactionId,

    producerEventId:
      value.producerEventId,

    producerCoreId:
      value.producerCoreId,

    producerInstanceId:
      value.producerInstanceId,

    producerVersion:
      value.producerVersion,

    fromAuthorityEpoch:
      value.fromAuthorityEpoch,

    toAuthorityEpoch:
      value.toAuthorityEpoch,

    barrierSequence:
      value.barrierSequence,

    producerStreamId:
      value.producerStreamId,

    streamSequence:
      value.streamSequence,

    proposalHash:
      value.proposalHash,

    intentHash:
      value.intentHash
  };
}


const BIOLOGICAL_ROUTE_STATES =
  Object.freeze([
    'ACTIVE',
    'DEGRADED',
    'EVIDENCE_GAP',
    'CLOSED',
    'RETIRED'
  ]);

const BIOLOGICAL_ROUTE_STATE_SET =
  new Set(
    BIOLOGICAL_ROUTE_STATES
  );

function biologicalRouteHeadBody(
  value
) {
  return {
    routeId:
      value.routeId,

    organismId:
      value.organismId,

    consumerId:
      value.consumerId,

    producerCoreId:
      value.producerCoreId,

    producerStreamId:
      value.producerStreamId,

    authorityEpoch:
      value.authorityEpoch,

    required:
      value.required,

    state:
      value.state,

    activeFromUs:
      value.activeFromUs,

    routeBarrierUs:
      value.routeBarrierUs,

    gapFromUs:
      value.gapFromUs,

    gapThroughUs:
      value.gapThroughUs,

    transitionSequence:
      value.transitionSequence,

    lastTransitionId:
      value.lastTransitionId
  };
}

function biologicalRouteTransitionBody(
  value
) {
  return {
    protocol:
      'stay-biological-route-transition-v1',

    routeId:
      value.routeId,

    transitionSequence:
      value.transitionSequence,

    fromState:
      value.fromState,

    toState:
      value.toState,

    authorityEpoch:
      value.authorityEpoch,

    activeFromUs:
      value.activeFromUs,

    routeBarrierUs:
      value.routeBarrierUs,

    gapFromUs:
      value.gapFromUs,

    gapThroughUs:
      value.gapThroughUs,

    reason:
      value.reason
  };
}

function biologicalRouteBoundaryAckBody(
  value
) {
  return {
    protocol:
      'stay-biological-route-boundary-ack-v1',

    routeId:
      value.routeId,

    transitionSequence:
      value.transitionSequence,

    consumerId:
      value.consumerId,

    boundaryState:
      value.boundaryState,

    routeBarrierUs:
      value.routeBarrierUs,

    committedThroughUs:
      value.committedThroughUs,

    checkpointHash:
      value.checkpointHash,

    transitionId:
      value.transitionId,

    semantics:
      value.semantics
  };
}

const RESIDENT_HASH =
  /^sha256:[0-9a-f]{64}$/;

const RESIDENT_STATUSES =
  new Set([
    'ATTACHED',
    'RUNNING',
    'RECOVERING',
    'QUARANTINED',
    'RESYNC_REQUIRED',
    'DETACHED'
  ]);

function residentRecord(row) {
  if (!row) return null;

  return {
    residencyId: row.residency_id,
    coreId: row.core_id,
    role: row.role,
    instanceId: row.instance_id,
    version: row.version,
    stateSchema: Number(row.state_schema),
    moduleRelativePath: row.module_relative_path,
    moduleHash: row.module_hash,
    manifestHash: row.manifest_hash,
    packagePolicyHash: row.package_policy_hash,
    organismIdentityHash: row.organism_identity_hash,
    checkpointHash: row.checkpoint_hash || null,
    checkpointGeneration:
      Number(row.checkpoint_generation) || 0,
    status: row.status,
    attachedAt: row.attached_at,
    updatedAt: row.updated_at
  };
}

async function collectFiles(rootDir) {
  const result = [];
  if (!(await exists(rootDir))) return result;
  for (const entry of await fs.readdir(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) result.push(...await collectFiles(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

class StateStore {
  constructor(rootDir) {
    if (!rootDir) throw new Error('StateStore requires a rootDir');
    this.rootDir = path.resolve(rootDir);
    this.databasePath = path.join(this.rootDir, 'continuity.sqlite3');
    this.blobRoot = path.join(this.rootDir, 'blobs', 'sha256');
    this.db = null;
    this.lastSuccessfulWriteAt = null;
    this.lastWriteError = null;
    this.writeFailureCount = 0;
    this.maintenanceErrors = new Map();
    this.snapshotBlobPinCounts = new Map();
    this.deferredBlobDeletes = new Set();
  }

  async init() {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    for (const relative of ['life', 'cores', 'journal', 'snapshots', 'blobs/sha256']) {
      await fs.mkdir(path.join(this.rootDir, relative), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(this.databasePath);

    try {
      /*
       * Refuse a database produced by a newer runtime before executing any
       * DDL.  In particular, CREATE TABLE IF NOT EXISTS and ALTER TABLE are
       * not harmless probes: an older binary must not partially rewrite a
       * future continuity store before it discovers the version mismatch.
       */
      this.assertSupportedSchemaVersions();

      this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      `);

      this.db.exec('BEGIN IMMEDIATE');

      try {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_metadata_mirrors (
        key TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL,
        json TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS authority (
        core_id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        version TEXT NOT NULL,
        epoch INTEGER NOT NULL CHECK(epoch >= 1),
        barrier_sequence INTEGER NOT NULL DEFAULT 0,
        checkpoint_hash TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS upgrade_transactions (
        transaction_id TEXT PRIMARY KEY,
        core_id TEXT NOT NULL,
        status TEXT NOT NULL,
        from_instance_id TEXT NOT NULL,
        from_version TEXT NOT NULL,
        from_epoch INTEGER NOT NULL,
        to_instance_id TEXT NOT NULL,
        to_version TEXT NOT NULL,
        to_epoch INTEGER NOT NULL,
        barrier_sequence INTEGER NOT NULL,
        prepared_at TEXT NOT NULL,
        finalized_at TEXT,
        to_checkpoint_hash TEXT,
        to_state_schema INTEGER,
        spooled_intent_count INTEGER NOT NULL DEFAULT 0,
        spool_sha256 TEXT,
        cutover_sealed_at TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS upgrade_core_status ON upgrade_transactions(core_id, status);
      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        core_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        version TEXT NOT NULL,
        authority_epoch INTEGER NOT NULL,
        state_schema INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        blob_hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        input_cursor INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(core_id, generation)
      );
      CREATE INDEX IF NOT EXISTS checkpoint_latest ON checkpoints(core_id, generation DESC);

      CREATE TABLE IF NOT EXISTS resident_instances (
        residency_id TEXT PRIMARY KEY,
        core_id TEXT NOT NULL,
        role TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        version TEXT NOT NULL,
        state_schema INTEGER NOT NULL CHECK(state_schema >= 1),
        module_relative_path TEXT NOT NULL,
        module_hash TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        package_policy_hash TEXT NOT NULL,
        organism_identity_hash TEXT NOT NULL,
        checkpoint_hash TEXT,
        checkpoint_generation INTEGER NOT NULL DEFAULT 0
          CHECK(checkpoint_generation >= 0),
        status TEXT NOT NULL CHECK(
          status IN (
            'ATTACHED',
            'RUNNING',
            'RECOVERING',
            'QUARANTINED',
            'RESYNC_REQUIRED',
            'DETACHED'
          )
        ),
        attached_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS resident_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        residency_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        version TEXT NOT NULL,
        state_schema INTEGER NOT NULL CHECK(state_schema >= 1),
        generation INTEGER NOT NULL CHECK(generation >= 1),
        blob_hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
        input_cursor INTEGER NOT NULL DEFAULT 0 CHECK(input_cursor >= 0),
        created_at TEXT NOT NULL,
        UNIQUE(residency_id, generation),
        FOREIGN KEY(residency_id)
          REFERENCES resident_instances(residency_id)
          ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS resident_checkpoint_latest
        ON resident_checkpoints(residency_id, generation DESC);

      CREATE TABLE IF NOT EXISTS resident_resynchronizations (
        resync_id TEXT PRIMARY KEY,
        residency_id TEXT NOT NULL,
        from_cursor INTEGER NOT NULL CHECK(from_cursor >= 0),
        to_cursor INTEGER NOT NULL CHECK(to_cursor >= 0),
        abandoned_count INTEGER NOT NULL CHECK(abandoned_count >= 0),
        first_abandoned_sequence INTEGER,
        last_abandoned_sequence INTEGER,
        checkpoint_hash TEXT NOT NULL,
        runtime_revision INTEGER NOT NULL CHECK(runtime_revision >= 1),
        created_at TEXT NOT NULL,
        FOREIGN KEY(residency_id)
          REFERENCES resident_instances(residency_id)
          ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS resident_resync_history
        ON resident_resynchronizations(
          residency_id,
          created_at
        );

      CREATE TABLE IF NOT EXISTS biological_events (
        sequence INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        topic TEXT NOT NULL,
        event_class TEXT NOT NULL CHECK(event_class IN ('critical', 'durable')),
        at_ms INTEGER NOT NULL,
        deadline_at_ms INTEGER,
        envelope_json TEXT NOT NULL,
        envelope_sha256 TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        provenance_sha256 TEXT NOT NULL,
        deduplication_key TEXT UNIQUE,
        deduplication_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS biological_envelopes_v2 (
        sequence INTEGER PRIMARY KEY,
        signal_id TEXT NOT NULL UNIQUE,
        organism_id TEXT NOT NULL,
        producer_core_id TEXT NOT NULL,
        producer_instance_id TEXT NOT NULL,
        producer_version TEXT NOT NULL,
        producer_event_id TEXT NOT NULL,
        producer_stream_id TEXT NOT NULL,
        stream_sequence INTEGER NOT NULL CHECK(stream_sequence >= 1),
        authority_epoch INTEGER NOT NULL CHECK(authority_epoch >= 1),
        authority_mode TEXT NOT NULL CHECK(authority_mode IN ('neutral', 'lab', 'shadow', 'authoritative')),
        accepted_time_us INTEGER NOT NULL CHECK(accepted_time_us >= 0),
        order_time_us INTEGER NOT NULL CHECK(order_time_us >= 0),
        proposal_sha256 TEXT,
        envelope_json TEXT NOT NULL,
        envelope_sha256 TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(sequence)
          REFERENCES biological_events(sequence)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS biological_v2_signal_stream
        ON biological_envelopes_v2(
          producer_stream_id,
          authority_epoch,
          stream_sequence
        );
      CREATE INDEX IF NOT EXISTS biological_v2_producer_event
        ON biological_envelopes_v2(
          organism_id,
          producer_core_id,
          producer_event_id
        );
      CREATE TABLE IF NOT EXISTS biological_stream_heads (
        organism_id TEXT NOT NULL,
        producer_stream_id TEXT NOT NULL,
        authority_epoch INTEGER NOT NULL CHECK(authority_epoch >= 1),
        producer_core_id TEXT NOT NULL,
        last_producer_instance_id TEXT NOT NULL,
        last_producer_version TEXT NOT NULL,
        last_authority_mode TEXT NOT NULL CHECK(last_authority_mode IN ('neutral', 'lab', 'shadow', 'authoritative')),
        last_stream_sequence INTEGER NOT NULL CHECK(last_stream_sequence >= 1),
        last_fabric_sequence INTEGER NOT NULL CHECK(last_fabric_sequence >= 1),
        last_signal_id TEXT NOT NULL,
        head_sha256 TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(
          organism_id,
          producer_stream_id,
          authority_epoch
        )
      );
      CREATE TABLE IF NOT EXISTS biological_stream_progress (
        progress_id TEXT PRIMARY KEY,
        organism_id TEXT NOT NULL,
        producer_stream_id TEXT NOT NULL,
        authority_epoch INTEGER NOT NULL CHECK(authority_epoch >= 1),
        producer_core_id TEXT NOT NULL,
        producer_instance_id TEXT NOT NULL,
        producer_version TEXT NOT NULL,
        authority_mode TEXT NOT NULL CHECK(authority_mode IN ('neutral', 'lab', 'shadow', 'authoritative')),
        finalized_through_us INTEGER NOT NULL CHECK(finalized_through_us >= 0),
        finalized_signal_count INTEGER NOT NULL CHECK(finalized_signal_count >= 0),
        finalized_last_stream_sequence INTEGER NOT NULL CHECK(finalized_last_stream_sequence >= 0),
        accepted_time_us INTEGER NOT NULL CHECK(accepted_time_us >= 0),
        previous_progress_id TEXT,
        progress_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(
          organism_id,
          producer_stream_id,
          authority_epoch,
          finalized_through_us
        )
      );

      CREATE INDEX IF NOT EXISTS biological_stream_progress_order
        ON biological_stream_progress(
          organism_id,
          producer_stream_id,
          authority_epoch,
          finalized_through_us
        );

      CREATE TABLE IF NOT EXISTS biological_stream_progress_heads (
        organism_id TEXT NOT NULL,
        producer_stream_id TEXT NOT NULL,
        authority_epoch INTEGER NOT NULL CHECK(authority_epoch >= 1),
        producer_core_id TEXT NOT NULL,
        producer_instance_id TEXT NOT NULL,
        producer_version TEXT NOT NULL,
        authority_mode TEXT NOT NULL CHECK(authority_mode IN ('neutral', 'lab', 'shadow', 'authoritative')),
        finalized_through_us INTEGER NOT NULL CHECK(finalized_through_us >= 0),
        finalized_signal_count INTEGER NOT NULL CHECK(finalized_signal_count >= 0),
        finalized_last_stream_sequence INTEGER NOT NULL CHECK(finalized_last_stream_sequence >= 0),
        progress_id TEXT NOT NULL,
        head_sha256 TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(
          organism_id,
          producer_stream_id,
          authority_epoch
        ),
        FOREIGN KEY(progress_id)
          REFERENCES biological_stream_progress(progress_id)
          ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS biological_outbox_intents (
        producer_event_id TEXT PRIMARY KEY,
        producer_core_id TEXT NOT NULL,
        producer_instance_id TEXT NOT NULL,
        producer_version TEXT NOT NULL,
        authority_epoch INTEGER NOT NULL CHECK(authority_epoch >= 1),

        producer_stream_id TEXT NOT NULL,
        stream_sequence INTEGER NOT NULL CHECK(stream_sequence >= 1),

        transition_id TEXT NOT NULL,
        cause_sequence INTEGER NOT NULL CHECK(cause_sequence >= 1),
        output_index INTEGER NOT NULL CHECK(output_index >= 1),

        topic TEXT NOT NULL,

        proposal_sha256 TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        intent_sha256 TEXT NOT NULL,

        checkpoint_id TEXT NOT NULL,
        checkpoint_hash TEXT NOT NULL,
        checkpoint_generation INTEGER NOT NULL CHECK(checkpoint_generation >= 1),

        status TEXT NOT NULL DEFAULT 'PENDING'
          CHECK(status IN ('PENDING', 'PUBLISHED')),

        fabric_sequence INTEGER,
        fabric_event_id TEXT,

        created_at TEXT NOT NULL,
        published_at TEXT,

        UNIQUE(
          producer_core_id,
          authority_epoch,
          producer_stream_id,
          stream_sequence
        ),

        UNIQUE(
          producer_core_id,
          authority_epoch,
          transition_id,
          output_index
        )
      );

      CREATE INDEX IF NOT EXISTS biological_outbox_pending
        ON biological_outbox_intents(
          producer_core_id,
          status,
          authority_epoch,
          stream_sequence
        );

      CREATE TABLE IF NOT EXISTS biological_outbox_stream_heads (
        producer_core_id TEXT NOT NULL,
        authority_epoch INTEGER NOT NULL CHECK(authority_epoch >= 1),
        producer_stream_id TEXT NOT NULL,
        producer_instance_id TEXT NOT NULL,
        producer_version TEXT NOT NULL,
        last_stream_sequence INTEGER NOT NULL CHECK(last_stream_sequence >= 1),
        last_producer_event_id TEXT NOT NULL,
        head_sha256 TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(
          producer_core_id,
          authority_epoch,
          producer_stream_id
        )
      );

      CREATE TABLE IF NOT EXISTS biological_cutover_spool (
        producer_event_id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL,
        producer_core_id TEXT NOT NULL,
        producer_instance_id TEXT NOT NULL,
        producer_version TEXT NOT NULL,
        from_authority_epoch INTEGER NOT NULL CHECK(from_authority_epoch >= 1),
        to_authority_epoch INTEGER NOT NULL CHECK(to_authority_epoch > from_authority_epoch),
        barrier_sequence INTEGER NOT NULL CHECK(barrier_sequence >= 0),
        producer_stream_id TEXT NOT NULL,
        stream_sequence INTEGER NOT NULL CHECK(stream_sequence >= 1),
        proposal_sha256 TEXT NOT NULL,
        intent_sha256 TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'SPOOLED'
          CHECK(status IN ('SPOOLED', 'ACCEPTED')),
        fabric_sequence INTEGER,
        fabric_event_id TEXT,
        spool_sha256 TEXT NOT NULL,
        spooled_at TEXT NOT NULL,
        accepted_at TEXT,
        FOREIGN KEY(producer_event_id)
          REFERENCES biological_outbox_intents(producer_event_id)
          ON DELETE RESTRICT,
        FOREIGN KEY(transaction_id)
          REFERENCES upgrade_transactions(transaction_id)
          ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS biological_cutover_spool_core_status
        ON biological_cutover_spool(
          producer_core_id,
          status,
          from_authority_epoch,
          producer_stream_id,
          stream_sequence
        );

      CREATE TABLE IF NOT EXISTS biological_consumers (
        consumer_id TEXT PRIMARY KEY,
        core_id TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 1 CHECK(required IN (0, 1)),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        topics_json TEXT NOT NULL,
        topics_sha256 TEXT NOT NULL,
        cursor INTEGER NOT NULL DEFAULT 0,
        authority_epoch INTEGER NOT NULL DEFAULT 0,
        checkpoint_hash TEXT,
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS biological_deliveries (
        sequence INTEGER NOT NULL,
        consumer_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'ACKED')),
        transition_id TEXT,
        checkpoint_hash TEXT,
        acknowledged_at TEXT,
        PRIMARY KEY(sequence, consumer_id),
        FOREIGN KEY(sequence) REFERENCES biological_events(sequence) ON DELETE CASCADE,
        FOREIGN KEY(consumer_id) REFERENCES biological_consumers(consumer_id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS biological_delivery_pending ON biological_deliveries(consumer_id, status, sequence);
      CREATE TABLE IF NOT EXISTS biological_routes (
        route_id TEXT PRIMARY KEY,
        organism_id TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        producer_core_id TEXT NOT NULL,
        producer_stream_id TEXT NOT NULL,
        authority_epoch INTEGER NOT NULL CHECK(authority_epoch >= 1),
        required INTEGER NOT NULL DEFAULT 1 CHECK(required IN (0, 1)),
        state TEXT NOT NULL CHECK(state IN ('ACTIVE', 'DEGRADED', 'EVIDENCE_GAP', 'CLOSED', 'RETIRED')),
        active_from_us INTEGER NOT NULL CHECK(active_from_us >= 0),
        route_barrier_us INTEGER,
        gap_from_us INTEGER,
        gap_through_us INTEGER,
        transition_sequence INTEGER NOT NULL CHECK(transition_sequence >= 1),
        last_transition_id TEXT NOT NULL,
        head_sha256 TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(consumer_id)
          REFERENCES biological_consumers(consumer_id)
          ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS biological_routes_consumer_state
        ON biological_routes(
          consumer_id,
          required,
          state,
          route_id
        );

      CREATE TABLE IF NOT EXISTS biological_route_transitions (
        route_id TEXT NOT NULL,
        transition_sequence INTEGER NOT NULL CHECK(transition_sequence >= 1),
        transition_id TEXT NOT NULL UNIQUE,
        from_state TEXT,
        to_state TEXT NOT NULL CHECK(to_state IN ('ACTIVE', 'DEGRADED', 'EVIDENCE_GAP', 'CLOSED', 'RETIRED')),
        authority_epoch INTEGER NOT NULL CHECK(authority_epoch >= 1),
        active_from_us INTEGER NOT NULL CHECK(active_from_us >= 0),
        route_barrier_us INTEGER,
        gap_from_us INTEGER,
        gap_through_us INTEGER,
        reason TEXT NOT NULL,
        transition_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(route_id, transition_sequence),
        FOREIGN KEY(route_id)
          REFERENCES biological_routes(route_id)
          ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS biological_route_boundary_acks (
        route_id TEXT NOT NULL,
        transition_sequence INTEGER NOT NULL CHECK(transition_sequence >= 1),
        ack_id TEXT NOT NULL UNIQUE,
        consumer_id TEXT NOT NULL,
        boundary_state TEXT NOT NULL CHECK(boundary_state IN ('DEGRADED', 'EVIDENCE_GAP', 'CLOSED')),
        route_barrier_us INTEGER NOT NULL CHECK(route_barrier_us >= 0),
        committed_through_us INTEGER NOT NULL CHECK(committed_through_us >= route_barrier_us),
        checkpoint_hash TEXT NOT NULL,
        transition_id TEXT NOT NULL,
        semantics TEXT NOT NULL CHECK(semantics IN ('UNKNOWN_INPUT', 'COMPLETE_END')),
        ack_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(route_id, transition_sequence),
        FOREIGN KEY(route_id, transition_sequence)
          REFERENCES biological_route_transitions(route_id, transition_sequence)
          ON DELETE RESTRICT,
        FOREIGN KEY(consumer_id)
          REFERENCES biological_consumers(consumer_id)
          ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS recovery_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        core_id TEXT,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_versions (
        name TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const upgradeColumns = new Set(this.db.prepare('PRAGMA table_info(upgrade_transactions)').all().map(row => row.name));
    if (!upgradeColumns.has('to_checkpoint_hash')) this.db.exec('ALTER TABLE upgrade_transactions ADD COLUMN to_checkpoint_hash TEXT');
    if (!upgradeColumns.has('to_state_schema')) this.db.exec('ALTER TABLE upgrade_transactions ADD COLUMN to_state_schema INTEGER');
    if (!upgradeColumns.has('spooled_intent_count')) this.db.exec('ALTER TABLE upgrade_transactions ADD COLUMN spooled_intent_count INTEGER NOT NULL DEFAULT 0');
    if (!upgradeColumns.has('spool_sha256')) this.db.exec('ALTER TABLE upgrade_transactions ADD COLUMN spool_sha256 TEXT');
    if (!upgradeColumns.has('cutover_sealed_at')) this.db.exec('ALTER TABLE upgrade_transactions ADD COLUMN cutover_sealed_at TEXT');
    const checkpointColumns = new Set(this.db.prepare('PRAGMA table_info(checkpoints)').all().map(row => row.name));
    if (!checkpointColumns.has('input_cursor')) this.db.exec('ALTER TABLE checkpoints ADD COLUMN input_cursor INTEGER NOT NULL DEFAULT 0');
    const schemaRow = this.db.prepare("SELECT version FROM schema_versions WHERE name='continuity'").get();
    if (Number(schemaRow?.version || 0) > 4) {
      throw Object.assign(
        new Error(
          'continuity schema is newer than this runtime supports'
        ),
        {
          code:
            'STATE_SCHEMA_UNSUPPORTED'
        }
      );
    }

    /*
     * Continuity schema 4 introduces durable
     * residency:
     *
     *   resident_instances
     *   resident_checkpoints
     *
     * An older schema-3 runtime MUST therefore
     * refuse a schema-4 database instead of opening
     * it while silently ignoring resident history.
     */
    this.db.prepare(`
      INSERT INTO schema_versions(
        name,
        version,
        updated_at
      )
      VALUES(
        'continuity',
        4,
        ?
      )
      ON CONFLICT(name)
      DO UPDATE SET
        version=excluded.version,
        updated_at=excluded.updated_at
    `).run(
      new Date().toISOString()
    );
      const biologicalEnvelopeSchemaRow =
        this.db.prepare(
          "SELECT version FROM schema_versions WHERE name='biological-envelope'"
        ).get();

      const biologicalEnvelopeSchemaVersion =
        Number(
          biologicalEnvelopeSchemaRow?.version ||
          0
        );

      if (
        biologicalEnvelopeSchemaVersion >
        4
      ) {
        throw Object.assign(
          new Error(
            'biological envelope schema is newer than this runtime supports'
          ),
          {
            code:
              'STATE_BIOLOGICAL_SCHEMA_UNSUPPORTED'
          }
        );
      }

      const createBiologicalStreamSequenceIndex =
        () => {
          this.db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS biological_v2_stream_sequence
            ON biological_envelopes_v2(
              organism_id,
              producer_stream_id,
              authority_epoch,
              stream_sequence
            )
          `);
        };

      if (
        biologicalEnvelopeSchemaVersion <
        3
      ) {
        this.withTransaction(
          () => {
            const rows =
              this.db.prepare(`
                SELECT *
                FROM biological_envelopes_v2
                ORDER BY
                  organism_id ASC,
                  producer_stream_id ASC,
                  authority_epoch ASC,
                  stream_sequence ASC,
                  sequence ASC
              `).all();

            const heads =
              new Map();

            for (
              const row of rows
            ) {
              const key =
                stableStringify([
                  row.organism_id,
                  row.producer_stream_id,
                  Number(
                    row.authority_epoch
                  )
                ]);

              const previous =
                heads.get(
                  key
                );

              if (
                previous &&
                previous.producerCoreId !==
                  row.producer_core_id
              ) {
                throw Object.assign(
                  new Error(
                    'biological stream migration found multiple owning cores'
                  ),
                  {
                    code:
                      'STATE_BIOLOGICAL_STREAM_MIGRATION'
                  }
                );
              }

              if (
                previous &&
                (
                  Number(
                    row.stream_sequence
                  ) <=
                    previous.lastStreamSequence ||
                  Number(
                    row.sequence
                  ) <=
                    previous.lastFabricSequence
                )
              ) {
                throw Object.assign(
                  new Error(
                    'biological stream migration found non-monotonic history'
                  ),
                  {
                    code:
                      'STATE_BIOLOGICAL_STREAM_MIGRATION'
                  }
                );
              }

              heads.set(
                key,
                {
                  organismId:
                    row.organism_id,

                  producerStreamId:
                    row.producer_stream_id,

                  authorityEpoch:
                    Number(
                      row.authority_epoch
                    ),

                  producerCoreId:
                    row.producer_core_id,

                  lastProducerInstanceId:
                    row.producer_instance_id,

                  lastProducerVersion:
                    row.producer_version,

                  lastAuthorityMode:
                    row.authority_mode,

                  lastStreamSequence:
                    Number(
                      row.stream_sequence
                    ),

                  lastFabricSequence:
                    Number(
                      row.sequence
                    ),

                  lastSignalId:
                    row.signal_id
                }
              );
            }

            this.db.prepare(
              'DELETE FROM biological_stream_heads'
            ).run();

            const insertHead =
              this.db.prepare(`
                INSERT INTO biological_stream_heads(
                  organism_id,
                  producer_stream_id,
                  authority_epoch,
                  producer_core_id,
                  last_producer_instance_id,
                  last_producer_version,
                  last_authority_mode,
                  last_stream_sequence,
                  last_fabric_sequence,
                  last_signal_id,
                  head_sha256,
                  updated_at
                )
                VALUES(
                  ?,
                  ?,
                  ?,
                  ?,
                  ?,
                  ?,
                  ?,
                  ?,
                  ?,
                  ?,
                  ?,
                  ?
                )
              `);

            const updatedAt =
              new Date().toISOString();

            for (
              const head of heads.values()
            ) {
              insertHead.run(
                head.organismId,
                head.producerStreamId,
                head.authorityEpoch,
                head.producerCoreId,
                head.lastProducerInstanceId,
                head.lastProducerVersion,
                head.lastAuthorityMode,
                head.lastStreamSequence,
                head.lastFabricSequence,
                head.lastSignalId,
                sha256(
                  stableStringify(
                    head
                  )
                ),
                updatedAt
              );
            }

            createBiologicalStreamSequenceIndex();

            this.db.prepare(`
              INSERT INTO schema_versions(
                name,
                version,
                updated_at
              )
              VALUES(
                'biological-envelope',
                3,
                ?
              )
              ON CONFLICT(name)
              DO UPDATE SET
                version=excluded.version,
                updated_at=excluded.updated_at
            `).run(
              new Date().toISOString()
            );
          }
        );

      } else {
        createBiologicalStreamSequenceIndex();
      }


      /*
       * EF1-E schema 4 adds the durable producer proposal
       * commitment and makes producer_event_id unique within
       * one organism/core identity.
       *
       * Existing accepted envelopes are backfilled from their
       * canonical stored Envelope v2. Historical duplicate
       * producer identities are not guessed away: migration
       * fails closed because exactly-once identity would
       * otherwise be ambiguous.
       */
      const biologicalEnvelopeColumns =
        new Set(
          this.db.prepare(
            'PRAGMA table_info(biological_envelopes_v2)'
          ).all().map(
            row => row.name
          )
        );

      if (
        !biologicalEnvelopeColumns.has(
          'proposal_sha256'
        )
      ) {
        this.db.exec(
          'ALTER TABLE biological_envelopes_v2 ADD COLUMN proposal_sha256 TEXT'
        );
      }

      const createBiologicalProducerEventIndex =
        () => {
          this.db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS biological_v2_producer_event_identity
            ON biological_envelopes_v2(
              organism_id,
              producer_core_id,
              producer_event_id
            )
          `);
        };

      if (
        biologicalEnvelopeSchemaVersion <
        4
      ) {
        this.withTransaction(
          () => {
            const rows =
              this.db.prepare(`
                SELECT *
                FROM biological_envelopes_v2
                ORDER BY sequence ASC
              `).all();

            const identities =
              new Set();

            const updateProposal =
              this.db.prepare(`
                UPDATE biological_envelopes_v2
                SET proposal_sha256=?
                WHERE sequence=?
              `);

            for (
              const row of rows
            ) {
              const identity =
                stableStringify([
                  row.organism_id,
                  row.producer_core_id,
                  row.producer_event_id
                ]);

              if (
                identities.has(
                  identity
                )
              ) {
                throw Object.assign(
                  new Error(
                    'biological producer-event migration found duplicate historical identity'
                  ),
                  {
                    code:
                      'STATE_BIOLOGICAL_PRODUCER_EVENT_MIGRATION'
                  }
                );
              }

              identities.add(
                identity
              );

              let envelope;

              try {
                envelope =
                  normalizeAcceptedEnvelope(
                    JSON.parse(
                      row.envelope_json
                    )
                  );
              } catch (error) {
                throw Object.assign(
                  new Error(
                    'biological producer-event migration found corrupt Envelope v2 history'
                  ),
                  {
                    code:
                      'STATE_BIOLOGICAL_PRODUCER_EVENT_MIGRATION',

                    cause:
                      error
                  }
                );
              }

              updateProposal.run(
                biologicalProducerProposalHash(
                  envelope
                ),
                row.sequence
              );
            }

            createBiologicalProducerEventIndex();

            this.db.prepare(`
              INSERT INTO schema_versions(
                name,
                version,
                updated_at
              )
              VALUES(
                'biological-envelope',
                4,
                ?
              )
              ON CONFLICT(name)
              DO UPDATE SET
                version=excluded.version,
                updated_at=excluded.updated_at
            `).run(
              new Date().toISOString()
            );
          }
        );

      } else {
        const missingProposal =
          this.db.prepare(`
            SELECT sequence
            FROM biological_envelopes_v2
            WHERE proposal_sha256 IS NULL
            LIMIT 1
          `).get();

        if (
          missingProposal
        ) {
          throw Object.assign(
            new Error(
              'biological envelope schema 4 contains an uncommitted producer proposal'
            ),
            {
              code:
                'STATE_BIOLOGICAL_PRODUCER_EVENT_MIGRATION'
            }
          );
        }

        createBiologicalProducerEventIndex();
      }

    const biologicalStreamProgressSchemaRow =
      this.db.prepare(
        "SELECT version FROM schema_versions WHERE name='biological-stream-progress'"
      ).get();

    const biologicalStreamProgressSchemaVersion =
      Number(
        biologicalStreamProgressSchemaRow?.version ||
        0
      );

    if (
      biologicalStreamProgressSchemaVersion >
      1
    ) {
      throw Object.assign(
        new Error(
          'biological stream-progress schema is newer than this runtime supports'
        ),
        {
          code:
            'STATE_BIOLOGICAL_STREAM_PROGRESS_SCHEMA_UNSUPPORTED'
        }
      );
    }

    this.db.prepare(`
      INSERT INTO schema_versions(
        name,
        version,
        updated_at
      )
      VALUES(
        'biological-stream-progress',
        1,
        ?
      )
      ON CONFLICT(name)
      DO UPDATE SET
        version=excluded.version,
        updated_at=excluded.updated_at
    `).run(
      new Date().toISOString()
    );

    const biologicalOutboxSchemaRow =
      this.db.prepare(
        "SELECT version FROM schema_versions WHERE name='biological-outbox'"
      ).get();

    const biologicalOutboxSchemaVersion =
      Number(
        biologicalOutboxSchemaRow?.version ||
        0
      );

    if (
      biologicalOutboxSchemaVersion >
      2
    ) {
      throw Object.assign(
        new Error(
          'biological outbox schema is newer than this runtime supports'
        ),
        {
          code:
            'STATE_BIOLOGICAL_OUTBOX_SCHEMA_UNSUPPORTED'
        }
      );
    }

    if (
      biologicalOutboxSchemaVersion <
      2
    ) {
      this.withTransaction(
        () => {
          const rows =
            this.db.prepare(`
              SELECT *
              FROM biological_outbox_intents
              ORDER BY
                producer_core_id ASC,
                authority_epoch ASC,
                producer_stream_id ASC,
                stream_sequence ASC
            `).all();

          const heads =
            new Map();

          for (
            const row of rows
          ) {
            const key =
              stableStringify([
                row.producer_core_id,
                Number(
                  row.authority_epoch
                ),
                row.producer_stream_id
              ]);

            const previous =
              heads.get(
                key
              );

            if (
              previous &&
              (
                previous.producerInstanceId !==
                  row.producer_instance_id ||
                previous.producerVersion !==
                  row.producer_version
              )
            ) {
              throw Object.assign(
                new Error(
                  'biological outbox migration found producer identity drift inside one authority epoch'
                ),
                {
                  code:
                    'STATE_BIOLOGICAL_OUTBOX_MIGRATION'
                }
              );
            }

            if (
              previous &&
              Number(
                row.stream_sequence
              ) <=
                previous.lastStreamSequence
            ) {
              throw Object.assign(
                new Error(
                  'biological outbox migration found non-monotonic producer stream'
                ),
                {
                  code:
                    'STATE_BIOLOGICAL_OUTBOX_MIGRATION'
                }
              );
            }

            heads.set(
              key,
              {
                producerCoreId:
                  row.producer_core_id,

                authorityEpoch:
                  Number(
                    row.authority_epoch
                  ),

                producerStreamId:
                  row.producer_stream_id,

                producerInstanceId:
                  row.producer_instance_id,

                producerVersion:
                  row.producer_version,

                lastStreamSequence:
                  Number(
                    row.stream_sequence
                  ),

                lastProducerEventId:
                  row.producer_event_id
              }
            );
          }

          this.db.prepare(
            'DELETE FROM biological_outbox_stream_heads'
          ).run();

          const insert =
            this.db.prepare(`
              INSERT INTO biological_outbox_stream_heads(
                producer_core_id,
                authority_epoch,
                producer_stream_id,
                producer_instance_id,
                producer_version,
                last_stream_sequence,
                last_producer_event_id,
                head_sha256,
                updated_at
              )
              VALUES(
                ?, ?, ?, ?, ?, ?, ?, ?, ?
              )
            `);

          const updatedAt =
            new Date().toISOString();

          for (
            const head of
            heads.values()
          ) {
            insert.run(
              head.producerCoreId,
              head.authorityEpoch,
              head.producerStreamId,
              head.producerInstanceId,
              head.producerVersion,
              head.lastStreamSequence,
              head.lastProducerEventId,
              sha256(
                stableStringify(
                  biologicalOutboxStreamHeadBody(
                    head
                  )
                )
              ),
              updatedAt
            );
          }

          this.db.prepare(`
            INSERT INTO schema_versions(
              name,
              version,
              updated_at
            )
            VALUES(
              'biological-outbox',
              2,
              ?
            )
            ON CONFLICT(name)
            DO UPDATE SET
              version=excluded.version,
              updated_at=excluded.updated_at
          `).run(
            new Date().toISOString()
          );
        }
      );

    } else {
      const row =
        this.db.prepare(`
          SELECT COUNT(*) AS value
          FROM biological_outbox_intents
        `).get();

      const headCoverage =
        this.db.prepare(`
          SELECT COUNT(*) AS value
          FROM (
            SELECT
              producer_core_id,
              authority_epoch,
              producer_stream_id
            FROM biological_outbox_intents
            GROUP BY
              producer_core_id,
              authority_epoch,
              producer_stream_id
          )
        `).get();

      const headCount =
        this.db.prepare(`
          SELECT COUNT(*) AS value
          FROM biological_outbox_stream_heads
        `).get();

      if (
        Number(row?.value || 0) >
          0 &&
        Number(headCoverage?.value || 0) !==
          Number(headCount?.value || 0)
      ) {
        throw Object.assign(
          new Error(
            'biological outbox schema 2 has incomplete durable stream heads'
          ),
          {
            code:
              'STATE_BIOLOGICAL_OUTBOX_MIGRATION'
          }
        );
      }
    }

    const biologicalCutoverSchemaVersion =
      Number(
        this.db.prepare(
          "SELECT version FROM schema_versions WHERE name='biological-cutover'"
        ).get()?.version || 0
      );

    if (
      biologicalCutoverSchemaVersion >
      1
    ) {
      throw Object.assign(
        new Error(
          'biological cutover schema is newer than this runtime supports'
        ),
        {
          code:
            'STATE_BIOLOGICAL_CUTOVER_SCHEMA_UNSUPPORTED'
        }
      );
    }

    this.db.prepare(`
      INSERT INTO schema_versions(
        name,
        version,
        updated_at
      )
      VALUES(
        'biological-cutover',
        1,
        ?
      )
      ON CONFLICT(name)
      DO UPDATE SET
        version=excluded.version,
        updated_at=excluded.updated_at
    `).run(
      new Date().toISOString()
    );

    const biologicalRouteSchemaVersion =
      Number(
        this.db.prepare(
          "SELECT version FROM schema_versions WHERE name='biological-routes'"
        ).get()?.version || 0
      );

    if (
      biologicalRouteSchemaVersion >
      1
    ) {
      throw Object.assign(
        new Error(
          'biological route schema is newer than this runtime supports'
        ),
        {
          code:
            'STATE_BIOLOGICAL_ROUTE_SCHEMA_UNSUPPORTED'
        }
      );
    }

    this.db.prepare(`
      INSERT INTO schema_versions(
        name,
        version,
        updated_at
      )
      VALUES(
        'biological-routes',
        1,
        ?
      )
      ON CONFLICT(name)
      DO UPDATE SET
        version=excluded.version,
        updated_at=excluded.updated_at
    `).run(
      new Date().toISOString()
    );

        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw error;
      }

    await this.importLegacyMetadata();
    await this.reconcileMetadataMirrors();
    await this.assertCanonicalLifeMirror('identity');
    await this.reconcileIncompleteUpgrades();
    this.markWriteSuccess();
    return this;
    } catch (error) {
      try {
        if (this.db?.isTransaction) this.db.exec('ROLLBACK');
      } catch {}

      try { this.db?.close(); } catch {}
      this.db = null;
      throw error;
    }
  }

  assertSupportedSchemaVersions() {
    this.assertOpen();

    const schemaTable = this.db.prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type='table' AND name='schema_versions'
    `).get();

    if (!schemaTable) return;

    const supported = new Map([
      ['continuity', [4, 'STATE_SCHEMA_UNSUPPORTED']],
      ['biological-envelope', [4, 'STATE_BIOLOGICAL_SCHEMA_UNSUPPORTED']],
      ['biological-stream-progress', [1, 'STATE_BIOLOGICAL_STREAM_PROGRESS_SCHEMA_UNSUPPORTED']],
      ['biological-outbox', [2, 'STATE_BIOLOGICAL_OUTBOX_SCHEMA_UNSUPPORTED']],
      ['biological-cutover', [1, 'STATE_BIOLOGICAL_CUTOVER_SCHEMA_UNSUPPORTED']],
      ['biological-routes', [1, 'STATE_BIOLOGICAL_ROUTE_SCHEMA_UNSUPPORTED']]
    ]);

    const rows = this.db.prepare(`
      SELECT name, version
      FROM schema_versions
      WHERE name IN (
        'continuity',
        'biological-envelope',
        'biological-stream-progress',
        'biological-outbox',
        'biological-cutover',
        'biological-routes'
      )
    `).all();

    for (const row of rows) {
      const [maximum, code] = supported.get(row.name);
      const version = Number(row.version);

      if (!Number.isSafeInteger(version) || version < 0 || version > maximum) {
        throw Object.assign(
          new Error(`${row.name} schema is newer than this runtime supports`),
          { code }
        );
      }
    }
  }

  assertOpen() { if (!this.db) throw new Error('StateStore is not initialized'); }

  withTransaction(fn) {
    this.assertOpen();

    /*
     * Schema bootstrap owns one outer transaction.  Migration helpers use
     * this same method, so joining that transaction is required to keep the
     * entire bootstrap crash-atomic rather than committing each sub-step.
     */
    if (this.db.isTransaction) return fn();

    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }

  lifePath(name) { return path.join(this.rootDir, 'life', name + '.json'); }
  corePath(coreId, channel = 'active') { return path.join(this.rootDir, 'cores', coreId, channel + '.json'); }

  markWriteSuccess() { this.lastSuccessfulWriteAt = new Date().toISOString(); this.lastWriteError = null; }
  markWriteFailure(error) {
    this.writeFailureCount += 1;
    this.lastWriteError = {
      at: new Date().toISOString(),
      code: error.code || null,
      message: error.message
    };
  }

  async runMaintenance(operation, task) {
    try {
      const value = await task();
      this.maintenanceErrors.delete(operation);
      return { ok: true, value };
    } catch (error) {
      const detail = {
        operation,
        at: new Date().toISOString(),
        code: error.code || null,
        message: error.message
      };
      this.maintenanceErrors.set(operation, detail);
      try {
        this.recordRecovery('maintenance.failed', null, detail);
      } catch {}
      return { ok: false, error: detail };
    }
  }

  async checkedAtomicWrite(filePath, data, mode = 0o600) {
    try { await atomicWrite(filePath, data, mode); this.markWriteSuccess(); }
    catch (error) { this.markWriteFailure(error); throw error; }
  }

  metadataGet(key, fallback = null) {
    this.assertOpen();
    const row = this.db.prepare('SELECT json, sha256 FROM metadata WHERE key = ?').get(key);
    if (!row) return fallback;
    if (sha256(row.json) !== row.sha256) throw Object.assign(new Error('continuity metadata hash mismatch: ' + key), { code: 'STATE_INTEGRITY' });
    return JSON.parse(row.json);
  }

  metadataSet(key, value) {
    const json = JSON.stringify(value);
    const at = new Date().toISOString();
    this.db.prepare(`INSERT INTO metadata(key, json, sha256, updated_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET json=excluded.json, sha256=excluded.sha256, updated_at=excluded.updated_at`)
      .run(key, json, sha256(json), at);
    this.markWriteSuccess();
  }

  async importLegacyMetadata() {
    for (const name of ['identity', 'runtime-revision', 'runtime-heartbeat']) {
      if (this.metadataGet('life:' + name, null) != null) continue;
      try {
        const value = JSON.parse(await fs.readFile(this.lifePath(name), 'utf8'));
        this.withTransaction(() => this.metadataSet('life:' + name, value));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  async readJson(filePath, fallback = null) {
    try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }

  async readLife(name, fallback = null) { return this.metadataGet('life:' + name, fallback); }

  async writeLife(name, value) {
    const json = JSON.stringify(value, null, 2) + '\n';
    const key = 'life:' + name;
    const relativePath = path.relative(this.rootDir, this.lifePath(name));
    try {
      this.withTransaction(() => {
        this.metadataSet(key, value);
        this.db.prepare(`INSERT INTO pending_metadata_mirrors(key, relative_path, json, sha256, created_at)
          VALUES(?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET
          relative_path=excluded.relative_path, json=excluded.json, sha256=excluded.sha256, created_at=excluded.created_at`)
          .run(key, relativePath, json, sha256(json), new Date().toISOString());
      });
      await this.checkedAtomicWrite(this.lifePath(name), json);
      this.withTransaction(() => this.db.prepare('DELETE FROM pending_metadata_mirrors WHERE key=? AND sha256=?').run(key, sha256(json)));
    } catch (error) { this.markWriteFailure(error); throw error; }
  }

  reserveEventSequence(minimum = 0) {
    return this.withTransaction(() => {
      const stored = this.metadataGet('life:event-sequence', { sequence: 0 });
      const sequence = Math.max(Number(stored?.sequence) || 0, Number(minimum) || 0) + 1;
      if (!Number.isSafeInteger(sequence)) throw Object.assign(new Error('event sequence exhausted'), { code: 'EVENT_SEQUENCE_EXHAUSTED' });
      this.metadataSet('life:event-sequence', { sequence, at: new Date().toISOString(), durability: 'reserved-before-delivery' });
      return sequence;
    });
  }

  appendBiologicalEvent({ topic, payload, meta = {}, eventClass, at, deadlineAt = null, minimum = 0 }) {
    this.assertOpen();
    if (!['critical', 'durable'].includes(eventClass)) throw Object.assign(new Error('biological ledger accepts only critical or durable events'), { code: 'BIOLOGICAL_EVENT_CLASS' });
    if (typeof topic !== 'string' || !topic || topic.length > 200) throw Object.assign(new Error('invalid biological event topic'), { code: 'BIOLOGICAL_EVENT_TOPIC' });
    if (!Number.isSafeInteger(at) || at < 0) throw Object.assign(new Error('invalid biological event time'), { code: 'BIOLOGICAL_EVENT_TIME' });
    const normalizedDeadline = deadlineAt == null ? null : Number(deadlineAt);
    if (normalizedDeadline != null && (!Number.isSafeInteger(normalizedDeadline) || normalizedDeadline < at)) {
      throw Object.assign(new Error('invalid biological event deadline'), { code: 'BIOLOGICAL_EVENT_DEADLINE' });
    }
    const deduplicationKey = meta.deduplicationKey == null ? null : String(meta.deduplicationKey);
    if (deduplicationKey && deduplicationKey.length > 256) throw Object.assign(new Error('event deduplication key is too long'), { code: 'EVENT_DEDUP_KEY' });
    const payloadJson = stableStringify(payload);
    const payloadHash = sha256(payloadJson);
    const provenance = {
      sourceCore: meta.sourceCore ?? null,
      sourceVersion: meta.sourceVersion ?? null,
      sourceInstanceId: meta.sourceInstanceId ?? null,
      authorityEpoch: meta.authorityEpoch ?? null,
      causeSequence: meta.causeSequence ?? null,
      causalParent: meta.causalParent ?? null,
      evidenceHash: meta.evidenceHash ?? null
    };
    const provenanceHash = sha256(stableStringify(provenance));
    const deduplicationHash = sha256(stableStringify({
      topic, class: eventClass, payload, deadlineAt: normalizedDeadline, provenance,
      outputIndex: meta.outputIndex ?? null
    }));
    return this.withTransaction(() => {
      if (deduplicationKey) {
        const existing = this.db.prepare('SELECT * FROM biological_events WHERE deduplication_key=?').get(deduplicationKey);
        if (existing) {
          if (existing.deduplication_sha256 !== deduplicationHash) {
            throw Object.assign(new Error('event deduplication key was reused with different content'), { code: 'EVENT_DEDUP_CONFLICT' });
          }
          return { event: this.biologicalEventFromRow(existing, true), deduplicated: true };
        }
      }
      const stored = this.metadataGet('life:event-sequence', { sequence: 0 });
      const sequence = Math.max(Number(stored?.sequence) || 0, Number(minimum) || 0) + 1;
      if (!Number.isSafeInteger(sequence)) throw Object.assign(new Error('event sequence exhausted'), { code: 'EVENT_SEQUENCE_EXHAUSTED' });
      const eventId = `evt-${sequence.toString(36)}-${deduplicationHash.slice(0, 16)}`;
      const eventMeta = { ...meta, eventClass, payloadHash: `sha256:${payloadHash}`, provenanceHash: `sha256:${provenanceHash}` };
      const envelope = { id: eventId, sequence, topic, class: eventClass, payload, at, deadlineAt: normalizedDeadline, meta: eventMeta };
      const envelopeJson = stableStringify(envelope);
      const envelopeHash = sha256(envelopeJson);
      const createdAt = new Date().toISOString();
      this.db.prepare(`INSERT INTO biological_events(sequence, event_id, topic, event_class, at_ms, deadline_at_ms,
        envelope_json, envelope_sha256, payload_sha256, provenance_sha256, deduplication_key, deduplication_sha256, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        sequence, eventId, topic, eventClass, at, normalizedDeadline, envelopeJson, envelopeHash,
        payloadHash, provenanceHash, deduplicationKey, deduplicationHash, createdAt
      );
      this.db.prepare(`INSERT INTO biological_deliveries(sequence, consumer_id)
        SELECT ?, consumer_id FROM biological_consumers WHERE active=1`).run(sequence);
      this.metadataSet('life:event-sequence', { sequence, at: createdAt, durability: 'envelope-appended-before-delivery' });
      return { event: this.biologicalEventFromRow(this.db.prepare('SELECT * FROM biological_events WHERE sequence=?').get(sequence), false), deduplicated: false };
    });
  }

  appendAcceptedBiologicalEnvelope({
    prepared,
    finalizePrepared,
    minimum = 0,
    authorityWitness = null
  }) {
    this.assertOpen();

    if (
      typeof finalizePrepared !==
      'function'
    ) {
      throw Object.assign(
        new Error(
          'finalizePrepared callback is required'
        ),
        {
          code:
            'BIOLOGICAL_ENVELOPE_V2_PERSISTENCE_CONFIG'
        }
      );
    }

    const normalizedMinimum =
      Number(minimum) || 0;

    if (
      !Number.isSafeInteger(
        normalizedMinimum
      ) ||
      normalizedMinimum < 0
    ) {
      throw Object.assign(
        new Error(
          'biological envelope minimum sequence is invalid'
        ),
        {
          code:
            'BIOLOGICAL_ENVELOPE_V2_SEQUENCE'
        }
      );
    }

    /*
     * Atomic B2B2 boundary:
     *
     *   determine sequence
     *   finalize Envelope v2
     *   persist canonical event
     *   persist exact Envelope v2
     *   create deliveries
     *   advance sequence high-water
     *
     * Any failure rolls back the entire SQLite transaction.
     */
    return this.withTransaction(
      () => {
        const preparedKernel =
          prepared?.kernel;

        const preparedIsAuthoritative =
          preparedKernel?.authority_mode ===
          'authoritative';

        if (
          preparedIsAuthoritative &&
          authorityWitness == null
        ) {
          throw Object.assign(
            new Error(
              'authoritative biological persistence requires a commit-time authority witness'
            ),
            {
              code:
                'BIOLOGICAL_AUTHORITY_WITNESS_REQUIRED'
            }
          );
        }

        if (
          !preparedIsAuthoritative &&
          authorityWitness != null
        ) {
          throw Object.assign(
            new Error(
              'non-authoritative biological persistence cannot claim an authority witness'
            ),
            {
              code:
                'BIOLOGICAL_AUTHORITY_WITNESS'
            }
          );
        }

        let boundAuthority =
          null;

        if (
          authorityWitness != null
        ) {
          const witness = {
            coreId:
              authorityWitness.coreId ??
              authorityWitness.core_id,

            instanceId:
              authorityWitness.instanceId ??
              authorityWitness.instance_id,

            version:
              authorityWitness.version,

            authorityEpoch:
              Number(
                authorityWitness.authorityEpoch ??
                authorityWitness.authority_epoch
              )
          };

          if (
            typeof witness.coreId !==
              'string' ||
            !witness.coreId ||
            typeof witness.instanceId !==
              'string' ||
            !witness.instanceId ||
            typeof witness.version !==
              'string' ||
            !witness.version ||
            !Number.isSafeInteger(
              witness.authorityEpoch
            ) ||
            witness.authorityEpoch < 1
          ) {
            throw Object.assign(
              new Error(
                'biological authority witness is invalid'
              ),
              {
                code:
                  'BIOLOGICAL_AUTHORITY_WITNESS'
              }
            );
          }

          if (
            !preparedKernel ||
            preparedKernel.authority_mode !==
              'authoritative' ||
            preparedKernel.producer_core_id !==
              witness.coreId ||
            preparedKernel.producer_instance_id !==
              witness.instanceId ||
            preparedKernel.producer_version !==
              witness.version ||
            Number(
              preparedKernel.authority_epoch
            ) !==
              witness.authorityEpoch
          ) {
            throw Object.assign(
              new Error(
                'authority witness does not match prepared biological acceptance'
              ),
              {
                code:
                  'BIOLOGICAL_AUTHORITY_WITNESS'
              }
            );
          }

          const currentAuthority =
            this.getAuthority(
              witness.coreId
            );

          if (
            !currentAuthority ||
            currentAuthority.instanceId !==
              witness.instanceId ||
            currentAuthority.version !==
              witness.version ||
            Number(
              currentAuthority.epoch
            ) !==
              witness.authorityEpoch
          ) {
            throw Object.assign(
              new Error(
                'authoritative biological producer became stale before durable commit'
              ),
              {
                code:
                  'BIOLOGICAL_AUTHORITY_STALE'
              }
            );
          }

          boundAuthority =
            currentAuthority;
        }


        /*
         * EF1-E producer-event idempotency.
         *
         * The exact producer-owned proposal is committed
         * independently from Kernel acceptance time and Fabric
         * sequence. A retry therefore returns the already
         * accepted biological fact without allocating a second
         * sequence. Reusing the identity for any other semantic
         * fact fails closed.
         */
        const preparedIdentity = {
          organismId:
            preparedKernel?.organism_id,

          producerCoreId:
            preparedKernel?.producer_core_id,

          producerEventId:
            prepared?.proposal?.producer_event_id
        };

        if (
          typeof preparedIdentity.organismId ===
            'string' &&
          preparedIdentity.organismId &&
          typeof preparedIdentity.producerCoreId ===
            'string' &&
          preparedIdentity.producerCoreId &&
          typeof preparedIdentity.producerEventId ===
            'string' &&
          preparedIdentity.producerEventId
        ) {
          const existingProducerEvent =
            this.db.prepare(`
              SELECT *
              FROM biological_envelopes_v2
              WHERE
                organism_id=? AND
                producer_core_id=? AND
                producer_event_id=?
            `).get(
              preparedIdentity.organismId,
              preparedIdentity.producerCoreId,
              preparedIdentity.producerEventId
            );

          if (
            existingProducerEvent
          ) {
            const retryEnvelope =
              normalizeAcceptedEnvelope(
                finalizePrepared(
                  prepared,
                  Number(
                    existingProducerEvent.sequence
                  )
                )
              );

            const existingEnvelope =
              this.acceptedBiologicalEnvelopeFromRow(
                existingProducerEvent
              );

            const retryProposalHash =
              biologicalProducerProposalHash(
                retryEnvelope
              );

            const storedProposalHash =
              existingProducerEvent.proposal_sha256;

            const sameProposal =
              typeof storedProposalHash ===
                'string' &&
              storedProposalHash ===
                retryProposalHash;

            const sameSemantics =
              stableStringify(
                biologicalRetrySemanticProjection(
                  retryEnvelope
                )
              ) ===
              stableStringify(
                biologicalRetrySemanticProjection(
                  existingEnvelope
                )
              );

            if (
              !sameProposal ||
              !sameSemantics
            ) {
              throw Object.assign(
                new Error(
                  'producer event identity was reused for a different biological fact'
                ),
                {
                  code:
                    'BIOLOGICAL_PRODUCER_EVENT_CONFLICT'
                }
              );
            }

            const eventRow =
              this.db.prepare(`
                SELECT *
                FROM biological_events
                WHERE sequence=?
              `).get(
                existingProducerEvent.sequence
              );

            if (
              !eventRow
            ) {
              throw Object.assign(
                new Error(
                  'idempotent producer event lost its durable Fabric event'
                ),
                {
                  code:
                    'BIOLOGICAL_PRODUCER_EVENT_CORRUPT'
                }
              );
            }

            return {
              envelope:
                existingEnvelope,

              event:
                this.biologicalEventFromRow(
                  eventRow,
                  true
                ),

              deduplicated:
                true
            };
          }
        }

        const stored =
          this.metadataGet(
            'life:event-sequence',
            {
              sequence:
                0
            }
          );

        const ledgerHighWater =
          Number(
            this.db.prepare(`
              SELECT COALESCE(
                MAX(sequence),
                0
              ) AS value
              FROM biological_events
            `).get()?.value ||
            0
          );

        const sequence =
          Math.max(
            Number(
              stored?.sequence
            ) || 0,
            normalizedMinimum,
            ledgerHighWater,
            Number(
              boundAuthority?.barrierSequence
            ) || 0
          ) + 1;

        if (
          !Number.isSafeInteger(
            sequence
          )
        ) {
          throw Object.assign(
            new Error(
              'event sequence exhausted'
            ),
            {
              code:
                'EVENT_SEQUENCE_EXHAUSTED'
            }
          );
        }

        /*
         * StateStore owns the sequence. The acceptance
         * boundary may only finalize against this exact value.
         */
        const finalized =
          finalizePrepared(
            prepared,
            sequence
          );

        const envelope =
          normalizeAcceptedEnvelope(
            finalized
          );

        if (
          boundAuthority
        ) {
          if (
            envelope.authority_mode !==
              'authoritative' ||
            envelope.producer_core_id !==
              boundAuthority.coreId ||
            envelope.producer_instance_id !==
              boundAuthority.instanceId ||
            envelope.producer_version !==
              boundAuthority.version ||
            Number(
              envelope.authority_epoch
            ) !==
              Number(
                boundAuthority.epoch
              )
          ) {
            throw Object.assign(
              new Error(
                'final authoritative biological envelope disagrees with commit-bound authority'
              ),
              {
                code:
                  'BIOLOGICAL_AUTHORITY_STALE'
              }
            );
          }
        }

        const streamHeadRow =
          this.db.prepare(`
            SELECT *
            FROM biological_stream_heads
            WHERE
              organism_id=? AND
              producer_stream_id=? AND
              authority_epoch=?
          `).get(
            envelope.organism_id,
            envelope.producer_stream_id,
            envelope.authority_epoch
          );

        const streamHead =
          streamHeadRow
            ? this.biologicalStreamHeadFromRow(
                streamHeadRow
              )
            : null;


        const finalizedProgress =
          this.getBiologicalStreamProgress({
            organismId:
              envelope.organism_id,

            producerStreamId:
              envelope.producer_stream_id,

            authorityEpoch:
              envelope.authority_epoch
          });

        if (
          finalizedProgress &&
          envelope.order_time_us <=
            finalizedProgress.finalizedThroughUs
        ) {
          throw Object.assign(
            new Error(
              'biological signal attempts to enter a finalized stream-time region'
            ),
            {
              code:
                'BIOLOGICAL_STREAM_FINALIZED_TIME'
            }
          );
        }

        if (
          streamHead &&
          streamHead.producerCoreId !==
            envelope.producer_core_id
        ) {
          throw Object.assign(
            new Error(
              'producer stream changed owning core inside one authority epoch'
            ),
            {
              code:
                'BIOLOGICAL_STREAM_IDENTITY'
            }
          );
        }

        if (
          streamHead &&
          envelope.stream_sequence <=
            streamHead.lastStreamSequence
        ) {
          throw Object.assign(
            new Error(
              'producer stream sequence did not advance'
            ),
            {
              code:
                'BIOLOGICAL_STREAM_SEQUENCE'
            }
          );
        }

        if (
          streamHead &&
          sequence <=
            streamHead.lastFabricSequence
        ) {
          throw Object.assign(
            new Error(
              'producer stream Fabric position did not advance'
            ),
            {
              code:
                'BIOLOGICAL_STREAM_SEQUENCE'
            }
          );
        }

        if (
          envelope.fabric_sequence !==
          sequence
        ) {
          throw Object.assign(
            new Error(
              'final Envelope v2 does not carry the StateStore-assigned sequence'
            ),
            {
              code:
                'BIOLOGICAL_ENVELOPE_V2_SEQUENCE'
            }
          );
        }

        let eventClass;

        if (
          envelope.durability_class ===
          DURABILITY_CLASS.CHECKPOINT_CRITICAL
        ) {
          eventClass =
            'critical';

        } else if (
          envelope.durability_class ===
            DURABILITY_CLASS.EPHEMERAL_REPLAYABLE ||
          envelope.durability_class ===
            DURABILITY_CLASS.DURABLE_TRANSITION
        ) {
          eventClass =
            'durable';

        } else {
          throw Object.assign(
            new Error(
              'Envelope v2 durability cannot enter the biological ledger'
            ),
            {
              code:
                'BIOLOGICAL_ENVELOPE_V2_DURABILITY'
            }
          );
        }

        const envelopeJson =
          stableStringify(
            envelope
          );

        const envelopeHash =
          sha256(
            envelopeJson
          );

        const payloadJson =
          stableStringify(
            envelope.payload
          );

        const payloadHash =
          sha256(
            payloadJson
          );

        if (
          envelope.payload_hash !==
          `sha256:${payloadHash}`
        ) {
          throw Object.assign(
            new Error(
              'Envelope v2 payload commitment disagrees with persisted payload'
            ),
            {
              code:
                'BIOLOGICAL_ENVELOPE_V2_CORRUPT'
            }
          );
        }

        const provenance = {
          protocol:
            envelope.protocol,

          signalId:
            envelope.signal_id,

          organismId:
            envelope.organism_id,

          sourceCore:
            envelope.producer_core_id,

          sourceVersion:
            envelope.producer_version,

          sourceInstanceId:
            envelope.producer_instance_id,

          producerEventId:
            envelope.producer_event_id,

          producerStreamId:
            envelope.producer_stream_id,

          streamSequence:
            envelope.stream_sequence,

          authorityEpoch:
            envelope.authority_epoch,

          authorityMode:
            envelope.authority_mode,

          acceptedTimeUs:
            envelope.accepted_time_us,

          orderTimeUs:
            envelope.order_time_us
        };

        const provenanceHash =
          sha256(
            stableStringify(
              provenance
            )
          );

        const deduplicationKey =
          envelope.signal_id;

        const deduplicationHash =
          sha256(
            stableStringify({
              protocol:
                'stay-biological-envelope-v2-ledger-v1',

              signalId:
                envelope.signal_id,

              envelopeHash:
                `sha256:${envelopeHash}`
            })
          );

        const eventId =
          `evt-${sequence.toString(36)}-${envelopeHash.slice(0, 16)}`;

        /*
         * Existing EventFabric uses millisecond-shaped event
         * time. This is compatibility metadata only.
         *
         * Exact biological microsecond time remains solely
         * authoritative inside Envelope v2.
         */
        const compatibilityAtMs =
          Math.floor(
            envelope.order_time_us /
            1000
          );

        const eventMeta = {
          biologicalEnvelopeV2:
            true,

          biologicalEnvelopeProtocol:
            envelope.protocol,

          biologicalSignalId:
            envelope.signal_id,

          sourceCore:
            envelope.producer_core_id,

          sourceVersion:
            envelope.producer_version,

          sourceInstanceId:
            envelope.producer_instance_id,

          authorityEpoch:
            envelope.authority_epoch,

          authorityMode:
            envelope.authority_mode,

          producerStreamId:
            envelope.producer_stream_id,

          streamSequence:
            envelope.stream_sequence,

          producerEventId:
            envelope.producer_event_id,

          eventClass,

          payloadHash:
            `sha256:${payloadHash}`,

          provenanceHash:
            `sha256:${provenanceHash}`
        };

        const compatibilityEnvelope = {
          id:
            eventId,

          sequence,

          topic:
            envelope.topic,

          class:
            eventClass,

          payload:
            envelope.payload,

          at:
            compatibilityAtMs,

          deadlineAt:
            null,

          meta:
            eventMeta
        };

        const compatibilityJson =
          stableStringify(
            compatibilityEnvelope
          );

        const compatibilityHash =
          sha256(
            compatibilityJson
          );

        const createdAt =
          new Date().toISOString();

        this.db.prepare(`
          INSERT INTO biological_events(
            sequence,
            event_id,
            topic,
            event_class,
            at_ms,
            deadline_at_ms,
            envelope_json,
            envelope_sha256,
            payload_sha256,
            provenance_sha256,
            deduplication_key,
            deduplication_sha256,
            created_at
          )
          VALUES(
            ?,
            ?,
            ?,
            ?,
            ?,
            NULL,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?
          )
        `).run(
          sequence,
          eventId,
          envelope.topic,
          eventClass,
          compatibilityAtMs,
          compatibilityJson,
          compatibilityHash,
          payloadHash,
          provenanceHash,
          deduplicationKey,
          deduplicationHash,
          createdAt
        );

        this.db.prepare(`
          INSERT INTO biological_envelopes_v2(
            sequence,
            signal_id,
            organism_id,
            producer_core_id,
            producer_instance_id,
            producer_version,
            producer_event_id,
            producer_stream_id,
            stream_sequence,
            authority_epoch,
            authority_mode,
            accepted_time_us,
            order_time_us,
            proposal_sha256,
            envelope_json,
            envelope_sha256,
            payload_sha256,
            created_at
          )
          VALUES(
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?
          )
        `).run(
          sequence,
          envelope.signal_id,
          envelope.organism_id,
          envelope.producer_core_id,
          envelope.producer_instance_id,
          envelope.producer_version,
          envelope.producer_event_id,
          envelope.producer_stream_id,
          envelope.stream_sequence,
          envelope.authority_epoch,
          envelope.authority_mode,
          envelope.accepted_time_us,
          envelope.order_time_us,
          biologicalProducerProposalHash(
            envelope
          ),
          envelopeJson,
          envelopeHash,
          payloadHash,
          createdAt
        );

        const nextStreamHead = {
          organismId:
            envelope.organism_id,

          producerStreamId:
            envelope.producer_stream_id,

          authorityEpoch:
            envelope.authority_epoch,

          producerCoreId:
            envelope.producer_core_id,

          lastProducerInstanceId:
            envelope.producer_instance_id,

          lastProducerVersion:
            envelope.producer_version,

          lastAuthorityMode:
            envelope.authority_mode,

          lastStreamSequence:
            envelope.stream_sequence,

          lastFabricSequence:
            sequence,

          lastSignalId:
            envelope.signal_id
        };

        const nextStreamHeadHash =
          sha256(
            stableStringify(
              nextStreamHead
            )
          );

        if (
          streamHead
        ) {
          const updated =
            this.db.prepare(`
              UPDATE biological_stream_heads
              SET
                producer_core_id=?,
                last_producer_instance_id=?,
                last_producer_version=?,
                last_authority_mode=?,
                last_stream_sequence=?,
                last_fabric_sequence=?,
                last_signal_id=?,
                head_sha256=?,
                updated_at=?
              WHERE
                organism_id=? AND
                producer_stream_id=? AND
                authority_epoch=? AND
                last_stream_sequence=? AND
                last_fabric_sequence=?
            `).run(
              nextStreamHead.producerCoreId,
              nextStreamHead.lastProducerInstanceId,
              nextStreamHead.lastProducerVersion,
              nextStreamHead.lastAuthorityMode,
              nextStreamHead.lastStreamSequence,
              nextStreamHead.lastFabricSequence,
              nextStreamHead.lastSignalId,
              nextStreamHeadHash,
              createdAt,
              nextStreamHead.organismId,
              nextStreamHead.producerStreamId,
              nextStreamHead.authorityEpoch,
              streamHead.lastStreamSequence,
              streamHead.lastFabricSequence
            );

          if (
            updated.changes !==
            1
          ) {
            throw Object.assign(
              new Error(
                'producer stream head compare-and-swap failed'
              ),
              {
                code:
                  'BIOLOGICAL_STREAM_CONFLICT'
              }
            );
          }

        } else {
          this.db.prepare(`
            INSERT INTO biological_stream_heads(
              organism_id,
              producer_stream_id,
              authority_epoch,
              producer_core_id,
              last_producer_instance_id,
              last_producer_version,
              last_authority_mode,
              last_stream_sequence,
              last_fabric_sequence,
              last_signal_id,
              head_sha256,
              updated_at
            )
            VALUES(
              ?,
              ?,
              ?,
              ?,
              ?,
              ?,
              ?,
              ?,
              ?,
              ?,
              ?,
              ?
            )
          `).run(
            nextStreamHead.organismId,
            nextStreamHead.producerStreamId,
            nextStreamHead.authorityEpoch,
            nextStreamHead.producerCoreId,
            nextStreamHead.lastProducerInstanceId,
            nextStreamHead.lastProducerVersion,
            nextStreamHead.lastAuthorityMode,
            nextStreamHead.lastStreamSequence,
            nextStreamHead.lastFabricSequence,
            nextStreamHead.lastSignalId,
            nextStreamHeadHash,
            createdAt
          );
        }

        this.db.prepare(`
          INSERT INTO biological_deliveries(
            sequence,
            consumer_id
          )
          SELECT
            ?,
            consumer_id
          FROM biological_consumers
          WHERE active=1
        `).run(
          sequence
        );

        this.metadataSet(
          'life:event-sequence',
          {
            sequence,

            at:
              createdAt,

            durability:
              'envelope-v2-appended-before-delivery'
          }
        );

        const acceptedRow =
          this.db.prepare(`
            SELECT *
            FROM biological_envelopes_v2
            WHERE sequence=?
          `).get(
            sequence
          );

        const eventRow =
          this.db.prepare(`
            SELECT *
            FROM biological_events
            WHERE sequence=?
          `).get(
            sequence
          );

        return {
          envelope:
            this.acceptedBiologicalEnvelopeFromRow(
              acceptedRow
            ),

          event:
            this.biologicalEventFromRow(
              eventRow,
              false
            ),

          deduplicated:
            false
        };
      }
    );
  }


  biologicalStreamHeadFromRow(
    row
  ) {
    if (!row) {
      return null;
    }

    const head = {
      organismId:
        row.organism_id,

      producerStreamId:
        row.producer_stream_id,

      authorityEpoch:
        Number(
          row.authority_epoch
        ),

      producerCoreId:
        row.producer_core_id,

      lastProducerInstanceId:
        row.last_producer_instance_id,

      lastProducerVersion:
        row.last_producer_version,

      lastAuthorityMode:
        row.last_authority_mode,

      lastStreamSequence:
        Number(
          row.last_stream_sequence
        ),

      lastFabricSequence:
        Number(
          row.last_fabric_sequence
        ),

      lastSignalId:
        row.last_signal_id
    };

    if (
      sha256(
        stableStringify(
          head
        )
      ) !==
      row.head_sha256
    ) {
      throw Object.assign(
        new Error(
          `biological stream head ${head.producerStreamId}/${head.authorityEpoch} is corrupt`
        ),
        {
          code:
            'BIOLOGICAL_STREAM_HEAD_CORRUPT'
        }
      );
    }

    return Object.freeze(
      head
    );
  }


  getBiologicalStreamHead({
    organismId,
    producerStreamId,
    authorityEpoch
  }) {
    this.assertOpen();

    if (
      typeof organismId !==
        'string' ||
      !organismId ||
      typeof producerStreamId !==
        'string' ||
      !producerStreamId
    ) {
      throw Object.assign(
        new Error(
          'biological stream identity is invalid'
        ),
        {
          code:
            'BIOLOGICAL_STREAM_ID'
        }
      );
    }

    const epoch =
      Number(
        authorityEpoch
      );

    if (
      !Number.isSafeInteger(
        epoch
      ) ||
      epoch < 1
    ) {
      throw Object.assign(
        new Error(
          'biological stream authority epoch is invalid'
        ),
        {
          code:
            'BIOLOGICAL_STREAM_ID'
        }
      );
    }

    const row =
      this.db.prepare(`
        SELECT *
        FROM biological_stream_heads
        WHERE
          organism_id=? AND
          producer_stream_id=? AND
          authority_epoch=?
      `).get(
        organismId,
        producerStreamId,
        epoch
      );

    return row
      ? this.biologicalStreamHeadFromRow(
          row
        )
      : null;
  }


  acceptedBiologicalEnvelopeFromRow(
    row
  ) {
    if (!row) {
      return null;
    }

    /*
     * Hash the exact stored bytes first.
     */
    if (
      sha256(
        row.envelope_json
      ) !==
      row.envelope_sha256
    ) {
      throw Object.assign(
        new Error(
          `accepted biological Envelope v2 ${row.sequence} is corrupt`
        ),
        {
          code:
            'BIOLOGICAL_ENVELOPE_V2_CORRUPT'
        }
      );
    }

    let parsed;

    try {
      parsed =
        JSON.parse(
          row.envelope_json
        );
    } catch (cause) {
      throw Object.assign(
        new Error(
          `accepted biological Envelope v2 ${row.sequence} is not valid JSON`
        ),
        {
          code:
            'BIOLOGICAL_ENVELOPE_V2_CORRUPT',

          cause
        }
      );
    }

    let envelope;

    try {
      envelope =
        normalizeAcceptedEnvelope(
          parsed
        );
    } catch (cause) {
      throw Object.assign(
        new Error(
          `accepted biological Envelope v2 ${row.sequence} failed contract validation`
        ),
        {
          code:
            'BIOLOGICAL_ENVELOPE_V2_CORRUPT',

          cause
        }
      );
    }

    const payloadHash =
      sha256(
        stableStringify(
          envelope.payload
        )
      );

    const mismatch =
      envelope.fabric_sequence !==
        Number(row.sequence) ||
      envelope.signal_id !==
        row.signal_id ||
      envelope.organism_id !==
        row.organism_id ||
      envelope.producer_core_id !==
        row.producer_core_id ||
      envelope.producer_instance_id !==
        row.producer_instance_id ||
      envelope.producer_version !==
        row.producer_version ||
      envelope.producer_event_id !==
        row.producer_event_id ||
      envelope.producer_stream_id !==
        row.producer_stream_id ||
      envelope.stream_sequence !==
        Number(row.stream_sequence) ||
      envelope.authority_epoch !==
        Number(row.authority_epoch) ||
      envelope.authority_mode !==
        row.authority_mode ||
      envelope.accepted_time_us !==
        Number(row.accepted_time_us) ||
      envelope.order_time_us !==
        Number(row.order_time_us) ||
      biologicalProducerProposalHash(
        envelope
      ) !==
        row.proposal_sha256 ||
      payloadHash !==
        row.payload_sha256 ||
      envelope.payload_hash !==
        `sha256:${row.payload_sha256}`;

    if (mismatch) {
      throw Object.assign(
        new Error(
          `accepted biological Envelope v2 ${row.sequence} metadata disagrees with its durable index`
        ),
        {
          code:
            'BIOLOGICAL_ENVELOPE_V2_CORRUPT'
        }
      );
    }

    return envelope;
  }


  getAcceptedBiologicalEnvelope(
    signalId
  ) {
    this.assertOpen();

    if (
      typeof signalId !== 'string' ||
      !signalId
    ) {
      throw Object.assign(
        new Error(
          'accepted biological signal id is invalid'
        ),
        {
          code:
            'BIOLOGICAL_ENVELOPE_V2_ID'
        }
      );
    }

    const row =
      this.db.prepare(`
        SELECT *
        FROM biological_envelopes_v2
        WHERE signal_id=?
      `).get(
        signalId
      );

    return row
      ? this.acceptedBiologicalEnvelopeFromRow(
          row
        )
      : null;
  }


  getAcceptedBiologicalEnvelopeBySequence(
    sequence
  ) {
    this.assertOpen();

    const normalized =
      Number(sequence);

    if (
      !Number.isSafeInteger(
        normalized
      ) ||
      normalized < 1
    ) {
      throw Object.assign(
        new Error(
          'accepted biological sequence is invalid'
        ),
        {
          code:
            'BIOLOGICAL_ENVELOPE_V2_SEQUENCE'
        }
      );
    }

    const row =
      this.db.prepare(`
        SELECT *
        FROM biological_envelopes_v2
        WHERE sequence=?
      `).get(
        normalized
      );

    return row
      ? this.acceptedBiologicalEnvelopeFromRow(
          row
        )
      : null;
  }



  getAcceptedBiologicalEnvelopeByProducerEvent({
    organismId,
    producerCoreId,
    producerEventId
  }) {
    this.assertOpen();

    for (
      const [
        value,
        label
      ] of [
        [
          organismId,
          'organism id'
        ],
        [
          producerCoreId,
          'producer core id'
        ],
        [
          producerEventId,
          'producer event id'
        ]
      ]
    ) {
      if (
        typeof value !==
          'string' ||
        !value
      ) {
        throw Object.assign(
          new Error(
            `accepted biological ${label} is invalid`
          ),
          {
            code:
              'BIOLOGICAL_PRODUCER_EVENT_ID'
          }
        );
      }
    }

    const row =
      this.db.prepare(`
        SELECT *
        FROM biological_envelopes_v2
        WHERE
          organism_id=? AND
          producer_core_id=? AND
          producer_event_id=?
      `).get(
        organismId,
        producerCoreId,
        producerEventId
      );

    return row
      ? this.acceptedBiologicalEnvelopeFromRow(
          row
        )
      : null;
  }


  listAcceptedBiologicalStreamRange({
    producerStreamId,
    authorityEpoch,
    firstSequence,
    lastSequence
  }) {
    this.assertOpen();

    if (
      typeof producerStreamId !==
        'string' ||
      !producerStreamId
    ) {
      throw Object.assign(
        new Error(
          'producer stream id is invalid'
        ),
        {
          code:
            'BIOLOGICAL_ENVELOPE_V2_RANGE'
        }
      );
    }

    const epoch =
      Number(
        authorityEpoch
      );

    const first =
      Number(
        firstSequence
      );

    const last =
      Number(
        lastSequence
      );

    if (
      !Number.isSafeInteger(
        epoch
      ) ||
      epoch < 1 ||
      !Number.isSafeInteger(
        first
      ) ||
      first < 1 ||
      !Number.isSafeInteger(
        last
      ) ||
      last < first
    ) {
      throw Object.assign(
        new Error(
          'accepted biological stream range is invalid'
        ),
        {
          code:
            'BIOLOGICAL_ENVELOPE_V2_RANGE'
        }
      );
    }

    return this.db.prepare(`
      SELECT *
      FROM biological_envelopes_v2
      WHERE
        producer_stream_id=? AND
        authority_epoch=? AND
        stream_sequence>=? AND
        stream_sequence<=?
      ORDER BY
        stream_sequence ASC,
        sequence ASC
    `).all(
      producerStreamId,
      epoch,
      first,
      last
    ).map(
      row =>
        this.acceptedBiologicalEnvelopeFromRow(
          row
        )
    );
  }



  biologicalStreamProgressFromRow(
    row
  ) {
    if (!row) {
      return null;
    }

    const progress = {
      progressId:
        row.progress_id,

      organismId:
        row.organism_id,

      producerStreamId:
        row.producer_stream_id,

      authorityEpoch:
        Number(
          row.authority_epoch
        ),

      producerCoreId:
        row.producer_core_id,

      producerInstanceId:
        row.producer_instance_id,

      producerVersion:
        row.producer_version,

      authorityMode:
        row.authority_mode,

      finalizedThroughUs:
        Number(
          row.finalized_through_us
        ),

      finalizedSignalCount:
        Number(
          row.finalized_signal_count
        ),

      finalizedLastStreamSequence:
        Number(
          row.finalized_last_stream_sequence
        ),

      acceptedTimeUs:
        Number(
          row.accepted_time_us
        ),

      previousProgressId:
        row.previous_progress_id ||
        null
    };

    const body = {
      protocol:
        'stay-biological-stream-progress-v1',

      organismId:
        progress.organismId,

      producerStreamId:
        progress.producerStreamId,

      authorityEpoch:
        progress.authorityEpoch,

      producerCoreId:
        progress.producerCoreId,

      producerInstanceId:
        progress.producerInstanceId,

      producerVersion:
        progress.producerVersion,

      authorityMode:
        progress.authorityMode,

      finalizedThroughUs:
        progress.finalizedThroughUs,

      finalizedSignalCount:
        progress.finalizedSignalCount,

      finalizedLastStreamSequence:
        progress.finalizedLastStreamSequence,

      acceptedTimeUs:
        progress.acceptedTimeUs,

      previousProgressId:
        progress.previousProgressId
    };

    const expectedProgressId =
      `sha256:${sha256(
        stableStringify(
          body
        )
      )}`;

    const expectedProgressHash =
      sha256(
        stableStringify({
          ...body,
          progressId:
            expectedProgressId
        })
      );

    if (
      progress.progressId !==
        expectedProgressId ||
      row.progress_sha256 !==
        expectedProgressHash
    ) {
      throw Object.assign(
        new Error(
          `biological stream progress ${progress.producerStreamId}/${progress.authorityEpoch} is corrupt`
        ),
        {
          code:
            'BIOLOGICAL_STREAM_PROGRESS_CORRUPT'
        }
      );
    }

    return Object.freeze(
      progress
    );
  }


  biologicalStreamProgressHeadFromRow(
    row
  ) {
    if (!row) {
      return null;
    }

    const head = {
      organismId:
        row.organism_id,

      producerStreamId:
        row.producer_stream_id,

      authorityEpoch:
        Number(
          row.authority_epoch
        ),

      producerCoreId:
        row.producer_core_id,

      producerInstanceId:
        row.producer_instance_id,

      producerVersion:
        row.producer_version,

      authorityMode:
        row.authority_mode,

      finalizedThroughUs:
        Number(
          row.finalized_through_us
        ),

      finalizedSignalCount:
        Number(
          row.finalized_signal_count
        ),

      finalizedLastStreamSequence:
        Number(
          row.finalized_last_stream_sequence
        ),

      progressId:
        row.progress_id
    };

    if (
      sha256(
        stableStringify(
          biologicalStreamProgressHeadBody(
            head
          )
        )
      ) !==
        row.head_sha256
    ) {
      throw Object.assign(
        new Error(
          `biological stream-progress head ${head.producerStreamId}/${head.authorityEpoch} is corrupt`
        ),
        {
          code:
            'BIOLOGICAL_STREAM_PROGRESS_CORRUPT'
        }
      );
    }

    const progressRow =
      this.db.prepare(`
        SELECT *
        FROM biological_stream_progress
        WHERE progress_id=?
      `).get(
        head.progressId
      );

    const progress =
      this.biologicalStreamProgressFromRow(
        progressRow
      );

    if (
      !progress ||
      progress.organismId !==
        head.organismId ||
      progress.producerStreamId !==
        head.producerStreamId ||
      progress.authorityEpoch !==
        head.authorityEpoch ||
      progress.producerCoreId !==
        head.producerCoreId ||
      progress.producerInstanceId !==
        head.producerInstanceId ||
      progress.producerVersion !==
        head.producerVersion ||
      progress.authorityMode !==
        head.authorityMode ||
      progress.finalizedThroughUs !==
        head.finalizedThroughUs ||
      progress.finalizedSignalCount !==
        head.finalizedSignalCount ||
      progress.finalizedLastStreamSequence !==
        head.finalizedLastStreamSequence
    ) {
      throw Object.assign(
        new Error(
          'biological stream-progress head disagrees with its durable progress record'
        ),
        {
          code:
            'BIOLOGICAL_STREAM_PROGRESS_CORRUPT'
        }
      );
    }

    return progress;
  }


  getBiologicalStreamProgress({
    organismId,
    producerStreamId,
    authorityEpoch
  }) {
    this.assertOpen();

    const epoch =
      Number(
        authorityEpoch
      );

    if (
      typeof organismId !==
        'string' ||
      !organismId ||
      typeof producerStreamId !==
        'string' ||
      !producerStreamId ||
      !Number.isSafeInteger(
        epoch
      ) ||
      epoch < 1
    ) {
      throw Object.assign(
        new Error(
          'biological stream-progress identity is invalid'
        ),
        {
          code:
            'BIOLOGICAL_STREAM_PROGRESS_ID'
        }
      );
    }

    const row =
      this.db.prepare(`
        SELECT *
        FROM biological_stream_progress_heads
        WHERE
          organism_id=? AND
          producer_stream_id=? AND
          authority_epoch=?
      `).get(
        organismId,
        producerStreamId,
        epoch
      );

    return row
      ? this.biologicalStreamProgressHeadFromRow(
          row
        )
      : null;
  }


  commitBiologicalStreamProgress({
    prepared,
    finalizePrepared,
    authorityWitness = null
  }) {
    this.assertOpen();

    if (
      typeof finalizePrepared !==
        'function'
    ) {
      throw Object.assign(
        new Error(
          'stream-progress finalizer is required'
        ),
        {
          code:
            'BIOLOGICAL_STREAM_PROGRESS_CONFIG'
        }
      );
    }

    return this.withTransaction(
      () => {
        /*
         * Finalization authenticates the prepared capability
         * before StateStore trusts any caller-supplied field.
         */
        const progress =
          finalizePrepared(
            prepared
          );

        const epoch =
          Number(
            progress?.authority_epoch
          );

        if (
          !progress ||
          progress.protocol !==
            'stay-biological-stream-progress-v1' ||
          typeof progress.organism_id !==
            'string' ||
          !progress.organism_id ||
          typeof progress.producer_core_id !==
            'string' ||
          !progress.producer_core_id ||
          typeof progress.producer_instance_id !==
            'string' ||
          !progress.producer_instance_id ||
          typeof progress.producer_version !==
            'string' ||
          !progress.producer_version ||
          typeof progress.producer_stream_id !==
            'string' ||
          !progress.producer_stream_id ||
          progress.producer_stream_id.length >
            200 ||
          !Number.isSafeInteger(
            epoch
          ) ||
          epoch < 1 ||
          ![
            'neutral',
            'lab',
            'shadow',
            'authoritative'
          ].includes(
            progress.authority_mode
          ) ||
          !Number.isSafeInteger(
            progress.finalized_through_us
          ) ||
          progress.finalized_through_us <
            0 ||
          !Number.isSafeInteger(
            progress.accepted_time_us
          ) ||
          progress.accepted_time_us <
            0
        ) {
          throw Object.assign(
            new Error(
              'prepared biological stream progress is invalid'
            ),
            {
              code:
                'BIOLOGICAL_STREAM_PROGRESS_INVALID'
            }
          );
        }

        if (
          progress.finalized_through_us >
            progress.accepted_time_us
        ) {
          throw Object.assign(
            new Error(
              'stream progress cannot finalize future organism time'
            ),
            {
              code:
                'BIOLOGICAL_STREAM_PROGRESS_FUTURE'
            }
          );
        }

        const authoritative =
          progress.authority_mode ===
            'authoritative';

        if (
          authoritative &&
          authorityWitness == null
        ) {
          throw Object.assign(
            new Error(
              'authoritative stream progress requires a commit-time authority witness'
            ),
            {
              code:
                'BIOLOGICAL_AUTHORITY_WITNESS_REQUIRED'
            }
          );
        }

        if (
          !authoritative &&
          authorityWitness != null
        ) {
          throw Object.assign(
            new Error(
              'non-authoritative stream progress cannot claim an authority witness'
            ),
            {
              code:
                'BIOLOGICAL_AUTHORITY_WITNESS'
            }
          );
        }

        if (
          authoritative
        ) {
          const witness = {
            coreId:
              authorityWitness.coreId ??
              authorityWitness.core_id,

            instanceId:
              authorityWitness.instanceId ??
              authorityWitness.instance_id,

            version:
              authorityWitness.version,

            authorityEpoch:
              Number(
                authorityWitness.authorityEpoch ??
                authorityWitness.authority_epoch
              )
          };

          if (
            witness.coreId !==
              progress.producer_core_id ||
            witness.instanceId !==
              progress.producer_instance_id ||
            witness.version !==
              progress.producer_version ||
            witness.authorityEpoch !==
              epoch
          ) {
            throw Object.assign(
              new Error(
                'stream-progress authority witness disagrees with prepared producer'
              ),
              {
                code:
                  'BIOLOGICAL_AUTHORITY_WITNESS'
              }
            );
          }

          const current =
            this.getAuthority(
              witness.coreId
            );

          if (
            !current ||
            current.instanceId !==
              witness.instanceId ||
            current.version !==
              witness.version ||
            Number(
              current.epoch
            ) !==
              witness.authorityEpoch
          ) {
            throw Object.assign(
              new Error(
                'stream-progress producer became stale before durable commit'
              ),
              {
                code:
                  'BIOLOGICAL_AUTHORITY_STALE'
              }
            );
          }
        }

        const streamHead =
          this.getBiologicalStreamHead({
            organismId:
              progress.organism_id,

            producerStreamId:
              progress.producer_stream_id,

            authorityEpoch:
              epoch
          });

        if (
          streamHead &&
          streamHead.producerCoreId !==
            progress.producer_core_id
        ) {
          throw Object.assign(
            new Error(
              'stream progress changed owning core inside one authority epoch'
            ),
            {
              code:
                'BIOLOGICAL_STREAM_IDENTITY'
            }
          );
        }

        const previous =
          this.getBiologicalStreamProgress({
            organismId:
              progress.organism_id,

            producerStreamId:
              progress.producer_stream_id,

            authorityEpoch:
              epoch
          });

        if (
          previous &&
          (
            previous.producerCoreId !==
              progress.producer_core_id ||
            previous.producerInstanceId !==
              progress.producer_instance_id ||
            previous.producerVersion !==
              progress.producer_version ||
            previous.authorityMode !==
              progress.authority_mode
          )
        ) {
          throw Object.assign(
            new Error(
              'stream-progress producer identity changed inside one authority epoch'
            ),
            {
              code:
                'BIOLOGICAL_STREAM_PROGRESS_IDENTITY'
            }
          );
        }

        if (
          previous &&
          progress.finalized_through_us <
            previous.finalizedThroughUs
        ) {
          throw Object.assign(
            new Error(
              'biological stream finalization cannot move backward'
            ),
            {
              code:
                'BIOLOGICAL_STREAM_PROGRESS_REWIND'
            }
          );
        }

        if (
          previous &&
          progress.finalized_through_us ===
            previous.finalizedThroughUs
        ) {
          return {
            ...previous,
            deduplicated:
              true
          };
        }

        /*
         * Finalized counts are cumulative durability metadata, not
         * a recount of whatever raw Envelope rows happen to remain.
         * Once a lower progress record exists, later progress adds
         * only signals in the newly finalized time interval. Safe
         * compaction of older finalized rows therefore cannot make
         * cumulative completeness move backward or fabricate silence.
         */
        const intervalSummary =
          previous
            ? this.db.prepare(`
                SELECT
                  COUNT(*) AS signal_count,
                  COALESCE(
                    MAX(stream_sequence),
                    0
                  ) AS last_stream_sequence
                FROM biological_envelopes_v2
                WHERE
                  organism_id=? AND
                  producer_stream_id=? AND
                  authority_epoch=? AND
                  order_time_us>? AND
                  order_time_us<=?
              `).get(
                progress.organism_id,
                progress.producer_stream_id,
                epoch,
                previous.finalizedThroughUs,
                progress.finalized_through_us
              )
            : this.db.prepare(`
                SELECT
                  COUNT(*) AS signal_count,
                  COALESCE(
                    MAX(stream_sequence),
                    0
                  ) AS last_stream_sequence
                FROM biological_envelopes_v2
                WHERE
                  organism_id=? AND
                  producer_stream_id=? AND
                  authority_epoch=? AND
                  order_time_us<=?
              `).get(
                progress.organism_id,
                progress.producer_stream_id,
                epoch,
                progress.finalized_through_us
              );

        const intervalSignalCount =
          Number(
            intervalSummary?.signal_count ||
            0
          );

        const intervalLastStreamSequence =
          Number(
            intervalSummary?.last_stream_sequence ||
            0
          );

        const finalizedSignalCount =
          (
            previous?.finalizedSignalCount ||
            0
          ) +
          intervalSignalCount;

        const finalizedLastStreamSequence =
          Math.max(
            previous?.finalizedLastStreamSequence ||
              0,
            intervalLastStreamSequence
          );

        const body = {
          protocol:
            'stay-biological-stream-progress-v1',

          organismId:
            progress.organism_id,

          producerStreamId:
            progress.producer_stream_id,

          authorityEpoch:
            epoch,

          producerCoreId:
            progress.producer_core_id,

          producerInstanceId:
            progress.producer_instance_id,

          producerVersion:
            progress.producer_version,

          authorityMode:
            progress.authority_mode,

          finalizedThroughUs:
            progress.finalized_through_us,

          finalizedSignalCount,

          finalizedLastStreamSequence,

          acceptedTimeUs:
            progress.accepted_time_us,

          previousProgressId:
            previous?.progressId ||
            null
        };

        const progressId =
          `sha256:${sha256(
            stableStringify(
              body
            )
          )}`;

        const progressHash =
          sha256(
            stableStringify({
              ...body,
              progressId
            })
          );

        const createdAt =
          new Date().toISOString();

        this.db.prepare(`
          INSERT INTO biological_stream_progress(
            progress_id,
            organism_id,
            producer_stream_id,
            authority_epoch,
            producer_core_id,
            producer_instance_id,
            producer_version,
            authority_mode,
            finalized_through_us,
            finalized_signal_count,
            finalized_last_stream_sequence,
            accepted_time_us,
            previous_progress_id,
            progress_sha256,
            created_at
          )
          VALUES(
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `).run(
          progressId,
          body.organismId,
          body.producerStreamId,
          body.authorityEpoch,
          body.producerCoreId,
          body.producerInstanceId,
          body.producerVersion,
          body.authorityMode,
          body.finalizedThroughUs,
          body.finalizedSignalCount,
          body.finalizedLastStreamSequence,
          body.acceptedTimeUs,
          body.previousProgressId,
          progressHash,
          createdAt
        );

        const nextHead = {
          organismId:
            body.organismId,

          producerStreamId:
            body.producerStreamId,

          authorityEpoch:
            body.authorityEpoch,

          producerCoreId:
            body.producerCoreId,

          producerInstanceId:
            body.producerInstanceId,

          producerVersion:
            body.producerVersion,

          authorityMode:
            body.authorityMode,

          finalizedThroughUs:
            body.finalizedThroughUs,

          finalizedSignalCount:
            body.finalizedSignalCount,

          finalizedLastStreamSequence:
            body.finalizedLastStreamSequence,

          progressId
        };

        const headHash =
          sha256(
            stableStringify(
              biologicalStreamProgressHeadBody(
                nextHead
              )
            )
          );

        if (
          previous
        ) {
          const updated =
            this.db.prepare(`
              UPDATE biological_stream_progress_heads
              SET
                producer_core_id=?,
                producer_instance_id=?,
                producer_version=?,
                authority_mode=?,
                finalized_through_us=?,
                finalized_signal_count=?,
                finalized_last_stream_sequence=?,
                progress_id=?,
                head_sha256=?,
                updated_at=?
              WHERE
                organism_id=? AND
                producer_stream_id=? AND
                authority_epoch=? AND
                progress_id=?
            `).run(
              nextHead.producerCoreId,
              nextHead.producerInstanceId,
              nextHead.producerVersion,
              nextHead.authorityMode,
              nextHead.finalizedThroughUs,
              nextHead.finalizedSignalCount,
              nextHead.finalizedLastStreamSequence,
              nextHead.progressId,
              headHash,
              createdAt,
              nextHead.organismId,
              nextHead.producerStreamId,
              nextHead.authorityEpoch,
              previous.progressId
            );

          if (
            updated.changes !==
            1
          ) {
            throw Object.assign(
              new Error(
                'biological stream-progress head compare-and-swap failed'
              ),
              {
                code:
                  'BIOLOGICAL_STREAM_PROGRESS_CONFLICT'
              }
            );
          }

        } else {
          this.db.prepare(`
            INSERT INTO biological_stream_progress_heads(
              organism_id,
              producer_stream_id,
              authority_epoch,
              producer_core_id,
              producer_instance_id,
              producer_version,
              authority_mode,
              finalized_through_us,
              finalized_signal_count,
              finalized_last_stream_sequence,
              progress_id,
              head_sha256,
              updated_at
            )
            VALUES(
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
          `).run(
            nextHead.organismId,
            nextHead.producerStreamId,
            nextHead.authorityEpoch,
            nextHead.producerCoreId,
            nextHead.producerInstanceId,
            nextHead.producerVersion,
            nextHead.authorityMode,
            nextHead.finalizedThroughUs,
            nextHead.finalizedSignalCount,
            nextHead.finalizedLastStreamSequence,
            nextHead.progressId,
            headHash,
            createdAt
          );
        }

        return {
          ...this.getBiologicalStreamProgress({
            organismId:
              body.organismId,

            producerStreamId:
              body.producerStreamId,

            authorityEpoch:
              body.authorityEpoch
          }),

          deduplicated:
            false
        };
      }
    );
  }


  proveBiologicalSilence({
    organismId,
    producerStreamId,
    authorityEpoch,
    fromUs,
    throughUs
  }) {
    this.assertOpen();

    const epoch =
      Number(
        authorityEpoch
      );

    const from =
      Number(
        fromUs
      );

    const through =
      Number(
        throughUs
      );

    if (
      typeof organismId !==
        'string' ||
      !organismId ||
      typeof producerStreamId !==
        'string' ||
      !producerStreamId ||
      !Number.isSafeInteger(
        epoch
      ) ||
      epoch < 1 ||
      !Number.isSafeInteger(
        from
      ) ||
      from < 0 ||
      !Number.isSafeInteger(
        through
      ) ||
      through < from
    ) {
      throw Object.assign(
        new Error(
          'biological silence query is invalid'
        ),
        {
          code:
            'BIOLOGICAL_STREAM_SILENCE_QUERY'
        }
      );
    }

    const upperRow =
      this.db.prepare(`
        SELECT *
        FROM biological_stream_progress
        WHERE
          organism_id=? AND
          producer_stream_id=? AND
          authority_epoch=? AND
          finalized_through_us>=?
        ORDER BY finalized_through_us ASC
        LIMIT 1
      `).get(
        organismId,
        producerStreamId,
        epoch,
        through
      );

    if (
      !upperRow
    ) {
      return Object.freeze({
        complete:
          false,

        silent:
          null,

        reason:
          'STREAM_PROGRESS_INCOMPLETE',

        fromUs:
          from,

        throughUs:
          through
      });
    }

    const upper =
      this.biologicalStreamProgressFromRow(
        upperRow
      );

    const retainedSignal =
      this.db.prepare(`
        SELECT
          signal_id,
          order_time_us,
          stream_sequence
        FROM biological_envelopes_v2
        WHERE
          organism_id=? AND
          producer_stream_id=? AND
          authority_epoch=? AND
          order_time_us>? AND
          order_time_us<=?
        ORDER BY
          order_time_us ASC,
          stream_sequence ASC
        LIMIT 1
      `).get(
        organismId,
        producerStreamId,
        epoch,
        from,
        through
      );

    if (
      retainedSignal
    ) {
      return Object.freeze({
        complete:
          true,

        silent:
          false,

        reason:
          'SIGNAL_PRESENT',

        fromUs:
          from,

        throughUs:
          through,

        coveringProgressId:
          upper.progressId,

        signalId:
          retainedSignal.signal_id,

        signalOrderTimeUs:
          Number(
            retainedSignal.order_time_us
          ),

        signalStreamSequence:
          Number(
            retainedSignal.stream_sequence
          )
      });
    }

    const lowerRow =
      this.db.prepare(`
        SELECT *
        FROM biological_stream_progress
        WHERE
          organism_id=? AND
          producer_stream_id=? AND
          authority_epoch=? AND
          finalized_through_us<=?
        ORDER BY finalized_through_us DESC
        LIMIT 1
      `).get(
        organismId,
        producerStreamId,
        epoch,
        from
      );

    if (
      !lowerRow
    ) {
      return Object.freeze({
        complete:
          true,

        silent:
          null,

        reason:
          'LOWER_PROGRESS_BOUND_MISSING',

        fromUs:
          from,

        throughUs:
          through,

        coveringProgressId:
          upper.progressId
      });
    }

    const lower =
      this.biologicalStreamProgressFromRow(
        lowerRow
      );

    if (
      lower.finalizedSignalCount ===
        upper.finalizedSignalCount
    ) {
      return Object.freeze({
        complete:
          true,

        silent:
          true,

        reason:
          'FINALIZED_COUNT_UNCHANGED',

        fromUs:
          from,

        throughUs:
          through,

        lowerProgressId:
          lower.progressId,

        coveringProgressId:
          upper.progressId
      });
    }

    /*
     * A changed cumulative count proves that at least one
     * signal exists somewhere between the two progress
     * boundaries. If that signal has since been compacted and
     * no retained row locates it inside the requested
     * sub-window, the only safe answer is UNKNOWN.
     */
    return Object.freeze({
      complete:
        true,

      silent:
        null,

      reason:
        'COMPACTED_OR_OUTSIDE_SUBWINDOW',

      fromUs:
        from,

      throughUs:
        through,

      lowerProgressId:
        lower.progressId,

      coveringProgressId:
        upper.progressId
    });
  }



  biologicalRouteTransitionFromRow(
    row
  ) {
    if (!row) {
      return null;
    }

    const transition = {
      routeId:
        row.route_id,

      transitionSequence:
        Number(
          row.transition_sequence
        ),

      transitionId:
        row.transition_id,

      fromState:
        row.from_state ||
        null,

      toState:
        row.to_state,

      authorityEpoch:
        Number(
          row.authority_epoch
        ),

      activeFromUs:
        Number(
          row.active_from_us
        ),

      routeBarrierUs:
        row.route_barrier_us == null
          ? null
          : Number(
              row.route_barrier_us
            ),

      gapFromUs:
        row.gap_from_us == null
          ? null
          : Number(
              row.gap_from_us
            ),

      gapThroughUs:
        row.gap_through_us == null
          ? null
          : Number(
              row.gap_through_us
            ),

      reason:
        row.reason
    };

    const body =
      biologicalRouteTransitionBody(
        transition
      );

    const expectedId =
      `sha256:${sha256(
        stableStringify(
          body
        )
      )}`;

    const expectedHash =
      sha256(
        stableStringify({
          ...body,
          transitionId:
            expectedId
        })
      );

    if (
      transition.transitionId !==
        expectedId ||
      row.transition_sha256 !==
        expectedHash
    ) {
      throw Object.assign(
        new Error(
          `biological route transition ${transition.routeId}/${transition.transitionSequence} is corrupt`
        ),
        {
          code:
            'BIOLOGICAL_ROUTE_CORRUPT'
        }
      );
    }

    return Object.freeze(
      transition
    );
  }


  biologicalRouteBoundaryAckFromRow(
    row
  ) {
    if (!row) {
      return null;
    }

    const ack = {
      routeId:
        row.route_id,

      transitionSequence:
        Number(
          row.transition_sequence
        ),

      ackId:
        row.ack_id,

      consumerId:
        row.consumer_id,

      boundaryState:
        row.boundary_state,

      routeBarrierUs:
        Number(
          row.route_barrier_us
        ),

      committedThroughUs:
        Number(
          row.committed_through_us
        ),

      checkpointHash:
        row.checkpoint_hash,

      transitionId:
        row.transition_id,

      semantics:
        row.semantics,

      createdAt:
        row.created_at
    };

    const body =
      biologicalRouteBoundaryAckBody(
        ack
      );

    const expectedId =
      `sha256:${sha256(
        stableStringify(
          body
        )
      )}`;

    const expectedHash =
      sha256(
        stableStringify({
          ...body,
          ackId:
            expectedId
        })
      );

    if (
      ack.ackId !==
        expectedId ||
      row.ack_sha256 !==
        expectedHash
    ) {
      throw Object.assign(
        new Error(
          `biological route boundary acknowledgement ${ack.routeId}/${ack.transitionSequence} is corrupt`
        ),
        {
          code:
            'BIOLOGICAL_ROUTE_CORRUPT'
        }
      );
    }

    return Object.freeze(
      ack
    );
  }


  biologicalRouteFromRow(
    row
  ) {
    if (!row) {
      return null;
    }

    const route = {
      routeId:
        row.route_id,

      organismId:
        row.organism_id,

      consumerId:
        row.consumer_id,

      producerCoreId:
        row.producer_core_id,

      producerStreamId:
        row.producer_stream_id,

      authorityEpoch:
        Number(
          row.authority_epoch
        ),

      required:
        Boolean(
          row.required
        ),

      state:
        row.state,

      activeFromUs:
        Number(
          row.active_from_us
        ),

      routeBarrierUs:
        row.route_barrier_us == null
          ? null
          : Number(
              row.route_barrier_us
            ),

      gapFromUs:
        row.gap_from_us == null
          ? null
          : Number(
              row.gap_from_us
            ),

      gapThroughUs:
        row.gap_through_us == null
          ? null
          : Number(
              row.gap_through_us
            ),

      transitionSequence:
        Number(
          row.transition_sequence
        ),

      lastTransitionId:
        row.last_transition_id,

      registeredAt:
        row.registered_at,

      updatedAt:
        row.updated_at
    };

    if (
      !BIOLOGICAL_ROUTE_STATE_SET.has(
        route.state
      ) ||
      sha256(
        stableStringify(
          biologicalRouteHeadBody(
            route
          )
        )
      ) !==
        row.head_sha256
    ) {
      throw Object.assign(
        new Error(
          `biological route ${route.routeId} head is corrupt`
        ),
        {
          code:
            'BIOLOGICAL_ROUTE_CORRUPT'
        }
      );
    }

    const transitionRow =
      this.db.prepare(`
        SELECT *
        FROM biological_route_transitions
        WHERE
          route_id=? AND
          transition_sequence=?
      `).get(
        route.routeId,
        route.transitionSequence
      );

    const transition =
      this.biologicalRouteTransitionFromRow(
        transitionRow
      );

    if (
      !transition ||
      transition.transitionId !==
        route.lastTransitionId ||
      transition.toState !==
        route.state ||
      transition.authorityEpoch !==
        route.authorityEpoch ||
      transition.activeFromUs !==
        route.activeFromUs ||
      transition.routeBarrierUs !==
        route.routeBarrierUs ||
      transition.gapFromUs !==
        route.gapFromUs ||
      transition.gapThroughUs !==
        route.gapThroughUs
    ) {
      throw Object.assign(
        new Error(
          `biological route ${route.routeId} head disagrees with transition history`
        ),
        {
          code:
            'BIOLOGICAL_ROUTE_CORRUPT'
        }
      );
    }

    const ackRow =
      this.db.prepare(`
        SELECT *
        FROM biological_route_boundary_acks
        WHERE
          route_id=? AND
          transition_sequence=?
      `).get(
        route.routeId,
        route.transitionSequence
      );

    const boundaryAck =
      ackRow
        ? this.biologicalRouteBoundaryAckFromRow(
            ackRow
          )
        : null;

    if (
      boundaryAck &&
      (
        boundaryAck.consumerId !==
          route.consumerId ||
        boundaryAck.boundaryState !==
          route.state ||
        boundaryAck.routeBarrierUs !==
          route.routeBarrierUs
      )
    ) {
      throw Object.assign(
        new Error(
          `biological route ${route.routeId} acknowledgement disagrees with route boundary`
        ),
        {
          code:
            'BIOLOGICAL_ROUTE_CORRUPT'
        }
      );
    }

    return Object.freeze({
      ...route,
      transition,
      boundaryAck
    });
  }


  getBiologicalRoute(
    routeId
  ) {
    this.assertOpen();

    const row =
      this.db.prepare(`
        SELECT *
        FROM biological_routes
        WHERE route_id=?
      `).get(
        routeId
      );

    return row
      ? this.biologicalRouteFromRow(
          row
        )
      : null;
  }


  listBiologicalRoutes({
    consumerId = null,
    required = null,
    state = null
  } = {}) {
    this.assertOpen();

    if (
      state != null &&
      !BIOLOGICAL_ROUTE_STATE_SET.has(
        state
      )
    ) {
      throw Object.assign(
        new Error(
          'biological route state filter is invalid'
        ),
        {
          code:
            'BIOLOGICAL_ROUTE_QUERY'
        }
      );
    }

    const clauses = [];
    const args = [];

    if (
      consumerId != null
    ) {
      clauses.push(
        'consumer_id=?'
      );
      args.push(
        consumerId
      );
    }

    if (
      required != null
    ) {
      clauses.push(
        'required=?'
      );
      args.push(
        required
          ? 1
          : 0
      );
    }

    if (
      state != null
    ) {
      clauses.push(
        'state=?'
      );
      args.push(
        state
      );
    }

    const where =
      clauses.length
        ? `WHERE ${clauses.join(' AND ')}`
        : '';

    return this.db.prepare(`
      SELECT *
      FROM biological_routes
      ${where}
      ORDER BY route_id ASC
    `).all(
      ...args
    ).map(
      row =>
        this.biologicalRouteFromRow(
          row
        )
    );
  }


  registerBiologicalRoute({
    routeId,
    organismId,
    consumerId,
    producerCoreId,
    producerStreamId,
    authorityEpoch,
    required = true,
    activeFromUs = 0,
    reason = 'route.registered'
  }) {
    this.assertOpen();

    const epoch =
      Number(
        authorityEpoch
      );

    const activeFrom =
      Number(
        activeFromUs
      );

    if (
      typeof routeId !==
        'string' ||
      !routeId ||
      routeId.length >
        200 ||
      typeof organismId !==
        'string' ||
      !organismId ||
      typeof consumerId !==
        'string' ||
      !consumerId ||
      typeof producerCoreId !==
        'string' ||
      !producerCoreId ||
      typeof producerStreamId !==
        'string' ||
      !producerStreamId ||
      producerStreamId.length >
        200 ||
      !Number.isSafeInteger(
        epoch
      ) ||
      epoch < 1 ||
      !Number.isSafeInteger(
        activeFrom
      ) ||
      activeFrom < 0 ||
      typeof reason !==
        'string' ||
      !reason ||
      reason.length >
        256
    ) {
      throw Object.assign(
        new Error(
          'biological route registration is invalid'
        ),
        {
          code:
            'BIOLOGICAL_ROUTE_INVALID'
        }
      );
    }

    const consumer =
      this.getBiologicalConsumer(
        consumerId
      );

    if (!consumer) {
      throw Object.assign(
        new Error(
          'biological route consumer is not registered'
        ),
        {
          code:
            'BIOLOGICAL_ROUTE_CONSUMER'
        }
      );
    }

    const existing =
      this.getBiologicalRoute(
        routeId
      );

    if (
      existing
    ) {
      if (
        existing.organismId ===
          organismId &&
        existing.consumerId ===
          consumerId &&
        existing.producerCoreId ===
          producerCoreId &&
        existing.producerStreamId ===
          producerStreamId &&
        existing.authorityEpoch ===
          epoch &&
        existing.required ===
          Boolean(required) &&
        existing.state ===
          'ACTIVE' &&
        existing.activeFromUs ===
          activeFrom
      ) {
        return existing;
      }

      throw Object.assign(
        new Error(
          'biological route identity was reused with different anatomy'
        ),
        {
          code:
            'BIOLOGICAL_ROUTE_CONFLICT'
        }
      );
    }

    const transition = {
      routeId,
      transitionSequence:
        1,
      fromState:
        null,
      toState:
        'ACTIVE',
      authorityEpoch:
        epoch,
      activeFromUs:
        activeFrom,
      routeBarrierUs:
        null,
      gapFromUs:
        null,
      gapThroughUs:
        null,
      reason
    };

    const transitionBody =
      biologicalRouteTransitionBody(
        transition
      );

    const transitionId =
      `sha256:${sha256(
        stableStringify(
          transitionBody
        )
      )}`;

    const transitionHash =
      sha256(
        stableStringify({
          ...transitionBody,
          transitionId
        })
      );

    const head = {
      routeId,
      organismId,
      consumerId,
      producerCoreId,
      producerStreamId,
      authorityEpoch:
        epoch,
      required:
        Boolean(required),
      state:
        'ACTIVE',
      activeFromUs:
        activeFrom,
      routeBarrierUs:
        null,
      gapFromUs:
        null,
      gapThroughUs:
        null,
      transitionSequence:
        1,
      lastTransitionId:
        transitionId
    };

    const headHash =
      sha256(
        stableStringify(
          biologicalRouteHeadBody(
            head
          )
        )
      );

    const at =
      new Date().toISOString();

    this.withTransaction(
      () => {
        this.db.prepare(`
          INSERT INTO biological_routes(
            route_id,
            organism_id,
            consumer_id,
            producer_core_id,
            producer_stream_id,
            authority_epoch,
            required,
            state,
            active_from_us,
            route_barrier_us,
            gap_from_us,
            gap_through_us,
            transition_sequence,
            last_transition_id,
            head_sha256,
            registered_at,
            updated_at
          )
          VALUES(
            ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, NULL, NULL, NULL, 1, ?, ?, ?, ?
          )
        `).run(
          routeId,
          organismId,
          consumerId,
          producerCoreId,
          producerStreamId,
          epoch,
          required
            ? 1
            : 0,
          activeFrom,
          transitionId,
          headHash,
          at,
          at
        );

        this.db.prepare(`
          INSERT INTO biological_route_transitions(
            route_id,
            transition_sequence,
            transition_id,
            from_state,
            to_state,
            authority_epoch,
            active_from_us,
            route_barrier_us,
            gap_from_us,
            gap_through_us,
            reason,
            transition_sha256,
            created_at
          )
          VALUES(
            ?, 1, ?, NULL, 'ACTIVE', ?, ?, NULL, NULL, NULL, ?, ?, ?
          )
        `).run(
          routeId,
          transitionId,
          epoch,
          activeFrom,
          reason,
          transitionHash,
          at
        );
      }
    );

    this.markWriteSuccess();

    return this.getBiologicalRoute(
      routeId
    );
  }


  transitionBiologicalRoute({
    routeId,
    toState,
    routeBarrierUs = null,
    gapFromUs = null,
    gapThroughUs = null,
    activeFromUs = null,
    authorityEpoch = null,
    reason = 'route.transition'
  }) {
    this.assertOpen();

    if (
      !BIOLOGICAL_ROUTE_STATE_SET.has(
        toState
      ) ||
      typeof reason !==
        'string' ||
      !reason ||
      reason.length >
        256
    ) {
      throw Object.assign(
        new Error(
          'biological route transition is invalid'
        ),
        {
          code:
            'BIOLOGICAL_ROUTE_TRANSITION'
        }
      );
    }

    const result = this.withTransaction(
      () => {
        const current =
          this.getBiologicalRoute(
            routeId
          );

        if (!current) {
          throw Object.assign(
            new Error(
              'unknown biological route'
            ),
            {
              code:
                'BIOLOGICAL_ROUTE_UNKNOWN'
            }
          );
        }

        if (
          current.state ===
            'RETIRED'
        ) {
          throw Object.assign(
            new Error(
              'retired biological route is terminal'
            ),
            {
              code:
                'BIOLOGICAL_ROUTE_RETIRED'
            }
          );
        }

        if (
          current.state ===
            toState
        ) {
          throw Object.assign(
            new Error(
              'biological route transition does not change state'
            ),
            {
              code:
                'BIOLOGICAL_ROUTE_TRANSITION'
            }
          );
        }

        let nextEpoch =
          current.authorityEpoch;

        let nextActiveFrom =
          current.activeFromUs;

        let nextBarrier =
          null;

        let nextGapFrom =
          null;

        let nextGapThrough =
          null;

        if (
          toState ===
            'ACTIVE'
        ) {
          if (
            ![
              'DEGRADED',
              'EVIDENCE_GAP'
            ].includes(
              current.state
            )
          ) {
            throw Object.assign(
              new Error(
                'only a degraded or evidence-gap route may reactivate'
              ),
              {
                code:
                  'BIOLOGICAL_ROUTE_REACTIVATION'
              }
            );
          }

          const ack =
            current.boundaryAck;

          if (!ack) {
            throw Object.assign(
              new Error(
                'route cannot reactivate before consumer boundary acknowledgement'
              ),
              {
                code:
                  'BIOLOGICAL_ROUTE_BOUNDARY_UNACKNOWLEDGED'
              }
            );
          }

          nextActiveFrom =
            Number(
              activeFromUs
            );

          nextEpoch =
            authorityEpoch == null
              ? current.authorityEpoch
              : Number(
                  authorityEpoch
                );

          if (
            !Number.isSafeInteger(
              nextActiveFrom
            ) ||
            nextActiveFrom <=
              ack.committedThroughUs ||
            !Number.isSafeInteger(
              nextEpoch
            ) ||
            nextEpoch <
              current.authorityEpoch
          ) {
            throw Object.assign(
              new Error(
                'route reactivation must begin beyond committed degraded history without authority rewind'
              ),
              {
                code:
                  'BIOLOGICAL_ROUTE_REACTIVATION'
              }
            );
          }

        } else if (
          toState ===
            'DEGRADED'
        ) {
          if (
            current.state !==
              'ACTIVE'
          ) {
            throw Object.assign(
              new Error(
                'only an active route may enter degraded state'
              ),
              {
                code:
                  'BIOLOGICAL_ROUTE_TRANSITION'
              }
            );
          }

          nextBarrier =
            Number(
              routeBarrierUs
            );

          if (
            !Number.isSafeInteger(
              nextBarrier
            ) ||
            nextBarrier <
              current.activeFromUs
          ) {
            throw Object.assign(
              new Error(
                'degraded route requires a complete non-rewinding barrier'
              ),
              {
                code:
                  'BIOLOGICAL_ROUTE_BARRIER'
              }
            );
          }

        } else if (
          toState ===
            'EVIDENCE_GAP'
        ) {
          if (
            current.state !==
              'ACTIVE'
          ) {
            throw Object.assign(
              new Error(
                'only an active route may enter evidence-gap state'
              ),
              {
                code:
                  'BIOLOGICAL_ROUTE_TRANSITION'
              }
            );
          }

          nextBarrier =
            Number(
              routeBarrierUs
            );

          nextGapFrom =
            Number(
              gapFromUs
            );

          nextGapThrough =
            Number(
              gapThroughUs
            );

          if (
            !Number.isSafeInteger(
              nextBarrier
            ) ||
            nextBarrier <
              current.activeFromUs ||
            !Number.isSafeInteger(
              nextGapFrom
            ) ||
            nextGapFrom <=
              nextBarrier ||
            !Number.isSafeInteger(
              nextGapThrough
            ) ||
            nextGapThrough <
              nextGapFrom
          ) {
            throw Object.assign(
              new Error(
                'evidence-gap route requires an exact missing interval beyond its complete barrier'
              ),
              {
                code:
                  'BIOLOGICAL_ROUTE_EVIDENCE_GAP'
              }
            );
          }

        } else if (
          toState ===
            'CLOSED'
        ) {
          if (
            current.state !==
              'ACTIVE'
          ) {
            throw Object.assign(
              new Error(
                'only an active route may close with a final complete boundary'
              ),
              {
                code:
                  'BIOLOGICAL_ROUTE_TRANSITION'
              }
            );
          }

          nextBarrier =
            Number(
              routeBarrierUs
            );

          if (
            !Number.isSafeInteger(
              nextBarrier
            ) ||
            nextBarrier <
              current.activeFromUs
          ) {
            throw Object.assign(
              new Error(
                'closed route requires a final non-rewinding complete boundary'
              ),
              {
                code:
                  'BIOLOGICAL_ROUTE_BARRIER'
              }
            );
          }

        } else if (
          toState ===
            'RETIRED'
        ) {
          if (
            current.state !==
              'CLOSED' ||
            !current.boundaryAck
          ) {
            throw Object.assign(
              new Error(
                'route may retire only after a closed boundary is durably acknowledged'
              ),
              {
                code:
                  'BIOLOGICAL_ROUTE_RETIREMENT'
              }
            );
          }

          nextBarrier =
            current.routeBarrierUs;
        }

        const transitionSequence =
          current.transitionSequence +
          1;

        const transition = {
          routeId:
            current.routeId,

          transitionSequence,

          fromState:
            current.state,

          toState,

          authorityEpoch:
            nextEpoch,

          activeFromUs:
            nextActiveFrom,

          routeBarrierUs:
            nextBarrier,

          gapFromUs:
            nextGapFrom,

          gapThroughUs:
            nextGapThrough,

          reason
        };

        const transitionBody =
          biologicalRouteTransitionBody(
            transition
          );

        const transitionId =
          `sha256:${sha256(
            stableStringify(
              transitionBody
            )
          )}`;

        const transitionHash =
          sha256(
            stableStringify({
              ...transitionBody,
              transitionId
            })
          );

        const nextHead = {
          routeId:
            current.routeId,

          organismId:
            current.organismId,

          consumerId:
            current.consumerId,

          producerCoreId:
            current.producerCoreId,

          producerStreamId:
            current.producerStreamId,

          authorityEpoch:
            nextEpoch,

          required:
            current.required,

          state:
            toState,

          activeFromUs:
            nextActiveFrom,

          routeBarrierUs:
            nextBarrier,

          gapFromUs:
            nextGapFrom,

          gapThroughUs:
            nextGapThrough,

          transitionSequence,

          lastTransitionId:
            transitionId
        };

        const headHash =
          sha256(
            stableStringify(
              biologicalRouteHeadBody(
                nextHead
              )
            )
          );

        const at =
          new Date().toISOString();

        this.db.prepare(`
          INSERT INTO biological_route_transitions(
            route_id,
            transition_sequence,
            transition_id,
            from_state,
            to_state,
            authority_epoch,
            active_from_us,
            route_barrier_us,
            gap_from_us,
            gap_through_us,
            reason,
            transition_sha256,
            created_at
          )
          VALUES(
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `).run(
          transition.routeId,
          transition.transitionSequence,
          transitionId,
          transition.fromState,
          transition.toState,
          transition.authorityEpoch,
          transition.activeFromUs,
          transition.routeBarrierUs,
          transition.gapFromUs,
          transition.gapThroughUs,
          transition.reason,
          transitionHash,
          at
        );

        const updated =
          this.db.prepare(`
            UPDATE biological_routes
            SET
              authority_epoch=?,
              state=?,
              active_from_us=?,
              route_barrier_us=?,
              gap_from_us=?,
              gap_through_us=?,
              transition_sequence=?,
              last_transition_id=?,
              head_sha256=?,
              updated_at=?
            WHERE
              route_id=? AND
              transition_sequence=? AND
              last_transition_id=?
          `).run(
            nextHead.authorityEpoch,
            nextHead.state,
            nextHead.activeFromUs,
            nextHead.routeBarrierUs,
            nextHead.gapFromUs,
            nextHead.gapThroughUs,
            nextHead.transitionSequence,
            nextHead.lastTransitionId,
            headHash,
            at,
            current.routeId,
            current.transitionSequence,
            current.lastTransitionId
          );

        if (
          updated.changes !==
            1
        ) {
          throw Object.assign(
            new Error(
              'biological route transition compare-and-swap failed'
            ),
            {
              code:
                'BIOLOGICAL_ROUTE_CONFLICT'
            }
          );
        }

        return this.getBiologicalRoute(
          routeId
        );
      }
    );

    this.markWriteSuccess();

    return result;
  }


  acknowledgeBiologicalRouteBoundary({
    routeId,
    checkpointHash,
    transitionId,
    committedThroughUs,
    semantics
  }) {
    this.assertOpen();

    const result = this.withTransaction(
      () => {
        const route =
          this.getBiologicalRoute(
            routeId
          );

        if (!route) {
          throw Object.assign(
            new Error(
              'unknown biological route'
            ),
            {
              code:
                'BIOLOGICAL_ROUTE_UNKNOWN'
            }
          );
        }

        if (
          ![
            'DEGRADED',
            'EVIDENCE_GAP',
            'CLOSED'
          ].includes(
            route.state
          ) ||
          route.routeBarrierUs ==
            null
        ) {
          throw Object.assign(
            new Error(
              'biological route has no acknowledgeable boundary'
            ),
            {
              code:
                'BIOLOGICAL_ROUTE_BOUNDARY'
            }
          );
        }

        const expectedSemantics =
          route.state ===
            'CLOSED'
            ? 'COMPLETE_END'
            : 'UNKNOWN_INPUT';

        if (
          semantics !==
            expectedSemantics
        ) {
          throw Object.assign(
            new Error(
              'route boundary acknowledgement semantics do not match route state'
            ),
            {
              code:
                'BIOLOGICAL_ROUTE_BOUNDARY_SEMANTICS'
            }
          );
        }

        if (
          route.boundaryAck
        ) {
          if (
            route.boundaryAck.checkpointHash ===
              checkpointHash &&
            route.boundaryAck.transitionId ===
              transitionId &&
            route.boundaryAck.committedThroughUs ===
              Number(
                committedThroughUs
              ) &&
            route.boundaryAck.semantics ===
              semantics
          ) {
            return route.boundaryAck;
          }

          throw Object.assign(
            new Error(
              'route boundary was already acknowledged with different committed evidence'
            ),
            {
              code:
                'BIOLOGICAL_ROUTE_BOUNDARY_CONFLICT'
            }
          );
        }

        const committedThrough =
          Number(
            committedThroughUs
          );

        const requiredThrough =
          route.state ===
            'EVIDENCE_GAP'
            ? route.gapThroughUs
            : route.routeBarrierUs;

        if (
          !Number.isSafeInteger(
            committedThrough
          ) ||
          committedThrough <
            requiredThrough ||
          typeof checkpointHash !==
            'string' ||
          !/^[0-9a-f]{64}$/.test(
            checkpointHash
          ) ||
          typeof transitionId !==
            'string' ||
          !transitionId ||
          transitionId.length >
            256
        ) {
          throw Object.assign(
            new Error(
              'route boundary acknowledgement is invalid or precedes the unavailable interval'
            ),
            {
              code:
                'BIOLOGICAL_ROUTE_BOUNDARY_ACK'
            }
          );
        }

        const consumer =
          this.getBiologicalConsumer(
            route.consumerId
          );

        if (!consumer) {
          throw Object.assign(
            new Error(
              'route consumer disappeared before boundary acknowledgement'
            ),
            {
              code:
                'BIOLOGICAL_ROUTE_CONSUMER'
            }
          );
        }

        const checkpoint =
          this.db.prepare(`
            SELECT checkpoint_id
            FROM checkpoints
            WHERE
              core_id=? AND
              blob_hash=?
            LIMIT 1
          `).get(
            consumer.coreId,
            checkpointHash
          );

        if (!checkpoint) {
          throw Object.assign(
            new Error(
              'route boundary acknowledgement is not bound to a durable consumer checkpoint'
            ),
            {
              code:
                'BIOLOGICAL_ROUTE_BOUNDARY_CHECKPOINT'
            }
          );
        }

        const ack = {
          routeId:
            route.routeId,

          transitionSequence:
            route.transitionSequence,

          consumerId:
            route.consumerId,

          boundaryState:
            route.state,

          routeBarrierUs:
            route.routeBarrierUs,

          committedThroughUs:
            committedThrough,

          checkpointHash,

          transitionId,

          semantics
        };

        const body =
          biologicalRouteBoundaryAckBody(
            ack
          );

        const ackId =
          `sha256:${sha256(
            stableStringify(
              body
            )
          )}`;

        const ackHash =
          sha256(
            stableStringify({
              ...body,
              ackId
            })
          );

        const at =
          new Date().toISOString();

        this.db.prepare(`
          INSERT INTO biological_route_boundary_acks(
            route_id,
            transition_sequence,
            ack_id,
            consumer_id,
            boundary_state,
            route_barrier_us,
            committed_through_us,
            checkpoint_hash,
            transition_id,
            semantics,
            ack_sha256,
            created_at
          )
          VALUES(
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `).run(
          ack.routeId,
          ack.transitionSequence,
          ackId,
          ack.consumerId,
          ack.boundaryState,
          ack.routeBarrierUs,
          ack.committedThroughUs,
          ack.checkpointHash,
          ack.transitionId,
          ack.semantics,
          ackHash,
          at
        );

        return this.biologicalRouteBoundaryAckFromRow(
          this.db.prepare(`
            SELECT *
            FROM biological_route_boundary_acks
            WHERE
              route_id=? AND
              transition_sequence=?
          `).get(
            route.routeId,
            route.transitionSequence
          )
        );
      }
    );

    this.markWriteSuccess();

    return result;
  }


  computeBiologicalSafeCompletenessFrontier({
    consumerId
  }) {
    this.assertOpen();

    const consumer =
      this.getBiologicalConsumer(
        consumerId
      );

    if (!consumer) {
      throw Object.assign(
        new Error(
          'unknown biological consumer'
        ),
        {
          code:
            'BIOLOGICAL_CONSUMER_UNKNOWN'
        }
      );
    }

    const routes =
      this.listBiologicalRoutes({
        consumerId,
        required:
          true
      }).filter(
        route =>
          route.state !==
            'RETIRED'
      );

    const active = [];
    const blockers = [];
    const released = [];

    for (
      const route of routes
    ) {
      if (
        route.state ===
          'ACTIVE'
      ) {
        const progress =
          this.getBiologicalStreamProgress({
            organismId:
              route.organismId,

            producerStreamId:
              route.producerStreamId,

            authorityEpoch:
              route.authorityEpoch
          });

        if (
          !progress ||
          progress.finalizedThroughUs <
            route.activeFromUs
        ) {
          blockers.push(
            Object.freeze({
              routeId:
                route.routeId,

              state:
                route.state,

              reason:
                'STREAM_PROGRESS_INCOMPLETE',

              routeBarrierUs:
                null
            })
          );

          continue;
        }

        active.push(
          Object.freeze({
            routeId:
              route.routeId,

            producerStreamId:
              route.producerStreamId,

            frontierUs:
              progress.finalizedThroughUs,

            progressId:
              progress.progressId
          })
        );

        continue;
      }

      if (
        [
          'DEGRADED',
          'EVIDENCE_GAP',
          'CLOSED'
        ].includes(
          route.state
        )
      ) {
        if (
          !route.boundaryAck
        ) {
          blockers.push(
            Object.freeze({
              routeId:
                route.routeId,

              state:
                route.state,

              reason:
                'ROUTE_BOUNDARY_UNACKNOWLEDGED',

              routeBarrierUs:
                route.routeBarrierUs
            })
          );

        } else {
          released.push(
            Object.freeze({
              routeId:
                route.routeId,

              state:
                route.state,

              routeBarrierUs:
                route.routeBarrierUs,

              committedThroughUs:
                route.boundaryAck.committedThroughUs,

              semantics:
                route.boundaryAck.semantics
            })
          );
        }
      }
    }

    const missingProgress =
      blockers.some(
        blocker =>
          blocker.reason ===
            'STREAM_PROGRESS_INCOMPLETE'
      );

    if (
      missingProgress
    ) {
      return Object.freeze({
        consumerId,
        complete:
          false,
        unconstrained:
          false,
        frontierUs:
          null,
        activeRoutes:
          Object.freeze(active),
        blockers:
          Object.freeze(blockers),
        releasedRoutes:
          Object.freeze(released)
      });
    }

    const frontierCandidates = [
      ...active.map(
        value =>
          value.frontierUs
      ),
      ...blockers
        .filter(
          blocker =>
            blocker.routeBarrierUs !=
              null
        )
        .map(
          blocker =>
            blocker.routeBarrierUs
        )
    ];

    const frontierUs =
      frontierCandidates.length
        ? Math.min(
            ...frontierCandidates
          )
        : null;

    return Object.freeze({
      consumerId,
      complete:
        blockers.length ===
        0,
      unconstrained:
        frontierCandidates.length ===
        0,
      frontierUs,
      activeRoutes:
        Object.freeze(active),
      blockers:
        Object.freeze(blockers),
      releasedRoutes:
        Object.freeze(released)
    });
  }


  hasPendingBiologicalRouteEvidence({
    consumerId,
    producerStreamIds,
    throughUs,
    excludingSequence = null
  }) {
    this.assertOpen();
    if (typeof consumerId !== 'string' || !consumerId
      || !Array.isArray(producerStreamIds)
      || producerStreamIds.some(value => typeof value !== 'string' || !value)
      || !Number.isSafeInteger(throughUs) || throughUs < 0
      || (excludingSequence !== null
        && (!Number.isSafeInteger(excludingSequence) || excludingSequence < 1))) {
      throw Object.assign(new Error('pending route-evidence query is invalid'), {
        code: 'BIOLOGICAL_ROUTE_PENDING_QUERY'
      });
    }
    const streams = [...new Set(producerStreamIds)].sort();
    if (streams.length === 0) return false;
    const placeholders = streams.map(() => '?').join(',');
    const excluded = excludingSequence === null ? '' : 'AND d.sequence<>?';
    const row = this.db.prepare(`
      SELECT 1 AS present
      FROM biological_deliveries d
      JOIN biological_envelopes_v2 v ON v.sequence=d.sequence
      WHERE d.consumer_id=?
        AND d.status='PENDING'
        AND v.producer_stream_id IN (${placeholders})
        AND v.order_time_us<=?
        ${excluded}
      LIMIT 1
    `).get(
      consumerId,
      ...streams,
      throughUs,
      ...(excludingSequence === null ? [] : [excludingSequence])
    );
    return Boolean(row);
  }


  biologicalEventFromRow(row, deduplicated = false) {
    const envelope = JSON.parse(row.envelope_json);
    if (sha256(stableStringify(envelope)) !== row.envelope_sha256) {
      throw Object.assign(new Error(`biological event envelope ${row.sequence} is corrupt`), { code: 'BIOLOGICAL_EVENT_CORRUPT' });
    }
    if (sha256(stableStringify(envelope.payload)) !== row.payload_sha256) {
      throw Object.assign(new Error(`biological event payload ${row.sequence} is corrupt`), { code: 'BIOLOGICAL_EVENT_CORRUPT' });
    }
    return Object.freeze({
      ...envelope,
      meta: Object.freeze(envelope.meta || {}),
      ledger: Object.freeze({
        durable: true,
        deduplicated,
        envelopeHash: `sha256:${row.envelope_sha256}`,
        payloadHash: `sha256:${row.payload_sha256}`,
        provenanceHash: `sha256:${row.provenance_sha256}`
      })
    });
  }

  getBiologicalEventByDeduplicationKey(
    deduplicationKey
  ) {
    if (
      typeof deduplicationKey !==
        'string' ||
      !deduplicationKey ||
      deduplicationKey.length > 256
    ) {
      throw Object.assign(
        new Error('event deduplication key is invalid'),
        { code: 'EVENT_DEDUP_KEY' }
      );
    }

    const row =
      this.db.prepare(`
        SELECT *
        FROM biological_events
        WHERE deduplication_key=?
      `).get(
        deduplicationKey
      );

    return row
      ? this.biologicalEventFromRow(
          row,
          true
        )
      : null;
  }

  registerBiologicalConsumer({
    consumerId,
    coreId,
    topics = [],
    required = true,
    authorityEpoch = 0,
    backfillInactiveGap = false
  }) {
    if (typeof consumerId !== 'string' || !consumerId || consumerId.length > 200) throw Object.assign(new Error('invalid biological consumer id'), { code: 'BIOLOGICAL_CONSUMER_ID' });
    if (typeof coreId !== 'string' || !coreId) throw Object.assign(new Error('invalid biological consumer core'), { code: 'BIOLOGICAL_CONSUMER_CORE' });
    const normalizedTopics = [...new Set(topics.map(String))].sort();
    const topicsJson = stableStringify(normalizedTopics);
    const topicsHash = sha256(topicsJson);
    const at = new Date().toISOString();
    return this.withTransaction(() => {
      const existing = this.db.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?').get(consumerId);
      if (existing && existing.core_id !== coreId) throw Object.assign(new Error('biological consumer identity changed core'), { code: 'BIOLOGICAL_CONSUMER_MISMATCH' });
      let activationBackfilled = 0;
      if (!existing) {
        const highWater = Number(this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM biological_events').get()?.value || 0);
        this.db.prepare(`INSERT INTO biological_consumers(consumer_id, core_id, required, active, topics_json, topics_sha256,
          cursor, authority_epoch, registered_at, updated_at) VALUES(?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`).run(
          consumerId, coreId, required ? 1 : 0, topicsJson, topicsHash, highWater, Number(authorityEpoch) || 0, at, at
        );
      } else {
        if (backfillInactiveGap === true) {
          activationBackfilled = Number(this.db.prepare(`
            INSERT OR IGNORE INTO biological_deliveries(
              sequence,
              consumer_id
            )
            SELECT
              sequence,
              ?
            FROM biological_events
            WHERE sequence>?
          `).run(
            consumerId,
            Number(existing.cursor) || 0
          ).changes || 0);
        }
        this.db.prepare(`UPDATE biological_consumers SET required=?, active=1, topics_json=?, topics_sha256=?, authority_epoch=?, updated_at=?
          WHERE consumer_id=?`).run(required ? 1 : 0, topicsJson, topicsHash, Number(authorityEpoch) || 0, at, consumerId);
      }
      return {
        ...this.getBiologicalConsumer(consumerId),
        activationBackfilled
      };
    });
  }

  getBiologicalConsumer(consumerId) {
    const row = this.db.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?').get(consumerId);
    return row ? {
      consumerId: row.consumer_id, coreId: row.core_id, required: Boolean(row.required), active: Boolean(row.active),
      topics: JSON.parse(row.topics_json), topicsHash: row.topics_sha256, cursor: Number(row.cursor) || 0,
      authorityEpoch: Number(row.authority_epoch) || 0, checkpointHash: row.checkpoint_hash || null,
      registeredAt: row.registered_at, updatedAt: row.updated_at
    } : null;
  }

  deactivateBiologicalConsumer(
    consumerId
  ) {
    const consumer =
      this.getBiologicalConsumer(
        consumerId
      );

    if (!consumer) {
      throw Object.assign(
        new Error(
          'biological consumer is not registered'
        ),
        {
          code:
            'BIOLOGICAL_CONSUMER_UNKNOWN'
        }
      );
    }

    const at =
      new Date().toISOString();

    const highWater =
      Number(
        this.db.prepare(`
          SELECT COALESCE(
            MAX(sequence),
            0
          ) AS value
          FROM biological_events
        `).get()?.value || 0
      );

    this.withTransaction(() => {
      this.db.prepare(`
        UPDATE biological_consumers
        SET
          active=0,
          required=0,
          updated_at=?
        WHERE consumer_id=?
      `).run(
        at,
        consumerId
      );
    });

    this.markWriteSuccess();

    return {
      consumerId,
      highWater,
      consumer:
        this.getBiologicalConsumer(
          consumerId
        )
    };
  }


  resynchronizeResidentBiologicalConsumer({
    residencyId,
    checkpointHash,
    runtimeRevision
  }) {
    const resident =
      this.getResident(
        residencyId
      );

    if (!resident) {
      throw Object.assign(
        new Error(
          `unknown resident: ${residencyId}`
        ),
        {
          code:
            'RESIDENT_UNKNOWN'
        }
      );
    }

    if (
      resident.checkpointHash !==
        checkpointHash
    ) {
      throw Object.assign(
        new Error(
          'resident resynchronization checkpoint changed'
        ),
        {
          code:
            'RESIDENT_CHECKPOINT_MISMATCH'
        }
      );
    }

    if (
      !Number.isSafeInteger(
        runtimeRevision
      ) ||
      runtimeRevision < 1
    ) {
      throw Object.assign(
        new Error(
          'resident resynchronization runtime revision is invalid'
        ),
        {
          code:
            'RESIDENT_RESYNC_REVISION'
        }
      );
    }

    const consumer =
      this.getBiologicalConsumer(
        residencyId
      );

    if (!consumer) {
      throw Object.assign(
        new Error(
          'resident biological consumer is unavailable'
        ),
        {
          code:
            'BIOLOGICAL_CONSUMER_UNKNOWN'
        }
      );
    }

    const at =
      new Date().toISOString();

    const resyncId =
      crypto.randomUUID();

    const highWater =
      Number(
        this.db.prepare(`
          SELECT COALESCE(
            MAX(sequence),
            0
          ) AS value
          FROM biological_events
        `).get()?.value || 0
      );

    const pending =
      this.db.prepare(`
        SELECT
          COUNT(*) AS count,
          MIN(sequence) AS minimum,
          MAX(sequence) AS maximum
        FROM biological_deliveries
        WHERE
          consumer_id=? AND
          status='PENDING'
      `).get(
        residencyId
      );

    const abandonedCount =
      Number(
        pending?.count || 0
      );

    const firstAbandonedSequence =
      pending?.minimum == null
        ? null
        : Number(
            pending.minimum
          );

    const lastAbandonedSequence =
      pending?.maximum == null
        ? null
        : Number(
            pending.maximum
          );

    this.withTransaction(() => {
      /*
       * Biological delivery v1 only has PENDING and
       * ACKED states.
       *
       * A controlled L0 resynchronization therefore
       * records abandoned deliveries as ACKED with a
       * cryptographically unambiguous administrative
       * transition marker, while the dedicated
       * resident_resynchronizations table preserves
       * the fact that these events were NOT applied
       * to physiology.
       */
      this.db.prepare(`
        UPDATE biological_deliveries
        SET
          status='ACKED',
          transition_id=?,
          checkpoint_hash=?,
          acknowledged_at=?
        WHERE
          consumer_id=? AND
          status='PENDING'
      `).run(
        `resident-resync-abandon:${resyncId}`,
        checkpointHash,
        at,
        residencyId
      );

      this.db.prepare(`
        UPDATE biological_consumers
        SET
          cursor=?,
          required=0,
          active=0,
          authority_epoch=0,
          checkpoint_hash=?,
          updated_at=?
        WHERE consumer_id=?
      `).run(
        highWater,
        checkpointHash,
        at,
        residencyId
      );

      this.db.prepare(`
        INSERT INTO resident_resynchronizations(
          resync_id,
          residency_id,
          from_cursor,
          to_cursor,
          abandoned_count,
          first_abandoned_sequence,
          last_abandoned_sequence,
          checkpoint_hash,
          runtime_revision,
          created_at
        )
        VALUES(
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        resyncId,
        residencyId,
        consumer.cursor,
        highWater,
        abandonedCount,
        firstAbandonedSequence,
        lastAbandonedSequence,
        checkpointHash,
        runtimeRevision,
        at
      );

      this.db.prepare(`
        INSERT INTO recovery_records(
          type,
          core_id,
          detail_json,
          created_at
        )
        VALUES(
          'resident.biological-resync',
          ?,
          ?,
          ?
        )
      `).run(
        resident.coreId,
        JSON.stringify({
          resyncId,
          residencyId,
          fromCursor:
            consumer.cursor,
          toCursor:
            highWater,
          abandonedCount,
          firstAbandonedSequence,
          lastAbandonedSequence,
          checkpointHash,
          runtimeRevision,
          inventedBiologicalTime:
            false
        }),
        at
      );
    });

    this.markWriteSuccess();

    return {
      resyncId,
      residencyId,
      fromCursor:
        consumer.cursor,
      toCursor:
        highWater,
      abandonedCount,
      firstAbandonedSequence,
      lastAbandonedSequence,
      checkpointHash,
      runtimeRevision
    };
  }


  beginResidentColdBacklogReplay({
    residencyId,
    coreId,
    checkpointHash,
    runtimeRevision,
    maximumPending
  }) {
    if (
      residencyId !== 'resident:chronobiology' ||
      coreId !== 'chronobiology' ||
      !/^[0-9a-f]{64}$/.test(String(checkpointHash || '')) ||
      !Number.isSafeInteger(runtimeRevision) ||
      runtimeRevision < 1 ||
      !Number.isSafeInteger(maximumPending) ||
      maximumPending < 1 ||
      maximumPending > 8192
    ) {
      throw Object.assign(
        new Error('cold backlog replay contract is invalid'),
        { code: 'RESIDENT_COLD_REPLAY_CONTRACT' }
      );
    }

    const at = new Date().toISOString();
    const replayId = crypto.randomUUID();
    let result;
    try {
      result = this.withTransaction(() => {
        const resident = this.db.prepare(`
          SELECT residency_id, core_id, status, checkpoint_hash
          FROM resident_instances
          WHERE residency_id=?
        `).get(residencyId);
        const consumer = this.db.prepare(`
          SELECT consumer_id, core_id, required, active, cursor, authority_epoch,
            checkpoint_hash
          FROM biological_consumers
          WHERE consumer_id=?
        `).get(residencyId);
        const pending = this.db.prepare(`
          SELECT COUNT(*) count, MIN(sequence) minimum, MAX(sequence) maximum
          FROM biological_deliveries
          WHERE consumer_id=? AND status='PENDING'
        `).get(residencyId);
        const authorityCount = Number(this.db.prepare(`
          SELECT COUNT(*) count FROM authority WHERE core_id=?
        `).get(coreId)?.count || 0);
        const pendingOutputCount = Number(this.db.prepare(`
          SELECT COUNT(*) count
          FROM biological_outbox_intents
          WHERE producer_core_id=? AND status='PENDING'
        `).get(coreId)?.count || 0);
        const pendingCount = Number(pending?.count || 0);

        if (
          resident?.core_id !== coreId ||
          resident?.status !== 'QUARANTINED' ||
          resident?.checkpoint_hash !== checkpointHash ||
          consumer?.core_id !== coreId ||
          Number(consumer?.required) !== 0 ||
          Number(consumer?.active) !== 1 ||
          Number(consumer?.authority_epoch) !== 0 ||
          consumer?.checkpoint_hash !== checkpointHash ||
          authorityCount !== 0 ||
          pendingOutputCount !== 0 ||
          pendingCount < 1 ||
          pendingCount > maximumPending
        ) {
          throw Object.assign(
            new Error('cold backlog replay state is not contained'),
            { code: 'RESIDENT_COLD_REPLAY_STATE' }
          );
        }

        const detail = {
          replayId,
          residencyId,
          checkpointHash,
          runtimeRevision,
          pendingCount,
          firstPendingSequence: pending?.minimum == null ? null : Number(pending.minimum),
          lastPendingSequence: pending?.maximum == null ? null : Number(pending.maximum),
          fromCursor: Number(consumer.cursor) || 0,
          maximumPending,
          abandonedCount: 0,
          inventedBiologicalTime: false,
          authorityChanged: false
        };
        const updated = this.db.prepare(`
          UPDATE resident_instances
          SET status='RECOVERING', updated_at=?
          WHERE residency_id=? AND status='QUARANTINED'
        `).run(at, residencyId);
        if (updated.changes !== 1) {
          throw Object.assign(
            new Error('cold backlog replay lost the resident fence'),
            { code: 'RESIDENT_IDENTITY_CONFLICT' }
          );
        }
        this.db.prepare(`
          INSERT INTO recovery_records(type, core_id, detail_json, created_at)
          VALUES('resident.cold-backlog-replay-begin', ?, ?, ?)
        `).run(coreId, JSON.stringify(detail), at);
        return detail;
      });
    } catch (error) {
      this.markWriteFailure(error);
      throw error;
    }
    this.markWriteSuccess();
    return result;
  }


  beginExactR147FrameBoundaryBacklogReplay({
    residencyId,
    coreId,
    checkpointHash,
    runtimeRevision,
    maximumPending
  }) {
    const expected = Object.freeze({
      residencyId: 'resident:homeos', coreId: 'HOMEOS',
      instanceId: '3f32bdc9-fa49-4eea-8c13-b9afe6b47c0f',
      version: '0.2.0-p1r0-shadow.1', stateSchema: 2,
      moduleRelativePath: 'cores/p1-r0/homeos-shadow/index.js',
      moduleHash: 'sha256:28ce93b507a070fef823e40cce3e7368928466077fed943c98a1a88b5a84299a',
      manifestHash: 'sha256:36a34d27e58035063c94cbf2acc7f8646679ee472b1d03f0459c9b4ccaa79179',
      packagePolicyHash: 'sha256:1afd6096fed7727491847e702d2506aa9492f8ad7d1424300b99ca3645d8b161',
      checkpointGeneration: 78,
      checkpointHash: 'd4805d5951a38fc4e5502fb3b787d7dc093e3dc9bf5ca0fb6eb4bbe815563f61',
      checkpointId: 'homeos-r147-frame-boundary-repair-78', checkpointBytes: 3943,
      inputCursor: 4574287, consumerCursor: 4574290,
      topics: Object.freeze(['metab.energy.availability.v1', 'metab.energy.reserve.v1',
        'runtime.homeos.shadow-activation', 'runtime.organism.binding']),
      topicsHash: 'abea82189093d4bb54bee213ed9f9a7ebdd9b2b0b76f6f77dcc2762555e75231',
      pendingCount: 492, firstPendingSequence: 4574291, lastPendingSequence: 4575520,
      repairRecordId: 231,
      repairId: 'homeos-r147-committed-metab-frame-boundary-v1'
    });
    if (residencyId !== expected.residencyId || coreId !== expected.coreId ||
        checkpointHash !== expected.checkpointHash || runtimeRevision !== 147 ||
        maximumPending !== 1023) {
      throw Object.assign(new Error('R147 frame-boundary replay contract is invalid'), {
        code: 'P1_R147_FRAME_BOUNDARY_REPLAY_CONTRACT'
      });
    }
    const at = new Date().toISOString();
    const replayId = crypto.randomUUID();
    let result;
    try {
      result = this.withTransaction(() => {
        const resident = this.db.prepare('SELECT * FROM resident_instances WHERE residency_id=?')
          .get(residencyId);
        const consumer = this.db.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?')
          .get(residencyId);
        const checkpoint = this.db.prepare(`SELECT * FROM resident_checkpoints
          WHERE residency_id=? AND generation=?`).get(residencyId, expected.checkpointGeneration);
        const pending = this.db.prepare(`SELECT d.sequence,e.topic
          FROM biological_deliveries d JOIN biological_events e ON e.sequence=d.sequence
          WHERE d.consumer_id=? AND d.status='PENDING' ORDER BY d.sequence`).all(residencyId);
        const otherPending = Number(this.db.prepare(`SELECT COUNT(*) count FROM biological_deliveries
          WHERE consumer_id!=? AND status='PENDING'`).get(residencyId)?.count || 0);
        const markers = expected.topics.map(() => '?').join(',');
        const eligibleReplayCount = Number(this.db.prepare(`SELECT COUNT(*) count
          FROM biological_events WHERE sequence>? AND topic IN (${markers})`)
          .get(expected.consumerCursor, ...expected.topics)?.count || 0);
        const invalidPending = Number(this.db.prepare(`SELECT COUNT(*) count
          FROM biological_deliveries d JOIN biological_events e ON e.sequence=d.sequence
          WHERE d.consumer_id=? AND d.status='PENDING' AND
            e.topic NOT IN (${markers})`).get(residencyId, ...expected.topics)?.count || 0);
        const highWater = Number(this.db.prepare(
          'SELECT COALESCE(MAX(sequence),0) value FROM biological_events'
        ).get()?.value || 0);
        const authorityCount = Number(this.db.prepare(`SELECT COUNT(*) count FROM authority
          WHERE core_id IN ('METAB','HOMEOS','INTERO','sntss','chronobiology')`).get()?.count || 0);
        const pendingOutputCount = Number(this.db.prepare(`SELECT COUNT(*) count
          FROM biological_outbox_intents WHERE status!='PUBLISHED'`).get()?.count || 0);
        const repair = this.db.prepare(`SELECT id,type,core_id,detail_json FROM recovery_records
          WHERE id=?`).get(expected.repairRecordId);
        let repairDetail = null;
        try { repairDetail = JSON.parse(repair?.detail_json || 'null'); } catch {}
        if (
          resident?.core_id !== coreId || resident?.instance_id !== expected.instanceId ||
          resident?.version !== expected.version || Number(resident?.state_schema) !== expected.stateSchema ||
          resident?.module_relative_path !== expected.moduleRelativePath ||
          resident?.module_hash !== expected.moduleHash || resident?.manifest_hash !== expected.manifestHash ||
          resident?.package_policy_hash !== expected.packagePolicyHash ||
          resident?.status !== 'RESYNC_REQUIRED' ||
          Number(resident?.checkpoint_generation) !== expected.checkpointGeneration ||
          resident?.checkpoint_hash !== expected.checkpointHash ||
          checkpoint?.checkpoint_id !== expected.checkpointId ||
          checkpoint?.instance_id !== expected.instanceId || checkpoint?.version !== expected.version ||
          Number(checkpoint?.state_schema) !== expected.stateSchema ||
          Number(checkpoint?.generation) !== expected.checkpointGeneration ||
          checkpoint?.blob_hash !== expected.checkpointHash ||
          Number(checkpoint?.byte_length) !== expected.checkpointBytes ||
          Number(checkpoint?.input_cursor) !== expected.inputCursor ||
          consumer?.core_id !== coreId || Number(consumer?.required) !== 0 ||
          Number(consumer?.active) !== 0 || Number(consumer?.cursor) !== expected.consumerCursor ||
          Number(consumer?.authority_epoch) !== 0 || consumer?.topics_sha256 !== expected.topicsHash ||
          consumer?.checkpoint_hash !== expected.checkpointHash ||
          pending.length !== expected.pendingCount ||
          Number(pending[0]?.sequence) !== expected.firstPendingSequence ||
          Number(pending.at(-1)?.sequence) !== expected.lastPendingSequence ||
          pending.some(row => !expected.topics.includes(row.topic)) ||
          eligibleReplayCount !== expected.pendingCount || eligibleReplayCount > maximumPending ||
          invalidPending !== 0 || otherPending !== 0 || highWater !== 4575520 ||
          authorityCount !== 0 || pendingOutputCount !== 0 ||
          Number(repair?.id) !== expected.repairRecordId ||
          repair?.type !== 'resident.r147-frame-boundary-repaired' || repair?.core_id !== coreId ||
          repairDetail?.repairId !== expected.repairId ||
          repairDetail?.repairedCheckpointHash !== expected.checkpointHash ||
          repairDetail?.pendingDeliveriesPreserved !== expected.pendingCount ||
          repairDetail?.biologicalEventsDeleted !== 0 || repairDetail?.abandonedCount !== 0 ||
          repairDetail?.inventedBiologicalTime !== false || repairDetail?.authorityChanged !== false
        ) {
          throw Object.assign(new Error('R147 frame-boundary replay state changed'), {
            code: 'P1_R147_FRAME_BOUNDARY_REPLAY_STATE'
          });
        }
        const detail = {
          cohort: 'r147-homeos-frame-boundary-continuation-v1', replayId, residencyId,
          repairRecordId: expected.repairRecordId, repairId: expected.repairId,
          checkpointHash, checkpointGeneration: expected.checkpointGeneration,
          runtimeRevision, fromCursor: expected.consumerCursor, toCursor: highWater,
          pendingCount: expected.pendingCount, eligibleReplayCount, maximumPending,
          abandonedCount: 0, inventedBiologicalTime: false, authorityChanged: false
        };
        const updated = this.db.prepare(`UPDATE resident_instances SET status='RECOVERING',updated_at=?
          WHERE residency_id=? AND status='RESYNC_REQUIRED' AND checkpoint_hash=?`)
          .run(at, residencyId, checkpointHash);
        if (updated.changes !== 1) throw Object.assign(
          new Error('R147 frame-boundary replay lost the resident fence'),
          { code: 'RESIDENT_IDENTITY_CONFLICT' }
        );
        this.db.prepare(`INSERT INTO recovery_records(type,core_id,detail_json,created_at)
          VALUES('resident.r147-frame-boundary-replay-begin',?,?,?)`)
          .run(coreId, JSON.stringify(detail), at);
        return detail;
      });
    } catch (error) {
      this.markWriteFailure(error);
      throw error;
    }
    this.markWriteSuccess();
    return result;
  }


  beginExactR147ContinuationBacklogReplay({
    residencyId,
    coreId,
    checkpointHash,
    runtimeRevision,
    maximumPending
  }) {
    const expectedByResidency = Object.freeze({
      'resident:homeos': Object.freeze({
        coreId: 'HOMEOS', instanceId: '3f32bdc9-fa49-4eea-8c13-b9afe6b47c0f',
        version: '0.2.0-p1r0-shadow.1', stateSchema: 2,
        moduleRelativePath: 'cores/p1-r0/homeos-shadow/index.js',
        moduleHash: 'sha256:28ce93b507a070fef823e40cce3e7368928466077fed943c98a1a88b5a84299a',
        manifestHash: 'sha256:36a34d27e58035063c94cbf2acc7f8646679ee472b1d03f0459c9b4ccaa79179',
        packagePolicyHash: 'sha256:1afd6096fed7727491847e702d2506aa9492f8ad7d1424300b99ca3645d8b161',
        checkpointGeneration: 76,
        checkpointHash: '970a580617d3c298bd7ce3bee5a56791bbe9565d25df7a73cde204e7d41d7f76',
        checkpointId: 'b3a93ad3-a9ce-443d-9e51-a5ec600b0908', checkpointBytes: 47620,
        inputCursor: 4574287, consumerCursor: 4574290,
        topics: Object.freeze(['metab.energy.availability.v1', 'metab.energy.reserve.v1',
          'runtime.homeos.shadow-activation', 'runtime.organism.binding']),
        topicsHash: 'abea82189093d4bb54bee213ed9f9a7ebdd9b2b0b76f6f77dcc2762555e75231',
        pendingCount: 1230, firstPendingSequence: 4574291, lastPendingSequence: 4575520,
        eligibleReplayCount: 492, invalidPendingCount: 738,
        replayBeginRecordId: 215, failureRecordId: 216,
        failureSequence: 4574291, failureCode: 'RESIDENT_REPLAY_BOUNDED'
      }),
      'resident:sntss': Object.freeze({
        coreId: 'sntss', instanceId: '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
        version: '0.5.0-i4g1', stateSchema: 5,
        moduleRelativePath: 'cores/sntss/i4g/index.js',
        moduleHash: 'sha256:4e96f1882ddbe35fc0e8f2afcdabae2b5e75812d8e9a392b09bcc8040b335ea7',
        manifestHash: 'sha256:c1d0db3d4520556cb022864f4d1eb487a99628d61f3564942aa65cc0f204499a',
        packagePolicyHash: 'sha256:ba12622fcc9c782c8c48f0544a5b019c96dc198dcbb7fb209c1dad47de64639d',
        checkpointGeneration: 2891083,
        checkpointHash: '16a0224ff3f8dbeac51ebb27c05ad6e5bef8a1d831f308367470f7cb639cd5a0',
        checkpointId: 'cb00ab19-2a1e-45cd-9e03-7c31a3c0e629', checkpointBytes: 4971,
        inputCursor: 4574207, consumerCursor: 4574211,
        topics: Object.freeze(['runtime.organism.binding', 'runtime.sntss.continuity-genesis',
          'runtime.time.pulse']),
        topicsHash: 'b752d8eebb09ac925c4c193810d31f5527315e42e36fbedafa1f30ef25a97501',
        pendingCount: 1294, firstPendingSequence: 4574212, lastPendingSequence: 4575520,
        eligibleReplayCount: 261, invalidPendingCount: 1033,
        replayBeginRecordId: 218, failureRecordId: 219,
        failureSequence: 4574212, failureCode: 'RESIDENT_REPLAY_BOUNDED'
      })
    });
    const expected = expectedByResidency[residencyId];
    if (!expected || coreId !== expected.coreId || checkpointHash !== expected.checkpointHash ||
        runtimeRevision !== 147 || maximumPending !== 1023) {
      throw Object.assign(new Error('R147 continuation replay contract is invalid'), {
        code: 'P1_R147_CONTINUATION_REPLAY_CONTRACT'
      });
    }
    const at = new Date().toISOString();
    const replayId = crypto.randomUUID();
    let result;
    try {
      result = this.withTransaction(() => {
        const resident = this.db.prepare('SELECT * FROM resident_instances WHERE residency_id=?')
          .get(residencyId);
        const consumer = this.db.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?')
          .get(residencyId);
        const checkpoint = this.db.prepare(`SELECT * FROM resident_checkpoints
          WHERE residency_id=? AND generation=?`).get(residencyId, expected.checkpointGeneration);
        const pending = this.db.prepare(`SELECT d.sequence,e.topic,e.deduplication_key
          FROM biological_deliveries d JOIN biological_events e ON e.sequence=d.sequence
          WHERE d.consumer_id=? AND d.status='PENDING' ORDER BY d.sequence`).all(residencyId);
        const markers = expected.topics.map(() => '?').join(',');
        const eligibleReplayCount = Number(this.db.prepare(`SELECT COUNT(*) count
          FROM biological_events WHERE sequence>? AND topic IN (${markers})`)
          .get(expected.consumerCursor, ...expected.topics)?.count || 0);
        const highWater = Number(this.db.prepare(
          'SELECT COALESCE(MAX(sequence),0) value FROM biological_events'
        ).get()?.value || 0);
        const failure = this.db.prepare(`SELECT id,detail_json FROM recovery_records
          WHERE type='resident.resync-required' AND core_id=? ORDER BY id DESC LIMIT 1`).get(coreId);
        const replayBegin = this.db.prepare(`SELECT id,detail_json FROM recovery_records
          WHERE type='resident.r147-continuation-replay-begin' AND core_id=?
          ORDER BY id DESC LIMIT 1`).get(coreId);
        let failureDetail = null;
        try { failureDetail = JSON.parse(failure?.detail_json || 'null'); } catch {}
        let replayBeginDetail = null;
        try { replayBeginDetail = JSON.parse(replayBegin?.detail_json || 'null'); } catch {}
        const invalidPendingCount = Number(this.db.prepare(`SELECT COUNT(*) count
          FROM biological_deliveries d JOIN biological_events e ON e.sequence=d.sequence
          WHERE d.consumer_id=? AND d.status='PENDING' AND d.sequence>? AND
            e.topic NOT IN (${markers})`).get(
          residencyId, expected.consumerCursor, ...expected.topics
        )?.count || 0);
        const relevantPendingCount = Number(this.db.prepare(`SELECT COUNT(*) count
          FROM biological_deliveries d JOIN biological_events e ON e.sequence=d.sequence
          WHERE d.consumer_id=? AND d.status='PENDING' AND d.sequence>? AND
            e.topic IN (${markers})`).get(
          residencyId, expected.consumerCursor, ...expected.topics
        )?.count || 0);
        const authorityCount = Number(this.db.prepare(`SELECT COUNT(*) count FROM authority
          WHERE core_id IN ('METAB','HOMEOS','INTERO','sntss','chronobiology')`).get()?.count || 0);
        const pendingOutputCount = Number(this.db.prepare(`SELECT COUNT(*) count
          FROM biological_outbox_intents WHERE producer_core_id=? AND status='PENDING'`)
          .get(coreId)?.count || 0);
        if (
          resident?.core_id !== coreId || resident?.instance_id !== expected.instanceId ||
          resident?.version !== expected.version || Number(resident?.state_schema) !== expected.stateSchema ||
          resident?.module_relative_path !== expected.moduleRelativePath ||
          resident?.module_hash !== expected.moduleHash || resident?.manifest_hash !== expected.manifestHash ||
          resident?.package_policy_hash !== expected.packagePolicyHash ||
          resident?.status !== 'RESYNC_REQUIRED' ||
          Number(resident?.checkpoint_generation) !== expected.checkpointGeneration ||
          resident?.checkpoint_hash !== expected.checkpointHash ||
          checkpoint?.checkpoint_id !== expected.checkpointId || checkpoint?.instance_id !== expected.instanceId ||
          checkpoint?.version !== expected.version || Number(checkpoint?.state_schema) !== expected.stateSchema ||
          Number(checkpoint?.generation) !== expected.checkpointGeneration ||
          checkpoint?.blob_hash !== expected.checkpointHash ||
          Number(checkpoint?.byte_length) !== expected.checkpointBytes ||
          Number(checkpoint?.input_cursor) !== expected.inputCursor ||
          consumer?.core_id !== coreId || Number(consumer?.required) !== 0 ||
          Number(consumer?.active) !== 0 || Number(consumer?.cursor) !== expected.consumerCursor ||
          Number(consumer?.authority_epoch) !== 0 || consumer?.topics_sha256 !== expected.topicsHash ||
          consumer?.checkpoint_hash !== expected.checkpointHash ||
          pending.length !== expected.pendingCount ||
          Number(pending[0]?.sequence) !== expected.firstPendingSequence ||
          Number(pending[pending.length - 1]?.sequence) !== expected.lastPendingSequence ||
          relevantPendingCount !== expected.eligibleReplayCount ||
          invalidPendingCount !== expected.invalidPendingCount ||
          eligibleReplayCount !== expected.eligibleReplayCount || eligibleReplayCount > maximumPending ||
          highWater !== 4575520 || Number(failure?.id) !== expected.failureRecordId ||
          failureDetail?.residencyId !== residencyId ||
          failureDetail?.sequence !== expected.failureSequence || failureDetail?.code !== expected.failureCode ||
          Number(replayBegin?.id) !== expected.replayBeginRecordId ||
          replayBeginDetail?.cohort !== 'r147-homeos-sntss-sequential-continuation-v1' ||
          replayBeginDetail?.residencyId !== residencyId ||
          replayBeginDetail?.pendingCount !== (residencyId === 'resident:homeos' ? 2 : 4) ||
          replayBeginDetail?.eligibleReplayCount !== expected.eligibleReplayCount ||
          replayBeginDetail?.abandonedCount !== 0 ||
          replayBeginDetail?.inventedBiologicalTime !== false ||
          replayBeginDetail?.authorityChanged !== false ||
          authorityCount !== 0 || pendingOutputCount !== 0
        ) {
          throw Object.assign(new Error('R147 continuation replay state changed'), {
            code: 'P1_R147_CONTINUATION_REPLAY_STATE'
          });
        }
        const deleted = this.db.prepare(`DELETE FROM biological_deliveries
          WHERE consumer_id=? AND status='PENDING' AND sequence IN (
            SELECT sequence FROM biological_events WHERE sequence>? AND
              topic NOT IN (${markers})
          )`).run(residencyId, expected.consumerCursor, ...expected.topics);
        if (deleted.changes !== expected.invalidPendingCount) {
          throw Object.assign(new Error('R147 invalid backfill prune lost its exact fence'), {
            code: 'P1_R147_CONTINUATION_PRUNE_FENCE'
          });
        }
        const retained = this.db.prepare(`SELECT d.sequence,e.topic
          FROM biological_deliveries d JOIN biological_events e ON e.sequence=d.sequence
          WHERE d.consumer_id=? AND d.status='PENDING' ORDER BY d.sequence`).all(residencyId);
        if (retained.length !== expected.eligibleReplayCount ||
            retained.some(row => !expected.topics.includes(row.topic))) {
          throw Object.assign(new Error('R147 continuation prune changed the replay cohort'), {
            code: 'P1_R147_CONTINUATION_PRUNE_STATE'
          });
        }
        this.db.prepare(`INSERT INTO recovery_records(type,core_id,detail_json,created_at)
          VALUES('resident.r147-invalid-backfill-pruned',?,?,?)`).run(coreId, JSON.stringify({
          cohort: 'r147-post-failure-invalid-delivery-repair-v1', replayId, residencyId,
          sourceReplayBeginRecordId: expected.replayBeginRecordId,
          sourceFailureRecordId: expected.failureRecordId,
          removedInvalidDeliveryCount: expected.invalidPendingCount,
          retainedEligibleDeliveryCount: expected.eligibleReplayCount,
          biologicalEventsDeleted: 0, abandonedCount: 0,
          inventedBiologicalTime: false, authorityChanged: false
        }), at);
        const detail = {
          cohort: 'r147-homeos-sntss-sequential-continuation-v1', replayId, residencyId,
          checkpointHash, checkpointGeneration: expected.checkpointGeneration,
          runtimeRevision, fromCursor: expected.consumerCursor, toCursor: highWater,
          pendingCount: expected.eligibleReplayCount, eligibleReplayCount, maximumPending,
          removedInvalidDeliveryCount: expected.invalidPendingCount,
          abandonedCount: 0, inventedBiologicalTime: false, authorityChanged: false
        };
        const updated = this.db.prepare(`UPDATE resident_instances SET status='RECOVERING',updated_at=?
          WHERE residency_id=? AND status='RESYNC_REQUIRED' AND checkpoint_hash=?`)
          .run(at, residencyId, checkpointHash);
        if (updated.changes !== 1) throw Object.assign(
          new Error('R147 continuation replay lost the resident fence'),
          { code: 'RESIDENT_IDENTITY_CONFLICT' }
        );
        this.db.prepare(`INSERT INTO recovery_records(type,core_id,detail_json,created_at)
          VALUES('resident.r147-continuation-replay-begin',?,?,?)`)
          .run(coreId, JSON.stringify(detail), at);
        return detail;
      });
    } catch (error) {
      this.markWriteFailure(error);
      throw error;
    }
    this.markWriteSuccess();
    return result;
  }


  beginExactR146HomeosBacklogReplay({
    residencyId,
    coreId,
    checkpointHash,
    runtimeRevision
  }) {
    const expected = Object.freeze({
      residencyId: 'resident:homeos',
      coreId: 'HOMEOS',
      instanceId: '3f32bdc9-fa49-4eea-8c13-b9afe6b47c0f',
      version: '0.2.0-p1r0-shadow.1',
      stateSchema: 2,
      moduleRelativePath: 'cores/p1-r0/homeos-shadow/index.js',
      moduleHash: 'sha256:28ce93b507a070fef823e40cce3e7368928466077fed943c98a1a88b5a84299a',
      manifestHash: 'sha256:36a34d27e58035063c94cbf2acc7f8646679ee472b1d03f0459c9b4ccaa79179',
      packagePolicyHash: 'sha256:1afd6096fed7727491847e702d2506aa9492f8ad7d1424300b99ca3645d8b161',
      checkpointGeneration: 42,
      checkpointHash: '562d336fcf6f7184acaf826d29fe0d890d5705b40c3b49aa4a70a41fa3328046',
      inputCursor: 4241113,
      consumerCursor: 4241116,
      prunedConsumerCursor: 4241118,
      topicsHash: 'abea82189093d4bb54bee213ed9f9a7ebdd9b2b0b76f6f77dcc2762555e75231',
      pending: Object.freeze([
        Object.freeze({
          sequence: 4241117,
          topic: 'metab.energy.availability.v1',
          deduplicationKey:
            'core-output:dd4f1feb2e23462bc77206e91d066aa9e88d41ba145228599d7e64ef0a0ed8dd'
        }),
        Object.freeze({
          sequence: 4241118,
          topic: 'metab.energy.reserve.v1',
          deduplicationKey:
            'core-output:63fadd3d778d1132eed2ec1ff533a69825b2fd2524ec16d2b35d81d01e8aeef9'
        })
      ]),
      publishedIntents: Object.freeze([
        Object.freeze({
          producerEventId: 'dd4f1feb2e23462bc77206e91d066aa9e88d41ba145228599d7e64ef0a0ed8dd',
          intentSha256: '3e2897f3a6dfc26d5ea0faea147d8dbd552cad7a10b9028cae5dc6f78e866e21',
          fabricSequence: 4241117,
          streamSequence: 39,
          outputIndex: 1,
          topic: 'metab.energy.availability.v1'
        }),
        Object.freeze({
          producerEventId: '63fadd3d778d1132eed2ec1ff533a69825b2fd2524ec16d2b35d81d01e8aeef9',
          intentSha256: 'e004c64e4fa571ab00e0858dc4e1299ee4b7207f5b24555cf4be778509cad6bc',
          fabricSequence: 4241118,
          streamSequence: 40,
          outputIndex: 2,
          topic: 'metab.energy.reserve.v1'
        })
      ]),
      repairId: 'homeos-r146-route-boundary-continuity-v1'
    });
    const registeredCheckpointHash = this.db.prepare(`SELECT checkpoint_hash
      FROM resident_instances WHERE residency_id=? AND core_id=?`).get(
      expected.residencyId, expected.coreId)?.checkpoint_hash;
    if (
      residencyId !== expected.residencyId ||
      coreId !== expected.coreId ||
      !/^[0-9a-f]{64}$/.test(checkpointHash || '') ||
      (checkpointHash !== expected.checkpointHash &&
        checkpointHash !== registeredCheckpointHash) ||
      runtimeRevision !== 146
    ) {
      throw Object.assign(
        new Error('R146 HOMEOS retained replay contract is invalid'),
        { code: 'P1_HOMEOS_R146_REPLAY_CONTRACT' }
      );
    }

    const at = new Date().toISOString();
    const replayId = crypto.randomUUID();
    let result;
    try {
      result = this.withTransaction(() => {
        const resident = this.db.prepare(`
          SELECT * FROM resident_instances WHERE residency_id=?
        `).get(residencyId);
        const checkpoint = this.db.prepare(`
          SELECT * FROM resident_checkpoints
          WHERE residency_id=? AND generation=?
        `).get(residencyId, expected.checkpointGeneration);
        const consumer = this.db.prepare(`
          SELECT * FROM biological_consumers WHERE consumer_id=?
        `).get(residencyId);
        const pending = this.db.prepare(`
          SELECT d.sequence,d.status,e.topic,e.deduplication_key
          FROM biological_deliveries d
          JOIN biological_events e ON e.sequence=d.sequence
          WHERE d.consumer_id=? AND d.status='PENDING'
          ORDER BY d.sequence
        `).all(residencyId);
        const repair = this.db.prepare(`
          SELECT detail_json FROM recovery_records
          WHERE type='resident.implementation-repaired' AND core_id=?
          ORDER BY id DESC LIMIT 1
        `).get(coreId);
        let repairDetail = null;
        try { repairDetail = JSON.parse(repair?.detail_json || 'null'); } catch {}
        const authorityCount = Number(this.db.prepare(`
          SELECT COUNT(*) count FROM authority
          WHERE core_id IN ('METAB','HOMEOS','INTERO')
        `).get()?.count || 0);
        const pendingOutputCount = Number(this.db.prepare(`
          SELECT COUNT(*) count FROM biological_outbox_intents
          WHERE producer_core_id=? AND status='PENDING'
        `).get(coreId)?.count || 0);
        const deliveryMode = repairDetail?.deliveryMode === 'pruned' ? 'pruned' : 'retained';
        const expectedCheckpointHash = deliveryMode === 'pruned'
          ? repairDetail?.repairedCheckpointHash : expected.checkpointHash;
        const expectedInputCursor = deliveryMode === 'pruned'
          ? expected.prunedConsumerCursor : expected.inputCursor;
        const expectedConsumerCursor = deliveryMode === 'pruned'
          ? expected.prunedConsumerCursor : expected.consumerCursor;
        const retainedPendingMatches = deliveryMode === 'retained' &&
          pending.length === expected.pending.length &&
          pending.every((row, index) =>
            Number(row.sequence) === expected.pending[index].sequence &&
            row.status === 'PENDING' &&
            row.topic === expected.pending[index].topic &&
            row.deduplication_key === expected.pending[index].deduplicationKey);
        let prunedIntentMatches = false;
        if (deliveryMode === 'pruned' && pending.length === 0) {
          const absentEvents = Number(this.db.prepare(`SELECT COUNT(*) count
            FROM biological_events WHERE sequence IN (?,?)`).get(
            ...expected.pending.map(value => value.sequence))?.count || 0) === 0;
          const intentRows = this.db.prepare(`SELECT * FROM biological_outbox_intents
            WHERE producer_event_id IN (?,?) ORDER BY fabric_sequence`).all(
            ...expected.publishedIntents.map(value => value.producerEventId));
          prunedIntentMatches = absentEvents && intentRows.length === expected.publishedIntents.length &&
            intentRows.every((row, index) => {
              let intent;
              try { intent = this.biologicalOutboxIntentFromRow(row); } catch { return false; }
              const exact = expected.publishedIntents[index];
              return row.producer_event_id === exact.producerEventId &&
                row.producer_core_id === 'METAB' &&
                row.producer_instance_id === 'd424c722-ef31-44b0-8201-ba68c418d14a' &&
                row.producer_version === '0.3.0-p1r0-homeos-feed.1' &&
                Number(row.authority_epoch) === 1 &&
                row.producer_stream_id === 'core:METAB:outputs' &&
                Number(row.stream_sequence) === exact.streamSequence &&
                row.transition_id === 'sha256:add174f19c585bfdc3e96158458dd63445f2b89d3944af6762fbccca107580d2' &&
                Number(row.cause_sequence) === 4241116 &&
                Number(row.output_index) === exact.outputIndex &&
                row.topic === exact.topic && row.intent_sha256 === exact.intentSha256 &&
                row.checkpoint_id === 'cc2b2a0d-919b-4944-a37d-b23ef9b9fdcb' &&
                row.checkpoint_hash === '45dd76aa69ef778e0672c588781dbf2d754b77ecbe680c4f61a1c59a0ddc81cb' &&
                Number(row.checkpoint_generation) === 196076 && row.status === 'PUBLISHED' &&
                Number(row.fabric_sequence) === exact.fabricSequence &&
                intent.producerEventId === exact.producerEventId;
            });
        }
        if (
          resident?.core_id !== coreId ||
          resident?.instance_id !== expected.instanceId ||
          resident?.version !== expected.version ||
          Number(resident?.state_schema) !== expected.stateSchema ||
          resident?.module_relative_path !== expected.moduleRelativePath ||
          resident?.module_hash !== expected.moduleHash ||
          resident?.manifest_hash !== expected.manifestHash ||
          resident?.package_policy_hash !== expected.packagePolicyHash ||
          resident?.status !== 'RESYNC_REQUIRED' ||
          Number(resident?.checkpoint_generation) !== expected.checkpointGeneration ||
          resident?.checkpoint_hash !== expectedCheckpointHash ||
          checkpoint?.instance_id !== expected.instanceId ||
          checkpoint?.version !== expected.version ||
          Number(checkpoint?.state_schema) !== expected.stateSchema ||
          checkpoint?.blob_hash !== expectedCheckpointHash ||
          Number(checkpoint?.input_cursor) !== expectedInputCursor ||
          consumer?.core_id !== coreId ||
          Number(consumer?.required) !== 0 ||
          Number(consumer?.active) !== 0 ||
          Number(consumer?.cursor) !== expectedConsumerCursor ||
          Number(consumer?.authority_epoch) !== 0 ||
          consumer?.topics_sha256 !== expected.topicsHash ||
          consumer?.checkpoint_hash !== expectedCheckpointHash ||
          (!retainedPendingMatches && !prunedIntentMatches) ||
          repairDetail?.repairId !== expected.repairId ||
          repairDetail?.repairedCheckpointHash !== expectedCheckpointHash ||
          repairDetail?.pendingDeliveriesPreserved !==
            (deliveryMode === 'retained' ? expected.pending.length : 0) ||
          (deliveryMode === 'pruned' &&
            (repairDetail?.prunedDeliveriesRecovered !== expected.pending.length ||
             JSON.stringify(repairDetail?.sourceIntentSha256) !==
               JSON.stringify(expected.publishedIntents.map(value => value.intentSha256)))) ||
          repairDetail?.abandonedCount !== 0 ||
          repairDetail?.inventedBiologicalTime !== false ||
          repairDetail?.authorityChanged !== false ||
          authorityCount !== 0 ||
          pendingOutputCount !== 0 || checkpointHash !== expectedCheckpointHash
        ) {
          throw Object.assign(
            new Error('R146 HOMEOS retained replay state changed'),
            { code: 'P1_HOMEOS_R146_REPLAY_STATE' }
          );
        }
        const detail = {
          cohort: 'r146-homeos-route-boundary-v1',
          replayId,
          residencyId,
          checkpointHash,
          checkpointGeneration: expected.checkpointGeneration,
          runtimeRevision,
          deliveryMode,
          pendingCount: deliveryMode === 'retained' ? expected.pending.length : 0,
          firstPendingSequence: deliveryMode === 'retained' ? expected.pending[0].sequence : null,
          lastPendingSequence: deliveryMode === 'retained' ? expected.pending.at(-1).sequence : null,
          fromCursor: expectedConsumerCursor,
          toCursor: expectedConsumerCursor,
          maximumPending: expected.pending.length,
          prunedDeliveriesRecovered: deliveryMode === 'pruned' ? expected.pending.length : 0,
          abandonedCount: 0,
          inventedBiologicalTime: false,
          authorityChanged: false
        };
        const changed = this.db.prepare(`
          UPDATE resident_instances SET status='RECOVERING',updated_at=?
          WHERE residency_id=? AND status='RESYNC_REQUIRED'
            AND checkpoint_generation=? AND checkpoint_hash=?
        `).run(at, residencyId, expected.checkpointGeneration, checkpointHash);
        if (changed.changes !== 1) {
          throw Object.assign(
            new Error('R146 HOMEOS retained replay lost its resident fence'),
            { code: 'P1_HOMEOS_R146_REPLAY_ATOMIC' }
          );
        }
        this.db.prepare(`
          INSERT INTO recovery_records(type,core_id,detail_json,created_at)
          VALUES('resident.exact-backlog-replay-begin',?,?,?)
        `).run(coreId, JSON.stringify(detail), at);
        return detail;
      });
    } catch (error) {
      this.markWriteFailure(error);
      throw error;
    }
    this.markWriteSuccess();
    return result;
  }


  listResidentResynchronizations(
    residencyId
  ) {
    return this.db.prepare(`
      SELECT *
      FROM resident_resynchronizations
      WHERE residency_id=?
      ORDER BY created_at, resync_id
    `).all(
      residencyId
    ).map(
      row => ({
        resyncId:
          row.resync_id,
        residencyId:
          row.residency_id,
        fromCursor:
          Number(
            row.from_cursor
          ),
        toCursor:
          Number(
            row.to_cursor
          ),
        abandonedCount:
          Number(
            row.abandoned_count
          ),
        firstAbandonedSequence:
          row.first_abandoned_sequence == null
            ? null
            : Number(
                row.first_abandoned_sequence
              ),
        lastAbandonedSequence:
          row.last_abandoned_sequence == null
            ? null
            : Number(
                row.last_abandoned_sequence
              ),
        checkpointHash:
          row.checkpoint_hash,
        runtimeRevision:
          Number(
            row.runtime_revision
          ),
        createdAt:
          row.created_at
      })
    );
  }


  getBiologicalDelivery(consumerId, sequence) {
    const row = this.db.prepare('SELECT * FROM biological_deliveries WHERE consumer_id=? AND sequence=?').get(consumerId, sequence);
    return row ? {
      consumerId: row.consumer_id, sequence: Number(row.sequence), status: row.status,
      transitionId: row.transition_id || null, checkpointHash: row.checkpoint_hash || null, acknowledgedAt: row.acknowledged_at || null
    } : null;
  }

  advanceBiologicalCursor(consumerId, at = new Date().toISOString()) {
    const consumer = this.db.prepare('SELECT cursor FROM biological_consumers WHERE consumer_id=?').get(consumerId);
    if (!consumer) throw Object.assign(new Error('biological consumer is not registered'), { code: 'BIOLOGICAL_CONSUMER_UNKNOWN' });
    const pending = this.db.prepare(`SELECT MIN(sequence) AS value FROM biological_deliveries
      WHERE consumer_id=? AND status='PENDING' AND sequence>?`).get(consumerId, consumer.cursor)?.value;
    const next = pending == null
      ? this.db.prepare(`SELECT COALESCE(MAX(sequence), ?) AS value FROM biological_deliveries
          WHERE consumer_id=? AND status='ACKED'`).get(consumer.cursor, consumerId)?.value
      : this.db.prepare(`SELECT COALESCE(MAX(sequence), ?) AS value FROM biological_deliveries
          WHERE consumer_id=? AND status='ACKED' AND sequence<?`).get(consumer.cursor, consumerId, pending)?.value;
    const cursor = Math.max(Number(consumer.cursor) || 0, Number(next) || 0);
    this.db.prepare('UPDATE biological_consumers SET cursor=?, updated_at=? WHERE consumer_id=?').run(cursor, at, consumerId);
    return cursor;
  }

  acknowledgeBiologicalEvent({ consumerId, sequence, transitionId = null, checkpointHash = null }) {
    const at = new Date().toISOString();
    return this.withTransaction(() => {
      const delivery = this.db.prepare('SELECT status FROM biological_deliveries WHERE consumer_id=? AND sequence=?').get(consumerId, sequence);
      if (!delivery) return { acknowledged: false, absent: true, cursor: this.getBiologicalConsumer(consumerId)?.cursor || 0 };
      if (delivery.status !== 'ACKED') {
        this.db.prepare(`UPDATE biological_deliveries SET status='ACKED', transition_id=?, checkpoint_hash=?, acknowledged_at=?
          WHERE consumer_id=? AND sequence=? AND status='PENDING'`).run(transitionId, checkpointHash, at, consumerId, sequence);
      }
      return { acknowledged: true, duplicate: delivery.status === 'ACKED', cursor: this.advanceBiologicalCursor(consumerId, at) };
    });
  }

  listPendingBiologicalEvents(consumerId, limit = 256) {
    const boundedLimit = Math.max(1, Math.min(1024, Number(limit) || 256));
    return this.db.prepare(`SELECT e.* FROM biological_events e JOIN biological_deliveries d ON d.sequence=e.sequence
      WHERE d.consumer_id=? AND d.status='PENDING' ORDER BY e.sequence LIMIT ?`).all(consumerId, boundedLimit)
      .map(row => this.biologicalEventFromRow(row, false));
  }

  countPendingBiologicalEvents(consumerId) {
    return Number(this.db.prepare(`
      SELECT COUNT(*) count
      FROM biological_deliveries
      WHERE consumer_id=? AND status='PENDING'
    `).get(consumerId)?.count || 0);
  }

  biologicalLedgerStatus() {
    const events = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(MIN(sequence), 0) AS minimum, COALESCE(MAX(sequence), 0) AS maximum FROM biological_events').get();
    const pending = this.db.prepare("SELECT COUNT(*) AS count FROM biological_deliveries WHERE status='PENDING'").get();
    const consumers = this.db.prepare('SELECT COUNT(*) AS count FROM biological_consumers WHERE active=1').get();
    return {
      protocol: 'stay-biological-ledger-v1', events: Number(events.count), minimumSequence: Number(events.minimum),
      maximumSequence: Number(events.maximum), pendingDeliveries: Number(pending.count), activeConsumers: Number(consumers.count)
    };
  }

  pruneBiologicalEvents({ retainCount = 4096 } = {}) {
    const retained = Math.max(1, Math.min(1000000, Number(retainCount) || 4096));
    return this.withTransaction(() => {
      const required = this.db.prepare('SELECT MIN(cursor) AS value FROM biological_consumers WHERE active=1 AND required=1').get()?.value;
      if (required == null) return { removed: 0, throughSequence: 0, retained };
      const keepBoundary = this.db.prepare('SELECT sequence FROM biological_events ORDER BY sequence DESC LIMIT 1 OFFSET ?').get(retained - 1)?.sequence;
      if (keepBoundary == null) return { removed: 0, throughSequence: 0, retained };
      const throughSequence = Math.min(Number(required) || 0, Number(keepBoundary) - 1);
      if (throughSequence < 1) return { removed: 0, throughSequence: 0, retained };
      const blocked = this.db.prepare(`SELECT COUNT(*) AS count FROM biological_deliveries d
        JOIN biological_consumers c ON c.consumer_id=d.consumer_id
        WHERE d.sequence<=? AND d.status='PENDING' AND c.active=1 AND c.required=1`).get(throughSequence)?.count;
      if (Number(blocked) > 0) throw Object.assign(new Error('biological retention boundary still has required pending deliveries'), { code: 'BIOLOGICAL_RETENTION_BLOCKED' });
      const result = this.db.prepare('DELETE FROM biological_events WHERE sequence<=?').run(throughSequence);
      return { removed: Number(result.changes) || 0, throughSequence, retained };
    });
  }

  pruneUnclaimedBiologicalEvents({ retainCount = 4096 } = {}) {
    const retained = Math.max(1, Math.min(1000000, Number(retainCount) || 4096));
    return this.withTransaction(() => {
      const keepBoundary = this.db.prepare(
        'SELECT sequence FROM biological_events ORDER BY sequence DESC LIMIT 1 OFFSET ?'
      ).get(retained - 1)?.sequence;
      if (keepBoundary == null) return { removed: 0, throughSequence: 0, retained };
      const throughSequence = Number(keepBoundary) - 1;
      if (throughSequence < 1) return { removed: 0, throughSequence: 0, retained };
      const result = this.db.prepare(`DELETE FROM biological_events
        WHERE sequence<=? AND NOT EXISTS (
          SELECT 1 FROM biological_deliveries d
          WHERE d.sequence=biological_events.sequence AND d.status='PENDING'
        )`).run(throughSequence);
      return { removed: Number(result.changes) || 0, throughSequence, retained };
    });
  }

  async reconcileMetadataMirrors() {
    const rows = this.db.prepare('SELECT * FROM pending_metadata_mirrors ORDER BY created_at').all();
    for (const row of rows) {
      if (sha256(row.json) !== row.sha256) {
        throw Object.assign(new Error(`metadata mirror journal is corrupt: ${row.key}`), { code: 'STATE_INTEGRITY' });
      }
      const resolved = path.resolve(this.rootDir, row.relative_path);
      if (resolved !== this.lifePath(row.key.replace(/^life:/, ''))) {
        throw Object.assign(new Error(`metadata mirror path is invalid: ${row.relative_path}`), { code: 'STATE_PATH_INVALID' });
      }
      await this.checkedAtomicWrite(resolved, row.json);
      this.withTransaction(() => this.db.prepare('DELETE FROM pending_metadata_mirrors WHERE key=? AND sha256=?').run(row.key, row.sha256));
      this.recordRecovery('metadata.mirror-reconciled', null, { key: row.key });
    }
    return rows.length;
  }

  async assertCanonicalLifeMirror(name) {
    const canonical = this.metadataGet('life:' + name, null);
    if (canonical == null) return;
    const mirror = await this.readJson(this.lifePath(name), null);
    if (mirror == null) return;
    if (JSON.stringify(canonical) !== JSON.stringify(mirror)) {
      throw Object.assign(new Error(`SQLite and JSON mirror disagree for life:${name}`), { code: 'IDENTITY_DIVERGENCE' });
    }
  }

  async readCore(coreId, channel = 'active', fallback = null) {
    if (channel === 'active') {
      const checkpoint = await this.readLatestCheckpoint(coreId);
      if (checkpoint) return { stateSchema: checkpoint.stateSchema, state: checkpoint.state, version: checkpoint.version };
    }
    return this.readJson(this.corePath(coreId, channel), fallback);
  }

  async writeCore(coreId, envelope, channel = 'active') {
    const value = { coreId, writtenAt: new Date().toISOString(), ...envelope };
    await this.checkedAtomicWrite(this.corePath(coreId, channel), JSON.stringify(value, null, 2) + '\n');
  }

  async appendJournal(record) {
    const file = path.join(this.rootDir, 'journal', new Date().toISOString().slice(0, 10) + '.jsonl');
    let handle;
    try {
      handle = await fs.open(file, 'a', 0o600);
      await handle.writeFile(JSON.stringify(record) + '\n');
      await handle.sync();
      this.markWriteSuccess();
    } catch (error) { this.markWriteFailure(error); throw error; }
    finally { await handle?.close(); }
  }

  async heartbeat(payload = {}) {
    const value = { at: new Date().toISOString(), ...payload };
    await this.writeLife('runtime-heartbeat', value);
    return value;
  }

  async persistenceStatus(maxHeartbeatAgeMs = 120000) {
    let integrity = 'ok';
    try {
      const check = this.db.prepare('PRAGMA quick_check').get();
      if (String(check?.quick_check || '').toLowerCase() !== 'ok') integrity = 'failed';
    }
    catch { integrity = 'failed'; }
    const heartbeat = await this.readLife('runtime-heartbeat', null);
    const heartbeatAt = heartbeat?.at || null;
    const heartbeatAgeMs = heartbeatAt ? Math.max(0, Date.now() - Date.parse(heartbeatAt)) : null;
    const maintenanceErrors = [...this.maintenanceErrors.values()];
    const healthy = integrity === 'ok' && Boolean(heartbeatAt) &&
      heartbeatAgeMs <= maxHeartbeatAgeMs && !this.lastWriteError &&
      this.writeFailureCount === 0 && maintenanceErrors.length === 0;
    return {
      ok: healthy,
      format: 'stay-statestore-v3',
      sqliteJournalMode: String(this.db.prepare('PRAGMA journal_mode').get()?.journal_mode || '').toLowerCase(),
      sqliteSynchronous: this.db.prepare('PRAGMA synchronous').get()?.synchronous,
      integrity,
      heartbeatAt,
      heartbeatAgeMs,
      lastSuccessfulWriteAt: this.lastSuccessfulWriteAt,
      lastWriteError: this.lastWriteError,
      writeFailureCount: this.writeFailureCount,
      maintenanceErrors
    };
  }

  blobPath(hash) { return path.join(this.blobRoot, hash.slice(0, 2), hash); }

  pinSnapshotBlobs(hashes) {
    for (const hash of hashes) {
      this.snapshotBlobPinCounts.set(
        hash,
        (this.snapshotBlobPinCounts.get(hash) || 0) + 1
      );
    }
  }

  snapshotBlobIsPinned(hash) {
    return (this.snapshotBlobPinCounts.get(hash) || 0) > 0;
  }

  blobReferenceCount(hash) {
    const queries = [
      'SELECT COUNT(*) AS count FROM checkpoints WHERE blob_hash=?',
      'SELECT COUNT(*) AS count FROM authority WHERE checkpoint_hash=?',
      'SELECT COUNT(*) AS count FROM resident_checkpoints WHERE blob_hash=?',
      'SELECT COUNT(*) AS count FROM resident_instances WHERE checkpoint_hash=?'
    ];
    return queries.reduce(
      (total, sql) => total + Number(this.db.prepare(sql).get(hash)?.count || 0),
      0
    );
  }

  async deleteBlobIfUnreferenced(hash) {
    if (this.blobReferenceCount(hash) !== 0) return false;
    if (this.snapshotBlobIsPinned(hash)) {
      this.deferredBlobDeletes.add(hash);
      return false;
    }
    await fs.unlink(this.blobPath(hash)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    this.deferredBlobDeletes.delete(hash);
    return true;
  }

  async releaseSnapshotBlobs(hashes) {
    for (const hash of hashes) {
      const remaining = (this.snapshotBlobPinCounts.get(hash) || 0) - 1;
      if (remaining > 0) this.snapshotBlobPinCounts.set(hash, remaining);
      else this.snapshotBlobPinCounts.delete(hash);
    }
    for (const hash of hashes) {
      if (this.deferredBlobDeletes.has(hash) && !this.snapshotBlobIsPinned(hash)) {
        await this.deleteBlobIfUnreferenced(hash);
      }
    }
  }

  async putBlob(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const hash = sha256(bytes);
    const filePath = this.blobPath(hash);
    if (!(await exists(filePath))) {
      await atomicWrite(filePath, bytes, 0o600, { acceptIdenticalExisting: true });
    }
    const verified = await sha256File(filePath);
    if (verified !== hash) throw Object.assign(new Error('content-addressed blob verification failed'), { code: 'BLOB_INTEGRITY' });
    return { hash, byteLength: bytes.length, path: filePath };
  }

  async readBlob(hash) {
    const bytes = await fs.readFile(this.blobPath(hash));
    if (sha256(bytes) !== hash) throw Object.assign(new Error('checkpoint blob hash mismatch'), { code: 'CHECKPOINT_CORRUPT' });
    return bytes;
  }

  registerResident({
    residencyId,
    coreId,
    role,
    instanceId,
    version,
    stateSchema,
    moduleRelativePath,
    moduleHash,
    manifestHash,
    packagePolicyHash,
    organismIdentityHash
  }) {
    const stringFields = {
      residencyId,
      coreId,
      role,
      instanceId,
      version,
      moduleRelativePath
    };

    for (const [name, value] of Object.entries(stringFields)) {
      if (typeof value !== 'string' || !value.trim()) {
        throw Object.assign(
          new Error(`invalid resident ${name}`),
          { code: 'RESIDENT_IDENTITY_INVALID' }
        );
      }
    }

    if (
      residencyId.length > 200 ||
      coreId.length > 120 ||
      role.length > 120 ||
      instanceId.length > 200 ||
      version.length > 120
    ) {
      throw Object.assign(
        new Error('resident identity exceeds bounded length'),
        { code: 'RESIDENT_IDENTITY_INVALID' }
      );
    }

    if (!Number.isSafeInteger(stateSchema) || stateSchema < 1) {
      throw Object.assign(
        new Error('invalid resident state schema'),
        { code: 'RESIDENT_IDENTITY_INVALID' }
      );
    }

    for (
      const [name, value]
      of Object.entries({
        moduleHash,
        manifestHash,
        packagePolicyHash,
        organismIdentityHash
      })
    ) {
      if (!RESIDENT_HASH.test(String(value || ''))) {
        throw Object.assign(
          new Error(`invalid resident ${name}`),
          { code: 'RESIDENT_IDENTITY_INVALID' }
        );
      }
    }

    const normalizedModule =
      String(moduleRelativePath)
        .replaceAll('\\', '/');

    if (
      path.posix.isAbsolute(normalizedModule) ||
      normalizedModule.split('/').includes('..')
    ) {
      throw Object.assign(
        new Error('resident module path must remain release-relative'),
        { code: 'RESIDENT_MODULE_PATH' }
      );
    }

    const existing =
      this.getResident(residencyId);

    const expected = {
      coreId,
      role,
      instanceId,
      version,
      stateSchema,
      moduleRelativePath: normalizedModule,
      moduleHash,
      manifestHash,
      packagePolicyHash,
      organismIdentityHash
    };

    if (existing) {
      for (const [name, value] of Object.entries(expected)) {
        if (existing[name] !== value) {
          throw Object.assign(
            new Error(
              `resident immutable identity changed: ${name}`
            ),
            { code: 'RESIDENT_IDENTITY_CONFLICT' }
          );
        }
      }

      return existing;
    }

    const at =
      new Date().toISOString();

    this.withTransaction(() => {
      this.db.prepare(`
        INSERT INTO resident_instances(
          residency_id,
          core_id,
          role,
          instance_id,
          version,
          state_schema,
          module_relative_path,
          module_hash,
          manifest_hash,
          package_policy_hash,
          organism_identity_hash,
          checkpoint_hash,
          checkpoint_generation,
          status,
          attached_at,
          updated_at
        )
        VALUES(
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          NULL, 0, 'ATTACHED', ?, ?
        )
      `).run(
        residencyId,
        coreId,
        role,
        instanceId,
        version,
        stateSchema,
        normalizedModule,
        moduleHash,
        manifestHash,
        packagePolicyHash,
        organismIdentityHash,
        at,
        at
      );
    });

    this.markWriteSuccess();

    return this.getResident(residencyId);
  }

  getResident(residencyId) {
    const row =
      this.db.prepare(
        'SELECT * FROM resident_instances WHERE residency_id=?'
      ).get(residencyId);

    return residentRecord(row);
  }

  listResidents() {
    return this.db.prepare(
      'SELECT * FROM resident_instances ORDER BY residency_id'
    ).all().map(residentRecord);
  }

  setResidentStatus(residencyId, status) {
    if (!RESIDENT_STATUSES.has(status)) {
      throw Object.assign(
        new Error(`invalid resident status: ${status}`),
        { code: 'RESIDENT_STATUS_INVALID' }
      );
    }

    const current =
      this.getResident(residencyId);

    if (!current) {
      throw Object.assign(
        new Error(`unknown resident: ${residencyId}`),
        { code: 'RESIDENT_UNKNOWN' }
      );
    }

    if (current.status === status) {
      return current;
    }

    const at =
      new Date().toISOString();

    this.withTransaction(() => {
      const updated =
        this.db.prepare(`
          UPDATE resident_instances
          SET status=?, updated_at=?
          WHERE residency_id=?
        `).run(
          status,
          at,
          residencyId
        );

      if (updated.changes !== 1) {
        throw Object.assign(
          new Error('resident status update lost identity'),
          { code: 'RESIDENT_IDENTITY_CONFLICT' }
        );
      }
    });

    this.markWriteSuccess();

    return this.getResident(residencyId);
  }

  transitionResidentToTerminal({
    residencyId,
    status,
    recoveryType,
    coreId,
    detail = {}
  }) {
    if (!['QUARANTINED', 'RESYNC_REQUIRED'].includes(status)) {
      throw Object.assign(
        new Error(`invalid resident terminal status: ${status}`),
        { code: 'RESIDENT_TERMINAL_STATUS_INVALID' }
      );
    }
    if (typeof recoveryType !== 'string' || !recoveryType) {
      throw Object.assign(
        new Error('resident terminal recovery type is invalid'),
        { code: 'RESIDENT_TERMINAL_RECOVERY_TYPE' }
      );
    }
    const at = new Date().toISOString();
    let result;
    try {
      result = this.withTransaction(() => {
      const resident = this.db.prepare(`
        SELECT core_id
        FROM resident_instances
        WHERE residency_id=?
      `).get(residencyId);
      if (!resident) {
        throw Object.assign(
          new Error(`unknown resident: ${residencyId}`),
          { code: 'RESIDENT_UNKNOWN' }
        );
      }
      if (coreId && resident.core_id !== coreId) {
        throw Object.assign(
          new Error('resident terminal transition changed core identity'),
          { code: 'RESIDENT_IDENTITY_CONFLICT' }
        );
      }
      const updated = this.db.prepare(`
        UPDATE resident_instances
        SET status=?, updated_at=?
        WHERE residency_id=?
      `).run(status, at, residencyId);
      if (updated.changes !== 1) {
        throw Object.assign(
          new Error('resident terminal transition lost identity'),
          { code: 'RESIDENT_IDENTITY_CONFLICT' }
        );
      }
      this.db.prepare(`
        UPDATE biological_consumers
        SET active=0, required=0, updated_at=?
        WHERE consumer_id=?
      `).run(at, residencyId);
      this.db.prepare(`
        INSERT INTO recovery_records(type, core_id, detail_json, created_at)
        VALUES(?, ?, ?, ?)
      `).run(recoveryType, resident.core_id, JSON.stringify(detail), at);
      this.db.prepare(`
        DELETE FROM recovery_records
        WHERE id NOT IN (
          SELECT id FROM recovery_records ORDER BY id DESC LIMIT 10000
        )
      `).run();
      return {
        resident: this.getResident(residencyId),
        consumer: this.getBiologicalConsumer(residencyId)
      };
      });
    } catch (error) {
      this.markWriteFailure(error);
      throw error;
    }
    this.markWriteSuccess();
    return result;
  }

  async commitResidentCheckpoint({
    residencyId,
    instanceId,
    version,
    stateSchema,
    state,
    consumerAck = null,
    producerEpoch = null,
    producerTransitionId = null,
    outboxIntents = [],
    allowCommittedOutboxReplay = false
  }) {
    const resident =
      this.getResident(residencyId);

    if (!resident) {
      throw Object.assign(
        new Error(`unknown resident: ${residencyId}`),
        { code: 'RESIDENT_UNKNOWN' }
      );
    }

    if (
      resident.instanceId !== instanceId ||
      resident.version !== version ||
      resident.stateSchema !== stateSchema
    ) {
      throw Object.assign(
        new Error('resident checkpoint identity mismatch'),
        { code: 'RESIDENT_CHECKPOINT_IDENTITY' }
      );
    }

    if (
      ![
        'ATTACHED',
        'RUNNING',
        'RECOVERING'
      ].includes(resident.status)
    ) {
      throw Object.assign(
        new Error(
          `resident ${residencyId} cannot checkpoint while ${resident.status}`
        ),
        { code: 'RESIDENT_CHECKPOINT_STATE' }
      );
    }

    if (
      consumerAck &&
      consumerAck.consumerId !== residencyId
    ) {
      throw Object.assign(
        new Error('resident acknowledgement identity mismatch'),
        { code: 'RESIDENT_CONSUMER_MISMATCH' }
      );
    }

    const json =
      JSON.stringify(state ?? {});

    const blob =
      await this.putBlob(json);

    const createdAt =
      new Date().toISOString();

    const checkpointId =
      crypto.randomUUID();

    let result;

    try {
      result =
        this.withTransaction(() => {
          const row =
            this.db.prepare(`
              SELECT
                generation,
                input_cursor
              FROM resident_checkpoints
              WHERE residency_id=?
              ORDER BY generation DESC
              LIMIT 1
            `).get(residencyId);

        const generation =
          Number(row?.generation || 0) + 1;

          /*
           * input_cursor is physiological provenance.
           *
           * Durable biological transitions record the
           * sequence actually incorporated into state.
           *
           * Lifecycle persistence incorporates no new
           * biological input, so it inherits provenance
           * from the preceding resident checkpoint.
           *
           * Do not copy biological_consumers.cursor:
           * administrative resynchronization may advance
           * that cursor without applying physiology.
           */
          const inputCursor =
            consumerAck
              ? Number(consumerAck.sequence) || 0
              : Number(row?.input_cursor) || 0;

        this.db.prepare(`
          INSERT INTO resident_checkpoints(
            checkpoint_id,
            residency_id,
            instance_id,
            version,
            state_schema,
            generation,
            blob_hash,
            byte_length,
            input_cursor,
            created_at
          )
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          checkpointId,
          residencyId,
          instanceId,
          version,
          stateSchema,
          generation,
          blob.hash,
          blob.byteLength,
          inputCursor,
          createdAt
        );

        const pointer =
          this.db.prepare(`
            UPDATE resident_instances
            SET
              checkpoint_hash=?,
              checkpoint_generation=?,
              updated_at=?
            WHERE
              residency_id=? AND
              instance_id=? AND
              version=? AND
              state_schema=?
          `).run(
            blob.hash,
            generation,
            createdAt,
            residencyId,
            instanceId,
            version,
            stateSchema
          );

        if (pointer.changes !== 1) {
          throw Object.assign(
            new Error(
              'resident checkpoint pointer lost identity'
            ),
            { code: 'RESIDENT_CHECKPOINT_IDENTITY' }
          );
        }

        if (consumerAck) {
          const delivery =
            this.db.prepare(`
              SELECT status
              FROM biological_deliveries
              WHERE consumer_id=? AND sequence=?
            `).get(
              consumerAck.consumerId,
              consumerAck.sequence
            );

          if (!delivery) {
            throw Object.assign(
              new Error(
                'resident acknowledgement has no durable delivery'
              ),
              { code: 'BIOLOGICAL_DELIVERY_MISSING' }
            );
          }

          if (delivery.status !== 'ACKED') {
            this.db.prepare(`
              UPDATE biological_deliveries
              SET
                status='ACKED',
                transition_id=?,
                checkpoint_hash=?,
                acknowledged_at=?
              WHERE
                consumer_id=? AND
                sequence=? AND
                status='PENDING'
            `).run(
              consumerAck.transitionId || null,
              blob.hash,
              createdAt,
              consumerAck.consumerId,
              consumerAck.sequence
            );
          }

          const cursor =
            this.advanceBiologicalCursor(
              consumerAck.consumerId,
              createdAt
            );

          this.db.prepare(`
            UPDATE biological_consumers
            SET checkpoint_hash=?, updated_at=?
            WHERE consumer_id=?
          `).run(
            blob.hash,
            createdAt,
            consumerAck.consumerId
          );

          if (cursor < consumerAck.sequence) {
            // Earlier pending deliveries legitimately
            // prevent the cursor from crossing this event.
          }
        }

        const committedOutbox =
          this._commitBiologicalOutboxIntents({
            coreId:
              resident.coreId,
            instanceId,
            version,
            authorityEpoch:
              producerEpoch ||
              1,
            checkpointId,
            checkpointHash:
              blob.hash,
            checkpointGeneration:
              generation,
            producerTransitionId,
            consumerAck,
            outboxIntents,
            allowCommittedOutboxReplay
          });

        return {
          checkpointId,
          generation,
          outboxIntents:
            committedOutbox
        };
        });
    } catch (error) {
      this.markWriteFailure(error);

      /*
       * putBlob necessarily precedes the SQLite transaction. If validation,
       * acknowledgement, or outbox insertion rolls that transaction back,
       * the content-addressed file must not accumulate as invisible storage
       * debt. A hash already referenced elsewhere is retained; snapshot pins
       * defer deletion through the existing pin protocol.
       */
      try {
        await this.deleteBlobIfUnreferenced(
          blob.hash
        );
      } catch (cleanupError) {
        error.orphanBlobCleanup = {
          code:
            cleanupError.code ||
            null,

          message:
            cleanupError.message
        };
      }

      throw error;
    }

    this.markWriteSuccess();

    await this.runMaintenance(
      'resident-checkpoint-retention',
      () => this.pruneResidentCheckpoints(
        residencyId,
        32
      )
    );

    return {
      ...result,
      residencyId,
      instanceId,
      version,
      stateSchema,
      blobHash: blob.hash,
      byteLength: blob.byteLength,
      createdAt
    };
  }


  async promoteResidentGeneration({
    residencyId,
    instanceId,
    organismIdentityHash,
    fromVersion,
    fromStateSchema,
    fromModuleRelativePath,
    fromCheckpointGeneration,
    fromCheckpointHash,
    toVersion,
    toStateSchema,
    toModuleRelativePath,
    toModuleHash,
    toManifestHash,
    toPackagePolicyHash,
    topics,
    genesisEvent,
    state,
    promotionKind =
      'SNTSS_CONTINUITY_GENESIS'
  }) {
    const textFields = {
      residencyId,
      instanceId,
      fromVersion,
      fromModuleRelativePath,
      toVersion,
      toModuleRelativePath
    };

    for (const [name, value] of Object.entries(textFields)) {
      if (
        typeof value !==
          'string' ||
        !value
      ) {
        throw Object.assign(
          new Error(`resident promotion ${name} is invalid`),
          { code: 'RESIDENT_PROMOTION_INPUT' }
        );
      }
    }

    for (const [name, value] of Object.entries({
      organismIdentityHash,
      toModuleHash,
      toManifestHash,
      toPackagePolicyHash
    })) {
      if (!RESIDENT_HASH.test(String(value || ''))) {
        throw Object.assign(
          new Error(`resident promotion ${name} is invalid`),
          { code: 'RESIDENT_PROMOTION_INPUT' }
        );
      }
    }

    const sntssPromotion =
      promotionKind ===
        'SNTSS_CONTINUITY_GENESIS' &&
      genesisEvent?.topic ===
        'runtime.sntss.continuity-genesis';

    const metabShadowActivationRevision =
      genesisEvent?.payload?.runtimeRevision;
    const metabShadowPromotion =
      promotionKind ===
        'METAB_NEUTRAL_TO_SHADOW_R128' &&
      residencyId === 'resident:metab' &&
      fromVersion === '0.1.0-p1r0-neutral.1' &&
      fromStateSchema === 1 &&
      fromModuleRelativePath ===
        'cores/p1-r0/metab-neutral/index.js' &&
      toVersion === '0.2.0-p1r0-shadow.1' &&
      toStateSchema === 2 &&
      toModuleRelativePath ===
        'cores/p1-r0/metab-shadow/index.js' &&
      stableStringify(topics) ===
        stableStringify([
          'runtime.organism.binding',
          'runtime.metab.shadow-activation',
          'resource.capacity.eligible.v1',
          'resource.capacity.quality.v1'
        ]) &&
      genesisEvent?.topic ===
        'runtime.metab.shadow-activation' &&
      genesisEvent?.payload?.protocol ===
        'stay-p1-r0-metab-shadow-activation-v1' &&
      genesisEvent?.payload?.residencyId ===
        residencyId &&
      genesisEvent?.payload?.instanceId ===
        instanceId &&
      genesisEvent?.payload?.fromVersion ===
        fromVersion &&
      genesisEvent?.payload?.fromStateSchema ===
        fromStateSchema &&
      genesisEvent?.payload?.sourceCheckpointGeneration ===
        fromCheckpointGeneration &&
      genesisEvent?.payload?.sourceCheckpointHash ===
        `sha256:${fromCheckpointHash}` &&
      genesisEvent?.payload?.toVersion ===
        toVersion &&
      genesisEvent?.payload?.toStateSchema ===
        toStateSchema &&
      [128, 135, 137, 139].includes(
        metabShadowActivationRevision
      ) &&
      genesisEvent?.payload?.parentRevision === 127 &&
      genesisEvent?.payload?.mode === 'SHADOW' &&
      genesisEvent?.payload?.authorityEpoch === '0' &&
      genesisEvent?.payload?.outputPolicy ===
        'FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT';

    const metabHomeosPromotion =
      promotionKind === 'METAB_HOMEOS_ROUTE_R144' &&
      residencyId === 'resident:metab' &&
      fromVersion === '0.2.0-p1r0-shadow.1' &&
      fromStateSchema === 2 &&
      fromModuleRelativePath === 'cores/p1-r0/metab-shadow/index.js' &&
      toVersion === '0.3.0-p1r0-homeos-feed.1' &&
      toStateSchema === 3 &&
      toModuleRelativePath === 'cores/p1-r0/metab-homeos/index.js' &&
      stableStringify(topics) === stableStringify([
        'runtime.organism.binding',
        'runtime.metab.shadow-activation',
        'resource.capacity.eligible.v1',
        'resource.capacity.quality.v1',
        'runtime.metab.homeos-route-activation'
      ]) &&
      genesisEvent?.topic === 'runtime.metab.homeos-route-activation' &&
      genesisEvent?.payload?.protocol === 'stay-p1-r0-metab-homeos-route-activation-v1' &&
      genesisEvent?.payload?.residencyId === residencyId &&
      genesisEvent?.payload?.instanceId === instanceId &&
      genesisEvent?.payload?.fromVersion === fromVersion &&
      genesisEvent?.payload?.fromStateSchema === fromStateSchema &&
      genesisEvent?.payload?.sourceCheckpointGeneration === fromCheckpointGeneration &&
      genesisEvent?.payload?.sourceCheckpointHash === `sha256:${fromCheckpointHash}` &&
      genesisEvent?.payload?.toVersion === toVersion &&
      genesisEvent?.payload?.toStateSchema === toStateSchema &&
      genesisEvent?.payload?.targetRevision === 144 &&
      genesisEvent?.payload?.parentRevision === 141 &&
      genesisEvent?.payload?.mode === 'SHADOW' &&
      genesisEvent?.payload?.authorityEpoch === '0' &&
      genesisEvent?.payload?.outputPolicy === 'HOMEOS_ONLY_SHADOW_SUMMARIES' &&
      stableStringify(genesisEvent?.payload?.routes) === stableStringify([
        'p1r0.metab-availability.homeos',
        'p1r0.metab-reserve.homeos'
      ]);

    const homeosShadowPromotion =
      promotionKind === 'HOMEOS_NEUTRAL_TO_SHADOW_R145' &&
      residencyId === 'resident:homeos' &&
      fromVersion === '0.1.0-p1r0-neutral.1' &&
      fromStateSchema === 1 &&
      fromModuleRelativePath === 'cores/p1-r0/homeos-neutral/index.js' &&
      toVersion === '0.2.0-p1r0-shadow.1' &&
      toStateSchema === 2 &&
      toModuleRelativePath === 'cores/p1-r0/homeos-shadow/index.js' &&
      stableStringify(topics) === stableStringify([
        'runtime.organism.binding',
        'metab.energy.availability.v1',
        'metab.energy.reserve.v1',
        'runtime.homeos.shadow-activation'
      ]) &&
      genesisEvent?.topic === 'runtime.homeos.shadow-activation' &&
      genesisEvent?.payload?.protocol === 'stay-p1-r0-homeos-shadow-activation-v1' &&
      genesisEvent?.payload?.residencyId === residencyId &&
      genesisEvent?.payload?.instanceId === instanceId &&
      genesisEvent?.payload?.fromVersion === fromVersion &&
      genesisEvent?.payload?.fromStateSchema === fromStateSchema &&
      genesisEvent?.payload?.sourceCheckpointGeneration === fromCheckpointGeneration &&
      genesisEvent?.payload?.sourceCheckpointHash === `sha256:${fromCheckpointHash}` &&
      genesisEvent?.payload?.toVersion === toVersion &&
      genesisEvent?.payload?.toStateSchema === toStateSchema &&
      genesisEvent?.payload?.targetRevision === 145 &&
      genesisEvent?.payload?.parentRevision === 141 &&
      genesisEvent?.payload?.mode === 'SHADOW' &&
      genesisEvent?.payload?.authorityEpoch === '0' &&
      genesisEvent?.payload?.outputPolicy === 'FORBIDDEN_UNTIL_INTERO_ATTACHMENT';

    const metabInteroPromotion =
      promotionKind === 'METAB_INTERO_ROUTE_R148' &&
      residencyId === 'resident:metab' &&
      fromVersion === '0.3.0-p1r0-homeos-feed.1' &&
      fromStateSchema === 3 &&
      fromModuleRelativePath === 'cores/p1-r0/metab-homeos/index.js' &&
      toVersion === '0.4.0-p1r0-intero-feed.1' &&
      toStateSchema === 4 &&
      toModuleRelativePath === 'cores/p1-r0/metab-intero/index.js' &&
      stableStringify(topics) === stableStringify([
        'runtime.organism.binding',
        'runtime.metab.shadow-activation',
        'resource.capacity.eligible.v1',
        'resource.capacity.quality.v1',
        'runtime.metab.homeos-route-activation',
        'runtime.metab.intero-route-activation'
      ]) &&
      genesisEvent?.topic === 'runtime.metab.intero-route-activation' &&
      genesisEvent?.payload?.protocol === 'stay-p1-r0-metab-intero-route-activation-v1' &&
      genesisEvent?.payload?.residencyId === residencyId &&
      genesisEvent?.payload?.instanceId === instanceId &&
      genesisEvent?.payload?.fromVersion === fromVersion &&
      genesisEvent?.payload?.fromStateSchema === fromStateSchema &&
      genesisEvent?.payload?.sourceCheckpointGeneration === fromCheckpointGeneration &&
      genesisEvent?.payload?.sourceCheckpointHash === `sha256:${fromCheckpointHash}` &&
      genesisEvent?.payload?.toVersion === toVersion &&
      genesisEvent?.payload?.toStateSchema === toStateSchema &&
      genesisEvent?.payload?.targetRevision === 148 &&
      genesisEvent?.payload?.parentRevision === 145 &&
      genesisEvent?.payload?.mode === 'SHADOW' &&
      genesisEvent?.payload?.authorityEpoch === '0' &&
      genesisEvent?.payload?.outputPolicy === 'HOMEOS_AND_INTERO_SHADOW_SUMMARIES' &&
      stableStringify(genesisEvent?.payload?.routes) === stableStringify([
        'p1r0.metab-availability.intero',
        'p1r0.metab-reserve.intero'
      ]);

    const homeosInteroPromotion =
      promotionKind === 'HOMEOS_INTERO_ROUTE_R149' &&
      residencyId === 'resident:homeos' &&
      fromVersion === '0.2.0-p1r0-shadow.1' &&
      fromStateSchema === 2 &&
      fromModuleRelativePath === 'cores/p1-r0/homeos-shadow/index.js' &&
      toVersion === '0.3.0-p1r0-intero-feed.1' &&
      toStateSchema === 3 &&
      toModuleRelativePath === 'cores/p1-r0/homeos-intero/index.js' &&
      stableStringify(topics) === stableStringify([
        'runtime.organism.binding',
        'metab.energy.availability.v1',
        'metab.energy.reserve.v1',
        'runtime.homeos.shadow-activation',
        'runtime.homeos.intero-route-activation'
      ]) &&
      genesisEvent?.topic === 'runtime.homeos.intero-route-activation' &&
      genesisEvent?.payload?.protocol === 'stay-p1-r0-homeos-intero-route-activation-v1' &&
      genesisEvent?.payload?.residencyId === residencyId &&
      genesisEvent?.payload?.instanceId === instanceId &&
      genesisEvent?.payload?.fromVersion === fromVersion &&
      genesisEvent?.payload?.fromStateSchema === fromStateSchema &&
      genesisEvent?.payload?.sourceCheckpointGeneration === fromCheckpointGeneration &&
      genesisEvent?.payload?.sourceCheckpointHash === `sha256:${fromCheckpointHash}` &&
      genesisEvent?.payload?.toVersion === toVersion &&
      genesisEvent?.payload?.toStateSchema === toStateSchema &&
      genesisEvent?.payload?.targetRevision === 149 &&
      genesisEvent?.payload?.parentRevision === 145 &&
      genesisEvent?.payload?.mode === 'SHADOW' &&
      genesisEvent?.payload?.authorityEpoch === '0' &&
      genesisEvent?.payload?.outputPolicy === 'INTERO_STABILITY_ONLY_SHADOW_SUMMARY' &&
      stableStringify(genesisEvent?.payload?.routes) === stableStringify([
        'p1r0.homeos-stability.intero'
      ]);

    const interoShadowPromotion =
      promotionKind === 'INTERO_NEUTRAL_TO_SHADOW_R150' &&
      residencyId === 'resident:intero' &&
      fromVersion === '0.1.0-p1r0-neutral.1' &&
      fromStateSchema === 1 &&
      fromModuleRelativePath === 'cores/p1-r0/intero-neutral/index.js' &&
      toVersion === '0.2.0-p1r0-shadow.1' &&
      toStateSchema === 2 &&
      toModuleRelativePath === 'cores/p1-r0/intero-shadow/index.js' &&
      stableStringify(topics) === stableStringify([
        'runtime.organism.binding',
        'runtime.intero.shadow-activation',
        'metab.energy.availability.v1',
        'metab.energy.reserve.v1',
        'homeos.stability.summary.v1'
      ]) &&
      genesisEvent?.topic === 'runtime.intero.shadow-activation' &&
      genesisEvent?.payload?.protocol === 'stay-p1-r0-intero-shadow-activation-v1' &&
      genesisEvent?.payload?.residencyId === residencyId &&
      genesisEvent?.payload?.instanceId === instanceId &&
      genesisEvent?.payload?.fromVersion === fromVersion &&
      genesisEvent?.payload?.fromStateSchema === fromStateSchema &&
      genesisEvent?.payload?.sourceCheckpointGeneration === fromCheckpointGeneration &&
      genesisEvent?.payload?.sourceCheckpointHash === `sha256:${fromCheckpointHash}` &&
      genesisEvent?.payload?.toVersion === toVersion &&
      genesisEvent?.payload?.toStateSchema === toStateSchema &&
      genesisEvent?.payload?.targetRevision === 150 &&
      genesisEvent?.payload?.parentRevision === 145 &&
      genesisEvent?.payload?.mode === 'SHADOW' &&
      genesisEvent?.payload?.authorityEpoch === '0' &&
      genesisEvent?.payload?.outputPolicy === 'PERCEPTION_ONLY_NO_OUTPUT' &&
      genesisEvent?.payload?.receptorRoute === 'ABSENT';

    const p1ContainedPromotion =
      metabShadowPromotion || metabHomeosPromotion || homeosShadowPromotion ||
      metabInteroPromotion || homeosInteroPromotion || interoShadowPromotion;

    if (
      !Number.isSafeInteger(fromStateSchema) ||
      fromStateSchema < 1 ||
      !Number.isSafeInteger(toStateSchema) ||
      toStateSchema <= fromStateSchema ||
      !Number.isSafeInteger(fromCheckpointGeneration) ||
      fromCheckpointGeneration < 1 ||
      !/^[0-9a-f]{64}$/.test(String(fromCheckpointHash || '')) ||
      !Array.isArray(topics) ||
      topics.some(topic => typeof topic !== 'string' || !topic) ||
      !genesisEvent ||
      (!sntssPromotion && !p1ContainedPromotion) ||
      genesisEvent.ledger?.durable !== true ||
      !Number.isSafeInteger(genesisEvent.sequence) ||
      genesisEvent.sequence < 1 ||
      typeof genesisEvent.id !== 'string' ||
      !genesisEvent.id
    ) {
      throw Object.assign(
        new Error('resident generation promotion input is invalid'),
        { code: 'RESIDENT_PROMOTION_INPUT' }
      );
    }

    const normalizedModule =
      String(toModuleRelativePath)
        .replaceAll('\\', '/');

    if (
      path.posix.isAbsolute(normalizedModule) ||
      normalizedModule.split('/').includes('..')
    ) {
      throw Object.assign(
        new Error('resident promotion module path is invalid'),
        { code: 'RESIDENT_MODULE_PATH' }
      );
    }

    const json =
      JSON.stringify(state ?? {});

    const blob =
      await this.putBlob(
        json
      );

    const createdAt =
      new Date().toISOString();

    const checkpointId =
      crypto.randomUUID();

    const normalizedTopics =
      [...new Set(topics.map(String))]
        .sort();

    const topicsJson =
      stableStringify(
        normalizedTopics
      );

    const topicsHash =
      sha256(
        topicsJson
      );

    const generation =
      fromCheckpointGeneration + 1;

    const transition =
      `sha256:${sha256(stableStringify({
        protocol:
          metabShadowPromotion
            ? 'stay-metab-mode-transition-v1'
            : p1ContainedPromotion
              ? 'stay-p1-r0-contained-transition-v1'
            : 'stay-resident-transition-v1',
        residencyId,
        eventId:
          genesisEvent.id,
        sequence:
          genesisEvent.sequence
      }))}`;

    this.withTransaction(() => {
      const current =
        this.getResident(
          residencyId
        );

      if (
        !current ||
        current.instanceId !== instanceId ||
        current.organismIdentityHash !== organismIdentityHash ||
        current.version !== fromVersion ||
        current.stateSchema !== fromStateSchema ||
        current.moduleRelativePath !== fromModuleRelativePath ||
        current.checkpointGeneration !== fromCheckpointGeneration ||
        current.checkpointHash !== fromCheckpointHash ||
        current.status !== 'DETACHED'
      ) {
        throw Object.assign(
          new Error('resident promotion lost the detached source generation'),
          { code: 'RESIDENT_PROMOTION_BASELINE' }
        );
      }

      if (
        p1ContainedPromotion &&
        current.coreId !== (
          residencyId === 'resident:homeos'
            ? 'HOMEOS'
            : residencyId === 'resident:intero'
              ? 'INTERO'
              : 'METAB'
        )
      ) {
        throw Object.assign(
          new Error('P1 contained promotion changed core identity'),
          { code: 'RESIDENT_PROMOTION_BASELINE' }
        );
      }

      const checkpoint =
        this.db.prepare(`
          SELECT generation, blob_hash
          FROM resident_checkpoints
          WHERE residency_id=?
          ORDER BY generation DESC
          LIMIT 1
        `).get(
          residencyId
        );

      if (
        Number(checkpoint?.generation) !== fromCheckpointGeneration ||
        checkpoint?.blob_hash !== fromCheckpointHash
      ) {
        throw Object.assign(
          new Error('resident promotion source checkpoint is no longer current'),
          { code: 'RESIDENT_PROMOTION_CHECKPOINT' }
        );
      }

      const eventRow =
        this.db.prepare(`
          SELECT *
          FROM biological_events
          WHERE sequence=? AND event_id=? AND topic=?
        `).get(
          genesisEvent.sequence,
          genesisEvent.id,
          genesisEvent.topic
        );

      if (!eventRow) {
        throw Object.assign(
          new Error('continuity-genesis event is not durably committed'),
          { code: 'RESIDENT_PROMOTION_EVENT' }
        );
      }

      const storedEvent =
        this.biologicalEventFromRow(
          eventRow,
          false
        );

      if (
        stableStringify(storedEvent) !==
          stableStringify({
            ...genesisEvent,
            ledger:
              storedEvent.ledger
          })
      ) {
        throw Object.assign(
          new Error('continuity-genesis event changed before promotion commit'),
          { code: 'RESIDENT_PROMOTION_EVENT' }
        );
      }

      const consumer =
        this.db.prepare(`
          SELECT *
          FROM biological_consumers
          WHERE consumer_id=?
        `).get(
          residencyId
        );

      const pending =
        Number(
          this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM biological_deliveries
            WHERE consumer_id=? AND status='PENDING'
          `).get(
            residencyId
          )?.count || 0
        );

      const authorityCount =
        p1ContainedPromotion
          ? Number(
              this.db.prepare(`
                SELECT COUNT(*) AS count
                FROM authority
                WHERE core_id IN ('METAB', 'HOMEOS', 'INTERO')
              `).get()?.count || 0
            )
          : 0;

      const outputIntentCount =
        p1ContainedPromotion
          ? Number(
              this.db.prepare(`
                SELECT COUNT(*) AS count
                FROM biological_outbox_intents
                WHERE producer_core_id=?
              `).get(current.coreId)?.count || 0
            )
          : 0;

      if (
        !consumer ||
        consumer.core_id !== current.coreId ||
        Number(consumer.active) !== 0 ||
        pending !== 0 ||
        authorityCount !== 0 ||
        outputIntentCount !== 0
      ) {
        throw Object.assign(
          new Error('resident consumer is not at a quiescent promotion boundary'),
          { code: 'RESIDENT_PROMOTION_CONSUMER' }
        );
      }

      this.db.prepare(`
        INSERT INTO resident_checkpoints(
          checkpoint_id,
          residency_id,
          instance_id,
          version,
          state_schema,
          generation,
          blob_hash,
          byte_length,
          input_cursor,
          created_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        checkpointId,
        residencyId,
        instanceId,
        toVersion,
        toStateSchema,
        generation,
        blob.hash,
        blob.byteLength,
        genesisEvent.sequence,
        createdAt
      );

      const updated =
        this.db.prepare(`
          UPDATE resident_instances
          SET
            version=?,
            state_schema=?,
            module_relative_path=?,
            module_hash=?,
            manifest_hash=?,
            package_policy_hash=?,
            checkpoint_hash=?,
            checkpoint_generation=?,
            status='ATTACHED',
            updated_at=?
          WHERE
            residency_id=? AND
            instance_id=? AND
            version=? AND
            state_schema=? AND
            module_relative_path=? AND
            checkpoint_hash=? AND
            checkpoint_generation=? AND
            status='DETACHED'
        `).run(
          toVersion,
          toStateSchema,
          normalizedModule,
          toModuleHash,
          toManifestHash,
          toPackagePolicyHash,
          blob.hash,
          generation,
          createdAt,
          residencyId,
          instanceId,
          fromVersion,
          fromStateSchema,
          fromModuleRelativePath,
          fromCheckpointHash,
          fromCheckpointGeneration
        );

      if (updated.changes !== 1) {
        throw Object.assign(
          new Error('resident promotion identity update lost its compare-and-swap'),
          { code: 'RESIDENT_PROMOTION_IDENTITY' }
        );
      }

      this.db.prepare(`
        INSERT INTO biological_deliveries(
          sequence,
          consumer_id,
          status,
          transition_id,
          checkpoint_hash,
          acknowledged_at
        )
        VALUES(?, ?, 'ACKED', ?, ?, ?)
      `).run(
        genesisEvent.sequence,
        residencyId,
        transition,
        blob.hash,
        createdAt
      );

      this.db.prepare(`
        UPDATE biological_consumers
        SET
          required=0,
          active=1,
          topics_json=?,
          topics_sha256=?,
          cursor=?,
          authority_epoch=0,
          checkpoint_hash=?,
          updated_at=?
        WHERE consumer_id=? AND active=0
      `).run(
        topicsJson,
        topicsHash,
        genesisEvent.sequence,
        blob.hash,
        createdAt,
        residencyId
      );
    });

    this.markWriteSuccess();

    await this.runMaintenance(
      'resident-checkpoint-retention',
      () => this.pruneResidentCheckpoints(
        residencyId,
        32
      )
    );

    return {
      resident:
        this.getResident(
          residencyId
        ),
      checkpoint: {
        checkpointId,
        residencyId,
        instanceId,
        version:
          toVersion,
        stateSchema:
          toStateSchema,
        generation,
        blobHash:
          blob.hash,
        byteLength:
          blob.byteLength,
        inputCursor:
          genesisEvent.sequence,
        createdAt,
        state:
          structuredClone(
            state
          )
      },
      genesisEvent,
      transitionId:
        transition
    };
  }

  async pruneResidentCheckpoints(
    residencyId,
    retention = 32
  ) {
    const bounded =
      Math.max(
        1,
        Math.min(
          1024,
          Number(retention) || 32
        )
      );

    const rows =
      this.db.prepare(`
        SELECT checkpoint_id, blob_hash
        FROM resident_checkpoints
        WHERE residency_id=?
        ORDER BY generation DESC
      `).all(residencyId);

    const remove =
      rows.slice(bounded);

    if (!remove.length) return;

    this.withTransaction(() => {
      const statement =
        this.db.prepare(`
          DELETE FROM resident_checkpoints
          WHERE checkpoint_id=?
        `);

      for (const row of remove) {
        statement.run(
          row.checkpoint_id
        );
      }
    });

    for (const row of remove) {
      await this.deleteBlobIfUnreferenced(row.blob_hash);
    }
  }

  async readResidentCheckpoint(
    residencyId
  ) {
    const resident =
      this.getResident(residencyId);

    if (!resident) {
      return null;
    }

    if (
      !resident.checkpointHash ||
      !resident.checkpointGeneration
    ) {
      return null;
    }

    const row =
      this.db.prepare(`
        SELECT *
        FROM resident_checkpoints
        WHERE
          residency_id=? AND
          instance_id=? AND
          version=? AND
          state_schema=? AND
          generation=? AND
          blob_hash=?
        LIMIT 1
      `).get(
        resident.residencyId,
        resident.instanceId,
        resident.version,
        resident.stateSchema,
        resident.checkpointGeneration,
        resident.checkpointHash
      );

    if (!row) {
      throw Object.assign(
        new Error(
          `resident checkpoint tuple is missing for ${residencyId}`
        ),
        { code: 'RESIDENT_CHECKPOINT_MISMATCH' }
      );
    }

    const bytes =
      await this.readBlob(
        row.blob_hash
      );

    return {
      checkpointId: row.checkpoint_id,
      residencyId: row.residency_id,
      instanceId: row.instance_id,
      version: row.version,
      stateSchema: Number(row.state_schema),
      generation: Number(row.generation),
      blobHash: row.blob_hash,
      byteLength: Number(row.byte_length),
      inputCursor:
        Number(row.input_cursor) || 0,
      createdAt: row.created_at,
      state:
        JSON.parse(
          bytes.toString('utf8')
        )
    };
  }


  async buildResidentCheckpointRecoveryPlan(residencyId) {
    const resident = this.getResident(residencyId);
    if (!resident || !resident.checkpointHash || !resident.checkpointGeneration) return null;
    const rows = this.db.prepare(`
      SELECT * FROM resident_checkpoints
      WHERE residency_id=? AND instance_id=? AND version=? AND state_schema=?
        AND generation<=?
      ORDER BY generation DESC
    `).all(
      resident.residencyId,
      resident.instanceId,
      resident.version,
      resident.stateSchema,
      resident.checkpointGeneration
    );
    const pointer = rows.find(row => Number(row.generation) === resident.checkpointGeneration
      && row.blob_hash === resident.checkpointHash);
    if (!pointer) {
      throw Object.assign(new Error(`resident checkpoint tuple is missing for ${residencyId}`), {
        code: 'RESIDENT_CHECKPOINT_MISMATCH'
      });
    }
    const candidates = [];
    const rejected = [];
    for (const row of rows) {
      try {
        const bytes = await this.readBlob(row.blob_hash);
        if (bytes.length !== Number(row.byte_length)) {
          throw Object.assign(new Error('resident checkpoint byte length mismatch'), {
            code: 'CHECKPOINT_CORRUPT'
          });
        }
        candidates.push(Object.freeze({
          checkpointId: row.checkpoint_id,
          residencyId: row.residency_id,
          instanceId: row.instance_id,
          version: row.version,
          stateSchema: Number(row.state_schema),
          generation: Number(row.generation),
          blobHash: row.blob_hash,
          byteLength: Number(row.byte_length),
          inputCursor: Number(row.input_cursor) || 0,
          createdAt: row.created_at,
          state: JSON.parse(bytes.toString('utf8'))
        }));
      } catch (error) {
        rejected.push(Object.freeze({
          checkpointId: row.checkpoint_id,
          generation: Number(row.generation),
          blobHash: row.blob_hash,
          code: error?.code || 'CHECKPOINT_CORRUPT'
        }));
      }
    }
    for (const hash of new Set(rejected.map(value => value.blobHash))) {
      const source = this.blobPath(hash);
      if (await exists(source)) {
        await fs.rename(source, `${source}.corrupt-${crypto.randomUUID()}`);
      }
    }
    return Object.freeze({
      residencyId,
      pointerGeneration: Number(pointer.generation),
      replayThroughCursor: Number(pointer.input_cursor) || 0,
      candidates: Object.freeze(candidates),
      rejected: Object.freeze(rejected)
    });
  }


  listFinalizedResidentReplayEvents({
    residencyId,
    afterGeneration,
    throughGeneration,
    afterInputCursor,
    throughInputCursor,
    limit = 1024
  }) {
    const values = [afterGeneration, throughGeneration, afterInputCursor, throughInputCursor];
    if (typeof residencyId !== 'string' || !residencyId
      || values.some(value => !Number.isSafeInteger(value) || value < 0)
      || throughGeneration < afterGeneration || throughInputCursor < afterInputCursor) {
      throw Object.assign(new Error('resident finalized replay query is invalid'), {
        code: 'RESIDENT_FINALIZED_REPLAY_QUERY'
      });
    }
    const bounded = Math.max(1, Math.min(1024, Number(limit) || 1024));
    const cursorRows = this.db.prepare(`
      SELECT DISTINCT input_cursor
      FROM resident_checkpoints
      WHERE residency_id=? AND generation>? AND generation<=?
        AND input_cursor>? AND input_cursor<=?
      ORDER BY input_cursor ASC
    `).all(
      residencyId, afterGeneration, throughGeneration,
      afterInputCursor, throughInputCursor
    );
    if (cursorRows.length >= bounded) {
      throw Object.assign(new Error('resident finalized replay exceeds bounded window'), {
        code: 'RESIDENT_REPLAY_BOUNDED'
      });
    }
    const events = [];
    for (const cursorRow of cursorRows) {
      const sequence = Number(cursorRow.input_cursor);
      const row = this.db.prepare(`
        SELECT e.*, d.status AS delivery_status
        FROM biological_events e
        JOIN biological_deliveries d ON d.sequence=e.sequence
        WHERE d.consumer_id=? AND e.sequence=?
      `).get(residencyId, sequence);
      if (!row || row.delivery_status !== 'ACKED') {
        throw Object.assign(new Error(
          `resident finalized replay evidence ${sequence} is unavailable or uncommitted`
        ), { code: 'RESIDENT_FINALIZED_REPLAY_INCOMPLETE' });
      }
      events.push(this.biologicalEventFromRow(row, false));
    }
    const last = events.at(-1)?.sequence ?? afterInputCursor;
    if (last !== throughInputCursor && throughInputCursor !== afterInputCursor) {
      throw Object.assign(new Error('resident replay provenance does not reach checkpoint frontier'), {
        code: 'RESIDENT_FINALIZED_REPLAY_INCOMPLETE'
      });
    }
    return Object.freeze(events);
  }


  biologicalOutboxStreamHeadFromRow(
    row
  ) {
    if (!row) {
      return null;
    }

    const head = {
      producerCoreId:
        row.producer_core_id,

      authorityEpoch:
        Number(
          row.authority_epoch
        ),

      producerStreamId:
        row.producer_stream_id,

      producerInstanceId:
        row.producer_instance_id,

      producerVersion:
        row.producer_version,

      lastStreamSequence:
        Number(
          row.last_stream_sequence
        ),

      lastProducerEventId:
        row.last_producer_event_id
    };

    if (
      sha256(
        stableStringify(
          biologicalOutboxStreamHeadBody(
            head
          )
        )
      ) !==
        row.head_sha256
    ) {
      throw Object.assign(
        new Error(
          `biological outbox stream head ${head.producerCoreId}/${head.authorityEpoch} is corrupt`
        ),
        {
          code:
            'BIOLOGICAL_OUTBOX_HEAD_CORRUPT'
        }
      );
    }

    return Object.freeze(
      head
    );
  }


  getBiologicalOutboxStreamHead({
    producerCoreId,
    authorityEpoch,
    producerStreamId
  }) {
    this.assertOpen();

    const epoch =
      Number(
        authorityEpoch
      );

    if (
      typeof producerCoreId !==
        'string' ||
      !producerCoreId ||
      typeof producerStreamId !==
        'string' ||
      !producerStreamId ||
      !Number.isSafeInteger(
        epoch
      ) ||
      epoch < 1
    ) {
      throw Object.assign(
        new Error(
          'biological outbox stream identity is invalid'
        ),
        {
          code:
            'BIOLOGICAL_OUTBOX_STREAM_ID'
        }
      );
    }

    const row =
      this.db.prepare(`
        SELECT *
        FROM biological_outbox_stream_heads
        WHERE
          producer_core_id=? AND
          authority_epoch=? AND
          producer_stream_id=?
      `).get(
        producerCoreId,
        epoch,
        producerStreamId
      );

    return row
      ? this.biologicalOutboxStreamHeadFromRow(
          row
        )
      : null;
  }


  biologicalOutboxIntentFromRow(row) {
    if (!row) return null;

    if (
      typeof row.intent_json !==
        'string' ||
      sha256(row.intent_json) !==
        row.intent_sha256
    ) {
      throw Object.assign(
        new Error(
          'biological outbox intent integrity mismatch'
        ),
        {
          code:
            'BIOLOGICAL_OUTBOX_CORRUPT'
        }
      );
    }

    let intent;

    try {
      intent =
        JSON.parse(
          row.intent_json
        );
    } catch {
      throw Object.assign(
        new Error(
          'biological outbox intent is invalid JSON'
        ),
        {
          code:
            'BIOLOGICAL_OUTBOX_CORRUPT'
        }
      );
    }

    const identityMatches =
      intent &&
      intent.format ===
        'stay-biological-outbox-intent-v1' &&
      intent.producer_event_id ===
        row.producer_event_id &&
      intent.producer_core_id ===
        row.producer_core_id &&
      intent.producer_instance_id ===
        row.producer_instance_id &&
      intent.producer_version ===
        row.producer_version &&
      Number(
        intent.authority_epoch
      ) ===
        Number(
          row.authority_epoch
        ) &&
      intent.producer_stream_id ===
        row.producer_stream_id &&
      Number(
        intent.stream_sequence
      ) ===
        Number(
          row.stream_sequence
        ) &&
      intent.transition_id ===
        row.transition_id &&
      Number(
        intent.cause_sequence
      ) ===
        Number(
          row.cause_sequence
        ) &&
      Number(
        intent.output_index
      ) ===
        Number(
          row.output_index
        ) &&
      intent.topic ===
        row.topic &&
      intent.checkpoint?.id ===
        row.checkpoint_id &&
      intent.checkpoint?.hash ===
        row.checkpoint_hash &&
      Number(
        intent.checkpoint?.generation
      ) ===
        Number(
          row.checkpoint_generation
        );

    if (!identityMatches) {
      throw Object.assign(
        new Error(
          'biological outbox row disagrees with immutable intent'
        ),
        {
          code:
            'BIOLOGICAL_OUTBOX_CORRUPT'
        }
      );
    }

    return Object.freeze({
      producerEventId:
        row.producer_event_id,

      producerCoreId:
        row.producer_core_id,

      producerInstanceId:
        row.producer_instance_id,

      producerVersion:
        row.producer_version,

      authorityEpoch:
        Number(
          row.authority_epoch
        ),

      producerStreamId:
        row.producer_stream_id,

      streamSequence:
        Number(
          row.stream_sequence
        ),

      transitionId:
        row.transition_id,

      causeSequence:
        Number(
          row.cause_sequence
        ),

      outputIndex:
        Number(
          row.output_index
        ),

      topic:
        row.topic,

      payload:
        structuredClone(
          intent.payload
        ),

      causalParent:
        intent.causal_parent ??
        null,

      publishMeta:
        Object.freeze({
          ...intent.publish_meta
        }),

      proposalHash:
        row.proposal_sha256,

      intentHash:
        row.intent_sha256,

      checkpointId:
        row.checkpoint_id,

      checkpointHash:
        row.checkpoint_hash,

      checkpointGeneration:
        Number(
          row.checkpoint_generation
        ),

      status:
        row.status,

      fabricSequence:
        row.fabric_sequence == null
          ? null
          : Number(
              row.fabric_sequence
            ),

      fabricEventId:
        row.fabric_event_id ||
        null,

      createdAt:
        row.created_at,

      publishedAt:
        row.published_at ||
        null
    });
  }

  getBiologicalOutboxIntent(
    producerEventId
  ) {
    this.assertOpen();

    const row =
      this.db.prepare(`
        SELECT *
        FROM biological_outbox_intents
        WHERE producer_event_id=?
      `).get(
        producerEventId
      );

    return this.biologicalOutboxIntentFromRow(
      row
    );
  }

  listPendingBiologicalOutboxIntents({
    producerCoreId = null,
    limit = 256
  } = {}) {
    this.assertOpen();

    const boundedLimit =
      Math.max(
        1,
        Math.min(
          1024,
          Number(limit) ||
          256
        )
      );

    const rows =
      producerCoreId == null
        ? this.db.prepare(`
            SELECT *
            FROM biological_outbox_intents
            WHERE status='PENDING'
            ORDER BY
              authority_epoch,
              producer_stream_id,
              stream_sequence
            LIMIT ?
          `).all(
            boundedLimit
          )
        : this.db.prepare(`
            SELECT *
            FROM biological_outbox_intents
            WHERE
              producer_core_id=? AND
              status='PENDING'
            ORDER BY
              authority_epoch,
              producer_stream_id,
              stream_sequence
            LIMIT ?
          `).all(
            producerCoreId,
            boundedLimit
          );

    return rows.map(
      row =>
        this.biologicalOutboxIntentFromRow(
          row
        )
    );
  }


  biologicalCutoverSpoolFromRow(
    row
  ) {
    if (!row) {
      return null;
    }

    const spool = {
      transactionId:
        row.transaction_id,

      producerEventId:
        row.producer_event_id,

      producerCoreId:
        row.producer_core_id,

      producerInstanceId:
        row.producer_instance_id,

      producerVersion:
        row.producer_version,

      fromAuthorityEpoch:
        Number(
          row.from_authority_epoch
        ),

      toAuthorityEpoch:
        Number(
          row.to_authority_epoch
        ),

      barrierSequence:
        Number(
          row.barrier_sequence
        ),

      producerStreamId:
        row.producer_stream_id,

      streamSequence:
        Number(
          row.stream_sequence
        ),

      proposalHash:
        row.proposal_sha256,

      intentHash:
        row.intent_sha256,

      status:
        row.status,

      fabricSequence:
        row.fabric_sequence == null
          ? null
          : Number(
              row.fabric_sequence
            ),

      fabricEventId:
        row.fabric_event_id ||
        null,

      spooledAt:
        row.spooled_at,

      acceptedAt:
        row.accepted_at ||
        null
    };

    const body =
      biologicalCutoverSpoolBody(
        spool
      );

    if (
      sha256(
        stableStringify(
          body
        )
      ) !==
        row.spool_sha256
    ) {
      throw Object.assign(
        new Error(
          `biological cutover spool ${spool.producerEventId} is corrupt`
        ),
        {
          code:
            'BIOLOGICAL_CUTOVER_SPOOL_CORRUPT'
        }
      );
    }

    const intent =
      this.getBiologicalOutboxIntent(
        spool.producerEventId
      );

    if (
      !intent ||
      intent.producerCoreId !==
        spool.producerCoreId ||
      intent.producerInstanceId !==
        spool.producerInstanceId ||
      intent.producerVersion !==
        spool.producerVersion ||
      intent.authorityEpoch !==
        spool.fromAuthorityEpoch ||
      intent.producerStreamId !==
        spool.producerStreamId ||
      intent.streamSequence !==
        spool.streamSequence ||
      intent.proposalHash !==
        spool.proposalHash ||
      intent.intentHash !==
        spool.intentHash
    ) {
      throw Object.assign(
        new Error(
          'cutover spool disagrees with immutable producer outbox intent'
        ),
        {
          code:
            'BIOLOGICAL_CUTOVER_SPOOL_CORRUPT'
        }
      );
    }

    if (
      spool.status ===
        'ACCEPTED' &&
      (
        intent.status !==
          'PUBLISHED' ||
        intent.fabricSequence !==
          spool.fabricSequence ||
        intent.fabricEventId !==
          spool.fabricEventId
      )
    ) {
      throw Object.assign(
        new Error(
          'accepted cutover spool disagrees with durable Fabric publication'
        ),
        {
          code:
            'BIOLOGICAL_CUTOVER_SPOOL_CORRUPT'
        }
      );
    }

    if (
      spool.status ===
        'SPOOLED' &&
      intent.status !==
        'PENDING'
    ) {
      throw Object.assign(
        new Error(
          'pending cutover spool disagrees with producer outbox status'
        ),
        {
          code:
            'BIOLOGICAL_CUTOVER_SPOOL_CORRUPT'
        }
      );
    }

    return Object.freeze(
      spool
    );
  }


  getBiologicalCutoverSpoolIntent(
    producerEventId
  ) {
    this.assertOpen();

    const row =
      this.db.prepare(`
        SELECT *
        FROM biological_cutover_spool
        WHERE producer_event_id=?
      `).get(
        producerEventId
      );

    return row
      ? this.biologicalCutoverSpoolFromRow(
          row
        )
      : null;
  }


  listBiologicalCutoverSpool({
    producerCoreId = null,
    status = null
  } = {}) {
    this.assertOpen();

    if (
      status != null &&
      ![
        'SPOOLED',
        'ACCEPTED'
      ].includes(
        status
      )
    ) {
      throw Object.assign(
        new Error(
          'cutover spool status filter is invalid'
        ),
        {
          code:
            'BIOLOGICAL_CUTOVER_SPOOL_QUERY'
        }
      );
    }

    const clauses = [];
    const args = [];

    if (
      producerCoreId != null
    ) {
      clauses.push(
        'producer_core_id=?'
      );
      args.push(
        producerCoreId
      );
    }

    if (
      status != null
    ) {
      clauses.push(
        'status=?'
      );
      args.push(
        status
      );
    }

    const where =
      clauses.length
        ? `WHERE ${clauses.join(' AND ')}`
        : '';

    return this.db.prepare(`
      SELECT *
      FROM biological_cutover_spool
      ${where}
      ORDER BY
        from_authority_epoch ASC,
        producer_stream_id ASC,
        stream_sequence ASC
    `).all(
      ...args
    ).map(
      row =>
        this.biologicalCutoverSpoolFromRow(
          row
        )
    );
  }


  listDrainableBiologicalOutboxIntents({
    producerCoreId,
    currentAuthorityEpoch,
    limit = 256
  }) {
    this.assertOpen();

    const epoch =
      Number(
        currentAuthorityEpoch
      );

    if (
      typeof producerCoreId !==
        'string' ||
      !producerCoreId
    ) {
      throw Object.assign(
        new Error(
          'drainable biological outbox authority is invalid'
        ),
        {
          code:
            'BIOLOGICAL_OUTBOX_DRAIN_AUTHORITY'
        }
      );
    }

    if (
      !Number.isSafeInteger(
        epoch
      ) ||
      epoch < 1
    ) {
      /*
       * Authority-contained residents with no declared output capability have
       * no producer epoch. Their empty outbox is already fully drained and is
       * not an operational failure. A pending row without authority remains a
       * hard error so corruption or an authority leak can never be hidden.
       */
      const pending =
        this.db.prepare(`
          SELECT producer_event_id
          FROM biological_outbox_intents
          WHERE producer_core_id=? AND status='PENDING'
          LIMIT 1
        `).get(
          producerCoreId
        );

      if (!pending) {
        return [];
      }

      throw Object.assign(
        new Error(
          'drainable biological outbox authority is invalid'
        ),
        {
          code:
            'BIOLOGICAL_OUTBOX_DRAIN_AUTHORITY',
          producerEventId:
            pending.producer_event_id
        }
      );
    }

    const future =
      this.db.prepare(`
        SELECT producer_event_id
        FROM biological_outbox_intents
        WHERE
          producer_core_id=? AND
          status='PENDING' AND
          authority_epoch>?
        LIMIT 1
      `).get(
        producerCoreId,
        epoch
      );

    if (
      future
    ) {
      throw Object.assign(
        new Error(
          'producer outbox contains a future authority epoch'
        ),
        {
          code:
            'BIOLOGICAL_OUTBOX_FUTURE_AUTHORITY'
        }
      );
    }

    const orphan =
      this.db.prepare(`
        SELECT o.producer_event_id
        FROM biological_outbox_intents o
        LEFT JOIN biological_cutover_spool s
          ON s.producer_event_id=o.producer_event_id
        WHERE
          o.producer_core_id=? AND
          o.status='PENDING' AND
          o.authority_epoch<? AND
          (
            s.producer_event_id IS NULL OR
            s.status<>'SPOOLED'
          )
        LIMIT 1
      `).get(
        producerCoreId,
        epoch
      );

    if (
      orphan
    ) {
      throw Object.assign(
        new Error(
          'revoked authority has an unspooled pending biological output'
        ),
        {
          code:
            'BIOLOGICAL_CUTOVER_ORPHANED_OUTBOX',

          producerEventId:
            orphan.producer_event_id
        }
      );
    }

    const boundedLimit =
      Math.max(
        1,
        Math.min(
          1024,
          Number(limit) ||
          256
        )
      );

    return this.db.prepare(`
      SELECT o.*
      FROM biological_outbox_intents o
      LEFT JOIN biological_cutover_spool s
        ON s.producer_event_id=o.producer_event_id
      WHERE
        o.producer_core_id=? AND
        o.status='PENDING' AND
        (
          o.authority_epoch=? OR
          (
            o.authority_epoch<? AND
            s.status='SPOOLED'
          )
        )
      ORDER BY
        o.authority_epoch ASC,
        o.producer_stream_id ASC,
        o.stream_sequence ASC
      LIMIT ?
    `).all(
      producerCoreId,
      epoch,
      epoch,
      boundedLimit
    ).map(
      row =>
        this.biologicalOutboxIntentFromRow(
          row
        )
    );
  }


  _spoolPendingBiologicalOutboxForUpgrade({
    transactionId,
    coreId,
    fromEpoch,
    toEpoch,
    barrierSequence,
    spooledAt
  }) {
    const rows =
      this.db.prepare(`
        SELECT *
        FROM biological_outbox_intents
        WHERE
          producer_core_id=? AND
          authority_epoch=? AND
          status='PENDING'
        ORDER BY
          producer_stream_id ASC,
          stream_sequence ASC
      `).all(
        coreId,
        fromEpoch
      );

    const digestEntries = [];

    const insert =
      this.db.prepare(`
        INSERT INTO biological_cutover_spool(
          producer_event_id,
          transaction_id,
          producer_core_id,
          producer_instance_id,
          producer_version,
          from_authority_epoch,
          to_authority_epoch,
          barrier_sequence,
          producer_stream_id,
          stream_sequence,
          proposal_sha256,
          intent_sha256,
          status,
          spool_sha256,
          spooled_at
        )
        VALUES(
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SPOOLED', ?, ?
        )
      `);

    for (
      const row of rows
    ) {
      const intent =
        this.biologicalOutboxIntentFromRow(
          row
        );

      const spool = {
        transactionId,
        producerEventId:
          intent.producerEventId,
        producerCoreId:
          intent.producerCoreId,
        producerInstanceId:
          intent.producerInstanceId,
        producerVersion:
          intent.producerVersion,
        fromAuthorityEpoch:
          fromEpoch,
        toAuthorityEpoch:
          toEpoch,
        barrierSequence,
        producerStreamId:
          intent.producerStreamId,
        streamSequence:
          intent.streamSequence,
        proposalHash:
          intent.proposalHash,
        intentHash:
          intent.intentHash
      };

      const spoolHash =
        sha256(
          stableStringify(
            biologicalCutoverSpoolBody(
              spool
            )
          )
        );

      insert.run(
        spool.producerEventId,
        spool.transactionId,
        spool.producerCoreId,
        spool.producerInstanceId,
        spool.producerVersion,
        spool.fromAuthorityEpoch,
        spool.toAuthorityEpoch,
        spool.barrierSequence,
        spool.producerStreamId,
        spool.streamSequence,
        spool.proposalHash,
        spool.intentHash,
        spoolHash,
        spooledAt
      );

      digestEntries.push({
        producerEventId:
          spool.producerEventId,
        spoolHash
      });
    }

    return {
      count:
        digestEntries.length,

      digest:
        sha256(
          stableStringify(
            digestEntries
          )
        )
    };
  }


  _commitBiologicalOutboxIntents({
    coreId,
    instanceId,
    version,
    authorityEpoch,
    checkpointId,
    checkpointHash,
    checkpointGeneration,
    producerTransitionId,
    consumerAck,
    outboxIntents,
    allowCommittedOutboxReplay = false
  }) {
    if (
      !Array.isArray(
        outboxIntents
      ) ||
      outboxIntents.length >
        64
    ) {
      throw Object.assign(
        new Error(
          'biological outbox batch is invalid'
        ),
        {
          code:
            'BIOLOGICAL_OUTBOX_BATCH'
        }
      );
    }

    if (
      outboxIntents.length ===
      0
    ) {
      return [];
    }

    if (
      typeof producerTransitionId !==
        'string' ||
      !producerTransitionId ||
      producerTransitionId.length >
        256
    ) {
      throw Object.assign(
        new Error(
          'biological outbox requires stable transition identity'
        ),
        {
          code:
            'BIOLOGICAL_OUTBOX_TRANSITION'
        }
      );
    }

    if (
      !consumerAck ||
      consumerAck.transitionId !==
        producerTransitionId
    ) {
      throw Object.assign(
        new Error(
          'biological outbox must belong to the committed biological transition'
        ),
        {
          code:
            'BIOLOGICAL_OUTBOX_TRANSITION'
        }
      );
    }

    const producerStreamId =
      `core:${coreId}:outputs`;

    const outboxHead =
      this.getBiologicalOutboxStreamHead({
        producerCoreId:
          coreId,

        authorityEpoch,

        producerStreamId
      });

    if (
      outboxHead &&
      (
        outboxHead.producerInstanceId !==
          instanceId ||
        outboxHead.producerVersion !==
          version
      )
    ) {
      throw Object.assign(
        new Error(
          'biological outbox producer identity changed inside one authority epoch'
        ),
        {
          code:
            'BIOLOGICAL_OUTBOX_STREAM_IDENTITY'
        }
      );
    }

    let streamSequence =
      outboxHead?.lastStreamSequence ||
      0;

    const committed =
      [];

    let totalBytes =
      0;

    for (
      let i = 0;
      i < outboxIntents.length;
      i += 1
    ) {
      const candidate =
        outboxIntents[i];

      if (
        !candidate ||
        typeof candidate !==
          'object' ||
        Array.isArray(
          candidate
        )
      ) {
        throw Object.assign(
          new Error(
            'biological outbox intent is invalid'
          ),
          {
            code:
              'BIOLOGICAL_OUTBOX_INTENT'
          }
        );
      }

      const outputIndex =
        Number(
          candidate.outputIndex
        );

      if (
        !Number.isSafeInteger(
          outputIndex
        ) ||
        outputIndex !==
          i + 1
      ) {
        throw Object.assign(
          new Error(
            'biological outbox output ordering is invalid'
          ),
          {
            code:
              'BIOLOGICAL_OUTBOX_ORDER'
          }
        );
      }

      const causeSequence =
        Number(
          candidate.causeSequence
        );

      if (
        !Number.isSafeInteger(
          causeSequence
        ) ||
        causeSequence < 1 ||
        causeSequence !==
          Number(
            consumerAck.sequence
          )
      ) {
        throw Object.assign(
          new Error(
            'biological outbox cause does not match originating transition'
          ),
          {
            code:
              'BIOLOGICAL_OUTBOX_CAUSE'
          }
        );
      }

      const topic =
        candidate.topic;

      if (
        typeof topic !==
          'string' ||
        !topic ||
        topic.length >
          200
      ) {
        throw Object.assign(
          new Error(
            'biological outbox topic is invalid'
          ),
          {
            code:
              'BIOLOGICAL_OUTBOX_TOPIC'
          }
        );
      }

      const payload =
        structuredClone(
          candidate.payload
        );

      const causalParent =
        candidate.causalParent == null
          ? null
          : String(
              candidate.causalParent
            );

      const payloadBytes =
        Buffer.byteLength(
          stableStringify(
            payload
          )
        );

      totalBytes +=
        payloadBytes;

      if (
        payloadBytes >
          8 * 1024 ||
        totalBytes >
          64 * 8 * 1024
      ) {
        throw Object.assign(
          new Error(
            'biological outbox payload bound exceeded'
          ),
          {
            code:
              'BIOLOGICAL_OUTBOX_BOUND'
          }
        );
      }

      /*
       * Stable producer identity is independent of
       * output content.
       *
       * A retry that changes content therefore reuses
       * the same identity and becomes a conflict instead
       * of silently becoming another biological cause.
       */
      const producerEventId =
        crypto
          .createHash('sha256')
          .update(
            stableStringify({
              protocol:
                'stay-biological-producer-event-v1',

              coreId,

              authorityEpoch,

              transitionId:
                producerTransitionId,

              outputIndex
            })
          )
          .digest('hex');

      const proposal = {
        protocol:
          'stay-biological-outbox-proposal-v1',

        producer_event_id:
          producerEventId,

        producer_core_id:
          coreId,

        producer_instance_id:
          instanceId,

        producer_version:
          version,

        authority_epoch:
          authorityEpoch,

        transition_id:
          producerTransitionId,

        cause_sequence:
          causeSequence,

        output_index:
          outputIndex,

        topic,

        payload,

        causal_parent:
          causalParent
      };

      const proposalHash =
        sha256(
          stableStringify(
            proposal
          )
        );

      const existing =
        this.db.prepare(`
          SELECT *
          FROM biological_outbox_intents
          WHERE producer_event_id=?
        `).get(
          producerEventId
        );

      if (existing) {
        if (
          existing.proposal_sha256 !==
          proposalHash
        ) {
          throw Object.assign(
            new Error(
              'stable producer event identity was reused with different content'
            ),
            {
              code:
                'BIOLOGICAL_OUTBOX_CONFLICT'
            }
          );
        }

        if (allowCommittedOutboxReplay) {
          committed.push(this.getBiologicalOutboxIntent(producerEventId));
          continue;
        }

        throw Object.assign(
          new Error(
            'authoritative biological transition was already committed'
          ),
          {
            code:
              'BIOLOGICAL_OUTBOX_DUPLICATE_TRANSITION'
          }
        );
      }

      streamSequence +=
        1;

      const publishMeta = {
        outputIndex,

        sourceCore:
          coreId,

        sourceVersion:
          version,

        sourceInstanceId:
          instanceId,

        authorityEpoch,

        causeSequence,

        causalParent,

        deduplicationKey:
          `core-output:${producerEventId}`,

        eventClass:
          'durable'
      };

      const intent = {
        format:
          'stay-biological-outbox-intent-v1',

        producer_event_id:
          producerEventId,

        producer_core_id:
          coreId,

        producer_instance_id:
          instanceId,

        producer_version:
          version,

        authority_epoch:
          authorityEpoch,

        producer_stream_id:
          producerStreamId,

        stream_sequence:
          streamSequence,

        transition_id:
          producerTransitionId,

        cause_sequence:
          causeSequence,

        output_index:
          outputIndex,

        topic,

        payload,

        causal_parent:
          causalParent,

        publish_meta:
          publishMeta,

        checkpoint: {
          id:
            checkpointId,

          hash:
            checkpointHash,

          generation:
            checkpointGeneration
        }
      };

      const intentJson =
        stableStringify(
          intent
        );

      const intentHash =
        sha256(
          intentJson
        );

      const createdAt =
        new Date().toISOString();

      this.db.prepare(`
        INSERT INTO biological_outbox_intents(
          producer_event_id,
          producer_core_id,
          producer_instance_id,
          producer_version,
          authority_epoch,
          producer_stream_id,
          stream_sequence,
          transition_id,
          cause_sequence,
          output_index,
          topic,
          proposal_sha256,
          intent_json,
          intent_sha256,
          checkpoint_id,
          checkpoint_hash,
          checkpoint_generation,
          status,
          created_at
        )
        VALUES(
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?
        )
      `).run(
        producerEventId,
        coreId,
        instanceId,
        version,
        authorityEpoch,
        producerStreamId,
        streamSequence,
        producerTransitionId,
        causeSequence,
        outputIndex,
        topic,
        proposalHash,
        intentJson,
        intentHash,
        checkpointId,
        checkpointHash,
        checkpointGeneration,
        createdAt
      );

      committed.push(
        this.getBiologicalOutboxIntent(
          producerEventId
        )
      );
    }

    const lastIntent =
      committed.at(
        -1
      );

    if (committed.every(intent => intent.checkpointId !== checkpointId)) {
      return committed;
    }

    const nextHead = {
      producerCoreId:
        coreId,

      authorityEpoch,

      producerStreamId,

      producerInstanceId:
        instanceId,

      producerVersion:
        version,

      lastStreamSequence:
        lastIntent.streamSequence,

      lastProducerEventId:
        lastIntent.producerEventId
    };

    const headHash =
      sha256(
        stableStringify(
          biologicalOutboxStreamHeadBody(
            nextHead
          )
        )
      );

    const updatedAt =
      new Date().toISOString();

    if (
      outboxHead
    ) {
      const updated =
        this.db.prepare(`
          UPDATE biological_outbox_stream_heads
          SET
            producer_instance_id=?,
            producer_version=?,
            last_stream_sequence=?,
            last_producer_event_id=?,
            head_sha256=?,
            updated_at=?
          WHERE
            producer_core_id=? AND
            authority_epoch=? AND
            producer_stream_id=? AND
            last_stream_sequence=? AND
            last_producer_event_id=?
        `).run(
          nextHead.producerInstanceId,
          nextHead.producerVersion,
          nextHead.lastStreamSequence,
          nextHead.lastProducerEventId,
          headHash,
          updatedAt,
          nextHead.producerCoreId,
          nextHead.authorityEpoch,
          nextHead.producerStreamId,
          outboxHead.lastStreamSequence,
          outboxHead.lastProducerEventId
        );

      if (
        updated.changes !==
        1
      ) {
        throw Object.assign(
          new Error(
            'biological outbox stream head compare-and-swap failed'
          ),
          {
            code:
              'BIOLOGICAL_OUTBOX_STREAM_CONFLICT'
          }
        );
      }

    } else {
      this.db.prepare(`
        INSERT INTO biological_outbox_stream_heads(
          producer_core_id,
          authority_epoch,
          producer_stream_id,
          producer_instance_id,
          producer_version,
          last_stream_sequence,
          last_producer_event_id,
          head_sha256,
          updated_at
        )
        VALUES(
          ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        nextHead.producerCoreId,
        nextHead.authorityEpoch,
        nextHead.producerStreamId,
        nextHead.producerInstanceId,
        nextHead.producerVersion,
        nextHead.lastStreamSequence,
        nextHead.lastProducerEventId,
        headHash,
        updatedAt
      );
    }

    return committed;
  }

  markBiologicalOutboxPublished({
    producerEventId,
    event
  }) {
    this.assertOpen();

    return this.withTransaction(
      () => {
        const row =
          this.db.prepare(`
            SELECT *
            FROM biological_outbox_intents
            WHERE producer_event_id=?
          `).get(
            producerEventId
          );

        if (!row) {
          throw Object.assign(
            new Error(
              'unknown biological outbox intent'
            ),
            {
              code:
                'BIOLOGICAL_OUTBOX_UNKNOWN'
            }
          );
        }

        const intent =
          this.biologicalOutboxIntentFromRow(
            row
          );

        const sequence =
          Number(
            event?.sequence
          );

        const eventId =
          event?.id;

        if (
          !Number.isSafeInteger(
            sequence
          ) ||
          sequence < 1 ||
          typeof eventId !==
            'string' ||
          !eventId
        ) {
          throw Object.assign(
            new Error(
              'published outbox event identity is invalid'
            ),
            {
              code:
                'BIOLOGICAL_OUTBOX_PUBLISH'
            }
          );
        }

        const durable =
          this.db.prepare(`
            SELECT
              event_id,
              topic,
              deduplication_key
            FROM biological_events
            WHERE sequence=?
          `).get(
            sequence
          );

        if (
          !durable ||
          durable.event_id !==
            eventId ||
          durable.topic !==
            intent.topic ||
          durable.deduplication_key !==
            intent.publishMeta.deduplicationKey
        ) {
          throw Object.assign(
            new Error(
              'outbox publication does not match durable Fabric identity'
            ),
            {
              code:
                'BIOLOGICAL_OUTBOX_PUBLISH'
            }
          );
        }

        if (
          row.status ===
          'PUBLISHED'
        ) {
          if (
            Number(
              row.fabric_sequence
            ) !==
              sequence ||
            row.fabric_event_id !==
              eventId
          ) {
            throw Object.assign(
              new Error(
                'published outbox intent was rebound to another Fabric event'
              ),
              {
                code:
                  'BIOLOGICAL_OUTBOX_CONFLICT'
              }
            );
          }

          return intent;
        }

        const publishedAt =
          new Date().toISOString();

        const updated =
          this.db.prepare(`
            UPDATE biological_outbox_intents
            SET
              status='PUBLISHED',
              fabric_sequence=?,
              fabric_event_id=?,
              published_at=?
            WHERE
              producer_event_id=? AND
              status='PENDING'
          `).run(
            sequence,
            eventId,
            publishedAt,
            producerEventId
          );

        if (
          updated.changes !==
          1
        ) {
          throw Object.assign(
            new Error(
              'biological outbox publication lost pending identity'
            ),
            {
              code:
                'BIOLOGICAL_OUTBOX_CONFLICT'
            }
          );
        }

        /*
         * If this obligation crossed an authority cutover,
         * acceptance of the exact durable Fabric identity also
         * resolves the Kernel-controlled spool entry in the same
         * SQLite transaction as the outbox publication marker.
         */
        const spool =
          this.db.prepare(`
            SELECT *
            FROM biological_cutover_spool
            WHERE producer_event_id=?
          `).get(
            producerEventId
          );

        if (
          spool
        ) {
          if (
            spool.status ===
              'ACCEPTED'
          ) {
            if (
              Number(
                spool.fabric_sequence
              ) !==
                sequence ||
              spool.fabric_event_id !==
                eventId
            ) {
              throw Object.assign(
                new Error(
                  'cutover spool was rebound to another Fabric identity'
                ),
                {
                  code:
                    'BIOLOGICAL_CUTOVER_SPOOL_CONFLICT'
                }
              );
            }

          } else {
            const spoolUpdated =
              this.db.prepare(`
                UPDATE biological_cutover_spool
                SET
                  status='ACCEPTED',
                  fabric_sequence=?,
                  fabric_event_id=?,
                  accepted_at=?
                WHERE
                  producer_event_id=? AND
                  status='SPOOLED'
              `).run(
                sequence,
                eventId,
                publishedAt,
                producerEventId
              );

            if (
              spoolUpdated.changes !==
              1
            ) {
              throw Object.assign(
                new Error(
                  'cutover spool lost pending publication identity'
                ),
                {
                  code:
                    'BIOLOGICAL_CUTOVER_SPOOL_CONFLICT'
                }
              );
            }
          }
        }

        return this.getBiologicalOutboxIntent(
          producerEventId
        );
      }
    );
  }

  async commitCheckpoint({
    coreId,
    instanceId,
    version,
    authorityEpoch,
    stateSchema,
    state,
    updateAuthority = true,
    consumerAck = null,
    producerTransitionId = null,
    outboxIntents = []
  }) {
    if (
      !Array.isArray(
        outboxIntents
      ) ||
      outboxIntents.length >
        64
    ) {
      throw Object.assign(
        new Error(
          'checkpoint outbox batch is invalid'
        ),
        {
          code:
            'BIOLOGICAL_OUTBOX_BATCH'
        }
      );
    }

    if (
      outboxIntents.length >
        0 &&
      !updateAuthority
    ) {
      throw Object.assign(
        new Error(
          'non-authoritative checkpoint may not create biological outbox intents'
        ),
        {
          code:
            'BIOLOGICAL_OUTBOX_AUTHORITY'
        }
      );
    }

    const json =
      JSON.stringify(
        state ?? {}
      );

    const blob =
      await this.putBlob(
        json
      );

    const createdAt =
      new Date().toISOString();

    const checkpointId =
      crypto.randomUUID();

    const result =
      this.withTransaction(
        () => {
          const generationRow =
            this.db.prepare(
              'SELECT COALESCE(MAX(generation), 0) AS generation FROM checkpoints WHERE core_id = ?'
            ).get(
              coreId
            );

          const generation =
            Number(
              generationRow?.generation ||
              0
            ) + 1;

          const provenanceRow =
            this.db.prepare(`
              SELECT input_cursor
              FROM checkpoints
              WHERE
                core_id=? AND
                instance_id=? AND
                version=? AND
                authority_epoch=?
              ORDER BY generation DESC
              LIMIT 1
            `).get(
              coreId,
              instanceId,
              version,
              authorityEpoch
            );

          const inputCursor =
            consumerAck
              ? Number(
                  consumerAck.sequence
                ) || 0
              : Number(
                  provenanceRow?.input_cursor
                ) || 0;

          this.db.prepare(`
            INSERT INTO checkpoints(
              checkpoint_id,
              core_id,
              instance_id,
              version,
              authority_epoch,
              state_schema,
              generation,
              blob_hash,
              byte_length,
              input_cursor,
              created_at
            )
            VALUES(
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
          `).run(
            checkpointId,
            coreId,
            instanceId,
            version,
            authorityEpoch,
            stateSchema,
            generation,
            blob.hash,
            blob.byteLength,
            inputCursor,
            createdAt
          );

          if (updateAuthority) {
            const updated =
              this.db.prepare(`
                UPDATE authority
                SET
                  checkpoint_hash=?,
                  updated_at=?
                WHERE
                  core_id=? AND
                  instance_id=? AND
                  version=? AND
                  epoch=?
              `).run(
                blob.hash,
                createdAt,
                coreId,
                instanceId,
                version,
                authorityEpoch
              );

            if (
              updated.changes !==
              1
            ) {
              throw Object.assign(
                new Error(
                  'checkpoint does not belong to current authority'
                ),
                {
                  code:
                    'CHECKPOINT_AUTHORITY_CONFLICT'
                }
              );
            }
          }

          if (consumerAck) {
            const delivery =
              this.db.prepare(`
                SELECT status
                FROM biological_deliveries
                WHERE
                  consumer_id=? AND
                  sequence=?
              `).get(
                consumerAck.consumerId,
                consumerAck.sequence
              );

            if (!delivery) {
              throw Object.assign(
                new Error(
                  'checkpoint acknowledgement has no durable delivery'
                ),
                {
                  code:
                    'BIOLOGICAL_DELIVERY_MISSING'
                }
              );
            }

            if (
              delivery.status !==
              'ACKED'
            ) {
              this.db.prepare(`
                UPDATE biological_deliveries
                SET
                  status='ACKED',
                  transition_id=?,
                  checkpoint_hash=?,
                  acknowledged_at=?
                WHERE
                  consumer_id=? AND
                  sequence=? AND
                  status='PENDING'
              `).run(
                consumerAck.transitionId ||
                  null,
                blob.hash,
                createdAt,
                consumerAck.consumerId,
                consumerAck.sequence
              );
            }

            const cursor =
              this.advanceBiologicalCursor(
                consumerAck.consumerId,
                createdAt
              );

            this.db.prepare(`
              UPDATE biological_consumers
              SET
                checkpoint_hash=?,
                authority_epoch=?,
                updated_at=?
              WHERE consumer_id=?
            `).run(
              blob.hash,
              authorityEpoch,
              createdAt,
              consumerAck.consumerId
            );

            if (
              cursor <
              consumerAck.sequence
            ) {
              // Earlier pending deliveries legitimately
              // prevent the cursor crossing this event.
            }
          }

          /*
           * EF1-D / P0.34
           *
           * Checkpoint, authority pointer, incorporated
           * input ACK and output obligation are one commit.
           *
           * No Fabric publication occurs inside this tx.
           */
          const committedOutbox =
            this._commitBiologicalOutboxIntents({
              coreId,
              instanceId,
              version,
              authorityEpoch,
              checkpointId,
              checkpointHash:
                blob.hash,
              checkpointGeneration:
                generation,
              producerTransitionId,
              consumerAck,
              outboxIntents
            });

          return {
            checkpointId,
            generation,
            outboxIntents:
              committedOutbox
          };
        }
      );

    this.markWriteSuccess();

    await this.runMaintenance(
      'authoritative-checkpoint-retention',
      () => this.pruneCheckpoints(
        coreId,
        32
      )
    );

    return {
      ...result,
      coreId,
      instanceId,
      version,
      authorityEpoch,
      stateSchema,
      blobHash:
        blob.hash,
      byteLength:
        blob.byteLength,
      createdAt
    };
  }

  async pruneCheckpoints(coreId, retention = 32) {
    const rows = this.db.prepare('SELECT checkpoint_id, blob_hash FROM checkpoints WHERE core_id=? ORDER BY generation DESC').all(coreId);
    const candidates =
      rows.slice(
        Math.max(
          1,
          retention
        )
      );

    /*
     * A committed-but-undrained biological obligation
     * pins the checkpoint that produced it.
     *
     * Once published, normal checkpoint retention may
     * reclaim that historical checkpoint.
     */
    const remove =
      candidates.filter(
        row =>
          !this.db.prepare(`
            SELECT 1
            FROM biological_outbox_intents
            WHERE
              checkpoint_id=? AND
              status='PENDING'
            LIMIT 1
          `).get(
            row.checkpoint_id
          )
      );
    if (!remove.length) return;
    this.withTransaction(() => {
      const statement = this.db.prepare('DELETE FROM checkpoints WHERE checkpoint_id=?');
      for (const row of remove) statement.run(row.checkpoint_id);
    });
    for (const row of remove) {
      await this.deleteBlobIfUnreferenced(row.blob_hash);
    }
  }

  async readLatestCheckpoint(coreId, version = null) {
    const sql = version
      ? 'SELECT * FROM checkpoints WHERE core_id = ? AND version = ? ORDER BY generation DESC LIMIT 1'
      : 'SELECT * FROM checkpoints WHERE core_id = ? ORDER BY generation DESC LIMIT 1';
    const row = version ? this.db.prepare(sql).get(coreId, version) : this.db.prepare(sql).get(coreId);
    if (!row) return null;
    const bytes = await this.readBlob(row.blob_hash);
    return {
      checkpointId: row.checkpoint_id,
      coreId: row.core_id,
      instanceId: row.instance_id,
      version: row.version,
      authorityEpoch: row.authority_epoch,
      stateSchema: row.state_schema,
      generation: row.generation,
      blobHash: row.blob_hash,
      byteLength: row.byte_length,
      inputCursor: Number(row.input_cursor) || 0,
      createdAt: row.created_at,
      state: JSON.parse(bytes.toString('utf8'))
    };
  }

  async readAuthoritativeCheckpoint(coreId) {
    const authority = this.getAuthority(coreId);
    if (!authority) return null;
    if (!authority.checkpointHash) {
      throw Object.assign(new Error(`authority ${coreId} has no checkpoint pointer`), { code: 'AUTHORITY_CHECKPOINT_MISSING' });
    }
    const row = this.db.prepare(`SELECT * FROM checkpoints
      WHERE core_id=? AND instance_id=? AND version=? AND authority_epoch=? AND blob_hash=?
      ORDER BY generation DESC LIMIT 1`).get(
      coreId, authority.instanceId, authority.version, authority.epoch, authority.checkpointHash
    );
    if (!row) {
      throw Object.assign(new Error(`authoritative checkpoint tuple is missing for ${coreId}`), { code: 'AUTHORITY_CHECKPOINT_MISMATCH' });
    }
    const bytes = await this.readBlob(row.blob_hash);
    return {
      checkpointId: row.checkpoint_id,
      coreId: row.core_id,
      instanceId: row.instance_id,
      version: row.version,
      authorityEpoch: row.authority_epoch,
      stateSchema: row.state_schema,
      generation: row.generation,
      blobHash: row.blob_hash,
      byteLength: row.byte_length,
      inputCursor: Number(row.input_cursor) || 0,
      createdAt: row.created_at,
      state: JSON.parse(bytes.toString('utf8'))
    };
  }

  getAuthority(coreId) {
    const row = this.db.prepare('SELECT * FROM authority WHERE core_id = ?').get(coreId);
    return row ? {
      coreId: row.core_id,
      instanceId: row.instance_id,
      version: row.version,
      epoch: row.epoch,
      barrierSequence: row.barrier_sequence,
      checkpointHash: row.checkpoint_hash,
      updatedAt: row.updated_at
    } : null;
  }

  listAuthority() {
    return this.db.prepare('SELECT core_id FROM authority ORDER BY core_id').all().map(row => this.getAuthority(row.core_id));
  }

  setInitialAuthority({ coreId, instanceId, version, epoch = 1, barrierSequence = 0 }) {
    const existing = this.getAuthority(coreId);
    if (existing) return existing;
    const at = new Date().toISOString();
    this.withTransaction(() => this.db.prepare(`INSERT INTO authority(core_id, instance_id, version, epoch, barrier_sequence, updated_at)
      VALUES(?, ?, ?, ?, ?, ?)`).run(coreId, instanceId, version, epoch, barrierSequence, at));
    this.markWriteSuccess();
    return this.getAuthority(coreId);
  }

  prepareUpgrade({ coreId, from, to, barrierSequence, checkpoint, detail = {} }) {
    const current = this.getAuthority(coreId);
    if (!current || current.instanceId !== from.instanceId || current.epoch !== from.epoch) {
      throw Object.assign(new Error('authority changed before upgrade preparation'), { code: 'AUTHORITY_CONFLICT' });
    }
    if (checkpoint && (checkpoint.coreId !== coreId || checkpoint.instanceId !== to.instanceId
      || checkpoint.version !== to.version || checkpoint.authorityEpoch !== to.epoch
      || !checkpoint.blobHash)) {
      throw Object.assign(new Error('upgrade target checkpoint tuple is invalid'), { code: 'UPGRADE_CHECKPOINT_INVALID' });
    }
    const transactionId = crypto.randomUUID();
    const preparedAt = new Date().toISOString();
    this.withTransaction(() => this.db.prepare(`INSERT INTO upgrade_transactions(
      transaction_id, core_id, status, from_instance_id, from_version, from_epoch,
      to_instance_id, to_version, to_epoch, barrier_sequence, prepared_at,
      to_checkpoint_hash, to_state_schema, detail_json
    ) VALUES(?, ?, 'PREPARED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      transactionId, coreId, from.instanceId, from.version, from.epoch,
      to.instanceId, to.version, to.epoch, barrierSequence, preparedAt,
      checkpoint?.blobHash || null, checkpoint?.stateSchema || null, JSON.stringify(detail)
    ));
    this.markWriteSuccess();
    return { transactionId, coreId, status: 'PREPARED', preparedAt, barrierSequence, from, to };
  }

  commitUpgrade(transactionId) {
    const at = new Date().toISOString();

    const result = this.withTransaction(() => {
      const tx = this.db.prepare(
        'SELECT * FROM upgrade_transactions WHERE transaction_id = ?'
      ).get(transactionId);

      if (!tx || tx.status !== 'PREPARED') {
        throw Object.assign(
          new Error('upgrade transaction is not prepared'),
          { code: 'UPGRADE_STATE' }
        );
      }

      const authority = this.getAuthority(tx.core_id);

      if (
        !authority ||
        authority.instanceId !== tx.from_instance_id ||
        authority.epoch !== tx.from_epoch
      ) {
        throw Object.assign(
          new Error('authority changed during upgrade transaction'),
          { code: 'AUTHORITY_CONFLICT' }
        );
      }

      const checkpoint = this.db.prepare(`
        SELECT checkpoint_id
        FROM checkpoints
        WHERE
          core_id=? AND
          instance_id=? AND
          version=? AND
          authority_epoch=? AND
          state_schema=? AND
          blob_hash=?
        LIMIT 1
      `).get(
        tx.core_id,
        tx.to_instance_id,
        tx.to_version,
        tx.to_epoch,
        tx.to_state_schema,
        tx.to_checkpoint_hash
      );

      if (!checkpoint) {
        throw Object.assign(
          new Error(
            'upgrade checkpoint disappeared or does not match target authority'
          ),
          { code: 'UPGRADE_CHECKPOINT_MISMATCH' }
        );
      }

      /*
       * EF1-G / P0.35 — authority-cutover outbox barrier.
       *
       * Every old-epoch output obligation that is still pending at
       * the cutover barrier is copied into a Kernel-owned immutable
       * spool BEFORE authority is changed. Both operations live in
       * this one BEGIN IMMEDIATE transaction, so there is no crash
       * state in which the old epoch is revoked while a committed
       * output has become ownerless.
       */
      const spool =
        this._spoolPendingBiologicalOutboxForUpgrade({
          transactionId:
            tx.transaction_id,

          coreId:
            tx.core_id,

          fromEpoch:
            Number(tx.from_epoch),

          toEpoch:
            Number(tx.to_epoch),

          barrierSequence:
            Number(tx.barrier_sequence),

          spooledAt:
            at
        });

      const sealed =
        this.db.prepare(`
          UPDATE upgrade_transactions
          SET
            spooled_intent_count=?,
            spool_sha256=?,
            cutover_sealed_at=?
          WHERE
            transaction_id=? AND
            status='PREPARED'
        `).run(
          spool.count,
          spool.digest,
          at,
          transactionId
        );

      if (
        sealed.changes !== 1
      ) {
        throw Object.assign(
          new Error(
            'authority cutover spool seal lost upgrade identity'
          ),
          { code: 'BIOLOGICAL_CUTOVER_SPOOL_CONFLICT' }
        );
      }

      const updated = this.db.prepare(`
        UPDATE authority
        SET
          instance_id=?,
          version=?,
          epoch=?,
          barrier_sequence=?,
          checkpoint_hash=?,
          updated_at=?
        WHERE
          core_id=? AND
          instance_id=? AND
          epoch=?
      `).run(
        tx.to_instance_id,
        tx.to_version,
        tx.to_epoch,
        tx.barrier_sequence,
        tx.to_checkpoint_hash,
        at,
        tx.core_id,
        tx.from_instance_id,
        tx.from_epoch
      );

      if (updated.changes !== 1) {
        throw Object.assign(
          new Error('authority compare-and-swap failed'),
          { code: 'AUTHORITY_CONFLICT' }
        );
      }

      this.db.prepare(`
        UPDATE upgrade_transactions
        SET
          status='COMMITTED',
          finalized_at=?
        WHERE transaction_id=?
      `).run(
        at,
        transactionId
      );

      return tx.core_id;
    });

    this.markWriteSuccess();
    return this.getAuthority(result);
  }


  getUpgradeTransaction(transactionId) {
    this.assertOpen();

    const row =
      this.db.prepare(`
        SELECT *
        FROM upgrade_transactions
        WHERE transaction_id=?
      `).get(
        transactionId
      );

    if (!row) {
      return null;
    }

    const spooledIntentCount =
      Number(
        row.spooled_intent_count ||
        0
      );

    const spoolHash =
      row.spool_sha256 ||
      null;

    const cutoverSealedAt =
      row.cutover_sealed_at ||
      null;

    /*
     * EF1-G seal integrity.  Historical upgrade rows created before
     * biological-cutover schema v1 have no cutover_sealed_at and stay
     * readable as legacy evidence.  New sealed rows must prove that the
     * aggregate spool identity still matches the transaction seal.
     */
    if (
      cutoverSealedAt != null
    ) {
      const entries =
        this.db.prepare(`
          SELECT *
          FROM biological_cutover_spool
          WHERE transaction_id=?
          ORDER BY
            producer_stream_id ASC,
            stream_sequence ASC,
            producer_event_id ASC
        `).all(
          transactionId
        ).map(
          spoolRow => {
            const spool =
              this.biologicalCutoverSpoolFromRow(
                spoolRow
              );

            return {
              producerEventId:
                spool.producerEventId,

              spoolHash:
                spoolRow.spool_sha256
            };
          }
        );

      const actualHash =
        sha256(
          stableStringify(
            entries
          )
        );

      if (
        entries.length !==
          spooledIntentCount ||
        typeof spoolHash !==
          'string' ||
        actualHash !==
          spoolHash
      ) {
        throw Object.assign(
          new Error(
            'authority cutover transaction spool seal is corrupt'
          ),
          {
            code:
              'BIOLOGICAL_CUTOVER_SPOOL_CORRUPT'
          }
        );
      }
    }

    return Object.freeze({
      transactionId:
        row.transaction_id,

      coreId:
        row.core_id,

      status:
        row.status,

      from:
        Object.freeze({
          instanceId: row.from_instance_id,
          version: row.from_version,
          epoch: Number(row.from_epoch)
        }),

      to:
        Object.freeze({
          instanceId: row.to_instance_id,
          version: row.to_version,
          epoch: Number(row.to_epoch)
        }),

      barrierSequence:
        Number(row.barrier_sequence),

      spooledIntentCount,

      spoolHash,

      cutoverSealedAt,

      preparedAt:
        row.prepared_at,

      finalizedAt:
        row.finalized_at || null
    });
  }

  abortUpgrade(transactionId, reason = 'aborted') {
    const at = new Date().toISOString();
    this.withTransaction(() => {
      const tx = this.db.prepare('SELECT status, detail_json FROM upgrade_transactions WHERE transaction_id = ?').get(transactionId);
      if (!tx || tx.status !== 'PREPARED') return;
      const detail = { ...JSON.parse(tx.detail_json || '{}'), abortReason: reason };
      this.db.prepare(`UPDATE upgrade_transactions SET status='ABORTED', finalized_at=?, detail_json=? WHERE transaction_id=?`)
        .run(at, JSON.stringify(detail), transactionId);
    });
    this.markWriteSuccess();
  }

  async reconcileIncompleteUpgrades() {
    const rows = this.db.prepare(`SELECT * FROM upgrade_transactions WHERE status='PREPARED'`).all();
    for (const tx of rows) {
      const authority = this.getAuthority(tx.core_id);
      const resolved = authority?.instanceId === tx.to_instance_id && authority?.epoch === tx.to_epoch ? 'COMMITTED' : 'ABORTED';
      const at = new Date().toISOString();
      this.withTransaction(() => {
        this.db.prepare('UPDATE upgrade_transactions SET status=?, finalized_at=? WHERE transaction_id=?').run(resolved, at, tx.transaction_id);
        this.db.prepare('INSERT INTO recovery_records(type, core_id, detail_json, created_at) VALUES(?, ?, ?, ?)')
          .run('upgrade.reconciled', tx.core_id, JSON.stringify({ transactionId: tx.transaction_id, resolved }), at);
      });
    }
    return rows.length;
  }

  recordRecovery(type, coreId, detail = {}) {
    const at = new Date().toISOString();
    try {
      this.withTransaction(() => {
        this.db.prepare('INSERT INTO recovery_records(type, core_id, detail_json, created_at) VALUES(?, ?, ?, ?)')
          .run(type, coreId || null, JSON.stringify(detail), at);
        this.db.prepare('DELETE FROM recovery_records WHERE id NOT IN (SELECT id FROM recovery_records ORDER BY id DESC LIMIT 10000)').run();
      });
    } catch (error) {
      this.markWriteFailure(error);
      throw error;
    }
    this.markWriteSuccess();
  }

  async createSnapshot({ reason = 'periodic', retention = 24 } = {}) {
    const snapshotsRoot = path.join(this.rootDir, 'snapshots');
    const createdAt = new Date().toISOString();
    const safeReason = String(reason).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 48) || 'snapshot';
    const name = createdAt.replace(/[:.]/g, '-') + '-' + safeReason;
    const finalDir = path.join(snapshotsRoot, name);
    const tempDir = finalDir + '.tmp-' + process.pid;
    let snapshotBlobHashes = new Set();
    let snapshotAuthority = [];
    let snapshotResidents = [];
    let blobsPinned = false;
    let completed = false;
    try {
      await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });

      /*
       * Pin the exact blob closure and create the SQLite image without an
       * intervening await. Checkpoint retention therefore cannot unlink a
       * selected blob or add a newer reference to this snapshot image.
       */
      snapshotBlobHashes = new Set(
        this.db.prepare(`
          SELECT blob_hash FROM checkpoints
          UNION
          SELECT blob_hash FROM resident_checkpoints
          UNION
          SELECT checkpoint_hash AS blob_hash
          FROM authority
          WHERE checkpoint_hash IS NOT NULL
          UNION
          SELECT checkpoint_hash AS blob_hash
          FROM resident_instances
          WHERE checkpoint_hash IS NOT NULL
        `).all().map(row => row.blob_hash)
      );
      this.pinSnapshotBlobs(snapshotBlobHashes);
      blobsPinned = true;
      snapshotAuthority = this.listAuthority();
      snapshotResidents = this.listResidents();

      const snapshotDatabasePath = path.join(tempDir, 'continuity.sqlite3');
      const escapedSnapshotPath = snapshotDatabasePath.replaceAll("'", "''");
      this.db.exec(`VACUUM INTO '${escapedSnapshotPath}'`);
      const snapshotDb = new DatabaseSync(snapshotDatabasePath);
      try {
        const check = snapshotDb.prepare('PRAGMA quick_check').get();
        if (String(check?.quick_check || '').toLowerCase() !== 'ok') {
          throw Object.assign(new Error('snapshot SQLite image failed quick_check'), { code: 'SNAPSHOT_INTEGRITY' });
        }
      } finally { snapshotDb.close(); }
      const selected = [];
      for (const relative of ['life/identity.json', 'life/runtime-heartbeat.json', 'legacy-0.6.0/genesis-state.json']) {
        const source = path.join(this.rootDir, relative);
        if (await exists(source)) selected.push(source);
      }
      for (const hash of snapshotBlobHashes) {
        const source = this.blobPath(hash);
        if (!(await exists(source))) {
          throw Object.assign(
            new Error(`snapshot referenced blob is missing: ${hash}`),
            { code: 'SNAPSHOT_BLOB_MISSING' }
          );
        }
        selected.push(source);
      }

      const manifest = {
        format: 'stay-runtime-snapshot-v2',
        createdAt,
        reason,
        files: {
          'continuity.sqlite3':
            await sha256File(snapshotDatabasePath)
        },
        authority:
          snapshotAuthority,
        residents:
          snapshotResidents
      };
      for (const source of selected) {
        const relative = path.relative(this.rootDir, source);
        const target = path.join(tempDir, relative);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.copyFile(source, target);
        manifest.files[relative] = await sha256File(target);
      }
      await atomicWrite(path.join(tempDir, 'SNAPSHOT_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
      await fs.rename(tempDir, finalDir);
      completed = true;
      await fsyncDirectory(snapshotsRoot);
      this.markWriteSuccess();
      await this.runMaintenance(
        'snapshot-and-journal-retention',
        async () => {
          await this.pruneSnapshots(retention);
          await this.pruneJournal(30);
          this.pruneUpgradeHistory(1000);
        }
      );
      return { name, path: finalDir, createdAt, reason, fileCount: Object.keys(manifest.files).length };
    } finally {
      try {
        if (blobsPinned) await this.releaseSnapshotBlobs(snapshotBlobHashes);
      } finally {
        if (!completed) await fs.rm(tempDir, { recursive: true, force: true });
      }
    }
  }

  async pruneJournal(retentionDays = 30) {
    const journalRoot = path.join(this.rootDir, 'journal');
    const cutoff = Date.now() - Math.max(1, retentionDays) * 86400000;
    for (const entry of await fs.readdir(journalRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) continue;
      const date = Date.parse(entry.name.slice(0, 10) + 'T00:00:00.000Z');
      if (Number.isFinite(date) && date < cutoff) await fs.unlink(path.join(journalRoot, entry.name));
    }
  }

  pruneUpgradeHistory(retention = 1000) {
    this.withTransaction(() => this.db.prepare(`DELETE FROM upgrade_transactions
      WHERE status <> 'PREPARED' AND transaction_id NOT IN (
        SELECT transaction_id FROM upgrade_transactions WHERE status <> 'PREPARED' ORDER BY COALESCE(finalized_at, prepared_at) DESC LIMIT ?
      )`).run(Math.max(1, retention)));
  }

  async verifySnapshot(snapshotPath) {
    const manifest = JSON.parse(await fs.readFile(path.join(snapshotPath, 'SNAPSHOT_MANIFEST.json'), 'utf8'));
    for (const [relative, expected] of Object.entries(manifest.files || {})) {
      if (await sha256File(path.join(snapshotPath, relative)) !== expected) throw new Error('snapshot hash mismatch: ' + relative);
    }
    return manifest;
  }

  async pruneSnapshots(retention = 24) {
    const snapshotsRoot = path.join(this.rootDir, 'snapshots');
    const entries = (await fs.readdir(snapshotsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.name.includes('.tmp-')).map(entry => entry.name).sort();
    for (const name of entries.slice(0, Math.max(0, entries.length - Math.max(1, retention)))) {
      await fs.rm(path.join(snapshotsRoot, name), { recursive: true, force: true });
    }
  }

  async snapshotStatus() {
    const snapshotsRoot = path.join(this.rootDir, 'snapshots');
    const entries = (await fs.readdir(snapshotsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.name.includes('.tmp-')).map(entry => entry.name).sort();
    return { format: 'stay-runtime-snapshot-v2', count: entries.length, latest: entries.at(-1) || null };
  }

  close() {
    if (!this.db) return;
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close();
    this.db = null;
  }
}

module.exports = { StateStore, atomicWrite, sha256File, sha256, fsyncDirectory };
