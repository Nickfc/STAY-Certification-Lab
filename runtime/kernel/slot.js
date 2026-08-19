'use strict';

const crypto = require('node:crypto');
const { CoreHostClient } = require('./core-host-client');
const { BoundedActorQueue } = require('./actor-queue');
const { ShadowEvidence } = require('./shadow-evidence');
const { assertUpgradeCompatible } = require('./manifest');
const { serializedSize } = require('./protocol');
const { stableStringify } = require('./canonical-json');

function transitionId(consumerId, event) {
  return 'sha256:' + crypto.createHash('sha256').update(stableStringify({
    protocol: 'stay-biological-transition-v1', consumerId, eventId: event.id, sequence: event.sequence
  })).digest('hex');
}

class HostedUnit {
  constructor({ definition, client, mode, instanceId, assignedEpoch, queue, evidence = null }) {
    this.definition = definition;
    this.manifest = definition.manifest;
    this.client = client;
    this.mode = mode;
    this.instanceId = instanceId;
    this.assignedEpoch = assignedEpoch;
    this.queue = queue;
    this.evidence = evidence;
    this.handledEvents = 0;
    this.suppressedOutputs = 0;
    this.authoritativeOutputs = 0;
    this.staleOutputs = 0;
    this.shadowRequiredFailures = 0;
    this.lastShadowFailure = null;
    this.lifecycle = mode;
  }

  async setMode(mode, epoch = this.assignedEpoch) {
    this.mode = mode;
    this.assignedEpoch = epoch;
    await this.client.setMode(mode);
  }

  async snapshot() { return this.client.snapshot(); }
  async health() { return this.client.health(); }
  async stop() { this.queue.close(); await this.client.stop(); }
}

class RuntimeSlot {
  constructor({ coreId, fabric, stateStore, logger = console }) {
    this.coreId = coreId;
    this.consumerId = `core:${coreId}`;
    this.fabric = fabric;
    this.stateStore = stateStore;
    this.logger = logger;
    this.active = null;
    this.candidate = null;
    this.standby = null;
    this.authorityEpoch = 0;
    this.cutoverBarrier = 0;
    this.cutover = null;
    this.transitioning = false;
    this.lastAuthorityError = null;
    this.unsubscribe = fabric.subscribeAll(event => this.dispatch(event));
  }

