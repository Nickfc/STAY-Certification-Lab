'use strict';

const path =
  require('node:path');

const crypto =
  require('node:crypto');

const {
  inspectCoreModule
} = require(
  './core-loader'
);

const {
  CoreHostClient
} = require(
  './core-host-client'
);

const {
  BoundedActorQueue
} = require(
  './actor-queue'
);

const {
  stableStringify
} = require(
  './canonical-json'
);


const L0_SNTSS_CONTRACT =
  Object.freeze({
    residencyId:
      'resident:sntss',

    coreId:
      'sntss',

    role:
      'resident-physiology',

    version:
      '0.4.0-i3d3',

    stateSchema:
      4,

    stage:
      'i3d-durable-receptor-regulation',

    priority:
      'optional',

    productionEligible:
      false,

    inputs:
      Object.freeze([
        'runtime.organism.binding',
        'runtime.time.pulse'
      ]),

    outputs:
      Object.freeze([]),

    packagePolicyHash:
      'sha256:5708b07f711f4d681c67c518e34450d57559b6fe51316060d1c83bd2c8a46765'
  });


const RESIDENT_SIGNALLING =
  Object.freeze({
    FORBIDDEN:
      'FORBIDDEN',

    LAB_SHADOW_ONLY:
      'LAB_SHADOW_ONLY'
  });


function normalizeResidentContract(
  input
) {
  if (
    !input ||
    typeof input !==
      'object' ||
    Array.isArray(input)
  ) {
    fail(
      'resident contract must be an object',
      'RESIDENT_CONTRACT_INVALID'
    );
  }

  const requiredText =
    [
      'residencyId',
      'coreId',
      'role',
      'version',
      'stage',
      'priority'
    ];

  for (
    const field
    of requiredText
  ) {
    if (
      typeof input[field] !==
        'string' ||
      input[field].trim() ===
        ''
    ) {
      fail(
        `resident contract field is invalid: ${field}`,
        'RESIDENT_CONTRACT_INVALID'
      );
    }
  }

  if (
    !Number.isSafeInteger(
      input.stateSchema
    ) ||
    input.stateSchema < 1 ||
    input.productionEligible !==
      false ||
    !Array.isArray(input.inputs) ||
    !Array.isArray(input.outputs) ||
    input.inputs.some(
      topic =>
        typeof topic !==
          'string' ||
        topic.trim() ===
          ''
    ) ||
    input.outputs.some(
      topic =>
        typeof topic !==
          'string' ||
        topic.trim() ===
          ''
    )
  ) {
    fail(
      'resident contract shape is invalid',
      'RESIDENT_CONTRACT_INVALID'
    );
  }

  const signalling =
    input.signalling ||
    (
      input.outputs.length ===
        0
        ? RESIDENT_SIGNALLING
            .FORBIDDEN
        : null
    );

  if (
    !Object.values(
      RESIDENT_SIGNALLING
    ).includes(
      signalling
    ) ||
    (
      signalling ===
        RESIDENT_SIGNALLING
          .FORBIDDEN &&
      input.outputs.length !==
        0
    ) ||
    (
      signalling ===
        RESIDENT_SIGNALLING
          .LAB_SHADOW_ONLY &&
      input.outputs.length ===
        0
    ) ||
    (
      input.packagePolicyHash !==
        null &&
      input.packagePolicyHash !==
        undefined &&
      !/^sha256:[0-9a-f]{64}$/.test(
        input.packagePolicyHash
      )
    )
  ) {
    fail(
      'resident signalling contract is invalid',
      'RESIDENT_CONTRACT_INVALID'
    );
  }

  return Object.freeze({
    ...input,

    inputs:
      Object.freeze([
        ...input.inputs
      ]),

    outputs:
      Object.freeze([
        ...input.outputs
      ]),

    packagePolicyHash:
      input.packagePolicyHash ??
      null,

    signalling
  });
}


function createResidentContractRegistry(
  contracts
) {
  if (
    !Array.isArray(contracts) ||
    contracts.length < 1
  ) {
    fail(
      'resident contract registry is empty',
      'RESIDENT_CONTRACT_INVALID'
    );
  }

  const byResidencyId =
    new Map();

  const byCoreId =
    new Map();

  for (
    const entry
    of contracts
  ) {
    const contract =
      normalizeResidentContract(
        entry
      );

    if (
      byResidencyId.has(
        contract.residencyId
      ) ||
      byCoreId.has(
        contract.coreId
      )
    ) {
      fail(
        'resident contract identity is duplicated',
        'RESIDENT_CONTRACT_DUPLICATE'
      );
    }

    byResidencyId.set(
      contract.residencyId,
      contract
    );

    byCoreId.set(
      contract.coreId,
      contract
    );
  }

  return Object.freeze({
    byResidencyId,
    byCoreId
  });
}


/*
 * The CoreHost handler deadline bounds only the in-worker biological
 * computation. A resident queue handler additionally includes the durable
 * checkpoint + ledger ACK commit after CoreHost dispatch. Reusing the same
 * deadline for both layers leaves zero persistence budget and can convert a
 * healthy, bounded host response into a false resident chronology failure.
 *
 * Keep the host deadline unchanged and independently bound the complete
 * resident transition. The outer deadline is always strictly larger while
 * remaining finite/fail-closed.
 */
function residentTransitionTimeoutMs(
  handlerTimeoutMs
) {
  const hostBudget =
    Math.max(
      1,
      Number(
        handlerTimeoutMs
      ) || 5000
    );

  return Math.max(
    1000,
    Math.min(
      30000,
      hostBudget * 2 + 500
    )
  );
}


function residentDrainTimeoutMs(
  handlerTimeoutMs
) {
  const transitionBudget =
    residentTransitionTimeoutMs(
      handlerTimeoutMs
    );

  const recoveryBudget =
    Math.max(
      5000,
      transitionBudget * 3
    );

  /*
   * A cutover/drain barrier is not a CoreHost compute deadline. It must remain
   * bounded while allowing two bounded host recoveries plus three complete
   * transition attempts for the same durable event.
   */
  return Math.min(
    30000,
    recoveryBudget * 2 +
      transitionBudget * 3 +
      1000
  );
}


