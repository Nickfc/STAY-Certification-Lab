'use strict';

const {
  stableStringify,
} = require('../../../runtime/kernel/canonical-json');

const { createFounderState, sha256 } = require('./founder');
const { appendAggregateObservation } = require('./aggregate');
const { integrateEvidencePlan } = require('./entrainment');
const { MAX_INTEGRATION_STEPS } = require('./oscillator');
const { PROFILE } = require('./calibration-profile');
const { PHOTIC_PROFILE } = require('./photic-calibration-profile');
const { normalizePhoticEvidence, PHOTIC_TOPIC } = require('./photic-transducer');
const { LONG_GAP_THRESHOLD_US, skipLongInterval } = require('./long-gap');
const { STATE_SCHEMA, fail, validateState } = require('./validation');

const TRUSTED_TIME_TOPIC = 'runtime.trusted-organism-time.pulse';

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function emptyState() {
  return freeze({
    schema: STATE_SCHEMA,
    mode: 'NEUTRAL',
    binding: null,
    genesis: null,
    phenotype: null,
    acquired: null,
    continuity: null,
  });
}

function normalizeState(input) {
  const candidate = input && Object.keys(input).length > 0
    ? structuredClone(input)
    : emptyState();
  if (candidate.genesis && candidate.continuity) {
    candidate.acquired.aggregate_phase_history ??= [];
    candidate.continuity.photic_route_configured ??= false;
    candidate.continuity.pending_photic_evidence ??= [];
    candidate.continuity.recent_photic_evidence ??= [];
    candidate.continuity.last_summary_emitted_us ??= null;
    candidate.continuity.last_summary_payload_hash ??= null;
    candidate.continuity.deferred_trusted_time_evidence ??= null;
  }
  validateState(candidate);
  return freeze(candidate);
}

function normalizeBindingEvent(event) {
  const payload = event?.payload;
  if (event?.topic !== 'runtime.organism.binding'
    || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.bindingVersion !== 1
    || typeof payload.identitySha256 !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(payload.identitySha256)
    || payload.organismLineage !== 'STAY/Genesis'
    || !Number.isSafeInteger(payload.runtimeRevision) || payload.runtimeRevision < 1
    || !Number.isSafeInteger(payload.authorityEpoch) || payload.authorityEpoch < 1
    || typeof payload.kernelVersion !== 'string' || !payload.kernelVersion
    || event.meta?.sourceCore !== 'living-kernel'
    || event.meta?.authorityEpoch !== payload.authorityEpoch) {
    fail('organism binding is not Kernel-authenticated', 'CHRONOBIOLOGY_BINDING_INVALID');
  }
  return freeze({
    organism_id: payload.identitySha256,
    organism_lineage: payload.organismLineage,
    runtime_revision: payload.runtimeRevision,
    kernel_authority_epoch: payload.authorityEpoch,
    kernel_version: payload.kernelVersion,
    binding_event_id: String(event.id),
  });
}

function bindState(state, event) {
  const current = normalizeState(state);
  const binding = normalizeBindingEvent(event);
  if (current.binding) {
    if (current.binding.organism_id !== binding.organism_id
      || current.binding.organism_lineage !== binding.organism_lineage
      || current.binding.kernel_authority_epoch !== binding.kernel_authority_epoch) {
      fail('organism binding changed after acceptance', 'CHRONOBIOLOGY_BINDING_MISMATCH');
    }
    return current;
  }
  return normalizeState({ ...current, binding });
}

