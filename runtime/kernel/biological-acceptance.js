'use strict';

const crypto =
  require('node:crypto');

const {
  stableStringify
} =
  require('./canonical-json');

const {
  acceptEnvelope,
  normalizeAcceptedEnvelope,
  AUTHORITY_MODE
} =
  require('./biological-envelope');


function fail(
  message,
  code
) {
  throw Object.assign(
    new Error(message),
    { code }
  );
}


function hash(
  value
) {
  return (
    'sha256:' +
    crypto
      .createHash('sha256')
      .update(
        stableStringify(value)
      )
      .digest('hex')
  );
}


function digestSourceRange(
  envelopes
) {
  if (
    !Array.isArray(envelopes) ||
    envelopes.length < 1
  ) {
    fail(
      'source range is empty',
      'BIOLOGICAL_ACCEPTANCE_RANGE'
    );
  }

  return hash(
    envelopes.map(
      envelope => ({
        signal_id:
          envelope.signal_id,

        producer_stream_id:
          envelope.producer_stream_id,

        authority_epoch:
          envelope.authority_epoch,

        stream_sequence:
          envelope.stream_sequence,

        order_time_us:
          envelope.order_time_us
      })
    )
  );
}


function requireFunction(
  value,
  label
) {
  if (
    typeof value !== 'function'
  ) {
    fail(
      `${label} is required`,
      'BIOLOGICAL_ACCEPTANCE_CONFIGURATION'
    );
  }

  return value;
}


function assertTrustedTime(
  snapshot
) {
  if (
    !snapshot ||
    snapshot.status !== 'TRUSTED' ||
    !Number.isSafeInteger(
      snapshot.trustedTimeUs
    ) ||
    snapshot.trustedTimeUs < 0
  ) {
    fail(
      'Trusted Organism Time is not authoritative',
      'BIOLOGICAL_ACCEPTANCE_TIME_UNCERTAIN'
    );
  }

  return snapshot.trustedTimeUs;
}


function authorityMode(
  value
) {
  if (
    !Object.values(
      AUTHORITY_MODE
    ).includes(value)
  ) {
    fail(
      'resolved producer authority mode is invalid',
      'BIOLOGICAL_ACCEPTANCE_PRODUCER'
    );
  }

  return value;
}


function validateProducer(
  value
) {
  if (
    !value ||
    typeof value !== 'object'
  ) {
    fail(
      'producer is not registered with Kernel authority',
      'BIOLOGICAL_ACCEPTANCE_PRODUCER'
    );
  }

  for (const field of [
    'coreId',
    'instanceId',
    'version'
  ]) {
    if (
      typeof value[field] !== 'string' ||
      !value[field]
    ) {
      fail(
        `resolved producer ${field} is invalid`,
        'BIOLOGICAL_ACCEPTANCE_PRODUCER'
      );
    }
  }

  if (
    !Number.isSafeInteger(
      value.authorityEpoch
    ) ||
    value.authorityEpoch < 1
  ) {
    fail(
      'resolved producer authority epoch is invalid',
      'BIOLOGICAL_ACCEPTANCE_PRODUCER'
    );
  }

  return {
    coreId:
      value.coreId,

    instanceId:
      value.instanceId,

    version:
      value.version,

    authorityEpoch:
      value.authorityEpoch,

    authorityMode:
      authorityMode(
        value.authorityMode
      )
  };
}


