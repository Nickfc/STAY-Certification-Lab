'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { LivingKernel } = require('../runtime');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const {
  FORMAT,
  RESIDENT_MODULES,
  validateRequest,
  createResidentControlDispatcher,
  createResidentControlServer
} = require('../runtime/kernel/resident-control-socket');
const {
  AUTHORIZATION_CLASS,
  identityHash,
  certificateFileName
} = require('../runtime/kernel/resident-promotion-authority');

const MODULE = 'cores/sntss/i3d/index.js';

async function request(socketPath, operation, residencyId) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy(new Error('resident-control timeout')));
    let body = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify({ format: FORMAT, operation, residencyId }) + '\n'));
    socket.on('data', chunk => { body += chunk; });
    socket.once('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (error) { reject(error); }
    });
  });
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('condition timed out');
}

test('P1-A1-01 protocol rejects arbitrary operations, modules, residencies and fields', () => {
  assert.deepEqual(Object.keys(RESIDENT_MODULES).sort(), [
    'resident:chronobiology', 'resident:metab', 'resident:sntss'
  ]);
  assert.throws(() => validateRequest({ format: FORMAT, operation: 'eval', residencyId: 'resident:sntss' }),
    error => error.code === 'RESIDENT_CONTROL_OPERATION');
  assert.throws(() => validateRequest({ format: FORMAT, operation: 'attach', residencyId: '../../tmp/core' }),
    error => error.code === 'RESIDENT_CONTROL_RESIDENCY');
  assert.throws(() => validateRequest({ format: FORMAT, operation: 'attach', residencyId: 'resident:sntss', modulePath: '/tmp/x' }),
    error => error.code === 'RESIDENT_CONTROL_REQUEST');
});

test('P1-A1-02 Unix socket is local filesystem-only, mode 0600, and status is read-only', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-p1-a1-socket-'));
  const socketPath = path.join(root, 'resident-control.sock');
  const records = new Map();
  const contracts = new Map([
    ['resident:sntss', {
      residencyId: 'resident:sntss', coreId: 'sntss', version: '0.4.0-i3d3', stateSchema: 4,
      priority: 'optional', productionEligible: false, signalling: 'FORBIDDEN', outputs: []
    }],
    ['resident:chronobiology', {
      residencyId: 'resident:chronobiology', coreId: 'chronobiology', version: '1.0.0-c3rc.1', stateSchema: 2,
      priority: 'optional', productionEligible: false, signalling: 'LAB_SHADOW_ONLY', outputs: ['chronobiology.phase.summary']
    }]
  ]);
  const kernel = {
    ensureResidentManager: () => ({ contractRegistry: { byResidencyId: contracts }, units: new Map() }),
    stateStore: { getResident: id => records.get(id) || null },
    attachResident: async () => { throw new Error('status must not attach'); },
    detachResident: async () => { throw new Error('status must not detach'); }
  };
  const control = createResidentControlServer({ kernel, socketPath, logger: { warn() {}, error() {} } });
  try {
    await control.start();
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    assert.equal(control.socketPath, socketPath);
    assert.match(String(createResidentControlServer), /server\.listen\(socketPath/);
    assert.match(String(createResidentControlServer), /fs\.chmod\(socketPath, 0o600\)/);
    const status = await createResidentControlDispatcher(kernel)({
      format: FORMAT, operation: 'status', residencyId: 'resident:sntss'
    });
    assert.equal(status.ok, true);
    assert.equal(status.resident.present, false);
    assert.equal(JSON.stringify([...records]), '[]');
    await fs.rm(root, { recursive: true, force: true });
    return;
  }
  t.after(async () => { await control.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });

  const stat = await fs.stat(socketPath);
  assert.equal(stat.isSocket(), true);
  assert.equal(stat.mode & 0o777, 0o600);
  const before = JSON.stringify([...records]);
  const status = await request(socketPath, 'status', 'resident:sntss');
  assert.equal(status.ok, true);
  assert.equal(status.resident.present, false);
  assert.equal(status.resident.signalling, 'FORBIDDEN');
  assert.equal(JSON.stringify([...records]), before);
});

