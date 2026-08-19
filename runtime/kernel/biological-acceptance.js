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
    allocateFabricSequence
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

    this.allocateFabricSequence =
      requireFunction(
        allocateFabricSequence,
        'allocateFabricSequence'
      );

    /*
     * Prepared acceptances are capabilities minted only by
     * this exact trusted boundary instance. A caller cannot
     * fabricate one merely by recreating its object shape.
     */
    this.preparedAcceptances =
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

    return acceptEnvelope(
      prepared.proposal,
      {
        ...prepared.kernel,

        fabric_sequence:
          fabricSequence
      }
    );
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