function replayRetryableCoreHostError(error) {
  return ['COREHOST_TIMEOUT', 'COREHOST_EXIT'].includes(String(error?.code || ''));
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


async function waitForResidentCoreHostRecovery(client, timeoutMs = 5000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (client.quarantined) {
      throw Object.assign(new Error('resident CoreHost quarantined during replay recovery'), {
        code: 'RESIDENT_REPLAY_COREHOST_QUARANTINED'
      });
    }

    if (!client.restarting && client.child?.connected && client.lifecycle !== 'recovering') {
      return;
    }

    await sleep(10);
  }

  throw Object.assign(new Error('resident CoreHost did not recover before replay retry deadline'), {
    code: 'RESIDENT_REPLAY_COREHOST_RECOVERY_TIMEOUT'
  });
}


function sha256(value) {
  return (
    'sha256:' +
    crypto
      .createHash('sha256')
      .update(value)
      .digest('hex')
  );
}


function canonicalHash(value) {
  return sha256(
    stableStringify(value)
  );
}


function transitionId(
  residencyId,
  event
) {
  return canonicalHash({
    protocol:
      'stay-resident-transition-v1',

    residencyId,

    eventId:
      event.id,

    sequence:
      event.sequence
  });
}


function fail(
  message,
  code
) {
  throw Object.assign(
    new Error(message),
    { code }
  );
}


class ResidentManager {
  constructor({
    releaseRoot,
    stateStore,
    fabric,
    identity,
    logger = console,
    clock = () => Date.now(),
    contract = L0_SNTSS_CONTRACT,
    contracts = null
  }) {
    if (!releaseRoot) {
      throw new Error(
        'ResidentManager requires releaseRoot'
      );
    }

    if (!stateStore || !fabric) {
      throw new Error(
        'ResidentManager requires StateStore and EventFabric'
      );
    }

    if (
      !identity ||
      identity.lineage !==
        'STAY/Genesis'
    ) {
      fail(
        'resident manager organism identity is invalid',
        'RESIDENT_IDENTITY_INVALID'
      );
    }

    this.releaseRoot =
      path.resolve(
        releaseRoot
      );

    this.stateStore =
      stateStore;

    this.fabric =
      fabric;

    this.identity =
      structuredClone(
        identity
      );

    this.organismIdentityHash =
      canonicalHash(
        this.identity
      );

    this.logger =
      logger;

    this.clock =
      clock;

    this.contractRegistry =
      createResidentContractRegistry(
        contracts ??
        [
          contract
        ]
      );

    /*
     * Preserve the original default-contract surface for every existing L0
     * caller. Generic operations resolve a contract explicitly from the
     * resident/core identity instead.
     */
    this.contract =
      this.contractRegistry
        .byResidencyId
        .get(
          contract.residencyId
        ) ||
      this.contractRegistry
        .byResidencyId
        .values()
        .next()
        .value;

    this.units =
      new Map();

    this.closed =
      false;

    /*
     * IMPORTANT:
     *
     * This subscriber intentionally does not return
     * the resident delivery Promise.
     *
     * Durable organism publication therefore does
     * not wait for optional resident physiology.
     */
    this.unsubscribe =
      this.fabric.subscribeAll(
        event => {
          try {
            this.observe(
              event
            );
          } catch (error) {
            this.recordBoundaryFailure(
              error,
              event
            );
          }

          return undefined;
        }
      );
  }


  recordBoundaryFailure(
    error,
    event
  ) {
    try {
      this.stateStore
        .recordRecovery(
          'resident.delivery-boundary-failure',
          this.contract.coreId,
          {
            residencyId:
              this.contract.residencyId,

            sequence:
              Number(
                event?.sequence
              ) || 0,

            topic:
              event?.topic || null,

            code:
              error?.code || null,

            message:
              error?.message || String(error)
          }
        );
    } catch {}

    this.logger.warn?.(
      '[STAY] contained resident delivery boundary failure: ' +
      (
        error?.message ||
        String(error)
      )
    );
  }


  validateBinding(
    binding
  ) {
    if (
      !binding ||
      typeof binding !==
        'object' ||
      Array.isArray(binding)
    ) {
      fail(
        'resident organism binding is invalid',
        'RESIDENT_BINDING_INVALID'
      );
    }

    if (
      binding.bindingVersion !== 1 ||
      binding.identitySha256 !==
        this.organismIdentityHash ||
      binding.organismLineage !==
        this.identity.lineage ||
      !Number.isSafeInteger(
        binding.issuedAt
      ) ||
      !Number.isSafeInteger(
        binding.runtimeRevision
      ) ||
      binding.runtimeRevision < 1 ||
      !Number.isSafeInteger(
        binding.authorityEpoch
      ) ||
      binding.authorityEpoch < 1 ||
      typeof binding.kernelVersion !==
        'string' ||
      !binding.kernelVersion
    ) {
      fail(
        'resident organism binding does not match living identity',
        'RESIDENT_BINDING_MISMATCH'
      );
    }

    return binding;
  }


