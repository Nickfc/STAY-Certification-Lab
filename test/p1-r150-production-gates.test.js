'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { inspectCoreModule } = require('../runtime/kernel/core-loader');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const { sealRevisionFreeze, validateRevisionFreeze } = require('../runtime/revision-freeze');
const { recordHash } = require('../runtime/p1-r0/records');
const { verifyHomeosNeutralBirthCertificate } = require(
  '../runtime/p1-r0/homeos-neutral-birth-authority');
const { verifyInteroNeutralBirthCertificate } = require(
  '../runtime/p1-r0/intero-neutral-birth-authority');
const { buildMaterials } = require('../tools/sign-p1-r0-expansion-birth');
const { verify } = require(
  '../deploy/live-physiology-transplant/p1-r150-verify-birth-certificate');
const { buildFreeze } = require(
  '../deploy/live-physiology-transplant/p1-r150-homeos-intero-freeze');

const ROOT = path.resolve(__dirname, '..');
const IDENTITY = Object.freeze({
  organismId: 'stay-r150-production-gate-test',
  createdAt: '2026-09-03T08:00:00.000Z',
  lineage: 'STAY/Genesis'
});
const MANIFEST = path.join(ROOT, 'deploy', 'live-physiology-transplant',
  'P1_PRODUCTION_HARDENING_R141F_TO_R150.sha256');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function parentFreeze(revision) {
  return sealRevisionFreeze({
    format: 'stay-runtime-revision-freeze-v1', result: 'PASS', acceptance: 'ACCEPTED',
    freezeType: `R${revision}_TEST_PARENT`,
    runtime: { revision, revisionLabel: `R${revision}F` }
  });
}
async function materials(coreId, revision) {
  const keys = crypto.generateKeyPairSync('ed25519');
  const nowMs = Date.now();
  const value = buildMaterials({
    coreId, releaseRoot: ROOT, identity: IDENTITY, parentFreeze: parentFreeze(revision),
    entropy: crypto.randomBytes(48).toString('hex'), privateKey: keys.privateKey,
    issuedAtMs: nowMs, validityMs: 3_600_000
  });
  return { ...value, keys, nowMs };
}

test('R150-PRODUCTION-01 offline founder signing is scoped, unique, and independently verifiable', async () => {
  const homeos = await materials('HOMEOS', 141);
  const intero = await materials('INTERO', 145);
  for (const [value, verifyCertificate] of [
    [homeos, verifyHomeosNeutralBirthCertificate],
    [intero, verifyInteroNeutralBirthCertificate]
  ]) {
    const inspectedDefinition = await inspectCoreModule(
      path.join(ROOT, value.config.moduleRelativePath));
    const contract = require(path.join(ROOT, value.config.contractRelativePath))[
      value.config.contractExport];
    const authorization = verifyCertificate(value.certificate, value.keys.publicKey, {
      inspected: {
        definition: inspectedDefinition, contract,
        manifestHash: `sha256:${sha256(stableStringify(inspectedDefinition.manifest))}`
      },
      identity: IDENTITY, runtimeRevision: value.config.targetRevision,
      parentFreezeRecordSha256: value.certificate.body.parentFreezeRecordSha256,
      nowMs: value.nowMs
    });
    assert.equal(authorization.founderDossierSha256, recordHash(value.dossier));
    assert.equal(value.dossier.noAuthority, true);
    assert.equal(value.dossier.productionOutputs, 0);
  }
  assert.notEqual(homeos.certificate.body.certificateId, intero.certificate.body.certificateId);
  assert.notEqual(intero.dossier.founderBinding.profile.noiseKeyHex, '0123456789abcdef');
  const forged = structuredClone(homeos.certificate);
  forged.body.targetRevision = 144;
  assert.throws(() => verifyHomeosNeutralBirthCertificate(forged, homeos.keys.publicKey, {
    inspected: {}, identity: IDENTITY, runtimeRevision: 144,
    parentFreezeRecordSha256: forged.body.parentFreezeRecordSha256, nowMs: homeos.nowMs
  }));
});

