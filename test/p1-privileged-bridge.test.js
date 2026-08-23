'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WRAPPER = path.join(ROOT,
  'deploy/live-physiology-transplant/stay-p1-production-controller');
const INSTALLER = path.join(ROOT,
  'deploy/live-physiology-transplant/install-p1-production-controller.sh');
const PREFLIGHT = path.join(ROOT,
  'deploy/live-physiology-transplant/p1-live-preflight.sh');
const WORKFLOW = path.join(ROOT, '.github/workflows/stage-lightsail-0.7.yml');

function callCleanup(runRoot, prefix) {
  return spawnSync('/bin/bash', [
    '-c', 'source "$1"; safe_cleanup "$2" "$3"',
    'p1-cleanup-test', WRAPPER, runRoot, prefix
  ], { encoding: 'utf8' });
}

test('P1-BRIDGE-01 cleanup removes a nested immutable incoming tree', (t) => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-p1-incoming-'));
  t.after(() => fs.rmSync(prefix, { recursive: true, force: true }));
  const runRoot = path.join(prefix, 'p1-actions-12345');
  const nested = path.join(runRoot, 'releases', 'immutable', 'deep');
  fs.mkdirSync(nested, { recursive: true });
  const file = path.join(nested, 'manifest.json');
  fs.writeFileSync(file, '{}\n');
  fs.chmodSync(file, 0o444);
  for (const dir of [nested, path.dirname(nested), path.dirname(path.dirname(nested)), runRoot]) {
    fs.chmodSync(dir, 0o555);
  }

  const result = callCleanup(runRoot, prefix);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(runRoot), false);

  const repeat = callCleanup(runRoot, prefix);
  assert.equal(repeat.status, 0, repeat.stderr);
});

test('P1-BRIDGE-02 cleanup refuses symlinks, path escapes and special files', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-p1-boundary-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const prefix = path.join(parent, 'incoming');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(prefix);
  fs.mkdirSync(outside);
  const outsideFile = path.join(outside, 'must-survive');
  fs.writeFileSync(outsideFile, 'forward-state\n');

  const symlinkRoot = path.join(prefix, 'p1-actions-101');
  fs.mkdirSync(symlinkRoot);
  fs.symlinkSync(outside, path.join(symlinkRoot, 'escape'));
  let result = callCleanup(symlinkRoot, prefix);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'forward-state\n');
  assert.equal(fs.existsSync(symlinkRoot), true);

  result = callCleanup(outside, prefix);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(outsideFile), true);

  const specialRoot = path.join(prefix, 'p1-actions-102');
  fs.mkdirSync(specialRoot);
  const fifo = path.join(specialRoot, 'special-fifo');
  const mkfifo = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(mkfifo.status, 0, mkfifo.stderr);
  result = callCleanup(specialRoot, prefix);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(specialRoot), true);

  const hardlinkRoot = path.join(prefix, 'p1-actions-103');
  fs.mkdirSync(hardlinkRoot);
  fs.linkSync(outsideFile, path.join(hardlinkRoot, 'external-hardlink'));
  result = callCleanup(hardlinkRoot, prefix);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'forward-state\n');
});

