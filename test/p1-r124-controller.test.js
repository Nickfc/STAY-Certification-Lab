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

test('R127-BRIDGE-01 controller binds the exact certified immutable repair cohort', () => {
  for (const identity of [
    "EXPECTED_RELEASE_TAG='r127-metab-repair-v2'",
    "EXPECTED_RELEASE_TAG_OBJECT='d8f9738c0daf8b8534cdbbebb3846f64767fd790'",
    "EXPECTED_RELEASE_COMMIT='6d52633225ff394c118652cecd2326a7d7c8a8ba'",
    "EXPECTED_RELEASE_TREE='50af738ceea3c2b1774f919e5700a8144927d92b'",
    "EXPECTED_ARCHIVE='STAY_P1_R127_METAB_REPAIR_V2_BUNDLE_20260902.tar.gz'",
    "EXPECTED_ARCHIVE_SHA256='20fa31ec4b890ffc1854355fc37926f9c575fab2d3ef450d936604dca9f56f3a'",
    "EXPECTED_SIDECAR_SHA256='8d38533a7f76ff53884dfab15c65c339ba1073b6bc30ddfce2aaed695f3faa03'",
    "EXPECTED_MANIFEST_SHA256='6677c444d77f801d5f36e5afc9b7a2b17bc182f6e5fabefe5e8d708b507d51c7'",
    "EXPECTED_FORWARD_SHA256='47ecff4b8ab2090a8942be36b801eb0cc85fa8dd46f10d20785ec2ce2d91297a'",
    "EXPECTED_RECOVERY_SHA256='47ecff4b8ab2090a8942be36b801eb0cc85fa8dd46f10d20785ec2ce2d91297a'",
    "EXPECTED_BIRTH_CERTIFICATE_SHA256='5fde5160f4a6dac8f97b546ef9b3458b64185465944c07e6c89a915912d2b4a6'",
    "EXPECTED_BIRTH_DOSSIER_SHA256='3eba9eb287f2f25a8ed06b12d104a538ac1c0511b948041c38f1ca24ebf27a1f'",
    "EXPECTED_BIRTH_PUBLIC_KEY_SHA256='754f949e67c31bc25b3bdf66e74a9b69ad44f781d43606b7a46ac69531e0551e'",
    "EXPECTED_TARGET_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r127-metab-repair-6677c444d77f'",
  ]) assert.equal(wrapper.includes(identity), true, identity);
  assert.match(wrapper, /"\$\{#entries\[@\]\}" -eq 63/);
  assert.match(wrapper, /-type f \| wc -l\)" -eq 45/);
  assert.match(wrapper, /wc -l < "\$root\/\$MANIFEST"\)" -eq 44/);
  assert.match(wrapper, /if \(NR != 44\) exit 1/);
});

test('R127-BRIDGE-02 wrapper exposes only the exact forward-repair operation', () => {
  const operationBlock = wrapper.slice(
    wrapper.indexOf('case "$operation" in'),
    wrapper.indexOf('esac', wrapper.indexOf('case "$operation" in')));
  assert.match(operationBlock, /recover-r124\)/);
  assert.doesNotMatch(operationBlock, /harden-r124|diagnostic|shell|command|script-path/);
  assert.match(wrapper, /AUTHORIZE_R127_METAB_REPAIR_V2_FORWARD_ONLY/);
  assert.match(wrapper, /AUTHORIZE_R124_METAB_NEUTRAL_FORWARD_RECOVERY_ONLY/);
  assert.match(wrapper, /\^\/opt\/stay\/incoming\/r127-metab-repair-v2-\[0-9\]\+\$/);
  assert.equal((wrapper.match(/if run_bounded_script/g) || []).length, 1);
});

