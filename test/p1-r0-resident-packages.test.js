'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { validateManifest } = require('../runtime/kernel/manifest');
const {
  enforcePackagePolicy,
  verifyManifestAgainstPackagePolicy
} = require('../runtime/kernel/package-policy');
const { P1_R0_RESIDENT_CONTRACTS } = require('../runtime/p1-r0/resident-contracts');
const packageHashes = require('../runtime/p1-r0/resident-package-hashes.json');
const {
  DEFINITIONS,
  MANIFEST_RESOURCES,
  bundle,
  policy
} = require('../scripts/build-p1-r0-resident-packages');

const ROOT = path.resolve(__dirname, '..');

test('P1-PKG-01 all three resident packages reproduce byte-identically from reviewed sources', () => {
  for (const [coreId, definition] of Object.entries(DEFINITIONS)) {
    const generatedBundle = bundle(definition.entry, ROOT);
    const generatedPolicy = policy(coreId, definition, generatedBundle);
    const packageRoot = path.join(ROOT, definition.output);
    assert.equal(fs.readFileSync(path.join(packageRoot, 'index.js'), 'utf8'), generatedBundle.output);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(packageRoot, 'package-policy.json'), 'utf8')),
      generatedPolicy
    );
    assert.equal(packageHashes[coreId], generatedPolicy.policyHash);
    assert.equal(generatedBundle.inventory.includes(definition.entry), true);
  }
});

test('P1-PKG-02 package policies deny ambient authority and retain the unchanged resource contract', () => {
  for (const [coreId, definition] of Object.entries(DEFINITIONS)) {
    const entrypoint = path.join(ROOT, definition.output, 'index.js');
    const record = enforcePackagePolicy(entrypoint);
    const resident = require(entrypoint);
    const manifest = validateManifest(resident.manifest);
    assert.equal(record.policy.coreId, coreId);
    assert.equal(record.policy.policyHash, packageHashes[coreId]);
    assert.deepEqual(record.policy.ambientCapabilities, {
      filesystemWrite: false,
      network: false,
      processSpawn: false
    });
    assert.deepEqual(record.policy.resourceContract.manifestResources, MANIFEST_RESOURCES);
    assert.equal(record.policy.resourceContract.requiredOnProductionHost, true);
    assert.equal(verifyManifestAgainstPackagePolicy(record, manifest), true);
  }
});

test('P1-PKG-03 contracts bind the exact package hashes and remain shadow/contained only', () => {
  assert.deepEqual(P1_R0_RESIDENT_CONTRACTS.map(contract => contract.coreId), ['METAB', 'HOMEOS', 'INTERO']);
  for (const contract of P1_R0_RESIDENT_CONTRACTS) {
    assert.equal(contract.packagePolicyHash, packageHashes[contract.coreId]);
    assert.equal(contract.productionEligible, false);
    assert.equal(contract.priorCheckpointRecovery, true);
    assert.equal(contract.authorityMode === 'shadow' || contract.outputs.length === 0, true);
  }
  assert.deepEqual(P1_R0_RESIDENT_CONTRACTS.find(value => value.coreId === 'INTERO').outputs, []);
});
