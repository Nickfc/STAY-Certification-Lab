'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { speciesProfile, ACTIVE_FAMILIES, ALL_FAMILIES, createInitialModel, hash } = require('../cores/sntss/v0.1.0/species-profile');
const { advanceLaboratory } = require('../cores/sntss/v0.1.0/laboratory');
const { createStimulusState } = require('../cores/sntss/v0.1.0/stimuli');
const { receptorProfileRegistry } = require('../cores/sntss/v0.1.0/receptor-profiles');
const receptors = require('../cores/sntss/v0.1.0/receptors');
const leases = require('../cores/sntss/v0.1.0/leases');
const stateContract = require('../cores/sntss/v0.1.0/state');
const genesisContract = require('../cores/sntss/v0.1.0/genesis');
const migrations = require('../cores/sntss/v0.1.0/migrations');
const recovery = require('../cores/sntss/v0.1.0/recovery');
const { applyAcquiredTransition } = require('../cores/sntss/v0.1.0/inheritance');
const development = require('../cores/sntss/v0.1.0/development');
const sntss = require('../cores/sntss/v0.1.0');

const IDENTITY = hash({ fixture: 'permanent-organism' });
const BINDING = Object.freeze({
  bindingVersion: 1, identitySha256: IDENTITY, organismLineage: 'STAY/Genesis', issuedAt: 500,
  runtimeRevision: 1, authorityEpoch: 7, kernelVersion: '0.8.11.3', bindingEventId: 'binding-1'
});
const REQUEST = Object.freeze({ binding: BINDING, neutralCheckpointHash: hash({ neutral: true }), genesisEventId: 'sntss-genesis-1', genesisSequence: 1, at: 1000 });
const AUTH = Object.freeze({ stage: 'laboratory-r7', productionCommit: false, neutralHandoffVerified: true, speciesProfileHash: speciesProfile.profileHash, authorityEpoch: 7 });

function genesis(entropy = '11'.repeat(32)) { return genesisContract.prepareGenesis(null, REQUEST, AUTH, entropy); }
function acquired() {
  const transaction = genesis(); let model = createInitialModel();
  for (let index = 0; index < 64; index += 1) model = advanceLaboratory(model, 250, { 'dopamine-like': [800000], 'noradrenaline-like': [500000] }).model;
  const stimulus = createStimulusState(); stimulus.cursor = 5;
  stimulus.habituation['memory.novelty.assessed'] = { burden: 250000, updatedAt: 1000, exposures: 4 };
  stimulus.sourceLastSeen.memory = { atMs: 1000, sequence: 5 };
  stimulus.breakers['source:memory'] = { mode: 'closed', failureWindowStartedAt: null, failureCount: 0, openedAt: null, reasonCode: null, probes: 0 };
  let receptorState = receptors.registerConsumer(transaction.state.receptors, 'receptor-probe-alpha', receptorProfileRegistry.profiles['receptor-probe-alpha'].profileHash, 1000);
  receptorState = leases.grantLease(receptorState, 'receptor-probe-alpha', receptorProfileRegistry.profiles['receptor-probe-alpha'].profileHash, 1000, 60000, {
    trustedRuntime: true, authorityEpoch: 7, consumerAuthority: { 'receptor-probe-alpha': { active: true, profileHash: receptorProfileRegistry.profiles['receptor-probe-alpha'].profileHash } }
  });
  receptorState = receptors.evaluateConsumer(receptorState, 'receptor-probe-alpha', model, 17000).state;
  return applyAcquiredTransition(transaction.state, { model, stimulusState: stimulus, receptorState, inputCursor: 5 }, { stage: 'laboratory-r7', productionImport: false, evidenceHash: hash({ transition: 5 }) });
}
function developmentSummary(state, overrides = {}) {
  const authorizationHash = hash({ review: state.inputCursor + 1 });
  const summary = {
    summaryVersion: 1, evidenceWindowHash: hash({ window: state.inputCursor + 1 }), reviewAuthorizationHash: authorizationHash,
    fromCursor: state.inputCursor + 1, toCursor: state.inputCursor + 100, windowStartMs: state.developmentalClock.lastTrustedWallClockMs,
    windowEndMs: state.developmentalClock.lastTrustedWallClockMs + 86400000, healthy: true, authoritative: true,
    timeTrusted: true, unclamped: true, synthetic: false, replay: false, sourceDiversity: 6,
    acceptedEvidenceCount: 1000, dominantSourceShare: 300000, extremeShare: 50000,
    proposedBaselines: Object.fromEntries(ACTIVE_FAMILIES.map(family => [family, speciesProfile.families[family].birthState.B + 50000])),
    ...overrides
  };
  const review = { sourceCore: 'sntss-development-review', sourceVersion: '1.0.0', sourceInstanceId: 'development-review-1', authorityEpoch: 3, contractHash: development.DEVELOPMENT_CONTRACT_HASH, authorizationHash: summary.reviewAuthorizationHash, summaryHash: hash(summary), active: true, reviewedAtCursor: summary.toCursor };
  const context = { trustedNowMs: summary.windowEndMs, verifiedAuthorizationHashes: new Set([summary.reviewAuthorizationHash]), reviewAuthorityByCore: { 'sntss-development-review': { active: true, epoch: 3, version: '1.0.0', instanceId: 'development-review-1' } } };
  return { summary, review, context };
}

