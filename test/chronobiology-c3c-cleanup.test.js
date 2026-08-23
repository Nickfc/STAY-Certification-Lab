'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cleanup = require('../certification/chronobiology-c3c/compute/private-material-cleanup');
const root = path.resolve(__dirname, '..');

test('C3-C-CLEANUP-01 recursively removes nested read-only fixture without following links', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-c3c-cleanup-'));
  const raw = path.join(output, 'raw');
  const ephemeral = path.join(output, 'ephemeral');
  const fixture = path.join(ephemeral, 'legacy-0.6.0');
  const nested = path.join(fixture, 'public', 'nested');
  const outside = path.join(output, 'outside-sentinel.txt');
  fs.mkdirSync(raw, { recursive: true, mode: 0o700 });
  fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(raw, 'private.tap'), 'private\n', { mode: 0o400 });
  fs.writeFileSync(path.join(nested, 'worker.js'), 'sealed\n', { mode: 0o444 });
  fs.writeFileSync(outside, 'unchanged\n', { mode: 0o600 });
  fs.symlinkSync(outside, path.join(nested, 'outside-link'));
  fs.chmodSync(nested, 0o555);
  fs.chmodSync(path.dirname(nested), 0o555);
  fs.chmodSync(fixture, 0o555);
  fs.chmodSync(ephemeral, 0o555);

  cleanup.destroyPrivateMaterial(output, [raw, ephemeral]);
  assert.equal(fs.existsSync(raw), false);
  assert.equal(fs.existsSync(ephemeral), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged\n');
  assert.doesNotThrow(() => cleanup.destroyPrivateMaterial(output, [raw, ephemeral]));
  fs.rmSync(output, { recursive: true, force: true });
});

test('C3-C-CLEANUP-02 finalization failure emits nonempty sanitized SANITIZE record', () => {
  const candidateSha = '1'.repeat(40);
  const candidateTree = '2'.repeat(40);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-c3c-sanitize-failure-'));
  const runnerPath = path.join(root, 'certification/chronobiology-c3c/compute/RUN.sh');
  const runner = fs.readFileSync(runnerPath, 'utf8');
  const functionStart = runner.indexOf('destroy_private_material() {');
  const trapLine = 'trap failure_trap ERR INT TERM';
  const trapEnd = runner.indexOf(trapLine, functionStart) + trapLine.length;
  const statusPath = path.join(directory, 'PRIVATE_STATUS.json');
  const scriptPath = path.join(directory, 'force-sanitize-failure.sh');
  const rawSibling = `${directory}-outside`;
  assert.ok(functionStart >= 0 && trapEnd > functionStart);
  fs.writeFileSync(scriptPath, `#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR=${JSON.stringify(path.dirname(runnerPath))}
OUTPUT_ROOT=${JSON.stringify(directory)}
RAW_ROOT=${JSON.stringify(rawSibling)}
EPHEMERAL_ROOT=${JSON.stringify(path.join(directory, 'ephemeral'))}
STATUS_FILE=${JSON.stringify(statusPath)}
CURRENT_STAGE=SANITIZE
mkdir -p -- "\${EPHEMERAL_ROOT}"
${runner.slice(functionStart, trapEnd)}
destroy_private_material
`, { mode: 0o700 });
  const forced = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
  assert.notEqual(forced.status, 0);
  assert.ok(fs.statSync(statusPath).size > 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(statusPath, 'utf8')), {
    schema: 'stay.chronobiology.c3c-compute-private-status/v1',
    result: 'FAILED',
    stage: 'SANITIZE',
  });
  const result = spawnSync(process.execPath, [path.join(root,
    'certification/chronobiology-c3c/compute/public-failure-record.js')], {
    env: {
      ...process.env,
      PRIVATE_STATUS_PATH: statusPath,
      CANDIDATE_SHA: candidateSha,
      CANDIDATE_TREE: candidateTree,
      COMPUTE_EXIT_CODE: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout) > 0);
  const record = JSON.parse(result.stdout);
  assert.deepEqual(record, {
    candidate_sha: candidateSha,
    candidate_tree: candidateTree,
    result: 'FAILED',
    stage: 'SANITIZE',
    exit_code: 1,
  });
  assert.equal(result.stdout.includes('private_path'), false);
  assert.equal(result.stdout.includes('assertion'), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('C3-C-CLEANUP-03 finalization keeps failure trap active until PASS COMPLETE', () => {
  const runner = fs.readFileSync(path.join(root,
    'certification/chronobiology-c3c/compute/RUN.sh'), 'utf8');
  const sanitize = runner.lastIndexOf('CURRENT_STAGE=SANITIZE');
  const cleanupAt = runner.lastIndexOf('destroy_private_material');
  const emit = runner.lastIndexOf('cat "${SANITIZED_RESULT}"');
  const pass = runner.lastIndexOf('write_status PASS COMPLETE');
  const disable = runner.lastIndexOf('trap - ERR INT TERM');
  assert.ok(sanitize < cleanupAt);
  assert.ok(cleanupAt < emit);
  assert.ok(emit < pass);
  assert.ok(pass < disable);
  assert.match(runner, /write_status FAILED "\$\{CURRENT_STAGE:-UNKNOWN\}"/);
});

test('C3-C-CLEANUP-04 cleanup CLI is path-contained and rejects sibling targets', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-c3c-boundary-'));
  const raw = path.join(output, 'raw');
  const ephemeral = path.join(output, 'ephemeral');
  const sibling = `${output}-sibling`;
  fs.mkdirSync(raw);
  fs.mkdirSync(ephemeral);
  fs.mkdirSync(sibling);
  const result = spawnSync(process.execPath, [path.join(root,
    'certification/chronobiology-c3c/compute/private-material-cleanup.js')], {
    env: {
      ...process.env,
      PRIVATE_OUTPUT_ROOT: output,
      PRIVATE_RAW_ROOT: raw,
      PRIVATE_EPHEMERAL_ROOT: sibling,
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(sibling), true);
  fs.rmSync(output, { recursive: true, force: true });
  fs.rmSync(sibling, { recursive: true, force: true });
});
