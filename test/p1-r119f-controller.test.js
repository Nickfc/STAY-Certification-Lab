'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const wrapper = read('deploy/live-physiology-transplant/stay-p1-r119f-production-controller');
const installer = read(
  'deploy/live-physiology-transplant/install-p1-r119f-production-controller.sh');
const productionWorkflow = read('.github/workflows/p1-r119f-production.yml');
const bootstrapWorkflow = read('.github/workflows/p1-r119f-controller-bootstrap.yml');
const wrapperSha256 = sha256(Buffer.from(wrapper));
const installerSha256 = sha256(Buffer.from(installer));

test('R119F-BRIDGE-01 controller binds the exact immutable V4 release cohort', () => {
  for (const identity of [
    "EXPECTED_RELEASE_TAG='r119f-v4'",
    "EXPECTED_RELEASE_COMMIT='833cf2564ed2be040c681a627de24042f9ac1538'",
    "EXPECTED_RELEASE_TREE='97a1f8dbcf596cb98f0bda9af8faacfd709cb9ef'",
    "EXPECTED_ARCHIVE='STAY_P1_PRODUCTION_HARDENING_R118_TO_R119F_V4_BUNDLE_20260830.tar.gz'",
    "EXPECTED_ARCHIVE_SHA256='b0da4fa781181f44299ae724dbc364a71a477dcceec860af7faf8d4f909a066b'",
    "EXPECTED_SIDECAR_SHA256='aab2c4f4cd13d2bd4bc94a145ca99af7d30a1800f6a2d5414b0a8509d515fbd7'",
    "EXPECTED_MANIFEST_SHA256='021c837c3b1d2a1e855e39e6154790e48a0ecc6f5bbb07dddc9776d63ad733eb'",
    "EXPECTED_FORWARD_SHA256='20a31e700d490877b513b359832a5562449257f745a6821955df27d3b77bfcc5'",
    "EXPECTED_RECOVERY_SHA256='c6a44bfc956beb07aa0b3ef3fa6a36da9e27926d3a347d0ef20a72a7ddaf9f00'",
    "EXPECTED_TARGET_RELEASE='/opt/stay/releases/0.8.11.3-p1m-r119f-chrono-repair-2961f9a48173'",
    "MANIFEST='deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R118_TO_R119F.sha256'",
  ]) assert.equal(wrapper.includes(identity), true, identity);
  assert.match(wrapper, /"\$\{#entries\[@\]\}" -eq 251/);
  assert.match(wrapper, /-type f \| wc -l\)" -eq 222/);
  assert.match(wrapper, /wc -l < "\$root\/\$MANIFEST"\)" -eq 221/);
  assert.match(wrapper, /if \(NR != 221\) exit 1/);
});

test('R119F-BRIDGE-02 wrapper exposes only exact forward and recovery operations', () => {
  const operationBlock = wrapper.slice(
    wrapper.indexOf('case "$operation" in'), wrapper.indexOf('esac',
      wrapper.indexOf('case "$operation" in')));
  assert.match(operationBlock, /harden-r119f\)/);
  assert.match(operationBlock, /recover-r119f\)/);
  assert.doesNotMatch(operationBlock, /diagnostic|shell|command|script-path/);
  assert.match(wrapper, /AUTHORIZE_R119F_V4_CONTAINED_FORWARD_WITH_FENCED_RECOVERY/);
  assert.match(wrapper, /AUTHORIZE_R119F_V4_FORWARD_RECOVERY_ONLY/);
  assert.match(wrapper, /REPAIR_R118_CHRONOBIOLOGY_CPU_TO_R119F_AND_BENCHMARK_72H/);
  assert.match(wrapper, /COMPLETE_REVISION_FENCED_R119F_WITH_AT_MOST_ONE_START/);
  assert.match(wrapper, /\^\/opt\/stay\/incoming\/r119f-v4-\[0-9\]\+\$/);
  assert.equal((wrapper.match(/if run_bounded_script/g) || []).length, 3);
  assert.doesNotMatch(wrapper, /set \+e\s+run_bounded_script/);
});

