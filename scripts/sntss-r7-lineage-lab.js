'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ACTIVE_FAMILIES, speciesProfile, createInitialModel, hash } = require('../cores/sntss/v0.1.0/species-profile');
const { advanceLaboratory } = require('../cores/sntss/v0.1.0/laboratory');
const { createStimulusState } = require('../cores/sntss/v0.1.0/stimuli');
const { receptorProfileRegistry } = require('../cores/sntss/v0.1.0/receptor-profiles');
const receptors = require('../cores/sntss/v0.1.0/receptors');
const stateContract = require('../cores/sntss/v0.1.0/state');
const genesisContract = require('../cores/sntss/v0.1.0/genesis');
const migrations = require('../cores/sntss/v0.1.0/migrations');
const recovery = require('../cores/sntss/v0.1.0/recovery');
const { applyAcquiredTransition } = require('../cores/sntss/v0.1.0/inheritance');
const development = require('../cores/sntss/v0.1.0/development');

const root = path.resolve(__dirname, '..');
function digestFile(relative) { return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex')}`; }
const identitySha256 = hash({ evidence: 'r7-organism' });
const binding = { bindingVersion: 1, identitySha256, organismLineage: 'STAY/Genesis', issuedAt: 500, runtimeRevision: 1, authorityEpoch: 7, kernelVersion: '0.8.11.3', bindingEventId: 'binding-r7' };
const request = { binding, neutralCheckpointHash: hash({ neutral: 'r7' }), genesisEventId: 'sntss-genesis-r7', genesisSequence: 1, at: 1000 };
const authorization = { stage: 'laboratory-r7', productionCommit: false, neutralHandoffVerified: true, speciesProfileHash: speciesProfile.profileHash, authorityEpoch: 7 };
const transaction = genesisContract.prepareGenesis(null, request, authorization, '77'.repeat(32));

let model = createInitialModel();
for (let index = 0; index < 64; index += 1) model = advanceLaboratory(model, 250, { 'dopamine-like': [800000], 'noradrenaline-like': [500000] }).model;
const stimulus = createStimulusState(); stimulus.cursor = 5; stimulus.habituation['memory.novelty.assessed'] = { burden: 250000, updatedAt: 1000, exposures: 4 };
let receptorState = receptors.registerConsumer(transaction.state.receptors, 'receptor-probe-alpha', receptorProfileRegistry.profiles['receptor-probe-alpha'].profileHash, 1000);
receptorState = receptors.evaluateConsumer(receptorState, 'receptor-probe-alpha', model, 17000).state;
const acquired = applyAcquiredTransition(transaction.state, { model, stimulusState: stimulus, receptorState, inputCursor: 5 }, { stage: 'laboratory-r7', productionImport: false, evidenceHash: hash({ transition: 'r7' }) });
const checkpoint = stateContract.createCheckpoint(acquired, 18000);
const restarted = recovery.verifyRestart(checkpoint, { lineage: acquired.lineage, identitySha256, speciesProfileHash: speciesProfile.profileHash });
const corrupt = JSON.parse(JSON.stringify(checkpoint)); corrupt.state.transmitters['dopamine-like'].R = 1000000;
const recovered = recovery.recoverCheckpoint(corrupt, [checkpoint], { lineage: acquired.lineage, identitySha256, speciesProfileHash: speciesProfile.profileHash });
const projection = migrations.projectBackward(acquired, 1); const migrated = migrations.migrateForward(projection.state, 2);
const elapsedMs = 365 * 86400000;
const downtime = recovery.advanceDowntime(acquired, { clockStatus: 'trusted', elapsedMs, resumeAtMs: acquired.modelClock.lastTrustedWallClockMs + elapsedMs, expectedLineage: acquired.lineage, expectedIdentitySha256: identitySha256 });
const authorizationHash = hash({ review: 'r7' });
const summary = {
  summaryVersion: 1, evidenceWindowHash: hash({ window: 'r7' }), reviewAuthorizationHash: authorizationHash,
  fromCursor: 6, toCursor: 105, windowStartMs: acquired.developmentalClock.lastTrustedWallClockMs,
  windowEndMs: acquired.developmentalClock.lastTrustedWallClockMs + 86400000,
  healthy: true, authoritative: true, timeTrusted: true, unclamped: true, synthetic: false, replay: false,
  sourceDiversity: 6, acceptedEvidenceCount: 1000, dominantSourceShare: 300000, extremeShare: 50000,
  proposedBaselines: Object.fromEntries(ACTIVE_FAMILIES.map(family => [family, speciesProfile.families[family].birthState.B + 50000]))
};
const review = { sourceCore: 'sntss-development-review', sourceVersion: '1.0.0', sourceInstanceId: 'review-r7', authorityEpoch: 3, contractHash: development.DEVELOPMENT_CONTRACT_HASH, authorizationHash, summaryHash: hash(summary), active: true, reviewedAtCursor: 105 };
const reviewContext = { trustedNowMs: summary.windowEndMs, verifiedAuthorizationHashes: new Set([authorizationHash]), reviewAuthorityByCore: { 'sntss-development-review': { active: true, epoch: 3, version: '1.0.0', instanceId: 'review-r7' } } };
const developed = development.applyDevelopmentSummary(acquired, summary, review, reviewContext);
const selfAuthorized = development.applyDevelopmentSummary(acquired, summary, { ...review, sourceCore: 'sntss' }, reviewContext);

const outcomes = {
  oneLineageBound: transaction.state.lineage === transaction.ledgerEvent.lineage && transaction.state.organismBinding.identitySha256 === identitySha256,
  noPrebirthStimulusHistory: Object.keys(transaction.state.sourceHistory).join(',') === 'genesis' && Object.keys(transaction.state.habituation).length === 0,
  restartExact: restarted.stateHash === stateContract.stateHash(acquired),
  corruptPrimaryRejected: recovered.report.selectedSource === 'backup-0',
  backwardProjectionPreservesBiology: migrations.biologicalInvariantHash(projection.state) === migrations.biologicalInvariantHash(acquired),
  forwardMigrationPreservesBiology: migrations.biologicalInvariantHash(migrated.state) === migrations.biologicalInvariantHash(acquired),
  downtimeNoDevelopment: downtime.state.developmentalClock.experienceMs === acquired.developmentalClock.experienceMs,
  downtimeNoSyntheticHistory: downtime.report.sourceHistoryUnchanged && downtime.report.habituationUnchanged,
  boundedDevelopment: developed.decision.accepted && Object.values(developed.decision.baselineChanges).every(value => Math.abs(value) <= 1000),
  selfAuthorizationRejected: !selfAuthorized.decision.accepted,
  laboratoryImportBlocked: (() => { try { genesisContract.assertProductionImportAllowed(transaction.state); return false; } catch (error) { return error.code === 'SNTSS_LAB_IMPORT_BLOCKED'; } })()
};
const moduleFiles = [
  'cores/sntss/v0.1.0/state.js', 'cores/sntss/v0.1.0/genesis.js', 'cores/sntss/v0.1.0/migrations.js',
  'cores/sntss/v0.1.0/recovery.js', 'cores/sntss/v0.1.0/inheritance.js', 'cores/sntss/v0.1.0/development.js',
  'cores/sntss/schemas/acquired-state.schema.json'
];
const body = {
  evidenceVersion: 1, stage: 'R7-genesis-inheritance-development-laboratory', productionGenesisEnabled: false,
  lineage: transaction.state.lineage, identitySha256, genesisTransactionHash: transaction.transactionHash,
  checkpointHash: checkpoint.checkpointHash, acquiredStateHash: stateContract.stateHash(acquired),
  migrationTransformationHash: migrations.TRANSFORMATION_HASH, developmentContractHash: development.DEVELOPMENT_CONTRACT_HASH,
  lineageFixtureHash: hash({ transaction, checkpointHash: checkpoint.checkpointHash, projection: projection.report, migration: migrated.report, downtime: downtime.report, development: developed.decision }),
  outcomes, moduleHashes: Object.fromEntries(moduleFiles.map(file => [file, digestFile(file)])),
  coreHostActivation: { productionGenesis: false, outputs: [], chemistryActive: false, laboratoryImportBlocked: true }
};
const evidence = { ...body, evidenceHash: hash(body) };
const destination = path.join(root, 'docs/sntss/evidence/R7_LINEAGE_EVIDENCE.json');
fs.writeFileSync(destination, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ destination: path.relative(root, destination), evidenceHash: evidence.evidenceHash, lineageFixtureHash: evidence.lineageFixtureHash, acquiredStateHash: evidence.acquiredStateHash })}\n`);

module.exports = { evidence };
