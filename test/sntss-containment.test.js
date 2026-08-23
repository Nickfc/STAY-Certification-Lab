'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { enforcePackagePolicy, auditSourceText, verifyManifestAgainstPackagePolicy } = require('../runtime/kernel/package-policy');
const { nativeCoreExecArgv, coreHostEnvironment } = require('../runtime/kernel/core-sandbox');
const { normalizePolicy } = require('../runtime/kernel/resource-governor');
const { cgroupLimitValues } = require('../runtime/kernel/cgroup-governor');
const containment = require('../cores/sntss/v0.1.0/containment');
const stateContract = require('../cores/sntss/v0.1.0/state');
const sntss = require('../cores/sntss/v0.1.0');
const { hash } = require('../cores/sntss/v0.1.0/species-profile');
const { makeKernel, waitFor } = require('./helpers');

const root = path.resolve(__dirname, '..');
const entrypoint = path.join(root, 'cores/sntss/v0.1.0/index.js');
const lineage = hash({ fixture: 'r8-lineage' });
const checkpointHash = hash({ fixture: 'r8-checkpoint' });
function incident(kind, id, extra = {}) {
  return {
    incidentId: id, kind, scope: 'global', severity: 'warning', observedAtCursor: 10,
    evidenceHash: hash({ evidence: id }), checkpointHash, detailHash: hash({ detail: id }), runtimeTrusted: true,
    ...extra
  };
}

test('R8-01 package policy is canonical, hash-attested and complete before CoreHost execution', () => {
  const record = enforcePackagePolicy(entrypoint);
  assert.equal(record.policy.coreId, 'sntss');
  assert.equal(record.entrypoint, fs.realpathSync.native(entrypoint));
  assert.ok(record.attestedFiles >= 30);
  assert.deepEqual(record.policy.allowedBuiltins, ['node:crypto']);
  assert.equal(record.policy.ambientCapabilities.network, false);
});

test('R8-02 unlisted dependencies, dynamic require and ambient process or timer capabilities fail closed', () => {
  for (const source of [
    "require('node:fs')", "require(variable)",
    'process.env.SECRET', 'setInterval(() => {}, 1)', 'fetch("https://example.invalid")'
  ]) assert.throws(() => auditSourceText(source, ['node:crypto']), error => ['CORE_PACKAGE_DEPENDENCY_DENIED', 'CORE_PACKAGE_CAPABILITY_DENIED'].includes(error.code));
  assert.throws(() => auditSourceText("require('./not-allowlisted')", ['node:crypto'], new Set(['./allowed'])), { code: 'CORE_PACKAGE_DEPENDENCY_DENIED' });
});

test('R8-03 manifest resources are cryptographically bound to the package contract', () => {
  const record = enforcePackagePolicy(entrypoint);
  assert.equal(verifyManifestAgainstPackagePolicy(record, sntss.manifest), true);
  assert.throws(() => verifyManifestAgainstPackagePolicy(record, { ...sntss.manifest, resources: { ...sntss.manifest.resources, pidsMax: 17 } }), { code: 'CORE_PACKAGE_RESOURCE_MISMATCH' });
});

test('R8-04 delegated cgroup leaf values match the SNTSS CPU, memory and pids ceilings', () => {
  const policy = normalizePolicy(sntss.manifest.resources, sntss.manifest.priority);
  assert.deepEqual(cgroupLimitValues(policy), {
    'memory.high': String(64 * 1024 * 1024), 'memory.max': String(96 * 1024 * 1024),
    'pids.max': '16', 'cpu.max': '20000 100000'
  });
  assert.equal(containment.packagePolicy.resourceContract.cgroupV2.kernelGovernorOwned, true);
});

test('R8-05 a local warning opens only its circuit and degrades without inventing chemistry', () => {
  const initial = containment.createContainmentState(lineage, checkpointHash);
  const next = containment.recordIncident(initial, incident('hang', 'hang-1', { scope: 'receptor' }));
  assert.equal(next.mode, 'degraded'); assert.equal(next.forceTermination, false);
  assert.equal(Object.keys(next.breakerScopes).length, 1); assert.equal(initial.mode, 'healthy');
});

test('R8-06 repeated flood evidence quarantines and retains a bounded incident window', () => {
  let state = containment.createContainmentState(lineage, checkpointHash);
  for (let index = 0; index < containment.MAX_INCIDENTS + 20; index += 1) {
    state = containment.recordIncident(state, incident('event-flood', `flood-${index}`, { detailHash: hash({ common: true }), observedAtCursor: index }));
  }
  assert.equal(state.mode, 'quarantined'); assert.equal(state.incidents.length, containment.MAX_INCIDENTS);
});

