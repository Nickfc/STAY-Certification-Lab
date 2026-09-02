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
    "EXPECTED_RELEASE_TAG='r127-metab-final-recovery-v1'",
    "EXPECTED_RELEASE_TAG_OBJECT='bce61c44968b0dbd7bb06885f84da99c0c932e8f'",
    "EXPECTED_RELEASE_COMMIT='13b9fe30fdcd4dfd1d1e414f66fdecef41286d5e'",
    "EXPECTED_RELEASE_TREE='fea4e3e625a3be7fb13f6e4e064734a949647cbb'",
    "EXPECTED_ARCHIVE='STAY_P1_R127_METAB_FINAL_RECOVERY_V1_BUNDLE_20260902.tar.gz'",
    "EXPECTED_ARCHIVE_SHA256='a849d50387d950340f281bd41b403183298073794c4bdffa4b7b87c1ac167afc'",
    "EXPECTED_SIDECAR_SHA256='ba6c6ea6dd13d78f2f8d251054e70912ab065a5342885f216f448deca61a4d1a'",
    "EXPECTED_MANIFEST_SHA256='cb760d7ee1489c8366cce7cdf2be50f55721150ed297126b52d5e7017cce580d'",
    "EXPECTED_FORWARD_SHA256='232fec04293cb5b64258fe0c782345f8cff98d3a5887fc5f3219566c4e2b377b'",
    "EXPECTED_RECOVERY_SHA256='232fec04293cb5b64258fe0c782345f8cff98d3a5887fc5f3219566c4e2b377b'",
    "EXPECTED_BIRTH_CERTIFICATE_SHA256='5fde5160f4a6dac8f97b546ef9b3458b64185465944c07e6c89a915912d2b4a6'",
    "EXPECTED_BIRTH_DOSSIER_SHA256='3eba9eb287f2f25a8ed06b12d104a538ac1c0511b948041c38f1ca24ebf27a1f'",
    "EXPECTED_BIRTH_PUBLIC_KEY_SHA256='754f949e67c31bc25b3bdf66e74a9b69ad44f781d43606b7a46ac69531e0551e'",
    "EXPECTED_TARGET_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r127-metab-final-cb760d7ee148'",
    "EXPECTED_ACTIVE_RELEASE_TAG='r127-metab-final-recovery-v1'",
    "EXPECTED_ACTIVE_RELEASE_COMMIT='13b9fe30fdcd4dfd1d1e414f66fdecef41286d5e'",
    "EXPECTED_ACTIVE_RELEASE_TREE='fea4e3e625a3be7fb13f6e4e064734a949647cbb'",
  ]) assert.equal(wrapper.includes(identity), true, identity);
  assert.match(wrapper, /"\$\{#entries\[@\]\}" -eq 64/);
  assert.match(wrapper, /-type f \| wc -l\)" -eq 46/);
  assert.match(wrapper, /wc -l < "\$root\/\$MANIFEST"\)" -eq 45/);
  assert.match(wrapper, /if \(NR != 45\) exit 1/);
});

test('R127-BRIDGE-02 wrapper exposes only the exact forward-repair operation', () => {
  const operationBlock = wrapper.slice(
    wrapper.indexOf('case "$operation" in'),
    wrapper.indexOf('esac', wrapper.indexOf('case "$operation" in')));
  assert.match(operationBlock, /recover-r127-final\)/);
  assert.doesNotMatch(operationBlock, /harden-r124|diagnostic|shell|command|script-path/);
  assert.match(wrapper, /AUTHORIZE_R127_METAB_FINAL_RECOVERY_V1_FORWARD_ONLY/);
  assert.match(wrapper, /AUTHORIZE_R127_METAB_REVISION_PRESERVING_FORWARD_RECOVERY_ONLY/);
  assert.match(wrapper, /\^\/opt\/stay\/incoming\/r127-metab-final-recovery-v1-\[0-9\]\+\$/);
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
  assert.match(wrapper, /STAY_R127_BIRTH_DOSSIER_FILE="\$WORK_ROOT\/birth\/\$DOSSIER_NAME"/);
  assert.match(wrapper, /metab-neutral-birth-once\.conf/);
  assert.match(wrapper, /resident-metab-neutral-birth\.json/);
  assert.match(wrapper, /metab-neutral-birth-authority\.pub/);
  assert.doesNotMatch(wrapper, /birth-authority-private|entropy\.secret|PRIVATE_KEY/);
});