test('R7-01 genesis is one-time, organism-bound, random-lineage and neutral with no fabricated stimulus history', () => {
  const first = genesis('11'.repeat(32)); const second = genesis('22'.repeat(32));
  assert.notEqual(first.state.lineage, second.state.lineage);
  assert.equal(first.state.organismBinding.identitySha256, IDENTITY); assert.equal(first.state.inputCursor, 1);
  assert.deepEqual(Object.keys(first.state.sourceHistory), ['genesis']); assert.deepEqual(first.state.habituation, {});
  for (const family of ALL_FAMILIES) {
    const current = first.state.transmitters[family]; const birth = speciesProfile.families[family].birthState;
    assert.deepEqual(current, birth); assert.equal(current.X, 0); assert.equal(current.O, 0); assert.ok(current.R < 1000000 || current.R === 0);
  }
  assert.equal(genesisContract.validateGenesisTransaction(first).transactionHash, first.transactionHash);
  assert.throws(() => genesisContract.prepareGenesis(first.state, REQUEST, AUTH, '33'.repeat(32)), { code: 'SNTSS_SECOND_GENESIS' });
});

test('R7-02 production genesis and laboratory-state import remain blocked until R13', () => {
  assert.throws(() => genesisContract.prepareGenesis(null, REQUEST, { ...AUTH, productionCommit: true }, '11'.repeat(32)), { code: 'SNTSS_PRODUCTION_GENESIS_BLOCKED' });
  assert.throws(() => genesisContract.assertProductionImportAllowed(genesis().state), { code: 'SNTSS_LAB_IMPORT_BLOCKED' });
  assert.throws(() => genesisContract.prepareGenesis(null, REQUEST, { ...AUTH, authorityEpoch: 8 }, '11'.repeat(32)), { code: 'SNTSS_GENESIS_AUTHORITY' });
});

test('R7-03 checkpoint restart and crash recovery preserve exact lineage and acquired state', () => {
  const state = acquired(); const checkpoint = stateContract.createCheckpoint(state, 18000);
  const restarted = recovery.verifyRestart(checkpoint, { lineage: state.lineage, identitySha256: IDENTITY, speciesProfileHash: speciesProfile.profileHash });
  assert.deepEqual(restarted.state, state); assert.equal(restarted.stateHash, stateContract.stateHash(state));
  assert.equal(restarted.checkpointHash, checkpoint.checkpointHash);
});

