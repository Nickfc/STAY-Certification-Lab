#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const RESIDENCY_ID = 'resident:sntss';
const VERSION = '0.4.0-i3d3';
const STATE_SCHEMA = 4;
const MODULE = 'cores/sntss/i3d/index.js';
const POLICY = 'sha256:5708b07f711f4d681c67c518e34450d57559b6fe51316060d1c83bd2c8a46765';
const FETUS_INSTANCE = '82202211-8dd6-44d4-a4ec-8f2553d8dc6f';
const FETUS_ANCHOR_GENERATION = 48;
const FETUS_ANCHOR_HASH = '412a0fa90cabcf266619a74b9275ccba02d12e199feecd74876d551cb41a1095';

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value) { return 'sha256:' + crypto.createHash('sha256').update(stable(value)).digest('hex'); }

function capture(databasePath) {
  const db = new DatabaseSync(databasePath, { open: true, readOnly: true });
  db.exec('PRAGMA query_only=ON');
  try {
    const authorityIdentity = db.prepare(`SELECT core_id, instance_id, version, epoch, barrier_sequence
      FROM authority ORDER BY core_id`).all();
    const fetusAuthority = authorityIdentity.find(row => row.core_id === 'fetus-legacy') || null;
    const fetusCheckpoint = db.prepare(`SELECT generation, blob_hash FROM checkpoints
      WHERE core_id='fetus-legacy' ORDER BY generation DESC LIMIT 1`).get() || null;
    const fetusAnchor = db.prepare(`SELECT generation, blob_hash FROM checkpoints
      WHERE core_id='fetus-legacy' AND generation=?`).get(FETUS_ANCHOR_GENERATION) || null;
    const identity = db.prepare("SELECT sha256 FROM metadata WHERE key='life:identity'").get() || null;
    const schema = Number(db.prepare("SELECT version FROM schema_versions WHERE name='continuity'").get()?.version || 0);
    const residents = db.prepare(`SELECT residency_id, core_id, role, instance_id, version, state_schema,
      module_relative_path, module_hash, manifest_hash, package_policy_hash, organism_identity_hash,
      checkpoint_hash, checkpoint_generation, status, attached_at, updated_at
      FROM resident_instances ORDER BY residency_id`).all();
    const sntss = residents.find(row => row.residency_id === RESIDENCY_ID) || null;
    const latestResidentCheckpoint = db.prepare(`SELECT generation, blob_hash, byte_length, input_cursor, created_at
      FROM resident_checkpoints WHERE residency_id=? ORDER BY generation DESC LIMIT 1`).get(RESIDENCY_ID) || null;
    const latestPulse = db.prepare(`SELECT d.sequence, d.transition_id, d.checkpoint_hash, d.acknowledged_at,
      e.event_id, e.topic FROM biological_deliveries d JOIN biological_events e ON e.sequence=d.sequence
      WHERE d.consumer_id=? AND d.status='ACKED' AND e.topic='runtime.time.pulse'
      ORDER BY d.sequence DESC LIMIT 1`).get(RESIDENCY_ID) || null;
    const pulseAckCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM biological_deliveries d
      JOIN biological_events e ON e.sequence=d.sequence WHERE d.consumer_id=? AND d.status='ACKED'
      AND e.topic='runtime.time.pulse'`).get(RESIDENCY_ID)?.count || 0);
    const consumer = db.prepare(`SELECT consumer_id, core_id, required, active, cursor, authority_epoch,
      checkpoint_hash FROM biological_consumers WHERE consumer_id=?`).get(RESIDENCY_ID) || null;
    const sntssOutboxCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM biological_outbox_intents
      WHERE producer_core_id='sntss'`).get()?.count || 0);
    return {
      quickCheck: db.prepare('PRAGMA quick_check').get()?.quick_check || null,
      schema,
      organismIdentityHash: identity?.sha256 ? `sha256:${identity.sha256}` : null,
      authorityIdentity,
      authorityIdentityHash: digest(authorityIdentity),
      fetusAuthority,
      fetusCheckpointGeneration: Number(fetusCheckpoint?.generation || 0),
      fetusCheckpointHash: fetusCheckpoint?.blob_hash || null,
      fetusAnchor,
      residents,
      sntss,
      latestResidentCheckpoint,
      latestPulse,
      pulseAckCount,
      consumer,
      sntssOutboxCount,
      chronobiologyResidentPresent: residents.some(row => row.residency_id === 'resident:chronobiology'),
      sntssAuthorityPresent: authorityIdentity.some(row => row.core_id === 'sntss'),
      chronobiologyAuthorityPresent: authorityIdentity.some(row => row.core_id === 'chronobiology')
    };
  } finally { db.close(); }
}