test('R127-BRIDGE-05 evidence access is exact, read-only, probed, and always restored', () => {
  assert.match(wrapper,
    /R124_FAILURE_ROOT='\/var\/lib\/stay\/evidence\/production-hardening\/FAILED-R124-20260902T144307Z\.eMKkA2'/);
  for (const identity of [
    '40e54a2d6ed649132c5f1395d8cdf0ed7075cbe0ff5c4d89a2c57707c84ca4da',
    '95d99d8b56d6299680928d10bacc5cc41bd5cc3fedf584ee519ce69729c5cb74',
    '34baedccaa9227ebd20c0b11a9e32fa6b98deb3c25ca2db03fa846bf49251a92',
    '9dc732e26d7974f4a5998a936051bd1f52909399179b8313a2311f5299f1fcac',
  ]) assert.equal(wrapper.includes(identity), true, identity);
  assert.match(wrapper, /validate_r124_evidence_access original/);
  assert.match(wrapper, /validate_r124_evidence_access staged/);
  assert.match(wrapper, /chmod 0710 "\$R124_FAILURE_PARENT"/);
  assert.match(wrapper, /chmod 0510 "\$R124_FAILURE_ROOT"/);
  assert.match(wrapper, /chmod 0440 "\$file"/);
  assert.match(wrapper, /process\.setgroups\(\[\]\)/);
  assert.match(wrapper, /process\.setgid\(Number\(gidText\)\)/);
  assert.match(wrapper, /process\.setuid\(Number\(uidText\)\)/);
  const probeBlock = wrapper.slice(
    wrapper.indexOf('probe_r124_evidence_access()'), wrapper.indexOf('finish_controller()'));
  assert.match(probeBlock, /require\('node:crypto'\)/);
  assert.match(probeBlock, /require\('node:fs'\)/);
  assert.match(probeBlock, /require\('node:path'\)/);
  assert.doesNotMatch(probeBlock, /require\(modulePath\)|living-kernel\.js|event-fabric/);
  assert.match(probeBlock, /trustedRootFile\(markerFile, markerSha256\)/);
  assert.match(probeBlock, /Object\.entries\(expectedEvidence\)/);
  assert.match(wrapper, /R127_CONTROLLER_EVIDENCE_ACCESS_PROBE=PASS/);
  assert.match(wrapper, /if \[\[ "\$EVIDENCE_ACCESS_STAGED" -eq 1 \]\]/);
  assert.match(wrapper, /chmod 0400 "\$file"/);
  assert.match(wrapper, /chmod 0500 "\$R124_FAILURE_ROOT"/);
  assert.match(wrapper, /chmod 0700 "\$R124_FAILURE_PARENT"/);
  assert.match(wrapper, /R127_CONTROLLER_EVIDENCE_ACCESS_RESTORED=/);
  assert.doesNotMatch(wrapper, /chmod\s+(?:[2367][0-7]{2}|0?[0-7]*[2367])\s+"\$file"/);
});

test('R127-BRIDGE-06 installer pins the wrapper and grants no general sudo surface', () => {
  assert.equal(wrapperSha256,
    'd4397f196e3a9e6c6906502ffacd274443a9615db4d833271fbf12ef536ea4de');
  assert.match(installer, new RegExp(`EXPECTED_WRAPPER_SHA256='${wrapperSha256}'`));
  assert.match(installer,
    /staydeploy ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/stay-p1-production-controller/);
  assert.doesNotMatch(installer, /NOPASSWD:\s+(?:ALL|\/bin\/(?:bash|sh)|\/usr\/bin\/env)/);
  assert.match(installer, /visudo -cf "\$sudoers_staged"/);
  assert.match(installer, /root:root:555/);
  assert.match(installer, /R127_FINAL_RECOVERY_V4_AUTHORIZED=NO/);
});

