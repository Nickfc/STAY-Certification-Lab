'use strict';

const crypto =
  require('node:crypto');

const {
  stableStringify
} =
  require('./canonical-json');


const ENVELOPE_PROTOCOL =
  'stay-biological-envelope-v2';

const MAX_PAYLOAD_BYTES =
  8 * 1024;

const MAX_DIRECT_PARENTS =
  4;

const MAX_CAUSAL_SOURCE_SPANS =
  4;

const MAX_CAUSAL_ROOTS =
  4;

const MAX_ANCESTOR_CORES =
  32;


const AUTHORITY_MODE =
  Object.freeze({
    NEUTRAL:
      'neutral',

    LABORATORY:
      'lab',

    SHADOW:
      'shadow',

    AUTHORITATIVE:
      'authoritative'
  });


const SIGNAL_CLASS =
  Object.freeze({
    RAW_AFFERENT:
      'RAW_AFFERENT',

    FAST_INTEROCEPTIVE_CONTEXT:
      'FAST_INTEROCEPTIVE_CONTEXT',

    INTEGRATED_EVIDENCE:
      'INTEGRATED_EVIDENCE',

    CHEMICAL_MODULATION:
      'CHEMICAL_MODULATION',

    REGULATORY_EFFERENT:
      'REGULATORY_EFFERENT',

    CHRONOBIOLOGICAL_CONTEXT:
      'CHRONOBIOLOGICAL_CONTEXT',

    DIFFUSE_ENDOCRINE:
      'DIFFUSE_ENDOCRINE',

    STATE_SUMMARY:
      'STATE_SUMMARY',

    BIOLOGICAL_TRANSITION:
      'BIOLOGICAL_TRANSITION'
  });


const DURABILITY_CLASS =
  Object.freeze({
    EPHEMERAL_REPLAYABLE:
      'EPHEMERAL_REPLAYABLE',

    CHECKPOINT_CRITICAL:
      'CHECKPOINT_CRITICAL',

    DURABLE_TRANSITION:
      'DURABLE_TRANSITION'
  });


const TEMPORAL_TYPE =
  Object.freeze({
    INSTANT:
      'INSTANT',

    INTERVAL:
      'INTERVAL',

    OBSERVATION_WINDOW:
      'OBSERVATION_WINDOW',

    STATE_AS_OF:
      'STATE_AS_OF'
  });


const TRUST_FIELDS =
  new Set([
    'organism_id',
    'signal_id',
    'producer_core_id',
    'producer_instance_id',
    'producer_version',
    'authority_epoch',
    'authority_mode',
    'accepted_time_us',
    'order_time_us',
    'fabric_sequence',
    'payload_hash',
    'causal_roots',
    'causal_generation',
    'roots_overflow_digest',
    'lineage_digest',
    'ancestor_core_set'
  ]);


const PROPOSAL_FIELDS =
  new Set([
    'producer_event_id',
    'producer_stream_id',
    'stream_sequence',
    'topic',
    'signal_class',
    'schema_version',
    'temporal',
    'valid_from_us',
    'expires_at_us',
    'durability_class',
    'payload',
    'direct_parents',
    'causal_source_spans'
  ]);


const KERNEL_FIELDS =
  new Set([
    'organism_id',
    'producer_core_id',
    'producer_instance_id',
    'producer_version',
    'authority_epoch',
    'authority_mode',
    'accepted_time_us',
    'fabric_sequence',
    'causal_roots',
    'causal_generation',
    'roots_overflow_digest',
    'lineage_digest',
    'ancestor_core_set',
    'causality_validated',
    'max_causal_order_time_us'
  ]);


const HASH =
  /^sha256:[0-9a-f]{64}$/;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;


function fail(
  message,
  code =
    'BIOLOGICAL_ENVELOPE_INVALID'
) {
  throw Object.assign(
    new Error(message),
    { code }
  );
}


function plainObject(
  value,
  label
) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    fail(
      `${label} must be an object`
    );
  }

  return value;
}


