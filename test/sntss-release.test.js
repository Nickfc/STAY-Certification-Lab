'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const release = require('../runtime/release/sntss-release-control');

const root = path.resolve(__dirname, '..');
const HASH = /^sha256:[0-9a-f]{64}$/;
function fileHash(relative) {
  let bytes = fs.readFileSync(path.join(root, relative));
  if (relative.endsWith('.ps1')) bytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}
async function temporary(prefix) { return fsp.mkdtemp(path.join(os.tmpdir(), prefix)); }

test('R10-01 release inventory is deterministic, complete and excludes live/laboratory state', async () => {
  const first = await release.buildInventory(root);
  const second = await release.buildInventory(root);
  assert.equal(first.inventoryHash, second.inventoryHash);
  assert.match(first.inventoryHash, HASH);
  assert.deepEqual(first.entries.map(entry => entry.path), [...first.entries.map(entry => entry.path)].sort((a, b) => a.localeCompare(b)));
  for (const required of release.REQUIRED_PATHS) assert.ok(first.entries.some(entry => entry.path === required), required);
  assert.ok(first.entries.some(entry => entry.role === 'sntss-source'));
  assert.ok(first.entries.some(entry => entry.role === 'sntss-schema'));
  assert.ok(first.entries.some(entry => entry.role === 'sntss-evidence'));
  assert.equal(first.entries.some(entry => entry.path === 'data/.gitkeep' || entry.path.startsWith('.stay-data/') || entry.path.startsWith('release-output/')), false);
});

test('R10-02 pinned provenance binds source inventory, dependencies, profiles, schemas and evidence', async () => {
  const documents = await release.createReleaseDocuments(root, { commit: 'a'.repeat(40), builder: 'r10-test', branch: 'candidate' });
  assert.equal(documents.provenance.format, release.PROVENANCE_FORMAT);
  assert.equal(documents.provenance.commit, 'a'.repeat(40));
  assert.equal(documents.provenance.stateRollbackPolicy, 'preserve-forward-state');
  assert.equal(documents.provenance.releaseMutable, false);
  assert.equal(documents.provenance.productionEligible, false);
  assert.match(documents.provenance.provenanceHash, HASH);
  assert.match(documents.provenance.inventoryHash, HASH);
  assert.match(documents.provenance.dependencyInventoryHash, HASH);
  for (const key of ['packagePolicyHash', 'speciesProfileHash', 'sourceRegistryHash', 'receptorProfileRegistryHash', 'schemaInventoryHash', 'evidenceInventoryHash', 'testInventoryHash']) {
    assert.match(documents.provenance.sntss[key], HASH, key);
  }
});

test('R10-03 neutral fallback is inert and the SNTSS package remains hash-attested', async () => {
  const documents = await release.createReleaseDocuments(root, { commit: 'b'.repeat(40), builder: 'r10-test' });
  assert.equal(documents.provenance.sntss.neutralFallback.version, '0.0.0-neutral');
  assert.equal(documents.provenance.sntss.neutralFallback.outputs, 0);
  assert.ok(documents.provenance.sntss.packageAttestedFiles >= 30);
});

