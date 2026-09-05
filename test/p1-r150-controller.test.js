'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const DEPLOY = path.join(ROOT, 'deploy', 'live-physiology-transplant');
const CONTROLLER = path.join(DEPLOY, 'stay-p1-r150-homeos-intero-production-controller');
const INSTALLER = path.join(DEPLOY, 'install-p1-r150-homeos-intero-production-controller.sh');
const PUBLIC_KEY = path.join(DEPLOY, 'p1-r150-expansion-birth-authority.pub');
const BOOTSTRAP = path.join(ROOT, '.github', 'workflows', 'p1-r150-controller-bootstrap.yml');
const CAPTURE = path.join(ROOT, '.github', 'workflows', 'p1-r150-live-origin-capture.yml');
const PRODUCTION = path.join(ROOT, '.github', 'workflows', 'p1-r150-homeos-intero-production.yml');

const read = file => fs.readFileSync(file, 'utf8');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('R150-CTRL-01 controller pins exact V21 source and immutable V22 overlay', () => {
  const source = read(CONTROLLER);
  for (const exact of [
    "PREVIOUS_RELEASE='/opt/stay/releases/0.8.11.3-p1r0-r150-homeos-intero-3aa588159412'",
    "PREVIOUS_MANIFEST_SHA256='3aa5881594126012fe090a99df84e55378ff5a39e09ba5480c6d33cf4d96d6a8'",
    "PREVIOUS_BOUND_CONTROLLER_SHA256='e4680f56afdb60138e78217b602b0cc018e522e6a764c7980c015a28bd453b72'",
    "RELEASE_TAG='r150-homeos-intero-shadow-v22'",
    "RELEASE_TAG_OBJECT='c6570c7f37acb495a92095729ac56c895a514f1c'",
    "RELEASE_COMMIT='1a2ff66909dd5eb065e08ca807a13e8ec5951c51'",
    "RELEASE_TREE='f05af36c697a4c0f48892e51d83ff4139369e088'",
    "ARCHIVE_SHA256='56942c3982d99aee293c09f882ba4d15c58a249fe81f4159d588eea2a2d7a031'",
    "SIDECAR_SHA256='f7eb8d227106d60aac3d9c637d175eab06ec748031720dca8662a400c572db67'",
    "MANIFEST_SHA256='c1651b9150bc5c14d254d86caa60cb267317301c01c95282929fc696f4c6160b'",
    "TARGET_RELEASE='/opt/stay/releases/0.8.11.3-p1r0-r150-homeos-intero-c1651b9150bc'"
  ]) assert.ok(source.includes(exact), exact);
  assert.match(source, /\$\{#entries\[@\]\}" -eq 109/);
  assert.match(source, /find "\$WORK_ROOT\/overlay" -type f \| wc -l\)" -eq 87/);
  assert.match(source, /wc -l < "\$WORK_ROOT\/overlay\/\$MANIFEST"\)" -eq 86/);
  assert.match(source, /sha256sum -c "\$MANIFEST"/);
  assert.match(source, /cmp "\$WORK_ROOT\/expected" "\$WORK_ROOT\/actual"/);
  assert.match(source, /cp -a --reflink=auto "\$PREVIOUS_RELEASE\/\."/);
});

test('R150-CTRL-02 recovery authority is exact, one-operation, and benchmark remains off', () => {
  const source = read(CONTROLLER);
  assert.match(source, /recover-r148-homeos-init && "\$authorization" == AUTHORIZE_R148_HOMEOS_INIT_FORWARD_RECOVERY_V1/);
  assert.match(source, /STAY_HOMEOS_STRANDED_R148_INIT_RECOVERY_AUTHORIZATION=\$RECOVERY_AUTHORIZATION/);
  assert.match(source, /RECOVERY_AUTHORIZATION='AUTHORIZE_STRANDED_R148_HOMEOS_INIT_FORWARD_RECOVERY_ONLY'/);
  assert.match(source, /BENCHMARK_ACTIVE=NO/);
  assert.match(source, /INTERO=ABSENT/);
  assert.doesNotMatch(source, /harden-r145-homeos|harden-r150-intero|systemctl start stay-physiology-benchmark/);
  assert.doesNotMatch(source, /TimeoutStartSec|TimeoutStopSec|CPUQuota=|MemoryMax=|PIDsMax=|git reset|git checkout/);
});

test('R150-CTRL-03 controller is revision-fenced, rollback-capable, and starts exactly once', () => {
  const source = read(CONTROLLER);
  assert.match(source, /SOURCE_RUNTIME_REVISION=R148/);
  assert.match(source, /TARGET_RUNTIME_REVISION=R148F/);
  assert.match(source, /p1-r148-homeos-init-forward-preflight\.js/);
  assert.match(source, /p1-r148-create-init-recovery-snapshot\.js/);
  assert.match(source, /validateR148After/);
  assert.match(source, /\$FREEZER" homeos-r148-recovery/);
  assert.match(source, /POINTER_ADVANCED[\s\S]*SERVICE_STARTED[\s\S]*TARGET_RELEASE/);
  assert.equal((source.match(/^\s*systemctl start stay\.service\s*$/gm) || []).length, 1);
  assert.match(source, /rm -f -- "\$RECOVERY_DROPIN"/);
  assert.match(source, /rm -f -- "\$FREEZE_DIR\/R148\.json"/);
});

test('R150-CTRL-04 fetus continuity and all contained shadows are independently accepted', () => {
  const source = read(CONTROLLER);
  for (const exact of [
    'FETUS_CONTINUITY=PASS', 'P1_AUTHORITY=NONE',
    'for id in sntss chronobiology metab homeos',
    "['sntss','chronobiology','metab','homeos'].every(id=>chip(id)?.state==='SHADOW')",
    "chip('bsf')?.state==='LIVE'", "m.revisionLabel==='R148F'"
  ]) assert.ok(source.includes(exact), exact);
  assert.match(source, /STAY_REQUIRE_OS_CORE_SANDBOX=1/);
  assert.match(source, /STAY_REQUIRE_CORE_PACKAGE_POLICY=1 STAY_REQUIRE_CGROUPS=1/);
  assert.match(source, /\^R150-PRODUCTION-05/);
});

test('R150-CTRL-05 bootstrap pins wrapper, key, host, and narrow sudo scope', () => {
  const source = read(INSTALLER);
  assert.ok(source.includes(`EXPECTED_WRAPPER_SHA256='${digest(CONTROLLER)}'`));
  assert.ok(source.includes(`EXPECTED_PUBLIC_KEY_SHA256='${digest(PUBLIC_KEY)}'`));
  assert.match(source, /EXPECTED_PRIVATE_IPV4='172\.26\.9\.207'/);
  assert.match(source, /staydeploy ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/stay-p1-production-controller/);
  assert.match(source, /R148_HOMEOS_INIT_FORWARD_RECOVERY_AUTHORIZED=NO/);
  assert.match(source, /BENCHMARK_START_AUTHORIZED=NO/);
});

test('R150-CTRL-06 workflows pin V25, V22, immutable validation, and stopped R148', () => {
  const bootstrap = read(BOOTSTRAP);
  const capture = read(CAPTURE);
  const production = read(PRODUCTION);
  for (const exact of [
    'AUTHORIZE_R150_HOMEOS_INTERO_V25_PINNED_CONTROLLER_BOOTSTRAP',
    `WRAPPER_SHA256: ${digest(CONTROLLER)}`,
    `INSTALLER_SHA256: ${digest(INSTALLER)}`,
    `PUBLIC_KEY_SHA256: ${digest(PUBLIC_KEY)}`,
    'r150-controller-v25-${GITHUB_RUN_ID}',
    'MANUAL_ROOT_BRIDGE_COMMAND='
  ]) assert.ok(bootstrap.includes(exact), exact);
  assert.ok(capture.includes(`WRAPPER_SHA256: ${digest(CONTROLLER)}`));
  for (const exact of [
    'recover-r148-homeos-init', 'AUTHORIZE_R148_HOMEOS_INIT_FORWARD_RECOVERY_V1',
    'RELEASE_TAG_OBJECT: c6570c7f37acb495a92095729ac56c895a514f1c',
    `WRAPPER_SHA256: ${digest(CONTROLLER)}`,
    'R148_STOPPED_DB_PREFLIGHT=PASS', 'pending===160', 'outbox===2',
    'highWater===4575680', 'R148_HOMEOS_INIT_FORWARD_RECOVERY=PASS',
    'FETUS_CONTINUITY=PASS', 'INTERO=ABSENT', "! grep -Fqi '502 Bad Gateway' public.html"
  ]) assert.ok(production.includes(exact), exact);
  for (const source of [bootstrap, capture, production]) {
    assert.doesNotMatch(source, /systemctl start stay-physiology-benchmark|benchmark-start/);
    assert.doesNotMatch(source, /TimeoutStartSec|TimeoutStopSec|CPUQuota=|MemoryMax=|PIDsMax=/);
  }
});

test('R150-CTRL-07 shell and embedded JavaScript entry paths parse', () => {
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
  for (const file of [CONTROLLER, INSTALLER]) {
    const source = read(file);
    const shell = spawnSync(bash, ['-n', file], { encoding: 'utf8' });
    assert.equal(shell.status, 0, `${file}\n${shell.stdout}\n${shell.stderr}`);
    for (const block of source.matchAll(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/g)) {
      const parsed = spawnSync(process.execPath, ['--check', '-'], { input: block[1], encoding: 'utf8' });
      assert.equal(parsed.status, 0, `${file}\n${parsed.stdout}\n${parsed.stderr}`);
    }
  }
  for (const file of [BOOTSTRAP, CAPTURE, PRODUCTION]) {
    const source = read(file);
    for (const block of source.matchAll(/<<'NODE'\r?\n([\s\S]*?)\r?\n\s+NODE/g)) {
      const parsed = spawnSync(process.execPath, ['--check', '-'], { input: block[1], encoding: 'utf8' });
      assert.equal(parsed.status, 0, `${file}\n${parsed.stdout}\n${parsed.stderr}`);
    }
  }
});

test('R150-CTRL-08 staging explicitly clears inherited setgid', {
  skip: process.platform !== 'linux'
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-r150-mode-'));
  try {
    fs.chmodSync(directory, 0o2700);
    const normalized = spawnSync('bash', ['-c', 'set -Eeuo pipefail;root="$1";stat -Lc %a "$root";chmod u-s,g-s "$root";chmod 0700 "$root";stat -Lc %a "$root"', '_', directory], { encoding: 'utf8' });
    assert.equal(normalized.status, 0, `${normalized.stdout}\n${normalized.stderr}`);
    assert.equal(normalized.stdout.trim(), '2700\n700');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