  async inspect(
    moduleRelativePath,
    expectedResidencyId =
      null
  ) {
    const normalized =
      String(
        moduleRelativePath
      ).replaceAll(
        '\\',
        '/'
      );

    if (
      !normalized ||
      path.posix.isAbsolute(
        normalized
      ) ||
      normalized
        .split('/')
        .includes('..')
    ) {
      fail(
        'resident module must be release-relative',
        'RESIDENT_MODULE_PATH'
      );
    }

    const absolute =
      path.resolve(
        this.releaseRoot,
        normalized
      );

    const relative =
      path.relative(
        this.releaseRoot,
        absolute
      ).replaceAll(
        '\\',
        '/'
      );

    if (
      relative.startsWith(
        '../'
      ) ||
      path.isAbsolute(
        relative
      )
    ) {
      fail(
        'resident module escaped release root',
        'RESIDENT_MODULE_PATH'
      );
    }

    const definition =
      await inspectCoreModule(
        absolute
      );

    const manifest =
      definition.manifest;

    const contract =
      expectedResidencyId
        ? this.contractRegistry
            .byResidencyId
            .get(
              expectedResidencyId
            )
        : this.contractRegistry
            .byCoreId
            .get(
              manifest.coreId
            );

    if (!contract) {
      fail(
        'resident package has no declared contract',
        'RESIDENT_CONTRACT_UNKNOWN'
      );
    }

    if (
      manifest.coreId !==
        contract.coreId ||
      manifest.version !==
        contract.version ||
      manifest.stateSchema !==
        contract.stateSchema ||
      manifest.stage !==
        contract.stage ||
      manifest.priority !==
        contract.priority ||
      manifest.productionEligible !==
        contract.productionEligible ||
      stableStringify(
        [...manifest.inputs]
      ) !==
        stableStringify(
          [...contract.inputs]
        ) ||
      stableStringify(
        [...manifest.outputs]
      ) !==
        stableStringify(
          [...contract.outputs]
        ) ||
      definition.packagePolicyHash !==
        contract.packagePolicyHash
    ) {
      fail(
        'resident package violates L0 contract',
        'RESIDENT_CONTRACT_MISMATCH'
      );
    }

    return {
      definition,

      contract,

      moduleRelativePath:
        relative,

      manifestHash:
        canonicalHash(
          manifest
        )
    };
  }


  verifyExistingIdentity(
    resident,
    inspected
  ) {
    if (
      resident.organismIdentityHash !==
        this.organismIdentityHash
    ) {
      fail(
        'resident belongs to another organism identity',
        'RESIDENT_IDENTITY_MISMATCH'
      );
    }

    if (
      resident.moduleRelativePath !==
        inspected.moduleRelativePath ||
      resident.moduleHash !==
        inspected.definition
          .moduleDigest ||
      resident.manifestHash !==
        inspected.manifestHash ||
      resident.packagePolicyHash !==
        inspected.definition
          .packagePolicyHash ||
      resident.version !==
        inspected.definition
          .manifest.version ||
      resident.stateSchema !==
        inspected.definition
          .manifest.stateSchema
    ) {
      fail(
        'resident executable identity changed',
        'RESIDENT_PACKAGE_MISMATCH'
      );
    }
  }


  createBindingEvent(
    residencyId,
    binding
  ) {
    this.validateBinding(
      binding
    );

    const at =
      Math.max(
        Number(
          this.clock()
        ) || 0,

        binding.issuedAt
      );

    return Object.freeze({
      id:
        'resident-binding-bootstrap:' +
        residencyId +
        ':' +
        this.organismIdentityHash
          .slice(
            'sha256:'.length,
            'sha256:'.length + 16
          ),

      sequence:
        0,

      topic:
        'runtime.organism.binding',

      class:
        'critical',

      payload:
        structuredClone(
          binding
        ),

      at,

      deadlineAt:
        null,

      meta:
        Object.freeze({
          eventClass:
            'critical',

          sourceCore:
            'living-kernel',

          sourceVersion:
            binding.kernelVersion,

          authorityEpoch:
            binding.authorityEpoch,

          residentBootstrap:
            true
        })
    });
  }


