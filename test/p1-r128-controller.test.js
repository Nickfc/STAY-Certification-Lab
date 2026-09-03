'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const WRAPPER_PATH = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'stay-p1-r128-metab-shadow-production-controller');
const INSTALLER_PATH = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'install-p1-r128-metab-shadow-production-controller.sh');
const BOOTSTRAP_PATH = path.join(ROOT, '.github', 'workflows',
  'p1-r128-metab-shadow-controller-bootstrap.yml');
const PRODUCTION_PATH = path.join(ROOT, '.github', 'workflows',
  'p1-r128-metab-shadow-production.yml');
const read = file => fs.readFileSync(file, 'utf8');
const wrapper = read(WRAPPER_PATH);
const installer = read(INSTALLER_PATH);
const bootstrap = read(BOOTSTRAP_PATH);
const production = read(PRODUCTION_PATH);
const wrapperSha256 = crypto.createHash('sha256').update(fs.readFileSync(WRAPPER_PATH)).digest('hex');

test('R128-BRIDGE-01 controller pins the certified release and exact R127F source', () => {
  for (const identity of [
    "SOURCE_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r127-metab-final-fb27ce309f77'",
    "SOURCE_MANIFEST_SHA256='fb27ce309f77d30f3d0e19b3cd8e15153f6f4d1da994d299b71e61904d2c7658'",
    "SOURCE_FILE_COUNT=646",
    "SOURCE_RELEASE_TAG='r127-metab-final-recovery-v6'",
    "SOURCE_RELEASE_COMMIT='196d603f423a3faac96c9d35f7c9bc38eb43e2f1'",
    "SOURCE_RELEASE_TREE='fb0456cc791fe0a184926f25b51dec55387d58dc'",
    "SOURCE_ARCHIVE_SHA256='sha256:4c33575ca505ef27ba744d5f0ae9c9dd351b4ae2f74ab0d91ec9ad9a974a7fa2'",
    "EXPECTED_RELEASE_TAG='r128-metab-shadow-v1'",
    "EXPECTED_RELEASE_TAG_OBJECT='90eb1d9ac72ad62702099df3b4b62aabb1e0bb9e'",
    "EXPECTED_RELEASE_COMMIT='92d60d0a650b5d43b39957563e0eb0e1de9c22a9'",
    "EXPECTED_RELEASE_TREE='5dc3ca17509777cf8a8b2c6e6b77888ae85da617'",
    "EXPECTED_ARCHIVE='STAY_P1_R128_METAB_SHADOW_V1_BUNDLE_20260903.tar.gz'",
    "EXPECTED_ARCHIVE_SHA256='fb39dbe1769fcb4735af2df517a95e915565ca8aa8914030b00a39aadb0a855e'",
    "EXPECTED_SIDECAR_SHA256='52207912dcafd1e50e7c9e9ac8ad200227ffed2ec7be59a106cc175bc5698f6c'",
    "EXPECTED_MANIFEST_SHA256='70b7e3055a789adc91cfe46f6e25ff1fc7662d88d2c642da580e4d46e554a34d'",
    "EXPECTED_FORWARD_SHA256='e4816b25c3a52b5ae3ec0f2f64f6a009013296d8b951b7a596a062ba5a6b8386'",
    "EXPECTED_RECOVERY_SHA256='0f63e520019640402b0b71cba02302144e489852cbf59819b88826f39c874c6f'",
    "EXPECTED_TARGET_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r128-metab-shadow-70b7e3055a78'",
    'TARGET_FILE_COUNT=658'
  ]) assert.equal(wrapper.includes(identity), true, identity);
  assert.match(wrapper, /durable_runtime_revision[\s\S]*revision/);
  assert.match(wrapper, /validateRevisionFreeze\(value,127\)/);
  assert.match(wrapper, /! -e "\$FREEZE_DIR\/R128\.json"/);
  assert.match(wrapper, /! -e "\$FREEZE_DIR\/R129\.json"/);
});