test('R150-PRODUCTION-02 real certificate preflight reads an exact database and real CoreHost module', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r150-preflight-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const value = await materials('HOMEOS', 141);
  const databaseFile = path.join(root, 'continuity.sqlite3');
  const freezeFile = path.join(root, 'R141.json');
  const certificateFile = path.join(root, 'homeos.json');
  const publicKeyFile = path.join(root, 'authority.pub');
  const database = new DatabaseSync(databaseFile);
  database.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,json TEXT NOT NULL,sha256 TEXT NOT NULL)');
  for (const [key, record] of [
    ['life:identity', IDENTITY], ['life:runtime-revision', { revision: 141 }]
  ]) {
    const json = stableStringify(record);
    database.prepare('INSERT INTO metadata(key,json,sha256) VALUES(?,?,?)')
      .run(key, json, sha256(json));
  }
  database.close();
  await fs.writeFile(freezeFile, `${JSON.stringify(parentFreeze(141))}\n`, { mode: 0o444 });
  await fs.writeFile(certificateFile, `${stableStringify(value.certificate)}\n`, { mode: 0o444 });
  await fs.writeFile(publicKeyFile, value.keys.publicKey.export({ type: 'spki', format: 'pem' }),
    { mode: 0o444 });
  const proof = await verify({
    coreId: 'HOMEOS', releaseRoot: ROOT, databaseFile, freezeFile, certificateFile,
    publicKeyFile, nowMs: value.nowMs
  });
  assert.equal(proof.result, 'PASS');
  assert.equal(proof.runtimeRevision, 141);
  assert.equal(proof.founderDossierSha256, recordHash(value.dossier));
  assert.equal(proof.authorityOwned, false);
});

test('R150-PRODUCTION-03 freeze seals immutable release, birth, recovery, and benchmark fences', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r150-freeze-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const value = await materials('HOMEOS', 141);
  const files = {
    'parent.freeze.json': parentFreeze(141),
    'before.proof.json': { result: 'PASS', revision: 141 },
    'after.proof.json': { result: 'PASS', revision: 146, abandonedDeliveries: 1 },
    'service.after.json': { afterPid: 22, afterRestarts: 0, restartCommands: 1 },
    'homeos.birth-certificate.json': value.certificate
  };
  for (const [name, record] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), `${JSON.stringify(record)}\n`);
  }
  await fs.writeFile(path.join(root, 'P1_R150_RELEASE.env'), [
    'RELEASE_PATH=/opt/stay/releases/0.8.11.3-p1r0-r150-homeos-intero-aaaaaaaaaaaa',
    'RELEASE_TAG=r150-homeos-intero-shadow-v1', `RELEASE_COMMIT=${'a'.repeat(40)}`,
    `RELEASE_TREE=${'b'.repeat(40)}`, `ARCHIVE_SHA256=sha256:${'c'.repeat(64)}`,
    `MANIFEST_SHA256=sha256:${'d'.repeat(64)}`, `CONTROLLER_SHA256=sha256:${'e'.repeat(64)}`
  ].join('\n') + '\n');
  const freeze = buildFreeze('homeos', root);
  assert.equal(validateRevisionFreeze(freeze, 146), true);
  assert.equal(freeze.promotionAuthority.unitDropinRevoked, true);
  assert.equal(freeze.promotionAuthority.activeCertificateRemoved, true);
  assert.equal(freeze.promotionAuthority.privateSigningKeyOnHost, false);
  assert.equal(freeze.benchmark.started, false);
});

