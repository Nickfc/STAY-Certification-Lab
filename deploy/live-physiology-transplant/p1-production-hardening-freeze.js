#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { FORMAT, sealRevisionFreeze, validateRevisionFreeze } = require('../../runtime/revision-freeze');

const REVISION = 111;
const PARENT_REVISION = 110;
const PARENT_RECORD_SHA256 = 'sha256:da7ad05dd0044754b81d599617d03a86d4cc31e208e39710d167f15c8c163989';
const R110_12H_SHA256 = 'sha256:1fbf5e7b854204278a7ee7967dfc0c9016d1eeb5b281eb7a5289fd66d3b88007';
const I4_POLICY_SHA256 = 'sha256:ba12622fcc9c782c8c48f0544a5b019c96dc198dcbb7fb209c1dad47de64639d';
const MIB = 1024 * 1024;

function fail(message, code = 'P1_PRODUCTION_HARDENING_FREEZE') {
  throw Object.assign(new Error(message), { code });
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`${label} is invalid: ${error.message}`, 'P1_PRODUCTION_HARDENING_FREEZE_INPUT'); }
}

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] == null) {
      fail('invalid option', 'P1_PRODUCTION_HARDENING_FREEZE_USAGE');
    }
    result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}

function hash(value) {
  return /^sha256:[0-9a-f]{64}$/.test(String(value || ''));
}

