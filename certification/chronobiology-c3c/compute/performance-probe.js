'use strict';

const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

const chronobiology = require('../../../cores/chronobiology/c3');
const { MAX_LONG_GAP_US } = require('../../../cores/chronobiology/c3/long-gap');
const {
  advanceTrustedTime,
  bindState,
  emptyState,
} = require('../../../cores/chronobiology/c3/state');

const DAY_US = 86_400_000_000;
const output = process.argv[2];
if (!output) throw new Error('performance result path is required');

const binding = {
  id: 'c3c-compute-performance-binding',
  topic: 'runtime.organism.binding',
  payload: {
    bindingVersion: 1,
    identitySha256: `sha256:${'c'.repeat(64)}`,
    organismLineage: 'STAY/Genesis',
    runtimeRevision: 1,
    authorityEpoch: 1,
    kernelVersion: '0.8.11.3',
  },
  meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
};

function pulse(sequence, trustedTimeUs) {
  return {
    id: `c3c-compute-performance-pulse-${sequence}`,
    topic: 'runtime.trusted-organism-time.pulse',
    payload: {
      runtimeRevision: 1,
      pulseSequence: sequence,
      status: 'TRUSTED',
      trustedTimeUs,
      continuityEpoch: 1,
      reasonCode: null,
    },
    meta: { sourceCore: 'living-kernel', authorityEpoch: 1 },
  };
}

const state = advanceTrustedTime(bindState(emptyState(), binding), pulse(1, 0));
const started = performance.now();
const advanced = advanceTrustedTime(state, pulse(2, 365 * DAY_US));
const elapsedMs = Number((performance.now() - started).toFixed(3));
if (advanced.continuity.committed_through_us !== 365 * DAY_US) {
  throw new Error('performance probe did not reach its trusted frontier');
}
if (elapsedMs >= chronobiology.manifest.resources.handlerTimeoutMs) {
  throw Object.assign(new Error(`one-year catch-up took ${elapsedMs} ms`), {
    code: 'C3C_COMPUTE_PERFORMANCE_GATE',
  });
}
try {
  advanceTrustedTime(state, pulse(2, MAX_LONG_GAP_US + DAY_US));
  throw new Error('long-gap bound was not enforced');
} catch (error) {
  if (error.code !== 'CHRONOBIOLOGY_LONG_GAP_BOUND') throw error;
}

fs.writeFileSync(output, `${JSON.stringify({
  handler_limit_ms: chronobiology.manifest.resources.handlerTimeoutMs,
  one_year_catchup_ms: elapsedMs,
  result: 'PASS',
}, null, 2)}\n`, { mode: 0o600 });