  async startUnit({
    resident,
    inspected,
    binding,
    checkpoint = null
  }) {
    const manifest =
      inspected.definition
        .manifest;

    const client =
      new CoreHostClient({
        modulePath:
          inspected.definition
            .modulePath,

        expectedManifest:
          manifest,

        instanceId:
          resident.instanceId,

        /*
         * CoreHost itself remains explicitly
         * non-active. Residency semantics live
         * entirely in this manager.
         */
        mode:
          'standby',

        logger:
          this.logger,

        policy: {
          resources:
            manifest.resources,

          priority:
            manifest.priority
        }
      });


    const unit = {
      residencyId:
        resident.residencyId,

      resident,
      definition:
        inspected.definition,

      manifest,
      client,

      queue:
        null,

      lifecycle:
        'starting',

      handledEvents:
        0,

      ignoredEvents:
        0,

      observedOutputs:
        0,

      outputViolation:
        false,

      lastError:
        null,

      replayHold:
        true,

      replaySequence:
        null
    };


    const queue =
      new BoundedActorQueue({
        name:
          resident.residencyId,

        capacity:
          client.policy
            .queueCapacity,

        handlerTimeoutMs:
          residentTransitionTimeoutMs(
            client.policy
              .handlerTimeoutMs
          ),

        handler:
          event =>
            this.processEvent(
              unit,
              event
            ),

        recoverFailure:
          (
            error,
            event,
            context
          ) =>
            this.recoverResidentEventFailure(
              unit,
              error,
              event,
              context
            ),

        onFault:
          (error, event) => {
            this.markResyncRequired(
              unit,
              error,
              event
            );
          }
      });

    unit.queue =
      queue;


    client.on(
      'output',
      message =>
        this.handleOutputViolation(
          unit,
          message
        )
    );


    client.on(
      'lifecycle',
      lifecycle => {
        unit.lifecycle =
          lifecycle;
      }
    );


    client.on(
      'quarantined',
      detail => {
        unit.lifecycle =
          'failed';

        try {
          this.stateStore
            .setResidentStatus(
              unit.residencyId,
              'QUARANTINED'
            );

          this.stateStore
            .recordRecovery(
              'resident.quarantined',
              unit.manifest.coreId,
              {
                residencyId:
                  unit.residencyId,

                instanceId:
                  resident.instanceId,

                ...detail
              }
            );
        } catch {}
      }
    );


    client.on(
      'error',
      error => {
        unit.lastError = {
          at:
            new Date().toISOString(),

          code:
            error.code || null,

          message:
            error.message
        };

        this.logger.warn?.(
          `[STAY] resident CoreHost ${unit.residencyId}: ${error.message}`
        );
      }
    );


    const envelope =
      checkpoint
        ? {
            stateSchema:
              checkpoint.stateSchema,

            state:
              checkpoint.state
          }
        : {
            stateSchema:
              manifest.stateSchema,

            state: {}
          };


    await client.start(
      envelope.state,
      envelope.stateSchema
    );


    /*
     * Direct, narrowly-scoped Kernel binding
     * bootstrap.
     */
    const bindingEvent =
      this.createBindingEvent(
        resident.residencyId,
        binding
      );


    const dispatched =
      await client.dispatch(
        bindingEvent,
        {
          coreId:
            manifest.coreId,

          implementationInstanceId:
            resident.instanceId,

          authorityEpoch:
            0,

          eventSequence:
            0,

          eventId:
            bindingEvent.id
        }
      );


    if (
      unit.outputViolation
    ) {
      fail(
        'resident emitted output during binding bootstrap',
        'RESIDENT_OUTPUT_VIOLATION'
      );
    }


    const boundState =
      dispatched.checkpoint != null
        ? dispatched.checkpoint
        : await client.snapshot();


    const persisted =
      await this.stateStore
        .commitResidentCheckpoint({
          residencyId:
            resident.residencyId,

          instanceId:
            resident.instanceId,

          version:
            manifest.version,

          stateSchema:
            manifest.stateSchema,

          state:
            boundState
        });


    client.setRecoveryState(
      boundState,
      manifest.stateSchema
    );


    this.stateStore
      .registerBiologicalConsumer({
        consumerId:
          resident.residencyId,

        coreId:
          manifest.coreId,

        topics:
          manifest.inputs,

        required:
          false,

        authorityEpoch:
          0
      });


    unit.resident =
      this.stateStore
        .getResident(
          resident.residencyId
        );


    this.units.set(
      resident.residencyId,
      unit
    );


    /*
     * Hold live enqueue while reconstruction retires durable replay debt.
     * Incoming durable events remain PENDING in StateStore and are discovered
     * by the replay loop in canonical sequence order.
     */
    try {
      await this.replayPendingBiologicalEvents(
        unit
      );

      /*
       * Release the hold and synchronously prove there is no tail debt before
       * returning control to the event loop. If a tail exists, restore the
       * hold and drain it before declaring the resident RUNNING.
       */
      let replayQuiescent =
        false;

      for (let pass = 0; pass < 4; pass += 1) {
        unit.replayHold = false;

        const tail =
          this.stateStore
            .listPendingBiologicalEvents(
              unit.residencyId,
              1024
            );

        if (!tail.length) {
          replayQuiescent =
            true;

          break;
        }

        unit.replayHold = true;
        await this.replayPendingBiologicalEvents(unit);
      }

      if (!replayQuiescent) {
        unit.replayHold = false;

        const finalTail =
          this.stateStore
            .listPendingBiologicalEvents(
              unit.residencyId,
              1024
            );

        if (finalTail.length) {
          fail(
            'resident replay could not reach a bounded quiescent boundary',
            'RESIDENT_REPLAY_NOT_QUIESCENT'
          );
        }
      }

      this.stateStore
        .setResidentStatus(
          resident.residencyId,
          'RUNNING'
        );

      unit.resident =
        this.stateStore
          .getResident(
            resident.residencyId
          );

      this.stateStore
        .recordRecovery(
          checkpoint
            ? 'resident.recovered'
            : 'resident.attached',
          manifest.coreId,
          {
            residencyId:
              resident.residencyId,

            instanceId:
              resident.instanceId,

            version:
              manifest.version,

            checkpointHash:
              persisted.blobHash
          }
        );
    } catch (error) {
      this.units.delete(
        resident.residencyId
      );

      try {
        unit.queue.close();
      } catch {}

      try {
        await unit.client.stop();
      } catch {}

      throw error;
    }


    return unit;
  }


  async attach({
    moduleRelativePath,
    binding
  }) {
    if (
      this.closed
    ) {
      fail(
        'resident manager is closed',
        'RESIDENT_MANAGER_CLOSED'
      );
    }

    const inspected =
      await this.inspect(
        moduleRelativePath
      );

    const contract =
      inspected.contract;

    const existing =
      this.stateStore
        .getResident(
          contract.residencyId
        );

    if (existing) {
      fail(
        'resident already exists; use recovery or explicit reattachment',
        'RESIDENT_EXISTS'
      );
    }

    this.validateBinding(
      binding
    );

    const instanceId =
      crypto.randomUUID();


    const resident =
      this.stateStore
        .registerResident({
          residencyId:
            contract.residencyId,

          coreId:
            contract.coreId,

          role:
            contract.role,

          instanceId,

          version:
            inspected.definition
              .manifest.version,

          stateSchema:
            inspected.definition
              .manifest.stateSchema,

          moduleRelativePath:
            inspected.moduleRelativePath,

          moduleHash:
            inspected.definition
              .moduleDigest,

          manifestHash:
            inspected.manifestHash,

          packagePolicyHash:
            inspected.definition
              .packagePolicyHash,

          organismIdentityHash:
            this.organismIdentityHash
        });


    return this.startUnit({
      resident,
      inspected,
      binding,
      checkpoint:
        null
    });
  }