  async buildUnit(definition, stateEnvelope, mode, instanceId, assignedEpoch, evidence = null) {
    const client = new CoreHostClient({
      modulePath: definition.modulePath,
      expectedManifest: definition.manifest,
      instanceId,
      mode,
      logger: this.logger,
      policy: { resources: definition.manifest.resources, priority: definition.manifest.priority }
    });
    const unit = new HostedUnit({ definition, client, mode, instanceId, assignedEpoch, queue: null, evidence });
    unit.pendingOutputIntents = new Map();
    const queue = new BoundedActorQueue({
      name: `${this.coreId}:${instanceId}`,
      capacity: client.policy.queueCapacity,
      handlerTimeoutMs: client.policy.handlerTimeoutMs,
      handler: async event => {
        const eventSequence =
          Number(
            event?.sequence
          ) || 0;

        let dispatched;

        try {
          dispatched =
            await client.dispatch(
              event,
              {
                coreId:
                  this.coreId,

                implementationInstanceId:
                  instanceId,

                authorityEpoch:
                  unit.assignedEpoch,

                eventSequence,

                eventId:
                  event.id
              }
            );
        } catch (error) {
          unit.pendingOutputIntents.delete(
            eventSequence
          );

          throw error;
        }

        const outboxIntents = [
          ...(
            unit.pendingOutputIntents.get(
              eventSequence
            ) ||
            []
          )
        ].sort(
          (a, b) =>
            a.outputIndex -
            b.outputIndex
        );

        unit.pendingOutputIntents.delete(
          eventSequence
        );

        if (
          unit ===
            this.active &&
          unit.mode ===
            'active' &&
          event.ledger?.durable
        ) {
          try {
            await this.persistUnit(
              unit,
              unit.assignedEpoch,
              true,
              {
                event,

                state:
                  dispatched.checkpoint,

                transitionId:
                  transitionId(
                    this.consumerId,
                    event
                  ),

                outboxIntents
              }
            );
          } catch (error) {
            await client.recycle(
              'uncommitted-transition',
              {
                eventSequence:
                  event.sequence,

                code:
                  error.code ||
                  null
              }
            );

            throw Object.assign(
              new Error(
                `durable transition ${event.sequence} was not committed: ${error.message}`
              ),
              {
                code:
                  'BIOLOGICAL_COMMIT_FAILED',

                cause:
                  error,

                eventSequence:
                  event.sequence
              }
            );
          }

          unit.authoritativeOutputs +=
            outboxIntents.length;

          if (
            this.candidate?.evidence
          ) {
            for (
              const intent
              of outboxIntents
            ) {
              this.candidate.evidence.recordActive({
                eventSequence,

                topic:
                  intent.topic,

                payload:
                  intent.payload
              });
            }
          }

          /*
           * Transport happens only after the originating
           * state transaction committed.
           */
          await this.tryDrainProducerOutbox();

        } else {
          if (
            unit ===
              this.active &&
            unit.mode ===
              'active' &&
            outboxIntents.length >
              0
          ) {
            await client.recycle(
              'uncommitted-transition',
              {
                eventSequence,

                code:
                  'BIOLOGICAL_OUTBOX_REQUIRES_DURABLE_TRANSITION'
              }
            );

            throw Object.assign(
              new Error(
                'authoritative output requires a durable originating transition'
              ),
              {
                code:
                  'BIOLOGICAL_OUTBOX_REQUIRES_DURABLE_TRANSITION',

                eventSequence
              }
            );
          }

          if (
            dispatched.checkpoint !=
            null
          ) {
            client.setRecoveryState(
              dispatched.checkpoint,
              unit.manifest.stateSchema
            );
          }
        }

        unit.handledEvents +=
          1;
      },
      onFault: (error, event) => {
        unit.lifecycle = 'degraded';

        const executionTimeout =
          error.code === 'ACTOR_HANDLER_TIMEOUT' ||
          error.code === 'COREHOST_TIMEOUT';

        if (!executionTimeout) return;

        if (unit.mode === 'shadow') {
          /*
           * A shadow has zero authority. Once execution times out its shadow
           * history is incomplete and this exact candidate can never become
           * authoritative.
           *
           * Fail it closed. Do not recycle it and do not let a replacement
           * shadow consume later events with a hole in its history.
           */
          if (['critical', 'durable'].includes(event?.class)) {
            this.recordRequiredShadowFailure(unit, event, error);
          }

          unit.lifecycle = 'failed';

          const closureError = Object.assign(
            new Error('shadow candidate failed closed after execution timeout'),
            {
              code: 'SHADOW_CANDIDATE_FAILED',
              cause: error
            }
          );

          unit.queue.close(closureError);

          client.stop().catch(stopError => {
            this.logger.warn?.(
              `[STAY] failed shadow cleanup ${this.coreId}: ${stopError.message}`
            );
          });

          return;
        }

        client.recycle(
          'actor-handler-timeout',
          { eventSequence: event?.sequence }
        ).catch(() => {});
      }
    });
    unit.queue = queue;
    client.on('output', message => this.handleOutput(unit, message));
    client.on('lifecycle', lifecycle => { unit.lifecycle = lifecycle; });
    client.on('quarantined', detail => {
      unit.lifecycle = 'failed';
      this.stateStore.recordRecovery('core.quarantined', this.coreId, { instanceId, ...detail });
    });
    client.on('error', error => {
      unit.lifecycle = 'degraded';
      this.logger.error?.(`[STAY] CoreHost ${this.coreId}/${instanceId}: ${error.message}`);
    });
    client.on('protocol-error', error => { unit.lifecycle = 'degraded'; this.logger.error?.(error.message); });
    const envelope = stateEnvelope || { stateSchema: definition.manifest.stateSchema, state: {} };
    await client.start(envelope.state || {}, envelope.stateSchema);
    return unit;
  }

