'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fp = require('../cores/sntss/v0.1.0/fixed-point');
const species = require('../cores/sntss/v0.1.0/species-profile');
const { advanceLaboratory } = require('../cores/sntss/v0.1.0/laboratory');
const { receptorProfileRegistry, validateReceptorProfile, hash } = require('../cores/sntss/v0.1.0/receptor-profiles');
const receptors = require('../cores/sntss/v0.1.0/receptors');
const leases = require('../cores/sntss/v0.1.0/leases');
const frames = require('../cores/sntss/v0.1.0/modulation-frames');
const sntss = require('../cores/sntss/v0.1.0');

const LINEAGE = hash({ fixture: 'r6-lineage' });
const SNTSS_INSTANCE = 'sntss-r6-authoritative-instance';
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function authority(consumerCoreId) {
  return { trustedRuntime: true, authorityEpoch: 9, consumerAuthority: { [consumerCoreId]: { active: true, profileHash: receptorProfileRegistry.profiles[consumerCoreId].profileHash } } };
}
function addConsumer(state, consumerCoreId, now = 0) {
  const profile = receptorProfileRegistry.profiles[consumerCoreId];
  state = receptors.registerConsumer(state, consumerCoreId, profile.profileHash, now);
  return leases.grantLease(state, consumerCoreId, profile.profileHash, now, 10000, authority(consumerCoreId));
}
function model() {
  return advanceLaboratory(species.createInitialModel(), 250, {
    'dopamine-like': [800000], 'acetylcholine-like': [500000], 'noradrenaline-like': [600000],
    'gaba-like': [400000], 'glutamate-like': [700000], 'serotonin-like': [500000]
  }).model;
}
function context(cursor, now = 1000, extra = {}) { return { lineage: LINEAGE, authorityEpoch: 9, evidenceCursor: cursor, nowMs: now, availability: 'available', ...extra }; }
function frameTrust({ expectedAuthorityEpoch = 9, expectedLineage = LINEAGE, expectedSourceInstanceId = SNTSS_INSTANCE, expectedSourceVersion = '0.1.0', delivery = {} } = {}) {
  return {
    expectedAuthorityEpoch, expectedLineage, expectedSourceInstanceId, expectedSourceVersion,
    delivery: { sourceCore: 'sntss', sourceVersion: expectedSourceVersion, sourceInstanceId: expectedSourceInstanceId, authorityEpoch: expectedAuthorityEpoch, ...delivery }
  };
}

test('R6-01 static probe profiles are immutable, hashed, bounded and restricted to active families', () => {
  assert.equal(Object.keys(receptorProfileRegistry.profiles).length, 2);
  assert.equal(receptorProfileRegistry.productionConsumersEnabled, false);
  assert.ok(Object.isFrozen(receptorProfileRegistry));
  for (const profile of Object.values(receptorProfileRegistry.profiles)) {
    assert.equal(validateReceptorProfile(profile).profileHash, profile.profileHash);
    assert.equal(profile.productionEligible, false); assert.equal(profile.wildcardAllowed, false);
    for (const receptor of profile.receptors) {
      assert.ok(species.ACTIVE_FAMILIES.includes(receptor.family)); assert.ok(!species.DORMANT_FAMILIES.includes(receptor.family));
      assert.ok(receptor.efficacy <= 250000); assert.equal(receptor.fallback, 0);
    }
  }
  const dynamic = copy(receptorProfileRegistry.profiles['receptor-probe-alpha']); dynamic.consumerCoreId = 'untrusted-dynamic';
  const { profileHash: ignored, ...body } = dynamic; dynamic.profileHash = hash(body);
  assert.throws(() => validateReceptorProfile(dynamic), { code: 'SNTSS_RECEPTOR_DYNAMIC_PROFILE' });
});

test('R6-02 receptor binding and local adaptation remain deterministic and bounded', () => {
  let state = receptors.createReceptorState(LINEAGE);
  state = receptors.registerConsumer(state, 'receptor-probe-alpha', receptorProfileRegistry.profiles['receptor-probe-alpha'].profileHash, 0);
  const first = receptors.evaluateConsumer(state, 'receptor-probe-alpha', model(), 250);
  const second = receptors.evaluateConsumer(first.state, 'receptor-probe-alpha', model(), 500);
  assert.deepEqual(receptors.evaluateConsumer(state, 'receptor-probe-alpha', model(), 250), first);
  for (const signal of second.signals) {
    assert.ok(Math.abs(signal.activation) <= fp.SCALE); assert.ok(Math.abs(signal.boundedEffect) <= fp.SCALE);
    assert.ok(signal.sensitivity >= 0 && signal.sensitivity <= fp.SCALE);
  }
  assert.ok(second.signals[0].sensitivity <= first.signals[0].sensitivity);
});

