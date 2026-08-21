'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const chronobiology = require('../cores/chronobiology/c3');
const { SUMMARY_TOPIC } = require('../cores/chronobiology/c3/summary');
const {
  advanceTrustedTime,
  bindState,
  emptyState,
  normalizeState,
} = require('../cores/chronobiology/c3/state');
const { stableStringify } = require('../runtime/kernel/canonical-json');
const {
  enforcePackagePolicy,
  verifyManifestAgainstPackagePolicy,
} = require('../runtime/kernel/package-policy');
const { CHRONOBIOLOGY_RESIDENT_CONTRACT } = require('../runtime/kernel/resident-manager');

const root = path.resolve(__dirname, '..');
const packageRoot = path.join(root, 'cores/chronobiology/c3');
const sha256 = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

test('C3-REL-01 exact release candidate is hash-bound and remains SHADOW-only', () => {
  const record = enforcePackagePolicy(require.resolve('../cores/chronobiology/c3'));
  assert.equal(verifyManifestAgainstPackagePolicy(record, chronobiology.manifest), true);
  assert.equal(chronobiology.manifest.version, '1.0.0-c3rc.1');
  assert.equal(chronobiology.manifest.stage, 'c3-shadow-release-candidate');
  assert.equal(chronobiology.manifest.productionEligible, false);
  assert.deepEqual(chronobiology.manifest.biology.producerCapabilities[0]
    .allowedAuthorityModes, ['shadow']);
  assert.equal(CHRONOBIOLOGY_RESIDENT_CONTRACT.authorityMode, 'shadow');
  assert.equal(CHRONOBIOLOGY_RESIDENT_CONTRACT.productionEligible, false);
  assert.equal(CHRONOBIOLOGY_RESIDENT_CONTRACT.packagePolicyHash,
    record.policy.policyHash);
});

test('C3-REL-02 artifact substitution changes a bound package hash', () => {
  const record = enforcePackagePolicy(require.resolve('../cores/chronobiology/c3'));
  for (const [relative, expected] of Object.entries(record.policy.files)) {
    const bytes = fs.readFileSync(path.resolve(packageRoot, relative));
    assert.equal(sha256(bytes), expected, relative);
  }
  const summary = fs.readFileSync(path.join(packageRoot, 'summary.js'));
  assert.notEqual(sha256(Buffer.concat([summary, Buffer.from('\n// substitution')])),
    record.policy.files['summary.js']);
});

test('C3-REL-03 unsupported model, engine, schema and calibration fail closed', () => {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(root, 'docs/chronobiology/c2a-convergence-report.json'),
    'utf8',
  ));
  assert.equal(fixture.result, 'PASS');
  const binding = {
    id: 'release-version-binding',
    topic: 'runtime.organism.binding',
    payload: {
      bindingVersion: 1,
      identitySha256: `sha256:${'1'.repeat(64)}`,
      organismLineage: 'STAY/Genesis',
      runtimeRevision: 1,
      authorityEpoch: 1,
      kernelVersion: 'test',
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
  };
  const pulse = {
    id: 'release-version-pulse',
    topic: 'runtime.trusted-organism-time.pulse',
    payload: {
      runtimeRevision: 1,
      pulseSequence: 1,
      status: 'TRUSTED',
      trustedTimeUs: 0,
      continuityEpoch: 1,
      reasonCode: null,
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
  };
  const original = advanceTrustedTime(bindState(emptyState(), binding), pulse);
  for (const mutate of [
    state => { state.schema = 'chronobiology.state/v999'; },
    state => { state.phenotype.model_version = 'chronobiology-model-v999'; },
    state => { state.phenotype.numerical_engine_version = 'fixed-point-v999'; },
    state => { state.phenotype.calibration_profile_id = 'calibration-v999'; },
  ]) {
    const candidate = structuredClone(original);
    mutate(candidate);
    assert.throws(() => normalizeState(candidate));
  }
});

test('C3-REL-04 public payload is context-only and has no foreign-write anatomy', async () => {
  const outputs = [];
  const core = await chronobiology.createCore({
    emit: async (topic, payload) => outputs.push({ topic, payload }),
  });
  const binding = {
    id: 'release-binding',
    topic: 'runtime.organism.binding',
    payload: {
      bindingVersion: 1,
      identitySha256: `sha256:${'e'.repeat(64)}`,
      organismLineage: 'STAY/Genesis',
      runtimeRevision: 1,
      authorityEpoch: 1,
      kernelVersion: '0.8.11.3',
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
  };
  const pulse = {
    id: 'release-pulse',
    topic: 'runtime.trusted-organism-time.pulse',
    payload: {
      runtimeRevision: 1,
      pulseSequence: 1,
      status: 'TRUSTED',
      trustedTimeUs: 0,
      continuityEpoch: 1,
      reasonCode: null,
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
  };
  await core.handle(binding);
  await core.handle(pulse);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].topic, SUMMARY_TOPIC);
  assert.doesNotMatch(stableStringify(outputs[0].payload),
    /transmitter|receptor|concentration|mutation|command|target_core|authority_epoch/i);
});

test('C3-REL-05 every tranche evidence record is present and passed', () => {
  for (const file of [
    'c2a-convergence-report.json',
    'c2b-photic-report.json',
    'c2c-persistence-report.json',
    'c3a-containment-report.json',
    'c3b-shadow-report.json',
  ]) {
    const report = JSON.parse(fs.readFileSync(path.join(root, 'docs/chronobiology', file)));
    assert.equal(report.result, 'PASS', file);
  }
});
