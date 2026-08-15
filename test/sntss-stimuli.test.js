'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sourceRegistry, validateSourceRegistry, hash } = require('../cores/sntss/v0.1.0/source-registry');
const { ACTIVE_FAMILIES, DORMANT_FAMILIES } = require('../cores/sntss/v0.1.0/species-profile');
const { createStimulusState, processSemanticEvent, assessProducerAvailability } = require('../cores/sntss/v0.1.0/stimuli');
const sntss = require('../cores/sntss/v0.1.0');

const H = value => hash({ fixture: value });
const payloads = {
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

function fixture(topic, sequence = 2, overrides = {}) {
  const policy = sourceRegistry.policies[topic];
  const now = overrides.now ?? 10000;
  const evidenceHash = overrides.evidenceHash || H(`evidence-${sequence}`);
  const parentId = overrides.parentId || `cause-${sequence}`;
  const parent = overrides.parent || { id: parentId, sequence: sequence - 1, sourceCore: 'evidence', topic: 'evidence.verified', causalParent: null, verified: true };
  const payload = overrides.payload || payloads[topic];
  const meta = {
    authorityEpoch: overrides.authorityEpoch ?? 7, causalParent: parentId, causeSequence: parent.sequence,
    clockStatus: overrides.clockStatus || 'trusted', deduplicationKey: overrides.deduplicationKey || `claim-${sequence}`,
    dreamOrigin: policy.dreamOrigin, eventClass: 'durable', evidenceHash, payloadHash: hash(payload), provenanceHash: '',
    schemaVersion: 1, sourceCore: overrides.sourceCore || policy.sourceCore, sourceInstanceId: overrides.instanceId || `${policy.sourceCore}-1`,
    sourceVersion: overrides.sourceVersion || '1.0.0'
  };
  const provenance = {
    sourceCore: meta.sourceCore, sourceVersion: meta.sourceVersion, sourceInstanceId: meta.sourceInstanceId,
    authorityEpoch: meta.authorityEpoch, causeSequence: meta.causeSequence, causalParent: meta.causalParent, evidenceHash: meta.evidenceHash
  };
  meta.provenanceHash = hash(provenance);
  const envelope = { id: `event-${sequence}`, sequence, topic, class: 'durable', payload, at: now, deadlineAt: now + 1000, meta };
  const event = { ...envelope, ledger: { durable: true, deduplicated: false, envelopeHash: hash(envelope), payloadHash: meta.payloadHash, provenanceHash: meta.provenanceHash } };
  const context = {
    trustedNowMs: now, verifiedEvidenceHashes: new Set([evidenceHash]), causalRecords: { [parentId]: parent },
    authorityByCore: { [policy.sourceCore]: { active: true, epoch: 7, version: '1.0.0', instanceId: `${policy.sourceCore}-1` } }
  };
  return { event, context, parent };
}

function run(state, topic, sequence, overrides) {
  const { event, context } = fixture(topic, sequence, overrides);
  return processSemanticEvent(state, event, context);
}

test('R5 registry freezes fourteen laboratory-only policies and active-family mappings', () => {
  assert.equal(Object.keys(sourceRegistry.policies).length, 14);
  assert.equal(sourceRegistry.productionTopicsEnabled, false);
  assert.ok(Object.isFrozen(sourceRegistry));
  assert.equal(validateSourceRegistry(JSON.parse(JSON.stringify(sourceRegistry))).registryHash, sourceRegistry.registryHash);
  for (const policy of Object.values(sourceRegistry.policies)) {
    assert.equal(policy.productionEnabled, false);
    assert.equal(Object.keys(policy.payloadFields).some(key => ACTIVE_FAMILIES.includes(key)), false);
    for (const family of [...Object.keys(policy.positiveWeights), ...Object.keys(policy.negativeWeights)]) {
      assert.ok(ACTIVE_FAMILIES.includes(family));
      assert.ok(!DORMANT_FAMILIES.includes(family));
    }
  }
  const changed = JSON.parse(JSON.stringify(sourceRegistry)); changed.stage = 'production';
  assert.throws(() => validateSourceRegistry(changed), { code: 'SNTSS_REGISTRY_INVALID' });
});

test('all fourteen canonical semantic facts map deterministically only to bounded active families', () => {
  for (const [index, topic] of Object.keys(sourceRegistry.policies).entries()) {
    const a = run(createStimulusState(), topic, index + 2);
    const b = run(createStimulusState(), topic, index + 2);
    assert.equal(a.decision.reasonCode, 'SNTSS_ACCEPTED', topic);
    assert.deepEqual(a.decision, b.decision, topic);
    for (const [family, drive] of Object.entries(a.decision.drives)) {
      assert.ok(ACTIVE_FAMILIES.includes(family)); assert.ok(Number.isSafeInteger(drive)); assert.ok(Math.abs(drive) <= 1000000);
    }
  }
});

test('forged ledger/provenance and stale producer authority are rejected with zero drive', () => {
  const forged = fixture('memory.prediction.outcome'); forged.event.payload.valence = -1;
  assert.equal(processSemanticEvent(createStimulusState(), forged.event, forged.context).decision.reasonCode, 'SNTSS_PROVENANCE_FORGED');
  const stale = fixture('memory.prediction.outcome', 3); stale.context.authorityByCore.memory.epoch = 8;
  const result = processSemanticEvent(createStimulusState(), stale.event, stale.context);
  assert.equal(result.decision.reasonCode, 'SNTSS_AUTHORITY_STALE'); assert.deepEqual(result.decision.drives, {});
});

test('unverified evidence, direct chemistry requests, and schema confusion are blocked', () => {
  const unverified = fixture('memory.novelty.assessed'); unverified.context.verifiedEvidenceHashes.clear();
  assert.equal(processSemanticEvent(createStimulusState(), unverified.event, unverified.context).decision.reasonCode, 'SNTSS_EVIDENCE_UNVERIFIED');
  const chemical = fixture('memory.novelty.assessed', 3, { payload: { novelty: 800000, magnitude: 800000, confidence: 900000, targetConcentration: 999999 } });
  assert.equal(processSemanticEvent(createStimulusState(), chemical.event, chemical.context).decision.reasonCode, 'SNTSS_DIRECT_CHEMICAL_COMMAND');
  const confused = fixture('memory.novelty.assessed', 4, { payload: { novelty: 800000, magnitude: 800000, confidence: 900000, extra: 1 } });
  assert.equal(processSemanticEvent(createStimulusState(), confused.event, confused.context).decision.reasonCode, 'SNTSS_SCHEMA_CONFUSION');
  const numeric = fixture('memory.novelty.assessed', 5, { payload: { novelty: 1000001, magnitude: 800000, confidence: 900000 } });
  assert.equal(processSemanticEvent(createStimulusState(), numeric.event, numeric.context).decision.reasonCode, 'SNTSS_INVALID_NUMERIC');
});

test('replay, duplicate evidence, and duplicate causal claims cannot create a second dose', () => {
  const first = fixture('memory.novelty.assessed', 2); const accepted = processSemanticEvent(createStimulusState(), first.event, first.context);
  const replay = processSemanticEvent(accepted.state, first.event, first.context);
  assert.equal(replay.decision.reasonCode, 'SNTSS_REPLAY_SEQUENCE'); assert.equal(replay.state, accepted.state);
  const duplicate = fixture('memory.novelty.assessed', 3, { evidenceHash: first.event.meta.evidenceHash });
  duplicate.context.verifiedEvidenceHashes.add(first.event.meta.evidenceHash);
  assert.equal(processSemanticEvent(accepted.state, duplicate.event, duplicate.context).decision.reasonCode, 'SNTSS_DUPLICATE_EVIDENCE');
  const claim = fixture('memory.novelty.assessed', 4, { parentId: first.event.meta.causalParent, parent: first.context.causalRecords[first.event.meta.causalParent], deduplicationKey: first.event.meta.deduplicationKey });
  assert.equal(processSemanticEvent(accepted.state, claim.event, claim.context).decision.reasonCode, 'SNTSS_DUPLICATE_CLAIM');
});

test('circular causality and SNTSS descendants are automatic blockers', () => {
  const circularParent = { id: 'loop', sequence: 1, sourceCore: 'evidence', topic: 'evidence.verified', causalParent: 'loop', verified: true };
  const circular = fixture('presence.state.changed', 3, { parentId: 'loop', parent: circularParent });
  assert.equal(processSemanticEvent(createStimulusState(), circular.event, circular.context).decision.reasonCode, 'SNTSS_CAUSAL_CIRCULAR');
  const descendant = fixture('presence.state.changed', 4, { parent: { id: 'cause-4', sequence: 3, sourceCore: 'sntss', topic: 'sntss.release', causalParent: null, verified: true } });
  assert.equal(processSemanticEvent(createStimulusState(), descendant.event, descendant.context).decision.reasonCode, 'SNTSS_CAUSAL_DESCENDANT');
});

test('future, expired, and degraded-clock events fail closed', () => {
  const future = fixture('presence.state.changed', 2); future.context.trustedNowMs = 9999;
  assert.equal(processSemanticEvent(createStimulusState(), future.event, future.context).decision.reasonCode, 'SNTSS_CLOCK_ANOMALY');
  const expired = fixture('presence.state.changed', 3); expired.context.trustedNowMs = 12000;
  assert.equal(processSemanticEvent(createStimulusState(), expired.event, expired.context).decision.reasonCode, 'SNTSS_EVENT_EXPIRED');
  const degraded = fixture('presence.state.changed', 4, { clockStatus: 'degraded' });
  assert.equal(processSemanticEvent(createStimulusState(), degraded.event, degraded.context).decision.reasonCode, 'SNTSS_CLOCK_DEGRADED');
});

test('contradictory evidence quarantines the producer without fabricating a drive', () => {
  const first = fixture('presence.state.changed', 2); let current = processSemanticEvent(createStimulusState(), first.event, first.context);
  const second = fixture('presence.state.changed', 3, {
    now: 10001, parentId: first.event.meta.causalParent, parent: first.context.causalRecords[first.event.meta.causalParent],
    payload: { state: 'departed', magnitude: 800000, confidence: 900000 }
  });
  current = processSemanticEvent(current.state, second.event, second.context);
  assert.equal(current.decision.reasonCode, 'SNTSS_EVIDENCE_CONTRADICTION'); assert.deepEqual(current.decision.drives, {});
  assert.equal(current.state.breakers['source:presence'].mode, 'open');
});

test('flooding opens a source breaker and recovery consumes a zero-drive probe', () => {
  let state = createStimulusState();
  for (let sequence = 2; sequence <= 9; sequence += 1) state = run(state, 'memory.novelty.assessed', sequence, { now: 10000 }).state;
  for (let sequence = 10; sequence <= 12; sequence += 1) {
    const outcome = run(state, 'memory.novelty.assessed', sequence, { now: 10000 }); state = outcome.state;
  }
  assert.equal(state.breakers['source:memory'].mode, 'open');
  const blocked = run(state, 'memory.novelty.assessed', 13, { now: 10001 }); state = blocked.state;
  assert.equal(blocked.decision.reasonCode, 'SNTSS_BREAKER_OPEN');
  const probe = run(state, 'memory.novelty.assessed', 14, { now: 40000 });
  assert.equal(probe.decision.reasonCode, 'SNTSS_BREAKER_RECOVERY_PROBE'); assert.deepEqual(probe.decision.drives, {});
  assert.equal(probe.state.breakers['source:memory'].mode, 'closed');
});

test('habituation reduces repeated response and downtime recovers analytically without resetting history', () => {
  let state = createStimulusState();
  const first = run(state, 'memory.novelty.assessed', 2, { now: 10000 }); state = first.state;
  const second = run(state, 'memory.novelty.assessed', 3, { now: 11100 }); state = second.state;
  assert.ok(second.decision.dose < first.decision.dose);
  const exposures = state.habituation['memory.novelty.assessed'].exposures;
  const recovered = run(state, 'memory.novelty.assessed', 4, { now: 1011100 });
  assert.ok(recovered.decision.dose > second.decision.dose);
  assert.equal(recovered.state.habituation['memory.novelty.assessed'].exposures, exposures + 1);
});

test('missing, late, and quarantined producers yield degraded zero-drive assessments without state mutation', () => {
  const empty = createStimulusState(); const before = JSON.stringify(empty);
  const missing = assessProducerAvailability(empty, 10000);
  assert.equal(missing.mode, 'degraded'); assert.deepEqual(missing.drives, {}); assert.equal(JSON.stringify(empty), before);
  const bad = fixture('presence.state.changed', 2, { authorityEpoch: 99 });
  const quarantinedState = processSemanticEvent(empty, bad.event, bad.context).state;
  assert.equal(assessProducerAvailability(quarantinedState, 10000).producers.presence.status, 'quarantined');
});

test('dream evidence remains permanently marked and capped', () => {
  const result = run(createStimulusState(), 'dream.affect.generated', 2);
  assert.equal(result.decision.dreamOrigin, true); assert.ok(result.decision.dose <= 100000);
});

test('every state-changing decision carries a stable hash-chained causal trace', () => {
  const a = run(createStimulusState(), 'memory.novelty.assessed', 2);
  const bad = fixture('memory.novelty.assessed', 3); bad.context.verifiedEvidenceHashes.clear();
  const b = processSemanticEvent(a.state, bad.event, bad.context);
  assert.equal(a.decision.trace.previousTraceHash, createStimulusState().traceHead);
  assert.equal(b.decision.trace.previousTraceHash, a.state.traceHead);
  assert.match(b.decision.trace.traceHash, /^sha256:[0-9a-f]{64}$/);
});

test('CoreHost remains inert: no semantic subscriptions, outputs, or production eligibility', async () => {
  assert.equal(sntss.manifest.productionEligible, false); assert.deepEqual(sntss.manifest.outputs, []);
  assert.deepEqual(sntss.manifest.inputs, ['runtime.organism.binding', 'runtime.time.pulse']);
  const core = await sntss.createCore({ initialState: {} }); await core.start();
  const health = await core.health(); assert.equal(health.chemistryActive, false); assert.equal(health.productionSemanticTopics, 0); assert.equal(health.semanticPolicies, 14);
});

test('committed hostile evidence matches its content and controlling R5 modules', () => {
  const root = path.resolve(__dirname, '..');
  const evidence = JSON.parse(fs.readFileSync(path.join(root, 'docs/sntss/evidence/R5_HOSTILE_EVIDENCE.json'), 'utf8'));
  const { evidenceHash, ...body } = evidence;
  assert.equal(evidenceHash, hash(body)); assert.equal(evidence.registryHash, sourceRegistry.registryHash);
  for (const [file, expected] of Object.entries(evidence.moduleHashes)) {
    const actual = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')}`;
    assert.equal(actual, expected, file);
  }
  assert.equal(evidence.coreHostActivation.chemistryActive, false);
});