  async handleOutput(unit, message) {
    const context =
      message.context;

    const topic =
      message.topic;

    if (
      !unit.manifest.outputs.includes(
        topic
      )
    ) {
      throw new Error(
        'CoreHost emitted undeclared output: ' +
        topic
      );
    }

    const eventSequence =
      Number(
        context?.eventSequence
      ) || 0;

    const payload =
      message.payload;

    if (
      unit ===
        this.active &&
      unit.mode ===
        'active'
    ) {
      const valid =
        context &&
        context.coreId ===
          this.coreId &&
        context.implementationInstanceId ===
          unit.instanceId &&
        Number(
          context.authorityEpoch
        ) ===
          this.authorityEpoch &&
        Number(
          context.authorityEpoch
        ) ===
          unit.assignedEpoch &&
        eventSequence >
          this.cutoverBarrier;

      if (!valid) {
        unit.staleOutputs +=
          1;

        this.lastAuthorityError = {
          at:
            new Date().toISOString(),

          code:
            'STALE_AUTHORITY_OUTPUT',

          instanceId:
            unit.instanceId,

          eventSequence,

          outputEpoch:
            context?.authorityEpoch ??
            null,

          authorityEpoch:
            this.authorityEpoch
        };

        return;
      }

      const outputIndex =
        Number(
          message.meta?.outputIndex
        );

      if (
        !Number.isSafeInteger(
          outputIndex
        ) ||
        outputIndex < 1
      ) {
        throw Object.assign(
          new Error(
            'authoritative output is missing trusted output ordering'
          ),
          {
            code:
              'BIOLOGICAL_OUTBOX_ORDER'
          }
        );
      }

      const existing =
        unit.pendingOutputIntents.get(
          eventSequence
        ) ||
        [];

      if (
        existing.some(
          intent =>
            intent.outputIndex ===
            outputIndex
        )
      ) {
        throw Object.assign(
          new Error(
            'duplicate output index inside one authoritative transition'
          ),
          {
            code:
              'BIOLOGICAL_OUTBOX_ORDER'
          }
        );
      }

      existing.push({
        outputIndex,

        topic,

        payload:
          structuredClone(
            payload
          ),

        causeSequence:
          eventSequence,

        causalParent:
          context?.eventId ||
          null
      });

      unit.pendingOutputIntents.set(
        eventSequence,
        existing
      );

      /*
       * NO EventFabric publication here.
       *
       * The output is not authoritative until its
       * originating transition and durable intent commit.
       */
      return;
    }

    unit.suppressedOutputs +=
      1;

    if (
      unit ===
        this.candidate &&
      unit.evidence
    ) {
      unit.evidence.recordShadow({
        eventSequence,
        topic,
        payload,
        invariantOk:
          Boolean(
            context
          )
      });
    }
  }

  async installInitial(definition) {
    if (this.active) throw new Error('slot already has an active implementation');
    const existingAuthority = this.stateStore.getAuthority(this.coreId);
    if (existingAuthority && existingAuthority.version !== definition.manifest.version) {
      throw Object.assign(new Error(`persisted authority for ${this.coreId} is ${existingAuthority.version}, not ${definition.manifest.version}`), { code: 'AUTHORITY_VERSION_MISMATCH' });
    }
    const checkpoint = existingAuthority
      ? await this.stateStore.readAuthoritativeCheckpoint(this.coreId)
      : null;
    const instanceId = existingAuthority?.instanceId || crypto.randomUUID();
    const epoch = existingAuthority?.epoch || 1;
    const envelope = checkpoint
      ? { stateSchema: checkpoint.stateSchema, state: checkpoint.state }
      : { stateSchema: definition.manifest.stateSchema, state: {} };
    const unit = await this.buildUnit(definition, envelope, 'active', instanceId, epoch);
    const authority = existingAuthority || this.stateStore.setInitialAuthority({
      coreId: this.coreId,
      instanceId,
      version: definition.manifest.version,
      epoch,
      barrierSequence: 0
    });
    this.authorityEpoch = authority.epoch;
    this.cutoverBarrier = authority.barrierSequence || 0;
    this.active = unit;
    this.stateStore.registerBiologicalConsumer({
      consumerId: this.consumerId,
      coreId: this.coreId,
      topics: unit.manifest.inputs,
      required: true,
      authorityEpoch: this.authorityEpoch
    });
    await this.persistActive();
    await this.replayPendingBiologicalEvents();
    return unit;
  }

