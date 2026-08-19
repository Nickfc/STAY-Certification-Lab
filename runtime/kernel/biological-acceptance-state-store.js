'use strict';


function fail(
  message,
  code
) {
  throw Object.assign(
    new Error(message),
    {
      code
    }
  );
}


function requireStateStore(
  stateStore
) {
  if (
    !stateStore ||
    typeof stateStore !==
      'object'
  ) {
    fail(
      'StateStore is required for biological evidence resolution',
      'BIOLOGICAL_ACCEPTANCE_STATESTORE_CONFIG'
    );
  }

  for (
    const method of [
      'getAcceptedBiologicalEnvelope',
      'listAcceptedBiologicalStreamRange'
    ]
  ) {
    if (
      typeof stateStore[method] !==
      'function'
    ) {
      fail(
        `StateStore biological evidence method is missing: ${method}`,
        'BIOLOGICAL_ACCEPTANCE_STATESTORE_CONFIG'
      );
    }
  }

  return stateStore;
}


function normalizeSignalId(
  value
) {
  if (
    typeof value ===
    'string'
  ) {
    return value;
  }

  if (
    value &&
    typeof value ===
      'object'
  ) {
    return (
      value.signal_id ??
      value.signalId ??
      null
    );
  }

  return null;
}


function normalizeRange(
  args
) {
  if (
    args.length === 1 &&
    args[0] &&
    typeof args[0] ===
      'object'
  ) {
    const input =
      args[0];

    return {
      producerStreamId:
        input.producer_stream_id ??
        input.producerStreamId,

      authorityEpoch:
        input.authority_epoch ??
        input.authorityEpoch,

      firstSequence:
        input.first_sequence ??
        input.firstSequence,

      lastSequence:
        input.last_sequence ??
        input.lastSequence
    };
  }

  return {
    producerStreamId:
      args[0],

    authorityEpoch:
      args[1],

    firstSequence:
      args[2],

    lastSequence:
      args[3]
  };
}


function createStateStoreBiologicalEvidenceResolvers({
  stateStore
}) {
  const store =
    requireStateStore(
      stateStore
    );

  /*
   * Missing accepted evidence deliberately returns null.
   * BiologicalAcceptanceBoundary owns the semantic decision
   * that a required missing parent is EVIDENCE_GAP.
   *
   * Integrity/schema failures are NOT converted to absence.
   * They propagate and fail closed.
   */
  const resolveSignal =
    async value => {
      const signalId =
        normalizeSignalId(
          value
        );

      if (
        typeof signalId !==
          'string' ||
        !signalId
      ) {
        fail(
          'biological evidence signal id is invalid',
          'BIOLOGICAL_ACCEPTANCE_STATESTORE_SIGNAL'
        );
      }

      return store
        .getAcceptedBiologicalEnvelope(
          signalId
        );
    };


  /*
   * B2A's resolver contract is intentionally injected.
   * Accept both the canonical span-object form and the
   * positional form so the durable adapter is not coupled
   * to an incidental call shape inside the acceptance class.
   */
  const resolveStreamRange =
    async (...args) => {
      const range =
        normalizeRange(
          args
        );

      if (
        typeof range.producerStreamId !==
          'string' ||
        !range.producerStreamId
      ) {
        fail(
          'biological evidence producer stream is invalid',
          'BIOLOGICAL_ACCEPTANCE_STATESTORE_RANGE'
        );
      }

      return store
        .listAcceptedBiologicalStreamRange(
          range
        );
    };


  return Object.freeze({
    resolveSignal,
    resolveStreamRange
  });
}


module.exports = {
  createStateStoreBiologicalEvidenceResolvers
};
