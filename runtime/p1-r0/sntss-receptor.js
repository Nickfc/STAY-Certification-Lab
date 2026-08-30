'use strict';

const { stableStringify } = require('../kernel/canonical-json');
const { validateCausalFrame } = require('./causal-frame');
const { ROUTES, validateFrameRoute } = require('./contract-registry');

const RECEPTOR_CONTRACT = Object.freeze({
  receptorId: 'sntss.receptor.intero.p1-r0',
  ownerCoreId: 'sntss',
  consumerCoreId: 'SNTSS_RECEPTOR_P1_R0',
  producerCoreId: 'INTERO',
  routeId: 'p1r0.intero.sntss-receptor',
  topic: 'intero.body.frame.v1',
  routeStage: 'ABSENT',
  bufferCapacity: 16,
  maximumPayloadBytes: 65_536,
  revocable: true,
  productionEligible: false,
  authorityEpoch: '0',
  outputs: Object.freeze([])
});

const STATE_FIELDS = new Set([
  'schema', 'routeStage', 'revocationGeneration', 'buffer', 'lastAcceptedFrameId'
]);

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function clone(value) {
  return JSON.parse(stableStringify(value));
}

function validateState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('SNTSS receptor state is invalid', 'P1_SNTSS_RECEPTOR_STATE');
  }
  const keys = Object.keys(input).sort();
  const expected = [...STATE_FIELDS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    input.schema !== 'stay-p1-r0-sntss-receptor-state/v1' ||
    input.routeStage !== 'ABSENT' ||
    !Number.isSafeInteger(input.revocationGeneration) ||
    input.revocationGeneration < 0 ||
    !Array.isArray(input.buffer) ||
    input.buffer.length !== 0 ||
    input.lastAcceptedFrameId !== null
  ) fail('SNTSS receptor state is invalid', 'P1_SNTSS_RECEPTOR_STATE');
  return clone(input);
}

function emptyState() {
  return {
    schema: 'stay-p1-r0-sntss-receptor-state/v1',
    routeStage: 'ABSENT',
    revocationGeneration: 0,
    buffer: [],
    lastAcceptedFrameId: null
  };
}

function createSntssInteroReceptor({ initialState } = {}) {
  const route = ROUTES[RECEPTOR_CONTRACT.routeId];
  if (
    !route ||
    route.stage !== RECEPTOR_CONTRACT.routeStage ||
    route.revocable !== true ||
    route.consumer !== RECEPTOR_CONTRACT.consumerCoreId ||
    route.producer !== RECEPTOR_CONTRACT.producerCoreId ||
    route.topic !== RECEPTOR_CONTRACT.topic
  ) fail('SNTSS receptor route contract drifted', 'P1_SNTSS_RECEPTOR_CONTRACT');

  let state = validateState(initialState || emptyState());

  return Object.freeze({
    receive(frameInput) {
      const frame = validateCausalFrame(frameInput);
      const declared = validateFrameRoute(frame);
      if (declared.routeId !== RECEPTOR_CONTRACT.routeId) {
        fail('SNTSS receptor received an undeclared route', 'P1_SNTSS_RECEPTOR_ROUTE');
      }
      if (state.routeStage === 'ABSENT') {
        fail('SNTSS interoceptive route is absent', 'P1_SNTSS_RECEPTOR_ABSENT');
      }
      // No activation path exists in P1-R0. This is a defensive authority fence.
      fail('SNTSS interoceptive route is not authorized', 'P1_SNTSS_RECEPTOR_AUTHORITY');
    },

    revoke() {
      state = {
        ...emptyState(),
        revocationGeneration: state.revocationGeneration + 1
      };
      return this.snapshot();
    },

    snapshot() {
      return Object.freeze(validateState(state));
    },

    health() {
      return Object.freeze({
        ok: true,
        routeStage: 'ABSENT',
        revocable: true,
        bufferDepth: 0,
        bufferCapacity: RECEPTOR_CONTRACT.bufferCapacity,
        authorityOwned: false,
        outputCount: 0
      });
    }
  });
}

module.exports = Object.freeze({ RECEPTOR_CONTRACT, createSntssInteroReceptor });
