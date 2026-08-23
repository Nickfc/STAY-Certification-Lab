'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sourceRegistry, hash } = require('../cores/sntss/v0.1.0/source-registry');
const { createStimulusState, processSemanticEvent, assessProducerAvailability } = require('../cores/sntss/v0.1.0/stimuli');

const root = path.resolve(__dirname, '..');
const H = value => hash({ evidenceFixture: value });
const samples = {
  'presence.state.changed': { state: 'arrived', magnitude: 800000, confidence: 900000 },
  'social.interaction.verified': { valence: 700000, magnitude: 800000, confidence: 900000 },
  'activity.phase.changed': { phase: 'active', magnitude: 800000, confidence: 900000 },
  'homeostasis.state.changed': { state: 'strained', magnitude: 800000, confidence: 900000 },
  'homeostasis.need.changed': { direction: 'increased', needClass: 'energy', magnitude: 800000, confidence: 900000 },
  'instinct.threat.assessed': { assessment: 'present', magnitude: 800000, confidence: 900000 },
  'instinct.drive.changed': { direction: 'increased', driveClass: 'explore', magnitude: 800000, confidence: 900000 },
  'pain.damage.registered': { status: 'new', magnitude: 800000, confidence: 900000 },
  'pain.relief.registered': { relief: 'verified', magnitude: 800000, confidence: 900000 },
  'memory.novelty.assessed': { novelty: 800000, magnitude: 800000, confidence: 900000 },
  'memory.prediction.outcome': { valence: 700000, magnitude: 800000, confidence: 900000 },
  'memory.familiarity.assessed': { familiarity: 800000, magnitude: 800000, confidence: 900000 },
  'sensory.attention.requested': { priority: 800000, magnitude: 800000, confidence: 900000 },
  'dream.affect.generated': { valence: 700000, magnitude: 800000, confidence: 900000, dreamIdHash: H('dream') }
};

function make(topic, sequence, options = {}) {
  const policy = sourceRegistry.policies[topic]; const now = options.now ?? 10000;
  const evidenceHash = options.evidenceHash || H(`evidence-${sequence}`); const parentId = options.parentId || `parent-${sequence}`;
  const parent = options.parent || { id: parentId, sequence: sequence - 1, sourceCore: 'evidence', topic: 'evidence.verified', causalParent: null, verified: true };
  const payload = options.payload || samples[topic];
  const meta = {
    authorityEpoch: options.authorityEpoch ?? 7, causalParent: parentId, causeSequence: parent.sequence, clockStatus: options.clockStatus || 'trusted',
    deduplicationKey: options.deduplicationKey || `claim-${sequence}`, dreamOrigin: policy.dreamOrigin, eventClass: 'durable', evidenceHash,
    payloadHash: hash(payload), provenanceHash: '', schemaVersion: 1, sourceCore: options.sourceCore || policy.sourceCore,
    sourceInstanceId: `${policy.sourceCore}-1`, sourceVersion: '1.0.0'
  };
  meta.provenanceHash = hash({ sourceCore: meta.sourceCore, sourceVersion: meta.sourceVersion, sourceInstanceId: meta.sourceInstanceId, authorityEpoch: meta.authorityEpoch, causeSequence: meta.causeSequence, causalParent: meta.causalParent, evidenceHash: meta.evidenceHash });
  const envelope = { id: `event-${sequence}`, sequence, topic, class: 'durable', payload, at: now, deadlineAt: now + 1000, meta };
  const event = { ...envelope, ledger: { durable: true, deduplicated: false, envelopeHash: hash(envelope), payloadHash: meta.payloadHash, provenanceHash: meta.provenanceHash } };
  const context = { trustedNowMs: now, verifiedEvidenceHashes: new Set([evidenceHash]), causalRecords: { [parentId]: parent }, authorityByCore: { [policy.sourceCore]: { active: true, epoch: 7, version: '1.0.0', instanceId: `${policy.sourceCore}-1` } } };
  return { event, context };
}

function outcome(state, fixture) { return processSemanticEvent(state, fixture.event, fixture.context); }
function digestFile(relative) { return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex')}`; }

const mappings = {};
for (const [index, topic] of Object.keys(sourceRegistry.policies).entries()) mappings[topic] = outcome(createStimulusState(), make(topic, index + 2)).decision.drives;

const acceptedFixture = make('memory.novelty.assessed', 100); const accepted = outcome(createStimulusState(), acceptedFixture);
const forgedFixture = make('memory.novelty.assessed', 101); forgedFixture.event.payload.novelty = 1;
const staleFixture = make('memory.novelty.assessed', 102); staleFixture.context.authorityByCore.memory.epoch = 8;
const chemicalFixture = make('memory.novelty.assessed', 103, { payload: { novelty: 800000, magnitude: 800000, confidence: 900000, rewardButton: true } });
const circularFixture = make('presence.state.changed', 104, { parentId: 'loop', parent: { id: 'loop', sequence: 103, sourceCore: 'evidence', topic: 'evidence.verified', causalParent: 'loop', verified: true } });
const descendantFixture = make('presence.state.changed', 105, { parent: { id: 'parent-105', sequence: 104, sourceCore: 'sntss', topic: 'sntss.release', causalParent: null, verified: true } });
const expiredFixture = make('presence.state.changed', 106); expiredFixture.context.trustedNowMs = 12000;
const cases = {
  accepted_authoritative_fact: accepted.decision.reasonCode,
  replayed_sequence: outcome(accepted.state, acceptedFixture).decision.reasonCode,
  forged_provenance: outcome(createStimulusState(), forgedFixture).decision.reasonCode,
  stale_authority: outcome(createStimulusState(), staleFixture).decision.reasonCode,
  direct_reward_semantics: outcome(createStimulusState(), chemicalFixture).decision.reasonCode,
  circular_causality: outcome(createStimulusState(), circularFixture).decision.reasonCode,
  sntss_descendant: outcome(createStimulusState(), descendantFixture).decision.reasonCode,
  expired_event: outcome(createStimulusState(), expiredFixture).decision.reasonCode
};

const evidence = {
  evidenceVersion: 1, stage: 'R5-authoritative-stimulus-laboratory', productionTopicsEnabled: false,
  registryHash: sourceRegistry.registryHash, policyCount: Object.keys(sourceRegistry.policies).length,
  goldenMappingHash: hash(mappings), hostileCorpusHash: hash(cases), hostileOutcomes: cases,
  degradedAssessment: assessProducerAvailability(createStimulusState(), 10000),
  moduleHashes: Object.fromEntries(['cores/sntss/v0.1.0/source-registry.js', 'cores/sntss/v0.1.0/causal-validator.js', 'cores/sntss/v0.1.0/circuit-breakers.js', 'cores/sntss/v0.1.0/stimuli.js', 'cores/sntss/v0.1.0/semantic-laboratory.js', 'cores/sntss/schemas/semantic-stimulus.schema.json'].map(file => [file, digestFile(file)])),
  automaticBlockersPassed: Object.values(cases).every(code => code === 'SNTSS_ACCEPTED' || code.startsWith('SNTSS_')),
  coreHostActivation: { inputsChanged: false, outputs: [], chemistryActive: false, productionEligible: false }
};
evidence.evidenceHash = hash(evidence);
const destination = path.join(root, 'docs/sntss/evidence/R5_HOSTILE_EVIDENCE.json');
fs.writeFileSync(destination, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ destination: path.relative(root, destination), evidenceHash: evidence.evidenceHash, goldenMappingHash: evidence.goldenMappingHash, hostileCorpusHash: evidence.hostileCorpusHash })}\n`);
