'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const WRAPPER_PATH = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'stay-p1-r135-metab-shadow-production-controller');
const INSTALLER_PATH = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'install-p1-r135-metab-shadow-production-controller.sh');
const read = file => fs.readFileSync(file, 'utf8');
const wrapper = read(WRAPPER_PATH);
const installer = read(INSTALLER_PATH);
const wrapperSha256 = crypto.createHash('sha256').update(fs.readFileSync(WRAPPER_PATH)).digest('hex');

test('R135-BRIDGE-01 pins the immutable release and exact R133 recovery source', () => {
  for (const identity of [
    "SOURCE_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r133-metab-shadow-recovery-087a96cd77b6'",
    "SOURCE_MANIFEST_SHA256='087a96cd77b65b15ce68bebbfc7cfdc02b6beed013d0e507f396a6eba8daa949'",
    'SOURCE_FILE_COUNT=663',
    "EXPECTED_RELEASE_TAG='r135-metab-shadow-recovery-v1'",
    "EXPECTED_RELEASE_TAG_OBJECT='751931c83d98f6331bc70892ca01f0c31abdeb37'",
    "EXPECTED_RELEASE_COMMIT='4db441f00c687c1e638ff18aa01af289a1841bff'",
    "EXPECTED_RELEASE_TREE='409f33cdb76b4168c8aaa8d993634abd37ac2e05'",
    "EXPECTED_ARCHIVE_SHA256='8271ef75c7fde2262921b0a09b0221623bd736afb96c858b7e20423ccd0e71a0'",
    "EXPECTED_SIDECAR_SHA256='c4309a5e086f738c261f54b9ead0c036848766745aa42e0e885be4a78e001e10'",
    "EXPECTED_MANIFEST_SHA256='0d123d94a809600922e96802be8012a0700260a0f6a5497c51f36c125af528ee'",
    "EXPECTED_FORWARD_SHA256='8c73303efe4dfa19bc000a9a59efc1faa03b1720026b80706d12c0a9e5c3185c'",
    "EXPECTED_TARGET_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r135-metab-shadow-recovery-0d123d94a809'",
    'TARGET_FILE_COUNT=667'
  ]) assert.equal(wrapper.includes(identity), true, identity);
  assert.match(wrapper, /durable_runtime_revision\)" == 133/);
  assert.match(wrapper, /-f "\$SOURCE_MARKER"/);
  assert.match(wrapper, /! -e "\$R135_MARKER"/);
});

test('R135-BRIDGE-02 exposes only the exact recovery operation and authorization', () => {
  assert.match(wrapper, /"\$operation" == harden-r135-recovery/);
  assert.match(wrapper, /AUTHORIZE_R135_METAB_OUTPUT_FIREWALLED_SHADOW_RECOVERY_V1/);
  assert.match(wrapper, /AUTHORIZE_R135_METAB_OUTPUT_FIREWALLED_SHADOW_FORWARD_RECOVERY_ONLY/);
  assert.match(wrapper, /\^\/opt\/stay\/incoming\/r135-metab-shadow-recovery-v1-\[0-9\]\+\$/);
  assert.doesNotMatch(wrapper, /diagnostic|shell-operation|script-path|START_BENCHMARK/);
});

test('R135-BRIDGE-03 verifies exact clean archive shape and assembled target', () => {
  assert.match(wrapper, /"\$\{#entries\[@\]\}" -eq 9/);
  assert.match(wrapper, /find "\$root" -type f \| wc -l\)" -eq 9/);
  assert.match(wrapper, /wc -l < "\$root\/\$MANIFEST"\)" -eq 8/);
  assert.match(wrapper, /sha256sum -c "\$MANIFEST"/);
  assert.match(wrapper, /cmp "\$expected" "\$actual"/);
  assert.match(wrapper, /\/usr\/local\/bin\/node --check/);
  assert.match(wrapper, /\/bin\/bash -n/);
  assert.match(wrapper, /cp -a --reflink=auto "\$SOURCE_RELEASE\/\."/);
  assert.match(wrapper, /P1_R135_RELEASE\.env/);
  assert.match(wrapper, /CONTROLLER_SHA256=sha256:\$controller_sha/);
});

