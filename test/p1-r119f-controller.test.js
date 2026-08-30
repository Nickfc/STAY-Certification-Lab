'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const wrapper = read('deploy/live-physiology-transplant/stay-p1-r119f-production-controller');
const installer = read(
  'deploy/live-physiology-transplant/install-p1-r119f-production-controller.sh');
const productionWorkflow = read('.github/workflows/p1-r119f-production.yml');
const bootstrapWorkflow = read('.github/workflows/p1-r119f-controller-bootstrap.yml');
const wrapperSha256 = sha256(Buffer.from(wrapper));
const installerSha256 = sha256(Buffer.from(installer));

test('R119F-BRIDGE-01 controller binds the exact immutable V1 release cohort', () => {
  for (const identity of [
    "EXPECTED_RELEASE_TAG='r119f-v1'",
    "EXPECTED_RELEASE_COMMIT='ea28a3c9722a59fb385cfeed84792a4839d58909'",
    "EXPECTED_RELEASE_TREE='9aa59b581190decf1666200a1951f3f76e0c96c9'",
    "EXPECTED_ARCHIVE='STAY_P1_PRODUCTION_HARDENING_R118_TO_R119F_V1_BUNDLE_20260830.tar.gz'",
    "EXPECTED_ARCHIVE_SHA256='b51ec80025b215d5a65a22e709bfa2f7b6ecfdeb0b26519224efd1eeaae9a7ff'",
    "EXPECTED_SIDECAR_SHA256='4b48c5a902077e5d597da627629f56b53a746538483b035182ec59c779021590'",
    "EXPECTED_MANIFEST_SHA256='b2b79e13fc0be1de2728c9e8c5a5d1e14430841743479cbbdebe9d5502bebaee'",
    "EXPECTED_FORWARD_SHA256='21c3510d158e2cf5e174cf1ede1ba472968a3c1e5dbdfe25b72df44919e281a1'",
    "EXPECTED_RECOVERY_SHA256='c6a44bfc956beb07aa0b3ef3fa6a36da9e27926d3a347d0ef20a72a7ddaf9f00'",
    "EXPECTED_TARGET_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r119f-chrono-repair-87a9aeaa1b01'",
    "MANIFEST='deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R118_TO_R119F.sha256'",
  ]) assert.equal(wrapper.includes(identity), true, identity);
  assert.match(wrapper, /"\$\{#entries\[@\]\}" -eq 250/);
  assert.match(wrapper, /-type f \| wc -l\)" -eq 221/);
  assert.match(wrapper, /wc -l < "\$root\/\$MANIFEST"\)" -eq 220/);
  assert.match(wrapper, /if \(NR != 220\) exit 1/);
});

test('R119F-BRIDGE-02 wrapper exposes only exact forward and recovery operations', () => {
  const operationBlock = wrapper.slice(
    wrapper.indexOf('case "$operation" in'), wrapper.indexOf('esac',
      wrapper.indexOf('case "$operation" in')));
  assert.match(operationBlock, /harden-r119f\)/);
  assert.match(operationBlock, /recover-r119f\)/);
  assert.doesNotMatch(operationBlock, /diagnostic|shell|command|script-path/);
  assert.match(wrapper, /AUTHORIZE_R119F_V1_CONTAINED_FORWARD_WITH_FENCED_RECOVERY/);
  assert.match(wrapper, /AUTHORIZE_R119F_V1_FORWARD_RECOVERY_ONLY/);
  assert.match(wrapper, /REPAIR_R118_CHRONOBIOLOGY_CPU_TO_R119F_AND_BENCHMARK_72H/);
  assert.match(wrapper, /COMPLETE_REVISION_FENCED_R119F_WITH_AT_MOST_ONE_START/);
  assert.match(wrapper, /\^\/opt\/stay\/incoming\/r119f-v1-\[0-9\]\+\$/);
  assert.equal((wrapper.match(/if run_bounded_script/g) || []).length, 3);
  assert.doesNotMatch(wrapper, /set \+e\s+run_bounded_script/);
});