test('R7-04 corruption selects a verified matching backup and never creates fresh chemistry', () => {
  const state = acquired(); const backup = stateContract.createCheckpoint(state, 18000); const corrupt = JSON.parse(JSON.stringify(backup));
  corrupt.state.transmitters['dopamine-like'].R = 1000000;
  const recovered = recovery.recoverCheckpoint(corrupt, [backup], { lineage: state.lineage, identitySha256: IDENTITY, speciesProfileHash: speciesProfile.profileHash });
  assert.equal(recovered.report.selectedSource, 'backup-0'); assert.deepEqual(recovered.state, state);
  assert.throws(() => recovery.recoverCheckpoint(corrupt, [], { lineage: state.lineage }), { code: 'SNTSS_RECOVERY_NO_VERIFIED_STATE' });
});

test('R7-05 acquired reserves, tolerance, opponent load, habituation and receptor history survive checkpoints', () => {
  const state = acquired(); const dopamine = state.transmitters['dopamine-like'];
  assert.ok(dopamine.R < speciesProfile.families['dopamine-like'].birthState.R); assert.ok(dopamine.X > 0); assert.ok(dopamine.O > 0);
  assert.equal(state.habituation['memory.novelty.assessed'].exposures, 4);
  assert.ok(state.receptors.consumers['receptor-probe-alpha'].populations['probe.alpha.encoding.dopamine.v1'].exposure > 0);
  const restored = recovery.verifyRestart(stateContract.createCheckpoint(state, 18000), { lineage: state.lineage }).state;
  assert.deepEqual(restored.transmitters, state.transmitters); assert.deepEqual(restored.habituation, state.habituation); assert.deepEqual(restored.receptors, state.receptors);
});

test('R7-06 forward migration and backward projection preserve acquired biology without rollback rewind', () => {
  const current = acquired(); const invariant = migrations.biologicalInvariantHash(current);
  const projected = migrations.projectBackward(current, 1);
  assert.equal(projected.report.sourceStateRemainsAuthoritative, true); assert.equal(migrations.biologicalInvariantHash(projected.state), invariant);
  const migrated = migrations.migrateForward(projected.state, 2);
  assert.equal(migrations.biologicalInvariantHash(migrated.state), invariant);
  assert.deepEqual(migrated.state.transmitters, current.transmitters); assert.deepEqual(migrated.state.receptors, current.receptors);
  assert.throws(() => migrations.migrateForward({ ...projected.state, stateSchema: 99 }, 2), { code: 'SNTSS_STATE_SCHEMA_UNSUPPORTED' });
});

test('R7-07 long trusted downtime advances only legitimate recovery and expires derived leases', () => {
  const state = acquired(); const developmentalBefore = state.developmentalClock.experienceMs; const cursor = state.inputCursor;
  const elapsedMs = 365 * 86400000; const resumeAtMs = state.modelClock.lastTrustedWallClockMs + elapsedMs;
  const result = recovery.advanceDowntime(state, { clockStatus: 'trusted', elapsedMs, resumeAtMs, expectedLineage: state.lineage, expectedIdentitySha256: IDENTITY });
  assert.equal(result.state.inputCursor, cursor); assert.equal(result.state.developmentalClock.experienceMs, developmentalBefore);
  assert.equal(result.report.sourceHistoryUnchanged, true); assert.equal(result.report.habituationUnchanged, true);
  assert.equal(result.state.leases['receptor-probe-alpha'].status, 'disconnected'); assert.deepEqual(result.state.leases['receptor-probe-alpha'].queue, []);
  const dopamine = result.state.transmitters['dopamine-like']; assert.equal(dopamine.C, dopamine.B); assert.equal(dopamine.X, 0); assert.equal(dopamine.O, 0);
});

