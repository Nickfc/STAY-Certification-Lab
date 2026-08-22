'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const evidence = require('../certification/chronobiology-c3c/split-evidence');

const root = path.resolve(__dirname, '..');
const candidateSha = '1'.repeat(40);
const candidateTree = '2'.repeat(40);

function tap(tests = 3, skipped = 0) {
  return [
    `# tests ${tests}`,
    `# pass ${tests - skipped}`,
    '# fail 0',
    '# cancelled 0',
    `# skipped ${skipped}`,
    '# todo 0',
    '# duration_ms 12.5',
    '',
  ].join('\n');
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-c3c-split-'));
  const raw = path.join(directory, 'raw');
  const logs = path.join(raw, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  for (const name of ['direct', 'targeted', 'full']) {
    fs.writeFileSync(path.join(logs, `${name}.tap`), tap());
  }
  fs.writeFileSync(path.join(raw, 'performance.json'), JSON.stringify({
    handler_limit_ms: 250,
    one_year_catchup_ms: 42.25,
    result: 'PASS',
  }));
  fs.writeFileSync(path.join(raw, 'cpu-stat-before.txt'), 'cpu 100 0 100 800 0 0 0 0 0 0\n');
  fs.writeFileSync(path.join(raw, 'cpu-stat-after.txt'), 'cpu 120 0 120 960 0 0 0 1 0 0\n');
  for (const name of [
    'source-tree.txt', 'source-status.txt',
    'environment-before.txt', 'environment-after.txt',
    'node-pids-before.txt', 'node-pids-after.txt', 'new-node-pids.txt',
    'processes-before.txt', 'processes-after.txt',
  ]) fs.writeFileSync(path.join(raw, name), `${name}\n`);
  return directory;
}

function liveFixture(directory, compute, before = 'MainPID=1\n/opt/stay/current=/release\n') {
  const beforeFile = path.join(directory, 'live-before.txt');
  const afterFile = path.join(directory, 'live-after.txt');
  const processBeforeFile = path.join(directory, 'processes-before-live.txt');
  const processAfterFile = path.join(directory, 'processes-after-live.txt');
  fs.writeFileSync(beforeFile, before);
  fs.writeFileSync(afterFile, before);
  fs.writeFileSync(processBeforeFile, 'before\n');
  fs.writeFileSync(processAfterFile, 'after\n');
  return evidence.buildLiveResult({
    candidateSha,
    candidateTree,
    compute,
    beforeFile,
    afterFile,
    processBeforeFile,
    processAfterFile,
  });
}

test('C3-C-SPLIT-01 compute runner is detached, private, zero-skip and has no live sentinel', () => {
  const runner = fs.readFileSync(path.join(root,
    'certification/chronobiology-c3c/compute/RUN.sh'), 'utf8');
  assert.match(runner, /Nickfc\/STAY-Certification-Lab/);
  assert.match(runner, /git symbolic-ref -q --short HEAD/);
  assert.match(runner, /require_zero_tap DIRECT/);
  assert.match(runner, /require_zero_tap TARGETED/);
  assert.match(runner, /require_zero_tap FULL/);
  assert.match(runner, /new-node-pids\.txt/);
  assert.match(runner, /cpu-stat-preflight/);
  assert.doesNotMatch(runner, /systemctl|stay\.service|\/opt\/stay\/current/);
  assert.doesNotMatch(runner, /tee .*\.tap|cat .*\.tap/);
  assert.match(runner, /prepare-legacy-fixture\.js/);
  assert.match(runner, /unset STAY_LEGACY_0_6_SOURCE_TAR_GZ_GPG/);
  assert.match(runner, /unset STAY_LEGACY_0_6_FIXTURE_PASSPHRASE/);
  assert.match(runner, /STAY_I1C_LEGACY_SOURCE_DIR/);
  assert.doesNotMatch(runner, /\[\[ -d \/opt\/stay\/legacy\/0\.6\.0/);
});

test('C3-C-SPLIT-02 sanitized compute result contains only allowed fields and binds raw hashes', () => {
  const directory = fixture();
  const compute = evidence.buildComputeResult({
    root: directory,
    candidateSha,
    candidateTree,
  });
  assert.equal(evidence.validateComputeResult(compute), compute);
  assert.deepEqual(Object.keys(compute).sort(), [
    'candidate', 'environment', 'evidence_hashes', 'performance',
    'record_sha256', 'result', 'schema', 'tests',
  ]);
  assert.equal(JSON.stringify(compute).includes('source-tree.txt'), false);
  assert.equal(JSON.stringify(compute).includes('TAP version'), false);
  assert.match(compute.evidence_hashes.direct_tap, /^sha256:[0-9a-f]{64}$/);
  assert.match(compute.evidence_hashes.cpu_stat_after, /^sha256:[0-9a-f]{64}$/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('C3-C-SPLIT-03 zero-skip, 250 ms and sustained-CPU gates fail closed', () => {
  const directory = fixture();
  fs.writeFileSync(path.join(directory, 'raw/logs/direct.tap'), tap(3, 1));
  assert.throws(() => evidence.buildComputeResult({ root: directory, candidateSha, candidateTree }),
    { code: 'C3C_SPLIT_TEST_GATE' });

  fs.writeFileSync(path.join(directory, 'raw/logs/direct.tap'), tap());
  fs.writeFileSync(path.join(directory, 'raw/performance.json'), JSON.stringify({
    handler_limit_ms: 250, one_year_catchup_ms: 250, result: 'PASS',
  }));
  assert.throws(() => evidence.buildComputeResult({ root: directory, candidateSha, candidateTree }),
    { code: 'C3C_SPLIT_PERFORMANCE_GATE' });

  fs.writeFileSync(path.join(directory, 'raw/performance.json'), JSON.stringify({
    handler_limit_ms: 250, one_year_catchup_ms: 10, result: 'PASS',
  }));
  fs.writeFileSync(path.join(directory, 'raw/cpu-stat-after.txt'),
    'cpu 120 0 120 950 0 0 0 20 0 0\n');
  assert.throws(() => evidence.buildComputeResult({ root: directory, candidateSha, candidateTree }),
    { code: 'C3C_SPLIT_ENVIRONMENT_GATE' });
  fs.rmSync(directory, { recursive: true, force: true });
});

test('C3-C-SPLIT-04 live lane uses only the real read-only sentinel', () => {
  const runner = fs.readFileSync(path.join(root,
    'certification/chronobiology-c3c/live/RUN.sh'), 'utf8');
  assert.match(runner, /systemctl show stay\.service/);
  assert.match(runner, /readlink -f \/opt\/stay\/current/);
  assert.match(runner, /cmp -s .*live-before\.txt.*live-after\.txt/);
  assert.doesNotMatch(runner, /systemctl\s+(restart|start|stop)|npm test|node --test/);
  assert.doesNotMatch(runner, /ln\s+-s|git\s+(merge|checkout|switch|reset)|StateStore/);
});

test('C3-C-SPLIT-05 binder requires exact SHA, tree and compute-record digest', () => {
  const directory = fixture();
  const compute = evidence.buildComputeResult({ root: directory, candidateSha, candidateTree });
  const live = liveFixture(directory, compute);
  const binding = evidence.bindSplitEvidence(compute, live);
  assert.equal(binding.result, 'CANDIDATE_CERTIFIED_UNSEALED');
  assert.equal(binding.release_sealed, false);
  assert.deepEqual(binding.candidate, { sha: candidateSha, tree: candidateTree });

  const wrongTree = structuredClone(live);
  wrongTree.candidate.tree = '3'.repeat(40);
  wrongTree.record_sha256 = evidence.recordSha256(wrongTree);
  assert.throws(() => evidence.bindSplitEvidence(compute, wrongTree),
    { code: 'C3C_SPLIT_CANDIDATE_MISMATCH' });

  const wrongCompute = structuredClone(live);
  wrongCompute.compute_record_sha256 = `sha256:${'4'.repeat(64)}`;
  wrongCompute.record_sha256 = evidence.recordSha256(wrongCompute);
  assert.throws(() => evidence.bindSplitEvidence(compute, wrongCompute),
    { code: 'C3C_SPLIT_CANDIDATE_MISMATCH' });
  fs.rmSync(directory, { recursive: true, force: true });
});

test('C3-C-SPLIT-06 changed live sentinel and record tampering fail closed', () => {
  const directory = fixture();
  const compute = evidence.buildComputeResult({ root: directory, candidateSha, candidateTree });
  const live = liveFixture(directory, compute);
  const tampered = structuredClone(compute);
  tampered.tests.direct.duration_ms += 1;
  assert.throws(() => evidence.validateComputeResult(tampered), /record hash is invalid/);

  const beforeFile = path.join(directory, 'changed-before.txt');
  const afterFile = path.join(directory, 'changed-after.txt');
  const processes = path.join(directory, 'changed-processes.txt');
  fs.writeFileSync(beforeFile, 'MainPID=1\n');
  fs.writeFileSync(afterFile, 'MainPID=2\n');
  fs.writeFileSync(processes, 'none\n');
  assert.throws(() => evidence.buildLiveResult({
    candidateSha, candidateTree, compute, beforeFile, afterFile,
    processBeforeFile: processes, processAfterFile: processes,
  }), { code: 'C3C_SPLIT_LIVE_GATE' });
  fs.rmSync(directory, { recursive: true, force: true });
});

test('C3-C-SPLIT-07 candidate status binds every certification execution path', () => {
  const status = JSON.parse(fs.readFileSync(path.join(root,
    'docs/chronobiology/c3c-certification-status.json'), 'utf8'));
  assert.equal(status.result, 'SPLIT_HOST_EVIDENCE_PENDING');
  assert.equal(status.release_sealed, false);
  assert.equal(status.split_host_certification.binding.required_identity,
    'EXACT_SAME_CANDIDATE_SHA_TREE_AND_COMPUTE_RECORD_DIGEST');
  for (const [relative, expected] of Object.entries(
    status.integrity.closure_evidence_sha256)) {
    const actual = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(root, relative))).digest('hex');
    assert.equal(actual, expected, relative);
  }
});

test('C3-C-SPLIT-08 public lab emits only sanitized JSON and destroys raw material', () => {
  const publicRunner = fs.readFileSync(path.join(root,
    'certification/chronobiology-c3c/compute/PUBLIC_RUN.sh'), 'utf8');
  assert.match(publicRunner, /Nickfc\/STAY-Certification-Lab/);
  assert.match(publicRunner, /GITHUB_EVENT_NAME.*workflow_dispatch/);
  assert.match(publicRunner, /exec >"\$\{PRIVATE_DRIVER_LOG\}" 2>&1/);
  assert.match(publicRunner, /rm -rf -- "\$\{PRIVATE_ROOT\}"/);
  assert.match(publicRunner, /cat "\$\{RESULT\}" >&3/);
  assert.doesNotMatch(publicRunner, /cat .*driver|upload-artifact|tee/);

  const workflow = fs.readFileSync(path.join(root,
    'certification/chronobiology-c3c/compute/PUBLIC_LAB_WORKFLOW.yml.example'), 'utf8');
  assert.match(workflow, /repository: Nickfc\/STAY-Genesis/);
  assert.match(workflow, /ssh-key: \$\{\{ secrets\.STAY_GENESIS_READONLY_DEPLOY_KEY \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /source\.tar\.gz\.gpg/);
  assert.match(workflow, /STAY_LEGACY_0_6_FIXTURE_PASSPHRASE/);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/COMPUTE_RESULT\.sanitized\.json/);
  assert.doesNotMatch(workflow, /path:.*(?:raw|tap|source-tree|processes)/);
});

test('C3-C-SPLIT-09 sterile legacy fixture is canonical, ephemeral and never uses live data', () => {
  const builder = fs.readFileSync(path.join(root,
    'certification/chronobiology-c3c/compute/prepare-legacy-fixture.js'), 'utf8');
  assert.match(builder, /STAY_LEGACY_0_6_SOURCE_TAR_GZ_GPG/);
  assert.match(builder, /STAY_LEGACY_0_6_FIXTURE_PASSPHRASE/);
  assert.match(builder, /'--passphrase-fd', '0'/);
  assert.match(builder, /legacy\/0\.6\.0\/SOURCE_ARCHIVE_SHA256/);
  assert.match(builder, /SOURCE_FILES/);
  assert.match(builder, /sha256\(fs\.readFileSync\(archivePath\)\) !== expectedArchiveDigest/);
  assert.match(builder, /fs\.chmodSync\(target, 0o444\)/);
  assert.match(builder, /fs\.rmSync\(work, \{ recursive: true, force: true \}\)/);
  assert.doesNotMatch(builder, /\/var\/lib\/stay|\/opt\/stay\/current|stay\.service/);

  const preparation = fs.readFileSync(path.join(root,
    'certification/chronobiology-c3c/compute/PREPARE_ENCRYPTED_FIXTURE.sh'), 'utf8');
  assert.match(preparation, /SOURCE_ARCHIVE_SHA256/);
  assert.match(preparation, /--symmetric --cipher-algo AES256/);
  assert.match(preparation, /\/opt\/stay\/\*\|\/var\/lib\/stay\/\*/);
  assert.doesNotMatch(preparation, /cat .*SOURCE_ARCHIVE|echo .*PASSPHRASE/);
});
