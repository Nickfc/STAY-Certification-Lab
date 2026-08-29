'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { EventFabric } = require('./event-fabric');
const {
  DURABILITY,
  createSignal
} = require('./biological-fabric');
const { StateStore } = require('./state-store');
const { RuntimeRegistry } = require('./registry');
const { UpgradeManager } = require('./upgrades');
const { ComputeFabric } = require('../compute/compute-fabric');
const { stableStringify } = require('./canonical-json');

const KERNEL_VERSION = '0.8.11.3';

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
      CHRONOBIOLOGY_R4_RESIDENT_CONTRACT
    } = require('./chronobiology-resident-contracts');

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
      [CHRONOBIOLOGY_R4_RESIDENT_CONTRACT, 'cores/chronobiology/c3r4/index.js'],
      [CHRONOBIOLOGY_R3_RESIDENT_CONTRACT, 'cores/chronobiology/c3r3/index.js'],
      [CHRONOBIOLOGY_R2_RESIDENT_CONTRACT, 'cores/chronobiology/c3r2/index.js']
    ].find(([contract, moduleRelativePath]) =>
      durableChronobiology?.version === contract.version &&
      durableChronobiology?.stateSchema === contract.stateSchema &&
      durableChronobiology?.moduleRelativePath === moduleRelativePath
    )?.[0] || CHRONOBIOLOGY_RESIDENT_CONTRACT;

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
            chronobiologyContract
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
    await this.bumpRuntimeRevision('kernel.start', { version: KERNEL_VERSION, pid: process.pid });

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
      durableResidents.length > 0
    ) {
      this.ensureResidentManager();

      const ordinaryRecovery =
        await this.recoverDurableResidents();

      const coldRecovery =
        await this.recoverColdFailedResidents();

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
    await this.createSnapshot('kernel-start');
    this.startMaintenance();
    return this;
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
    const unit = await this.upgrades.installInitial(path.resolve(modulePath));
    await this.bumpRuntimeRevision('core.install', {
      coreId: unit.manifest ? unit.manifest.coreId : null,
      coreVersion: unit.manifest ? unit.manifest.version : null
    });
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

  async recoverDurableResidents() {
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
        await manager.recover(
          resident.residencyId,
          binding
        );

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
      {
        residencyId:
          'resident:sntss',
        status:
          'RESYNC_REQUIRED',
        allowColdQuarantine:
          false
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
          false
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
                  .allowColdQuarantine
            }
          );

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

module.exports = { LivingKernel, KERNEL_VERSION };
