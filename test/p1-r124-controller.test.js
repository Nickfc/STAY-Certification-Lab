'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const wrapper = read(
  'deploy/live-physiology-transplant/stay-p1-r124-metab-neutral-production-controller');
const installer = read(
  'deploy/live-physiology-transplant/install-p1-r124-metab-neutral-production-controller.sh');
const wrapperSha256 = sha256(Buffer.from(wrapper));

test('R124-BRIDGE-01 controller binds the exact certified immutable cohort', () => {
  for (const identity of [
    "EXPECTED_RELEASE_TAG='r124-metab-neutral-v1'",
    "EXPECTED_RELEASE_TAG_OBJECT='58500d7b43b7ffc0911d5a79f43018e89aeccc1e'",
    "EXPECTED_RELEASE_COMMIT='61783ba477a12c4b4529ce1003f3599e814f4c3b'",
    "EXPECTED_RELEASE_TREE='09f53d65c8d4dcd200efc8ef08e4c91080378197'",
    "EXPECTED_ARCHIVE='STAY_P1_R124_METAB_NEUTRAL_V1_BUNDLE_20260902.tar.gz'",
    "EXPECTED_ARCHIVE_SHA256='734c246b17bde4c3c34d9cce55dddd1d00e9ee3a3f371013e57020d516f81687'",
    "EXPECTED_SIDECAR_SHA256='434fd7f1240deb3ad468f12032ca6b01c0568dc737a5226dc529af849b0640a7'",
    "EXPECTED_MANIFEST_SHA256='b324bd23048a58ca31ca505d17edb2ec0ac21af6fbbfe10825f6378f3716abcc'",
    "EXPECTED_FORWARD_SHA256='7a4c22a4e30b9dfeb5ff52394d085f9cd3633567fcaf6a6f7d5357e150160ed4'",
    "EXPECTED_RECOVERY_SHA256='960fbb96772b8b9f6668f6d98da4075c44f7aafd8036fc08e923734a14fd8ccc'",
    "EXPECTED_BIRTH_CERTIFICATE_SHA256='5fde5160f4a6dac8f97b546ef9b3458b64185465944c07e6c89a915912d2b4a6'",
    "EXPECTED_BIRTH_DOSSIER_SHA256='3eba9eb287f2f25a8ed06b12d104a538ac1c0511b948041c38f1ca24ebf27a1f'",
    "EXPECTED_BIRTH_PUBLIC_KEY_SHA256='754f949e67c31bc25b3bdf66e74a9b69ad44f781d43606b7a46ac69531e0551e'",
    "EXPECTED_TARGET_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r124-metab-neutral-b324bd23048a'",
  ]) assert.equal(wrapper.includes(identity), true, identity);
  assert.match(wrapper, /"\$\{#entries\[@\]\}" -eq 60/);
  assert.match(wrapper, /-type f \| wc -l\)" -eq 42/);
  assert.match(wrapper, /wc -l < "\$root\/\$MANIFEST"\)" -eq 41/);
  assert.match(wrapper, /if \(NR != 41\) exit 1/);
});

test('R124-BRIDGE-02 wrapper exposes only exact forward and recovery operations', () => {
  const operationBlock = wrapper.slice(
    wrapper.indexOf('case "$operation" in'),
    wrapper.indexOf('esac', wrapper.indexOf('case "$operation" in')));
  assert.match(operationBlock, /harden-r124\)/);
  assert.match(operationBlock, /recover-r124\)/);
  assert.doesNotMatch(operationBlock, /diagnostic|shell|command|script-path/);
  assert.match(wrapper,
    /AUTHORIZE_R124_METAB_NEUTRAL_V1_CONTAINED_BIRTH_WITH_FENCED_RECOVERY/);
  assert.match(wrapper, /AUTHORIZE_R124_METAB_NEUTRAL_V1_FORWARD_RECOVERY_ONLY/);
  assert.match(wrapper, /AUTHORIZE_R124_METAB_NEUTRAL_ZERO_AUTHORITY_BIRTH/);
  assert.match(wrapper, /AUTHORIZE_R124_METAB_NEUTRAL_FORWARD_RECOVERY_ONLY/);
  assert.match(wrapper, /\^\/opt\/stay\/incoming\/r124-metab-neutral-v1-\[0-9\]\+\$/);
  assert.equal((wrapper.match(/if run_bounded_script/g) || []).length, 3);
});