function normalizeTrustedTimeEvent(event) {
  const payload = event?.payload;
  if (event?.topic !== TRUSTED_TIME_TOPIC
    || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || !Number.isSafeInteger(payload.runtimeRevision) || payload.runtimeRevision < 1
    || !Number.isSafeInteger(payload.pulseSequence) || payload.pulseSequence < 1
    || !['TRUSTED', 'TRUSTED_TIME_UNCERTAIN', 'TRUSTED_TIME_UNAVAILABLE'].includes(payload.status)
    || event.meta?.sourceCore !== 'living-kernel') {
    fail('trusted organism-time evidence is invalid', 'CHRONOBIOLOGY_TIME_INVALID');
  }

  if (payload.status === 'TRUSTED') {
    if (!Number.isSafeInteger(payload.trustedTimeUs) || payload.trustedTimeUs < 0
      || !Number.isSafeInteger(payload.continuityEpoch) || payload.continuityEpoch < 1
      || payload.reasonCode !== null) {
      fail('trusted organism-time evidence is incomplete', 'CHRONOBIOLOGY_TIME_INVALID');
    }
  } else if (payload.trustedTimeUs !== null || payload.continuityEpoch !== null
    || typeof payload.reasonCode !== 'string' || !payload.reasonCode) {
    fail('uncertain organism-time evidence invented a frontier', 'CHRONOBIOLOGY_TIME_INVALID');
  }

  return freeze({
    runtime_revision: payload.runtimeRevision,
    pulse_sequence: payload.pulseSequence,
    status: payload.status,
    trusted_time_us: payload.trustedTimeUs,
    continuity_epoch: payload.continuityEpoch,
    reason_code: payload.reasonCode,
  });
}

function evidenceHash(evidence) {
  return sha256(stableStringify(evidence));
}

function normalizeRouteCompleteness(event) {
  const value = event?.meta?.residentRouteCompleteness;
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.complete !== 'boolean'
    || typeof value.unconstrained !== 'boolean'
    || typeof value.configured !== 'boolean'
    || (value.frontierUs !== null
      && (!Number.isSafeInteger(value.frontierUs) || value.frontierUs < 0))
    || typeof value.pendingEvidence !== 'boolean'
    || !Array.isArray(value.activeRoutes)
    || !Array.isArray(value.blockers)
    || !Array.isArray(value.releasedRoutes)) {
    fail('resident route completeness is invalid', 'CHRONOBIOLOGY_ROUTE_INVALID');
  }
  return freeze(structuredClone(value));
}

function withRouteContext(state, context) {
  if (!context) return state;
  return {
    ...state,
    continuity: {
      ...state.continuity,
      photic_route_configured: context.configured,
      input_route_states: {
        ...state.continuity.input_route_states,
        photic: context,
      },
    },
  };
}

function routeAllowsAdvance(context, targetUs) {
  if (!context || !context.configured) return true;
  if (!context.complete || context.pendingEvidence) return false;
  if (context.unconstrained) return true;
  return Number.isSafeInteger(context.frontierUs) && context.frontierUs >= targetUs;
}

function deferTrustedTime(state, evidence, context) {
  const previous = state.continuity.deferred_trusted_time_evidence;
  if (previous && (evidence.runtime_revision < previous.runtime_revision
    || (evidence.runtime_revision === previous.runtime_revision
      && evidence.pulse_sequence < previous.pulse_sequence))) {
    fail('deferred trusted pulse rewound', 'CHRONOBIOLOGY_TIME_REWIND');
  }
  return normalizeState({
    ...withRouteContext(state, context),
    continuity: {
      ...withRouteContext(state, context).continuity,
      deferred_trusted_time_evidence: evidence,
    },
  });
}

function queuePhoticEvidence(state, event) {
  const current = normalizeState(state);
  if (!current.genesis) {
    fail('photic evidence cannot precede canonical genesis', 'CHRONOBIOLOGY_PHOTIC_BEFORE_GENESIS');
  }
  const normalized = normalizePhoticEvidence(event);
  const evidence = Object.freeze({
    ...normalized,
    evidence_hash: evidenceHash(normalized),
  });
  const pending = current.continuity.pending_photic_evidence;
  const recent = current.continuity.recent_photic_evidence;
  const consumed = recent.find(entry => entry.event_id === evidence.event_id);
  if (consumed) {
    if (consumed.evidence_hash === evidence.evidence_hash) return current;
    fail('consumed photic evidence identity conflicts with content', 'CHRONOBIOLOGY_PHOTIC_CONFLICT');
  }
  const duplicate = pending.find(entry => entry.event_id === evidence.event_id);
  if (duplicate) {
    if (stableStringify(duplicate) === stableStringify(evidence)) return current;
    fail('photic evidence identity conflicts with queued content', 'CHRONOBIOLOGY_PHOTIC_CONFLICT');
  }
  if (evidence.effective_from_us < current.continuity.committed_through_us) {
    fail('photic evidence arrived behind committed physiology', 'CHRONOBIOLOGY_PHOTIC_LATE');
  }
  const previous = pending.at(-1);
  if (previous && evidence.effective_from_us < previous.effective_to_us) {
    fail('photic evidence intervals overlap', 'CHRONOBIOLOGY_PHOTIC_OVERLAP');
  }
  if (pending.length >= PHOTIC_PROFILE.evidenceCapacity) {
    fail('photic evidence queue capacity exceeded', 'CHRONOBIOLOGY_PHOTIC_BACKPRESSURE');
  }
  return normalizeState({
    ...current,
    continuity: {
      ...current.continuity,
      photic_route_configured: true,
      pending_photic_evidence: [...pending, evidence],
    },
  });
}

