'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'P1_PRODUCTION_HARDENING_R123F_TO_R124.sha256');
const FORWARD = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'p1-r124-metab-neutral-forward.sh');
const RECOVERY = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'p1-r124-metab-neutral-forward-recovery.sh');
const MARKER_RECOVERY = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'p1-r127-metab-marker-forward-recovery.sh');

const EXPECTED_OVERLAY = Object.freeze([
  'certification/p1-r0/r123f-benchmark-closure/README.md',
  'certification/p1-r0/r123f-benchmark-closure/adjudication-v4.json',
  'certification/p1-r0/r123f-benchmark-closure/outbox-witness-v1.json',
  'certification/p1-r0/r123f-benchmark-closure/r123f-freeze.json',
  'cores/p1-r0/metab-neutral/index.js',
  'cores/p1-r0/metab-neutral/package-policy.json',
  'deploy/live-physiology-transplant/p1-r124-metab-neutral-forward-recovery.sh',
  'deploy/live-physiology-transplant/p1-r124-metab-neutral-forward.sh',
  'deploy/live-physiology-transplant/p1-r124-metab-neutral-live-proof.js',
  'deploy/live-physiology-transplant/p1-r127-metab-marker-forward-recovery.sh',
  'deploy/live-physiology-transplant/p1-resident-control-client.js',
  'runtime/kernel/canonical-json.js',
  'runtime/kernel/living-kernel.js',
  'runtime/kernel/resident-control-socket.js',
  'runtime/kernel/resident-manager.js',
  'runtime/p1-r0/c0-source-contracts/contracts/founder_profile_templates.json',
  'runtime/p1-r0/causal-frame.js',
  'runtime/p1-r0/contract-registry.js',
  'runtime/p1-r0/laboratory-persistence.js',
  'runtime/p1-r0/metab-engine.js',
  'runtime/p1-r0/metab-founder-dossier.js',
  'runtime/p1-r0/metab-neutral-birth-authority.js',
  'runtime/p1-r0/metab-neutral-contract.js',
  'runtime/p1-r0/production-persistence.js',
  'runtime/p1-r0/q16-48.js',
  'runtime/p1-r0/records.js',
  'runtime/p1-r0/resident-package-hashes.json',
  'runtime/p1-r0/resident-support.js',
  'runtime/p1-r0/residents/metab-neutral.js',
  'runtime/release/surgery-a-control.js',
  'runtime/revision-freeze.js',
  'runtime/ui/chip-projection.js',
  'server.js',
  'test/p1-r118f-release-contract.test.js',
  'test/p1-r119f-release-contract.test.js',
  'test/p1-r123f-benchmark-closure.test.js',
  'test/p1-r124-metab-founder-dossier.test.js',
  'test/p1-r124-metab-neutral-birth.test.js',
  'test/p1-r124-metab-neutral-production-proof.test.js',
  'test/p1-r124-release-contract.test.js',
  'test/p1-resident-control-socket.test.js',
  'test/p1-surgery-a-transplant.test.js',
  'test/production-hardening.test.js',
  'test/server.test.js',
  'tools/sign-metab-neutral-birth.js'
]);