test('R135-BRIDGE-04 protects existing residents and runs real entry paths', () => {
  for (const invariant of [
    'cores/sntss/i4g', 'cores/chronobiology/c3', 'cores/chronobiology/c3r4',
    'cores/chronobiology/c3r5', 'cores/fetus-legacy-0.6', 'legacy/0.6.0',
    'test/p1-r135-metab-shadow-recovery.test.js', 'test/p1-r128-metab-shadow.test.js',
    'the real preflight CLI entry passes through Bubblewrap on Linux', 'R128-METAB-ENTRY-09',
    'p1-r119f-entry-preflight.js', 'STAY_BWRAP=/usr/local/libexec/stay-bwrap-sandbox',
    'STAY_REQUIRE_CGROUPS=1', 'payloadAttachedBeforeInit===true', 'hardCpuPercent===20'
  ]) assert.equal(wrapper.includes(invariant), true, invariant);
  assert.equal((wrapper.match(/systemd-run --wait --pipe --collect --quiet/g) || []).length, 3);
});

test('R135-BRIDGE-05 independent acceptance requires shadow truth and containment', () => {
  for (const invariant of [
    "row('resident:metab')?.instance_id==='d424c722-ef31-44b0-8201-ba68c418d14a'",
    "row('resident:metab')?.version==='0.2.0-p1r0-shadow.1'",
    'db.pendingDeliveries===0', 'db.pendingOutboxIntents===0', 'db.failedDeliveries===0',
    'db.p1Authority===0', 'db.sntssAuthority===0', 'db.chronobiologyAuthority===0',
    'db.metabOutboxIntents===0', 's.observedOutputs===0', 'm.observedOutputs===0',
    "chip('bsf')?.state==='LIVE'", "chip('sntss')?.state==='SHADOW'",
    "chip('chronobiology')?.state==='SHADOW'", "chip('metab')?.state==='SHADOW'",
    "fetus?.version==='0.6.0'", 'validateRevisionFreeze(freeze,135)',
    'freeze.recovery?.pointerRewound===false'
  ]) assert.equal(wrapper.includes(invariant), true, invariant);
  assert.match(wrapper, /hardRamBytes===100663296/);
  assert.match(wrapper, /handlerTimeoutMs===250/);
  assert.match(wrapper, /\['cpu\.max'\]==='20000 100000'/);
});

test('R135-BRIDGE-06 controller cannot mutate biology directly or widen limits', () => {
  assert.doesNotMatch(wrapper,
    /git reset|git checkout|sqlite3\s+.*(?:DELETE|UPDATE)|TimeoutStartSec=|TimeoutStopSec=|CPUQuota=/);
  assert.equal((wrapper.match(/systemctl restart stay\.service/g) || []).length, 0);
  assert.equal((wrapper.match(/systemctl start stay\.service/g) || []).length, 0);
  assert.doesNotMatch(wrapper, /benchmark-start|START_BENCHMARK/);
  assert.match(wrapper, /RUNTIME_SECONDS=120/);
});

test('R135-BRIDGE-07 installer pins the controller and grants no general sudo', () => {
  assert.equal(wrapperSha256, '0cbc82d406e49447e39971dcabf04c7c7e10ce577949c58fe3ca5ab2d7c53f0c');
  assert.match(installer, new RegExp(`EXPECTED_WRAPPER_SHA256='${wrapperSha256}'`));
  assert.match(installer,
    /staydeploy ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/stay-p1-production-controller/);
  assert.doesNotMatch(installer, /NOPASSWD:\s+(?:ALL|\/bin\/(?:bash|sh)|\/usr\/bin\/env)/);
  assert.match(installer, /visudo -cf "\$sudoers_staged"/);
  assert.match(installer, /root:root:555/);
  assert.match(installer, /R135_FORWARD_AUTHORIZED=NO/);
  assert.match(installer, /R135_RECOVERY_AUTHORIZED=NO/);
  assert.doesNotMatch(installer, /systemctl\s+(?:restart|start|stop)/);
});

test('R135-BRIDGE-08 shell and embedded JavaScript paths parse', () => {
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
