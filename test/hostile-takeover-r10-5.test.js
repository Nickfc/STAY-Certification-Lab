'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { makeKernel } = require('./helpers');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const packagePolicy = require('../runtime/kernel/package-policy');
const sandbox = require('../runtime/kernel/core-sandbox');
const promotion = require('../runtime/kernel/promotion-authority');
const trustedRelease = require('../deploy/trusted-release-verifier');
const { FORENSIC_READ_CAPABILITY, hash, verifyForensicBundle, SntssObservabilityPlane } = require('../runtime/kernel/sntss-observability');

const root = path.resolve(__dirname, '..');
const neutralPath = path.join(root, 'cores/sntss/neutral/index.js');
const HASH = /^sha256:[0-9a-f]{64}$/;

function sign(body, privateKey, format) {
  return { format, body, signature: crypto.sign(null, Buffer.from(stableStringify(body)), privateKey).toString('base64') };
}
function neutralDefinition() {
  delete require.cache[require.resolve(neutralPath)];
  const manifest = require(neutralPath).manifest;
  const record = packagePolicy.enforcePackagePolicy(neutralPath);
  return { modulePath: fs.realpathSync.native(neutralPath), manifest, packagePolicy: record.policy };
}

async function releaseFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stay-r105-release-'));
  await fsp.writeFile(path.join(dir, 'hello.txt'), 'hello\n');
  const bytes = await fsp.readFile(path.join(dir, 'hello.txt'));
  const entries = [{ path: 'hello.txt', bytes: bytes.length, sha256: trustedRelease.sha256(bytes), role: 'runtime-source' }];
  const inventoryBody = { format: 'stay-release-inventory-v1', entries };
  const inventory = { ...inventoryBody, inventoryHash: trustedRelease.sha256(trustedRelease.stableStringify(inventoryBody)) };
  const dependencies = {};
  const provenanceBody = {
    format: 'stay-release-provenance-v2', version: '0.8.11.3', commit: 'a'.repeat(40), builder: 'test', branch: 'candidate', workflow: null, runId: null,
    stateRollbackPolicy: 'preserve-forward-state', releaseMutable: false, productionEligible: false,
    inventoryHash: inventory.inventoryHash, dependencyInventoryHash: trustedRelease.sha256(trustedRelease.stableStringify(dependencies)), sntss: {}
  };
  const provenance = { ...provenanceBody, provenanceHash: trustedRelease.sha256(trustedRelease.stableStringify(provenanceBody)), dependencies };
  await fsp.writeFile(path.join(dir, 'RELEASE_INVENTORY.json'), JSON.stringify(inventory, null, 2) + '\n');
  await fsp.writeFile(path.join(dir, 'RELEASE_PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n');
  return { dir, inventory, provenance };
}

function forensicTransition(index) {
  return {
    transitionId: `r105-transition-${index}`, observedAtMs: 1000 + index,
    input: { eventId: `r105-event-${index}`, sequence: index, topic: 'presence.changed', status: 'accepted', reasonCode: 'SNTSS_ACCEPTED' },
    beforeStateHash: hash({ before: index }), afterStateHash: hash({ after: index }), clamps: [], circuitChanges: [], migrations: [], emittedFrameIds: [],
    evidenceCursor: index, profileHash: hash({ profile: 'r105' }), candidateVersion: '0.1.0', checkpointHash: hash({ checkpoint: index }), auditHeadHash: hash({ audit: index })
  };
}

test('R10.5-01 deployment never executes a candidate-controlled verifier as root', () => {
  const deployer = fs.readFileSync(path.join(root, 'deploy/stay-deploy.sh'), 'utf8');
  assert.match(deployer, /TRUSTED_VERIFIER="\/usr\/local\/lib\/stay\/trusted-release-verifier\.js"/);
  assert.match(deployer, /CRITICAL TRUST ORDER: no candidate JavaScript has executed/);
  assert.doesNotMatch(deployer, /"\$WORK\/runtime\/release\/sntss-release-control\.js"\s+verify/);
  assert.ok(deployer.indexOf('"$NODE" "$TRUSTED_VERIFIER" verify') < deployer.indexOf('continuity-check.js'));
});

