'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const wrapper = read('deploy/live-physiology-transplant/stay-p1-production-controller');
const installer = read('deploy/live-physiology-transplant/install-p1-production-controller.sh');
const workflow = read('.github/workflows/p1-production-hardening-r111f.yml');

test('P1-BRIDGE-R116F-01 controller accepts only fixed forward and recovery operations', () => {
  const dispatch = wrapper.slice(
    wrapper.indexOf('  case "$operation" in'),
    wrapper.indexOf('  esac', wrapper.indexOf('  case "$operation" in'))
  );
  assert.match(dispatch, /harden-r116f\)/);
  assert.match(dispatch, /recover-r116f\)/);
  assert.match(dispatch, /\*\) abort_controller 76 "OPERATION_REJECTED"/);
  assert.doesNotMatch(dispatch, /preflight|surgery|rollback|attach|detach|shell/);
});

test('P1-BRIDGE-R116F-02 authorizations are exact, distinct and not inherited', () => {
  const forward = 'AUTHORIZE_R116F_V15_CONTAINED_FORWARD_WITH_FENCED_RECOVERY';
  const recovery = 'AUTHORIZE_R116F_V15_FORWARD_RECOVERY_ONLY';
  assert.notEqual(forward, recovery);
  assert.match(wrapper, new RegExp(forward));
  assert.match(wrapper, new RegExp(recovery));
  assert.match(wrapper, /env -i PATH="\$PATH"/);
  assert.match(installer, /Defaults!\/usr\/local\/sbin\/stay-p1-production-controller !setenv/);
});

test('P1-BRIDGE-R116F-03 sudoers grants only the installed root-owned controller', () => {
  const heredoc = installer.match(/<<'SUDOERS'\n([\s\S]*?)\nSUDOERS/);
  assert.ok(heredoc);
  assert.match(heredoc[1],
    /^staydeploy ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/stay-p1-production-controller$/m);
  assert.doesNotMatch(heredoc[1],
    /systemd-run|\/bin\/(?:ba)?sh|\bnode\b|\brm\b|\bcp\b|\bmv\b|systemctl|ALL\s*$/m);
  assert.match(installer, /install -o root -g root -m 0555/);
  assert.match(installer, /R116F_FORWARD_AUTHORIZED=NO/);
  assert.match(installer, /R116F_RECOVERY_AUTHORIZED=NO/);
});

test('P1-BRIDGE-R116F-04 controller pins host, release, archive, manifest and scripts', () => {
  assert.match(wrapper, /EXPECTED_PRIVATE_IPV4="172\.26\.9\.207"/);
  assert.match(wrapper, /EXPECTED_R116F_RELEASE_TAG="r116f-v14"/);
  assert.match(wrapper, /EXPECTED_R116F_RELEASE_COMMIT="[0-9a-f]{40}"/);
  assert.match(wrapper, /EXPECTED_R116F_RELEASE_TREE="[0-9a-f]{40}"/);
  assert.match(wrapper, /EXPECTED_R116F_ARCHIVE_SHA256="[0-9a-f]{64}"/);
  assert.match(wrapper, /EXPECTED_R116F_MANIFEST_SHA256="[0-9a-f]{64}"/);
  assert.match(wrapper, /EXPECTED_R116F_FORWARD_SHA256="[0-9a-f]{64}"/);
  assert.match(wrapper, /EXPECTED_R116F_RECOVERY_SHA256="[0-9a-f]{64}"/);
  assert.match(wrapper, /verify_r116f_staged_identity/);
  assert.match(wrapper, /verify_r116f_release_tree/);
});

test('P1-BRIDGE-R116F-05 paths, ownership and archive types fail closed', () => {
  assert.match(wrapper, /\^r116f-v14-\[0-9\]\+\$/);
  assert.match(wrapper, /staydeploy:staydeploy/);
  assert.match(wrapper, /root:root:700/);
  assert.match(wrapper, /find -P "\$root" -xdev/);
  assert.match(wrapper, /-type l -o -type f -links \+1 -o ! -type d ! -type f/);
  assert.match(wrapper, /findmnt -rn -R -o TARGET/);
  assert.match(wrapper, /rm -rf --one-file-system -- "\$candidate"/);
  assert.match(wrapper, /"\$entry" != \/*/);
  assert.match(wrapper, /\(\^\|\/\)\\\.\\\.\(\/\|\$\)/);
});

test('P1-BRIDGE-R116F-06 privileged execution uses sanitized paths and trusted root files', () => {
  assert.match(wrapper, /PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/);
  assert.match(wrapper, /stat -Lc '%U:%G'/);
  assert.match(wrapper, /8#022/);
  assert.match(wrapper, /trusted_root_file "\$script"/);
  assert.match(wrapper, /trusted_root_executable \/usr\/bin\/timeout/);
  assert.match(wrapper, /trusted_root_executable \/bin\/bash/);
  assert.match(wrapper, /\/usr\/bin\/timeout --signal=TERM --kill-after=30s/);
});

test('P1-BRIDGE-R116F-07 failure cleanup is exact and reports classification', () => {
  assert.match(wrapper, /trap finish_controller EXIT/);
  assert.match(wrapper, /CLEANUP_ARMED=1/);
  assert.match(wrapper, /safe_cleanup_r116f_work_root/);
  assert.match(wrapper, /safe_cleanup_r116f_run_root/);
  assert.match(wrapper, /CONTROLLER_DISPATCH_STATUS=/);
  assert.match(wrapper, /CONTROLLER_FAILURE_CLASS=/);
  assert.match(wrapper, /CONTROLLER_CLEANUP_STATUS=/);
  assert.match(wrapper, /CONTROLLER_CLEANUP_FAILED/);
});

test('P1-BRIDGE-R116F-08 Actions invokes only the installed wrapper', () => {
  assert.match(workflow,
    /sudo -n \/usr\/local\/sbin\/stay-p1-production-controller '\$controller_operation' '\$RUN_ROOT' '\$REQUESTED_AUTHORIZATION'/);
  assert.doesNotMatch(workflow, /sudo -n \/usr\/bin\/systemd-run/);
  assert.doesNotMatch(workflow, /ssh[^\n]*root@/);
  assert.match(workflow, /CONTROLLER_DISPATCH_STATUS=0/);
  assert.match(workflow, /CONTROLLER_FAILURE_CLASS=NONE/);
  assert.match(workflow, /CONTROLLER_CLEANUP_STATUS=PASS/);
});
