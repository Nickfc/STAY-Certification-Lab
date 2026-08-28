'use strict';

const CHIP_ORDER = Object.freeze([
  'bsf',
  'sntss',
  'chronobiology',
  'metab',
  'homeos',
  'intero'
]);

const CHIP_STATES = Object.freeze([
  'QUARANTINED',
  'OFFLINE',
  'RECOVERING',
  'DEGRADED',
  'LIVE',
  'SHADOW',
  'NEUTRAL'
]);

const ROADMAP_STAGES = Object.freeze([
  'PLANNED',
  'LAB BUILD',
  'LAB QUALIFIED'
]);

const RELEASE_ROADMAP = Object.freeze([
  Object.freeze({ coreId: 'metab', label: 'METAB', stage: 'PLANNED' }),
  Object.freeze({ coreId: 'homeos', label: 'HOMEOS', stage: 'PLANNED' }),
  Object.freeze({ coreId: 'intero', label: 'INTERO', stage: 'PLANNED' })
]);

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function coreIdOf(item) {
  return text(item?.coreId || item?.id || item?.residencyId, 'unknown')
    .replace(/^resident:/, '')
    .toLowerCase();
}

function count(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function lifecycleState(item) {
  const status = text(item?.status, 'UNKNOWN').toUpperCase();
  const lifecycle = text(item?.lifecycle, '').toUpperCase();
  const mode = text(item?.mode, 'NEUTRAL').toUpperCase();

  if (status === 'QUARANTINED' || lifecycle === 'QUARANTINED') return 'QUARANTINED';
  if (['OFFLINE', 'DETACHED', 'STOPPED'].includes(status) || lifecycle === 'OFFLINE') {
    return 'OFFLINE';
  }
  if (['RECOVERING', 'STARTING'].includes(status) || lifecycle === 'RECOVERING') {
    return 'RECOVERING';
  }
  if (
    ['DEGRADED', 'RESYNC_REQUIRED'].includes(status) ||
    lifecycle === 'DEGRADED' ||
    item?.healthOk === false
  ) {
    return 'DEGRADED';
  }
  if (item?.running === false) return 'OFFLINE';
  if (item?.running === true && mode === 'LIVE') return 'LIVE';
  if (item?.running === true && mode === 'SHADOW') return 'SHADOW';
  return 'NEUTRAL';
}

function symbolForState(state) {
  return Object.freeze({
    QUARANTINED: '⛔',
    OFFLINE: '○',
    RECOVERING: '↻',
    DEGRADED: '△',
    LIVE: '●',
    SHADOW: '◐',
    NEUTRAL: '◇'
  })[state] || '◇';
}

function healthReasonFor(item, state) {
  if (state === 'QUARANTINED') return 'RESIDENT_QUARANTINED';
  if (state === 'OFFLINE') return 'RUNTIME_NOT_RUNNING';
  if (state === 'RECOVERING') return 'BOUNDED_RECOVERY_ACTIVE';
  if (state === 'DEGRADED') return 'RUNTIME_HEALTH_DEGRADED';
  if (state === 'LIVE') return 'LIVE_HEALTHY';
  if (state === 'SHADOW') return 'SHADOW_HEALTHY';
  return item?.running === true ? 'NEUTRAL_HEALTHY' : 'LIFECYCLE_NEUTRAL';
}

function lifecycleChip(item, kind) {
  const coreId = coreIdOf(item);
  const state = lifecycleState(item);
  return {
    chipId: `${kind}:${coreId}`,
    kind: 'LIFECYCLE',
    sourceKind: kind.toUpperCase(),
    coreId,
    residencyId: kind === 'resident' ? text(item?.residencyId, null) : null,
    label: text(item?.label, coreId).toUpperCase(),
    version: text(item?.version, null),
    mode: text(item?.mode, 'NEUTRAL').toUpperCase(),
    status: text(item?.status, 'UNKNOWN').toUpperCase(),
    lifecycle: text(item?.lifecycle, item?.status || 'UNKNOWN').toUpperCase(),
    state,
    symbol: symbolForState(state),
    running: item?.running === true,
    healthOk: item?.healthOk !== false,
    healthReason: healthReasonFor(item, state),
    checkpointGeneration: count(item?.checkpointGeneration),
    handledEvents: count(item?.handledEvents ?? item?.events),
    outputs: count(item?.observedOutputs),
    observationOnly: true
  };
}

function orderOf(coreId) {
  const index = CHIP_ORDER.indexOf(coreId);
  return index < 0 ? CHIP_ORDER.length : index;
}

function projectObservationChips({ systems = [], residents = [], roadmap = RELEASE_ROADMAP } = {}) {
  const lifecycle = [];
  for (const system of Array.isArray(systems) ? systems : []) {
    if (system && typeof system === 'object') lifecycle.push(lifecycleChip(system, 'system'));
  }
  for (const resident of Array.isArray(residents) ? residents : []) {
    if (resident && typeof resident === 'object') lifecycle.push(lifecycleChip(resident, 'resident'));
  }
  lifecycle.sort((left, right) =>
    orderOf(left.coreId) - orderOf(right.coreId) || left.coreId.localeCompare(right.coreId)
  );

  const born = new Set(lifecycle.map(chip => chip.coreId));
  const projectedRoadmap = (Array.isArray(roadmap) ? roadmap : [])
    .filter(entry => entry && typeof entry === 'object')
    .map(entry => {
      const coreId = coreIdOf(entry);
      const stage = ROADMAP_STAGES.includes(text(entry.stage).toUpperCase())
        ? text(entry.stage).toUpperCase()
        : 'PLANNED';
      return {
        roadmapId: `roadmap:${coreId}`,
        kind: 'ROADMAP',
        coreId,
        label: text(entry.label, coreId).toUpperCase(),
        stage,
        nonLive: true,
        observationOnly: true
      };
    })
    .filter(entry => !born.has(entry.coreId))
    .sort((left, right) =>
      orderOf(left.coreId) - orderOf(right.coreId) || left.coreId.localeCompare(right.coreId)
    );

  return {
    schema: 'stay-observation-chips-v1',
    source: 'VALIDATED_RUNTIME_METADATA',
    observationOnly: true,
    mutationEndpoints: [],
    order: [...CHIP_ORDER],
    lifecycle,
    roadmap: projectedRoadmap
  };
}

module.exports = {
  CHIP_ORDER,
  CHIP_STATES,
  ROADMAP_STAGES,
  RELEASE_ROADMAP,
  lifecycleState,
  projectObservationChips,
  symbolForState
};