function rootSetFromEvidence(
  evidence
) {
  const roots =
    new Set();

  const inheritedOverflow =
    new Set();

  for (
    const envelope of evidence
  ) {
    if (
      envelope.causal_roots.length > 0
    ) {
      for (
        const root of
          envelope.causal_roots
      ) {
        roots.add(root);
      }
    } else {
      roots.add(
        envelope.signal_id
      );
    }

    /*
     * A compacted ancestor may already represent roots
     * that no longer fit in its explicit four-root budget.
     * Descendants must commit to that hidden ancestry too.
     */
    if (
      envelope.roots_overflow_digest
    ) {
      inheritedOverflow.add(
        envelope.roots_overflow_digest
      );
    }
  }

  const sorted =
    [...roots].sort();

  const explicit =
    sorted.slice(0, 4);

  const overflowMaterial = [
    ...sorted.slice(4),
    ...[...inheritedOverflow].sort()
  ];

  return {
    causalRoots:
      explicit,

    rootsOverflowDigest:
      overflowMaterial.length > 0
        ? hash(
            overflowMaterial
          )
        : null
  };
}


function lineageDigest(
  evidence
) {
  if (
    evidence.length === 0
  ) {
    return null;
  }

  /*
   * Commit not merely to immediate parent identities,
   * but also to ancestry commitments inherited from them.
   * This prevents repeated derivation/compaction from
   * silently forgetting older causal history.
   */
  return hash(
    evidence
      .map(
        envelope => ({
          signal_id:
            envelope.signal_id,

          lineage_digest:
            envelope.lineage_digest,

          roots_overflow_digest:
            envelope.roots_overflow_digest
        })
      )
      .sort(
        (a, b) =>
          a.signal_id.localeCompare(
            b.signal_id
          )
      )
  );
}


class BiologicalAcceptanceBoundary {
  constructor({
    organismId,
    trustedTime,
    resolveProducer,
    resolveSignal,
    resolveStreamRange,
    resolveProducerEvent = null,
    allocateFabricSequence,
    bsfPolicy = null
  }) {
    if (
      typeof organismId !== 'string' ||
      !organismId
    ) {
      fail(
        'organismId is required',
        'BIOLOGICAL_ACCEPTANCE_CONFIGURATION'
      );
    }

    if (
      !trustedTime ||
      typeof trustedTime.sample !==
        'function'
    ) {
      fail(
        'Trusted Organism Time is required',
        'BIOLOGICAL_ACCEPTANCE_CONFIGURATION'
      );
    }

    this.organismId =
      organismId;

    this.trustedTime =
      trustedTime;

    this.resolveProducer =
      requireFunction(
        resolveProducer,
        'resolveProducer'
      );

    this.resolveSignal =
      requireFunction(
        resolveSignal,
        'resolveSignal'
      );

    this.resolveStreamRange =
      requireFunction(
        resolveStreamRange,
        'resolveStreamRange'
      );

    /*
     * Optional EF1-E retry resolver. Existing callers remain
     * compatible, while StateStore-backed acceptance can short-
     * circuit an already accepted producer_event_id before causal
     * evidence is re-resolved. This matters after safe compaction:
     * retry acknowledgement must not depend on retained parent rows.
     */
    this.resolveProducerEvent =
      resolveProducerEvent == null
        ? async () => null
        : requireFunction(
            resolveProducerEvent,
            'resolveProducerEvent'
          );

    this.allocateFabricSequence =
      requireFunction(
        allocateFabricSequence,
        'allocateFabricSequence'
      );

    if (
      bsfPolicy != null &&
      (
        typeof bsfPolicy !== 'object' ||
        typeof bsfPolicy.validateProposal !== 'function' ||
        typeof bsfPolicy.validateStreamProgress !== 'function'
      )
    ) {
      fail(
        'bsfPolicy must expose validateProposal and validateStreamProgress',
        'BIOLOGICAL_ACCEPTANCE_CONFIGURATION'
      );
    }

    this.bsfPolicy =
      bsfPolicy;

    /*
     * Prepared acceptances are capabilities minted only by
     * this exact trusted boundary instance. A caller cannot
     * fabricate one merely by recreating its object shape.
     */
    this.preparedAcceptances =
      new WeakSet();

    /*
     * Stream-progress declarations use the same
     * unforgeable prepared-capability pattern as Envelope v2.
     */
    this.preparedStreamProgress =
      new WeakSet();
  }


