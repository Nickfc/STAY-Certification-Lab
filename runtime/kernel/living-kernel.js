'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const { EventFabric } = require('./event-fabric');
const {
  DURABILITY,
  createSignal,
  deriveSignal
} = require('./biological-fabric');
const { StateStore } = require('./state-store');
const { RuntimeRegistry } = require('./registry');
const { UpgradeManager } = require('./upgrades');
const { ComputeFabric } = require('../compute/compute-fabric');
const { stableStringify } = require('./canonical-json');

const KERNEL_VERSION = '0.8.11.3';

const R128_METAB_SHADOW = Object.freeze({
  authorization:
    'AUTHORIZE_R128_METAB_NEUTRAL_TO_OUTPUT_FIREWALLED_SHADOW_ONLY',
  runtimeRevision: 128,
  parentRevision: 127,
  instanceId:
    'd424c722-ef31-44b0-8201-ba68c418d14a',
  neutralVersion:
    '0.1.0-p1r0-neutral.1',
  neutralCheckpointHash:
    '4a16fc393b9846d1dd6f2f9849920053e3d2b5235c066dde3c5cd72699595107',
  shadowVersion:
    '0.2.0-p1r0-shadow.1',
  sntssHealthMode:
    'SHADOW',
  chronobiologyHealthMode:
    'SHADOW',
  outputPolicy:
    'FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT'
});

const R133_METAB_SHADOW_RECOVERY = Object.freeze({
  ...R128_METAB_SHADOW,
  authorization:
    'AUTHORIZE_R133_METAB_NEUTRAL_TO_OUTPUT_FIREWALLED_SHADOW_RECOVERY_ONLY',
  runtimeRevision: 133,
  activationLabel: 'r133',
  acceptancePrefix: 'R133_RECOVERY'
});

const R135_METAB_SHADOW_RECOVERY = Object.freeze({
  ...R133_METAB_SHADOW_RECOVERY,
  authorization:
    'AUTHORIZE_R135_METAB_NEUTRAL_TO_OUTPUT_FIREWALLED_SHADOW_RECOVERY_ONLY',
  runtimeRevision: 135,
  sntssHealthMode: null,
  chronobiologyHealthMode: 'NEUTRAL',
  activationLabel: 'r135',
  acceptancePrefix: 'R135_RECOVERY'
});

const R137_METAB_SHADOW_RECOVERY = Object.freeze({
  ...R135_METAB_SHADOW_RECOVERY,
  authorization:
    'AUTHORIZE_R137_METAB_NEUTRAL_TO_OUTPUT_FIREWALLED_SHADOW_RECOVERY_ONLY',
  runtimeRevision: 137,
  activationLabel: 'r137',
  acceptancePrefix: 'R137_RECOVERY'
});

const R139_METAB_SHADOW_RECOVERY = Object.freeze({
  ...R137_METAB_SHADOW_RECOVERY,
  authorization:
    'AUTHORIZE_R139_METAB_NEUTRAL_TO_OUTPUT_FIREWALLED_SHADOW_RECOVERY_ONLY',
  runtimeRevision: 139,
  activationLabel: 'r139',
  acceptancePrefix: 'R139_RECOVERY'
});

const R145_HOMEOS_SHADOW = Object.freeze({
  birthAuthorization: 'AUTHORIZE_R143_HOMEOS_NEUTRAL_BIRTH_ONLY',
  metabRouteAuthorization: 'AUTHORIZE_R144_METAB_HOMEOS_ROUTE_ONLY',
  shadowAuthorization: 'AUTHORIZE_R145_HOMEOS_OUTPUT_FIREWALLED_SHADOW_ONLY',
  strandedRecoveryAuthorization:
    'AUTHORIZE_STRANDED_R145_HOMEOS_FORWARD_RECOVERY_ONLY',
  parentRevision: 141,
  birthRevision: 143,
  metabRouteRevision: 144,
  shadowRevision: 145,
  metabInstanceId: 'd424c722-ef31-44b0-8201-ba68c418d14a',
  homeosOutputPolicy: 'FORBIDDEN_UNTIL_INTERO_ATTACHMENT',
  metabOutputPolicy: 'HOMEOS_ONLY_SHADOW_SUMMARIES'
});

const R146_METAB_Q48_HOMEOS_RECOVERY = Object.freeze({
  authorization:
    'AUTHORIZE_STRANDED_R146_METAB_Q48_HOMEOS_FORWARD_RECOVERY_ONLY',
  runtimeRevision: 146,
  repairId: 'metab-q48-saturating-lifetime-r146-v1',
  metabInstanceId: R145_HOMEOS_SHADOW.metabInstanceId,
  metabVersion: '0.2.0-p1r0-shadow.1',
  metabStateSchema: 2,
  metabModuleRelativePath: 'cores/p1-r0/metab-shadow/index.js',
  metabModuleHash:
    'sha256:316ccafbada62b8eb9261d2574833ec0f36eb8232041e9c35320d8cbb419f88d',
  metabManifestHash:
    'sha256:06767143b3eae0760931d93029d4c905c7e811180e818f7236111629e0c1eb69',
  metabPackagePolicyHash:
    'sha256:7aa327005436f91310176753baf94d783661bb5c156be2d8ace0190456fd55c9',
  checkpointId: 'metab-q48-r146-partial-frame-repair-196025',
  checkpointGeneration: 196025,
  inputCursor: 4179959,
  failureRecordId: 164,
  failureSequence: 4179960,
  partialMetabVersion: '0.3.0-p1r0-homeos-feed.1',
  partialMetabStateSchema: 3,
  partialMetabModuleRelativePath: 'cores/p1-r0/metab-homeos/index.js',
  partialMetabModuleHash:
    'sha256:eba96dd21bc225b9bed97261dc9d3648c9a63ed2b2ddbd2d76fb6d306e2a0622',
  partialMetabManifestHash:
    'sha256:ae050626ce7d2e1e1e0d0a6c009a1818e094bfecb792c0bf868bcc14ddd791ac',
  partialMetabPackagePolicyHash:
    'sha256:c97cd6f90c444bf1d496d45c7e64ee2547c86a477a76ca28c41ce528d454780e',
  partialHomeosInstanceId: '3f32bdc9-fa49-4eea-8c13-b9afe6b47c0f',
  partialHomeosVersion: '0.1.0-p1r0-neutral.1',
  partialHomeosStateSchema: 1,
  partialHomeosModuleRelativePath: 'cores/p1-r0/homeos-neutral/index.js',
  partialHomeosModuleHash:
    'sha256:2470be8ba7572296758638f72abbafd5f0e2f8b0effd4d6d7b9fd0dfed830d30',
  partialHomeosManifestHash:
    'sha256:8604f0ea30cca02c1b1f2cf10aa902197389d2a8a508454ff221555c3cde6825',
  partialHomeosPackagePolicyHash:
    'sha256:2f8cc1fd91f84bd1ee54ef9e38929a824f5768775fe849816185bcecd2843b8f',
  finalHomeosInstanceId: '3f32bdc9-fa49-4eea-8c13-b9afe6b47c0f',
  finalHomeosVersion: '0.2.0-p1r0-shadow.1',
  finalHomeosStateSchema: 2,
  finalHomeosModuleRelativePath: 'cores/p1-r0/homeos-shadow/index.js',
  finalHomeosModuleHash:
    'sha256:28ce93b507a070fef823e40cce3e7368928466077fed943c98a1a88b5a84299a',
  finalHomeosManifestHash:
    'sha256:36a34d27e58035063c94cbf2acc7f8646679ee472b1d03f0459c9b4ccaa79179',
  finalHomeosPackagePolicyHash:
    'sha256:1afd6096fed7727491847e702d2506aa9492f8ad7d1424300b99ca3645d8b161',
  finalHomeosCheckpointId: 'homeos-r146-route-boundary-repair-42',
  finalHomeosCheckpointGeneration: 42,
  finalHomeosCheckpointHash:
    '562d336fcf6f7184acaf826d29fe0d890d5705b40c3b49aa4a70a41fa3328046',
  finalHomeosCheckpointBytes: 3926,
  finalHomeosInputCursor: 4241113,
  finalHomeosConsumerCursor: 4241116,
  finalHomeosPrunedConsumerCursor: 4241118,
  finalHomeosTopicsHash:
    'abea82189093d4bb54bee213ed9f9a7ebdd9b2b0b76f6f77dcc2762555e75231',
  finalHomeosFailureRecordId: 184,
  finalHomeosPendingSequences: Object.freeze([4241117, 4241118]),
  finalHomeosPublishedIntentIds: Object.freeze([
    'dd4f1feb2e23462bc77206e91d066aa9e88d41ba145228599d7e64ef0a0ed8dd',
    '63fadd3d778d1132eed2ec1ff533a69825b2fd2524ec16d2b35d81d01e8aeef9'
  ]),
  finalHomeosPublishedIntentHashes: Object.freeze([
    '3e2897f3a6dfc26d5ea0faea147d8dbd552cad7a10b9028cae5dc6f78e866e21',
    'e004c64e4fa571ab00e0858dc4e1299ee4b7207f5b24555cf4be778509cad6bc'
  ]),
  finalHomeosRepairId: 'homeos-r146-route-boundary-continuity-v1',
  fetus: Object.freeze({
    consumerId: 'core:fetus-legacy',
    coreId: 'fetus-legacy',
    instanceId: '82202211-8dd6-44d4-a4ec-8f2553d8dc6f',
    version: '0.6.0',
    authorityEpoch: 1,
    checkpointGeneration: 203,
    checkpointHash:
      '4e1e648fb80c66d6c21d5c1c550ae50f702f581ab52bbda60805ce66b33078bf',
    checkpointBytes: 55962,
    priorConsumerCheckpointHash:
      'dc65f0fff624e08df092620697f230ea28521e8db34614c455f7473e6ed91b7b',
    consumerCursor: 4194076,
    demotionId: 167,
    priorResolutionId: 124,
    priorDemotionId: 116,
    pendingAtDemotion: 16464,
    maximumDebt: 16384,
    topicsHash:
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
  })
});

const R147_HOMEOS_FORWARD_RECOVERY = Object.freeze({
  authorization:
    'AUTHORIZE_STRANDED_R147_HOMEOS_FORWARD_RECOVERY_ONLY',
  runtimeRevision: 147,
  latestRecoveryRecordId: 193,
  homeosRepairRecordId: 192,
  homeosCheckpointHash:
    '923be976d0ddcd7609d159e312b429c89e8704b85ef9757cf6e16010be8a5e1f',
  metab: Object.freeze({
    residencyId: 'resident:metab', coreId: 'METAB',
    instanceId: R145_HOMEOS_SHADOW.metabInstanceId,
    version: '0.3.0-p1r0-homeos-feed.1', stateSchema: 3,
    status: 'RUNNING', checkpointGeneration: 324873,
    checkpointHash: '722ea9378801bb36b6b6b23ccd1f2fbe0ef70c5a85f165a2cddc97c824e219f9',
    moduleRelativePath: R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabModuleRelativePath,
    moduleHash: R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabModuleHash,
    manifestHash: R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabManifestHash,
    packagePolicyHash: R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabPackagePolicyHash
  }),
  homeos: Object.freeze({
    residencyId: 'resident:homeos', coreId: 'HOMEOS',
    instanceId: R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosInstanceId,
    version: R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosVersion, stateSchema: 2,
    status: 'RESYNC_REQUIRED', checkpointGeneration: 42,
    checkpointHash: '923be976d0ddcd7609d159e312b429c89e8704b85ef9757cf6e16010be8a5e1f',
    moduleRelativePath: R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosModuleRelativePath,
    moduleHash: R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosModuleHash,
    manifestHash: R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosManifestHash,
    packagePolicyHash: R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosPackagePolicyHash,
    consumerCursor: 4241118,
    topicsHash: R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosTopicsHash,
    failureRecordId: 184,
    failureSequence: 4241117,
    failureCode: 'P1_RESIDENT_PENDING_BOUND'
  }),
  sntss: Object.freeze({
    residencyId: 'resident:sntss', coreId: 'sntss',
    instanceId: '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
    version: '0.5.0-i4g1', stateSchema: 5,
    status: 'RESYNC_REQUIRED', checkpointGeneration: 2891079,
    checkpointHash: 'd4d83ab89d3d155e97502d008dc23a118c8de73bcdf6215abef8f991ccf43cc1',
    moduleRelativePath: 'cores/sntss/i4g/index.js',
    moduleHash: 'sha256:4e96f1882ddbe35fc0e8f2afcdabae2b5e75812d8e9a392b09bcc8040b335ea7',
    manifestHash: 'sha256:c1d0db3d4520556cb022864f4d1eb487a99628d61f3564942aa65cc0f204499a',
    packagePolicyHash: 'sha256:ba12622fcc9c782c8c48f0544a5b019c96dc198dcbb7fb209c1dad47de64639d',
    consumerCursor: 4460340,
    failureRecordId: 187, failureSequence: 4460341,
    failureCode: 'COREHOST_PAYLOAD_ATTACH_TIMEOUT'
  }),
  chronobiology: Object.freeze({
    residencyId: 'resident:chronobiology', coreId: 'chronobiology',
    instanceId: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
    version: '1.0.0-c3rc.5', stateSchema: 2,
    status: 'RESYNC_REQUIRED', checkpointGeneration: 12380,
    checkpointHash: '9c8643f66af8dd4beb056895370e8b23a5a97a0b6df8207dabbbfd51d7f7fa7c',
    moduleRelativePath: 'cores/chronobiology/c3r5/index.js',
    moduleHash: 'sha256:ecac9b25bf5897d6344cbca702a6ce30ab76c5ff69af76ad17f1aea734e54867',
    manifestHash: 'sha256:4f809b9fee2b4099d51250d339fbee15d226ed9aa0126c4a83d47ff580021012',
    packagePolicyHash: 'sha256:887ff83909b360a75abc1ea6f755db597e613186acaa9b7b20d33b1d21d2232b',
    consumerCursor: 4522718,
    failureRecordId: 190, failureSequence: 4522719,
    failureCode: 'ACTOR_RECOVERY_STALLED'
  })
});

const R147_HOMEOS_CONTINUATION_RECOVERY = Object.freeze({
  authorization:
    'AUTHORIZE_STRANDED_R147_HOMEOS_POST_TIMEOUT_CONTINUATION_ONLY',
  runtimeRevision: 147,
  highWater: 4575520,
  latestRecoveryRecordId: 220,
  fetusResolutionRecordId: 194,
  capacitySource: Object.freeze({
    runtimeRevision: 128,
    lastCommittedFrame: 162684,
    lastTrustedTimeUs: 986135434231,
    lastContinuityEpoch: 1
  }),
  metab: Object.freeze({
    residencyId: 'resident:metab', coreId: 'METAB',
    instanceId: R145_HOMEOS_SHADOW.metabInstanceId,
    version: '0.3.0-p1r0-homeos-feed.1', stateSchema: 3,
    status: 'RUNNING', checkpointGeneration: 325400,
    checkpointHash: 'ec9a31171e5dd07fbe09479aaad9eb5e66de929668c1241914d28a85f9bbc0fe',
    checkpointId: '09f2b7b0-719b-4737-9cef-8d8eb6ba22ff',
    checkpointBytes: 5008, inputCursor: 4575518, consumerCursor: 4575520,
    moduleRelativePath: R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabModuleRelativePath,
    moduleHash: R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabModuleHash,
    manifestHash: R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabManifestHash,
    packagePolicyHash: R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabPackagePolicyHash,
    topicsHash: '089945e41de20089fc1c06ae83c755470a49fe23e2ba8d00ac5a0ddcc64fef82'
  }),
  homeos: Object.freeze({
    residencyId: 'resident:homeos', coreId: 'HOMEOS',
    instanceId: R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosInstanceId,
    version: R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosVersion, stateSchema: 2,
    status: 'RESYNC_REQUIRED', checkpointGeneration: 76,
    checkpointHash: '970a580617d3c298bd7ce3bee5a56791bbe9565d25df7a73cde204e7d41d7f76',
    checkpointId: 'b3a93ad3-a9ce-443d-9e51-a5ec600b0908',
    checkpointBytes: 47620, inputCursor: 4574287, consumerCursor: 4574290,
    moduleRelativePath: R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosModuleRelativePath,
    moduleHash: R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosModuleHash,
    manifestHash: R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosManifestHash,
    packagePolicyHash: R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosPackagePolicyHash,
    topicsHash: R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosTopicsHash,
    failureRecordId: 216, failureSequence: 4574291,
    failureCode: 'RESIDENT_REPLAY_BOUNDED', pendingCount: 1230,
    firstPendingSequence: 4574291, lastPendingSequence: 4575520,
    eligibleReplayCount: 492, invalidPendingCount: 738,
    topics: Object.freeze(['metab.energy.availability.v1', 'metab.energy.reserve.v1',
      'runtime.homeos.shadow-activation', 'runtime.organism.binding'])
  }),
  sntss: Object.freeze({
    residencyId: 'resident:sntss', coreId: 'sntss',
    instanceId: '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
    version: '0.5.0-i4g1', stateSchema: 5,
    status: 'RESYNC_REQUIRED', checkpointGeneration: 2891083,
    checkpointHash: '16a0224ff3f8dbeac51ebb27c05ad6e5bef8a1d831f308367470f7cb639cd5a0',
    checkpointId: 'cb00ab19-2a1e-45cd-9e03-7c31a3c0e629',
    checkpointBytes: 4971, inputCursor: 4574207, consumerCursor: 4574211,
    moduleRelativePath: 'cores/sntss/i4g/index.js',
    moduleHash: 'sha256:4e96f1882ddbe35fc0e8f2afcdabae2b5e75812d8e9a392b09bcc8040b335ea7',
    manifestHash: 'sha256:c1d0db3d4520556cb022864f4d1eb487a99628d61f3564942aa65cc0f204499a',
    packagePolicyHash: 'sha256:ba12622fcc9c782c8c48f0544a5b019c96dc198dcbb7fb209c1dad47de64639d',
    topicsHash: 'b752d8eebb09ac925c4c193810d31f5527315e42e36fbedafa1f30ef25a97501',
    failureRecordId: 219, failureSequence: 4574212,
    failureCode: 'RESIDENT_REPLAY_BOUNDED', pendingCount: 1294,
    firstPendingSequence: 4574212, lastPendingSequence: 4575520,
    eligibleReplayCount: 261, invalidPendingCount: 1033,
    topics: Object.freeze(['runtime.organism.binding', 'runtime.sntss.continuity-genesis',
      'runtime.time.pulse'])
  }),
  chronobiology: Object.freeze({
    residencyId: 'resident:chronobiology', coreId: 'chronobiology',
    instanceId: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
    version: '1.0.0-c3rc.5', stateSchema: 2,
    status: 'RUNNING', checkpointGeneration: 12387,
    checkpointHash: 'd6374f44ba42dfa716cea7f291422f3c4684308fc73c95db1b2723d03639e022',
    checkpointId: '07ebe290-b267-4af9-84e3-e8dee435cc66',
    checkpointBytes: 49187, inputCursor: 4575400, consumerCursor: 4575520,
    moduleRelativePath: 'cores/chronobiology/c3r5/index.js',
    moduleHash: 'sha256:ecac9b25bf5897d6344cbca702a6ce30ab76c5ff69af76ad17f1aea734e54867',
    manifestHash: 'sha256:4f809b9fee2b4099d51250d339fbee15d226ed9aa0126c4a83d47ff580021012',
    packagePolicyHash: 'sha256:887ff83909b360a75abc1ea6f755db597e613186acaa9b7b20d33b1d21d2232b',
    topicsHash: 'a0897ae1c2f0bdf9f94e5491cf681820cda4a0126afcb47511cc4a538d5a281e'
  }),
  fetus: Object.freeze({
    consumerId: 'core:fetus-legacy', coreId: 'fetus-legacy',
    instanceId: '82202211-8dd6-44d4-a4ec-8f2553d8dc6f', version: '0.6.0',
    authorityEpoch: 1, consumerCursor: 4574204,
    consumerCheckpointHash: '4e1e648fb80c66d6c21d5c1c550ae50f702f581ab52bbda60805ce66b33078bf',
    checkpointGeneration: 207,
    checkpointHash: '2e532d20a1cddb41896ea8127f3ffc1d3f1612e134bba06b497d51d0e51a6c68',
    checkpointBytes: 59402,
    topicsHash: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
  })
});

/*
 * Exact successor to the first bounded R147 continuation attempt.  That
 * attempt correctly removed only invalid delivery assignments and restored
 * SNTSS, Chronobiology, and METAB.  HOMEOS remained stopped because its
 * retained checkpoint exposed an older committed-METAB frame boundary.  A
 * release-controlled pre-start repair advances only the proven UNKNOWN
 * coordinates and applies the sixteen complete pairs already in the
 * checkpoint.  This fence admits only that post-repair state and the 492
 * still-pending, ordered HOMEOS deliveries.
 */
const R147_HOMEOS_FRAME_BOUNDARY_RECOVERY = Object.freeze({
  authorization: R147_HOMEOS_CONTINUATION_RECOVERY.authorization,
  runtimeRevision: 147,
  highWater: 4575520,
  latestRecoveryRecordId: 231,
  repairId: 'homeos-r147-committed-metab-frame-boundary-v1',
  repairCheckpointHash: 'd4805d5951a38fc4e5502fb3b787d7dc093e3dc9bf5ca0fb6eb4bbe815563f61',
  metab: Object.freeze({
    ...R147_HOMEOS_CONTINUATION_RECOVERY.metab,
    checkpointGeneration: 325401,
    checkpointId: '3ec1e822-c6ae-48c1-8dc4-7a792d0f3d46'
  }),
  homeos: Object.freeze({
    ...R147_HOMEOS_CONTINUATION_RECOVERY.homeos,
    checkpointGeneration: 78,
    checkpointHash: 'd4805d5951a38fc4e5502fb3b787d7dc093e3dc9bf5ca0fb6eb4bbe815563f61',
    checkpointId: 'homeos-r147-frame-boundary-repair-78',
    checkpointBytes: 3943,
    pendingCount: 492,
    eligibleReplayCount: 492,
    invalidPendingCount: 0,
    replayBeginRecordId: 224,
    failureRecordId: 225,
    failureCode: 'P1_RESIDENT_PENDING_BOUND'
  }),
  sntss: Object.freeze({
    ...R147_HOMEOS_CONTINUATION_RECOVERY.sntss,
    status: 'RUNNING',
    checkpointGeneration: 2891345,
    checkpointHash: '76be4edfec7355aa2f21f1cd10f86928b54c51fe2897cc38ceefd6abde1ccd8a',
    checkpointId: 'dfaf23c7-2c2f-46d9-862c-e728fa7d27d6',
    checkpointBytes: 4973,
    inputCursor: 4575516,
    consumerCursor: 4575516,
    pendingCount: 0,
    eligibleReplayCount: 0,
    invalidPendingCount: 0
  }),
  chronobiology: Object.freeze({
    ...R147_HOMEOS_CONTINUATION_RECOVERY.chronobiology,
    checkpointGeneration: 12388,
    checkpointId: '4ac1dc48-0d93-4993-a88f-04ac7ef9cc47'
  }),
  fetus: Object.freeze({
    ...R147_HOMEOS_CONTINUATION_RECOVERY.fetus,
    checkpointGeneration: 208,
    checkpointHash: '09e5c63c912792d96535f6bcfe65861b55b4eccd38f9e50085a9bb30989966ae',
    checkpointBytes: 60264
  })
});

/*
 * A normal post-durable service start after the completed R147 HOMEOS replay
 * advanced the Kernel start generation to R148 before the fetus CoreHost could
 * finish initializing.  The optional residents were already reconstructed and
 * their transitions were durably committed.  Recovery must therefore preserve
 * R148, awaken the fetus before rebuilding optional resident CoreHosts, and
 * drain only the exact retained obligations below.  It must never reinterpret
 * this boundary as the separately-authorized INTERO R148 route tranche.
 */
const R148_HOMEOS_INIT_FORWARD_RECOVERY = Object.freeze({
  authorization: 'AUTHORIZE_STRANDED_R148_HOMEOS_INIT_FORWARD_RECOVERY_ONLY',
  runtimeRevision: 148,
  highWater: 4575680,
  latestRecoveryRecordId: 242,
  runtimeRevisionMetadataHash:
    '95006d8102f40df4d7e9f94d26b7ef6fc73ce0e965526b17b812515c8cbe78d0',
  capacitySourceMetadataHash:
    'e9a6efb7deff7c43d2adffe10b90f85a3327a3b9ffe5a7f9df0da4067f75b0b4',
  pendingFetusDeliveries: 160,
  pendingFetusFirstSequence: 4575521,
  pendingFetusLastSequence: 4575680,
  pendingOutbox: Object.freeze([
    Object.freeze({
      producerEventId: '3e1a8eac1c292fc9153d721ff5a01423a0134bf359cdcd11c6b1354b23d70c76',
      intentHash: 'ec9a0aa818f7c92c3c0736e4833d9032c75b5fb562f08c856cc71a7a08d963a3',
      checkpointHash: 'b526325e704c1aee7d2f8a373e16d9470345f782c83fc6f306b78e6d858c44b6',
      checkpointGeneration: 325468,
      streamSequence: 129423,
      causeSequence: 4575680,
      topic: 'metab.energy.availability.v1'
    }),
    Object.freeze({
      producerEventId: '75cec9456437f48238b6fd9b12313a8d9820ca68ceacee56083df5f8766561bd',
      intentHash: '47615230deb7a726fbeac54807d5b7f584e422cf043eb5030e0c1e23b82bc12d',
      checkpointHash: 'b526325e704c1aee7d2f8a373e16d9470345f782c83fc6f306b78e6d858c44b6',
      checkpointGeneration: 325468,
      streamSequence: 129424,
      causeSequence: 4575680,
      topic: 'metab.energy.reserve.v1'
    })
  ]),
  residents: Object.freeze({
    'resident:chronobiology': Object.freeze({
      residencyId: 'resident:chronobiology', coreId: 'chronobiology',
      instanceId: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
      version: '1.0.0-c3rc.5', stateSchema: 2, status: 'RUNNING',
      checkpointGeneration: 12392,
      checkpointHash: 'd353fb25a6d4e353869bd1756b6ca910d1177786151f0d72f9555e31250e1540',
      checkpointId: 'a66d62f5-f41a-4a09-8666-41ec51af87fe',
      checkpointBytes: 49191, inputCursor: 4575521, consumerCursor: 4575680,
      moduleRelativePath: 'cores/chronobiology/c3r5/index.js',
      moduleHash: 'sha256:ecac9b25bf5897d6344cbca702a6ce30ab76c5ff69af76ad17f1aea734e54867',
      manifestHash: 'sha256:4f809b9fee2b4099d51250d339fbee15d226ed9aa0126c4a83d47ff580021012',
      packagePolicyHash: 'sha256:887ff83909b360a75abc1ea6f755db597e613186acaa9b7b20d33b1d21d2232b',
      topicsHash: 'a0897ae1c2f0bdf9f94e5491cf681820cda4a0126afcb47511cc4a538d5a281e'
    }),
    'resident:homeos': Object.freeze({
      residencyId: 'resident:homeos', coreId: 'HOMEOS',
      instanceId: '3f32bdc9-fa49-4eea-8c13-b9afe6b47c0f',
      version: '0.2.0-p1r0-shadow.1', stateSchema: 2, status: 'RUNNING',
      checkpointGeneration: 635,
      checkpointHash: '7a0fb44dcfa5650d8a30f03b287054bef13ae212869aa6821324fe9aa1226c9b',
      checkpointId: '804a33d3-5ecd-45b7-9706-752d1608c5db',
      checkpointBytes: 3944, inputCursor: 4575677, consumerCursor: 4575680,
      moduleRelativePath: 'cores/p1-r0/homeos-shadow/index.js',
      moduleHash: 'sha256:28ce93b507a070fef823e40cce3e7368928466077fed943c98a1a88b5a84299a',
      manifestHash: 'sha256:36a34d27e58035063c94cbf2acc7f8646679ee472b1d03f0459c9b4ccaa79179',
      packagePolicyHash: 'sha256:1afd6096fed7727491847e702d2506aa9492f8ad7d1424300b99ca3645d8b161',
      topicsHash: 'abea82189093d4bb54bee213ed9f9a7ebdd9b2b0b76f6f77dcc2762555e75231'
    }),
    'resident:metab': Object.freeze({
      residencyId: 'resident:metab', coreId: 'METAB',
      instanceId: 'd424c722-ef31-44b0-8201-ba68c418d14a',
      version: '0.3.0-p1r0-homeos-feed.1', stateSchema: 3, status: 'RUNNING',
      checkpointGeneration: 325468,
      checkpointHash: 'b526325e704c1aee7d2f8a373e16d9470345f782c83fc6f306b78e6d858c44b6',
      checkpointId: 'ad8d6e0c-36d7-46af-994d-543359131580',
      checkpointBytes: 5009, inputCursor: 4575680, consumerCursor: 4575680,
      moduleRelativePath: 'cores/p1-r0/metab-homeos/index.js',
      moduleHash: 'sha256:eba96dd21bc225b9bed97261dc9d3648c9a63ed2b2ddbd2d76fb6d306e2a0622',
      manifestHash: 'sha256:ae050626ce7d2e1e1e0d0a6c009a1818e094bfecb792c0bf868bcc14ddd791ac',
      packagePolicyHash: 'sha256:c97cd6f90c444bf1d496d45c7e64ee2547c86a477a76ca28c41ce528d454780e',
      topicsHash: '089945e41de20089fc1c06ae83c755470a49fe23e2ba8d00ac5a0ddcc64fef82'
    }),
    'resident:sntss': Object.freeze({
      residencyId: 'resident:sntss', coreId: 'sntss',
      instanceId: '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
      version: '0.5.0-i4g1', stateSchema: 5, status: 'RUNNING',
      checkpointGeneration: 2891380,
      checkpointHash: 'cbd9ab3546e38c810523c54d63d0d3984327bef0dc4bf815691902dd8007af57',
      checkpointId: '829da15e-f664-4966-bab4-f7882d5ac520',
      checkpointBytes: 4972, inputCursor: 4575678, consumerCursor: 4575680,
      moduleRelativePath: 'cores/sntss/i4g/index.js',
      moduleHash: 'sha256:4e96f1882ddbe35fc0e8f2afcdabae2b5e75812d8e9a392b09bcc8040b335ea7',
      manifestHash: 'sha256:c1d0db3d4520556cb022864f4d1eb487a99628d61f3564942aa65cc0f204499a',
      packagePolicyHash: 'sha256:ba12622fcc9c782c8c48f0544a5b019c96dc198dcbb7fb209c1dad47de64639d',
      topicsHash: 'b752d8eebb09ac925c4c193810d31f5527315e42e36fbedafa1f30ef25a97501'
    })
  }),
  fetus: Object.freeze({
    consumerId: 'core:fetus-legacy', coreId: 'fetus-legacy',
    instanceId: '82202211-8dd6-44d4-a4ec-8f2553d8dc6f', version: '0.6.0',
    authorityEpoch: 1, consumerCursor: 4574204,
    consumerCheckpointHash: '4e1e648fb80c66d6c21d5c1c550ae50f702f581ab52bbda60805ce66b33078bf',
    checkpointGeneration: 211,
    checkpointHash: 'b98888fa5beb39c3fdf909d38eceb522b96ac59134072074a8ae417b5c145280',
    checkpointBytes: 61126,
    topicsHash: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
  })
});

const R148_HOMEOS_INIT_POST_DURABLE_FINALIZATION = Object.freeze({
  authorization: 'AUTHORIZE_STRANDED_R148_HOMEOS_INIT_POST_DURABLE_FINALIZATION_ONLY',
  runtimeRevision: 148,
  highWater: 4575682,
  latestRecoveryRecordId: 246,
  runtimeRevisionMetadataHash:
    '95006d8102f40df4d7e9f94d26b7ef6fc73ce0e965526b17b812515c8cbe78d0',
  capacitySourceMetadataHash:
    'e9a6efb7deff7c43d2adffe10b90f85a3327a3b9ffe5a7f9df0da4067f75b0b4',
  residents: Object.freeze({
    'resident:chronobiology': Object.freeze({
      ...R148_HOMEOS_INIT_FORWARD_RECOVERY.residents['resident:chronobiology'],
      checkpointGeneration: 12394,
      checkpointId: '958a0163-fb2e-4f75-8ade-8569f24e5852',
      consumerCursor: 4575682
    }),
    'resident:homeos': Object.freeze({
      ...R148_HOMEOS_INIT_FORWARD_RECOVERY.residents['resident:homeos'],
      checkpointGeneration: 639,
      checkpointHash: '039b15ff0fe06db56964a054d1c738283fc007ff490f8cf03c44ff418fda94aa',
      checkpointId: 'e0c38bbf-7d9c-4434-bf26-a3b68c29332a',
      inputCursor: 4575682, consumerCursor: 4575682
    }),
    'resident:metab': Object.freeze({
      ...R148_HOMEOS_INIT_FORWARD_RECOVERY.residents['resident:metab'],
      checkpointGeneration: 325470,
      checkpointId: '929f299e-85c2-44c3-b10c-f48f7f6490d1',
      consumerCursor: 4575682
    }),
    'resident:sntss': Object.freeze({
      ...R148_HOMEOS_INIT_FORWARD_RECOVERY.residents['resident:sntss'],
      checkpointGeneration: 2891382,
      checkpointId: '66071c31-2bee-45e9-98dc-384fa6cf798d',
      consumerCursor: 4575682
    })
  }),
  fetus: Object.freeze({
    ...R148_HOMEOS_INIT_FORWARD_RECOVERY.fetus,
    consumerCursor: 4575682,
    checkpointGeneration: 214,
    checkpointHash: '706123370dc9b7194c847a0b2e186f48d9e83b796a9e4d6f79403a4c1a9b6114',
    checkpointBytes: 61986
  })
});

/*
 * The first exact post-durable finalization reconstructed all four residents,
 * but its external acceptance client reached a server-side status allowlist
 * that still excluded HOMEOS.  Fail-closed cleanup stopped the service after
 * the reconstruction was committed.  This fence permits only that resulting
 * R148 cohort to restart without replaying events or advancing to R149.
 */
const R148_HOMEOS_POST_FINALIZATION_RESTART = Object.freeze({
  authorization: 'AUTHORIZE_STRANDED_R148_HOMEOS_POST_FINALIZATION_RESTART_ONLY',
  runtimeRevision: 148,
  highWater: 4575682,
  latestRecoveryRecordId: 250,
  runtimeRevisionMetadataHash:
    '95006d8102f40df4d7e9f94d26b7ef6fc73ce0e965526b17b812515c8cbe78d0',
  capacitySourceMetadataHash:
    'e9a6efb7deff7c43d2adffe10b90f85a3327a3b9ffe5a7f9df0da4067f75b0b4',
  residents: Object.freeze({
    'resident:chronobiology': Object.freeze({
      ...R148_HOMEOS_INIT_POST_DURABLE_FINALIZATION.residents['resident:chronobiology'],
      checkpointGeneration: 12396,
      checkpointId: '508c0ce9-bd8c-46d0-8dc2-5332f409d6e1'
    }),
    'resident:homeos': Object.freeze({
      ...R148_HOMEOS_INIT_POST_DURABLE_FINALIZATION.residents['resident:homeos'],
      checkpointGeneration: 641,
      checkpointId: 'cd5ac03d-8f56-4dc5-92b1-ba531ded973e'
    }),
    'resident:metab': Object.freeze({
      ...R148_HOMEOS_INIT_POST_DURABLE_FINALIZATION.residents['resident:metab'],
      checkpointGeneration: 325472,
      checkpointId: '2796adc0-92a4-415d-9d2f-3f628f6c8483'
    }),
    'resident:sntss': Object.freeze({
      ...R148_HOMEOS_INIT_POST_DURABLE_FINALIZATION.residents['resident:sntss'],
      checkpointGeneration: 2891384,
      checkpointId: '3eee91b2-07cb-4e20-b222-3d7c32279e9e'
    })
  }),
  fetus: Object.freeze({
    ...R148_HOMEOS_INIT_POST_DURABLE_FINALIZATION.fetus,
    checkpointGeneration: 217,
    checkpointHash: 'dcfd5507220929e87bf28ec222170fc7bc537ff764d2056ba911be3ec2ab128e',
    checkpointBytes: 62848
  })
});

/*
 * The first restart of the post-durable R148 cohort rebuilt all four
 * residents, but deferred recovery meant the hardened trusted-time scheduler
 * was not resumed. METAB had already durably accepted capacity frame 162716;
 * only the source ledger acknowledgement remained pending. This fence admits
 * the exact stopped result of that restart so startup can idempotently
 * re-observe the already-persisted pair, commit the source acknowledgement,
 * and resume the schedulers without advancing the runtime revision.
 */
const R148_HOMEOS_CAPACITY_SOURCE_FINALIZATION = Object.freeze({
  authorization: 'AUTHORIZE_STRANDED_R148_HOMEOS_CAPACITY_SOURCE_FINALIZATION_ONLY',
  runtimeRevision: 148,
  highWater: 4575682,
  latestRecoveryRecordId: 254,
  runtimeRevisionMetadataHash:
    '95006d8102f40df4d7e9f94d26b7ef6fc73ce0e965526b17b812515c8cbe78d0',
  capacitySourceMetadataHash:
    'e9a6efb7deff7c43d2adffe10b90f85a3327a3b9ffe5a7f9df0da4067f75b0b4',
  committedCapacitySourceMetadataHash:
    'ad3e6e4a829a9dd82261d44f795c888bdd74ed4a9aee183e837a9aa762920667',
  capacitySource: Object.freeze({
    lastCommittedFrame: 162716,
    lastTrustedTimeUs: 1011924235209,
    lastContinuityEpoch: 1
  }),
  residents: Object.freeze({
    'resident:chronobiology': Object.freeze({
      ...R148_HOMEOS_POST_FINALIZATION_RESTART.residents['resident:chronobiology'],
      checkpointGeneration: 12398,
      checkpointId: '7a944b2c-81c7-4039-be84-580392946918'
    }),
    'resident:homeos': Object.freeze({
      ...R148_HOMEOS_POST_FINALIZATION_RESTART.residents['resident:homeos'],
      checkpointGeneration: 643,
      checkpointId: '41040104-f61f-4c0a-8dcd-30b9a98a74a4'
    }),
    'resident:metab': Object.freeze({
      ...R148_HOMEOS_POST_FINALIZATION_RESTART.residents['resident:metab'],
      checkpointGeneration: 325474,
      checkpointId: 'a844ee26-489b-4729-987b-44b8f4b6ca63'
    }),
    'resident:sntss': Object.freeze({
      ...R148_HOMEOS_POST_FINALIZATION_RESTART.residents['resident:sntss'],
      checkpointGeneration: 2891386,
      checkpointId: '929a3875-d7df-476e-b1d0-de5c1a1fe691'
    })
  }),
  fetus: Object.freeze({
    ...R148_HOMEOS_POST_FINALIZATION_RESTART.fetus,
    checkpointGeneration: 220,
    checkpointHash: '7e38f6099e9f2749fd2a76d8dcd5141012f7d4e78f9ad1c593eaf787c521e24b',
    checkpointBytes: 63710
  })
});

const R150_INTERO_SHADOW = Object.freeze({
  birthAuthorization: 'AUTHORIZE_R147_INTERO_NEUTRAL_BIRTH_ONLY',
  metabRouteAuthorization: 'AUTHORIZE_R148_METAB_INTERO_ROUTE_ONLY',
  homeosRouteAuthorization: 'AUTHORIZE_R149_HOMEOS_INTERO_ROUTE_ONLY',
  shadowAuthorization: 'AUTHORIZE_R150_INTERO_PERCEPTION_ONLY_SHADOW_ONLY',
  parentRevision: 145,
  birthRevision: 147,
  metabRouteRevision: 148,
  homeosRouteRevision: 149,
  shadowRevision: 150,
  metabOutputPolicy: 'HOMEOS_AND_INTERO_SHADOW_SUMMARIES',
  homeosOutputPolicy: 'INTERO_STABILITY_ONLY_SHADOW_SUMMARY',
  interoOutputPolicy: 'PERCEPTION_ONLY_NO_OUTPUT'
});

function isBoundedMetabPromotionTail(pendingDeliveries) {
  return Number.isSafeInteger(pendingDeliveries) &&
    pendingDeliveries >= 0 && pendingDeliveries <= 2;
}

function defaultMetabCapacitySampler() {
  const cpuCount = os.cpus()?.length;
  const loadAverage = os.loadavg()?.[0];
  const freeMemoryBytes = os.freemem();
  const totalMemoryBytes = os.totalmem();

  if (
    !Number.isSafeInteger(cpuCount) ||
    cpuCount < 1 ||
    !Number.isFinite(loadAverage) ||
    loadAverage < 0 ||
    !Number.isSafeInteger(freeMemoryBytes) ||
    freeMemoryBytes < 0 ||
    !Number.isSafeInteger(totalMemoryBytes) ||
    totalMemoryBytes < 1 ||
    freeMemoryBytes > totalMemoryBytes
  ) {
    throw Object.assign(
      new Error('Kernel resource sample is unavailable'),
      { code: 'P1_METAB_CAPACITY_SAMPLE' }
    );
  }

  return Object.freeze({
    cpuCount,
    loadAverageMilli:
      Math.max(0, Math.round(loadAverage * 1000)),
    freeMemoryBytes,
    totalMemoryBytes
  });
}

const R124_METAB_RECOVERY = Object.freeze({
  markerSha256: 'sha256:933b128f24d4898550add86f4b34174f18b42e942391ec479f8956689624bb5e',
  failureEvidence:
    '/var/lib/stay/evidence/production-hardening/FAILED-R124-20260902T144307Z.eMKkA2',
  release: '/opt/stay/releases/0.8.11.3-p1m-r124-metab-neutral-a1999132f935',
  releaseTag: 'r124-metab-neutral-v4',
  releaseCommit: '16e8e2d9ca04c8829425f99b91a49b3e495777cc',
  releaseTree: '316f94dc20c29a431cbe009f3564e6f0b6687a24',
  archiveSha256:
    'sha256:ebbfca81636d5952a7db3b8c771d5c7660c841ecb023ae6cb212f71fa2775458',
  manifestSha256:
    'sha256:a1999132f935054dc7c482313b88b0679f73475a225b9706c27ed2686d822b26',
  controllerSha256:
    'sha256:11ccd13023daeb29b20076e2dab2c4af1b3ce516480449eeb8ffc917575c0b7d',
  certificateSha256:
    'sha256:5fde5160f4a6dac8f97b546ef9b3458b64185465944c07e6c89a915912d2b4a6',
  dossierSha256:
    'sha256:3eba9eb287f2f25a8ed06b12d104a538ac1c0511b948041c38f1ca24ebf27a1f',
  publicKeySha256:
    'sha256:754f949e67c31bc25b3bdf66e74a9b69ad44f781d43606b7a46ac69531e0551e',
  evidence: Object.freeze({
    'before.proof.json':
      '40e54a2d6ed649132c5f1395d8cdf0ed7075cbe0ff5c4d89a2c57707c84ca4da',
    'service.before.json':
      '95d99d8b56d6299680928d10bacc5cc41bd5cc3fedf584ee519ce69729c5cb74',
    'R123.freeze.json':
      '34baedccaa9227ebd20c0b11a9e32fa6b98deb3c25ca2db03fa846bf49251a92',
    'benchmark.proof.json':
      '9dc732e26d7974f4a5998a936051bd1f52909399179b8313a2311f5299f1fcac'
  })
});

const R127_POST_RESTART_CONTINUITY = Object.freeze({
  authorization:
    'AUTHORIZE_R127_POST_RESTART_FETUS_SNTSS_CHRONOBIOLOGY_CONTINUITY_ONLY',
  metab: Object.freeze({
    residencyId: 'resident:metab',
    instanceId: 'd424c722-ef31-44b0-8201-ba68c418d14a',
    version: '0.1.0-p1r0-neutral.1',
    checkpointHash: '4a16fc393b9846d1dd6f2f9849920053e3d2b5235c066dde3c5cd72699595107'
  }),
  sntss: Object.freeze({
    residencyId: 'resident:sntss',
    coreId: 'sntss',
    instanceId: '8c65a965-5236-46e1-a2f1-e2f8cfc1ac0f',
    version: '0.5.0-i4g1',
    checkpointGeneration: 2449921,
    checkpointHash: 'dd5921a4b98c054b463daf6216dddb39789773f890db464d0434809c55677acc',
    inputCursor: 3652768,
    consumerCursor: 3652769,
    pendingSequence: 3652770,
    topic: 'runtime.time.pulse',
    pulseSequence: 1,
    lastPulseSequence: 23828,
    recoveryRecordId: 120,
    recoveryCode: 'SNTSS_TIME_REWIND',
    topics: Object.freeze([
      'runtime.organism.binding',
      'runtime.sntss.continuity-genesis',
      'runtime.time.pulse'
    ]),
    topicsHash: 'b752d8eebb09ac925c4c193810d31f5527315e42e36fbedafa1f30ef25a97501'
  }),
  chronobiology: Object.freeze({
    residencyId: 'resident:chronobiology',
    coreId: 'chronobiology',
    instanceId: 'f1e1ae54-9ea0-4d64-a9c6-6e4a301c5e8a',
    version: '1.0.0-c3rc.5',
    checkpointGeneration: 10049,
    checkpointHash: '49f3a88b1b811757879e4cdddd25496f2bd4f3f3e4927d9b30d71c4b91c5efc9',
    inputCursor: 3652631,
    consumerCursor: 3652768,
    pendingSequence: 3652769,
    topic: 'runtime.trusted-organism-time.pulse',
    pulseSequence: 1,
    lastPulseSequence: 100,
    recoveryRecordId: 119,
    recoveryCode: 'CHRONOBIOLOGY_TIME_REWIND',
    topics: Object.freeze([
      'environment.photic.exposure',
      'runtime.organism.binding',
      'runtime.trusted-organism-time.pulse'
    ]),
    topicsHash: 'a0897ae1c2f0bdf9f94e5491cf681820cda4a0126afcb47511cc4a538d5a281e'
  }),
  fetus: Object.freeze({
    consumerId: 'core:fetus-legacy',
    coreId: 'fetus-legacy',
    instanceId: '82202211-8dd6-44d4-a4ec-8f2553d8dc6f',
    version: '0.6.0',
    authorityEpoch: 1,
    checkpointGeneration: 185,
    checkpointHash: 'dc65f0fff624e08df092620697f230ea28521e8db34614c455f7473e6ed91b7b',
    consumerCursor: 3620902,
    demotionId: 116,
    pendingAtDemotion: 16464,
    maximumDebt: 16384,
    topicsHash: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
  }),
  ledger: Object.freeze({
    cohortFirstSequence: 3652769,
    highWater: 3654057,
    timePulseCount: 1283,
    trustedOrganismTimePulseCount: 6
  })
});

function sha256Bytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function readR124MetabRecoveryFence({
  markerFile,
  expectedMarkerSha256,
  trustedUid
}) {
  if (
    expectedMarkerSha256 !== R124_METAB_RECOVERY.markerSha256 ||
    typeof markerFile !== 'string'
  ) {
    throw Object.assign(
      new Error('R124 METAB recovery marker identity is not authorized'),
      { code: 'P1_METAB_RECOVERY_MARKER' }
    );
  }
  let markerStat;
  let raw;
  try {
    markerStat = fs.lstatSync(markerFile);
    raw = fs.readFileSync(markerFile);
  } catch (error) {
    throw Object.assign(
      new Error(`R124 METAB recovery marker is unavailable: ${error.message}`),
      { code: 'P1_METAB_RECOVERY_MARKER' }
    );
  }
  if (
    !markerStat.isFile() ||
    markerStat.isSymbolicLink() ||
    markerStat.uid !== trustedUid ||
    (markerStat.mode & 0o022) !== 0 ||
    raw.length < 1 ||
    raw.length > 8192 ||
    sha256Bytes(raw) !== expectedMarkerSha256
  ) {
    throw Object.assign(
      new Error('R124 METAB recovery marker trust fence failed'),
      { code: 'P1_METAB_RECOVERY_MARKER' }
    );
  }
  const lines = raw.toString('utf8').trimEnd().split('\n');
  const values = new Map();
  for (const line of lines) {
    const index = line.indexOf('=');
    if (index < 1) {
      throw Object.assign(new Error('R124 METAB recovery marker is malformed'), {
        code: 'P1_METAB_RECOVERY_MARKER'
      });
    }
    const key = line.slice(0, index);
    if (values.has(key)) {
      throw Object.assign(new Error('R124 METAB recovery marker repeats a field'), {
        code: 'P1_METAB_RECOVERY_MARKER'
      });
    }
    values.set(key, line.slice(index + 1));
  }
  const expected = new Map([
    ['R124_FAILURE_EVIDENCE', R124_METAB_RECOVERY.failureEvidence],
    ['R124_RELEASE', R124_METAB_RECOVERY.release],
    ['R124_RELEASE_TAG', R124_METAB_RECOVERY.releaseTag],
    ['R124_RELEASE_COMMIT', R124_METAB_RECOVERY.releaseCommit],
    ['R124_RELEASE_TREE', R124_METAB_RECOVERY.releaseTree],
    ['R124_ARCHIVE_SHA256', R124_METAB_RECOVERY.archiveSha256],
    ['R124_MANIFEST_SHA256', R124_METAB_RECOVERY.manifestSha256],
    ['R124_CONTROLLER_SHA256', R124_METAB_RECOVERY.controllerSha256],
    ['R124_BIRTH_CERTIFICATE_SHA256', R124_METAB_RECOVERY.certificateSha256],
    ['R124_BIRTH_DOSSIER_SHA256', R124_METAB_RECOVERY.dossierSha256],
    ['R124_BIRTH_PUBLIC_KEY_SHA256', R124_METAB_RECOVERY.publicKeySha256]
  ]);
  if (
    values.size !== expected.size ||
    [...expected].some(([key, value]) => values.get(key) !== value)
  ) {
    throw Object.assign(
      new Error('R124 METAB recovery marker cohort is not exact'),
      { code: 'P1_METAB_RECOVERY_MARKER' }
    );
  }
  let evidenceStat;
  try {
    evidenceStat = fs.lstatSync(R124_METAB_RECOVERY.failureEvidence);
  } catch (error) {
    throw Object.assign(
      new Error(`R124 METAB failure evidence is unavailable: ${error.message}`),
      { code: 'P1_METAB_RECOVERY_EVIDENCE' }
    );
  }
  if (
    !evidenceStat.isDirectory() ||
    evidenceStat.isSymbolicLink() ||
    evidenceStat.uid !== trustedUid ||
    (evidenceStat.mode & 0o022) !== 0
  ) {
    throw Object.assign(
      new Error('R124 METAB failure evidence trust fence failed'),
      { code: 'P1_METAB_RECOVERY_EVIDENCE' }
    );
  }
  for (const [name, expectedHash] of Object.entries(R124_METAB_RECOVERY.evidence)) {
    const file = path.join(R124_METAB_RECOVERY.failureEvidence, name);
    const stat = fs.lstatSync(file);
    const body = fs.readFileSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== trustedUid ||
      (stat.mode & 0o022) !== 0 ||
      sha256Bytes(body) !== `sha256:${expectedHash}`
    ) {
      throw Object.assign(
        new Error(`R124 METAB failure evidence is invalid: ${name}`),
        { code: 'P1_METAB_RECOVERY_EVIDENCE' }
      );
    }
  }
  return Object.freeze({
    markerSha256: expectedMarkerSha256,
    failureEvidence: R124_METAB_RECOVERY.failureEvidence
  });
}

class LivingKernel {
  constructor({
    dataDir,
    logger = console,
    clock = () => Date.now(),
    allowIdentityBootstrap = false,
    heartbeatIntervalMs = Number(process.env.STAY_HEARTBEAT_INTERVAL_MS || 30000),
    snapshotIntervalMs = Number(process.env.STAY_SNAPSHOT_INTERVAL_MS || 21600000),
    snapshotRetention = Number(process.env.STAY_SNAPSHOT_RETENTION || 24),
    releaseRoot = path.resolve(__dirname, '..', '..'),
    trustedOrganismTime = null,
    enableTrustedOrganismTime =
      process.env.STAY_ENABLE_TRUSTED_ORGANISM_TIME === '1',
    durableResidentsDisabled =
      process.env.STAY_DISABLE_DURABLE_RESIDENTS === '1',
    allowLaboratoryResidentAttachment =
      process.env.STAY_REQUIRE_CORE_PROMOTION_CERT !== '1',

    allowBoundedChronobiologyShadowAttachment =
      process.env.STAY_ALLOW_CHRONOBIOLOGY_SHADOW_ATTACH === '1',

    allowBoundedSntssContinuityGenesisPromotion =
      process.env.STAY_ALLOW_SNTSS_I4G_PROMOTION === '1',

    allowMetabNeutralBirth =
      process.env.STAY_ALLOW_METAB_NEUTRAL_BIRTH === '1',

    allowMetabNeutralRecovery =
      process.env.STAY_ALLOW_METAB_NEUTRAL_RECOVERY === '1',

    allowMetabNeutralRecoveryRevisionPreservation =
      process.env.STAY_ALLOW_METAB_NEUTRAL_RECOVERY_REVISION_PRESERVATION === '1',

    allowMetabShadowPromotion =
      process.env.STAY_ALLOW_METAB_SHADOW_PROMOTION === '1',

    homeosNeutralBirthAuthorization =
      process.env.STAY_HOMEOS_NEUTRAL_BIRTH_AUTHORIZATION || '',

    metabHomeosRouteAuthorization =
      process.env.STAY_METAB_HOMEOS_ROUTE_AUTHORIZATION || '',

    homeosShadowPromotionAuthorization =
      process.env.STAY_HOMEOS_SHADOW_PROMOTION_AUTHORIZATION || '',

    homeosStrandedR145RecoveryAuthorization =
      process.env.STAY_HOMEOS_STRANDED_R145_RECOVERY_AUTHORIZATION || '',

    homeosStrandedR146RecoveryAuthorization =
      process.env.STAY_HOMEOS_STRANDED_R146_RECOVERY_AUTHORIZATION || '',

    homeosStrandedR147RecoveryAuthorization =
      process.env.STAY_HOMEOS_STRANDED_R147_RECOVERY_AUTHORIZATION || '',

    r147ContinuationPreflightSnapshot =
      process.env.STAY_R147_CONTINUATION_PREFLIGHT_SNAPSHOT || '',

    r147ContinuationPreflightSnapshotManifestSha256 =
      process.env.STAY_R147_CONTINUATION_PREFLIGHT_SNAPSHOT_MANIFEST_SHA256 || '',

    homeosStrandedR148InitRecoveryAuthorization =
      process.env.STAY_HOMEOS_STRANDED_R148_INIT_RECOVERY_AUTHORIZATION || '',

    homeosR148InitPostDurableFinalizationAuthorization =
      process.env.STAY_HOMEOS_R148_INIT_POST_DURABLE_FINALIZATION_AUTHORIZATION || '',

    r148InitRecoveryPreflightSnapshot =
      process.env.STAY_R148_INIT_RECOVERY_PREFLIGHT_SNAPSHOT || '',

    r148InitRecoveryPreflightSnapshotManifestSha256 =
      process.env.STAY_R148_INIT_RECOVERY_PREFLIGHT_SNAPSHOT_MANIFEST_SHA256 || '',

    interoNeutralBirthAuthorization =
      process.env.STAY_INTERO_NEUTRAL_BIRTH_AUTHORIZATION || '',

    metabInteroRouteAuthorization =
      process.env.STAY_METAB_INTERO_ROUTE_AUTHORIZATION || '',

    homeosInteroRouteAuthorization =
      process.env.STAY_HOMEOS_INTERO_ROUTE_AUTHORIZATION || '',

    interoShadowPromotionAuthorization =
      process.env.STAY_INTERO_SHADOW_PROMOTION_AUTHORIZATION || '',

    metabShadowPromotionAuthorization =
      process.env.STAY_METAB_SHADOW_PROMOTION_AUTHORIZATION || '',

    metabShadowRecoveryAuthorization =
      process.env.STAY_METAB_SHADOW_RECOVERY_AUTHORIZATION || '',

    metabCapacitySampler =
      defaultMetabCapacitySampler,

    r127PostRestartContinuityAuthorization =
      process.env.STAY_ALLOW_R127_POST_RESTART_CONTINUITY_RECOVERY || '',

    metabNeutralRecoveryMarkerFile =
      process.env.STAY_METAB_NEUTRAL_RECOVERY_MARKER ||
      '/run/stay-r124-metab-neutral-recovery.env',

    metabNeutralRecoveryMarkerSha256 =
      process.env.STAY_METAB_NEUTRAL_RECOVERY_MARKER_SHA256 || '',

    metabNeutralRecoveryTrustedUid = 0,

    metabNeutralRecoveryFenceReader =
      readR124MetabRecoveryFence,

    metabNeutralBirthCertificateFile =
      process.env.STAY_METAB_NEUTRAL_BIRTH_CERTIFICATE ||
      '/etc/stay/resident-promotions/resident-metab-neutral-birth.json',

    metabNeutralBirthPublicKeyPath =
      process.env.STAY_METAB_NEUTRAL_BIRTH_PUBLIC_KEY ||
      '/etc/stay/metab-neutral-birth-authority.pub',

    homeosNeutralBirthCertificateFile =
      process.env.STAY_HOMEOS_NEUTRAL_BIRTH_CERTIFICATE ||
      '/etc/stay/resident-promotions/resident-homeos-neutral-birth.json',

    homeosNeutralBirthPublicKeyPath =
      process.env.STAY_HOMEOS_NEUTRAL_BIRTH_PUBLIC_KEY ||
      '/etc/stay/p1-r0-expansion-birth-authority.pub',

    interoNeutralBirthCertificateFile =
      process.env.STAY_INTERO_NEUTRAL_BIRTH_CERTIFICATE ||
      '/etc/stay/resident-promotions/resident-intero-neutral-birth.json',

    interoNeutralBirthPublicKeyPath =
      process.env.STAY_INTERO_NEUTRAL_BIRTH_PUBLIC_KEY ||
      '/etc/stay/p1-r0-expansion-birth-authority.pub',

    runtimeFreezeDirectory =
      process.env.STAY_RUNTIME_FREEZE_DIR || undefined,

    residentPromotionPublicKeyPath =
      process.env.STAY_CORE_PROMOTION_PUBLIC_KEY ||
      '/etc/stay/release-authority.pub',

    residentPromotionCertificateDir =
      process.env.STAY_RESIDENT_PROMOTION_CERT_DIR ||
      '/etc/stay/resident-promotions'
  }) {
    this.dataDir = dataDir;
    this.clock = clock;
    this.logger = logger;
    this.stateStore = new StateStore(dataDir);
    this.fabric = new EventFabric({
      clock,
      sequenceAllocator: ({ minimum }) => this.stateStore.reserveEventSequence(minimum),
      durableAppender: envelope => this.stateStore.appendBiologicalEvent(envelope)
    });
    this.registry = new RuntimeRegistry({ fabric: this.fabric, stateStore: this.stateStore, logger });
    this.upgrades = new UpgradeManager({ registry: this.registry, stateStore: this.stateStore });
    this.computeFabric = new ComputeFabric();
    this.identity = null;
    this.allowIdentityBootstrap = allowIdentityBootstrap;
    this.startedAt = null;
    this.runtimeRevision = 0;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.snapshotIntervalMs = snapshotIntervalMs;
    this.snapshotRetention = snapshotRetention;
    this.heartbeatTimer = null;
    this.snapshotTimer = null;
    this.maintenanceErrors = {};
    this.statusCache = null;
    this.statusInFlight = null;
    this.statusCacheTtlMs = 1000;
    this.trustedTimePulseSequence = 0;
    this.trustedOrganismTimePulseSequence = 0;
    this.lastBiologicalRetention = null;
    this.trustedOrganismTime =
      trustedOrganismTime;

    this.enableTrustedOrganismTime =
      Boolean(enableTrustedOrganismTime);

    this.ownsTrustedOrganismTime =
      false;

    this.durableResidentsDisabled =
      Boolean(durableResidentsDisabled);

    if (
      this.trustedOrganismTime !== null &&
      typeof this.trustedOrganismTime
        ?.sample !== 'function'
    ) {
      throw Object.assign(
        new Error('Kernel trusted organism time provider is invalid'),
        { code: 'TRUSTED_TIME_PROVIDER_INVALID' }
      );
    }

    this.releaseRoot =
      path.resolve(releaseRoot);

    /*
     * Initial L0 production attachment remains
     * impossible until signed residency promotion
     * authorization is implemented.
     *
     * Crash recovery of an already durable resident
     * is a separate liveness operation.
     */
    this.allowLaboratoryResidentAttachment =
      Boolean(
        allowLaboratoryResidentAttachment
      );

    this.allowBoundedChronobiologyShadowAttachment =
      Boolean(allowBoundedChronobiologyShadowAttachment);

    this.allowBoundedSntssContinuityGenesisPromotion =
      Boolean(allowBoundedSntssContinuityGenesisPromotion);

    this.allowMetabNeutralBirth =
      Boolean(allowMetabNeutralBirth);

    this.allowMetabNeutralRecovery =
      Boolean(allowMetabNeutralRecovery);

    this.allowMetabNeutralRecoveryRevisionPreservation =
      Boolean(allowMetabNeutralRecoveryRevisionPreservation);

    this.allowMetabShadowPromotion =
      Boolean(allowMetabShadowPromotion);

    this.homeosNeutralBirthAuthorization =
      String(homeosNeutralBirthAuthorization);

    this.metabHomeosRouteAuthorization =
      String(metabHomeosRouteAuthorization);

    this.homeosShadowPromotionAuthorization =
      String(homeosShadowPromotionAuthorization);

    this.homeosStrandedR145RecoveryAuthorization =
      String(homeosStrandedR145RecoveryAuthorization);

    this.homeosStrandedR146RecoveryAuthorization =
      String(homeosStrandedR146RecoveryAuthorization);

    this.homeosStrandedR147RecoveryAuthorization =
      String(homeosStrandedR147RecoveryAuthorization);

    this.r147ContinuationPreflightSnapshot =
      String(r147ContinuationPreflightSnapshot);

    this.r147ContinuationPreflightSnapshotManifestSha256 =
      String(r147ContinuationPreflightSnapshotManifestSha256);

    this.homeosStrandedR148InitRecoveryAuthorization =
      String(homeosStrandedR148InitRecoveryAuthorization);

    this.homeosR148InitPostDurableFinalizationAuthorization =
      String(homeosR148InitPostDurableFinalizationAuthorization);

    this.r148InitRecoveryPreflightSnapshot =
      String(r148InitRecoveryPreflightSnapshot);

    this.r148InitRecoveryPreflightSnapshotManifestSha256 =
      String(r148InitRecoveryPreflightSnapshotManifestSha256);

    this.homeosStrandedR145RecoveryActive = false;
    this.homeosStrandedRecoveryRevision = null;
    this.metabQ48R146RecoveryActive = false;
    this.homeosStrandedR146PartialRecoveryActive = false;
    this.homeosFinalR146RecoveryActive = false;
    this.fetusEmptyInputR146RecoveryActive = false;
    this.homeosFinalR147RecoveryActive = false;
    this.fetusEmptyInputR147RecoveryActive = false;
    this.r147HomeosContinuationRecoveryActive = false;
    this.r147HomeosFrameBoundaryRecoveryActive = false;
    this.r147DeferredResidentRecovery = false;
    this.r148HomeosInitForwardRecoveryActive = false;
    this.r148HomeosInitPostDurableFinalizationActive = false;
    this.r148HomeosInitPostDurableFinalizationExpected = null;
    this.r148DeferredResidentRecovery = false;
    this.p1ExpansionFetusInstallRevisionPreservation = null;
    this.p1ExpansionFetusInstallPreserved = false;

    this.interoNeutralBirthAuthorization =
      String(interoNeutralBirthAuthorization);

    this.metabInteroRouteAuthorization =
      String(metabInteroRouteAuthorization);

    this.homeosInteroRouteAuthorization =
      String(homeosInteroRouteAuthorization);

    this.interoShadowPromotionAuthorization =
      String(interoShadowPromotionAuthorization);

    this.metabShadowPromotionAuthorization =
      String(metabShadowPromotionAuthorization);

    this.metabShadowRecoveryAuthorization =
      String(metabShadowRecoveryAuthorization);

    if (typeof metabCapacitySampler !== 'function') {
      throw Object.assign(
        new Error('METAB capacity sampler is invalid'),
        { code: 'P1_METAB_CAPACITY_SAMPLE' }
      );
    }

    this.metabCapacitySampler =
      metabCapacitySampler;

    this.lastMetabCapacitySource =
      null;

    this.metabCapacitySourcePromise =
      null;

    this.r127PostRestartContinuityAuthorization =
      String(r127PostRestartContinuityAuthorization);

    this.r127PostRestartContinuityRecovery =
      false;

    this.metabNeutralRecoveryRevisionPreserved =
      false;

    this.metabNeutralRecoveryCompletedAtPreservedRevision =
      false;

    this.metabNeutralRecoveryFetusInstallPreserved =
      false;

    this.metabNeutralRecoveryFence =
      null;

    this.metabNeutralRecoveryMarkerFile =
      String(metabNeutralRecoveryMarkerFile);

    this.metabNeutralRecoveryMarkerSha256 =
      String(metabNeutralRecoveryMarkerSha256);

    this.metabNeutralRecoveryTrustedUid =
      Number(metabNeutralRecoveryTrustedUid);

    if (typeof metabNeutralRecoveryFenceReader !== 'function') {
      throw Object.assign(
        new Error('METAB neutral recovery fence reader is invalid'),
        { code: 'P1_METAB_RECOVERY_FENCE_READER' }
      );
    }
    this.metabNeutralRecoveryFenceReader =
      metabNeutralRecoveryFenceReader;

    this.metabNeutralBirthCertificateFile =
      String(metabNeutralBirthCertificateFile);

    this.metabNeutralBirthPublicKeyPath =
      String(metabNeutralBirthPublicKeyPath);

    this.homeosNeutralBirthCertificateFile =
      String(homeosNeutralBirthCertificateFile);

    this.homeosNeutralBirthPublicKeyPath =
      String(homeosNeutralBirthPublicKeyPath);

    this.interoNeutralBirthCertificateFile =
      String(interoNeutralBirthCertificateFile);

    this.interoNeutralBirthPublicKeyPath =
      String(interoNeutralBirthPublicKeyPath);

    this.runtimeFreezeDirectory =
      runtimeFreezeDirectory == null
        ? undefined
        : path.resolve(String(runtimeFreezeDirectory));

    this.residentPromotionPublicKeyPath =
      String(
        residentPromotionPublicKeyPath
      );

    this.residentPromotionCertificateDir =
      String(
        residentPromotionCertificateDir
      );

    this.residentManager =
      null;

    this.lastResidentRecovery =
      Object.freeze([]);
  }

  ensureResidentManager() {
    if (this.durableResidentsDisabled) {
      throw Object.assign(
        new Error(
          'durable residents are disabled by the forward-compatible rollback boundary'
        ),
        { code: 'DURABLE_RESIDENTS_DISABLED' }
      );
    }

    if (this.residentManager) {
      return this.residentManager;
    }

    if (!this.identity) {
      throw Object.assign(
        new Error(
          'organism identity is unavailable for residency'
        ),
        {
          code:
            'RESIDENT_IDENTITY_MISSING'
        }
      );
    }

    /*
     * Surgery A installs the resident substrate but does not load it merely by
     * starting the Kernel.  Loading is deferred until durable resident state
     * already exists or an explicitly authorized attachment is requested.
     * This also gives the forward-compatible rollback entrypoint a substrate-
     * only path that never constructs a resident manager or BSF route owner.
     */
    const {
      ResidentManager,
      L0_SNTSS_CONTRACT,
      I4G_SNTSS_CONTRACT,
      CHRONOBIOLOGY_RESIDENT_CONTRACT
    } = require('./resident-manager');

    const {
      CHRONOBIOLOGY_R2_RESIDENT_CONTRACT,
      CHRONOBIOLOGY_R3_RESIDENT_CONTRACT,
      CHRONOBIOLOGY_R4_RESIDENT_CONTRACT,
      CHRONOBIOLOGY_R5_RESIDENT_CONTRACT
    } = require('./chronobiology-resident-contracts');

    const {
      METAB_NEUTRAL_RESIDENT_CONTRACT
    } = require('../p1-r0/metab-neutral-contract');

    const {
      METAB_SHADOW_RESIDENT_CONTRACT
    } = require('../p1-r0/metab-shadow-contract');

    const {
      METAB_HOMEOS_RESIDENT_CONTRACT
    } = require('../p1-r0/metab-homeos-contract');

    const {
      METAB_INTERO_RESIDENT_CONTRACT
    } = require('../p1-r0/metab-intero-contract');

    const {
      HOMEOS_NEUTRAL_RESIDENT_CONTRACT
    } = require('../p1-r0/homeos-neutral-contract');

    const {
      HOMEOS_SHADOW_RESIDENT_CONTRACT
    } = require('../p1-r0/homeos-shadow-contract');

    const {
      HOMEOS_INTERO_RESIDENT_CONTRACT
    } = require('../p1-r0/homeos-intero-contract');

    const {
      INTERO_NEUTRAL_RESIDENT_CONTRACT
    } = require('../p1-r0/intero-neutral-contract');

    const {
      INTERO_SHADOW_RESIDENT_CONTRACT
    } = require('../p1-r0/intero-shadow-contract');

    const durableSntss =
      this.stateStore
        .getResident(
          'resident:sntss'
        );

    const sntssContract =
      durableSntss?.version ===
        I4G_SNTSS_CONTRACT.version &&
      durableSntss?.stateSchema ===
        I4G_SNTSS_CONTRACT.stateSchema &&
      durableSntss?.moduleRelativePath ===
        'cores/sntss/i4g/index.js'
        ? I4G_SNTSS_CONTRACT
        : L0_SNTSS_CONTRACT;

    const durableChronobiology =
      this.stateStore
        .getResident(
          'resident:chronobiology'
        );

    const chronobiologyContract = [
      [CHRONOBIOLOGY_R5_RESIDENT_CONTRACT, 'cores/chronobiology/c3r5/index.js'],
      [CHRONOBIOLOGY_R4_RESIDENT_CONTRACT, 'cores/chronobiology/c3r4/index.js'],
      [CHRONOBIOLOGY_R3_RESIDENT_CONTRACT, 'cores/chronobiology/c3r3/index.js'],
      [CHRONOBIOLOGY_R2_RESIDENT_CONTRACT, 'cores/chronobiology/c3r2/index.js']
    ].find(([contract, moduleRelativePath]) =>
      durableChronobiology?.version === contract.version &&
      durableChronobiology?.stateSchema === contract.stateSchema &&
      durableChronobiology?.moduleRelativePath === moduleRelativePath
    )?.[0] || CHRONOBIOLOGY_RESIDENT_CONTRACT;

    const durableMetab =
      this.stateStore.getResident('resident:metab');

    const metabContract =
      durableMetab?.version === METAB_INTERO_RESIDENT_CONTRACT.version &&
      durableMetab?.stateSchema === METAB_INTERO_RESIDENT_CONTRACT.stateSchema &&
      durableMetab?.moduleRelativePath === 'cores/p1-r0/metab-intero/index.js'
        ? METAB_INTERO_RESIDENT_CONTRACT
        : durableMetab?.version ===
        METAB_HOMEOS_RESIDENT_CONTRACT.version &&
      durableMetab?.stateSchema ===
        METAB_HOMEOS_RESIDENT_CONTRACT.stateSchema &&
      durableMetab?.moduleRelativePath ===
        'cores/p1-r0/metab-homeos/index.js'
        ? METAB_HOMEOS_RESIDENT_CONTRACT
        : durableMetab?.version ===
        METAB_SHADOW_RESIDENT_CONTRACT.version &&
      durableMetab?.stateSchema ===
        METAB_SHADOW_RESIDENT_CONTRACT.stateSchema &&
      durableMetab?.moduleRelativePath ===
        'cores/p1-r0/metab-shadow/index.js'
        ? METAB_SHADOW_RESIDENT_CONTRACT
        : METAB_NEUTRAL_RESIDENT_CONTRACT;

    const durableHomeos =
      this.stateStore.getResident('resident:homeos');

    const homeosContract =
      durableHomeos?.version === HOMEOS_INTERO_RESIDENT_CONTRACT.version &&
      durableHomeos?.stateSchema === HOMEOS_INTERO_RESIDENT_CONTRACT.stateSchema &&
      durableHomeos?.moduleRelativePath === 'cores/p1-r0/homeos-intero/index.js'
        ? HOMEOS_INTERO_RESIDENT_CONTRACT
        : durableHomeos?.version === HOMEOS_SHADOW_RESIDENT_CONTRACT.version &&
      durableHomeos?.stateSchema === HOMEOS_SHADOW_RESIDENT_CONTRACT.stateSchema &&
      durableHomeos?.moduleRelativePath === 'cores/p1-r0/homeos-shadow/index.js'
        ? HOMEOS_SHADOW_RESIDENT_CONTRACT
        : HOMEOS_NEUTRAL_RESIDENT_CONTRACT;

    const durableIntero = this.stateStore.getResident('resident:intero');

    const interoContract =
      durableIntero?.version === INTERO_SHADOW_RESIDENT_CONTRACT.version &&
      durableIntero?.stateSchema === INTERO_SHADOW_RESIDENT_CONTRACT.stateSchema &&
      durableIntero?.moduleRelativePath === 'cores/p1-r0/intero-shadow/index.js'
        ? INTERO_SHADOW_RESIDENT_CONTRACT
        : INTERO_NEUTRAL_RESIDENT_CONTRACT;

    this.residentManager =
      new ResidentManager({
        releaseRoot:
          this.releaseRoot,

        stateStore:
          this.stateStore,

        fabric:
          this.fabric,

        identity:
          this.identity,

        logger:
          this.logger,

        clock:
          this.clock,

        contracts:
          [
            sntssContract,
            chronobiologyContract,
            metabContract,
            homeosContract,
            interoContract
          ]
      });

    return this.residentManager;
  }

  async start() {
    if (process.env.STAY_REQUIRE_CGROUPS === '1' && !process.execArgv.includes('--disable-sigusr1')) {
      throw Object.assign(new Error('production Kernel must start Node with --disable-sigusr1'), { code: 'KERNEL_INSPECTOR_SIGNAL_UNSAFE' });
    }
    await this.stateStore.init();
    const storedSequence = await this.stateStore.readLife('event-sequence', { sequence: 0 });
    const authorityHighWater = this.stateStore.listAuthority().reduce((maximum, entry) => Math.max(maximum, Number(entry.barrierSequence) || 0), 0);
    this.fabric.sequence = Math.max(Number(storedSequence?.sequence) || 0, authorityHighWater);
    const existing = await this.stateStore.readLife('identity', null);
    if (!existing && !this.allowIdentityBootstrap) {
      throw Object.assign(new Error('organism identity is missing; refusing to manufacture a replacement identity'), { code: 'IDENTITY_MISSING' });
    }
    this.identity = existing || {
      organismId: 'stay-' + crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      lineage: 'STAY/Genesis'
    };
    if (!existing) await this.stateStore.writeLife('identity', this.identity);
    if (!this.identity.organismId || !this.identity.createdAt || this.identity.lineage !== 'STAY/Genesis') {
      throw Object.assign(new Error('organism identity is incomplete or inconsistent'), { code: 'IDENTITY_INVALID' });
    }

    if (
      this.enableTrustedOrganismTime &&
      this.trustedOrganismTime === null
    ) {
      const {
        TrustedOrganismTime,
        BOOTSTRAP_PROTOCOL
      } = require('./trusted-organism-time');

      this.trustedOrganismTime =
        new TrustedOrganismTime({
          stateStore:
            this.stateStore,

          organismId:
            this.identity.organismId
        });

      this.ownsTrustedOrganismTime =
        true;

      await this.trustedOrganismTime.start({
        bootstrap: {
          protocol:
            BOOTSTRAP_PROTOCOL,

          organismId:
            this.identity.organismId,

          trustedTimeUs:
            0,

          proofId:
            'p1-r98f-chronobiology-shadow-bootstrap-v1'
        }
      });
    }

    const revisionState = await this.stateStore.readLife('runtime-revision', { revision: 0 });
    this.runtimeRevision = Number(revisionState && revisionState.revision) || 0;

    this.startedAt = new Date().toISOString();
    const preservedRecoveryRevision =
      await this.preserveExactR127MetabRecoveryRevision() ||
      this.preserveExactR148HomeosInitPostDurableFinalizationRevision() ||
      this.preserveExactR148HomeosInitForwardRecoveryRevision() ||
      this.preserveExactR147HomeosFrameBoundaryRevision() ||
      this.preserveExactR147HomeosContinuationRevision() ||
      this.preserveExactR147HomeosRecoveryRevision() ||
      this.preserveExactR145HomeosProgressRevision() ||
      this.preserveExactR150InteroProgressRevision();
    await this.verifyExactR148InitRecoveryPreflightSnapshot();
    await this.verifyExactR147ContinuationPreflightSnapshot();
    if (!preservedRecoveryRevision) {
      await this.bumpRuntimeRevision('kernel.start', { version: KERNEL_VERSION, pid: process.pid });
    }

    await this.restoreTrustedPulseSequencesFromDurableState();
    if (this.fetusEmptyInputR146RecoveryActive || this.fetusEmptyInputR147RecoveryActive) {
      await this.repairExactR146FetusEmptyInputContinuity();
    }
    if (this.r127PostRestartContinuityRecovery) {
      await this.repairExactR127PostRestartContinuity();
    }

    /*
     * Durable residents are reconstructed only after:
     *
     *   - StateStore is open;
     *   - organism identity is verified;
     *   - a new Kernel runtime revision exists.
     *
     * Resident-specific recovery failures are
     * contained and MUST NOT fail Kernel start.
     */
    const durableResidents =
      this.stateStore.listResidents();

    if (
      this.durableResidentsDisabled &&
      durableResidents.length > 0
    ) {
      throw Object.assign(
        new Error(
          'forward-compatible rollback refuses to ignore existing durable resident state'
        ),
        { code: 'FORWARD_ROLLBACK_RESIDENT_STATE_PRESENT' }
      );
    }

    if (
      !this.durableResidentsDisabled &&
      durableResidents.length > 0 &&
      !this.r147DeferredResidentRecovery &&
      !this.r148DeferredResidentRecovery
    ) {
      this.ensureResidentManager();

      const ordinaryRecovery =
        await this.recoverDurableResidents();

      const coldRecovery =
        await this.recoverColdFailedResidents();

      if (this.r127PostRestartContinuityRecovery) {
        await this.completeExactR127PostRestartResidentRecovery({
          ordinaryRecovery,
          coldRecovery
        });
        await this.anchorExactR127PostRestartTrustedTime();
      }

      this.lastResidentRecovery =
        Object.freeze([
          ...ordinaryRecovery,
          ...coldRecovery
        ]);
    }

    await this.stateStore.appendJournal({
      type: 'kernel.start',
      at: this.startedAt,
      version: KERNEL_VERSION,
      runtimeRevision: this.runtimeRevision,
      organismId: this.identity.organismId,
      pid: process.pid
    });

    await this.writeHeartbeat();
    if (this.r148HomeosInitForwardRecoveryActive) {
      await this.stateStore.appendJournal({
        type: 'state.snapshot-reused',
        at: new Date().toISOString(),
        reason: 'r148-homeos-init-forward-preflight-v1',
        snapshot: this.r148InitRecoveryPreflightSnapshotEvidence.name,
        manifestSha256:
          this.r148InitRecoveryPreflightSnapshotEvidence.manifestSha256
      });
    } else if (this.r147DeferredResidentRecovery) {
      await this.stateStore.appendJournal({
        type: 'state.snapshot-reused',
        at: new Date().toISOString(),
        reason: 'r147-homeos-continuation-preflight-v1',
        snapshot: this.r147ContinuationPreflightSnapshotEvidence.name,
        manifestSha256:
          this.r147ContinuationPreflightSnapshotEvidence.manifestSha256
      });
    } else {
      await this.createSnapshot('kernel-start');
    }
    if (!this.r147DeferredResidentRecovery && !this.r148DeferredResidentRecovery) {
      this.startMaintenance();
    }
    return this;
  }

  async verifyExactR148InitRecoveryPreflightSnapshot() {
    const snapshotPath = this.r148InitRecoveryPreflightSnapshot;
    const manifestSha256 = this.r148InitRecoveryPreflightSnapshotManifestSha256;
    if (!this.r148HomeosInitForwardRecoveryActive) {
      if (snapshotPath || manifestSha256) {
        throw Object.assign(
          new Error('R148 init-forward snapshot is outside its exact recovery boundary'),
          { code: 'P1_R148_INIT_SNAPSHOT_BOUNDARY' }
        );
      }
      return null;
    }
    if (!path.isAbsolute(snapshotPath) || !/^sha256:[0-9a-f]{64}$/.test(manifestSha256)) {
      throw Object.assign(
        new Error('R148 init-forward snapshot identity is invalid'),
        { code: 'P1_R148_INIT_SNAPSHOT_IDENTITY' }
      );
    }

    let snapshotsRoot;
    let resolvedSnapshot;
    let snapshotStat;
    let manifestStat;
    let manifestBody;
    try {
      snapshotsRoot = fs.realpathSync(path.join(this.stateStore.rootDir, 'snapshots'));
      resolvedSnapshot = fs.realpathSync(snapshotPath);
      snapshotStat = fs.lstatSync(snapshotPath);
      const manifestPath = path.join(resolvedSnapshot, 'SNAPSHOT_MANIFEST.json');
      manifestStat = fs.lstatSync(manifestPath);
      manifestBody = fs.readFileSync(manifestPath);
    } catch (error) {
      throw Object.assign(
        new Error(`R148 init-forward snapshot is unavailable: ${error.message}`),
        { code: 'P1_R148_INIT_SNAPSHOT_PATH' }
      );
    }
    if (
      path.dirname(resolvedSnapshot) !== snapshotsRoot ||
      resolvedSnapshot !== path.resolve(snapshotPath) ||
      !snapshotStat.isDirectory() || snapshotStat.isSymbolicLink() ||
      !manifestStat.isFile() || manifestStat.isSymbolicLink() ||
      (process.platform !== 'win32' && (snapshotStat.mode & 0o022) !== 0) ||
      (process.platform !== 'win32' && (manifestStat.mode & 0o022) !== 0) ||
      sha256Bytes(manifestBody) !== manifestSha256
    ) {
      throw Object.assign(
        new Error('R148 init-forward snapshot trust fence failed'),
        { code: 'P1_R148_INIT_SNAPSHOT_TRUST' }
      );
    }

    const manifest = await this.stateStore.verifySnapshot(resolvedSnapshot);
    if (
      manifest?.format !== 'stay-runtime-snapshot-v2' ||
      manifest?.reason !== 'r148-homeos-init-forward-preflight-v1' ||
      stableStringify(manifest.authority) !== stableStringify(this.stateStore.listAuthority()) ||
      stableStringify(manifest.residents) !== stableStringify(this.stateStore.listResidents())
    ) {
      throw Object.assign(
        new Error('R148 init-forward snapshot durable cohort changed'),
        { code: 'P1_R148_INIT_SNAPSHOT_COHORT' }
      );
    }
    this.r148InitRecoveryPreflightSnapshotEvidence = Object.freeze({
      name: path.basename(resolvedSnapshot),
      path: resolvedSnapshot,
      manifestSha256
    });
    return this.r148InitRecoveryPreflightSnapshotEvidence;
  }

  async verifyExactR147ContinuationPreflightSnapshot() {
    const snapshotPath = this.r147ContinuationPreflightSnapshot;
    const manifestSha256 =
      this.r147ContinuationPreflightSnapshotManifestSha256;
    if (!this.r147DeferredResidentRecovery) {
      if (snapshotPath || manifestSha256) {
        throw Object.assign(
          new Error('R147 continuation preflight snapshot is outside its exact recovery boundary'),
          { code: 'P1_R147_CONTINUATION_SNAPSHOT_BOUNDARY' }
        );
      }
      return null;
    }
    if (
      !path.isAbsolute(snapshotPath) ||
      !/^sha256:[0-9a-f]{64}$/.test(manifestSha256)
    ) {
      throw Object.assign(
        new Error('R147 continuation preflight snapshot identity is invalid'),
        { code: 'P1_R147_CONTINUATION_SNAPSHOT_IDENTITY' }
      );
    }

    let snapshotsRoot;
    let resolvedSnapshot;
    let snapshotStat;
    let manifestStat;
    let manifestBody;
    try {
      snapshotsRoot = fs.realpathSync(path.join(this.stateStore.rootDir, 'snapshots'));
      resolvedSnapshot = fs.realpathSync(snapshotPath);
      snapshotStat = fs.lstatSync(snapshotPath);
      const manifestPath = path.join(resolvedSnapshot, 'SNAPSHOT_MANIFEST.json');
      manifestStat = fs.lstatSync(manifestPath);
      manifestBody = fs.readFileSync(manifestPath);
    } catch (error) {
      throw Object.assign(
        new Error(`R147 continuation preflight snapshot is unavailable: ${error.message}`),
        { code: 'P1_R147_CONTINUATION_SNAPSHOT_PATH' }
      );
    }
    if (
      path.dirname(resolvedSnapshot) !== snapshotsRoot ||
      resolvedSnapshot !== path.resolve(snapshotPath) ||
      !snapshotStat.isDirectory() || snapshotStat.isSymbolicLink() ||
      !manifestStat.isFile() || manifestStat.isSymbolicLink() ||
      (process.platform !== 'win32' && (snapshotStat.mode & 0o022) !== 0) ||
      (process.platform !== 'win32' && (manifestStat.mode & 0o022) !== 0) ||
      sha256Bytes(manifestBody) !== manifestSha256
    ) {
      throw Object.assign(
        new Error('R147 continuation preflight snapshot trust fence failed'),
        { code: 'P1_R147_CONTINUATION_SNAPSHOT_TRUST' }
      );
    }

    const manifest = await this.stateStore.verifySnapshot(resolvedSnapshot);
    if (
      manifest?.format !== 'stay-runtime-snapshot-v2' ||
      manifest?.reason !== 'r147-homeos-continuation-preflight-v1' ||
      stableStringify(manifest.authority) !==
        stableStringify(this.stateStore.listAuthority()) ||
      stableStringify(manifest.residents) !==
        stableStringify(this.stateStore.listResidents())
    ) {
      throw Object.assign(
        new Error('R147 continuation preflight snapshot durable cohort changed'),
        { code: 'P1_R147_CONTINUATION_SNAPSHOT_COHORT' }
      );
    }
    this.r147ContinuationPreflightSnapshotEvidence = Object.freeze({
      name: path.basename(resolvedSnapshot),
      path: resolvedSnapshot,
      manifestSha256
    });
    return this.r147ContinuationPreflightSnapshotEvidence;
  }

  async bumpRuntimeRevision(reason, details = {}) {
    this.runtimeRevision += 1;
    const record = {
      revision: this.runtimeRevision,
      reason,
      at: new Date().toISOString(),
      kernelVersion: KERNEL_VERSION,
      ...details
    };
    await this.stateStore.writeLife('runtime-revision', record);
    await this.stateStore.appendJournal({ type: 'runtime.revision', ...record });
    return this.runtimeRevision;
  }

  async preserveExactR127MetabRecoveryRevision() {
    if (!this.allowMetabNeutralRecoveryRevisionPreservation) {
      return false;
    }
    if (
      !this.allowMetabNeutralRecovery ||
      this.runtimeRevision !== 127
    ) {
      throw Object.assign(
        new Error('METAB revision preservation is fenced to the exact stranded R127 recovery'),
        { code: 'P1_METAB_RECOVERY_REVISION_PRESERVATION' }
      );
    }

    const recoveryFence =
      this.metabNeutralRecoveryFenceReader({
        markerFile: this.metabNeutralRecoveryMarkerFile,
        expectedMarkerSha256: this.metabNeutralRecoveryMarkerSha256,
        trustedUid: this.metabNeutralRecoveryTrustedUid
      });
    if (
      !recoveryFence ||
      recoveryFence.markerSha256 !== R124_METAB_RECOVERY.markerSha256 ||
      recoveryFence.failureEvidence !== R124_METAB_RECOVERY.failureEvidence
    ) {
      throw Object.assign(
        new Error('METAB revision preservation recovery fence is invalid'),
        { code: 'P1_METAB_RECOVERY_MARKER' }
      );
    }

    const countRows = table => {
      const exists = this.stateStore.db.prepare(`
        SELECT 1 AS present FROM sqlite_master
        WHERE type='table' AND name=?
      `).get(table);
      return exists
        ? Number(this.stateStore.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)
        : 0;
    };
    const metabResident =
      this.stateStore.getResident('resident:metab');
    const metabConsumer =
      this.stateStore.getBiologicalConsumer('resident:metab');
    const checkpoint =
      await this.stateStore.readResidentCheckpoint('resident:metab');
    const p1Authority =
      this.stateStore.listAuthority().filter(entry =>
        ['METAB', 'HOMEOS', 'INTERO'].includes(entry.coreId)
      );
    const emptyBirthCohort =
      !metabResident &&
      !metabConsumer &&
      checkpoint === null &&
      p1Authority.length === 0 &&
      countRows('p1_founders') === 0 &&
      countRows('p1_birth_dossiers') === 0 &&
      countRows('p1_chip_current') === 0 &&
      countRows('p1_chip_history') === 0;
    const exactPostRestartCohort =
      this.r127PostRestartContinuityAuthorization ===
        R127_POST_RESTART_CONTINUITY.authorization &&
      metabResident?.residencyId === R127_POST_RESTART_CONTINUITY.metab.residencyId &&
      metabResident?.instanceId === R127_POST_RESTART_CONTINUITY.metab.instanceId &&
      metabResident?.version === R127_POST_RESTART_CONTINUITY.metab.version &&
      metabResident?.status === 'RUNNING' &&
      metabResident?.checkpointGeneration === 1 &&
      metabResident?.checkpointHash === R127_POST_RESTART_CONTINUITY.metab.checkpointHash &&
      checkpoint?.generation === 1 &&
      checkpoint?.blobHash === R127_POST_RESTART_CONTINUITY.metab.checkpointHash &&
      metabConsumer?.coreId === 'METAB' &&
      metabConsumer?.required === false &&
      metabConsumer?.authorityEpoch === 0 &&
      stableStringify(metabConsumer?.topics) === stableStringify(['runtime.organism.binding']) &&
      p1Authority.length === 0 &&
      countRows('p1_founders') === 1 &&
      countRows('p1_birth_dossiers') === 1 &&
      countRows('p1_chip_current') === 1 &&
      countRows('p1_chip_history') === 1;
    if (!emptyBirthCohort && !exactPostRestartCohort) {
      throw Object.assign(
        new Error('METAB revision preservation requires an exact authorized R127 cohort'),
        { code: 'P1_METAB_RECOVERY_NOT_EMPTY' }
      );
    }

    this.metabNeutralRecoveryFence = recoveryFence;
    this.metabNeutralRecoveryRevisionPreserved = true;
    this.r127PostRestartContinuityRecovery = exactPostRestartCohort;
    await this.stateStore.appendJournal({
      type: 'runtime.revision-preserved',
      at: this.startedAt,
      reason: exactPostRestartCohort
        ? 'runtime.exact-r127-post-restart-continuity-recovery'
        : 'resident.metab-neutral-exact-r127-forward-recovery',
      runtimeRevision: this.runtimeRevision,
      version: KERNEL_VERSION,
      pid: process.pid,
      recoveryMarkerSha256: recoveryFence.markerSha256,
      authorityOwned: false
    });
    return true;
  }


  exactR146FetusContinuityCohort() {
    const expected = R146_METAB_Q48_HOMEOS_RECOVERY.fetus;
    const consumer = this.stateStore.getBiologicalConsumer(expected.consumerId);
    const authority = this.stateStore.db.prepare(
      'SELECT * FROM authority WHERE core_id=?'
    ).get(expected.coreId);
    const checkpoint = this.stateStore.db.prepare(`
      SELECT * FROM checkpoints WHERE core_id=? ORDER BY generation DESC LIMIT 1
    `).get(expected.coreId);
    const demotion = this.stateStore.db.prepare(`
      SELECT id,detail_json FROM recovery_records
      WHERE type='biological.consumer-demoted' AND core_id=?
      ORDER BY id DESC LIMIT 1
    `).get(expected.coreId);
    const resolution = this.stateStore.db.prepare(`
      SELECT id,detail_json FROM recovery_records
      WHERE type='biological.consumer-resynchronized' AND core_id=?
      ORDER BY id DESC LIMIT 1
    `).get(expected.coreId);
    let demotionDetail = null;
    let resolutionDetail = null;
    try { demotionDetail = JSON.parse(demotion?.detail_json || 'null'); } catch {}
    try { resolutionDetail = JSON.parse(resolution?.detail_json || 'null'); } catch {}
    const pending = Number(this.stateStore.db.prepare(`
      SELECT COUNT(*) count FROM biological_deliveries
      WHERE consumer_id=? AND status='PENDING'
    `).get(expected.consumerId)?.count || 0);
    const pendingOutbox = Number(this.stateStore.db.prepare(`
      SELECT COUNT(*) count FROM biological_outbox_intents
      WHERE producer_core_id=? AND status='PENDING'
    `).get(expected.coreId)?.count || 0);
    const common =
      consumer?.coreId === expected.coreId && consumer?.required === false &&
      consumer?.active === false && consumer?.authorityEpoch === expected.authorityEpoch &&
      stableStringify(consumer?.topics) === '[]' && consumer?.topicsHash === expected.topicsHash &&
      authority?.instance_id === expected.instanceId && authority?.version === expected.version &&
      Number(authority?.epoch) === expected.authorityEpoch &&
      authority?.checkpoint_hash === expected.checkpointHash &&
      checkpoint?.instance_id === expected.instanceId && checkpoint?.version === expected.version &&
      Number(checkpoint?.authority_epoch) === expected.authorityEpoch &&
      Number(checkpoint?.generation) === expected.checkpointGeneration &&
      checkpoint?.blob_hash === expected.checkpointHash &&
      Number(checkpoint?.byte_length) === expected.checkpointBytes &&
      Number(demotion?.id) === expected.demotionId &&
      demotionDetail?.consumerId === expected.consumerId &&
      demotionDetail?.cursor === expected.consumerCursor &&
      demotionDetail?.pending === expected.pendingAtDemotion &&
      demotionDetail?.maximumDebt === expected.maximumDebt &&
      demotionDetail?.resynchronizationRequired === true &&
      pending === 0 && pendingOutbox === 0;
    const unresolved = common &&
      consumer?.cursor === expected.consumerCursor &&
      consumer?.checkpointHash === expected.priorConsumerCheckpointHash &&
      Number(resolution?.id) === expected.priorResolutionId &&
      resolutionDetail?.demotionId === expected.priorDemotionId;
    const resolved = common && Number(resolution?.id) > expected.demotionId &&
      resolutionDetail?.cohort === 'r146-fetus-empty-input-continuity-v1' &&
      resolutionDetail?.demotionId === expected.demotionId &&
      resolutionDetail?.consumerId === expected.consumerId &&
      resolutionDetail?.fromCursor === expected.consumerCursor &&
      Number.isSafeInteger(resolutionDetail?.toCursor) &&
      resolutionDetail.toCursor >= expected.consumerCursor &&
      consumer?.cursor === resolutionDetail.toCursor &&
      consumer?.checkpointHash === expected.checkpointHash &&
      resolutionDetail?.inputs?.length === 0 &&
      resolutionDetail?.checkpointHash === expected.checkpointHash &&
      resolutionDetail?.checkpointGeneration === expected.checkpointGeneration &&
      resolutionDetail?.checkpointBytesChanged === false &&
      resolutionDetail?.biologicalStateChanged === false &&
      resolutionDetail?.physiologyApplied === 0 && resolutionDetail?.abandonedCount === 0 &&
      resolutionDetail?.inventedBiologicalTime === false &&
      resolutionDetail?.authorityChanged === false &&
      [146, 147].includes(resolutionDetail?.runtimeRevision);
    return Object.freeze({ valid: unresolved || resolved, unresolved, resolved,
      consumer, authority, checkpoint, demotion, demotionDetail, resolution, resolutionDetail });
  }


  preserveExactR148HomeosInitForwardRecoveryRevision() {
    const expected = R148_HOMEOS_INIT_FORWARD_RECOVERY;
    if (this.homeosStrandedR148InitRecoveryAuthorization !== expected.authorization) {
      return false;
    }
    const reject = () => {
      throw Object.assign(
        new Error('authorized R148 init-forward recovery cohort changed'),
        { code: 'P1_R148_INIT_RECOVERY_IDENTITY' }
      );
    };
    if (
      this.runtimeRevision !== expected.runtimeRevision ||
      this.homeosStrandedR147RecoveryAuthorization ||
      this.homeosNeutralBirthAuthorization || this.metabHomeosRouteAuthorization ||
      this.homeosShadowPromotionAuthorization || this.interoNeutralBirthAuthorization ||
      this.metabInteroRouteAuthorization || this.homeosInteroRouteAuthorization ||
      this.interoShadowPromotionAuthorization ||
      this.stateStore.getResident('resident:intero') ||
      this.stateStore.listResidents().length !== Object.keys(expected.residents).length
    ) return reject();

    const exactResident = fence => {
      const resident = this.stateStore.getResident(fence.residencyId);
      const consumer = this.stateStore.getBiologicalConsumer(fence.residencyId);
      const checkpoint = this.stateStore.db.prepare(`
        SELECT checkpoint_id,instance_id,version,state_schema,generation,blob_hash,
          byte_length,input_cursor FROM resident_checkpoints
        WHERE residency_id=? AND generation=?
      `).get(fence.residencyId, fence.checkpointGeneration);
      return resident?.residencyId === fence.residencyId && resident?.coreId === fence.coreId &&
        resident?.instanceId === fence.instanceId && resident?.version === fence.version &&
        resident?.stateSchema === fence.stateSchema && resident?.status === fence.status &&
        resident?.checkpointGeneration === fence.checkpointGeneration &&
        resident?.checkpointHash === fence.checkpointHash &&
        resident?.moduleRelativePath === fence.moduleRelativePath &&
        resident?.moduleHash === fence.moduleHash && resident?.manifestHash === fence.manifestHash &&
        resident?.packagePolicyHash === fence.packagePolicyHash &&
        consumer?.coreId === fence.coreId && consumer?.required === false &&
        consumer?.active === true && consumer?.authorityEpoch === 0 &&
        consumer?.cursor === fence.consumerCursor && consumer?.checkpointHash === fence.checkpointHash &&
        consumer?.topicsHash === fence.topicsHash &&
        checkpoint?.checkpoint_id === fence.checkpointId &&
        checkpoint?.instance_id === fence.instanceId && checkpoint?.version === fence.version &&
        Number(checkpoint?.state_schema) === fence.stateSchema &&
        Number(checkpoint?.generation) === fence.checkpointGeneration &&
        checkpoint?.blob_hash === fence.checkpointHash &&
        Number(checkpoint?.byte_length) === fence.checkpointBytes &&
        Number(checkpoint?.input_cursor) === fence.inputCursor;
    };
    if (!Object.values(expected.residents).every(exactResident)) return reject();

    const count = (sql, ...args) =>
      Number(this.stateStore.db.prepare(sql).get(...args)?.count || 0);
    const highWater = Number(this.stateStore.db.prepare(
      'SELECT COALESCE(MAX(sequence),0) value FROM biological_events'
    ).get()?.value || 0);
    const fetusPending = this.stateStore.db.prepare(`
      SELECT COUNT(*) count,MIN(sequence) minimum,MAX(sequence) maximum
      FROM biological_deliveries WHERE consumer_id=? AND status='PENDING'
    `).get(expected.fetus.consumerId);
    if (
      highWater !== expected.highWater ||
      count("SELECT COUNT(*) count FROM biological_deliveries WHERE status='PENDING'") !==
        expected.pendingFetusDeliveries ||
      count("SELECT COUNT(*) count FROM biological_deliveries WHERE status='PENDING' AND consumer_id!=?",
        expected.fetus.consumerId) !== 0 ||
      Number(fetusPending?.count) !== expected.pendingFetusDeliveries ||
      Number(fetusPending?.minimum) !== expected.pendingFetusFirstSequence ||
      Number(fetusPending?.maximum) !== expected.pendingFetusLastSequence ||
      count("SELECT COUNT(*) count FROM biological_deliveries WHERE status='FAILED'") !== 0 ||
      count("SELECT COUNT(*) count FROM biological_deliveries WHERE status='ABANDONED'") !== 0 ||
      count("SELECT COUNT(*) count FROM biological_outbox_intents WHERE status='PENDING'") !==
        expected.pendingOutbox.length ||
      count("SELECT COUNT(*) count FROM biological_outbox_intents WHERE status!='PUBLISHED' AND producer_core_id!='METAB'") !== 0 ||
      count("SELECT COUNT(*) count FROM biological_outbox_intents WHERE producer_core_id IN ('sntss','SNTSS','HOMEOS','INTERO')") !== 0
    ) return reject();

    const outbox = this.stateStore.db.prepare(`
      SELECT * FROM biological_outbox_intents WHERE status='PENDING'
      ORDER BY stream_sequence,producer_event_id
    `).all();
    if (outbox.length !== expected.pendingOutbox.length || !outbox.every((row, index) => {
      const fence = expected.pendingOutbox[index];
      try { this.stateStore.biologicalOutboxIntentFromRow(row); } catch { return false; }
      return row.producer_event_id === fence.producerEventId &&
        row.intent_sha256 === fence.intentHash && row.producer_core_id === 'METAB' &&
        Number(row.stream_sequence) === fence.streamSequence &&
        Number(row.cause_sequence) === fence.causeSequence && row.topic === fence.topic &&
        row.checkpoint_hash === fence.checkpointHash &&
        Number(row.checkpoint_generation) === fence.checkpointGeneration;
    })) return reject();

    const exactMetadataHash = (key, hash) => {
      const row = this.stateStore.db.prepare(
        'SELECT json,sha256 FROM metadata WHERE key=?'
      ).get(key);
      return row?.sha256 === hash &&
        crypto.createHash('sha256').update(row?.json || '').digest('hex') === hash;
    };
    if (!exactMetadataHash('life:runtime-revision', expected.runtimeRevisionMetadataHash) ||
        !exactMetadataHash('life:p1-r0-metab-capacity-source', expected.capacitySourceMetadataHash)) {
      return reject();
    }

    const latest = this.stateStore.db.prepare(
      'SELECT id,type,core_id,detail_json FROM recovery_records ORDER BY id DESC LIMIT 1'
    ).get();
    let retry = null;
    try { retry = JSON.parse(latest?.detail_json || 'null'); } catch {}
    if (Number(latest?.id) !== expected.latestRecoveryRecordId ||
        latest?.type !== 'resident.delivery-retry' || latest?.core_id !== 'sntss' ||
        retry?.residencyId !== 'resident:sntss' || retry?.sequence !== 4575528 ||
        retry?.attempt !== 1 || retry?.code !== 'CORE_WORKER_TIMEOUT' ||
        retry?.operation !== 'event' || retry?.failedGeneration !== 1 ||
        retry?.recoveredGeneration !== 2) return reject();

    const fetus = expected.fetus;
    const fetusConsumer = this.stateStore.getBiologicalConsumer(fetus.consumerId);
    const fetusAuthority = this.stateStore.db.prepare(
      'SELECT * FROM authority WHERE core_id=?'
    ).get(fetus.coreId);
    const fetusCheckpoint = this.stateStore.db.prepare(`
      SELECT * FROM checkpoints WHERE core_id=? ORDER BY generation DESC LIMIT 1
    `).get(fetus.coreId);
    const p1Authority = this.stateStore.listAuthority().filter(entry =>
      ['METAB', 'HOMEOS', 'INTERO', 'sntss', 'chronobiology'].includes(entry.coreId)
    );
    if (p1Authority.length !== 0 ||
        fetusConsumer?.coreId !== fetus.coreId || fetusConsumer?.required !== true ||
        fetusConsumer?.active !== true || fetusConsumer?.cursor !== fetus.consumerCursor ||
        fetusConsumer?.authorityEpoch !== fetus.authorityEpoch ||
        fetusConsumer?.checkpointHash !== fetus.consumerCheckpointHash ||
        fetusConsumer?.topicsHash !== fetus.topicsHash ||
        fetusAuthority?.instance_id !== fetus.instanceId || fetusAuthority?.version !== fetus.version ||
        Number(fetusAuthority?.epoch) !== fetus.authorityEpoch ||
        fetusAuthority?.checkpoint_hash !== fetus.checkpointHash ||
        fetusCheckpoint?.instance_id !== fetus.instanceId || fetusCheckpoint?.version !== fetus.version ||
        Number(fetusCheckpoint?.authority_epoch) !== fetus.authorityEpoch ||
        Number(fetusCheckpoint?.generation) !== fetus.checkpointGeneration ||
        fetusCheckpoint?.blob_hash !== fetus.checkpointHash ||
        Number(fetusCheckpoint?.byte_length) !== fetus.checkpointBytes) return reject();

    this.r148HomeosInitForwardRecoveryActive = true;
    this.r148DeferredResidentRecovery = true;
    this.p1ExpansionFetusInstallRevisionPreservation = this.runtimeRevision;
    return true;
  }

  preserveExactR148HomeosInitPostDurableFinalizationRevision() {
    const expected = [
      R148_HOMEOS_INIT_POST_DURABLE_FINALIZATION,
      R148_HOMEOS_POST_FINALIZATION_RESTART,
      R148_HOMEOS_CAPACITY_SOURCE_FINALIZATION
    ].find(fence =>
      this.homeosR148InitPostDurableFinalizationAuthorization === fence.authorization);
    if (!expected) return false;
    const reject = () => {
      throw Object.assign(new Error('authorized R148 post-durable cohort changed'), {
        code: 'P1_R148_INIT_FINALIZATION_IDENTITY'
      });
    };
    if (
      this.runtimeRevision !== expected.runtimeRevision ||
      this.homeosStrandedR148InitRecoveryAuthorization ||
      this.homeosStrandedR147RecoveryAuthorization ||
      this.homeosNeutralBirthAuthorization || this.metabHomeosRouteAuthorization ||
      this.homeosShadowPromotionAuthorization || this.interoNeutralBirthAuthorization ||
      this.metabInteroRouteAuthorization || this.homeosInteroRouteAuthorization ||
      this.interoShadowPromotionAuthorization ||
      this.stateStore.getResident('resident:intero') ||
      this.stateStore.listResidents().length !== Object.keys(expected.residents).length
    ) return reject();

    const count = (sql, ...args) =>
      Number(this.stateStore.db.prepare(sql).get(...args)?.count || 0);
    const exactMetadataHash = (key, hash) => {
      const row = this.stateStore.db.prepare('SELECT json,sha256 FROM metadata WHERE key=?').get(key);
      return row?.sha256 === hash &&
        crypto.createHash('sha256').update(row?.json || '').digest('hex') === hash;
    };
    const exactResident = fence => {
      const resident = this.stateStore.getResident(fence.residencyId);
      const consumer = this.stateStore.getBiologicalConsumer(fence.residencyId);
      const checkpoint = this.stateStore.db.prepare(`
        SELECT checkpoint_id,instance_id,version,state_schema,generation,blob_hash,
          byte_length,input_cursor FROM resident_checkpoints
        WHERE residency_id=? AND generation=?
      `).get(fence.residencyId, fence.checkpointGeneration);
      return resident?.residencyId === fence.residencyId && resident?.coreId === fence.coreId &&
        resident?.instanceId === fence.instanceId && resident?.version === fence.version &&
        resident?.stateSchema === fence.stateSchema && resident?.status === fence.status &&
        resident?.checkpointGeneration === fence.checkpointGeneration &&
        resident?.checkpointHash === fence.checkpointHash &&
        resident?.moduleRelativePath === fence.moduleRelativePath &&
        resident?.moduleHash === fence.moduleHash && resident?.manifestHash === fence.manifestHash &&
        resident?.packagePolicyHash === fence.packagePolicyHash &&
        consumer?.coreId === fence.coreId && consumer?.required === false &&
        consumer?.active === true && consumer?.authorityEpoch === 0 &&
        consumer?.cursor === fence.consumerCursor && consumer?.checkpointHash === fence.checkpointHash &&
        consumer?.topicsHash === fence.topicsHash &&
        checkpoint?.checkpoint_id === fence.checkpointId &&
        checkpoint?.instance_id === fence.instanceId && checkpoint?.version === fence.version &&
        Number(checkpoint?.state_schema) === fence.stateSchema &&
        Number(checkpoint?.generation) === fence.checkpointGeneration &&
        checkpoint?.blob_hash === fence.checkpointHash &&
        Number(checkpoint?.byte_length) === fence.checkpointBytes &&
        Number(checkpoint?.input_cursor) === fence.inputCursor;
    };
    if (!Object.values(expected.residents).every(exactResident)) return reject();

    const highWater = Number(this.stateStore.db.prepare(
      'SELECT COALESCE(MAX(sequence),0) value FROM biological_events'
    ).get()?.value || 0);
    const latest = this.stateStore.db.prepare(
      'SELECT id,type,core_id,detail_json FROM recovery_records ORDER BY id DESC LIMIT 1'
    ).get();
    let recovery = null;
    try { recovery = JSON.parse(latest?.detail_json || 'null'); } catch {}
    if (
      highWater !== expected.highWater ||
      count("SELECT COUNT(*) count FROM biological_deliveries WHERE status='PENDING'") !== 0 ||
      count("SELECT COUNT(*) count FROM biological_deliveries WHERE status='FAILED'") !== 0 ||
      count("SELECT COUNT(*) count FROM biological_deliveries WHERE status='ABANDONED'") !== 0 ||
      count("SELECT COUNT(*) count FROM biological_outbox_intents WHERE status='PENDING'") !== 0 ||
      count("SELECT COUNT(*) count FROM biological_outbox_intents WHERE producer_core_id IN ('sntss','SNTSS','HOMEOS','INTERO')") !== 0 ||
      !exactMetadataHash('life:runtime-revision', expected.runtimeRevisionMetadataHash) ||
      !exactMetadataHash('life:p1-r0-metab-capacity-source', expected.capacitySourceMetadataHash) ||
      Number(latest?.id) !== expected.latestRecoveryRecordId ||
      latest?.type !== 'resident.recovered' || latest?.core_id !== 'sntss' ||
      recovery?.residencyId !== 'resident:sntss' ||
      recovery?.instanceId !== expected.residents['resident:sntss'].instanceId ||
      recovery?.version !== expected.residents['resident:sntss'].version ||
      recovery?.checkpointHash !== expected.residents['resident:sntss'].checkpointHash
    ) return reject();


    const fetus = expected.fetus;
    const fetusConsumer = this.stateStore.getBiologicalConsumer(fetus.consumerId);
    const fetusAuthority = this.stateStore.db.prepare('SELECT * FROM authority WHERE core_id=?').get(fetus.coreId);
    const fetusCheckpoint = this.stateStore.db.prepare(
      'SELECT * FROM checkpoints WHERE core_id=? ORDER BY generation DESC LIMIT 1'
    ).get(fetus.coreId);
    if (
      this.stateStore.listAuthority().some(entry =>
        ['METAB', 'HOMEOS', 'INTERO', 'sntss', 'chronobiology'].includes(entry.coreId)) ||
      fetusConsumer?.coreId !== fetus.coreId || fetusConsumer?.required !== true ||
      fetusConsumer?.active !== true || fetusConsumer?.cursor !== fetus.consumerCursor ||
      fetusConsumer?.authorityEpoch !== fetus.authorityEpoch ||
      fetusConsumer?.checkpointHash !== fetus.consumerCheckpointHash ||
      fetusConsumer?.topicsHash !== fetus.topicsHash ||
      fetusAuthority?.instance_id !== fetus.instanceId || fetusAuthority?.version !== fetus.version ||
      Number(fetusAuthority?.epoch) !== fetus.authorityEpoch ||
      fetusAuthority?.checkpoint_hash !== fetus.checkpointHash ||
      fetusCheckpoint?.instance_id !== fetus.instanceId || fetusCheckpoint?.version !== fetus.version ||
      Number(fetusCheckpoint?.authority_epoch) !== fetus.authorityEpoch ||
      Number(fetusCheckpoint?.generation) !== fetus.checkpointGeneration ||
      fetusCheckpoint?.blob_hash !== fetus.checkpointHash ||
      Number(fetusCheckpoint?.byte_length) !== fetus.checkpointBytes
    ) return reject();

    this.r148HomeosInitPostDurableFinalizationActive = true;
    this.r148HomeosInitPostDurableFinalizationExpected = expected;
    this.r148DeferredResidentRecovery = true;
    this.p1ExpansionFetusInstallRevisionPreservation = this.runtimeRevision;
    return true;
  }
  preserveExactR147HomeosRecoveryRevision() {
    const expected = R147_HOMEOS_FORWARD_RECOVERY;
    if (
      this.runtimeRevision !== expected.runtimeRevision ||
      this.homeosStrandedR147RecoveryAuthorization !== expected.authorization ||
      this.homeosNeutralBirthAuthorization !== R145_HOMEOS_SHADOW.birthAuthorization ||
      this.metabHomeosRouteAuthorization !== R145_HOMEOS_SHADOW.metabRouteAuthorization ||
      this.homeosShadowPromotionAuthorization !== R145_HOMEOS_SHADOW.shadowAuthorization ||
      this.stateStore.getResident('resident:intero')
    ) return false;

    const exactResident = (resident, fence) => resident?.residencyId === fence.residencyId &&
      resident?.coreId === fence.coreId && resident?.instanceId === fence.instanceId &&
      resident?.version === fence.version && resident?.stateSchema === fence.stateSchema &&
      resident?.status === fence.status &&
      resident?.checkpointGeneration === fence.checkpointGeneration &&
      resident?.checkpointHash === fence.checkpointHash &&
      (!fence.moduleRelativePath || resident?.moduleRelativePath === fence.moduleRelativePath) &&
      (!fence.moduleHash || resident?.moduleHash === fence.moduleHash) &&
      (!fence.manifestHash || resident?.manifestHash === fence.manifestHash) &&
      (!fence.packagePolicyHash || resident?.packagePolicyHash === fence.packagePolicyHash);
    const metab = this.stateStore.getResident(expected.metab.residencyId);
    const homeos = this.stateStore.getResident(expected.homeos.residencyId);
    const sntss = this.stateStore.getResident(expected.sntss.residencyId);
    const chronobiology = this.stateStore.getResident(expected.chronobiology.residencyId);
    if (![ [metab, expected.metab], [homeos, expected.homeos], [sntss, expected.sntss],
      [chronobiology, expected.chronobiology] ].every(([resident, fence]) =>
      exactResident(resident, fence))) return false;

    const exactConsumer = fence => {
      const consumer = this.stateStore.getBiologicalConsumer(fence.residencyId);
      return consumer?.coreId === fence.coreId && consumer?.required === false &&
        consumer?.authorityEpoch === 0 && consumer?.checkpointHash === fence.checkpointHash &&
        consumer?.active === (fence.status === 'RUNNING') &&
        (!Number.isSafeInteger(fence.consumerCursor) || consumer?.cursor === fence.consumerCursor) &&
        (!fence.topicsHash || consumer?.topicsHash === fence.topicsHash);
    };
    if (![expected.metab, expected.homeos, expected.sntss, expected.chronobiology]
      .every(exactConsumer)) return false;

    if (this.stateStore.listAuthority().some(entry =>
      ['METAB', 'HOMEOS', 'INTERO', 'sntss', 'chronobiology'].includes(entry.coreId)
    )) return false;
    const count = (sql, ...args) => Number(this.stateStore.db.prepare(sql).get(...args)?.count || 0);
    if (
      count("SELECT COUNT(*) count FROM biological_deliveries WHERE status!='ACKED'") !== 0 ||
      count("SELECT COUNT(*) count FROM biological_outbox_intents WHERE status!='PUBLISHED'") !== 0 ||
      count("SELECT COUNT(*) count FROM biological_outbox_intents WHERE producer_core_id IN ('sntss','SNTSS','HOMEOS','INTERO')") !== 0
    ) return false;

    const latest = coreId => this.stateStore.db.prepare(`
      SELECT id,detail_json FROM recovery_records
      WHERE type='resident.resync-required' AND core_id=? ORDER BY id DESC LIMIT 1
    `).get(coreId);
    for (const fence of [expected.homeos, expected.sntss, expected.chronobiology]) {
      const row = latest(fence.coreId);
      let detail = null;
      try { detail = JSON.parse(row?.detail_json || 'null'); } catch {}
      if (Number(row?.id) !== fence.failureRecordId ||
          detail?.residencyId !== fence.residencyId ||
          detail?.sequence !== fence.failureSequence || detail?.code !== fence.failureCode) return false;
    }
    const latestRecovery = this.stateStore.db.prepare(`
      SELECT id,detail_json FROM recovery_records ORDER BY id DESC LIMIT 1
    `).get();
    let recoveryDetail = null;
    try { recoveryDetail = JSON.parse(latestRecovery?.detail_json || 'null'); } catch {}
    if (Number(latestRecovery?.id) !== expected.latestRecoveryRecordId ||
        recoveryDetail?.residencyId !== expected.metab.residencyId ||
        recoveryDetail?.instanceId !== expected.metab.instanceId ||
        recoveryDetail?.version !== expected.metab.version ||
        recoveryDetail?.checkpointHash !== expected.metab.checkpointHash) return false;
    const repair = this.stateStore.db.prepare(`
      SELECT id,detail_json FROM recovery_records
      WHERE type='resident.implementation-repaired' AND core_id='HOMEOS'
      ORDER BY id DESC LIMIT 1
    `).get();
    let repairDetail = null;
    try { repairDetail = JSON.parse(repair?.detail_json || 'null'); } catch {}
    if (Number(repair?.id) !== expected.homeosRepairRecordId ||
        repairDetail?.repairId !== R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosRepairId ||
        repairDetail?.repairedCheckpointHash !== expected.homeosCheckpointHash ||
        repairDetail?.pendingDeliveriesPreserved !== 0 ||
        repairDetail?.prunedDeliveriesRecovered !== 2 ||
        repairDetail?.biologicalOutputs !== 0 || repairDetail?.abandonedCount !== 0 ||
        repairDetail?.inventedBiologicalTime !== false ||
        repairDetail?.authorityChanged !== false || repairDetail?.resourceLimitsChanged !== false) return false;

    const capacityRow = this.stateStore.db.prepare(`
      SELECT json,sha256 FROM metadata WHERE key='life:p1-r0-metab-capacity-source'
    `).get();
    let source = null;
    try {
      if (capacityRow?.sha256 !== crypto.createHash('sha256').update(capacityRow?.json || '').digest('hex')) {
        return false;
      }
      const { validateCapacitySourceState } = require('../p1-r0/metab-capacity-source');
      source = validateCapacitySourceState(JSON.parse(capacityRow.json), {
        instanceId: expected.metab.instanceId,
        residentVersion: expected.metab.version
      });
    } catch { return false; }
    if (source.runtimeRevision !== 128 || source.lastCommittedFrame < 162421 ||
        (source.pending !== null && source.pending.sampleFrame !== source.lastCommittedFrame + 1)) return false;
    if (!this.exactR146FetusContinuityCohort().valid) return false;

    this.homeosFinalR146RecoveryActive = true;
    this.homeosFinalR147RecoveryActive = true;
    this.fetusEmptyInputR147RecoveryActive = true;
    return true;
  }


  preserveExactR147HomeosFrameBoundaryRevision() {
    const expected = R147_HOMEOS_FRAME_BOUNDARY_RECOVERY;
    if (
      this.runtimeRevision !== expected.runtimeRevision ||
      this.homeosStrandedR147RecoveryAuthorization !== expected.authorization ||
      this.homeosNeutralBirthAuthorization !== R145_HOMEOS_SHADOW.birthAuthorization ||
      this.metabHomeosRouteAuthorization !== R145_HOMEOS_SHADOW.metabRouteAuthorization ||
      this.homeosShadowPromotionAuthorization !== R145_HOMEOS_SHADOW.shadowAuthorization ||
      this.stateStore.getResident('resident:intero')
    ) return false;

    const exactResident = fence => {
      const resident = this.stateStore.getResident(fence.residencyId);
      const consumer = this.stateStore.getBiologicalConsumer(fence.residencyId);
      const checkpoint = this.stateStore.db.prepare(`
        SELECT checkpoint_id,instance_id,version,state_schema,generation,blob_hash,
          byte_length,input_cursor FROM resident_checkpoints
        WHERE residency_id=? AND generation=?
      `).get(fence.residencyId, fence.checkpointGeneration);
      return resident?.coreId === fence.coreId && resident?.instanceId === fence.instanceId &&
        resident?.version === fence.version && resident?.stateSchema === fence.stateSchema &&
        resident?.status === fence.status &&
        resident?.checkpointGeneration === fence.checkpointGeneration &&
        resident?.checkpointHash === fence.checkpointHash &&
        resident?.moduleRelativePath === fence.moduleRelativePath &&
        resident?.moduleHash === fence.moduleHash && resident?.manifestHash === fence.manifestHash &&
        resident?.packagePolicyHash === fence.packagePolicyHash &&
        consumer?.coreId === fence.coreId && consumer?.required === false &&
        consumer?.active === ['RUNNING', 'RECOVERING'].includes(fence.status) &&
        consumer?.authorityEpoch === 0 && consumer?.cursor === fence.consumerCursor &&
        consumer?.checkpointHash === fence.checkpointHash && consumer?.topicsHash === fence.topicsHash &&
        checkpoint?.checkpoint_id === fence.checkpointId && checkpoint?.instance_id === fence.instanceId &&
        checkpoint?.version === fence.version && Number(checkpoint?.state_schema) === fence.stateSchema &&
        Number(checkpoint?.generation) === fence.checkpointGeneration &&
        checkpoint?.blob_hash === fence.checkpointHash &&
        Number(checkpoint?.byte_length) === fence.checkpointBytes &&
        Number(checkpoint?.input_cursor) === fence.inputCursor;
    };
    if (![expected.metab, expected.homeos, expected.sntss, expected.chronobiology]
      .every(exactResident)) return false;

    const count = (sql, ...args) => Number(this.stateStore.db.prepare(sql).get(...args)?.count || 0);
    if (
      this.stateStore.listAuthority().some(entry =>
        ['METAB', 'HOMEOS', 'INTERO', 'sntss', 'chronobiology'].includes(entry.coreId)) ||
      count("SELECT COUNT(*) count FROM biological_deliveries WHERE status='PENDING'") !== 492 ||
      count("SELECT COUNT(*) count FROM biological_deliveries WHERE status='ABANDONED'") !== 0 ||
      count("SELECT COUNT(*) count FROM biological_outbox_intents WHERE status!='PUBLISHED'") !== 0 ||
      count("SELECT COUNT(*) count FROM biological_outbox_intents WHERE producer_core_id IN ('sntss','SNTSS','HOMEOS','INTERO')") !== 0 ||
      Number(this.stateStore.db.prepare(
        'SELECT COALESCE(MAX(sequence),0) value FROM biological_events'
      ).get()?.value) !== expected.highWater
    ) return false;

    const pending = this.stateStore.db.prepare(`
      SELECT COUNT(*) count,MIN(d.sequence) minimum,MAX(d.sequence) maximum,
        SUM(CASE WHEN e.topic='metab.energy.availability.v1' THEN 1 ELSE 0 END) availability,
        SUM(CASE WHEN e.topic='metab.energy.reserve.v1' THEN 1 ELSE 0 END) reserve,
        SUM(CASE WHEN e.topic NOT IN ('metab.energy.availability.v1','metab.energy.reserve.v1')
          THEN 1 ELSE 0 END) invalid
      FROM biological_deliveries d JOIN biological_events e ON e.sequence=d.sequence
      WHERE d.consumer_id='resident:homeos' AND d.status='PENDING'
    `).get();
    if (Number(pending?.count) !== expected.homeos.pendingCount ||
        Number(pending?.minimum) !== expected.homeos.firstPendingSequence ||
        Number(pending?.maximum) !== expected.homeos.lastPendingSequence ||
        Number(pending?.availability) !== 246 || Number(pending?.reserve) !== 246 ||
        Number(pending?.invalid) !== 0 ||
        count("SELECT COUNT(*) count FROM biological_deliveries WHERE consumer_id!='resident:homeos' AND status='PENDING'") !== 0) {
      return false;
    }

    const latest = this.stateStore.db.prepare(
      'SELECT id,type,core_id,detail_json FROM recovery_records ORDER BY id DESC LIMIT 1'
    ).get();
    let repair = null;
    try { repair = JSON.parse(latest?.detail_json || 'null'); } catch {}
    if (Number(latest?.id) !== expected.latestRecoveryRecordId ||
        latest?.type !== 'resident.r147-frame-boundary-repaired' || latest?.core_id !== 'HOMEOS' ||
        repair?.repairId !== expected.repairId ||
        repair?.repairedCheckpointHash !== expected.repairCheckpointHash ||
        repair?.pendingDeliveriesPreserved !== 492 || repair?.biologicalEventsDeleted !== 0 ||
        repair?.abandonedCount !== 0 || repair?.inventedBiologicalTime !== false ||
        repair?.authorityChanged !== false || repair?.biologicalOutputs !== 0) return false;

    const fetus = expected.fetus;
    const fetusConsumer = this.stateStore.getBiologicalConsumer(fetus.consumerId);
    const fetusAuthority = this.stateStore.db.prepare('SELECT * FROM authority WHERE core_id=?')
      .get(fetus.coreId);
    const fetusCheckpoint = this.stateStore.db.prepare(`
      SELECT * FROM checkpoints WHERE core_id=? ORDER BY generation DESC LIMIT 1
    `).get(fetus.coreId);
    if (fetusConsumer?.coreId !== fetus.coreId || fetusConsumer?.required !== true ||
        fetusConsumer?.active !== true || fetusConsumer?.cursor !== fetus.consumerCursor ||
        fetusConsumer?.authorityEpoch !== fetus.authorityEpoch ||
        fetusConsumer?.checkpointHash !== fetus.consumerCheckpointHash ||
        fetusConsumer?.topicsHash !== fetus.topicsHash ||
        fetusAuthority?.instance_id !== fetus.instanceId || fetusAuthority?.version !== fetus.version ||
        Number(fetusAuthority?.epoch) !== fetus.authorityEpoch ||
        fetusAuthority?.checkpoint_hash !== fetus.checkpointHash ||
        fetusCheckpoint?.instance_id !== fetus.instanceId || fetusCheckpoint?.version !== fetus.version ||
        Number(fetusCheckpoint?.authority_epoch) !== fetus.authorityEpoch ||
        Number(fetusCheckpoint?.generation) !== fetus.checkpointGeneration ||
        fetusCheckpoint?.blob_hash !== fetus.checkpointHash ||
        Number(fetusCheckpoint?.byte_length) !== fetus.checkpointBytes ||
        count("SELECT COUNT(*) count FROM biological_deliveries WHERE consumer_id=? AND status='PENDING'", fetus.consumerId) !== 0) {
      return false;
    }

    const capacityRow = this.stateStore.db.prepare(`
      SELECT json,sha256 FROM metadata WHERE key='life:p1-r0-metab-capacity-source'
    `).get();
    let source = null;
    try {
      if (capacityRow?.sha256 !== crypto.createHash('sha256').update(capacityRow?.json || '').digest('hex')) {
        return false;
      }
      const { validateCapacitySourceState } = require('../p1-r0/metab-capacity-source');
      source = validateCapacitySourceState(JSON.parse(capacityRow.json), {
        instanceId: expected.metab.instanceId,
        residentVersion: expected.metab.version
      });
    } catch { return false; }
    if (source.runtimeRevision !== R147_HOMEOS_CONTINUATION_RECOVERY.capacitySource.runtimeRevision ||
        source.lastCommittedFrame !== R147_HOMEOS_CONTINUATION_RECOVERY.capacitySource.lastCommittedFrame ||
        source.lastTrustedTimeUs !== R147_HOMEOS_CONTINUATION_RECOVERY.capacitySource.lastTrustedTimeUs ||
        source.lastContinuityEpoch !== R147_HOMEOS_CONTINUATION_RECOVERY.capacitySource.lastContinuityEpoch ||
        source.pending !== null) return false;

    this.homeosFinalR146RecoveryActive = true;
    this.homeosFinalR147RecoveryActive = true;
    this.fetusEmptyInputR147RecoveryActive = false;
    this.r147HomeosContinuationRecoveryActive = true;
    this.r147HomeosFrameBoundaryRecoveryActive = true;
    this.r147DeferredResidentRecovery = true;
    this.p1ExpansionFetusInstallRevisionPreservation = this.runtimeRevision;
    return true;
  }


  preserveExactR147HomeosContinuationRevision() {
    const expected = R147_HOMEOS_CONTINUATION_RECOVERY;
    if (
      this.runtimeRevision !== expected.runtimeRevision ||
      this.homeosStrandedR147RecoveryAuthorization !== expected.authorization ||
      this.homeosNeutralBirthAuthorization !== R145_HOMEOS_SHADOW.birthAuthorization ||
      this.metabHomeosRouteAuthorization !== R145_HOMEOS_SHADOW.metabRouteAuthorization ||
      this.homeosShadowPromotionAuthorization !== R145_HOMEOS_SHADOW.shadowAuthorization ||
      this.stateStore.getResident('resident:intero')
    ) return false;

    const exactResident = fence => {
      const resident = this.stateStore.getResident(fence.residencyId);
      const consumer = this.stateStore.getBiologicalConsumer(fence.residencyId);
      const checkpoint = this.stateStore.db.prepare(`
        SELECT checkpoint_id,instance_id,version,state_schema,generation,blob_hash,
          byte_length,input_cursor FROM resident_checkpoints
        WHERE residency_id=? AND generation=?
      `).get(fence.residencyId, fence.checkpointGeneration);
      return resident?.coreId === fence.coreId && resident?.instanceId === fence.instanceId &&
        resident?.version === fence.version && resident?.stateSchema === fence.stateSchema &&
        resident?.status === fence.status &&
        resident?.checkpointGeneration === fence.checkpointGeneration &&
        resident?.checkpointHash === fence.checkpointHash &&
        resident?.moduleRelativePath === fence.moduleRelativePath &&
        resident?.moduleHash === fence.moduleHash && resident?.manifestHash === fence.manifestHash &&
        resident?.packagePolicyHash === fence.packagePolicyHash &&
        consumer?.coreId === fence.coreId && consumer?.required === false &&
        consumer?.active === ['RUNNING', 'RECOVERING'].includes(fence.status) &&
        consumer?.authorityEpoch === 0 &&
        consumer?.cursor === fence.consumerCursor && consumer?.checkpointHash === fence.checkpointHash &&
        consumer?.topicsHash === fence.topicsHash && checkpoint?.checkpoint_id === fence.checkpointId &&
        checkpoint?.instance_id === fence.instanceId && checkpoint?.version === fence.version &&
        Number(checkpoint?.state_schema) === fence.stateSchema &&
        Number(checkpoint?.generation) === fence.checkpointGeneration &&
        checkpoint?.blob_hash === fence.checkpointHash &&
        Number(checkpoint?.byte_length) === fence.checkpointBytes &&
        Number(checkpoint?.input_cursor) === fence.inputCursor;
    };
    if (![expected.metab, expected.homeos, expected.sntss, expected.chronobiology]
      .every(exactResident)) return false;

    const count = (sql, ...args) => Number(this.stateStore.db.prepare(sql).get(...args)?.count || 0);
    if (
      this.stateStore.listAuthority().some(entry =>
        ['METAB', 'HOMEOS', 'INTERO', 'sntss', 'chronobiology'].includes(entry.coreId)) ||
      count("SELECT COUNT(*) count FROM biological_deliveries WHERE status!='ACKED'") !== 2524 ||
      count("SELECT COUNT(*) count FROM biological_outbox_intents WHERE status!='PUBLISHED'") !== 0 ||
      count("SELECT COUNT(*) count FROM biological_outbox_intents WHERE producer_core_id IN ('sntss','SNTSS','HOMEOS','INTERO')") !== 0 ||
      Number(this.stateStore.db.prepare(
        'SELECT COALESCE(MAX(sequence),0) value FROM biological_events'
      ).get()?.value) !== expected.highWater
    ) return false;

    for (const fence of [expected.homeos, expected.sntss]) {
      const pending = this.stateStore.db.prepare(`
        SELECT COUNT(*) count,MIN(sequence) minimum,MAX(sequence) maximum
        FROM biological_deliveries WHERE consumer_id=? AND status='PENDING'
      `).get(fence.residencyId);
      const failure = this.stateStore.db.prepare(`
        SELECT id,detail_json FROM recovery_records
        WHERE type='resident.resync-required' AND core_id=? ORDER BY id DESC LIMIT 1
      `).get(fence.coreId);
      let detail = null;
      try { detail = JSON.parse(failure?.detail_json || 'null'); } catch {}
      const markers = fence.topics.map(() => '?').join(',');
      const relevantPending = count(`SELECT COUNT(*) count FROM biological_deliveries d
        JOIN biological_events e ON e.sequence=d.sequence
        WHERE d.consumer_id=? AND d.status='PENDING' AND d.sequence>? AND
          e.topic IN (${markers})`, fence.residencyId, fence.consumerCursor, ...fence.topics);
      const invalidPending = count(`SELECT COUNT(*) count FROM biological_deliveries d
        JOIN biological_events e ON e.sequence=d.sequence
        WHERE d.consumer_id=? AND d.status='PENDING' AND d.sequence>? AND
          e.topic NOT IN (${markers})`, fence.residencyId, fence.consumerCursor, ...fence.topics);
      if (Number(pending?.count) !== fence.pendingCount ||
          Number(pending?.minimum) !== fence.firstPendingSequence ||
          Number(pending?.maximum) !== fence.lastPendingSequence ||
          Number(failure?.id) !== fence.failureRecordId ||
          detail?.residencyId !== fence.residencyId ||
          detail?.sequence !== fence.failureSequence || detail?.code !== fence.failureCode ||
          relevantPending !== fence.eligibleReplayCount ||
          invalidPending !== fence.invalidPendingCount) return false;
    }
    const latest = this.stateStore.db.prepare(
      'SELECT id,type,core_id,detail_json FROM recovery_records ORDER BY id DESC LIMIT 1'
    ).get();
    let latestDetail = null;
    try { latestDetail = JSON.parse(latest?.detail_json || 'null'); } catch {}
    const fetusResolution = this.stateStore.db.prepare(`
      SELECT id,detail_json FROM recovery_records
      WHERE type='biological.consumer-resynchronized' AND core_id='fetus-legacy'
      ORDER BY id DESC LIMIT 1
    `).get();
    let fetusDetail = null;
    try { fetusDetail = JSON.parse(fetusResolution?.detail_json || 'null'); } catch {}
    if (Number(latest?.id) !== expected.latestRecoveryRecordId ||
        latest?.type !== 'resident.cold-recovery-failed' || latest?.core_id !== expected.sntss.coreId ||
        latestDetail?.residencyId !== expected.sntss.residencyId ||
        latestDetail?.expectedRevision !== expected.runtimeRevision ||
        latestDetail?.code !== expected.sntss.failureCode ||
        Number(fetusResolution?.id) !== expected.fetusResolutionRecordId ||
        fetusDetail?.cohort !== 'r146-fetus-empty-input-continuity-v1' ||
        fetusDetail?.toCursor !== 4574204 || fetusDetail?.abandonedCount !== 0 ||
        fetusDetail?.inventedBiologicalTime !== false || fetusDetail?.authorityChanged !== false) return false;

    const fetus = expected.fetus;
    const fetusConsumer = this.stateStore.getBiologicalConsumer(fetus.consumerId);
    const fetusAuthority = this.stateStore.db.prepare(
      'SELECT * FROM authority WHERE core_id=?'
    ).get(fetus.coreId);
    const fetusCheckpoint = this.stateStore.db.prepare(`
      SELECT * FROM checkpoints WHERE core_id=? ORDER BY generation DESC LIMIT 1
    `).get(fetus.coreId);
    if (
      fetusConsumer?.coreId !== fetus.coreId || fetusConsumer?.required !== true ||
      fetusConsumer?.active !== true || fetusConsumer?.cursor !== fetus.consumerCursor ||
      fetusConsumer?.authorityEpoch !== fetus.authorityEpoch ||
      fetusConsumer?.checkpointHash !== fetus.consumerCheckpointHash ||
      fetusConsumer?.topicsHash !== fetus.topicsHash ||
      fetusAuthority?.instance_id !== fetus.instanceId || fetusAuthority?.version !== fetus.version ||
      Number(fetusAuthority?.epoch) !== fetus.authorityEpoch ||
      fetusAuthority?.checkpoint_hash !== fetus.checkpointHash ||
      fetusCheckpoint?.instance_id !== fetus.instanceId || fetusCheckpoint?.version !== fetus.version ||
      Number(fetusCheckpoint?.authority_epoch) !== fetus.authorityEpoch ||
      Number(fetusCheckpoint?.generation) !== fetus.checkpointGeneration ||
      fetusCheckpoint?.blob_hash !== fetus.checkpointHash ||
      Number(fetusCheckpoint?.byte_length) !== fetus.checkpointBytes ||
      count("SELECT COUNT(*) count FROM biological_deliveries WHERE consumer_id=? AND status='PENDING'", fetus.consumerId) !== 0 ||
      count("SELECT COUNT(*) count FROM biological_outbox_intents WHERE producer_core_id=? AND status='PENDING'", fetus.coreId) !== 0
    ) return false;

    const capacityRow = this.stateStore.db.prepare(`
      SELECT json,sha256 FROM metadata WHERE key='life:p1-r0-metab-capacity-source'
    `).get();
    let source = null;
    try {
      if (capacityRow?.sha256 !== crypto.createHash('sha256').update(capacityRow?.json || '').digest('hex')) {
        return false;
      }
      const { validateCapacitySourceState } = require('../p1-r0/metab-capacity-source');
      source = validateCapacitySourceState(JSON.parse(capacityRow.json), {
        instanceId: expected.metab.instanceId,
        residentVersion: expected.metab.version
      });
    } catch { return false; }
    if (source.runtimeRevision !== expected.capacitySource.runtimeRevision ||
        source.lastCommittedFrame !== expected.capacitySource.lastCommittedFrame ||
        source.lastTrustedTimeUs !== expected.capacitySource.lastTrustedTimeUs ||
        source.lastContinuityEpoch !== expected.capacitySource.lastContinuityEpoch ||
        source.pending !== null) return false;

    this.homeosFinalR146RecoveryActive = true;
    this.homeosFinalR147RecoveryActive = true;
    this.fetusEmptyInputR147RecoveryActive = false;
    this.r147HomeosContinuationRecoveryActive = true;
    this.r147DeferredResidentRecovery = true;
    this.p1ExpansionFetusInstallRevisionPreservation = this.runtimeRevision;
    return true;
  }


  preserveExactR145HomeosProgressRevision() {
    if (
      this.homeosNeutralBirthAuthorization !== R145_HOMEOS_SHADOW.birthAuthorization ||
      this.metabHomeosRouteAuthorization !== R145_HOMEOS_SHADOW.metabRouteAuthorization ||
      this.homeosShadowPromotionAuthorization !== R145_HOMEOS_SHADOW.shadowAuthorization
    ) return false;
    const metab = this.stateStore.getResident('resident:metab');
    const homeos = this.stateStore.getResident('resident:homeos');
    const authorityPresent = this.stateStore.listAuthority().some(entry =>
      ['METAB', 'HOMEOS', 'INTERO'].includes(entry.coreId)
    );
    if (authorityPresent) return false;
    const strandedR145 =
      this.homeosStrandedR145RecoveryAuthorization ===
        R145_HOMEOS_SHADOW.strandedRecoveryAuthorization &&
      this.runtimeRevision === 145 &&
      !homeos &&
      !this.stateStore.getResident('resident:intero') &&
      !this.stateStore.getBiologicalConsumer('resident:homeos') &&
      metab?.instanceId === R145_HOMEOS_SHADOW.metabInstanceId &&
      metab?.version === '0.2.0-p1r0-shadow.1' && metab?.stateSchema === 2 &&
      metab?.moduleRelativePath === 'cores/p1-r0/metab-shadow/index.js' &&
      metab?.status === 'RUNNING';
    if (strandedR145) {
      this.homeosStrandedR145RecoveryActive = true;
      this.homeosStrandedRecoveryRevision = 145;
      return true;
    }
    if (
      this.runtimeRevision === R146_METAB_Q48_HOMEOS_RECOVERY.runtimeRevision &&
      this.homeosStrandedR146RecoveryAuthorization ===
        R146_METAB_Q48_HOMEOS_RECOVERY.authorization
    ) {
    const checkpoint = this.stateStore.db.prepare(`
      SELECT checkpoint_id,instance_id,version,state_schema,generation,blob_hash,
        byte_length,input_cursor
      FROM resident_checkpoints
      WHERE residency_id=? AND generation=?
    `).get(
      'resident:metab',
      R146_METAB_Q48_HOMEOS_RECOVERY.checkpointGeneration
    );
    const metabConsumer =
      this.stateStore.getBiologicalConsumer('resident:metab');
    const latestFailure = this.stateStore.db.prepare(`
      SELECT id,detail_json FROM recovery_records
      WHERE type='resident.resync-required' AND core_id='METAB'
      ORDER BY id DESC LIMIT 1
    `).get();
    const latestRepair = this.stateStore.db.prepare(`
      SELECT detail_json FROM recovery_records
      WHERE type='resident.implementation-repaired' AND core_id='METAB'
      ORDER BY id DESC LIMIT 1
    `).get();
    const capacitySourceRow = this.stateStore.db.prepare(`
      SELECT json,sha256 FROM metadata
      WHERE key='life:p1-r0-metab-capacity-source'
    `).get();
    let failureDetail = null;
    let repairDetail = null;
    let capacitySource = null;
    try { failureDetail = JSON.parse(latestFailure?.detail_json || 'null'); } catch {}
    try { repairDetail = JSON.parse(latestRepair?.detail_json || 'null'); } catch {}
    try { capacitySource = JSON.parse(capacitySourceRow?.json || 'null'); } catch {}
    const pendingMetab = Number(this.stateStore.db.prepare(`
      SELECT COUNT(*) AS count FROM biological_deliveries
      WHERE consumer_id='resident:metab' AND status='PENDING'
    `).get().count);
    const pendingMetabOutbox = Number(this.stateStore.db.prepare(`
      SELECT COUNT(*) AS count FROM biological_outbox_intents
      WHERE producer_core_id='METAB' AND status='PENDING'
    `).get().count);
    const strandedR146 =
      this.homeosStrandedR146RecoveryAuthorization ===
        R146_METAB_Q48_HOMEOS_RECOVERY.authorization &&
      this.runtimeRevision === R146_METAB_Q48_HOMEOS_RECOVERY.runtimeRevision &&
      !homeos &&
      !this.stateStore.getResident('resident:intero') &&
      !this.stateStore.getBiologicalConsumer('resident:homeos') &&
      metab?.instanceId === R146_METAB_Q48_HOMEOS_RECOVERY.metabInstanceId &&
      metab?.version === R146_METAB_Q48_HOMEOS_RECOVERY.metabVersion &&
      metab?.stateSchema === R146_METAB_Q48_HOMEOS_RECOVERY.metabStateSchema &&
      metab?.moduleRelativePath ===
        R146_METAB_Q48_HOMEOS_RECOVERY.metabModuleRelativePath &&
      metab?.moduleHash === R146_METAB_Q48_HOMEOS_RECOVERY.metabModuleHash &&
      metab?.manifestHash === R146_METAB_Q48_HOMEOS_RECOVERY.metabManifestHash &&
      metab?.packagePolicyHash ===
        R146_METAB_Q48_HOMEOS_RECOVERY.metabPackagePolicyHash &&
      metab?.status === 'RESYNC_REQUIRED' &&
      metab?.checkpointGeneration ===
        R146_METAB_Q48_HOMEOS_RECOVERY.checkpointGeneration &&
      metab?.checkpointHash === checkpoint?.blob_hash &&
      checkpoint?.checkpoint_id === R146_METAB_Q48_HOMEOS_RECOVERY.checkpointId &&
      checkpoint?.instance_id === R146_METAB_Q48_HOMEOS_RECOVERY.metabInstanceId &&
      checkpoint?.version === R146_METAB_Q48_HOMEOS_RECOVERY.metabVersion &&
      Number(checkpoint?.state_schema) ===
        R146_METAB_Q48_HOMEOS_RECOVERY.metabStateSchema &&
      Number(checkpoint?.generation) ===
        R146_METAB_Q48_HOMEOS_RECOVERY.checkpointGeneration &&
      Number(checkpoint?.input_cursor) ===
        R146_METAB_Q48_HOMEOS_RECOVERY.inputCursor &&
      metabConsumer?.coreId === 'METAB' &&
      metabConsumer?.required === false &&
      metabConsumer?.active === false &&
      metabConsumer?.cursor === R146_METAB_Q48_HOMEOS_RECOVERY.inputCursor &&
      metabConsumer?.authorityEpoch === 0 &&
      metabConsumer?.checkpointHash === checkpoint?.blob_hash &&
      Number(latestFailure?.id) ===
        R146_METAB_Q48_HOMEOS_RECOVERY.failureRecordId &&
      failureDetail?.sequence ===
        R146_METAB_Q48_HOMEOS_RECOVERY.failureSequence &&
      failureDetail?.topic === 'resource.capacity.quality.v1' &&
      failureDetail?.code === 'P1_Q48_OVERFLOW' &&
      repairDetail?.repairId === R146_METAB_Q48_HOMEOS_RECOVERY.repairId &&
      repairDetail?.repairedCheckpointHash === checkpoint?.blob_hash &&
      repairDetail?.abandonedCount === 0 &&
      repairDetail?.inventedBiologicalTime === false &&
      repairDetail?.authorityChanged === false &&
      typeof capacitySourceRow?.json === 'string' &&
      capacitySourceRow?.sha256 === crypto.createHash('sha256')
        .update(capacitySourceRow.json).digest('hex') &&
      capacitySource?.lastCommittedFrame === 98001 &&
      capacitySource?.pending === null &&
      pendingMetab === 0 && pendingMetabOutbox === 0;
    if (strandedR146) {
      this.homeosStrandedR145RecoveryActive = true;
      this.homeosStrandedRecoveryRevision = 146;
      this.metabQ48R146RecoveryActive = true;
      return true;
    }

    /*
     * A killed recovery may already have committed the neutral HOMEOS birth
     * and the METAB HOMEOS-route generation while leaving one complete
     * capacity sample staged under the source generation.  Admit only that
     * exact, contained state.  The staged sample is not discarded: startup
     * carries it across the resident-version boundary and commits it before
     * HOMEOS is promoted.
     */
    if (
      homeos &&
      metab?.version === R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabVersion
    ) {
      const currentMetabCheckpoint = this.stateStore.db.prepare(`
        SELECT checkpoint_id,instance_id,version,state_schema,generation,blob_hash,
          byte_length,input_cursor
        FROM resident_checkpoints
        WHERE residency_id=? AND generation=?
      `).get('resident:metab', metab.checkpointGeneration);
      const currentHomeosCheckpoint = this.stateStore.db.prepare(`
        SELECT checkpoint_id,instance_id,version,state_schema,generation,blob_hash,
          byte_length,input_cursor
        FROM resident_checkpoints
        WHERE residency_id=? AND generation=?
      `).get('resident:homeos', homeos.checkpointGeneration);
      const homeosConsumer =
        this.stateStore.getBiologicalConsumer('resident:homeos');
      const latestMetabRecovery = this.stateStore.db.prepare(`
        SELECT detail_json FROM recovery_records
        WHERE type='resident.recovered' AND core_id='METAB'
        ORDER BY id DESC LIMIT 1
      `).get();
      const latestHomeosBirth = this.stateStore.db.prepare(`
        SELECT detail_json FROM recovery_records
        WHERE type='resident.attached' AND core_id='HOMEOS'
        ORDER BY id DESC LIMIT 1
      `).get();
      let metabRecoveryDetail = null;
      let homeosBirthDetail = null;
      let exactCapacitySource = null;
      try { metabRecoveryDetail = JSON.parse(latestMetabRecovery?.detail_json || 'null'); } catch {}
      try { homeosBirthDetail = JSON.parse(latestHomeosBirth?.detail_json || 'null'); } catch {}
      try {
        const { validateCapacitySourceState } = require('../p1-r0/metab-capacity-source');
        exactCapacitySource = validateCapacitySourceState(capacitySource, {
          instanceId: R146_METAB_Q48_HOMEOS_RECOVERY.metabInstanceId,
          residentVersion: R146_METAB_Q48_HOMEOS_RECOVERY.metabVersion
        });
      } catch {}
      const pendingHomeos = Number(this.stateStore.db.prepare(`
        SELECT COUNT(*) AS count FROM biological_deliveries
        WHERE consumer_id='resident:homeos' AND status='PENDING'
      `).get().count);
      const pendingHomeosOutbox = Number(this.stateStore.db.prepare(`
        SELECT COUNT(*) AS count FROM biological_outbox_intents
        WHERE producer_core_id='HOMEOS' AND status='PENDING'
      `).get().count);
      const partialR146 =
        this.homeosStrandedR146RecoveryAuthorization ===
          R146_METAB_Q48_HOMEOS_RECOVERY.authorization &&
        this.runtimeRevision === R146_METAB_Q48_HOMEOS_RECOVERY.runtimeRevision &&
        !this.stateStore.getResident('resident:intero') &&
        metab?.instanceId === R146_METAB_Q48_HOMEOS_RECOVERY.metabInstanceId &&
        metab?.stateSchema === R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabStateSchema &&
        metab?.moduleRelativePath ===
          R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabModuleRelativePath &&
        metab?.moduleHash === R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabModuleHash &&
        metab?.manifestHash === R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabManifestHash &&
        metab?.packagePolicyHash ===
          R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabPackagePolicyHash &&
        metab?.status === 'RUNNING' &&
        Number(metab?.checkpointGeneration) >
          R146_METAB_Q48_HOMEOS_RECOVERY.checkpointGeneration &&
        currentMetabCheckpoint?.instance_id ===
          R146_METAB_Q48_HOMEOS_RECOVERY.metabInstanceId &&
        currentMetabCheckpoint?.version ===
          R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabVersion &&
        Number(currentMetabCheckpoint?.state_schema) ===
          R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabStateSchema &&
        Number(currentMetabCheckpoint?.generation) ===
          Number(metab?.checkpointGeneration) &&
        currentMetabCheckpoint?.blob_hash === metab?.checkpointHash &&
        homeos?.instanceId === R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosInstanceId &&
        homeos?.version === R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosVersion &&
        homeos?.stateSchema === R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosStateSchema &&
        homeos?.moduleRelativePath ===
          R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosModuleRelativePath &&
        homeos?.moduleHash === R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosModuleHash &&
        homeos?.manifestHash === R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosManifestHash &&
        homeos?.packagePolicyHash ===
          R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosPackagePolicyHash &&
        homeos?.status === 'RUNNING' && Number(homeos?.checkpointGeneration) === 1 &&
        currentHomeosCheckpoint?.instance_id ===
          R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosInstanceId &&
        currentHomeosCheckpoint?.version ===
          R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosVersion &&
        Number(currentHomeosCheckpoint?.state_schema) ===
          R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosStateSchema &&
        Number(currentHomeosCheckpoint?.generation) === 1 &&
        currentHomeosCheckpoint?.blob_hash === homeos?.checkpointHash &&
        metabConsumer?.coreId === 'METAB' && metabConsumer?.required === false &&
        metabConsumer?.active === true && metabConsumer?.authorityEpoch === 0 &&
        metabConsumer?.checkpointHash === metab?.checkpointHash &&
        homeosConsumer?.coreId === 'HOMEOS' && homeosConsumer?.required === false &&
        homeosConsumer?.active === true && homeosConsumer?.authorityEpoch === 0 &&
        homeosConsumer?.checkpointHash === null &&
        repairDetail?.repairId === R146_METAB_Q48_HOMEOS_RECOVERY.repairId &&
        repairDetail?.abandonedCount === 0 &&
        repairDetail?.inventedBiologicalTime === false &&
        repairDetail?.authorityChanged === false &&
        metabRecoveryDetail?.residencyId === 'resident:metab' &&
        metabRecoveryDetail?.instanceId === R146_METAB_Q48_HOMEOS_RECOVERY.metabInstanceId &&
        metabRecoveryDetail?.version ===
          R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabVersion &&
        metabRecoveryDetail?.checkpointHash === metab?.checkpointHash &&
        homeosBirthDetail?.residencyId === 'resident:homeos' &&
        homeosBirthDetail?.instanceId ===
          R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosInstanceId &&
        homeosBirthDetail?.version ===
          R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosVersion &&
        homeosBirthDetail?.checkpointHash === homeos?.checkpointHash &&
        exactCapacitySource?.runtimeRevision === 128 &&
        Number.isSafeInteger(exactCapacitySource?.lastCommittedFrame) &&
        exactCapacitySource.lastCommittedFrame >= 98001 &&
        exactCapacitySource?.pending?.sampleFrame ===
          exactCapacitySource.lastCommittedFrame + 1 &&
        pendingMetab === 0 && pendingHomeos === 0 &&
        pendingMetabOutbox === 0 && pendingHomeosOutbox === 0;
      if (partialR146) {
        this.homeosStrandedR145RecoveryActive = true;
        this.homeosStrandedRecoveryRevision = 146;
        this.metabQ48R146RecoveryActive = true;
        this.homeosStrandedR146PartialRecoveryActive = true;
        return true;
      }
    }

    /*
     * The route is fully installed, but the first R146 shadow process was
     * stopped at an exact HOMEOS pending-frame boundary.  ExecStartPre has
     * already committed the reviewed implementation/checkpoint repair.  Keep
     * R146 only for this exact two-delivery cohort and the exact empty-input
     * fetus demotion; any drift remains fail-closed and would advance instead.
     */
    if (
      homeos &&
      metab?.version === R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabVersion &&
      homeos.version === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosVersion &&
      homeos.moduleHash === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosModuleHash &&
      homeos.status === 'RESYNC_REQUIRED'
    ) {
      const homeosCheckpoint = this.stateStore.db.prepare(`
        SELECT * FROM resident_checkpoints
        WHERE residency_id='resident:homeos' AND generation=?
      `).get(R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosCheckpointGeneration);
      const homeosConsumer = this.stateStore.getBiologicalConsumer('resident:homeos');
      const pendingHomeos = this.stateStore.db.prepare(`
        SELECT d.sequence,e.topic FROM biological_deliveries d
        JOIN biological_events e ON e.sequence=d.sequence
        WHERE d.consumer_id='resident:homeos' AND d.status='PENDING'
        ORDER BY d.sequence
      `).all();
      const latestHomeosFailure = this.stateStore.db.prepare(`
        SELECT id,detail_json FROM recovery_records
        WHERE type='resident.resync-required' AND core_id='HOMEOS'
        ORDER BY id DESC LIMIT 1
      `).get();
      const latestHomeosRepair = this.stateStore.db.prepare(`
        SELECT detail_json FROM recovery_records
        WHERE type='resident.implementation-repaired' AND core_id='HOMEOS'
        ORDER BY id DESC LIMIT 1
      `).get();
      let homeosFailureDetail = null;
      let homeosRepairDetail = null;
      try { homeosFailureDetail = JSON.parse(latestHomeosFailure?.detail_json || 'null'); } catch {}
      try { homeosRepairDetail = JSON.parse(latestHomeosRepair?.detail_json || 'null'); } catch {}
      const deliveryMode = homeosRepairDetail?.deliveryMode === 'pruned' ? 'pruned' : 'retained';
      const expectedHomeosCheckpointHash = deliveryMode === 'pruned'
        ? homeosRepairDetail?.repairedCheckpointHash
        : R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosCheckpointHash;
      const expectedHomeosCheckpointBytes = deliveryMode === 'pruned'
        ? Number(homeosRepairDetail?.repairedCheckpointBytes)
        : R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosCheckpointBytes;
      const expectedHomeosInputCursor = deliveryMode === 'pruned'
        ? R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosPrunedConsumerCursor
        : R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosInputCursor;
      const expectedHomeosConsumerCursor = deliveryMode === 'pruned'
        ? R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosPrunedConsumerCursor
        : R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosConsumerCursor;
      let exactPrunedIntents = false;
      if (deliveryMode === 'pruned') {
        const rows = this.stateStore.db.prepare(`SELECT * FROM biological_outbox_intents
          WHERE producer_event_id IN (?,?) ORDER BY fabric_sequence`).all(
          ...R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosPublishedIntentIds);
        exactPrunedIntents = rows.length === 2 && rows.every((row, index) => {
          try { this.stateStore.biologicalOutboxIntentFromRow(row); } catch { return false; }
          return row.producer_event_id ===
              R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosPublishedIntentIds[index] &&
            row.intent_sha256 ===
              R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosPublishedIntentHashes[index] &&
            row.producer_core_id === 'METAB' && row.status === 'PUBLISHED' &&
            Number(row.fabric_sequence) ===
              R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosPendingSequences[index];
        }) && Number(this.stateStore.db.prepare(`SELECT COUNT(*) count FROM biological_events
          WHERE sequence IN (?,?)`).get(
          ...R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosPendingSequences)?.count || 0) === 0;
      }
      const exactDeliveryBoundary = deliveryMode === 'retained'
        ? pendingHomeos.length === 2 && pendingHomeos.every((row, index) =>
          Number(row.sequence) === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosPendingSequences[index] &&
          row.topic === ['metab.energy.availability.v1', 'metab.energy.reserve.v1'][index])
        : pendingHomeos.length === 0 && exactPrunedIntents &&
          homeosRepairDetail?.pendingDeliveriesPreserved === 0 &&
          homeosRepairDetail?.prunedDeliveriesRecovered === 2 &&
          JSON.stringify(homeosRepairDetail?.sourceIntentSha256) ===
            JSON.stringify(R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosPublishedIntentHashes);
      const fetus = this.exactR146FetusContinuityCohort();
      const finalR146 =
        !this.stateStore.getResident('resident:intero') &&
        metab?.instanceId === R146_METAB_Q48_HOMEOS_RECOVERY.metabInstanceId &&
        metab?.stateSchema === R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabStateSchema &&
        metab?.moduleRelativePath === R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabModuleRelativePath &&
        metab?.moduleHash === R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabModuleHash &&
        metab?.manifestHash === R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabManifestHash &&
        metab?.packagePolicyHash === R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabPackagePolicyHash &&
        metab?.status === 'RUNNING' &&
        metabConsumer?.coreId === 'METAB' && metabConsumer?.required === false &&
        metabConsumer?.active === true && metabConsumer?.authorityEpoch === 0 &&
        homeos?.instanceId === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosInstanceId &&
        homeos?.version === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosVersion &&
        homeos?.stateSchema === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosStateSchema &&
        homeos?.moduleRelativePath === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosModuleRelativePath &&
        homeos?.moduleHash === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosModuleHash &&
        homeos?.manifestHash === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosManifestHash &&
        homeos?.packagePolicyHash === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosPackagePolicyHash &&
        homeos?.status === 'RESYNC_REQUIRED' &&
        homeos?.checkpointGeneration === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosCheckpointGeneration &&
        homeos?.checkpointHash === expectedHomeosCheckpointHash &&
        homeosCheckpoint?.checkpoint_id === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosCheckpointId &&
        homeosCheckpoint?.instance_id === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosInstanceId &&
        homeosCheckpoint?.version === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosVersion &&
        Number(homeosCheckpoint?.state_schema) === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosStateSchema &&
        Number(homeosCheckpoint?.generation) ===
          R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosCheckpointGeneration &&
        homeosCheckpoint?.blob_hash === expectedHomeosCheckpointHash &&
        Number(homeosCheckpoint?.byte_length) === expectedHomeosCheckpointBytes &&
        Number(homeosCheckpoint?.input_cursor) === expectedHomeosInputCursor &&
        homeosConsumer?.coreId === 'HOMEOS' && homeosConsumer?.required === false &&
        homeosConsumer?.active === false && homeosConsumer?.authorityEpoch === 0 &&
        homeosConsumer?.cursor === expectedHomeosConsumerCursor &&
        homeosConsumer?.topicsHash === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosTopicsHash &&
        homeosConsumer?.checkpointHash === expectedHomeosCheckpointHash &&
        exactDeliveryBoundary &&
        Number(latestHomeosFailure?.id) === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosFailureRecordId &&
        homeosFailureDetail?.sequence === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosPendingSequences[0] &&
        homeosFailureDetail?.code === 'P1_RESIDENT_PENDING_BOUND' &&
        homeosRepairDetail?.repairId === R146_METAB_Q48_HOMEOS_RECOVERY.finalHomeosRepairId &&
        homeosRepairDetail?.repairedCheckpointHash === expectedHomeosCheckpointHash &&
        homeosRepairDetail?.pendingDeliveriesPreserved ===
          (deliveryMode === 'retained' ? 2 : 0) &&
        homeosRepairDetail?.abandonedCount === 0 &&
        homeosRepairDetail?.inventedBiologicalTime === false &&
        homeosRepairDetail?.authorityChanged === false &&
        pendingMetabOutbox === 0 &&
        Number(this.stateStore.db.prepare(`SELECT COUNT(*) count FROM biological_outbox_intents
          WHERE producer_core_id='HOMEOS' AND status='PENDING'`).get()?.count || 0) === 0 &&
        capacitySource?.pending === null && fetus.valid;
      if (finalR146) {
        this.homeosFinalR146RecoveryActive = true;
        this.fetusEmptyInputR146RecoveryActive = true;
        return true;
      }
    }
    }
    if (!homeos || homeos.status === 'QUARANTINED') return false;
    const atR143 =
      this.runtimeRevision === 143 &&
      metab?.version === '0.2.0-p1r0-shadow.1' && metab?.stateSchema === 2 &&
      metab?.moduleRelativePath === 'cores/p1-r0/metab-shadow/index.js' &&
      homeos.version === '0.1.0-p1r0-neutral.1' && homeos.stateSchema === 1 &&
      homeos.moduleRelativePath === 'cores/p1-r0/homeos-neutral/index.js';
    const atR144 =
      this.runtimeRevision === 144 &&
      metab?.version === '0.3.0-p1r0-homeos-feed.1' && metab?.stateSchema === 3 &&
      metab?.moduleRelativePath === 'cores/p1-r0/metab-homeos/index.js' &&
      homeos.version === '0.1.0-p1r0-neutral.1' && homeos.stateSchema === 1 &&
      homeos.moduleRelativePath === 'cores/p1-r0/homeos-neutral/index.js';
    return atR143 || atR144;
  }

  isExactStrandedHomeosRecovery(preserveRevision) {
    if (preserveRevision !== true || this.homeosStrandedR145RecoveryActive !== true) {
      return false;
    }
    if (this.runtimeRevision === 145 && this.homeosStrandedRecoveryRevision === 145) {
      return this.homeosStrandedR145RecoveryAuthorization ===
        R145_HOMEOS_SHADOW.strandedRecoveryAuthorization;
    }
    return this.runtimeRevision === 146 &&
      this.homeosStrandedRecoveryRevision === 146 &&
      this.metabQ48R146RecoveryActive === true &&
      this.homeosStrandedR146RecoveryAuthorization ===
        R146_METAB_Q48_HOMEOS_RECOVERY.authorization;
  }

  preserveExactR150InteroProgressRevision() {
    if (
      this.interoNeutralBirthAuthorization !== R150_INTERO_SHADOW.birthAuthorization ||
      this.metabInteroRouteAuthorization !== R150_INTERO_SHADOW.metabRouteAuthorization ||
      this.homeosInteroRouteAuthorization !== R150_INTERO_SHADOW.homeosRouteAuthorization ||
      this.interoShadowPromotionAuthorization !== R150_INTERO_SHADOW.shadowAuthorization
    ) return false;
    const metab = this.stateStore.getResident('resident:metab');
    const homeos = this.stateStore.getResident('resident:homeos');
    const intero = this.stateStore.getResident('resident:intero');
    const authorityPresent = this.stateStore.listAuthority().some(entry =>
      ['METAB', 'HOMEOS', 'INTERO'].includes(entry.coreId)
    );
    if (
      authorityPresent || !metab || !homeos || !intero ||
      [metab, homeos, intero].some(resident =>
        resident.status === 'QUARANTINED' || resident.status === 'RESYNC_REQUIRED'
      )
    ) return false;
    const interoNeutral =
      intero.version === '0.1.0-p1r0-neutral.1' && intero.stateSchema === 1 &&
      intero.moduleRelativePath === 'cores/p1-r0/intero-neutral/index.js';
    const atR147 =
      this.runtimeRevision === 147 && interoNeutral &&
      metab.version === '0.3.0-p1r0-homeos-feed.1' && metab.stateSchema === 3 &&
      metab.moduleRelativePath === 'cores/p1-r0/metab-homeos/index.js' &&
      homeos.version === '0.2.0-p1r0-shadow.1' && homeos.stateSchema === 2 &&
      homeos.moduleRelativePath === 'cores/p1-r0/homeos-shadow/index.js';
    const metabIntero =
      metab.version === '0.4.0-p1r0-intero-feed.1' && metab.stateSchema === 4 &&
      metab.moduleRelativePath === 'cores/p1-r0/metab-intero/index.js';
    const atR148 =
      this.runtimeRevision === 148 && interoNeutral && metabIntero &&
      homeos.version === '0.2.0-p1r0-shadow.1' && homeos.stateSchema === 2 &&
      homeos.moduleRelativePath === 'cores/p1-r0/homeos-shadow/index.js';
    const atR149 =
      this.runtimeRevision === 149 && interoNeutral && metabIntero &&
      homeos.version === '0.3.0-p1r0-intero-feed.1' && homeos.stateSchema === 3 &&
      homeos.moduleRelativePath === 'cores/p1-r0/homeos-intero/index.js';
    return atR147 || atR148 || atR149;
  }

  async restoreTrustedPulseSequencesFromDurableState() {
    const ledgerMaximum = (topic) => {
      const prefix = `${topic}:${this.runtimeRevision}:`;
      let maximum = 0;
      for (const row of this.stateStore.db.prepare(`
        SELECT deduplication_key FROM biological_events
        WHERE topic=? AND deduplication_key LIKE ?
      `).all(topic, `${prefix}%`)) {
        const suffix = String(row.deduplication_key || '').slice(prefix.length);
        if (/^[1-9][0-9]*$/.test(suffix)) maximum = Math.max(maximum, Number(suffix));
      }
      return Number.isSafeInteger(maximum) ? maximum : 0;
    };

    let sntssSequence = ledgerMaximum('runtime.time.pulse');
    let chronobiologySequence = ledgerMaximum('runtime.trusted-organism-time.pulse');
    const sntss = await this.stateStore.readResidentCheckpoint('resident:sntss');
    const chronobiology = await this.stateStore.readResidentCheckpoint('resident:chronobiology');
    if (sntss?.state?.trustedTime?.lastRuntimeRevision === this.runtimeRevision) {
      sntssSequence = Math.max(sntssSequence, Number(sntss.state.trustedTime.lastPulseSequence) || 0);
    }
    if (chronobiology?.state?.continuity?.last_runtime_revision === this.runtimeRevision) {
      chronobiologySequence = Math.max(
        chronobiologySequence,
        Number(chronobiology.state.continuity.last_trusted_pulse_sequence) || 0
      );
    }
    if (!Number.isSafeInteger(sntssSequence) || sntssSequence < 0 ||
        !Number.isSafeInteger(chronobiologySequence) || chronobiologySequence < 0) {
      throw Object.assign(new Error('durable trusted pulse sequence is invalid'), {
        code: 'TRUSTED_PULSE_SEQUENCE_INVALID'
      });
    }
    this.trustedTimePulseSequence = Math.max(this.trustedTimePulseSequence, sntssSequence);
    this.trustedOrganismTimePulseSequence = Math.max(
      this.trustedOrganismTimePulseSequence,
      chronobiologySequence
    );
    return Object.freeze({
      trustedTimePulseSequence: this.trustedTimePulseSequence,
      trustedOrganismTimePulseSequence: this.trustedOrganismTimePulseSequence
    });
  }

  async repairExactR146FetusEmptyInputContinuity() {
    const authorizedR146 = this.fetusEmptyInputR146RecoveryActive === true &&
      this.homeosFinalR146RecoveryActive === true &&
      this.runtimeRevision === R146_METAB_Q48_HOMEOS_RECOVERY.runtimeRevision &&
      this.homeosStrandedR146RecoveryAuthorization === R146_METAB_Q48_HOMEOS_RECOVERY.authorization;
    const authorizedR147 = this.fetusEmptyInputR147RecoveryActive === true &&
      this.homeosFinalR147RecoveryActive === true &&
      this.runtimeRevision === R147_HOMEOS_FORWARD_RECOVERY.runtimeRevision &&
      [
        R147_HOMEOS_FORWARD_RECOVERY.authorization,
        R147_HOMEOS_CONTINUATION_RECOVERY.authorization
      ].includes(this.homeosStrandedR147RecoveryAuthorization);
    if (!authorizedR146 && !authorizedR147) {
      throw Object.assign(
        new Error('R146 fetus empty-input continuity recovery is not authorized'),
        { code: 'P1_R146_FETUS_CONTINUITY_AUTHORIZATION' }
      );
    }
    const expected = R146_METAB_Q48_HOMEOS_RECOVERY.fetus;
    const cohort = this.exactR146FetusContinuityCohort();
    if (!cohort.valid) {
      throw Object.assign(
        new Error('R146 fetus empty-input continuity cohort changed'),
        { code: 'P1_R146_FETUS_CONTINUITY_COHORT' }
      );
    }
    if (cohort.resolved) {
      return Object.freeze({ ...cohort.resolutionDetail, idempotent: true });
    }
    const checkpointBytes = await this.stateStore.readBlob(expected.checkpointHash);
    if (
      checkpointBytes.length !== expected.checkpointBytes ||
      crypto.createHash('sha256').update(checkpointBytes).digest('hex') !== expected.checkpointHash
    ) {
      throw Object.assign(
        new Error('R146 fetus authority checkpoint bytes changed'),
        { code: 'P1_R146_FETUS_CONTINUITY_CHECKPOINT' }
      );
    }
    const assignedAfterCursor = Number(this.stateStore.db.prepare(`
      SELECT COUNT(*) count FROM biological_deliveries
      WHERE consumer_id=? AND sequence>?
    `).get(expected.consumerId, expected.consumerCursor)?.count || 0);
    if (assignedAfterCursor !== 0) {
      throw Object.assign(
        new Error('R146 fetus empty-input interval contains assigned biology'),
        { code: 'P1_R146_FETUS_CONTINUITY_INPUT' }
      );
    }
    const highWater = Number(this.stateStore.db.prepare(`
      SELECT COALESCE(MAX(sequence),0) value FROM biological_events
    `).get()?.value || 0);
    if (!Number.isSafeInteger(highWater) || highWater < expected.consumerCursor) {
      throw Object.assign(
        new Error('R146 fetus empty-input high-water mark is invalid'),
        { code: 'P1_R146_FETUS_CONTINUITY_LEDGER' }
      );
    }
    const at = new Date().toISOString();
    const detail = {
      cohort: 'r146-fetus-empty-input-continuity-v1',
      demotionId: expected.demotionId,
      consumerId: expected.consumerId,
      fromCursor: expected.consumerCursor,
      toCursor: highWater,
      quarantinedPendingAtDemotion: expected.pendingAtDemotion,
      retainedPendingAtRecovery: 0,
      inputs: [],
      checkpointHash: expected.checkpointHash,
      checkpointGeneration: expected.checkpointGeneration,
      checkpointBytesChanged: false,
      biologicalStateChanged: false,
      physiologyApplied: 0,
      abandonedCount: 0,
      inventedBiologicalTime: false,
      authorityChanged: false,
      runtimeRevision: this.runtimeRevision
    };
    const repaired = this.stateStore.withTransaction(() => {
      const current = this.exactR146FetusContinuityCohort();
      if (!current.unresolved) {
        throw Object.assign(
          new Error('R146 fetus continuity compare-and-swap lost its cohort'),
          { code: 'P1_R146_FETUS_CONTINUITY_ATOMIC' }
        );
      }
      const changed = this.stateStore.db.prepare(`
        UPDATE biological_consumers
        SET cursor=?,checkpoint_hash=?,updated_at=?
        WHERE consumer_id=? AND core_id=? AND active=0 AND required=0
          AND topics_json='[]' AND topics_sha256=? AND cursor=?
          AND authority_epoch=? AND checkpoint_hash=?
      `).run(
        highWater,
        expected.checkpointHash,
        at,
        expected.consumerId,
        expected.coreId,
        expected.topicsHash,
        expected.consumerCursor,
        expected.authorityEpoch,
        expected.priorConsumerCheckpointHash
      );
      if (changed.changes !== 1) {
        throw Object.assign(
          new Error('R146 fetus continuity cursor update was not atomic'),
          { code: 'P1_R146_FETUS_CONTINUITY_ATOMIC' }
        );
      }
      this.stateStore.db.prepare(`
        INSERT INTO recovery_records(type,core_id,detail_json,created_at)
        VALUES('biological.consumer-resynchronized',?,?,?)
      `).run(expected.coreId, JSON.stringify(detail), at);
      const after = this.exactR146FetusContinuityCohort();
      if (!after.resolved) {
        throw Object.assign(
          new Error('R146 fetus continuity evidence did not seal'),
          { code: 'P1_R146_FETUS_CONTINUITY_ATOMIC' }
        );
      }
      return detail;
    });
    this.statusCache = null;
    return Object.freeze(repaired);
  }


  async repairExactR127PostRestartContinuity() {
    if (
      !this.metabNeutralRecoveryRevisionPreserved ||
      this.runtimeRevision !== 127 ||
      this.r127PostRestartContinuityAuthorization !==
        R127_POST_RESTART_CONTINUITY.authorization
    ) {
      throw Object.assign(new Error('R127 post-restart continuity recovery is not authorized'), {
        code: 'P1_R127_POST_RESTART_AUTHORIZATION'
      });
    }

    const existing = this.stateStore.db.prepare(`
      SELECT detail_json FROM recovery_records
      WHERE type='runtime.r127-post-restart-continuity-recovered'
      ORDER BY id DESC LIMIT 1
    `).get();
    if (existing) {
      const detail = JSON.parse(existing.detail_json || '{}');
      if (detail.cohort !== 'r127-post-restart-continuity-v1' || detail.abandonedCount !== 0 ||
          detail.inventedBiologicalTime !== false || detail.authorityChanged !== false) {
        throw Object.assign(new Error('R127 post-restart continuity evidence is invalid'), {
          code: 'P1_R127_POST_RESTART_EVIDENCE'
        });
      }
      return Object.freeze({ ...detail, idempotent: true });
    }

    const residentProof = async (expected) => {
      const resident = this.stateStore.getResident(expected.residencyId);
      const consumer = this.stateStore.getBiologicalConsumer(expected.residencyId);
      const checkpoint = await this.stateStore.readResidentCheckpoint(expected.residencyId);
      const delivery = this.stateStore.db.prepare(`
        SELECT d.status, e.topic, e.deduplication_key, e.envelope_json
        FROM biological_deliveries d JOIN biological_events e ON e.sequence=d.sequence
        WHERE d.consumer_id=? AND d.sequence=?
      `).get(expected.residencyId, expected.pendingSequence);
      const recovery = this.stateStore.db.prepare(`
        SELECT id, detail_json FROM recovery_records WHERE id=? AND type='resident.resync-required'
          AND core_id=?
      `).get(expected.recoveryRecordId, expected.coreId);
      let recoveryDetail = null;
      let envelope = null;
      try {
        recoveryDetail = JSON.parse(recovery?.detail_json || 'null');
        envelope = JSON.parse(delivery?.envelope_json || 'null');
      } catch {}
      const pendingCount = this.stateStore.countPendingBiologicalEvents(expected.residencyId);
      if (!(resident?.coreId === expected.coreId && resident?.instanceId === expected.instanceId &&
        resident?.version === expected.version && resident?.status === 'RESYNC_REQUIRED' &&
        resident?.checkpointGeneration === expected.checkpointGeneration &&
        resident?.checkpointHash === expected.checkpointHash &&
        checkpoint?.generation === expected.checkpointGeneration &&
        checkpoint?.blobHash === expected.checkpointHash &&
        checkpoint?.inputCursor === expected.inputCursor &&
        consumer?.active === false && consumer?.required === false &&
        consumer?.authorityEpoch === 0 && consumer?.cursor === expected.consumerCursor &&
        consumer?.checkpointHash === expected.checkpointHash &&
        stableStringify(consumer?.topics) === stableStringify(expected.topics) &&
        consumer?.topicsHash === expected.topicsHash && pendingCount === 1 &&
        delivery?.status === 'PENDING' && delivery?.topic === expected.topic &&
        delivery?.deduplication_key === `${expected.topic}:127:${expected.pulseSequence}` &&
        envelope?.payload?.runtimeRevision === 127 &&
        envelope?.payload?.pulseSequence === expected.pulseSequence &&
        recovery?.id === expected.recoveryRecordId &&
        recoveryDetail?.residencyId === expected.residencyId &&
        recoveryDetail?.sequence === expected.pendingSequence &&
        recoveryDetail?.code === expected.recoveryCode)) {
        throw Object.assign(new Error(`R127 restart pulse cohort mismatch: ${expected.residencyId}`), {
          code: 'P1_R127_POST_RESTART_RESIDENT'
        });
      }
      const durableLastPulse = expected.coreId === 'sntss'
        ? checkpoint.state?.trustedTime?.lastPulseSequence
        : checkpoint.state?.continuity?.last_trusted_pulse_sequence;
      const durableRevision = expected.coreId === 'sntss'
        ? checkpoint.state?.trustedTime?.lastRuntimeRevision
        : checkpoint.state?.continuity?.last_runtime_revision;
      if (durableRevision !== 127 || durableLastPulse !== expected.lastPulseSequence ||
          expected.pulseSequence >= durableLastPulse) {
        throw Object.assign(new Error(`R127 durable pulse fence mismatch: ${expected.residencyId}`), {
          code: 'P1_R127_POST_RESTART_PULSE'
        });
      }
      return { resident, consumer, checkpoint, delivery, recoveryDetail };
    };

    const sntss = await residentProof(R127_POST_RESTART_CONTINUITY.sntss);
    const chronobiology = await residentProof(R127_POST_RESTART_CONTINUITY.chronobiology);
    const fetusExpected = R127_POST_RESTART_CONTINUITY.fetus;
    const fetusConsumer = this.stateStore.getBiologicalConsumer(fetusExpected.consumerId);
    const fetusAuthority = this.stateStore.db.prepare(
      'SELECT * FROM authority WHERE core_id=?'
    ).get(fetusExpected.coreId);
    const fetusCheckpoint = this.stateStore.db.prepare(`
      SELECT * FROM checkpoints WHERE core_id=? ORDER BY generation DESC LIMIT 1
    `).get(fetusExpected.coreId);
    const fetusDemotion = this.stateStore.db.prepare(`
      SELECT id, detail_json FROM recovery_records
      WHERE id=? AND type='biological.consumer-demoted' AND core_id=?
    `).get(fetusExpected.demotionId, fetusExpected.coreId);
    let fetusDemotionDetail = null;
    try { fetusDemotionDetail = JSON.parse(fetusDemotion?.detail_json || 'null'); } catch {}
    const fetusPending = this.stateStore.countPendingBiologicalEvents(fetusExpected.consumerId);
    if (!(fetusConsumer?.coreId === fetusExpected.coreId && fetusConsumer?.active === false &&
      fetusConsumer?.required === false && fetusConsumer?.cursor === fetusExpected.consumerCursor &&
      fetusConsumer?.authorityEpoch === fetusExpected.authorityEpoch &&
      fetusConsumer?.checkpointHash === null &&
      stableStringify(fetusConsumer?.topics) === '[]' &&
      fetusConsumer?.topicsHash === fetusExpected.topicsHash && fetusPending === 0 &&
      fetusAuthority?.instance_id === fetusExpected.instanceId &&
      fetusAuthority?.version === fetusExpected.version &&
      Number(fetusAuthority?.epoch) === fetusExpected.authorityEpoch &&
      fetusAuthority?.checkpoint_hash === fetusExpected.checkpointHash &&
      Number(fetusCheckpoint?.generation) === fetusExpected.checkpointGeneration &&
      fetusCheckpoint?.blob_hash === fetusExpected.checkpointHash &&
      fetusDemotion?.id === fetusExpected.demotionId &&
      fetusDemotionDetail?.consumerId === fetusExpected.consumerId &&
      fetusDemotionDetail?.cursor === fetusExpected.consumerCursor &&
      fetusDemotionDetail?.pending === fetusExpected.pendingAtDemotion &&
      fetusDemotionDetail?.maximumDebt === fetusExpected.maximumDebt &&
      fetusDemotionDetail?.resynchronizationRequired === true)) {
      throw Object.assign(new Error('R127 fetus continuity cohort mismatch'), {
        code: 'P1_R127_POST_RESTART_FETUS'
      });
    }

    const totalPending = Number(this.stateStore.db.prepare(`
      SELECT COUNT(*) AS count FROM biological_deliveries WHERE status='PENDING'
    `).get()?.count || 0);
    const highWater = Number(this.stateStore.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS value FROM biological_events
    `).get()?.value || 0);
    if (
      totalPending !== 2 ||
      highWater !== R127_POST_RESTART_CONTINUITY.ledger.highWater
    ) {
      throw Object.assign(new Error('R127 post-restart ledger cohort mismatch'), {
        code: 'P1_R127_POST_RESTART_LEDGER'
      });
    }

    const cohortEvents = this.stateStore.db.prepare(`
      SELECT sequence, event_id, topic, event_class, envelope_json, deduplication_key
      FROM biological_events WHERE sequence>=? AND sequence<=? ORDER BY sequence
    `).all(
      R127_POST_RESTART_CONTINUITY.ledger.cohortFirstSequence,
      highWater
    );
    const expectedCohortLength =
      highWater - R127_POST_RESTART_CONTINUITY.ledger.cohortFirstSequence + 1;
    const pulseCounts = new Map([
      ['runtime.time.pulse', 0],
      ['runtime.trusted-organism-time.pulse', 0]
    ]);
    if (cohortEvents.length !== expectedCohortLength) {
      throw Object.assign(new Error('R127 restart pulse cohort is not contiguous'), {
        code: 'P1_R127_POST_RESTART_LEDGER'
      });
    }
    for (const row of cohortEvents) {
      if (!pulseCounts.has(row.topic) || row.event_class !== 'durable') {
        throw Object.assign(new Error('R127 restart cohort contains an unexpected event'), {
          code: 'P1_R127_POST_RESTART_LEDGER'
        });
      }
      let envelope = null;
      try { envelope = JSON.parse(row.envelope_json); } catch {}
      const pulseSequence = pulseCounts.get(row.topic) + 1;
      if (
        envelope?.id !== row.event_id ||
        envelope?.sequence !== Number(row.sequence) ||
        envelope?.topic !== row.topic ||
        envelope?.payload?.runtimeRevision !== 127 ||
        envelope?.payload?.pulseSequence !== pulseSequence ||
        envelope?.meta?.sourceCore !== 'living-kernel' ||
        row.deduplication_key !== `${row.topic}:127:${pulseSequence}`
      ) {
        throw Object.assign(new Error('R127 restart pulse envelope fence mismatch'), {
          code: 'P1_R127_POST_RESTART_LEDGER'
        });
      }
      pulseCounts.set(row.topic, pulseSequence);
    }
    if (
      pulseCounts.get('runtime.time.pulse') !==
        R127_POST_RESTART_CONTINUITY.ledger.timePulseCount ||
      pulseCounts.get('runtime.trusted-organism-time.pulse') !==
        R127_POST_RESTART_CONTINUITY.ledger.trustedOrganismTimePulseCount
    ) {
      throw Object.assign(new Error('R127 restart pulse counts do not match the sealed cohort'), {
        code: 'P1_R127_POST_RESTART_LEDGER'
      });
    }

    const at = new Date().toISOString();
    const repaired = this.stateStore.withTransaction(() => {
      for (const [expected, proof] of [
        [R127_POST_RESTART_CONTINUITY.chronobiology, chronobiology],
        [R127_POST_RESTART_CONTINUITY.sntss, sntss]
      ]) {
        const transitionId = `r127-restart-pulse-superseded:${expected.pendingSequence}`;
        const changed = this.stateStore.db.prepare(`
          UPDATE biological_deliveries SET status='ACKED', transition_id=?, checkpoint_hash=?,
            acknowledged_at=? WHERE consumer_id=? AND sequence=? AND status='PENDING'
        `).run(transitionId, expected.checkpointHash, at, expected.residencyId,
          expected.pendingSequence).changes;
        if (changed !== 1) throw new Error('R127 restart pulse acknowledgement was not atomic');
        const cursorChanged = this.stateStore.db.prepare(`
          UPDATE biological_consumers SET cursor=?, updated_at=?
          WHERE consumer_id=? AND cursor=?
        `).run(highWater, at, expected.residencyId, expected.consumerCursor).changes;
        if (cursorChanged !== 1) throw new Error('R127 restart cursor fence was not atomic');
        const statusChanged = this.stateStore.db.prepare(`
          UPDATE resident_instances SET status='RECOVERING', updated_at=?
          WHERE residency_id=? AND status='RESYNC_REQUIRED'
        `).run(at, expected.residencyId).changes;
        if (statusChanged !== 1) throw new Error('R127 resident recovery fence was not atomic');
        this.stateStore.db.prepare(`
          INSERT INTO recovery_records(type, core_id, detail_json, created_at)
          VALUES('resident.restart-pulse-superseded', ?, ?, ?)
        `).run(expected.coreId, JSON.stringify({
          cohort: 'r127-post-restart-continuity-v1',
          residencyId: expected.residencyId,
          sourceRecoveryRecordId: expected.recoveryRecordId,
          sequence: expected.pendingSequence,
          fromCursor: expected.consumerCursor,
          toCursor: highWater,
          topic: expected.topic,
          rejectedPulseSequence: expected.pulseSequence,
          durableLastPulseSequence: expected.lastPulseSequence,
          supersededInputCount: expected.coreId === 'sntss'
            ? R127_POST_RESTART_CONTINUITY.ledger.timePulseCount
            : R127_POST_RESTART_CONTINUITY.ledger.trustedOrganismTimePulseCount,
          nonInputEventCount: expected.coreId === 'sntss'
            ? R127_POST_RESTART_CONTINUITY.ledger.trustedOrganismTimePulseCount - 1
            : R127_POST_RESTART_CONTINUITY.ledger.timePulseCount,
          checkpointHash: expected.checkpointHash,
          checkpointGeneration: expected.checkpointGeneration,
          checkpointBytesChanged: false,
          biologicalStateChanged: false,
          abandonedCount: 0,
          inventedBiologicalTime: false,
          authorityChanged: false
        }), at);
        void proof;
      }

      const fetusChanged = this.stateStore.db.prepare(`
        UPDATE biological_consumers SET cursor=?, checkpoint_hash=?, updated_at=?
        WHERE consumer_id=? AND active=0 AND required=0 AND cursor=?
      `).run(highWater, fetusExpected.checkpointHash, at, fetusExpected.consumerId,
        fetusExpected.consumerCursor).changes;
      if (fetusChanged !== 1) throw new Error('R127 fetus continuity anchor was not atomic');
      const fetusDetail = {
        cohort: 'r127-post-restart-continuity-v1',
        demotionId: fetusExpected.demotionId,
        consumerId: fetusExpected.consumerId,
        fromCursor: fetusExpected.consumerCursor,
        toCursor: highWater,
        quarantinedPendingAtDemotion: fetusExpected.pendingAtDemotion,
        retainedPendingAtRecovery: 0,
        inputs: [],
        checkpointHash: fetusExpected.checkpointHash,
        checkpointGeneration: fetusExpected.checkpointGeneration,
        checkpointBytesChanged: false,
        biologicalStateChanged: false,
        physiologyApplied: 0,
        abandonedCount: 0,
        inventedBiologicalTime: false,
        authorityChanged: false,
        runtimeRevision: 127
      };
      this.stateStore.db.prepare(`
        INSERT INTO recovery_records(type, core_id, detail_json, created_at)
        VALUES('biological.consumer-resynchronized', ?, ?, ?)
      `).run(fetusExpected.coreId, JSON.stringify(fetusDetail), at);
      const detail = {
        cohort: 'r127-post-restart-continuity-v1',
        runtimeRevision: 127,
        fetusDemotionId: fetusExpected.demotionId,
        fetusFromCursor: fetusExpected.consumerCursor,
        fetusToCursor: highWater,
        sntssCheckpointHash: R127_POST_RESTART_CONTINUITY.sntss.checkpointHash,
        chronobiologyCheckpointHash: R127_POST_RESTART_CONTINUITY.chronobiology.checkpointHash,
        acknowledgedPendingDeliveryCount: 2,
        supersededInputPulseCount:
          R127_POST_RESTART_CONTINUITY.ledger.timePulseCount +
          R127_POST_RESTART_CONTINUITY.ledger.trustedOrganismTimePulseCount,
        nonInputEventCount:
          R127_POST_RESTART_CONTINUITY.ledger.timePulseCount +
          R127_POST_RESTART_CONTINUITY.ledger.trustedOrganismTimePulseCount - 1,
        abandonedCount: 0,
        inventedBiologicalTime: false,
        authorityChanged: false
      };
      this.stateStore.db.prepare(`
        INSERT INTO recovery_records(type, core_id, detail_json, created_at)
        VALUES('runtime.r127-post-restart-continuity-recovered', NULL, ?, ?)
      `).run(JSON.stringify(detail), at);
      return detail;
    });
    this.statusCache = null;
    return Object.freeze(repaired);
  }

  async completeExactR127PostRestartResidentRecovery({
    ordinaryRecovery,
    coldRecovery
  }) {
    if (
      !this.r127PostRestartContinuityRecovery ||
      !this.metabNeutralRecoveryRevisionPreserved ||
      this.runtimeRevision !== 127 ||
      !Array.isArray(ordinaryRecovery) ||
      !Array.isArray(coldRecovery)
    ) {
      throw Object.assign(new Error('R127 resident recovery completion is not authorized'), {
        code: 'P1_R127_POST_RESTART_RESIDENT_COMPLETION'
      });
    }

    const durableResidents = this.stateStore.listResidents();
    const recovered = new Map(ordinaryRecovery.map(row => [row.residencyId, row]));
    const expectedResidents = [
      {
        ...R127_POST_RESTART_CONTINUITY.sntss,
        checkpointGeneration: R127_POST_RESTART_CONTINUITY.sntss.checkpointGeneration + 1
      },
      {
        ...R127_POST_RESTART_CONTINUITY.chronobiology,
        checkpointGeneration:
          R127_POST_RESTART_CONTINUITY.chronobiology.checkpointGeneration + 1
      },
      {
        ...R127_POST_RESTART_CONTINUITY.metab,
        coreId: 'METAB',
        checkpointGeneration: 2,
        consumerCursor: R127_POST_RESTART_CONTINUITY.ledger.highWater,
        topics: ['runtime.organism.binding'],
        mode: 'NEUTRAL'
      }
    ];
    if (durableResidents.length !== expectedResidents.length || coldRecovery.length !== 0) {
      throw Object.assign(new Error('R127 recovered resident set is not exact'), {
        code: 'P1_R127_POST_RESTART_RESIDENT_COMPLETION'
      });
    }

    for (const expected of expectedResidents) {
      const result = recovered.get(expected.residencyId);
      const durable = this.stateStore.getResident(expected.residencyId);
      const consumer = this.stateStore.getBiologicalConsumer(expected.residencyId);
      const runtime = await this.ensureResidentManager().status(expected.residencyId);
      if (!(result?.recovered === true && result?.status === 'RUNNING' &&
        durable?.coreId === expected.coreId && durable?.instanceId === expected.instanceId &&
        durable?.version === expected.version && durable?.status === 'RUNNING' &&
        durable?.checkpointGeneration === expected.checkpointGeneration &&
        durable?.checkpointHash === expected.checkpointHash &&
        runtime?.status === 'RUNNING' && runtime?.running === true &&
        runtime?.checkpointGeneration === expected.checkpointGeneration &&
        runtime?.checkpointHash === expected.checkpointHash &&
        runtime?.pendingDeliveries === 0 && runtime?.observedOutputs === 0 &&
        runtime?.authorityOwned === false && runtime?.activationBackfilled === 0 &&
        consumer?.active === true && consumer?.required === false &&
        consumer?.authorityEpoch === 0 &&
        consumer?.cursor === R127_POST_RESTART_CONTINUITY.ledger.highWater &&
        stableStringify(consumer?.topics) === stableStringify(expected.topics))) {
        throw Object.assign(
          new Error(`R127 resident recovery completion mismatch: ${expected.residencyId}`),
          { code: 'P1_R127_POST_RESTART_RESIDENT_COMPLETION' }
        );
      }
      if (expected.mode && runtime?.health?.mode !== expected.mode) {
        throw Object.assign(new Error('R127 METAB recovery lost neutral containment'), {
          code: 'P1_R127_POST_RESTART_RESIDENT_COMPLETION'
        });
      }
    }

    const pending = Number(this.stateStore.db.prepare(`
      SELECT COUNT(*) AS count FROM biological_deliveries WHERE status='PENDING'
    `).get()?.count || 0);
    const p1Authority = this.stateStore.listAuthority().filter(row =>
      ['METAB', 'HOMEOS', 'INTERO'].includes(row.coreId)
    );
    if (pending !== 0 || p1Authority.length !== 0) {
      throw Object.assign(new Error('R127 resident recovery containment failed'), {
        code: 'P1_R127_POST_RESTART_RESIDENT_COMPLETION'
      });
    }

    this.metabNeutralRecoveryCompletedAtPreservedRevision = true;
    await this.stateStore.appendJournal({
      type: 'runtime.r127-post-restart-residents-recovered',
      at: new Date().toISOString(),
      runtimeRevision: 127,
      cohort: 'r127-post-restart-continuity-v1',
      residents: expectedResidents.map(row => row.residencyId),
      pendingDeliveries: 0,
      p1AuthorityCount: 0,
      abandonedCount: 0,
      inventedBiologicalTime: false,
      authorityChanged: false
    });
  }

  async anchorExactR127PostRestartTrustedTime() {
    if (!this.r127PostRestartContinuityRecovery) return null;
    if (
      !this.metabNeutralRecoveryRevisionPreserved ||
      !this.metabNeutralRecoveryCompletedAtPreservedRevision ||
      this.runtimeRevision !== 127 ||
      this.trustedTimePulseSequence !==
        R127_POST_RESTART_CONTINUITY.sntss.lastPulseSequence
    ) {
      throw Object.assign(
        new Error('R127 trusted-time restart anchor is outside its exact recovery fence'),
        { code: 'P1_R127_POST_RESTART_TIME_ANCHOR' }
      );
    }

    const expected = R127_POST_RESTART_CONTINUITY.sntss;
    const manager = this.ensureResidentManager();
    await manager.drain(
      expected.residencyId,
      R127_POST_RESTART_CONTINUITY.ledger.highWater
    );
    const beforeResident = this.stateStore.getResident(expected.residencyId);
    const beforeConsumer = this.stateStore.getBiologicalConsumer(expected.residencyId);
    const beforeCheckpoint = await this.stateStore.readResidentCheckpoint(expected.residencyId);
    const beforeStatus = await manager.status(expected.residencyId);
    const beforeTime = beforeCheckpoint?.state?.trustedTime;
    const recoveryCheckpoints = this.stateStore.db.prepare(`
      SELECT generation, blob_hash, input_cursor
      FROM resident_checkpoints
      WHERE residency_id=? AND generation>?
      ORDER BY generation
    `).all(expected.residencyId, expected.checkpointGeneration);
    const recoveryCheckpointSetIsExact =
      recoveryCheckpoints.length >= 1 && recoveryCheckpoints.length <= 2 &&
      recoveryCheckpoints.every((row, index) =>
        Number(row.generation) === expected.checkpointGeneration + index + 1 &&
        row.blob_hash === expected.checkpointHash &&
        Number(row.input_cursor) === expected.inputCursor
      );
    const beforeHighWater = Number(this.stateStore.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS value FROM biological_events
    `).get()?.value || 0);
    if (!(beforeResident?.status === 'RUNNING' &&
      recoveryCheckpointSetIsExact &&
      beforeResident?.checkpointGeneration === beforeCheckpoint?.generation &&
      beforeResident?.checkpointHash === expected.checkpointHash &&
      beforeConsumer?.active === true && beforeConsumer?.required === false &&
      beforeConsumer?.authorityEpoch === 0 &&
      beforeConsumer?.cursor === R127_POST_RESTART_CONTINUITY.ledger.highWater &&
      beforeConsumer?.checkpointHash === expected.checkpointHash &&
      beforeCheckpoint?.generation ===
        Number(recoveryCheckpoints[recoveryCheckpoints.length - 1]?.generation) &&
      beforeCheckpoint?.blobHash === expected.checkpointHash &&
      beforeCheckpoint?.inputCursor === expected.inputCursor &&
      beforeStatus?.status === 'RUNNING' && beforeStatus?.running === true &&
      beforeStatus?.checkpointGeneration === beforeCheckpoint?.generation &&
      beforeStatus?.checkpointHash === expected.checkpointHash &&
      beforeStatus?.pendingDeliveries === 0 && beforeStatus?.observedOutputs === 0 &&
      beforeStatus?.authorityOwned === false && beforeStatus?.lastError === null &&
      beforeTime?.lastRuntimeRevision === 127 &&
      beforeTime?.lastPulseSequence === expected.lastPulseSequence &&
      beforeTime?.lastClockStatus === 'trusted' &&
      Number.isSafeInteger(beforeTime?.lastWallClockMs) &&
      Number.isSafeInteger(beforeTime?.acceptedPulses) &&
      Number.isSafeInteger(beforeTime?.integratedIntervals) &&
      beforeHighWater === R127_POST_RESTART_CONTINUITY.ledger.highWater)) {
      throw Object.assign(new Error('R127 trusted-time restart anchor precondition mismatch'), {
        code: 'P1_R127_POST_RESTART_TIME_ANCHOR'
      });
    }

    const physiologyProjectionHash = state => {
      const {
        lastWallClockMs,
        lastPulseSequence,
        lastRuntimeRevision,
        lastClockStatus,
        acceptedPulses,
        ...preservedTrustedTime
      } = state.trustedTime;
      void lastWallClockMs;
      void lastPulseSequence;
      void lastRuntimeRevision;
      void lastClockStatus;
      void acceptedPulses;
      return sha256Bytes(stableStringify({
        ...state,
        trustedTime: preservedTrustedTime
      }));
    };
    const beforePhysiologyHash = physiologyProjectionHash(beforeCheckpoint.state);

    await this.publishTimePulse('uncertain');
    await manager.drain(expected.residencyId, beforeHighWater + 1);

    const afterResident = this.stateStore.getResident(expected.residencyId);
    const afterConsumer = this.stateStore.getBiologicalConsumer(expected.residencyId);
    const afterCheckpoint = await this.stateStore.readResidentCheckpoint(expected.residencyId);
    const afterStatus = await manager.status(expected.residencyId);
    const afterTime = afterCheckpoint?.state?.trustedTime;
    const expectedSequence = beforeHighWater + 1;
    const anchorCheckpoints = this.stateStore.db.prepare(`
      SELECT generation, blob_hash, input_cursor
      FROM resident_checkpoints
      WHERE residency_id=? AND generation>?
      ORDER BY generation
    `).all(expected.residencyId, beforeCheckpoint.generation);
    const anchorCheckpointSetIsExact =
      anchorCheckpoints.length >= 1 && anchorCheckpoints.length <= 2 &&
      anchorCheckpoints.every((row, index) =>
        Number(row.generation) === beforeCheckpoint.generation + index + 1 &&
        row.blob_hash === afterCheckpoint?.blobHash &&
        Number(row.input_cursor) === expectedSequence
      );
    const event = this.stateStore.db.prepare(`
      SELECT topic, event_class, deduplication_key, envelope_json
      FROM biological_events WHERE sequence=?
    `).get(expectedSequence);
    let envelope = null;
    try { envelope = JSON.parse(event?.envelope_json || 'null'); } catch {}
    const afterPhysiologyHash = afterCheckpoint?.state
      ? physiologyProjectionHash(afterCheckpoint.state)
      : null;
    if (!(afterResident?.status === 'RUNNING' &&
      anchorCheckpointSetIsExact &&
      afterResident?.checkpointGeneration === afterCheckpoint?.generation &&
      afterResident?.checkpointHash === afterCheckpoint?.blobHash &&
      afterResident?.checkpointHash !== expected.checkpointHash &&
      afterConsumer?.active === true && afterConsumer?.required === false &&
      afterConsumer?.authorityEpoch === 0 && afterConsumer?.cursor === expectedSequence &&
      afterConsumer?.checkpointHash === afterCheckpoint?.blobHash &&
      afterCheckpoint?.generation ===
        Number(anchorCheckpoints[anchorCheckpoints.length - 1]?.generation) &&
      afterCheckpoint?.inputCursor === expectedSequence &&
      afterStatus?.status === 'RUNNING' && afterStatus?.running === true &&
      afterStatus?.checkpointGeneration === afterCheckpoint?.generation &&
      afterStatus?.checkpointHash === afterCheckpoint?.blobHash &&
      afterStatus?.pendingDeliveries === 0 && afterStatus?.observedOutputs === 0 &&
      afterStatus?.authorityOwned === false && afterStatus?.lastError === null &&
      this.trustedTimePulseSequence === expected.lastPulseSequence + 1 &&
      afterTime?.lastRuntimeRevision === 127 &&
      afterTime?.lastPulseSequence === expected.lastPulseSequence + 1 &&
      afterTime?.lastClockStatus === 'uncertain' &&
      afterTime?.lastWallClockMs >= beforeTime.lastWallClockMs &&
      afterTime?.acceptedPulses === beforeTime.acceptedPulses + 1 &&
      afterTime?.integratedIntervals === beforeTime.integratedIntervals &&
      afterPhysiologyHash === beforePhysiologyHash &&
      event?.topic === 'runtime.time.pulse' && event?.event_class === 'durable' &&
      event?.deduplication_key ===
        `runtime.time.pulse:127:${expected.lastPulseSequence + 1}` &&
      envelope?.payload?.runtimeRevision === 127 &&
      envelope?.payload?.pulseSequence === expected.lastPulseSequence + 1 &&
      envelope?.payload?.clockStatus === 'uncertain')) {
      throw Object.assign(new Error('R127 trusted-time restart anchor changed containment'), {
        code: 'P1_R127_POST_RESTART_TIME_ANCHOR'
      });
    }

    const detail = {
      cohort: 'r127-post-restart-continuity-v1',
      residencyId: expected.residencyId,
      runtimeRevision: 127,
      eventSequence: expectedSequence,
      fromPulseSequence: expected.lastPulseSequence,
      toPulseSequence: expected.lastPulseSequence + 1,
      clockStatus: 'uncertain',
      checkpointGenerationBefore: beforeCheckpoint.generation,
      checkpointGenerationAfter: afterCheckpoint.generation,
      idempotentCheckpointCommits: anchorCheckpoints.length,
      physiologyStateHashBefore: beforePhysiologyHash,
      physiologyStateHashAfter: afterPhysiologyHash,
      physiologyApplied: 0,
      abandonedCount: 0,
      inventedBiologicalTime: false,
      authorityChanged: false
    };
    this.stateStore.recordRecovery(
      'resident.r127-restart-clock-anchored',
      expected.coreId,
      detail
    );
    this.statusCache = null;
    return Object.freeze(detail);
  }

  startMaintenance() {
    if (this.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.writeHeartbeat().catch(error => this.recordMaintenanceError('heartbeat', error));
      }, this.heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    }

    if (this.snapshotIntervalMs > 0) {
      this.snapshotTimer = setInterval(() => {
        this.createSnapshot('periodic').catch(error => this.recordMaintenanceError('snapshot', error));
      }, this.snapshotIntervalMs);
      this.snapshotTimer.unref?.();
    }
  }

  recordMaintenanceError(operation, error) {
    this.maintenanceErrors[operation] = {
      operation,
      at: new Date().toISOString(),
      code: error.code || null,
      message: error.message
    };
    this.logger.error('[STAY] maintenance failure [' + operation + '] ' + error.message);
  }

  clearMaintenanceError(operation) {
    delete this.maintenanceErrors[operation];
  }

  async writeHeartbeat() {
    const cores = await this.registry.status();

    if (
      this.residentManager &&
      !this.residentManager.closed
    ) {
      try {
        await this.residentManager
          .maintainResidentOutboxes();

        this.clearMaintenanceError(
          'resident-outbox'
        );
      } catch (error) {
        this.recordMaintenanceError(
          'resident-outbox',
          error
        );
      }
    }

    this.lastBiologicalRetention = this.stateStore.pruneBiologicalEvents({ retainCount: 4096 });
    await this.stateStore.writeLife('event-sequence', {
      sequence: this.fabric.sequence,
      at: new Date().toISOString()
    });
    await this.stateStore.heartbeat({
      kernelVersion: KERNEL_VERSION,
      runtimeRevision: this.runtimeRevision,
      organismId: this.identity ? this.identity.organismId : null,
      pid: process.pid,
      startedAt: this.startedAt,
      coreHealth: cores.map(slot => ({
        coreId: slot.coreId,
        ok: !slot.active || !slot.active.health || slot.active.health.ok !== false
      })),
      biologicalRetention: this.lastBiologicalRetention
    });
    this.clearMaintenanceError('heartbeat');
  }

  async createSnapshot(reason) {
    await Promise.all([...this.registry.slots.values()].map(slot => slot.persistActive()));
    const snapshot = await this.stateStore.createSnapshot({
      reason,
      retention: this.snapshotRetention
    });
    await this.stateStore.appendJournal({
      type: 'state.snapshot',
      at: snapshot.createdAt,
      reason,
      snapshot: snapshot.name
    });
    this.clearMaintenanceError('snapshot');
    return snapshot;
  }

  async installCore(modulePath) {
    const expansionRevision = this.p1ExpansionFetusInstallRevisionPreservation;
    const preserveExactFetusInstall =
      (this.metabNeutralRecoveryRevisionPreserved &&
       this.metabNeutralRecoveryCompletedAtPreservedRevision &&
       !this.metabNeutralRecoveryFetusInstallPreserved) ||
      (this.p1ExpansionFetusInstallRevisionPreservation !== null &&
       !this.p1ExpansionFetusInstallPreserved);
    const resolvedModulePath = path.resolve(modulePath);
    if (preserveExactFetusInstall) {
      let trustedModulePath;
      let requestedModulePath;
      try {
        trustedModulePath = fs.realpathSync(path.join(
          this.releaseRoot,
          'cores/fetus-legacy-0.6/index.js'
        ));
        requestedModulePath = fs.realpathSync(resolvedModulePath);
      } catch (error) {
        throw Object.assign(
          new Error(`R127 fetus continuity module is unavailable: ${error.message}`),
          { code: 'P1_METAB_RECOVERY_FETUS_FENCE' }
        );
      }
      if (requestedModulePath !== trustedModulePath) {
        throw Object.assign(
          new Error('revision preservation permits only the release-sealed fetus module'),
          { code: expansionRevision === null
            ? 'P1_METAB_RECOVERY_FETUS_FENCE'
            : 'P1_EXPANSION_RECOVERY_FETUS_FENCE' }
        );
      }
    }
    const unit = await this.upgrades.installInitial(resolvedModulePath);
    if (preserveExactFetusInstall) {
      const exactRevision = expansionRevision === null
        ? this.runtimeRevision === 127
        : this.runtimeRevision === expansionRevision;
      if (!exactRevision || unit.manifest?.coreId !== 'fetus-legacy' || unit.manifest?.version !== '0.6.0') {
        throw Object.assign(
          new Error('revision preservation permits only the exact fetus continuity install'),
          { code: expansionRevision === null
            ? 'P1_METAB_RECOVERY_FETUS_FENCE'
            : 'P1_EXPANSION_RECOVERY_FETUS_FENCE' }
        );
      }
      if (expansionRevision === null) this.metabNeutralRecoveryFetusInstallPreserved = true;
      else this.p1ExpansionFetusInstallPreserved = true;
      await this.stateStore.appendJournal({
        type: 'runtime.revision-preserved',
        at: new Date().toISOString(),
        reason: expansionRevision === null
          ? 'fetus.install.exact-r127-metab-forward-recovery'
          : `fetus.install.exact-r${expansionRevision}-p1-expansion`,
        runtimeRevision: this.runtimeRevision,
        coreId: unit.manifest.coreId,
        coreVersion: unit.manifest.version,
        authorityOwned: false
      });
    } else {
      await this.bumpRuntimeRevision('core.install', {
        coreId: unit.manifest ? unit.manifest.coreId : null,
        coreVersion: unit.manifest ? unit.manifest.version : null
      });
    }
    if (unit.manifest?.coreId === 'sntss') await this.publishOrganismBinding();
    return unit;
  }

  async ensureOrganismBinding({
    allowCreate = false
  } = {}) {
    if (!this.identity) {
      throw Object.assign(
        new Error(
          'organism identity is unavailable'
        ),
        {
          code:
            'IDENTITY_MISSING'
        }
      );
    }

    const identityHash =
      'sha256:' +
      crypto
        .createHash('sha256')
        .update(
          stableStringify(
            this.identity
          )
        )
        .digest('hex');

    let binding =
      await this.stateStore
        .readLife(
          'organism-binding',
          null
        );

    if (!binding) {
      if (!allowCreate) {
        throw Object.assign(
          new Error(
            'persisted organism binding is missing'
          ),
          {
            code:
              'ORGANISM_BINDING_MISSING'
          }
        );
      }

      binding = {
        bindingVersion:
          1,

        identitySha256:
          identityHash,

        organismLineage:
          this.identity.lineage,

        issuedAt:
          Number(
            this.clock()
          ),

        runtimeRevision:
          this.runtimeRevision,

        authorityEpoch:
          this.runtimeRevision,

        kernelVersion:
          KERNEL_VERSION
      };

      await this.stateStore
        .writeLife(
          'organism-binding',
          binding
        );
    }

    if (
      binding.bindingVersion !== 1 ||
      binding.identitySha256 !==
        identityHash ||
      binding.organismLineage !==
        this.identity.lineage
    ) {
      throw Object.assign(
        new Error(
          'persisted organism binding does not match living identity'
        ),
        {
          code:
            'ORGANISM_BINDING_MISMATCH'
        }
      );
    }

    return binding;
  }

  async publishOrganismBinding() {
    const binding =
      await this.ensureOrganismBinding({
        allowCreate:
          true
      });

    const signalId =
      `runtime.organism.binding:v${binding.bindingVersion}:${binding.identitySha256}`;

    const signal =
      createSignal({
        signalId,

        topic:
          'runtime.organism.binding',

        payload:
          binding,

        trustedTime: {
          source:
            'kernel',

          observedAtMs:
            Number(this.clock())
        },

        provenance: {
          producerType:
            'kernel',

          producerId:
            'living-kernel',

          authorityEpoch:
            binding.authorityEpoch
        },

        durability:
          DURABILITY.DURABLE
      });

    return this.fabric
      .publishBiologicalSignal(
        signal,
        {
          /*
           * Organism binding was already a critical Kernel event.
           * Canonical biological transport must not weaken that property.
           */
          eventClass:
            'critical',

          sourceVersion:
            binding.kernelVersion,

          evidenceHash:
            binding.identitySha256
        }
      );
  }

  async attachResident(
    moduleRelativePath =
      'cores/sntss/i3d/index.js'
  ) {
    const manager =
      this.ensureResidentManager();

    /*
     * Inspect before authorization so the signed
     * certificate binds the exact executable,
     * manifest and package policy that will later
     * be loaded.
     */
    const inspected =
      await manager.inspect(
        moduleRelativePath
      );

    const { loadAndVerifyResidentPromotion, CHRONOBIOLOGY_AUTHORIZATION_CLASS } =
      require('./resident-promotion-authority');

    const boundedChronobiologyShadow =
      this.allowBoundedChronobiologyShadowAttachment &&
      inspected.contract?.residencyId === 'resident:chronobiology' &&
      inspected.contract?.coreId === 'chronobiology' &&
      inspected.contract?.version === '1.0.0-c3rc.1' &&
      inspected.contract?.stateSchema === 2 &&
      inspected.contract?.stage === 'c3-shadow-release-candidate' &&
      inspected.contract?.productionEligible === false &&
      inspected.contract?.authorityMode === 'shadow' &&
      inspected.contract?.signalling === 'LAB_SHADOW_ONLY' &&
      inspected.contract?.packagePolicyHash === 'sha256:9ab15c27c69494c6ce3156255ed06d2f57887934928a85b13ff58d578add7820';

    const authorization = boundedChronobiologyShadow
      ? Object.freeze({
          ok: true,
          certificateId: null,
          authorizationClass: CHRONOBIOLOGY_AUTHORIZATION_CLASS,
          boundedShadowAuthorization: true,
          laboratoryBypass: false
        })
      : loadAndVerifyResidentPromotion({
        inspected,

        action:
          'attach-resident',

        identity:
          this.identity,

        contract:
          inspected.contract,

        required:
          !this
            .allowLaboratoryResidentAttachment,

        publicKeyPath:
          this
            .residentPromotionPublicKeyPath,

        certificateDir:
          this
            .residentPromotionCertificateDir
      });

    await this.stateStore
      .appendJournal({
        type:
          'resident.promotion-authorized',

        at:
          new Date().toISOString(),

        residencyId:
          inspected.contract
            .residencyId,

        coreId:
          inspected.definition
            .manifest.coreId,

        version:
          inspected.definition
            .manifest.version,

        action:
          'attach-resident',

        certificateId:
          authorization
            .certificateId || null,

        authorizationClass:
          authorization
            .authorizationClass || null,

        laboratoryBypass:
          authorization
            .laboratoryBypass === true,

        boundedShadowAuthorization:
          authorization
            .boundedShadowAuthorization === true
      });

    const binding =
      await this.ensureOrganismBinding({
        allowCreate:
          true
      });

    const unit =
      await manager.attach({
        moduleRelativePath,
        binding
      });

    /*
     * Attaching a new durable subsystem changes the
     * runtime generation.
     *
     * The next trusted time pulse therefore anchors
     * rather than integrating attachment latency.
     */
    await this.bumpRuntimeRevision(
      'resident.attach',
      {
        residencyId:
          unit.residencyId,

        coreId:
          unit.manifest.coreId,

        coreVersion:
          unit.manifest.version
      }
    );

    this.statusCache =
      null;

    await this.stateStore
      .appendJournal({
        type:
          'resident.attach',

        at:
          new Date().toISOString(),

        residencyId:
          unit.residencyId,

        coreId:
          unit.manifest.coreId,

        version:
          unit.manifest.version,

        organismId:
          this.identity.organismId,

        runtimeRevision:
          this.runtimeRevision
      });

    return unit;
  }


  metabNeutralAcceptanceCommit(storage, healthReasonCode) {
    return ({ checkpoint, resident, manifest }) =>
      storage.appendNeutralChip({
        recordVersion: 'CoreChipObservationV1',
        chipId: 'resident:metab',
        organismId: this.identity.organismId,
        coreId: 'METAB',
        publicName: 'METAB',
        born: true,
        firstActivationFrame: 0,
        firstResidencyId: 'resident:metab',
        currentState: 'NEUTRAL',
        mode: 'NEUTRAL',
        lifecycle: 'RUNNING',
        healthReasonCode,
        coreVersion: manifest.version,
        stateSchemaVersion: String(manifest.stateSchema),
        checkpointGeneration: String(resident.checkpointGeneration),
        lastTrustedFrame: null,
        coverageBand: 'UNKNOWN',
        evidenceRefs: [`sha256:${checkpoint.blobHash}`],
        observedUtc: new Date(Number(this.clock())).toISOString()
      });
  }


  metabShadowAcceptanceCommit(
    storage,
    healthReasonCode,
    parentFreezeRecordSha256
  ) {
    return ({ checkpoint, resident, manifest }) => {
      const lastTrustedFrame =
        Number(checkpoint?.state?.lastAcceptedFrame) || 0;

      return storage.appendShadowChip({
        recordVersion: 'CoreChipObservationV1',
        chipId: 'resident:metab',
        organismId: this.identity.organismId,
        coreId: 'METAB',
        publicName: 'METAB',
        born: true,
        firstActivationFrame: 0,
        firstResidencyId: 'resident:metab',
        currentState: 'SHADOW',
        mode: 'SHADOW',
        lifecycle:
          checkpoint?.state?.engineState?.lifecycle ||
          'UNRESOLVED',
        healthReasonCode,
        coreVersion: manifest.version,
        stateSchemaVersion:
          String(manifest.stateSchema),
        checkpointGeneration:
          String(resident.checkpointGeneration),
        lastTrustedFrame:
          lastTrustedFrame > 0
            ? lastTrustedFrame
            : null,
        coverageBand:
          lastTrustedFrame > 0
            ? 'FULL'
            : 'UNKNOWN',
        evidenceRefs: [
          `sha256:${checkpoint.blobHash}`,
          parentFreezeRecordSha256
        ],
        observedUtc:
          new Date(Number(this.clock())).toISOString()
      });
    };
  }


  metabHomeosAcceptanceCommit(storage, healthReasonCode, parentFreezeRecordSha256) {
    return ({ checkpoint, resident, manifest }) => {
      const lastTrustedFrame = Number(checkpoint?.state?.sourceState?.lastAcceptedFrame) || 0;
      return storage.appendMetabHomeosChip({
        recordVersion: 'CoreChipObservationV1',
        chipId: 'resident:metab',
        organismId: this.identity.organismId,
        coreId: 'METAB',
        publicName: 'METAB',
        born: true,
        firstActivationFrame: 0,
        firstResidencyId: 'resident:metab',
        currentState: 'SHADOW',
        mode: 'SHADOW',
        lifecycle: checkpoint?.state?.sourceState?.engineState?.lifecycle || 'UNRESOLVED',
        healthReasonCode,
        coreVersion: manifest.version,
        stateSchemaVersion: String(manifest.stateSchema),
        checkpointGeneration: String(resident.checkpointGeneration),
        lastTrustedFrame: lastTrustedFrame > 0 ? lastTrustedFrame : null,
        coverageBand: lastTrustedFrame > 0 ? 'FULL' : 'UNKNOWN',
        evidenceRefs: [`sha256:${checkpoint.blobHash}`, parentFreezeRecordSha256],
        observedUtc: new Date(Number(this.clock())).toISOString()
      });
    };
  }


  homeosAcceptanceCommit(storage, healthReasonCode, parentFreezeRecordSha256, shadow = false) {
    return ({ checkpoint, resident, manifest }) => {
      const state = checkpoint?.state?.neutralState || checkpoint?.state;
      const lastTrustedFrame = Number(state?.engineState?.frameIndex) || 0;
      return storage.appendHomeosChip({
        recordVersion: 'CoreChipObservationV1',
        chipId: 'resident:homeos',
        organismId: this.identity.organismId,
        coreId: 'HOMEOS',
        publicName: 'HOMEOS',
        born: true,
        firstActivationFrame: 0,
        firstResidencyId: 'resident:homeos',
        currentState: shadow ? 'SHADOW' : 'NEUTRAL',
        mode: shadow ? 'SHADOW' : 'NEUTRAL',
        lifecycle: state?.engineState?.lifecycle || 'INITIALIZING',
        healthReasonCode,
        coreVersion: manifest.version,
        stateSchemaVersion: String(manifest.stateSchema),
        checkpointGeneration: String(resident.checkpointGeneration),
        lastTrustedFrame: lastTrustedFrame > 0 ? lastTrustedFrame : null,
        coverageBand: lastTrustedFrame > 0 ? 'FULL' : 'UNKNOWN',
        evidenceRefs: [`sha256:${checkpoint.blobHash}`, parentFreezeRecordSha256],
        observedUtc: new Date(Number(this.clock())).toISOString()
      }, { shadow });
    };
  }

  metabInteroAcceptanceCommit(storage, healthReasonCode, parentFreezeRecordSha256) {
    return ({ checkpoint, resident, manifest }) => {
      const source = checkpoint?.state?.homeosFeedState?.sourceState;
      const lastTrustedFrame = Number(source?.lastAcceptedFrame) || 0;
      return storage.appendMetabInteroChip({
        recordVersion: 'CoreChipObservationV1',
        chipId: 'resident:metab',
        organismId: this.identity.organismId,
        coreId: 'METAB',
        publicName: 'METAB',
        born: true,
        firstActivationFrame: 0,
        firstResidencyId: 'resident:metab',
        currentState: 'SHADOW',
        mode: 'SHADOW',
        lifecycle: source?.engineState?.lifecycle || 'UNRESOLVED',
        healthReasonCode,
        coreVersion: manifest.version,
        stateSchemaVersion: String(manifest.stateSchema),
        checkpointGeneration: String(resident.checkpointGeneration),
        lastTrustedFrame: lastTrustedFrame > 0 ? lastTrustedFrame : null,
        coverageBand: lastTrustedFrame > 0 ? 'FULL' : 'UNKNOWN',
        evidenceRefs: [`sha256:${checkpoint.blobHash}`, parentFreezeRecordSha256],
        observedUtc: new Date(Number(this.clock())).toISOString()
      });
    };
  }

  homeosInteroAcceptanceCommit(storage, healthReasonCode, parentFreezeRecordSha256) {
    return ({ checkpoint, resident, manifest }) => {
      const state = checkpoint?.state?.sourceState?.neutralState;
      const lastTrustedFrame = Number(state?.engineState?.frameIndex) || 0;
      return storage.appendHomeosInteroChip({
        recordVersion: 'CoreChipObservationV1',
        chipId: 'resident:homeos',
        organismId: this.identity.organismId,
        coreId: 'HOMEOS',
        publicName: 'HOMEOS',
        born: true,
        firstActivationFrame: 0,
        firstResidencyId: 'resident:homeos',
        currentState: 'SHADOW',
        mode: 'SHADOW',
        lifecycle: state?.engineState?.lifecycle || 'UNRESOLVED',
        healthReasonCode,
        coreVersion: manifest.version,
        stateSchemaVersion: String(manifest.stateSchema),
        checkpointGeneration: String(resident.checkpointGeneration),
        lastTrustedFrame: lastTrustedFrame > 0 ? lastTrustedFrame : null,
        coverageBand: lastTrustedFrame > 0 ? 'FULL' : 'UNKNOWN',
        evidenceRefs: [`sha256:${checkpoint.blobHash}`, parentFreezeRecordSha256],
        observedUtc: new Date(Number(this.clock())).toISOString()
      });
    };
  }

  interoAcceptanceCommit(storage, healthReasonCode, parentFreezeRecordSha256, shadow = false) {
    return ({ checkpoint, resident, manifest }) => {
      const state = shadow ? checkpoint?.state : null;
      const lastTrustedFrame = Number(state?.engineState?.frameIndex) || 0;
      return storage.appendInteroChip({
        recordVersion: 'CoreChipObservationV1',
        chipId: 'resident:intero',
        organismId: this.identity.organismId,
        coreId: 'INTERO',
        publicName: 'INTERO',
        born: true,
        firstActivationFrame: 0,
        firstResidencyId: 'resident:intero',
        currentState: shadow ? 'SHADOW' : 'NEUTRAL',
        mode: shadow ? 'SHADOW' : 'NEUTRAL',
        lifecycle: state?.engineState?.lifecycle || 'INITIALIZING',
        healthReasonCode,
        coreVersion: manifest.version,
        stateSchemaVersion: String(manifest.stateSchema),
        checkpointGeneration: String(resident.checkpointGeneration),
        lastTrustedFrame: lastTrustedFrame > 0 ? lastTrustedFrame : null,
        coverageBand: lastTrustedFrame > 0 ? 'FULL' : 'UNKNOWN',
        evidenceRefs: [`sha256:${checkpoint.blobHash}`, parentFreezeRecordSha256],
        observedUtc: new Date(Number(this.clock())).toISOString()
      }, { shadow });
    };
  }


  async promoteMetabShadow() {
    const normalAuthorized =
      this.metabShadowPromotionAuthorization ===
        R128_METAB_SHADOW.authorization;
    const r133RecoveryAuthorized =
      this.metabShadowRecoveryAuthorization ===
        R133_METAB_SHADOW_RECOVERY.authorization;
    const r135RecoveryAuthorized =
      this.metabShadowRecoveryAuthorization ===
        R135_METAB_SHADOW_RECOVERY.authorization;
    const r137RecoveryAuthorized =
      this.metabShadowRecoveryAuthorization ===
        R137_METAB_SHADOW_RECOVERY.authorization;
    const r139RecoveryAuthorized =
      this.metabShadowRecoveryAuthorization ===
        R139_METAB_SHADOW_RECOVERY.authorization;
    const authorizationCount = [
      normalAuthorized,
      r133RecoveryAuthorized,
      r135RecoveryAuthorized,
      r137RecoveryAuthorized,
      r139RecoveryAuthorized
    ].filter(Boolean).length;
    if (!this.allowMetabShadowPromotion || authorizationCount !== 1) {
      throw Object.assign(
        new Error('METAB shadow promotion is not exactly authorized'),
        { code: 'P1_METAB_SHADOW_NOT_AUTHORIZED' }
      );
    }

    const promotion = r139RecoveryAuthorized
      ? R139_METAB_SHADOW_RECOVERY
      : r137RecoveryAuthorized
        ? R137_METAB_SHADOW_RECOVERY
        : r135RecoveryAuthorized
          ? R135_METAB_SHADOW_RECOVERY
          : r133RecoveryAuthorized
            ? R133_METAB_SHADOW_RECOVERY
            : Object.freeze({
              ...R128_METAB_SHADOW,
              activationLabel: 'r128',
              acceptancePrefix: 'R128'
            });

    if (this.runtimeRevision !== promotion.runtimeRevision) {
      throw Object.assign(
        new Error(
          `METAB shadow promotion is fenced to runtime R${promotion.runtimeRevision}`
        ),
        { code: 'P1_METAB_SHADOW_REVISION' }
      );
    }

    const { readRevisionFreeze } = require('../revision-freeze');
    const parentFreeze = readRevisionFreeze(
      promotion.parentRevision,
      { directory: this.runtimeFreezeDirectory }
    );

    if (!parentFreeze.frozen || !parentFreeze.recordSha256) {
      throw Object.assign(
        new Error('R127F parent freeze is absent or invalid'),
        { code: 'P1_METAB_SHADOW_PARENT_FREEZE' }
      );
    }

    const residents = this.stateStore.listResidents();
    const residentIds = residents
      .map(resident => resident.residencyId)
      .sort();

    if (
      stableStringify(residentIds) !==
        stableStringify([
          'resident:chronobiology',
          'resident:metab',
          'resident:sntss'
        ]) ||
      this.stateStore.getResident('resident:homeos') !== null ||
      this.stateStore.getResident('resident:intero') !== null
    ) {
      throw Object.assign(
        new Error('R128 METAB promotion resident cohort is not exact'),
        { code: 'P1_METAB_SHADOW_COHORT' }
      );
    }

    const manager = this.ensureResidentManager();
    const metabResident =
      this.stateStore.getResident('resident:metab');
    const metabCheckpoint =
      await this.stateStore.readResidentCheckpoint(
        'resident:metab'
      );
    const metabStatus =
      await manager.status('resident:metab');
    const sntss =
      await manager.status('resident:sntss');
    const chronobiology =
      await manager.status('resident:chronobiology');
    const p1Authority =
      this.stateStore.listAuthority().filter(entry =>
        ['METAB', 'HOMEOS', 'INTERO'].includes(entry.coreId)
      );
    const fetusAuthority =
      this.stateStore.getAuthority('fetus-legacy');
    const fetusSlot =
      (await this.registry.status())
        .find(slot => slot.coreId === 'fetus-legacy');
    const pendingMetabOutbox = Number(
      this.stateStore.db.prepare(`
        SELECT COUNT(*) AS count
        FROM biological_outbox_intents
        WHERE producer_core_id='METAB'
      `).get()?.count || 0
    );

    if (
      metabResident?.instanceId !==
        promotion.instanceId ||
      metabResident?.version !==
        promotion.neutralVersion ||
      metabResident?.stateSchema !== 1 ||
      metabResident?.moduleRelativePath !==
        'cores/p1-r0/metab-neutral/index.js' ||
      metabResident?.checkpointHash !==
        promotion.neutralCheckpointHash ||
      metabResident?.status !== 'RUNNING' ||
      metabCheckpoint?.blobHash !==
        promotion.neutralCheckpointHash ||
      metabCheckpoint?.state?.engineState?.frameIndex !== 0 ||
      metabCheckpoint?.state?.engineState?.outputSequence !== '0' ||
      metabStatus?.running !== true ||
      metabStatus?.health?.mode !== 'NEUTRAL' ||
      metabStatus?.authorityOwned !== false ||
      metabStatus?.observedOutputs !== 0 ||
      metabStatus?.pendingDeliveries !== 0 ||
      sntss?.instanceId !==
        R127_POST_RESTART_CONTINUITY.sntss.instanceId ||
      sntss?.version !==
        R127_POST_RESTART_CONTINUITY.sntss.version ||
      sntss?.running !== true ||
      (promotion.sntssHealthMode === null
        ? sntss?.health?.mode !== undefined
        : sntss?.health?.mode !== promotion.sntssHealthMode) ||
      sntss?.authorityOwned !== false ||
      sntss?.observedOutputs !== 0 ||
      sntss?.pendingDeliveries !== 0 ||
      chronobiology?.instanceId !==
        R127_POST_RESTART_CONTINUITY.chronobiology.instanceId ||
      chronobiology?.version !==
        R127_POST_RESTART_CONTINUITY.chronobiology.version ||
      chronobiology?.running !== true ||
      chronobiology?.health?.mode !==
        promotion.chronobiologyHealthMode ||
      chronobiology?.authorityOwned !== false ||
      chronobiology?.pendingDeliveries !== 0 ||
      p1Authority.length !== 0 ||
      pendingMetabOutbox !== 0 ||
      fetusAuthority?.instanceId !==
        R127_POST_RESTART_CONTINUITY.fetus.instanceId ||
      fetusAuthority?.version !==
        R127_POST_RESTART_CONTINUITY.fetus.version ||
      fetusSlot?.active?.instanceId !==
        R127_POST_RESTART_CONTINUITY.fetus.instanceId ||
      fetusSlot?.active?.manifest?.version !==
        R127_POST_RESTART_CONTINUITY.fetus.version ||
      fetusSlot?.active?.mode !== 'active' ||
      fetusSlot?.active?.health?.ok === false
    ) {
      throw Object.assign(
        new Error('R128 METAB shadow continuity cohort failed closed'),
        { code: 'P1_METAB_SHADOW_COHORT' }
      );
    }

    const {
      PRODUCTION_STORAGE_AUTHORIZATION,
      P1ProductionPersistence
    } = require('../p1-r0/production-persistence');
    const storage = new P1ProductionPersistence({
      stateStore: this.stateStore,
      authorization: PRODUCTION_STORAGE_AUTHORIZATION
    }).initialize();
    const founder = storage.readFounder({
      organismId: this.identity.organismId,
      coreId: 'METAB'
    });
    const dossier = storage.readBirthDossier('resident:metab');
    const chip = storage.readChip('resident:metab');

    if (
      !founder ||
      !dossier ||
      chip?.currentState !== 'NEUTRAL' ||
      chip?.mode !== 'NEUTRAL' ||
      chip?.firstResidencyId !== 'resident:metab' ||
      dossier.founderRecord?.founderId !== founder.founderId ||
      dossier.founderRecord?.lineageId !== founder.lineageId ||
      dossier.founderRecord?.profileHash !== founder.profileHash ||
      metabCheckpoint.state?.founder?.founderId !== founder.founderId ||
      metabCheckpoint.state?.founder?.lineageId !== founder.lineageId ||
      metabCheckpoint.state?.founder?.profileHash !== founder.profileHash
    ) {
      throw Object.assign(
        new Error('METAB founder or chip continuity is incomplete'),
        { code: 'P1_METAB_SHADOW_LINEAGE' }
      );
    }

    const binding = await this.ensureOrganismBinding({
      allowCreate: false
    });
    const {
      METAB_SHADOW_RESIDENT_CONTRACT
    } = require('../p1-r0/metab-shadow-contract');

    const unit = await manager.promoteMetabShadow({
      moduleRelativePath:
        'cores/p1-r0/metab-shadow/index.js',
      binding,
      shadowContract:
        METAB_SHADOW_RESIDENT_CONTRACT,
      acceptanceCommit:
        this.metabShadowAcceptanceCommit(
          storage,
          `${promotion.acceptancePrefix}_SHADOW_ACCEPTED_OUTPUT_FIREWALLED`,
          parentFreeze.recordSha256
        ),
      publishActivation:
        async ({ sourceCheckpoint, resident }) => {
          const payload = {
            protocol:
              'stay-p1-r0-metab-shadow-activation-v1',
            organismIdentityHash:
              manager.organismIdentityHash,
            residencyId: 'resident:metab',
            instanceId: resident.instanceId,
            fromVersion: resident.version,
            fromStateSchema: resident.stateSchema,
            sourceCheckpointGeneration:
              sourceCheckpoint.generation,
            sourceCheckpointHash:
              `sha256:${sourceCheckpoint.blobHash}`,
            toVersion:
              METAB_SHADOW_RESIDENT_CONTRACT.version,
            toStateSchema:
              METAB_SHADOW_RESIDENT_CONTRACT.stateSchema,
            runtimeRevision: this.runtimeRevision,
            parentRevision:
              promotion.parentRevision,
            parentFreezeRecordSha256:
              parentFreeze.recordSha256,
            mode: 'SHADOW',
            authorityEpoch: '0',
            outputPolicy:
              promotion.outputPolicy
          };
          const signalId =
            `runtime.metab.shadow-activation:${promotion.activationLabel}:g${sourceCheckpoint.generation}:${sourceCheckpoint.blobHash}`;
          const signal = createSignal({
            signalId,
            topic:
              'runtime.metab.shadow-activation',
            payload,
            trustedTime: {
              source: 'kernel',
              observedAtMs:
                Number(this.clock()),
              pulseId:
                `metab-shadow-activation-${promotion.activationLabel}-g${sourceCheckpoint.generation}`
            },
            provenance: {
              producerType: 'kernel',
              producerId: 'living-kernel',
              authorityEpoch:
                this.runtimeRevision
            },
            durability: DURABILITY.DURABLE
          });
          return this.fabric.publishBiologicalSignal(
            signal,
            {
              eventClass: 'critical',
              sourceVersion: KERNEL_VERSION,
              evidenceHash:
                manager.organismIdentityHash
            }
          );
        }
    });

    let initialCapacitySample =
      await this.publishMetabCapacitySample();

    /*
     * The 250 ms trusted-time scheduler can have one pre-promotion no-op in
     * flight while the durable generation swap completes. Retry that exact
     * collision once without sleeping or widening a deadline. Any real
     * source/time failure still reaches the acceptance fence below.
     */
    if (initialCapacitySample === false) {
      initialCapacitySample =
        await this.publishMetabCapacitySample();
    }

    const promoted = this.stateStore.getResident('resident:metab');
    const checkpoint =
      await this.stateStore.readResidentCheckpoint(
        'resident:metab'
      );
    const status = await manager.status('resident:metab');
    const consumer =
      this.stateStore.getBiologicalConsumer(
        'resident:metab'
      );

    if (
      initialCapacitySample !== true ||
      unit?.residencyId !== 'resident:metab' ||
      promoted?.instanceId !== metabResident.instanceId ||
      promoted?.version !== promotion.shadowVersion ||
      promoted?.stateSchema !== 2 ||
      promoted?.status !== 'RUNNING' ||
      checkpoint?.state?.activation?.sourceCheckpointHash !==
        `sha256:${promotion.neutralCheckpointHash}` ||
      checkpoint?.state?.lastAcceptedFrame < 1 ||
      checkpoint?.state?.engineState?.outputSequence !== '0' ||
      status?.running !== true ||
      status?.health?.mode !== 'SHADOW' ||
      status?.health?.outputPolicy !==
        promotion.outputPolicy ||
      status?.authorityOwned !== false ||
      status?.observedOutputs !== 0 ||
      status?.declaredOutputs !== 0 ||
      !isBoundedMetabPromotionTail(status?.pendingDeliveries) ||
      consumer?.active !== true ||
      consumer?.required !== false ||
      consumer?.authorityEpoch !== 0 ||
      stableStringify(consumer?.topics) !==
        stableStringify(METAB_SHADOW_RESIDENT_CONTRACT.inputs) ||
      this.stateStore.getAuthority('METAB') !== null
    ) {
      throw Object.assign(
        new Error('METAB shadow acceptance proof failed'),
        { code: 'P1_METAB_SHADOW_ACCEPTANCE' }
      );
    }

    this.metabShadowAcceptanceCommit(
      storage,
      `${promotion.acceptancePrefix}_SHADOW_RUNNING_OUTPUT_FIREWALLED`,
      parentFreeze.recordSha256
    )({
      checkpoint,
      resident: promoted,
      manifest: unit.manifest
    });

    this.statusCache = null;
    await this.stateStore.appendJournal({
      type: 'resident.metab-shadow-promotion',
      at: new Date(Number(this.clock())).toISOString(),
      residencyId: 'resident:metab',
      instanceId: promoted.instanceId,
      fromVersion:
        promotion.neutralVersion,
      toVersion: promoted.version,
      runtimeRevision: this.runtimeRevision,
      parentFreezeRecordSha256:
        parentFreeze.recordSha256,
      sourceCheckpointHash:
        promotion.neutralCheckpointHash,
      acceptedFrame:
        checkpoint.state.lastAcceptedFrame,
      authorityOwned: false,
      observedOutputs: 0,
      abandonedCount: 0,
      inventedBiologicalTime: false
    });

    return unit;
  }


  async recoverMetabNeutralBirth() {
    return this.birthMetabNeutral({ recovery: true });
  }


  async birthHomeosNeutral({ preserveRevision = false } = {}) {
    const exactStrandedRecovery =
      this.isExactStrandedHomeosRecovery(preserveRevision);
    if (
      this.homeosNeutralBirthAuthorization !== R145_HOMEOS_SHADOW.birthAuthorization ||
      (this.runtimeRevision !== 142 && !exactStrandedRecovery)
    ) {
      throw Object.assign(
        new Error('HOMEOS neutral birth is not exactly authorized at R142'),
        { code: 'P1_HOMEOS_BIRTH_NOT_AUTHORIZED' }
      );
    }
    const { readRevisionFreeze } = require('../revision-freeze');
    const parentFreeze = readRevisionFreeze(R145_HOMEOS_SHADOW.parentRevision, {
      directory: this.runtimeFreezeDirectory
    });
    if (!parentFreeze.frozen || !parentFreeze.recordSha256) {
      throw Object.assign(new Error('R141F parent freeze is absent or invalid'), {
        code: 'P1_HOMEOS_BIRTH_PARENT_FREEZE'
      });
    }
    const manager = this.ensureResidentManager();
    const metab = this.stateStore.getResident('resident:metab');
    const forbiddenIntero = this.stateStore.getResident('resident:intero');
    const metabStatus = await manager.status('resident:metab');
    if (
      !metab || metab.instanceId !== R145_HOMEOS_SHADOW.metabInstanceId ||
      metab.version !== '0.2.0-p1r0-shadow.1' || metab.stateSchema !== 2 ||
      metab.moduleRelativePath !== 'cores/p1-r0/metab-shadow/index.js' ||
      metab.status !== 'RUNNING' || metabStatus?.running !== true ||
      metabStatus?.health?.mode !== 'SHADOW' || metabStatus?.authorityOwned !== false ||
      metabStatus?.observedOutputs !== 0 || forbiddenIntero ||
      this.stateStore.listAuthority().some(entry => ['METAB', 'HOMEOS', 'INTERO'].includes(entry.coreId))
    ) throw Object.assign(new Error('HOMEOS birth dependency fence failed'), {
      code: 'P1_HOMEOS_BIRTH_DEPENDENCY_FENCE'
    });
    const { HOMEOS_NEUTRAL_RESIDENT_CONTRACT } = require('../p1-r0/homeos-neutral-contract');
    const moduleRelativePath = 'cores/p1-r0/homeos-neutral/index.js';
    const inspected = await manager.inspect(
      moduleRelativePath,
      'resident:homeos',
      HOMEOS_NEUTRAL_RESIDENT_CONTRACT
    );
    const { loadAndVerifyHomeosNeutralBirth } = require('../p1-r0/homeos-neutral-birth-authority');
    const authorization = loadAndVerifyHomeosNeutralBirth({
      inspected,
      identity: this.identity,
      runtimeRevision: R145_HOMEOS_SHADOW.birthRevision,
      parentFreezeRecordSha256: parentFreeze.recordSha256,
      publicKeyPath: this.homeosNeutralBirthPublicKeyPath,
      certificateFile: this.homeosNeutralBirthCertificateFile,
      nowMs: Number(this.clock())
    });
    const binding = await this.ensureOrganismBinding({ allowCreate: false });
    const {
      PRODUCTION_STORAGE_AUTHORIZATION,
      P1ProductionExpansionPersistence
    } = require('../p1-r0/production-persistence');
    const storage = new P1ProductionExpansionPersistence({
      stateStore: this.stateStore,
      authorization: PRODUCTION_STORAGE_AUTHORIZATION
    }).initialize();
    if (
      this.stateStore.getResident('resident:homeos') ||
      storage.readFounder({ organismId: this.identity.organismId, coreId: 'HOMEOS' }) ||
      storage.readBirthDossier('resident:homeos')
    ) throw Object.assign(new Error('HOMEOS birth requires an empty exact cohort'), {
      code: 'P1_HOMEOS_BIRTH_NOT_EMPTY'
    });
    const { createNeutralHomeosInitialState } = require('../p1-r0/residents/homeos-neutral');
    const initialState = createNeutralHomeosInitialState({
      binding,
      founder: authorization.founderBinding
    });
    const digest = crypto.createHash('sha256').update(authorization.certificateId).digest();
    digest[6] = (digest[6] & 0x0f) | 0x40;
    digest[8] = (digest[8] & 0x3f) | 0x80;
    const hex = digest.subarray(0, 16).toString('hex');
    const instanceId = [
      hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
      hex.slice(16, 20), hex.slice(20)
    ].join('-');
    const unit = await manager.attach({
      moduleRelativePath,
      binding,
      initialState,
      instanceId,
      registerResident: registration => storage.commitHomeosNeutralBirth({
        founder: authorization.founderRecord,
        resident: registration,
        authorization
      }).resident,
      acceptanceCommit: this.homeosAcceptanceCommit(
        storage,
        'R143_NEUTRAL_ACCEPTED_OUTPUT_FORBIDDEN',
        parentFreeze.recordSha256,
        false
      )
    });
    const status = await manager.status('resident:homeos');
    const consumer = this.stateStore.getBiologicalConsumer('resident:homeos');
    if (
      unit?.residencyId !== 'resident:homeos' || status?.status !== 'RUNNING' ||
      status?.running !== true || status?.health?.mode !== 'NEUTRAL' ||
      status?.authorityOwned !== false || status?.observedOutputs !== 0 ||
      status?.declaredOutputs !== 0 || !consumer || consumer.active !== true ||
      consumer.authorityEpoch !== 0 || consumer.required !== false ||
      this.stateStore.getAuthority('HOMEOS') !== null
    ) throw Object.assign(new Error('HOMEOS neutral containment proof failed'), {
      code: 'P1_HOMEOS_BIRTH_ACCEPTANCE'
    });
    if (exactStrandedRecovery) {
      await this.stateStore.appendJournal({
        type: 'runtime.revision-preserved', at: new Date(Number(this.clock())).toISOString(),
        reason: `resident.homeos-neutral-birth.exact-stranded-r${this.runtimeRevision}-forward-recovery`,
        runtimeRevision: this.runtimeRevision, residencyId: 'resident:homeos',
        coreVersion: status.version, parentFreezeRecordSha256: parentFreeze.recordSha256,
        authorityOwned: false
      });
    } else {
      await this.bumpRuntimeRevision('resident.homeos-neutral-birth', {
        residencyId: 'resident:homeos', coreVersion: status.version,
        parentFreezeRecordSha256: parentFreeze.recordSha256
      });
    }
    this.statusCache = null;
    return unit;
  }


  async promoteMetabHomeosRoute({ preserveRevision = false } = {}) {
    const exactStrandedRecovery =
      this.isExactStrandedHomeosRecovery(preserveRevision);
    if (
      this.metabHomeosRouteAuthorization !== R145_HOMEOS_SHADOW.metabRouteAuthorization ||
      (this.runtimeRevision !== 143 && !exactStrandedRecovery)
    ) throw Object.assign(new Error('METAB HOMEOS route is not exactly authorized at R143'), {
      code: 'P1_METAB_HOMEOS_NOT_AUTHORIZED'
    });
    const { readRevisionFreeze } = require('../revision-freeze');
    const parentFreeze = readRevisionFreeze(R145_HOMEOS_SHADOW.parentRevision, {
      directory: this.runtimeFreezeDirectory
    });
    if (!parentFreeze.frozen || !parentFreeze.recordSha256) {
      throw Object.assign(new Error('R141F parent freeze is absent or invalid'), {
        code: 'P1_METAB_HOMEOS_PARENT_FREEZE'
      });
    }
    const manager = this.ensureResidentManager();
    const homeosStatus = await manager.status('resident:homeos');
    if (
      homeosStatus?.status !== 'RUNNING' || homeosStatus?.running !== true ||
      homeosStatus?.health?.mode !== 'NEUTRAL' || homeosStatus?.authorityOwned !== false ||
      homeosStatus?.observedOutputs !== 0
    ) throw Object.assign(new Error('METAB HOMEOS route lacks a contained HOMEOS consumer'), {
      code: 'P1_METAB_HOMEOS_DEPENDENCY'
    });
    const binding = await this.ensureOrganismBinding({ allowCreate: false });
    const { METAB_HOMEOS_RESIDENT_CONTRACT } = require('../p1-r0/metab-homeos-contract');
    const {
      PRODUCTION_STORAGE_AUTHORIZATION,
      P1ProductionExpansionPersistence
    } = require('../p1-r0/production-persistence');
    const storage = new P1ProductionExpansionPersistence({
      stateStore: this.stateStore,
      authorization: PRODUCTION_STORAGE_AUTHORIZATION
    }).initialize();
    const unit = await manager.promoteP1ContainedGeneration({
      kind: 'METAB_HOMEOS_ROUTE_R144',
      moduleRelativePath: 'cores/p1-r0/metab-homeos/index.js',
      binding,
      nextContract: METAB_HOMEOS_RESIDENT_CONTRACT,
      acceptanceCommit: this.metabHomeosAcceptanceCommit(
        storage,
        'R144_HOMEOS_ROUTES_ACCEPTED',
        parentFreeze.recordSha256
      ),
      publishActivation: async ({ sourceCheckpoint, resident }) => {
        const payload = {
          protocol: 'stay-p1-r0-metab-homeos-route-activation-v1',
          organismIdentityHash: manager.organismIdentityHash,
          residencyId: 'resident:metab',
          instanceId: resident.instanceId,
          fromVersion: resident.version,
          fromStateSchema: resident.stateSchema,
          sourceCheckpointGeneration: sourceCheckpoint.generation,
          sourceCheckpointHash: `sha256:${sourceCheckpoint.blobHash}`,
          toVersion: METAB_HOMEOS_RESIDENT_CONTRACT.version,
          toStateSchema: METAB_HOMEOS_RESIDENT_CONTRACT.stateSchema,
          targetRevision: R145_HOMEOS_SHADOW.metabRouteRevision,
          parentRevision: R145_HOMEOS_SHADOW.parentRevision,
          parentFreezeRecordSha256: parentFreeze.recordSha256,
          mode: 'SHADOW',
          authorityEpoch: '0',
          outputPolicy: R145_HOMEOS_SHADOW.metabOutputPolicy,
          routes: ['p1r0.metab-availability.homeos', 'p1r0.metab-reserve.homeos']
        };
        const signal = createSignal({
          signalId: `runtime.metab.homeos-route-activation:r144:g${sourceCheckpoint.generation}:${sourceCheckpoint.blobHash}`,
          topic: 'runtime.metab.homeos-route-activation',
          payload,
          trustedTime: {
            source: 'kernel',
            observedAtMs: Number(this.clock()),
            pulseId: `metab-homeos-route-r144-g${sourceCheckpoint.generation}`
          },
          provenance: {
            producerType: 'kernel', producerId: 'living-kernel',
            authorityEpoch: R145_HOMEOS_SHADOW.metabRouteRevision
          },
          durability: DURABILITY.DURABLE
        });
        return this.fabric.publishBiologicalSignal(signal, {
          eventClass: 'critical',
          sourceVersion: KERNEL_VERSION,
          evidenceHash: manager.organismIdentityHash
        });
      }
    });
    let sample = await this.publishMetabCapacitySample();
    if (sample === false) sample = await this.publishMetabCapacitySample();
    if (sample !== true) {
      throw Object.assign(new Error('METAB HOMEOS route did not accept an exact capacity sample'), {
        code: 'P1_METAB_HOMEOS_SAMPLE'
      });
    }
    await manager.drain('resident:homeos');
    const metabStatus = await manager.status('resident:metab');
    const nextHomeosStatus = await manager.status('resident:homeos');
    if (
      metabStatus?.running !== true || metabStatus?.health?.mode !== 'SHADOW' ||
      metabStatus?.health?.outputPolicy !== R145_HOMEOS_SHADOW.metabOutputPolicy ||
      metabStatus?.authorityOwned !== false || metabStatus?.declaredOutputs !== 2 ||
      metabStatus?.observedOutputs < 2 ||
      nextHomeosStatus?.running !== true || nextHomeosStatus?.health?.mode !== 'NEUTRAL' ||
      nextHomeosStatus?.health?.physiologicalInputs < 2 ||
      nextHomeosStatus?.observedOutputs !== 0 ||
      this.stateStore.getAuthority('METAB') !== null || this.stateStore.getAuthority('HOMEOS') !== null
    ) throw Object.assign(new Error('METAB HOMEOS route acceptance proof failed'), {
      code: 'P1_METAB_HOMEOS_ACCEPTANCE'
    });
    if (exactStrandedRecovery) {
      await this.stateStore.appendJournal({
        type: 'runtime.revision-preserved', at: new Date(Number(this.clock())).toISOString(),
        reason: `resident.metab-homeos-route.exact-stranded-r${this.runtimeRevision}-forward-recovery`,
        runtimeRevision: this.runtimeRevision, residencyId: 'resident:metab',
        coreVersion: metabStatus.version, parentFreezeRecordSha256: parentFreeze.recordSha256,
        authorityOwned: false
      });
    } else {
      await this.bumpRuntimeRevision('resident.metab-homeos-route', {
        residencyId: 'resident:metab', coreVersion: metabStatus.version,
        parentFreezeRecordSha256: parentFreeze.recordSha256
      });
    }
    this.statusCache = null;
    return unit;
  }


  async promoteHomeosShadow({ preserveRevision = false } = {}) {
    const exactStrandedRecovery =
      this.isExactStrandedHomeosRecovery(preserveRevision);
    if (
      this.homeosShadowPromotionAuthorization !== R145_HOMEOS_SHADOW.shadowAuthorization ||
      (this.runtimeRevision !== 144 && !exactStrandedRecovery)
    ) throw Object.assign(new Error('HOMEOS shadow is not exactly authorized at R144'), {
      code: 'P1_HOMEOS_SHADOW_NOT_AUTHORIZED'
    });
    const { readRevisionFreeze } = require('../revision-freeze');
    const parentFreeze = readRevisionFreeze(R145_HOMEOS_SHADOW.parentRevision, {
      directory: this.runtimeFreezeDirectory
    });
    if (!parentFreeze.frozen || !parentFreeze.recordSha256) {
      throw Object.assign(new Error('R141F parent freeze is absent or invalid'), {
        code: 'P1_HOMEOS_SHADOW_PARENT_FREEZE'
      });
    }
    const manager = this.ensureResidentManager();
    const metabStatus = await manager.status('resident:metab');
    if (
      metabStatus?.running !== true || metabStatus?.health?.mode !== 'SHADOW' ||
      metabStatus?.health?.outputPolicy !== R145_HOMEOS_SHADOW.metabOutputPolicy ||
      metabStatus?.authorityOwned !== false
    ) throw Object.assign(new Error('HOMEOS shadow lacks its exact METAB source'), {
      code: 'P1_HOMEOS_SHADOW_DEPENDENCY'
    });
    const binding = await this.ensureOrganismBinding({ allowCreate: false });
    const { HOMEOS_SHADOW_RESIDENT_CONTRACT } = require('../p1-r0/homeos-shadow-contract');
    const {
      PRODUCTION_STORAGE_AUTHORIZATION,
      P1ProductionExpansionPersistence
    } = require('../p1-r0/production-persistence');
    const storage = new P1ProductionExpansionPersistence({
      stateStore: this.stateStore,
      authorization: PRODUCTION_STORAGE_AUTHORIZATION
    }).initialize();
    const unit = await manager.promoteP1ContainedGeneration({
      kind: 'HOMEOS_NEUTRAL_TO_SHADOW_R145',
      moduleRelativePath: 'cores/p1-r0/homeos-shadow/index.js',
      binding,
      nextContract: HOMEOS_SHADOW_RESIDENT_CONTRACT,
      acceptanceCommit: this.homeosAcceptanceCommit(
        storage,
        'R145_SHADOW_ACCEPTED_OUTPUT_FIREWALLED',
        parentFreeze.recordSha256,
        true
      ),
      publishActivation: async ({ sourceCheckpoint, resident }) => {
        const payload = {
          protocol: 'stay-p1-r0-homeos-shadow-activation-v1',
          organismIdentityHash: manager.organismIdentityHash,
          residencyId: 'resident:homeos',
          instanceId: resident.instanceId,
          fromVersion: resident.version,
          fromStateSchema: resident.stateSchema,
          sourceCheckpointGeneration: sourceCheckpoint.generation,
          sourceCheckpointHash: `sha256:${sourceCheckpoint.blobHash}`,
          toVersion: HOMEOS_SHADOW_RESIDENT_CONTRACT.version,
          toStateSchema: HOMEOS_SHADOW_RESIDENT_CONTRACT.stateSchema,
          targetRevision: R145_HOMEOS_SHADOW.shadowRevision,
          parentRevision: R145_HOMEOS_SHADOW.parentRevision,
          parentFreezeRecordSha256: parentFreeze.recordSha256,
          mode: 'SHADOW',
          authorityEpoch: '0',
          outputPolicy: R145_HOMEOS_SHADOW.homeosOutputPolicy
        };
        const signal = createSignal({
          signalId: `runtime.homeos.shadow-activation:r145:g${sourceCheckpoint.generation}:${sourceCheckpoint.blobHash}`,
          topic: 'runtime.homeos.shadow-activation',
          payload,
          trustedTime: {
            source: 'kernel', observedAtMs: Number(this.clock()),
            pulseId: `homeos-shadow-r145-g${sourceCheckpoint.generation}`
          },
          provenance: {
            producerType: 'kernel', producerId: 'living-kernel',
            authorityEpoch: R145_HOMEOS_SHADOW.shadowRevision
          },
          durability: DURABILITY.DURABLE
        });
        return this.fabric.publishBiologicalSignal(signal, {
          eventClass: 'critical', sourceVersion: KERNEL_VERSION,
          evidenceHash: manager.organismIdentityHash
        });
      }
    });
    const status = await manager.status('resident:homeos');
    if (
      status?.running !== true || status?.health?.mode !== 'SHADOW' ||
      status?.health?.outputPolicy !== R145_HOMEOS_SHADOW.homeosOutputPolicy ||
      status?.authorityOwned !== false || status?.declaredOutputs !== 0 ||
      status?.observedOutputs !== 0 || this.stateStore.getAuthority('HOMEOS') !== null
    ) throw Object.assign(new Error('HOMEOS shadow acceptance proof failed'), {
      code: 'P1_HOMEOS_SHADOW_ACCEPTANCE'
    });
    if (exactStrandedRecovery) {
      await this.stateStore.appendJournal({
        type: 'runtime.revision-preserved', at: new Date(Number(this.clock())).toISOString(),
        reason: `resident.homeos-shadow.exact-stranded-r${this.runtimeRevision}-forward-recovery`,
        runtimeRevision: this.runtimeRevision, residencyId: 'resident:homeos',
        coreVersion: status.version, parentFreezeRecordSha256: parentFreeze.recordSha256,
        authorityOwned: false
      });
    } else {
      await this.bumpRuntimeRevision('resident.homeos-shadow', {
        residencyId: 'resident:homeos', coreVersion: status.version,
        parentFreezeRecordSha256: parentFreeze.recordSha256
      });
    }
    this.p1ExpansionFetusInstallRevisionPreservation = this.runtimeRevision;
    this.statusCache = null;
    return unit;
  }

  async recoverStrandedR145Homeos() {
    const preservedRevision = this.homeosStrandedRecoveryRevision;
    const partialR146 =
      this.homeosStrandedR146PartialRecoveryActive === true;
    if (!this.isExactStrandedHomeosRecovery(true) ||
        (!partialR146 && this.stateStore.getResident('resident:homeos')) ||
        this.stateStore.getResident('resident:intero')) {
      throw Object.assign(new Error('stranded HOMEOS recovery cohort is not exact'), {
        code: 'P1_HOMEOS_STRANDED_R145_RECOVERY_FENCE'
      });
    }
    if (!partialR146) {
      await this.birthHomeosNeutral({ preserveRevision: true });
      await this.promoteMetabHomeosRoute({ preserveRevision: true });
    } else {
      const manager = this.ensureResidentManager();
      let sample = await this.publishMetabCapacitySample();
      if (sample === false) sample = await this.publishMetabCapacitySample();
      await manager.drain('resident:homeos');
      const metabStatus = await manager.status('resident:metab');
      const homeosStatus = await manager.status('resident:homeos');
      const resumedFromCommittedSample =
        sample === false &&
        metabStatus?.observedOutputs >= 2 &&
        homeosStatus?.health?.physiologicalInputs >= 2;
      if (
        (sample !== true && !resumedFromCommittedSample) ||
        metabStatus?.version !== R146_METAB_Q48_HOMEOS_RECOVERY.partialMetabVersion ||
        metabStatus?.running !== true || metabStatus?.health?.mode !== 'SHADOW' ||
        metabStatus?.health?.outputPolicy !== R145_HOMEOS_SHADOW.metabOutputPolicy ||
        metabStatus?.authorityOwned !== false || metabStatus?.declaredOutputs !== 2 ||
        metabStatus?.observedOutputs < 2 ||
        homeosStatus?.version !== R146_METAB_Q48_HOMEOS_RECOVERY.partialHomeosVersion ||
        homeosStatus?.running !== true || homeosStatus?.health?.mode !== 'NEUTRAL' ||
        homeosStatus?.health?.physiologicalInputs < 2 ||
        homeosStatus?.observedOutputs !== 0 ||
        this.stateStore.getAuthority('METAB') !== null ||
        this.stateStore.getAuthority('HOMEOS') !== null
      ) {
        throw Object.assign(new Error('partial R146 METAB HOMEOS route recovery is incomplete'), {
          code: 'P1_HOMEOS_STRANDED_R146_PARTIAL_ROUTE'
        });
      }
    }
    await this.promoteHomeosShadow({ preserveRevision: true });
    if (this.runtimeRevision !== preservedRevision) {
      throw Object.assign(new Error('stranded HOMEOS recovery changed durable revision'), {
        code: 'P1_HOMEOS_STRANDED_R145_REVISION_CHANGED'
      });
    }
    return this.stateStore.getResident('resident:homeos');
  }

  async birthInteroNeutral() {
    if (
      this.interoNeutralBirthAuthorization !== R150_INTERO_SHADOW.birthAuthorization ||
      this.runtimeRevision !== R150_INTERO_SHADOW.birthRevision - 1
    ) throw Object.assign(new Error('INTERO neutral birth is not exactly authorized at R146'), {
      code: 'P1_INTERO_BIRTH_NOT_AUTHORIZED'
    });
    const { readRevisionFreeze } = require('../revision-freeze');
    const parentFreeze = readRevisionFreeze(R150_INTERO_SHADOW.parentRevision, {
      directory: this.runtimeFreezeDirectory
    });
    if (!parentFreeze.frozen || !parentFreeze.recordSha256) {
      throw Object.assign(new Error('R145F parent freeze is absent or invalid'), {
        code: 'P1_INTERO_BIRTH_PARENT_FREEZE'
      });
    }
    const manager = this.ensureResidentManager();
    const metabStatus = await manager.status('resident:metab');
    const homeosStatus = await manager.status('resident:homeos');
    if (
      metabStatus?.status !== 'RUNNING' || metabStatus?.running !== true ||
      metabStatus?.version !== '0.3.0-p1r0-homeos-feed.1' ||
      metabStatus?.health?.mode !== 'SHADOW' ||
      metabStatus?.health?.outputPolicy !== R145_HOMEOS_SHADOW.metabOutputPolicy ||
      metabStatus?.authorityOwned !== false ||
      homeosStatus?.status !== 'RUNNING' || homeosStatus?.running !== true ||
      homeosStatus?.version !== '0.2.0-p1r0-shadow.1' ||
      homeosStatus?.health?.mode !== 'SHADOW' ||
      homeosStatus?.health?.outputPolicy !== R145_HOMEOS_SHADOW.homeosOutputPolicy ||
      homeosStatus?.authorityOwned !== false || homeosStatus?.observedOutputs !== 0 ||
      this.stateStore.listAuthority().some(entry =>
        ['METAB', 'HOMEOS', 'INTERO'].includes(entry.coreId)
      )
    ) throw Object.assign(new Error('INTERO birth dependencies are not exact'), {
      code: 'P1_INTERO_BIRTH_DEPENDENCY'
    });
    const { INTERO_NEUTRAL_RESIDENT_CONTRACT } = require('../p1-r0/intero-neutral-contract');
    const moduleRelativePath = 'cores/p1-r0/intero-neutral/index.js';
    const inspected = await manager.inspect(
      moduleRelativePath,
      'resident:intero',
      INTERO_NEUTRAL_RESIDENT_CONTRACT
    );
    const { loadAndVerifyInteroNeutralBirth } = require('../p1-r0/intero-neutral-birth-authority');
    const authorization = loadAndVerifyInteroNeutralBirth({
      inspected,
      identity: this.identity,
      runtimeRevision: R150_INTERO_SHADOW.birthRevision,
      parentFreezeRecordSha256: parentFreeze.recordSha256,
      publicKeyPath: this.interoNeutralBirthPublicKeyPath,
      certificateFile: this.interoNeutralBirthCertificateFile,
      nowMs: Number(this.clock())
    });
    const binding = await this.ensureOrganismBinding({ allowCreate: false });
    const {
      PRODUCTION_STORAGE_AUTHORIZATION,
      P1ProductionExpansionPersistence
    } = require('../p1-r0/production-persistence');
    const storage = new P1ProductionExpansionPersistence({
      stateStore: this.stateStore,
      authorization: PRODUCTION_STORAGE_AUTHORIZATION
    }).initialize();
    if (
      this.stateStore.getResident('resident:intero') ||
      storage.readFounder({ organismId: this.identity.organismId, coreId: 'INTERO' }) ||
      storage.readBirthDossier('resident:intero')
    ) throw Object.assign(new Error('INTERO birth requires an empty exact cohort'), {
      code: 'P1_INTERO_BIRTH_NOT_EMPTY'
    });
    const { createNeutralInteroInitialState } = require('../p1-r0/residents/intero-neutral');
    const initialState = createNeutralInteroInitialState({
      binding,
      founder: authorization.founderBinding
    });
    const digest = crypto.createHash('sha256').update(authorization.certificateId).digest();
    digest[6] = (digest[6] & 0x0f) | 0x40;
    digest[8] = (digest[8] & 0x3f) | 0x80;
    const hex = digest.subarray(0, 16).toString('hex');
    const instanceId = [
      hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
      hex.slice(16, 20), hex.slice(20)
    ].join('-');
    const unit = await manager.attach({
      moduleRelativePath,
      binding,
      initialState,
      instanceId,
      registerResident: registration => storage.commitInteroNeutralBirth({
        founder: authorization.founderRecord,
        resident: registration,
        authorization
      }).resident,
      acceptanceCommit: this.interoAcceptanceCommit(
        storage,
        'R147_NEUTRAL_ACCEPTED_RECEPTOR_ABSENT',
        parentFreeze.recordSha256,
        false
      )
    });
    const status = await manager.status('resident:intero');
    const consumer = this.stateStore.getBiologicalConsumer('resident:intero');
    if (
      unit?.residencyId !== 'resident:intero' || status?.status !== 'RUNNING' ||
      status?.running !== true || status?.health?.mode !== 'NEUTRAL' ||
      status?.health?.receptorRoute !== 'ABSENT' || status?.authorityOwned !== false ||
      status?.observedOutputs !== 0 || status?.declaredOutputs !== 0 ||
      !consumer || consumer.active !== true || consumer.authorityEpoch !== 0 ||
      consumer.required !== false ||
      stableStringify(consumer.topics) !== stableStringify(['runtime.organism.binding']) ||
      this.stateStore.getAuthority('INTERO') !== null
    ) throw Object.assign(new Error('INTERO neutral containment proof failed'), {
      code: 'P1_INTERO_BIRTH_ACCEPTANCE'
    });
    await this.bumpRuntimeRevision('resident.intero-neutral-birth', {
      residencyId: 'resident:intero',
      coreVersion: status.version,
      parentFreezeRecordSha256: parentFreeze.recordSha256
    });
    this.statusCache = null;
    return unit;
  }

  async promoteMetabInteroRoute() {
    if (
      this.metabInteroRouteAuthorization !== R150_INTERO_SHADOW.metabRouteAuthorization ||
      this.runtimeRevision !== R150_INTERO_SHADOW.birthRevision
    ) throw Object.assign(new Error('METAB INTERO route is not exactly authorized at R147'), {
      code: 'P1_METAB_INTERO_NOT_AUTHORIZED'
    });
    const { readRevisionFreeze } = require('../revision-freeze');
    const parentFreeze = readRevisionFreeze(R150_INTERO_SHADOW.parentRevision, {
      directory: this.runtimeFreezeDirectory
    });
    if (!parentFreeze.frozen || !parentFreeze.recordSha256) {
      throw Object.assign(new Error('R145F parent freeze is absent or invalid'), {
        code: 'P1_METAB_INTERO_PARENT_FREEZE'
      });
    }
    const manager = this.ensureResidentManager();
    const interoBefore = await manager.status('resident:intero');
    const homeosBefore = await manager.status('resident:homeos');
    if (
      interoBefore?.running !== true || interoBefore?.health?.mode !== 'NEUTRAL' ||
      interoBefore?.health?.receptorRoute !== 'ABSENT' || interoBefore?.authorityOwned !== false ||
      interoBefore?.observedOutputs !== 0 ||
      homeosBefore?.running !== true || homeosBefore?.health?.mode !== 'SHADOW' ||
      homeosBefore?.version !== '0.2.0-p1r0-shadow.1' || homeosBefore?.authorityOwned !== false
    ) throw Object.assign(new Error('METAB INTERO route lacks contained consumers'), {
      code: 'P1_METAB_INTERO_DEPENDENCY'
    });
    const binding = await this.ensureOrganismBinding({ allowCreate: false });
    const { METAB_INTERO_RESIDENT_CONTRACT } = require('../p1-r0/metab-intero-contract');
    const {
      PRODUCTION_STORAGE_AUTHORIZATION,
      P1ProductionExpansionPersistence
    } = require('../p1-r0/production-persistence');
    const storage = new P1ProductionExpansionPersistence({
      stateStore: this.stateStore,
      authorization: PRODUCTION_STORAGE_AUTHORIZATION
    }).initialize();
    const unit = await manager.promoteP1ContainedGeneration({
      kind: 'METAB_INTERO_ROUTE_R148',
      moduleRelativePath: 'cores/p1-r0/metab-intero/index.js',
      binding,
      nextContract: METAB_INTERO_RESIDENT_CONTRACT,
      acceptanceCommit: this.metabInteroAcceptanceCommit(
        storage,
        'R148_INTERO_ROUTES_ACCEPTED',
        parentFreeze.recordSha256
      ),
      publishActivation: async ({ sourceCheckpoint, resident }) => {
        const payload = {
          protocol: 'stay-p1-r0-metab-intero-route-activation-v1',
          organismIdentityHash: manager.organismIdentityHash,
          residencyId: 'resident:metab',
          instanceId: resident.instanceId,
          fromVersion: resident.version,
          fromStateSchema: resident.stateSchema,
          sourceCheckpointGeneration: sourceCheckpoint.generation,
          sourceCheckpointHash: `sha256:${sourceCheckpoint.blobHash}`,
          toVersion: METAB_INTERO_RESIDENT_CONTRACT.version,
          toStateSchema: METAB_INTERO_RESIDENT_CONTRACT.stateSchema,
          targetRevision: R150_INTERO_SHADOW.metabRouteRevision,
          parentRevision: R150_INTERO_SHADOW.parentRevision,
          parentFreezeRecordSha256: parentFreeze.recordSha256,
          mode: 'SHADOW',
          authorityEpoch: '0',
          outputPolicy: R150_INTERO_SHADOW.metabOutputPolicy,
          routes: ['p1r0.metab-availability.intero', 'p1r0.metab-reserve.intero']
        };
        const signal = createSignal({
          signalId: `runtime.metab.intero-route-activation:r148:g${sourceCheckpoint.generation}:${sourceCheckpoint.blobHash}`,
          topic: 'runtime.metab.intero-route-activation',
          payload,
          trustedTime: {
            source: 'kernel', observedAtMs: Number(this.clock()),
            pulseId: `metab-intero-route-r148-g${sourceCheckpoint.generation}`
          },
          provenance: {
            producerType: 'kernel', producerId: 'living-kernel',
            authorityEpoch: R150_INTERO_SHADOW.metabRouteRevision
          },
          durability: DURABILITY.DURABLE
        });
        return this.fabric.publishBiologicalSignal(signal, {
          eventClass: 'critical', sourceVersion: KERNEL_VERSION,
          evidenceHash: manager.organismIdentityHash
        });
      }
    });
    let sample = await this.publishMetabCapacitySample();
    if (sample === false) sample = await this.publishMetabCapacitySample();
    if (sample !== true) throw Object.assign(new Error('METAB INTERO route did not accept a capacity sample'), {
      code: 'P1_METAB_INTERO_SAMPLE'
    });
    await manager.drain('resident:homeos');
    const metabStatus = await manager.status('resident:metab');
    const homeosStatus = await manager.status('resident:homeos');
    if (
      metabStatus?.running !== true || metabStatus?.health?.mode !== 'SHADOW' ||
      metabStatus?.health?.outputPolicy !== R150_INTERO_SHADOW.metabOutputPolicy ||
      metabStatus?.authorityOwned !== false || metabStatus?.declaredOutputs !== 2 ||
      metabStatus?.observedOutputs < 4 ||
      homeosStatus?.running !== true || homeosStatus?.health?.mode !== 'SHADOW' ||
      homeosStatus?.health?.physiologicalInputs < homeosBefore.health.physiologicalInputs + 2 ||
      homeosStatus?.observedOutputs !== 0 ||
      this.stateStore.listAuthority().some(entry => ['METAB', 'HOMEOS', 'INTERO'].includes(entry.coreId))
    ) throw Object.assign(new Error('METAB INTERO route acceptance proof failed'), {
      code: 'P1_METAB_INTERO_ACCEPTANCE'
    });
    await this.bumpRuntimeRevision('resident.metab-intero-route', {
      residencyId: 'resident:metab', coreVersion: metabStatus.version,
      parentFreezeRecordSha256: parentFreeze.recordSha256
    });
    this.statusCache = null;
    return unit;
  }

  async promoteHomeosInteroRoute() {
    if (
      this.homeosInteroRouteAuthorization !== R150_INTERO_SHADOW.homeosRouteAuthorization ||
      this.runtimeRevision !== R150_INTERO_SHADOW.metabRouteRevision
    ) throw Object.assign(new Error('HOMEOS INTERO route is not exactly authorized at R148'), {
      code: 'P1_HOMEOS_INTERO_NOT_AUTHORIZED'
    });
    const { readRevisionFreeze } = require('../revision-freeze');
    const parentFreeze = readRevisionFreeze(R150_INTERO_SHADOW.parentRevision, {
      directory: this.runtimeFreezeDirectory
    });
    if (!parentFreeze.frozen || !parentFreeze.recordSha256) {
      throw Object.assign(new Error('R145F parent freeze is absent or invalid'), {
        code: 'P1_HOMEOS_INTERO_PARENT_FREEZE'
      });
    }
    const manager = this.ensureResidentManager();
    const metabBefore = await manager.status('resident:metab');
    const interoBefore = await manager.status('resident:intero');
    if (
      metabBefore?.running !== true || metabBefore?.version !== '0.4.0-p1r0-intero-feed.1' ||
      metabBefore?.health?.outputPolicy !== R150_INTERO_SHADOW.metabOutputPolicy ||
      metabBefore?.authorityOwned !== false ||
      interoBefore?.running !== true || interoBefore?.health?.mode !== 'NEUTRAL' ||
      interoBefore?.health?.receptorRoute !== 'ABSENT' || interoBefore?.authorityOwned !== false
    ) throw Object.assign(new Error('HOMEOS INTERO route lacks exact dependencies'), {
      code: 'P1_HOMEOS_INTERO_DEPENDENCY'
    });
    const binding = await this.ensureOrganismBinding({ allowCreate: false });
    const { HOMEOS_INTERO_RESIDENT_CONTRACT } = require('../p1-r0/homeos-intero-contract');
    const {
      PRODUCTION_STORAGE_AUTHORIZATION,
      P1ProductionExpansionPersistence
    } = require('../p1-r0/production-persistence');
    const storage = new P1ProductionExpansionPersistence({
      stateStore: this.stateStore,
      authorization: PRODUCTION_STORAGE_AUTHORIZATION
    }).initialize();
    const unit = await manager.promoteP1ContainedGeneration({
      kind: 'HOMEOS_INTERO_ROUTE_R149',
      moduleRelativePath: 'cores/p1-r0/homeos-intero/index.js',
      binding,
      nextContract: HOMEOS_INTERO_RESIDENT_CONTRACT,
      acceptanceCommit: this.homeosInteroAcceptanceCommit(
        storage,
        'R149_INTERO_ROUTE_ACCEPTED',
        parentFreeze.recordSha256
      ),
      publishActivation: async ({ sourceCheckpoint, resident }) => {
        const payload = {
          protocol: 'stay-p1-r0-homeos-intero-route-activation-v1',
          organismIdentityHash: manager.organismIdentityHash,
          residencyId: 'resident:homeos', instanceId: resident.instanceId,
          fromVersion: resident.version, fromStateSchema: resident.stateSchema,
          sourceCheckpointGeneration: sourceCheckpoint.generation,
          sourceCheckpointHash: `sha256:${sourceCheckpoint.blobHash}`,
          toVersion: HOMEOS_INTERO_RESIDENT_CONTRACT.version,
          toStateSchema: HOMEOS_INTERO_RESIDENT_CONTRACT.stateSchema,
          targetRevision: R150_INTERO_SHADOW.homeosRouteRevision,
          parentRevision: R150_INTERO_SHADOW.parentRevision,
          parentFreezeRecordSha256: parentFreeze.recordSha256,
          mode: 'SHADOW', authorityEpoch: '0',
          outputPolicy: R150_INTERO_SHADOW.homeosOutputPolicy,
          routes: ['p1r0.homeos-stability.intero']
        };
        const signal = createSignal({
          signalId: `runtime.homeos.intero-route-activation:r149:g${sourceCheckpoint.generation}:${sourceCheckpoint.blobHash}`,
          topic: 'runtime.homeos.intero-route-activation', payload,
          trustedTime: {
            source: 'kernel', observedAtMs: Number(this.clock()),
            pulseId: `homeos-intero-route-r149-g${sourceCheckpoint.generation}`
          },
          provenance: {
            producerType: 'kernel', producerId: 'living-kernel',
            authorityEpoch: R150_INTERO_SHADOW.homeosRouteRevision
          },
          durability: DURABILITY.DURABLE
        });
        return this.fabric.publishBiologicalSignal(signal, {
          eventClass: 'critical', sourceVersion: KERNEL_VERSION,
          evidenceHash: manager.organismIdentityHash
        });
      }
    });
    let sample = await this.publishMetabCapacitySample();
    if (sample === false) sample = await this.publishMetabCapacitySample();
    if (sample !== true) throw Object.assign(new Error('HOMEOS INTERO route did not accept a capacity sample'), {
      code: 'P1_HOMEOS_INTERO_SAMPLE'
    });
    await manager.drain('resident:homeos');
    const status = await manager.status('resident:homeos');
    if (
      status?.running !== true || status?.health?.mode !== 'SHADOW' ||
      status?.health?.outputPolicy !== R150_INTERO_SHADOW.homeosOutputPolicy ||
      status?.authorityOwned !== false || status?.declaredOutputs !== 1 ||
      status?.observedOutputs < 1 ||
      this.stateStore.listAuthority().some(entry => ['METAB', 'HOMEOS', 'INTERO'].includes(entry.coreId))
    ) throw Object.assign(new Error('HOMEOS INTERO route acceptance proof failed'), {
      code: 'P1_HOMEOS_INTERO_ACCEPTANCE'
    });
    await this.bumpRuntimeRevision('resident.homeos-intero-route', {
      residencyId: 'resident:homeos', coreVersion: status.version,
      parentFreezeRecordSha256: parentFreeze.recordSha256
    });
    this.statusCache = null;
    return unit;
  }

  async promoteInteroShadow() {
    if (
      this.interoShadowPromotionAuthorization !== R150_INTERO_SHADOW.shadowAuthorization ||
      this.runtimeRevision !== R150_INTERO_SHADOW.homeosRouteRevision
    ) throw Object.assign(new Error('INTERO shadow is not exactly authorized at R149'), {
      code: 'P1_INTERO_SHADOW_NOT_AUTHORIZED'
    });
    const { readRevisionFreeze } = require('../revision-freeze');
    const parentFreeze = readRevisionFreeze(R150_INTERO_SHADOW.parentRevision, {
      directory: this.runtimeFreezeDirectory
    });
    if (!parentFreeze.frozen || !parentFreeze.recordSha256) {
      throw Object.assign(new Error('R145F parent freeze is absent or invalid'), {
        code: 'P1_INTERO_SHADOW_PARENT_FREEZE'
      });
    }
    const manager = this.ensureResidentManager();
    const metab = await manager.status('resident:metab');
    const homeos = await manager.status('resident:homeos');
    if (
      metab?.running !== true || metab?.version !== '0.4.0-p1r0-intero-feed.1' ||
      metab?.health?.outputPolicy !== R150_INTERO_SHADOW.metabOutputPolicy ||
      metab?.authorityOwned !== false ||
      homeos?.running !== true || homeos?.version !== '0.3.0-p1r0-intero-feed.1' ||
      homeos?.health?.outputPolicy !== R150_INTERO_SHADOW.homeosOutputPolicy ||
      homeos?.authorityOwned !== false
    ) throw Object.assign(new Error('INTERO shadow lacks exact committed sources'), {
      code: 'P1_INTERO_SHADOW_DEPENDENCY'
    });
    const binding = await this.ensureOrganismBinding({ allowCreate: false });
    const { INTERO_SHADOW_RESIDENT_CONTRACT } = require('../p1-r0/intero-shadow-contract');
    const {
      PRODUCTION_STORAGE_AUTHORIZATION,
      P1ProductionExpansionPersistence
    } = require('../p1-r0/production-persistence');
    const storage = new P1ProductionExpansionPersistence({
      stateStore: this.stateStore,
      authorization: PRODUCTION_STORAGE_AUTHORIZATION
    }).initialize();
    const unit = await manager.promoteP1ContainedGeneration({
      kind: 'INTERO_NEUTRAL_TO_SHADOW_R150',
      moduleRelativePath: 'cores/p1-r0/intero-shadow/index.js',
      binding,
      nextContract: INTERO_SHADOW_RESIDENT_CONTRACT,
      acceptanceCommit: this.interoAcceptanceCommit(
        storage,
        'R150_SHADOW_ACCEPTED_PERCEPTION_ONLY_RECEPTOR_ABSENT',
        parentFreeze.recordSha256,
        true
      ),
      publishActivation: async ({ sourceCheckpoint, resident }) => {
        const payload = {
          protocol: 'stay-p1-r0-intero-shadow-activation-v1',
          organismIdentityHash: manager.organismIdentityHash,
          residencyId: 'resident:intero', instanceId: resident.instanceId,
          fromVersion: resident.version, fromStateSchema: resident.stateSchema,
          sourceCheckpointGeneration: sourceCheckpoint.generation,
          sourceCheckpointHash: `sha256:${sourceCheckpoint.blobHash}`,
          toVersion: INTERO_SHADOW_RESIDENT_CONTRACT.version,
          toStateSchema: INTERO_SHADOW_RESIDENT_CONTRACT.stateSchema,
          targetRevision: R150_INTERO_SHADOW.shadowRevision,
          parentRevision: R150_INTERO_SHADOW.parentRevision,
          parentFreezeRecordSha256: parentFreeze.recordSha256,
          mode: 'SHADOW', authorityEpoch: '0',
          outputPolicy: R150_INTERO_SHADOW.interoOutputPolicy,
          receptorRoute: 'ABSENT'
        };
        const signal = createSignal({
          signalId: `runtime.intero.shadow-activation:r150:g${sourceCheckpoint.generation}:${sourceCheckpoint.blobHash}`,
          topic: 'runtime.intero.shadow-activation', payload,
          trustedTime: {
            source: 'kernel', observedAtMs: Number(this.clock()),
            pulseId: `intero-shadow-r150-g${sourceCheckpoint.generation}`
          },
          provenance: {
            producerType: 'kernel', producerId: 'living-kernel',
            authorityEpoch: R150_INTERO_SHADOW.shadowRevision
          },
          durability: DURABILITY.DURABLE
        });
        return this.fabric.publishBiologicalSignal(signal, {
          eventClass: 'critical', sourceVersion: KERNEL_VERSION,
          evidenceHash: manager.organismIdentityHash
        });
      }
    });
    let sample = await this.publishMetabCapacitySample();
    if (sample === false) sample = await this.publishMetabCapacitySample();
    if (sample !== true) throw Object.assign(new Error('INTERO shadow did not receive a source sample'), {
      code: 'P1_INTERO_SHADOW_SAMPLE'
    });
    await manager.drain('resident:homeos');
    await manager.drain('resident:intero');
    const status = await manager.status('resident:intero');
    if (
      status?.running !== true || status?.health?.mode !== 'SHADOW' ||
      status?.health?.outputPolicy !== R150_INTERO_SHADOW.interoOutputPolicy ||
      status?.health?.projectionAvailable !== true ||
      status?.health?.receptorRoute !== 'ABSENT' || status?.authorityOwned !== false ||
      status?.declaredOutputs !== 0 || status?.observedOutputs !== 0 ||
      status?.health?.biologicalOutputs !== 0 || status?.health?.physiologicalInputs < 3 ||
      this.stateStore.listAuthority().some(entry => ['METAB', 'HOMEOS', 'INTERO'].includes(entry.coreId))
    ) throw Object.assign(new Error('INTERO shadow acceptance proof failed'), {
      code: 'P1_INTERO_SHADOW_ACCEPTANCE'
    });
    await this.bumpRuntimeRevision('resident.intero-shadow', {
      residencyId: 'resident:intero', coreVersion: status.version,
      parentFreezeRecordSha256: parentFreeze.recordSha256
    });
    this.p1ExpansionFetusInstallRevisionPreservation = 150;
    this.statusCache = null;
    return unit;
  }


  async birthMetabNeutral({ recovery = false } = {}) {
    if (!this.allowMetabNeutralBirth) {
      throw Object.assign(
        new Error('R124 METAB neutral birth is not enabled'),
        { code: 'P1_METAB_BIRTH_NOT_AUTHORIZED' }
      );
    }

    let recoveryFence = null;
    if (recovery) {
      if (!this.allowMetabNeutralRecovery) {
        throw Object.assign(
          new Error('R124 METAB forward recovery is not enabled'),
          { code: 'P1_METAB_RECOVERY_NOT_AUTHORIZED' }
        );
      }
      const exactR127RevisionPreservation =
        this.runtimeRevision === 127 &&
        this.metabNeutralRecoveryRevisionPreserved;
      if (
        this.runtimeRevision !== 126 &&
        !exactR127RevisionPreservation
      ) {
        throw Object.assign(
          new Error('METAB forward recovery is fenced to runtime R126 or the exact preserved R127 cohort'),
          { code: 'P1_METAB_RECOVERY_REVISION' }
        );
      }
      recoveryFence = this.metabNeutralRecoveryFenceReader({
        markerFile: this.metabNeutralRecoveryMarkerFile,
        expectedMarkerSha256: this.metabNeutralRecoveryMarkerSha256,
        trustedUid: this.metabNeutralRecoveryTrustedUid
      });
      if (
        !recoveryFence ||
        recoveryFence.markerSha256 !== R124_METAB_RECOVERY.markerSha256 ||
        recoveryFence.failureEvidence !== R124_METAB_RECOVERY.failureEvidence
      ) {
        throw Object.assign(
          new Error('METAB forward recovery fence result is invalid'),
          { code: 'P1_METAB_RECOVERY_MARKER' }
        );
      }
    } else if (this.runtimeRevision !== 124) {
      throw Object.assign(
        new Error('METAB neutral birth is fenced to runtime R124'),
        { code: 'P1_METAB_BIRTH_REVISION' }
      );
    }

    const { readRevisionFreeze } =
      require('../revision-freeze');
    const parentFreeze =
      readRevisionFreeze(123, {
        directory: this.runtimeFreezeDirectory
      });

    if (!parentFreeze.frozen || !parentFreeze.recordSha256) {
      throw Object.assign(
        new Error('R123F parent freeze is absent or invalid'),
        { code: 'P1_METAB_BIRTH_PARENT_FREEZE' }
      );
    }

    const forbiddenResidents =
      this.stateStore.listResidents().filter(resident =>
        ['resident:homeos', 'resident:intero'].includes(
          resident.residencyId
        )
      );

    if (forbiddenResidents.length) {
      throw Object.assign(
        new Error('dependent P1 residents already exist'),
        { code: 'P1_METAB_BIRTH_DEPENDENCY_FENCE' }
      );
    }

    const forbiddenAuthority =
      this.stateStore.listAuthority().filter(entry =>
        ['METAB', 'HOMEOS', 'INTERO'].includes(entry.coreId)
      );

    if (forbiddenAuthority.length) {
      throw Object.assign(
        new Error('P1 authority already exists'),
        { code: 'P1_METAB_BIRTH_AUTHORITY_FENCE' }
      );
    }

    const manager =
      this.ensureResidentManager();
    const moduleRelativePath =
      'cores/p1-r0/metab-neutral/index.js';
    const inspected =
      await manager.inspect(
        moduleRelativePath,
        'resident:metab'
      );
    const {
      loadAndVerifyMetabNeutralBirth
    } = require('../p1-r0/metab-neutral-birth-authority');
    const authorization =
      loadAndVerifyMetabNeutralBirth({
        inspected,
        identity: this.identity,
        runtimeRevision: recovery ? 124 : this.runtimeRevision,
        parentFreezeRecordSha256:
          parentFreeze.recordSha256,
        publicKeyPath:
          this.metabNeutralBirthPublicKeyPath,
        certificateFile:
          this.metabNeutralBirthCertificateFile,
        nowMs: Number(this.clock())
      });
    const binding =
      await this.ensureOrganismBinding({
        allowCreate: false
      });
    const {
      PRODUCTION_STORAGE_AUTHORIZATION,
      P1ProductionPersistence
    } = require('../p1-r0/production-persistence');
    const storage =
      new P1ProductionPersistence({
        stateStore: this.stateStore,
        authorization:
          PRODUCTION_STORAGE_AUTHORIZATION
      }).initialize();
    const {
      createNeutralMetabInitialState
    } = require('../p1-r0/residents/metab-neutral');
    const initialState =
      createNeutralMetabInitialState({
        binding,
        founder: authorization.founderBinding
      });
    const existing =
      this.stateStore.getResident(
        'resident:metab'
      );
    const committedFounder =
      storage.readFounder({
        organismId: this.identity.organismId,
        coreId: 'METAB'
      });
    const committedDossier =
      storage.readBirthDossier('resident:metab');

    if (
      recovery &&
      (existing || committedFounder || committedDossier)
    ) {
      throw Object.assign(
        new Error('R126 METAB forward recovery requires an empty birth cohort'),
        { code: 'P1_METAB_RECOVERY_NOT_EMPTY' }
      );
    }

    if (
      committedFounder &&
      stableStringify(committedFounder) !==
        stableStringify(authorization.founderRecord)
    ) {
      throw Object.assign(
        new Error('committed METAB founder disagrees with the signed dossier'),
        { code: 'P1_METAB_BIRTH_FOUNDER_CONFLICT' }
      );
    }

    if (
      committedDossier &&
      (
        committedDossier.certificateId !==
          authorization.certificateId ||
        committedDossier.parentFreezeRecordSha256 !==
          authorization.parentFreezeRecordSha256 ||
        committedDossier.founderDossierSha256 !==
          authorization.founderDossierSha256 ||
        stableStringify(committedDossier.founderRecord) !==
          stableStringify(authorization.founderRecord) ||
        stableStringify(committedDossier.founderBinding) !==
          stableStringify(authorization.founderBinding)
      )
    ) {
      throw Object.assign(
        new Error('committed METAB birth dossier disagrees with signed authority'),
        { code: 'P1_METAB_BIRTH_DOSSIER_CONFLICT' }
      );
    }

    const acceptanceCommit =
      this.metabNeutralAcceptanceCommit(
        storage,
        recovery
          ? this.metabNeutralRecoveryRevisionPreserved
            ? 'R127_NEUTRAL_FORWARD_RECOVERED'
            : 'R126_NEUTRAL_FORWARD_RECOVERED'
          : existing
          ? 'R124_NEUTRAL_RECOVERED'
          : 'R124_NEUTRAL_ACCEPTED'
      );
    let unit;

    if (existing) {
      manager.verifyExistingIdentity(
        existing,
        inspected
      );

      if (!committedFounder || !committedDossier) {
        throw Object.assign(
          new Error('durable METAB residency has no committed founder dossier'),
          { code: 'P1_METAB_BIRTH_DOSSIER_MISSING' }
        );
      }

      if (manager.units.has('resident:metab')) {
        const chip = storage.readChip('resident:metab');
        if (
          existing.status !== 'RUNNING' ||
          !chip ||
          chip.currentState !== 'NEUTRAL'
        ) {
          throw Object.assign(
            new Error('running METAB acceptance evidence is incomplete'),
            { code: 'P1_METAB_BIRTH_ACCEPTANCE_MISSING' }
          );
        }
        unit = manager.units.get('resident:metab');
      } else {
        const checkpoint =
          await this.stateStore.readResidentCheckpoint(
            'resident:metab'
          );
        unit = checkpoint
          ? await manager.recover(
              'resident:metab',
              binding,
              { acceptanceCommit }
            )
          : await manager.resumeInitialAttachment({
              residencyId: 'resident:metab',
              binding,
              initialState,
              acceptanceCommit
            });
      }
    } else {
      const instanceDigest =
        crypto.createHash('sha256')
          .update(authorization.certificateId)
          .digest();
      instanceDigest[6] =
        (instanceDigest[6] & 0x0f) | 0x40;
      instanceDigest[8] =
        (instanceDigest[8] & 0x3f) | 0x80;
      const instanceHex =
        instanceDigest.subarray(0, 16).toString('hex');
      const instanceId = [
        instanceHex.slice(0, 8),
        instanceHex.slice(8, 12),
        instanceHex.slice(12, 16),
        instanceHex.slice(16, 20),
        instanceHex.slice(20)
      ].join('-');

      unit = await manager.attach({
        moduleRelativePath,
        binding,
        initialState,
        instanceId,
        registerResident: registration =>
          storage.commitNeutralBirth({
            founder:
              authorization.founderRecord,
            resident:
              registration,
            authorization
          }).resident,
        acceptanceCommit
      });
    }

    const status =
      await manager.status('resident:metab');
    const consumer =
      this.stateStore.getBiologicalConsumer(
        'resident:metab'
      );
    const authority =
      this.stateStore.getAuthority('METAB');

    if (
      status.status !== 'RUNNING' ||
      status.authorityOwned !== false ||
      status.observedOutputs !== 0 ||
      status.health?.mode !== 'NEUTRAL' ||
      authority !== null ||
      !consumer ||
      stableStringify(consumer.topics) !==
        stableStringify(['runtime.organism.binding']) ||
      consumer.authorityEpoch !== 0
    ) {
      throw Object.assign(
        new Error('METAB neutral post-birth containment proof failed'),
        { code: 'P1_METAB_BIRTH_CONTAINMENT' }
      );
    }

    this.statusCache = null;
    await this.stateStore.appendJournal({
      type: 'resident.metab-neutral-birth',
      at: new Date(Number(this.clock())).toISOString(),
      residencyId: 'resident:metab',
      version: status.version,
      runtimeRevision: this.runtimeRevision,
      parentFreezeRecordSha256:
        parentFreeze.recordSha256,
      certificateId:
        authorization.certificateId,
      founderDossierSha256:
        authorization.founderDossierSha256,
      recoveryMarkerSha256:
        recoveryFence?.markerSha256 || null,
      certificateTargetRevision:
        authorization.targetRevision,
      authorityOwned: false,
      observedOutputs: 0
    });

    if (this.metabNeutralRecoveryRevisionPreserved) {
      this.metabNeutralRecoveryCompletedAtPreservedRevision = true;
    }

    return unit;
  }


  async promoteSntssContinuityGenesis() {
    if (
      !this
        .allowBoundedSntssContinuityGenesisPromotion
    ) {
      throw Object.assign(
        new Error(
          'bounded SNTSS continuity-genesis promotion is not enabled'
        ),
        {
          code:
            'SNTSS_I4G_PROMOTION_NOT_AUTHORIZED'
        }
      );
    }

    const manager =
      this.ensureResidentManager();

    const binding =
      await this.ensureOrganismBinding({
        allowCreate:
          false
      });

    const parentFreezeRecordSha256 =
      'sha256:78021d86da8038e298fedb46b7371a46e1bc1e4d1cb0624205a864877ca22875';

    const unit =
      await manager
        .promoteSntssContinuityGenesis({
          moduleRelativePath:
            'cores/sntss/i4g/index.js',

          binding,

          publishGenesis:
            async ({
              sourceCheckpoint
            }) => {
              const signalId =
                'runtime.sntss.continuity-genesis.r105f.' +
                sourceCheckpoint.blobHash;

              const existing =
                this.stateStore
                  .getBiologicalEventByDeduplicationKey(
                    signalId
                  );

              if (existing) {
                return existing;
              }

              await this.bumpRuntimeRevision(
                'resident.sntss-continuity-genesis',
                {
                  residencyId:
                    'resident:sntss',
                  fromVersion:
                    '0.4.0-i3d3',
                  toVersion:
                    '0.5.0-i4g1',
                  sourceCheckpointGeneration:
                    sourceCheckpoint.generation,
                  sourceCheckpointHash:
                    sourceCheckpoint.blobHash
                }
              );

              const wallClockMs =
                Math.max(
                  Number(this.clock()),
                  Number(binding.issuedAt)
                );

              const signal =
                createSignal({
                  signalId,

                  topic:
                    'runtime.sntss.continuity-genesis',

                  payload: {
                    formatVersion:
                      1,
                    authorization:
                      'R13_SNTSS_CONTINUITY_GENESIS_SHADOW',
                    organismIdentitySha256:
                      manager.organismIdentityHash,
                    parentFreezeRevision:
                      105,
                    parentFreezeRecordSha256,
                    runtimeRevision:
                      this.runtimeRevision,
                    seedHex:
                      crypto
                        .randomBytes(32)
                        .toString('hex'),
                    sourceCheckpointGeneration:
                      sourceCheckpoint.generation,
                    sourceCheckpointHash:
                      `sha256:${sourceCheckpoint.blobHash}`
                  },

                  trustedTime: {
                    source:
                      'kernel',
                    observedAtMs:
                      wallClockMs
                  },

                  provenance: {
                    producerType:
                      'kernel',
                    producerId:
                      'living-kernel',
                    authorityEpoch:
                      this.runtimeRevision
                  },

                  durability:
                    DURABILITY.DURABLE
                });

              return this.fabric
                .publishBiologicalSignal(
                  signal,
                  {
                    eventClass:
                      'critical',
                    sourceVersion:
                      KERNEL_VERSION,
                    evidenceHash:
                      parentFreezeRecordSha256
                  }
                );
            }
        });

    this.statusCache =
      null;

    await this.stateStore
      .appendJournal({
        type:
          'resident.sntss-continuity-genesis-promoted',
        at:
          new Date().toISOString(),
        residencyId:
          unit.residencyId,
        instanceId:
          unit.resident.instanceId,
        version:
          unit.manifest.version,
        stateSchema:
          unit.manifest.stateSchema,
        runtimeRevision:
          this.runtimeRevision,
        authorityMode:
          'NONE',
        outputs:
          0
      });

    return unit;
  }

  async detachResident(
    residencyId =
      'resident:sntss'
  ) {
    if (this.durableResidentsDisabled) {
      throw Object.assign(
        new Error(
          'durable residents are disabled by the forward-compatible rollback boundary'
        ),
        { code: 'DURABLE_RESIDENTS_DISABLED' }
      );
    }

    if (!this.residentManager) {
      throw Object.assign(
        new Error(
          'resident runtime manager is unavailable'
        ),
        {
          code:
            'RESIDENT_NOT_RUNNING'
        }
      );
    }

    const result =
      await this.residentManager
        .detach(
          residencyId
        );

    this.statusCache =
      null;

    await this.stateStore
      .appendJournal({
        type:
          'resident.detach',

        at:
          new Date().toISOString(),

        residencyId,

        organismId:
          this.identity.organismId,

        checkpointHash:
          result.checkpointHash,

        statePreserved:
          true
      });

    return result;
  }


  async reattachResident(
    residencyId =
      'resident:sntss'
  ) {
    const manager =
      this.ensureResidentManager();

    const resident =
      this.stateStore
        .getResident(
          residencyId
        );

    if (!resident) {
      throw Object.assign(
        new Error(
          'resident does not exist'
        ),
        {
          code:
            'RESIDENT_UNKNOWN'
        }
      );
    }

    if (
      resident.status !==
        'DETACHED'
    ) {
      throw Object.assign(
        new Error(
          'resident is not detached'
        ),
        {
          code:
            'RESIDENT_REATTACH_STATE'
        }
      );
    }

    const inspected =
      await manager.inspect(
        resident.moduleRelativePath
      );

    manager.verifyExistingIdentity(
      resident,
      inspected
    );

    const { loadAndVerifyResidentPromotion } =
      require('./resident-promotion-authority');

    const authorization =
      loadAndVerifyResidentPromotion({
        inspected,

        action:
          'reattach-resident',

        identity:
          this.identity,

        contract:
          inspected.contract,

        required:
          !this
            .allowLaboratoryResidentAttachment,

        publicKeyPath:
          this
            .residentPromotionPublicKeyPath,

        certificateDir:
          this
            .residentPromotionCertificateDir
      });

    await this.stateStore
      .appendJournal({
        type:
          'resident.promotion-authorized',

        at:
          new Date().toISOString(),

        residencyId,

        coreId:
          resident.coreId,

        version:
          resident.version,

        action:
          'reattach-resident',

        certificateId:
          authorization
            .certificateId || null,

        authorizationClass:
          authorization
            .authorizationClass || null,

        laboratoryBypass:
          authorization
            .laboratoryBypass === true
      });

    const binding =
      await this.ensureOrganismBinding({
        allowCreate:
          false
      });

    /*
     * A detached resident necessarily missed trusted
     * pulses. Advance the Kernel runtime generation
     * before reconnecting it so the next pulse is a
     * new-revision anchor instead of a sequence gap.
     */
    await this.bumpRuntimeRevision(
      'resident.reattach',
      {
        residencyId,
        coreId:
          resident.coreId,
        coreVersion:
          resident.version
      }
    );

    const unit =
      await manager.reattach(
        residencyId,
        binding
      );

    this.statusCache =
      null;

    await this.stateStore
      .appendJournal({
        type:
          'resident.reattach',

        at:
          new Date().toISOString(),

        residencyId,

        organismId:
          this.identity.organismId,

        runtimeRevision:
          this.runtimeRevision
      });

    return unit;
  }


  async resynchronizeResident(
    residencyId =
      'resident:sntss'
  ) {
    const manager =
      this.ensureResidentManager();

    const resident =
      this.stateStore
        .getResident(
          residencyId
        );

    if (!resident) {
      throw Object.assign(
        new Error(
          'resident does not exist'
        ),
        {
          code:
            'RESIDENT_UNKNOWN'
        }
      );
    }

    if (
      resident.status !==
        'RESYNC_REQUIRED'
    ) {
      throw Object.assign(
        new Error(
          'resident is not awaiting resynchronization'
        ),
        {
          code:
            'RESIDENT_RESYNC_STATE'
        }
      );
    }

    const inspected =
      await manager.inspect(
        resident.moduleRelativePath
      );

    manager.verifyExistingIdentity(
      resident,
      inspected
    );

    const binding =
      await this.ensureOrganismBinding({
        allowCreate:
          false
      });

    /*
     * Resynchronization is a recovery operation,
     * not a promotion. It grants no new right and
     * therefore does not require a fresh release
     * certificate.
     *
     * The new runtime revision creates the trusted
     * no-catch-up boundary.
     */
    await this.bumpRuntimeRevision(
      'resident.resynchronize',
      {
        residencyId,
        coreId:
          resident.coreId,
        coreVersion:
          resident.version
      }
    );

    const result =
      await manager.resynchronize(
        residencyId,
        binding,
        this.runtimeRevision
      );

    this.statusCache =
      null;

    await this.stateStore
      .appendJournal({
        type:
          'resident.resynchronize',

        at:
          new Date().toISOString(),

        residencyId,

        organismId:
          this.identity.organismId,

        runtimeRevision:
          this.runtimeRevision,

        resyncId:
          result.record.resyncId,

        abandonedCount:
          result.record
            .abandonedCount,

        inventedBiologicalTime:
          false
      });

    return result;
  }


  async residentStatuses() {
    const residents =
      this.stateStore
        .listResidents();

    if (!residents.length) {
      return [];
    }

    const manager =
      this.ensureResidentManager();

    return Promise.all(
      residents.map(
        resident =>
          manager.status(
            resident.residencyId
          )
      )
    );
  }

  async recoverDurableResidents({
    exactCurrentCheckpointFences = null
  } = {}) {
    if (
      exactCurrentCheckpointFences !== null &&
      !(exactCurrentCheckpointFences instanceof Map)
    ) {
      throw Object.assign(
        new Error('exact current checkpoint fences must be a Map'),
        { code: 'RESIDENT_EXACT_CURRENT_CHECKPOINT_FENCES' }
      );
    }
    const residents =
      this.stateStore
        .listResidents();

    if (!residents.length) {
      return [];
    }

    const manager =
      this.ensureResidentManager();

    const eligible =
      residents.filter(
        resident =>
          [
            'ATTACHED',
            'RUNNING',
            'RECOVERING'
          ].includes(
            resident.status
          )
      );

    if (!eligible.length) {
      return residents.map(
        resident => ({
          residencyId:
            resident.residencyId,

          recovered:
            false,

          skipped:
            true,

          status:
            resident.status
        })
      );
    }

    let binding;

    try {
      /*
       * Recovery MUST NOT manufacture a missing
       * organism binding.
       */
      binding =
        await this.ensureOrganismBinding({
          allowCreate:
            false
        });
    } catch (error) {
      const results =
        [];

      for (
        const resident
        of eligible
      ) {
        try {
          this.stateStore
            .setResidentStatus(
              resident.residencyId,
              'QUARANTINED'
            );
        } catch {}

        try {
          this.stateStore
            .recordRecovery(
              'resident.kernel-recovery-failed',
              resident.coreId,
              {
                residencyId:
                  resident.residencyId,

                code:
                  error.code || null,

                message:
                  error.message
              }
            );
        } catch {}

        results.push({
          residencyId:
            resident.residencyId,

          recovered:
            false,

          code:
            error.code || null
        });
      }

      return results;
    }

    const results =
      [];

    for (
      const resident
      of residents
    ) {
      if (
        ![
          'ATTACHED',
          'RUNNING',
          'RECOVERING'
        ].includes(
          resident.status
        )
      ) {
        results.push({
          residencyId:
            resident.residencyId,

          recovered:
            false,

          skipped:
            true,

          status:
            resident.status
        });

        continue;
      }

      try {
        let recoveryOptions;
        let resumeInitialState = null;

        if (
          resident.residencyId === 'resident:metab' &&
          resident.coreId === 'METAB' &&
          resident.version === '0.1.0-p1r0-neutral.1' &&
          resident.stateSchema === 1 &&
          resident.moduleRelativePath ===
            'cores/p1-r0/metab-neutral/index.js'
        ) {
          const {
            PRODUCTION_STORAGE_AUTHORIZATION,
            P1ProductionPersistence
          } = require('../p1-r0/production-persistence');
          const storage =
            new P1ProductionPersistence({
              stateStore: this.stateStore,
              authorization:
                PRODUCTION_STORAGE_AUTHORIZATION
            }).initialize();
          const founder =
            storage.readFounder({
              organismId:
                this.identity.organismId,
              coreId: 'METAB'
            });
          const dossier =
            storage.readBirthDossier(
              'resident:metab'
            );

          if (!founder || !dossier) {
            throw Object.assign(
              new Error('durable neutral METAB resident has no founder dossier'),
              { code: 'P1_METAB_RECOVERY_DOSSIER_MISSING' }
            );
          }

          const { readRevisionFreeze } =
            require('../revision-freeze');
          const parentFreeze =
            readRevisionFreeze(123, {
              directory:
                this.runtimeFreezeDirectory
            });

          if (
            !parentFreeze.frozen ||
            parentFreeze.recordSha256 !==
              dossier.parentFreezeRecordSha256
          ) {
            throw Object.assign(
              new Error('neutral METAB recovery parent freeze disagrees with birth dossier'),
              { code: 'P1_METAB_RECOVERY_PARENT_FREEZE' }
            );
          }

          recoveryOptions = {
            acceptanceCommit:
              this.metabNeutralAcceptanceCommit(
                storage,
                'R124_NEUTRAL_FORWARD_RECOVERED'
              )
          };

          if (
            resident.status === 'ATTACHED' &&
            !await this.stateStore
              .readResidentCheckpoint(
                resident.residencyId
              )
          ) {
            const {
              createNeutralMetabInitialState
            } = require('../p1-r0/residents/metab-neutral');
            resumeInitialState =
              createNeutralMetabInitialState({
                binding,
                founder:
                  dossier.founderBinding
              });
          }
        } else if (
          resident.residencyId === 'resident:metab' &&
          resident.coreId === 'METAB' &&
          resident.version ===
            R128_METAB_SHADOW.shadowVersion &&
          resident.stateSchema === 2 &&
          resident.moduleRelativePath ===
            'cores/p1-r0/metab-shadow/index.js'
        ) {
          const {
            PRODUCTION_STORAGE_AUTHORIZATION,
            P1ProductionPersistence
          } = require('../p1-r0/production-persistence');
          const storage =
            new P1ProductionPersistence({
              stateStore: this.stateStore,
              authorization:
                PRODUCTION_STORAGE_AUTHORIZATION
            }).initialize();
          const founder = storage.readFounder({
            organismId: this.identity.organismId,
            coreId: 'METAB'
          });
          const dossier =
            storage.readBirthDossier('resident:metab');
          const chip =
            storage.readChip('resident:metab');
          const { readRevisionFreeze } =
            require('../revision-freeze');
          const birthFreeze =
            readRevisionFreeze(123, {
              directory:
                this.runtimeFreezeDirectory
            });
          const shadowFreeze =
            readRevisionFreeze(127, {
              directory:
                this.runtimeFreezeDirectory
            });

          if (
            !founder ||
            !dossier ||
            !birthFreeze.frozen ||
            birthFreeze.recordSha256 !==
              dossier.parentFreezeRecordSha256 ||
            !shadowFreeze.frozen ||
            !shadowFreeze.recordSha256 ||
            !chip ||
            !['NEUTRAL', 'SHADOW'].includes(
              chip.currentState
            ) ||
            chip.firstResidencyId !==
              'resident:metab'
          ) {
            throw Object.assign(
              new Error('durable shadow METAB continuity evidence is incomplete'),
              { code: 'P1_METAB_SHADOW_RECOVERY_EVIDENCE' }
            );
          }

          recoveryOptions = {
            acceptanceCommit:
              this.metabShadowAcceptanceCommit(
                storage,
                `R${this.runtimeRevision}_SHADOW_RECOVERED_OUTPUT_FIREWALLED`,
                shadowFreeze.recordSha256
              )
          };
        } else if (
          resident.residencyId === 'resident:metab' && resident.coreId === 'METAB' &&
          [
            '0.3.0-p1r0-homeos-feed.1',
            '0.4.0-p1r0-intero-feed.1'
          ].includes(resident.version)
        ) {
          const {
            PRODUCTION_STORAGE_AUTHORIZATION,
            P1ProductionExpansionPersistence
          } = require('../p1-r0/production-persistence');
          const storage = new P1ProductionExpansionPersistence({
            stateStore: this.stateStore,
            authorization: PRODUCTION_STORAGE_AUTHORIZATION
          }).initialize();
          const founder = storage.readFounder({
            organismId: this.identity.organismId,
            coreId: 'METAB'
          });
          const dossier = storage.legacy.readBirthDossier('resident:metab');
          const chip = storage.legacy.readChip('resident:metab');
          const { readRevisionFreeze } = require('../revision-freeze');
          const birthFreeze = readRevisionFreeze(123, { directory: this.runtimeFreezeDirectory });
          const parentRevision = resident.version === '0.4.0-p1r0-intero-feed.1' ? 145 : 141;
          const parentFreeze = readRevisionFreeze(parentRevision, { directory: this.runtimeFreezeDirectory });
          if (
            !founder || !dossier || !birthFreeze.frozen ||
            birthFreeze.recordSha256 !== dossier.parentFreezeRecordSha256 ||
            !parentFreeze.frozen || !parentFreeze.recordSha256 || !chip ||
            chip.firstResidencyId !== 'resident:metab' || chip.currentState !== 'SHADOW'
          ) throw Object.assign(new Error('routed METAB recovery evidence is incomplete'), {
            code: 'P1_METAB_ROUTED_RECOVERY_EVIDENCE'
          });
          recoveryOptions = {
            acceptanceCommit: resident.version === '0.4.0-p1r0-intero-feed.1'
              ? this.metabInteroAcceptanceCommit(
                  storage,
                  `R${this.runtimeRevision}_INTERO_FEED_RECOVERED`,
                  parentFreeze.recordSha256
                )
              : this.metabHomeosAcceptanceCommit(
                  storage,
                  `R${this.runtimeRevision}_HOMEOS_FEED_RECOVERED`,
                  parentFreeze.recordSha256
                )
          };
        } else if (
          resident.residencyId === 'resident:homeos' && resident.coreId === 'HOMEOS' &&
          [
            '0.1.0-p1r0-neutral.1',
            '0.2.0-p1r0-shadow.1',
            '0.3.0-p1r0-intero-feed.1'
          ].includes(resident.version)
        ) {
          const {
            PRODUCTION_STORAGE_AUTHORIZATION,
            P1ProductionExpansionPersistence
          } = require('../p1-r0/production-persistence');
          const storage = new P1ProductionExpansionPersistence({
            stateStore: this.stateStore,
            authorization: PRODUCTION_STORAGE_AUTHORIZATION
          }).initialize();
          const founder = storage.readFounder({
            organismId: this.identity.organismId,
            coreId: 'HOMEOS'
          });
          const dossier = storage.readBirthDossier('resident:homeos');
          const chip = storage.legacy.readChip('resident:homeos');
          const { readRevisionFreeze } = require('../revision-freeze');
          const birthFreeze = readRevisionFreeze(141, { directory: this.runtimeFreezeDirectory });
          const parentRevision = resident.version === '0.3.0-p1r0-intero-feed.1' ? 145 : 141;
          const parentFreeze = readRevisionFreeze(parentRevision, { directory: this.runtimeFreezeDirectory });
          if (
            !founder || !dossier || !birthFreeze.frozen ||
            birthFreeze.recordSha256 !== dossier.parentFreezeRecordSha256 ||
            !parentFreeze.frozen || !parentFreeze.recordSha256 || !chip ||
            chip.firstResidencyId !== 'resident:homeos'
          ) throw Object.assign(new Error('HOMEOS recovery evidence is incomplete'), {
            code: 'P1_HOMEOS_RECOVERY_EVIDENCE'
          });
          const routed = resident.version === '0.3.0-p1r0-intero-feed.1';
          const shadow = resident.version !== '0.1.0-p1r0-neutral.1';
          recoveryOptions = {
            acceptanceCommit: routed
              ? this.homeosInteroAcceptanceCommit(
                  storage,
                  `R${this.runtimeRevision}_INTERO_FEED_RECOVERED`,
                  parentFreeze.recordSha256
                )
              : this.homeosAcceptanceCommit(
                  storage,
                  `R${this.runtimeRevision}_${shadow ? 'SHADOW' : 'NEUTRAL'}_RECOVERED`,
                  parentFreeze.recordSha256,
                  shadow
                )
          };
          if (
            !shadow && resident.status === 'ATTACHED' &&
            !await this.stateStore.readResidentCheckpoint(resident.residencyId)
          ) {
            const { createNeutralHomeosInitialState } = require('../p1-r0/residents/homeos-neutral');
            resumeInitialState = createNeutralHomeosInitialState({
              binding,
              founder: dossier.founderBinding
            });
          }
        } else if (
          resident.residencyId === 'resident:intero' && resident.coreId === 'INTERO' &&
          ['0.1.0-p1r0-neutral.1', '0.2.0-p1r0-shadow.1'].includes(resident.version)
        ) {
          const {
            PRODUCTION_STORAGE_AUTHORIZATION,
            P1ProductionExpansionPersistence
          } = require('../p1-r0/production-persistence');
          const storage = new P1ProductionExpansionPersistence({
            stateStore: this.stateStore,
            authorization: PRODUCTION_STORAGE_AUTHORIZATION
          }).initialize();
          const founder = storage.readFounder({
            organismId: this.identity.organismId,
            coreId: 'INTERO'
          });
          const dossier = storage.readBirthDossier('resident:intero');
          const chip = storage.legacy.readChip('resident:intero');
          const { readRevisionFreeze } = require('../revision-freeze');
          const parentFreeze = readRevisionFreeze(145, { directory: this.runtimeFreezeDirectory });
          if (
            !founder || !dossier || !parentFreeze.frozen ||
            parentFreeze.recordSha256 !== dossier.parentFreezeRecordSha256 ||
            !chip || chip.firstResidencyId !== 'resident:intero'
          ) throw Object.assign(new Error('INTERO recovery evidence is incomplete'), {
            code: 'P1_INTERO_RECOVERY_EVIDENCE'
          });
          const shadow = resident.version === '0.2.0-p1r0-shadow.1';
          recoveryOptions = {
            acceptanceCommit: this.interoAcceptanceCommit(
              storage,
              `R${this.runtimeRevision}_${shadow ? 'SHADOW' : 'NEUTRAL'}_RECOVERED`,
              parentFreeze.recordSha256,
              shadow
            )
          };
          if (
            !shadow && resident.status === 'ATTACHED' &&
            !await this.stateStore.readResidentCheckpoint(resident.residencyId)
          ) {
            const { createNeutralInteroInitialState } = require('../p1-r0/residents/intero-neutral');
            resumeInitialState = createNeutralInteroInitialState({
              binding,
              founder: dossier.founderBinding
            });
          }
        }

        if (resumeInitialState) {
          await manager.resumeInitialAttachment({
            residencyId:
              resident.residencyId,
            binding,
            initialState:
              resumeInitialState,
            acceptanceCommit:
              recoveryOptions.acceptanceCommit
          });
        } else {
          const exactCurrentCheckpoint =
            exactCurrentCheckpointFences?.get(
              resident.residencyId
            );
          if (exactCurrentCheckpoint) {
            recoveryOptions = {
              ...(recoveryOptions || {}),
              exactCurrentCheckpoint
            };
          }
          await manager.recover(
            resident.residencyId,
            binding,
            recoveryOptions
          );
        }

        results.push({
          residencyId:
            resident.residencyId,

          recovered:
            true,

          status:
            'RUNNING'
        });
      } catch (error) {
        const current =
          this.stateStore
            .getResident(
              resident.residencyId
            );

        if (
          current &&
          ![
            'QUARANTINED',
            'RESYNC_REQUIRED',
            'DETACHED'
          ].includes(
            current.status
          )
        ) {
          try {
            this.stateStore
              .setResidentStatus(
                resident.residencyId,
                'QUARANTINED'
              );
          } catch {}
        }

        try {
          this.stateStore
            .recordRecovery(
              'resident.kernel-recovery-failed',
              resident.coreId,
              {
                residencyId:
                  resident.residencyId,

                code:
                  error.code || null,

                message:
                  error.message
              }
            );
        } catch {}

        /*
         * Resident-specific reconstruction is
         * deliberately non-fatal to organism
         * liveness.
         */
        this.logger.warn?.(
          `[STAY] resident ${resident.residencyId} recovery contained: ${error.message}`
        );

        results.push({
          residencyId:
            resident.residencyId,

          recovered:
            false,

          code:
            error.code || null
        });
      }
    }

    this.statusCache =
      null;

    return results;
  }

  async recoverColdFailedResidents() {
    const expectedRevision =
      Number(
        process.env
          .STAY_RECOVER_COLD_RESIDENTS_AT_REVISION
      );

    if (
      !Number.isSafeInteger(
        expectedRevision
      ) ||
      expectedRevision < 1 ||
      expectedRevision !==
        this.runtimeRevision
    ) {
      return [];
    }

    const candidates = [
      ...(this.metabQ48R146RecoveryActive === true
        ? [{
            residencyId:
              'resident:metab',
            status:
              'RESYNC_REQUIRED',
            allowColdQuarantine:
              false,
            requireZeroAbandonment:
              true
          }]
        : []),
      ...(this.homeosFinalR146RecoveryActive === true
        ? [{
            residencyId:
              'resident:homeos',
            status:
              'RESYNC_REQUIRED',
            allowColdQuarantine:
              false,
            exactR146HomeosBacklog:
              this.r147HomeosContinuationRecoveryActive !== true,
            exactR147ContinuationBacklog:
              this.r147HomeosContinuationRecoveryActive === true &&
              this.r147HomeosFrameBoundaryRecoveryActive !== true,
            exactR147FrameBoundaryBacklog:
              this.r147HomeosFrameBoundaryRecoveryActive === true,
            requireZeroAbandonment:
              true
          }]
        : []),
      {
        residencyId:
          'resident:sntss',
        status:
          'RESYNC_REQUIRED',
        allowColdQuarantine:
          false,
        requireZeroAbandonment:
          this.homeosFinalR147RecoveryActive === true,
        exactR147ContinuationBacklog:
          this.r147HomeosContinuationRecoveryActive === true
      },
      {
        residencyId:
          'resident:sntss',
        status:
          'QUARANTINED',
        allowColdQuarantine:
          true
      },
      {
        residencyId:
          'resident:chronobiology',
        status:
          'RESYNC_REQUIRED',
        allowColdQuarantine:
          false,
        requireZeroAbandonment:
          this.homeosFinalR147RecoveryActive === true
      },
      {
        residencyId:
          'resident:chronobiology',
        status:
          'QUARANTINED',
        allowColdQuarantine:
          true
      }
    ].filter(candidate =>
      this.stateStore
        .getResident(
          candidate.residencyId
        )
        ?.status ===
          candidate.status
    );

    if (!candidates.length) {
      return [];
    }

    const manager =
      this.ensureResidentManager();

    const binding =
      await this.ensureOrganismBinding({
        allowCreate:
          false
      });

    const results = [];

    for (const candidate of candidates) {
      try {
        const recovered =
          await manager.resynchronize(
            candidate.residencyId,
            binding,
            this.runtimeRevision,
            {
              allowColdQuarantine:
                candidate
                  .allowColdQuarantine,
              ...(candidate.exactR146HomeosBacklog === true
                ? { exactR146HomeosBacklog: true }
                : {}),
              ...(candidate.exactR147ContinuationBacklog === true
                ? { exactR147ContinuationBacklog: true }
                : {}),
              ...(candidate.exactR147FrameBoundaryBacklog === true
                ? { exactR147FrameBoundaryBacklog: true }
                : {})
            }
          );

        if (
          candidate.requireZeroAbandonment === true &&
          recovered.record.abandonedCount !== 0
        ) {
          throw Object.assign(
            new Error('exact R146 resident repair abandoned accepted biology'),
            { code: 'P1_R146_RECOVERY_ABANDONMENT' }
          );
        }

        results.push({
          residencyId:
            candidate.residencyId,
          recovered:
            true,
          coldRecovery:
            true,
          abandonedCount:
            recovered.record
              .abandonedCount,
          status:
            'RUNNING'
        });
      } catch (error) {
        try {
          this.stateStore
            .setResidentStatus(
              candidate.residencyId,
              candidate.status
            );
        } catch {}

        try {
          this.stateStore
            .recordRecovery(
              'resident.cold-recovery-failed',
              this.stateStore
                .getResident(
                  candidate.residencyId
                )
                ?.coreId || null,
              {
                residencyId:
                  candidate.residencyId,
                expectedRevision,
                code:
                  error.code || null,
                message:
                  error.message
              }
            );
        } catch {}

        results.push({
          residencyId:
            candidate.residencyId,
          recovered:
            false,
          coldRecovery:
            true,
          code:
            error.code || null
        });
      }
    }

    this.statusCache =
      null;

    return results;
  }


  async completeExactR147DeferredResidentRecovery() {
    const frameBoundaryRecovery =
      this.r147HomeosFrameBoundaryRecoveryActive === true;
    const expected = frameBoundaryRecovery
      ? R147_HOMEOS_FRAME_BOUNDARY_RECOVERY
      : R147_HOMEOS_CONTINUATION_RECOVERY;
    if (
      this.r147DeferredResidentRecovery !== true ||
      this.r147HomeosContinuationRecoveryActive !== true ||
      this.runtimeRevision !== expected.runtimeRevision ||
      this.p1ExpansionFetusInstallPreserved !== true ||
      this.heartbeatTimer !== null || this.snapshotTimer !== null
    ) {
      throw Object.assign(
        new Error('R147 deferred resident recovery is not at its exact boundary'),
        { code: 'P1_R147_CONTINUATION_BOUNDARY' }
      );
    }
    const ordinaryRecovery = await this.recoverDurableResidents({
      exactCurrentCheckpointFences: new Map([
        [expected.chronobiology.residencyId, expected.chronobiology],
        [expected.metab.residencyId, expected.metab],
        ...(frameBoundaryRecovery
          ? [[expected.sntss.residencyId, expected.sntss]]
          : [])
      ])
    });
    const coldRecovery = await this.recoverColdFailedResidents();
    const ordinary = new Map(ordinaryRecovery.map(row => [row.residencyId, row]));
    const cold = new Map(coldRecovery.map(row => [row.residencyId, row]));
    if (
      ordinary.size !== 4 || ordinary.get('resident:metab')?.recovered !== true ||
      ordinary.get('resident:chronobiology')?.recovered !== true ||
      ordinary.get('resident:homeos')?.skipped !== true ||
      ordinary.get('resident:homeos')?.status !== 'RESYNC_REQUIRED' ||
      (frameBoundaryRecovery
        ? ordinary.get('resident:sntss')?.recovered !== true
        : ordinary.get('resident:sntss')?.skipped !== true ||
          ordinary.get('resident:sntss')?.status !== 'RESYNC_REQUIRED') ||
      cold.size !== (frameBoundaryRecovery ? 1 : 2) ||
      cold.get('resident:homeos')?.recovered !== true ||
      (!frameBoundaryRecovery && cold.get('resident:sntss')?.recovered !== true) ||
      cold.get('resident:homeos')?.abandonedCount !== 0 ||
      (!frameBoundaryRecovery && cold.get('resident:sntss')?.abandonedCount !== 0)
    ) {
      throw Object.assign(
        new Error('R147 deferred resident recovery did not restore the exact cohort'),
        { code: 'P1_R147_CONTINUATION_RESIDENTS' }
      );
    }
    this.lastResidentRecovery = Object.freeze([...ordinaryRecovery, ...coldRecovery]);
    this.r147DeferredResidentRecovery = false;
    this.r147HomeosFrameBoundaryRecoveryActive = false;
    this.startMaintenance();
    this.statusCache = null;
    return this.lastResidentRecovery;
  }

  async completeExactR148DeferredResidentRecovery() {
    const expected = R148_HOMEOS_INIT_FORWARD_RECOVERY;
    if (
      this.r148DeferredResidentRecovery !== true ||
      this.r148HomeosInitForwardRecoveryActive !== true ||
      this.runtimeRevision !== expected.runtimeRevision ||
      this.p1ExpansionFetusInstallPreserved !== true ||
      this.heartbeatTimer !== null || this.snapshotTimer !== null
    ) {
      throw Object.assign(
        new Error('R148 init-forward recovery is not at its exact boundary'),
        { code: 'P1_R148_INIT_RECOVERY_BOUNDARY' }
      );
    }

    const ordinaryRecovery = await this.recoverDurableResidents({
      exactCurrentCheckpointFences: new Map(
        Object.values(expected.residents).map(fence => [fence.residencyId, fence])
      )
    });
    const recovery = new Map(ordinaryRecovery.map(row => [row.residencyId, row]));
    const count = (sql, ...args) =>
      Number(this.stateStore.db.prepare(sql).get(...args)?.count || 0);
    if (
      ordinaryRecovery.length !== Object.keys(expected.residents).length ||
      recovery.size !== Object.keys(expected.residents).length ||
      !Object.keys(expected.residents).every(id => recovery.get(id)?.recovered === true) ||
      this.runtimeRevision !== expected.runtimeRevision ||
      this.stateStore.getResident('resident:intero') ||
      count("SELECT COUNT(*) count FROM biological_deliveries WHERE status='PENDING'") !== 0 ||
      count("SELECT COUNT(*) count FROM biological_deliveries WHERE status='FAILED'") !== 0 ||
      count("SELECT COUNT(*) count FROM biological_deliveries WHERE status='ABANDONED'") !== 0 ||
      count("SELECT COUNT(*) count FROM biological_outbox_intents WHERE status='PENDING'") !== 0 ||
      count("SELECT COUNT(*) count FROM biological_outbox_intents WHERE producer_core_id IN ('sntss','SNTSS','HOMEOS','INTERO')") !== 0 ||
      this.stateStore.listAuthority().some(entry =>
        ['METAB', 'HOMEOS', 'INTERO', 'sntss', 'chronobiology'].includes(entry.coreId)
      )
    ) {
      throw Object.assign(
        new Error('R148 init-forward recovery did not restore the exact contained cohort'),
        { code: 'P1_R148_INIT_RECOVERY_COHORT' }
      );
    }

    this.lastResidentRecovery = Object.freeze(ordinaryRecovery);
    this.r148DeferredResidentRecovery = false;
    this.r148HomeosInitForwardRecoveryActive = false;
    this.startMaintenance();
    this.statusCache = null;
    return this.lastResidentRecovery;
  }

  async completeExactR148PostDurableResidentFinalization() {
    const expected = this.r148HomeosInitPostDurableFinalizationExpected ||
      R148_HOMEOS_INIT_POST_DURABLE_FINALIZATION;
    if (
      ![R148_HOMEOS_INIT_POST_DURABLE_FINALIZATION,
        R148_HOMEOS_POST_FINALIZATION_RESTART,
        R148_HOMEOS_CAPACITY_SOURCE_FINALIZATION].includes(expected) ||
      this.r148DeferredResidentRecovery !== true ||
      this.r148HomeosInitPostDurableFinalizationActive !== true ||
      this.runtimeRevision !== expected.runtimeRevision ||
      this.p1ExpansionFetusInstallPreserved !== true ||
      this.heartbeatTimer !== null || this.snapshotTimer !== null
    ) throw Object.assign(new Error('R148 post-durable finalization boundary changed'), {
      code: 'P1_R148_INIT_FINALIZATION_BOUNDARY'
    });

    const ordinaryRecovery = await this.recoverDurableResidents({
      exactCurrentCheckpointFences: new Map(
        Object.values(expected.residents).map(fence => [fence.residencyId, fence])
      )
    });
    const recovered = new Map(ordinaryRecovery.map(row => [row.residencyId, row]));
    const count = (sql, ...args) =>
      Number(this.stateStore.db.prepare(sql).get(...args)?.count || 0);
    if (
      ordinaryRecovery.length !== Object.keys(expected.residents).length ||
      recovered.size !== Object.keys(expected.residents).length ||
      !Object.keys(expected.residents).every(id => recovered.get(id)?.recovered === true) ||
      this.runtimeRevision !== expected.runtimeRevision ||
      this.stateStore.getResident('resident:intero') ||
      count("SELECT COUNT(*) count FROM biological_deliveries WHERE status IN ('PENDING','FAILED','ABANDONED')") !== 0 ||
      count("SELECT COUNT(*) count FROM biological_outbox_intents WHERE status='PENDING'") !== 0 ||
      this.stateStore.listAuthority().some(entry =>
        ['METAB', 'HOMEOS', 'INTERO', 'sntss', 'chronobiology'].includes(entry.coreId))
    ) throw Object.assign(new Error('R148 post-durable contained cohort was not restored'), {
      code: 'P1_R148_INIT_FINALIZATION_COHORT'
    });

    if (expected === R148_HOMEOS_CAPACITY_SOURCE_FINALIZATION) {
      const capacityFinalized = await this.publishMetabCapacitySample();
      const capacityRow = this.stateStore.db.prepare(`
        SELECT json,sha256 FROM metadata
        WHERE key='life:p1-r0-metab-capacity-source'
      `).get();
      const metabCheckpoint = await this.stateStore.readResidentCheckpoint('resident:metab');
      let capacitySource = null;
      try {
        const { validateCapacitySourceState } = require('../p1-r0/metab-capacity-source');
        capacitySource = validateCapacitySourceState(JSON.parse(capacityRow?.json || 'null'), {
          instanceId: expected.residents['resident:metab'].instanceId,
          residentVersion: expected.residents['resident:metab'].version
        });
      } catch {}
      if (
        capacityFinalized !== true ||
        capacityRow?.sha256 !== expected.committedCapacitySourceMetadataHash ||
        crypto.createHash('sha256').update(capacityRow?.json || '').digest('hex') !==
          expected.committedCapacitySourceMetadataHash ||
        capacitySource?.lastCommittedFrame !== expected.capacitySource.lastCommittedFrame ||
        capacitySource?.lastTrustedTimeUs !== expected.capacitySource.lastTrustedTimeUs ||
        capacitySource?.lastContinuityEpoch !== expected.capacitySource.lastContinuityEpoch ||
        capacitySource?.pending !== null ||
        metabCheckpoint?.state?.sourceState?.lastAcceptedFrame !==
          expected.capacitySource.lastCommittedFrame ||
        metabCheckpoint?.state?.sourceState?.pendingEligible !== null ||
        metabCheckpoint?.state?.sourceState?.pendingQuality !== null ||
        Number(this.stateStore.db.prepare(
          'SELECT COALESCE(MAX(sequence),0) value FROM biological_events'
        ).get()?.value || 0) !== expected.highWater ||
        count("SELECT COUNT(*) count FROM biological_deliveries WHERE status IN ('PENDING','FAILED','ABANDONED')") !== 0 ||
        count("SELECT COUNT(*) count FROM biological_outbox_intents WHERE status='PENDING'") !== 0 ||
        this.stateStore.listAuthority().some(entry =>
          ['METAB', 'HOMEOS', 'INTERO', 'sntss', 'chronobiology'].includes(entry.coreId))
      ) throw Object.assign(new Error('R148 capacity source acknowledgement was not finalized'), {
        code: 'P1_R148_CAPACITY_SOURCE_FINALIZATION'
      });
    }

    this.lastResidentRecovery = Object.freeze(ordinaryRecovery);
    this.r148DeferredResidentRecovery = false;
    this.r148HomeosInitPostDurableFinalizationActive = false;
    this.r148HomeosInitPostDurableFinalizationExpected = null;
    this.startMaintenance();
    this.startTrustedTimePulseScheduler?.();
    this.startTrustedOrganismTimePulseScheduler?.();
    this.statusCache = null;
    return this.lastResidentRecovery;
  }

  async publishTimePulse(clockStatus = 'trusted') {
    if (!['trusted', 'degraded', 'uncertain'].includes(clockStatus)) throw Object.assign(new Error('invalid runtime clock status'), { code: 'RUNTIME_CLOCK_STATUS' });

    const pulseSequence =
      ++this.trustedTimePulseSequence;

    const wallClockMs =
      Number(this.clock());

    const signalId =
      `runtime.time.pulse:${this.runtimeRevision}:${pulseSequence}`;

    const signal =
      createSignal({
        signalId,

        topic:
          'runtime.time.pulse',

        payload: {
          wallClockMs,
          runtimeRevision:
            this.runtimeRevision,
          pulseSequence,
          clockStatus
        },

        trustedTime: {
          source:
            'kernel',

          observedAtMs:
            wallClockMs,

          pulseId:
            `pulse-${this.runtimeRevision}-${pulseSequence}`
        },

        provenance: {
          producerType:
            'kernel',

          producerId:
            'living-kernel',

          authorityEpoch:
            this.runtimeRevision
        },

        durability:
          DURABILITY.DURABLE
      });

    return this.fabric
      .publishBiologicalSignal(
        signal,
        {
          eventClass:
            'durable',

          sourceVersion:
            KERNEL_VERSION
        }
      );
  }

  async publishTrustedOrganismTimePulse() {
    const evidence =
      await this.sampleTrustedTimeEvidence();

    const pulseSequence =
      ++this.trustedOrganismTimePulseSequence;

    const wallClockMs =
      Number(this.clock());

    const signalId =
      `runtime.trusted-organism-time.pulse:${this.runtimeRevision}:${pulseSequence}`;

    const signal =
      createSignal({
        signalId,
        topic:
          'runtime.trusted-organism-time.pulse',
        payload: {
          runtimeRevision:
            this.runtimeRevision,
          pulseSequence,
          ...evidence
        },
        trustedTime: {
          source:
            'kernel',
          observedAtMs:
            wallClockMs,
          pulseId:
            `trusted-organism-time-${this.runtimeRevision}-${pulseSequence}`
        },
        provenance: {
          producerType:
            'kernel',
          producerId:
            'living-kernel',
          authorityEpoch:
            this.runtimeRevision
        },
        durability:
          DURABILITY.DURABLE
      });

    return this.fabric
      .publishBiologicalSignal(
        signal,
        {
          eventClass:
            'durable',
          authorityEpoch:
            this.runtimeRevision,
          deduplicationKey:
            signalId
        }
      );
  }

  async sampleTrustedTimeEvidence() {
    if (!this.trustedOrganismTime) {
      return Object.freeze({
        status:
          'TRUSTED_TIME_UNAVAILABLE',
        trustedTimeUs:
          null,
        continuityEpoch:
          null,
        reasonCode:
          'TRUSTED_TIME_PROVIDER_UNAVAILABLE'
      });
    }

    const sampled =
      await this.trustedOrganismTime
        .sample();

    const trusted =
      sampled?.status ===
        'TRUSTED' &&
      Number.isSafeInteger(
        sampled.trustedTimeUs
      ) &&
      sampled.trustedTimeUs >= 0 &&
      Number.isSafeInteger(
        sampled.continuityEpoch
      ) &&
      sampled.continuityEpoch >= 1;

    return Object.freeze({
      status:
        trusted
          ? 'TRUSTED'
          : 'TRUSTED_TIME_UNCERTAIN',
      trustedTimeUs:
        trusted
          ? sampled.trustedTimeUs
          : null,
      continuityEpoch:
        trusted
          ? sampled.continuityEpoch
          : null,
      reasonCode:
        trusted
          ? null
          : sampled?.reasonCode ||
            'TRUSTED_TIME_UNCERTAIN'
    });
  }

  async publishMetabCapacitySample() {
    if (this.metabCapacitySourcePromise) {
      return this.metabCapacitySourcePromise;
    }

    const operation =
      this.runMetabCapacitySample();

    this.metabCapacitySourcePromise =
      operation;

    try {
      return await operation;
    } finally {
      if (this.metabCapacitySourcePromise === operation) {
        this.metabCapacitySourcePromise = null;
      }
    }
  }

  async runMetabCapacitySample() {
    const resident =
      this.stateStore.getResident('resident:metab');
    const manager = this.residentManager;

    const outputFirewalled =
      resident?.version === R128_METAB_SHADOW.shadowVersion &&
      resident?.stateSchema === 2 &&
      resident?.moduleRelativePath === 'cores/p1-r0/metab-shadow/index.js';
    const homeosFeed =
      resident?.version === '0.3.0-p1r0-homeos-feed.1' &&
      resident?.stateSchema === 3 &&
      resident?.moduleRelativePath === 'cores/p1-r0/metab-homeos/index.js';
    const interoFeed =
      resident?.version === '0.4.0-p1r0-intero-feed.1' &&
      resident?.stateSchema === 4 &&
      resident?.moduleRelativePath === 'cores/p1-r0/metab-intero/index.js';
    if (
      !manager ||
      (!outputFirewalled && !homeosFeed && !interoFeed) ||
      resident?.status !== 'RUNNING' ||
      !manager.units.has('resident:metab')
    ) {
      return false;
    }

    const {
      SOURCE_CORE_ID,
      PENDING_VERSION_MIGRATION_POLICY,
      SOURCE_STATE_KEY,
      SOURCE_VERSION,
      commitCapacitySample,
      createCapacitySourceState,
      migrateCapacitySourceResidentVersion,
      stageCapacitySample,
      validateCapacitySourceState
    } = require('../p1-r0/metab-capacity-source');

    let sourceState =
      await this.stateStore.readLife(
        SOURCE_STATE_KEY,
        null
      );
    let checkpoint =
      await this.stateStore.readResidentCheckpoint(
        'resident:metab'
      );
    const residentState = value => interoFeed
      ? value?.homeosFeedState?.sourceState
      : homeosFeed
        ? value?.sourceState
        : value;
    let checkpointResidentState = residentState(checkpoint?.state);

    if (!sourceState) {
      if (
        checkpointResidentState?.lastAcceptedFrame !== 0 ||
        checkpointResidentState?.lastAcceptedTimeMs !== null ||
        checkpointResidentState?.pendingEligible !== null ||
        checkpointResidentState?.pendingQuality !== null
      ) {
        throw Object.assign(
          new Error('METAB capacity source history is missing'),
          { code: 'P1_METAB_CAPACITY_SOURCE_STATE' }
        );
      }
      sourceState = createCapacitySourceState({
        instanceId: resident.instanceId,
        residentVersion: resident.version
      });
      await this.stateStore.writeLife(
        SOURCE_STATE_KEY,
        sourceState
      );
    } else {
      if (
        (homeosFeed || interoFeed) &&
        sourceState.residentVersion !== resident.version
      ) {
        sourceState = migrateCapacitySourceResidentVersion(sourceState, {
          instanceId: resident.instanceId,
          fromVersion: sourceState.residentVersion,
          toVersion: resident.version,
          pendingMigrationPolicy:
            PENDING_VERSION_MIGRATION_POLICY,
          checkpointFrame:
            Number(checkpointResidentState?.lastAcceptedFrame),
          checkpointPairComplete:
            checkpointResidentState?.pendingEligible === null &&
            checkpointResidentState?.pendingQuality === null &&
            checkpointResidentState?.engineState?.outputSequence === '0'
        });
        await this.stateStore.writeLife(SOURCE_STATE_KEY, sourceState);
      } else {
        sourceState = validateCapacitySourceState(
          sourceState,
          {
            instanceId: resident.instanceId,
            residentVersion: resident.version
          }
        );
      }
    }

    const checkpointFrame =
      Number(checkpointResidentState?.lastAcceptedFrame);
    const allowedCheckpointFrames =
      sourceState.pending
        ? [
            sourceState.lastCommittedFrame,
            sourceState.pending.sampleFrame
          ]
        : [sourceState.lastCommittedFrame];

    if (
      !allowedCheckpointFrames.includes(checkpointFrame) ||
      checkpointResidentState?.engineState?.outputSequence !== '0'
    ) {
      throw Object.assign(
        new Error('METAB capacity source disagrees with committed physiology'),
        { code: 'P1_METAB_CAPACITY_SOURCE_STATE' }
      );
    }

    if (!sourceState.pending) {
      const evidence =
        await this.sampleTrustedTimeEvidence();

      if (
        evidence.status !== 'TRUSTED' ||
        !Number.isSafeInteger(evidence.trustedTimeUs)
      ) {
        this.lastMetabCapacitySource = Object.freeze({
          ok: false,
          reasonCode:
            evidence.reasonCode ||
            'TRUSTED_TIME_UNCERTAIN',
          lastCommittedFrame:
            sourceState.lastCommittedFrame,
          pendingFrame: null
        });
        return false;
      }

      const staged = stageCapacitySample(
        sourceState,
        {
          trustedTimeUs:
            evidence.trustedTimeUs,
          continuityEpoch:
            evidence.continuityEpoch,
          metrics:
            this.metabCapacitySampler()
        }
      );

      if (!staged.pending) {
        this.lastMetabCapacitySource = Object.freeze({
          ok: true,
          reasonCode:
            'FRAME_INTERVAL_NOT_REACHED',
          lastCommittedFrame:
            sourceState.lastCommittedFrame,
          pendingFrame: null
        });
        return false;
      }

      sourceState = staged;
      await this.stateStore.writeLife(
        SOURCE_STATE_KEY,
        sourceState
      );
    }

    const pending = sourceState.pending;
    const trustedTime = {
      source: 'kernel',
      observedAtMs: pending.observedAtMs,
      pulseId: pending.pulseId
    };
    const provenance = {
      producerType: 'kernel',
      producerId: SOURCE_CORE_ID,
      authorityEpoch: 0
    };
    const eligibleSignal = createSignal({
      signalId: pending.eligibleSignalId,
      topic: 'resource.capacity.eligible.v1',
      payload: pending.eligiblePayload,
      trustedTime,
      provenance,
      durability: DURABILITY.DURABLE
    });
    const qualitySignal = deriveSignal(
      eligibleSignal,
      {
        signalId: pending.qualitySignalId,
        topic: 'resource.capacity.quality.v1',
        payload: pending.qualityPayload,
        trustedTime,
        provenance,
        durability: DURABILITY.DURABLE
      }
    );

    const eligibleEvent =
      await this.fabric.publishBiologicalSignal(
        eligibleSignal,
        {
          eventClass: 'durable',
          sourceVersion: SOURCE_VERSION
        }
      );
    const qualityEvent =
      await this.fabric.publishBiologicalSignal(
        qualitySignal,
        {
          eventClass: 'durable',
          sourceVersion: SOURCE_VERSION
        }
      );

    await manager.drain(
      'resident:metab',
      qualityEvent.sequence
    );

    const eligibleDelivery =
      this.stateStore.getBiologicalDelivery(
        'resident:metab',
        eligibleEvent.sequence
      );
    const qualityDelivery =
      this.stateStore.getBiologicalDelivery(
        'resident:metab',
        qualityEvent.sequence
      );
    checkpoint =
      await this.stateStore.readResidentCheckpoint(
        'resident:metab'
      );
    checkpointResidentState = residentState(checkpoint?.state);
    const routedState = interoFeed
      ? checkpoint?.state?.homeosFeedState?.routedEngineState
      : homeosFeed
        ? checkpoint?.state?.routedEngineState
        : null;
    const emittedOutputSequence = interoFeed
      ? checkpoint?.state?.homeosFeedState?.emittedOutputSequence
      : homeosFeed
        ? checkpoint?.state?.emittedOutputSequence
        : '0';
    const interoRoutedState = interoFeed
      ? checkpoint?.state?.interoEngineState
      : null;
    const interoOutputSequence = interoFeed
      ? checkpoint?.state?.interoOutputSequence
      : '0';

    if (
      eligibleDelivery?.status !== 'ACKED' ||
      qualityDelivery?.status !== 'ACKED' ||
      checkpointResidentState?.lastAcceptedFrame !==
        pending.sampleFrame ||
      checkpointResidentState?.lastAcceptedTimeMs !==
        pending.observedAtMs ||
      checkpointResidentState?.engineState?.frameIndex !==
        pending.sampleFrame ||
      checkpointResidentState?.engineState?.outputSequence !== '0' ||
      checkpointResidentState?.pendingEligible !== null ||
      checkpointResidentState?.pendingQuality !== null ||
      (
        (homeosFeed || interoFeed) &&
        (
          routedState?.frameIndex !== pending.sampleFrame ||
          !/^[1-9][0-9]*$/.test(String(emittedOutputSequence || '')) ||
          BigInt(routedState?.outputSequence || '-1') !== BigInt(emittedOutputSequence) * 2n
        )
      ) ||
      (
        interoFeed &&
        (
          interoRoutedState?.frameIndex !== pending.sampleFrame ||
          !/^[1-9][0-9]*$/.test(String(interoOutputSequence || '')) ||
          BigInt(interoOutputSequence) % 2n !== 0n ||
          BigInt(interoRoutedState?.outputSequence || '-1') % 4n !== 0n
        )
      ) ||
      this.stateStore.getAuthority('METAB') !== null ||
      Number(this.stateStore.db.prepare(`
        SELECT COUNT(*) AS count
        FROM biological_outbox_intents
        WHERE producer_core_id='METAB' AND status='PENDING'
      `).get()?.count || 0) !== 0
    ) {
      throw Object.assign(
        new Error('METAB capacity pair did not commit atomically into contained physiology'),
        { code: 'P1_METAB_CAPACITY_COMMIT' }
      );
    }

    sourceState = commitCapacitySample(sourceState);
    await this.stateStore.writeLife(
      SOURCE_STATE_KEY,
      sourceState
    );
    this.lastMetabCapacitySource = Object.freeze({
      ok: true,
      reasonCode: null,
      lastCommittedFrame:
        sourceState.lastCommittedFrame,
      continuityEpoch:
        sourceState.lastContinuityEpoch,
      pendingFrame: null,
      eligibleSequence:
        eligibleEvent.sequence,
      qualitySequence:
        qualityEvent.sequence
    });
    this.statusCache = null;

    return true;
  }

  async stageCoreUpgrade(modulePath) {
    const unit = await this.upgrades.stage(path.resolve(modulePath));
    await this.bumpRuntimeRevision('core.stage', {
      coreId: unit.manifest ? unit.manifest.coreId : null,
      coreVersion: unit.manifest ? unit.manifest.version : null
    });
    return unit;
  }

  async commitCoreUpgrade(coreId, options) {
    const result = await this.upgrades.commit(coreId, options);
    await this.bumpRuntimeRevision('core.commit', {
      coreId,
      coreVersion: result.active ? result.active.version : null
    });
    return result;
  }

  async rollbackCore(coreId) {
    const result = await this.upgrades.rollback(coreId);
    await this.bumpRuntimeRevision('core.rollback', {
      coreId,
      coreVersion: result.active ? result.active.version : null
    });
    return result;
  }

  async publish(topic, payload, meta) {
    return this.fabric.publish(topic, payload, meta);
  }

  async health(knownCores = null) {
    const cores = knownCores || await this.registry.status();
    const persistence = await this.stateStore.persistenceStatus(
      Math.max(120000, this.heartbeatIntervalMs * 4)
    );
    const unhealthyCores = cores
      .filter(slot => slot.active && slot.active.health && slot.active.health.ok === false)
      .map(slot => slot.coreId);
    const blockingCores = cores
      .filter(slot => slot.active && slot.active.manifest?.priority === 'critical' && slot.active.health && slot.active.health.ok === false)
      .map(slot => slot.coreId);
    const maintenanceErrors = Object.values(this.maintenanceErrors);

    const residencies =
      await this.residentStatuses();

    const unhealthyResidents =
      residencies
        .filter(
          resident =>
            resident &&
            (
              [
                'ATTACHED',
                'RECOVERING',
                'QUARANTINED',
                'RESYNC_REQUIRED'
              ].includes(
                resident.status
              ) ||
              (
                resident.status ===
                  'RUNNING' &&
                (
                  resident.running !== true ||
                  !resident.health ||
                  resident.health.ok !== true ||
                  resident.terminalPersistenceError ||
                  resident.teardownError
                )
              )
            )
        )
        .map(
          resident =>
            resident.residencyId
        );

    return {
      /*
       * Residents are deliberately visible but
       * non-blocking.
       */
      ok: persistence.ok && blockingCores.length === 0 && maintenanceErrors.length === 0,
      kernelVersion: KERNEL_VERSION,
      runtimeRevision: this.runtimeRevision,
      persistence,
      maintenanceErrors,
      unhealthyCores,
      blockingCores,
      unhealthyResidents,
      residencies,
      eventFabric: this.fabric.status(),
      biologicalLedger: this.stateStore.biologicalLedgerStatus(),
      biologicalRetention: this.lastBiologicalRetention,
      metabCapacitySource:
        this.lastMetabCapacitySource,
      authority: this.stateStore.listAuthority(),
      computeFabric: this.computeFabric.status()
    };
  }

  async buildStatus() {
    const realCores = await this.registry.status();
    const health = await this.health(realCores);

    const persistenceContract = {
      coreId: 'kernel-persistence',
      active: {
        manifest: {
          coreId: 'kernel-persistence',
          version: KERNEL_VERSION,
          protocol: 'genesis-kernel-health-v2',
          stateSchema: 2,
          hotSwap: false,
          inputs: [],
          outputs: []
        },
        mode: 'active',
        handledEvents: 0,
        bufferedOutputs: 0,
        health: {
          ok: health.persistence.ok && health.maintenanceErrors.length === 0,
          persistence: health.persistence,
          maintenanceErrors: health.maintenanceErrors
        }
      },
      candidate: null,
      standby: null
    };

    return {
      kernel: {
        version: KERNEL_VERSION,
        runtimeRevision: this.runtimeRevision,
        organismId: this.identity ? this.identity.organismId : null,
        startedAt: this.startedAt,
        pid: process.pid,
        dataDir: this.dataDir
      },
      health,
      snapshots: await this.stateStore.snapshotStatus(),
      authority: this.stateStore.listAuthority(),
      eventFabric: this.fabric.status(),
      biologicalLedger: this.stateStore.biologicalLedgerStatus(),
      computeFabric: this.computeFabric.status(),

      /*
       * Residents are intentionally not inserted
       * into cores[] because cores[] represents the
       * RuntimeRegistry authority topology.
       */
      residencies:
        health.residencies,

      cores: [persistenceContract, ...realCores]
    };
  }

  async status({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.statusCache && now - this.statusCache.at < this.statusCacheTtlMs) return this.statusCache.value;
    if (this.statusInFlight) return this.statusInFlight;
    this.statusInFlight = this.buildStatus();
    try {
      const value = await this.statusInFlight;
      this.statusCache = { at: Date.now(), value };
      return value;
    } finally {
      this.statusInFlight = null;
    }
  }

  async stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.heartbeatTimer = null;
    this.snapshotTimer = null;

    for (const slot of this.registry.slots.values()) await slot.persistActive();

    /*
     * Resident shutdown checkpoints physiology
     * before the final runtime snapshot is created.
     *
     * Status remains RUNNING in persistent metadata,
     * allowing automatic reconstruction on the next
     * Kernel generation.
     */
    if (this.residentManager) {
      await this.residentManager
        .shutdown();
    }

    await this.writeHeartbeat();
    await this.createSnapshot('kernel-stop');
    await this.registry.stop();

    await this.stateStore.appendJournal({
      type: 'kernel.stop',
      at: new Date().toISOString(),
      version: KERNEL_VERSION,
      runtimeRevision: this.runtimeRevision,
      organismId: this.identity ? this.identity.organismId : null
    });
    this.stateStore.close();
  }
}

module.exports = {
  LivingKernel,
  KERNEL_VERSION,
  R124_METAB_RECOVERY,
  R128_METAB_SHADOW,
  R135_METAB_SHADOW_RECOVERY,
  R137_METAB_SHADOW_RECOVERY,
  R139_METAB_SHADOW_RECOVERY,
  R145_HOMEOS_SHADOW,
  R146_METAB_Q48_HOMEOS_RECOVERY,
  R147_HOMEOS_FORWARD_RECOVERY,
  R147_HOMEOS_CONTINUATION_RECOVERY,
  R147_HOMEOS_FRAME_BOUNDARY_RECOVERY,
  R148_HOMEOS_INIT_FORWARD_RECOVERY,
  R148_HOMEOS_INIT_POST_DURABLE_FINALIZATION,
  R148_HOMEOS_POST_FINALIZATION_RESTART,
  R148_HOMEOS_CAPACITY_SOURCE_FINALIZATION,
  R150_INTERO_SHADOW,
  isBoundedMetabPromotionTail,
  defaultMetabCapacitySampler,
  readR124MetabRecoveryFence
};
