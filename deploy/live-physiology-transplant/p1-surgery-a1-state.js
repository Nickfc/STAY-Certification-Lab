'use strict';

const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return 'sha256:' + crypto.createHash('sha256').update(stable(value)).digest('hex');
}

function capture(databasePath) {
  const db = new DatabaseSync(databasePath, { open: true, readOnly: true });
  db.exec('PRAGMA query_only=ON');
  try {
    const authorityIdentity = db.prepare(`SELECT core_id, instance_id, version, epoch, barrier_sequence
      FROM authority ORDER BY core_id`).all();
    const fetusAuthority = authorityIdentity.find(row => row.core_id === 'fetus-legacy') || null;
    const fetusCheckpoint = db.prepare(`SELECT generation, blob_hash FROM checkpoints
      WHERE core_id='fetus-legacy' ORDER BY generation DESC LIMIT 1`).get() || null;
    const identity = db.prepare("SELECT sha256 FROM metadata WHERE key='life:identity'").get() || null;
    const schema = Number(db.prepare("SELECT version FROM schema_versions WHERE name='continuity'").get()?.version || 0);
    const residents = db.prepare(`SELECT residency_id, core_id, status, checkpoint_hash, checkpoint_generation
      FROM resident_instances ORDER BY residency_id`).all();
    const authorityCores = db.prepare('SELECT core_id FROM authority ORDER BY core_id').all().map(row => row.core_id);
    return {
      quickCheck: db.prepare('PRAGMA quick_check').get()?.quick_check || null,
      schema,
      organismIdentityHash: identity?.sha256 ? `sha256:${identity.sha256}` : null,
      authorityIdentity,
      authorityIdentityHash: digest(authorityIdentity),
      fetusAuthority,
      fetusCheckpointGeneration: Number(fetusCheckpoint?.generation || 0),
      fetusCheckpointHash: fetusCheckpoint?.blob_hash || null,
      residents,
      sntssResidentPresent: residents.some(row => row.residency_id === 'resident:sntss'),
      chronobiologyResidentPresent: residents.some(row => row.residency_id === 'resident:chronobiology'),
      sntssAuthorityPresent: authorityCores.includes('sntss'),
      chronobiologyAuthorityPresent: authorityCores.includes('chronobiology')
    };
  } finally {
    db.close();
  }
}

function compare(before, after) {
  const pass = before.quickCheck === 'ok' && after.quickCheck === 'ok' &&
    before.schema === 4 && after.schema === 4 &&
    before.authorityIdentityHash === after.authorityIdentityHash &&
    before.organismIdentityHash === after.organismIdentityHash &&
    after.fetusCheckpointGeneration >= before.fetusCheckpointGeneration &&
    !after.sntssResidentPresent && !after.chronobiologyResidentPresent &&
    !after.sntssAuthorityPresent && !after.chronobiologyAuthorityPresent;
  if (!pass) throw Object.assign(new Error('A.1 biological continuity comparison failed'), { code: 'P1_A1_CONTINUITY' });
  return {
    status: 'PASS',
    authorityIdentityHash: after.authorityIdentityHash,
    organismIdentityHash: after.organismIdentityHash,
    checkpointForwardOnly: true,
    fetusCheckpointAdvanced: after.fetusCheckpointGeneration > before.fetusCheckpointGeneration,
    fetusCheckpointHashChanged: after.fetusCheckpointHash !== before.fetusCheckpointHash,
    fetus: after.fetusAuthority,
    fetusCheckpointGeneration: after.fetusCheckpointGeneration,
    fetusCheckpointHash: after.fetusCheckpointHash,
    schema: after.schema
  };
}

function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'capture' && argv[1]) {
    process.stdout.write(JSON.stringify(capture(argv[1])) + '\n');
    return;
  }
  if (argv[0] === 'compare' && argv[1] && argv[2]) {
    const fs = require('node:fs');
    process.stdout.write(JSON.stringify(compare(
      JSON.parse(fs.readFileSync(argv[1], 'utf8')),
      JSON.parse(fs.readFileSync(argv[2], 'utf8'))
    )) + '\n');
    return;
  }
  throw new Error('usage: p1-surgery-a1-state.js capture <database> | compare <before.json> <after.json>');
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(`P1_A1_STATE_ABORT=${error.code || 'FAILED'}`); process.exitCode = 1; }
}

module.exports = { capture, compare, digest };