function initializeGenesis(state, evidence, founderSeedHex) {
  const current = normalizeState(state);
  if (current.genesis !== null) {
    fail('canonical Chronobiology genesis already exists', 'CHRONOBIOLOGY_SECOND_GENESIS');
  }
  if (!current.binding || evidence.status !== 'TRUSTED') {
    fail('canonical genesis requires binding and trusted organism time', 'CHRONOBIOLOGY_GENESIS_UNTRUSTED');
  }

  const founder = createFounderState({
    organismId: current.binding.organism_id,
    trustedTimeUs: evidence.trusted_time_us,
    runtimeRevision: evidence.runtime_revision,
    pulseSequence: evidence.pulse_sequence,
    continuityEpoch: evidence.continuity_epoch,
    ...(founderSeedHex === undefined ? {} : { founderSeedHex }),
  });
  const next = appendAggregateObservation({
    ...current,
    ...founder,
    continuity: {
      ...founder.continuity,
      last_trusted_evidence_hash: evidenceHash(evidence),
      photic_route_configured: false,
      pending_photic_evidence: Object.freeze([]),
      recent_photic_evidence: Object.freeze([]),
      last_summary_emitted_us: null,
      last_summary_payload_hash: null,
    },
  }, evidence.trusted_time_us);
  return normalizeState(next);
}

function recordSummaryEmission(state, payload) {
  const current = normalizeState(state);
  if (!current.genesis || !current.continuity) {
    fail('phase summary cannot precede genesis', 'CHRONOBIOLOGY_SUMMARY_BEFORE_GENESIS');
  }
  const emittedAtUs = current.continuity.committed_through_us;
  const payloadHash = evidenceHash(payload);
  if (current.continuity.last_summary_emitted_us === emittedAtUs) {
    if (current.continuity.last_summary_payload_hash === payloadHash) return current;
    fail('phase summary identity conflicts at one biological frontier',
      'CHRONOBIOLOGY_SUMMARY_CONFLICT');
  }
  return normalizeState({
    ...current,
    continuity: {
      ...current.continuity,
      last_summary_emitted_us: emittedAtUs,
      last_summary_payload_hash: payloadHash,
    },
  });
}