  async recover(
    residencyId,
    binding
  ) {
    if (
      this.closed
    ) {
      fail(
        'resident manager is closed',
        'RESIDENT_MANAGER_CLOSED'
      );
    }

    if (
      this.units.has(
        residencyId
      )
    ) {
      fail(
        'resident is already running in this manager',
        'RESIDENT_ALREADY_RUNNING'
      );
    }

    const resident =
      this.stateStore
        .getResident(
          residencyId
        );

    if (!resident) {
      fail(
        'resident does not exist',
        'RESIDENT_UNKNOWN'
      );
    }

    if (
      resident.organismIdentityHash !==
        this.organismIdentityHash
    ) {
      fail(
        'resident belongs to another organism identity',
        'RESIDENT_IDENTITY_MISMATCH'
      );
    }

    if (
      [
        'DETACHED',
        'QUARANTINED',
        'RESYNC_REQUIRED'
      ].includes(
        resident.status
      )
    ) {
      fail(
        `resident ${residencyId} is ${resident.status}`,
        'RESIDENT_RECOVERY_NOT_ALLOWED'
      );
    }

    this.validateBinding(
      binding
    );

    const inspected =
      await this.inspect(
        resident.moduleRelativePath,
        residencyId
      );

    this.verifyExistingIdentity(
      resident,
      inspected
    );

    const checkpoint =
      await this.stateStore
        .readResidentCheckpoint(
          residencyId
        );

    if (!checkpoint) {
      fail(
        'resident history is missing; refusing neutral reconstruction',
        'RESIDENT_CHECKPOINT_MISSING'
      );
    }

    this.stateStore
      .setResidentStatus(
        residencyId,
        'RECOVERING'
      );

    return this.startUnit({
      resident:
        this.stateStore
          .getResident(
            residencyId
          ),

      inspected,
      binding,
      checkpoint
    });
  }


  observe(
    event
  ) {
    if (
      this.closed ||
      !event
    ) {
      return;
    }

    for (
      const unit
      of this.units.values()
    ) {
      const durable =
        Boolean(
          event.ledger?.durable
        );

      if (durable) {
        const delivery =
          this.stateStore
            .getBiologicalDelivery(
              unit.residencyId,
              event.sequence
            );

        if (
          !delivery ||
          delivery.status ===
            'ACKED'
        ) {
          continue;
        }
      }


      const relevant =
        unit.manifest
          .inputs
          .includes(
            event.topic
          );


      /*
       * Same topic without durable Kernel ledger
       * authority is not a resident input.
       */
      if (
        relevant &&
        !durable
      ) {
        unit.ignoredEvents +=
          1;

        continue;
      }


      if (!relevant) {
        unit.ignoredEvents +=
          1;

        if (durable) {
          this.stateStore
            .acknowledgeBiologicalEvent({
              consumerId:
                unit.residencyId,

              sequence:
                event.sequence,

              transitionId:
                transitionId(
                  unit.residencyId,
                  event
                )
            });
        }

        continue;
      }


      const resident =
        this.stateStore
          .getResident(
            unit.residencyId
          );

      if (
        !resident ||
        resident.status !==
          'RUNNING'
      ) {
        /*
         * Relevant durable delivery remains
         * pending while the resident is not
         * eligible to run.
         */
        continue;
      }


      if (unit.replayHold) {
        /*
         * Reconstructed residents must retire all durable replay debt before
         * live observation may enqueue newer biology. The EventFabric ledger
         * already owns this delivery, so holding it here loses nothing and
         * prevents sequence inversion during recovery.
         */
        continue;
      }


      /*
       * Deliberately fire-and-contain.
       *
       * Never return this Promise to EventFabric.
       */
      unit.queue
        .enqueue(
          event
        )
        .catch(
          error => {
            this.markResyncRequired(
              unit,
              error,
              event
            );
          }
        );
    }
  }


  async processEvent(
    unit,
    event
  ) {
    if (
      unit.outputViolation
    ) {
      fail(
        'resident output firewall already tripped',
        'RESIDENT_OUTPUT_VIOLATION'
      );
    }

    const dispatched =
      await unit.client
        .dispatch(
          event,
          {
            coreId:
              unit.manifest.coreId,

            implementationInstanceId:
              unit.resident
                .instanceId,

            authorityEpoch:
              0,

            eventSequence:
              event.sequence,

            eventId:
              event.id
          }
        );


    if (
      unit.outputViolation
    ) {
      fail(
        'resident emitted forbidden output',
        'RESIDENT_OUTPUT_VIOLATION'
      );
    }


    if (
      !event.ledger?.durable
    ) {
      return;
    }


    const checkpoint =
      dispatched.checkpoint;


    if (
      checkpoint == null
    ) {
      fail(
        'durable resident transition produced no checkpoint',
        'RESIDENT_CHECKPOINT_MISSING'
      );
    }


    let persisted;

    try {
      persisted =
        await this.stateStore
          .commitResidentCheckpoint({
            residencyId:
              unit.residencyId,

            instanceId:
              unit.resident
                .instanceId,

            version:
              unit.manifest.version,

            stateSchema:
              unit.manifest
                .stateSchema,

            state:
              checkpoint,

            consumerAck: {
              consumerId:
                unit.residencyId,

              sequence:
                event.sequence,

              transitionId:
                transitionId(
                  unit.residencyId,
                  event
                )
            }
          });
    } catch (error) {
      /*
       * The in-process resident state changed but
       * its durable checkpoint did not.
       *
       * Recycle from the previously committed
       * recovery image.
       */
      await unit.client
        .recycle(
          'uncommitted-transition',
          {
            eventSequence:
              event.sequence,

            code:
              error.code || null
          }
        );

      throw Object.assign(
        new Error(
          `resident durable transition ${event.sequence} was not committed: ${error.message}`
        ),
        {
          code:
            'RESIDENT_COMMIT_FAILED',

          cause:
            error
        }
      );
    }


    /*
     * Recovery image advances only after the
     * resident checkpoint + ledger ACK commit.
     */
    unit.client
      .setRecoveryState(
        checkpoint,
        unit.manifest
          .stateSchema
      );


    unit.handledEvents +=
      1;

    unit.resident =
      this.stateStore
        .getResident(
          unit.residencyId
        );


    return persisted;
  }