  validateEvidenceEnvelope(
    envelope
  ) {
    const normalized =
      normalizeAcceptedEnvelope(
        envelope
      );

    if (
      normalized.organism_id !==
      this.organismId
    ) {
      fail(
        'causal evidence belongs to another organism',
        'BIOLOGICAL_ACCEPTANCE_ORGANISM_MISMATCH'
      );
    }

    return normalized;
  }


  enforceAuthorityTaint(
    producer,
    evidence
  ) {
    if (
      producer.authorityMode !==
      AUTHORITY_MODE.AUTHORITATIVE
    ) {
      return;
    }

    for (
      const envelope of evidence
    ) {
      if (
        envelope.authority_mode !==
        AUTHORITY_MODE.AUTHORITATIVE
      ) {
        fail(
          'authoritative output cannot derive from non-authoritative evidence',
          'BIOLOGICAL_ACCEPTANCE_AUTHORITY_LAUNDERING'
        );
      }
    }
  }


  enforceNoCycle(
    producer,
    evidence
  ) {
    for (
      const envelope of evidence
    ) {
      if (
        envelope.producer_core_id ===
          producer.coreId ||
        envelope.ancestor_core_set.includes(
          producer.coreId
        )
      ) {
        fail(
          'producer would re-enter its own causal lineage',
          'BIOLOGICAL_ACCEPTANCE_CAUSAL_CYCLE'
        );
      }
    }
  }


  async resolveParents(
    parentIds
  ) {
    const evidence =
      [];

    for (
      const signalId of
        parentIds
    ) {
      const found =
        await this.resolveSignal(
          signalId
        );

      if (!found) {
        fail(
          `causal parent ${signalId} is unavailable`,
          'BIOLOGICAL_ACCEPTANCE_EVIDENCE_GAP'
        );
      }

      const normalized =
        this.validateEvidenceEnvelope(
          found
        );

      if (
        normalized.signal_id !==
        signalId
      ) {
        fail(
          'resolved parent identity mismatch',
          'BIOLOGICAL_ACCEPTANCE_EVIDENCE_GAP'
        );
      }

      evidence.push(
        normalized
      );
    }

    return evidence;
  }


  async resolveSpans(
    spans
  ) {
    const evidence =
      [];

    for (
      const span of spans
    ) {
      const members =
        await this.resolveStreamRange({
          producerStreamId:
            span.producer_stream_id,

          authorityEpoch:
            span.authority_epoch,

          firstSequence:
            span.first_sequence,

          lastSequence:
            span.last_sequence
        });

      if (
        !Array.isArray(members) ||
        members.length !==
          span.source_count
      ) {
        fail(
          'causal source span is incomplete',
          'BIOLOGICAL_ACCEPTANCE_EVIDENCE_GAP'
        );
      }

      const normalized =
        members.map(
          member =>
            this.validateEvidenceEnvelope(
              member
            )
        );

      for (
        let index = 0;
        index < normalized.length;
        index += 1
      ) {
        const expectedSequence =
          span.first_sequence +
          index;

        const member =
          normalized[index];

        if (
          member.producer_stream_id !==
            span.producer_stream_id ||
          member.authority_epoch !==
            span.authority_epoch ||
          member.stream_sequence !==
            expectedSequence
        ) {
          fail(
            'causal source span is not one contiguous validated stream range',
            'BIOLOGICAL_ACCEPTANCE_EVIDENCE_GAP'
          );
        }
      }

      const maxOrderTime =
        Math.max(
          ...normalized.map(
            member =>
              member.order_time_us
          )
        );

      if (
        maxOrderTime !==
        span.max_order_time_us
      ) {
        fail(
          'causal source span max order time is false',
          'BIOLOGICAL_ACCEPTANCE_RANGE_DIGEST'
        );
      }

      if (
        digestSourceRange(
          normalized
        ) !==
        span.range_digest
      ) {
        fail(
          'causal source range digest mismatch',
          'BIOLOGICAL_ACCEPTANCE_RANGE_DIGEST'
        );
      }

      evidence.push(
        ...normalized
      );
    }

    return evidence;
  }