test('P1-A1-03 fixed socket hot-attaches certified SNTSS, consumes pulses, emits zero output, and detaches forward', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-p1-a1-live-'));
  const dataDir = path.join(root, 'state');
  const authorityDir = path.join(root, 'resident-promotions');
  const publicKeyPath = path.join(root, 'release-authority.pub');
  const socketPath = path.join(root, 'resident-control.sock');
  await fs.mkdir(authorityDir, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  await fs.writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));

  let now = 1000;
  const kernel = new LivingKernel({
    dataDir,
    allowIdentityBootstrap: true,
    heartbeatIntervalMs: 0,
    snapshotIntervalMs: 0,
    trustedTimePulseIntervalMs: 0,
    allowLaboratoryResidentAttachment: false,
    residentPromotionPublicKeyPath: publicKeyPath,
    residentPromotionCertificateDir: authorityDir,
    clock: () => now
  });
  await kernel.start();
  const manager = kernel.ensureResidentManager();
  const inspected = await manager.inspect(MODULE);
  const wall = Date.now();
  const body = {
    allowedActions: ['attach-resident'],
    allowedInputs: [...inspected.definition.manifest.inputs],
    allowedOutputs: [],
    authorizationClass: AUTHORIZATION_CLASS,
    certificateId: 'p1-a1-offlive-' + crypto.randomUUID(),
    coreId: inspected.definition.manifest.coreId,
    expiresAtMs: wall + 600000,
    issuedAtMs: wall - 1000,
    manifestHash: inspected.manifestHash,
    moduleHash: inspected.definition.moduleDigest,
    organismId: kernel.identity.organismId,
    organismIdentityHash: identityHash(kernel.identity),
    packagePolicyHash: inspected.definition.packagePolicyHash,
    residencyId: manager.contract.residencyId,
    role: manager.contract.role,
    version: inspected.definition.manifest.version
  };
  const record = {
    format: 'stay-resident-promotion-v1',
    body,
    signature: crypto.sign(null, Buffer.from(stableStringify(body)), privateKey).toString('base64')
  };
  await fs.writeFile(path.join(authorityDir, certificateFileName('resident:sntss')), JSON.stringify(record));

  const control = createResidentControlServer({ kernel, socketPath, logger: { warn() {}, error() {} } });
  let dispatchRequest;
  try {
    await control.start();
    dispatchRequest = (operation, residencyId) => request(socketPath, operation, residencyId);
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    const dispatch = createResidentControlDispatcher(kernel);
    dispatchRequest = (operation, residencyId) => dispatch({ format: FORMAT, operation, residencyId });
  }
  t.after(async () => {
    await control.stop().catch(() => {});
    await kernel.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });

  const authorityBefore = kernel.stateStore.listAuthority();
  const attached = await dispatchRequest('attach', 'resident:sntss');
  assert.equal(attached.ok, true);
  assert.equal(attached.resident.running, true);
  assert.equal(attached.resident.version, '0.4.0-i3d3');
  assert.equal(attached.resident.stateSchema, 4);
  assert.equal(attached.resident.declaredOutputs, 0);
  assert.equal(attached.resident.productionEligible, false);
  assert.equal(attached.resident.authorityOwned, false);
  const initialGeneration = attached.resident.checkpointGeneration;

  for (let index = 0; index < 4; index += 1) {
    now += 100;
    await kernel.publishTimePulse('trusted');
  }
  const checkpoint = await waitFor(async () => {
    const value = await kernel.stateStore.readResidentCheckpoint('resident:sntss');
    return value?.generation >= initialGeneration + 4 ? value : null;
  });
  assert.equal(Boolean(checkpoint.state.organismBinding), true);
  assert.ok(checkpoint.state.trustedTime.acceptedPulses >= 4);
  assert.equal(checkpoint.state.trustedTime.lastPulseSequence, 4);
  const running = await dispatchRequest('status', 'resident:sntss');
  assert.equal(running.resident.running, true);
  assert.equal(running.resident.observedOutputs, 0);
  assert.equal(running.resident.authorityOwned, false);
  assert.equal(running.resident.health.ok, true);
  assert.deepEqual(kernel.stateStore.listAuthority(), authorityBefore);

  const detached = await dispatchRequest('detach', 'resident:sntss');
  assert.equal(detached.ok, true);
  assert.equal(detached.statePreserved, true);
  assert.equal(detached.resident.status, 'DETACHED');
  assert.ok(detached.resident.checkpointGeneration >= checkpoint.generation);
  assert.ok(detached.resident.checkpointHash);
  assert.deepEqual(kernel.stateStore.listAuthority(), authorityBefore);
});