test('P1-BRIDGE-03 direct or denied privilege invocation fails closed', () => {
  const env = { ...process.env };
  delete env.SUDO_USER;
  const result = spawnSync(WRAPPER, [
    'preflight', '/opt/stay/incoming/p1-actions-123', 'NO_AUTHORIZATION'
  ], { encoding: 'utf8', env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P1_CONTROLLER_ABORT=privileged-sudo-context-required/);
});

test('P1-BRIDGE-04 preflight has sentinels and no mutating service or pointer action', () => {
  const wrapper = fs.readFileSync(WRAPPER, 'utf8');
  const preflight = fs.readFileSync(PREFLIGHT, 'utf8');
  assert.match(wrapper, /SERVICE_OPERATION=NO/);
  assert.match(wrapper, /CURRENT_POINTER_CHANGE=NO/);
  assert.match(wrapper, /STATESTORE_WRITE=NO/);
  assert.match(wrapper, /RESIDENT_OPERATION=NO/);
  assert.match(wrapper, /AUTHORITY_CHANGE=NO/);
  assert.doesNotMatch(preflight, /systemctl\s+(?:start|stop|restart|reload)\b/);
  assert.doesNotMatch(preflight, /(?:ln|mv)\s+[^\n]*\/opt\/stay\/current/);
  assert.doesNotMatch(preflight, /(?:INSERT|UPDATE|DELETE|BEGIN IMMEDIATE|writeLife|appendJournal)/);
});

test('P1-BRIDGE-05 surgery and rollback authorizations remain exact and distinct', () => {
  const wrapper = fs.readFileSync(WRAPPER, 'utf8');
  const surgery = 'AUTHORIZE_SURGERY_A_7D040592CCF1F149';
  const rollback = 'AUTHORIZE_ROLLBACK_A_FORWARD_STATE_7D040592CCF1F149';
  assert.notEqual(surgery, rollback);
  assert.match(wrapper, new RegExp(surgery));
  assert.match(wrapper, new RegExp(rollback));
  assert.match(wrapper, /preflight-authorization-argument-invalid/);
  assert.match(wrapper, /surgery-authorization-missing/);
  assert.match(wrapper, /rollback-authorization-missing/);
});

test('P1-BRIDGE-06 sudoers grants only the installed root-owned controller', () => {
  const installer = fs.readFileSync(INSTALLER, 'utf8');
  const heredoc = installer.match(/<<'SUDOERS'\n([\s\S]*?)\nSUDOERS/);
  assert.ok(heredoc);
  assert.match(heredoc[1],
    /^staydeploy ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/stay-p1-production-controller$/m);
  assert.doesNotMatch(heredoc[1], /systemd-run|\/bin\/(?:ba)?sh|\bnode\b|\brm\b|\bcp\b|\bmv\b|systemctl|ALL\s*$/m);
  assert.match(installer, /install -o root -g root -m 0555/);
  assert.match(installer, /SURGERY_A_AUTHORIZED=NO/);
  assert.match(installer, /ROLLBACK_A_AUTHORIZED=NO/);
  assert.match(installer, /B0_SANDBOX_REPAIR_COMPLETION_AUTHORIZED=NO/);
});

test('P1-BRIDGE-07 privileged parsing uses a root-owned non-writable host Node', () => {
  const wrapper = fs.readFileSync(WRAPPER, 'utf8');
  assert.match(wrapper, /stat -Lc '%U:%G'/);
  assert.match(wrapper, /root:root/);
  assert.match(wrapper, /8#022/);
  assert.match(wrapper, /trusted_root_executable "\$candidate"/);
  assert.match(wrapper,
    /PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/);
});

test('P1-BRIDGE-08 root wrapper preserves sanitized release install classification', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-p1-classify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [stage, expected] of [
    ['destination-precheck', 'RELEASE_INSTALL_DESTINATION_PRECHECK_FAILED'],
    ['copy', 'RELEASE_INSTALL_COPY_FAILED'],
    ['chown', 'RELEASE_INSTALL_CHOWN_FAILED'],
    ['chmod-dirs', 'RELEASE_INSTALL_CHMOD_DIRS_FAILED'],
    ['chmod-files', 'RELEASE_INSTALL_CHMOD_FILES_FAILED'],
    ['atomic-publish', 'RELEASE_INSTALL_ATOMIC_PUBLISH_FAILED'],
    ['existing-release-verify', 'RELEASE_INSTALL_EXISTING_RELEASE_VERIFY_FAILED']
  ]) {
    const evidence = path.join(dir, `${stage}.txt`);
    fs.writeFileSync(evidence,
      `RELEASE_INSTALL_STAGE=${stage}\nSURGERY_A_ABORT=release-install-${stage}\n`);
    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; classify_remote_controller_failure "$2"',
      'p1-classification-test', WRAPPER, evidence
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
});

test('P1-BRIDGE-09 Actions invokes only the installed wrapper and classifies failures', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow,
    /sudo -n \/usr\/local\/sbin\/stay-p1-production-controller '\$OPERATION' '\$RUN_ROOT' '\$AUTHORIZATION_ARGUMENT'/);
  assert.doesNotMatch(workflow, /sudo -n \/usr\/bin\/systemd-run/);
  assert.doesNotMatch(workflow, /Remove transient incoming bundle/);
  assert.match(workflow, /CONTROLLER_DISPATCH_STATUS/);
  assert.match(workflow, /CONTROLLER_FAILURE_CLASS/);
  assert.match(workflow, /RELEASE_INSTALL_STAGE/);
  assert.match(workflow, /RELEASE_INSTALL_ATOMIC_PUBLISH_FAILED/);
  assert.match(workflow, /CONTROLLER_SOURCE_IDENTITY=\$CONTROLLER_SOURCE_IDENTITY/);
  assert.match(workflow,
    /cd "\$BUNDLE"\n\s+sha256sum P1_ACTIONS_BUNDLE\.identity >> P1_ACTIONS_BUNDLE\.sha256/);
});