  async prepare(definition) {
    if (!this.active) throw new Error('cannot prepare upgrade without active core');
    if (this.candidate) throw new Error('candidate already prepared');
    assertUpgradeCompatible(this.active.manifest, definition.manifest);
    const state = await this.active.snapshot();
    const evidence = new ShadowEvidence({ sampleLimit: 128, activeWindow: 512 });
    this.candidate = await this.buildUnit(
      definition,
      { stateSchema: this.active.manifest.stateSchema, state },
      'shadow',
      crypto.randomUUID(),
      this.authorityEpoch,
      evidence
    );
    return this.candidate;
  }

  async dispatch(event) {
    if (event.ledger?.durable) {
      const delivery = this.stateStore.getBiologicalDelivery(this.consumerId, event.sequence);
      if (!delivery || delivery.status === 'ACKED') return { delivered: false, duplicate: Boolean(delivery), ignored: true };
    }
    if (this.cutover && event.sequence > this.cutover.barrierSequence) {
      const relevant = this.active?.manifest.inputs.includes(event.topic)
        || this.candidate?.manifest.inputs.includes(event.topic)
        || this.standby?.manifest.inputs.includes(event.topic);
      if (!relevant) return { delivered: false, ignored: true };
      if (this.cutover.held.length >= this.cutover.heldCapacity) {
        if (event.class === 'best-effort' || event.class === 'telemetry') {
          return { delivered: false, dropped: true, reason: 'cutover-capacity' };
        }
        throw Object.assign(new Error(`authority cutover queue capacity ${this.cutover.heldCapacity} exceeded`), {
          code: 'AUTHORITY_CUTOVER_OVERFLOW'
        });
      }
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      this.cutover.held.push({ event, resolve, reject });
      if (event.meta?.sourceInstanceId === this.active?.instanceId) {
        promise.catch(error => this.logger.warn?.(`[STAY] held recursive event ${event.sequence}: ${error.message}`));
        return { delivered: true, deferredRecursive: true, heldForCutover: true };
      }
      return promise;
    }
    if (!this.active || !this.active.manifest.inputs.includes(event.topic)) {
      if (this.candidate?.manifest.inputs.includes(event.topic)) this.enqueueCandidate(event);
      if (this.active && event.ledger?.durable) {
        this.stateStore.acknowledgeBiologicalEvent({
          consumerId: this.consumerId,
          sequence: event.sequence,
          transitionId: transitionId(this.consumerId, event)
        });
      }
      return { delivered: false, ignored: true };
    }
    const activePromise = this.active.queue.enqueue(event);
    if (this.candidate?.manifest.inputs.includes(event.topic)) this.enqueueCandidate(event);
    if (this.standby?.manifest.inputs.includes(event.topic)) {
      this.standby.queue.enqueue(event).catch(() => {});
    }
    if (event.meta?.sourceInstanceId === this.active.instanceId) {
      activePromise.catch(error => this.logger.warn?.(`[STAY] recursive event ${event.sequence}: ${error.message}`));
      return { delivered: true, deferredRecursive: true };
    }
    return activePromise;
  }

  enqueueCandidate(event) {
    const unit = this.candidate;
    if (!unit) return;
    unit.queue.enqueue(event).then(result => {
      if (result?.dropped && !['best-effort', 'telemetry'].includes(event.class)) {
        this.recordRequiredShadowFailure(unit, event, Object.assign(new Error('required shadow event was dropped'), { code: 'SHADOW_REQUIRED_DROP' }));
      }
    }).catch(error => {
      if (['critical', 'durable'].includes(event.class)) this.recordRequiredShadowFailure(unit, event, error);
      if (![
        'ACTOR_QUEUE_CLOSED',
        'COREHOST_EXIT',
        'SHADOW_CANDIDATE_FAILED'
      ].includes(error.code)) {
        this.logger.warn?.(`[STAY] shadow queue ${this.coreId}: ${error.message}`);
      }
    });
  }

