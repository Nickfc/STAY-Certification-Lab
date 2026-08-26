#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { validateRevisionFreeze } = require('../../runtime/revision-freeze');

const DATABASE = process.env.STAY_DATABASE || '/var/lib/stay/data/continuity.sqlite3';
const DATA_ROOT = path.dirname(DATABASE);
const POLICY = 'sha256:ba12622fcc9c782c8c48f0544a5b019c96dc198dcbb7fb209c1dad47de64639d';
const PARENT_FREEZE = 'sha256:78021d86da8038e298fedb46b7371a46e1bc1e4d1cb0624205a864877ca22875';

function fail(message, code = 'P1_SNTSS_I4G_LIVE_STATE') {
  throw Object.assign(new Error(message), { code });
}

function parse(value, label) {
  try { return JSON.parse(value); }
  catch { fail(`${label} JSON is invalid`); }
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function row(database, sql, ...parameters) {
  return database.prepare(sql).get(...parameters) || null;
}

function readJson(file, label) {
  try { return parse(fs.readFileSync(file, 'utf8'), label); }
  catch (error) {
    if (error?.code === 'P1_SNTSS_I4G_LIVE_STATE') throw error;
    fail(`${label} is unavailable`);
  }
}

function capture(database) {
  const quickCheck = database.prepare('PRAGMA quick_check').get()?.quick_check || null;
  const revisionRecord = parse(row(database,
    "SELECT json FROM metadata WHERE key='life:runtime-revision'")?.json || '{}', 'runtime revision');
  const resident = row(database, `
    SELECT * FROM resident_instances WHERE residency_id='resident:sntss'
  `);
  const checkpoint = resident ? row(database, `
    SELECT * FROM resident_checkpoints
    WHERE residency_id=? AND generation=? AND blob_hash=?
  `, resident.residency_id, resident.checkpoint_generation, resident.checkpoint_hash) : null;
  const blobPath = checkpoint
    ? path.join(DATA_ROOT, 'blobs', 'sha256', checkpoint.blob_hash.slice(0, 2), checkpoint.blob_hash)
    : null;
  const blob = blobPath && fs.existsSync(blobPath) ? fs.readFileSync(blobPath) : null;
  const state = blob ? parse(blob.toString('utf8'), 'SNTSS checkpoint') : null;
  const individuality = state?.individuality || null;
  const event = individuality ? row(database, `
    SELECT sequence, event_id, topic, event_class, envelope_json, envelope_sha256
    FROM biological_events WHERE sequence=? AND event_id=?
  `, individuality.genesisSequence, individuality.genesisEventId) : null;
  const delivery = individuality ? row(database, `
    SELECT status, transition_id, checkpoint_hash, acknowledged_at
    FROM biological_deliveries WHERE sequence=? AND consumer_id='resident:sntss'
  `, individuality.genesisSequence) : null;
  const consumer = row(database, `
    SELECT * FROM biological_consumers WHERE consumer_id='resident:sntss'
  `);
  const source = individuality ? row(database, `
    SELECT generation, version, state_schema, blob_hash
    FROM resident_checkpoints
    WHERE residency_id='resident:sntss' AND generation=? AND blob_hash=?
  `, individuality.sourceCheckpointGeneration,
  String(individuality.sourceCheckpointHash || '').replace(/^sha256:/, '')) : null;
  const count = sql => Number(row(database, sql)?.value || 0);
  const chronobiology = row(database, `
    SELECT * FROM resident_instances WHERE residency_id='resident:chronobiology'
  `);
  return {
    quickCheck,
    runtimeRevision: Number(revisionRecord.revision),
    resident,
    checkpoint: checkpoint ? {
      ...checkpoint,
      blobDigestMatches: Boolean(blob && digest(blob) === checkpoint.blob_hash)
    } : null,
    state,
    individuality,
    event: event ? {
      ...event,
      envelope: parse(event.envelope_json, 'continuity-genesis envelope')
    } : null,
    delivery,
    consumer: consumer ? {
      ...consumer,
      topics: parse(consumer.topics_json, 'SNTSS consumer topics')
    } : null,
    source,
    chronobiology,
    pendingDeliveries: count("SELECT COUNT(*) value FROM biological_deliveries WHERE status='PENDING'"),
    sntssAuthorityRows: count("SELECT COUNT(*) value FROM authority WHERE core_id='sntss'"),
    sntssOutputRows: count("SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id='sntss'"),
    chronobiologyAuthorityRows: count("SELECT COUNT(*) value FROM authority WHERE core_id='chronobiology'"),
    chronobiologyOutputRows: count("SELECT COUNT(*) value FROM biological_outbox_intents WHERE producer_core_id='chronobiology'")
  };
}

function validateHistoricalCommitment(value, parent) {
  const r = value.resident;
  const i = value.individuality;
  const e = value.event?.envelope;
  const sourceHash = String(i?.sourceCheckpointHash || '').replace(/^sha256:/, '');
  const parentValid = validateRevisionFreeze(parent, 108) &&
    parent.freezeType === 'P1_BSF_SNTSS_I4G_CHRONOBIOLOGY_LIVE_SHADOW' &&
    parent.sntss?.residencyId === 'resident:sntss' &&
    parent.sntss?.version === '0.5.0-i4g1' && Number(parent.sntss?.stateSchema) === 5 &&
    parent.sntss?.instanceId === r?.instance_id && parent.sntss?.authority === 'NONE' &&
    Number(parent.sntss?.outputs) === 0 &&
    Number(parent.sntss?.genesisSequence) === Number(i?.genesisSequence) &&
    parent.sntss?.lineageSha256 === i?.lineageSha256 &&
    parent.sntss?.seedCommitmentSha256 === i?.seedCommitmentSha256 &&
    parent.sntss?.prenatalStateSha256 === i?.prenatalStateSha256 &&
    Number(parent.sntss?.sourceCheckpointGeneration) === Number(i?.sourceCheckpointGeneration) &&
    parent.sntss?.sourceCheckpointHash === i?.sourceCheckpointHash;
  const sourceValid = value.source == null ||
    (value.source.version === '0.4.0-i3d3' && Number(value.source.state_schema) === 4 &&
      Number(value.source.generation) === Number(i?.sourceCheckpointGeneration) &&
      value.source.blob_hash === sourceHash);
  const eventValid = value.event == null ||
    (e?.topic === 'runtime.sntss.continuity-genesis' && e?.class === 'critical' &&
      e?.id === i?.genesisEventId && Number(e?.sequence) === Number(i?.genesisSequence) &&
      e?.meta?.sourceCore === 'living-kernel' &&
      Number(e?.meta?.authorityEpoch) === Number(i?.runtimeRevision));
  const deliveryValid = value.delivery == null ||
    (value.delivery.status === 'ACKED' && Boolean(value.delivery.checkpoint_hash));
  if (!parentValid || !sourceValid || !eventValid || !deliveryValid) {
    fail('historical continuity commitment is invalid');
  }
  return {
    anchoredToR108F: true,
    r108FreezeRecordSha256: parent.recordSha256,
    sourceCheckpointRowRetained: value.source != null,
    genesisEventRowRetained: value.event != null,
    genesisDeliveryRowRetained: value.delivery != null,
    prunedRowsAcceptedByImmutableCommitment: [value.source, value.event, value.delivery]
      .some(entry => entry == null)
  };
}

function validate(value, expectedRevision, parent) {
  const r = value.resident;
  const i = value.individuality;
  const c = value.consumer;
  const historicalContinuity = validateHistoricalCommitment(value, parent);
  const valid = value.quickCheck === 'ok' && value.runtimeRevision === expectedRevision &&
    r?.residency_id === 'resident:sntss' && r?.core_id === 'sntss' &&
    r?.version === '0.5.0-i4g1' && Number(r?.state_schema) === 5 &&
    r?.module_relative_path === 'cores/sntss/i4g/index.js' &&
    r?.package_policy_hash === POLICY && r?.status === 'RUNNING' &&
    Number(r?.checkpoint_generation) >= 1 && value.checkpoint?.blobDigestMatches === true &&
    value.state?.stateSchema === 5 && value.state?.coreVersion === '0.5.0-i4g1' &&
    i?.type === 'SNTSS_CONTINUITY_GENESIS' && i?.authorization === 'R13_SNTSS_CONTINUITY_GENESIS_SHADOW' &&
    i?.parentFreezeRevision === 105 && i?.parentFreezeRecordSha256 === PARENT_FREEZE &&
    i?.runtimeRevision >= 106 && i?.authorityMode === 'NONE' && i?.outputs === 0 &&
    /^sha256:[0-9a-f]{64}$/.test(String(i?.lineageSha256 || '')) &&
    /^sha256:[0-9a-f]{64}$/.test(String(i?.seedCommitmentSha256 || '')) &&
    c?.consumer_id === 'resident:sntss' && c?.core_id === 'sntss' &&
    Number(c?.required) === 0 && Number(c?.active) === 1 &&
    JSON.stringify(c?.topics) === JSON.stringify([
      'runtime.organism.binding', 'runtime.sntss.continuity-genesis', 'runtime.time.pulse'
    ]) &&
    value.sntssAuthorityRows === 0 && value.sntssOutputRows === 0 &&
    value.chronobiology?.version === '1.0.0-c3rc.1' &&
    value.chronobiology?.status === 'RUNNING' &&
    value.chronobiologyAuthorityRows === 0 && value.chronobiologyOutputRows >= 1;
  if (!valid) fail('live I4-G1 durable generation is invalid');
  return { ...value, historicalContinuity };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || !/^[1-9][0-9]*$/.test(argv[0])) {
    fail('expected runtime revision and parent freeze are required', 'P1_SNTSS_I4G_LIVE_STATE_USAGE');
  }
  const parent = readJson(argv[1], 'R108F parent freeze');
  const database = new DatabaseSync(DATABASE, { open: true, readOnly: true });
  database.exec('PRAGMA query_only=ON');
  try {
    process.stdout.write(JSON.stringify(validate(capture(database), Number(argv[0]), parent)) + '\n');
  } finally {
    database.close();
  }
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`P1_SNTSS_I4G_LIVE_STATE_ABORT=${error.code || 'FAILED'}:${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { POLICY, PARENT_FREEZE, capture, validate, validateHistoricalCommitment };