test('R124-BRIDGE-03 archive extraction and cleanup are exact and path-fenced', () => {
  assert.match(wrapper, /validate_plain_tree/);
  assert.match(wrapper, /-type l -o -type f -links \+1/);
  assert.match(wrapper, /sort -u \| wc -l/);
  assert.match(wrapper, /tar -tvzf "\$archive"[\s\S]*substr\(\$1,1,1\) !~ \/\[-d\]\//);
  assert.match(wrapper, /sha256sum -c "\$MANIFEST"/);
  assert.match(wrapper, /cmp "\$expected_list" "\$actual_list"/);
  assert.match(wrapper, /\/usr\/local\/bin\/node --check/);
  assert.match(wrapper, /\/bin\/bash -n/);
  assert.match(wrapper, /rm -rf --one-file-system -- "\$candidate"/);
  assert.doesNotMatch(wrapper, /rm -rf (?:\/|\$HOME|~)/);
});

test('R124-BRIDGE-04 one-shot birth material remains scoped and revocable', () => {
  assert.match(wrapper, /STAY_R124_BIRTH_CERTIFICATE_FILE="\$WORK_ROOT\/birth\/\$CERTIFICATE_NAME"/);
  assert.match(wrapper, /STAY_R124_BIRTH_DOSSIER_FILE="\$WORK_ROOT\/birth\/\$DOSSIER_NAME"/);
  assert.match(wrapper, /STAY_R124_BIRTH_PUBLIC_KEY_FILE="\$WORK_ROOT\/birth\/\$PUBLIC_KEY_NAME"/);
  assert.match(wrapper, /metab-neutral-birth-once\.conf/);
  assert.match(wrapper, /resident-metab-neutral-birth\.json/);
  assert.match(wrapper, /metab-neutral-birth-authority\.pub/);
  assert.doesNotMatch(wrapper, /birth-authority-private|entropy\.secret|PRIVATE_KEY/);
});

test('R124-BRIDGE-05 installer pins the wrapper and grants no general sudo surface', () => {
  assert.equal(wrapperSha256,
    'd5c9ff9e1f6e1b1899f5f70ce6158127670afe2f2ac228fec87c7092df1d91c4');
  assert.match(installer, new RegExp(`EXPECTED_WRAPPER_SHA256='${wrapperSha256}'`));
  assert.match(installer,
    /staydeploy ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/stay-p1-production-controller/);
  assert.doesNotMatch(installer, /NOPASSWD:\s+(?:ALL|\/bin\/(?:bash|sh)|\/usr\/bin\/env)/);
  assert.match(installer, /visudo -cf "\$sudoers_staged"/);
  assert.match(installer, /root:root:555/);
  assert.match(installer, /R124_FORWARD_AUTHORIZED=NO/);
  assert.match(installer, /R124_RECOVERY_AUTHORIZED=NO/);
});

test('R124-BRIDGE-06 completion contract independently proves containment', () => {
  for (const marker of [
    'BSF_MODE=LIVE', 'SNTSS_MODE=SHADOW', 'SNTSS_AUTHORITY=NONE',
    'SNTSS_OUTPUTS=0', 'CHRONOBIOLOGY_MODE=SHADOW',
    'CHRONOBIOLOGY_AUTHORITY=NONE', 'METAB_MODE=NEUTRAL',
    'METAB_STATUS=RUNNING', 'METAB_AUTHORITY=NONE', 'METAB_OUTPUTS=0',
    'FETUS_CONTINUITY=PASS', 'BIRTH_AUTHORITY_ACTIVE=NO',
  ]) assert.equal(wrapper.includes(marker), true, marker);
  assert.match(wrapper, /database\.quickCheck === 'ok'/);
  assert.match(wrapper, /database\.pendingDeliveries === 0/);
  assert.match(wrapper, /database\.pendingOutboxIntents === 0/);
  assert.match(wrapper, /database\.p1Authority === 0/);
  assert.match(wrapper, /sntss\?\.observedOutputs === 0/);
  assert.match(wrapper, /metab\?\.signalling === 'FORBIDDEN'/);
  assert.match(wrapper, /metab\?\.productionEligible === false/);
  assert.match(wrapper, /chip\('metab'\)\?\.born === true/);
  assert.match(wrapper, /validateRevisionFreeze\(freeze, revision\)/);
  assert.match(wrapper, /FORWARD_RUNTIME_SECONDS=900/);
  assert.match(wrapper, /RECOVERY_RUNTIME_SECONDS=600/);
});

test('R124-BRIDGE-07 controller never rewinds biology or broadens resource limits', () => {
  assert.doesNotMatch(wrapper,
    /git reset|git checkout|sqlite3\s+.*(?:DELETE|UPDATE)|restore.*continuity|CPUQuota=|TimeoutStopSec=/);
  assert.doesNotMatch(installer, /systemctl\s+(?:restart|start|stop)/);
  assert.equal((wrapper.match(/systemctl restart stay\.service/g) || []).length, 0);
  assert.equal((wrapper.match(/systemctl start stay\.service/g) || []).length, 0);
});

test('R124-BRIDGE-08 embedded independent live verifier has valid JavaScript syntax', () => {
  const blocks = [...wrapper.matchAll(/<<'NODE'\n([\s\S]*?)\nNODE/g)];
  assert.equal(blocks.length, 1);
  const result = spawnSync(process.execPath, ['--check', '-'], {
    input: blocks[0][1], encoding: 'utf8'
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