function exactAllowedFields(
  value,
  allowed,
  label
) {
  plainObject(
    value,
    label
  );

  for (
    const key of
      Object.keys(value)
  ) {
    if (
      TRUST_FIELDS.has(key) &&
      label === 'producer proposal'
    ) {
      fail(
        `producer may not author trusted field ${key}`,
        'BIOLOGICAL_ENVELOPE_TRUST_FIELD'
      );
    }

    if (!allowed.has(key)) {
      fail(
        `${label} field ${key} is not permitted`,
        'BIOLOGICAL_ENVELOPE_FIELD'
      );
    }
  }
}


function boundedString(
  value,
  label,
  maximumBytes
) {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(
      value,
      'utf8'
    ) > maximumBytes
  ) {
    fail(
      `${label} is invalid`
    );
  }

  return value;
}


function unsigned(
  value,
  label,
  {
    minimum = 0,
    maximum =
      Number.MAX_SAFE_INTEGER
  } = {}
) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(
      `${label} is invalid`
    );
  }

  return value;
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


function canonicalClone(
  value
) {
  try {
    return JSON.parse(
      stableStringify(value)
    );
  } catch {
    fail(
      'value is not canonically serializable'
    );
  }
}


function deepFreeze(
  value
) {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.isFrozen(value)
  ) {
    return value;
  }

  for (
    const child of
      Object.values(value)
  ) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}


function acceptedId(
  value,
  label
) {
  if (
    typeof value !== 'string' ||
    !HASH.test(value)
  ) {
    fail(
      `${label} must be a sha256 identity`
    );
  }

  return value;
}


function producerEventId(
  value
) {
  if (
    typeof value !== 'string' ||
    !(
      HASH.test(value) ||
      UUID.test(value)
    )
  ) {
    fail(
      'producer_event_id must be a stable 128-256 bit identity',
      'BIOLOGICAL_ENVELOPE_PRODUCER_EVENT_ID'
    );
  }

  return value.toLowerCase();
}


function topic(
  value
) {
  boundedString(
    value,
    'topic',
    96
  );

  if (
    value.includes('*') ||
    !/^[a-z0-9][a-z0-9._:-]*$/i.test(value)
  ) {
    fail(
      'topic is invalid',
      'BIOLOGICAL_ENVELOPE_TOPIC'
    );
  }

  return value;
}


function streamId(
  value
) {
  boundedString(
    value,
    'producer_stream_id',
    128
  );

  if (
    value.includes('*') ||
    !/^[a-z0-9][a-z0-9._:-]*$/i.test(value)
  ) {
    fail(
      'producer stream is invalid',
      'BIOLOGICAL_ENVELOPE_STREAM'
    );
  }

  return value;
}


function schemaVersion(
  value
) {
  if (
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 65535
  ) {
    return value;
  }

  if (
    typeof value === 'string' &&
    value &&
    Buffer.byteLength(
      value,
      'utf8'
    ) <= 32
  ) {
    return value;
  }

  fail(
    'schema_version is invalid',
    'BIOLOGICAL_ENVELOPE_SCHEMA'
  );
}


