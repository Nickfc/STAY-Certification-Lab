'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const wrapperPath = path.join(root,
  'deploy/live-physiology-transplant/stay-p1-r118f-production-controller');
const installerPath = path.join(root,
  'deploy/live-physiology-transplant/install-p1-r118f-production-controller.sh');
const wrapper = fs.readFileSync(wrapperPath, 'utf8');
const installer = fs.readFileSync(installerPath, 'utf8');
const bootstrapWorkflow = fs.readFileSync(path.join(root,
  '.github/workflows/p1-r118f-controller-bootstrap.yml'), 'utf8');
const productionWorkflow = fs.readFileSync(path.join(root,
  '.github/workflows/p1-r118f-production.yml'), 'utf8');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

test('R118F-BRIDGE-01 controller binds the exact immutable release cohort', () => {
  for (const identity of [
    "EXPECTED_RELEASE_TAG='r118f-v10'",
    "EXPECTED_RELEASE_COMMIT='e48b96fa90a0fb47e2fc48ef5ce3cacf454c234c'",
    "EXPECTED_RELEASE_TREE='f4d674c02790c44f1a6e8d16f8ee6dad4e5bc32a'",
    "EXPECTED_ARCHIVE='STAY_P1_PRODUCTION_HARDENING_R116_TO_R118F_V10_BUNDLE_20260830.tar.gz'",
    "EXPECTED_ARCHIVE_SHA256='bed5eff2a4488691254d2fb2ba7ca7d9f6cc4c339488c7b0573f08cdec5426e8'",
    "EXPECTED_SIDECAR_SHA256='a8f57c23edff2774086dffcf0670c87f95af433f7294d36198515196c882a883'",
    "EXPECTED_MANIFEST_SHA256='129dd8aa818f211444cddcf79665745d2490718e45cc1b2aba32a375c0dfddd0'",
    "EXPECTED_FORWARD_SHA256='c58272879f6a1c30b1a8390f56c1665c7f6268c7c0535337e8fa0ebef2cd9035'",
    "EXPECTED_RECOVERY_SHA256='92466c256ba5210b391939e3458003c80d8a0658af747a6ac4a722269fdfcc03'",
    "EXPECTED_TARGET_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r118f-chrono-repair-8ddbb57a00a7'",
  ]) assert.equal(wrapper.includes(identity), true, identity);
  assert.match(wrapper, /ARCHIVE_ENTRY_COUNT|"\$\{#entries\[@\]\}" -eq 216/);
  assert.match(wrapper, /-type f \| wc -l\)" -eq 189/);
  assert.match(wrapper, /wc -l < "\$root\/\$MANIFEST"\)" -eq 188/);
  assert.equal(wrapper.includes(
    '[[ "$(<"$sidecar")" == "$EXPECTED_ARCHIVE_SHA256 *$EXPECTED_ARCHIVE" ]]'), true);
});

test('R118F-BRIDGE-02 controller exposes only forward and fenced recovery', () => {
  const operationCase = wrapper.slice(
    wrapper.indexOf('case "$operation" in'),
    wrapper.indexOf('esac', wrapper.indexOf('case "$operation" in'))
  );
  const operations = [...operationCase.matchAll(/^    ([a-z0-9-]+)\)$/gm)]
    .map(match => match[1]);
  assert.deepEqual(operations, ['harden-r118f', 'recover-r118f']);
  assert.match(wrapper, /AUTHORIZE_R118F_V10_CONTAINED_FORWARD_WITH_FENCED_RECOVERY/);
  assert.match(wrapper, /AUTHORIZE_R118F_V10_FORWARD_RECOVERY_ONLY/);
  assert.match(wrapper, /REPAIR_R116_CHRONOBIOLOGY_GAP_TO_R118F_AND_BENCHMARK_72H/);
  assert.match(wrapper, /COMPLETE_REVISION_FENCED_R118F_WITHOUT_RESTART/);
  assert.doesNotMatch(wrapper, /rollback-r118f|restore.*StateStore|sqlite3.*\.restore/i);
});

test('R118F-BRIDGE-03 controller validates before root extraction and execution', () => {
  const staged = wrapper.indexOf('verify_staged_identity ||');
  const prepare = wrapper.indexOf('prepare_private_release ||');
  const execute = wrapper.indexOf('run_bounded_script "$script"');
  assert.ok(staged > 0 && staged < prepare && prepare < execute);
  assert.match(wrapper, /tar -tvzf "\$archive"/);
  assert.match(wrapper, /sha256sum -c "\$MANIFEST"/);
  assert.match(wrapper, /cmp "\$expected_list" "\$actual_list"/);
  assert.match(wrapper, /node --check/);
  assert.match(wrapper, /bash -n/);
  assert.match(wrapper, /STAY_R118F_CONTROLLER_SHA256="sha256:\$controller_sha"/);
});

