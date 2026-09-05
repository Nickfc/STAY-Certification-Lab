'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const CONTROLLER = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'stay-p1-r150-homeos-intero-production-controller');
const INSTALLER = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'install-p1-r150-homeos-intero-production-controller.sh');
const PUBLIC_KEY = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'p1-r150-expansion-birth-authority.pub');
const BOOTSTRAP_WORKFLOW = path.join(ROOT, '.github', 'workflows',
  'p1-r150-controller-bootstrap.yml');
const CAPTURE_WORKFLOW = path.join(ROOT, '.github', 'workflows',
  'p1-r150-live-origin-capture.yml');
const PRODUCTION_WORKFLOW = path.join(ROOT, '.github', 'workflows',
  'p1-r150-homeos-intero-production.yml');

function read(file) { return fs.readFileSync(file, 'utf8'); }
function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('R150-CTRL-01 controller pins the exact immutable source release and overlay', () => {
  const source = read(CONTROLLER);
  for (const exact of [
    "SOURCE_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r141-metab-shadow-recovery-6a1e6a9ffbfd'",
    "PREVIOUS_HOMEOS_RELEASE='/opt/stay/releases/0.8.11.3-p1r0-r150-homeos-intero-9a94dba608c5'",
    "PREVIOUS_HOMEOS_MANIFEST_SHA256='9a94dba608c506d38788d6498d3f1a92388420b6093acc6e9cf4a27e482b9a30'",
    "PREVIOUS_HOMEOS_CONTROLLER_SHA256='f09e7c1e28369af56b37af69e2727c2222226d8445904294563a39f413de4d31'",
    "TARGET_RELEASE_BOUND_CONTROLLER_SHA256='e4680f56afdb60138e78217b602b0cc018e522e6a764c7980c015a28bd453b72'",
    "RELEASE_TAG='r150-homeos-intero-shadow-v21'",
    "RELEASE_TAG_OBJECT='b703d1030fe19c77e6b00cde7cd3a908cc0e7086'",
    "RELEASE_COMMIT='08cbc4a8db10868cd751ae3fe208d4a4467ae4d0'",
    "RELEASE_TREE='455dde13ccd63a0f0be32ee2b59af2055c055369'",
    "ARCHIVE_SHA256='9cb72d077e1497ccfe5037d3ff6994b0471f0489019f3a99aa5341b5adb953e2'",
    "MANIFEST_SHA256='3aa5881594126012fe090a99df84e55378ff5a39e09ba5480c6d33cf4d96d6a8'",
    "TARGET_RELEASE='/opt/stay/releases/0.8.11.3-p1r0-r150-homeos-intero-3aa588159412'"
  ]) assert.ok(source.includes(exact), exact);
  assert.match(source, /sha256sum -c "\$MANIFEST"/);
  assert.match(source, /find "\$WORK_ROOT\/overlay" -type f\|wc -l\)" -eq 84/);
  assert.match(source, /cmp "\$WORK_ROOT\/expected" "\$WORK_ROOT\/actual"/);
  assert.match(source, /expected_previous_homeos_release_env/);
  assert.match(source, /expected_previous_r147_marker/);
  assert.match(source, /\$R147_FRAME_BOUNDARY_REPAIR" preflight/);
  assert.match(source, /cp -a --reflink=auto "\$PREVIOUS_HOMEOS_RELEASE\/\."/);
  assert.match(source, /"\$DATABASE" "\$preflight_root"/);
  assert.match(source, /rm -f -- \/run\/stay-r147-homeos-shadow-recovery\.env/);
  assert.match(source, /mv -Tf "\$pointer_tmp" \/opt\/stay\/current/);
  assert.match(source, /validate_r147_post_durable_cohort/);
  assert.match(source, /resident\.r147-frame-boundary-replayed/);
  assert.match(source, /pendingDeliveries===0/);
  assert.match(source, /replayedPendingCount===492/);
  assert.match(source, /prior-recovery-attempts\.txt/);
});

test('R150-CTRL-02 authority is one-operation exact and benchmark cannot start', () => {
  const source = read(CONTROLLER);
  assert.ok(source.includes(
    'finalize-r147-homeos:AUTHORIZE_R147_HOMEOS_POST_DURABLE_FINALIZATION_V1'));
  assert.doesNotMatch(source, /harden-r145-homeos:|recover-r145-homeos:|harden-r150-intero:|recover-r150-intero:/);
  assert.match(source, /RUNTIME_SECONDS=120/);
  assert.match(source, /BENCHMARK_ACTIVE=NO/);
  assert.doesNotMatch(source, /systemctl start stay-physiology-benchmark/);
  assert.doesNotMatch(source,
    /TimeoutStartSec|TimeoutStopSec|CPUQuota=|MemoryMax=|PIDsMax=|git reset|git checkout/);
});

test('R150-CTRL-03 bootstrap pins wrapper, separate public key, host, and sudo scope', () => {
  const source = read(INSTALLER);
  assert.ok(source.includes(`EXPECTED_WRAPPER_SHA256='${digest(CONTROLLER)}'`));
  assert.ok(source.includes(`EXPECTED_PUBLIC_KEY_SHA256='${digest(PUBLIC_KEY)}'`));
  assert.match(source, /existing-expansion-public-key-conflict/);
  assert.match(source,
    /staydeploy ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/stay-p1-production-controller/);
  assert.match(source, /EXPECTED_PRIVATE_IPV4='172\.26\.9\.207'/);
  assert.match(source, /BENCHMARK_START_AUTHORIZED=NO/);
});

test('R150-CTRL-04 shell and embedded JavaScript entry paths parse', () => {
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
    : 'bash';
  for (const file of [CONTROLLER, INSTALLER]) {
    const source = read(file);
    const shell = spawnSync(bash, ['-n', file], { encoding: 'utf8' });
    assert.equal(shell.status, 0, `${shell.stdout}\n${shell.stderr}`);
    for (const block of source.matchAll(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/g)) {
      const parsed = spawnSync(process.execPath, ['--check', '-'], {
        input: block[1], encoding: 'utf8'
      });
      assert.equal(parsed.status, 0, `${parsed.stdout}\n${parsed.stderr}`);
    }
  }
  for (const file of [BOOTSTRAP_WORKFLOW, CAPTURE_WORKFLOW, PRODUCTION_WORKFLOW]) {
    const source = read(file);
    const blocks = [...source.matchAll(/<<'NODE'\r?\n([\s\S]*?)\r?\n\s+NODE/g)];
    if (file !== BOOTSTRAP_WORKFLOW) assert.ok(blocks.length >= 2, file);
    for (const block of blocks) {
      const parsed = spawnSync(process.execPath, ['--check', '-'], {
        input: block[1], encoding: 'utf8'
      });
      assert.equal(parsed.status, 0, `${file}\n${parsed.stdout}\n${parsed.stderr}`);
    }
  }
});

test('R150-CTRL-05 controller independently re-proves all residents and fixed resources', () => {
  const source = read(CONTROLLER);
  for (const exact of [
    "contained(status('sntss'),'0.5.0-i4g1')",
    "contained(status('chronobiology'),'1.0.0-c3rc.5','NEUTRAL')",
    "'0.4.0-p1r0-intero-feed.1'",
    "'0.3.0-p1r0-intero-feed.1'",
    "contained(status('intero'),'0.2.0-p1r0-shadow.1','SHADOW')",
    'softRamBytes===67108864', 'hardRamBytes===100663296', 'hardCpuDuty===0.2',
    'handlerTimeoutMs===250', 'pidsMax===16', "l?.['memory.high']==='67108864'",
    "l?.['memory.max']==='100663296'", "l?.['cpu.max']==='20000 100000'",
    "l?.['pids.max']==='16'", 'supervisorChargedToKernel===true',
    'STAY_BWRAP=/usr/local/libexec/stay-bwrap-sandbox',
    'db.p1Authority===0', 'db.outputs.intero===0', 'freeze.benchmark?.started===false'
  ]) assert.ok(source.includes(exact), exact);
});

test('R150-CTRL-06 workflows fence bootstrap, read-only capture, transitions, and benchmark', () => {
  const bootstrap = read(BOOTSTRAP_WORKFLOW);
  const capture = read(CAPTURE_WORKFLOW);
  const production = read(PRODUCTION_WORKFLOW);
  for (const exact of [
    'AUTHORIZE_R150_HOMEOS_INTERO_V24_PINNED_CONTROLLER_BOOTSTRAP',
    `WRAPPER_SHA256: ${digest(CONTROLLER)}`,
    `INSTALLER_SHA256: ${digest(INSTALLER)}`,
    `PUBLIC_KEY_SHA256: ${digest(PUBLIC_KEY)}`,
    'secrets.STAY_DEPLOY_KEY',
    'MANUAL_ROOT_BRIDGE_COMMAND=',
    'p1-r150-expansion-birth-authority.pub',
    "chmod u-s,g-s '$run_root'",
    "chmod 0700 '$run_root'",
    'chmod u-s,g-s "$root"',
    'chmod 0700 "$root"',
    "stat -Lc '%U:%G:%a' \"$root\")\" == staydeploy:staydeploy:700"
  ]) assert.ok(bootstrap.includes(exact), exact);
  for (const exact of [
    'AUTHORIZE_R150_READ_ONLY_ORIGIN_CAPTURE_V1',
    `WRAPPER_SHA256: ${digest(CONTROLLER)}`,
    `PUBLIC_KEY_SHA256: ${digest(PUBLIC_KEY)}`,
    'stay-r150-read-only-live-origin-capture-v1',
    "validateRevisionFreeze(capture.parentFreeze, expected)",
    'benchmarkActive: false'
  ]) assert.ok(capture.includes(exact), exact);
  assert.doesNotMatch(capture, /\bsudo\b|\bscp\b|systemctl\s+(?:start|stop|restart)|benchmark-start/);
  for (const exact of [
    'finalize-r147-homeos',
    'AUTHORIZE_R147_HOMEOS_POST_DURABLE_FINALIZATION_V1',
    'RELEASE_TAG_OBJECT: b703d1030fe19c77e6b00cde7cd3a908cc0e7086',
    `WRAPPER_SHA256: ${digest(CONTROLLER)}`,
    'git clone --no-hardlinks release-source /tmp/stay-r150-validation-source',
    'find /tmp/stay-r150-validation-source -type d -exec chmod a+rx {} +',
    'working-directory: /tmp/stay-r150-validation-source',
    'sudo -n /usr/local/sbin/stay-p1-production-controller',
    "chmod u-s,g-s '$run_root'",
    "chmod 0700 '$run_root'",
    'chmod u-s,g-s "$root"',
    'chmod 0700 "$root"',
    "stat -Lc '%U:%G:%a' \"$root\")\" == staydeploy:staydeploy:700",
    '-type f ! -perm 0400 -print -quit',
    'for attempt in $(seq 1 20); do',
    '[[ "$attempt" -eq 20 ]] || sleep 0.25',
    'pending===0',
    "homeos?.status==='RUNNING'",
    'homeos.checkpoint_generation===572',
    "latest.type==='resident.r147-frame-boundary-replayed'",
    'highWater===4575520',
    '[[ "$current" == "$target_release" && "$revision" == 147 ]]',
    'finalize-*)',
    'exact post-durable timeout state',
    'SERVICE_STATE=%s/%s',
    'root="$1"; stage="${2:-}"',
    "grep -Fx 'BENCHMARK_ACTIVE=NO' controller.output",
    "! grep -Fqi '502 Bad Gateway' public.html"
  ]) assert.ok(production.includes(exact), exact);
  for (const source of [bootstrap, capture, production]) {
    assert.doesNotMatch(source, /systemctl start stay-physiology-benchmark|benchmark-start/);
    assert.doesNotMatch(source, /TimeoutStartSec|TimeoutStopSec|CPUQuota=|MemoryMax=|PIDsMax=/);
  }
});

test('R150-CTRL-08 production cgroup entry runs in-process under its delegated unit', () => {
  const source = read(CONTROLLER);
  assert.match(source,
    /systemd-run[\s\S]*?STAY_REQUIRE_CGROUPS=1 \/usr\/local\/bin\/node --test --test-isolation=none --test-concurrency=1[\s\S]*?\^R150-PRODUCTION-05/);
});

test('R150-CTRL-07 staging explicitly clears an inherited setgid directory bit', {
  skip: process.platform !== 'linux'
}, () => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'stay-r150-mode-'));
  try {
    fs.chmodSync(directory, 0o2700);
    const normalized = spawnSync('bash', ['-c', [
      'set -Eeuo pipefail',
      'root="$1"',
      'stat -Lc %a "$root"',
      'chmod u-s,g-s "$root"',
      'chmod 0700 "$root"',
      'stat -Lc %a "$root"'
    ].join(';'), '_', directory], { encoding: 'utf8' });
    assert.equal(normalized.status, 0, `${normalized.stdout}\n${normalized.stderr}`);
    assert.equal(normalized.stdout.trim(), '2700\n700');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
