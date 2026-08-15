'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const species = require('../cores/sntss/v0.1.0/species-profile');
const { advanceLaboratory } = require('../cores/sntss/v0.1.0/laboratory');
const { receptorProfileRegistry, hash } = require('../cores/sntss/v0.1.0/receptor-profiles');
const receptors = require('../cores/sntss/v0.1.0/receptors');
const leases = require('../cores/sntss/v0.1.0/leases');
const frames = require('../cores/sntss/v0.1.0/modulation-frames');

const root = path.resolve(__dirname, '..'); const lineage = hash({ evidence: 'r6-lineage' });
function digestFile(relative) { return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex')}`; }
function authority(id) { return { trustedRuntime: true, authorityEpoch: 11, consumerAuthority: { [id]: { active: true, profileHash: receptorProfileRegistry.profiles[id].profileHash } } }; }
function add(state, id) {
  const profile = receptorProfileRegistry.profiles[id];
  state = receptors.registerConsumer(state, id, profile.profileHash, 0);
  return leases.grantLease(state, id, profile.profileHash, 0, 10000, authority(id));
}
function context(cursor, nowMs = 1000, extra = {}) { return { lineage, authorityEpoch: 11, evidenceCursor: cursor, nowMs, availability: 'available', ...extra }; }
const model = advanceLaboratory(species.createInitialModel(), 250, {
  'dopamine-like': [800000], 'acetylcholine-like': [500000], 'noradrenaline-like': [600000],
  'gaba-like': [400000], 'glutamate-like': [700000], 'serotonin-like': [500000]
}).model;

let initial = receptors.createReceptorState(lineage); initial = add(initial, 'receptor-probe-alpha'); initial = add(initial, 'receptor-probe-beta');
const first = frames.generateAllFrames(initial, model, context(20));
const replay = frames.generateAllFrames(initial, model, context(20));
const degraded = frames.generateFrame(first.state, 'receptor-probe-alpha', model, context(21, 1100, { availability: 'degraded', degradationReason: 'producer-quarantine' }));
const recovery = frames.generateFrame(degraded.state, 'receptor-probe-alpha', model, context(22, 1200, { resynchronizing: true }));
let pressure = initial;
for (let cursor = 1; cursor <= 11; cursor += 1) pressure = frames.generateFrame(pressure, 'receptor-probe-alpha', model, context(cursor, 1000 + cursor)).state;
const betaAfterPressure = frames.generateFrame(pressure, 'receptor-probe-beta', model, context(50, 1020));
const removed = receptors.removeConsumer(first.state, 'receptor-probe-alpha');
const restored = receptors.registerConsumer(removed, 'receptor-probe-alpha', receptorProfileRegistry.profiles['receptor-probe-alpha'].profileHash, 2000);

const outcomes = {
  targetValidation: frames.validateFrameForConsumer(first.outcomes['receptor-probe-alpha'].frame, 'receptor-probe-alpha', receptorProfileRegistry.profiles['receptor-probe-alpha'].profileHash, 1000, 11),
  deterministicReplay: frames.sameFrame(first.outcomes['receptor-probe-alpha'].frame, replay.outcomes['receptor-probe-alpha'].frame),
  distinctConsumerFrameIds: first.outcomes['receptor-probe-alpha'].frame.frameId !== first.outcomes['receptor-probe-beta'].frame.frameId,
  degradedEffectsExactlyZero: degraded.frame.receptors.every(signal => signal.activation === 0 && signal.boundedEffect === 0 && !signal.available),
  recoveryEffectsCapped: recovery.frame.receptors.every(signal => Math.abs(signal.boundedEffect) <= 50000),
  alphaBreakerOpened: pressure.leases['receptor-probe-alpha'].breaker === 'open',
  betaUnaffected: betaAfterPressure.status === 'generated' && betaAfterPressure.state.leases['receptor-probe-beta'].breaker === 'closed',
  removalPreservedHistory: Boolean(removed.removedConsumers['receptor-probe-alpha']),
  rollbackRestoredHistory: restored.consumers['receptor-probe-alpha'].frameSequence === first.state.consumers['receptor-probe-alpha'].frameSequence
};
const goldenFrames = Object.fromEntries(Object.entries(first.outcomes).map(([id, value]) => [id, value.frame]));
const moduleFiles = [
  'cores/sntss/v0.1.0/receptor-profiles.js', 'cores/sntss/v0.1.0/receptors.js',
  'cores/sntss/v0.1.0/leases.js', 'cores/sntss/v0.1.0/modulation-frames.js',
  'cores/sntss/schemas/receptor-profile.schema.json', 'cores/sntss/schemas/modulation-frame.schema.json'
];
const body = {
  evidenceVersion: 1, stage: 'R6-receptor-lease-frame-laboratory', productionDeliveryEnabled: false,
  profileRegistryHash: receptorProfileRegistry.registryHash, profileCount: Object.keys(receptorProfileRegistry.profiles).length,
  goldenFrameHash: hash(goldenFrames), isolationCorpusHash: hash(outcomes), outcomes,
  frameIds: Object.fromEntries(Object.entries(goldenFrames).map(([id, frame]) => [id, frame.frameId])),
  moduleHashes: Object.fromEntries(moduleFiles.map(file => [file, digestFile(file)])),
  coreHostActivation: { inputsChanged: false, outputs: [], chemistryActive: false, productionReceptorConsumers: 0 }
};
const evidence = { ...body, evidenceHash: hash(body) };
const destination = path.join(root, 'docs/sntss/evidence/R6_RECEPTOR_EVIDENCE.json');
fs.writeFileSync(destination, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ destination: path.relative(root, destination), evidenceHash: evidence.evidenceHash, goldenFrameHash: evidence.goldenFrameHash, isolationCorpusHash: evidence.isolationCorpusHash })}\n`);

module.exports = { evidence };
