'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const workflow = fs.readFileSync(
  path.join(ROOT, '.github/workflows/p1-production-hardening-r111f.yml'),
  'utf8'
);
const forward = fs.readFileSync(
  path.join(ROOT, 'deploy/live-physiology-transplant/p1-production-hardening-forward.sh'),
  'utf8'
);
const recovery = fs.readFileSync(
  path.join(ROOT, 'deploy/live-physiology-transplant/p1-production-hardening-forward-recovery.sh'),
  'utf8'
);
const controller = fs.readFileSync(
  path.join(ROOT, 'deploy/live-physiology-transplant/stay-p1-production-controller'),
  'utf8'
);
const installer = fs.readFileSync(
  path.join(ROOT, 'deploy/live-physiology-transplant/install-p1-production-controller.sh'),
  'utf8'
);
const bootstrap = fs.readFileSync(
  path.join(ROOT, '.github/workflows/p1-r111f-controller-bootstrap.yml'),
  'utf8'
);

test('R111F deployment is manual-only and pins the merged Git and immutable archive identities', () => {
  assert.match(workflow, /^\s{2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s{2}(push|pull_request|schedule):/m);
  assert.match(workflow, /RELEASE_TAG: r111f-v7/);
  assert.match(workflow, /RELEASE_COMMIT: 0a88ef1e593651eaa14463f8989a7f62c4f58f5b/);
  assert.match(workflow, /RELEASE_TREE: 561f025b7acb2b64690071459a7c9ef877d9b1f3/);
  assert.match(workflow, /ARCHIVE: STAY_P1_PRODUCTION_HARDENING_R110F_TO_R111F_V7_BUNDLE_20260827\.tar\.gz/);
  assert.match(workflow, /ARCHIVE_SHA256: 59d8c9f971189690a3ac51befe588a9eb6d8d1d88206cb406a8b2312b06bf01b/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
});

test('R111F deployment validates the archive, clean extraction, Git payload, syntax and focused regressions before secrets', () => {
  const validation = workflow.slice(
    workflow.indexOf('  validate-immutable-release:'),
    workflow.indexOf('  production-operation:')
  );
  assert.match(validation, /gh release download/);
  assert.match(validation, /sha256sum -c "\$ARCHIVE\.sha256"/);
  assert.match(validation, /\$entry" =~ \(\^\|\/\)\\\.\\\.\(\/\|\$\)/);
  assert.match(validation, /\$\{#entries\[@\]\} == 85/);
  assert.match(validation, /find "\$extract" -type f \| wc -l\)" == 71/);
  assert.match(validation, /wc -l < "\$extract\/\$manifest"\)" == 70/);
  assert.match(validation, /cmp "\$extract\/\$relative" "\$GITHUB_WORKSPACE\/\$relative"/);
  assert.match(validation, /node --check/);
  assert.match(validation, /production-hardening-entry-path\.test\.js/);
  assert.match(validation, /production-hardening\.test\.js/);
  assert.doesNotMatch(validation, /STAY_DEPLOY_KEY|secrets\./);
});

test('R111F live preflight is non-mutating and binds the exact R110F host state', () => {
  const livePreflight = workflow.slice(
    workflow.indexOf('      - name: Run mutation-free live preflight'),
    workflow.indexOf('      - name: Invoke bounded forward or recovery operation')
  );
  const staleCleanup = workflow.slice(
    workflow.indexOf('      - name: Remove exact failed read-only stage'),
    workflow.indexOf('      - name: Stage and independently verify immutable release')
  );
  assert.match(workflow, /PRODUCTION_PRIVATE_IPV4: 172\.26\.9\.207/);
  assert.match(workflow, /SOURCE_RELEASE: \/opt\/stay\/releases\/0\.8\.11\.3-p1i-i4g-deadline-3f4580ae943e/);
  assert.match(workflow, /v\.ok!==true\|\|v\.revision!==110/);
  assert.match(workflow, /--candidate-inspection-only/);
  assert.match(workflow, /STAY_REQUIRE_OS_CORE_SANDBOX=1/);
  assert.match(workflow, /STAY_REQUIRE_CGROUPS=0/);
  assert.match(workflow, /R111F_LIVE_PREFLIGHT=PASS/);
  assert.match(workflow, /SERVICE_OPERATION=NO/);
  assert.match(workflow, /CURRENT_POINTER_CHANGE=NO/);
  assert.match(workflow, /AUTHORITY_CHANGE=NO/);
  assert.match(livePreflight, /ServerAliveInterval=30/);
  assert.match(livePreflight, /ServerAliveCountMax=3/);
  assert.match(workflow, /FAILED_READ_ONLY_STAGE: \/opt\/stay\/incoming\/r111f-v6-33097105865/);
  assert.match(workflow, /FAILED_READ_ONLY_ARCHIVE: STAY_P1_PRODUCTION_HARDENING_R110F_TO_R111F_V6_BUNDLE_20260827\.tar\.gz/);
  assert.match(workflow, /FAILED_READ_ONLY_ARCHIVE_SHA256: f1e668a63caca869c212a0e4d178d8e9829985fb29e77869a67a74b84c5634e3/);
  assert.match(staleCleanup, /"\$FAILED_READ_ONLY_STAGE" "\$FAILED_READ_ONLY_ARCHIVE" "\$FAILED_READ_ONLY_ARCHIVE_SHA256"/);
  assert.ok(staleCleanup.indexOf('172.26.9.207') < staleCleanup.indexOf('rm -rf'));
  assert.match(staleCleanup, /sha256sum "\$root\/\$archive"/);
  assert.match(staleCleanup, /FAILED_READ_ONLY_STAGE=CLEANED/);
  assert.match(workflow, /FAILED_AUTHORITY_STAGE: \/opt\/stay\/incoming\/r111f-v7-33103827764/);
  assert.match(workflow, /FAILED_AUTHORITY_ARCHIVE_SHA256: 59d8c9f971189690a3ac51befe588a9eb6d8d1d88206cb406a8b2312b06bf01b/);
  assert.match(staleCleanup, /FAILED_AUTHORITY_STAGE=CLEANED/);
  assert.match(staleCleanup, /48530ec7f678519e58a576a29242177e89636e80124b270ab1d95ce17fcff9c7/);
  assert.match(staleCleanup, /! -user staydeploy/);
});

test('R111F mutation requires exact authorization, bounded root execution and forward-only recovery', () => {
  assert.match(workflow, /AUTHORIZE_R111F_V7_READ_ONLY_PREFLIGHT/);
  assert.match(workflow, /AUTHORIZE_R111F_V7_FORWARD_WITH_FENCED_RECOVERY/);
  assert.match(workflow, /AUTHORIZE_R111F_V7_FORWARD_RECOVERY_ONLY/);
  assert.match(controller, /HARDEN_R110F_EXACTLY_ONCE_RECOVER_AND_BENCHMARK_72H/);
  assert.match(controller, /FORWARD_RECOVER_R111_AND_COMPLETE_FREEZE_BENCHMARK/);
  assert.match(forward, /'HARDEN_R110F_EXACTLY_ONCE_RECOVER_AND_BENCHMARK_72H'/);
  assert.match(recovery, /'FORWARD_RECOVER_R111_AND_COMPLETE_FREEZE_BENCHMARK'/);
  assert.match(workflow,
    /sudo -n \/usr\/local\/sbin\/stay-p1-production-controller '\$controller_operation' '\$RUN_ROOT' '\$REQUESTED_AUTHORIZATION'/);
  assert.doesNotMatch(workflow, /sudo -n \/usr\/bin\/systemd-run/);
  assert.match(controller, /harden-r111f\)/);
  assert.match(controller, /recover-r111f\)/);
  assert.match(controller, /R111F_FORWARD_RUNTIME_SECONDS=1500/);
  assert.match(controller, /R111F_RECOVERY_RUNTIME_SECONDS=900/);
  assert.match(controller, /\/usr\/bin\/timeout/);
  assert.match(controller, /--kill-after=30s/);
  assert.match(controller, /p1-production-hardening-forward\.sh/);
  assert.match(controller, /p1-production-hardening-forward-recovery\.sh/);
  assert.match(controller, /P1_PRODUCTION_HARDENING_FORWARD_POST_RESTART=LEFT_RUNNING_FOR_FORWARD_RECOVERY/);
  assert.match(controller, /R111F_CONTROLLER_RECOVERY=AUTOMATIC/);
  assert.match(controller, /R111F_CONTROLLER_RESULT=PASS/);
  assert.match(controller, /EXPECTED_R111F_ARCHIVE_SHA256="59d8c9f971189690a3ac51befe588a9eb6d8d1d88206cb406a8b2312b06bf01b"/);
  assert.match(controller, /EXPECTED_R111F_MANIFEST_SHA256="48530ec7f678519e58a576a29242177e89636e80124b270ab1d95ce17fcff9c7"/);
  assert.match(controller, /\^r111f-v7-\[0-9\]\+\$/);
  assert.match(controller, /! -user staydeploy/);
  assert.match(controller, /prepare_r111f_private_release/);
  assert.match(controller, /install -o root -g root -m 0400 "\$source_archive" "\$private_archive"/);
  assert.match(controller, /verify_hash "\$private_archive" "\$EXPECTED_R111F_ARCHIVE_SHA256"/);
  assert.match(controller, /controller_script="\$R111F_WORK_ROOT\/release/);
  assert.match(controller, /safe_cleanup_r111f_work_root/);
  assert.doesNotMatch(workflow, /ssh[^\n]*root@|scp[^\n]*:\/opt\/stay\/current/);
});

test('R111F completion proves the frozen revision and active benchmark before bounded cleanup', () => {
  assert.match(workflow, /h\.revision!==111/);
  assert.match(workflow, /m\.revisionFrozen!==true/);
  assert.match(workflow, /m\.revisionLabel!=="R111F"/);
  assert.match(workflow, /stay-p1-physiology-benchmark\.service/);
  assert.match(workflow, /BSF_SNTSS_CHRONOBIOLOGY_CONTINUITY=PASS/);
  assert.match(workflow, /PHYSIOLOGY_AUTHORITY_CONTAINMENT=PASS/);
  assert.match(workflow, /PRAGMA quick_check/);
  assert.match(workflow, /R111F_LIVE_RESULT=PASS/);
  assert.match(workflow, /\^\/opt\/stay\/incoming\/r111f-v7-\[0-9\]\+\$/);
  assert.match(workflow, /rm -rf --one-file-system -- "\$root"/);
  assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
});

test('R111F controller bootstrap is source-sealed and preserves the narrow sudo boundary', () => {
  assert.match(bootstrap, /^\s{2}workflow_dispatch:/m);
  assert.doesNotMatch(bootstrap, /^\s{2}(push|pull_request|schedule):/m);
  assert.match(bootstrap, /AUTHORIZE_R111F_V8_PINNED_CONTROLLER_BOOTSTRAP/);
  assert.match(bootstrap, /WRAPPER_SHA256: 7eb9470a50108a3de9070c6f3d4e454ce74f9da88e6aa2b6d2248d3fb9707335/);
  assert.match(bootstrap, /INSTALLER_SHA256: 8f2178b51097c1209ae9d96ea215fd9185634f1a82173a843c072013172303ea/);
  assert.match(installer, /EXPECTED_WRAPPER_SHA256="7eb9470a50108a3de9070c6f3d4e454ce74f9da88e6aa2b6d2248d3fb9707335"/);
  const secretFree = bootstrap.slice(
    bootstrap.indexOf('  validate-and-seal:'),
    bootstrap.indexOf('  stage-and-await-root-bridge:')
  );
  assert.doesNotMatch(secretFree, /STAY_DEPLOY_KEY|secrets\./);
  assert.match(bootstrap, /\^\/opt\/stay\/incoming\/r111f-controller-v8-\[0-9\]\+\$/);
  assert.match(bootstrap, /private=\\\$\(mktemp -d \/run\/stay-r111f-v8-bootstrap\.XXXXXX\)/);
  assert.match(bootstrap, /install -o root -g root -m 0555/);
  assert.match(bootstrap, /P1_R111F_V8_CONTROLLER_BOOTSTRAP\.sha256/);
  assert.match(bootstrap, /FAILED_BOOTSTRAP_STAGE: \/opt\/stay\/incoming\/r111f-controller-v8-33108449678/);
  assert.match(bootstrap, /FAILED_BOOTSTRAP_STAGE=CLEANED/);
  assert.match(bootstrap, /stat -Lc '%U:%G:%a' "\$root"/);
  assert.doesNotMatch(bootstrap, /staydeploy:staydeploy:700:1/);
  assert.match(bootstrap, /R111F_V8_CONTROLLER_BOOTSTRAP=PASS/);
  assert.match(bootstrap, /SUDOERS_SCOPE=STAYDEPLOY_TO_PINNED_P1_CONTROLLER_ONLY/);
  assert.doesNotMatch(bootstrap, /sudo -n \/usr\/bin\/systemd-run/);
  const sudoers = installer.match(/<<'SUDOERS'\n([\s\S]*?)\nSUDOERS/);
  assert.ok(sudoers);
  assert.equal(sudoers[1].trim().split('\n').at(-1),
    'staydeploy ALL=(root) NOPASSWD: /usr/local/sbin/stay-p1-production-controller');
});
