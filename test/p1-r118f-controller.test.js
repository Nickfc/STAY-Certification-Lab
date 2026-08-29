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
    "EXPECTED_RELEASE_TAG='r118f-v1'",
    "EXPECTED_RELEASE_COMMIT='b2ce7cb94bdea34780385b5d0cbf2121155cddb0'",
    "EXPECTED_RELEASE_TREE='b14df9a6c67740d5f849ff6693800867b1363ad3'",
    "EXPECTED_ARCHIVE_SHA256='d6745dd533b80ae1f72038c2e36d16f2fa840eb583d7b2a013f5d89e55c7bac9'",
    "EXPECTED_SIDECAR_SHA256='2fdecfd93552c13c577d7926118f73967013f9b72216252a70256901b61542cc'",
    "EXPECTED_MANIFEST_SHA256='377b1a2fc19633c2d636f3a0e0e420a4063e1d6cad13e6e4dd16439b89772c1a'",
    "EXPECTED_FORWARD_SHA256='c868c4baf1abbeaf60a3054f8c74290cba108067e7f65b1a3bbc280384010f8a'",
    "EXPECTED_RECOVERY_SHA256='92466c256ba5210b391939e3458003c80d8a0658af747a6ac4a722269fdfcc03'",
    "EXPECTED_TARGET_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r118f-chrono-repair-42b230a19975'",
  ]) assert.equal(wrapper.includes(identity), true, identity);
  assert.match(wrapper, /ARCHIVE_ENTRY_COUNT|"\$\{#entries\[@\]\}" -eq 160/);
  assert.match(wrapper, /-type f \| wc -l\)" -eq 140/);
  assert.match(wrapper, /wc -l < "\$root\/\$MANIFEST"\)" -eq 139/);
});

test('R118F-BRIDGE-02 controller exposes only forward and fenced recovery', () => {
  const operationCase = wrapper.slice(
    wrapper.indexOf('case "$operation" in'),
    wrapper.indexOf('esac', wrapper.indexOf('case "$operation" in'))
  );
  const operations = [...operationCase.matchAll(/^    ([a-z0-9-]+)\)$/gm)]
    .map(match => match[1]);
  assert.deepEqual(operations, ['harden-r118f', 'recover-r118f']);
  assert.match(wrapper, /AUTHORIZE_R118F_V1_CONTAINED_FORWARD_WITH_FENCED_RECOVERY/);
  assert.match(wrapper, /AUTHORIZE_R118F_V1_FORWARD_RECOVERY_ONLY/);
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
  assert.equal(wrapperHash,
    '7c1a872f8fca4e4c7bf5bb40f194f35ad2ff55fa7b7519a35b88e4961d2d2244');
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
    /WRAPPER_SHA256: 7c1a872f8fca4e4c7bf5bb40f194f35ad2ff55fa7b7519a35b88e4961d2d2244/);
  assert.match(bootstrapWorkflow,
    /INSTALLER_SHA256: 2efa97d3856b9d616b5dba753d9a2e62b682df25cf9a5b1ecdde8af75a794945/);
  for (const identity of [
    'RELEASE_TAG: r118f-v1',
    'RELEASE_TAG_OBJECT: 744f85ad9fdffa5710286a4d8b7ea8423fc285eb',
    'RELEASE_COMMIT: b2ce7cb94bdea34780385b5d0cbf2121155cddb0',
    'RELEASE_TREE: b14df9a6c67740d5f849ff6693800867b1363ad3',
    'ARCHIVE_SHA256: d6745dd533b80ae1f72038c2e36d16f2fa840eb583d7b2a013f5d89e55c7bac9',
    'MANIFEST_SHA256: 377b1a2fc19633c2d636f3a0e0e420a4063e1d6cad13e6e4dd16439b89772c1a',
    'FORWARD_SHA256: c868c4baf1abbeaf60a3054f8c74290cba108067e7f65b1a3bbc280384010f8a',
    'RECOVERY_SHA256: 92466c256ba5210b391939e3458003c80d8a0658af747a6ac4a722269fdfcc03',
  ]) assert.equal(productionWorkflow.includes(identity), true, identity);
  assert.match(productionWorkflow, /persist-credentials: false/);
  assert.match(productionWorkflow,
    /gh api "repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags\/\$RELEASE_TAG"/);
  assert.match(productionWorkflow,
    /gh api "repos\/\$GITHUB_REPOSITORY\/git\/tags\/\$RELEASE_TAG_OBJECT"/);
  assert.doesNotMatch(productionWorkflow, /git -C release-source fetch/);
  assert.match(productionWorkflow, /gh release download "\$RELEASE_TAG"/);
  assert.match(productionWorkflow, /sha256sum -c "\$ARCHIVE\.sha256"/);
  assert.match(productionWorkflow, /STAY_BWRAP=\/usr\/local\/bin\/stay-ci-bwrap node --test/);
});

test('R118F-BRIDGE-07 live preflight precedes staging and only wrapper receives sudo', () => {
  const preflight = productionWorkflow.indexOf('Exact read-only R116 production preflight');
  const staging = productionWorkflow.indexOf('Stage and invoke only the pinned root controller');
  assert.ok(preflight > 0 && preflight < staging);
  assert.match(productionWorkflow, /PRAGMA quick_check/);
  assert.match(productionWorkflow, /m\.revision===116/);
  assert.match(productionWorkflow, /sudo -n \/usr\/local\/sbin\/stay-p1-production-controller/);
  assert.doesNotMatch(productionWorkflow, /sudo -n (?:bash|sh|node|systemctl|sqlite3)/);
  const choices = productionWorkflow.slice(
    productionWorkflow.indexOf('operation:'),
    productionWorkflow.indexOf('authorization:')
  );
  assert.match(choices, /- harden-r118f\n\s+- recover-r118f/);
});
