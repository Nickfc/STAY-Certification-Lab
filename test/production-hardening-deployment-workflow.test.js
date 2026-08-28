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
const liveProof = fs.readFileSync(
  path.join(ROOT, 'deploy/live-physiology-transplant/p1-production-hardening-live-proof.js'),
  'utf8'
);
const freeze = fs.readFileSync(
  path.join(ROOT, 'deploy/live-physiology-transplant/p1-production-hardening-freeze.js'),
  'utf8'
);
const preflight = fs.readFileSync(
  path.join(ROOT, 'deploy/live-physiology-transplant/p1-production-hardening-preflight.js'),
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

test('R114F deployment is manual-only and pins the immutable Git and archive identities', () => {
  assert.match(workflow, /^\s{2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s{2}(push|pull_request|schedule):/m);
  assert.match(workflow, /RELEASE_TAG: r114f-v12/);
  assert.match(workflow, /RELEASE_COMMIT: 101bac700e6498ef9021f8e61ba0c1e66411d4fd/);
  assert.match(workflow, /RELEASE_TREE: 97d94e09be6c78b72f26a888818a228076244fe0/);
  assert.match(workflow, /ARCHIVE: STAY_P1_PRODUCTION_HARDENING_R112_TO_R114F_V12_BUNDLE_20260828\.tar\.gz/);
  assert.match(workflow, /ARCHIVE_SHA256: e20a48594be06ad8ff8336410ea0bf9cf65af5777b9f560f0fb2c538d0b0365f/);
  assert.match(workflow, /TARGET_RELEASE: \/opt\/stay\/releases\/0\.8\.11\.3-p1k-r112-repair-0aa05cea80aa/);
  assert.match(workflow, /PRODUCTION_SSH_ED25519_KEY: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBvxednOQ0VcQL1KR0MewyXFCqufbwWsg0Lkgg\/MwMUS/);
  assert.match(workflow, /PRODUCTION_SSH_ED25519_FINGERPRINT: SHA256:z0aBq4eHfQpARjsa7pfpL2spIVi62lqwx54mlm9XU8Q/);
  assert.match(workflow, /printf '%s %s\\n' "\$PRODUCTION_PUBLIC_IPV4" "\$PRODUCTION_SSH_ED25519_KEY" > ~\/\.ssh\/known_hosts/);
  assert.match(workflow, /ssh-keygen -lf ~\/\.ssh\/known_hosts/);
  assert.doesNotMatch(workflow, /StrictHostKeyChecking=accept-new/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
});

test('R114F deployment validates the archive, clean extraction, Git payload, syntax and focused regressions before secrets', () => {
  const validation = workflow.slice(
    workflow.indexOf('  validate-immutable-release:'),
    workflow.indexOf('  production-operation:')
  );
  assert.match(validation, /gh release download/);
  assert.match(validation, /sha256sum -c "\$ARCHIVE\.sha256"/);
  assert.match(validation, /\$entry" =~ \(\^\|\/\)\\\.\\\.\(\/\|\$\)/);
  assert.match(validation, /\$\{#entries\[@\]\} == 100/);
  assert.match(validation, /find "\$extract" -type f \| wc -l\)" == 85/);
  assert.match(validation, /wc -l < "\$extract\/\$manifest"\)" == 84/);
  assert.match(validation, /cmp "\$extract\/\$relative" "\$GITHUB_WORKSPACE\/\$relative"/);
  assert.match(validation, /node --check/);
  assert.match(validation, /production-hardening-entry-path\.test\.js/);
  assert.match(validation, /production-hardening\.test\.js/);
  assert.doesNotMatch(validation, /STAY_DEPLOY_KEY|secrets\./);
});

test('R114F live preflight is non-mutating and binds the exact contained R112 host state', () => {
  const livePreflight = workflow.slice(
    workflow.indexOf('      - name: Run mutation-free live preflight'),
    workflow.indexOf('      - name: Invoke bounded forward or recovery operation')
  );
  const staleCleanup = workflow.slice(
    workflow.indexOf('      - name: Remove exact failed read-only stage'),
    workflow.indexOf('      - name: Stage and independently verify immutable release')
  );
  assert.match(workflow, /PRODUCTION_PRIVATE_IPV4: 172\.26\.9\.207/);
  assert.match(workflow, /SOURCE_RELEASE: \/opt\/stay\/releases\/0\.8\.11\.3-p1j-production-hardening-6a04981799aa/);
  assert.match(workflow, /v\.ok!==true\|\|v\.revision!==112/);
  assert.match(workflow, /--candidate-inspection-only/);
  assert.match(workflow, /STAY_REQUIRE_OS_CORE_SANDBOX=1/);
  assert.match(workflow, /STAY_REQUIRE_CGROUPS=0/);
  assert.match(workflow, /STAY_PRODUCTION_HARDENING_TARGET_REVISION=114/);
  assert.match(workflow, /R114F_LIVE_PREFLIGHT=PASS/);
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
  assert.match(workflow, /FAILED_V7_FORWARD_STAGE: \/opt\/stay\/incoming\/r111f-v7-33114548848/);
  assert.match(workflow, /FAILED_V7_FORWARD_ARCHIVE_SHA256: 59d8c9f971189690a3ac51befe588a9eb6d8d1d88206cb406a8b2312b06bf01b/);
  assert.match(staleCleanup, /FAILED_V7_FORWARD_STAGE=CLEANED/);
  assert.match(staleCleanup, /48530ec7f678519e58a576a29242177e89636e80124b270ab1d95ce17fcff9c7/);
  assert.match(workflow, /FAILED_V8_IDENTITY_STAGE: \/opt\/stay\/incoming\/r111f-v8-33119878249/);
  assert.match(workflow, /FAILED_V8_IDENTITY_ARCHIVE_SHA256: 381be48f4bc037b2066d2bfdf8e4369c60e194a9e3e934e775e5a290e5f65586/);
  assert.match(workflow, /FAILED_V8_IDENTITY_MANIFEST_SHA256: 2371e103c15cab60073218606de20f3b8f7db7c2eeac52c24cd9545371100d0e/);
  assert.match(staleCleanup, /FAILED_V8_IDENTITY_STAGE=CLEANED/);
  assert.match(workflow, /FAILED_V9_PREFLIGHT_STAGE: \/opt\/stay\/incoming\/r114f-v9-33132185185/);
  assert.match(workflow, /FAILED_V9_PREFLIGHT_ARCHIVE_SHA256: 759be82dbd12ee93258d033e1a7a36667d21b50c793463d82d38b42db3d739d5/);
  assert.match(workflow, /FAILED_V9_PREFLIGHT_MANIFEST_SHA256: b8329ca509b47529ae62b07e3f2ab4108ebf70ec2b559341a6c5dc86bac41aaa/);
  assert.match(staleCleanup, /FAILED_V9_PREFLIGHT_STAGE=CLEANED/);
  assert.match(workflow, /FAILED_V11_CANDIDATE_STAGE: \/opt\/stay\/incoming\/r114f-v11-33136236907/);
  assert.match(workflow, /FAILED_V11_CANDIDATE_ARCHIVE_SHA256: 39bef53eb7c424da6eb6c039203ee8bfb79ad4c37d6bc6ac09b011c8aa6550de/);
  assert.match(workflow, /FAILED_V11_CANDIDATE_MANIFEST_SHA256: d0b419e0cd24cf56112294e00d9132d875570d395d121bb711bccd8eff365063/);
  assert.match(staleCleanup, /FAILED_V11_CANDIDATE_STAGE=CLEANED/);
  assert.match(staleCleanup, /! -user staydeploy/);
});

test('R114F contained repair remains anchored to the exact completed R110F failure ledger', () => {
  for (const digest of [
    '1fbf5e7b854204278a7ee7967dfc0c9016d1eeb5b281eb7a5289fd66d3b88007',
    '67551f663c79efb6d106ca4f6e9c16557917d24b64bbe2b2592f27820065b504',
    'a215023bac35f1c12b8ba9b8021b7ebc16e131f153623a48a0a3c891814fd61a',
    '53cbbffc750534c5e5aadc056845f31bf88afc4f850cd1e23800371a8bdd5237'
  ]) {
    assert.match(liveProof, new RegExp(digest));
    assert.match(freeze, new RegExp(digest));
  }
  assert.match(forward, /benchmark_active_state" == inactive/);
  assert.match(forward, /benchmark_sub_state" == dead/);
  assert.match(forward, /benchmark_result" == success/);
  assert.match(forward, /benchmark_exec_code" == 1/);
  assert.match(forward, /benchmark_exec_status" == 0/);
  assert.match(forward, /benchmark_unit_state" == enabled/);
  assert.match(forward, /benchmark_exit_mono" -gt "\$benchmark_start_mono"/);
  assert.match(forward, /r110-benchmark-terminal-state-invalid/);
  assert.doesNotMatch(forward, /systemctl stop stay-p1-physiology-benchmark\.service/);
  assert.match(liveProof, /stay-physiology-benchmark-closure-v4/);
  assert.match(liveProof, /evidence\.result === 'OBSERVED_FAILURES'/);
  assert.match(liveProof, /sntss\?\.status === 'RESYNC_REQUIRED'/);
  assert.match(liveProof, /sntss\?\.authorityOwned === false/);
  assert.match(liveProof, /Number\(sntss\?\.observedOutputs\) === 0/);
  assert.match(liveProof, /Number\(state\.samples\) === Number\(sampleLedgerRecords\)/);
});

test('R114F repair is fenced to the exact contained R112 failure state and one R113 cold boot', () => {
  assert.match(forward, /SOURCE_RELEASE='\/opt\/stay\/releases\/0\.8\.11\.3-p1j-production-hardening-6a04981799aa'/);
  assert.match(forward, /FAILED-R111-20260827T225532Z\.PQqgvJ/);
  assert.match(forward, /FAILED-R111-RECOVERY-20260827T230134Z\.yj5Jz9/);
  assert.match(forward, /1c6785982bb0e8e73d0eac474c6d793417be2b5d5951e0d5e1d074838aea1155/);
  assert.match(forward, /cb225e46fe6be038ba9b448ce44649b18ab23d9f41cbf72369ab5208664cb506/);
  assert.match(forward, /'REPAIR_CONTAINED_R112_TO_R114F_AND_BENCHMARK_72H'/);
  assert.match(forward, /revision\)" == 112/);
  assert.match(forward, /revisionLabel\)" == R112/);
  assert.match(forward, /Environment=STAY_RECOVER_COLD_RESIDENTS_AT_REVISION=113/);
  assert.match(forward, /systemctl restart stay\.service/);
  assert.match(forward, /revision 2>\/dev\/null \|\| true\)" == 114/);
  assert.match(forward, /TARGET_REVISION=R114F/);
  assert.match(forward, /STAY_PRODUCTION_HARDENING_TARGET_REVISION=114/);
  assert.match(preflight, /supervisorRssBytes < 64 \* MIB/);
  assert.match(preflight, /Number\(memoryPlan\?\.supervisorOldSpaceMiB\) === 12/);
  assert.match(preflight, /Number\(memoryPlan\?\.supervisorSemiSpaceMiB\) === 1/);
  assert.match(freeze, /Number\(preflight\?\.targetRevision\) === REVISION/);
  assert.match(liveProof, /database\.runtimeRevision === 112/);
  assert.match(liveProof, /database\.runtimeRevision === 114/);
  assert.match(liveProof, /sntssResync\?\.detail\?\.runtimeRevision === 113/);
  assert.match(liveProof, /chronobiologyResync\?\.detail\?\.runtimeRevision === 113/);
  assert.match(liveProof, /database\.pendingDeliveries <= 32/);
  assert.match(freeze, /Number\(recovery\.serviceRestarts\) >= 1/);
  assert.match(freeze, /recovery\?\.payloadLimitsChanged === false/);
  assert.match(freeze, /recovery\?\.deadlinesChanged === false/);
  assert.match(freeze, /recovery\?\.authorityChanged === false/);
});

test('R114F recovery retries only when no revision committed and otherwise refuses advancement', () => {
  assert.match(recovery, /'FORWARD_RECOVER_R114_AND_COMPLETE_FREEZE_BENCHMARK'/);
  assert.match(recovery, /durable_revision" == 114/);
  assert.match(recovery, /r114-generation-not-live-restart-would-advance-revision/);
  assert.match(recovery, /R114_RUNNING_GENERATION_PROVED_NO_RESTART/);
  assert.match(recovery, /durable_revision" == 112/);
  assert.match(recovery, /FIRST_START_COMMITTED_NO_REVISION_SAFE_R113_RETRY/);
  assert.match(recovery, /systemctl restart stay\.service/);
  assert.match(recovery, /recovery_restarts=2/);
  assert.match(recovery, /revisionLabel\)" == R114F/);
});

test('R114F V12 mutation controller remains exact, bounded and forward-only', () => {
  assert.match(workflow, /AUTHORIZE_R114F_V12_READ_ONLY_PREFLIGHT/);
  assert.match(workflow, /AUTHORIZE_R114F_V12_CONTAINED_FORWARD_WITH_FENCED_RECOVERY/);
  assert.match(workflow, /AUTHORIZE_R114F_V12_FORWARD_RECOVERY_ONLY/);
  assert.match(controller, /REPAIR_CONTAINED_R112_TO_R114F_AND_BENCHMARK_72H/);
  assert.match(controller, /FORWARD_RECOVER_R114_AND_COMPLETE_FREEZE_BENCHMARK/);
  assert.match(workflow,
    /sudo -n \/usr\/local\/sbin\/stay-p1-production-controller '\$controller_operation' '\$RUN_ROOT' '\$REQUESTED_AUTHORIZATION'/);
  assert.doesNotMatch(workflow, /sudo -n \/usr\/bin\/systemd-run/);
  assert.match(controller, /harden-r114f\)/);
  assert.match(controller, /recover-r114f\)/);
  assert.match(controller, /R114F_FORWARD_RUNTIME_SECONDS=1500/);
  assert.match(controller, /R114F_RECOVERY_RUNTIME_SECONDS=900/);
  assert.match(controller, /\/usr\/bin\/timeout/);
  assert.match(controller, /--kill-after=30s/);
  assert.match(controller, /p1-production-hardening-forward\.sh/);
  assert.match(controller, /p1-production-hardening-forward-recovery\.sh/);
  assert.match(controller, /P1_PRODUCTION_HARDENING_FORWARD_POST_RESTART=LEFT_RUNNING_FOR_FORWARD_RECOVERY/);
  assert.match(controller, /R114F_CONTROLLER_RECOVERY=AUTOMATIC/);
  assert.match(controller, /R114F_CONTROLLER_RESULT=PASS/);
  assert.match(controller, /EXPECTED_R114F_ARCHIVE_SHA256="e20a48594be06ad8ff8336410ea0bf9cf65af5777b9f560f0fb2c538d0b0365f"/);
  assert.match(controller,
    /"\$\(<"\$sidecar"\)" == "\$EXPECTED_R114F_ARCHIVE_SHA256 \*\$EXPECTED_R114F_ARCHIVE"/);
  assert.doesNotMatch(controller,
    /"\$\(<"\$sidecar"\)" == "\$EXPECTED_R114F_ARCHIVE_SHA256  \$EXPECTED_R114F_ARCHIVE"/);
  assert.match(controller, /EXPECTED_R114F_MANIFEST_SHA256="cb4f777e57f636b0894e0dd816a004fc2713da47b691cebdb681c1839e9bc396"/);
  assert.match(controller, /EXPECTED_R114F_FORWARD_SHA256="685fd0d48579b24b09278b0ff537a4c9ab574e2f94d9c564439c40b6766946d2"/);
  assert.match(controller, /"\$\{#entries\[@\]\}" -eq 100/);
  assert.match(controller, /type f \| wc -l\)" -eq 85/);
  assert.match(controller, /wc -l < "\$manifest"\)" -eq 84/);
  assert.match(controller, /NR != 84/);
  assert.match(controller, /\^r114f-v12-\[0-9\]\+\$/);
  assert.match(controller, /! -user staydeploy/);
  assert.match(controller, /prepare_r114f_private_release/);
  assert.match(controller, /install -o root -g root -m 0400 "\$source_archive" "\$private_archive"/);
  assert.match(controller, /verify_hash "\$private_archive" "\$EXPECTED_R114F_ARCHIVE_SHA256"/);
  assert.match(controller, /controller_script="\$R114F_WORK_ROOT\/release/);
  assert.match(controller, /safe_cleanup_r114f_work_root/);
  assert.doesNotMatch(workflow, /ssh[^\n]*root@|scp[^\n]*:\/opt\/stay\/current/);
});

test('R114F completion proves the frozen revision and active benchmark before bounded cleanup', () => {
  assert.match(workflow, /h\.revision!==114/);
  assert.match(workflow, /m\.revisionFrozen!==true/);
  assert.match(workflow, /m\.revisionLabel!=="R114F"/);
  assert.match(workflow, /stay-p1-physiology-benchmark\.service/);
  assert.match(workflow, /BSF_SNTSS_CHRONOBIOLOGY_CONTINUITY=PASS/);
  assert.match(workflow, /PHYSIOLOGY_AUTHORITY_CONTAINMENT=PASS/);
  assert.match(workflow, /FETUS_CONTINUITY=PASS/);
  assert.match(workflow, /PRAGMA quick_check/);
  assert.match(workflow, /R114F_LIVE_RESULT=PASS/);
  assert.match(workflow, /"\$current" == "\$target_release"/);
  assert.match(workflow, /\^\/opt\/stay\/incoming\/r114f-v12-\[0-9\]\+\$/);
  assert.match(workflow, /rm -rf --one-file-system -- "\$root"/);
  assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
});

test('R114F V13 controller bootstrap is source-sealed and preserves the narrow sudo boundary', () => {
  assert.match(bootstrap, /^\s{2}workflow_dispatch:/m);
  assert.doesNotMatch(bootstrap, /^\s{2}(push|pull_request|schedule):/m);
  assert.match(bootstrap, /AUTHORIZE_R114F_V13_PINNED_CONTROLLER_BOOTSTRAP/);
  assert.match(bootstrap, /WRAPPER_SHA256: 99537254da2b48551b797478eb5e01bb6dc113e8f901505818031e697a9b43a0/);
  assert.match(bootstrap, /INSTALLER_SHA256: 06c29ec9e005fc13e7792c040dca2b384042050a04cf8dfdaa36109607a4c26c/);
  assert.match(bootstrap, /PRODUCTION_SSH_ED25519_FINGERPRINT: SHA256:z0aBq4eHfQpARjsa7pfpL2spIVi62lqwx54mlm9XU8Q/);
  assert.match(bootstrap, /ssh-keygen -lf ~\/\.ssh\/known_hosts/);
  assert.doesNotMatch(bootstrap, /StrictHostKeyChecking=accept-new/);
  assert.match(installer, /EXPECTED_WRAPPER_SHA256="99537254da2b48551b797478eb5e01bb6dc113e8f901505818031e697a9b43a0"/);
  const secretFree = bootstrap.slice(
    bootstrap.indexOf('  validate-and-seal:'),
    bootstrap.indexOf('  stage-and-await-root-bridge:')
  );
  assert.doesNotMatch(secretFree, /STAY_DEPLOY_KEY|secrets\./);
  assert.match(bootstrap, /\^\/opt\/stay\/incoming\/r114f-controller-v13-\[0-9\]\+\$/);
  assert.match(bootstrap, /private=\\\$\(mktemp -d \/run\/stay-r114f-v13-bootstrap\.XXXXXX\)/);
  assert.match(bootstrap, /install -o root -g root -m 0555/);
  assert.match(bootstrap, /P1_R114F_V13_CONTROLLER_BOOTSTRAP\.sha256/);
  assert.match(bootstrap, /FAILED_BOOTSTRAP_STAGE: \/opt\/stay\/incoming\/r111f-controller-v8-33108449678/);
  assert.match(bootstrap, /FAILED_BOOTSTRAP_STAGE=CLEANED/);
  assert.match(bootstrap, /root_identity="\$\(stat -Lc '%U:%G' "\$root"\)"/);
  assert.match(bootstrap, /root_mode="\$\(stat -Lc '%a' "\$root"\)"/);
  assert.match(bootstrap, /"\$root_mode" == 700 \|\| "\$root_mode" == 2700/);
  assert.match(bootstrap, /FAILED_BOOTSTRAP_STAGE_MODE=/);
  assert.match(bootstrap, /R114F_V13_CONTROLLER_STAGE_MODE=/);
  assert.doesNotMatch(bootstrap, /staydeploy:staydeploy:700:1/);
  assert.match(bootstrap, /R114F_V13_CONTROLLER_BOOTSTRAP=PASS/);
  assert.match(bootstrap, /SUDOERS_SCOPE=STAYDEPLOY_TO_PINNED_P1_CONTROLLER_ONLY/);
  assert.doesNotMatch(bootstrap, /sudo -n \/usr\/bin\/systemd-run/);
  const sudoers = installer.match(/<<'SUDOERS'\n([\s\S]*?)\nSUDOERS/);
  assert.ok(sudoers);
  assert.equal(sudoers[1].trim().split('\n').at(-1),
    'staydeploy ALL=(root) NOPASSWD: /usr/local/sbin/stay-p1-production-controller');
});
