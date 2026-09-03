'use strict';

const {
  SCALE,
  parseRaw,
  roundHalfEven
} = require('./q16-48');
const {
  clone,
  deepFreeze,
  exact,
  fail
} = require('./resident-support');

const SOURCE_PROTOCOL =
  'stay-p1-r0-metab-capacity-source-v1';
const SOURCE_VERSION = '1.0.0';
const SOURCE_CORE_ID = 'kernel-resource';
const SOURCE_STATE_KEY = 'p1-r0-metab-capacity-source';
const FRAME_INTERVAL_US = 250_000;
const RUNTIME_REVISION = 128;
const ELIGIBLE_TOPIC = 'resource.capacity.eligible.v1';
const QUALITY_TOPIC = 'resource.capacity.quality.v1';
const STATE_FIELDS = new Set([
  'protocol',
  'residencyId',
  'instanceId',
  'residentVersion',
  'runtimeRevision',
  'lastCommittedFrame',
  'lastTrustedTimeUs',
  'lastContinuityEpoch',
  'pending'
]);
const PENDING_FIELDS = new Set([
  'sampleFrame',
  'trustedTimeUs',
  'continuityEpoch',
  'observedAtMs',
  'pulseId',
  'eligibleSignalId',
  'qualitySignalId',
  'eligiblePayload',
  'qualityPayload'
]);
const ELIGIBLE_FIELDS = new Set([
  'eligibleCapacityQ48',
  'safetyCeilingQ48',
  'capacityClass',
  'sampleFrame'
]);
const QUALITY_FIELDS = new Set([
  'status',
  'qualityQ48',
  'ceilingVerified',
  'reasonCodes'
]);
const METRIC_FIELDS = new Set([
  'cpuCount',
  'loadAverageMilli',
  'freeMemoryBytes',
  'totalMemoryBytes'
]);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;

function safeInteger(value, label, minimum = 0) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    fail(
      `${label} is invalid`,
      'P1_METAB_CAPACITY_SOURCE'
    );
  }

  return value;
}

function safeId(value, label) {
  if (
    typeof value !== 'string' ||
    !SAFE_ID.test(value)
  ) {
    fail(
      `${label} is invalid`,
      'P1_METAB_CAPACITY_SOURCE'
    );
  }

  return value;
}

function sourceRaw(value, label) {
  try {
    return parseRaw(value);
  } catch {
    fail(
      `${label} is invalid`,
      'P1_METAB_CAPACITY_SOURCE_STATE'
    );
  }
}

function unitRatio(numerator, denominator) {
  const left = BigInt(numerator);
  const right = BigInt(denominator);

  if (right <= 0n || left < 0n) {
    fail(
      'capacity ratio is invalid',
      'P1_METAB_CAPACITY_SOURCE'
    );
  }

  const bounded = left > right ? right : left;
  return roundHalfEven(
    bounded * SCALE,
    right
  );
}

function normalizeMetrics(input) {
  exact(
    input,
    METRIC_FIELDS,
    'METAB capacity metrics',
    'P1_METAB_CAPACITY_SOURCE'
  );

  const cpuCount =
    safeInteger(input.cpuCount, 'capacity CPU count', 1);
  const loadAverageMilli =
    safeInteger(input.loadAverageMilli, 'capacity load average');
  const freeMemoryBytes =
    safeInteger(input.freeMemoryBytes, 'capacity free memory');
  const totalMemoryBytes =
    safeInteger(input.totalMemoryBytes, 'capacity total memory', 1);

  if (
    cpuCount > 4096 ||
    loadAverageMilli > cpuCount * 1_000_000 ||
    freeMemoryBytes > totalMemoryBytes
  ) {
    fail(
      'capacity metrics exceed their contract',
      'P1_METAB_CAPACITY_SOURCE'
    );
  }

  return Object.freeze({
    cpuCount,
    loadAverageMilli,
    freeMemoryBytes,
    totalMemoryBytes
  });
}

