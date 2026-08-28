'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { stableStringify } = require('../kernel/canonical-json');

const IDENTITIES = Object.freeze({
  branch: 'feature/live-physiology-transplant',
  baseSha: '75ee72ab0b1eeccf33e8fd1a8e11d43d4eda1a6e',
  chronobiologySealedSha: 'cf23389c1faa6d58cbb4e0960dab02fe38648f59',
  chronobiologySealedTree: '94625cc5c832e6716b7142c4af267f9713bbc1c1',
  sntssPackage: 'cores/sntss/i3d',
  sntssPackageTree: '5efc31371cfdca9e650ad3c8bc6d749f8f4df618',
  sntssVersion: '0.4.0-i3d3',
  sntssStateSchema: 4,
  sntssPolicyHash: 'sha256:5708b07f711f4d681c67c518e34450d57559b6fe51316060d1c83bd2c8a46765',
  sntssProductionOutputs: 0,
  anchors: Object.freeze({
    biologicalSignallingFabric: '9838f5e37dc410e6ef959e2b614398ba42a33e87392f39c9a682cd032d85114a',
    residentManager: '228fc35ca35371d4886730890642e0885b084654c7bf84f95d54d5c68dd16c3b',
    stateStore: 'f177fda82fbc87400f44674f3bb60f01faa6e3a84dbbb218cfb71fbf33806c5b'
  })
});

const ANCHOR_PATHS = Object.freeze({
  biologicalSignallingFabric: 'runtime/kernel/biological-signalling-fabric.js',
  residentManager: 'runtime/kernel/resident-manager.js',
  stateStore: 'runtime/kernel/state-store.js'
});