function assertBaseline(state) {
  const fetus = state.fetusAuthority;
  if (state.quickCheck !== 'ok' || state.schema !== 4 ||
      !fetus || fetus.instance_id !== FETUS_INSTANCE || fetus.version !== '0.6.0' ||
      Number(fetus.epoch) !== 1 || Number(fetus.barrier_sequence) !== 0 ||
      state.fetusCheckpointGeneration < FETUS_ANCHOR_GENERATION ||
      Number(state.fetusAnchor?.generation) !== FETUS_ANCHOR_GENERATION || state.fetusAnchor?.blob_hash !== FETUS_ANCHOR_HASH ||
      state.chronobiologyResidentPresent || state.sntssAuthorityPresent || state.chronobiologyAuthorityPresent) {
    throw Object.assign(new Error('post-A.1 baseline mismatch'), { code: 'P1_B_BASELINE' });
  }
}

function sameResidentIdentity(before, after) {
  const keys = ['residency_id', 'core_id', 'role', 'instance_id', 'version', 'state_schema',
    'module_relative_path', 'module_hash', 'manifest_hash', 'package_policy_hash', 'organism_identity_hash'];
  return keys.every(key => before?.[key] === after?.[key]);
}

function compareSurgery(before, after) {
  assertBaseline(before); assertBaseline(after);
  const r = after.sntss;
  const pass = !before.sntss && r && r.residency_id === RESIDENCY_ID && r.core_id === 'sntss' &&
    r.version === VERSION && Number(r.state_schema) === STATE_SCHEMA && r.module_relative_path === MODULE &&
    r.package_policy_hash === POLICY && r.status === 'RUNNING' &&
    after.authorityIdentityHash === before.authorityIdentityHash && after.organismIdentityHash === before.organismIdentityHash &&
    after.fetusCheckpointGeneration >= before.fetusCheckpointGeneration &&
    Number(r.checkpoint_generation) >= 4 && Number(after.latestResidentCheckpoint?.generation) === Number(r.checkpoint_generation) &&
    after.pulseAckCount >= 3 && after.latestPulse?.topic === 'runtime.time.pulse' &&
    Number(after.latestResidentCheckpoint?.input_cursor || 0) >= Number(after.latestPulse?.sequence || 0) &&
    after.sntssOutboxCount === 0 && Number(after.consumer?.required) === 0 && Number(after.consumer?.active) === 1;
  if (!pass) throw Object.assign(new Error('Surgery B continuity comparison failed'), { code: 'P1_B_CONTINUITY' });
  return {
    status: 'PASS', authorityBeforeHash: before.authorityIdentityHash, authorityAfterHash: after.authorityIdentityHash,
    organismIdentityHash: after.organismIdentityHash, fetusCheckpointForwardOnly: true,
    initialCheckpointHash: r.checkpoint_hash === after.latestResidentCheckpoint.blob_hash ? null : null,
    finalCheckpointHash: r.checkpoint_hash, checkpointGeneration: Number(r.checkpoint_generation),
    residentTransitionSequence: Number(after.latestPulse.sequence), pulseAckCount: after.pulseAckCount,
    sntssOutboxCount: after.sntssOutboxCount, instanceId: r.instance_id
  };
}

function compareRollback(before, after) {
  assertBaseline(before); assertBaseline(after);
  const pass = before.sntss?.status === 'RUNNING' && after.sntss?.status === 'DETACHED' &&
    sameResidentIdentity(before.sntss, after.sntss) &&
    Number(after.sntss.checkpoint_generation) > Number(before.sntss.checkpoint_generation) &&
    after.sntss.checkpoint_hash === after.latestResidentCheckpoint?.blob_hash &&
    after.authorityIdentityHash === before.authorityIdentityHash && after.organismIdentityHash === before.organismIdentityHash &&
    after.fetusCheckpointGeneration >= before.fetusCheckpointGeneration && after.sntssOutboxCount === 0 &&
    Number(after.consumer?.active) === 0 && after.pulseAckCount >= before.pulseAckCount;
  if (!pass) throw Object.assign(new Error('rollback B continuity comparison failed'), { code: 'P1_B_ROLLBACK_CONTINUITY' });
  return { status: 'PASS', checkpointHash: after.sntss.checkpoint_hash,
    checkpointGeneration: Number(after.sntss.checkpoint_generation), statePreserved: true,
    authorityBeforeHash: before.authorityIdentityHash, authorityAfterHash: after.authorityIdentityHash };
}