test('R150-PRODUCTION-04 forward and recovery entry paths retain exact hard gates', async () => {
  const forward = await fs.readFile(path.join(ROOT,
    'deploy/live-physiology-transplant/p1-r150-homeos-intero-forward.sh'), 'utf8');
  const recovery = await fs.readFile(path.join(ROOT,
    'deploy/live-physiology-transplant/p1-r150-homeos-intero-forward-recovery.sh'), 'utf8');
  const server = await fs.readFile(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(recovery,
    /STAY_HOMEOS_STRANDED_R146_RECOVERY_AUTHORIZATION=AUTHORIZE_STRANDED_R146_METAB_Q48_HOMEOS_FORWARD_RECOVERY_ONLY/);
  assert.match(recovery,
    /STAY_HOMEOS_STRANDED_R147_RECOVERY_AUTHORIZATION=AUTHORIZE_STRANDED_R147_HOMEOS_CONTINUATION_RECOVERY_ONLY/);
  assert.match(recovery,
    /R147_HOMEOS_FAILURE_EVIDENCE='\/var\/lib\/stay\/evidence\/production-hardening\/FAILED-R147-HOMEOS-R147-RECOVERY-20260904T190412Z\.o7ctIx'/);
  assert.match(recovery,
    /METAB_REPAIR='deploy\/live-physiology-transplant\/p1-r146-metab-q48-implementation-repair\.js'/);
  for (const exact of [
    "PREVIOUS_HOMEOS_TARGET='/opt/stay/releases/0.8.11.3-p1r0-r150-homeos-intero-8421f172c6f8'",
    "PREVIOUS_HOMEOS_TAG='r150-homeos-intero-shadow-v11'",
    "PREVIOUS_HOMEOS_COMMIT='10618886fb1cf20fb4a0b69171a8e0f191a2f7fe'",
    "PREVIOUS_HOMEOS_TREE='ccd673eeecef8a7c95842129ce455120eeabbf9b'",
    "PREVIOUS_HOMEOS_ARCHIVE_SHA256='sha256:748c43093083f35c0ff91bf9199cb966486ecafa79d48c510fc28e6009d01d3b'",
    "PREVIOUS_HOMEOS_MANIFEST_SHA256='sha256:8421f172c6f84f69bd5ff9ad746cc931baa1d22c0866037e3ca5b89d52a956e0'",
    "PREVIOUS_HOMEOS_CONTROLLER_SHA256='sha256:de0bab3adc6f0cc37e10b7ac420570017b18959fac3f1bad40f7d6afbebff753'",
    "marker_cohort='EXACT_PREVIOUS_HOMEOS_FAILURE'"
  ]) assert.ok(recovery.includes(exact), exact);
  for (const exact of [
    "ORIGINAL_HOMEOS_FAILURE_TARGET='/opt/stay/releases/0.8.11.3-p1r0-r150-homeos-intero-418c80c33029'",
    "ORIGINAL_HOMEOS_FAILURE_TAG='r150-homeos-intero-shadow-v3'",
    "ORIGINAL_HOMEOS_FAILURE_COMMIT='b21e56776be8a0954ef1af34bd28c13d6e03dd5d'",
    "ORIGINAL_HOMEOS_FAILURE_TREE='3f4864991e8454cdc2fedae11fe448677c84d706'",
    "ORIGINAL_HOMEOS_FAILURE_ARCHIVE_SHA256='sha256:183887ece2eec09358e13c8a8effa80d98551d76e0b208ae5f90272e34f07e5e'",
    "ORIGINAL_HOMEOS_FAILURE_MANIFEST_SHA256='sha256:418c80c33029f9e2e2920c999e262cf3fea259630a2b378e4258f13833d3735d'",
    "ORIGINAL_HOMEOS_FAILURE_CONTROLLER_SHA256='sha256:f70cb15c890d396ba6013e3747e464d8a297bd3add5eb958b9c3d693a1a6d404'",
    "ORIGINAL_HOMEOS_FAILURE_EVIDENCE='/var/lib/stay/evidence/production-hardening/FAILED-R145-HOMEOS-20260903T201401Z.qIMbPE'",
    "ORIGINAL_HOMEOS_FAILURE_CERTIFICATE_SHA256='sha256:a4a4c8d215d625cf5694a33f246a1953049846ad60e08959c65463fbb03ec31c'",
    "marker_cohort='EXACT_ORIGINAL_HOMEOS_FAILURE'"
  ]) assert.ok(recovery.includes(exact), exact);
  assert.match(recovery, /ExecStartPre=.*\$METAB_REPAIR apply/);
  assert.ok(server.indexOf('await kernel.recoverStrandedR145Homeos();') <
    server.indexOf('await kernel.installCore(process.env.STAY_BOOT_CORE);'));
  for (const source of [forward, recovery]) {
    assert.match(source, /EXPECTED_PRIVATE_IPV4='172\.26\.9\.207'/);
    assert.match(source, /P1_PRODUCTION_HARDENING_R141F_TO_R150\.sha256/);
    assert.match(source, /handlerTimeoutMs|PROOF/);
    assert.match(source, /stay-physiology-benchmark-v3\.service/);
    assert.doesNotMatch(source, /benchmark-start|systemctl start stay-physiology-benchmark/);
  }
  assert.match(forward, /seq 1 20/);
  assert.match(forward, /sleep 0\.25/);
  assert.match(recovery, /seq 1 100/);
  assert.match(recovery, /sleep 0\.75/);
  assert.match(recovery, /TARGET_REVISION=147/);
  assert.doesNotMatch(recovery, /handlerTimeoutMs=|hardRamBytes=|hardCpuDuty=/);
  assert.match(forward, /RESTART_COMMITTED=1\s*\nsystemctl restart stay\.service/);
  assert.match(forward, /point_current "\$SOURCE_RELEASE"/);
  assert.match(recovery, /durable-revision-outside-recovery-fence/);
  assert.doesNotMatch(recovery, /point_current/);
  assert.match(recovery,
    /-S "\$SOCKET" && ! -L "\$SOCKET" \]\] &&\s*curl --fail --silent --max-time 1 http:\/\/127\.0\.0\.1:8787\/healthz \|\s*grep -q "\\"revision\\":\$TARGET_REVISION"; then\s*need_restart=0/);
  for (const token of [
    'AUTHORIZE_R143_HOMEOS_NEUTRAL_BIRTH_ONLY',
    'AUTHORIZE_R144_METAB_HOMEOS_ROUTE_ONLY',
    'AUTHORIZE_R145_HOMEOS_OUTPUT_FIREWALLED_SHADOW_ONLY',
    'AUTHORIZE_R147_INTERO_NEUTRAL_BIRTH_ONLY',
    'AUTHORIZE_R148_METAB_INTERO_ROUTE_ONLY',
    'AUTHORIZE_R149_HOMEOS_INTERO_ROUTE_ONLY',
    'AUTHORIZE_R150_INTERO_PERCEPTION_ONLY_SHADOW_ONLY'
  ]) assert.match(forward, new RegExp(token));

  const repair = await fs.readFile(path.join(ROOT,
    'deploy/live-physiology-transplant/p1-r146-metab-q48-implementation-repair.js'), 'utf8');
  const kernel = await fs.readFile(path.join(ROOT, 'runtime/kernel/living-kernel.js'), 'utf8');
  const manager = await fs.readFile(path.join(ROOT, 'runtime/kernel/resident-manager.js'), 'utf8');
  const store = await fs.readFile(path.join(ROOT, 'runtime/kernel/state-store.js'), 'utf8');
  const homeos = await fs.readFile(path.join(ROOT,
    'runtime/p1-r0/residents/homeos-shadow.js'), 'utf8');
  assert.match(`${repair}\n${kernel}\n${store}\n${homeos}`,
    /homeos-r146-route-boundary-continuity-v1/);
  assert.match(homeos, /repairExactR146RouteBoundaryState/);
  assert.match(store, /beginExactR146HomeosBacklogReplay/);
  assert.match(store, /beginExactR147ContinuationBacklogReplay/);
  assert.match(manager, /exactR146HomeosBacklog/);
  assert.match(manager, /exactR147ContinuationBacklog/);
  assert.match(kernel, /r146-fetus-empty-input-continuity-v1/);
  assert.match(repair, /pendingSequences: Object\.freeze\(\[4241117, 4241118\]\)/);
  assert.match(repair, /PRAGMA query_only=ON; BEGIN/);
});