function normalizeTemporal(
  input
) {
  plainObject(
    input,
    'temporal'
  );

  const type =
    input.type;

  if (
    !Object.values(
      TEMPORAL_TYPE
    ).includes(type)
  ) {
    fail(
      'temporal type is invalid',
      'BIOLOGICAL_ENVELOPE_TEMPORAL'
    );
  }

  if (
    type ===
    TEMPORAL_TYPE.INSTANT ||
    type ===
    TEMPORAL_TYPE.STATE_AS_OF
  ) {
    if (
      Object.keys(input).length !== 2 ||
      !Object.hasOwn(input, 'at_us')
    ) {
      fail(
        'instant/state-as-of temporal fields are invalid',
        'BIOLOGICAL_ENVELOPE_TEMPORAL'
      );
    }

    return {
      type,
      at_us:
        unsigned(
          input.at_us,
          'temporal.at_us'
        )
    };
  }

  if (
    type ===
    TEMPORAL_TYPE.INTERVAL
  ) {
    if (
      Object.keys(input).length !== 3 ||
      !Object.hasOwn(input, 'start_us') ||
      !Object.hasOwn(input, 'end_us')
    ) {
      fail(
        'interval temporal fields are invalid',
        'BIOLOGICAL_ENVELOPE_TEMPORAL'
      );
    }

    const start =
      unsigned(
        input.start_us,
        'temporal.start_us'
      );

    const end =
      unsigned(
        input.end_us,
        'temporal.end_us'
      );

    if (end < start) {
      fail(
        'interval ends before it starts',
        'BIOLOGICAL_ENVELOPE_TEMPORAL'
      );
    }

    return {
      type,
      start_us:
        start,

      end_us:
        end
    };
  }

  if (
    Object.keys(input).length !== 4 ||
    !Object.hasOwn(input, 'start_us') ||
    !Object.hasOwn(input, 'end_us') ||
    !Object.hasOwn(input, 'decision_us')
  ) {
    fail(
      'observation-window temporal fields are invalid',
      'BIOLOGICAL_ENVELOPE_TEMPORAL'
    );
  }

  const start =
    unsigned(
      input.start_us,
      'temporal.start_us'
    );

  const end =
    unsigned(
      input.end_us,
      'temporal.end_us'
    );

  const decision =
    unsigned(
      input.decision_us,
      'temporal.decision_us'
    );

  if (
    end < start ||
    decision < end
  ) {
    fail(
      'observation window is temporally inconsistent',
      'BIOLOGICAL_ENVELOPE_TEMPORAL'
    );
  }

  return {
    type,
    start_us:
      start,

    end_us:
      end,

    decision_us:
      decision
  };
}


function deriveOrderTime(
  temporal
) {
  switch (
    temporal.type
  ) {
    case TEMPORAL_TYPE.INSTANT:
    case TEMPORAL_TYPE.STATE_AS_OF:
      return temporal.at_us;

    case TEMPORAL_TYPE.INTERVAL:
      return temporal.start_us;

    case TEMPORAL_TYPE.OBSERVATION_WINDOW:
      return temporal.decision_us;

    default:
      fail(
        'cannot derive order time',
        'BIOLOGICAL_ENVELOPE_TEMPORAL'
      );
  }
}


function normalizeValidity(
  validFrom,
  expiresAt
) {
  const start =
    validFrom == null
      ? null
      : unsigned(
          validFrom,
          'valid_from_us'
        );

  const end =
    expiresAt == null
      ? null
      : unsigned(
          expiresAt,
          'expires_at_us'
        );

  if (
    start != null &&
    end != null &&
    end < start
  ) {
    fail(
      'validity interval is reversed',
      'BIOLOGICAL_ENVELOPE_VALIDITY'
    );
  }

  return {
    valid_from_us:
      start,

    expires_at_us:
      end
  };
}


function normalizeParents(
  value
) {
  const parents =
    value == null
      ? []
      : value;

  if (!Array.isArray(parents)) {
    fail(
      'direct_parents must be an array',
      'BIOLOGICAL_ENVELOPE_CAUSAL_BOUND'
    );
  }

  if (
    parents.length >
    MAX_DIRECT_PARENTS
  ) {
    fail(
      'direct parent budget exceeded',
      'BIOLOGICAL_ENVELOPE_CAUSAL_BOUND'
    );
  }

  const normalized =
    parents.map(
      (entry, index) =>
        acceptedId(
          entry,
          `direct_parents[${index}]`
        )
    );

  if (
    new Set(normalized).size !==
    normalized.length
  ) {
    fail(
      'duplicate direct parent',
      'BIOLOGICAL_ENVELOPE_CAUSAL_BOUND'
    );
  }

  return normalized;
}