test('R118F-BRIDGE-04 result contract proves biology, chips and benchmark start', () => {
  for (const marker of [
    'RUNTIME_REVISION_AFTER=118', 'REVISION_LABEL=R118F',
    'BSF_STATUS=FUNCTIONAL', 'BSF_MODE=LIVE',
    'SNTSS_AUTHORITY=NONE', 'SNTSS_OUTPUT_COUNT=0',
    'CHRONOBIOLOGY_ABANDONED_COUNT=0',
    'CHRONOBIOLOGY_INVENTED_BIOLOGICAL_TIME=NO',
    'CHRONOBIOLOGY_AUTHORITY=NONE', 'FETUS_CONTINUITY=PASS',
    'WEB_CHIP_BSF=LIVE', 'WEB_CHIP_SNTSS=SHADOW',
    'WEB_CHIP_CHRONOBIOLOGY=SHADOW', 'BENCHMARK_SERVICE=ACTIVE',
    'BENCHMARK_STARTED_AT_UTC', 'BENCHMARK_12H_DUE_UTC',
    'BENCHMARK_72H_DUE_UTC',
  ]) assert.equal(wrapper.includes(marker), true, marker);
});

test('R118F-BRIDGE-05 installer replaces the old wrapper without widening sudo', () => {
  const wrapperHash = sha256(fs.readFileSync(wrapperPath));
  const installerHash = sha256(fs.readFileSync(installerPath));
  assert.equal(wrapperHash,
    'c1ee5a94719425be5e5561f92400445d059a7844f6ad8163df4d99a7fcefe3c4');
  assert.equal(installerHash,
    'a46f183b3c4411514b16752d7d97131ec931fc4a8ac2a51f1454245f03b54e16');
  assert.match(installer, new RegExp(`EXPECTED_WRAPPER_SHA256='${wrapperHash}'`));
  assert.match(installer,
    /TARGET_WRAPPER='\/usr\/local\/sbin\/stay-p1-production-controller'/);
  const sudoers = installer.slice(installer.indexOf("<<'SUDOERS'"),
    installer.indexOf('\nSUDOERS', installer.indexOf("<<'SUDOERS'")));
  assert.match(sudoers,
    /staydeploy ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/stay-p1-production-controller/);
  assert.doesNotMatch(sudoers, /systemctl|node|bash|sh|rm|cp|mv/);
});