test('R8-07 process escape and governor bypass authorize Kernel-owned force termination only', () => {
  const escaped = containment.recordIncident(containment.createContainmentState(lineage, checkpointHash), incident('process-escape', 'escape-1', { severity: 'critical' }));
  assert.equal(escaped.mode, 'quarantined'); assert.equal(escaped.forceTermination, true);
  assert.throws(() => containment.forceTerminationDirective(escaped, { trustedRuntime: true }), { code: 'SNTSS_CONTAINMENT_AUTHORITY' });
  const killed = containment.forceTerminationDirective(escaped, { trustedRuntime: true, kernelGovernor: true });
  assert.equal(killed.state.mode, 'terminated'); assert.equal(killed.directive.signal, 'SIGKILL');
  assert.equal(killed.directive.restartMode, 'shadow-only');
});

test('R8-08 neutral degradation preserves failed state evidence and has zero chemistry authority', () => {
  const state = containment.recordIncident(containment.createContainmentState(lineage, checkpointHash), incident('oom', 'oom-1', { severity: 'critical' }));
  const failedState = { acquired: 'opaque-and-unchanged' }; const failedStateHash = hash(failedState);
  const result = containment.neutralizationDirective(state, failedStateHash);
  assert.deepEqual(failedState, { acquired: 'opaque-and-unchanged' });
  assert.equal(result.directive.mutateAcquiredBiology, false); assert.equal(result.directive.emitChemistryFrames, false);
  assert.equal(result.state.failedStateRef.stateHash, failedStateHash);
});

test('R8-09 invalid checkpoints are quarantined and oversized acquired state remains rejected', () => {
  const state = containment.recordIncident(containment.createContainmentState(lineage, checkpointHash), incident('invalid-checkpoint', 'checkpoint-1', { severity: 'critical' }));
  assert.equal(state.forceTermination, true);
  assert.equal(containment.packagePolicy.bounds.checkpointBytes, stateContract.MAX_STATE_BYTES);
  assert.equal(containment.packagePolicy.bounds.migrationRecords, 64);
});

test('R8-10 environment and diagnostics expose no ambient secret or inspector surface', () => {
  const env = coreHostEnvironment();
  assert.ok(Object.keys(env).every(key => containment.packagePolicy.environmentAllowlist.includes(key)));
  assert.equal(env.STAY_COREHOST, '1'); assert.equal(Object.hasOwn(env, 'HOME'), false);
  const argv = nativeCoreExecArgv(entrypoint);
  assert.ok(argv.includes('--permission')); assert.ok(argv.every(value => !value.startsWith('--allow-child-process') && !value.startsWith('--allow-net')));
});

test('R8-11 SIGKILL of the isolated SNTSS CoreHost preserves Kernel and StateStore health', async t => {
  const { kernel, dataDir } = await makeKernel();
  t.after(async () => { if (kernel.stateStore.db) await kernel.stop().catch(() => {}); await fs.promises.rm(dataDir, { recursive: true, force: true }); });
  await kernel.installCore(entrypoint);
  const slot = kernel.registry.get('sntss'); const generation = slot.active.client.generation;
  slot.active.client.child.kill('SIGKILL');
  await waitFor(() => slot.active.client.generation > generation && slot.active.client.lifecycle === 'active', 5000);
  const health = await kernel.health();
  assert.equal(health.ok, true); assert.equal(health.persistence.ok, true);
});

test('R8-12 committed containment evidence matches its body and controlling sources', () => {
  const evidencePath = path.join(root, 'docs/sntss/evidence/R8_CONTAINMENT_EVIDENCE.json');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')); const { evidenceHash, ...body } = evidence;
  assert.equal(evidenceHash, hash(body)); assert.equal(evidence.activeStatePathTouched, false);

  const requiredModuleHashes = [
    'runtime/kernel/package-policy.js',
    'runtime/kernel/core-loader.js',
    'runtime/kernel/core-host-client.js',
    'runtime/kernel/core-sandbox.js',
    'runtime/core-host/host.js',
    'runtime/core-host/sandbox-host.js',
    'runtime/core-host/worker.js',
    'runtime/kernel/resource-governor.js',
    'runtime/kernel/cgroup-governor.js',
    'cores/sntss/v0.1.0/containment.js',
    'cores/sntss/v0.1.0/package-policy.json',
    'cores/sntss/schemas/containment-policy.schema.json',
    'test/sntss-containment.test.js'
  ];

  assert.deepEqual(
    Object.keys(evidence.moduleHashes),
    requiredModuleHashes,
    'containment evidence source inventory changed'
  );

  for (const [file, expected] of Object.entries(evidence.moduleHashes)) {
    const actual = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')}`;
    assert.equal(actual, expected, file);
  }
});