function createCapacityPayloads({
  sampleFrame,
  metrics
} = {}) {
  const frame =
    safeInteger(sampleFrame, 'capacity sample frame', 1);
  const normalized =
    normalizeMetrics(metrics);
  const cpuUsed =
    unitRatio(
      normalized.loadAverageMilli,
      normalized.cpuCount * 1000
    );
  const cpuHeadroom = SCALE - cpuUsed;
  const memoryHeadroom =
    unitRatio(
      normalized.freeMemoryBytes,
      normalized.totalMemoryBytes
    );
  const eligible =
    cpuHeadroom < memoryHeadroom
      ? cpuHeadroom
      : memoryHeadroom;

  return deepFreeze({
    eligiblePayload: {
      eligibleCapacityQ48: eligible.toString(),
      safetyCeilingQ48: SCALE.toString(),
      capacityClass: 'HOST_RESOURCE_HEADROOM_V1',
      sampleFrame: frame
    },
    qualityPayload: {
      status: 'VALID',
      qualityQ48: SCALE.toString(),
      ceilingVerified: true,
      reasonCodes: [
        'TRUSTED_ORGANISM_TIME',
        'KERNEL_CPU_HEADROOM',
        'KERNEL_MEMORY_HEADROOM'
      ]
    }
  });
}

function createCapacitySourceState({
  instanceId,
  residentVersion
} = {}) {
  return deepFreeze({
    protocol: SOURCE_PROTOCOL,
    residencyId: 'resident:metab',
    instanceId: safeId(instanceId, 'capacity source instance'),
    residentVersion: safeId(
      residentVersion,
      'capacity source resident version'
    ),
    runtimeRevision: RUNTIME_REVISION,
    lastCommittedFrame: 0,
    lastTrustedTimeUs: null,
    lastContinuityEpoch: null,
    pending: null
  });
}

function normalizeEligiblePayload(input, frame) {
  exact(
    input,
    ELIGIBLE_FIELDS,
    'capacity eligible payload',
    'P1_METAB_CAPACITY_SOURCE_STATE'
  );

  if (
    input.sampleFrame !== frame ||
    typeof input.eligibleCapacityQ48 !== 'string' ||
    typeof input.safetyCeilingQ48 !== 'string' ||
    input.capacityClass !== 'HOST_RESOURCE_HEADROOM_V1' ||
    sourceRaw(input.eligibleCapacityQ48, 'capacity eligible value') < 0n ||
    sourceRaw(input.eligibleCapacityQ48, 'capacity eligible value') > SCALE ||
    sourceRaw(input.safetyCeilingQ48, 'capacity safety ceiling') !== SCALE
  ) {
    fail(
      'capacity eligible payload changed',
      'P1_METAB_CAPACITY_SOURCE_STATE'
    );
  }

  return clone(input);
}

function normalizeQualityPayload(input) {
  exact(
    input,
    QUALITY_FIELDS,
    'capacity quality payload',
    'P1_METAB_CAPACITY_SOURCE_STATE'
  );

  if (
    input.status !== 'VALID' ||
    input.ceilingVerified !== true ||
    sourceRaw(input.qualityQ48, 'capacity quality value') !== SCALE ||
    !Array.isArray(input.reasonCodes) ||
    input.reasonCodes.length !== 3 ||
    input.reasonCodes[0] !== 'TRUSTED_ORGANISM_TIME' ||
    input.reasonCodes[1] !== 'KERNEL_CPU_HEADROOM' ||
    input.reasonCodes[2] !== 'KERNEL_MEMORY_HEADROOM'
  ) {
    fail(
      'capacity quality payload changed',
      'P1_METAB_CAPACITY_SOURCE_STATE'
    );
  }

  return clone(input);
}