function read(file) { return fs.readFileSync(file, 'utf8'); }
function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function manifestEntries() {
  const lines = read(MANIFEST).trim().split(/\r?\n/);
  const entries = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  \.\/([A-Za-z0-9._/-]+)$/.exec(line);
    assert.ok(match, `invalid R124 manifest line: ${line}`);
    assert.equal(entries.has(match[2]), false, `duplicate R124 manifest path: ${match[2]}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

test('R124-REL-01 successor manifest is exact, minimal and excludes future resident runtimes', () => {
  const entries = manifestEntries();
  assert.deepEqual([...entries.keys()], EXPECTED_OVERLAY);
  for (const [relative, digest] of entries) {
    assert.equal(hash(path.join(ROOT, relative)), digest, relative);
  }
  for (const forbidden of [
    'cores/p1-r0/metab/index.js', 'cores/p1-r0/homeos/index.js',
    'cores/p1-r0/intero/index.js', 'runtime/p1-r0/residents/metab.js',
    'runtime/p1-r0/residents/homeos.js', 'runtime/p1-r0/residents/intero.js',
    'runtime/p1-r0/homeos-engine.js', 'runtime/p1-r0/intero-engine.js',
    'runtime/p1-r0/sntss-receptor.js'
  ]) assert.equal(entries.has(forbidden), false, forbidden);
});

test('R124-REL-02 repair binds the exact failed R124 cohort and permits one guarded restart', () => {
  const source = read(FORWARD);
  for (const identity of [
    "SOURCE_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r124-metab-neutral-a1999132f935'",
    "SOURCE_MANIFEST_SHA256='a1999132f935054dc7c482313b88b0679f73475a225b9706c27ed2686d822b26'",
    'SOURCE_MANIFEST_RECORDS=43',
    'SOURCE_FILE_COUNT=644',
    "SOURCE_TREE_SHA256='7899d884fcdf619bec84835de2c57aab19813d3d2cba0665ba3ffeacef6af1e5'",
    "SOURCE_RELEASE_ENV_SHA256='bbf952d6de2434ed8f77bf458cd821d3b30253167fea953e9f8aef28b70e49aa'",
    "'sha256:161b5fe340ef01836447e21c0e77167cac86033973f8a06b3c1af1d7b44fa3cc'",
    "RECOVERY_MARKER_SHA256='933b128f24d4898550add86f4b34174f18b42e942391ec479f8956689624bb5e'",
    "FAILED_R124_EVIDENCE='/var/lib/stay/evidence/production-hardening/FAILED-R124-20260902T144307Z.eMKkA2'",
    'AUTHORIZE_R124_METAB_NEUTRAL_FORWARD_RECOVERY_ONLY'
  ]) assert.equal(source.includes(identity), true, identity);
  assert.equal((source.match(/systemctl restart stay\.service/g) || []).length, 1);
  assert.equal((source.match(/systemctl start stay\.service/g) || []).length, 0);
  assert.match(source, /RESTART_COMMITTED=1\s+systemctl restart stay\.service/);
  assert.match(source, /durable_runtime_revision\)" == 125/);
  assert.match(source, /durable_runtime_revision\)" == 127/);
  assert.doesNotMatch(source, /birth resident:metab/);
  assert.match(source, /STAY_ALLOW_METAB_NEUTRAL_RECOVERY=1/);
  assert.match(source, /STAY_METAB_NEUTRAL_RECOVERY_MARKER_SHA256/);
  assert.match(source, /remove_active_birth_material/);
  assert.match(source, /R124_METAB_NEUTRAL_RECOVERY=PASS/);
  assert.match(source, /R127_REPAIR_POST_RESTART=LEFT_REVISION_FENCED_FOR_FORWARD_RECOVERY/);
  assert.doesNotMatch(source, /git reset|sqlite3\s+.*(?:DELETE|UPDATE)|restore.*continuity|TimeoutStopSec|handlerTimeoutMs\s*=/);
});

test('R124-REL-03 candidate validation covers exact packages and real bubblewrap entry paths', () => {
  const source = read(FORWARD);
  assert.match(source, /sha256sum -c "\$TARGET_MANIFEST"/);
  assert.match(source, /candidate_file_set/);
  assert.match(source, /cores\/sntss\/i4g/);
  assert.match(source, /cores\/chronobiology\/c3r5/);
  assert.match(source, /cores\/p1-r0\/metab-neutral\/index\.js/);
  assert.match(source, /--test-name-pattern='\^R126-METAB-RECOVERY-03'/);
  assert.match(source, /p1-r119f-entry-preflight\.js/);
  assert.match(source, /STAY_REQUIRE_OS_CORE_SANDBOX=1/);
  assert.match(source, /STAY_REQUIRE_CGROUPS=1/);
  assert.doesNotMatch(source,
    /node - "\$STAGE_ROOT\/runtime\/kernel\/living-kernel\.js"/);
  assert.match(source, /const \[markerFile, evidenceRoot\] = process\.argv\.slice\(2\)/);
  assert.match(source,
    /933b128f24d4898550add86f4b34174f18b42e942391ec479f8956689624bb5e/);
  assert.match(source,
    /STAY_REQUIRE_CGROUPS=1[\s\S]*?\/usr\/local\/bin\/node --disable-sigusr1 --test --test-isolation=none \\\n+    --test-concurrency=1/);
  assert.match(source, /payloadAttachedBeforeInit/);
  assert.doesNotMatch(source, /CPUQuota=|handlerTimeoutMs.*(?:[3-9][0-9]{2}|[1-9][0-9]{3,})/);
});

test('R124-REL-04 repair is startup-only, revision-fenced and never rewinds after restart', () => {
  const source = read(FORWARD);
  const server = read(path.join(ROOT, 'server.js'));
  assert.match(source, /AUTHORIZE_R124_METAB_NEUTRAL_FORWARD_RECOVERY_ONLY/);
  assert.match(source, /R125 FAILED-BIRTH PREFLIGHT/);
  assert.match(source, /R127_METAB_NEUTRAL_FORWARD_REPAIR/);
  assert.match(source, /sourceRevision: 125, birthRevision: 126, acceptedRevision: 127/);
  assert.match(source, /revisionFenced: true, pointerRewound: false/);
  assert.match(source, /remove_active_birth_material[\s\S]*?rm -f -- "\$RECOVERY_MARKER"/);
  assert.match(source, /pointerRewound: false/);
  assert.match(source, /after\.founderId/);
  assert.match(source, /after\.instanceId/);
  assert.match(server, /await kernel\.start\(\);[\s\S]*?await kernel\.recoverMetabNeutralBirth\(\);[\s\S]*?await kernel\.installCore/);
  const committed = source.slice(source.indexOf('RESTART_COMMITTED=1'));
  assert.doesNotMatch(committed, /point_current "\$SOURCE_RELEASE"/);
  assert.doesNotMatch(source, /git reset|sqlite3\s+.*(?:DELETE|UPDATE)|restore.*continuity/);
});

test('R124-REL-05 release preserves exact resource and authority contracts', () => {
  const policy = JSON.parse(read(path.join(ROOT,
    'cores/p1-r0/metab-neutral/package-policy.json')));
  assert.deepEqual(policy.resourceContract.manifestResources, {
    hardCpuPercent: 20, hardRamMiB: 96, handlerTimeoutMs: 250,
    healthTimeoutMs: 1000, maxRestarts: 4, outputBytesPerEvent: 65536,
    outputCapacity: 128, outputLimitPerEvent: 16, pidsMax: 16,
    queueCapacity: 256, restartBackoffMs: 250, restartWindowMs: 60000,
    softCpuPercent: 5, softRamMiB: 64, storageMiB: 4
  });
  assert.equal(policy.bounds.productionOutputs, 0);
  assert.deepEqual(policy.allowedBuiltins, ['node:crypto']);
  assert.deepEqual(policy.ambientCapabilities, {
    filesystemWrite: false, network: false, processSpawn: false
  });
});

test('R124-REL-06 clean overlay loads the real preflight proof in isolation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-r124-overlay-'));
  try {
    for (const relative of manifestEntries().keys()) {
      const target = path.join(directory, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(ROOT, relative), target);
    }
    const proof = path.join(directory, 'deploy', 'live-physiology-transplant',
      'p1-r124-metab-neutral-live-proof.js');
    const result = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', proof], {
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('R127-PRESERVE-REL-01 exact stranded R127 state recovers and freezes without widening limits', () => {
  const source = read(MARKER_RECOVERY);
  const proof = read(path.join(ROOT, 'deploy', 'live-physiology-transplant',
    'p1-r124-metab-neutral-live-proof.js'));
  for (const identity of [
    "ACTIVE_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r127-metab-repair-fb8d675114b4'",
    "ACTIVE_MANIFEST_SHA256='fb8d675114b4d35a8d478c69b547910014234e63df1b928876fed7c49cbf2dcf'",
    "ACTIVE_RELEASE_ENV_SHA256='c82a2454d50ca1602dbdab0b3db532963a17e8913b3ff2475182eb7b004f921d'",
    'ACTIVE_FILE_COUNT=644',
    'TARGET_FILE_COUNT=645',
    "RECOVERY_MARKER_SHA256='933b128f24d4898550add86f4b34174f18b42e942391ec479f8956689624bb5e'",
    "ACTIVE_TREE_SHA256='ce832ae2a465804a917d40fbbf2475d367af2e537101fe471593d0f2ad4d24d8'",
    "FAILED_R127_EVIDENCE='/var/lib/stay/evidence/production-hardening/FAILED-R127-MARKER-20260902T171244Z.x3NznR'",
    "FAILED_R127_TREE_SHA256='d8116e02ac70747929950a36186795134f272905da5663d18d61c68c8e826466'",
    'EXPECTED_STRANDED_PID=436477',
    'EXPECTED_STRANDED_PENDING_DELIVERIES=0',
    'AUTHORIZE_R127_METAB_REVISION_PRESERVING_FORWARD_RECOVERY_ONLY'
  ]) assert.equal(source.includes(identity), true, identity);
  assert.equal((source.match(/systemctl restart stay\.service/g) || []).length, 1);
  assert.equal((source.match(/systemctl start stay\.service/g) || []).length, 0);
  assert.match(source, /durable_runtime_revision\)" == 127/);
  assert.match(source, /STAY_ALLOW_METAB_NEUTRAL_RECOVERY_REVISION_PRESERVATION=1/);
  assert.match(source, /--test-name-pattern='\^R127-METAB-RECOVERY-05'/);
  assert.match(source, /restartCommands: 4/);
  assert.match(source, /R127_METAB_NEUTRAL_REVISION_PRESERVING_FORWARD_RECOVERY/);
  assert.match(source, /kernelRevisionPreserved: true/);
  assert.match(source, /fetusInstallRevisionPreserved: true/);
  assert.match(source, /value\.pendingDeliveries === expectedPendingDeliveries/);
  assert.match(source, /expectedPendingDeliveries === 0/);
  assert.match(source, /value\.abandonedDeliveries === 0/);
  assert.match(source, /before\.pendingDeliveries === 0/);
  assert.match(source, /before\.abandonedDeliveries === 0/);
  assert.doesNotMatch(source, /pendingDeliveries > 0/);
  assert.match(source, /missing_active_overlay_files=\(\)/);
  assert.match(source, /missing_active_overlay_files\[0\][\s\S]*p1-r127-metab-marker-forward-recovery\.sh/);
  assert.match(source, /find "\$CANDIDATE" -type f \| wc -l\)" -eq "\$TARGET_FILE_COUNT"/);
  assert.match(source, /markerAccessRepaired: true,[\s\S]*?revisionFenced: true, pointerRewound: false/);
  assert.match(source, /R127_PRESERVATION_POST_RESTART=LEFT_REVISION_FENCED_FOR_FORWARD_RECOVERY/);
  assert.match(proof, /function validateR127RevisionPreservingAfter\(input\)/);
  const committed = source.slice(source.indexOf('RESTART_COMMITTED=1'));
  assert.doesNotMatch(committed, /point_current "\$ACTIVE_RELEASE"/);
  assert.doesNotMatch(source,
    /TimeoutStartSec|TimeoutStopSec|CPUQuota=|handlerTimeoutMs\s*=|healthTimeoutMs\s*=|git reset|sqlite3\s+.*(?:DELETE|UPDATE)/);
});

module.exports = Object.freeze({ EXPECTED_OVERLAY });
