'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const MODULE = 'cores/sntss/i3d/index.js';
const { LivingKernel } = require('../runtime');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const { createResidentControlDispatcher, FORMAT } = require('../runtime/kernel/resident-control-socket');
const { AUTHORIZATION_CLASS, identityHash, certificateFileName } = require('../runtime/kernel/resident-promotion-authority');
const { treeHash } = require('../deploy/live-physiology-transplant/p1-surgery-b-state');

async function waitFor(check, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('condition timed out');
}

test('P1-B-01 fixed scripts are socket-only, guarded, and rollback preserves forward state', () => {
  const preflight = fss.readFileSync(path.join(ROOT, 'deploy/live-physiology-transplant/p1-surgery-b-preflight.sh'), 'utf8');
  const surgery = fss.readFileSync(path.join(ROOT, 'deploy/live-physiology-transplant/p1-surgery-b-execute.sh'), 'utf8');
  const rollback = fss.readFileSync(path.join(ROOT, 'deploy/live-physiology-transplant/p1-surgery-b-rollback.sh'), 'utf8');
  for (const source of [preflight, surgery, rollback]) {
    assert.match(source, /p1-host-identity-guard\.sh/);
    assert.match(source, /0\.8\.11\.3-p1a1-resident-control-7d040592ccf1f149/);
    assert.doesNotMatch(source, /systemctl (restart|stop|start) stay\.service|ln -s|\/opt\/stay\/current.*(mv|ln)|snapshot.*restore|continuity\.sqlite3.*(cp|mv)/);
  }
  assert.match(preflight, /STAY_REQUIRE_CORE_PROMOTION_CERT/);
  assert.match(preflight, /STAY_TRUSTED_TIME_PULSE_INTERVAL_MS/);
  assert.match(preflight, /p1-b0-sandbox-repair\.env/);
  assert.match(preflight, /LIVE_USER_CORE_INSPECT=PASS/);
  assert.match(preflight, /SERVICE_INHERITABLE_CAPABILITIES_HEX/);
  assert.match(preflight, /SERVICE_PERMITTED_CAPABILITIES=NONE/);
  assert.match(preflight, /SERVICE_EFFECTIVE_CAPABILITIES=NONE/);
  assert.match(preflight, /SERVICE_AMBIENT_CAPABILITIES=NONE/);
  assert.match(preflight, /NO_NEW_PRIVILEGES=YES/);
  assert.match(surgery, /p1-resident-control-client\.js" attach resident:sntss/);
  assert.match(rollback, /p1-resident-control-client\.js" detach resident:sntss/);
  assert.match(rollback, /CANONICAL_FORWARD_STATE_PRESERVED=YES/);
  assert.doesNotMatch(surgery + rollback, /attach resident:chronobiology|detach resident:chronobiology/);
});

test('P1-B-02 signed hot attach consumes multiple scheduler pulses with zero outputs and no authority', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-p1-b-'));
  const dataDir = path.join(root, 'state');
  const authorityDir = path.join(root, 'resident-promotions');
  const publicKeyPath = path.join(root, 'release-authority.pub');
  await fs.mkdir(authorityDir, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  await fs.writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  let now = 1000;
  const kernel = new LivingKernel({ dataDir, allowIdentityBootstrap: true, heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0, trustedTimePulseIntervalMs: 25, allowLaboratoryResidentAttachment: false,
    residentPromotionPublicKeyPath: publicKeyPath, residentPromotionCertificateDir: authorityDir,
    clock: () => ++now });
  await kernel.start();
  t.after(async () => { await kernel.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  const manager = kernel.ensureResidentManager();
  const inspected = await manager.inspect(MODULE);
  const wall = Date.now();
  const body = {
    allowedActions: ['attach-resident'], allowedInputs: [...inspected.definition.manifest.inputs], allowedOutputs: [],
    authorizationClass: AUTHORIZATION_CLASS, certificateId: 'p1-b-offlive-' + crypto.randomUUID(),
    coreId: inspected.definition.manifest.coreId, expiresAtMs: wall + 600000, issuedAtMs: wall - 1000,
    manifestHash: inspected.manifestHash, moduleHash: inspected.definition.moduleDigest,
    organismId: kernel.identity.organismId, organismIdentityHash: identityHash(kernel.identity),
    packagePolicyHash: inspected.definition.packagePolicyHash, residencyId: manager.contract.residencyId,
    role: manager.contract.role, version: inspected.definition.manifest.version
  };
  await fs.writeFile(path.join(authorityDir, certificateFileName('resident:sntss')), JSON.stringify({
    format: 'stay-resident-promotion-v1', body,
    signature: crypto.sign(null, Buffer.from(stableStringify(body)), privateKey).toString('base64')
  }));
  const dispatch = createResidentControlDispatcher(kernel);
  const authorityBefore = kernel.stateStore.listAuthority();
  const fetusBefore = authorityBefore.find(row => row.coreId === 'fetus-legacy') || null;
  const attached = await dispatch({ format: FORMAT, operation: 'attach', residencyId: 'resident:sntss' });
  assert.equal(attached.resident.running, true);
  assert.equal(attached.resident.productionEligible, false);
  assert.equal(attached.resident.signalling, 'FORBIDDEN');
  const initialGeneration = attached.resident.checkpointGeneration;
  const running = await waitFor(async () => {
    const status = await dispatch({ format: FORMAT, operation: 'status', residencyId: 'resident:sntss' });
    return status.resident.handledEvents >= 3 && status.resident.checkpointGeneration >= initialGeneration + 3 ? status : null;
  });
  assert.equal(running.resident.health.ok, true);
  assert.equal(running.resident.observedOutputs, 0);
  assert.equal(running.resident.declaredOutputs, 0);
  assert.equal(running.resident.authorityOwned, false);
  assert.equal(kernel.stateStore.db.prepare("SELECT COUNT(*) AS count FROM biological_outbox_intents WHERE producer_core_id='sntss'").get().count, 0);
  assert.deepEqual(kernel.stateStore.listAuthority(), authorityBefore);
  assert.deepEqual(kernel.stateStore.listAuthority().find(row => row.coreId === 'fetus-legacy') || null, fetusBefore);
  assert.equal(kernel.trustedTimePulseStatus().running, true);
});

test('P1-B-03 detach keeps the latest checkpoint and Surgery A runtime alive', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-p1-b-rollback-'));
  const dataDir = path.join(root, 'state');
  const kernel = new LivingKernel({ dataDir, allowIdentityBootstrap: true, heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0, trustedTimePulseIntervalMs: 0, allowLaboratoryResidentAttachment: true });
  await kernel.start();
  t.after(async () => { await kernel.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  const dispatch = createResidentControlDispatcher(kernel);
  const authorityBefore = kernel.stateStore.listAuthority();
  await dispatch({ format: FORMAT, operation: 'attach', residencyId: 'resident:sntss' });
  await kernel.publishTimePulse('trusted');
  const before = await waitFor(async () => {
    const s = await dispatch({ format: FORMAT, operation: 'status', residencyId: 'resident:sntss' });
    return s.resident.handledEvents >= 1 ? s : null;
  });
  const detached = await dispatch({ format: FORMAT, operation: 'detach', residencyId: 'resident:sntss' });
  assert.equal(detached.statePreserved, true);
  assert.equal(detached.resident.status, 'DETACHED');
  assert.ok(detached.resident.checkpointGeneration > before.resident.checkpointGeneration);
  assert.ok(detached.resident.checkpointHash);
  assert.equal(kernel.stateStore.getResident('resident:sntss').checkpointHash, detached.resident.checkpointHash);
  assert.deepEqual(kernel.stateStore.listAuthority(), authorityBefore);
  assert.equal((await kernel.health()).persistence.ok, true);
});

test('P1-B-04 frozen SNTSS I3-D3 package retains its exact Git tree identity', async () => {
  assert.equal(await treeHash(path.join(ROOT, 'cores/sntss/i3d')),
    '5efc31371cfdca9e650ad3c8bc6d749f8f4df618');
});