function normalizePending(
  input,
  lastCommittedFrame,
  lastContinuityEpoch
) {
  exact(
    input,
    PENDING_FIELDS,
    'capacity pending sample',
    'P1_METAB_CAPACITY_SOURCE_STATE'
  );

  const sampleFrame =
    safeInteger(input.sampleFrame, 'pending sample frame', 1);
  const trustedTimeUs =
    safeInteger(input.trustedTimeUs, 'pending trusted time');
  const continuityEpoch =
    safeInteger(input.continuityEpoch, 'pending continuity epoch', 1);
  const observedAtMs =
    safeInteger(input.observedAtMs, 'pending observed time');

  if (
    sampleFrame !== lastCommittedFrame + 1 ||
    observedAtMs !== Math.floor(trustedTimeUs / 1000) ||
    (
      lastContinuityEpoch !== null &&
      continuityEpoch < lastContinuityEpoch
    )
  ) {
    fail(
      'capacity pending chronology is invalid',
      'P1_METAB_CAPACITY_SOURCE_STATE'
    );
  }

  for (const [field, prefix] of [
    ['pulseId', `metab-capacity-r128-f${sampleFrame}`],
    ['eligibleSignalId', `runtime.metab.capacity.eligible:r128:f${sampleFrame}`],
    ['qualitySignalId', `runtime.metab.capacity.quality:r128:f${sampleFrame}`]
  ]) {
    if (input[field] !== prefix) {
      fail(
        `capacity pending ${field} changed`,
        'P1_METAB_CAPACITY_SOURCE_STATE'
      );
    }
  }

  return {
    sampleFrame,
    trustedTimeUs,
    continuityEpoch,
    observedAtMs,
    pulseId: input.pulseId,
    eligibleSignalId: input.eligibleSignalId,
    qualitySignalId: input.qualitySignalId,
    eligiblePayload:
      normalizeEligiblePayload(
        input.eligiblePayload,
        sampleFrame
      ),
    qualityPayload:
      normalizeQualityPayload(
        input.qualityPayload
      )
  };
}

function validateCapacitySourceState(input, {
  instanceId,
  residentVersion
} = {}) {
  exact(
    input,
    STATE_FIELDS,
    'METAB capacity source state',
    'P1_METAB_CAPACITY_SOURCE_STATE'
  );

  if (
    input.protocol !== SOURCE_PROTOCOL ||
    input.residencyId !== 'resident:metab' ||
    input.instanceId !== instanceId ||
    input.residentVersion !== residentVersion ||
    input.runtimeRevision !== RUNTIME_REVISION
  ) {
    fail(
      'METAB capacity source identity changed',
      'P1_METAB_CAPACITY_SOURCE_STATE'
    );
  }

  const lastCommittedFrame =
    safeInteger(
      input.lastCommittedFrame,
      'capacity committed frame'
    );
  const lastTrustedTimeUs =
    input.lastTrustedTimeUs === null
      ? null
      : safeInteger(
          input.lastTrustedTimeUs,
          'capacity committed trusted time'
        );
  const lastContinuityEpoch =
    input.lastContinuityEpoch === null
      ? null
      : safeInteger(
          input.lastContinuityEpoch,
          'capacity committed continuity epoch',
          1
        );

  if (
    (lastCommittedFrame === 0) !==
      (lastTrustedTimeUs === null) ||
    (lastCommittedFrame === 0) !==
      (lastContinuityEpoch === null)
  ) {
    fail(
      'capacity committed chronology is incomplete',
      'P1_METAB_CAPACITY_SOURCE_STATE'
    );
  }

  const pending =
    input.pending === null
      ? null
      : normalizePending(
          input.pending,
          lastCommittedFrame,
          lastContinuityEpoch
        );

  if (
    pending &&
    lastTrustedTimeUs !== null &&
    pending.trustedTimeUs - lastTrustedTimeUs <
      FRAME_INTERVAL_US
  ) {
    fail(
      'capacity pending sample invents elapsed time',
      'P1_METAB_CAPACITY_SOURCE_STATE'
    );
  }

  return deepFreeze({
    protocol: SOURCE_PROTOCOL,
    residencyId: 'resident:metab',
    instanceId,
    residentVersion,
    runtimeRevision: RUNTIME_REVISION,
    lastCommittedFrame,
    lastTrustedTimeUs,
    lastContinuityEpoch,
    pending:
      pending === null
        ? null
        : clone(pending)
  });
}

