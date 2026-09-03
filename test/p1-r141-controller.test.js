'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const WRAPPER_PATH = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'stay-p1-r141-metab-shadow-production-controller');
const INSTALLER_PATH = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'install-p1-r141-metab-shadow-production-controller.sh');
const read = file => fs.readFileSync(file, 'utf8');
const wrapper = read(WRAPPER_PATH);
const installer = read(INSTALLER_PATH);
const wrapperSha256 = crypto.createHash('sha256').update(fs.readFileSync(WRAPPER_PATH)).digest('hex');

test('R141-BRIDGE-01 pins the immutable release and exact R139 recovery source', () => {
  for (const identity of [
    "SOURCE_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r139-metab-shadow-recovery-6a343c91a536'",
    "SOURCE_MANIFEST_SHA256='6a343c91a536d9fab8147f9a214d05654e15f0221622b063477f53ea3212c981'",
    'SOURCE_FILE_COUNT=675',
    "EXPECTED_RELEASE_TAG='r141-metab-shadow-recovery-v2'",
    "EXPECTED_RELEASE_TAG_OBJECT='70919f78c582fd1a796780281f14a21d9d4aa74a'",
    "EXPECTED_RELEASE_COMMIT='563efb7d47ea6451ecae3373f191385f91c2a0ba'",
    "EXPECTED_RELEASE_TREE='45978e42ec2a9ac8e69ab10d6cc4af0f0b197658'",
    "EXPECTED_ARCHIVE_SHA256='2e2c8f11e5c1980b3f069898ab2ab2dc74abf32b637897e7ddd66a555476442a'",
    "EXPECTED_SIDECAR_SHA256='1087bdd5d39dd84fca0919be8fbe1cda030e96b1ea3463415fac4b53d599fb28'",
    "EXPECTED_MANIFEST_SHA256='097d977e8484eb9534439ed30a91ce0eb023b0123b98f95ab4ed061abe5a4cc9'",
    "EXPECTED_FORWARD_SHA256='bd69eb5a62f6cdb7ac6de40f9f7fed0b6d459d7304a2a99f479875ad339a665e'",
    "EXPECTED_TARGET_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r141-metab-shadow-recovery-097d977e8484'",
    'TARGET_FILE_COUNT=679'
  ]) assert.equal(wrapper.includes(identity), true, identity);
  assert.match(wrapper, /durable_runtime_revision\)" == 139/);
  assert.match(wrapper, /-f "\$SOURCE_MARKER"/);
  assert.match(wrapper, /! -e "\$R141_MARKER"/);
});

test('R141-BRIDGE-02 exposes only the exact recovery operation and authorization', () => {
  assert.match(wrapper, /"\$operation" == harden-r141-recovery/);
  assert.match(wrapper, /AUTHORIZE_R141_METAB_OUTPUT_FIREWALLED_SHADOW_RECOVERY_V2/);
  assert.match(wrapper, /AUTHORIZE_R141_METAB_OUTPUT_FIREWALLED_SHADOW_FORWARD_RECOVERY_ONLY/);
  assert.match(wrapper, /\^\/opt\/stay\/incoming\/r141-metab-shadow-recovery-v2-\[0-9\]\+\$/);
  assert.doesNotMatch(wrapper, /diagnostic|shell-operation|script-path|START_BENCHMARK/);
});

test('R141-BRIDGE-03 verifies exact clean archive shape and assembled target', () => {
  assert.match(wrapper, /"\$\{#entries\[@\]\}" -eq 18/);
  assert.match(wrapper, /find "\$root" -type f \| wc -l\)" -eq 13/);
  assert.match(wrapper, /wc -l < "\$root\/\$MANIFEST"\)" -eq 12/);
  assert.match(wrapper, /sha256sum -c "\$MANIFEST"/);
  assert.match(wrapper, /"\$EXPECTED_ARCHIVE_SHA256  \$EXPECTED_ARCHIVE"/);
  assert.match(wrapper, /cmp "\$expected" "\$actual"/);
  assert.match(wrapper, /\/usr\/local\/bin\/node --check/);
  assert.match(wrapper, /\/bin\/bash -n/);
  assert.match(wrapper, /cp -a --reflink=auto "\$SOURCE_RELEASE\/\."/);
  assert.match(wrapper, /P1_R141_RELEASE\.env/);
  assert.match(wrapper, /CONTROLLER_SHA256=sha256:\$controller_sha/);
});