test('R119F-BRIDGE-03 archive extraction and cleanup remain path- and identity-fenced', () => {
  assert.match(wrapper, /validate_plain_tree/);
  assert.match(wrapper, /-type l -o -type f -links \+1/);
  assert.match(wrapper, /tar -tvzf "\$archive"[\s\S]*substr\(\$1,1,1\) !~ \/\[-d\]\//);
  assert.match(wrapper, /sha256sum -c "\$MANIFEST"/);
  assert.match(wrapper, /cmp "\$expected_list" "\$actual_list"/);
  assert.match(wrapper, /\/usr\/local\/bin\/node --check/);
  assert.match(wrapper, /\/bin\/bash -n/);
  assert.match(wrapper, /rm -rf --one-file-system -- "\$candidate"/);
  assert.doesNotMatch(wrapper, /rm -rf (?:\/|\$HOME|~)/);
});

test('R119F-BRIDGE-04 installer pins the wrapper and grants no general sudo surface', () => {
  assert.equal(wrapperSha256,
    '8044dba5b17805d3bc14cd3570380a399c8ed502d8f1d02ceb289f73645fe55a');
  assert.match(installer, new RegExp(`EXPECTED_WRAPPER_SHA256='${wrapperSha256}'`));
  assert.match(installer,
    /staydeploy ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/stay-p1-production-controller/);
  assert.doesNotMatch(installer, /NOPASSWD:\s+(?:ALL|\/bin\/(?:bash|sh)|\/usr\/bin\/env)/);
  assert.match(installer, /visudo -cf "\$sudoers_staged"/);
  assert.match(installer, /root:root:555/);
  assert.match(installer, /R119F_FORWARD_AUTHORIZED=NO/);
  assert.match(installer, /R119F_RECOVERY_AUTHORIZED=NO/);
});

test('R119F-BRIDGE-05 bootstrap seals exact artifacts and pauses at the root bridge', () => {
  assert.match(bootstrapWorkflow, /^\s{2}workflow_dispatch:/m);
  assert.doesNotMatch(bootstrapWorkflow, /^\s{2}(push|pull_request|schedule):/m);
  assert.match(bootstrapWorkflow,
    /AUTHORIZE_R119F_V1_PINNED_CONTROLLER_BOOTSTRAP/);
  assert.match(bootstrapWorkflow, new RegExp(`WRAPPER_SHA256: ${wrapperSha256}`));
  assert.match(bootstrapWorkflow, new RegExp(`INSTALLER_SHA256: ${installerSha256}`));
  assert.match(bootstrapWorkflow, /\[\[ "\$GITHUB_REF" == refs\/heads\/main \]\]/);
  assert.match(bootstrapWorkflow,
    /node --test --test-concurrency=1 test\/p1-r119f-controller\.test\.js/);
  assert.match(bootstrapWorkflow, /harden-r119f\\nrecover-r119f/);
  assert.match(bootstrapWorkflow, /MANUAL_ROOT_BRIDGE_COMMAND/);
  assert.match(bootstrapWorkflow, /Await exact installed controller/);
  assert.doesNotMatch(bootstrapWorkflow,
    /ssh[^\n]*sudo -n \/usr\/local\/sbin\/stay-p1-production-controller/);
});

test('R119F-BRIDGE-06 production workflow revalidates the hosted immutable archive', () => {
  for (const identity of [
    'RELEASE_TAG_OBJECT: 149d3123398ff20556791b247fde0707eea6992a',
    'RELEASE_COMMIT: ea28a3c9722a59fb385cfeed84792a4839d58909',
    'RELEASE_TREE: 9aa59b581190decf1666200a1951f3f76e0c96c9',
    'ARCHIVE_SHA256: b51ec80025b215d5a65a22e709bfa2f7b6ecfdeb0b26519224efd1eeaae9a7ff',
    'SIDECAR_SHA256: 4b48c5a902077e5d597da627629f56b53a746538483b035182ec59c779021590',
    'MANIFEST_SHA256: b2b79e13fc0be1de2728c9e8c5a5d1e14430841743479cbbdebe9d5502bebaee',
    'TARGET_RELEASE: /opt/stay/releases/0.8.11.3-p1m-r119f-chrono-repair-87a9aeaa1b01',
    `WRAPPER_SHA256: ${wrapperSha256}`,
  ]) assert.equal(productionWorkflow.includes(identity), true, identity);
  assert.match(productionWorkflow, /gh api "repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags\/\$RELEASE_TAG"/);
  assert.match(productionWorkflow, /gh release download "\$RELEASE_TAG"/);
  assert.match(productionWorkflow, /sha256sum -c "\$ARCHIVE\.sha256"/);
  assert.match(productionWorkflow, /"\$\{#entries\[@\]\}" -eq 250/);
  assert.match(productionWorkflow, /-type f \| wc -l\)" -eq 221/);
  assert.match(productionWorkflow, /wc -l < "\$extract\/\$manifest"\)" -eq 220/);
  assert.match(productionWorkflow, /chronobiology-c3r5-bounded-catchup-repair\.test\.js/);
  assert.match(productionWorkflow, /p1-r119f-entry-path\.test\.js/);
  assert.match(productionWorkflow, /STAY_BWRAP=\/usr\/local\/bin\/stay-ci-bwrap/);
});

test('R119F-BRIDGE-07 production preflight is read-only and recovery-cohort fenced', () => {
  const preflight = productionWorkflow.slice(
    productionWorkflow.indexOf('Exact read-only operation-fenced production preflight'),
    productionWorkflow.indexOf('Stage and invoke only the pinned root controller'));
  assert.match(preflight,
    /\/opt\/stay\/releases\/0\.8\.11\.3-p1m-r118f-chrono-repair-934069400d62/);
  assert.match(preflight, /new DatabaseSync\(process\.argv\[2\], \{ open: true, readOnly: true \}\)/);
  assert.match(preflight, /PRAGMA query_only=ON/);
  assert.match(preflight, /crypto\.createHash\('sha256'\)\.update\(revisionRow\.json\)/);
  assert.match(preflight, /value\.revision === 118/);
  assert.match(preflight, /value\.revision === 119/);
  assert.match(preflight, /active !== 'active' && pid === '0'/);
  assert.match(preflight, /chronobiology-c3r5-r118-bounded-catchup/);
  assert.match(preflight, /inventedBiologicalTime === false/);
  assert.match(preflight, /value\.chronobiologyPending === 0/);
  assert.match(preflight, /systemctl show stay\.service -p MainPID/);
  assert.doesNotMatch(preflight, /sqlite3 \/var\/lib\/stay/);
  assert.doesNotMatch(preflight,
    /sudo|systemctl\s+(?:restart|stop|start|enable|disable)|rm -rf|\/opt\/stay\/incoming/);
  assert.match(productionWorkflow,
    /sudo -n \/usr\/local\/sbin\/stay-p1-production-controller/);
  assert.doesNotMatch(productionWorkflow,
    /sudo -n (?:bash|sh|node|systemctl|sqlite3)/);
});

test('R119F-BRIDGE-08 completion contract requires freeze, containment and benchmark', () => {
  assert.match(wrapper, /RUNTIME_REVISION_AFTER=119/);
  assert.match(wrapper, /REVISION_LABEL=R119F/);
  for (const marker of [
    'BSF_STATUS=FUNCTIONAL', 'BSF_MODE=LIVE', 'SNTSS_AUTHORITY=NONE',
    'SNTSS_OUTPUT_COUNT=0', 'CHRONOBIOLOGY_ABANDONED_COUNT=0',
    'CHRONOBIOLOGY_INVENTED_BIOLOGICAL_TIME=NO', 'CHRONOBIOLOGY_AUTHORITY=NONE',
    'FETUS_CONTINUITY=PASS', 'WEB_CHIP_BSF=LIVE', 'WEB_CHIP_SNTSS=SHADOW',
    'WEB_CHIP_CHRONOBIOLOGY=SHADOW', 'BENCHMARK_SERVICE=ACTIVE',
  ]) assert.equal(wrapper.includes(marker), true, marker);
  assert.match(wrapper, /FORWARD_RUNTIME_SECONDS=1500/);
  assert.match(wrapper, /RECOVERY_RUNTIME_SECONDS=900/);
  assert.match(productionWorkflow, /grep -Fx 'RUNTIME_REVISION_AFTER=119' controller\.output/);
});