test('R10-04 preflight rejection leaves release pointer and canonical state untouched', async () => {
  const dir = await temporary('stay-r10-preflight-');
  try {
    const result = await release.releaseReplicaRehearsal(dir, { failPreflight: true });
    assert.deepEqual(result, { status: 'PREFLIGHT_REJECTED', pointerUnchanged: true, stateUnchanged: true });
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('R10-05 post-switch failure restores code pointer without rewinding acquired biology', async () => {
  const dir = await temporary('stay-r10-rollback-');
  try {
    const result = await release.releaseReplicaRehearsal(dir, { failHealth: true });
    assert.equal(result.status, 'ROLLED_BACK');
    assert.equal(result.pointerRestored, true);
    assert.equal(result.identityPreserved, true);
    assert.equal(result.biologyNotRewound, true);
    assert.equal(result.failedStateRetained, true);
    assert.equal(result.safetyBackupRetained, true);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('R10-06 accepted replica switch is atomic and preserves organism identity', async () => {
  const dir = await temporary('stay-r10-accept-');
  try {
    const result = await release.releaseReplicaRehearsal(dir);
    assert.equal(result.status, 'ACCEPTED');
    assert.equal(result.pointerSwitched, true);
    assert.equal(result.identityPreserved, true);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('R10-07 forward migration and backward projection preserve the acquired biological invariant', () => {
  const result = release.migrationRehearsal(root);
  assert.equal(result.status, 'PASS');
  assert.equal(result.beforeInvariantHash, result.forwardInvariantHash);
  assert.equal(result.beforeInvariantHash, result.backwardProjectionInvariantHash);
  assert.equal(result.sourceStateRemainsAuthoritative, true);
});

test('R10-08 generated release documents reproduce exactly and tampering fails closed', async () => {
  const dir = await temporary('stay-r10-docs-');
  try {
    await fsp.cp(root, dir, {
      recursive: true,
      filter(source) {
        const relative = path.relative(root, source).split(path.sep).join('/');
        return relative !== '.git' && !relative.startsWith('.git/') && relative !== 'release-output' && !relative.startsWith('release-output/');
      }
    });
    const written = await release.writeReleaseDocuments(dir, { commit: 'c'.repeat(40), builder: 'r10-test-copy' });
    const verified = await release.verifyReleaseDocuments(dir);
    assert.equal(verified.provenance.provenanceHash, written.provenance.provenanceHash);
    await fsp.appendFile(path.join(dir, 'docs/sntss/R10_OPERATOR_HANDOFF.md'), '\nTAMPER\n');
    await assert.rejects(() => release.verifyReleaseDocuments(dir), error => ['SNTSS_RELEASE_PROVENANCE_MISMATCH', 'SNTSS_RELEASE_INVENTORY_MISMATCH'].includes(error.code));
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('R10-09 deployer verifies R10 provenance and contains no automatic StateStore rewind extraction', () => {
  const source = fs.readFileSync(path.join(root, 'deploy/stay-deploy.sh'), 'utf8');
  assert.match(source, /sntss-release-control\.js" verify/);
  assert.match(source, /STATE_ROLLBACK_POLICY/);
  assert.match(source, /preserve-forward-state/);
  assert.doesNotMatch(source, /tar --no-same-owner --no-same-permissions -xzf "\$BACKUP_DIR\/stay-data\.tar\.gz" -C \/var\/lib\/stay/);
  assert.match(source, /failed-forward-state/);
});

test('R10-10 GitHub staging remains manual, pinned and builds v2 provenance before upload', () => {
  const source = fs.readFileSync(path.join(root, '.github/workflows/stage-lightsail-0.7.yml'), 'utf8');
  assert.match(source, /workflow_dispatch:/);
  assert.doesNotMatch(source, /^\s*push:/m);
  assert.match(source, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(source, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(source, /sntss-release-control\.js[\"']?\s+emit/);
  assert.match(source, /sha256sum "\$ARCHIVE"/);
  assert.match(source, /Upload to incoming only/);
});

test('R10-11 Git and local builders emit the same R10 provenance contract and exclude state', () => {
  const gitBuilder = fs.readFileSync(path.join(root, 'deploy/stay-deploy-git.sh'), 'utf8');
  const windowsBuilder = fs.readFileSync(path.join(root, 'tools/build-release.ps1'), 'utf8');
  for (const source of [gitBuilder, windowsBuilder]) {
    assert.match(source, /sntss-release-control\.js/);
    assert.match(source, /emit/);
    assert.match(source, /verify/);
  }
  assert.match(gitBuilder, /rm -rf .*data/);
  assert.match(windowsBuilder, /foreach \(\$relative in @\("data"/i);
});

test('R10-12 committed candidate evidence is source-hash consistent and explicitly non-production', () => {
  const evidence = JSON.parse(fs.readFileSync(path.join(root, 'docs/sntss/evidence/R10_RELEASE_EVIDENCE.json'), 'utf8'));
  assert.equal(evidence.format, 'stay-sntss-r10-release-evidence-v1');
  assert.equal(evidence.productionEligible, false);
  assert.equal(evidence.liveMutationPerformed, false);
  assert.equal(evidence.candidateClosureOnly, true);
  const expected = {
    releaseControl: fileHash('runtime/release/sntss-release-control.js'),
    test: fileHash('test/sntss-release.test.js'),
    deployer: fileHash('deploy/stay-deploy.sh'),
    gitBuilder: fileHash('deploy/stay-deploy-git.sh'),
    workflow: fileHash('.github/workflows/stage-lightsail-0.7.yml'),
    windowsBuilder: fileHash('tools/build-release.ps1')
  };
  assert.deepEqual(evidence.sourceHashes, expected);
  const body = { ...evidence }; delete body.evidenceHash;
  assert.equal(evidence.evidenceHash, release.sha256(stableStringify(body)));
});
