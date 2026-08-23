'use strict';

const fp = require('./fixed-point');
const { ACTIVE_FAMILIES, speciesProfile, hash } = require('./species-profile');
const stateContract = require('./state');

const DAY_MS = 86400000;
const DEVELOPMENT_CONTRACT = Object.freeze({
  contractVersion: 1, maximumBaselineMovementPerDay: 1000, maximumBirthDeviation: 100000,
  minimumWindowMs: 3600000, maximumWindowMs: DAY_MS, minimumAcceptedEvidence: 64,
  minimumSourceDiversity: 4, maximumDominantSourceShare: 500000, maximumExtremeShare: 100000,
  eligibleVariable: 'tonic-baseline-only', selfAuthorizationAllowed: false, productionEnabled: false
});
const DEVELOPMENT_CONTRACT_HASH = hash(DEVELOPMENT_CONTRACT);
const SUMMARY_KEYS = Object.freeze([
  'acceptedEvidenceCount', 'authoritative', 'dominantSourceShare', 'evidenceWindowHash', 'extremeShare',
  'fromCursor', 'healthy', 'proposedBaselines', 'replay', 'reviewAuthorizationHash', 'sourceDiversity',
  'summaryVersion', 'synthetic', 'timeTrusted', 'toCursor', 'unclamped', 'windowEndMs', 'windowStartMs'
]);
const REVIEW_KEYS = Object.freeze(['active', 'authorityEpoch', 'authorizationHash', 'contractHash', 'reviewedAtCursor', 'sourceCore', 'sourceInstanceId', 'sourceVersion', 'summaryHash']);