test('R128-BRIDGE-02 privileged surface exposes only fenced forward and recovery operations', () => {
  const start = wrapper.indexOf('case "$operation" in');
  const end = wrapper.indexOf('esac', start);
  const operationBlock = wrapper.slice(start, end);
  assert.match(operationBlock, /harden-r128\)/);
  assert.match(operationBlock, /recover-r128\)/);
  assert.doesNotMatch(operationBlock, /diagnostic|shell|command|script-path|benchmark/);
  assert.match(wrapper, /AUTHORIZE_R128_METAB_OUTPUT_FIREWALLED_SHADOW_V1/);
  assert.match(wrapper, /AUTHORIZE_R128_METAB_OUTPUT_FIREWALLED_SHADOW_RECOVERY_V1/);
  assert.match(wrapper, /AUTHORIZE_R128_METAB_OUTPUT_FIREWALLED_SHADOW_FORWARD_ONLY/);
  assert.match(wrapper, /AUTHORIZE_R128_METAB_OUTPUT_FIREWALLED_SHADOW_RECOVERY_ONLY/);
  assert.match(wrapper, /R128_METAB_SHADOW_RECOVERY_REQUIRED=YES/);
  assert.match(wrapper, /\^\/opt\/stay\/incoming\/r128-metab-shadow-v1-\[0-9\]\+\$/);
});

