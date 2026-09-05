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

test('R150-CTRL-01 controller pins exact V22 source and immutable V24 overlay', () => {
  const source = read(CONTROLLER);
  for (const exact of [
    "PREVIOUS_RELEASE='/opt/stay/releases/0.8.11.3-p1r0-r150-homeos-intero-c1651b9150bc'",
    "PREVIOUS_MANIFEST_SHA256='c1651b9150bc5c14d254d86caa60cb267317301c01c95282929fc696f4c6160b'",
    "PREVIOUS_BOUND_CONTROLLER_SHA256='6f948c132325352469a51b1248d53292d98f7cdaad32c6a26d31aabbebcc1f64'",
    "RELEASE_TAG='r150-homeos-intero-shadow-v24'",
    "RELEASE_TAG_OBJECT='bc88ce9baab29bfc59c1ea21fa10006e72b9ea68'",
    "RELEASE_COMMIT='579ee569eca02e8e1c6241d3dfda9996f3675132'",
    "RELEASE_TREE='fc3019f7aeb2b0b95d0f1bdf817c5850c7c6d951'",
    "ARCHIVE_SHA256='d518444b3ae07749528f24932af2eac04e2733285dcd4cb90a922efa08d642db'",
    "SIDECAR_SHA256='90324d0ec58a289081e4a1769cf8c1f5a43c8b0095d5ca79c6cb1ebc153a9c4d'",
    "MANIFEST_SHA256='292ef3caf1923acb8c0a2a0883862f1b0b87ec546e872785736a926214a87046'",
    "TARGET_RELEASE='/opt/stay/releases/0.8.11.3-p1r0-r150-homeos-intero-292ef3caf192'"
  ]) assert.ok(source.includes(exact), exact);
  assert.match(source, /\$\{#entries\[@\]\}" -eq 111/);
  assert.match(source, /find "\$WORK_ROOT\/overlay" -type f \| wc -l\)" -eq 89/);
  assert.match(source, /wc -l < "\$WORK_ROOT\/overlay\/\$MANIFEST"\)" -eq 88/);
  assert.match(source, /sha256sum -c "\$MANIFEST"/);
  assert.match(source, /cmp "\$WORK_ROOT\/expected" "\$WORK_ROOT\/actual"/);
  assert.match(source, /cp -a --reflink=auto "\$PREVIOUS_RELEASE\/\."/);
});

test('R150-CTRL-02 post-finalization restart authority is exact and benchmark remains off', () => {
  const source = read(CONTROLLER);
  assert.match(source, /restart-r148-homeos-finalized && "\$authorization" == AUTHORIZE_R148_HOMEOS_POST_FINALIZATION_RESTART_V1/);
  assert.match(source, /STAY_HOMEOS_R148_INIT_POST_DURABLE_FINALIZATION_AUTHORIZATION=\$RECOVERY_AUTHORIZATION/);
  assert.match(source, /RECOVERY_AUTHORIZATION='AUTHORIZE_STRANDED_R148_HOMEOS_POST_FINALIZATION_RESTART_ONLY'/);
  assert.match(source, /BENCHMARK_ACTIVE=NO/);
  assert.match(source, /INTERO=ABSENT/);
  assert.doesNotMatch(source, /harden-r145-homeos|harden-r150-intero|systemctl start stay-physiology-benchmark/);
  assert.doesNotMatch(source, /TimeoutStartSec|TimeoutStopSec|CPUQuota=|MemoryMax=|PIDsMax=|git reset|git checkout/);
});

test('R150-CTRL-03 controller is revision-fenced, rollback-capable, and starts exactly once', () => {
  const source = read(CONTROLLER);
  assert.match(source, /SOURCE_RUNTIME_REVISION=R148/);
  assert.match(source, /TARGET_RUNTIME_REVISION=R148F/);
  assert.match(source, /stay-r148-homeos-post-finalization-restart-preflight-v1/);
  assert.match(source, /R148_HOMEOS_POST_FINALIZATION_RESTART/);
  assert.doesNotMatch(source, /p1-r148-create-init-recovery-snapshot\.js|STAY_R148_INIT_RECOVERY_PREFLIGHT_SNAPSHOT/);
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
  assert.match(source, /R148_HOMEOS_POST_FINALIZATION_RESTART_AUTHORIZED=NO/);
  assert.match(source, /BENCHMARK_START_AUTHORIZED=NO/);
});

test('R150-CTRL-06 workflows pin V27, V24, immutable validation, and stopped R148', () => {
  const bootstrap = read(BOOTSTRAP);
  const capture = read(CAPTURE);
  const production = read(PRODUCTION);
  for (const exact of [
    'AUTHORIZE_R150_HOMEOS_INTERO_V27_PINNED_CONTROLLER_BOOTSTRAP',
    `WRAPPER_SHA256: ${digest(CONTROLLER)}`,
    `INSTALLER_SHA256: ${digest(INSTALLER)}`,
    `PUBLIC_KEY_SHA256: ${digest(PUBLIC_KEY)}`,
    'r150-controller-v27-${GITHUB_RUN_ID}',
    'MANUAL_ROOT_BRIDGE_COMMAND='
  ]) assert.ok(bootstrap.includes(exact), exact);
  assert.ok(capture.includes(`WRAPPER_SHA256: ${digest(CONTROLLER)}`));
  for (const exact of [
    'restart-r148-homeos-finalized', 'AUTHORIZE_R148_HOMEOS_POST_FINALIZATION_RESTART_V1',
    'RELEASE_TAG_OBJECT: bc88ce9baab29bfc59c1ea21fa10006e72b9ea68',
    `WRAPPER_SHA256: ${digest(CONTROLLER)}`,
    'R148_POST_FINALIZATION_DB_PREFLIGHT=PASS', 'pending===0', 'outbox===0',
    'highWater===4575682', 'R148_HOMEOS_POST_FINALIZATION_RESTART=PASS',
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