  async recoverResidentEventFailure(
    unit,
    error,
    event,
    {
      attempt =
        1
    } = {}
  ) {
    if (
      !event?.ledger?.durable ||
      !replayRetryableCoreHostError(
        error
      ) ||
      attempt >= 3
    ) {
      return false;
    }


    const resident =
      this.stateStore
        .getResident(
          unit.residencyId
        );


    if (
      !resident ||
      ![
        'ATTACHED',
        'RECOVERING',
        'RUNNING'
      ].includes(
        resident.status
      )
    ) {
      return false;
    }


    const before =
      this.stateStore
        .getBiologicalDelivery(
          unit.residencyId,
          event.sequence
        );


    if (
      !before ||
      before.status !==
        'PENDING'
    ) {
      throw Object.assign(
        new Error(
          'resident retryable CoreHost failure changed durable delivery state'
        ),
        {
          code:
            'RESIDENT_RETRY_STATE'
        }
      );
    }


    /*
     * The actor handler has already failed and returned control to
     * BoundedActorQueue. Recovery happens here outside that handler deadline.
     *
     * EVENT timeout/exit recovery is initiated by CoreHostClient.request().
     * A durable SNAPSHOT timeout is initiated by CoreHostClient.dispatch()
     * using the last committed recovery image. Either way, never retry until
     * the previous process is gone and the replacement host is connected.
     */
    await waitForResidentCoreHostRecovery(
      unit.client,
      Math.max(
        5000,
        residentTransitionTimeoutMs(
          unit.client.policy
            .handlerTimeoutMs
        ) * 3
      )
    );


    const after =
      this.stateStore
        .getBiologicalDelivery(
          unit.residencyId,
          event.sequence
        );


    if (
      !after ||
      after.status !==
        'PENDING'
    ) {
      throw Object.assign(
        new Error(
          'resident durable delivery changed while CoreHost was recovering'
        ),
        {
          code:
            'RESIDENT_RETRY_STATE'
        }
      );
    }


    try {
      this.stateStore
        .recordRecovery(
          'resident.delivery-retry',
          unit.manifest.coreId,
          {
            residencyId:
              unit.residencyId,

            sequence:
              event.sequence,

            attempt,

            code:
              error.code || null,

            operation:
              error.coreHostOperation ||
              null
          }
        );
    } catch {}


    return true;
  }


  markResyncRequired(
    unit,
    error,
    event
  ) {
    unit.lastError = {
      at:
        new Date().toISOString(),

      sequence:
        Number(
          event?.sequence
        ) || 0,

      topic:
        event?.topic || null,

      code:
        error?.code || null,

      message:
        error?.message ||
        String(error)
    };


    const resident =
      this.stateStore
        .getResident(
          unit.residencyId
        );


    if (
      resident &&
      ![
        'QUARANTINED',
        'DETACHED'
      ].includes(
        resident.status
      )
    ) {
      try {
        this.stateStore
          .setResidentStatus(
            unit.residencyId,
            'RESYNC_REQUIRED'
          );

        /*
         * Once chronology is uncertain, stop
         * accruing new biological delivery debt.
         */
        this.stateStore
          .deactivateBiologicalConsumer(
            unit.residencyId
          );
      } catch {}
    }


    try {
      this.stateStore
        .recordRecovery(
          'resident.resync-required',
          unit.manifest.coreId,
          {
            residencyId:
              unit.residencyId,

            ...unit.lastError
          }
        );
    } catch {}
  }


  handleOutputViolation(
    unit,
    message
  ) {
    unit.observedOutputs +=
      1;

    unit.outputViolation =
      true;

    unit.lastError = {
      at:
        new Date().toISOString(),

      code:
        'RESIDENT_OUTPUT_VIOLATION',

      topic:
        message?.topic || null,

      message:
        'resident attempted biological output'
    };


    try {
      this.stateStore
        .setResidentStatus(
          unit.residencyId,
          'QUARANTINED'
        );

      this.stateStore
        .deactivateBiologicalConsumer(
          unit.residencyId
        );

      this.stateStore
        .recordRecovery(
          'resident.output-violation',
          unit.manifest.coreId,
          {
            residencyId:
              unit.residencyId,

            instanceId:
              unit.resident
                .instanceId,

            topic:
              message?.topic || null
          }
        );
    } catch {}

    /*
     * Intentionally NO EventFabric publish path.
     */
  }


  async detach(
    residencyId
  ) {
    const unit =
      this.units.get(
        residencyId
      );

    if (!unit) {
      fail(
        'resident is not running',
        'RESIDENT_NOT_RUNNING'
      );
    }

    const resident =
      this.stateStore
        .getResident(
          residencyId
        );

    if (
      !resident ||
      resident.status !==
        'RUNNING'
    ) {
      fail(
        'resident is not eligible for detach',
        'RESIDENT_DETACH_STATE'
      );
    }

    /*
     * RECOVERING is the non-input transitional
     * state already permitted to checkpoint.
     */
    this.stateStore
      .setResidentStatus(
        residencyId,
        'RECOVERING'
      );

    const boundary =
      this.stateStore
        .deactivateBiologicalConsumer(
          residencyId
        );

    try {
      /*
       * No new durable deliveries can be created
       * after consumer deactivation. Everything at
       * or below highWater was already visible to
       * this manager before we yielded control.
       */
      await unit.queue
        .drainThrough(
          boundary.highWater
        );

      const state =
        await unit.client
          .snapshot();

      const persisted =
        await this.stateStore
          .commitResidentCheckpoint({
            residencyId,

            instanceId:
              resident.instanceId,

            version:
              resident.version,

            stateSchema:
              resident.stateSchema,

            state
          });

      unit.client
        .setRecoveryState(
          state,
          resident.stateSchema
        );

      unit.queue.close();

      await unit.client
        .stop();

      this.units.delete(
        residencyId
      );

      this.stateStore
        .setResidentStatus(
          residencyId,
          'DETACHED'
        );

      this.stateStore
        .recordRecovery(
          'resident.detached',
          resident.coreId,
          {
            residencyId,
            instanceId:
              resident.instanceId,
            checkpointHash:
              persisted.blobHash,
            checkpointGeneration:
              persisted.generation,
            throughSequence:
              boundary.highWater,
            statePreserved:
              true
          }
        );

      return {
        residencyId,
        status:
          'DETACHED',
        checkpointHash:
          persisted.blobHash,
        checkpointGeneration:
          persisted.generation,
        throughSequence:
          boundary.highWater
      };
    } catch (error) {
      try {
        this.stateStore
          .setResidentStatus(
            residencyId,
            'RESYNC_REQUIRED'
          );
      } catch {}

      try {
        unit.queue.close();
      } catch {}

      try {
        await unit.client.stop();
      } catch {}

      this.units.delete(
        residencyId
      );

      try {
        this.stateStore
          .recordRecovery(
            'resident.detach-failed',
            resident.coreId,
            {
              residencyId,
              code:
                error.code || null,
              message:
                error.message
            }
          );
      } catch {}

      throw error;
    }
  }