  recordRequiredShadowFailure(unit, event, error) {
    const sequence = Number(event?.sequence) || 0;

    /*
     * The actor fault path and enqueue rejection path can observe the same
     * failed required event. It is one missing biological transition, not
     * two.
     */
    if (
      unit.lastShadowFailure &&
      Number(unit.lastShadowFailure.sequence) === sequence
    ) {
      return;
    }

    unit.shadowRequiredFailures += 1;
    unit.lastShadowFailure = {
      at: new Date().toISOString(),
      sequence,
      topic: event?.topic || null,
      code: error.code || null,
      message: error.message
    };
    unit.lifecycle = 'degraded';
  }

  async candidateHealth(minEvents = 1) {
    if (!this.candidate) throw new Error('no candidate prepared');

    if (this.candidate.shadowRequiredFailures > 0) {
      throw Object.assign(
        new Error(
          `candidate missed ${this.candidate.shadowRequiredFailures} required shadow events`
        ),
        {
          code: 'SHADOW_INCOMPLETE',
          detail: this.candidate.lastShadowFailure
        }
      );
    }

    await this.candidate.queue.drainThrough(this.fabric.sequence);

    /*
     * A required failure can appear while drainThrough is in flight.
     */
    if (this.candidate.shadowRequiredFailures > 0) {
      throw Object.assign(
        new Error(
          `candidate missed ${this.candidate.shadowRequiredFailures} required shadow events`
        ),
        {
          code: 'SHADOW_INCOMPLETE',
          detail: this.candidate.lastShadowFailure
        }
      );
    }
    const health = await this.candidate.health();
    if (health?.ok === false) throw new Error('candidate health check failed');
    if (this.candidate.handledEvents < minEvents) throw new Error('candidate has insufficient shadow evidence');
    return health;
  }

  async commit(minEvents = 1) {
    if (this.transitioning) throw Object.assign(new Error('authority transition already in progress'), { code: 'AUTHORITY_TRANSITION_BUSY' });
    this.transitioning = true;
    let transaction = null;
    let committed = false;
    const previous = this.active;
    const next = this.candidate;
    try {
      await this.candidateHealth(minEvents);
      await this.persistActive();
      const barrierSequence = this.fabric.sequence;
      this.cutover = {
        barrierSequence,
        held: [],
        heldCapacity: Math.max(previous.client.policy.queueCapacity, next.client.policy.queueCapacity)
      };
      await Promise.all([
        previous.queue.drainThrough(barrierSequence),
        next.queue.drainThrough(barrierSequence)
      ]);
      const nextEpoch = this.authorityEpoch + 1;
      const checkpoint = await this.persistUnit(next, nextEpoch, false);
      transaction = this.stateStore.prepareUpgrade({
        coreId: this.coreId,
        from: { instanceId: previous.instanceId, version: previous.manifest.version, epoch: this.authorityEpoch },
        to: { instanceId: next.instanceId, version: next.manifest.version, epoch: nextEpoch },
        barrierSequence,
        checkpoint,
        detail: { shadowEvidence: next.evidence?.summary() || null }
      });
      const authority = this.stateStore.commitUpgrade(transaction.transactionId);
      committed = true;
      this.authorityEpoch = authority.epoch;
      this.cutoverBarrier = authority.barrierSequence;
      previous.mode = 'standby';
      next.mode = 'active';
      previous.assignedEpoch = nextEpoch - 1;
      next.assignedEpoch = nextEpoch;
      this.active = next;
      this.candidate = null;
      this.stateStore.registerBiologicalConsumer({
        consumerId: this.consumerId,
        coreId: this.coreId,
        topics: next.manifest.inputs,
        required: true,
        authorityEpoch: this.authorityEpoch
      });
      const oldStandby = this.standby;
      this.standby = previous;
      this.releaseHeld(next);
      await Promise.all([next.client.setMode('active'), previous.client.setMode('standby')]);
      if (oldStandby) await oldStandby.stop();
      await this.persistActive();
      return { active: this.active.manifest, standby: this.standby.manifest, authority, transactionId: transaction.transactionId };
    } catch (error) {
      if (!committed) {
        if (transaction) this.stateStore.abortUpgrade(transaction.transactionId, error.code || error.message);
        this.releaseHeld(previous);
      } else if (this.cutover) {
        this.releaseHeld(this.active);
      }
      throw error;
    } finally {
      this.cutover = null;
      this.transitioning = false;
    }
  }

