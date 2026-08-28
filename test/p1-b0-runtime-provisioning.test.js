'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { LivingKernel } = require('../runtime');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const { StateStore } = require('../runtime/kernel/state-store');
const { identityHash, certificateFileName } = require('../runtime/kernel/resident-promotion-authority');
const { request } = require('../deploy/live-physiology-transplant/p1-b0-state');
const { verifyPromotion } = require('../deploy/live-physiology-transplant/p1-surgery-b-state');
const { waitForRuntimeReady } = require('../deploy/live-physiology-transplant/p1-b0-runtime-ready');
const ROOT = path.resolve(__dirname, '..');

test('P1-B0-01 fixed control path provisions trust/runtime only at certified 25 ms cadence', () => {
  const preflight = fs.readFileSync(path.join(ROOT, 'deploy/live-physiology-transplant/p1-b0-preflight.sh'), 'utf8');
  const configure = fs.readFileSync(path.join(ROOT, 'deploy/live-physiology-transplant/p1-b0-configure.sh'), 'utf8');
  const rollback = fs.readFileSync(path.join(ROOT, 'deploy/live-physiology-transplant/p1-b0-rollback.sh'), 'utf8');
  assert.match(preflight, /RUNTIME_REVISION=52/);
  assert.match(configure, /STAY_TRUSTED_TIME_PULSE_INTERVAL_MS=25/);
  assert.match(configure, /CapabilityBoundingSet=CAP_SETGID CAP_SETUID CAP_NET_ADMIN CAP_SYS_CHROOT CAP_SYS_PTRACE CAP_SYS_ADMIN/);
  for (const setting of ['STAY_REQUIRE_OS_CORE_SANDBOX=1', 'STAY_BWRAP=/usr/bin/bwrap',
    'STAY_REQUIRE_CORE_PACKAGE_POLICY=1', 'STAY_REQUIRE_CORE_PROMOTION_CERT=1',
    'STAY_CORE_PROMOTION_PUBLIC_KEY=/etc/stay/release-authority.pub',
    'STAY_CORE_PROMOTION_CERT_DIR=/etc/stay/core-promotions',
    'STAY_RESIDENT_PROMOTION_CERT_DIR=/etc/stay/resident-promotions']) assert.match(configure, new RegExp(setting.replaceAll('/', '\\/')));
  assert.match(configure, /openssl pkeyutl -verify -pubin -rawin/);
  assert.match(configure, /AFTER_REVISION > BEFORE_REVISION/);
  assert.doesNotMatch(configure, /AFTER_REVISION" == 53|RUNTIME_REVISION_AFTER=53/);
  assert.match(configure, /p1-b0-runtime-ready\.js.*\|\| abort service-socket-or-http-health-not-ready/);
  assert.match(rollback, /CANONICAL_FORWARD_STATE_PRESERVED=YES/);
  assert.doesNotMatch(preflight + configure + rollback, /attach resident:sntss|attach resident:chronobiology|ln -s|\/opt\/stay\/current.*(?:mv|ln)|snapshot.*restore/);
});

test('P1-B0-07 socket may precede HTTP listener and the shared bounded readiness gate waits for both', async t => {
  let healthAttempts = 0;
  const health = await waitForRuntimeReady({
    attempts: 8,
    intervalMs: 1,
    socketProbe: async () => true,
    healthProbe: async () => {
      healthAttempts += 1;
      if (healthAttempts < 4) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      return { ok: true, revision: 54 };
    }
  });
  assert.equal(healthAttempts, 4);
  assert.deepEqual(health, { ok: true, revision: 54 });
});

test('P1-B0-08 completion is fixed to the partial live state and performs no service or biological operation', () => {
  const complete = fs.readFileSync(path.join(ROOT, 'deploy/live-physiology-transplant/p1-b0-complete.sh'), 'utf8');
  assert.match(complete, /p1-b0-20260823T115636Z/);
  assert.match(complete, /RUNTIME_REVISION=54/);
  assert.match(complete, /after-state\.json.*already-exists/);
  assert.match(complete, /baseline-seal-already-exists/);
  assert.match(complete, /p1-b0-state\.js" capture/);
  assert.match(complete, /p1-b0-state\.js" compare/);
  assert.match(complete, /p1-surgery-b-state\.js" promotion/);
  assert.match(complete, /cmp -s "\$EVIDENCE_DIR\/dropin\.expected" "\$DROPIN"/);
  assert.match(complete, /installed-public-key-fingerprint-mismatch/);
  assert.match(complete, /SNTSS_ATTACHED=NO/);
  assert.match(complete, /CHRONOBIOLOGY_ATTACHED=NO/);
  assert.doesNotMatch(complete, /systemctl (?:restart|stop|start|daemon-reload)|attach resident:|detach resident:|\b(?:INSERT|UPDATE|DELETE|BEGIN IMMEDIATE)\b|\/opt\/stay\/current.*(?:ln|mv)|continuity\.sqlite3.*(?:cp|mv)|snapshot.*restore/);
});

test('P1-B0-09 historical completion remains sealed and is absent from the R116F controller', () => {
  const wrapper = fs.readFileSync(path.join(ROOT, 'deploy/live-physiology-transplant/stay-p1-production-controller'), 'utf8');
  const remote = fs.readFileSync(path.join(ROOT, 'deploy/live-physiology-transplant/p1-actions-remote-controller.sh'), 'utf8');
  assert.match(remote, /STAY_B0_COMPLETE_AUTHORIZED/);
  assert.doesNotMatch(wrapper, /complete-b0|AUTHORIZE_B0_COMPLETE_EXISTING_RUNTIME/);
  assert.match(wrapper, /harden-r116f\)/);
  assert.match(wrapper, /recover-r116f\)/);
});

test('P1-B0-02 certificate request is exact zero-authority frozen contract', () => {
  const { EXPECTED } = require('../deploy/live-physiology-transplant/p1-b0-state');
  assert.deepEqual(EXPECTED, {
    residencyId: 'resident:sntss', coreId: 'sntss', version: '0.4.0-i3d3', role: 'resident-physiology',
    moduleHash: 'sha256:36f51012ccbb5822d5e0d3da41f8ec6bae9f3d9b9073e08a561128f5a908b284',
    manifestHash: 'sha256:6612fc65862ae310a5c888e9c95c5037daaaaf3ab45c58709c57f6a9699a9797',
    packagePolicyHash: 'sha256:5708b07f711f4d681c67c518e34450d57559b6fe51316060d1c83bd2c8a46765',
    allowedInputs: ['runtime.organism.binding', 'runtime.time.pulse'], allowedOutputs: [],
    allowedActions: ['attach-resident'], authorizationClass: 'sntss-resident-zero-authority'
  });
});

test('P1-B0-03 detached manifest accepts exact public material and rejects changed certificate', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stay-p1-b0-trust-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  await fsp.writeFile(path.join(dir, 'release-authority-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  await fsp.writeFile(path.join(dir, 'resident-sntss.json'), '{}\n');
  const names = ['release-authority-public.pem', 'resident-sntss.json'];
  const manifest = names.map(name => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')}  ${name}\n`).join('');
  await fsp.writeFile(path.join(dir, 'P1_B0_TRUST_MATERIAL.sha256'), manifest);
  const signature = crypto.sign(null, Buffer.from(manifest), privateKey);
  await fsp.writeFile(path.join(dir, 'P1_B0_TRUST_MATERIAL.sha256.sig'), signature);
  assert.equal(crypto.verify(null, Buffer.from(manifest), publicKey, signature), true);
  const manifestMatches = () => names.every(name => manifest.includes(
    `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')}  ${name}\n`
  ));
  assert.equal(manifestMatches(), true);
  await fsp.writeFile(path.join(dir, 'resident-sntss.json'), '{"changed":true}\n');
  assert.equal(manifestMatches(), false);
});

test('P1-B0-04 historical B.0 inputs stay sealed but are not exposed by the R116F controller', () => {
  const remote = fs.readFileSync(path.join(ROOT, 'deploy/live-physiology-transplant/p1-actions-remote-controller.sh'), 'utf8');
  const wrapper = fs.readFileSync(path.join(ROOT, 'deploy/live-physiology-transplant/stay-p1-production-controller'), 'utf8');
  assert.match(remote, /preflight-b0[\s\S]*configure-b0[\s\S]*rollback-b0/);
  assert.doesNotMatch(wrapper, /preflight-b0|configure-b0|rollback-b0|AUTHORIZE_B0/);
  assert.match(wrapper, /harden-r116f\)/);
  assert.match(wrapper, /recover-r116f\)/);
  assert.doesNotMatch(remote + wrapper, /RELEASE_AUTHORITY_PRIVATE|PRIVATE_KEY_B64|private\.pem/);
});

test('P1-B0-05 one provisioning restart preserves identity/authority/checkpoints forward and configures trusted time', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stay-p1-b0-restart-'));
  const dataDir = path.join(root, 'state');
  const corePath = path.join(ROOT, 'test/fixtures/cores/counter-v1.js');
  let first = new LivingKernel({ dataDir, allowIdentityBootstrap: true, heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0, trustedTimePulseIntervalMs: 0 });
  let restarted;
  t.after(async () => {
    await first?.stop().catch(() => {}); await restarted?.stop().catch(() => {});
    await fsp.rm(root, { recursive: true, force: true });
  });
  await first.start(); await first.installCore(corePath); await first.publish('test.tick', {});
  const beforeAuthority = first.stateStore.getAuthority('test-counter');
  const beforeCheckpoint = await first.stateStore.readAuthoritativeCheckpoint('test-counter');
  const beforeIdentity = crypto.createHash('sha256').update(stableStringify(first.identity)).digest('hex');
  await first.stop(); first = null;
  restarted = new LivingKernel({ dataDir, heartbeatIntervalMs: 0, snapshotIntervalMs: 0,
    trustedTimePulseIntervalMs: 25 });
  await restarted.start(); await restarted.installCore(corePath);
  const afterAuthority = restarted.stateStore.getAuthority('test-counter');
  const afterCheckpoint = await restarted.stateStore.readAuthoritativeCheckpoint('test-counter');
  const tuple = x => ({ coreId: x.coreId, instanceId: x.instanceId, version: x.version,
    epoch: x.epoch, barrierSequence: x.barrierSequence });
  assert.deepEqual(tuple(afterAuthority), tuple(beforeAuthority));
  assert.equal(crypto.createHash('sha256').update(stableStringify(restarted.identity)).digest('hex'), beforeIdentity);
  assert.ok(afterCheckpoint.generation >= beforeCheckpoint.generation);
  assert.deepEqual(restarted.trustedTimePulseStatus(), {
    enabled: true, running: false, inFlight: false, intervalMs: 25, sequence: 0
  });
  assert.equal(restarted.stateStore.listResidents().length, 0);
});

test('P1-B0-06 request uses canonical resident identity hash and its certificate passes exact promotion path', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stay-p1-b0-canonical-'));
  const dataDir = path.join(root, 'state');
  const certDir = path.join(root, 'certificates');
  const publicKeyPath = path.join(root, 'release-authority.pub');
  const databasePath = path.join(dataDir, 'continuity.sqlite3');
  await fsp.mkdir(certDir, { recursive: true });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const organism = {
    organismId: 'stay-canonical-identity-regression',
    createdAt: '2026-08-23T00:00:00.000Z',
    lineage: 'STAY/Genesis'
  };
  const store = new StateStore(dataDir);
  await store.init();
  await store.writeLife('identity', organism);
  const metadata = store.db.prepare("SELECT sha256 FROM metadata WHERE key='life:identity'").get();
  store.close();

  const metadataHash = `sha256:${metadata.sha256}`;
  const canonicalHash = identityHash(organism);
  assert.notEqual(metadataHash, canonicalHash);
  const certificateRequest = await request(ROOT, databasePath);
  assert.equal(certificateRequest.bodyTemplate.organismIdentityHash, canonicalHash);
  assert.notEqual(certificateRequest.bodyTemplate.organismIdentityHash, metadataHash);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  await fsp.writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  const now = Date.now();
  const body = {
    ...certificateRequest.bodyTemplate,
    certificateId: 'p1-b0-canonical-regression',
    issuedAtMs: now - 1000,
    expiresAtMs: now + 600000
  };
  await fsp.writeFile(path.join(certDir, certificateFileName('resident:sntss')), JSON.stringify({
    format: 'stay-resident-promotion-v1',
    body,
    signature: crypto.sign(null, Buffer.from(stableStringify(body)), privateKey).toString('base64')
  }));
  const verified = await verifyPromotion(ROOT, databasePath, publicKeyPath, certDir);
  assert.equal(verified.status, 'PASS');
  assert.equal(verified.residencyId, 'resident:sntss');
  assert.equal(verified.authorizationClass, 'sntss-resident-zero-authority');
  assert.equal(verified.laboratoryBypass, false);
});