test('R10.5-02 release authorization is external Ed25519 authority and tamper fails closed', async t => {
  const fixture = await releaseFixture(); t.after(() => fsp.rm(fixture.dir, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const archiveSha256 = trustedRelease.sha256('fake-archive-bytes');
  const body = {
    allowedActions: ['activate'], archiveSha256, authorizationClass: 'release-activation', commit: 'a'.repeat(40),
    inventoryHash: fixture.inventory.inventoryHash, issuedAtMs: 1000, nonce: '0123456789abcdef0123456789abcdef',
    provenanceHash: fixture.provenance.provenanceHash, version: '0.8.11.3', expiresAtMs: 5000
  };
  const record = sign(body, privateKey, 'stay-release-authorization-v1');
  assert.equal(trustedRelease.verifyAuthorization(record, publicKey, { action: 'activate', archiveSha256, inventoryHash: body.inventoryHash, provenanceHash: body.provenanceHash, version: body.version, commit: body.commit }, 2000).commit, body.commit);
  const tampered = structuredClone(record); tampered.body.commit = 'b'.repeat(40);
  assert.throws(() => trustedRelease.verifyAuthorization(tampered, publicKey, { action: 'activate', archiveSha256 }, 2000), /mismatch|signature/i);
});

test('R10.5-03 trusted release verifier reproduces candidate bytes without importing candidate code', async t => {
  const fixture = await releaseFixture(); t.after(() => fsp.rm(fixture.dir, { recursive: true, force: true }));
  assert.equal(await trustedRelease.verifyInventory(fixture.dir, fixture.inventory), fixture.inventory.inventoryHash);
  assert.equal(trustedRelease.verifyProvenance(fixture.provenance, fixture.inventory.inventoryHash, '0.8.11.3', 'a'.repeat(40)), fixture.provenance.provenanceHash);
  await fsp.appendFile(path.join(fixture.dir, 'hello.txt'), 'tamper');
  await assert.rejects(() => trustedRelease.verifyInventory(fixture.dir, fixture.inventory));
  const verifierSource = fs.readFileSync(path.join(root, 'deploy/trusted-release-verifier.js'), 'utf8');
  assert.doesNotMatch(verifierSource, /require\([^)]*WORK|require\([^)]*root/i);
});

test('R10.5-04 SNTSS package policy is mandatory, including the neutral core', () => {
  const record = packagePolicy.enforcePackagePolicy(neutralPath);
  assert.equal(record.policy.coreId, 'sntss'); assert.equal(record.policy.ambientCapabilities.network, false); assert.equal(record.policy.bounds.productionOutputs, 0);
  assert.equal(packagePolicy.verifyManifestAgainstPackagePolicy(record, require(neutralPath).manifest), true);
  assert.throws(() => packagePolicy.verifyManifestAgainstPackagePolicy(null, require(neutralPath).manifest), error => error.code === 'CORE_PACKAGE_POLICY_REQUIRED');
});

test('R10.5-05 source policy catches simple require aliasing and arbitrary package-root escape', async t => {
  assert.throws(() => packagePolicy.auditSourceText("const load = require; load('node:fs')", []), error => error.code === 'CORE_PACKAGE_DEPENDENCY_DENIED');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stay-r105-policy-')); t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const pkg = path.join(dir, 'pkg'); await fsp.mkdir(pkg); await fsp.writeFile(path.join(pkg, 'index.js'), "module.exports={manifest:{}};\n"); await fsp.writeFile(path.join(dir, 'evil.js'), 'module.exports=1;\n');
  const body = {
    allowedBuiltins: [], ambientCapabilities: { filesystemWrite: false, network: false, processSpawn: false }, bounds: {}, coreId: 'test', diagnostics: false,
    entrypoint: 'index.js', environmentAllowlist: ['LANG','LC_ALL','NODE_ENV','PATH','STAY_COREHOST','TZ'], formatVersion: 1,
    files: { 'index.js': packagePolicy.digest(await fsp.readFile(path.join(pkg, 'index.js'))), '../evil.js': packagePolicy.digest(await fsp.readFile(path.join(dir, 'evil.js'))) },
    resourceContract: { manifestResources: {} }
  };
  await fsp.writeFile(path.join(pkg, 'package-policy.json'), JSON.stringify({ ...body, policyHash: packagePolicy.digest(stableStringify(body)) }, null, 2));
  assert.throws(() => packagePolicy.enforcePackagePolicy(path.join(pkg, 'index.js')), error => error.code === 'CORE_PACKAGE_PATH_DENIED');
});

test('R10.5-06 hostile native core worker is planned into empty network/PID/user namespace with no StateStore mount', () => {
  const plan = sandbox.sandboxWorkerPlan(neutralPath);
  const text = [plan.executable, ...plan.args].join(' ');
  assert.match(text, /--unshare-all/); assert.match(text, /--disable-userns/); assert.match(text, /--cap-drop ALL/);
  assert.doesNotMatch(text, /--share-net/); assert.doesNotMatch(text, /\/var\/lib\/stay/); assert.doesNotMatch(text, /\/opt\/stay\/current/);
  assert.match(text, /--ro-bind .* \/stay-release/); assert.equal(plan.networkShared, false); assert.equal(plan.stateStoreVisible, false);
});

test('R10.5-07 trusted CoreHost supervisor does not require candidate code in its own process', () => {
  const dispatcher = fs.readFileSync(path.join(root, 'runtime/core-host/host.js'), 'utf8');
  const supervisor = fs.readFileSync(path.join(root, 'runtime/core-host/sandbox-host.js'), 'utf8');
  const worker = fs.readFileSync(path.join(root, 'runtime/core-host/worker.js'), 'utf8');
  assert.match(dispatcher, /STAY_REQUIRE_OS_CORE_SANDBOX/);
  assert.doesNotMatch(supervisor, /require\(absolute\)|require\(modulePath\)|require\(payload\.modulePath\)/);
  assert.match(supervisor, /spawnCoreWorker/); assert.match(worker, /const coreModule = require\(absolute\)/);
  assert.match(supervisor, /currentEvent/); assert.match(supervisor, /Core worker output has no causal event/);
});

test('R10.5-08 production unit requires OS sandbox, signed promotion, mandatory policy and empty capability set', () => {
  const service = fs.readFileSync(path.join(root, 'deploy/systemd/stay.service'), 'utf8');
  assert.match(service, /^Environment=STAY_REQUIRE_OS_CORE_SANDBOX=1$/m); assert.match(service, /^Environment=STAY_REQUIRE_CORE_PACKAGE_POLICY=1$/m);
  assert.match(service, /^Environment=STAY_REQUIRE_CORE_PROMOTION_CERT=1$/m); assert.match(service, /^RestrictNamespaces=false$/m);
  assert.match(service, /^CapabilityBoundingSet=$/m); assert.match(service, /^AmbientCapabilities=$/m); assert.match(service, /^ReadWritePaths=\/var\/lib\/stay\/data$/m);
});

test('R10.5-09 Kernel-owned promotion certificate binds exact organism, package, manifest and module', () => {
  const definition = neutralDefinition();
  const identity = { organismId: 'stay-r105', createdAt: '2026-08-16T00:00:00.000Z', lineage: 'STAY/Genesis' };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const body = {
    allowedActions: ['install'], allowedInputs: [...definition.manifest.inputs], allowedOutputs: [], authorizationClass: 'sntss-neutral-install', certificateId: 'certificate-0123456789abcdef',
    coreId: 'sntss', expiresAtMs: 5000, issuedAtMs: 1000, manifestHash: promotion.manifestHash(definition), moduleHash: promotion.moduleHash(definition),
    organismId: identity.organismId, organismIdentityHash: promotion.identityHash(identity), packagePolicyHash: definition.packagePolicy.policyHash, r11CertificationHash: null, version: definition.manifest.version
  };
  const record = sign(body, privateKey, promotion.FORMAT);
  assert.equal(promotion.verifyPromotionCertificate(record, publicKey, { definition, action: 'install', identity, nowMs: 2000 }).ok, true);
  const forged = structuredClone(record); forged.body.allowedOutputs = ['chemistry.frame'];
  assert.throws(() => promotion.verifyPromotionCertificate(forged, publicKey, { definition, action: 'install', identity, nowMs: 2000 }));
});

test('R10.5-10 pre-R11 SNTSS certificate cannot authorize biological output or active laboratory chemistry', () => {
  const base = neutralDefinition(); const identity = { organismId: 'stay-r105', createdAt: '2026-08-16T00:00:00.000Z', lineage: 'STAY/Genesis' };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const definition = { ...base, manifest: { ...base.manifest, version: '0.1.0', stage: 'laboratory-r7', productionEligible: false, outputs: ['sntss.modulation.frame'] } };
  const common = {
    allowedInputs: [...definition.manifest.inputs], allowedOutputs: [...definition.manifest.outputs], certificateId: 'certificate-abcdef0123456789', coreId: 'sntss',
    expiresAtMs: 5000, issuedAtMs: 1000, manifestHash: promotion.manifestHash(definition), moduleHash: promotion.moduleHash(definition), organismId: identity.organismId,
    organismIdentityHash: promotion.identityHash(identity), packagePolicyHash: definition.packagePolicy.policyHash, r11CertificationHash: null, version: definition.manifest.version
  };
  const shadow = sign({ ...common, allowedActions: ['stage'], authorizationClass: 'sntss-shadow-evaluation' }, privateKey, promotion.FORMAT);
  assert.throws(() => promotion.verifyPromotionCertificate(shadow, publicKey, { definition, action: 'stage', identity, nowMs: 2000 }), error => error.code === 'SNTSS_PROMOTION_SHADOW_ONLY');
  const active = sign({ ...common, allowedActions: ['commit'], authorizationClass: 'sntss-r11-certified-activation', r11CertificationHash: hash({ r11: true }) }, privateKey, promotion.FORMAT);
  assert.throws(() => promotion.verifyPromotionCertificate(active, publicKey, { definition, action: 'commit', identity, nowMs: 2000 }), error => error.code === 'SNTSS_PROMOTION_R11_REQUIRED');
});

test('R10.5-11 generic Kernel publish cannot forge authoritative producer provenance', async t => {
  const { kernel, dataDir } = await makeKernel(); t.after(async () => { if (kernel.stateStore.db) await kernel.stop().catch(() => {}); await fsp.rm(dataDir, { recursive: true, force: true }); });
  await assert.rejects(() => kernel.publish('test.event', {}, { sourceCore: 'living-kernel' }), error => error.code === 'EVENT_PROVENANCE_RESERVED');
  await assert.rejects(() => kernel.publish('test.event', {}, { authorityEpoch: 999 }), error => error.code === 'EVENT_PROVENANCE_RESERVED');
  const event = await kernel.publish('test.event', {}, { eventClass: 'best-effort' }); assert.equal(event.topic, 'test.event');
});

test('R10.5-12 forensic rotation remains monotonic after retained segment capacity is exceeded', () => {
  const anchor = hash({ r105: 'anchor' }); const plane = new SntssObservabilityPlane({ anchorHash: anchor, forensicCapacity: 8, segmentCapacity: 2 });
  for (let index = 1; index <= 34; index += 1) assert.equal(plane.capture(forensicTransition(index)).captured, true);
  const bundle = plane.forensicBundle(FORENSIC_READ_CAPABILITY);
  assert.equal(bundle.segments.length, 2); assert.ok(bundle.retainedSegmentIndex >= 2); assert.ok(bundle.segmentHighWater > bundle.segments.length);
  assert.equal(bundle.segments[0].segmentIndex, bundle.retainedSegmentIndex + 1); assert.equal(verifyForensicBundle(bundle, { expectedAnchorHash: anchor, expectedCount: 34 }).ok, true);
});

test('R10.5-13 required-consumer retention debt is bounded by quarantine rather than unbounded Kernel storage', async t => {
  const { kernel, dataDir } = await makeKernel(); t.after(async () => { if (kernel.stateStore.db) await kernel.stop().catch(() => {}); await fsp.rm(dataDir, { recursive: true, force: true }); });
  kernel.stateStore.registerBiologicalConsumer({ consumerId: 'core:stalled', coreId: 'stalled', topics: ['debt.event'], required: true, authorityEpoch: 1 });
  for (let index = 0; index < 9; index += 1) await kernel.publish('debt.event', { index }, { eventClass: 'durable', deduplicationKey: `r105-debt-${index}` });
  const result = kernel.governBiologicalRetentionDebt(8);
  assert.equal(result.demotedConsumers.length, 1); assert.equal(result.demotedConsumers[0].coreId, 'stalled');
  const consumer = kernel.stateStore.getBiologicalConsumer('core:stalled'); assert.equal(consumer.active, false); assert.equal(consumer.required, false);
  assert.ok(kernel.stateStore.db.prepare("SELECT COUNT(*) AS count FROM recovery_records WHERE type='biological.consumer-demoted' AND core_id='stalled'").get().count >= 1);
});

test('R10.5-14 retention-debt quarantine cannot silently reactivate without explicit biological resynchronization', async t => {
  const { kernel, dataDir } = await makeKernel(); t.after(async () => { if (kernel.stateStore.db) await kernel.stop().catch(() => {}); await fsp.rm(dataDir, { recursive: true, force: true }); });
  const at = new Date().toISOString();
  kernel.stateStore.db.prepare('INSERT INTO recovery_records(type, core_id, detail_json, created_at) VALUES(?, ?, ?, ?)').run('biological.consumer-demoted', 'test-counter', '{}', at);
  const fixture = path.join(root, 'test/fixtures/cores/counter-v1.js');
  await assert.rejects(() => kernel.installCore(fixture), error => error.code === 'BIOLOGICAL_RESYNC_REQUIRED');
});

test('R10.5-15 private signing keys are not release artifacts and trusted-boundary installer only accepts a public key', () => {
  const installer = fs.readFileSync(path.join(root, 'deploy/install-trusted-boundary.sh'), 'utf8');
  assert.match(installer, /release-authority-public\.pem/); assert.doesNotMatch(installer, /private[-_ ]key/i);
  const signer = fs.readFileSync(path.join(root, 'tools/sign-release-authorization.js'), 'utf8'); assert.match(signer, /--private-key/);
  const deployer = fs.readFileSync(path.join(root, 'deploy/stay-deploy.sh'), 'utf8'); assert.doesNotMatch(deployer, /--private-key/);
});