function advanceTrustedTime(state, event, { founderSeedHex } = {}) {
  const current = normalizeState(state);
  const evidence = normalizeTrustedTimeEvent(event);
  const routeContext = normalizeRouteCompleteness(event);
  if (evidence.status !== 'TRUSTED') return current;
  if (!current.binding) return current;
  if (!current.genesis) return initializeGenesis(current, evidence, founderSeedHex);

  if (!routeAllowsAdvance(routeContext, evidence.trusted_time_us)) {
    return deferTrustedTime(current, evidence, routeContext);
  }

  const routedCurrent = withRouteContext(current, routeContext);

  const continuity = routedCurrent.continuity;
  const hash = evidenceHash(evidence);
  if (evidence.runtime_revision < continuity.last_runtime_revision) {
    fail('runtime revision rewound', 'CHRONOBIOLOGY_TIME_REWIND');
  }
  if (evidence.runtime_revision === continuity.last_runtime_revision) {
    if (evidence.pulse_sequence === continuity.last_trusted_pulse_sequence) {
      if (hash === continuity.last_trusted_evidence_hash) return current;
      fail('trusted pulse identity conflicts with committed evidence', 'CHRONOBIOLOGY_TIME_CONFLICT');
    }
    if (evidence.pulse_sequence < continuity.last_trusted_pulse_sequence) {
      fail('trusted pulse sequence rewound', 'CHRONOBIOLOGY_TIME_REWIND');
    }
  }
  if (evidence.continuity_epoch < continuity.trusted_time_continuity_epoch
    || evidence.trusted_time_us < continuity.committed_through_us) {
    fail('trusted organism time rewound', 'CHRONOBIOLOGY_TIME_REWIND');
  }

  const interval = evidence.trusted_time_us - continuity.committed_through_us;
  const maySkip = interval > LONG_GAP_THRESHOLD_US
    && continuity.pending_photic_evidence.length === 0;
  if (!maySkip && Math.ceil(interval / PROFILE.integrationQuantumUs) > MAX_INTEGRATION_STEPS) {
    fail('trusted interval exceeds bounded integration work', 'CHRONOBIOLOGY_INTERVAL_BOUND');
  }
  const integrated = maySkip
    ? skipLongInterval(routedCurrent, evidence.trusted_time_us, {
      evidenceGap: continuity.photic_route_configured,
    })
    : integrateEvidencePlan(routedCurrent, evidence.trusted_time_us);
  const remainingIds = new Set((integrated.pending_photic_evidence
    ?? continuity.pending_photic_evidence).map(entry => entry.event_id));
  const consumedEvidence = continuity.pending_photic_evidence
    .filter(entry => !remainingIds.has(entry.event_id))
    .map(entry => Object.freeze({
      event_id: entry.event_id,
      evidence_hash: entry.evidence_hash,
    }));
  const advanced = appendAggregateObservation({
    ...routedCurrent,
    acquired: integrated.acquired,
    continuity: {
      ...continuity,
      committed_through_us: evidence.trusted_time_us,
      last_trusted_pulse_sequence: evidence.pulse_sequence,
      last_runtime_revision: evidence.runtime_revision,
      trusted_time_continuity_epoch: evidence.continuity_epoch,
      last_trusted_evidence_hash: hash,
      deferred_trusted_time_evidence: null,
      pending_photic_evidence:
        integrated.pending_photic_evidence ?? continuity.pending_photic_evidence,
      recent_photic_evidence: [
        ...continuity.recent_photic_evidence,
        ...consumedEvidence,
      ].slice(-PROFILE.entrainmentHistoryCapacity),
    },
  }, evidence.trusted_time_us);
  return normalizeState(advanced);
}

function resumeDeferredTrustedTime(state, event) {
  const current = normalizeState(state);
  const deferred = current.continuity?.deferred_trusted_time_evidence;
  const routeContext = normalizeRouteCompleteness(event);
  if (!deferred || !routeAllowsAdvance(routeContext, deferred.trusted_time_us)) return current;
  return advanceTrustedTime(current, {
    id: `deferred-trusted-${deferred.runtime_revision}-${deferred.pulse_sequence}`,
    topic: TRUSTED_TIME_TOPIC,
    payload: {
      runtimeRevision: deferred.runtime_revision,
      pulseSequence: deferred.pulse_sequence,
      status: deferred.status,
      trustedTimeUs: deferred.trusted_time_us,
      continuityEpoch: deferred.continuity_epoch,
      reasonCode: deferred.reason_code,
    },
    meta: {
      sourceCore: 'living-kernel',
      residentRouteCompleteness: routeContext,
    },
  });
}

module.exports = {
  TRUSTED_TIME_TOPIC,
  PHOTIC_TOPIC,
  advanceTrustedTime,
  bindState,
  emptyState,
  evidenceHash,
  freeze,
  initializeGenesis,
  normalizeBindingEvent,
  normalizeState,
  normalizeTrustedTimeEvent,
  queuePhoticEvidence,
  recordSummaryEmission,
  resumeDeferredTrustedTime,
};
