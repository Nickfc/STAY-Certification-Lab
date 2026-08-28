'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const workflow = read('.github/workflows/p1-production-hardening-r111f.yml');
const forward = read('deploy/live-physiology-transplant/p1-production-hardening-forward.sh');
const recovery = read('deploy/live-physiology-transplant/p1-production-hardening-forward-recovery.sh');
const liveProof = read('deploy/live-physiology-transplant/p1-production-hardening-live-proof.js');
const freeze = read('deploy/live-physiology-transplant/p1-production-hardening-freeze.js');
const preflight = read('deploy/live-physiology-transplant/p1-production-hardening-preflight.js');
const controller = read('deploy/live-physiology-transplant/stay-p1-production-controller');
const installer = read('deploy/live-physiology-transplant/install-p1-production-controller.sh');
const bootstrap = read('.github/workflows/p1-r111f-controller-bootstrap.yml');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

test('R116F deployment is manual-only and pins the immutable release identities', () => {
  assert.match(workflow, /^\s{2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s{2}(push|pull_request|schedule):/m);
  assert.match(workflow, /RELEASE_TAG: r116f-v14/);
  assert.match(workflow, /RELEASE_COMMIT: cbf047e3fb42acdb504119c8be6a102fa32c3860/);
  assert.match(workflow, /RELEASE_TREE: 54ed5645470b9aff7c44187247c79c555737bcd7/);
  assert.match(workflow,
    /ARCHIVE: STAY_P1_PRODUCTION_HARDENING_R114_TO_R116F_V14_BUNDLE_20260828\.tar\.gz/);
  assert.match(workflow,
    /ARCHIVE_SHA256: 8836a624c7fa65a9c82f2de163679b0eaa12b5bf864a72ca16326dda54247b0a/);
  assert.match(workflow,
    /MANIFEST_SHA256: 647ffe294b9a462ef4a3ff44e8303adf6e069fc122e4df7e0eed3976b4c5ee94/);
  assert.match(workflow,
    /TARGET_RELEASE: \/opt\/stay\/releases\/0\.8\.11\.3-p1l-r114-backlog-repair-cb26a2ae203f/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(workflow, /StrictHostKeyChecking=accept-new/);
});

test('R116F validation proves the hosted archive, inventory, syntax and real entry path before secrets', () => {
  const validation = workflow.slice(
    workflow.indexOf('  validate-immutable-release:'),
    workflow.indexOf('  production-operation:')
  );
  assert.match(validation, /gh release download/);
  assert.match(validation, /sha256sum -c "\$ARCHIVE\.sha256"/);
  assert.match(validation, /\$\{#entries\[@\]\} == 102/);
  assert.match(validation, /find -P "\$extract" -type f \| wc -l\)" == 87/);
  assert.match(validation, /wc -l < "\$extract\/\$manifest"\)" == 86/);
  assert.match(validation, /cmp "\$extract\/\$relative" "\$GITHUB_WORKSPACE\/\$relative"/);
  assert.match(validation, /node --check/);
  assert.match(validation, /bash -n/);
  assert.match(validation, /STAY_BWRAP=\/usr\/local\/bin\/stay-ci-bwrap/);
  assert.match(validation, /production-hardening-entry-path\.test\.js/);
  assert.match(validation, /production-hardening\.test\.js/);
  assert.doesNotMatch(validation, /STAY_DEPLOY_KEY|secrets\./);
});

test('R116F live preflight occurs before staging and is mutation-free', () => {
  const preflightStart = workflow.indexOf('      - name: Run mutation-free live preflight before any host staging');
  const stageStart = workflow.indexOf('      - name: Stage and independently verify immutable release');
  assert.ok(preflightStart > 0 && stageStart > preflightStart);
  const livePreflight = workflow.slice(preflightStart, stageStart);
  assert.match(livePreflight, /SOURCE_RELEASE/);
  assert.match(livePreflight, /revision\) === 114/);
  assert.match(livePreflight, /meta\.revisionFrozen === false/);
  assert.match(livePreflight, /meta\.revisionLabel === 'R114'/);
  assert.match(livePreflight, /PRAGMA quick_check/);
  assert.match(livePreflight, /0\.5\.0-i4g1/);
  assert.match(livePreflight, /status === 'QUARANTINED'/);
  assert.match(livePreflight, /pending >= 1 && pending <= 8192/);
  assert.match(workflow, /EXPECTED_CHRONOBIOLOGY_CHECKPOINT: 81bb366d99550dffc2e78c16c869bb7da20c70473636c3ee1e95b9d8bf8382ae/);
  assert.match(livePreflight, /sntssStatus\?\.instanceId === sntss\?\.instance_id/);
  assert.match(livePreflight, /fetusAuthority\?\.version === '0\.6\.0'/);
  assert.match(livePreflight, /payloadSoftBytes\) === 64 \* 1024 \* 1024/);
  assert.match(livePreflight, /supervisorOldSpaceMiB\) === 12/);
  assert.match(livePreflight, /R116F_LIVE_PREFLIGHT=PASS/);
  for (const marker of [
    'SERVICE_OPERATION=NO', 'CURRENT_POINTER_CHANGE=NO', 'STATESTORE_WRITE=NO',
    'RESIDENT_OPERATION=NO', 'AUTHORITY_CHANGE=NO'
  ]) assert.match(livePreflight, new RegExp(marker));
  assert.doesNotMatch(livePreflight,
    /systemctl\s+(?:restart|stop|start|enable|disable)|rm -rf|install -d|scp |\/opt\/stay\/incoming/);
});

test('R116F backlog repair is fenced to exact R114, one R115 cold boot and zero abandonment', () => {
  assert.match(forward,
    /SOURCE_RELEASE='\/opt\/stay\/releases\/0\.8\.11\.3-p1k-r112-repair-37b0c95c6b68'/);
  assert.match(forward, /'REPAIR_CONTAINED_R114_BACKLOG_TO_R116F_AND_BENCHMARK_72H'/);
  assert.match(forward, /revision\)" == 114/);
  assert.match(forward, /revisionLabel\)" == R114/);
  assert.match(forward, /Environment=STAY_RECOVER_COLD_RESIDENTS_AT_REVISION=115/);
  assert.match(forward, /systemctl restart stay\.service/);
  assert.match(forward, /durable_revision" == 114/);
  assert.match(forward, /PRE_DURABLE_ADVANCEMENT_POINTER_RESTORED/);
  assert.match(forward, /revision 2>\/dev\/null \|\| true\)" == 116/);
  assert.match(forward, /TARGET_REVISION=R116F/);
  assert.match(forward, /STAY_PRODUCTION_HARDENING_TARGET_REVISION=116/);
  assert.match(forward, /CHRONOBIOLOGY_PENDING_REPLAY=BOUNDED_ZERO_ABANDONMENT/);
  assert.match(forward, /CHRONOBIOLOGY_PENDING_REPLAY_MAXIMUM=8192/);
  assert.match(forward, /backlog-repair-before/);
  assert.match(forward, /backlog-repair-recovery/);
  assert.match(preflight, /supervisorRssBytes < 64 \* MIB/);
  assert.match(freeze, /recovery\?\.payloadLimitsChanged === false/);
  assert.match(liveProof, /Number\(begin\?\.detail\?\.abandonedCount\) === 0/);
  assert.match(liveProof, /complete\?\.detail\?\.inventedBiologicalTime === false/);
  assert.match(liveProof, /database\.pendingDeliveries <= 32/);
});

test('R116F recovery completes only the exact running generation without another restart', () => {
  assert.match(recovery, /'FORWARD_RECOVER_R116_AND_COMPLETE_FREEZE_BENCHMARK'/);
  assert.match(recovery, /durable_revision" == 116/);
  assert.match(recovery, /r116-generation-not-live-restart-forbidden/);
  assert.match(recovery, /R116_RUNNING_GENERATION_PROVED_NO_RESTART/);
  assert.match(recovery, /one-shot-dropin-identity-mismatch/);
  assert.doesNotMatch(recovery, /systemctl restart stay\.service/);
  assert.match(recovery, /revisionLabel\)" == R116F/);
});

test('V15 controller exposes only the two R116F operations and binds every release identity', () => {
  assert.match(controller, /harden-r116f\)/);
  assert.match(controller, /recover-r116f\)/);
  for (const operation of [
    'preflight-a1)', 'surgery-a1)', 'rollback-a1)', 'harden-r114f)', 'recover-r114f)',
    'complete-b0', 'sandbox-repair'
  ]) assert.doesNotMatch(controller, new RegExp(operation.replace(/[()]/g, '\\$&')));
  assert.match(controller, /AUTHORIZE_R116F_V15_CONTAINED_FORWARD_WITH_FENCED_RECOVERY/);
  assert.match(controller, /AUTHORIZE_R116F_V15_FORWARD_RECOVERY_ONLY/);
  assert.match(controller, /R116F_FORWARD_RUNTIME_SECONDS=1500/);
  assert.match(controller, /R116F_RECOVERY_RUNTIME_SECONDS=900/);
  assert.match(controller, /--kill-after=30s/);
  assert.match(controller,
    /EXPECTED_R116F_RELEASE_COMMIT="cbf047e3fb42acdb504119c8be6a102fa32c3860"/);
  assert.match(controller,
    /EXPECTED_R116F_RELEASE_TREE="54ed5645470b9aff7c44187247c79c555737bcd7"/);
  assert.match(controller,
    /EXPECTED_R116F_ARCHIVE_SHA256="8836a624c7fa65a9c82f2de163679b0eaa12b5bf864a72ca16326dda54247b0a"/);
  assert.match(controller, /"\$\{#entries\[@\]\}" -eq 102/);
  assert.match(controller, /type f \| wc -l\)" -eq 87/);
  assert.match(controller, /wc -l < "\$manifest"\)" -eq 86/);
  assert.match(controller, /\^r116f-v14-\[0-9\]\+\$/);
  assert.match(controller, /prepare_r116f_private_release/);
  assert.match(controller, /install -o root -g root -m 0400 "\$source_archive" "\$private_archive"/);
  assert.match(controller, /P1_PRODUCTION_HARDENING_FORWARD_POST_RESTART=LEFT_RUNNING_FOR_FORWARD_RECOVERY/);
  assert.match(controller, /R116F_CONTROLLER_RECOVERY=AUTOMATIC/);
  assert.match(controller, /R116F_CONTROLLER_RESULT=PASS/);
});

test('bounded R116F child failure returns control so the exact recovery marker can be handled', () => {
  const start = controller.indexOf('run_bounded_r116f_script() {');
  const end = controller.indexOf('\n}\n\nmain()', start);
  assert.ok(start >= 0 && end > start, 'bounded R116F helper is present');
  const helper = controller.slice(start, end + 2);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-r116f-controller-'));
  const child = path.join(root, 'forward.sh');
  const output = path.join(root, 'operation.raw');
  fs.writeFileSync(child, [
    '#!/bin/bash',
    "echo 'P1_PRODUCTION_HARDENING_FORWARD_POST_RESTART=LEFT_RUNNING_FOR_FORWARD_RECOVERY'",
    'exit 115',
    ''
  ].join('\n'));
  fs.chmodSync(child, 0o755);
  try {
    const bash = process.platform === 'win32'
      ? 'C:\\Program Files\\Git\\bin\\bash.exe'
      : '/bin/bash';
    const shellPath = value => process.platform === 'win32'
      ? value.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/')
      : value;
    const probe = [
      'set -e',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'R116F_FORWARD_RUNTIME_SECONDS=5',
      'R116F_RECOVERY_RUNTIME_SECONDS=3',
      'trusted_root_file() { return 0; }',
      'trusted_root_executable() { return 0; }',
      helper,
      'set +e',
      `run_bounded_r116f_script ${JSON.stringify(shellPath(child))} STAY_P1_PRODUCTION_HARDENING_AUTHORIZATION VALUE 5 ${JSON.stringify(shellPath(output))}`,
      'status=$?',
      'set -e',
      'echo "CALLER_SURVIVED_STATUS=$status"',
      `grep -Fxq 'P1_PRODUCTION_HARDENING_FORWARD_POST_RESTART=LEFT_RUNNING_FOR_FORWARD_RECOVERY' ${JSON.stringify(shellPath(output))}`
    ].join('\n');
    const result = spawnSync(bash, ['-c', probe], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /CALLER_SURVIVED_STATUS=115/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R116F completion proves frozen chips, continuity and one zero-failure benchmark collector', () => {
  assert.match(workflow, /Number\(health\.revision\) === 116/);
  assert.match(workflow, /meta\.revisionFrozen === true/);
  assert.match(workflow, /meta\.revisionLabel === 'R116F'/);
  assert.match(workflow, /chip\('bsf'\)\?\.state === 'LIVE'/);
  assert.match(workflow, /chip\('sntss'\)\?\.state === 'SHADOW'/);
  assert.match(workflow, /chip\('chronobiology'\)\?\.state === 'SHADOW'/);
  assert.match(workflow, /\['metab', 'homeos', 'intero'\]/);
  assert.match(workflow, /Number\(state\.collectorStarts\) === 1/);
  assert.match(workflow, /Number\(state\.collectorRestarts\) === 0/);
  assert.match(workflow, /Number\(state\.failures\) === 0/);
  assert.match(workflow, /CHRONOBIOLOGY_REPLAY_EQUALS_BASELINE=/);
  assert.match(workflow, /SNTSS_LINEAGE_AND_CHECKPOINT_PROGRESS=PASS/);
  assert.match(workflow, /CHRONOBIOLOGY_LINEAGE_CONTINUITY=PASS/);
  assert.match(workflow, /FETUS_AUTHORITY_CONTINUITY=PASS/);
  assert.match(workflow, /BENCHMARK_12H_DUE_UTC=/);
  assert.match(workflow, /BENCHMARK_72H_DUE_UTC=/);
  assert.match(workflow, /PHYSIOLOGY_AUTHORITY_CONTAINMENT=PASS/);
  assert.match(workflow, /FETUS_CONTINUITY=PASS/);
});

test('R116F V15 bootstrap is source-sealed and installs only the pinned controller', () => {
  assert.match(bootstrap, /^\s{2}workflow_dispatch:/m);
  assert.doesNotMatch(bootstrap, /^\s{2}(push|pull_request|schedule):/m);
  assert.match(bootstrap, /AUTHORIZE_R116F_V15_PINNED_CONTROLLER_BOOTSTRAP/);
  assert.match(bootstrap, new RegExp(`WRAPPER_SHA256: ${sha256(controller)}`));
  assert.match(bootstrap, new RegExp(`INSTALLER_SHA256: ${sha256(installer)}`));
  assert.match(installer, new RegExp(`EXPECTED_WRAPPER_SHA256="${sha256(controller)}"`));
  assert.match(bootstrap, /operations="\$\(sed -n/);
  assert.match(bootstrap, /\$'harden-r116f\\nrecover-r116f'/);
  assert.match(bootstrap, /P1_R116F_V15_CONTROLLER_BOOTSTRAP\.sha256/);
  assert.match(bootstrap, /\^\/opt\/stay\/incoming\/r116f-controller-v15-\[0-9\]\+\$/);
  assert.match(bootstrap, /private=\\\$\(mktemp -d \/run\/stay-r116f-v15-bootstrap\.XXXXXX\)/);
  assert.match(bootstrap, /R116F_V15_CONTROLLER_BOOTSTRAP=PASS/);
  assert.doesNotMatch(bootstrap, /FAILED_BOOTSTRAP_STAGE|r111f-controller-v8/);
  assert.doesNotMatch(bootstrap, /sudo -n \/usr\/bin\/systemd-run/);
  const sudoers = installer.match(/<<'SUDOERS'\n([\s\S]*?)\nSUDOERS/);
  assert.ok(sudoers);
  assert.equal(sudoers[1].trim().split('\n').at(-1),
    'staydeploy ALL=(root) NOPASSWD: /usr/local/sbin/stay-p1-production-controller');
});