function migrateCapacitySourceResidentVersion(stateInput, {
  instanceId,
  fromVersion,
  toVersion
} = {}) {
  const state = validateCapacitySourceState(stateInput, {
    instanceId,
    residentVersion: fromVersion
  });
  if (
    state.pending !== null ||
    !(
      (
        fromVersion === '0.2.0-p1r0-shadow.1' &&
        toVersion === '0.3.0-p1r0-homeos-feed.1'
      ) ||
      (
        fromVersion === '0.3.0-p1r0-homeos-feed.1' &&
        toVersion === '0.4.0-p1r0-intero-feed.1'
      )
    )
  ) fail('capacity source version migration is not at an exact boundary', 'P1_METAB_CAPACITY_SOURCE_MIGRATION');
  return validateCapacitySourceState({ ...clone(state), residentVersion: toVersion }, {
    instanceId,
    residentVersion: toVersion
  });
}

function stageCapacitySample(stateInput, {
  trustedTimeUs,
  continuityEpoch,
  metrics
} = {}) {
  const state =
    validateCapacitySourceState(
      stateInput,
      {
        instanceId: stateInput?.instanceId,
        residentVersion:
          stateInput?.residentVersion
      }
    );

  if (state.pending !== null) {
    return state;
  }

  const trusted =
    safeInteger(
      trustedTimeUs,
      'capacity trusted time'
    );
  const epoch =
    safeInteger(
      continuityEpoch,
      'capacity continuity epoch',
      1
    );

  if (
    state.lastContinuityEpoch !== null &&
    epoch < state.lastContinuityEpoch
  ) {
    fail(
      'capacity continuity epoch rewound',
      'P1_METAB_CAPACITY_SOURCE_STATE'
    );
  }

  if (
    state.lastTrustedTimeUs !== null &&
    trusted - state.lastTrustedTimeUs <
      FRAME_INTERVAL_US
  ) {
    return state;
  }

  const sampleFrame =
    state.lastCommittedFrame + 1;
  const payloads =
    createCapacityPayloads({
      sampleFrame,
      metrics
    });

  return validateCapacitySourceState({
    ...state,
    pending: {
      sampleFrame,
      trustedTimeUs: trusted,
      continuityEpoch: epoch,
      observedAtMs:
        Math.floor(trusted / 1000),
      pulseId:
        `metab-capacity-r128-f${sampleFrame}`,
      eligibleSignalId:
        `runtime.metab.capacity.eligible:r128:f${sampleFrame}`,
      qualitySignalId:
        `runtime.metab.capacity.quality:r128:f${sampleFrame}`,
      ...payloads
    }
  }, {
    instanceId: state.instanceId,
    residentVersion:
      state.residentVersion
  });
}

function commitCapacitySample(stateInput) {
  const state =
    validateCapacitySourceState(
      stateInput,
      {
        instanceId: stateInput?.instanceId,
        residentVersion:
          stateInput?.residentVersion
      }
    );

  if (!state.pending) {
    fail(
      'capacity source has no pending sample',
      'P1_METAB_CAPACITY_SOURCE_STATE'
    );
  }

  return validateCapacitySourceState({
    ...state,
    lastCommittedFrame:
      state.pending.sampleFrame,
    lastTrustedTimeUs:
      state.pending.trustedTimeUs,
    lastContinuityEpoch:
      state.pending.continuityEpoch,
    pending: null
  }, {
    instanceId: state.instanceId,
    residentVersion:
      state.residentVersion
  });
}

module.exports = Object.freeze({
  ELIGIBLE_TOPIC,
  FRAME_INTERVAL_US,
  QUALITY_TOPIC,
  RUNTIME_REVISION,
  SOURCE_CORE_ID,
  SOURCE_PROTOCOL,
  SOURCE_STATE_KEY,
  SOURCE_VERSION,
  commitCapacitySample,
  createCapacityPayloads,
  createCapacitySourceState,
  migrateCapacitySourceResidentVersion,
  stageCapacitySample,
  validateCapacitySourceState
});