  async rollback() {
    if (!this.standby) throw new Error('no standby implementation available');
    if (this.transitioning) throw Object.assign(new Error('authority transition already in progress'), { code: 'AUTHORITY_TRANSITION_BUSY' });
    this.transitioning = true;
    const current = this.active;
    const previous = this.standby;
    let transaction = null;
    let committed = false;
    try {
      await this.persistActive();
      const barrierSequence = this.fabric.sequence;
      this.cutover = {
        barrierSequence,
        held: [],
        heldCapacity: Math.max(current.client.policy.queueCapacity, previous.client.policy.queueCapacity)
      };
      await Promise.all([
        current.queue.drainThrough(barrierSequence),
        previous.queue.drainThrough(barrierSequence)
      ]);
      const nextEpoch = this.authorityEpoch + 1;
      const checkpoint = await this.persistUnit(previous, nextEpoch, false);
      transaction = this.stateStore.prepareUpgrade({
        coreId: this.coreId,
        from: { instanceId: current.instanceId, version: current.manifest.version, epoch: this.authorityEpoch },
        to: { instanceId: previous.instanceId, version: previous.manifest.version, epoch: nextEpoch },
        barrierSequence,
        checkpoint,
        detail: { rollback: true }
      });
      const authority = this.stateStore.commitUpgrade(transaction.transactionId);
      committed = true;
      this.authorityEpoch = authority.epoch;
      this.cutoverBarrier = authority.barrierSequence;
      current.mode = 'standby';
      previous.mode = 'active';
      current.assignedEpoch = nextEpoch - 1;
      previous.assignedEpoch = nextEpoch;
      this.active = previous;
      this.standby = current;
      this.stateStore.registerBiologicalConsumer({
        consumerId: this.consumerId,
        coreId: this.coreId,
        topics: previous.manifest.inputs,
        required: true,
        authorityEpoch: this.authorityEpoch
      });
      this.releaseHeld(previous);
      await Promise.all([previous.client.setMode('active'), current.client.setMode('standby')]);
      await this.persistActive();
      return { active: this.active.manifest, standby: this.standby.manifest, authority, transactionId: transaction.transactionId };
    } catch (error) {
      if (!committed) {
        if (transaction) this.stateStore.abortUpgrade(transaction.transactionId, error.code || error.message);
        this.releaseHeld(current);
      } else if (this.cutover) this.releaseHeld(this.active);
      throw error;
    } finally {
      this.cutover = null;
      this.transitioning = false;
    }
  }

  releaseHeld(unit) {
    const cutover = this.cutover;
    if (!cutover) return;
    this.cutover = null;
    for (const held of cutover.held) {
      if (!unit?.manifest.inputs.includes(held.event.topic)) {
        held.resolve({ delivered: false, ignored: true });
        continue;
      }
      unit.queue.enqueue(held.event).then(held.resolve, held.reject);
    }
  }

  async abort() {
    if (!this.candidate) return;
    await this.candidate.stop();
    this.candidate = null;
  }

  async persistActive() {
    if (!this.active) return null;
    return this.persistUnit(this.active, this.authorityEpoch, true);
  }

  async drainProducerOutbox(
    limit = 256
  ) {
    let drained =
      0;

    for (;;) {
      const intents =
        this.stateStore
          .listPendingBiologicalOutboxIntents({
            producerCoreId:
              this.coreId,

            limit
          });

      if (
        intents.length ===
        0
      ) {
        return drained;
      }

      for (
        const intent
        of intents
      ) {
        const event =
          await this.fabric.publish(
            intent.topic,
            intent.payload,
            intent.publishMeta
          );

        this.stateStore
          .markBiologicalOutboxPublished({
            producerEventId:
              intent.producerEventId,

            event
          });

        drained +=
          1;
      }

      if (
        intents.length <
        limit
      ) {
        return drained;
      }
    }
  }