  async prepare({
    producerHandle,
    proposal
  }) {
    /*
     * The producer handle itself carries no biological
     * authority. The trusted Kernel resolver owns the
     * identity and authority decision.
     */
    const producer =
      validateProducer(
        await this.resolveProducer(
          producerHandle
        )
      );

    if (
      this.bsfPolicy
    ) {
      await this.bsfPolicy.validateProposal({
        producer:
          Object.freeze({ ...producer }),
        proposal,
        organismId:
          this.organismId
      });
    }

    /*
     * EF1-E retry fast path.
     *
     * A durable previously accepted producer_event_id is already
     * evidence that its causal inputs were validated at original
     * acceptance. Exact retry therefore authenticates the proposal
     * against that immutable accepted envelope BEFORE trying to
     * resolve historical parents/spans again. This preserves P0.29
     * after legitimate evidence compaction.
     *
     * Changed content cannot use this path: reconstructing the
     * envelope with the historical Kernel facts changes signal_id
     * and fails closed.
     */
    const retryCandidate =
      typeof proposal?.producer_event_id ===
        'string' &&
      proposal.producer_event_id
        ? await this.resolveProducerEvent({
            organismId:
              this.organismId,

            producerCoreId:
              producer.coreId,

            producerEventId:
              proposal.producer_event_id
          })
        : null;

    if (
      retryCandidate
    ) {
      const existing =
        this.validateEvidenceEnvelope(
          retryCandidate
        );

      if (
        existing.producer_core_id !==
          producer.coreId ||
        existing.producer_instance_id !==
          producer.instanceId ||
        existing.producer_version !==
          producer.version ||
        existing.authority_epoch !==
          producer.authorityEpoch ||
        existing.authority_mode !==
          producer.authorityMode
      ) {
        fail(
          'producer event retry does not match the accepted producer authority',
          'BIOLOGICAL_PRODUCER_EVENT_CONFLICT'
        );
      }

      const retryEnvelope =
        acceptEnvelope(
          proposal,
          {
            organism_id:
              existing.organism_id,

            producer_core_id:
              existing.producer_core_id,

            producer_instance_id:
              existing.producer_instance_id,

            producer_version:
              existing.producer_version,

            authority_epoch:
              existing.authority_epoch,

            authority_mode:
              existing.authority_mode,

            accepted_time_us:
              existing.accepted_time_us,

            fabric_sequence:
              existing.fabric_sequence,

            causal_roots:
              existing.causal_roots,

            causal_generation:
              existing.causal_generation,

            roots_overflow_digest:
              existing.roots_overflow_digest,

            lineage_digest:
              existing.lineage_digest,

            ancestor_core_set:
              existing.ancestor_core_set,

            causality_validated:
              existing.direct_parents.length > 0 ||
              existing.causal_source_spans.length > 0,

            /*
             * The original exact envelope proves its own causal
             * precedence. Using its order time as the retry ceiling
             * cannot authorize an earlier child; any changed temporal
             * proposal also changes signal identity below.
             */
            max_causal_order_time_us:
              existing.direct_parents.length > 0 ||
              existing.causal_source_spans.length > 0
                ? existing.order_time_us
                : 0
          }
        );

      if (
        retryEnvelope.signal_id !==
          existing.signal_id
      ) {
        fail(
          'producer event identity was reused for different biological content',
          'BIOLOGICAL_PRODUCER_EVENT_CONFLICT'
        );
      }

      const preparedRetry =
        Object.freeze({
          proposal:
            Object.freeze({
              producer_event_id:
                retryEnvelope.producer_event_id,

              producer_stream_id:
                retryEnvelope.producer_stream_id,

              stream_sequence:
                retryEnvelope.stream_sequence,

              topic:
                retryEnvelope.topic,

              signal_class:
                retryEnvelope.signal_class,

              schema_version:
                retryEnvelope.schema_version,

              temporal:
                retryEnvelope.temporal,

              valid_from_us:
                retryEnvelope.valid_from_us,

              expires_at_us:
                retryEnvelope.expires_at_us,

              durability_class:
                retryEnvelope.durability_class,

              payload:
                retryEnvelope.payload,

              direct_parents:
                retryEnvelope.direct_parents,

              causal_source_spans:
                retryEnvelope.causal_source_spans
            }),

          kernel:
            Object.freeze({
              organism_id:
                retryEnvelope.organism_id,

              producer_core_id:
                retryEnvelope.producer_core_id,

              producer_instance_id:
                retryEnvelope.producer_instance_id,

              producer_version:
                retryEnvelope.producer_version,

              authority_epoch:
                retryEnvelope.authority_epoch,

              authority_mode:
                retryEnvelope.authority_mode,

              accepted_time_us:
                retryEnvelope.accepted_time_us,

              causal_roots:
                retryEnvelope.causal_roots,

              causal_generation:
                retryEnvelope.causal_generation,

              roots_overflow_digest:
                retryEnvelope.roots_overflow_digest,

              lineage_digest:
                retryEnvelope.lineage_digest,

              ancestor_core_set:
                retryEnvelope.ancestor_core_set,

              causality_validated:
                retryEnvelope.direct_parents.length > 0 ||
                retryEnvelope.causal_source_spans.length > 0,

              max_causal_order_time_us:
                retryEnvelope.order_time_us
            }),

          existingAccepted:
            existing
        });

      this.preparedAcceptances.add(
        preparedRetry
      );

      return preparedRetry;
    }

    /*
     * Resolve and validate every causal input before
     * biological sequence identity exists.
     */
    const directEvidence =
      await this.resolveParents(
        proposal?.direct_parents ||
        []
      );

    const spanEvidence =
      await this.resolveSpans(
        proposal?.causal_source_spans ||
        []
      );

    const evidenceById =
      new Map();

    for (
      const envelope of [
        ...directEvidence,
        ...spanEvidence
      ]
    ) {
      evidenceById.set(
        envelope.signal_id,
        envelope
      );
    }

    const evidence =
      [...evidenceById.values()];

    this.enforceAuthorityTaint(
      producer,
      evidence
    );

    this.enforceNoCycle(
      producer,
      evidence
    );

    const {
      causalRoots,
      rootsOverflowDigest
    } =
      rootSetFromEvidence(
        evidence
      );

    const causalGeneration =
      evidence.length > 0
        ? (
            Math.max(
              ...evidence.map(
                envelope =>
                  envelope.causal_generation
              )
            ) + 1
          )
        : 0;

    const ancestorCoreSet =
      [
        ...new Set(
          evidence.flatMap(
            envelope => [
              envelope.producer_core_id,
              ...envelope.ancestor_core_set
            ]
          )
        )
      ].sort();

    const maxCausalOrderTimeUs =
      evidence.length > 0
        ? Math.max(
            ...evidence.map(
              envelope =>
                envelope.order_time_us
            )
          )
        : 0;

    const acceptedTimeUs =
      assertTrustedTime(
        await this.trustedTime.sample()
      );

    const kernelBase = {
      organism_id:
        this.organismId,

      producer_core_id:
        producer.coreId,

      producer_instance_id:
        producer.instanceId,

      producer_version:
        producer.version,

      authority_epoch:
        producer.authorityEpoch,

      authority_mode:
        producer.authorityMode,

      accepted_time_us:
        acceptedTimeUs,

      causal_roots:
        causalRoots,

      causal_generation:
        causalGeneration,

      roots_overflow_digest:
        rootsOverflowDigest,

      lineage_digest:
        lineageDigest(
          evidence
        ),

      ancestor_core_set:
        ancestorCoreSet,

      causality_validated:
        evidence.length > 0,

      max_causal_order_time_us:
        maxCausalOrderTimeUs
    };

    /*
     * Validate and canonicalize the full proposal NOW,
     * before any durable fabric sequence is allocated.
     *
     * Sequence 1 is a disposable structural-validation
     * value only. The resulting signal identity is never
     * exposed or persisted.
     */
    const validated =
      acceptEnvelope(
        proposal,
        {
          ...kernelBase,
          fabric_sequence:
            1
        }
      );

    const canonicalProposal =
      Object.freeze({
        producer_event_id:
          validated.producer_event_id,

        producer_stream_id:
          validated.producer_stream_id,

        stream_sequence:
          validated.stream_sequence,

        topic:
          validated.topic,

        signal_class:
          validated.signal_class,

        schema_version:
          validated.schema_version,

        temporal:
          validated.temporal,

        valid_from_us:
          validated.valid_from_us,

        expires_at_us:
          validated.expires_at_us,

        durability_class:
          validated.durability_class,

        payload:
          validated.payload,

        direct_parents:
          validated.direct_parents,

        causal_source_spans:
          validated.causal_source_spans
      });

    const canonicalKernel =
      Object.freeze({
        organism_id:
          validated.organism_id,

        producer_core_id:
          validated.producer_core_id,

        producer_instance_id:
          validated.producer_instance_id,

        producer_version:
          validated.producer_version,

        authority_epoch:
          validated.authority_epoch,

        authority_mode:
          validated.authority_mode,

        accepted_time_us:
          validated.accepted_time_us,

        causal_roots:
          validated.causal_roots,

        causal_generation:
          validated.causal_generation,

        roots_overflow_digest:
          validated.roots_overflow_digest,

        lineage_digest:
          validated.lineage_digest,

        ancestor_core_set:
          validated.ancestor_core_set,

        causality_validated:
          evidence.length > 0,

        max_causal_order_time_us:
          maxCausalOrderTimeUs
      });

    const prepared =
      Object.freeze({
        proposal:
          canonicalProposal,

        kernel:
          canonicalKernel
      });

    this.preparedAcceptances.add(
      prepared
    );

    return prepared;
  }


