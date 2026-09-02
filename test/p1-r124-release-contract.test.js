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

test('R124-REL-02 forward path binds the exact R123F host and permits one guarded restart', () => {
  const source = read(FORWARD);
  for (const identity of [
    "SOURCE_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r119f-chrono-repair-2961f9a48173'",
    "SOURCE_MANIFEST_SHA256='021c837c3b1d2a1e855e39e6154790e48a0ecc6f5bbb07dddc9776d63ad733eb'",
    "SOURCE_FILE_COUNT=612",
    "SOURCE_TREE_SHA256='c97d4850e4747de7a6d80231047140ef99bfabdf69e762b8b52367f1ce30d9a2'",
    "'sha256:161b5fe340ef01836447e21c0e77167cac86033973f8a06b3c1af1d7b44fa3cc'",
    'AUTHORIZE_R124_METAB_NEUTRAL_ZERO_AUTHORITY_BIRTH'
  ]) assert.equal(source.includes(identity), true, identity);
  assert.equal((source.match(/systemctl restart stay\.service/g) || []).length, 1);
  assert.match(source, /RESTART_COMMITTED=1\s+systemctl restart stay\.service/);
  assert.match(source, /durable_runtime_revision\)" == 123/);
  assert.match(source, /durable_runtime_revision\)" == 124/);
  assert.match(source, /birth resident:metab/);
  assert.match(source, /remove_active_birth_material/);
  assert.match(source, /R124_METAB_NEUTRAL_ZERO_AUTHORITY_BIRTH/);
  assert.match(source, /R124_FORWARD_POST_RESTART=LEFT_REVISION_FENCED_FOR_FORWARD_RECOVERY/);
  assert.doesNotMatch(source, /git reset|sqlite3\s+.*(?:DELETE|UPDATE)|restore.*continuity|TimeoutStopSec|handlerTimeoutMs\s*=/);
});

test('R124-REL-03 candidate validation covers exact packages and real bubblewrap entry paths', () => {
  const source = read(FORWARD);
  assert.match(source, /sha256sum -c "\$TARGET_MANIFEST"/);
  assert.match(source, /candidate_file_set/);
  assert.match(source, /cores\/sntss\/i4g/);
  assert.match(source, /cores\/chronobiology\/c3r5/);
  assert.match(source, /cores\/p1-r0\/metab-neutral\/index\.js/);
  assert.match(source, /--test-name-pattern='\^R124-METAB-ENTRY-01'/);
  assert.match(source, /p1-r119f-entry-preflight\.js/);
  assert.match(source, /STAY_REQUIRE_OS_CORE_SANDBOX=1/);
  assert.match(source, /STAY_REQUIRE_CGROUPS=1/);
  assert.match(source, /payloadAttachedBeforeInit/);
  assert.doesNotMatch(source, /CPUQuota=|handlerTimeoutMs.*(?:[3-9][0-9]{2}|[1-9][0-9]{3,})/);
});

test('R124-REL-04 recovery is revision-fenced, founder-preserving and never rewinds the pointer', () => {
  const source = read(RECOVERY);
  assert.match(source, /AUTHORIZE_R124_METAB_NEUTRAL_FORWARD_RECOVERY_ONLY/);
  assert.match(source, /revision" == 124 \|\| "\$revision" == 125/);
  assert.match(source, /inactive-r124-has-no-durable-birth/);
  assert.equal((source.match(/systemctl start stay\.service/g) || []).length, 1);
  assert.equal((source.match(/systemctl restart stay\.service/g) || []).length, 0);
  assert.match(source, /birth resident:metab/);
  assert.match(source, /pointerRewound: false/);
  assert.match(source, /after\.founderId/);
  assert.match(source, /after\.instanceId/);
  assert.doesNotMatch(source, /point_current|SOURCE_RELEASE.*current|git reset|restore.*continuity/);
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

module.exports = Object.freeze({ EXPECTED_OVERLAY });