  async tryDrainProducerOutbox() {
    try {
      return await this
        .drainProducerOutbox();

    } catch (error) {
      this.stateStore.recordRecovery(
        'biological.outbox-drain-failed',
        this.coreId,
        {
          code:
            error.code ||
            null,

          message:
            error.message
        }
      );

      this.logger.warn?.(
        `[STAY] durable producer outbox for ${this.coreId} remains pending: ${error.message}`
      );

      /*
       * Originating state already committed.
       *
       * Transport failure delays the obligation;
       * it may never roll the transition back.
       */
      return 0;
    }
  }

  async replayPendingBiologicalEvents() {
    let replayed =
      0;

    for (;;) {
      const events =
        this.stateStore
          .listPendingBiologicalEvents(
            this.consumerId,
            256
          );

      if (!events.length) {
        return replayed;
      }

      for (
        const event
        of events
      ) {
        const result =
          await this.dispatch(
            event
          );

        if (
          result?.deferredRecursive
        ) {
          await this.active?.queue
            .drainThrough(
              event.sequence
            );
        }

        replayed +=
          1;
      }
    }
  }

  async persistUnit(
    unit,
    authorityEpoch,
    updateAuthority,
    transition = null
  ) {
    const state =
      transition &&
      transition.state != null
        ? transition.state
        : await unit.snapshot();

    const bytes =
      serializedSize(
        state
      );

    if (
      bytes >
      unit.client.policy.storageBytes
    ) {
      throw Object.assign(
        new Error(
          `core checkpoint exceeds ${unit.client.policy.storageBytes} byte budget`
        ),
        {
          code:
            'CORE_STORAGE_BUDGET'
        }
      );
    }

    const checkpoint =
      await this.stateStore
        .commitCheckpoint({
          coreId:
            this.coreId,

          instanceId:
            unit.instanceId,

          version:
            unit.manifest.version,

          authorityEpoch,

          stateSchema:
            unit.manifest.stateSchema,

          state,

          updateAuthority,

          consumerAck:
            transition?.event?.ledger?.durable
              ? {
                  consumerId:
                    this.consumerId,

                  sequence:
                    transition.event.sequence,

                  transitionId:
                    transition.transitionId
                }
              : null,

          producerTransitionId:
            transition?.transitionId ||
            null,

          outboxIntents:
            transition?.outboxIntents ||
            []
        });

    unit.client.setRecoveryState(
      state,
      unit.manifest.stateSchema
    );

    return checkpoint;
  }

  async describe(unit) {
    if (!unit) return null;
    let health;
    try { health = await unit.health(); }
    catch (error) { health = { ok: false, code: error.code || null, message: error.message }; }
    return {
      manifest: unit.manifest,
      instanceId: unit.instanceId,
      authorityEpoch: unit.assignedEpoch,
      mode: unit.mode,
      lifecycle: unit.lifecycle,
      handledEvents: unit.handledEvents,
      authoritativeOutputs: unit.authoritativeOutputs,
      suppressedOutputs: unit.suppressedOutputs,
      staleOutputs: unit.staleOutputs,
      shadowCompleteness: {
        requiredFailures: unit.shadowRequiredFailures,
        lastFailure: unit.lastShadowFailure
      },
      queue: unit.queue.snapshotMetrics(),
      evidence: unit.evidence?.summary() || null,
      host: unit.client.status(),
      health
    };
  }

  async status() {
    return {
      coreId: this.coreId,
      authorityEpoch: this.authorityEpoch,
      cutoverBarrier: this.cutoverBarrier,
      lastAuthorityError: this.lastAuthorityError,
      active: await this.describe(this.active),
      candidate: await this.describe(this.candidate),
      standby: await this.describe(this.standby)
    };
  }

  async stop() {
    this.unsubscribe?.();
    for (const unit of [this.active, this.candidate, this.standby].filter(Boolean)) await unit.stop();
  }
}

module.exports = { RuntimeSlot, HostedUnit };