  finalizePrepared(
    prepared,
    fabricSequence
  ) {
    if (
      !prepared ||
      typeof prepared !== 'object' ||
      !this.preparedAcceptances.has(
        prepared
      )
    ) {
      fail(
        'prepared biological acceptance was not minted by this Kernel boundary',
        'BIOLOGICAL_ACCEPTANCE_PREPARED'
      );
    }

    if (
      !Number.isSafeInteger(
        fabricSequence
      ) ||
      fabricSequence < 1
    ) {
      fail(
        'Kernel fabric sequence is invalid',
        'BIOLOGICAL_ACCEPTANCE_SEQUENCE'
      );
    }

    if (
      prepared.existingAccepted
    ) {
      if (
        fabricSequence !==
          prepared.existingAccepted.fabric_sequence
      ) {
        fail(
          'idempotent retry must finalize at its original Fabric sequence',
          'BIOLOGICAL_PRODUCER_EVENT_CONFLICT'
        );
      }

      return prepared.existingAccepted;
    }

    return acceptEnvelope(
      prepared.proposal,
      {
        ...prepared.kernel,

        fabric_sequence:
          fabricSequence
      }
    );
  }



  async prepareStreamProgress({
    producerHandle,
    progress
  }) {
    const producer =
      validateProducer(
        await this.resolveProducer(
          producerHandle
        )
      );

    if (
      this.bsfPolicy
    ) {
      await this.bsfPolicy.validateStreamProgress({
        producer:
          Object.freeze({ ...producer }),
        progress,
        organismId:
          this.organismId
      });
    }

    if (
      !progress ||
      typeof progress !==
        'object' ||
      Array.isArray(
        progress
      )
    ) {
      fail(
        'stream progress must be an object',
        'BIOLOGICAL_STREAM_PROGRESS_INVALID'
      );
    }

    const allowed =
      new Set([
        'producer_stream_id',
        'finalized_through_us'
      ]);

    for (
      const key of
      Object.keys(
        progress
      )
    ) {
      if (
        !allowed.has(
          key
        )
      ) {
        fail(
          `stream progress contains unknown field ${key}`,
          'BIOLOGICAL_STREAM_PROGRESS_INVALID'
        );
      }
    }

    if (
      typeof progress.producer_stream_id !==
        'string' ||
      !progress.producer_stream_id ||
      progress.producer_stream_id.length >
        200
    ) {
      fail(
        'stream progress producer_stream_id is invalid',
        'BIOLOGICAL_STREAM_PROGRESS_INVALID'
      );
    }

    const finalizedThroughUs =
      Number(
        progress.finalized_through_us
      );

    if (
      !Number.isSafeInteger(
        finalizedThroughUs
      ) ||
      finalizedThroughUs <
        0
    ) {
      fail(
        'stream progress finalized_through_us is invalid',
        'BIOLOGICAL_STREAM_PROGRESS_INVALID'
      );
    }

    const acceptedTimeUs =
      assertTrustedTime(
        await this.trustedTime.sample()
      );

    if (
      finalizedThroughUs >
        acceptedTimeUs
    ) {
      fail(
        'stream progress cannot finalize future organism time',
        'BIOLOGICAL_STREAM_PROGRESS_FUTURE'
      );
    }

    const prepared =
      Object.freeze({
        protocol:
          'stay-biological-stream-progress-prepared-v1',

        producer_stream_id:
          progress.producer_stream_id,

        finalized_through_us:
          finalizedThroughUs,

        kernel:
          Object.freeze({
            organism_id:
              this.organismId,

            producer_core_id:
              producer.coreId,

            producer_instance_id:
              producer.instanceId,

            producer_version:
              producer.version,

            authority_epoch:
              producer.authorityEpoch,

            authority_mode:
              producer.authorityMode,

            accepted_time_us:
              acceptedTimeUs
          })
      });

    this.preparedStreamProgress.add(
      prepared
    );

    return prepared;
  }