test('R150-PRODUCTION-05 every new production generation passes the real Bubblewrap entry path', {
  skip: process.platform !== 'linux' || !fsSync.existsSync(
    process.env.STAY_BWRAP || '/usr/bin/bwrap')
}, async () => {
  const previousRequired = process.env.STAY_REQUIRE_OS_CORE_SANDBOX;
  const previousBwrap = process.env.STAY_BWRAP;
  process.env.STAY_REQUIRE_OS_CORE_SANDBOX = '1';
  process.env.STAY_BWRAP = previousBwrap || '/usr/bin/bwrap';
  try {
    for (const generation of [
      'homeos-neutral', 'metab-homeos', 'homeos-shadow', 'intero-neutral',
      'metab-intero', 'homeos-intero', 'intero-shadow'
    ]) {
      const inspected = await inspectCoreModule(
        path.join(ROOT, 'cores', 'p1-r0', generation, 'index.js'));
      assert.equal(inspected.sandboxed, true, generation);
    }
  } finally {
    if (previousRequired === undefined) delete process.env.STAY_REQUIRE_OS_CORE_SANDBOX;
    else process.env.STAY_REQUIRE_OS_CORE_SANDBOX = previousRequired;
    if (previousBwrap === undefined) delete process.env.STAY_BWRAP;
    else process.env.STAY_BWRAP = previousBwrap;
  }
});

