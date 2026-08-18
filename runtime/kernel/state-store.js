'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { stableStringify } = require('./canonical-json');

async function fsyncDirectory(dirPath) {
  let handle;
  try { handle = await fs.open(dirPath, 'r'); await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}

async function atomicWrite(filePath, data, mode = 0o600) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const handle = await fs.open(tmp, 'wx', mode);
  try { await handle.writeFile(data); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(tmp, filePath);
  await fsyncDirectory(dir);
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; }
  catch { return false; }
}

function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
async function sha256File(filePath) { return sha256(await fs.readFile(filePath)); }

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
  }

  async init() {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    for (const relative of ['life', 'cores', 'journal', 'snapshots', 'blobs/sha256']) {
      await fs.mkdir(path.join(this.rootDir, relative), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
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
    await this.importLegacyMetadata();
    await this.reconcileMetadataMirrors();
    await this.assertCanonicalLifeMirror('identity');
    await this.reconcileIncompleteUpgrades();
    this.markWriteSuccess();
    return this;
  }

  assertOpen() { if (!this.db) throw new Error('StateStore is not initialized'); }

  withTransaction(fn) {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }

  lifePath(name) { return path.join(this.rootDir, 'life', name + '.json'); }
  corePath(coreId, channel = 'active') { return path.join(this.rootDir, 'cores', coreId, channel + '.json'); }

  markWriteSuccess() { this.lastSuccessfulWriteAt = new Date().toISOString(); this.lastWriteError = null; }
  markWriteFailure(error) { this.lastWriteError = { at: new Date().toISOString(), code: error.code || null, message: error.message }; }

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

  registerBiologicalConsumer({ consumerId, coreId, topics = [], required = true, authorityEpoch = 0 }) {
    if (typeof consumerId !== 'string' || !consumerId || consumerId.length > 200) throw Object.assign(new Error('invalid biological consumer id'), { code: 'BIOLOGICAL_CONSUMER_ID' });
    if (typeof coreId !== 'string' || !coreId) throw Object.assign(new Error('invalid biological consumer core'), { code: 'BIOLOGICAL_CONSUMER_CORE' });
    const normalizedTopics = [...new Set(topics.map(String))].sort();
    const topicsJson = stableStringify(normalizedTopics);
    const topicsHash = sha256(topicsJson);
    const at = new Date().toISOString();
    return this.withTransaction(() => {
      const existing = this.db.prepare('SELECT * FROM biological_consumers WHERE consumer_id=?').get(consumerId);
      if (existing && existing.core_id !== coreId) throw Object.assign(new Error('biological consumer identity changed core'), { code: 'BIOLOGICAL_CONSUMER_MISMATCH' });
      if (!existing) {
        const highWater = Number(this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM biological_events').get()?.value || 0);
        this.db.prepare(`INSERT INTO biological_consumers(consumer_id, core_id, required, active, topics_json, topics_sha256,
          cursor, authority_epoch, registered_at, updated_at) VALUES(?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`).run(
          consumerId, coreId, required ? 1 : 0, topicsJson, topicsHash, highWater, Number(authorityEpoch) || 0, at, at
        );
      } else {
        this.db.prepare(`UPDATE biological_consumers SET required=?, active=1, topics_json=?, topics_sha256=?, authority_epoch=?, updated_at=?
          WHERE consumer_id=?`).run(required ? 1 : 0, topicsJson, topicsHash, Number(authorityEpoch) || 0, at, consumerId);
      }
      return this.getBiologicalConsumer(consumerId);
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
    const healthy = integrity === 'ok' && Boolean(heartbeatAt) && heartbeatAgeMs <= maxHeartbeatAgeMs && !this.lastWriteError;
    return {
      ok: healthy,
      format: 'stay-statestore-v3',
      sqliteJournalMode: String(this.db.prepare('PRAGMA journal_mode').get()?.journal_mode || '').toLowerCase(),
      sqliteSynchronous: this.db.prepare('PRAGMA synchronous').get()?.synchronous,
      integrity,
      heartbeatAt,
      heartbeatAgeMs,
      lastSuccessfulWriteAt: this.lastSuccessfulWriteAt,
      lastWriteError: this.lastWriteError
    };
  }

  blobPath(hash) { return path.join(this.blobRoot, hash.slice(0, 2), hash); }

  async putBlob(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const hash = sha256(bytes);
    const filePath = this.blobPath(hash);
    if (!(await exists(filePath))) await atomicWrite(filePath, bytes, 0o600);
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

  async commitResidentCheckpoint({
    residencyId,
    instanceId,
    version,
    stateSchema,
    state,
    consumerAck = null
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

    const result =
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

        return {
          checkpointId,
          generation
        };
      });

    this.markWriteSuccess();

    await this.pruneResidentCheckpoints(
      residencyId,
      32
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
      const authoritativeCheckpointRefs =
        Number(
          this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM checkpoints
            WHERE blob_hash=?
          `).get(row.blob_hash)?.count || 0
        );

      const authorityRefs =
        Number(
          this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM authority
            WHERE checkpoint_hash=?
          `).get(row.blob_hash)?.count || 0
        );

      const residentCheckpointRefs =
        Number(
          this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM resident_checkpoints
            WHERE blob_hash=?
          `).get(row.blob_hash)?.count || 0
        );

      const residentPointerRefs =
        Number(
          this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM resident_instances
            WHERE checkpoint_hash=?
          `).get(row.blob_hash)?.count || 0
        );

      if (
        authoritativeCheckpointRefs === 0 &&
        authorityRefs === 0 &&
        residentCheckpointRefs === 0 &&
        residentPointerRefs === 0
      ) {
        await fs.unlink(
          this.blobPath(row.blob_hash)
        ).catch(error => {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        });
      }
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

  async commitCheckpoint({ coreId, instanceId, version, authorityEpoch, stateSchema, state, updateAuthority = true, consumerAck = null }) {
    const json = JSON.stringify(state ?? {});
    const blob = await this.putBlob(json);
    const createdAt = new Date().toISOString();
    const checkpointId = crypto.randomUUID();
    const result = this.withTransaction(() => {
      const row = this.db.prepare('SELECT COALESCE(MAX(generation), 0) AS generation FROM checkpoints WHERE core_id = ?').get(coreId);
      const generation = Number(row?.generation || 0) + 1;
      const inputCursor = consumerAck ? Number(consumerAck.sequence) || 0 : 0;
      this.db.prepare(`INSERT INTO checkpoints(checkpoint_id, core_id, instance_id, version, authority_epoch, state_schema, generation, blob_hash, byte_length, input_cursor, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        checkpointId, coreId, instanceId, version, authorityEpoch, stateSchema, generation, blob.hash, blob.byteLength, inputCursor, createdAt
      );
      if (updateAuthority) {
        const updated = this.db.prepare(`UPDATE authority SET checkpoint_hash = ?, updated_at = ?
          WHERE core_id = ? AND instance_id = ? AND version = ? AND epoch = ?`)
          .run(blob.hash, createdAt, coreId, instanceId, version, authorityEpoch);
        if (updated.changes !== 1) {
          throw Object.assign(new Error('checkpoint does not belong to current authority'), { code: 'CHECKPOINT_AUTHORITY_CONFLICT' });
        }
      }
      if (consumerAck) {
        const delivery = this.db.prepare('SELECT status FROM biological_deliveries WHERE consumer_id=? AND sequence=?')
          .get(consumerAck.consumerId, consumerAck.sequence);
        if (!delivery) throw Object.assign(new Error('checkpoint acknowledgement has no durable delivery'), { code: 'BIOLOGICAL_DELIVERY_MISSING' });
        if (delivery.status !== 'ACKED') {
          this.db.prepare(`UPDATE biological_deliveries SET status='ACKED', transition_id=?, checkpoint_hash=?, acknowledged_at=?
            WHERE consumer_id=? AND sequence=? AND status='PENDING'`).run(
            consumerAck.transitionId || null, blob.hash, createdAt, consumerAck.consumerId, consumerAck.sequence
          );
        }
        const cursor = this.advanceBiologicalCursor(consumerAck.consumerId, createdAt);
        this.db.prepare('UPDATE biological_consumers SET checkpoint_hash=?, authority_epoch=?, updated_at=? WHERE consumer_id=?')
          .run(blob.hash, authorityEpoch, createdAt, consumerAck.consumerId);
        if (cursor < consumerAck.sequence) {
          // Out-of-order completion is legal; the cursor advances only after earlier pending deliveries cross.
        }
      }
      return { checkpointId, generation };
    });
    this.markWriteSuccess();
    await this.pruneCheckpoints(coreId, 32);
    return { ...result, coreId, instanceId, version, authorityEpoch, stateSchema, blobHash: blob.hash, byteLength: blob.byteLength, createdAt };
  }

  async pruneCheckpoints(coreId, retention = 32) {
    const rows = this.db.prepare('SELECT checkpoint_id, blob_hash FROM checkpoints WHERE core_id=? ORDER BY generation DESC').all(coreId);
    const remove = rows.slice(Math.max(1, retention));
    if (!remove.length) return;
    this.withTransaction(() => {
      const statement = this.db.prepare('DELETE FROM checkpoints WHERE checkpoint_id=?');
      for (const row of remove) statement.run(row.checkpoint_id);
    });
    for (const row of remove) {
      const checkpointRefs = Number(this.db.prepare('SELECT COUNT(*) AS count FROM checkpoints WHERE blob_hash=?').get(row.blob_hash)?.count || 0);
      const authorityRefs = Number(this.db.prepare('SELECT COUNT(*) AS count FROM authority WHERE checkpoint_hash=?').get(row.blob_hash)?.count || 0);
      if (checkpointRefs === 0 && authorityRefs === 0) await fs.unlink(this.blobPath(row.blob_hash)).catch(error => { if (error.code !== 'ENOENT') throw error; });
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
      const tx = this.db.prepare('SELECT * FROM upgrade_transactions WHERE transaction_id = ?').get(transactionId);
      if (!tx || tx.status !== 'PREPARED') throw Object.assign(new Error('upgrade transaction is not prepared'), { code: 'UPGRADE_STATE' });
      const authority = this.getAuthority(tx.core_id);
      if (!authority || authority.instanceId !== tx.from_instance_id || authority.epoch !== tx.from_epoch) {
        throw Object.assign(new Error('authority changed during upgrade transaction'), { code: 'AUTHORITY_CONFLICT' });
      }
      const checkpoint = this.db.prepare(`SELECT checkpoint_id FROM checkpoints
        WHERE core_id=? AND instance_id=? AND version=? AND authority_epoch=?
          AND state_schema=? AND blob_hash=? LIMIT 1`).get(
        tx.core_id, tx.to_instance_id, tx.to_version, tx.to_epoch,
        tx.to_state_schema, tx.to_checkpoint_hash
      );
      if (!checkpoint) {
        throw Object.assign(new Error('upgrade checkpoint disappeared or does not match target authority'), { code: 'UPGRADE_CHECKPOINT_MISMATCH' });
      }
      const updated = this.db.prepare(`UPDATE authority SET instance_id=?, version=?, epoch=?, barrier_sequence=?, checkpoint_hash=?, updated_at=?
        WHERE core_id=? AND instance_id=? AND epoch=?`).run(
        tx.to_instance_id, tx.to_version, tx.to_epoch, tx.barrier_sequence,
        tx.to_checkpoint_hash, at, tx.core_id, tx.from_instance_id, tx.from_epoch
      );
      if (updated.changes !== 1) throw Object.assign(new Error('authority compare-and-swap failed'), { code: 'AUTHORITY_CONFLICT' });
      this.db.prepare(`UPDATE upgrade_transactions SET status='COMMITTED', finalized_at=? WHERE transaction_id=?`).run(at, transactionId);
      return tx.core_id;
    });
    this.markWriteSuccess();
    return this.getAuthority(result);
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
    this.withTransaction(() => {
      this.db.prepare('INSERT INTO recovery_records(type, core_id, detail_json, created_at) VALUES(?, ?, ?, ?)')
        .run(type, coreId || null, JSON.stringify(detail), at);
      this.db.prepare('DELETE FROM recovery_records WHERE id NOT IN (SELECT id FROM recovery_records ORDER BY id DESC LIMIT 10000)').run();
    });
    this.markWriteSuccess();
  }

  async createSnapshot({ reason = 'periodic', retention = 24 } = {}) {
    const snapshotsRoot = path.join(this.rootDir, 'snapshots');
    const createdAt = new Date().toISOString();
    const safeReason = String(reason).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 48) || 'snapshot';
    const name = createdAt.replace(/[:.]/g, '-') + '-' + safeReason;
    const finalDir = path.join(snapshotsRoot, name);
    const tempDir = finalDir + '.tmp-' + process.pid;
    await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });

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
    const checkpointRows = this.db.prepare('SELECT DISTINCT blob_hash FROM checkpoints').all();
    for (const row of checkpointRows) {
      const source = this.blobPath(row.blob_hash);
      if (
        await exists(source) &&
        !selected.includes(source)
      ) {
        selected.push(source);
      }
    }

    const residentCheckpointRows =
      this.db.prepare(
        'SELECT DISTINCT blob_hash FROM resident_checkpoints'
      ).all();

    for (const row of residentCheckpointRows) {
      const source =
        this.blobPath(row.blob_hash);

      if (
        await exists(source) &&
        !selected.includes(source)
      ) {
        selected.push(source);
      }
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
        this.listAuthority(),
      residents:
        this.listResidents()
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
    await fsyncDirectory(snapshotsRoot);
    this.markWriteSuccess();
    await this.pruneSnapshots(retention);
    await this.pruneJournal(30);
    this.pruneUpgradeHistory(1000);
    return { name, path: finalDir, createdAt, reason, fileCount: Object.keys(manifest.files).length };
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
