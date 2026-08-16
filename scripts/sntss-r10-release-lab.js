'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const release = require('../runtime/release/sntss-release-control');

const root = path.resolve(__dirname, '..');
function option(name, fallback = null) { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; }
function fileHash(relative) { return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex')}`; }

async function main() {
  const output = path.resolve(option('--output', path.join(root, 'docs/sntss/evidence/R10_RELEASE_EVIDENCE.generated.json')));
  const commit = option('--commit', '0'.repeat(40));
  const first = await release.createReleaseDocuments(root, { commit, builder: 'sntss-r10-release-lab', branch: 'candidate' });
  const second = await release.createReleaseDocuments(root, { commit, builder: 'sntss-r10-release-lab', branch: 'candidate' });
  const migration = release.migrationRehearsal(root);
  const preflightDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stay-r10-preflight-'));
  const rollbackDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stay-r10-rollback-'));
  const acceptDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stay-r10-accept-'));
  try {
    const preflight = await release.releaseReplicaRehearsal(preflightDir, { failPreflight: true });
    const rollback = await release.releaseReplicaRehearsal(rollbackDir, { failHealth: true });
    const accepted = await release.releaseReplicaRehearsal(acceptDir);
    const body = {
      format: 'stay-sntss-r10-release-evidence-v1',
      candidateVersion: '0.1.0',
      candidateCommit: commit === '0'.repeat(40) ? null : commit,
      candidateCommitPinned: commit !== '0'.repeat(40),
      candidateClosureOnly: true,
      productionEligible: false,
      liveMutationPerformed: false,
      activeReleasePointerTouched: false,
      activeStatePathTouched: false,
      stateRollbackPolicy: 'preserve-forward-state',
      package: {
        deterministicInventory: first.inventory.inventoryHash === second.inventory.inventoryHash,
        inventoryHash: first.inventory.inventoryHash,
        provenanceHash: first.provenance.provenanceHash,
        dependencyInventoryHash: first.provenance.dependencyInventoryHash,
        packagePolicyHash: first.provenance.sntss.packagePolicyHash,
        speciesProfileHash: first.provenance.sntss.speciesProfileHash,
        sourceRegistryHash: first.provenance.sntss.sourceRegistryHash,
        receptorProfileRegistryHash: first.provenance.sntss.receptorProfileRegistryHash,
        schemaInventoryHash: first.provenance.sntss.schemaInventoryHash,
        evidenceInventoryHash: first.provenance.sntss.evidenceInventoryHash,
        neutralFallback: first.provenance.sntss.neutralFallback
      },
      migration,
      rehearsal: { preflight, rollback, accepted },
      sourceHashes: {
        releaseControl: fileHash('runtime/release/sntss-release-control.js'),
        test: fileHash('test/sntss-release.test.js'),
        deployer: fileHash('deploy/stay-deploy.sh'),
        gitBuilder: fileHash('deploy/stay-deploy-git.sh'),
        workflow: fileHash('.github/workflows/stage-lightsail-0.7.yml'),
        windowsBuilder: fileHash('tools/build-release.ps1')
      },
      blockersRemaining: ['R8 formal host-endurance closure', 'R9 formal dependency closure', 'R10 isolated production-host release rehearsal'],
      status: 'CANDIDATE_PASS'
    };
    const evidence = { ...body, evidenceHash: release.sha256(stableStringify(body)) };
    await fsp.mkdir(path.dirname(output), { recursive: true });
    await fsp.writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ status: evidence.status, evidenceHash: evidence.evidenceHash, output })}\n`);
  } finally {
    await Promise.all([preflightDir, rollbackDir, acceptDir].map(dir => fsp.rm(dir, { recursive: true, force: true })));
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