test('R150-PRODUCTION-06 immutable overlay inventory is sorted, safe, unique, and exact', () => {
  const entries = new Map();
  const lines = fsSync.readFileSync(MANIFEST, 'utf8').trim().split(/\r?\n/);
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  \.\/([A-Za-z0-9._/-]+)$/.exec(line);
    assert.ok(match, line);
    assert.equal(entries.has(match[2]), false, `duplicate ${match[2]}`);
    assert.equal(path.posix.normalize(match[2]), match[2]);
    assert.equal(path.posix.isAbsolute(match[2]), false);
    assert.equal(match[2].startsWith('../'), false);
    entries.set(match[2], match[1]);
  }
  assert.deepEqual([...entries.keys()], [...entries.keys()].toSorted());
  assert.equal(entries.size, 81);
  for (const required of [
    'runtime/kernel/hardened-living-kernel.js',
    'runtime/kernel/living-kernel.js', 'runtime/kernel/resident-manager.js',
    'runtime/kernel/state-store.js', 'runtime/p1-r0/production-persistence.js',
    'runtime/p1-r0/deterministic-noise.js',
    'runtime/p1-r0/homeos-contract.js', 'runtime/p1-r0/homeos-contract.json',
    'runtime/p1-r0/homeos-engine.js',
    'runtime/p1-r0/intero-contract.js', 'runtime/p1-r0/intero-contract.json',
    'runtime/p1-r0/intero-engine.js',
    'server.js', 'deploy/live-physiology-transplant/p1-r150-homeos-intero-forward.sh',
    'deploy/live-physiology-transplant/p1-r150-homeos-intero-forward-recovery.sh',
    'deploy/live-physiology-transplant/p1-r147-homeos-continuation-preflight.js',
    'deploy/live-physiology-transplant/p1-r150-homeos-intero-live-proof.js',
    'deploy/live-physiology-transplant/p1-r146-metab-q48-implementation-repair.js',
    'test/biological-ledger.test.js', 'test/p1-r145-homeos-shadow.test.js',
    'test/p1-r146-metab-q48-implementation-repair.test.js',
    'test/p1-r147-continuation-recovery.test.js',
    'test/p1-r150-production-gates.test.js'
  ]) assert.equal(entries.has(required), true, required);
  for (const [relative, expected] of entries) {
    assert.equal(sha256(fsSync.readFileSync(path.join(ROOT, relative))), expected, relative);
  }
});

test('R150-PRODUCTION-06A clean R141-shaped overlay resolves every promoted resident module', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r150-clean-overlay-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const overlay = fsSync.readFileSync(MANIFEST, 'utf8').trim().split(/\r?\n/)
    .map(line => line.match(/^([0-9a-f]{64})  \.\/([A-Za-z0-9._/-]+)$/)[2]);
  const r141Base = [
    'runtime/kernel/biological-envelope.js',
    'runtime/kernel/canonical-json.js',
    'runtime/p1-r0/causal-frame.js',
    'runtime/p1-r0/contract-registry.js',
    'runtime/p1-r0/metab-engine.js',
    'runtime/p1-r0/q16-48.js',
    'runtime/p1-r0/resident-support.js',
    'runtime/p1-r0/residents/metab-neutral.js',
    'runtime/p1-r0/residents/metab-shadow.js'
  ];
  for (const relative of [...new Set([...r141Base, ...overlay])]) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(ROOT, relative), target);
  }
  for (const relative of [
    'runtime/p1-r0/residents/homeos-neutral.js',
    'runtime/p1-r0/residents/homeos-shadow.js',
    'runtime/p1-r0/residents/metab-homeos.js',
    'runtime/p1-r0/residents/homeos-intero.js',
    'runtime/p1-r0/residents/intero-neutral.js',
    'runtime/p1-r0/residents/intero-shadow.js',
    'runtime/p1-r0/residents/metab-intero.js'
  ]) {
    assert.doesNotThrow(() => require(path.join(root, relative)), relative);
  }
});

test('R150-PRODUCTION-07 shell and every embedded JavaScript entry block parse', () => {
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
    : 'bash';
  for (const relative of [
    'deploy/live-physiology-transplant/p1-r150-homeos-intero-forward.sh',
    'deploy/live-physiology-transplant/p1-r150-homeos-intero-forward-recovery.sh'
  ]) {
    const file = path.join(ROOT, relative);
    const source = fsSync.readFileSync(file, 'utf8');
    const shell = spawnSync(bash, ['-n', file], { encoding: 'utf8' });
    assert.equal(shell.status, 0, `${shell.stdout}\n${shell.stderr}`);
    const blocks = [...source.matchAll(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/g)];
    assert.ok(blocks.length >= 4, relative);
    for (const block of blocks) {
      const parsed = spawnSync(process.execPath, ['--check', '-'], {
        input: block[1], encoding: 'utf8'
      });
      assert.equal(parsed.status, 0, `${relative}\n${parsed.stdout}\n${parsed.stderr}`);
    }
    assert.doesNotMatch(source,
      /TimeoutStartSec|TimeoutStopSec|CPUQuota=|MemoryMax=|PIDsMax=|git reset|git checkout|sqlite3\s+.*(?:DELETE|UPDATE)/);
  }
});