  async reattach(
    residencyId,
    binding
  ) {
    if (
      this.closed
    ) {
      fail(
        'resident manager is closed',
        'RESIDENT_MANAGER_CLOSED'
      );
    }

    if (
      this.units.has(
        residencyId
      )
    ) {
      fail(
        'resident is already running',
        'RESIDENT_ALREADY_RUNNING'
      );
    }

    const resident =
      this.stateStore
        .getResident(
          residencyId
        );

    if (!resident) {
      fail(
        'resident does not exist',
        'RESIDENT_UNKNOWN'
      );
    }

    if (
      resident.status !==
        'DETACHED'
    ) {
      fail(
        `resident ${residencyId} is ${resident.status}`,
        'RESIDENT_REATTACH_STATE'
      );
    }

    this.validateBinding(
      binding
    );

    const inspected =
      await this.inspect(
        resident.moduleRelativePath
      );

    this.verifyExistingIdentity(
      resident,
      inspected
    );

    const checkpoint =
      await this.stateStore
        .readResidentCheckpoint(
          residencyId
        );

    if (!checkpoint) {
      fail(
        'detached resident history is missing',
        'RESIDENT_CHECKPOINT_MISSING'
      );
    }

    this.stateStore
      .setResidentStatus(
        residencyId,
        'RECOVERING'
      );

    const unit =
      await this.startUnit({
        resident:
          this.stateStore
            .getResident(
              residencyId
            ),
        inspected,
        binding,
        checkpoint
      });

    this.stateStore
      .recordRecovery(
        'resident.reattached',
        resident.coreId,
        {
          residencyId,
          instanceId:
            resident.instanceId,
          checkpointHash:
            this.stateStore
              .getResident(
                residencyId
              )
              .checkpointHash
        }
      );

    return unit;
  }


  async resynchronize(
    residencyId,
    binding,
    runtimeRevision
  ) {
    if (
      this.closed
    ) {
      fail(
        'resident manager is closed',
        'RESIDENT_MANAGER_CLOSED'
      );
    }

    const resident =
      this.stateStore
        .getResident(
          residencyId
        );

    if (!resident) {
      fail(
        'resident does not exist',
        'RESIDENT_UNKNOWN'
      );
    }

    if (
      resident.status !==
        'RESYNC_REQUIRED'
    ) {
      fail(
        `resident ${residencyId} is not awaiting resynchronization`,
        'RESIDENT_RESYNC_STATE'
      );
    }

    this.validateBinding(
      binding
    );

    const inspected =
      await this.inspect(
        resident.moduleRelativePath
      );

    this.verifyExistingIdentity(
      resident,
      inspected
    );

    const checkpoint =
      await this.stateStore
        .readResidentCheckpoint(
          residencyId
        );

    if (!checkpoint) {
      fail(
        'resident resynchronization history is missing',
        'RESIDENT_CHECKPOINT_MISSING'
      );
    }

    const unit =
      this.units.get(
        residencyId
      );

    if (unit) {
      try {
        this.stateStore
          .deactivateBiologicalConsumer(
            residencyId
          );
      } catch {}

      try {
        unit.queue.close();
      } catch {}

      try {
        await unit.client.stop();
      } catch {}

      this.units.delete(
        residencyId
      );
    }

    const record =
      this.stateStore
        .resynchronizeResidentBiologicalConsumer({
          residencyId,
          checkpointHash:
            checkpoint.blobHash,
          runtimeRevision
        });

    /*
     * The physiology checkpoint itself is not
     * changed by resynchronization.
     */
    const afterReset =
      await this.stateStore
        .readResidentCheckpoint(
          residencyId
        );

    if (
      afterReset.blobHash !==
        checkpoint.blobHash
    ) {
      fail(
        'resident resynchronization mutated physiology',
        'RESIDENT_RESYNC_STATE_MUTATION'
      );
    }

    this.stateStore
      .setResidentStatus(
        residencyId,
        'RECOVERING'
      );

    const restarted =
      await this.startUnit({
        resident:
          this.stateStore
            .getResident(
              residencyId
            ),
        inspected,
        binding,
        checkpoint
      });

    this.stateStore
      .recordRecovery(
        'resident.resynchronized',
        resident.coreId,
        {
          residencyId,
          resyncId:
            record.resyncId,
          abandonedCount:
            record.abandonedCount,
          fromCursor:
            record.fromCursor,
          toCursor:
            record.toCursor,
          runtimeRevision,
          inventedBiologicalTime:
            false
        }
      );

    return {
      unit:
        restarted,
      record
    };
  }