test('R127-BRIDGE-03 archive extraction and cleanup are exact and path-fenced', () => {
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

test('R127-BRIDGE-04 one-shot birth material remains scoped and revocable', () => {
  assert.match(wrapper, /STAY_R124_BIRTH_CERTIFICATE_FILE="\$WORK_ROOT\/birth\/\$CERTIFICATE_NAME"/);
  assert.match(wrapper, /STAY_R124_BIRTH_DOSSIER_FILE="\$WORK_ROOT\/birth\/\$DOSSIER_NAME"/);
  assert.match(wrapper, /STAY_R124_BIRTH_PUBLIC_KEY_FILE="\$WORK_ROOT\/birth\/\$PUBLIC_KEY_NAME"/);
  assert.match(wrapper, /metab-neutral-birth-once\.conf/);
  assert.match(wrapper, /resident-metab-neutral-birth\.json/);
  assert.match(wrapper, /metab-neutral-birth-authority\.pub/);
  assert.doesNotMatch(wrapper, /birth-authority-private|entropy\.secret|PRIVATE_KEY/);
});

test('R127-BRIDGE-05 installer pins the wrapper and grants no general sudo surface', () => {
  assert.equal(wrapperSha256,
    '97488ba60fcafee4b52504b70c664fefc5028c2f31a311b7ef225b341989bbb2');
  assert.match(installer, new RegExp(`EXPECTED_WRAPPER_SHA256='${wrapperSha256}'`));
  assert.match(installer,
    /staydeploy ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/stay-p1-production-controller/);
  assert.doesNotMatch(installer, /NOPASSWD:\s+(?:ALL|\/bin\/(?:bash|sh)|\/usr\/bin\/env)/);
  assert.match(installer, /visudo -cf "\$sudoers_staged"/);
  assert.match(installer, /root:root:555/);
  assert.match(installer, /R127_REPAIR_AUTHORIZED=NO/);
});

test('R127-BRIDGE-06 completion contract independently proves repair and containment', () => {
  for (const marker of [
    'BSF_MODE=LIVE', 'SNTSS_MODE=SHADOW', 'SNTSS_AUTHORITY=NONE',
    'SNTSS_OUTPUTS=0', 'CHRONOBIOLOGY_MODE=SHADOW', 'CHRONOBIOLOGY_STATUS=RUNNING',
    'CHRONOBIOLOGY_AUTHORITY=NONE', 'METAB_MODE=NEUTRAL',
    'METAB_STATUS=RUNNING', 'METAB_AUTHORITY=NONE', 'METAB_OUTPUTS=0',
    'METAB_SIGNALLING=FORBIDDEN', 'RESTART_COMMANDS=2',
    'FETUS_CONTINUITY=PASS', 'BIRTH_AUTHORITY_ACTIVE=NO',
    'WEB_CHIP_BSF=LIVE', 'WEB_CHIP_SNTSS=SHADOW',
    'WEB_CHIP_CHRONOBIOLOGY=SHADOW', 'WEB_CHIP_METAB=NEUTRAL',
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
  assert.match(wrapper, /R127_METAB_NEUTRAL_FORWARD_REPAIR/);
  assert.match(wrapper, /freeze\.recovery\?\.pointerRewound === false/);
  assert.match(wrapper, /RECOVERY_RUNTIME_SECONDS=900/);
});

test('R127-BRIDGE-07 controller never rewinds biology or broadens resource limits', () => {
  assert.doesNotMatch(wrapper,
    /git reset|git checkout|sqlite3\s+.*(?:DELETE|UPDATE)|restore.*continuity|CPUQuota=|TimeoutStopSec=/);
  assert.doesNotMatch(installer, /systemctl\s+(?:restart|start|stop)/);
  assert.equal((wrapper.match(/systemctl restart stay\.service/g) || []).length, 0);
  assert.equal((wrapper.match(/systemctl start stay\.service/g) || []).length, 0);
});

test('R127-BRIDGE-08 embedded independent live verifier has valid JavaScript syntax', () => {
  const blocks = [...wrapper.matchAll(/<<'NODE'\n([\s\S]*?)\nNODE/g)];
  assert.equal(blocks.length, 1);
  const result = spawnSync(process.execPath, ['--check', '-'], {
    input: blocks[0][1], encoding: 'utf8'
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