function normalizeSpan(
  value
) {
  plainObject(
    value,
    'causal source span'
  );

  const required = [
    'producer_stream_id',
    'authority_epoch',
    'first_sequence',
    'last_sequence',
    'source_count',
    'max_order_time_us',
    'range_digest'
  ];

  if (
    Object.keys(value).length !==
      required.length ||
    required.some(
      key =>
        !Object.hasOwn(
          value,
          key
        )
    )
  ) {
    fail(
      'causal source span fields are invalid',
      'BIOLOGICAL_ENVELOPE_CAUSAL_SPAN'
    );
  }

  const first =
    unsigned(
      value.first_sequence,
      'span.first_sequence',
      { minimum: 1 }
    );

  const last =
    unsigned(
      value.last_sequence,
      'span.last_sequence',
      { minimum: 1 }
    );

  const count =
    unsigned(
      value.source_count,
      'span.source_count',
      { minimum: 1 }
    );

  if (
    last < first ||
    count !==
      last - first + 1
  ) {
    fail(
      'causal source span range/count mismatch',
      'BIOLOGICAL_ENVELOPE_CAUSAL_SPAN'
    );
  }

  return {
    producer_stream_id:
      streamId(
        value.producer_stream_id
      ),

    authority_epoch:
      unsigned(
        value.authority_epoch,
        'span.authority_epoch',
        { minimum: 1 }
      ),

    first_sequence:
      first,

    last_sequence:
      last,

    source_count:
      count,

    max_order_time_us:
      unsigned(
        value.max_order_time_us,
        'span.max_order_time_us'
      ),

    range_digest:
      acceptedId(
        value.range_digest,
        'span.range_digest'
      )
  };
}


function normalizeSpans(
  value
) {
  const spans =
    value == null
      ? []
      : value;

  if (!Array.isArray(spans)) {
    fail(
      'causal_source_spans must be an array',
      'BIOLOGICAL_ENVELOPE_CAUSAL_BOUND'
    );
  }

  if (
    spans.length >
    MAX_CAUSAL_SOURCE_SPANS
  ) {
    fail(
      'causal source span budget exceeded',
      'BIOLOGICAL_ENVELOPE_CAUSAL_BOUND'
    );
  }

  const normalized =
    spans.map(
      normalizeSpan
    );

  for (
    let leftIndex = 0;
    leftIndex < normalized.length;
    leftIndex += 1
  ) {
    const left =
      normalized[leftIndex];

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < normalized.length;
      rightIndex += 1
    ) {
      const right =
        normalized[rightIndex];

      if (
        left.producer_stream_id ===
          right.producer_stream_id &&
        left.authority_epoch ===
          right.authority_epoch
      ) {
        const overlaps =
          left.first_sequence <=
            right.last_sequence &&
          right.first_sequence <=
            left.last_sequence;

        if (overlaps) {
          fail(
            'causal source spans overlap in one stream authority domain',
            'BIOLOGICAL_ENVELOPE_CAUSAL_SPAN'
          );
        }
      }
    }
  }

  return normalized;
}


function normalizeRoots(
  value
) {
  const roots =
    value == null
      ? []
      : value;

  if (
    !Array.isArray(roots) ||
    roots.length >
      MAX_CAUSAL_ROOTS
  ) {
    fail(
      'causal root budget exceeded',
      'BIOLOGICAL_ENVELOPE_CAUSAL_BOUND'
    );
  }

  const normalized =
    roots.map(
      (entry, index) =>
        boundedString(
          entry,
          `causal_roots[${index}]`,
          256
        )
    );

  if (
    new Set(normalized).size !==
    normalized.length
  ) {
    fail(
      'duplicate causal root',
      'BIOLOGICAL_ENVELOPE_CAUSAL_BOUND'
    );
  }

  return normalized;
}


function optionalHash(
  value,
  label
) {
  if (value == null) {
    return null;
  }

  return acceptedId(
    value,
    label
  );
}


function normalizeAncestorCores(
  value,
  producerCoreId
) {
  const input =
    value == null
      ? []
      : value;

  if (!Array.isArray(input)) {
    fail(
      'ancestor_core_set is invalid',
      'BIOLOGICAL_ENVELOPE_ANCESTRY'
    );
  }

  const cores =
    [
      ...input,
      producerCoreId
    ].map(
      (entry, index) =>
        boundedString(
          entry,
          `ancestor_core_set[${index}]`,
          128
        )
    );

  const unique =
    [...new Set(cores)]
      .sort();

  if (
    unique.length >
    MAX_ANCESTOR_CORES
  ) {
    fail(
      'ancestor core budget exceeded',
      'BIOLOGICAL_ENVELOPE_ANCESTRY'
    );
  }

  return unique;
}