  async replayPendingBiologicalEvents(
    unit
  ) {
    /*
     * 1023 is deliberate.
     *
     * StateStore bounds one read at 1024. Seeing
     * 1024 pending deliveries means the resident
     * debt reached or exceeded our first L0 replay
     * window and must not be silently consumed as
     * an unbounded workload.
     */
    const pending =
      this.stateStore
        .listPendingBiologicalEvents(
          unit.residencyId,
          1024
        );


    if (
      pending.length >= 1024
    ) {
      const error =
        Object.assign(
          new Error(
            'resident pending-delivery replay exceeds L0 bounded window'
          ),
          {
            code:
              'RESIDENT_REPLAY_BOUNDED'
          }
        );


      this.markResyncRequired(
        unit,
        error,
        pending[0] || null
      );


      throw error;
    }


    let replayed =
      0;

    let ignored =
      0;


    for (
      const event
      of pending
    ) {
      const delivery =
        this.stateStore
          .getBiologicalDelivery(
            unit.residencyId,
            event.sequence
          );


      if (
        !delivery ||
        delivery.status ===
          'ACKED'
      ) {
        continue;
      }


      const relevant =
        unit.manifest
          .inputs
          .includes(
            event.topic
          );


      if (!relevant) {
        this.stateStore
          .acknowledgeBiologicalEvent({
            consumerId:
              unit.residencyId,

            sequence:
              event.sequence,

            transitionId:
              transitionId(
                unit.residencyId,
                event
              )
          });


        unit.ignoredEvents +=
          1;

        ignored +=
          1;

        continue;
      }


      const resident =
        this.stateStore
          .getResident(
            unit.residencyId
          );


      if (
        !resident ||
        ![
          'ATTACHED',
          'RECOVERING',
          'RUNNING'
        ].includes(
          resident.status
        )
      ) {
        fail(
          'resident became unavailable during pending replay',
          'RESIDENT_REPLAY_STATE'
        );
      }


      /*
       * BoundedActorQueue owns retry serialization for durable CoreHost
       * timeout/exit recovery. The enqueue Promise remains unresolved across a
       * bounded host reconstruction, so newer queued biology cannot overtake
       * this exact PENDING event and drain barriers stay pinned to it.
       */
      await unit.queue
        .enqueue(
          event
        );


      replayed +=
        1;
    }


    return {
      replayed,
      ignored
    };
  }


  async drain(
    residencyId,
    sequence =
      this.fabric.sequence
  ) {
    const unit =
      this.units.get(
        residencyId
      );

    if (!unit) {
      fail(
        'resident is not running',
        'RESIDENT_NOT_RUNNING'
      );
    }

    return unit.queue
      .drainThrough(
        sequence,
        residentDrainTimeoutMs(
          unit.client.policy
            .handlerTimeoutMs
        )
      );
  }


  async status(
    residencyId =
      this.contract.residencyId
  ) {
    const resident =
      this.stateStore
        .getResident(
          residencyId
        );

    if (!resident) {
      return null;
    }

    const unit =
      this.units.get(
        residencyId
      );

    const authority =
      this.stateStore
        .getAuthority(
          resident.coreId
        );

    let health =
      null;

    if (unit) {
      try {
        health =
          await unit.client
            .health();
      } catch (error) {
        health = {
          ok: false,

          code:
            error.code || null,

          message:
            error.message
        };
      }
    }

    let pendingDeliveries =
      0;

    try {
      pendingDeliveries =
        this.stateStore
          .listPendingBiologicalEvents(
            residencyId,
            1024
          )
          .length;
    } catch {
      pendingDeliveries =
        -1;
    }


    return {
      residencyId:
        resident.residencyId,

      coreId:
        resident.coreId,

      role:
        resident.role,

      version:
        resident.version,

      stateSchema:
        resident.stateSchema,

      status:
        resident.status,

      instanceId:
        resident.instanceId,

      organismIdentityHash:
        resident.organismIdentityHash,

      moduleHash:
        resident.moduleHash,

      manifestHash:
        resident.manifestHash,

      packagePolicyHash:
        resident.packagePolicyHash,

      checkpointHash:
        resident.checkpointHash,

      checkpointGeneration:
        resident.checkpointGeneration,

      pendingDeliveries,

      declaredOutputs:
        unit
          ? unit.manifest
              .outputs.length
          : 0,

      observedOutputs:
        unit
          ? unit.observedOutputs
          : 0,

      authorityOwned:
        Boolean(
          authority &&
          authority.instanceId ===
            resident.instanceId
        ),

      handledEvents:
        unit
          ? unit.handledEvents
          : 0,

      ignoredEvents:
        unit
          ? unit.ignoredEvents
          : 0,

      lastError:
        unit
          ? unit.lastError
          : null,

      host:
        unit
          ? unit.client.status()
          : null,

      health
    };
  }


  async shutdown() {
    if (
      this.closed
    ) {
      return;
    }

    this.closed =
      true;

    try {
      this.unsubscribe?.();
    } catch {}


    for (
      const unit
      of this.units.values()
    ) {
      const resident =
        this.stateStore
          .getResident(
            unit.residencyId
          );

      if (
        resident?.status ===
          'RUNNING'
      ) {
        try {
          await unit.queue
            .drainThrough(
              this.fabric.sequence
            );

          const state =
            await unit.client
              .snapshot();

          await this.stateStore
            .commitResidentCheckpoint({
              residencyId:
                unit.residencyId,

              instanceId:
                resident.instanceId,

              version:
                resident.version,

              stateSchema:
                resident.stateSchema,

              state
            });

          unit.client
            .setRecoveryState(
              state,
              resident.stateSchema
            );
        } catch (error) {
          this.logger.warn?.(
            `[STAY] resident shutdown checkpoint failed: ${error.message}`
          );
        }
      }

      try {
        unit.queue.close();
      } catch {}

      try {
        await unit.client.stop();
      } catch {}
    }


    this.units.clear();
  }
}


module.exports = {
  ResidentManager,
  L0_SNTSS_CONTRACT,
  RESIDENT_SIGNALLING,
  normalizeResidentContract,
  createResidentContractRegistry,
  canonicalHash,
  transitionId,
  residentTransitionTimeoutMs
};