test('R119F-BRIDGE-03 archive extraction and cleanup remain path- and identity-fenced', () => {
  assert.match(wrapper, /validate_plain_tree/);
  assert.match(wrapper, /-type l -o -type f -links \+1/);
  assert.match(wrapper, /tar -tvzf "\$archive"[\s\S]*substr\(\$1,1,1\) !~ \/\[-d\]\//);
  assert.match(wrapper, /sha256sum -c "\$MANIFEST"/);
  assert.match(wrapper, /cmp "\$expected_list" "\$actual_list"/);
  assert.match(wrapper, /\/usr\/local\/bin\/node --check/);
  assert.match(wrapper, /\/bin\/bash -n/);
  assert.match(wrapper, /rm -rf --one-file-system -- "\$candidate"/);
  assert.doesNotMatch(wrapper, /rm -rf (?:\/|\$HOME|~)/);
});

test('R119F-BRIDGE-04 installer pins the wrapper and grants no general sudo surface', () => {
  assert.equal(wrapperSha256,
    'f5432db9af2e232cb5b4be38323d6883b3370887b967723232e81558e0482a3c');
  assert.match(installer, new RegExp(`EXPECTED_WRAPPER_SHA256='${wrapperSha256}'`));
  assert.match(installer,
    /staydeploy ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/stay-p1-production-controller/);
  assert.doesNotMatch(installer, /NOPASSWD:\s+(?:ALL|\/bin\/(?:bash|sh)|\/usr\/bin\/env)/);
  assert.match(installer, /visudo -cf "\$sudoers_staged"/);
  assert.match(installer, /root:root:555/);
  assert.match(installer, /R119F_FORWARD_AUTHORIZED=NO/);
  assert.match(installer, /R119F_RECOVERY_AUTHORIZED=NO/);
});

test('R119F-BRIDGE-05 bootstrap seals exact artifacts and yields the root bridge without polling', () => {
  assert.match(bootstrapWorkflow, /^\s{2}workflow_dispatch:/m);
  assert.doesNotMatch(bootstrapWorkflow, /^\s{2}(push|pull_request|schedule):/m);
  assert.match(bootstrapWorkflow,
    /AUTHORIZE_R119F_V4_PINNED_CONTROLLER_BOOTSTRAP/);
  assert.match(bootstrapWorkflow, new RegExp(`WRAPPER_SHA256: ${wrapperSha256}`));
  assert.match(bootstrapWorkflow, new RegExp(`INSTALLER_SHA256: ${installerSha256}`));
  assert.match(bootstrapWorkflow, /\[\[ "\$GITHUB_REF" == refs\/heads\/main \]\]/);
  assert.match(bootstrapWorkflow,
    /node --test --test-concurrency=1 test\/p1-r119f-controller\.test\.js/);
  assert.match(bootstrapWorkflow, /harden-r119f\\nrecover-r119f/);
  assert.match(bootstrapWorkflow, /MANUAL_ROOT_BRIDGE_COMMAND/);
  assert.doesNotMatch(bootstrapWorkflow, /Await exact installed controller|sleep 30/);
  assert.doesNotMatch(bootstrapWorkflow,
    /ssh[^\n]*sudo -n \/usr\/local\/sbin\/stay-p1-production-controller/);
});

test('R119F-BRIDGE-06 production workflow revalidates the hosted immutable archive', () => {
  for (const identity of [
    'RELEASE_TAG_OBJECT: 3b91c75e0fbcfd33c2c436d6967492ad0d8210af',
    'RELEASE_COMMIT: 833cf2564ed2be040c681a627de24042f9ac1538',
    'RELEASE_TREE: 97a1f8dbcf596cb98f0bda9af8faacfd709cb9ef',
    'ARCHIVE_SHA256: b0da4fa781181f44299ae724dbc364a71a477dcceec860af7faf8d4f909a066b',
    'SIDECAR_SHA256: aab2c4f4cd13d2bd4bc94a145ca99af7d30a1800f6a2d5414b0a8509d515fbd7',
    'MANIFEST_SHA256: 021c837c3b1d2a1e855e39e6154790e48a0ecc6f5bbb07dddc9776d63ad733eb',
    'TARGET_RELEASE: /opt/stay/releases/0.8.11.3-p1m-r119f-chrono-repair-2961f9a48173',
    `WRAPPER_SHA256: ${wrapperSha256}`,
  ]) assert.equal(productionWorkflow.includes(identity), true, identity);
  assert.match(productionWorkflow, /gh api "repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags\/\$RELEASE_TAG"/);
  assert.match(productionWorkflow, /gh release download "\$RELEASE_TAG"/);
  assert.match(productionWorkflow, /sha256sum -c "\$ARCHIVE\.sha256"/);
  assert.match(productionWorkflow, /"\$\{#entries\[@\]\}" -eq 251/);
  assert.match(productionWorkflow, /-type f \| wc -l\)" -eq 222/);
  assert.match(productionWorkflow, /wc -l < "\$extract\/\$manifest"\)" -eq 221/);
  assert.match(productionWorkflow, /chronobiology-c3r5-bounded-catchup-repair\.test\.js/);
  assert.match(productionWorkflow, /p1-r119f-entry-path\.test\.js/);
  assert.match(productionWorkflow, /STAY_BWRAP=\/usr\/local\/bin\/stay-ci-bwrap/);
});

test('R119F-BRIDGE-07 production preflight is read-only and recovery-cohort fenced', () => {
  const preflight = productionWorkflow.slice(
    productionWorkflow.indexOf('Exact read-only operation-fenced production preflight'),
    productionWorkflow.indexOf('Stage and invoke only the pinned root controller'));
  assert.match(preflight,
    /\/opt\/stay\/releases\/0\.8\.11\.3-p1m-r118f-chrono-repair-934069400d62/);
  assert.match(preflight,
    /source_manifest='deploy\/live-physiology-transplant\/P1_PRODUCTION_HARDENING_R116_TO_R118F\.sha256'/);
  assert.match(preflight,
    /source_manifest_sha256='129dd8aa818f211444cddcf79665745d2490718e45cc1b2aba32a375c0dfddd0'/);
  assert.match(preflight, /source_manifest_records=188/);
  assert.match(preflight, /source_present_records=181/);
  assert.match(preflight, /source_file_count=571/);
  assert.match(preflight,
    /source_tree_sha256='e8f8ab054b0c6510d3b24535fdc8f556a8c17df4acb2377621a8533becec3c8f'/);
  for (const absentHash of [
    'bc21dd1aded8cf68eb60f630fe9f6c8afdcb4e8a6bf8c928184b85e8258dcc37',
    '259341d04759ee74550d5d3fe34aa869c15b2e2cea4efe2e637a8f700804472f',
    '7b5370cd244b427bbdac062b9be09af1e853ece9a416dd22a72e220e03789fcc',
    '433430f1e360d1183e29e016978c9610fd1b2d1070aab5415facb39aab8896df',
    '386da10cf952cd448ffc8315e797165c292208561246e47a223565825a922d52',
    '048bdec2ab67e2a2ff0114e8d5fecec1c81879addbfe9b13a53b70b7c263602c',
    '42aae340f5dfc8a43dc8c3f38855df1b3e681e51102d0ab1b5be14ebfb456404',
  ]) assert.equal(preflight.includes(absentHash), true, absentHash);
  for (const reconciliation of [
    '4d95813956acee06cd963ad8dc11a52d402ebeedadc3262046202a1cc9682a1c',
    '90552599da3c3c2f189ea3426b25ea25d91e6d22d796449f4fc27b388d172b46',
    '46c7a51b8f256f3c6b9fdb1a183b087a676eace03c3c19d7d4cf05f3e0481429',
    'bb187de6a8f6d7013db2b5658391da81ad4adf375ad810674466ee329bb30103',
  ]) assert.equal(preflight.includes(reconciliation), true, reconciliation);
  assert.match(preflight, /source_reconciled_records/);
  assert.match(preflight, /sha256sum -c <\(source_records_present\)/);
  assert.match(preflight, /find \. -type f -print0 \| sort -z \| xargs -0 sha256sum/);
  assert.match(preflight, /R119F_SOURCE_RELEASE_INVENTORY=PASS/);
  assert.match(preflight, /new DatabaseSync\(process\.argv\[2\], \{ open: true, readOnly: true \}\)/);
  assert.match(preflight, /PRAGMA query_only=ON/);
  assert.match(preflight, /crypto\.createHash\('sha256'\)\.update\(revisionRow\.json\)/);
  assert.match(preflight, /value\.revision === 118/);
  assert.match(preflight, /value\.revision === 119/);
  assert.match(preflight, /active !== 'active' && pid === '0'/);
  assert.match(preflight, /chronobiology-c3r5-r118-bounded-catchup/);
  assert.match(preflight, /inventedBiologicalTime === false/);
  assert.match(preflight, /value\.chronobiologyPending === 0/);
  assert.match(preflight, /systemctl show stay\.service -p MainPID/);
  assert.doesNotMatch(preflight, /sqlite3 \/var\/lib\/stay/);
  assert.doesNotMatch(preflight,
    /sudo|systemctl\s+(?:restart|stop|start|enable|disable)|rm -rf|\/opt\/stay\/incoming/);
  assert.match(productionWorkflow,
    /sudo -n \/usr\/local\/sbin\/stay-p1-production-controller/);
  assert.doesNotMatch(productionWorkflow,
    /sudo -n (?:bash|sh|node|systemctl|sqlite3)/);
});

test('R119F-BRIDGE-08 completion contract requires freeze, containment and benchmark', () => {
  assert.match(wrapper, /RUNTIME_REVISION_AFTER=119/);
  assert.match(wrapper, /REVISION_LABEL=R119F/);
  for (const marker of [
    'BSF_STATUS=FUNCTIONAL', 'BSF_MODE=LIVE', 'SNTSS_AUTHORITY=NONE',
    'SNTSS_OUTPUT_COUNT=0', 'CHRONOBIOLOGY_ABANDONED_COUNT=0',
    'CHRONOBIOLOGY_INVENTED_BIOLOGICAL_TIME=NO', 'CHRONOBIOLOGY_AUTHORITY=NONE',
    'FETUS_CONTINUITY=PASS', 'WEB_CHIP_BSF=LIVE', 'WEB_CHIP_SNTSS=SHADOW',
    'WEB_CHIP_CHRONOBIOLOGY=SHADOW', 'BENCHMARK_SERVICE=ACTIVE',
  ]) assert.equal(wrapper.includes(marker), true, marker);
  assert.match(wrapper, /FORWARD_RUNTIME_SECONDS=1500/);
  assert.match(wrapper, /RECOVERY_RUNTIME_SECONDS=900/);
  assert.match(productionWorkflow, /grep -Fx 'RUNTIME_REVISION_AFTER=119' controller\.output/);
});

test('R119F-BRIDGE-09 executable preflight accepts only exact R118/R119 cohorts', () => {
  const match = /node - "\$operation" "\$snapshot" "\$active" "\$sub" "\$pid" <<'NODE'\n([\s\S]*?)\n {10}NODE\n {10}if/.exec(
    productionWorkflow);
  assert.ok(match, 'embedded cohort verifier not found');
  const source = match[1].replace(/^ {10}/gm, '');
  const baselineHash = '81bb366d99550dffc2e78c16c869bb7da20c70473636c3ee1e95b9d8bf8382ae';
  const baseline = {
    revision: 118,
    residents: [
      { residency_id: 'resident:chronobiology',
        instance_id: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
        version: '1.0.0-c3rc.4', state_schema: 2, checkpoint_generation: 5118,
        checkpoint_hash: baselineHash, status: 'RESYNC_REQUIRED' },
      { residency_id: 'resident:sntss',
        instance_id: '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
        version: '0.5.0-i4g1', status: 'RUNNING' },
    ],
    consumers: [{ consumer_id: 'resident:chronobiology', required: 0, active: 0,
      cursor: 2341576, authority_epoch: 0, checkpoint_hash: baselineHash }],
    checkpoint: { instance_id: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
      version: '1.0.0-c3rc.4', state_schema: 2, generation: 5118,
      blob_hash: baselineHash, byte_length: 49287, input_cursor: 1636338 },
    repair: null, chronobiologyPending: 0, pendingOutbox: 0,
    sntssOutputs: 0, sntssAuthority: 0, chronobiologyAuthority: 0,
  };
  const repair = {
    repairId: 'chronobiology-c3r5-r118-bounded-catchup',
    instanceId: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
    sourceCheckpointId: '039d2b99-b950-4bab-beac-83f602b27be2',
    checkpointHash: baselineHash, checkpointByteLength: 49287,
    checkpointInputCursor: 1636338, consumerCursor: 2341576,
    biologicalStateChanged: false, checkpointBytesChanged: false,
    abandonedCount: 0, inventedBiologicalTime: false,
    authorityChanged: false, resourceLimitsChanged: false,
  };
  const run = (operation, snapshot, active, sub, pid) => spawnSync(
    process.execPath, ['-', operation, JSON.stringify(snapshot), active, sub, pid],
    { input: source, encoding: 'utf8' });
  assert.equal(run('harden-r119f', baseline, 'active', 'running', '100').status, 0);
  const leaking = structuredClone(baseline);
  leaking.chronobiologyPending = 1;
  assert.notEqual(run('harden-r119f', leaking, 'active', 'running', '100').status, 0);

  const repairedR118 = structuredClone(baseline);
  Object.assign(repairedR118.residents[0], {
    version: '1.0.0-c3rc.5', checkpoint_generation: 5119,
  });
  Object.assign(repairedR118.checkpoint, {
    version: '1.0.0-c3rc.5', generation: 5119,
  });
  repairedR118.repair = repair;
  assert.equal(run('recover-r119f', repairedR118, 'inactive', 'dead', '0').status, 0);

  const repairedR119 = structuredClone(repairedR118);
  const currentHash = 'b'.repeat(64);
  repairedR119.revision = 119;
  Object.assign(repairedR119.residents[0], {
    checkpoint_generation: 5120, checkpoint_hash: currentHash, status: 'RUNNING',
  });
  Object.assign(repairedR119.consumers[0], {
    active: 1, cursor: 2341586, checkpoint_hash: currentHash,
  });
  Object.assign(repairedR119.checkpoint, {
    generation: 5120, blob_hash: currentHash, byte_length: 49400,
    input_cursor: 2341586,
  });
  assert.equal(run('recover-r119f', repairedR119, 'active', 'running', '200').status, 0);
  repairedR119.checkpoint.input_cursor = 1636338;
  assert.notEqual(run('recover-r119f', repairedR119, 'active', 'running', '200').status, 0);
});

test('R119F-BRIDGE-10 extracted remote preflight executes through both nested verifiers',
  { skip: process.platform === 'win32' }, () => {
    const preflight = productionWorkflow.slice(
      productionWorkflow.indexOf('Exact read-only operation-fenced production preflight'),
      productionWorkflow.indexOf('Stage and invoke only the pinned root controller'));
    const match = /<<'REMOTE'\n([\s\S]*?)\n {10}REMOTE/.exec(preflight);
    assert.ok(match, 'remote preflight payload not found');
    const rawSource = match[1].replace(/^ {10}/gm, '');
    const baselineHash =
      '81bb366d99550dffc2e78c16c869bb7da20c70473636c3ee1e95b9d8bf8382ae';
    const snapshot = {
      revision: 118,
      residents: [
        { residency_id: 'resident:chronobiology',
          instance_id: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
          version: '1.0.0-c3rc.4', state_schema: 2, checkpoint_generation: 5118,
          checkpoint_hash: baselineHash, status: 'RESYNC_REQUIRED' },
        { residency_id: 'resident:sntss',
          instance_id: '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
          version: '0.5.0-i4g1', status: 'RUNNING' },
      ],
      consumers: [{ consumer_id: 'resident:chronobiology', required: 0, active: 0,
        cursor: 2341576, authority_epoch: 0, checkpoint_hash: baselineHash }],
      checkpoint: { instance_id: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
        version: '1.0.0-c3rc.4', state_schema: 2, generation: 5118,
        blob_hash: baselineHash, byte_length: 49287, input_cursor: 1636338 },
      repair: null, chronobiologyPending: 0, pendingOutbox: 0,
      sntssOutputs: 0, sntssAuthority: 0, chronobiologyAuthority: 0,
    };
    const meta = {
      ok: true, revision: 118, revisionFrozen: false, revisionLabel: 'R118',
      cores: [{ id: 'fetus-legacy', ok: true,
        memoryGuardian: { status: 'healthy', warnAtMiB: 192, recycleAtMiB: 256 } }],
      systems: [{ id: 'bsf', mode: 'LIVE', status: 'RUNNING', healthOk: true }],
    };
    const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-r119f-preflight-'));
    const fixtureRelease = path.join(fixtureDirectory, 'source-release');
    const sourceManifestRelative =
      'deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R116_TO_R118F.sha256';
    const sourceManifest = read(sourceManifestRelative);
    const absentPaths = new Set([
      'deploy/live-physiology-transplant/P1_PRODUCTION_HARDENING_R110F_TO_R111F.md',
      'deploy/live-physiology-transplant/P1_SNTSS_I4G_REHEARSAL_R105F.md',
      'deploy/live-physiology-transplant/P1_SNTSS_I4G_REHEARSAL_R105F.sha256',
      'deploy/live-physiology-transplant/p1-sntss-i4g-rehearsal.js',
      'deploy/live-physiology-transplant/p1-sntss-i4g-rehearsal.sh',
      'docs/sntss/R13_CONTINUITY_GENESIS_SHADOW.md',
      'test/p1-r118f-release-contract.test.js',
    ]);
    for (const record of sourceManifest.trimEnd().split('\n')) {
      const relative = record.split('  ./')[1];
      if (absentPaths.has(relative)) continue;
      const target = path.join(fixtureRelease, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'fixture');
    }
    for (const relative of [sourceManifestRelative,
      'P1_PRODUCTION_HARDENING_RELEASE.env', 'P1_R118F_RELEASE.env']) {
      const target = path.join(fixtureRelease, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, relative === sourceManifestRelative ? sourceManifest : 'fixture\n');
    }
    for (let index = 0; index < 387; index += 1) {
      const target = path.join(fixtureRelease, 'historical-source-fixture',
        `${String(index).padStart(3, '0')}.txt`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `historical-${index}\n`);
    }
    const source = rawSource.replaceAll(
      '/opt/stay/releases/0.8.11.3-p1m-r118f-chrono-repair-934069400d62',
      fixtureRelease);
    const stub = `#!/usr/bin/env bash
set -euo pipefail
case "$(basename "$0")" in
  ip) printf '%s\\n' '2: ens5 inet 172.26.9.207/20 scope global ens5' ;;
  sha256sum)
    if [[ "$#" -eq 0 ]]; then cat >/dev/null; printf '%s  -\n' "$FIXTURE_SOURCE_TREE_SHA"
    elif [[ "\${1:-}" == -c ]]; then cat "$2" >/dev/null
    elif [[ "$1" == *P1_PRODUCTION_HARDENING_R116_TO_R118F.sha256 ]]; then
      printf '%s  %s\\n' "$FIXTURE_SOURCE_MANIFEST_SHA" "$1"
    else printf '%s  %s\\n' "$FIXTURE_WRAPPER_SHA" "$1"
    fi ;;
  readlink) printf '%s\\n' "$FIXTURE_SOURCE_RELEASE" ;;
  systemctl)
    case "$*" in
      *'-p ActiveState'*) printf '%s\\n' active ;;
      *'-p SubState'*) printf '%s\\n' running ;;
      *'-p MainPID'*) printf '%s\\n' 123 ;;
      *'-p NRestarts'*) printf '%s\\n' 0 ;;
      *) exit 80 ;;
    esac ;;
  curl) printf '%s' "$FIXTURE_META" ;;
  node)
    if [[ "$1" == - && "$2" == /var/lib/stay/data/continuity.sqlite3 ]]; then
      cat >/dev/null
      printf '%s' "$FIXTURE_SNAPSHOT"
    elif [[ "$1" == */p1-resident-control-client.js && "$3" == resident:sntss ]]; then
      printf '%s' "$FIXTURE_SNTSS"
    elif [[ "$1" == */p1-resident-control-client.js && "$3" == resident:chronobiology ]]; then
      printf '%s' "$FIXTURE_CHRONOBIOLOGY"
    else
      exec "$REAL_NODE" "$@"
    fi ;;
  *) exit 81 ;;
esac
`;
    try {
      for (const command of ['ip', 'sha256sum', 'readlink', 'systemctl', 'curl', 'node']) {
        const target = path.join(fixtureDirectory, command);
        fs.writeFileSync(target, stub, { mode: 0o755 });
      }
      const run = () => spawnSync('bash', ['-s', '--', '172.26.9.207', wrapperSha256,
        'harden-r119f', '/opt/stay/releases/unused-r119f-target'], {
        input: source, encoding: 'utf8', env: {
          ...process.env,
          PATH: `${fixtureDirectory}${path.delimiter}${process.env.PATH}`,
          REAL_NODE: process.execPath,
          FIXTURE_WRAPPER_SHA: wrapperSha256,
          FIXTURE_SOURCE_MANIFEST_SHA:
            '129dd8aa818f211444cddcf79665745d2490718e45cc1b2aba32a375c0dfddd0',
          FIXTURE_SOURCE_TREE_SHA:
            'e8f8ab054b0c6510d3b24535fdc8f556a8c17df4acb2377621a8533becec3c8f',
          FIXTURE_SOURCE_RELEASE: fixtureRelease,
          FIXTURE_SNAPSHOT: JSON.stringify(snapshot),
          FIXTURE_META: JSON.stringify(meta),
          FIXTURE_SNTSS: JSON.stringify({ resident: { version: '0.5.0-i4g1',
            running: true, authorityOwned: false, observedOutputs: 0 } }),
          FIXTURE_CHRONOBIOLOGY: JSON.stringify({ resident: { version: '1.0.0-c3rc.4',
            status: 'RESYNC_REQUIRED', running: false, authorityOwned: false,
            observedOutputs: 0 } }),
        } });
      const result = run();
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /R119F_SOURCE_RELEASE_INVENTORY=PASS/);
      assert.match(result.stdout, /R119F_READ_ONLY_PREFLIGHT_HARDEN-R119F=PASS/);
      assert.match(result.stdout, /SERVICE_PID=123/);
      assert.match(result.stdout, /SERVICE_NRESTARTS=0/);
      fs.writeFileSync(path.join(fixtureRelease, 'unexpected-production-file'), 'fixture');
      const rejected = run();
      assert.notEqual(rejected.status, 0, 'extra installed source file passed the exact fence');
    } finally {
      fs.rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  });