function fail(message, code = 'P1_SURGERY_A_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

function gitObject(root, object) {
  return execFileSync('git', ['-C', root, 'rev-parse', object], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function verifyAnchors(rootDir, { verifyGitTrees = true } = {}) {
  const root = path.resolve(rootDir);
  const files = {};
  for (const [name, relative] of Object.entries(ANCHOR_PATHS)) {
    const actual = fileSha256(path.join(root, relative));
    const expected = IDENTITIES.anchors[name];
    if (actual !== expected) fail(`${name} anchor mismatch`, 'P1_SHARED_ANCHOR_MISMATCH');
    files[name] = Object.freeze({ path: relative, sha256: actual });
  }

  const policy = JSON.parse(fs.readFileSync(
    path.join(root, IDENTITIES.sntssPackage, 'package-policy.json'),
    'utf8'
  ));
  if (policy.policyHash !== IDENTITIES.sntssPolicyHash ||
      Number(policy?.bounds?.productionOutputs) !== IDENTITIES.sntssProductionOutputs) {
    fail('SNTSS package policy identity mismatch', 'P1_SNTSS_IDENTITY_MISMATCH');
  }

  const indexSource = fs.readFileSync(
    path.join(root, IDENTITIES.sntssPackage, 'index.js'),
    'utf8'
  );
  if (!indexSource.includes(`'${IDENTITIES.sntssVersion}'`) ||
      !/stateSchema:\s*\n?\s*4\b/.test(indexSource) ||
      !/productionEligible:\s*\n?\s*false\b/.test(indexSource)) {
    fail('SNTSS executable manifest identity mismatch', 'P1_SNTSS_IDENTITY_MISMATCH');
  }

  let sntssPackageTree = IDENTITIES.sntssPackageTree;
  if (verifyGitTrees) {
    sntssPackageTree = gitObject(root, `HEAD:${IDENTITIES.sntssPackage}`);
    if (sntssPackageTree !== IDENTITIES.sntssPackageTree) {
      fail('SNTSS package tree mismatch', 'P1_SNTSS_TREE_MISMATCH');
    }
  }

  return Object.freeze({
    status: 'PASS',
    files: Object.freeze(files),
    sntss: Object.freeze({
      package: IDENTITIES.sntssPackage,
      tree: sntssPackageTree,
      version: IDENTITIES.sntssVersion,
      stateSchema: IDENTITIES.sntssStateSchema,
      policyHash: IDENTITIES.sntssPolicyHash,
      productionOutputs: IDENTITIES.sntssProductionOutputs
    })
  });
}

function tableExists(db, name) {
  return Boolean(db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name));
}

function rowsIfPresent(db, table, sql) {
  return tableExists(db, table) ? db.prepare(sql).all() : [];
}

function inspectDatabase(databasePath) {
  const db = new DatabaseSync(path.resolve(databasePath), {
    open: true,
    readOnly: true
  });
  try {
    db.exec('PRAGMA query_only=ON');
    const quickCheck = String(db.prepare('PRAGMA quick_check').get()?.quick_check || '');
    if (quickCheck.toLowerCase() !== 'ok') fail('StateStore quick_check failed', 'P1_STATESTORE_INTEGRITY');
    const schemas = rowsIfPresent(db, 'schema_versions',
      'SELECT name, version FROM schema_versions ORDER BY name');
    const authority = rowsIfPresent(db, 'authority', `
      SELECT core_id, instance_id, version, epoch, barrier_sequence,
             checkpoint_hash
        FROM authority
       ORDER BY core_id`);
    const residents = rowsIfPresent(db, 'resident_instances', `
      SELECT residency_id, core_id, version, state_schema, status,
             checkpoint_hash, checkpoint_generation
        FROM resident_instances
       ORDER BY residency_id`);
    const biologicalEvents = tableExists(db, 'biological_events')
      ? Number(db.prepare('SELECT COUNT(*) AS count FROM biological_events').get()?.count || 0)
      : 0;
    const continuitySchema = Number(
      schemas.find(row => row.name === 'continuity')?.version || 0
    );
    return Object.freeze({
      quickCheck: 'ok',
      continuitySchema,
      schemas: Object.freeze(schemas),
      authority: Object.freeze(authority),
      residents: Object.freeze(residents),
      biologicalEvents
    });
  } finally {
    db.close();
  }
}

function assertNoNewPhysiology(state) {
  const forbiddenResidents = state.residents.filter(row =>
    ['sntss', 'chronobiology'].includes(String(row.core_id))
  );
  const forbiddenAuthority = state.authority.filter(row =>
    ['sntss', 'chronobiology'].includes(String(row.core_id))
  );
  if (forbiddenResidents.length || forbiddenAuthority.length) {
    fail('Surgery A contains newly activated physiology', 'P1_PHYSIOLOGY_ACTIVATED');
  }
  return true;
}

function assertPreSurgeryState(state) {
  if (state.continuitySchema !== 3) {
    fail(`expected continuity schema 3, observed ${state.continuitySchema || 'none'}`,
      'P1_SCHEMA3_REQUIRED');
  }
  assertNoNewPhysiology(state);
  return true;
}

function assertPostSurgeryState(before, after) {
  if (after.continuitySchema !== 4) {
    fail(`Surgery A did not produce continuity schema 4: ${after.continuitySchema || 'none'}`,
      'P1_SCHEMA4_REQUIRED');
  }
  assertNoNewPhysiology(after);
  if (stableStringify(before.authority) !== stableStringify(after.authority)) {
    fail('biological authority changed during Surgery A', 'P1_AUTHORITY_CHANGED');
  }
  if (after.residents.length !== before.residents.length) {
    fail('resident identity set changed during Surgery A', 'P1_RESIDENT_SET_CHANGED');
  }
  return true;
}

function createManifest({ sourceSha, sourceTree, releaseRole, inventoryHash = null }) {
  if (!/^[0-9a-f]{40}$/.test(String(sourceSha)) ||
      !/^[0-9a-f]{40}$/.test(String(sourceTree))) {
    fail('source SHA and tree must be pinned Git object IDs', 'P1_SOURCE_IDENTITY_INVALID');
  }
  if (!['surgery-a-candidate', 'forward-compatible-rollback'].includes(releaseRole)) {
    fail('release role is invalid', 'P1_RELEASE_ROLE_INVALID');
  }
  const releaseId = `0.8.11.3-p1a-${releaseRole}-${sourceSha}`;
  const body = {
    format: 'stay-live-physiology-transplant-p1-release-v1',
    branch: IDENTITIES.branch,
    baseSha: IDENTITIES.baseSha,
    sourceSha,
    sourceTree,
    releaseId,
    releaseRole,
    surgery: 'A',
    sharedInfrastructureOnly: true,
    schema3CompatibleInput: true,
    schemaMigrationDuringSurgeryA: true,
    continuitySchemaBefore: 3,
    continuitySchemaAfter: 4,
    stateRollbackPolicy: 'preserve-forward-state',
    rollbackEntrypoint: 'server-surgery-a-rollback.js',
    sntssActivated: false,
    chronobiologyActivated: false,
    newBiologicalAuthority: false,
    identities: IDENTITIES,
    inventoryHash
  };
  return Object.freeze({
    ...body,
    manifestHash: `sha256:${sha256(stableStringify(body))}`
  });
}

module.exports = {
  IDENTITIES,
  ANCHOR_PATHS,
  sha256,
  fileSha256,
  verifyAnchors,
  inspectDatabase,
  assertNoNewPhysiology,
  assertPreSurgeryState,
  assertPostSurgeryState,
  createManifest
};