test('R6-03 frames require Kernel-authenticated source authority in addition to hash, target and expiry', () => {
  let state = addConsumer(receptors.createReceptorState(LINEAGE), 'receptor-probe-alpha');
  const generated = frames.generateFrame(state, 'receptor-probe-alpha', model(), context(10));
  const profile = receptorProfileRegistry.profiles['receptor-probe-alpha'];
  const trusted = frameTrust();
  assert.equal(generated.status, 'generated');
  assert.equal(frames.validateFrameForConsumer(generated.frame, 'receptor-probe-alpha', profile.profileHash, 1000, trusted), true);
  assert.throws(() => frames.validateFrameForConsumer(generated.frame, 'receptor-probe-beta', profile.profileHash, 1000, trusted), { code: 'SNTSS_FRAME_UNTARGETED' });
  assert.throws(() => frames.validateFrameForConsumer(generated.frame, 'receptor-probe-alpha', profile.profileHash, 3000, trusted), { code: 'SNTSS_FRAME_EXPIRED' });
  assert.throws(() => frames.validateFrameForConsumer(generated.frame, 'receptor-probe-alpha', profile.profileHash, 1000, frameTrust({ expectedAuthorityEpoch: 10 })), { code: 'SNTSS_FRAME_AUTHORITY_STALE' });
  assert.throws(() => frames.validateFrameForConsumer(generated.frame, 'receptor-probe-alpha', profile.profileHash, 1000), { code: 'SNTSS_FRAME_SOURCE_UNAUTHENTICATED' });
  assert.throws(() => frames.validateFrameForConsumer(generated.frame, 'receptor-probe-alpha', profile.profileHash, 1000, frameTrust({ delivery: { sourceCore: 'malicious-core' } })), { code: 'SNTSS_FRAME_SOURCE_UNAUTHENTICATED' });
  assert.throws(() => frames.validateFrameForConsumer(generated.frame, 'receptor-probe-alpha', profile.profileHash, 1000, frameTrust({ delivery: { sourceInstanceId: 'forged-sntss-instance' } })), { code: 'SNTSS_FRAME_SOURCE_UNAUTHENTICATED' });
  assert.throws(() => frames.validateFrameForConsumer(generated.frame, 'receptor-probe-alpha', profile.profileHash, 1000, frameTrust({ expectedLineage: hash({ fixture: 'other-organism' }) })), { code: 'SNTSS_FRAME_LINEAGE_UNAUTHENTICATED' });
});

test('R6-04 replay is idempotent and fresh replay from identical state reproduces frame IDs and effects', () => {
  const initial = addConsumer(receptors.createReceptorState(LINEAGE), 'receptor-probe-alpha');
  const first = frames.generateFrame(initial, 'receptor-probe-alpha', model(), context(10));
  const duplicate = frames.generateFrame(first.state, 'receptor-probe-alpha', model(), context(10, 1100));
  const independent = frames.generateFrame(initial, 'receptor-probe-alpha', model(), context(10));
  assert.equal(duplicate.status, 'replay'); assert.equal(duplicate.state, first.state); assert.deepEqual(duplicate.frame, first.frame);
  assert.deepEqual(independent.frame, first.frame); assert.equal(first.frame.frameId, independent.frame.frameId);
  assert.throws(() => frames.generateFrame(first.state, 'receptor-probe-alpha', model(), context(9)), { code: 'SNTSS_FRAME_CURSOR_REWIND' });
});

test('R6-05 lease grants require trusted runtime authority and expire/disconnect fail closed', () => {
  let state = receptors.createReceptorState(LINEAGE); const profile = receptorProfileRegistry.profiles['receptor-probe-alpha'];
  state = receptors.registerConsumer(state, 'receptor-probe-alpha', profile.profileHash, 0);
  assert.throws(() => leases.grantLease(state, 'receptor-probe-alpha', profile.profileHash, 0, 10000, {}), { code: 'SNTSS_LEASE_AUTHORITY' });
  state = leases.grantLease(state, 'receptor-probe-alpha', profile.profileHash, 0, 10000, authority('receptor-probe-alpha'));
  assert.equal(frames.generateFrame(state, 'receptor-probe-alpha', model(), context(10, 10001)).reasonCode, 'SNTSS_LEASE_EXPIRED');
  state = leases.disconnectLease(state, 'receptor-probe-alpha', 500);
  assert.equal(frames.generateFrame(state, 'receptor-probe-alpha', model(), context(10, 1000)).reasonCode, 'SNTSS_CONSUMER_DISCONNECTED');
});