function sameNumbers(left, right) {
  const normalize = input => [...new Set((input || []).map(Number).filter(Number.isSafeInteger))]
    .sort((a, b) => a - b);
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function hasNumericKeys(value, keys) {
  return value != null && keys.every(key => Number.isFinite(Number(value[key])));
}

function assertResidentContainment(sample, residentId, cgroupName) {
  const resident = sample?.residents?.[residentId];
  const host = resident?.host;
  const durability = resident?.durabilityContract;
  const cgroup = sample?.service?.cgroup?.[cgroupName];
  const memory = host?.osContainment?.memoryPlan;
  const supervisorPid = Number(host?.pid);
  const kernelProcesses = sample?.service?.cgroup?.kernelProcesses || [];
  const payloadProcesses = cgroup?.processes || [];
  const declaredPayload = host?.osContainment?.payloadPids || [];
  const memoryEvents = cgroup?.memoryEvents || {};
  const pidsEvents = cgroup?.pidsEvents || {};
  const cpuStat = cgroup?.cpuStat || {};
  const queue = resident?.queue || {};
  const valid = resident?.status === 'RUNNING' && resident?.running === true &&
    resident?.health?.ok === true && resident?.resyncRequired !== true &&
    !resident?.terminalPersistenceError && !resident?.teardownError &&
    ['failed', 'timedOut', 'stalled', 'recovered', 'recoveryRejected', 'recoveryTimedOut']
      .every(key => Number(queue[key] || 0) === 0) &&
    host?.osContainment?.required === true && host?.osContainment?.available === true &&
    host?.osContainment?.payloadAttachedBeforeInit === true &&
    host?.osContainment?.payloadQuiescedBeforeSpawn === true &&
    memory?.accounting === 'payload-cgroup-plus-kernel-supervisor' &&
    Number(memory?.payloadSoftBytes) === 64 * MIB &&
    Number(memory?.payloadHardBytes) === 96 * MIB &&
    Number(memory?.cgroupSoftBytes) === 64 * MIB &&
    Number(memory?.cgroupHardBytes) === 96 * MIB &&
    Number(memory?.supervisorSoftBytes) === 48 * MIB &&
    Number(memory?.supervisorHardBytes) === 64 * MIB &&
    Number(memory?.totalHardEnvelopeBytes) === 160 * MIB &&
    cgroup?.ambiguous === false && Number(cgroup?.activeLeafCount) === 1 &&
    cgroup?.memoryHigh === String(64 * MIB) &&
    cgroup?.memoryMax === String(96 * MIB) &&
    cgroup?.pidsMax === '16' && cgroup?.cpuMax === '20000 100000' &&
    hasNumericKeys(memoryEvents, ['low', 'high', 'max', 'oom', 'oom_kill']) &&
    ['low', 'high', 'max', 'oom', 'oom_kill'].every(name => Number(memoryEvents[name]) === 0) &&
    hasNumericKeys(pidsEvents, ['max']) && Number(pidsEvents.max) === 0 &&
    hasNumericKeys(cpuStat, ['usage_usec', 'nr_periods', 'nr_throttled', 'throttled_usec']) &&
    Number(cpuStat.nr_throttled) === 0 && Number(cpuStat.throttled_usec) === 0 &&
    Number.isFinite(Number(cgroup?.memoryCurrent)) && Number(cgroup.memoryCurrent) >= 0 &&
    Number(cgroup.memoryCurrent) <= 96 * MIB &&
    Number.isSafeInteger(Number(cgroup?.pidsCurrent)) && Number(cgroup.pidsCurrent) >= 1 &&
    Number(cgroup.pidsCurrent) <= 16 &&
    payloadProcesses.length >= 1 && payloadProcesses.length <= 16 &&
    sameNumbers(payloadProcesses, declaredPayload) &&
    Number.isSafeInteger(supervisorPid) && supervisorPid > 1 &&
    !payloadProcesses.includes(supervisorPid) && kernelProcesses.includes(supervisorPid) &&
    host?.deadlineContract?.eventAndCheckpointCombined === true &&
    host?.deadlineContract?.outputsReleasedAfterCheckpoint === true &&
    durability?.eventCheckpointConsumerAckAtomic === true &&
    durability?.outboxIntentInSameCommit === true &&
    durability?.biologicalPublicationFromCommittedOutboxOnly === true &&
    durability?.recoveryImageAdvancesAfterCommitOnly === true &&
    durability?.activationGapBackfillAtomic === true &&
    durability?.outboxPublicationSingleFlight === true &&
    durability?.startupFailureTeardownComplete === true &&
    Number(host?.deadlineContract?.ipcTransitionTimeoutMs) >
      Number(host?.deadlineContract?.workerTransitionTimeoutMs);
  if (!valid) fail(`${residentId} containment contract is invalid`, 'P1_PRODUCTION_HARDENING_FREEZE_CONTAINMENT');
  return {
    supervisorPid,
    payloadProcesses: [...payloadProcesses],
    cgroupDirectory: cgroup.directory,
    memoryPlan: memory,
    deadlineContract: host.deadlineContract,
    durabilityContract: durability
  };
}

function assertFoundation({ sample, state, parent, recovery, preflight, closure, soak, input }) {
  const residents = Array.isArray(sample?.meta?.residents) ? sample.meta.residents : [];
  const systems = Array.isArray(sample?.meta?.systems) ? sample.meta.systems : [];
  const publicSntss = residents.find(value => value.residencyId === 'resident:sntss');
  const publicChronobiology = residents.find(value => value.residencyId === 'resident:chronobiology');
  const bsf = systems.find(value => value.id === 'bsf');
  const sntss = sample?.residents?.sntss;
  const chronobiology = sample?.residents?.chronobiology;
  const individuality = state?.individuality;
  const queue = sntss?.queue;

  const valid = sample?.health?.ok === true && Number(sample.health.revision) === REVISION &&
    Number(sample?.meta?.revision) === REVISION && sample?.meta?.revisionFrozen === false &&
    sample?.meta?.revisionLabel === `R${REVISION}` && sample?.database?.quickCheck === 'ok' &&
    sample?.service?.cgroup?.required === true &&
    sample?.service?.cgroup?.delegateSubgroup === 'stay-kernel' &&
    Array.isArray(sample?.service?.cgroup?.parentProcesses) &&
    sample.service.cgroup.parentProcesses.length === 0 &&
    ['cpu', 'memory', 'pids'].every(name =>
      String(sample?.service?.cgroup?.subtreeControl || '').includes(name)
    ) &&
    Number(sample?.service?.pid) === Number(input.mainPid) &&
    sample?.service?.cgroup?.kernelProcesses?.includes(Number(input.mainPid)) &&
    validateRevisionFreeze(parent, PARENT_REVISION) &&
    parent.recordSha256 === PARENT_RECORD_SHA256 &&
    state?.runtimeRevision === REVISION && state?.quickCheck === 'ok' &&
    state?.resident?.version === '0.5.0-i4g1' && Number(state?.resident?.state_schema) === 5 &&
    state?.resident?.package_policy_hash === I4_POLICY_SHA256 &&
    state?.checkpoint?.blobDigestMatches === true &&
    individuality?.type === 'SNTSS_CONTINUITY_GENESIS' &&
    individuality?.authorityMode === 'NONE' && individuality?.outputs === 0 &&
    state?.historicalContinuity?.anchoredToR108F === true &&
    state?.sntssAuthorityRows === 0 && state?.sntssOutputRows === 0 &&
    state?.chronobiologyAuthorityRows === 0 && state?.chronobiologyOutputRows >= 1 &&
    sample?.database?.failedDeliveries === 0 &&
    sample?.database?.maintenanceFailureRows === 0 &&
    sample?.database?.startupTeardownFailureRows === 0 &&
    sample?.database?.detachTeardownFailureRows === 0 &&
    sample?.database?.terminalTeardownFailureRows === 0 &&
    sample?.database?.shutdownCheckpointFailureRows === 0 &&
    sample?.database?.shutdownStopFailureRows === 0 &&
    sample?.database?.pendingOutboxIntents === 0 &&
    sample?.database?.sntssAuthorityRows === 0 && sample?.database?.sntssOutputRows === 0 &&
    sample?.database?.chronobiologyAuthorityRows === 0 &&
    sntss?.version === '0.5.0-i4g1' && Number(sntss?.stateSchema) === 5 &&
    sntss?.moduleRelativePath === 'cores/sntss/i4g/index.js' &&
    sntss?.authorityOwned === false && Number(sntss?.observedOutputs) === 0 &&
    chronobiology?.version === '1.0.0-c3rc.1' &&
    chronobiology?.authorityOwned === false &&
    bsf?.mode === 'LIVE' && bsf?.status === 'RUNNING' && bsf?.running === true &&
    bsf?.healthOk === true && Number(bsf?.writeFailures || 0) === 0 &&
    publicSntss?.mode === 'SHADOW' && publicSntss?.running === true &&
    publicChronobiology?.mode === 'SHADOW' && publicChronobiology?.running === true &&
    Number(queue?.failed || 0) === 0 && Number(queue?.timedOut || 0) === 0 &&
    Number(queue?.recovered || 0) === 0 && Number(queue?.stalled || 0) === 0 &&
    Number(queue?.contract?.handlerTimeoutMs) === 1000 &&
    Number(queue?.contract?.settlementGraceMs) === 5000 &&
    Number(queue?.contract?.recoveryTimeoutMs) === 15000 &&
    Number(queue?.contract?.maxAttempts) === 3 &&
    recovery?.format === 'stay-production-hardening-recovery-proof-v1' &&
    recovery?.result === 'PASS' && recovery?.before?.runtimeRevision === PARENT_REVISION &&
    recovery?.before?.status === 'RESYNC_REQUIRED' && recovery?.after?.runtimeRevision === REVISION &&
    recovery?.after?.status === 'RUNNING' && recovery?.after?.running === true &&
    recovery?.before?.instanceId === recovery?.after?.instanceId &&
    Number(recovery?.after?.checkpointGeneration) > Number(recovery?.before?.checkpointGeneration) &&
    recovery?.inventedBiologicalTime === false &&
    Number.isSafeInteger(Number(recovery?.serviceRestarts)) &&
    Number(recovery.serviceRestarts) >= 1 && Number(recovery.serviceRestarts) <= 2 &&
    recovery?.maintenanceFailuresDuringRecovery === 0 &&
    recovery?.outboxPublicationFailuresDuringRecovery === 0 &&
    recovery?.coreHostFaultsDuringRecovery === 0 &&
    recovery?.resyncRequiredDuringRecovery === 0 &&
    recovery?.deliveryRetriesDuringRecovery === 0 &&
    recovery?.duplicateResyncGroupsDuringRecovery === 0 &&
    preflight?.format === 'stay-production-hardening-preflight-v1' && preflight?.result === 'PASS' &&
    preflight?.liveDatabaseReadOnly === true && preflight?.i4?.outputs === 0 &&
    Number(preflight?.i4?.pulseCount) === 5000 &&
    Number(preflight?.i4?.endingClock) - Number(preflight?.i4?.startingClock) === 1250000 &&
    preflight?.i4?.acceleratedWorkload?.pacing === 'UNIFORM_COMMIT_AWARE' &&
    Number(preflight?.i4?.acceleratedWorkload?.pulseIntervalMs) === 50 &&
    Number(preflight?.i4?.acceleratedWorkload?.maximumAccelerationFactor) === 5 &&
    preflight?.i4?.acceleratedWorkload?.recoveryWatermarkAdvancedPerCheckpoint === true &&
    Number(preflight?.i4?.acceleratedWorkload?.elapsedMs) >= 249950 &&
    preflight?.i4?.acceleratedWorkload?.resourceGovernorHardAction == null &&
    preflight?.faultContainment?.speculativeOutputsReleased === 0 &&
    preflight?.faultContainment?.committedCount === 1 &&
    Number(preflight?.faultContainment?.recoveredGeneration) >
      Number(preflight?.faultContainment?.failedGeneration) &&
    closure?.format === 'stay-physiology-benchmark-closure-v3' &&
    closure?.revisionLabel === 'R110F' && closure?.result === 'OBSERVED_FAILURES' &&
    closure?.source12hSha256 === R110_12H_SHA256 && closure?.evidenceRetained === true &&
    soak?.format === 'stay-production-hardening-live-soak-v1' && soak?.result === 'PASS' &&
    Number(soak?.elapsedMs) >= 125000 && Number(soak?.residentProcessTransitions) === 0 &&
    Number(soak?.newCoreHostFaults) === 0 && Number(soak?.newMaintenanceFailures) === 0 &&
    Number(soak?.newOutboxPublicationFailures) === 0 &&
    Number(soak?.pendingOutboxIntents) === 0 &&
    Number(soak?.newResourcePressureEvents) === 0 &&
    Number(soak?.failedDeliveries) === 0 && soak?.sqliteQuickCheck === 'ok' &&
    hash(closure?.recordSha256) &&
    hash(input.overlaySha256) && hash(input.runtimeDropinSha256) && hash(input.oneShotDropinSha256);
  if (!valid) fail('R111 production-hardening foundation is invalid', 'P1_PRODUCTION_HARDENING_FREEZE_CONTRACT');

  const sntssContainment = assertResidentContainment(sample, 'sntss', 'sntss');
  const chronobiologyContainment = assertResidentContainment(sample, 'chronobiology', 'chronobiology');
  const chronobiologyPids = new Set(chronobiologyContainment.payloadProcesses.map(Number));
  if (sntssContainment.payloadProcesses.some(pid => chronobiologyPids.has(Number(pid)))) {
    fail('resident payload cgroups are not distinct', 'P1_PRODUCTION_HARDENING_FREEZE_CONTAINMENT');
  }
  return { sntss, chronobiology, individuality, sntssContainment, chronobiologyContainment };
}

function createRecord(input) {
  const sample = readJson(input.sample, 'sample');
  const state = readJson(input.state, 'state');
  const parent = readJson(input.parent, 'parent freeze');
  const recovery = readJson(input.recovery, 'recovery proof');
  const preflight = readJson(input.preflight, 'preflight');
  const closure = readJson(input.closure, 'R110 benchmark closure');
  const soak = readJson(input.soak, 'live soak proof');
  const proven = assertFoundation({ sample, state, parent, recovery, preflight, closure, soak, input });
  const { sntss, chronobiology, individuality } = proven;

  return sealRevisionFreeze({
    format: FORMAT,
    freezeType: 'P1_PRODUCTION_HARDENING_EXACTLY_ONCE_RECOVERY',
    result: 'PASS',
    acceptance: 'ACCEPTED',
    capturedAt: input.capturedAt,
    host: { hostname: input.hostname, privateIpv4: input.privateIp },
    parentFreeze: {
      revision: PARENT_REVISION,
      revisionLabel: 'R110F',
      recordSha256: parent.recordSha256
    },
    runtime: {
      revision: REVISION,
      revisionLabel: 'R111F',
      version: sample.health.version,
      release: input.release,
      mainPid: Number(input.mainPid),
      nRestarts: Number(input.restarts),
      healthOk: true,
      cadenceMs: 250,
      trustedOrganismTimeCadenceMs: 60000,
      overlaySha256: input.overlaySha256,
      runtimeDropinSha256: input.runtimeDropinSha256,
      oneShotRecoveryDropinSha256: input.oneShotDropinSha256,
      oneShotRecoveryDropinRemoved: true,
      physiologyStripLocation: 'TOP_LEFT_UNDER_STAY'
    },
    hardening: {
      eventOwnership: 'ONE_ACTOR_ONE_EVENT_UNTIL_COMMIT_OR_TERMINAL_RESYNC',
      deadlineSemantics: 'OBSERVATION_NOT_CANCELLATION',
      unsettledTransitionPolicy: 'FAIL_CLOSED_NO_REPLAY',
      eventCheckpointCommitFence: 'COMBINED_WORKER_OPERATION',
      outputCommitFence: 'RELEASE_ONLY_AFTER_EVENT_CHECKPOINT_COMPLETION',
      biologicalPublicationFence: 'DATABASE_COMMITTED_OUTBOX_ONLY',
      recoverySource: 'LAST_DATABASE_COMMITTED_CHECKPOINT_ONLY',
      recoveryGenerationFence: true,
      duplicateResyncSuppression: true,
      queueDeadlineStartsAtExecution: true,
      biologicalPackageChanged: false,
      biologicalResourceContractChanged: false,
      terminalStateConsumerDeactivationRecoveryAtomic: true,
      persistenceWriteFailuresStickyForProcessLifetime: true,
      publicRunningRequiresLiveHealthyUnit: true,
      preflightResult: preflight.result,
      boundedLiveSoak: soak
    },
    deadlineContract: {
      declaredBiologicalHandlerTimeoutMs: 250,
      sntssWorkerTransitionTimeoutMs: 250,
      sntssIpcTransitionTimeoutMs: 1000,
      sntssResidentTransitionTimeoutMs: 1000,
      sntssSettlementGraceMs: 5000,
      sntssRecoveryTimeoutMs: 15000,
      maximumEventAttempts: 3,
      eventAndCheckpointCombined: true,
      eventCheckpointConsumerAckAtomic: true,
      outboxIntentInSameCommit: true,
      biologicalPublicationFromCommittedOutboxOnly: true,
      recoveryImageAdvancesAfterCommitOnly: true,
      activationGapBackfillAtomic: true,
      outboxPublicationSingleFlight: true,
      startupFailureTeardownComplete: true
    },
    containment: {
      requiredCgroupV2: true,
      delegateSubgroup: 'stay-kernel',
      payloadDistribution: 'stay-cores',
      payloadMemoryHighBytes: 64 * MIB,
      payloadMemoryMaxBytes: 96 * MIB,
      payloadPidsMax: 16,
      payloadCpuMax: '20000 100000',
      supervisorChargedToKernel: true,
      supervisorSoftBytes: 48 * MIB,
      supervisorHardBytes: 64 * MIB,
      sntss: proven.sntssContainment,
      chronobiology: proven.chronobiologyContainment
    },
    recovery: {
      sourceRevision: PARENT_REVISION,
      completedRevision: REVISION,
      mode: 'ONE_SHOT_COLD_RESYNCHRONIZATION',
      serviceRestarts: Number(recovery.serviceRestarts),
      residentInstancePreserved: true,
      checkpointGenerationBefore: Number(recovery.before.checkpointGeneration),
      checkpointGenerationAfter: Number(recovery.after.checkpointGeneration),
      checkpointHashBefore: recovery.before.checkpointHash,
      checkpointHashAtFirstRunningObservation: recovery.after.checkpointHash,
      abandonedPendingDeliveries: Number(recovery.abandonedCount || 0),
      maintenanceFailuresDuringRecovery: 0,
      outboxPublicationFailuresDuringRecovery: 0,
      coreHostFaultsDuringRecovery: 0,
      resyncRequiredDuringRecovery: 0,
      deliveryRetriesDuringRecovery: 0,
      duplicateResyncGroupsDuringRecovery: 0,
      inventedBiologicalTime: false
    },
    historicalContinuity: {
      anchoredToR108F: true,
      r108FreezeRecordSha256: state.historicalContinuity.r108FreezeRecordSha256,
      prunedRowsAcceptedByImmutableCommitment:
        state.historicalContinuity.prunedRowsAcceptedByImmutableCommitment
    },
    r110Diagnostic: {
      milestone: '12h',
      evidenceSha256: R110_12H_SHA256,
      result: 'OBSERVED_FAILURES',
      rootCause: 'NON_ATOMIC_COREHOST_TIMEOUT_RECOVERY_AND_TWO_PROCESS_RESOURCE_ACCOUNTING',
      evidenceRetained: true,
      closureSha256: closure.recordSha256
    },
    bsf: {
      mode: 'LIVE', status: 'FUNCTIONAL', persistence: 'PASS',
      sqliteQuickCheck: state.quickCheck,
      pendingDeliveries: Number(state.pendingDeliveries)
    },
    sntss: {
      residencyId: 'resident:sntss', version: '0.5.0-i4g1', stateSchema: 5,
      packagePolicySha256: I4_POLICY_SHA256,
      mode: 'SHADOW', signalling: 'FORBIDDEN', authority: 'NONE', outputs: 0,
      instanceId: state.resident.instance_id,
      checkpointGeneration: Number(sntss.checkpointGeneration),
      genesisSequence: Number(individuality.genesisSequence),
      lineageSha256: individuality.lineageSha256,
      seedCommitmentSha256: individuality.seedCommitmentSha256,
      prenatalStateSha256: individuality.prenatalStateSha256,
      healthOk: true
    },
    chronobiology: {
      residencyId: 'resident:chronobiology', version: '1.0.0-c3rc.1', stateSchema: 2,
      mode: 'SHADOW', signalling: 'LAB_SHADOW_ONLY', authority: 'NONE',
      productionEligible: false,
      checkpointGeneration: Number(chronobiology.checkpointGeneration),
      durableShadowOutputs: Number(state.chronobiologyOutputRows),
      healthOk: true
    },
    benchmark: {
      collectorContract: 'stay-physiology-benchmark-state-v3',
      automatic: true, durationHours: 72, intervalSeconds: 60,
      milestones: ['15m', '12h', '72h'],
      requiresZeroFaults: true,
      requiresZeroResidentProcessTransitions: true,
      requiresZeroCollectorRestarts: true,
      requiresZeroMaintenanceFailures: true,
      requiresZeroPendingOutboxIntents: true,
      requiresZeroOutboxPublicationFailures: true,
      historicalCountersBaselined: true,
      nestedWorkerFaultsObserved: true,
      cgroupMemoryEventsObserved: true,
      cgroupPidsEventsObserved: true,
      cgroupCpuThrottleEventsObserved: true,
      exactPayloadPidContractObserved: true,
      recoveryRetentionWatermarksObserved: true,
      evidenceFsyncRequired: true
    },
    continuity: {
      fetus: 'PASS', biologicalAuthorityChanged: false,
      residentInstancePreserved: true, inventedBiologicalTime: false
    }
  });
}

function verify(record) {
  return validateRevisionFreeze(record, REVISION) &&
    record.freezeType === 'P1_PRODUCTION_HARDENING_EXACTLY_ONCE_RECOVERY' &&
    record.parentFreeze?.revision === PARENT_REVISION &&
    record.parentFreeze?.recordSha256 === PARENT_RECORD_SHA256 &&
    record.runtime?.revisionLabel === 'R111F' &&
    record.hardening?.biologicalPackageChanged === false &&
    record.hardening?.biologicalResourceContractChanged === false &&
    record.hardening?.eventCheckpointCommitFence === 'COMBINED_WORKER_OPERATION' &&
    record.hardening?.outputCommitFence === 'RELEASE_ONLY_AFTER_EVENT_CHECKPOINT_COMPLETION' &&
    record.hardening?.biologicalPublicationFence === 'DATABASE_COMMITTED_OUTBOX_ONLY' &&
    record.hardening?.terminalStateConsumerDeactivationRecoveryAtomic === true &&
    record.hardening?.persistenceWriteFailuresStickyForProcessLifetime === true &&
    record.hardening?.publicRunningRequiresLiveHealthyUnit === true &&
    record.hardening?.boundedLiveSoak?.result === 'PASS' &&
    record.hardening?.boundedLiveSoak?.pendingOutboxIntents === 0 &&
    Number(record.hardening?.boundedLiveSoak?.elapsedMs) >= 125000 &&
    record.deadlineContract?.outputsReleasedAfterCheckpoint === true &&
    record.deadlineContract?.eventCheckpointConsumerAckAtomic === true &&
    record.deadlineContract?.outboxIntentInSameCommit === true &&
    record.deadlineContract?.biologicalPublicationFromCommittedOutboxOnly === true &&
    record.deadlineContract?.recoveryImageAdvancesAfterCommitOnly === true &&
    record.deadlineContract?.activationGapBackfillAtomic === true &&
    record.deadlineContract?.outboxPublicationSingleFlight === true &&
    record.deadlineContract?.startupFailureTeardownComplete === true &&
    record.containment?.payloadMemoryHighBytes === 64 * MIB &&
    record.containment?.payloadMemoryMaxBytes === 96 * MIB &&
    record.containment?.supervisorChargedToKernel === true &&
    Number.isSafeInteger(Number(record.recovery?.serviceRestarts)) &&
    Number(record.recovery.serviceRestarts) >= 1 &&
    Number(record.recovery.serviceRestarts) <= 2 &&
    record.recovery?.coreHostFaultsDuringRecovery === 0 &&
    record.recovery?.resyncRequiredDuringRecovery === 0 &&
    record.recovery?.deliveryRetriesDuringRecovery === 0 &&
    record.recovery?.duplicateResyncGroupsDuringRecovery === 0 &&
    record.recovery?.inventedBiologicalTime === false &&
    record.sntss?.version === '0.5.0-i4g1' && record.sntss?.mode === 'SHADOW' &&
    record.sntss?.authority === 'NONE' && record.sntss?.outputs === 0 &&
    record.chronobiology?.mode === 'SHADOW' && record.chronobiology?.authority === 'NONE' &&
    record.bsf?.mode === 'LIVE' && record.benchmark?.durationHours === 72 &&
    record.benchmark?.exactPayloadPidContractObserved === true &&
    record.benchmark?.recoveryRetentionWatermarksObserved === true &&
    record.benchmark?.evidenceFsyncRequired === true &&
    record.benchmark?.collectorContract === 'stay-physiology-benchmark-state-v3';
}

async function main(argv = process.argv.slice(2)) {
  const [mode, ...rest] = argv;
  if (mode === 'capture') {
    const option = options(rest);
    process.stdout.write(JSON.stringify(createRecord({
      sample: option.sample,
      state: option.state,
      parent: option.parent,
      recovery: option.recovery,
      preflight: option.preflight,
      closure: option.closure,
      soak: option.soak,
      release: option.release,
      overlaySha256: option['overlay-sha256'],
      runtimeDropinSha256: option['runtime-dropin-sha256'],
      oneShotDropinSha256: option['one-shot-dropin-sha256'],
      hostname: option.hostname,
      privateIp: option['private-ip'],
      mainPid: option['main-pid'],
      restarts: option.restarts,
      capturedAt: option['captured-at']
    })) + '\n');
    return;
  }
  if (mode === 'verify' && rest.length === 1) {
    const record = readJson(rest[0], 'freeze record');
    if (!verify(record)) fail('R111 production-hardening freeze verification failed', 'P1_PRODUCTION_HARDENING_FREEZE_VERIFY');
    process.stdout.write([
      'P1_PRODUCTION_HARDENING_FREEZE_RESULT=PASS',
      'RUNTIME_REVISION=111',
      'REVISION_LABEL=R111F',
      'BSF_MODE=LIVE',
      'SNTSS_MODE=SHADOW',
      'SNTSS_VERSION=0.5.0-i4g1',
      'SNTSS_AUTHORITY=NONE',
      'SNTSS_OUTPUT_COUNT=0',
      'CHRONOBIOLOGY_MODE=SHADOW',
      'BIOLOGICAL_PACKAGE_CHANGED=NO',
      'BIOLOGICAL_RESOURCE_CONTRACT_CHANGED=NO',
      'EXACTLY_ONCE_COMMIT_FENCE=PASS',
      'SPECULATIVE_OUTPUT_FENCE=PASS',
      'PAYLOAD_CGROUP_ACCOUNTING=PASS',
      'SUPERVISOR_KERNEL_ACCOUNTING=PASS',
      'BENCHMARK_CONTRACT=V3_72H_ZERO_FAULT',
      `FREEZE_RECORD_SHA256=${record.recordSha256}`
    ].join('\n') + '\n');
    return;
  }
  fail('capture or verify required', 'P1_PRODUCTION_HARDENING_FREEZE_USAGE');
}

if (require.main === module) main().catch(error => {
  console.error(`P1_PRODUCTION_HARDENING_FREEZE_ABORT=${error.code || 'FAILED'}:${error.message}`);
  process.exitCode = 1;
});

module.exports = { createRecord, verify, assertFoundation, assertResidentContainment };
