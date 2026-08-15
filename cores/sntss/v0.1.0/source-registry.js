'use strict';

const crypto = require('node:crypto');
const fp = require('./fixed-point');
const { ACTIVE_FAMILIES } = require('./species-profile');
const { stableStringify } = require('../../../runtime/kernel/canonical-json');

const HASH = /^sha256:[0-9a-f]{64}$/;
const DEFAULT_LIMITS = Object.freeze({
  maxDurationMs: 5000,
  maxDose: 600000,
  rateWindowMs: 1000,
  maxEventsPerWindow: 8,
  cooldownMs: 0,
  habituationStrength: 650000,
  habituationGain: 120000,
  habituationRetentionPerSecond: 999000,
  missingAfterMs: 60000,
  contradictionWindowMs: 5000
});
const BREAKER_POLICY = Object.freeze({
  version: 1,
  violationWindowMs: 10000,
  violationThreshold: 3,
  recoveryMs: 30000,
  maximumTrackedCausalPaths: 256
});

function hash(value) { return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`; }
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
function scaled() { return { type: 'scaled' }; }
function signed() { return { type: 'signed' }; }
function hashField() { return { type: 'hash' }; }
function enumeration(values) { return { type: 'enum', values: [...values] }; }

function policy({ topic, sourceCore, semanticClass, payloadFields, signal, positiveWeights, negativeWeights = {}, contradictionField = null, dreamOrigin = false, limits = {} }) {
  const body = {
    policyVersion: 1,
    topic,
    sourceCore,
    semanticClass,
    payloadFields,
    signal,
    positiveWeights,
    negativeWeights,
    contradictionField,
    dreamOrigin,
    productionEnabled: false,
    limits: { ...DEFAULT_LIMITS, ...limits }
  };
  return { ...body, policyHash: hash(body) };
}

const policies = {
  'presence.state.changed': policy({
    topic: 'presence.state.changed', sourceCore: 'presence', semanticClass: 'presence-state',
    payloadFields: { state: enumeration(['arrived', 'departed']), magnitude: scaled(), confidence: scaled() },
    signal: { kind: 'enum', field: 'state', values: { arrived: fp.SCALE, departed: -fp.SCALE }, magnitudeField: 'magnitude', confidenceField: 'confidence' },
    positiveWeights: { 'serotonin-like': 250000, 'dopamine-like': 100000 },
    negativeWeights: { 'serotonin-like': -150000, 'noradrenaline-like': 100000 }, contradictionField: 'state'
  }),
  'social.interaction.verified': policy({
    topic: 'social.interaction.verified', sourceCore: 'social-identity', semanticClass: 'verified-social-interaction',
    payloadFields: { valence: signed(), magnitude: scaled(), confidence: scaled() },
    signal: { kind: 'signed', field: 'valence', magnitudeField: 'magnitude', confidenceField: 'confidence' },
    positiveWeights: { 'serotonin-like': 300000, 'dopamine-like': 150000 },
    negativeWeights: { 'serotonin-like': -250000, 'noradrenaline-like': 250000 }, contradictionField: 'valence'
  }),
  'activity.phase.changed': policy({
    topic: 'activity.phase.changed', sourceCore: 'activity', semanticClass: 'activity-phase',
    payloadFields: { phase: enumeration(['rest', 'active', 'recovery']), magnitude: scaled(), confidence: scaled() },
    signal: { kind: 'enum', field: 'phase', values: { rest: -fp.SCALE, active: fp.SCALE, recovery: -500000 }, magnitudeField: 'magnitude', confidenceField: 'confidence' },
    positiveWeights: { 'noradrenaline-like': 250000, 'acetylcholine-like': 150000 },
    negativeWeights: { 'noradrenaline-like': -200000, 'gaba-like': 100000, 'serotonin-like': 150000 }, contradictionField: 'phase'
  }),
  'homeostasis.state.changed': policy({
    topic: 'homeostasis.state.changed', sourceCore: 'homeostasis', semanticClass: 'homeostasis-state',
    payloadFields: { state: enumeration(['stable', 'strained', 'recovering']), magnitude: scaled(), confidence: scaled() },
    signal: { kind: 'enum', field: 'state', values: { stable: -400000, strained: fp.SCALE, recovering: -500000 }, magnitudeField: 'magnitude', confidenceField: 'confidence' },
    positiveWeights: { 'noradrenaline-like': 500000, 'glutamate-like': 150000 },
    negativeWeights: { 'noradrenaline-like': -200000, 'serotonin-like': 200000, 'gaba-like': 150000 }, contradictionField: 'state'
  }),
  'homeostasis.need.changed': policy({
    topic: 'homeostasis.need.changed', sourceCore: 'homeostasis', semanticClass: 'homeostasis-need',
    payloadFields: { direction: enumeration(['increased', 'decreased']), needClass: enumeration(['energy', 'rest', 'thermal', 'safety']), magnitude: scaled(), confidence: scaled() },
    signal: { kind: 'enum', field: 'direction', values: { increased: fp.SCALE, decreased: -fp.SCALE }, magnitudeField: 'magnitude', confidenceField: 'confidence' },
    positiveWeights: { 'dopamine-like': 250000, 'noradrenaline-like': 300000 },
    negativeWeights: { 'dopamine-like': -100000, 'serotonin-like': 150000, 'gaba-like': 100000 }, contradictionField: 'direction'
  }),
  'instinct.threat.assessed': policy({
    topic: 'instinct.threat.assessed', sourceCore: 'primordial-instinct', semanticClass: 'threat-assessment',
    payloadFields: { assessment: enumeration(['uncertain', 'present', 'cleared']), magnitude: scaled(), confidence: scaled() },
    signal: { kind: 'enum', field: 'assessment', values: { uncertain: 500000, present: fp.SCALE, cleared: -fp.SCALE }, magnitudeField: 'magnitude', confidenceField: 'confidence' },
    positiveWeights: { 'noradrenaline-like': 800000, 'glutamate-like': 250000, 'acetylcholine-like': 150000 },
    negativeWeights: { 'noradrenaline-like': -500000, 'gaba-like': 450000, 'serotonin-like': 200000 }, contradictionField: 'assessment',
    limits: { maxDose: 500000, maxEventsPerWindow: 4, cooldownMs: 100 }
  }),
  'instinct.drive.changed': policy({
    topic: 'instinct.drive.changed', sourceCore: 'primordial-instinct', semanticClass: 'instinct-drive',
    payloadFields: { direction: enumeration(['increased', 'decreased']), driveClass: enumeration(['explore', 'protect', 'rest', 'seek-resource']), magnitude: scaled(), confidence: scaled() },
    signal: { kind: 'enum', field: 'direction', values: { increased: fp.SCALE, decreased: -fp.SCALE }, magnitudeField: 'magnitude', confidenceField: 'confidence' },
    positiveWeights: { 'dopamine-like': 300000, 'noradrenaline-like': 200000 },
    negativeWeights: { 'dopamine-like': -150000, 'gaba-like': 100000 }, contradictionField: 'direction'
  }),
  'pain.damage.registered': policy({
    topic: 'pain.damage.registered', sourceCore: 'synthetic-pain', semanticClass: 'damage-registration',
    payloadFields: { status: enumeration(['new', 'worsened', 'stable']), magnitude: scaled(), confidence: scaled() },
    signal: { kind: 'enum', field: 'status', values: { new: fp.SCALE, worsened: fp.SCALE, stable: 250000 }, magnitudeField: 'magnitude', confidenceField: 'confidence' },
    positiveWeights: { 'noradrenaline-like': 700000, 'glutamate-like': 350000 }, negativeWeights: {}, contradictionField: 'status',
    limits: { maxDose: 500000, maxEventsPerWindow: 4, cooldownMs: 100 }
  }),
  'pain.relief.registered': policy({
    topic: 'pain.relief.registered', sourceCore: 'synthetic-pain', semanticClass: 'verified-relief',
    payloadFields: { relief: enumeration(['verified', 'partial']), magnitude: scaled(), confidence: scaled() },
    signal: { kind: 'enum', field: 'relief', values: { verified: fp.SCALE, partial: 500000 }, magnitudeField: 'magnitude', confidenceField: 'confidence' },
    positiveWeights: { 'gaba-like': 500000, 'noradrenaline-like': -500000, 'serotonin-like': 250000 }, negativeWeights: {}, contradictionField: 'relief',
    limits: { maxDose: 400000, maxEventsPerWindow: 4, cooldownMs: 100 }
  }),
  'memory.novelty.assessed': policy({
    topic: 'memory.novelty.assessed', sourceCore: 'memory', semanticClass: 'novelty-assessment',
    payloadFields: { novelty: scaled(), magnitude: scaled(), confidence: scaled() },
    signal: { kind: 'scaled', field: 'novelty', magnitudeField: 'magnitude', confidenceField: 'confidence' },
    positiveWeights: { 'dopamine-like': 600000, 'acetylcholine-like': 450000, 'noradrenaline-like': 150000 }
  }),
  'memory.prediction.outcome': policy({
    topic: 'memory.prediction.outcome', sourceCore: 'memory', semanticClass: 'prediction-outcome',
    payloadFields: { valence: signed(), magnitude: scaled(), confidence: scaled() },
    signal: { kind: 'signed', field: 'valence', magnitudeField: 'magnitude', confidenceField: 'confidence' },
    positiveWeights: { 'dopamine-like': 700000, 'acetylcholine-like': 200000 },
    negativeWeights: { 'dopamine-like': -500000, 'noradrenaline-like': 350000 }, contradictionField: 'valence'
  }),
  'memory.familiarity.assessed': policy({
    topic: 'memory.familiarity.assessed', sourceCore: 'memory', semanticClass: 'familiarity-assessment',
    payloadFields: { familiarity: scaled(), magnitude: scaled(), confidence: scaled() },
    signal: { kind: 'scaled', field: 'familiarity', magnitudeField: 'magnitude', confidenceField: 'confidence' },
    positiveWeights: { 'serotonin-like': 350000, 'noradrenaline-like': -250000 }
  }),
  'sensory.attention.requested': policy({
    topic: 'sensory.attention.requested', sourceCore: 'sensory', semanticClass: 'sensory-attention-priority',
    payloadFields: { priority: scaled(), magnitude: scaled(), confidence: scaled() },
    signal: { kind: 'scaled', field: 'priority', magnitudeField: 'magnitude', confidenceField: 'confidence' },
    positiveWeights: { 'acetylcholine-like': 700000, 'noradrenaline-like': 250000 },
    limits: { maxDose: 500000, maxEventsPerWindow: 6 }
  }),
  'dream.affect.generated': policy({
    topic: 'dream.affect.generated', sourceCore: 'dream', semanticClass: 'dream-affect',
    payloadFields: { valence: signed(), magnitude: scaled(), confidence: scaled(), dreamIdHash: hashField() },
    signal: { kind: 'signed', field: 'valence', magnitudeField: 'magnitude', confidenceField: 'confidence' },
    positiveWeights: { 'dopamine-like': 100000, 'serotonin-like': 100000 },
    negativeWeights: { 'serotonin-like': -100000, 'noradrenaline-like': 100000 }, contradictionField: 'valence', dreamOrigin: true,
    limits: { maxDose: 100000, maxEventsPerWindow: 2, cooldownMs: 500, missingAfterMs: 300000 }
  })
};

const body = {
  registryVersion: 1,
  stage: 'laboratory-r5',
  productionTopicsEnabled: false,
  fixedPointScale: fp.SCALE,
  breakerPolicy: BREAKER_POLICY,
  policies: Object.fromEntries(Object.keys(policies).sort().map(topic => [topic, policies[topic]]))
};
const sourceRegistry = deepFreeze({ ...body, registryHash: hash(body) });

function validateSourceRegistry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('source registry is invalid'), { code: 'SNTSS_REGISTRY_INVALID' });
  const expectedTopics = Object.keys(sourceRegistry.policies);
  if (input.registryVersion !== 1 || input.stage !== 'laboratory-r5' || input.productionTopicsEnabled !== false || input.fixedPointScale !== fp.SCALE) {
    throw Object.assign(new Error('source registry header changed'), { code: 'SNTSS_REGISTRY_INVALID' });
  }
  if (stableStringify(Object.keys(input.policies || {}).sort()) !== stableStringify(expectedTopics)) throw Object.assign(new Error('source registry topic inventory changed'), { code: 'SNTSS_REGISTRY_INVALID' });
  for (const topic of expectedTopics) {
    const candidate = input.policies[topic];
    if (!candidate || candidate.topic !== topic || candidate.productionEnabled !== false || candidate.policyHash !== hash(Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'policyHash')))) {
      throw Object.assign(new Error(`source policy is invalid: ${topic}`), { code: 'SNTSS_POLICY_HASH_MISMATCH' });
    }
    for (const weights of [candidate.positiveWeights, candidate.negativeWeights]) {
      for (const [family, weight] of Object.entries(weights || {})) {
        if (!ACTIVE_FAMILIES.includes(family) || !Number.isSafeInteger(weight) || weight < fp.SIGNED_MIN || weight > fp.SIGNED_MAX) {
          throw Object.assign(new Error(`source policy has invalid family mapping: ${topic}`), { code: 'SNTSS_POLICY_FAMILY' });
        }
      }
    }
  }
  const { registryHash, ...candidateBody } = input;
  if (!HASH.test(registryHash) || registryHash !== hash(candidateBody)) throw Object.assign(new Error('source registry hash mismatch'), { code: 'SNTSS_REGISTRY_HASH_MISMATCH' });
  if (stableStringify(input) !== stableStringify(sourceRegistry)) throw Object.assign(new Error('source registry differs from the frozen R5 contract'), { code: 'SNTSS_REGISTRY_INVALID' });
  return input;
}

validateSourceRegistry(sourceRegistry);

module.exports = { DEFAULT_LIMITS, BREAKER_POLICY, sourceRegistry, validateSourceRegistry, hash };