test('R127-BRIDGE-07 completion contract independently proves repair and containment', () => {
  for (const marker of [
    'BSF_MODE=LIVE', 'SNTSS_MODE=SHADOW', 'SNTSS_AUTHORITY=NONE',
    'SNTSS_OUTPUTS=0', 'CHRONOBIOLOGY_MODE=SHADOW', 'CHRONOBIOLOGY_STATUS=RUNNING',
    'CHRONOBIOLOGY_AUTHORITY=NONE', 'METAB_MODE=NEUTRAL',
    'METAB_STATUS=RUNNING', 'METAB_AUTHORITY=NONE', 'METAB_OUTPUTS=0',
    'METAB_SIGNALLING=FORBIDDEN', 'RESTART_COMMANDS=4',
    'FETUS_CONTINUITY=PASS', 'BIRTH_AUTHORITY_ACTIVE=NO',
    'WEB_CHIP_BSF=LIVE', 'WEB_CHIP_SNTSS=SHADOW',
    'WEB_CHIP_CHRONOBIOLOGY=SHADOW', 'WEB_CHIP_METAB=NEUTRAL',
  ]) assert.equal(wrapper.includes(marker), true, marker);
  assert.match(wrapper, /database\.quickCheck === 'ok'/);
  assert.match(wrapper, /database\.pendingDeliveries === 0/);
  assert.match(wrapper, /database\.pendingOutboxIntents === 0/);
  assert.match(wrapper, /database\.failedDeliveries === 0/);
  assert.match(wrapper, /database\.abandonedDeliveries === 0/);
  assert.match(wrapper, /database\.p1Authority === 0/);
  assert.match(wrapper, /sntss\?\.observedOutputs === 0/);
  assert.match(wrapper, /metab\?\.signalling === 'FORBIDDEN'/);
  assert.match(wrapper, /metab\?\.productionEligible === false/);
  assert.match(wrapper, /chip\('metab'\)\?\.born === true/);
  assert.match(wrapper, /validateRevisionFreeze\(freeze, revision\)/);
  assert.match(wrapper, /R127_METAB_NEUTRAL_REVISION_PRESERVING_FORWARD_RECOVERY/);
  assert.match(wrapper, /freeze\.recovery\?\.markerAccessRepaired === true/);
  assert.match(wrapper, /freeze\.recovery\?\.kernelRevisionPreserved === true/);
  assert.match(wrapper, /freeze\.recovery\?\.fetusInstallRevisionPreserved === true/);
  assert.match(wrapper, /freeze\.recovery\?\.pointerRewound === false/);
  assert.match(wrapper, /RECOVERY_RUNTIME_SECONDS=900/);
});

test('R127-BRIDGE-08 controller never rewinds biology or broadens resource limits', () => {
  assert.doesNotMatch(wrapper,
    /git reset|git checkout|sqlite3\s+.*(?:DELETE|UPDATE)|restore.*continuity|CPUQuota=|TimeoutStopSec=/);
  assert.doesNotMatch(installer, /systemctl\s+(?:restart|start|stop)/);
  assert.equal((wrapper.match(/systemctl restart stay\.service/g) || []).length, 0);
  assert.equal((wrapper.match(/systemctl start stay\.service/g) || []).length, 0);
});

test('R127-BRIDGE-09 embedded JavaScript verifiers have valid syntax', () => {
  const blocks = [...wrapper.matchAll(/<<'NODE'\n([\s\S]*?)\nNODE/g)];
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    const result = spawnSync(process.execPath, ['--check', '-'], {
      input: block[1], encoding: 'utf8'
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
});