  finalizePreparedStreamProgress(
    prepared
  ) {
    if (
      !prepared ||
      typeof prepared !==
        'object' ||
      !this.preparedStreamProgress.has(
        prepared
      )
    ) {
      fail(
        'prepared stream progress was not minted by this Kernel boundary',
        'BIOLOGICAL_STREAM_PROGRESS_PREPARED'
      );
    }

    return Object.freeze({
      protocol:
        'stay-biological-stream-progress-v1',

      producer_stream_id:
        prepared.producer_stream_id,

      finalized_through_us:
        prepared.finalized_through_us,

      organism_id:
        prepared.kernel.organism_id,

      producer_core_id:
        prepared.kernel.producer_core_id,

      producer_instance_id:
        prepared.kernel.producer_instance_id,

      producer_version:
        prepared.kernel.producer_version,

      authority_epoch:
        prepared.kernel.authority_epoch,

      authority_mode:
        prepared.kernel.authority_mode,

      accepted_time_us:
        prepared.kernel.accepted_time_us
    });
  }


  async accept({
    producerHandle,
    proposal
  }) {
    const prepared =
      await this.prepare({
        producerHandle,
        proposal
      });

    /*
     * The compatibility convenience path remains for
     * isolated tests. B2B2 will instead hand PREPARED
     * acceptance to StateStore so sequence assignment
     * and durable append become one transaction.
     */
    const fabricSequence =
      await this.allocateFabricSequence();

    return this.finalizePrepared(
      prepared,
      fabricSequence
    );
  }

}


module.exports = {
  BiologicalAcceptanceBoundary,
  digestSourceRange
};