test('R6-06 consumer backpressure is bounded and isolated from other consumers', () => {
  let state = addConsumer(receptors.createReceptorState(LINEAGE), 'receptor-probe-alpha');
  state = addConsumer(state, 'receptor-probe-beta');
  for (let cursor = 1; cursor <= 11; cursor += 1) state = frames.generateFrame(state, 'receptor-probe-alpha', model(), context(cursor, 1000 + cursor)).state;
  assert.equal(state.leases['receptor-probe-alpha'].breaker, 'open');
  assert.ok(state.leases['receptor-probe-alpha'].queue.length <= receptorProfileRegistry.profiles['receptor-probe-alpha'].queueCapacity);
  const beta = frames.generateFrame(state, 'receptor-probe-beta', model(), context(50, 1020));
  assert.equal(beta.status, 'generated'); assert.equal(beta.reasonCode, 'SNTSS_FRAME_QUEUED');
  assert.equal(beta.state.leases['receptor-probe-beta'].breaker, 'closed');
});

test('R6-07 removal makes receptor history dormant and rollback restores rather than resets it', () => {
  let state = addConsumer(receptors.createReceptorState(LINEAGE), 'receptor-probe-alpha');
  state = frames.generateFrame(state, 'receptor-probe-alpha', model(), context(10)).state;
  const before = copy(state.consumers['receptor-probe-alpha'].populations);
  state = receptors.removeConsumer(state, 'receptor-probe-alpha');
  assert.equal(state.consumers['receptor-probe-alpha'], undefined);
  assert.ok(Object.values(state.removedConsumers['receptor-probe-alpha'].populations).every(value => value.dormant));
  state = receptors.registerConsumer(state, 'receptor-probe-alpha', receptorProfileRegistry.profiles['receptor-probe-alpha'].profileHash, 2000);
  for (const [id, population] of Object.entries(before)) assert.deepEqual({ ...state.consumers['receptor-probe-alpha'].populations[id], dormant: false }, { ...population, dormant: false });
});

test('R6-08 degraded frames carry neutral fallback and recovery is bounded without backlog impulse', () => {
  let state = addConsumer(receptors.createReceptorState(LINEAGE), 'receptor-probe-alpha');
  const degraded = frames.generateFrame(state, 'receptor-probe-alpha', model(), context(10, 1000, { availability: 'degraded', degradationReason: 'source-quarantine' }));
  assert.ok(degraded.frame.receptors.every(signal => signal.available === false && signal.activation === 0 && signal.boundedEffect === 0));
  state = degraded.state;
  const recovery = frames.generateFrame(state, 'receptor-probe-alpha', model(), context(11, 1100, { resynchronizing: true }));
  assert.equal(recovery.frame.degradation.health, 'recovering');
  assert.ok(recovery.frame.receptors.every(signal => Math.abs(signal.boundedEffect) <= 50000));
});

test('R6-09 malformed profiles and frames cannot activate dormant families or unbounded efficacy', () => {
  const profile = copy(receptorProfileRegistry.profiles['receptor-probe-alpha']); profile.receptors[0].family = 'oxytocin-like';
  const { profileHash: ignored, ...body } = profile; profile.profileHash = hash(body);
  assert.throws(() => validateReceptorProfile(profile), { code: 'SNTSS_FAMILY_DORMANT' });
  const high = copy(receptorProfileRegistry.profiles['receptor-probe-alpha']); high.receptors[0].efficacy = 1000000;
  const { profileHash: ignoredHigh, ...highBody } = high; high.profileHash = hash(highBody);
  assert.throws(() => validateReceptorProfile(high), { code: 'SNTSS_RECEPTOR_EFFICACY' });
});

test('R6-10 CoreHost remains inert and exposes no receptor-frame output authority', async () => {
  assert.equal(sntss.manifest.productionEligible, false); assert.deepEqual(sntss.manifest.outputs, []);
  assert.deepEqual(sntss.manifest.inputs, ['runtime.organism.binding', 'runtime.time.pulse']);
  const core = await sntss.createCore({ initialState: {} }); const health = await core.health();
  assert.equal(health.chemistryActive, false); assert.equal(health.productionReceptorConsumers, 0); assert.equal(health.laboratoryReceptorProfiles, 2);
});

test('R6-11 committed receptor evidence matches its content and controlling modules', () => {
  const root = path.resolve(__dirname, '..');
  const evidence = JSON.parse(fs.readFileSync(path.join(root, 'docs/sntss/evidence/R6_RECEPTOR_EVIDENCE.json'), 'utf8'));
  const { evidenceHash, ...body } = evidence;
  assert.equal(evidenceHash, hash(body)); assert.equal(evidence.profileRegistryHash, receptorProfileRegistry.registryHash);
  assert.ok(Object.values(evidence.outcomes).every(Boolean));
  for (const [file, expected] of Object.entries(evidence.moduleHashes)) {
    const actual = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')}`;
    assert.equal(actual, expected, file);
  }
});