async function treeHash(root) {
  function gitObjectHash(type, bytes) {
    return crypto.createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest();
  }
  async function visit(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => Buffer.from(a.name + (a.isDirectory() ? '/' : '')).compare(Buffer.from(b.name + (b.isDirectory() ? '/' : ''))));
    const records = [];
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      let mode;
      let objectHash;
      if (entry.isDirectory()) {
        mode = '40000';
        objectHash = await visit(absolute);
      }
      else if (entry.isFile()) {
        const stat = await fsp.lstat(absolute);
        if (stat.isSymbolicLink() || stat.nlink !== 1) throw Object.assign(new Error('package link forbidden'), { code: 'P1_B_PACKAGE_LINK' });
        const bytes = await fsp.readFile(absolute);
        mode = (stat.mode & 0o111) ? '100755' : '100644';
        objectHash = gitObjectHash('blob', bytes);
      } else throw Object.assign(new Error('package special file forbidden'), { code: 'P1_B_PACKAGE_SPECIAL' });
      records.push(Buffer.from(`${mode} ${entry.name}\0`), objectHash);
    }
    return gitObjectHash('tree', Buffer.concat(records));
  }
  return (await visit(path.resolve(root))).toString('hex');
}

async function verifyPromotion(releaseRoot, databasePath, publicKeyPath, certificateDir) {
  const db = new DatabaseSync(databasePath, { open: true, readOnly: true });
  db.exec('PRAGMA query_only=ON');
  let identity;
  try { identity = JSON.parse(db.prepare("SELECT json FROM metadata WHERE key='life:identity'").get()?.json || 'null'); }
  finally { db.close(); }
  if (!identity) throw Object.assign(new Error('organism identity unavailable'), { code: 'P1_B_IDENTITY' });
  const { inspectCoreModule } = require(path.join(releaseRoot, 'runtime/kernel/core-loader.js'));
  const { canonicalHash, L0_SNTSS_CONTRACT } = require(path.join(releaseRoot, 'runtime/kernel/resident-manager.js'));
  const { loadAndVerifyResidentPromotion } = require(path.join(releaseRoot, 'runtime/kernel/resident-promotion-authority.js'));
  const definition = await inspectCoreModule(path.join(releaseRoot, MODULE));
  const inspected = { definition, manifestHash: canonicalHash(definition.manifest), moduleRelativePath: MODULE };
  const result = loadAndVerifyResidentPromotion({ inspected, action: 'attach-resident', identity,
    contract: L0_SNTSS_CONTRACT, required: true, publicKeyPath, certificateDir });
  return { status: 'PASS', certificateId: result.certificateId, authorizationClass: result.authorizationClass,
    residencyId: result.residencyId, version: result.version, laboratoryBypass: result.laboratoryBypass === true };
}

async function main(argv = process.argv.slice(2)) {
  const [mode, ...args] = argv;
  if (mode === 'capture' && args[0]) return void process.stdout.write(JSON.stringify(capture(args[0])) + '\n');
  if (mode === 'baseline' && args[0]) { const s = capture(args[0]); assertBaseline(s); return void process.stdout.write(JSON.stringify({ status: 'PASS', state: s }) + '\n'); }
  if (mode === 'compare-surgery' && args[0] && args[1]) return void process.stdout.write(JSON.stringify(compareSurgery(JSON.parse(fs.readFileSync(args[0])), JSON.parse(fs.readFileSync(args[1])))) + '\n');
  if (mode === 'compare-rollback' && args[0] && args[1]) return void process.stdout.write(JSON.stringify(compareRollback(JSON.parse(fs.readFileSync(args[0])), JSON.parse(fs.readFileSync(args[1])))) + '\n');
  if (mode === 'tree' && args[0]) return void process.stdout.write(JSON.stringify({ tree: await treeHash(args[0]) }) + '\n');
  if (mode === 'promotion' && args.length === 4) return void process.stdout.write(JSON.stringify(await verifyPromotion(...args)) + '\n');
  throw new Error('fixed P1 Surgery B state operation required');
}

if (require.main === module) main().catch(error => { console.error(`P1_SURGERY_B_STATE_ABORT=${error.code || 'FAILED'}`); process.exitCode = 1; });
module.exports = { capture, assertBaseline, compareSurgery, compareRollback, treeHash, verifyPromotion };
