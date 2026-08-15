'use strict';

const packagePolicy = require('./package-policy.json');
const { hash } = require('./species-profile');

const MAX_INCIDENTS = 128;
const MAX_SCOPE_INCIDENTS = 3;
const MODES = Object.freeze(['healthy', 'degraded', 'quarantined', 'terminated']);
const KINDS = Object.freeze([
  'audit-flood', 'cpu-pressure', 'event-flood', 'governor-bypass', 'hang', 'invalid-checkpoint',
  'migration-overrun', 'oom', 'output-abuse', 'pids-exhaustion', 'process-escape', 'sigkill', 'unsafe-shutdown'
]);
const SCOPES = Object.freeze(['receptor', 'source', 'transmitter', 'global']);
const TERMINATING_KINDS = new Set(['governor-bypass', 'invalid-checkpoint', 'process-escape', 'unsafe-shutdown']);
const INCIDENT_KEYS = Object.freeze(['checkpointHash', 'detailHash', 'evidenceHash', 'incidentId', 'kind', 'observedAtCursor', 'runtimeTrusted', 'scope', 'severity']);

function fail(message, code = 'SNTSS_CONTAINMENT_INVALID') { throw Object.assign(new Error(message), { code }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} fields are not canonical`);
}
function validHash(value) { return /^sha256:[0-9a-f]{64}$/.test(value); }

function createContainmentState(lineage, checkpointHash) {
  if (!validHash(lineage) || !validHash(checkpointHash)) fail('containment lineage or checkpoint is invalid');
  const body = {
    version: 1, lineage, mode: 'healthy', incidents: [], breakerScopes: {},
    evidenceHead: hash({ protocol: 'stay-sntss-containment-v1', lineage, checkpointHash }),
    failedStateRef: null, lastVerifiedCheckpointHash: checkpointHash, forceTermination: false
  };
  return body;
}

function validateIncident(incident) {
  exactKeys(incident, INCIDENT_KEYS, 'containment incident');
  if (!KINDS.includes(incident.kind) || !SCOPES.includes(incident.scope) || !['warning', 'critical'].includes(incident.severity)) fail('incident classification is invalid');
  if (incident.runtimeTrusted !== true) fail('only trusted runtime evidence may drive containment', 'SNTSS_CONTAINMENT_AUTHORITY');
  if (!Number.isSafeInteger(incident.observedAtCursor) || incident.observedAtCursor < 0) fail('incident cursor is invalid');
  for (const key of ['checkpointHash', 'detailHash', 'evidenceHash']) if (!validHash(incident[key])) fail(`incident ${key} is invalid`);
  if (typeof incident.incidentId !== 'string' || !incident.incidentId || incident.incidentId.length > 128) fail('incident identity is invalid');
  return incident;
}

function validateContainmentState(state) {
  exactKeys(state, ['breakerScopes', 'evidenceHead', 'failedStateRef', 'forceTermination', 'incidents', 'lastVerifiedCheckpointHash', 'lineage', 'mode', 'version'], 'containment state');
  if (state.version !== 1 || !validHash(state.lineage) || !validHash(state.evidenceHead) || !validHash(state.lastVerifiedCheckpointHash) || !MODES.includes(state.mode)) fail('containment state header is invalid');
  if (!Array.isArray(state.incidents) || state.incidents.length > MAX_INCIDENTS) fail('containment incident history is oversized');
  state.incidents.forEach(validateIncident);
  if (!state.breakerScopes || typeof state.breakerScopes !== 'object' || Array.isArray(state.breakerScopes) || Object.keys(state.breakerScopes).length > 64) fail('containment breaker set is invalid');
  for (const [scope, record] of Object.entries(state.breakerScopes)) {
    if (typeof scope !== 'string' || scope.length > 128 || !record || record.mode !== 'open' || !KINDS.includes(record.reason) || !Number.isSafeInteger(record.openedAtCursor)) fail('containment breaker record is invalid');
  }
  if (state.failedStateRef !== null && (!validHash(state.failedStateRef.stateHash) || !validHash(state.failedStateRef.checkpointHash) || !validHash(state.failedStateRef.evidenceHead))) fail('failed-state evidence reference is invalid');
  if (typeof state.forceTermination !== 'boolean') fail('force termination flag is invalid');
  return state;
}

function recordIncident(input, rawIncident) {
  validateContainmentState(input); const incident = validateIncident(clone(rawIncident));
  const state = clone(input);
  if (state.incidents.some(entry => entry.incidentId === incident.incidentId)) fail('duplicate containment incident', 'SNTSS_CONTAINMENT_REPLAY');
  const scopeKey = incident.scope === 'global' ? 'global' : `${incident.scope}:${incident.detailHash}`;
  const scopeCount = state.incidents.filter(entry => (entry.scope === incident.scope && (entry.scope === 'global' || entry.detailHash === incident.detailHash))).length + 1;
  state.breakerScopes[scopeKey] = { mode: 'open', reason: incident.kind, openedAtCursor: incident.observedAtCursor };
  state.incidents.push(incident);
  if (state.incidents.length > MAX_INCIDENTS) state.incidents.shift();
  state.evidenceHead = hash({ previous: state.evidenceHead, incident });
  state.lastVerifiedCheckpointHash = incident.checkpointHash;
  state.forceTermination = state.forceTermination || TERMINATING_KINDS.has(incident.kind);
  state.mode = state.forceTermination || incident.severity === 'critical' || scopeCount >= MAX_SCOPE_INCIDENTS ? 'quarantined' : 'degraded';
  return validateContainmentState(state);
}

function neutralizationDirective(state, failedStateHash) {
  validateContainmentState(state);
  if (!['quarantined', 'terminated'].includes(state.mode) || !validHash(failedStateHash)) fail('neutralization requires quarantined evidence and a failed-state hash');
  const next = clone(state);
  next.failedStateRef = { stateHash: failedStateHash, checkpointHash: state.lastVerifiedCheckpointHash, evidenceHead: state.evidenceHead };
  const directive = deepFreeze({
    directiveVersion: 1, action: 'neutral-degradation', stopNewStimuli: true, expireDerivedLeases: true,
    emitChemistryFrames: false, mutateAcquiredBiology: false, preserveFailedState: true,
    checkpointHash: next.lastVerifiedCheckpointHash, failedStateHash, evidenceHead: next.evidenceHead
  });
  return { state: validateContainmentState(next), directive };
}

function forceTerminationDirective(state, authority) {
  validateContainmentState(state);
  if (!authority || authority.trustedRuntime !== true || authority.kernelGovernor !== true || state.forceTermination !== true) fail('force termination is not authorized', 'SNTSS_CONTAINMENT_AUTHORITY');
  const next = clone(state); next.mode = 'terminated';
  return {
    state: validateContainmentState(next),
    directive: deepFreeze({ directiveVersion: 1, action: 'kill-corehost', signal: 'SIGKILL', restartMode: 'shadow-only', preserveFailedState: true, evidenceHead: next.evidenceHead })
  };
}

module.exports = {
  packagePolicy: deepFreeze(packagePolicy), MAX_INCIDENTS, KINDS, SCOPES,
  createContainmentState, validateContainmentState, validateIncident, recordIncident,
  neutralizationDirective, forceTerminationDirective
};