test('R118F-BRIDGE-06 workflows bind the controller and immutable hosted release', () => {
  assert.match(bootstrapWorkflow,
    /WRAPPER_SHA256: c1ee5a94719425be5e5561f92400445d059a7844f6ad8163df4d99a7fcefe3c4/);
  assert.match(bootstrapWorkflow,
    /INSTALLER_SHA256: a46f183b3c4411514b16752d7d97131ec931fc4a8ac2a51f1454245f03b54e16/);
  assert.match(bootstrapWorkflow,
    /run_root="\/opt\/stay\/incoming\/r118f-controller-v10-\$\{GITHUB_RUN_ID\}"/);
  assert.doesNotMatch(bootstrapWorkflow,
    /R118F V[6-9]|R118F_V[6-9]|r118f-v[6-9]|controller-v[6-9]/);
  for (const identity of [
    'RELEASE_TAG: r118f-v10',
    'RELEASE_TAG_OBJECT: 8e438d8f4feecf8f5bbacd23f6e92b89e3f762af',
    'RELEASE_COMMIT: e48b96fa90a0fb47e2fc48ef5ce3cacf454c234c',
    'RELEASE_TREE: f4d674c02790c44f1a6e8d16f8ee6dad4e5bc32a',
    'ARCHIVE: STAY_P1_PRODUCTION_HARDENING_R116_TO_R118F_V10_BUNDLE_20260830.tar.gz',
    'ARCHIVE_SHA256: bed5eff2a4488691254d2fb2ba7ca7d9f6cc4c339488c7b0573f08cdec5426e8',
    'SIDECAR_SHA256: a8f57c23edff2774086dffcf0670c87f95af433f7294d36198515196c882a883',
    'MANIFEST_SHA256: 129dd8aa818f211444cddcf79665745d2490718e45cc1b2aba32a375c0dfddd0',
    'FORWARD_SHA256: c58272879f6a1c30b1a8390f56c1665c7f6268c7c0535337e8fa0ebef2cd9035',
    'RECOVERY_SHA256: 92466c256ba5210b391939e3458003c80d8a0658af747a6ac4a722269fdfcc03',
    'TARGET_RELEASE: /opt/stay/releases/0.8.11.3-p1m-r118f-chrono-repair-8ddbb57a00a7',
    'WRAPPER_SHA256: c1ee5a94719425be5e5561f92400445d059a7844f6ad8163df4d99a7fcefe3c4',
  ]) assert.equal(productionWorkflow.includes(identity), true, identity);
  assert.match(productionWorkflow, /persist-credentials: false/);
  assert.match(productionWorkflow,
    /gh api "repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags\/\$RELEASE_TAG"/);
  assert.match(productionWorkflow,
    /gh api "repos\/\$GITHUB_REPOSITORY\/git\/tags\/\$RELEASE_TAG_OBJECT"/);
  assert.doesNotMatch(productionWorkflow, /git -C release-source fetch/);
  assert.match(productionWorkflow, /gh release download "\$RELEASE_TAG"/);
  assert.match(productionWorkflow, /sha256sum -c "\$ARCHIVE\.sha256"/);
  assert.match(productionWorkflow, /install -d -m 0700 "\$root" "\$extract"/);
  assert.match(productionWorkflow,
    /entry_extract="\$\(mktemp -d \/tmp\/stay-r118f-entry\.XXXXXX\)"/);
  assert.match(productionWorkflow, /cleanup_entry_extract\(\) \{/);
  assert.match(productionWorkflow, /chmod -R u\+w -- "\$entry_extract" \|\| true/);
  assert.match(productionWorkflow, /trap cleanup_entry_extract EXIT/);
  assert.match(productionWorkflow, /\(cd "\$entry_extract" && sha256sum -c "\$manifest"\)/);
  assert.match(productionWorkflow, /find "\$entry_extract" -type f -exec chmod a-w,a\+r/);
  assert.match(productionWorkflow, /find "\$entry_extract" -type d -exec chmod a-w,a\+rx/);
  assert.match(productionWorkflow, /STAY_BWRAP=\/usr\/local\/bin\/stay-ci-bwrap node --test/);
  for (const focusedTest of [
    'chronobiology-c3r2-performance-repair.test.js',
    'chronobiology-c3r3-jitless-performance-repair.test.js',
    'chronobiology-c3r4-performance-lab.test.js',
    'chronobiology-c3r4-topology-performance-repair.test.js',
    'core-host-supervisor-permissions.test.js',
    'core-loader-diagnostics.test.js',
    'p1-r118f-chronobiology-implementation-repair.test.js',
    'p1-r118f-entry-path.test.js',
    'p1-r118f-release-contract.test.js',
    'production-hardening.test.js',
    'production-hardening-entry-path.test.js',
  ]) assert.equal(productionWorkflow.includes(`"$entry_extract/test/${focusedTest}"`),
    true, focusedTest);
  assert.doesNotMatch(productionWorkflow, /"\$extract\/test\/p1-r118f-entry-path\.test\.js"/);
});

test('R118F-BRIDGE-07 live preflight precedes staging and only wrapper receives sudo', () => {
  const preflight = productionWorkflow.indexOf('Exact read-only R116 production preflight');
  const staging = productionWorkflow.indexOf('Stage and invoke only the pinned root controller');
  assert.ok(preflight > 0 && preflight < staging);
  assert.match(productionWorkflow, /PRAGMA quick_check/);
  assert.match(productionWorkflow, /new DatabaseSync\(process\.argv\[2\], \{ open: true, readOnly: true \}\)/);
  assert.doesNotMatch(productionWorkflow.slice(preflight, staging), /sqlite3 \/var\/lib\/stay/);
  assert.match(productionWorkflow, /m\.revision===116/);
  assert.match(productionWorkflow, /sudo -n \/usr\/local\/sbin\/stay-p1-production-controller/);
  assert.doesNotMatch(productionWorkflow, /sudo -n (?:bash|sh|node|systemctl|sqlite3)/);
  const choices = productionWorkflow.slice(
    productionWorkflow.indexOf('operation:'),
    productionWorkflow.indexOf('authorization:')
  );
  assert.match(choices, /- harden-r118f\n\s+- recover-r118f/);
});