function normalizePayload(
  value
) {
  plainObject(
    value,
    'payload'
  );

  const canonical =
    canonicalClone(value);

  const encoded =
    stableStringify(
      canonical
    );

  if (
    Buffer.byteLength(
      encoded,
      'utf8'
    ) > MAX_PAYLOAD_BYTES
  ) {
    fail(
      `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
      'BIOLOGICAL_ENVELOPE_PAYLOAD_TOO_LARGE'
    );
  }

  return {
    payload:
      canonical,

    payload_hash:
      hash(canonical)
  };
}


function normalizeProposal(
  input
) {
  exactAllowedFields(
    input,
    PROPOSAL_FIELDS,
    'producer proposal'
  );

  const className =
    input.signal_class;

  if (
    !Object.values(
      SIGNAL_CLASS
    ).includes(className)
  ) {
    fail(
      'signal_class is invalid',
      'BIOLOGICAL_ENVELOPE_SIGNAL_CLASS'
    );
  }

  const durability =
    input.durability_class;

  if (
    !Object.values(
      DURABILITY_CLASS
    ).includes(durability)
  ) {
    fail(
      'durability_class is invalid',
      'BIOLOGICAL_ENVELOPE_DURABILITY'
    );
  }

  /*
   * Stream sequencing has its own protocol failure domain.
   *
   * Later EF1 replay/finalization machinery must be able to
   * distinguish a malformed producer stream from an unrelated
   * envelope validation failure.
   */
  if (
    !Number.isSafeInteger(
      input.stream_sequence
    ) ||
    input.stream_sequence < 1
  ) {
    fail(
      'stream_sequence is invalid',
      'BIOLOGICAL_ENVELOPE_STREAM'
    );
  }

  const sequence =
    input.stream_sequence;

  const temporal =
    normalizeTemporal(
      input.temporal
    );

  const validity =
    normalizeValidity(
      input.valid_from_us,
      input.expires_at_us
    );

  return {
    producer_event_id:
      producerEventId(
        input.producer_event_id
      ),

    producer_stream_id:
      streamId(
        input.producer_stream_id
      ),

    stream_sequence:
      sequence,

    topic:
      topic(
        input.topic
      ),

    signal_class:
      className,

    schema_version:
      schemaVersion(
        input.schema_version
      ),

    temporal,

    ...validity,

    durability_class:
      durability,

    payload:
      input.payload,

    direct_parents:
      normalizeParents(
        input.direct_parents
      ),

    causal_source_spans:
      normalizeSpans(
        input.causal_source_spans
      )
  };
}


function normalizeKernel(
  input
) {
  exactAllowedFields(
    input,
    KERNEL_FIELDS,
    'Kernel acceptance context'
  );

  const mode =
    input.authority_mode;

  if (
    !Object.values(
      AUTHORITY_MODE
    ).includes(mode)
  ) {
    fail(
      'authority_mode is invalid',
      'BIOLOGICAL_ENVELOPE_AUTHORITY'
    );
  }

  const producerCoreId =
    boundedString(
      input.producer_core_id,
      'producer_core_id',
      128
    );

  return {
    organism_id:
      boundedString(
        input.organism_id,
        'organism_id',
        256
      ),

    producer_core_id:
      producerCoreId,

    producer_instance_id:
      boundedString(
        input.producer_instance_id,
        'producer_instance_id',
        160
      ),

    producer_version:
      boundedString(
        input.producer_version,
        'producer_version',
        32
      ),

    authority_epoch:
      unsigned(
        input.authority_epoch,
        'authority_epoch',
        { minimum: 1 }
      ),

    authority_mode:
      mode,

    accepted_time_us:
      unsigned(
        input.accepted_time_us,
        'accepted_time_us'
      ),

    fabric_sequence:
      unsigned(
        input.fabric_sequence,
        'fabric_sequence',
        { minimum: 1 }
      ),

    causal_roots:
      normalizeRoots(
        input.causal_roots
      ),

    causal_generation:
      unsigned(
        input.causal_generation ?? 0,
        'causal_generation',
        { maximum: 65535 }
      ),

    roots_overflow_digest:
      optionalHash(
        input.roots_overflow_digest,
        'roots_overflow_digest'
      ),

    lineage_digest:
      optionalHash(
        input.lineage_digest,
        'lineage_digest'
      ),

    ancestor_core_set:
      normalizeAncestorCores(
        input.ancestor_core_set,
        producerCoreId
      ),

    causality_validated:
      input.causality_validated === true,

    max_causal_order_time_us:
      unsigned(
        input.max_causal_order_time_us ?? 0,
        'max_causal_order_time_us'
      )
  };
}


function acceptEnvelope(
  producerInput,
  kernelInput
) {
  const proposal =
    normalizeProposal(
      producerInput
    );

  const kernel =
    normalizeKernel(
      kernelInput
    );

  const temporal =
    proposal.temporal;

  const orderTimeUs =
    deriveOrderTime(
      temporal
    );

  const hasCausality =
    proposal.direct_parents.length > 0 ||
    proposal.causal_source_spans.length > 0 ||
    kernel.causal_roots.length > 0;

  if (
    hasCausality &&
    !kernel.causality_validated
  ) {
    fail(
      'causal input has not been Kernel validated',
      'BIOLOGICAL_ENVELOPE_CAUSAL_UNVERIFIED'
    );
  }

  if (
    hasCausality &&
    kernel.causal_generation < 1
  ) {
    fail(
      'causal generation is inconsistent',
      'BIOLOGICAL_ENVELOPE_ANCESTRY'
    );
  }

  if (
    !hasCausality &&
    kernel.causal_generation !== 0
  ) {
    fail(
      'non-causal signal has causal generation',
      'BIOLOGICAL_ENVELOPE_ANCESTRY'
    );
  }

  if (
    hasCausality &&
    orderTimeUs <
      kernel.max_causal_order_time_us
  ) {
    fail(
      'derived envelope precedes validated causal input',
      'BIOLOGICAL_ENVELOPE_CAUSAL_PRECEDENCE'
    );
  }

  const normalizedPayload =
    normalizePayload(
      proposal.payload
    );

  const body = {
    protocol:
      ENVELOPE_PROTOCOL,

    organism_id:
      kernel.organism_id,

    producer_core_id:
      kernel.producer_core_id,

    producer_instance_id:
      kernel.producer_instance_id,

    producer_version:
      kernel.producer_version,

    authority_epoch:
      kernel.authority_epoch,

    authority_mode:
      kernel.authority_mode,

    producer_event_id:
      proposal.producer_event_id,

    producer_stream_id:
      proposal.producer_stream_id,

    stream_sequence:
      proposal.stream_sequence,

    topic:
      proposal.topic,

    signal_class:
      proposal.signal_class,

    schema_version:
      proposal.schema_version,

    temporal:
      temporal,

    accepted_time_us:
      kernel.accepted_time_us,

    order_time_us:
      orderTimeUs,

    fabric_sequence:
      kernel.fabric_sequence,

    valid_from_us:
      proposal.valid_from_us,

    expires_at_us:
      proposal.expires_at_us,

    causal_roots:
      kernel.causal_roots,

    direct_parents:
      proposal.direct_parents,

    causal_source_spans:
      proposal.causal_source_spans,

    causal_generation:
      kernel.causal_generation,

    roots_overflow_digest:
      kernel.roots_overflow_digest,

    lineage_digest:
      kernel.lineage_digest,

    ancestor_core_set:
      kernel.ancestor_core_set,

    durability_class:
      proposal.durability_class,

    payload:
      normalizedPayload.payload,

    payload_hash:
      normalizedPayload.payload_hash
  };

  const envelope = {
    ...body,

    signal_id:
      hash(body)
  };

  return deepFreeze(
    envelope
  );
}


function normalizeAcceptedEnvelope(
  input
) {
  plainObject(
    input,
    'accepted biological envelope'
  );

  const requiredFields = [
    'protocol',
    'organism_id',
    'signal_id',
    'producer_core_id',
    'producer_instance_id',
    'producer_version',
    'authority_epoch',
    'authority_mode',
    'producer_event_id',
    'producer_stream_id',
    'stream_sequence',
    'topic',
    'signal_class',
    'schema_version',
    'temporal',
    'accepted_time_us',
    'order_time_us',
    'fabric_sequence',
    'valid_from_us',
    'expires_at_us',
    'causal_roots',
    'direct_parents',
    'causal_source_spans',
    'causal_generation',
    'roots_overflow_digest',
    'lineage_digest',
    'ancestor_core_set',
    'durability_class',
    'payload',
    'payload_hash'
  ];

  if (
    Object.keys(input).length !==
      requiredFields.length ||
    requiredFields.some(
      key =>
        !Object.hasOwn(
          input,
          key
        )
    )
  ) {
    fail(
      'accepted envelope fields are not canonical',
      'BIOLOGICAL_ENVELOPE_ACCEPTED_FIELDS'
    );
  }

  if (
    input.protocol !==
    ENVELOPE_PROTOCOL
  ) {
    fail(
      'accepted envelope protocol is invalid'
    );
  }

  const rebuilt =
    acceptEnvelope(
      {
        producer_event_id:
          input.producer_event_id,

        producer_stream_id:
          input.producer_stream_id,

        stream_sequence:
          input.stream_sequence,

        topic:
          input.topic,

        signal_class:
          input.signal_class,

        schema_version:
          input.schema_version,

        temporal:
          input.temporal,

        valid_from_us:
          input.valid_from_us,

        expires_at_us:
          input.expires_at_us,

        durability_class:
          input.durability_class,

        payload:
          input.payload,

        direct_parents:
          input.direct_parents,

        causal_source_spans:
          input.causal_source_spans
      },

      {
        organism_id:
          input.organism_id,

        producer_core_id:
          input.producer_core_id,

        producer_instance_id:
          input.producer_instance_id,

        producer_version:
          input.producer_version,

        authority_epoch:
          input.authority_epoch,

        authority_mode:
          input.authority_mode,

        accepted_time_us:
          input.accepted_time_us,

        fabric_sequence:
          input.fabric_sequence,

        causal_roots:
          input.causal_roots,

        causal_generation:
          input.causal_generation,

        roots_overflow_digest:
          input.roots_overflow_digest,

        lineage_digest:
          input.lineage_digest,

        ancestor_core_set:
          input.ancestor_core_set,

        causality_validated:
          (
            input.direct_parents.length > 0 ||
            input.causal_source_spans.length > 0 ||
            input.causal_roots.length > 0
          ),

        max_causal_order_time_us:
          Math.max(
            0,
            ...input.causal_source_spans.map(
              span =>
                span.max_order_time_us
            )
          )
      }
    );

  /*
   * Direct-parent resolution belongs to the later Kernel
   * acceptance/causal-ledger stage. Round-trip normalization
   * may validate the immutable representation but may not
   * invent parent order-time evidence.
   *
   * Therefore only identity fields independent of external
   * ledger resolution are compared here.
   */
  if (
    rebuilt.payload_hash !==
      input.payload_hash ||
    rebuilt.order_time_us !==
      input.order_time_us
  ) {
    fail(
      'accepted envelope integrity mismatch',
      'BIOLOGICAL_ENVELOPE_INTEGRITY'
    );
  }

  /*
   * signal_id is the hash of the complete accepted immutable
   * body. Verify it directly rather than trusting the input.
   */
  const {
    signal_id,
    ...body
  } =
    input;

  if (
    !HASH.test(signal_id) ||
    hash(body) !==
      signal_id
  ) {
    fail(
      'accepted envelope signal identity is invalid',
      'BIOLOGICAL_ENVELOPE_IDENTITY'
    );
  }

  return deepFreeze(
    canonicalClone(input)
  );
}


module.exports = {
  ENVELOPE_PROTOCOL,

  MAX_PAYLOAD_BYTES,
  MAX_DIRECT_PARENTS,
  MAX_CAUSAL_SOURCE_SPANS,
  MAX_CAUSAL_ROOTS,

  AUTHORITY_MODE,
  SIGNAL_CLASS,
  DURABILITY_CLASS,
  TEMPORAL_TYPE,

  acceptEnvelope,
  normalizeAcceptedEnvelope
};
