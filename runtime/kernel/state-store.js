'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

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
        created_at TEXT NOT NULL,
        UNIQUE(core_id, generation)
      );
      CREATE INDEX IF NOT EXISTS checkpoint_latest ON checkpoints(core_id, generation DESC);
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
    const schemaRow = this.db.prepare("SELECT version FROM schema_versions WHERE name='continuity'").get();
    if (Number(schemaRow?.version || 0) > 3) {
      throw Object.assign(new Error('continuity schema is newer than this runtime supports'), { code: 'STATE_SCHEMA_UNSUPPORTED' });
    }
    this.db.prepare(`INSERT INTO schema_versions(name, version, updated_at) VALUES('continuity', 3, ?)
      ON CONFLICT(name) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at`).run(new Date().toISOString());
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
      format: 'stay-statestore-v2',
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

  async commitCheckpoint({ coreId, instanceId, version, authorityEpoch, stateSchema, state, updateAuthority = true }) {
    const json = JSON.stringify(state ?? {});
    const blob = await this.putBlob(json);
    const createdAt = new Date().toISOString();
    const checkpointId = crypto.randomUUID();
    const result = this.withTransaction(() => {
      const row = this.db.prepare('SELECT COALESCE(MAX(generation), 0) AS generation FROM checkpoints WHERE core_id = ?').get(coreId);
      const generation = Number(row?.generation || 0) + 1;
      this.db.prepare(`INSERT INTO checkpoints(checkpoint_id, core_id, instance_id, version, authority_epoch, state_schema, generation, blob_hash, byte_length, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        checkpointId, coreId, instanceId, version, authorityEpoch, stateSchema, generation, blob.hash, blob.byteLength, createdAt
      );
      if (updateAuthority) {
        const updated = this.db.prepare(`UPDATE authority SET checkpoint_hash = ?, updated_at = ?
          WHERE core_id = ? AND instance_id = ? AND version = ? AND epoch = ?`)
          .run(blob.hash, createdAt, coreId, instanceId, version, authorityEpoch);
        if (updated.changes !== 1) {
          throw Object.assign(new Error('checkpoint does not belong to current authority'), { code: 'CHECKPOINT_AUTHORITY_CONFLICT' });
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
      if (await exists(source)) selected.push(source);
    }

    const manifest = {
      format: 'stay-runtime-snapshot-v2', createdAt, reason, files: {
        'continuity.sqlite3': await sha256File(snapshotDatabasePath)
      }, authority: this.listAuthority()
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