test('R141-BRIDGE-04 protects existing residents and runs real entry paths', () => {
  for (const invariant of [
    'cores/sntss/i4g', 'cores/chronobiology/c3', 'cores/chronobiology/c3r4',
    'cores/chronobiology/c3r5', 'cores/fetus-legacy-0.6', 'legacy/0.6.0',
    'test/p1-r118f-release-contract.test.js', 'test/p1-r119f-release-contract.test.js',
    'test/p1-r124-release-contract.test.js', 'test/p1-r128-metab-shadow.test.js',
    'test/p1-r128-release-contract.test.js', 'test/p1-r133-metab-shadow-recovery.test.js',
    'test/p1-r135-metab-shadow-recovery.test.js', 'test/p1-r137-metab-shadow-recovery.test.js',
    'test/p1-r139-metab-shadow-recovery.test.js', 'test/p1-r141-metab-shadow-recovery.test.js',
    'the real preflight CLI entry passes through Bubblewrap on Linux', 'R128-METAB-ENTRY-09',
    'p1-r119f-entry-preflight.js', 'STAY_BWRAP=/usr/local/libexec/stay-bwrap-sandbox',
    'STAY_REQUIRE_CGROUPS=1', 'payloadAttachedBeforeInit===true', 'hardCpuPercent===20'
  ]) assert.equal(wrapper.includes(invariant), true, invariant);
  assert.equal((wrapper.match(/systemd-run --wait --pipe --collect --quiet/g) || []).length, 3);
});

test('R141-BRIDGE-05 independent acceptance requires shadow truth and containment', () => {
  for (const invariant of [
    "row('resident:metab')?.instance_id==='d424c722-ef31-44b0-8201-ba68c418d14a'",
    "row('resident:metab')?.version==='0.2.0-p1r0-shadow.1'",
    'db.pendingDeliveries===0', 'db.pendingOutboxIntents===0', 'db.failedDeliveries===0',
    'db.p1Authority===0', 'db.sntssAuthority===0', 'db.chronobiologyAuthority===0',
    'db.metabOutboxIntents===0', 's.observedOutputs===0', 'm.observedOutputs===0',
    "chip('bsf')?.state==='LIVE'", "chip('sntss')?.state==='SHADOW'",
    "chip('chronobiology')?.state==='SHADOW'", "chip('metab')?.state==='SHADOW'",
    "fetus?.version==='0.6.0'", 'db.runtimeRevision===141',
    'db.metabCheckpointState?.activation?.runtimeRevision===139',
    'db.capacitySource?.runtimeRevision===128', 'validateRevisionFreeze(freeze,141)',
    'freeze.recovery?.pointerRewound===false', 'freeze.recovery?.repeatedPromotion===false'
  ]) assert.equal(wrapper.includes(invariant), true, invariant);
  assert.match(wrapper, /hardRamBytes===100663296/);
  assert.match(wrapper, /handlerTimeoutMs===250/);
  assert.match(wrapper, /\['cpu\.max'\]==='20000 100000'/);
});

test('R141-BRIDGE-06 controller cannot mutate biology directly or widen limits', () => {
  assert.doesNotMatch(wrapper,
    /git reset|git checkout|sqlite3\s+.*(?:DELETE|UPDATE)|TimeoutStartSec=|TimeoutStopSec=|CPUQuota=/);
  assert.equal((wrapper.match(/systemctl restart stay\.service/g) || []).length, 0);
  assert.equal((wrapper.match(/systemctl start stay\.service/g) || []).length, 0);
  assert.doesNotMatch(wrapper, /benchmark-start|START_BENCHMARK/);
  assert.match(wrapper, /RUNTIME_SECONDS=120/);
});

test('R141-BRIDGE-07 installer pins the controller and grants no general sudo', () => {
  assert.equal(wrapperSha256, '18907d1b032744cd28d5488635d1d174b335835d6a744a0068942d19181e6e2a');
  assert.match(installer, new RegExp(`EXPECTED_WRAPPER_SHA256='${wrapperSha256}'`));
  assert.match(installer,
    /staydeploy ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/stay-p1-production-controller/);
  assert.doesNotMatch(installer, /NOPASSWD:\s+(?:ALL|\/bin\/(?:bash|sh)|\/usr\/bin\/env)/);
  assert.match(installer, /visudo -cf "\$sudoers_staged"/);
  assert.match(installer, /root:root:555/);
  assert.match(installer, /R141_FORWARD_AUTHORIZED=NO/);
  assert.match(installer, /R141_RECOVERY_AUTHORIZED=NO/);
  assert.doesNotMatch(installer, /systemctl\s+(?:restart|start|stop)/);
});

test('R141-BRIDGE-08 shell and embedded JavaScript paths parse', () => {
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
    : 'bash';
  for (const file of [WRAPPER_PATH, INSTALLER_PATH]) {
    const result = spawnSync(bash, ['-n', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}\n${result.stdout}\n${result.stderr}`);
  }
  const blocks = [...wrapper.matchAll(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/g)];
  assert.equal(blocks.length, 3);
  for (const block of blocks) {
    const result = spawnSync(process.execPath, ['--check', '-'], {
      input: block[1], encoding: 'utf8'
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
});