function fail(message, code = 'SNTSS_DEVELOPMENT_INVALID') { throw Object.assign(new Error(message), { code }); }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} fields are not canonical`);
}
function reject(state, code) { return { state, decision: { accepted: false, reasonCode: code, baselineChanges: {}, developmentalExperienceAddedMs: 0 } }; }

function applyDevelopmentSummary(inputState, summary, review, context) {
  stateContract.validateAcquiredState(inputState);
  try {
    exactKeys(summary, SUMMARY_KEYS, 'development summary'); exactKeys(review, REVIEW_KEYS, 'development review');
    if (summary.summaryVersion !== 1 || !stateContract.HASH.test(summary.evidenceWindowHash) || !stateContract.HASH.test(summary.reviewAuthorizationHash)) fail('development evidence hashes are invalid');
    const authority = context?.reviewAuthorityByCore?.[review.sourceCore];
    const verified = context?.verifiedAuthorizationHashes instanceof Set ? context.verifiedAuthorizationHashes.has(review.authorizationHash) : Array.isArray(context?.verifiedAuthorizationHashes) && context.verifiedAuthorizationHashes.includes(review.authorizationHash);
    if (!Number.isSafeInteger(context?.trustedNowMs) || context.trustedNowMs < summary.windowEndMs || review.sourceCore === 'sntss' || review.sourceCore !== 'sntss-development-review' || review.active !== true || review.contractHash !== DEVELOPMENT_CONTRACT_HASH || review.authorizationHash !== summary.reviewAuthorizationHash || review.summaryHash !== hash(summary) || !verified || !authority || authority.active !== true || authority.epoch !== review.authorityEpoch || authority.version !== review.sourceVersion || authority.instanceId !== review.sourceInstanceId || review.reviewedAtCursor !== summary.toCursor) fail('development is not independently authorized', 'SNTSS_DEVELOPMENT_SELF_AUTHORIZATION');
    for (const flag of ['healthy', 'authoritative', 'timeTrusted', 'unclamped']) if (summary[flag] !== true) fail('development health gate failed', 'SNTSS_DEVELOPMENT_HEALTH_GATE');
    if (summary.synthetic !== false || summary.replay !== false) fail('synthetic or replay evidence cannot develop biology', 'SNTSS_DEVELOPMENT_INELIGIBLE_EVIDENCE');
    for (const key of ['fromCursor', 'toCursor', 'windowStartMs', 'windowEndMs', 'acceptedEvidenceCount', 'sourceDiversity', 'dominantSourceShare', 'extremeShare']) if (!Number.isSafeInteger(summary[key]) || summary[key] < 0) fail(`development ${key} is invalid`);
    const duration = summary.windowEndMs - summary.windowStartMs;
    if (duration < DEVELOPMENT_CONTRACT.minimumWindowMs || duration > DEVELOPMENT_CONTRACT.maximumWindowMs || summary.windowStartMs !== inputState.developmentalClock.lastTrustedWallClockMs) fail('development window is invalid', 'SNTSS_DEVELOPMENT_TIME_GATE');
    if (summary.fromCursor <= inputState.inputCursor || summary.toCursor < summary.fromCursor || review.reviewedAtCursor !== summary.toCursor) fail('development cursor is invalid', 'SNTSS_DEVELOPMENT_REPLAY');
    if (summary.acceptedEvidenceCount < DEVELOPMENT_CONTRACT.minimumAcceptedEvidence || summary.sourceDiversity < DEVELOPMENT_CONTRACT.minimumSourceDiversity || summary.dominantSourceShare > DEVELOPMENT_CONTRACT.maximumDominantSourceShare || summary.extremeShare > DEVELOPMENT_CONTRACT.maximumExtremeShare) fail('development evidence is sparse or concentrated', 'SNTSS_DEVELOPMENT_DIVERSITY_GATE');
    exactKeys(summary.proposedBaselines, ACTIVE_FAMILIES, 'proposed developmental baselines');
    for (const family of ACTIVE_FAMILIES) {
      const target = summary.proposedBaselines[family]; const birth = speciesProfile.families[family].birthState.B;
      if (!Number.isSafeInteger(target) || target < 0 || target > fp.SCALE || Math.abs(target - birth) > DEVELOPMENT_CONTRACT.maximumBirthDeviation) fail('development target is outside reviewed range', 'SNTSS_DEVELOPMENT_RANGE');
    }
    const maximumMovement = Math.floor(DEVELOPMENT_CONTRACT.maximumBaselineMovementPerDay * duration / DAY_MS);
    const state = stateContract.clone(inputState); const baselineChanges = {};
    for (const family of ACTIVE_FAMILIES) {
      const current = state.transmitters[family].B; const target = summary.proposedBaselines[family];
      const movement = Math.max(-maximumMovement, Math.min(maximumMovement, target - current));
      state.transmitters[family].B = fp.clamp(current + movement); baselineChanges[family] = movement;
    }
    state.developmentalClock = { experienceMs: state.developmentalClock.experienceMs + duration, lastTrustedWallClockMs: summary.windowEndMs };
    state.inputCursor = summary.toCursor;
    const record = { evidenceWindowHash: summary.evidenceWindowHash, authorizationHash: summary.reviewAuthorizationHash, fromCursor: summary.fromCursor, toCursor: summary.toCursor, durationMs: duration, baselineChanges, contractHash: DEVELOPMENT_CONTRACT_HASH };
    state.sourceHistory.development = [...(state.sourceHistory.development || []), record].slice(-256);
    state.auditChainHead = hash({ previous: state.auditChainHead, transition: 'developmental-baseline-update', recordHash: hash(record), beforeStateHash: stateContract.stateHash(inputState) });
    stateContract.validateAcquiredState(state);
    return { state, decision: { accepted: true, reasonCode: 'SNTSS_DEVELOPMENT_ACCEPTED', baselineChanges, developmentalExperienceAddedMs: duration, contractHash: DEVELOPMENT_CONTRACT_HASH, recordHash: hash(record) } };
  } catch (error) { return reject(inputState, error.code || 'SNTSS_DEVELOPMENT_INVALID'); }
}

module.exports = { DEVELOPMENT_CONTRACT, DEVELOPMENT_CONTRACT_HASH, applyDevelopmentSummary };
