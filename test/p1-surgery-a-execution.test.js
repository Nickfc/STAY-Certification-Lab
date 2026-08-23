'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT,
  'deploy/live-physiology-transplant/p1-surgery-a-execute.sh');

test('P1-EXEC-01 production controller pins the independently certified candidate', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /EXPECTED_CANDIDATE_SHA="7d040592ccf1f149f0f0a170f79cf76bb5f05d92"/);
  assert.match(source, /EXPECTED_CANDIDATE_TREE="450cc22f70b7abf3b5733fe882049d88cd52de74"/);
  assert.match(source, /EXPECTED_COMPUTE_RECORD_SHA256="sha256:384f3f2e27232b555fe52185c775562d31cf7fac349dfb95ae93968225c83ec1"/);
});

test('P1-EXEC-02 host identity guard precedes authorization, systemd and release writes', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const guard = source.indexOf('p1-host-identity-guard.sh');
  assert.ok(guard >= 0);
  for (const marker of [
    'STAY_SURGERY_A_WRITE_AUTHORIZED',
    'systemctl',
    'mkdir -p "$EVIDENCE_DIR"',
    'cp -a "$staged"',
    'mv -Tf "$CURRENT.p1-surgery-a"'
  ]) {
    assert.ok(source.indexOf(marker) > guard, marker);
  }
});

test('P1-EXEC-03 rollback is code-forward and contains no StateStore restore path', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /FINAL_ROLLBACK/);
  assert.match(source, /canonical_forward_state_preserved=YES/);
  assert.match(source, /STATESTORE_POST_SCHEMA=4/);
  assert.doesNotMatch(source, /tar\s+[^\n]*-x|sqlite3\s+[^\n]*restore|cp\s+[^\n]*(stay-data|continuity\.sqlite3)|rm\s+[^\n]*\/var\/lib\/stay\/data/);
});

test('P1-EXEC-04 post-start gates require continuity, no new residents and unchanged authority', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /Number\(schema\?\.version\) !== 4/);
  assert.match(source, /physiology resident activated/);
  assert.match(source, /new physiology authority activated/);
  assert.match(source, /biological authority identity changed/);
  assert.match(source, /fetus checkpoint continuity regressed/);
  assert.match(source, /READY_FOR_SURGERY_B=AWAITING_REVIEW/);
});

test('P1-EXEC-05 candidate verification is deprivileged under a trusted host Node', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /-x \/usr\/local\/bin\/node/);
  assert.match(source, /-x \/usr\/bin\/node/);
  assert.match(source, /runuser -u "\$STAY_USER" -- "\$NODE_BIN"/);
  assert.doesNotMatch(source, /\n\s*node "\$release\//);
});

test('P1-EXEC-06 forward rollback starts only the certified rollback entrypoint', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /p1-forward-compatible-rollback\.conf/);
  assert.match(source, /ExecStart=%s --disable-sigusr1 \/opt\/stay\/current\/server-surgery-a-rollback\.js/);
  assert.match(source, /systemctl daemon-reload/);
});

test('P1-EXEC-07 every release installation stage emits a sanitized abort marker', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  for (const stage of [
    'destination-precheck',
    'copy',
    'chown',
    'chmod-dirs',
    'chmod-files',
    'atomic-publish',
    'existing-release-verify'
  ]) {
    assert.match(source, new RegExp(`RELEASE_INSTALL_STAGE=${stage}`));
  }
  assert.match(source, /fail "release-install-\$stage"/);
  assert.match(source, /cp -a "\$staged" "\$incoming" \|\| install_stage_fail "copy"/);
  assert.match(source, /chown -R root:root "\$incoming" \|\| install_stage_fail "chown"/);
  assert.match(source, /mv "\$incoming" "\$final" \|\| install_stage_fail "atomic-publish"/);
});

test('P1-EXEC-08 install_release enters destination precheck with nounset enabled', (t) => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const match = source.match(/install_release\(\) \{[\s\S]*?\n\}\n\ninstall_release "\$STAGED_CANDIDATE"/);
  assert.ok(match, 'install_release function must be extractable for the nounset harness');
  const functionSource = match[0].replace(/\n\ninstall_release "\$STAGED_CANDIDATE"[\s\S]*$/, '');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-p1-nounset-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const releases = path.join(root, 'releases');
  const staged = path.join(root, 'staged');
  fs.mkdirSync(releases);
  fs.mkdirSync(staged);
  const harness = `
set -u
RELEASES="$1"
STAMP=test
STAY_USER=staydeploy
NODE_BIN=/usr/bin/node
fail() { echo "SURGERY_A_ABORT=$1" >&2; return "\${2:-60}"; }
cp() { return 91; }
${functionSource}
install_release "$2" nounset-regression
`;
  const result = spawnSync('/bin/bash', ['-c', harness, 'p1-nounset-test', releases, staged], {
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0, 'stubbed copy must stop the harness');
  assert.match(`${result.stdout}\n${result.stderr}`,
    /RELEASE_INSTALL_STAGE=destination-precheck/);
  assert.doesNotMatch(result.stderr, /release_id: unbound variable/);
});