test('R7-08 uncertain time, lineage mismatch and operator-authored recovery fail without mutation', () => {
  const state = acquired(); const context = { clockStatus: 'trusted', elapsedMs: 1000, resumeAtMs: state.modelClock.lastTrustedWallClockMs + 1000, expectedLineage: state.lineage, expectedIdentitySha256: IDENTITY };
  assert.throws(() => recovery.advanceDowntime(state, { ...context, clockStatus: 'uncertain' }), { code: 'SNTSS_DOWNTIME_CLOCK_UNTRUSTED' });
  assert.throws(() => recovery.advanceDowntime(state, { ...context, expectedLineage: hash({ wrong: true }) }), { code: 'SNTSS_LINEAGE_MISMATCH' });
  assert.equal(state.modelClock.lastTrustedWallClockMs, 1000);
});

test('R7-09 reviewed development is slow, tonic-only and bounded by day/range/evidence contracts', () => {
  const state = acquired(); const before = JSON.parse(JSON.stringify(state.transmitters)); const fixture = developmentSummary(state);
  const result = development.applyDevelopmentSummary(state, fixture.summary, fixture.review, fixture.context);
  assert.equal(result.decision.reasonCode, 'SNTSS_DEVELOPMENT_ACCEPTED'); assert.equal(result.state.developmentalClock.experienceMs, 86400000);
  for (const family of ACTIVE_FAMILIES) {
    assert.equal(result.decision.baselineChanges[family], 1000);
    for (const key of ['P', 'R', 'C', 'X', 'O', 'F']) assert.equal(result.state.transmitters[family][key], before[family][key]);
    assert.equal(result.state.transmitters[family].B, before[family].B + 1000);
  }
  for (const family of speciesProfile.dormantFamilies) assert.deepEqual(result.state.transmitters[family], before[family]);
});

test('R7-10 sparse, synthetic, unhealthy, self-authorized, replayed and out-of-range development cannot mutate state', () => {
  const state = acquired(); const base = developmentSummary(state);
  const cases = [
    [{ ...base.summary, acceptedEvidenceCount: 1 }, base.review, base.context],
    [{ ...base.summary, synthetic: true }, base.review, base.context],
    [{ ...base.summary, healthy: false }, base.review, base.context],
    [base.summary, { ...base.review, sourceCore: 'sntss' }, base.context],
    [{ ...base.summary, fromCursor: state.inputCursor }, base.review, base.context],
    [{ ...base.summary, proposedBaselines: { ...base.summary.proposedBaselines, 'dopamine-like': 1000000 } }, base.review, base.context],
    [{ ...base.summary, maximumBaselineMovementPerDay: 999999 }, base.review, base.context]
  ];
  for (const [summary, review, context] of cases) {
    const result = development.applyDevelopmentSummary(state, summary, review, context);
    assert.equal(result.decision.accepted, false); assert.equal(result.state, state); assert.deepEqual(result.decision.baselineChanges, {});
  }
});

test('R7-11 CoreHost remains pre-genesis and cannot import or persist laboratory lineage', async () => {
  assert.equal(sntss.manifest.productionEligible, false); assert.deepEqual(sntss.manifest.outputs, []);
  const core = await sntss.createCore({ initialState: {} }); const snapshot = await core.snapshot(); const health = await core.health();
  assert.deepEqual(snapshot.transmitters, {}); assert.deepEqual(snapshot.receptors, {}); assert.equal(health.chemistryActive, false);
  assert.equal(health.productionGenesis, false);
});

test('R7-12 committed lineage evidence matches its content and controlling modules', () => {
  const root = path.resolve(__dirname, '..'); const evidencePath = path.join(root, 'docs/sntss/evidence/R7_LINEAGE_EVIDENCE.json');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')); const { evidenceHash, ...body } = evidence;
  assert.equal(evidenceHash, hash(body)); assert.ok(Object.values(evidence.outcomes).every(Boolean));
  for (const [file, expected] of Object.entries(evidence.moduleHashes)) {
    const actual = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')}`; assert.equal(actual, expected, file);
  }
});
