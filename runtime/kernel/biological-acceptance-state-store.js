'use strict';

const {
  AUTHORITY_MODE
} = require('./biological-envelope');



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



function normalizeProducerHandle(
  value
) {
  if (
    !value ||
    typeof value !==
      'object'
  ) {
    return null;
  }

  const coreId =
    value.coreId ??
    value.core_id;

  const instanceId =
    value.instanceId ??
    value.instance_id;

  const version =
    value.version;

  const authorityEpoch =
    Number(
      value.authorityEpoch ??
      value.authority_epoch
    );

  if (
    typeof coreId !==
      'string' ||
    !coreId ||
    typeof instanceId !==
      'string' ||
    !instanceId ||
    typeof version !==
      'string' ||
    !version ||
    !Number.isSafeInteger(
      authorityEpoch
    ) ||
    authorityEpoch < 1
  ) {
    return null;
  }

  return {
    coreId,
    instanceId,
    version,
    authorityEpoch
  };
}


function createStateStoreAuthoritativeProducerResolver({
  stateStore
}) {
  const store =
    requireStateStore(
      stateStore
    );

  if (
    typeof store.getAuthority !==
    'function'
  ) {
    fail(
      'StateStore authority resolver is unavailable',
      'BIOLOGICAL_ACCEPTANCE_STATESTORE_CONFIG'
    );
  }

  return async producerHandle => {
    const handle =
      normalizeProducerHandle(
        producerHandle
      );

    if (!handle) {
      return null;
    }

    const authority =
      store.getAuthority(
        handle.coreId
      );

    if (
      !authority ||
      authority.instanceId !==
        handle.instanceId ||
      authority.version !==
        handle.version ||
      Number(
        authority.epoch
      ) !==
        handle.authorityEpoch
    ) {
      return null;
    }

    return {
      coreId:
        authority.coreId,

      instanceId:
        authority.instanceId,

      version:
        authority.version,

      authorityEpoch:
        Number(
          authority.epoch
        ),

      authorityMode:
        AUTHORITY_MODE.AUTHORITATIVE,

      barrierSequence:
        Number(
          authority.barrierSequence
        ) || 0
    };
  };
}


function authorityWitnessFromPrepared(
  prepared
) {
  const kernel =
    prepared?.kernel;

  if (
    !kernel ||
    kernel.authority_mode !==
      AUTHORITY_MODE.AUTHORITATIVE
  ) {
    return null;
  }

  const witness = {
    coreId:
      kernel.producer_core_id,

    instanceId:
      kernel.producer_instance_id,

    version:
      kernel.producer_version,

    authorityEpoch:
      Number(
        kernel.authority_epoch
      )
  };

  if (
    typeof witness.coreId !==
      'string' ||
    !witness.coreId ||
    typeof witness.instanceId !==
      'string' ||
    !witness.instanceId ||
    typeof witness.version !==
      'string' ||
    !witness.version ||
    !Number.isSafeInteger(
      witness.authorityEpoch
    ) ||
    witness.authorityEpoch < 1
  ) {
    fail(
      'prepared authoritative biological fact carries an invalid authority witness',
      'BIOLOGICAL_AUTHORITY_WITNESS'
    );
  }

  return Object.freeze(
    witness
  );
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
  createStateStoreBiologicalEvidenceResolvers,
  createStateStoreAuthoritativeProducerResolver,
  authorityWitnessFromPrepared
};