test('R128-BRIDGE-03 archive handling is immutable, exact and clean-extraction safe', () => {
  assert.match(wrapper, /validate_plain_tree/);
  assert.match(wrapper, /-type l -o -type f -links \+1/);
  assert.match(wrapper, /sort -u \| wc -l/);
  assert.match(wrapper, /tar -tvzf "\$archive"[\s\S]*substr\(\$1,1,1\) !~ \/\[-d\]\//);
  assert.match(wrapper, /find -P "\$root" -xdev -type f \| wc -l\)" -eq 54/);
  assert.match(wrapper, /wc -l < "\$root\/\$MANIFEST"\)" -eq 53/);
  assert.match(wrapper, /if \(NR != 53\) exit 1/);
  assert.match(wrapper, /sha256sum -c "\$MANIFEST"/);
  assert.match(wrapper, /cmp "\$expected_list" "\$actual_list"/);
  assert.match(wrapper, /\/usr\/local\/bin\/node --check/);
  assert.match(wrapper, /\/bin\/bash -n/);
  assert.match(wrapper, /install -o root -g root -m 0400 "\$RUN_ROOT\/\$EXPECTED_ARCHIVE"/);
  assert.match(wrapper, /rm -rf --one-file-system -- "\$candidate"/);
  assert.doesNotMatch(wrapper, /rm -rf (?:\/|\$HOME|~)/);
});

test('R128-BRIDGE-04 candidate is assembled from frozen R127F and protects existing biology', () => {
  assert.match(wrapper, /cp -a --reflink=auto "\$SOURCE_RELEASE\/\." "\$CANDIDATE\/"/);
  for (const protectedPath of [
    'cores/sntss/i4g', 'cores/chronobiology/c3', 'cores/chronobiology/c3r4',
    'cores/chronobiology/c3r5', 'cores/fetus-legacy-0.6', 'legacy/0.6.0'
  ]) assert.equal(wrapper.includes(protectedPath), true, protectedPath);
  assert.match(wrapper, /tree_digest "\$SOURCE_RELEASE" "\$relative"/);
  assert.match(wrapper, /diff -qr "\$SOURCE_RELEASE\/\$relative" "\$root\/\$relative"/);
  assert.match(wrapper, /P1_R128_RELEASE\.env/);
  assert.match(wrapper, /CONTROLLER_SHA256=sha256:\$controller_sha/);
  assert.match(wrapper, /METAB_OUTPUT_POLICY=FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT/);
});

test('R128-BRIDGE-05 preflight covers focused regressions and real contained entry paths', () => {
  for (const required of [
    'test/p1-r128-metab-shadow.test.js',
    'test/p1-r128-release-contract.test.js',
    'test/production-hardening-entry-path.test.js',
    'the real preflight CLI entry passes through Bubblewrap on Linux',
    'R128-METAB-ENTRY-09',
    'p1-r119f-entry-preflight.js',
    'STAY_BWRAP=/usr/local/libexec/stay-bwrap-sandbox',
    'STAY_REQUIRE_CGROUPS=1',
    'payloadAttachedBeforeInit===true',
    'hardCpuPercent===20'
  ]) assert.equal(wrapper.includes(required), true, required);
  assert.equal((wrapper.match(/systemd-run --wait --pipe --collect --quiet/g) || []).length, 3);
  assert.match(wrapper, /MainPID --value[\s\S]*NRestarts --value[\s\S]*durable_runtime_revision/);
});

test('R128-BRIDGE-06 live acceptance preserves identities, containment and chip truth', () => {
  for (const invariant of [
    "row('resident:sntss')?.instance_id==='8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f'",
    "row('resident:chronobiology')?.instance_id==='f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a'",
    "row('resident:metab')?.instance_id==='d424c722-ef31-44b0-8201-ba68c418d14a'",
    "metab.version==='0.2.0-p1r0-shadow.1'",
    'db.pendingDeliveries===0', 'db.pendingOutboxIntents===0',
    'db.failedDeliveries===0', 'db.metabOutboxIntents===0',
    'db.p1Authority===0', 'db.sntssAuthority===0',
    'db.chronobiologyAuthority===0', 'sntss.observedOutputs===0',
    'metab.observedOutputs===0', "metab.health?.outputPolicy==='FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT'",
    "authority?.instance_id==='82202211-8dd6-44d4-a4ec-8f2553d8dc6f'",
    "fetus?.version==='0.6.0'", "chip('bsf')?.state==='LIVE'",
    "chip('sntss')?.state==='SHADOW'", "chip('chronobiology')?.state==='SHADOW'",
    "chip('metab')?.state==='SHADOW'", "v.coreId==='homeos'",
    "v.coreId==='intero'", 'freeze.continuity?.inventedBiologicalTime===false',
    'freeze.recovery?.pointerRewound===false'
  ]) assert.equal(wrapper.includes(invariant), true, invariant);
});

test('R128-BRIDGE-07 controller cannot edit biology, restart services or widen runtime contracts', () => {
  assert.doesNotMatch(wrapper,
    /git reset|git checkout|sqlite3\s+.*(?:DELETE|UPDATE)|restore.*continuity|TimeoutStartSec=|TimeoutStopSec=|CPUQuota=/);
  assert.equal((wrapper.match(/systemctl restart stay\.service/g) || []).length, 0);
  assert.equal((wrapper.match(/systemctl start stay\.service/g) || []).length, 0);
  assert.match(wrapper, /hardRamBytes===100663296/);
  assert.match(wrapper, /hardCpuDuty===0\.2/);
  assert.match(wrapper, /handlerTimeoutMs===250/);
  assert.match(wrapper, /pidsMax===16/);
  assert.match(wrapper, /RECOVERY_RUNTIME_SECONDS=120/);
});

test('R128-BRIDGE-08 installer pins the wrapper and grants no general sudo surface', () => {
  assert.equal(wrapperSha256,
    'f5f13672ff3172d4166f08f18368f7ec14bd596ef13fc9c821e5ee2fbbf1e6e1');
  assert.match(installer, new RegExp(`EXPECTED_WRAPPER_SHA256='${wrapperSha256}'`));
  assert.match(installer,
    /staydeploy ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/stay-p1-production-controller/);
  assert.doesNotMatch(installer, /NOPASSWD:\s+(?:ALL|\/bin\/(?:bash|sh)|\/usr\/bin\/env)/);
  assert.match(installer, /visudo -cf "\$sudoers_staged"/);
  assert.match(installer, /root:root:555/);
  assert.match(installer, /R128_FORWARD_AUTHORIZED=NO/);
  assert.match(installer, /R128_RECOVERY_AUTHORIZED=NO/);
  assert.doesNotMatch(installer, /systemctl\s+(?:restart|start|stop)/);
});

test('R128-BRIDGE-09 shell and embedded JavaScript controller paths parse', () => {
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
    : 'bash';
  for (const file of [WRAPPER_PATH, INSTALLER_PATH]) {
    const result = spawnSync(bash, ['-n', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}\n${result.stdout}\n${result.stderr}`);
  }
  const blocks = [...wrapper.matchAll(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/g)];
  assert.equal(blocks.length, 4);
  for (const block of blocks) {
    const result = spawnSync(process.execPath, ['--check', '-'], {
      input: block[1], encoding: 'utf8'
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
});

test('R128-BRIDGE-10 workflows pin immutable inputs and repeat clean and real-entry validation', () => {
  for (const identity of [
    'RELEASE_TAG: r128-metab-shadow-v1',
    'RELEASE_TAG_OBJECT: 90eb1d9ac72ad62702099df3b4b62aabb1e0bb9e',
    'RELEASE_COMMIT: 92d60d0a650b5d43b39957563e0eb0e1de9c22a9',
    'RELEASE_TREE: 5dc3ca17509777cf8a8b2c6e6b77888ae85da617',
    'ARCHIVE_SHA256: fb39dbe1769fcb4735af2df517a95e915565ca8aa8914030b00a39aadb0a855e',
    'SIDECAR_SHA256: 52207912dcafd1e50e7c9e9ac8ad200227ffed2ec7be59a106cc175bc5698f6c',
    'MANIFEST_SHA256: 70b7e3055a789adc91cfe46f6e25ff1fc7662d88d2c642da580e4d46e554a34d',
    'WRAPPER_SHA256: f5f13672ff3172d4166f08f18368f7ec14bd596ef13fc9c821e5ee2fbbf1e6e1'
  ]) assert.equal(production.includes(identity), true, identity);
  for (const validation of [
    'gh release download', 'sha256sum -c "$ARCHIVE.sha256"',
    'tar -tvzf "$root/$ARCHIVE"', 'find "$extract" -type f | wc -l',
    'cmp "$root/expected" "$root/actual"',
    'test/p1-r128-release-contract.test.js', 'test/p1-r128-metab-shadow.test.js',
    'the real preflight CLI entry passes through Bubblewrap on Linux',
    "--test-name-pattern='^R128-METAB-ENTRY-09'"
  ]) assert.equal(production.includes(validation), true, validation);
  assert.match(production, /DatabaseSync\(file,\{open:true,readOnly:true\}\)/);
  assert.match(production, /PRAGMA query_only=ON; BEGIN/);
  assert.match(production, /MainPID --value[\s\S]*NRestarts --value/);
  assert.match(production, /sudo -n \/usr\/local\/sbin\/stay-p1-production-controller/);
  assert.doesNotMatch(production, /p1-r123f-benchmark-start|benchmark-start|START_BENCHMARK/);
});

test('R128-BRIDGE-11 bootstrap stages the exact controller but does not authorize production', () => {
  assert.match(bootstrap,
    /WRAPPER_SHA256: f5f13672ff3172d4166f08f18368f7ec14bd596ef13fc9c821e5ee2fbbf1e6e1/);
  assert.match(bootstrap,
    /INSTALLER_SHA256: f74c33c4579bddee26f2678910f710649938c825f62f5c2c909eadc0989e1b86/);
  assert.match(bootstrap, /AUTHORIZE_R128_METAB_SHADOW_V1_PINNED_CONTROLLER_BOOTSTRAP/);
  assert.match(bootstrap, /node --test --test-concurrency=1 test\/p1-r128-controller\.test\.js/);
  assert.match(bootstrap, /P1_R128_METAB_SHADOW_V1_CONTROLLER_BOOTSTRAP\.sha256/);
  assert.match(bootstrap, /MANUAL_ROOT_BRIDGE_COMMAND=/);
  assert.doesNotMatch(bootstrap,
    /AUTHORIZE_R128_METAB_OUTPUT_FIREWALLED_SHADOW_V1(?:\s|$)/);
  assert.doesNotMatch(bootstrap, /systemctl\s+(?:restart|start|stop)/);
});
