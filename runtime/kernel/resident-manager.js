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


const I4G_SNTSS_CONTRACT =
  Object.freeze({
    residencyId:
      'resident:sntss',

    coreId:
      'sntss',

    role:
      'resident-physiology',

    version:
      '0.5.0-i4g1',

    stateSchema:
      5,

    stage:
      'i4g-continuity-genesis-shadow',

    priority:
      'optional',

    productionEligible:
      false,

    inputs:
      Object.freeze([
        'runtime.organism.binding',
        'runtime.sntss.continuity-genesis',
        'runtime.time.pulse'
      ]),

    outputs:
      Object.freeze([]),

    packagePolicyHash:
      'sha256:ba12622fcc9c782c8c48f0544a5b019c96dc198dcbb7fb209c1dad47de64639d'
  });


const CHRONOBIOLOGY_RESIDENT_CONTRACT =
  Object.freeze({
    residencyId:
      'resident:chronobiology',

    coreId:
      'chronobiology',

    role:
      'chronobiology',

    version:
      '1.0.0-c3rc.1',

    stateSchema:
      2,

    stage:
      'c3-shadow-release-candidate',

    priority:
      'optional',

    productionEligible:
      false,

    inputs:
      Object.freeze([
        'runtime.organism.binding',
        'runtime.trusted-organism-time.pulse',
        'environment.photic.exposure'
      ]),

    outputs:
      Object.freeze([
        'chronobiology.phase.summary'
      ]),

    packagePolicyHash:
      'sha256:9ab15c27c69494c6ce3156255ed06d2f57887934928a85b13ff58d578add7820',

    routeCompleteness:
      true,

    priorCheckpointRecovery:
      true,

    signalling:
      'LAB_SHADOW_ONLY',

    producerEpoch:
      1,

    authorityMode:
      'shadow'
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

  if (input.routeCompleteness !== undefined
    && typeof input.routeCompleteness !== 'boolean') {
    fail('resident route-completeness flag is invalid', 'RESIDENT_CONTRACT_INVALID');
  }
  if (input.priorCheckpointRecovery !== undefined
    && typeof input.priorCheckpointRecovery !== 'boolean') {
    fail('resident prior-checkpoint recovery flag is invalid', 'RESIDENT_CONTRACT_INVALID');
  }

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
    ) ||
    (
      signalling ===
        RESIDENT_SIGNALLING
          .LAB_SHADOW_ONLY &&
      (
        !Number.isSafeInteger(
          input.producerEpoch
        ) ||
        input.producerEpoch < 1 ||
        ![
          'lab',
          'shadow'
        ].includes(
          input.authorityMode
        )
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


function residentQueueTimeoutMs(
  manifest,
  handlerTimeoutMs
) {
  const ordinary =
    residentTransitionTimeoutMs(
      handlerTimeoutMs
    );

  /*
   * Chronobiology's canonical founder expansion is a one-time cold
   * transition. CoreHostClient still rejects every later event at the
   * manifest's ordinary 250 ms deadline; this outer allowance merely keeps
   * the actor queue from expiring before that one bounded cold dispatch can
   * finish and be durably committed.
   */
  return manifest?.coreId ===
    'chronobiology'
    ? Math.max(
        ordinary,
        6500
      )
    : ordinary;
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
  return [
    'COREHOST_TIMEOUT',
    'COREHOST_EXIT',
    'COREHOST_OFFLINE',
    'CORE_WORKER_TIMEOUT',
    'CORE_WORKER_EXIT',
    'CORE_WORKER_OFFLINE'
  ].includes(String(error?.code || ''));
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


async function waitForResidentCoreHostRecovery(client, failedGeneration, timeoutMs = 5000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (client.quarantined) {
      throw Object.assign(new Error('resident CoreHost quarantined during replay recovery'), {
        code: 'RESIDENT_REPLAY_COREHOST_QUARANTINED'
      });
    }

    if (
      client.generation > failedGeneration &&
      !client.restarting &&
      client.child?.connected &&
      client.lifecycle !== 'recovering'
    ) {
      return client.generation;
    }

    await sleep(10);
  }

  throw Object.assign(new Error('resident CoreHost did not advance its generation before replay retry deadline'), {
    code: 'RESIDENT_REPLAY_COREHOST_RECOVERY_TIMEOUT',
    failedGeneration,
    observedGeneration: client.generation
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
      null,
    explicitContract =
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
      explicitContract
        ? normalizeResidentContract(
            explicitContract
          )
        : expectedResidencyId
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


  activateResidentContract(
    contractInput
  ) {
    const contract =
      normalizeResidentContract(
        contractInput
      );

    this.contractRegistry
      .byResidencyId
      .set(
        contract.residencyId,
        contract
      );

    this.contractRegistry
      .byCoreId
      .set(
        contract.coreId,
        contract
      );

    if (
      this.contract?.residencyId ===
        contract.residencyId
    ) {
      this.contract =
        contract;
    }

    return contract;
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
    checkpoint = null,
    initialState = null,
    acceptanceCommit = null,
    finalizedReplay = [],
    backfillInactiveGap = false,
    replayDebtLimit = 1023,
    preserveConsumerOnFailure = false
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

      lastSlowTransition:
        null,

      resyncRequired:
        false,

      terminalPersistenceError:
        null,

      teardownError:
        null,

      replayHold:
        true,

      replaySequence:
        null,

      contract:
        inspected.contract,

      pendingOutputIntents:
        new Map(),

      outboxDrainPromise:
        null,

      finalizedReplayTail:
        [...finalizedReplay],

      activationBackfilled:
        0,

      consumerActivated:
        false
    };


    const queue =
      new BoundedActorQueue({
        name:
          resident.residencyId,

        capacity:
          client.policy
            .queueCapacity,

        handlerTimeoutMs:
          residentQueueTimeoutMs(
            manifest,
            client.handlerTimeoutMs ??
              client.policy
                .handlerTimeoutMs
          ),

        settlementGraceMs:
          Math.max(
            5000,
            residentTransitionTimeoutMs(
              client.handlerTimeoutMs ??
                client.policy.handlerTimeoutMs
            )
          ),

        recoveryTimeoutMs:
          Math.max(
            15000,
            residentTransitionTimeoutMs(
              client.handlerTimeoutMs ??
                client.policy.handlerTimeoutMs
            ) * 3
          ),

        recoverySettlementGraceMs:
          5000,

        maxAttempts:
          3,

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

        onSlow:
          (error, event, context) => {
            unit.lastSlowTransition = {
              at: new Date().toISOString(),
              sequence: Number(event?.sequence) || 0,
              topic: event?.topic || null,
              attempt: Number(context?.attempt) || 1,
              deadlineMs: Number(error?.deadlineMs) || queue?.handlerTimeoutMs || null
            };
          },

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
        unit.contract.signalling ===
          RESIDENT_SIGNALLING
            .FORBIDDEN
          ? this.handleOutputViolation(
              unit,
              message
            )
          : this.handleSignallingOutput(
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

        this.persistTerminalTransition(
          unit,
          'QUARANTINED',
          'resident.quarantined',
          {
            residencyId:
              unit.residencyId,

            instanceId:
              resident.instanceId,

            ...detail
          }
        );

        this.stopTerminalUnit(
          unit,
          'quarantine'
        );
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
        : initialState
          ? {
              stateSchema:
                manifest.stateSchema,

              state:
                structuredClone(initialState)
            }
          : {
            stateSchema:
              manifest.stateSchema,

            state: {}
          };


    try {
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
            unit.contract
              .signalling ===
                RESIDENT_SIGNALLING
                  .LAB_SHADOW_ONLY
              ? unit.contract
                  .producerEpoch
              : 0,

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


    const consumerActivation =
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
          0,

        backfillInactiveGap
      });


    unit.activationBackfilled =
      Number(
        consumerActivation
          ?.activationBackfilled || 0
      );

    unit.consumerActivated =
      true;


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
      await this.replayFinalizedResidentEvents(unit);

      await this.replayPendingBiologicalEvents(
        unit,
        replayDebtLimit
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

      /*
       * A resident may have committed its checkpoint + input ACK + output
       * obligation immediately before manager loss. No input replay debt is
       * required for that already-committed transition, so recovery must also
       * attempt the shared durable outbox independently. Publication failure
       * remains non-fatal here: the immutable obligation stays pending.
       */
      await this.tryDrainResidentOutbox(
        unit
      );

      this.stateStore
        .withTransaction(
          () => {
            this.stateStore
              .setResidentStatus(
                resident.residencyId,
                'RUNNING'
              );

            if (acceptanceCommit) {
              if (typeof acceptanceCommit !== 'function') {
                fail(
                  'resident acceptance commit is invalid',
                  'RESIDENT_ACCEPTANCE_COMMIT'
                );
              }

              const result =
                acceptanceCommit({
                  checkpoint:
                    persisted,

                  resident:
                    this.stateStore
                      .getResident(
                        resident.residencyId
                      ),

                  manifest
                });

              if (
                result &&
                typeof result.then ===
                  'function'
              ) {
                fail(
                  'resident acceptance commit must be synchronous',
                  'RESIDENT_ACCEPTANCE_COMMIT'
                );
              }
            }
          }
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

      /*
       * Consumer activation and replay are one logical recovery boundary.
       * If initialization or replay fails after the atomic activation/backfill,
       * stop routing new events to this absent unit. Its cursor and immutable
       * PENDING deliveries remain available to the next recovery attempt.
       */
      if (
        unit.consumerActivated &&
        !preserveConsumerOnFailure
      ) {
        try {
          this.stateStore
            .deactivateBiologicalConsumer(
              resident.residencyId
            );
        } catch {}
      }

      try {
        unit.queue.close();
      } catch {}

      try {
        await unit.client.stop();
      } catch (error) {
        try {
          this.stateStore
            .recordRecovery(
              'resident.startup-teardown-failed',
              resident?.coreId || unit.manifest?.coreId || null,
              {
                residencyId:
                  unit.residencyId,

                instanceId:
                  resident?.instanceId || null,

                code:
                  error.code || null,

                message:
                  error.message || String(error)
              }
            );
        } catch {}

        this.logger.warn?.(
          `[STAY] resident startup teardown failed: ${error.message}`
        );
      }

      throw error;
    }


    return unit;
  }


  async attach({
    moduleRelativePath,
    binding,
    initialState = null,
    instanceId = null,
    registerResident = null,
    acceptanceCommit = null
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

    const selectedInstanceId =
      instanceId == null
        ? crypto.randomUUID()
        : String(instanceId);


    const registration = {
          residencyId:
            contract.residencyId,

          coreId:
            contract.coreId,

          role:
            contract.role,

          instanceId:
            selectedInstanceId,

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
        };

    const resident =
      registerResident
        ? registerResident(
            Object.freeze({
              ...registration
            })
          )
        : this.stateStore
            .registerResident(
              registration
            );

    if (
      !resident ||
      typeof resident.then ===
        'function'
    ) {
      fail(
        'resident registration must commit synchronously',
        'RESIDENT_REGISTRATION_COMMIT'
      );
    }

    this.verifyExistingIdentity(
      resident,
      inspected
    );


    return this.startUnit({
      resident,
      inspected,
      binding,
      checkpoint:
        null,
      initialState,
      acceptanceCommit
    });
  }


  async resumeInitialAttachment({
    residencyId,
    binding,
    initialState,
    acceptanceCommit = null
  }) {
    if (this.closed) {
      fail(
        'resident manager is closed',
        'RESIDENT_MANAGER_CLOSED'
      );
    }

    if (this.units.has(residencyId)) {
      fail(
        'resident is already running in this manager',
        'RESIDENT_ALREADY_RUNNING'
      );
    }

    const resident =
      this.stateStore.getResident(residencyId);

    if (!resident || resident.status !== 'ATTACHED') {
      fail(
        'initial resident attachment is not resumable',
        'RESIDENT_INITIAL_ATTACHMENT_NOT_RESUMABLE'
      );
    }

    this.validateBinding(binding);

    const inspected =
      await this.inspect(
        resident.moduleRelativePath,
        residencyId
      );

    this.verifyExistingIdentity(
      resident,
      inspected
    );

    if (
      await this.stateStore
        .readResidentCheckpoint(
          residencyId
        )
    ) {
      fail(
        'initial resident attachment has a checkpoint; use recovery',
        'RESIDENT_INITIAL_ATTACHMENT_HAS_CHECKPOINT'
      );
    }

    if (!initialState) {
      fail(
        'initial resident attachment state is missing',
        'RESIDENT_INITIAL_ATTACHMENT_STATE_MISSING'
      );
    }

    return this.startUnit({
      resident,
      inspected,
      binding,
      checkpoint: null,
      initialState,
      acceptanceCommit
    });
  }


  async promoteSntssContinuityGenesis({
    moduleRelativePath =
      'cores/sntss/i4g/index.js',
    binding,
    publishGenesis
  }) {
    if (this.closed) {
      fail(
        'resident manager is closed',
        'RESIDENT_MANAGER_CLOSED'
      );
    }

    if (
      typeof publishGenesis !==
        'function'
    ) {
      fail(
        'continuity-genesis publisher is required',
        'SNTSS_I4G_PROMOTION_CONFIG'
      );
    }

    const residencyId =
      I4G_SNTSS_CONTRACT
        .residencyId;

    const before =
      this.stateStore
        .getResident(
          residencyId
        );

    if (
      !before ||
      before.version !==
        L0_SNTSS_CONTRACT.version ||
      before.stateSchema !==
        L0_SNTSS_CONTRACT.stateSchema ||
      before.moduleRelativePath !==
        'cores/sntss/i3d/index.js' ||
      before.status !==
        'RUNNING' ||
      !this.units.has(
        residencyId
      )
    ) {
      fail(
        'SNTSS is not the live I3-D3 promotion baseline',
        'SNTSS_I4G_PROMOTION_BASELINE'
      );
    }

    this.validateBinding(
      binding
    );

    const previousContract =
      this.contractRegistry
        .byResidencyId
        .get(
          residencyId
        );

    const previousInspection =
      await this.inspect(
        before.moduleRelativePath,
        residencyId,
        L0_SNTSS_CONTRACT
      );

    const inspected =
      await this.inspect(
        moduleRelativePath,
        residencyId,
        I4G_SNTSS_CONTRACT
      );

    let candidate =
      null;

    let committed =
      false;

    let outputViolation =
      false;

    let sourceCheckpoint =
      null;

    try {
      await this.detach(
        residencyId
      );

      sourceCheckpoint =
        await this.stateStore
          .readResidentCheckpoint(
            residencyId
          );

      if (
        !sourceCheckpoint ||
        sourceCheckpoint.version !==
          L0_SNTSS_CONTRACT.version ||
        sourceCheckpoint.stateSchema !==
          L0_SNTSS_CONTRACT.stateSchema
      ) {
        fail(
          'SNTSS prenatal checkpoint is unavailable',
          'SNTSS_I4G_PROMOTION_CHECKPOINT'
        );
      }

      candidate =
        new CoreHostClient({
          modulePath:
            inspected.definition
              .modulePath,

          expectedManifest:
            inspected.definition
              .manifest,

          instanceId:
            before.instanceId,

          mode:
            'standby',

          logger:
            this.logger,

          policy: {
            resources:
              inspected.definition
                .manifest.resources,

            priority:
              inspected.definition
                .manifest.priority
          }
        });

      candidate.on(
        'output',
        () => {
          outputViolation =
            true;
        }
      );

      await candidate.start(
        sourceCheckpoint.state,
        sourceCheckpoint.stateSchema
      );

      const genesisEvent =
        await publishGenesis({
          sourceCheckpoint,
          inspected
        });

      const dispatched =
        await candidate.dispatch(
          genesisEvent,
          {
            eventSequence:
              genesisEvent.sequence
          }
        );

      if (outputViolation) {
        fail(
          'I4-G1 emitted output during continuity genesis',
          'RESIDENT_OUTPUT_VIOLATION'
        );
      }

      const bornState =
        dispatched.checkpoint != null
          ? dispatched.checkpoint
          : await candidate.snapshot();

      if (
        bornState?.stateSchema !==
          I4G_SNTSS_CONTRACT.stateSchema ||
        !bornState?.individuality ||
        bornState.individuality
          .genesisEventId !==
            genesisEvent.id ||
        bornState.individuality
          .sourceCheckpointGeneration !==
            sourceCheckpoint.generation ||
        bornState.individuality
          .sourceCheckpointHash !==
            `sha256:${sourceCheckpoint.blobHash}`
      ) {
        fail(
          'I4-G1 continuity genesis did not produce the bound generation',
          'SNTSS_I4G_PROMOTION_GENESIS'
        );
      }

      const health =
        await candidate.health();

      if (
        health?.ok ===
          false ||
        health?.continuityGenesisEstablished !==
          true
      ) {
        fail(
          'I4-G1 continuity-genesis health gate failed',
          'SNTSS_I4G_PROMOTION_HEALTH'
        );
      }

      const promoted =
        await this.stateStore
          .promoteResidentGeneration({
            residencyId,
            instanceId:
              before.instanceId,
            organismIdentityHash:
              before.organismIdentityHash,
            fromVersion:
              before.version,
            fromStateSchema:
              before.stateSchema,
            fromModuleRelativePath:
              before.moduleRelativePath,
            fromCheckpointGeneration:
              sourceCheckpoint.generation,
            fromCheckpointHash:
              sourceCheckpoint.blobHash,
            toVersion:
              inspected.definition
                .manifest.version,
            toStateSchema:
              inspected.definition
                .manifest.stateSchema,
            toModuleRelativePath:
              inspected.moduleRelativePath,
            toModuleHash:
              inspected.definition
                .moduleDigest,
            toManifestHash:
              inspected.manifestHash,
            toPackagePolicyHash:
              inspected.definition
                .packagePolicyHash,
            topics:
              inspected.definition
                .manifest.inputs,
            genesisEvent,
            state:
              bornState
          });

      committed =
        true;

      candidate.stopping =
        true;

      await candidate.stop();
      candidate =
        null;

      this.activateResidentContract(
        I4G_SNTSS_CONTRACT
      );

      return await this.startUnit({
        resident:
          promoted.resident,
        inspected,
        binding,
        checkpoint:
          promoted.checkpoint
      });
    } catch (error) {
      if (candidate) {
        candidate.stopping =
          true;

        await candidate
          .stop()
          .catch(
            () => {}
          );
      }

      if (!committed && sourceCheckpoint) {
        this.activateResidentContract(
          previousContract ||
          L0_SNTSS_CONTRACT
        );

        try {
          this.stateStore
            .setResidentStatus(
              residencyId,
              'RECOVERING'
            );

          await this.startUnit({
            resident:
              this.stateStore
                .getResident(
                  residencyId
                ),
            inspected:
              previousInspection,
            binding,
            checkpoint:
              sourceCheckpoint
          });
        } catch (rollbackError) {
          error.rollbackError = {
            code:
              rollbackError?.code ||
              null,
            message:
              rollbackError?.message ||
              String(rollbackError)
          };
        }
      }

      throw error;
    }
  }


  async promoteMetabShadow({
    moduleRelativePath =
      'cores/p1-r0/metab-shadow/index.js',
    binding,
    shadowContract,
    publishActivation,
    acceptanceCommit = null
  }) {
    if (this.closed) {
      fail(
        'resident manager is closed',
        'RESIDENT_MANAGER_CLOSED'
      );
    }

    if (
      typeof publishActivation !== 'function' ||
      !shadowContract
    ) {
      fail(
        'METAB shadow promotion configuration is incomplete',
        'P1_METAB_SHADOW_PROMOTION_CONFIG'
      );
    }

    const nextContract =
      normalizeResidentContract(
        shadowContract
      );
    const expectedInputs = [
      'runtime.organism.binding',
      'runtime.metab.shadow-activation',
      'resource.capacity.eligible.v1',
      'resource.capacity.quality.v1'
    ];

    if (
      nextContract.residencyId !== 'resident:metab' ||
      nextContract.coreId !== 'METAB' ||
      nextContract.role !== 'metabolism' ||
      nextContract.version !== '0.2.0-p1r0-shadow.1' ||
      nextContract.stateSchema !== 2 ||
      nextContract.stage !== 'p1-r0-production-shadow-r128' ||
      nextContract.productionEligible !== false ||
      nextContract.signalling !== RESIDENT_SIGNALLING.FORBIDDEN ||
      nextContract.authorityMode !== 'shadow' ||
      stableStringify(nextContract.inputs) !==
        stableStringify(expectedInputs) ||
      stableStringify(nextContract.outputs) !==
        stableStringify([])
    ) {
      fail(
        'METAB shadow contract is not the R128 output-firewalled contract',
        'P1_METAB_SHADOW_PROMOTION_CONTRACT'
      );
    }

    const residencyId = 'resident:metab';
    const before =
      this.stateStore.getResident(residencyId);
    const consumer =
      this.stateStore.getBiologicalConsumer(residencyId);
    const authority =
      this.stateStore.getAuthority('METAB');
    const pending =
      this.stateStore.listPendingBiologicalEvents(
        residencyId,
        1024
      );
    const beforeUnit =
      this.units.get(residencyId);

    if (
      !before ||
      before.coreId !== 'METAB' ||
      before.role !== 'metabolism' ||
      before.version !== '0.1.0-p1r0-neutral.1' ||
      before.stateSchema !== 1 ||
      before.moduleRelativePath !==
        'cores/p1-r0/metab-neutral/index.js' ||
      before.status !== 'RUNNING' ||
      !beforeUnit ||
      beforeUnit.outputViolation ||
      beforeUnit.observedOutputs !== 0 ||
      authority !== null ||
      !consumer ||
      consumer.coreId !== 'METAB' ||
      consumer.active !== true ||
      consumer.required !== false ||
      consumer.authorityEpoch !== 0 ||
      stableStringify(consumer.topics) !==
        stableStringify(['runtime.organism.binding']) ||
      pending.length !== 0
    ) {
      fail(
        'METAB is not at the exact contained neutral promotion boundary',
        'P1_METAB_SHADOW_PROMOTION_BASELINE'
      );
    }

    this.validateBinding(binding);

    const previousContract =
      this.contractRegistry.byResidencyId.get(residencyId);
    const previousInspection =
      await this.inspect(
        before.moduleRelativePath,
        residencyId,
        previousContract
      );
    const inspected =
      await this.inspect(
        moduleRelativePath,
        residencyId,
        nextContract
      );

    let candidate = null;
    let committed = false;
    let outputViolation = false;
    let sourceCheckpoint = null;

    try {
      await this.detach(residencyId);
      sourceCheckpoint =
        await this.stateStore.readResidentCheckpoint(
          residencyId
        );

      if (
        !sourceCheckpoint ||
        sourceCheckpoint.version !== before.version ||
        sourceCheckpoint.stateSchema !== before.stateSchema ||
        sourceCheckpoint.blobHash !==
          this.stateStore.getResident(residencyId)?.checkpointHash
      ) {
        fail(
          'METAB neutral source checkpoint is unavailable',
          'P1_METAB_SHADOW_PROMOTION_CHECKPOINT'
        );
      }

      candidate =
        new CoreHostClient({
          modulePath: inspected.definition.modulePath,
          expectedManifest: inspected.definition.manifest,
          instanceId: before.instanceId,
          mode: 'standby',
          logger: this.logger,
          policy: {
            resources: inspected.definition.manifest.resources,
            priority: inspected.definition.manifest.priority
          }
        });

      candidate.on('output', () => {
        outputViolation = true;
      });
      candidate.on('error', () => {});

      await candidate.start(
        sourceCheckpoint.state,
        sourceCheckpoint.stateSchema
      );

      const activationEvent =
        await publishActivation({
          sourceCheckpoint,
          inspected,
          resident: before
        });
      const dispatched =
        await candidate.dispatch(
          activationEvent,
          {
            coreId: 'METAB',
            implementationInstanceId:
              before.instanceId,
            authorityEpoch: 0,
            eventSequence:
              activationEvent.sequence,
            eventId:
              activationEvent.id
          }
        );

      if (outputViolation) {
        fail(
          'METAB emitted output during shadow activation',
          'RESIDENT_OUTPUT_VIOLATION'
        );
      }

      const activatedState =
        dispatched.checkpoint != null
          ? dispatched.checkpoint
          : await candidate.snapshot();
      const activation = activatedState?.activation;

      if (
        activatedState?.schema !==
          'stay-p1-r0-resident/metab-shadow-state-v2' ||
        activatedState?.engineState?.frameIndex !== 0 ||
        activatedState?.engineState?.outputSequence !== '0' ||
        activatedState?.handledEvents !== 0 ||
        activation?.eventId !== activationEvent.id ||
        activation?.eventSequence !== activationEvent.sequence ||
        activation?.instanceId !== before.instanceId ||
        activation?.sourceCheckpointGeneration !==
          sourceCheckpoint.generation ||
        activation?.sourceCheckpointHash !==
          `sha256:${sourceCheckpoint.blobHash}` ||
        activation?.organismIdentityHash !==
          this.organismIdentityHash ||
        activation?.authorityEpoch !== '0' ||
        activation?.outputPolicy !==
          'FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT'
      ) {
        fail(
          'METAB shadow activation did not preserve neutral continuity',
          'P1_METAB_SHADOW_PROMOTION_ACTIVATION'
        );
      }

      const health = await candidate.health();
      if (
        health?.ok !== true ||
        health?.mode !== 'SHADOW' ||
        health?.authorityOwned !== false ||
        health?.activated !== true ||
        health?.frameIndex !== 0 ||
        health?.biologicalOutputs !== 0 ||
        health?.outputPolicy !==
          'FORBIDDEN_UNTIL_HOMEOS_ATTACHMENT'
      ) {
        fail(
          'METAB shadow candidate health gate failed',
          'P1_METAB_SHADOW_PROMOTION_HEALTH'
        );
      }

      const promoted =
        await this.stateStore.promoteResidentGeneration({
          residencyId,
          instanceId: before.instanceId,
          organismIdentityHash:
            before.organismIdentityHash,
          fromVersion: before.version,
          fromStateSchema: before.stateSchema,
          fromModuleRelativePath:
            before.moduleRelativePath,
          fromCheckpointGeneration:
            sourceCheckpoint.generation,
          fromCheckpointHash:
            sourceCheckpoint.blobHash,
          toVersion:
            inspected.definition.manifest.version,
          toStateSchema:
            inspected.definition.manifest.stateSchema,
          toModuleRelativePath:
            inspected.moduleRelativePath,
          toModuleHash:
            inspected.definition.moduleDigest,
          toManifestHash:
            inspected.manifestHash,
          toPackagePolicyHash:
            inspected.definition.packagePolicyHash,
          topics:
            inspected.definition.manifest.inputs,
          genesisEvent: activationEvent,
          state: activatedState,
          promotionKind:
            'METAB_NEUTRAL_TO_SHADOW_R128'
        });

      committed = true;
      candidate.stopping = true;
      await candidate.stop();
      candidate = null;

      this.activateResidentContract(nextContract);

      return await this.startUnit({
        resident: promoted.resident,
        inspected,
        binding,
        checkpoint: promoted.checkpoint,
        acceptanceCommit
      });
    } catch (error) {
      if (candidate) {
        candidate.stopping = true;
        await candidate.stop().catch(() => {});
      }

      if (!committed && sourceCheckpoint) {
        this.activateResidentContract(previousContract);
        try {
          this.stateStore.setResidentStatus(
            residencyId,
            'RECOVERING'
          );
          await this.startUnit({
            resident:
              this.stateStore.getResident(residencyId),
            inspected: previousInspection,
            binding,
            checkpoint: sourceCheckpoint
          });
        } catch (rollbackError) {
          error.rollbackError = {
            code: rollbackError?.code || null,
            message:
              rollbackError?.message ||
              String(rollbackError)
          };
        }
      }

      throw error;
    }
  }


  async promoteP1ContainedGeneration({
    kind,
    moduleRelativePath,
    binding,
    nextContract: nextContractInput,
    publishActivation,
    acceptanceCommit = null
  }) {
    if (this.closed) {
      fail('resident manager is closed', 'RESIDENT_MANAGER_CLOSED');
    }
    if (typeof publishActivation !== 'function' || !nextContractInput) {
      fail('P1 contained promotion configuration is incomplete', 'P1_CONTAINED_PROMOTION_CONFIG');
    }
    const specs = {
      METAB_HOMEOS_ROUTE_R144: {
        residencyId: 'resident:metab',
        coreId: 'METAB',
        role: 'metabolism',
        fromVersion: '0.2.0-p1r0-shadow.1',
        fromSchema: 2,
        fromModule: 'cores/p1-r0/metab-shadow/index.js',
        toVersion: '0.3.0-p1r0-homeos-feed.1',
        toSchema: 3,
        toModule: 'cores/p1-r0/metab-homeos/index.js',
        stage: 'p1-r0-production-homeos-feed-shadow-r144',
        activationTopic: 'runtime.metab.homeos-route-activation',
        stateSchema: 'stay-p1-r0-resident/metab-homeos-state-v3',
        outputPolicy: 'HOMEOS_ONLY_SHADOW_SUMMARIES',
        signalling: RESIDENT_SIGNALLING.LAB_SHADOW_ONLY,
        outputs: ['metab.energy.availability.v1', 'metab.energy.reserve.v1']
      },
      HOMEOS_NEUTRAL_TO_SHADOW_R145: {
        residencyId: 'resident:homeos',
        coreId: 'HOMEOS',
        role: 'homeostasis',
        fromVersion: '0.1.0-p1r0-neutral.1',
        fromSchema: 1,
        fromModule: 'cores/p1-r0/homeos-neutral/index.js',
        toVersion: '0.2.0-p1r0-shadow.1',
        toSchema: 2,
        toModule: 'cores/p1-r0/homeos-shadow/index.js',
        stage: 'p1-r0-production-output-firewalled-shadow-r145',
        activationTopic: 'runtime.homeos.shadow-activation',
        stateSchema: 'stay-p1-r0-resident/homeos-shadow-state-v2',
        outputPolicy: 'FORBIDDEN_UNTIL_INTERO_ATTACHMENT',
        signalling: RESIDENT_SIGNALLING.FORBIDDEN,
        outputs: []
      },
      METAB_INTERO_ROUTE_R148: {
        residencyId: 'resident:metab',
        coreId: 'METAB',
        role: 'metabolism',
        fromVersion: '0.3.0-p1r0-homeos-feed.1',
        fromSchema: 3,
        fromModule: 'cores/p1-r0/metab-homeos/index.js',
        toVersion: '0.4.0-p1r0-intero-feed.1',
        toSchema: 4,
        toModule: 'cores/p1-r0/metab-intero/index.js',
        stage: 'p1-r0-production-intero-feed-shadow-r148',
        activationTopic: 'runtime.metab.intero-route-activation',
        stateSchema: 'stay-p1-r0-resident/metab-intero-state-v4',
        outputPolicy: 'HOMEOS_AND_INTERO_SHADOW_SUMMARIES',
        signalling: RESIDENT_SIGNALLING.LAB_SHADOW_ONLY,
        outputs: ['metab.energy.availability.v1', 'metab.energy.reserve.v1']
      },
      HOMEOS_INTERO_ROUTE_R149: {
        residencyId: 'resident:homeos',
        coreId: 'HOMEOS',
        role: 'homeostasis',
        fromVersion: '0.2.0-p1r0-shadow.1',
        fromSchema: 2,
        fromModule: 'cores/p1-r0/homeos-shadow/index.js',
        toVersion: '0.3.0-p1r0-intero-feed.1',
        toSchema: 3,
        toModule: 'cores/p1-r0/homeos-intero/index.js',
        stage: 'p1-r0-production-intero-feed-shadow-r149',
        activationTopic: 'runtime.homeos.intero-route-activation',
        stateSchema: 'stay-p1-r0-resident/homeos-intero-state-v3',
        outputPolicy: 'INTERO_STABILITY_ONLY_SHADOW_SUMMARY',
        signalling: RESIDENT_SIGNALLING.LAB_SHADOW_ONLY,
        outputs: ['homeos.stability.summary.v1']
      },
      INTERO_NEUTRAL_TO_SHADOW_R150: {
        residencyId: 'resident:intero',
        coreId: 'INTERO',
        role: 'interoception',
        fromVersion: '0.1.0-p1r0-neutral.1',
        fromSchema: 1,
        fromModule: 'cores/p1-r0/intero-neutral/index.js',
        toVersion: '0.2.0-p1r0-shadow.1',
        toSchema: 2,
        toModule: 'cores/p1-r0/intero-shadow/index.js',
        stage: 'p1-r0-production-perception-only-shadow-r150',
        activationTopic: 'runtime.intero.shadow-activation',
        stateSchema: 'stay-p1-r0-resident/intero-shadow-state-v2',
        outputPolicy: 'PERCEPTION_ONLY_NO_OUTPUT',
        signalling: RESIDENT_SIGNALLING.FORBIDDEN,
        outputs: []
      }
    };
    const spec = specs[kind];
    if (!spec || moduleRelativePath !== spec.toModule) {
      fail('P1 contained promotion kind is not exact', 'P1_CONTAINED_PROMOTION_CONFIG');
    }
    const nextContract = normalizeResidentContract(nextContractInput);
    if (
      nextContract.residencyId !== spec.residencyId ||
      nextContract.coreId !== spec.coreId || nextContract.role !== spec.role ||
      nextContract.version !== spec.toVersion || nextContract.stateSchema !== spec.toSchema ||
      nextContract.stage !== spec.stage || nextContract.productionEligible !== false ||
      nextContract.signalling !== spec.signalling || nextContract.authorityMode !== 'shadow' ||
      stableStringify(nextContract.outputs) !== stableStringify(spec.outputs)
    ) fail('P1 contained promotion contract is not exact', 'P1_CONTAINED_PROMOTION_CONTRACT');

    const residencyId = spec.residencyId;
    const before = this.stateStore.getResident(residencyId);
    const consumer = this.stateStore.getBiologicalConsumer(residencyId);
    const beforeUnit = this.units.get(residencyId);
    const pending = this.stateStore.listPendingBiologicalEvents(residencyId, 1024);
    const pendingOutbox = this.stateStore.listPendingBiologicalOutboxIntents({
      producerCoreId: spec.coreId,
      limit: 1024
    });
    const expectedPreviousTopics = [...(this.contractRegistry.byResidencyId.get(residencyId)?.inputs || [])].sort();
    if (
      !before || before.coreId !== spec.coreId || before.role !== spec.role ||
      before.version !== spec.fromVersion || before.stateSchema !== spec.fromSchema ||
      before.moduleRelativePath !== spec.fromModule || before.status !== 'RUNNING' ||
      !beforeUnit || beforeUnit.outputViolation ||
      (spec.signalling === RESIDENT_SIGNALLING.FORBIDDEN && beforeUnit.observedOutputs !== 0) ||
      this.stateStore.getAuthority(spec.coreId) !== null ||
      this.stateStore.listAuthority().some(entry => ['METAB', 'HOMEOS', 'INTERO'].includes(entry.coreId)) ||
      !consumer || consumer.coreId !== spec.coreId || consumer.active !== true ||
      consumer.required !== false || consumer.authorityEpoch !== 0 ||
      stableStringify(consumer.topics) !== stableStringify(expectedPreviousTopics) ||
      pending.length !== 0 || pendingOutbox.length !== 0
    ) fail('resident is not at the exact contained promotion boundary', 'P1_CONTAINED_PROMOTION_BASELINE');

    this.validateBinding(binding);
    const previousContract = this.contractRegistry.byResidencyId.get(residencyId);
    const previousInspection = await this.inspect(before.moduleRelativePath, residencyId, previousContract);
    const inspected = await this.inspect(moduleRelativePath, residencyId, nextContract);
    let candidate = null;
    let committed = false;
    let sourceCheckpoint = null;
    let outputViolation = false;
    try {
      await this.detach(residencyId);
      sourceCheckpoint = await this.stateStore.readResidentCheckpoint(residencyId);
      if (
        !sourceCheckpoint || sourceCheckpoint.version !== before.version ||
        sourceCheckpoint.stateSchema !== before.stateSchema ||
        sourceCheckpoint.blobHash !== this.stateStore.getResident(residencyId)?.checkpointHash
      ) fail('P1 promotion source checkpoint is unavailable', 'P1_CONTAINED_PROMOTION_CHECKPOINT');

      candidate = new CoreHostClient({
        modulePath: inspected.definition.modulePath,
        expectedManifest: inspected.definition.manifest,
        instanceId: before.instanceId,
        mode: 'standby',
        logger: this.logger,
        policy: {
          resources: inspected.definition.manifest.resources,
          priority: inspected.definition.manifest.priority
        }
      });
      candidate.on('output', () => { outputViolation = true; });
      candidate.on('error', () => {});
      await candidate.start(sourceCheckpoint.state, sourceCheckpoint.stateSchema);
      const activationEvent = await publishActivation({ sourceCheckpoint, inspected, resident: before });
      const dispatched = await candidate.dispatch(activationEvent, {
        coreId: spec.coreId,
        implementationInstanceId: before.instanceId,
        authorityEpoch: 0,
        eventSequence: activationEvent.sequence,
        eventId: activationEvent.id
      });
      if (outputViolation) {
        fail('resident emitted output during contained activation', 'RESIDENT_OUTPUT_VIOLATION');
      }
      const activatedState = dispatched.checkpoint || await candidate.snapshot();
      const activation = activatedState?.activation;
      const preserved = kind === 'METAB_HOMEOS_ROUTE_R144'
        ? (
            activatedState?.sourceState?.lastAcceptedFrame === sourceCheckpoint.state?.lastAcceptedFrame &&
            activatedState?.sourceState?.engineState?.outputSequence === '0' &&
            activatedState?.routedEngineState?.frameIndex === sourceCheckpoint.state?.lastAcceptedFrame &&
            activatedState?.routedEngineState?.outputSequence === '0' &&
            activatedState?.emittedOutputSequence === '0'
          )
        : kind === 'HOMEOS_NEUTRAL_TO_SHADOW_R145'
          ? (
            stableStringify(activatedState?.neutralState?.founder) === stableStringify(sourceCheckpoint.state?.founder) &&
            stableStringify(activatedState?.neutralState?.engineState) === stableStringify(sourceCheckpoint.state?.engineState) &&
            activatedState?.neutralState?.engineState?.outputSequence === '0'
          )
          : kind === 'METAB_INTERO_ROUTE_R148'
            ? (
                stableStringify(activatedState?.homeosFeedState) === stableStringify(sourceCheckpoint.state) &&
                activatedState?.interoEngineState?.frameIndex === sourceCheckpoint.state?.routedEngineState?.frameIndex &&
                activatedState?.interoOutputSequence === '0'
              )
            : kind === 'HOMEOS_INTERO_ROUTE_R149'
              ? (
                  stableStringify(activatedState?.sourceState) === stableStringify(sourceCheckpoint.state) &&
                  activatedState?.routedEngineState?.frameIndex === sourceCheckpoint.state?.neutralState?.engineState?.frameIndex &&
                  activatedState?.emittedOutputSequence === '0'
                )
              : (
                  stableStringify(activatedState?.neutralState?.founder) === stableStringify(sourceCheckpoint.state?.founder) &&
                  stableStringify(activatedState?.neutralState?.engineState) === stableStringify(sourceCheckpoint.state?.engineState) &&
                  activatedState?.engineState?.outputSequence === '0' &&
                  activatedState?.lastProjection === null
                );
      if (
        activatedState?.schema !== spec.stateSchema || !preserved ||
        activation?.eventId !== activationEvent.id ||
        activation?.eventSequence !== activationEvent.sequence ||
        activation?.instanceId !== before.instanceId ||
        activation?.sourceCheckpointGeneration !== sourceCheckpoint.generation ||
        activation?.sourceCheckpointHash !== `sha256:${sourceCheckpoint.blobHash}` ||
        activation?.organismIdentityHash !== this.organismIdentityHash ||
        activation?.authorityEpoch !== '0' || activation?.outputPolicy !== spec.outputPolicy
      ) fail('contained activation did not preserve resident continuity', 'P1_CONTAINED_PROMOTION_ACTIVATION');
      const health = await candidate.health();
      const expectedActivationOutputs = kind === 'METAB_INTERO_ROUTE_R148'
        ? Number(BigInt(activatedState.homeosFeedState.emittedOutputSequence))
        : 0;
      if (
        health?.ok !== true || health?.mode !== 'SHADOW' ||
        health?.authorityOwned !== false || health?.activated !== true ||
        health?.biologicalOutputs !== expectedActivationOutputs || health?.outputPolicy !== spec.outputPolicy
      ) fail('contained candidate health gate failed', 'P1_CONTAINED_PROMOTION_HEALTH');

      const promoted = await this.stateStore.promoteResidentGeneration({
        residencyId,
        instanceId: before.instanceId,
        organismIdentityHash: before.organismIdentityHash,
        fromVersion: before.version,
        fromStateSchema: before.stateSchema,
        fromModuleRelativePath: before.moduleRelativePath,
        fromCheckpointGeneration: sourceCheckpoint.generation,
        fromCheckpointHash: sourceCheckpoint.blobHash,
        toVersion: inspected.definition.manifest.version,
        toStateSchema: inspected.definition.manifest.stateSchema,
        toModuleRelativePath: inspected.moduleRelativePath,
        toModuleHash: inspected.definition.moduleDigest,
        toManifestHash: inspected.manifestHash,
        toPackagePolicyHash: inspected.definition.packagePolicyHash,
        topics: inspected.definition.manifest.inputs,
        genesisEvent: activationEvent,
        state: activatedState,
        promotionKind: kind
      });
      committed = true;
      candidate.stopping = true;
      await candidate.stop();
      candidate = null;
      this.activateResidentContract(nextContract);
      return await this.startUnit({
        resident: promoted.resident,
        inspected,
        binding,
        checkpoint: promoted.checkpoint,
        acceptanceCommit
      });
    } catch (error) {
      if (candidate) {
        candidate.stopping = true;
        await candidate.stop().catch(() => {});
      }
      if (!committed && sourceCheckpoint) {
        this.activateResidentContract(previousContract);
        try {
          this.stateStore.setResidentStatus(residencyId, 'RECOVERING');
          await this.startUnit({
            resident: this.stateStore.getResident(residencyId),
            inspected: previousInspection,
            binding,
            checkpoint: sourceCheckpoint
          });
        } catch (rollbackError) {
          error.rollbackError = {
            code: rollbackError?.code || null,
            message: rollbackError?.message || String(rollbackError)
          };
        }
      }
      throw error;
    }
  }


  async recover(
    residencyId,
    binding,
    {
      acceptanceCommit = null,
      exactCurrentCheckpoint = null
    } = {}
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

    let checkpoint;
    let finalizedReplay = [];

    if (exactCurrentCheckpoint !== null) {
      checkpoint = await this.stateStore.readResidentCheckpoint(residencyId);
      const exact = checkpoint &&
        checkpoint.checkpointId === exactCurrentCheckpoint.checkpointId &&
        checkpoint.residencyId === residencyId &&
        checkpoint.instanceId === resident.instanceId &&
        checkpoint.version === resident.version &&
        checkpoint.stateSchema === resident.stateSchema &&
        checkpoint.generation === exactCurrentCheckpoint.checkpointGeneration &&
        checkpoint.blobHash === exactCurrentCheckpoint.checkpointHash &&
        checkpoint.byteLength === exactCurrentCheckpoint.checkpointBytes &&
        checkpoint.inputCursor === exactCurrentCheckpoint.inputCursor;
      if (!exact) {
        fail(
          'current resident checkpoint changed outside the exact recovery fence',
          'RESIDENT_EXACT_CURRENT_CHECKPOINT_MISMATCH'
        );
      }
      /*
       * The real startUnit launch below validates this exact checkpoint using
       * the same CoreHost initialization path. Do not launch and tear down a
       * second disposable CoreHost for a checkpoint whose complete durable
       * identity is already revision-fenced here. Historical candidate
       * selection still uses the independent preflight path below.
       */
    } else if (inspected.contract.priorCheckpointRecovery) {
      const plan = await this.stateStore.buildResidentCheckpointRecoveryPlan(residencyId);
      if (plan) {
        for (const candidate of plan.candidates) {
          if (await this.preflightResidentCheckpoint(resident, inspected, candidate)) {
            checkpoint = candidate;
            break;
          }
        }
        if (checkpoint) {
          finalizedReplay = this.stateStore.listFinalizedResidentReplayEvents({
            residencyId,
            afterGeneration: checkpoint.generation,
            throughGeneration: plan.pointerGeneration,
            afterInputCursor: checkpoint.inputCursor,
            throughInputCursor: plan.replayThroughCursor,
            limit: 1024
          });
        }
      }
    } else {
      checkpoint = await this.stateStore.readResidentCheckpoint(residencyId);
    }

    if (!checkpoint) {
      fail(
        inspected.contract.priorCheckpointRecovery
          ? 'no retained resident checkpoint validates; refusing reconstruction'
          : 'resident history is missing; refusing neutral reconstruction',
        inspected.contract.priorCheckpointRecovery
          ? 'RESIDENT_CHECKPOINT_NO_VALID'
          : 'RESIDENT_CHECKPOINT_MISSING'
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
      checkpoint,
      finalizedReplay,
      backfillInactiveGap: true,
      acceptanceCommit
    });
  }


  async preflightResidentCheckpoint(resident, inspected, checkpoint) {
    const client = new CoreHostClient({
      modulePath: inspected.definition.modulePath,
      expectedManifest: inspected.definition.manifest,
      instanceId: resident.instanceId,
      mode: 'standby',
      logger: this.logger,
      policy: {
        resources: inspected.definition.manifest.resources,
        priority: inspected.definition.manifest.priority
      }
    });
    client.on('error', () => {});
    try {
      await client.start(checkpoint.state, checkpoint.stateSchema);
      return true;
    } catch {
      return false;
    } finally {
      await client.stop().catch(() => {});
    }
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
        /* BoundedActorQueue.onFault is the sole terminal-fault owner. */
        .catch(() => {});
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

    const dispatchedEvent =
      this.withRouteCompleteness(
        unit,
        event
      );

    let dispatched;

    try {
      dispatched =
        await unit.client
          .dispatch(
            dispatchedEvent,
            {
              coreId:
                unit.manifest.coreId,

              implementationInstanceId:
                unit.resident
                  .instanceId,

              authorityEpoch:
                unit.contract
                  .signalling ===
                    RESIDENT_SIGNALLING
                      .LAB_SHADOW_ONLY
                  ? unit.contract
                      .producerEpoch
                  : 0,

              eventSequence:
                event.sequence,

              eventId:
                event.id
            }
          );
    } catch (error) {
      /*
       * The trusted supervisor may have delivered one or more speculative
       * output messages before discovering a later output/protocol failure.
       * None crossed the StateStore commit boundary. Erase the whole attempt
       * before BoundedActorQueue reconstructs the worker and retries the same
       * durable sequence.
       */
      unit.pendingOutputIntents
        .delete(
          event.sequence
        );

      throw error;
    }


    if (
      unit.outputViolation
    ) {
      fail(
        'resident emitted forbidden output',
        'RESIDENT_OUTPUT_VIOLATION'
      );
    }


    const outputIntents =
      unit.pendingOutputIntents
        .get(
          event.sequence
        ) ||
      [];


    if (
      !event.ledger?.durable
    ) {
      unit.pendingOutputIntents
        .delete(
          event.sequence
        );

      if (outputIntents.length > 0) {
        fail(
          'resident signalling requires a durable originating event',
          'RESIDENT_OUTPUT_CAUSALITY'
        );
      }

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
            },

            producerEpoch:
              unit.contract
                .producerEpoch ||
              null,

            producerTransitionId:
              transitionId(
                unit.residencyId,
                event
              ),

            outboxIntents:
              outputIntents,

            allowCommittedOutboxReplay:
              unit.replaySequence === event.sequence
          });
    } catch (error) {
      unit.pendingOutputIntents
        .delete(
          event.sequence
        );

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

    unit.pendingOutputIntents
      .delete(
        event.sequence
      );

    if (
      persisted.outboxIntents
        ?.length > 0
    ) {
      await this.tryDrainResidentOutbox(
        unit
      );
    }


    unit.handledEvents +=
      1;

    unit.resident =
      this.stateStore
        .getResident(
          unit.residencyId
        );


    return persisted;
  }


  withRouteCompleteness(unit, event) {
    if (!unit.contract.routeCompleteness) return event;
    const completeness = this.stateStore.computeBiologicalSafeCompletenessFrontier({
      consumerId: unit.residencyId
    });
    const targetUs = event.topic === 'runtime.trusted-organism-time.pulse'
      ? event.payload?.trustedTimeUs
      : event.topic === 'environment.photic.exposure'
        ? event.payload?.effective_to_us
        : null;
    const activeStreams = completeness.activeRoutes
      .map(route => route.producerStreamId)
      .filter(Boolean);
    const pendingThroughUs = event.topic === 'runtime.trusted-organism-time.pulse'
      ? targetUs
      : completeness.frontierUs;
    const pendingReplayEvidence = Number.isSafeInteger(pendingThroughUs)
      && unit.finalizedReplayTail.some(candidate => candidate.sequence !== event.sequence
        && activeStreams.includes(candidate.meta?.producerStreamId)
        && Number.isSafeInteger(candidate.payload?.effective_from_us)
        && candidate.payload.effective_from_us <= pendingThroughUs);
    const pendingEvidence = pendingReplayEvidence || (Number.isSafeInteger(pendingThroughUs)
      && this.stateStore.hasPendingBiologicalRouteEvidence({
        consumerId: unit.residencyId,
        producerStreamIds: activeStreams,
        throughUs: pendingThroughUs,
        excludingSequence: event.sequence
      }));
    return Object.freeze({
      ...event,
      meta: Object.freeze({
        ...(event.meta || {}),
        residentRouteCompleteness: Object.freeze({
          complete: completeness.complete,
          unconstrained: completeness.unconstrained,
          configured: completeness.activeRoutes.length
            + completeness.blockers.length
            + completeness.releasedRoutes.length > 0,
          frontierUs: completeness.frontierUs,
          pendingEvidence,
          activeRoutes: completeness.activeRoutes,
          blockers: completeness.blockers,
          releasedRoutes: completeness.releasedRoutes
        })
      })
    });
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


    const failedGeneration =
      Number(error.coreHostGeneration) ||
      unit.client.generation;

    /*
     * The actor still owns this exact PENDING event. Await the single-flight
     * reconstruction from the last database-committed recovery image and
     * prove the process generation advanced before replay is permitted.
     */
    await unit.client
      .ensureRecovery(error);

    await waitForResidentCoreHostRecovery(
      unit.client,
      failedGeneration,
      Math.max(
        5000,
        residentTransitionTimeoutMs(
          unit.client.handlerTimeoutMs ??
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
              null,

            failedGeneration,

            recoveredGeneration:
              unit.client.generation
          }
        );
    } catch {}


    return true;
  }


  persistTerminalTransition(
    unit,
    status,
    recoveryType,
    detail
  ) {
    try {
      this.stateStore
        .transitionResidentToTerminal({
          residencyId:
            unit.residencyId,

          status,

          recoveryType,

          coreId:
            unit.manifest.coreId,

          detail
        });

      unit.terminalPersistenceError =
        null;

      return true;
    } catch (error) {
      unit.terminalPersistenceError = {
        at:
          new Date().toISOString(),

        code:
          error.code || null,

        message:
          error.message || String(error)
      };

      this.logger.error?.(
        `[STAY] resident terminal transition was not persisted: ${error.message}`
      );

      return false;
    }
  }


  stopTerminalUnit(
    unit,
    phase
  ) {
    Promise.resolve()
      .then(() => unit.client?.stop())
      .catch(error => {
        unit.teardownError = {
          at:
            new Date().toISOString(),

          phase,

          code:
            error.code || null,

          message:
            error.message || String(error)
        };

        try {
          this.stateStore
            .recordRecovery(
              'resident.terminal-teardown-failed',
              unit.manifest.coreId,
              {
                residencyId:
                  unit.residencyId,

                phase,

                code:
                  error.code || null,

                message:
                  error.message || String(error)
              }
            );
        } catch {}

        this.logger.error?.(
          `[STAY] resident terminal teardown failed: ${error.message}`
        );
      });
  }


  markResyncRequired(
    unit,
    error,
    event
  ) {
    if (unit.resyncRequired || unit.outputViolation) return false;
    unit.resyncRequired = true;

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

    /*
     * One component owns terminal chronology failure. Stop the queue before
     * changing consumer eligibility so follow-on COREHOST_OFFLINE errors
     * cannot fan out duplicate resync records or additional delivery debt.
     */
    try {
      unit.queue?.close(
        Object.assign(
          new Error(`resident ${unit.residencyId} requires resynchronization`),
          {
            code: 'RESIDENT_RESYNC_REQUIRED',
            cause: error
          }
        )
      );
    } catch {}

    unit.lifecycle = 'failed';
    this.stopTerminalUnit(
      unit,
      'resync-required'
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
      this.persistTerminalTransition(
        unit,
        'RESYNC_REQUIRED',
        'resident.resync-required',
        {
          residencyId:
            unit.residencyId,

          ...unit.lastError
        }
      );
    }

    return true;
  }


  handleOutputViolation(
    unit,
    message
  ) {
    unit.observedOutputs +=
      1;

    if (unit.outputViolation) {
      return;
    }

    unit.outputViolation =
      true;

    unit.lifecycle =
      'failed';

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
      unit.queue?.close(
        Object.assign(
          new Error('resident output firewall tripped'),
          { code: 'RESIDENT_OUTPUT_VIOLATION' }
        )
      );
    } catch {}

    this.persistTerminalTransition(
      unit,
      'QUARANTINED',
      'resident.output-violation',
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

    this.stopTerminalUnit(
      unit,
      'output-violation'
    );

    /*
     * Intentionally NO EventFabric publish path.
     */
  }


  handleSignallingOutput(
    unit,
    message
  ) {
    unit.observedOutputs +=
      1;

    const topic =
      message?.topic;

    const context =
      message?.context;

    const eventSequence =
      Number(
        context?.eventSequence
      );

    const outputIndex =
      Number(
        message?.meta
          ?.outputIndex
      );

    if (
      !unit.manifest.outputs.includes(
        topic
      ) ||
      context?.coreId !==
        unit.manifest.coreId ||
      context
        ?.implementationInstanceId !==
        unit.resident.instanceId ||
      Number(
        context?.authorityEpoch
      ) !==
        unit.contract.producerEpoch ||
      !Number.isSafeInteger(
        eventSequence
      ) ||
      eventSequence < 1 ||
      !Number.isSafeInteger(
        outputIndex
      ) ||
      outputIndex < 1
    ) {
      fail(
        'resident signalling output has invalid provenance',
        'RESIDENT_OUTPUT_PROVENANCE'
      );
    }

    const pending =
      unit.pendingOutputIntents
        .get(
          eventSequence
        ) ||
      [];

    if (
      pending.some(
        intent =>
          intent.outputIndex ===
            outputIndex
      )
    ) {
      fail(
        'resident signalling output index is duplicated',
        'BIOLOGICAL_OUTBOX_ORDER'
      );
    }

    pending.push({
      outputIndex,
      topic,
      payload:
        structuredClone(
          message.payload
        ),
      causeSequence:
        eventSequence,
      causalParent:
        context?.eventId ||
        null
    });

    pending.sort(
      (left, right) =>
        left.outputIndex -
        right.outputIndex
    );

    unit.pendingOutputIntents
      .set(
        eventSequence,
        pending
      );
  }


  async drainResidentOutbox(
    unit,
    limit = 128
  ) {
    let drained = 0;

    for (;;) {
      const intents =
        this.stateStore
          .listDrainableBiologicalOutboxIntents({
            producerCoreId:
              unit.manifest.coreId,
            currentAuthorityEpoch:
              unit.contract
                .producerEpoch,
            limit
          });

      if (intents.length === 0) {
        return drained;
      }

      for (const intent of intents) {
        const event =
          await this.fabric.publish(
            intent.topic,
            intent.payload,
            {
              ...intent.publishMeta,
              authorityMode:
                unit.contract
                  .authorityMode,
              physiologicalAuthority:
                false
            }
          );

        this.stateStore
          .markBiologicalOutboxPublished({
            producerEventId:
              intent.producerEventId,
            event
          });

        drained += 1;
      }

      if (intents.length < limit) {
        return drained;
      }
    }
  }


  async tryDrainResidentOutbox(
    unit
  ) {
    try {
      const drained = await this
        .drainResidentOutboxSingleFlight(
          unit
        );

      unit.outboxFailureSignature =
        null;

      return drained;
    } catch (error) {
      this.recordOutboxPending(
        unit,
        error
      );

      return 0;
    }
  }


  async drainResidentOutboxSingleFlight(
    unit
  ) {
    if (unit.outboxDrainPromise) {
      return unit.outboxDrainPromise;
    }

    const operation =
      Promise.resolve()
        .then(() =>
          this.drainResidentOutbox(
            unit
          )
        );

    unit.outboxDrainPromise =
      operation;

    try {
      return await operation;
    } finally {
      if (
        unit.outboxDrainPromise ===
          operation
      ) {
        unit.outboxDrainPromise =
          null;
      }
    }
  }


  recordOutboxPending(
    unit,
    error
  ) {
    const signature =
      `${error?.code || ''}\u0000${error?.message || ''}`;

    if (
      unit.outboxFailureSignature ===
        signature
    ) {
      return;
    }

    unit.outboxFailureSignature =
      signature;

    try {
      this.stateStore
        .recordRecovery(
          'resident.outbox-pending',
          unit.manifest.coreId,
          {
            residencyId:
              unit.residencyId,
            code:
              error?.code ||
              null,
            message:
              error?.message ||
              'biological outbox publication failed'
          }
        );
    } catch {}
  }


  async maintainResidentOutboxes() {
    if (this.closed) {
      return 0;
    }

    let drained = 0;
    const failures = [];

    const units =
      [...this.units.values()]
        .sort(
          (left, right) =>
            left.residencyId.localeCompare(
              right.residencyId
            )
        );

    for (const unit of units) {
      const resident =
        this.stateStore
          .getResident(
            unit.residencyId
          );

      if (
        resident?.status !==
          'RUNNING'
      ) {
        continue;
      }

      try {
        drained +=
          await this
            .drainResidentOutboxSingleFlight(
              unit
            );

        unit.outboxFailureSignature =
          null;
      } catch (error) {
        this.recordOutboxPending(
          unit,
          error
        );

        failures.push({
          residencyId:
            unit.residencyId,
          code:
            error.code ||
            null,
          message:
            error.message
        });
      }
    }

    if (failures.length > 0) {
      throw Object.assign(
        new Error(
          `durable resident outbox maintenance failed for ${failures.map(value => value.residencyId).join(', ')}`
        ),
        {
          code:
            'RESIDENT_OUTBOX_MAINTENANCE',
          failures
        }
      );
    }

    return drained;
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
      } catch (error) {
        try {
          this.stateStore
            .recordRecovery(
              'resident.detach-teardown-failed',
              resident?.coreId || unit.manifest?.coreId || null,
              {
                residencyId:
                  unit.residencyId,

                instanceId:
                  resident?.instanceId || null,

                code:
                  error.code || null,

                message:
                  error.message || String(error)
              }
            );
        } catch {}

        this.logger.warn?.(
          `[STAY] resident detach teardown failed: ${error.message}`
        );
      }

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
    runtimeRevision,
    {
      allowColdQuarantine =
        false,
      exactR146HomeosBacklog =
        false,
      exactR147ContinuationBacklog =
        false
    } = {}
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

    const coldQuarantine =
      allowColdQuarantine === true &&
      (
        (
          resident.residencyId ===
            'resident:sntss' &&
          resident.coreId ===
            'sntss'
        ) ||
        (
          resident.residencyId ===
            'resident:chronobiology' &&
          resident.coreId ===
            'chronobiology'
        )
      ) &&
      resident.status ===
        'QUARANTINED';

    const containedChronobiologyBacklog =
      coldQuarantine &&
      resident.residencyId ===
        'resident:chronobiology' &&
      resident.coreId ===
        'chronobiology';

    const containedR146HomeosBacklog =
      exactR146HomeosBacklog === true &&
      resident.residencyId === 'resident:homeos' &&
      resident.coreId === 'HOMEOS' &&
      resident.version === '0.2.0-p1r0-shadow.1' &&
      resident.status === 'RESYNC_REQUIRED' &&
      runtimeRevision === 146;

    const containedR147ContinuationBacklog =
      exactR147ContinuationBacklog === true &&
      ['resident:homeos', 'resident:sntss'].includes(resident.residencyId) &&
      ['HOMEOS', 'sntss'].includes(resident.coreId) &&
      resident.status === 'RESYNC_REQUIRED' && runtimeRevision === 147;

    if (
      resident.status !==
        'RESYNC_REQUIRED' &&
      !coldQuarantine
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
      containedChronobiologyBacklog
        ? this.stateStore
            .beginResidentColdBacklogReplay({
              residencyId,
              coreId:
                resident.coreId,
              checkpointHash:
                checkpoint.blobHash,
              runtimeRevision,
              maximumPending:
                8192
            })
        : containedR146HomeosBacklog
          ? this.stateStore
              .beginExactR146HomeosBacklogReplay({
                residencyId,
                coreId: resident.coreId,
                checkpointHash: checkpoint.blobHash,
                runtimeRevision
              })
          : containedR147ContinuationBacklog
            ? this.stateStore.beginExactR147ContinuationBacklogReplay({
                residencyId,
                coreId: resident.coreId,
                checkpointHash: checkpoint.blobHash,
                runtimeRevision,
                maximumPending: 1023
              })
        : this.stateStore
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

    if (!containedChronobiologyBacklog && !containedR146HomeosBacklog &&
        !containedR147ContinuationBacklog) {
      this.stateStore
        .setResidentStatus(
          residencyId,
          'RECOVERING'
        );
    }

    const restarted =
      await this.startUnit({
        resident:
          this.stateStore
            .getResident(
              residencyId
            ),
        inspected,
        binding,
        checkpoint,
        backfillInactiveGap:
          !containedChronobiologyBacklog && !containedR146HomeosBacklog,
        replayDebtLimit:
          containedChronobiologyBacklog
            ? 8192
            : containedR146HomeosBacklog
              ? 2
              : 1023,
        preserveConsumerOnFailure:
          containedChronobiologyBacklog || containedR146HomeosBacklog ||
          containedR147ContinuationBacklog
      });

    this.stateStore
      .recordRecovery(
        containedChronobiologyBacklog
          ? 'resident.cold-backlog-replayed'
          : containedR146HomeosBacklog
            ? 'resident.exact-backlog-replayed'
          : containedR147ContinuationBacklog
            ? 'resident.r147-continuation-replayed'
          : coldQuarantine
            ? 'resident.cold-quarantine-recovered'
          : 'resident.resynchronized',
        resident.coreId,
        {
          residencyId,
          resyncId:
            record.resyncId ||
            null,
          replayId:
            record.replayId ||
            null,
          abandonedCount:
            record.abandonedCount,
          fromCursor:
            record.fromCursor,
          toCursor:
            record.toCursor,
          runtimeRevision,
          coldQuarantine,
          inventedBiologicalTime:
            false,
          replayedPendingCount:
            containedChronobiologyBacklog
              ? record.pendingCount
              : containedR146HomeosBacklog
                ? record.pendingCount
                : containedR147ContinuationBacklog
                  ? record.eligibleReplayCount
                  : 0
        }
      );

    return {
      unit:
        restarted,
      record
    };
  }


  async replayPendingBiologicalEvents(
    unit,
    maximumEvents = 1023
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
    const pagedColdReplay =
      Number.isSafeInteger(maximumEvents) &&
      maximumEvents > 1023 &&
      maximumEvents <= 8192 &&
      unit.residencyId ===
        'resident:chronobiology' &&
      unit.manifest.coreId ===
        'chronobiology';
    let processed = 0;
    let replayed = 0;
    let ignored = 0;

    while (true) {
      const pending =
        this.stateStore
          .listPendingBiologicalEvents(
            unit.residencyId,
            1024
          );

      if (!pending.length) break;

      if (
        pending.length >= 1024 &&
        !pagedColdReplay
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

      if (processed + pending.length > maximumEvents) {
        const error = Object.assign(
          new Error('contained cold backlog replay exceeds its fixed total bound'),
          { code: 'RESIDENT_COLD_REPLAY_BOUNDED' }
        );
        this.markResyncRequired(unit, error, pending[0] || null);
        throw error;
      }

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

      processed += pending.length;
      if (!pagedColdReplay || pending.length < 1024) break;
    }


    return {
      replayed,
      ignored
    };
  }


  async replayFinalizedResidentEvents(unit) {
    while (unit.finalizedReplayTail.length > 0) {
      const event = unit.finalizedReplayTail[0];
      if (!event?.ledger?.durable) {
        fail('resident finalized replay contains non-durable evidence',
          'RESIDENT_FINALIZED_REPLAY_INCOMPLETE');
      }
      unit.replaySequence = event.sequence;
      await unit.queue.enqueue(event);
      unit.finalizedReplayTail.shift();
    }
    unit.replaySequence = null;
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
          unit.client.handlerTimeoutMs ??
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

    if (unit && resident.status === 'RUNNING' && !unit.resyncRequired) {
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

      running:
        Boolean(
          unit &&
          resident.status === 'RUNNING' &&
          ['standby', 'shadow', 'active'].includes(unit.lifecycle) &&
          unit.resyncRequired !== true &&
          unit.outputViolation !== true &&
          !unit.terminalPersistenceError &&
          !unit.teardownError
        ),

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

      lastSlowTransition:
        unit
          ? unit.lastSlowTransition
          : null,

      resyncRequired:
        Boolean(unit?.resyncRequired || resident.status === 'RESYNC_REQUIRED'),

      terminalPersistenceError:
        unit?.terminalPersistenceError || null,

      teardownError:
        unit?.teardownError || null,

      queue:
        unit
          ? unit.queue.snapshotMetrics()
          : null,

      durabilityContract: {
        eventCheckpointConsumerAckAtomic:
          true,

        outboxIntentInSameCommit:
          true,

        biologicalPublicationFromCommittedOutboxOnly:
          true,

        recoveryImageAdvancesAfterCommitOnly:
          true,

        activationGapBackfillAtomic:
          true,

        outboxPublicationSingleFlight:
          true,

        startupFailureTeardownComplete:
          true
      },

      activationBackfilled:
        unit
          ? unit.activationBackfilled
          : 0,

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
          try {
            this.stateStore
              .recordRecovery(
                'resident.shutdown-checkpoint-failed',
                resident.coreId,
                {
                  residencyId:
                    unit.residencyId,

                  instanceId:
                    resident.instanceId,

                  checkpointGeneration:
                    Number(resident.checkpointGeneration) || 0,

                  code:
                    error.code || null,

                  message:
                    error.message || String(error)
                }
              );
          } catch {}

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
      } catch (error) {
        try {
          this.stateStore
            .recordRecovery(
              'resident.shutdown-stop-failed',
              resident?.coreId || unit.manifest?.coreId || null,
              {
                residencyId:
                  unit.residencyId,

                instanceId:
                  resident?.instanceId || null,

                code:
                  error.code || null,

                message:
                  error.message || String(error)
              }
            );
        } catch {}

        this.logger.warn?.(
          `[STAY] resident shutdown stop failed: ${error.message}`
        );
      }
    }


    this.units.clear();
  }
}


module.exports = {
  ResidentManager,
  L0_SNTSS_CONTRACT,
  I4G_SNTSS_CONTRACT,
  CHRONOBIOLOGY_RESIDENT_CONTRACT,
  RESIDENT_SIGNALLING,
  normalizeResidentContract,
  createResidentContractRegistry,
  canonicalHash,
  transitionId,
  residentTransitionTimeoutMs
};
