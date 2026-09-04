'use strict';

// Deterministic P1-R0 resident bundle. Source seal: sha256:ad71e5ee9a08fc79246fdf09943440679e60dc991fdf5d72a73ba99b1659cc37
const __bundleModules = {
"runtime/kernel/biological-envelope.js": function(module, exports, __bundleRequire) {
'use strict';

const crypto =
  require('node:crypto');

const {
  stableStringify
} =
  __bundleRequire("runtime/kernel/canonical-json.js");


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
},
"runtime/kernel/canonical-json.js": function(module, exports, __bundleRequire) {
'use strict';

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw Object.assign(new Error('canonical JSON rejects non-finite numbers'), { code: 'CANONICAL_JSON_NUMBER' });
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw Object.assign(new Error('canonical JSON rejects unsupported values'), { code: 'CANONICAL_JSON_TYPE' });
  }
  if (seen.has(value)) throw Object.assign(new Error('canonical JSON rejects cyclic values'), { code: 'CANONICAL_JSON_CYCLE' });
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map(entry => canonicalize(entry, seen));
  } else {
    result = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') {
        throw Object.assign(new Error(`canonical JSON rejects unsupported field: ${key}`), { code: 'CANONICAL_JSON_FIELD' });
      }
      result[key] = canonicalize(entry, seen);
    }
  }
  seen.delete(value);
  return result;
}

function stableStringify(value) { return JSON.stringify(canonicalize(value)); }

module.exports = { canonicalize, stableStringify };
},
"runtime/p1-r0/causal-frame.js": function(module, exports, __bundleRequire) {
'use strict';

const crypto = require('node:crypto');
const { stableStringify } = __bundleRequire("runtime/kernel/canonical-json.js");
const {
  SIGNAL_CLASS,
  DURABILITY_CLASS,
  TEMPORAL_TYPE,
  MAX_PAYLOAD_BYTES,
  MAX_DIRECT_PARENTS,
  MAX_CAUSAL_SOURCE_SPANS
} = __bundleRequire("runtime/kernel/biological-envelope.js");
const q48 = __bundleRequire("runtime/p1-r0/q16-48.js");
const { validateFrameRoute } = __bundleRequire("runtime/p1-r0/contract-registry.js");

const FRAME_PROTOCOL = 'stay-p1-r0-causal-frame-v1';
const FRAME_US = 250_000;
const HASH = /^sha256:[0-9a-f]{64}$/;
const UNSIGNED_TEXT = /^(0|[1-9][0-9]*)$/;
const MODE = new Set(['NEUTRAL', 'SHADOW', 'LIVE']);
const QUALITY = new Set(['ACCEPT', 'HOLD', 'UNKNOWN', 'QUARANTINE']);
const TOPIC_CLASS = Object.freeze({
  SUMMARY: SIGNAL_CLASS.STATE_SUMMARY,
  INTEGRITY: SIGNAL_CLASS.INTEGRATED_EVIDENCE,
  DEMAND: SIGNAL_CLASS.RAW_AFFERENT,
  MODULATION: SIGNAL_CLASS.REGULATORY_EFFERENT,
  FACT: SIGNAL_CLASS.BIOLOGICAL_TRANSITION,
  CONTEXT: SIGNAL_CLASS.CHRONOBIOLOGICAL_CONTEXT,
  OBSERVATION: SIGNAL_CLASS.INTEGRATED_EVIDENCE
});

const FRAME_FIELDS = new Set([
  'frameVersion', 'frameId', 'organismId', 'founderLineageId', 'producer',
  'route', 'topic', 'producerSequence', 'committedFrame', 'visibleFromFrame',
  'sourceWindow', 'causalSpan', 'quality', 'expiresAtFrame', 'payload', 'payloadHash'
]);

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`, 'P1_FRAME_SCHEMA');
  }
  return value;
}

function exact(value, fields, label) {
  object(value, label);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some(key => !fields.has(key))) {
    fail(`${label} fields are not exact`, 'P1_FRAME_SCHEMA');
  }
}

function text(value, label, maximum = 160) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximum) {
    fail(`${label} is invalid`, 'P1_FRAME_SCHEMA');
  }
  return value;
}

function frameIndex(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid`, 'P1_FRAME_SCHEMA');
  return value;
}

function unsignedText(value, label) {
  if (typeof value !== 'string' || !UNSIGNED_TEXT.test(value)) {
    fail(`${label} is invalid`, 'P1_FRAME_SCHEMA');
  }
  return BigInt(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function clone(value) {
  return JSON.parse(stableStringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateWindow(value, label) {
  exact(value, new Set(['startFrame', 'endFrame']), label);
  const startFrame = frameIndex(value.startFrame, `${label}.startFrame`);
  const endFrame = frameIndex(value.endFrame, `${label}.endFrame`);
  if (endFrame < startFrame) fail(`${label} ends before it starts`, 'P1_FRAME_WINDOW');
  return { startFrame, endFrame };
}

function validateAncestor(value) {
  const fields = new Set([
    'producerCoreId', 'residencyId', 'topic', 'routeId', 'producerSequence',
    'sourceWindow', 'mode', 'shadowAncestry', 'confidenceQ48'
  ]);
  exact(value, fields, 'causal ancestor');
  text(value.producerCoreId, 'ancestor producer core id');
  text(value.residencyId, 'ancestor residency id');
  text(value.topic, 'ancestor topic');
  text(value.routeId, 'ancestor route id');
  unsignedText(value.producerSequence, 'ancestor producer sequence');
  validateWindow(value.sourceWindow, 'ancestor source window');
  if (!MODE.has(value.mode)) fail('ancestor mode is invalid', 'P1_FRAME_SCHEMA');
  if (typeof value.shadowAncestry !== 'boolean') fail('ancestor shadow ancestry is invalid', 'P1_FRAME_SCHEMA');
  const confidence = q48.parseRaw(value.confidenceQ48);
  if (confidence < 0n || confidence > q48.SCALE) fail('ancestor confidence is outside 0..1', 'P1_FRAME_QUALITY');
}

function validateCausalFrame(input) {
  exact(input, FRAME_FIELDS, 'P1 causal frame');
  if (input.frameVersion !== FRAME_PROTOCOL) fail('P1 frame protocol is invalid', 'P1_FRAME_PROTOCOL');
  if (!HASH.test(input.frameId)) fail('P1 frame id is invalid', 'P1_FRAME_SCHEMA');
  text(input.organismId, 'organism id');
  text(input.founderLineageId, 'founder lineage id');

  exact(input.producer, new Set(['coreId', 'residencyId', 'coreVersion', 'authorityEpoch', 'mode', 'lifecycle']), 'producer');
  text(input.producer.coreId, 'producer core id');
  text(input.producer.residencyId, 'producer residency id');
  text(input.producer.coreVersion, 'producer version');
  unsignedText(input.producer.authorityEpoch, 'producer authority epoch');
  if (!MODE.has(input.producer.mode)) fail('producer mode is invalid', 'P1_FRAME_SCHEMA');
  text(input.producer.lifecycle, 'producer lifecycle');

  exact(input.route, new Set(['routeId', 'consumerCoreId', 'routeVersion']), 'route');
  text(input.route.routeId, 'route id');
  text(input.route.consumerCoreId, 'consumer core id');
  text(input.route.routeVersion, 'route version');

  exact(input.topic, new Set(['name', 'class', 'schemaId', 'schemaVersion', 'unit', 'scale']), 'topic');
  text(input.topic.name, 'topic name', 96);
  if (!Object.hasOwn(TOPIC_CLASS, input.topic.class)) fail('topic class has no Envelope v2 mapping', 'P1_FRAME_TOPIC_CLASS');
  text(input.topic.schemaId, 'topic schema id');
  unsignedText(input.topic.schemaVersion, 'topic schema version');
  text(input.topic.unit, 'topic unit');
  if (input.topic.scale !== 'Q16.48') fail('topic scale is invalid', 'P1_FRAME_SCHEMA');
  unsignedText(input.producerSequence, 'producer sequence');

  const committedFrame = frameIndex(input.committedFrame, 'committed frame');
  const visibleFromFrame = frameIndex(input.visibleFromFrame, 'visible-from frame');
  if (visibleFromFrame < committedFrame + 1) {
    fail('P1 output cannot be consumed in its commit frame', 'P1_FRAME_SAME_FRAME');
  }
  const sourceWindow = validateWindow(input.sourceWindow, 'source window');
  if (sourceWindow.endFrame > committedFrame) {
    fail('P1 source window reaches into an uncommitted future frame', 'P1_FRAME_FUTURE_SOURCE');
  }

  exact(input.causalSpan, new Set(['earliestFrame', 'latestFrame', 'containsNeutral', 'containsShadow', 'ancestors']), 'causal span');
  const earliestFrame = frameIndex(input.causalSpan.earliestFrame, 'causal earliest frame');
  const latestFrame = frameIndex(input.causalSpan.latestFrame, 'causal latest frame');
  if (latestFrame < earliestFrame || latestFrame > committedFrame) {
    fail('causal span is temporally invalid', 'P1_FRAME_CAUSAL_SPAN');
  }
  if (typeof input.causalSpan.containsNeutral !== 'boolean' || typeof input.causalSpan.containsShadow !== 'boolean') {
    fail('causal authority flags are invalid', 'P1_FRAME_SCHEMA');
  }
  if (sourceWindow.startFrame < earliestFrame || sourceWindow.endFrame > latestFrame) {
    fail('source window is outside its declared causal span', 'P1_FRAME_CAUSAL_SPAN');
  }
  if (!Array.isArray(input.causalSpan.ancestors) || input.causalSpan.ancestors.length > 32) {
    fail('causal ancestor set is invalid', 'P1_FRAME_CAUSAL_SPAN');
  }
  const ancestorKeys = new Set();
  for (const ancestor of input.causalSpan.ancestors) {
    validateAncestor(ancestor);
    if (
      ancestor.sourceWindow.startFrame < earliestFrame ||
      ancestor.sourceWindow.endFrame > latestFrame ||
      ancestor.sourceWindow.endFrame > committedFrame
    ) fail('ancestor window is outside its declared causal span', 'P1_FRAME_CAUSAL_SPAN');
    if (ancestor.mode === 'NEUTRAL' && !input.causalSpan.containsNeutral) {
      fail('neutral ancestry was omitted from the causal flags', 'P1_FRAME_AUTHORITY_LAUNDERING');
    }
    if ((ancestor.mode === 'SHADOW' || ancestor.shadowAncestry) && !input.causalSpan.containsShadow) {
      fail('shadow ancestry was omitted from the causal flags', 'P1_FRAME_AUTHORITY_LAUNDERING');
    }
    const key = stableStringify([
      ancestor.producerCoreId,
      ancestor.residencyId,
      ancestor.topic,
      ancestor.routeId,
      ancestor.producerSequence
    ]);
    if (ancestorKeys.has(key)) fail('causal ancestor is duplicated', 'P1_FRAME_CAUSAL_SPAN');
    ancestorKeys.add(key);
  }
  if (input.producer.mode === 'LIVE' && (input.causalSpan.containsNeutral || input.causalSpan.containsShadow || input.causalSpan.ancestors.some(value => value.mode !== 'LIVE' || value.shadowAncestry))) {
    fail('non-authoritative ancestry cannot become LIVE', 'P1_FRAME_AUTHORITY_LAUNDERING');
  }

  exact(input.quality, new Set(['status', 'confidenceQ48', 'coverageQ48', 'reasons']), 'quality');
  if (!QUALITY.has(input.quality.status)) fail('quality status is invalid', 'P1_FRAME_QUALITY');
  for (const field of ['confidenceQ48', 'coverageQ48']) {
    const value = q48.parseRaw(input.quality[field]);
    if (value < 0n || value > q48.SCALE) fail(`${field} is outside 0..1`, 'P1_FRAME_QUALITY');
  }
  if (!Array.isArray(input.quality.reasons) || input.quality.reasons.length > 32) fail('quality reasons are invalid', 'P1_FRAME_QUALITY');
  for (const reason of input.quality.reasons) text(reason, 'quality reason', 128);

  if (input.expiresAtFrame !== null) {
    const expiresAtFrame = frameIndex(input.expiresAtFrame, 'expiry frame');
    if (expiresAtFrame < visibleFromFrame) fail('frame expires before it becomes visible', 'P1_FRAME_EXPIRY');
  }
  object(input.payload, 'payload');
  if (!HASH.test(input.payloadHash) || input.payloadHash !== sha256(input.payload)) {
    fail('P1 frame payload hash is invalid', 'P1_FRAME_PAYLOAD_HASH');
  }
  validateFrameRoute(input);
  return deepFreeze(clone(input));
}

function safeFrameUs(value, label) {
  const result = value * FRAME_US;
  if (!Number.isSafeInteger(result)) fail(`${label} exceeds trusted-time range`, 'P1_FRAME_TIME_RANGE');
  return result;
}

function toEnvelopeProposal(input, options = {}) {
  const frame = validateCausalFrame(input);
  const { directParents, causalSourceSpans, producerBinding } = options;
  if (frame.quality.status !== 'ACCEPT') {
    fail('only accepted P1 quality may become a biological proposal', 'P1_FRAME_NOT_ACCEPTED');
  }
  exact(producerBinding, new Set([
    'organismId', 'founderLineageId', 'coreId', 'residencyId',
    'coreVersion', 'authorityEpoch', 'mode'
  ]), 'Kernel producer binding');
  const expectedBinding = {
    organismId: frame.organismId,
    founderLineageId: frame.founderLineageId,
    coreId: frame.producer.coreId,
    residencyId: frame.producer.residencyId,
    coreVersion: frame.producer.coreVersion,
    authorityEpoch: frame.producer.authorityEpoch,
    mode: frame.producer.mode
  };
  if (Object.keys(expectedBinding).some(field => producerBinding[field] !== expectedBinding[field])) {
    fail('producer-authored frame identity disagrees with Kernel binding', 'P1_FRAME_PRODUCER_BINDING');
  }
  if (
    !Array.isArray(directParents) ||
    !Array.isArray(causalSourceSpans) ||
    directParents.length > MAX_DIRECT_PARENTS ||
    causalSourceSpans.length > MAX_CAUSAL_SOURCE_SPANS
  ) {
    fail('resolved Envelope v2 ancestry is required', 'P1_FRAME_ANCESTRY_REQUIRED');
  }
  if (
    (frame.causalSpan.ancestors.length > 0 || frame.causalSpan.containsNeutral || frame.causalSpan.containsShadow) &&
    directParents.length === 0 &&
    causalSourceSpans.length === 0
  ) {
    fail('claimed P1 ancestry lacks Kernel-resolved Envelope v2 evidence', 'P1_FRAME_ANCESTRY_REQUIRED');
  }
  const sequence = BigInt(frame.producerSequence);
  const schemaVersion = BigInt(frame.topic.schemaVersion);
  if (sequence < 1n || sequence > BigInt(Number.MAX_SAFE_INTEGER) || schemaVersion < 1n || schemaVersion > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('P1 sequence or schema version exceeds Envelope v2 range', 'P1_FRAME_ENVELOPE_RANGE');
  }
  const payload = {
    schema: 'stay-p1-r0-frame-payload/v1',
    p1Frame: frame
  };
  if (Buffer.byteLength(stableStringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) {
    fail('P1 frame exceeds the frozen Envelope v2 payload ceiling', 'P1_FRAME_PAYLOAD_LIMIT');
  }
  const producerStreamId = `p1r0:${frame.producer.coreId}:${frame.topic.name}`;
  if (Buffer.byteLength(producerStreamId, 'utf8') > 96) {
    fail('P1 producer stream id exceeds Envelope v2 range', 'P1_FRAME_ENVELOPE_RANGE');
  }
  const proposal = {
    producer_event_id: sha256(frame),
    producer_stream_id: producerStreamId,
    stream_sequence: Number(sequence),
    topic: frame.topic.name,
    signal_class: TOPIC_CLASS[frame.topic.class],
    schema_version: Number(schemaVersion),
    temporal: {
      type: TEMPORAL_TYPE.STATE_AS_OF,
      at_us: safeFrameUs(frame.committedFrame, 'committed frame')
    },
    valid_from_us: safeFrameUs(frame.visibleFromFrame, 'visible-from frame'),
    expires_at_us: frame.expiresAtFrame === null ? null : safeFrameUs(frame.expiresAtFrame, 'expiry frame'),
    durability_class: frame.topic.class === 'FACT'
      ? DURABILITY_CLASS.DURABLE_TRANSITION
      : DURABILITY_CLASS.CHECKPOINT_CRITICAL,
    payload,
    direct_parents: clone(directParents),
    causal_source_spans: clone(causalSourceSpans)
  };
  return deepFreeze(proposal);
}

module.exports = Object.freeze({
  FRAME_PROTOCOL,
  FRAME_US,
  TOPIC_CLASS,
  validateCausalFrame,
  toEnvelopeProposal
});
},
"runtime/p1-r0/contract-registry.js": function(module, exports, __bundleRequire) {
'use strict';

const ROUTE_STAGE = 'ABSENT';

const routes = [
  ['p1r0.capacity.metab', 'KERNEL_RESOURCE', 'METAB', 'resource.capacity.eligible.v1', 'SUMMARY'],
  ['p1r0.capacity-quality.metab', 'KERNEL_RESOURCE', 'METAB', 'resource.capacity.quality.v1', 'INTEGRITY'],
  ['p1r0.metab-availability.homeos', 'METAB', 'HOMEOS', 'metab.energy.availability.v1', 'SUMMARY'],
  ['p1r0.metab-reserve.homeos', 'METAB', 'HOMEOS', 'metab.energy.reserve.v1', 'SUMMARY'],
  ['p1r0.metab-availability.intero', 'METAB', 'INTERO', 'metab.energy.availability.v1', 'SUMMARY'],
  ['p1r0.metab-reserve.intero', 'METAB', 'INTERO', 'metab.energy.reserve.v1', 'SUMMARY'],
  ['p1r0.homeos-dimension.intero', 'HOMEOS', 'INTERO', 'homeos.dimension.summary.v1', 'SUMMARY'],
  ['p1r0.homeos-stability.intero', 'HOMEOS', 'INTERO', 'homeos.stability.summary.v1', 'SUMMARY'],
  ['p1r0.intero.sntss-receptor', 'INTERO', 'SNTSS_RECEPTOR_P1_R0', 'intero.body.frame.v1', 'SUMMARY']
].map(([routeId, producer, consumer, topic, topicClass]) => Object.freeze({
  routeId,
  producer,
  consumer,
  topic,
  topicClass,
  minDelayFrames: 1,
  revocable: true,
  requirement: consumer === 'SNTSS_RECEPTOR_P1_R0' ? 'GATED' : 'REQUIRED',
  stage: ROUTE_STAGE
}));

const ROUTES = Object.freeze(Object.fromEntries(routes.map(route => [route.routeId, route])));
const FORBIDDEN_EDGES = Object.freeze([
  'INTERO->HOMEOS',
  'SNTSS->METAB',
  'SNTSS->HOMEOS',
  'SNTSS->INTERO',
  'HOMEOS->CARD',
  'HOMEOS->RESP'
]);
const FORBIDDEN_EDGE_SET = new Set(FORBIDDEN_EDGES);

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function core(value) {
  return String(value || '').trim().toUpperCase().replaceAll('-', '_');
}

function routeFor(routeId) {
  const route = ROUTES[routeId];
  if (!route) fail('P1-R0 route is not registered', 'P1_ROUTE_UNKNOWN');
  return route;
}

function validateFrameRoute(frame) {
  const route = routeFor(frame.route.routeId);
  const producer = core(frame.producer.coreId);
  const consumer = core(frame.route.consumerCoreId);
  if (FORBIDDEN_EDGE_SET.has(`${producer}->${consumer}`)) {
    fail('P1-R0 edge is constitutionally forbidden', 'P1_ROUTE_FORBIDDEN');
  }
  if (
    route.producer !== producer ||
    route.consumer !== consumer ||
    route.topic !== frame.topic.name ||
    route.topicClass !== frame.topic.class
  ) {
    fail('P1-R0 frame does not match its closed route declaration', 'P1_ROUTE_MISMATCH');
  }
  if (frame.visibleFromFrame < frame.committedFrame + route.minDelayFrames) {
    fail('P1-R0 route delay is not satisfied', 'P1_ROUTE_DELAY');
  }
  return route;
}

module.exports = Object.freeze({
  ROUTE_STAGE,
  ROUTES,
  FORBIDDEN_EDGES,
  routeFor,
  validateFrameRoute
});
},
"runtime/p1-r0/homeos-contract.js": function(module, exports, __bundleRequire) {
'use strict';

const { stableStringify } = __bundleRequire("runtime/kernel/canonical-json.js");
const q48 = __bundleRequire("runtime/p1-r0/q16-48.js");
const { validateCausalFrame } = __bundleRequire("runtime/p1-r0/causal-frame.js");
const contract = __bundleRequire("runtime/p1-r0/homeos-contract.json");

const SCARCITY = new Set(['ABUNDANT', 'BALANCED', 'CONSERVING', 'DEPLETED', 'UNRESOLVED', 'PROTECTED']);
const SOURCE_BY_ROUTE = new Map(contract.sources.map(source => [source.routeId, Object.freeze(source)]));
const HOMEOS_PROFILE_FIELDS = new Set([
  'profileId', 'dimensions', 'minimumConfidenceQ48', 'adaptationConfidenceQ48',
  'holdFrames', 'adaptationMinimumFrames', 'maxAdaptationPer24hQ48',
  'maxLifetimeAdaptationQ48', 'numericPolicy', 'frameMs'
]);

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function exact(value, fields, label, code = 'P1_HOMEOS_CONTRACT_SCHEMA') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`, code);
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`${label} fields are not exact`, code);
  }
}

function clone(value) {
  return JSON.parse(stableStringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function raw(value, label, { minimum = q48.MIN_RAW, maximum = q48.MAX_RAW } = {}) {
  const parsed = q48.parseRaw(value);
  if (parsed < minimum || parsed > maximum) fail(`${label} is outside its contract range`, 'P1_HOMEOS_CONTRACT_RANGE');
  return parsed;
}

function unitInterval(value, label) {
  return raw(value, label, { minimum: 0n, maximum: q48.SCALE });
}

function validatePayload(source, frame) {
  exact(frame.payload, new Set(source.payloadFields), `${source.key} payload`, 'P1_HOMEOS_INPUT_SCHEMA');
  if (source.key === 'availability') {
    unitInterval(frame.payload.availabilityQ48, 'availability');
    raw(frame.payload.debtQ48, 'metabolic debt', { minimum: 0n });
    unitInterval(frame.payload.confidenceQ48, 'availability confidence');
    unitInterval(frame.payload.coverageQ48, 'availability coverage');
    if (!SCARCITY.has(frame.payload.scarcityState)) fail('availability scarcity state is invalid', 'P1_HOMEOS_INPUT_SCHEMA');
    if (
      frame.payload.confidenceQ48 !== frame.quality.confidenceQ48 ||
      frame.payload.coverageQ48 !== frame.quality.coverageQ48
    ) fail('availability quality disagrees with its frame', 'P1_HOMEOS_INPUT_QUALITY');
  } else {
    raw(frame.payload.reserveQ48, 'reserve', { minimum: 0n });
    unitInterval(frame.payload.reserveFractionQ48, 'reserve fraction');
    raw(frame.payload.trendQ48PerSecond, 'reserve trend');
    raw(frame.payload.cumulativeChargeQ48, 'cumulative reserve charge', { minimum: 0n });
    raw(frame.payload.cumulativeDischargeQ48, 'cumulative reserve discharge', { minimum: 0n });
    unitInterval(frame.payload.confidenceQ48, 'reserve confidence');
    if (frame.payload.confidenceQ48 !== frame.quality.confidenceQ48) {
      fail('reserve quality disagrees with its frame', 'P1_HOMEOS_INPUT_QUALITY');
    }
  }
}

function validateHomeosInputFrame(input, consumerFrame) {
  if (!Number.isSafeInteger(consumerFrame) || consumerFrame < 0) {
    fail('HOMEOS consumer frame is invalid', 'P1_HOMEOS_CONSUMER_FRAME');
  }
  const frame = validateCausalFrame(input);
  const source = SOURCE_BY_ROUTE.get(frame.route.routeId);
  if (!source) fail('frame is not a HOMEOS METAB input', 'P1_HOMEOS_INPUT_ROUTE');
  if (
    frame.producer.coreId.toUpperCase().replaceAll('-', '_') !== source.producer ||
    frame.producer.mode !== source.producerMode ||
    frame.route.consumerCoreId.toUpperCase().replaceAll('-', '_') !== contract.consumer ||
    frame.topic.name !== source.topic ||
    frame.topic.class !== source.topicClass ||
    frame.topic.schemaId !== source.schemaId ||
    frame.topic.schemaVersion !== '1' ||
    frame.topic.unit !== source.unit ||
    frame.topic.scale !== 'Q16.48'
  ) fail('HOMEOS input identity does not match its frozen source', 'P1_HOMEOS_INPUT_IDENTITY');
  if (frame.quality.status !== 'ACCEPT') fail('HOMEOS cannot consume unresolved METAB evidence', 'P1_HOMEOS_INPUT_UNKNOWN');
  if (consumerFrame < frame.visibleFromFrame || consumerFrame < frame.committedFrame + contract.consumerDelayFrames) {
    fail('HOMEOS cannot consume a same-frame or future METAB summary', 'P1_HOMEOS_INPUT_DELAY');
  }
  validatePayload(source, frame);
  return deepFreeze({ source: source.key, frame });
}

function collectHomeosInputs(inputs, consumerFrame) {
  if (!Array.isArray(inputs) || inputs.length !== contract.sources.length) {
    fail('HOMEOS requires exactly one frame from each METAB source', 'P1_HOMEOS_INPUT_COVERAGE');
  }
  const validated = inputs.map(input => validateHomeosInputFrame(input, consumerFrame));
  const bySource = new Map();
  for (const item of validated) {
    if (bySource.has(item.source)) fail('HOMEOS received duplicate canonical METAB evidence', 'P1_HOMEOS_INPUT_CONFLICT');
    bySource.set(item.source, item.frame);
  }
  if (bySource.size !== contract.sources.length || contract.sources.some(source => !bySource.has(source.key))) {
    fail('HOMEOS source coverage is incomplete', 'P1_HOMEOS_INPUT_COVERAGE');
  }
  const [first, ...rest] = [...bySource.values()];
  for (const frame of rest) {
    for (const field of ['organismId', 'founderLineageId', 'committedFrame']) {
      if (frame[field] !== first[field]) fail('HOMEOS METAB evidence is not frame-coherent', 'P1_HOMEOS_INPUT_COHERENCE');
    }
    for (const field of ['coreId', 'residencyId', 'coreVersion', 'authorityEpoch', 'mode']) {
      if (frame.producer[field] !== first.producer[field]) fail('HOMEOS METAB producer identity is incoherent', 'P1_HOMEOS_INPUT_COHERENCE');
    }
  }
  return deepFreeze({
    consumerFrame,
    producer: clone(first.producer),
    committedFrame: first.committedFrame,
    availability: clone(bySource.get('availability').payload),
    reserve: clone(bySource.get('reserve').payload),
    evidence: contract.sources.map(source => Object.freeze({
      routeId: source.routeId,
      frameId: bySource.get(source.key).frameId,
      producerSequence: bySource.get(source.key).producerSequence
    }))
  });
}

function validateHomeosFounderProfile(input) {
  exact(input, HOMEOS_PROFILE_FIELDS, 'HOMEOS founder profile');
  if (
    input.frameMs !== 250 ||
    input.holdFrames !== 4 ||
    input.numericPolicy !== 'Q16.48-half-even-saturating-v1' ||
    !Number.isSafeInteger(input.adaptationMinimumFrames) ||
    input.adaptationMinimumFrames < 172800
  ) fail('HOMEOS founder policy is invalid', 'P1_HOMEOS_PROFILE');
  for (const field of ['minimumConfidenceQ48', 'adaptationConfidenceQ48', 'maxAdaptationPer24hQ48', 'maxLifetimeAdaptationQ48']) {
    unitInterval(input[field], `HOMEOS ${field}`);
  }
  if (!Array.isArray(input.dimensions) || input.dimensions.length !== contract.sources.length) {
    fail('HOMEOS must have exactly the reviewed METAB dimensions', 'P1_HOMEOS_PROFILE');
  }
  const identities = new Set();
  for (const dimension of input.dimensions) {
    const source = contract.sources.find(candidate => candidate.topic === dimension?.source?.topic);
    if (
      !source ||
      dimension.dimensionId !== source.dimensionId ||
      dimension.source.producerCoreId !== source.producer ||
      dimension.source.schemaId !== source.schemaId ||
      dimension.source.mode !== source.producerMode
    ) {
      fail('HOMEOS dimension source is not canonical METAB evidence', 'P1_HOMEOS_PROFILE_SOURCE');
    }
    if (identities.has(source.key)) fail('HOMEOS has two canonical sources for one dimension', 'P1_HOMEOS_PROFILE_SOURCE');
    identities.add(source.key);
  }
  return deepFreeze(clone(input));
}

module.exports = Object.freeze({
  contract: deepFreeze(clone(contract)),
  validateHomeosInputFrame,
  collectHomeosInputs,
  validateHomeosFounderProfile
});
},
"runtime/p1-r0/homeos-contract.json": function(module, exports, __bundleRequire) {
module.exports = {"coherence":["same organism","same METAB founder lineage","same METAB residency","same authority epoch","same committed frame","exactly one frame per source"],"consumer":"HOMEOS","consumerDelayFrames":1,"contractVersion":"P1-R0-HOMEOS-METAB-INPUT-v1","forbiddenHomeosSemantics":["heartRate","respiratoryRate","temperature","emotion","cause","self","action"],"forbiddenInputFields":["viewerId","viewerCount","payment","owner"],"laboratoryOnly":true,"routeStage":"ABSENT","sources":[{"dimensionId":"energy.availability","key":"availability","payloadFields":["availabilityQ48","confidenceQ48","coverageQ48","debtQ48","scarcityState"],"producer":"METAB","producerMode":"SHADOW","routeId":"p1r0.metab-availability.homeos","schemaId":"urn:stay:p1-r0:schema:metab-energy-availability-payload:v1","topic":"metab.energy.availability.v1","topicClass":"SUMMARY","unit":"ratio"},{"dimensionId":"energy.reserve","key":"reserve","payloadFields":["confidenceQ48","cumulativeChargeQ48","cumulativeDischargeQ48","reserveFractionQ48","reserveQ48","trendQ48PerSecond"],"producer":"METAB","producerMode":"SHADOW","routeId":"p1r0.metab-reserve.homeos","schemaId":"urn:stay:p1-r0:schema:metab-energy-reserve-payload:v1","topic":"metab.energy.reserve.v1","topicClass":"SUMMARY","unit":"ratio"}]};
},
"runtime/p1-r0/homeos-engine.js": function(module, exports, __bundleRequire) {
'use strict';

const crypto = require('node:crypto');
const { stableStringify } = __bundleRequire("runtime/kernel/canonical-json.js");
const q48 = __bundleRequire("runtime/p1-r0/q16-48.js");
const { validateCausalFrame } = __bundleRequire("runtime/p1-r0/causal-frame.js");
const { collectHomeosInputs, validateHomeosFounderProfile } = __bundleRequire("runtime/p1-r0/homeos-contract.js");

const OPTION_FIELDS = new Set(['profile', 'identity']);
const IDENTITY_FIELDS = new Set([
  'organismId', 'founderLineageId', 'residencyId', 'coreVersion', 'authorityEpoch', 'mode'
]);
const ADVANCE_FIELDS = new Set(['frameIndex', 'inputs']);
const STATE_FIELDS = new Set([
  'frameIndex', 'dimensions', 'stabilityLoadQ48', 'lifecycle', 'inputCursors', 'outputSequence'
]);
const DIMENSION_STATE_FIELDS = new Set([
  'dimensionId', 'filteredQ48', 'deviationQ48', 'burdenLowQ48', 'burdenHighQ48',
  'pressureQ48', 'adaptedCenterQ48', 'lifetimeDriftQ48', 'quality', 'sourceSequence'
]);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const QUALITY = new Set(['ACCEPT', 'HOLD', 'UNKNOWN', 'QUARANTINE']);

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function exact(value, fields, label, code = 'P1_HOMEOS_ENGINE_SCHEMA') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`, code);
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`${label} fields are not exact`, code);
  }
}

function clone(value) {
  return JSON.parse(stableStringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`, 'P1_HOMEOS_ENGINE_SCHEMA');
  return value;
}

function raw(value, label, minimum = q48.MIN_RAW, maximum = q48.MAX_RAW) {
  const parsed = q48.parseRaw(value);
  if (parsed < minimum || parsed > maximum) fail(`${label} is outside its range`, 'P1_HOMEOS_ENGINE_RANGE');
  return parsed;
}

function unit(value, label) {
  return raw(value, label, 0n, q48.SCALE);
}

function minimum(left, right) {
  return left < right ? left : right;
}

function maximum(left, right) {
  return left > right ? left : right;
}

function validateIdentity(input) {
  exact(input, IDENTITY_FIELDS, 'HOMEOS identity', 'P1_HOMEOS_IDENTITY');
  for (const field of ['organismId', 'founderLineageId', 'residencyId', 'coreVersion']) {
    if (typeof input[field] !== 'string' || !SAFE_ID.test(input[field])) fail(`HOMEOS ${field} is invalid`, 'P1_HOMEOS_IDENTITY');
  }
  if (input.authorityEpoch !== '0') fail('laboratory HOMEOS must own zero authority', 'P1_HOMEOS_AUTHORITY');
  if (!['NEUTRAL', 'SHADOW'].includes(input.mode)) fail('laboratory HOMEOS mode is invalid', 'P1_HOMEOS_AUTHORITY');
  return deepFreeze(clone(input));
}

function descriptorCenter(descriptor) {
  const low = raw(descriptor.targetLowQ48, 'HOMEOS target low');
  const high = raw(descriptor.targetHighQ48, 'HOMEOS target high');
  if (high < low) fail('HOMEOS target band is inverted', 'P1_HOMEOS_PROFILE');
  return q48.roundHalfEven(low + high, 2n);
}

function initialState(profile) {
  return {
    frameIndex: 0,
    dimensions: profile.dimensions.map(descriptor => {
      const center = descriptorCenter(descriptor).toString();
      return {
        dimensionId: descriptor.dimensionId,
        filteredQ48: center,
        deviationQ48: '0',
        burdenLowQ48: '0',
        burdenHighQ48: '0',
        pressureQ48: '0',
        adaptedCenterQ48: center,
        lifetimeDriftQ48: '0',
        quality: 'UNKNOWN',
        sourceSequence: '0'
      };
    }),
    stabilityLoadQ48: '0',
    lifecycle: 'INITIALIZING',
    inputCursors: {
      'p1r0.metab-availability.homeos': '0',
      'p1r0.metab-reserve.homeos': '0'
    },
    outputSequence: '0'
  };
}

function validateState(input, profile) {
  exact(input, STATE_FIELDS, 'HOMEOS state', 'P1_HOMEOS_STATE');
  integer(input.frameIndex, 'HOMEOS state frame');
  unit(input.stabilityLoadQ48, 'HOMEOS stability load');
  if (!['INITIALIZING', 'STABLE', 'STRAINED', 'UNRESOLVED', 'PROTECTED', 'RECOVERING'].includes(input.lifecycle)) {
    fail('HOMEOS state lifecycle is invalid', 'P1_HOMEOS_STATE');
  }
  if (!Array.isArray(input.dimensions) || input.dimensions.length !== profile.dimensions.length) {
    fail('HOMEOS state dimensions are invalid', 'P1_HOMEOS_STATE');
  }
  for (let index = 0; index < input.dimensions.length; index += 1) {
    const dimension = input.dimensions[index];
    exact(dimension, DIMENSION_STATE_FIELDS, 'HOMEOS dimension state', 'P1_HOMEOS_STATE');
    if (dimension.dimensionId !== profile.dimensions[index].dimensionId || !QUALITY.has(dimension.quality)) {
      fail('HOMEOS dimension identity or quality is invalid', 'P1_HOMEOS_STATE');
    }
    raw(dimension.filteredQ48, 'HOMEOS filtered state');
    raw(dimension.deviationQ48, 'HOMEOS deviation');
    unit(dimension.burdenLowQ48, 'HOMEOS low burden');
    unit(dimension.burdenHighQ48, 'HOMEOS high burden');
    unit(dimension.pressureQ48, 'HOMEOS pressure');
    raw(dimension.adaptedCenterQ48, 'HOMEOS adapted center');
    raw(dimension.lifetimeDriftQ48, 'HOMEOS lifetime drift');
    if (!/^(0|[1-9][0-9]*)$/.test(dimension.sourceSequence)) fail('HOMEOS source sequence is invalid', 'P1_HOMEOS_STATE');
  }
  if (!input.inputCursors || typeof input.inputCursors !== 'object' || Array.isArray(input.inputCursors)) {
    fail('HOMEOS state cursors are invalid', 'P1_HOMEOS_STATE');
  }
  if (!/^(0|[1-9][0-9]*)$/.test(input.outputSequence)) fail('HOMEOS output sequence is invalid', 'P1_HOMEOS_STATE');
  return clone(input);
}

function sourceValue(dimensionId, collected) {
  if (dimensionId === 'energy.availability') return collected.availability.availabilityQ48;
  if (dimensionId === 'energy.reserve') return collected.reserve.reserveFractionQ48;
  fail('HOMEOS dimension lacks a reviewed METAB source', 'P1_HOMEOS_PROFILE_SOURCE');
}

function updateBurden(previous, active, loadRate, reliefRate, magnitude, frameFraction) {
  if (active) {
    const increment = q48.mul(q48.mul(loadRate, magnitude), frameFraction);
    return q48.clamp(q48.saturatingAdd(previous, increment), 0n, q48.SCALE);
  }
  const relief = q48.mul(reliefRate, frameFraction);
  return previous > relief ? previous - relief : 0n;
}

function updateDimension(previous, descriptor, value, sourceFrame, frameFraction) {
  const sample = unit(value, `HOMEOS ${descriptor.dimensionId} sample`);
  const alpha = unit(descriptor.alphaQ48, `HOMEOS ${descriptor.dimensionId} alpha`);
  const oldFiltered = raw(previous.filteredQ48, 'HOMEOS previous filtered state');
  const filtered = q48.add(oldFiltered, q48.mul(alpha, sample - oldFiltered));
  const targetLow = raw(descriptor.targetLowQ48, 'HOMEOS target low');
  const targetHigh = raw(descriptor.targetHighQ48, 'HOMEOS target high');
  const lowMagnitude = filtered < targetLow ? targetLow - filtered : 0n;
  const highMagnitude = filtered > targetHigh ? filtered - targetHigh : 0n;
  const deviation = lowMagnitude > 0n ? -lowMagnitude : highMagnitude;
  const loadRate = unit(descriptor.loadRateQ48, 'HOMEOS load rate');
  const reliefRate = unit(descriptor.reliefRateQ48, 'HOMEOS relief rate');
  const burdenLow = updateBurden(unit(previous.burdenLowQ48, 'HOMEOS prior low burden'), lowMagnitude > 0n, loadRate, reliefRate, lowMagnitude, frameFraction);
  const burdenHigh = updateBurden(unit(previous.burdenHighQ48, 'HOMEOS prior high burden'), highMagnitude > 0n, loadRate, reliefRate, highMagnitude, frameFraction);
  const proportional = q48.mul(unit(descriptor.pressureKpQ48, 'HOMEOS pressure kp'), maximum(lowMagnitude, highMagnitude));
  const burden = q48.clamp(burdenLow + burdenHigh, 0n, q48.SCALE);
  const accumulated = q48.mul(unit(descriptor.pressureKbQ48, 'HOMEOS pressure kb'), burden);
  const pressure = q48.clamp(proportional + accumulated, 0n, q48.SCALE);
  return {
    state: {
      dimensionId: descriptor.dimensionId,
      filteredQ48: filtered.toString(),
      deviationQ48: deviation.toString(),
      burdenLowQ48: burdenLow.toString(),
      burdenHighQ48: burdenHigh.toString(),
      pressureQ48: pressure.toString(),
      adaptedCenterQ48: previous.adaptedCenterQ48,
      lifetimeDriftQ48: previous.lifetimeDriftQ48,
      quality: 'ACCEPT',
      sourceSequence: sourceFrame.producerSequence
    },
    summary: {
      dimensionId: descriptor.dimensionId,
      filteredQ48: filtered.toString(),
      deviationQ48: deviation.toString(),
      burdenLowQ48: burdenLow.toString(),
      burdenHighQ48: burdenHigh.toString(),
      pressureQ48: pressure.toString(),
      recoveryEligible: lowMagnitude === 0n && highMagnitude === 0n && burden > 0n,
      confidenceQ48: sourceFrame.quality.confidenceQ48,
      coverageQ48: sourceFrame.quality.coverageQ48
    },
    pressure,
    weight: unit(descriptor.weightQ48, 'HOMEOS dimension weight')
  };
}

function ancestors(inputs) {
  return inputs.map(frame => ({
    producerCoreId: 'METAB',
    residencyId: frame.producer.residencyId,
    topic: frame.topic.name,
    routeId: frame.route.routeId,
    producerSequence: frame.producerSequence,
    sourceWindow: clone(frame.sourceWindow),
    mode: frame.producer.mode,
    shadowAncestry: true,
    confidenceQ48: frame.quality.confidenceQ48
  }));
}

function buildFrame({ identity, state, routeId, topic, schemaId, payload, sequence, inputs, confidenceQ48, coverageQ48 }) {
  const sourceFrame = inputs[0].committedFrame;
  const causalAncestors = ancestors(inputs);
  const earliest = Math.min(sourceFrame, ...causalAncestors.map(value => value.sourceWindow.startFrame));
  const withoutId = {
    frameVersion: 'stay-p1-r0-causal-frame-v1',
    organismId: identity.organismId,
    founderLineageId: identity.founderLineageId,
    producer: {
      coreId: 'HOMEOS',
      residencyId: identity.residencyId,
      coreVersion: identity.coreVersion,
      authorityEpoch: identity.authorityEpoch,
      mode: identity.mode,
      lifecycle: state.lifecycle
    },
    route: { routeId, consumerCoreId: 'INTERO', routeVersion: '1' },
    topic: { name: topic, class: 'SUMMARY', schemaId, schemaVersion: '1', unit: 'ratio', scale: 'Q16.48' },
    producerSequence: sequence.toString(),
    committedFrame: state.frameIndex,
    visibleFromFrame: state.frameIndex + 1,
    sourceWindow: { startFrame: sourceFrame, endFrame: sourceFrame },
    causalSpan: {
      earliestFrame: earliest,
      latestFrame: sourceFrame,
      containsNeutral: false,
      containsShadow: true,
      ancestors: causalAncestors
    },
    quality: { status: 'ACCEPT', confidenceQ48, coverageQ48, reasons: [] },
    expiresAtFrame: null,
    payload,
    payloadHash: sha256(payload)
  };
  return validateCausalFrame({ frameId: sha256(withoutId), ...withoutId });
}

function createHomeosEngine(options = {}) {
  exact(options, OPTION_FIELDS, 'HOMEOS engine options', 'P1_HOMEOS_OPTIONS');
  const profile = validateHomeosFounderProfile(options.profile);
  const identity = validateIdentity(options.identity);
  const frameFraction = q48.fromDecimal('0.25');
  let state = initialState(profile);
  const seen = new Map();

  function snapshot() {
    return deepFreeze(clone(state));
  }

  function restore(input) {
    const next = validateState(input, profile);
    if (
      next.frameIndex < state.frameIndex ||
      BigInt(next.outputSequence) < BigInt(state.outputSequence) ||
      next.dimensions.some((dimension, index) =>
        unit(dimension.burdenLowQ48, 'HOMEOS restored low burden') < unit(state.dimensions[index].burdenLowQ48, 'HOMEOS current low burden') ||
        unit(dimension.burdenHighQ48, 'HOMEOS restored high burden') < unit(state.dimensions[index].burdenHighQ48, 'HOMEOS current high burden') ||
        dimension.adaptedCenterQ48 !== state.dimensions[index].adaptedCenterQ48 ||
        dimension.lifetimeDriftQ48 !== state.dimensions[index].lifetimeDriftQ48
      )
    ) fail('HOMEOS restore would rewind acquired burden or adaptation', 'P1_HOMEOS_REWIND');
    state = next;
    return snapshot();
  }

  function advance(input) {
    exact(input, ADVANCE_FIELDS, 'HOMEOS advance input');
    const frameIndex = integer(input.frameIndex, 'HOMEOS frame index', 1);
    if (input.inputs !== null && !Array.isArray(input.inputs)) fail('HOMEOS inputs are invalid', 'P1_HOMEOS_ENGINE_SCHEMA');
    const inputHash = input.inputs === null ? null : sha256(input.inputs);
    if (inputHash && seen.has(inputHash)) return deepFreeze({ state: snapshot(), outputs: [], duplicate: true });
    if (
      (state.frameIndex === 0 && frameIndex < 1) ||
      (state.frameIndex !== 0 && frameIndex !== state.frameIndex + 1)
    ) fail('HOMEOS frame progression is not contiguous', 'P1_HOMEOS_FRAME_SEQUENCE');

    if (input.inputs === null) {
      state = {
        ...state,
        frameIndex,
        dimensions: state.dimensions.map(dimension => ({ ...dimension, quality: 'UNKNOWN' })),
        lifecycle: 'UNRESOLVED'
      };
      return deepFreeze({ state: snapshot(), outputs: [], duplicate: false });
    }

    const collected = collectHomeosInputs(input.inputs, frameIndex);
    if (input.inputs.some(frame => frame.organismId !== identity.organismId)) {
      fail('HOMEOS cannot consume evidence from another organism', 'P1_HOMEOS_INPUT_IDENTITY');
    }
    const minimumConfidence = unit(profile.minimumConfidenceQ48, 'HOMEOS minimum confidence');
    if (input.inputs.some(frame => unit(frame.quality.confidenceQ48, 'HOMEOS source confidence') < minimumConfidence)) {
      fail('HOMEOS source confidence is below its founder minimum', 'P1_HOMEOS_INPUT_CONFIDENCE');
    }
    seen.set(inputHash, true);
    const byTopic = new Map(input.inputs.map(frame => [frame.topic.name, frame]));
    const updates = profile.dimensions.map((descriptor, index) => {
      const sourceFrame = byTopic.get(descriptor.source.topic);
      if (!sourceFrame) fail('HOMEOS source disappeared after contract validation', 'P1_HOMEOS_INPUT_COVERAGE');
      return updateDimension(state.dimensions[index], descriptor, sourceValue(descriptor.dimensionId, collected), sourceFrame, frameFraction);
    });
    const totalWeight = updates.reduce((sum, update) => sum + update.weight, 0n);
    const weightedPressure = updates.reduce((sum, update) => sum + q48.mul(update.pressure, update.weight), 0n);
    const stabilityLoad = totalWeight === 0n ? 0n : q48.clamp(q48.div(weightedPressure, totalWeight), 0n, q48.SCALE);
    const activePressureCount = updates.filter(update => update.pressure > 0n).length;
    const previousLifecycle = state.lifecycle;
    let lifecycle = activePressureCount > 0 ? 'STRAINED' : previousLifecycle === 'STRAINED' ? 'RECOVERING' : 'STABLE';
    const confidence = input.inputs.reduce((value, frame) => minimum(value, unit(frame.quality.confidenceQ48, 'HOMEOS confidence')), q48.SCALE);
    const coverage = input.inputs.reduce((value, frame) => minimum(value, unit(frame.quality.coverageQ48, 'HOMEOS coverage')), q48.SCALE);
    state = {
      frameIndex,
      dimensions: updates.map(update => update.state),
      stabilityLoadQ48: stabilityLoad.toString(),
      lifecycle,
      inputCursors: Object.fromEntries(input.inputs.map(frame => [frame.route.routeId, frame.producerSequence]).sort(([left], [right]) => left.localeCompare(right))),
      outputSequence: state.outputSequence
    };

    const outputs = [];
    if (identity.mode === 'SHADOW') {
      let sequence = BigInt(state.outputSequence);
      for (const update of updates) {
        sequence += 1n;
        outputs.push(buildFrame({
          identity,
          state,
          routeId: 'p1r0.homeos-dimension.intero',
          topic: 'homeos.dimension.summary.v1',
          schemaId: 'urn:stay:p1-r0:schema:homeos-dimension-summary-payload:v1',
          payload: update.summary,
          sequence,
          inputs: input.inputs,
          confidenceQ48: update.summary.confidenceQ48,
          coverageQ48: update.summary.coverageQ48
        }));
      }
      sequence += 1n;
      outputs.push(buildFrame({
        identity,
        state,
        routeId: 'p1r0.homeos-stability.intero',
        topic: 'homeos.stability.summary.v1',
        schemaId: 'urn:stay:p1-r0:schema:homeos-stability-summary-payload:v1',
        payload: {
          stabilityLoadQ48: state.stabilityLoadQ48,
          state: lifecycle,
          activePressureCount,
          confidenceQ48: confidence.toString(),
          coverageQ48: coverage.toString()
        },
        sequence,
        inputs: input.inputs,
        confidenceQ48: confidence.toString(),
        coverageQ48: coverage.toString()
      }));
      state.outputSequence = sequence.toString();
    }
    return deepFreeze({ state: snapshot(), outputs: deepFreeze(outputs), duplicate: false });
  }

  return Object.freeze({ advance, snapshot, restore });
}

module.exports = Object.freeze({ createHomeosEngine });
},
"runtime/p1-r0/q16-48.js": function(module, exports, __bundleRequire) {
'use strict';

const FRACTION_BITS = 48n;
const SCALE = 1n << FRACTION_BITS;
const MIN_RAW = -(1n << 63n);
const MAX_RAW = (1n << 63n) - 1n;
const CANONICAL_RAW = /^(0|-?[1-9][0-9]*)$/;
const DECIMAL = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function checked(value) {
  if (typeof value !== 'bigint') {
    fail('Q16.48 raw value must be a bigint', 'P1_Q48_TYPE');
  }
  if (value < MIN_RAW || value > MAX_RAW) {
    fail('Q16.48 raw value overflowed signed 64-bit storage', 'P1_Q48_OVERFLOW');
  }
  return value;
}

function parseRaw(value) {
  if (typeof value !== 'string' || value.length > 20 || !CANONICAL_RAW.test(value) || value === '-0') {
    fail('Q16.48 transport value is not canonical', 'P1_Q48_CANONICAL');
  }
  return checked(BigInt(value));
}

function roundHalfEven(numerator, denominator) {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint') {
    fail('Q16.48 rounding operands must be bigint', 'P1_Q48_TYPE');
  }
  if (denominator === 0n) fail('Q16.48 division by zero', 'P1_Q48_DIV_ZERO');
  let left = numerator;
  let right = denominator;
  if (right < 0n) {
    left = -left;
    right = -right;
  }
  const negative = left < 0n;
  const magnitude = negative ? -left : left;
  let quotient = magnitude / right;
  const remainder = magnitude % right;
  const comparison = remainder * 2n - right;
  if (comparison > 0n || (comparison === 0n && quotient % 2n === 1n)) quotient += 1n;
  return negative ? -quotient : quotient;
}

function fromDecimal(value) {
  if (typeof value !== 'string' || value.length > 96) fail('Q16.48 decimal must be a bounded string', 'P1_Q48_DECIMAL');
  const match = DECIMAL.exec(value);
  if (!match || value === '-0') fail('Q16.48 decimal is invalid', 'P1_Q48_DECIMAL');
  const fraction = match[3] || '';
  const denominator = 10n ** BigInt(fraction.length);
  const digits = BigInt(match[2] + fraction);
  const numerator = (match[1] === '-' ? -digits : digits) * SCALE;
  return checked(roundHalfEven(numerator, denominator));
}

function add(left, right) {
  return checked(checked(left) + checked(right));
}

function subtract(left, right) {
  return checked(checked(left) - checked(right));
}

function mul(left, right) {
  return checked(roundHalfEven(checked(left) * checked(right), SCALE));
}

function div(left, right) {
  checked(left);
  checked(right);
  if (right === 0n) fail('Q16.48 division by zero', 'P1_Q48_DIV_ZERO');
  return checked(roundHalfEven(left * SCALE, right));
}

function quantize(value, step) {
  checked(value);
  checked(step);
  if (step <= 0n) fail('Q16.48 quantization step must be positive', 'P1_Q48_STEP');
  return checked(roundHalfEven(value, step) * step);
}

function clamp(value, minimum = MIN_RAW, maximum = MAX_RAW) {
  checked(value);
  checked(minimum);
  checked(maximum);
  if (minimum > maximum) fail('Q16.48 clamp range is invalid', 'P1_Q48_RANGE');
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function saturatingAdd(left, right) {
  checked(left);
  checked(right);
  const result = left + right;
  return result < MIN_RAW ? MIN_RAW : result > MAX_RAW ? MAX_RAW : result;
}

function saturatingSubtract(left, right) {
  checked(left);
  checked(right);
  const result = left - right;
  return result < MIN_RAW ? MIN_RAW : result > MAX_RAW ? MAX_RAW : result;
}

module.exports = Object.freeze({
  FRACTION_BITS,
  SCALE,
  MIN_RAW,
  MAX_RAW,
  checked,
  parseRaw,
  roundHalfEven,
  fromDecimal,
  add,
  subtract,
  mul,
  div,
  quantize,
  clamp,
  saturatingAdd,
  saturatingSubtract
});
},
"runtime/p1-r0/resident-support.js": function(module, exports, __bundleRequire) {
'use strict';

const crypto = require('node:crypto');
const { stableStringify } = __bundleRequire("runtime/kernel/canonical-json.js");
const { validateCausalFrame } = __bundleRequire("runtime/p1-r0/causal-frame.js");
const { validateFrameRoute } = __bundleRequire("runtime/p1-r0/contract-registry.js");

const FOUNDER_TOPICS = Object.freeze({
  METAB: 'p1r0.metab.founder.binding.v1',
  HOMEOS: 'p1r0.homeos.founder.binding.v1',
  INTERO: 'p1r0.intero.founder.binding.v1'
});
const HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const FOUNDER_FIELDS = new Set([
  'recordVersion', 'coreId', 'organismId', 'organismIdentityHash',
  'founderId', 'lineageId', 'residencyId', 'profileId', 'profileHash',
  'profile', 'mode', 'authorityEpoch'
]);

const RESOURCES = Object.freeze({
  softRamMiB: 64,
  hardRamMiB: 96,
  softCpuPercent: 5,
  hardCpuPercent: 20,
  pidsMax: 16,
  queueCapacity: 256,
  handlerTimeoutMs: 250,
  healthTimeoutMs: 1000,
  outputCapacity: 128,
  outputLimitPerEvent: 16,
  outputBytesPerEvent: 65536,
  storageMiB: 4,
  maxRestarts: 4,
  restartWindowMs: 60_000,
  restartBackoffMs: 250
});

function fail(message, code = 'P1_RESIDENT_SCHEMA') {
  throw Object.assign(new Error(message), { code });
}

function clone(value) {
  return JSON.parse(stableStringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function exact(value, fields, label, code = 'P1_RESIDENT_SCHEMA') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`, code);
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`${label} fields are not exact`, code);
  }
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function normalizeRuntimeBinding(payload) {
  const canonical = payload && typeof payload === 'object' && !Array.isArray(payload) &&
    Object.keys(payload).length === 3 &&
    Object.hasOwn(payload, 'identitySha256') &&
    Object.hasOwn(payload, 'organismLineage') &&
    Object.hasOwn(payload, 'runtimeRevision');
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    (!canonical && payload.bindingVersion !== 1) ||
    typeof payload.identitySha256 !== 'string' ||
    !HASH.test(payload.identitySha256) ||
    payload.organismLineage !== 'STAY/Genesis' ||
    !Number.isSafeInteger(payload.runtimeRevision) ||
    payload.runtimeRevision < 1
  ) fail('P1 resident runtime binding is invalid', 'P1_RESIDENT_RUNTIME_BINDING');
  return deepFreeze({
    identitySha256: payload.identitySha256,
    organismLineage: payload.organismLineage,
    runtimeRevision: payload.runtimeRevision
  });
}

function normalizeFounderBinding(payload, { coreId, residencyId, runtimeBinding }) {
  exact(payload, FOUNDER_FIELDS, 'P1 resident founder binding', 'P1_RESIDENT_FOUNDER');
  if (
    payload.recordVersion !== 'P1ResidentFounderBindingV1' ||
    payload.coreId !== coreId ||
    payload.residencyId !== residencyId ||
    payload.mode !== 'SHADOW' ||
    payload.authorityEpoch !== '0' ||
    !runtimeBinding ||
    payload.organismIdentityHash !== runtimeBinding.identitySha256
  ) fail('P1 resident founder binding identity is invalid', 'P1_RESIDENT_FOUNDER');
  for (const field of ['organismId', 'founderId', 'lineageId', 'residencyId', 'profileId']) {
    safeId(payload[field], `P1 founder ${field}`);
  }
  if (!HASH.test(payload.organismIdentityHash) || !HASH.test(payload.profileHash)) {
    fail('P1 resident founder hash is invalid', 'P1_RESIDENT_FOUNDER');
  }
  if (!payload.profile || typeof payload.profile !== 'object' || Array.isArray(payload.profile)) {
    fail('P1 resident founder profile is invalid', 'P1_RESIDENT_FOUNDER');
  }
  if (payload.profile.profileId !== payload.profileId || sha256(payload.profile) !== payload.profileHash) {
    fail('P1 resident founder profile binding is invalid', 'P1_RESIDENT_FOUNDER');
  }
  return deepFreeze(clone(payload));
}

function engineIdentity(founder, version) {
  return deepFreeze({
    organismId: founder.organismId,
    founderLineageId: founder.lineageId,
    residencyId: founder.residencyId,
    coreVersion: version,
    authorityEpoch: '0',
    mode: 'SHADOW'
  });
}

function frameFromEvent(event, consumerCoreId) {
  const payload = event?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('P1 resident causal-frame payload is invalid', 'P1_RESIDENT_FRAME');
  }
  const frame = validateCausalFrame(payload);
  validateFrameRoute(frame);
  if (frame.route?.consumerCoreId !== consumerCoreId) return null;
  return frame;
}

function boundedInsert(record, key, value, maximum = 16) {
  if (!Object.hasOwn(record, key) && Object.keys(record).length >= maximum) {
    fail('P1 resident pending-frame bound exceeded', 'P1_RESIDENT_PENDING_BOUND');
  }
  const existing = record[key];
  const digest = sha256(value);
  if (existing && sha256(existing) !== digest) {
    fail('P1 resident pending frame conflicts with retained evidence', 'P1_RESIDENT_REPLAY_CONFLICT');
  }
  record[key] = clone(value);
}

module.exports = Object.freeze({
  FOUNDER_TOPICS,
  RESOURCES,
  boundedInsert,
  clone,
  deepFreeze,
  engineIdentity,
  exact,
  fail,
  frameFromEvent,
  normalizeFounderBinding,
  normalizeRuntimeBinding,
  sha256
});
},
"runtime/p1-r0/residents/homeos-neutral.js": function(module, exports, __bundleRequire) {
'use strict';

const { stableStringify } = __bundleRequire("runtime/kernel/canonical-json.js");
const { createHomeosEngine } = __bundleRequire("runtime/p1-r0/homeos-engine.js");
const {
  RESOURCES,
  boundedInsert,
  clone,
  deepFreeze,
  exact,
  fail,
  frameFromEvent,
  normalizeRuntimeBinding,
  sha256
} = __bundleRequire("runtime/p1-r0/resident-support.js");

const CORE_ID = 'HOMEOS';
const RESIDENCY_ID = 'resident:homeos';
const VERSION = '0.1.0-p1r0-neutral.1';
const STAGE = 'p1-r0-production-neutral-r143';
const AVAILABILITY_TOPIC = 'metab.energy.availability.v1';
const RESERVE_TOPIC = 'metab.energy.reserve.v1';
const FOUNDER_FIELDS = new Set([
  'recordVersion', 'coreId', 'organismId', 'organismIdentityHash',
  'founderId', 'lineageId', 'residencyId', 'profileId', 'profileHash',
  'profile', 'mode', 'authorityEpoch'
]);
const STATE_FIELDS = new Set([
  'schema', 'runtimeBinding', 'founder', 'engineState', 'pendingAvailability',
  'pendingReserve', 'handledEvents'
]);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

const manifest = Object.freeze({
  coreId: CORE_ID,
  version: VERSION,
  protocol: 'stay-p1-r0-resident-v1',
  stateSchema: 1,
  hotSwap: true,
  priority: 'optional',
  stage: STAGE,
  productionEligible: false,
  inputs: Object.freeze([
    'runtime.organism.binding',
    AVAILABILITY_TOPIC,
    RESERVE_TOPIC
  ]),
  outputs: Object.freeze([]),
  biology: Object.freeze({
    protocol: 'stay-biological-signalling-fabric-v1',
    producerCapabilities: Object.freeze([]),
    consumerRouteLeases: Object.freeze([])
  }),
  resources: RESOURCES
});

function normalizeNeutralFounder(payload, runtimeBinding) {
  exact(payload, FOUNDER_FIELDS, 'HOMEOS neutral founder binding', 'P1_HOMEOS_NEUTRAL_FOUNDER');
  if (
    payload.recordVersion !== 'P1ResidentFounderBindingV1' ||
    payload.coreId !== CORE_ID ||
    payload.residencyId !== RESIDENCY_ID ||
    payload.mode !== 'NEUTRAL' ||
    payload.authorityEpoch !== '0' ||
    !runtimeBinding ||
    payload.organismIdentityHash !== runtimeBinding.identitySha256
  ) fail('HOMEOS neutral founder identity is invalid', 'P1_HOMEOS_NEUTRAL_FOUNDER');
  for (const field of ['organismId', 'founderId', 'lineageId', 'residencyId', 'profileId']) {
    if (typeof payload[field] !== 'string' || !SAFE_ID.test(payload[field])) {
      fail(`HOMEOS neutral founder ${field} is invalid`, 'P1_HOMEOS_NEUTRAL_FOUNDER');
    }
  }
  if (
    !HASH.test(String(payload.organismIdentityHash || '')) ||
    !HASH.test(String(payload.profileHash || '')) ||
    !payload.profile ||
    typeof payload.profile !== 'object' ||
    Array.isArray(payload.profile) ||
    payload.profile.profileId !== payload.profileId ||
    sha256(payload.profile) !== payload.profileHash
  ) fail('HOMEOS neutral founder profile binding is invalid', 'P1_HOMEOS_NEUTRAL_FOUNDER');
  return deepFreeze(clone(payload));
}

function engineIdentity(founder) {
  return deepFreeze({
    organismId: founder.organismId,
    founderLineageId: founder.lineageId,
    residencyId: founder.residencyId,
    coreVersion: VERSION,
    authorityEpoch: '0',
    mode: 'NEUTRAL'
  });
}

function createNeutralHomeosInitialState({ binding, founder } = {}) {
  const runtimeBinding = normalizeRuntimeBinding(binding);
  const normalizedFounder = normalizeNeutralFounder(founder, runtimeBinding);
  const engine = createHomeosEngine({
    profile: normalizedFounder.profile,
    identity: engineIdentity(normalizedFounder)
  });
  return deepFreeze({
    schema: 'stay-p1-r0-resident/homeos-neutral-state-v1',
    runtimeBinding: clone(runtimeBinding),
    founder: clone(normalizedFounder),
    engineState: clone(engine.snapshot()),
    pendingAvailability: {},
    pendingReserve: {},
    handledEvents: 0
  });
}

function validatePending(record, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length > 16) {
    fail(`${label} is invalid`, 'P1_HOMEOS_NEUTRAL_STATE');
  }
  for (const key of Object.keys(record)) {
    if (!/^[1-9][0-9]*$/.test(key)) fail(`${label} key is invalid`, 'P1_HOMEOS_NEUTRAL_STATE');
    frameFromEvent({ payload: record[key] }, CORE_ID);
  }
}

function validateState(input) {
  exact(input, STATE_FIELDS, 'HOMEOS neutral resident state', 'P1_HOMEOS_NEUTRAL_STATE');
  if (
    input.schema !== 'stay-p1-r0-resident/homeos-neutral-state-v1' ||
    !Number.isSafeInteger(input.handledEvents) || input.handledEvents < 0
  ) fail('HOMEOS neutral resident state is invalid', 'P1_HOMEOS_NEUTRAL_STATE');
  const runtimeBinding = normalizeRuntimeBinding(input.runtimeBinding);
  const founder = normalizeNeutralFounder(input.founder, runtimeBinding);
  validatePending(input.pendingAvailability, 'HOMEOS pending availability');
  validatePending(input.pendingReserve, 'HOMEOS pending reserve');
  const engine = createHomeosEngine({ profile: founder.profile, identity: engineIdentity(founder) });
  engine.restore(input.engineState);
  if (engine.snapshot().outputSequence !== '0') {
    fail('HOMEOS neutral state contains biological output', 'P1_HOMEOS_NEUTRAL_OUTPUT');
  }
  return deepFreeze({
    schema: input.schema,
    runtimeBinding: clone(runtimeBinding),
    founder: clone(founder),
    engineState: clone(engine.snapshot()),
    pendingAvailability: clone(input.pendingAvailability),
    pendingReserve: clone(input.pendingReserve),
    handledEvents: input.handledEvents
  });
}

async function createCore({ manifest: activeManifest = manifest, initialState, emit = async () => null } = {}) {
  if (
    activeManifest.coreId !== CORE_ID || activeManifest.version !== VERSION ||
    activeManifest.stateSchema !== 1 ||
    stableStringify(activeManifest.inputs) !== stableStringify(manifest.inputs) ||
    stableStringify(activeManifest.outputs) !== stableStringify([]) || typeof emit !== 'function'
  ) fail('HOMEOS neutral manifest mismatch', 'P1_HOMEOS_NEUTRAL_MANIFEST');
  if (!initialState || Object.keys(initialState).length === 0) {
    fail('HOMEOS neutral requires a precommitted founder', 'P1_HOMEOS_NEUTRAL_FOUNDER_REQUIRED');
  }
  let state = clone(validateState(initialState));
  let engine = createHomeosEngine({ profile: state.founder.profile, identity: engineIdentity(state.founder) });
  engine.restore(state.engineState);

  function drainCompletePairs() {
    let transitions = 0;
    while (transitions < 5) {
      const sourceFrame = state.engineState.frameIndex === 0
        ? Object.keys(state.pendingAvailability)
            .map(Number)
            .filter(frame => state.pendingReserve[String(frame)])
            .sort((left, right) => left - right)[0]
        : state.engineState.frameIndex;
      if (!Number.isSafeInteger(sourceFrame) || sourceFrame < 1) return;
      const key = String(sourceFrame);
      if (!state.pendingAvailability[key] || !state.pendingReserve[key]) return;
      const result = engine.advance({
        frameIndex: sourceFrame + 1,
        inputs: [state.pendingAvailability[key], state.pendingReserve[key]]
      });
      if (result.outputs.length !== 0 || result.state.outputSequence !== '0') {
        fail('HOMEOS neutral output firewall failed', 'P1_HOMEOS_NEUTRAL_OUTPUT');
      }
      state.engineState = clone(result.state);
      delete state.pendingAvailability[key];
      delete state.pendingReserve[key];
      transitions += 1;
    }
  }

  return Object.freeze({
    async start() { state = clone(validateState(state)); },
    async handle(event) {
      if (event?.topic === 'runtime.organism.binding') {
        const binding = normalizeRuntimeBinding(event.payload);
        if (sha256(binding) !== sha256(state.runtimeBinding)) {
          fail('HOMEOS neutral runtime identity cannot change', 'P1_HOMEOS_NEUTRAL_IDENTITY');
        }
        return;
      }
      if (![AVAILABILITY_TOPIC, RESERVE_TOPIC].includes(event?.topic)) {
        fail('HOMEOS neutral input is forbidden', 'P1_HOMEOS_NEUTRAL_INPUT');
      }
      const frame = frameFromEvent(event, CORE_ID);
      if (frame) {
        const key = String(frame.committedFrame);
        if (event.topic === AVAILABILITY_TOPIC) boundedInsert(state.pendingAvailability, key, frame);
        else boundedInsert(state.pendingReserve, key, frame);
        drainCompletePairs();
      }
      state.handledEvents += 1;
    },
    async snapshot() { return clone(validateState(state)); },
    async health() {
      const verified = validateState(state);
      return Object.freeze({
        ok: true,
        mode: 'NEUTRAL',
        authorityOwned: false,
        foundered: true,
        lifecycle: verified.engineState.lifecycle,
        frameIndex: verified.engineState.frameIndex,
        pendingFrames: Object.keys(verified.pendingAvailability).length + Object.keys(verified.pendingReserve).length,
        biologicalOutputs: 0,
        physiologicalInputs: verified.handledEvents,
        outputPolicy: 'FORBIDDEN_UNTIL_INTERO_ATTACHMENT'
      });
    },
    async stop() {}
  });
}

async function migrateState({ state, fromSchema, toSchema }) {
  if (fromSchema !== 1 || toSchema !== 1) {
    fail(`unsupported HOMEOS neutral migration ${fromSchema}->${toSchema}`, 'P1_HOMEOS_NEUTRAL_MIGRATION');
  }
  return clone(validateState(state));
}

module.exports = Object.freeze({
  AVAILABILITY_TOPIC,
  CORE_ID,
  RESERVE_TOPIC,
  RESIDENCY_ID,
  STAGE,
  VERSION,
  createCore,
  createNeutralHomeosInitialState,
  manifest,
  migrateState,
  normalizeNeutralFounder,
  validateState
});
},
"runtime/p1-r0/residents/homeos-shadow.js": function(module, exports, __bundleRequire) {
'use strict';

const { stableStringify } = __bundleRequire("runtime/kernel/canonical-json.js");
const { createHomeosEngine } = __bundleRequire("runtime/p1-r0/homeos-engine.js");
const {
  RESOURCES,
  clone,
  deepFreeze,
  exact,
  fail,
  frameFromEvent,
  normalizeRuntimeBinding,
  sha256
} = __bundleRequire("runtime/p1-r0/resident-support.js");
const neutral = __bundleRequire("runtime/p1-r0/residents/homeos-neutral.js");

const CORE_ID = 'HOMEOS';
const RESIDENCY_ID = 'resident:homeos';
const VERSION = '0.2.0-p1r0-shadow.1';
const STAGE = 'p1-r0-production-output-firewalled-shadow-r145';
const ACTIVATION_TOPIC = 'runtime.homeos.shadow-activation';
const OUTPUT_POLICY = 'FORBIDDEN_UNTIL_INTERO_ATTACHMENT';
const HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const ACTIVATION_PAYLOAD_FIELDS = new Set([
  'protocol', 'organismIdentityHash', 'residencyId', 'instanceId',
  'fromVersion', 'fromStateSchema', 'sourceCheckpointGeneration',
  'sourceCheckpointHash', 'toVersion', 'toStateSchema', 'targetRevision',
  'parentRevision', 'parentFreezeRecordSha256', 'mode', 'authorityEpoch',
  'outputPolicy'
]);
const ACTIVATION_FIELDS = new Set([...ACTIVATION_PAYLOAD_FIELDS, 'eventId', 'eventSequence']);
const STATE_FIELDS = new Set(['schema', 'activation', 'neutralState']);
const R146_ROUTE_BOUNDARY = Object.freeze({
  activationEventId: 'evt-2iweb-70324b1e3d6eaba6',
  activationEventSequence: 4241027,
  activationSourceCheckpointGeneration: 7,
  activationSourceCheckpointHash:
    'sha256:2c816e7d10033049d81d55bacb07c049483f243e3f60816892ccc9e3db5d3744',
  engineFrame: 98007,
  missingSourceFrame: 98007,
  firstRetainedSourceFrame: 98008,
  lastRetainedSourceFrame: 98023,
  availabilityProducerSequence: 3,
  reserveProducerSequence: 4,
  firstRetainedAvailabilitySequence: 7,
  firstRetainedReserveSequence: 8,
  handledEvents: 36
});

const manifest = Object.freeze({
  coreId: CORE_ID,
  version: VERSION,
  protocol: 'stay-p1-r0-resident-v1',
  stateSchema: 2,
  hotSwap: true,
  priority: 'optional',
  stage: STAGE,
  productionEligible: false,
  inputs: Object.freeze([...neutral.manifest.inputs, ACTIVATION_TOPIC]),
  outputs: Object.freeze([]),
  biology: Object.freeze({
    protocol: 'stay-biological-signalling-fabric-v1',
    producerCapabilities: Object.freeze([]),
    consumerRouteLeases: Object.freeze([])
  }),
  resources: RESOURCES
});

function normalizeActivationPayload(payload) {
  exact(payload, ACTIVATION_PAYLOAD_FIELDS, 'HOMEOS shadow activation', 'P1_HOMEOS_SHADOW_ACTIVATION');
  if (
    payload.protocol !== 'stay-p1-r0-homeos-shadow-activation-v1' ||
    payload.residencyId !== RESIDENCY_ID ||
    payload.fromVersion !== neutral.VERSION || payload.fromStateSchema !== 1 ||
    payload.toVersion !== VERSION || payload.toStateSchema !== 2 ||
    payload.targetRevision !== 145 || payload.parentRevision !== 141 ||
    payload.mode !== 'SHADOW' || payload.authorityEpoch !== '0' ||
    payload.outputPolicy !== OUTPUT_POLICY ||
    !HASH.test(String(payload.organismIdentityHash || '')) ||
    !HASH.test(String(payload.sourceCheckpointHash || '')) ||
    !HASH.test(String(payload.parentFreezeRecordSha256 || '')) ||
    !Number.isSafeInteger(payload.sourceCheckpointGeneration) || payload.sourceCheckpointGeneration < 1 ||
    typeof payload.instanceId !== 'string' || !SAFE_ID.test(payload.instanceId)
  ) fail('HOMEOS shadow activation is invalid', 'P1_HOMEOS_SHADOW_ACTIVATION');
  return deepFreeze(clone(payload));
}

function normalizeActivation(payload, event) {
  const normalized = normalizeActivationPayload(payload);
  if (
    event?.topic !== ACTIVATION_TOPIC || event?.ledger?.durable !== true ||
    !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
    typeof event.id !== 'string' || !SAFE_ID.test(event.id) ||
    event.meta?.sourceCore !== 'living-kernel' ||
    event.meta?.authorityEpoch !== normalized.targetRevision ||
    event.meta?.evidenceHash !== normalized.organismIdentityHash
  ) fail('HOMEOS activation provenance is invalid', 'P1_HOMEOS_SHADOW_ACTIVATION');
  return deepFreeze({ ...clone(normalized), eventId: event.id, eventSequence: event.sequence });
}

function createShadowStagingState(neutralState) {
  return deepFreeze({
    schema: 'stay-p1-r0-resident/homeos-shadow-state-v2',
    activation: null,
    neutralState: clone(neutral.validateState(neutralState))
  });
}

function validateState(input) {
  exact(input, STATE_FIELDS, 'HOMEOS shadow state', 'P1_HOMEOS_SHADOW_STATE');
  if (input.schema !== 'stay-p1-r0-resident/homeos-shadow-state-v2') {
    fail('HOMEOS shadow state is invalid', 'P1_HOMEOS_SHADOW_STATE');
  }
  const neutralState = neutral.validateState(input.neutralState);
  let activation = null;
  if (input.activation !== null) {
    exact(input.activation, ACTIVATION_FIELDS, 'stored HOMEOS activation', 'P1_HOMEOS_SHADOW_STATE');
    const payload = {};
    for (const field of ACTIVATION_PAYLOAD_FIELDS) payload[field] = input.activation[field];
    activation = normalizeActivationPayload(payload);
    if (
      typeof input.activation.eventId !== 'string' || !SAFE_ID.test(input.activation.eventId) ||
      !Number.isSafeInteger(input.activation.eventSequence) || input.activation.eventSequence < 1 ||
      activation.organismIdentityHash !== neutralState.runtimeBinding.identitySha256
    ) fail('stored HOMEOS activation is invalid', 'P1_HOMEOS_SHADOW_STATE');
    activation = deepFreeze({ ...clone(activation), eventId: input.activation.eventId, eventSequence: input.activation.eventSequence });
  }
  return deepFreeze({ schema: input.schema, activation: activation === null ? null : clone(activation), neutralState: clone(neutralState) });
}

/*
 * The first R146 HOMEOS shadow route was interrupted after its neutral
 * checkpoint had consumed source frame 98006 and before the newly opened
 * route could publish source frame 98007.  The following sixteen complete,
 * delayed METAB pairs were durably accepted into the HOMEOS checkpoint but
 * could not advance because the engine correctly requires contiguous time.
 *
 * This repair is deliberately a pure, exact-cohort transform.  It advances
 * the single absent source frame as UNKNOWN, then applies only the retained
 * causal frames already present in the checkpoint.  It invents no input,
 * emits no output, changes no authority, and cannot match a later generic
 * gap.  The privileged recovery entry path persists the returned state and
 * evidence atomically before replaying the two retained deliveries.  If the
 * old unclaimed-event pruner has already removed those optional delivery
 * rows, the exact published producer intents remain the durable source.
 */
function repairExactR146RouteBoundaryState(input) {
  const state = clone(validateState(input));
  const activation = state.activation;
  const source = state.neutralState;
  const engineState = source.engineState;
  const availabilityKeys = Object.keys(source.pendingAvailability).map(Number).sort((a, b) => a - b);
  const reserveKeys = Object.keys(source.pendingReserve).map(Number).sort((a, b) => a - b);
  const expectedFrames = Array.from(
    { length: R146_ROUTE_BOUNDARY.lastRetainedSourceFrame -
        R146_ROUTE_BOUNDARY.firstRetainedSourceFrame + 1 },
    (_value, index) => R146_ROUTE_BOUNDARY.firstRetainedSourceFrame + index
  );
  if (
    activation?.eventId !== R146_ROUTE_BOUNDARY.activationEventId ||
    activation?.eventSequence !== R146_ROUTE_BOUNDARY.activationEventSequence ||
    activation?.sourceCheckpointGeneration !==
      R146_ROUTE_BOUNDARY.activationSourceCheckpointGeneration ||
    activation?.sourceCheckpointHash !== R146_ROUTE_BOUNDARY.activationSourceCheckpointHash ||
    activation?.instanceId !== '3f32bdc9-fa49-4eea-8c13-b9afe6b47c0f' ||
    engineState?.frameIndex !== R146_ROUTE_BOUNDARY.engineFrame ||
    engineState?.outputSequence !== '0' ||
    engineState?.inputCursors?.['p1r0.metab-availability.homeos'] !==
      String(R146_ROUTE_BOUNDARY.availabilityProducerSequence) ||
    engineState?.inputCursors?.['p1r0.metab-reserve.homeos'] !==
      String(R146_ROUTE_BOUNDARY.reserveProducerSequence) ||
    source.handledEvents !== R146_ROUTE_BOUNDARY.handledEvents ||
    stableStringify(availabilityKeys) !== stableStringify(expectedFrames) ||
    stableStringify(reserveKeys) !== stableStringify(expectedFrames)
  ) {
    fail('HOMEOS R146 route-boundary cohort changed', 'P1_HOMEOS_R146_ROUTE_BOUNDARY');
  }

  const engine = createHomeosEngine({
    profile: source.founder.profile,
    identity: {
      organismId: source.founder.organismId,
      founderLineageId: source.founder.lineageId,
      residencyId: source.founder.residencyId,
      coreVersion: neutral.VERSION,
      authorityEpoch: '0',
      mode: 'NEUTRAL'
    }
  });
  engine.restore(engineState);
  const absent = engine.advance({
    frameIndex: R146_ROUTE_BOUNDARY.engineFrame + 1,
    inputs: null
  });
  if (absent.outputs.length !== 0 || absent.state.outputSequence !== '0' ||
      absent.state.lifecycle !== 'UNRESOLVED') {
    fail('HOMEOS R146 absent frame was not contained', 'P1_HOMEOS_R146_ROUTE_BOUNDARY');
  }

  for (const [index, frame] of expectedFrames.entries()) {
    const availability = source.pendingAvailability[String(frame)];
    const reserve = source.pendingReserve[String(frame)];
    if (
      availability?.committedFrame !== frame || reserve?.committedFrame !== frame ||
      availability?.producerSequence !==
        String(R146_ROUTE_BOUNDARY.firstRetainedAvailabilitySequence + index * 2) ||
      reserve?.producerSequence !==
        String(R146_ROUTE_BOUNDARY.firstRetainedReserveSequence + index * 2)
    ) {
      fail('HOMEOS R146 retained frame identity changed', 'P1_HOMEOS_R146_ROUTE_BOUNDARY');
    }
    const advanced = engine.advance({ frameIndex: frame + 1, inputs: [availability, reserve] });
    if (advanced.outputs.length !== 0 || advanced.state.outputSequence !== '0') {
      fail('HOMEOS R146 route-boundary repair emitted output', 'P1_HOMEOS_R146_ROUTE_BOUNDARY');
    }
    delete source.pendingAvailability[String(frame)];
    delete source.pendingReserve[String(frame)];
  }
  source.engineState = clone(engine.snapshot());
  const repaired = validateState(state);
  if (
    repaired.neutralState.engineState.frameIndex !==
      R146_ROUTE_BOUNDARY.lastRetainedSourceFrame + 1 ||
    Object.keys(repaired.neutralState.pendingAvailability).length !== 0 ||
    Object.keys(repaired.neutralState.pendingReserve).length !== 0
  ) {
    fail('HOMEOS R146 route-boundary repair is incomplete', 'P1_HOMEOS_R146_ROUTE_BOUNDARY');
  }
  return deepFreeze({
    state: clone(repaired),
    evidence: {
      cohort: 'r146-homeos-route-boundary-v1',
      missingSourceFrame: R146_ROUTE_BOUNDARY.missingSourceFrame,
      absentFrameSemantics: 'UNKNOWN',
      retainedPairCount: expectedFrames.length,
      firstRetainedSourceFrame: expectedFrames[0],
      lastRetainedSourceFrame: expectedFrames.at(-1),
      fromEngineFrame: R146_ROUTE_BOUNDARY.engineFrame,
      toEngineFrame: repaired.neutralState.engineState.frameIndex,
      checkpointBytesChanged: true,
      biologicalStateChanged: true,
      physiologyApplied: expectedFrames.length,
      abandonedCount: 0,
      inventedBiologicalTime: false,
      authorityChanged: false,
      biologicalOutputs: 0
    }
  });
}

function applyExactR146PrunedOutboxPair(input, pair) {
  const state = clone(validateState(input));
  if (!Array.isArray(pair) || pair.length !== 2) {
    fail('HOMEOS R146 pruned outbox pair changed', 'P1_HOMEOS_R146_PRUNED_PAIR');
  }
  const expected = [
    { topic: neutral.AVAILABILITY_TOPIC, producerSequence: '39' },
    { topic: neutral.RESERVE_TOPIC, producerSequence: '40' }
  ];
  const frames = pair.map((entry, index) => {
    if (!entry || entry.topic !== expected[index].topic) {
      fail('HOMEOS R146 pruned outbox topic changed', 'P1_HOMEOS_R146_PRUNED_PAIR');
    }
    const frame = frameFromEvent({ topic: entry.topic, payload: entry.payload }, CORE_ID);
    if (frame?.committedFrame !== R146_ROUTE_BOUNDARY.lastRetainedSourceFrame + 1 ||
        frame?.producerSequence !== expected[index].producerSequence) {
      fail('HOMEOS R146 pruned outbox identity changed', 'P1_HOMEOS_R146_PRUNED_PAIR');
    }
    return frame;
  });
  const source = state.neutralState;
  if (source.engineState?.frameIndex !== R146_ROUTE_BOUNDARY.lastRetainedSourceFrame + 1 ||
      source.engineState?.outputSequence !== '0' ||
      Object.keys(source.pendingAvailability).length !== 0 ||
      Object.keys(source.pendingReserve).length !== 0) {
    fail('HOMEOS R146 repaired boundary changed', 'P1_HOMEOS_R146_PRUNED_PAIR');
  }
  const engine = createHomeosEngine({
    profile: source.founder.profile,
    identity: {
      organismId: source.founder.organismId,
      founderLineageId: source.founder.lineageId,
      residencyId: source.founder.residencyId,
      coreVersion: neutral.VERSION,
      authorityEpoch: '0',
      mode: 'NEUTRAL'
    }
  });
  engine.restore(source.engineState);
  const advanced = engine.advance({
    frameIndex: R146_ROUTE_BOUNDARY.lastRetainedSourceFrame + 2,
    inputs: frames
  });
  if (advanced.outputs.length !== 0 || advanced.state.outputSequence !== '0') {
    fail('HOMEOS R146 pruned outbox recovery emitted output', 'P1_HOMEOS_R146_PRUNED_PAIR');
  }
  source.engineState = clone(advanced.state);
  source.handledEvents += 2;
  const recovered = validateState(state);
  return deepFreeze({
    state: clone(recovered),
    evidence: {
      cohort: 'r146-homeos-pruned-delivery-recovery-v1',
      sourceFrame: R146_ROUTE_BOUNDARY.lastRetainedSourceFrame + 1,
      producerSequences: pair.map(entry => entry.payload.producerSequence),
      handledEventsAdded: 2,
      physiologyApplied: 1,
      biologicalOutputs: 0,
      abandonedCount: 0,
      inventedBiologicalTime: false,
      authorityChanged: false
    }
  });
}

async function createCore({ manifest: activeManifest = manifest, initialState, emit = async () => null } = {}) {
  if (
    activeManifest.coreId !== CORE_ID || activeManifest.version !== VERSION ||
    activeManifest.stateSchema !== 2 ||
    stableStringify(activeManifest.inputs) !== stableStringify(manifest.inputs) ||
    stableStringify(activeManifest.outputs) !== stableStringify([]) || typeof emit !== 'function'
  ) fail('HOMEOS shadow manifest mismatch', 'P1_HOMEOS_SHADOW_MANIFEST');
  if (!initialState || Object.keys(initialState).length === 0) {
    fail('HOMEOS shadow requires preserved neutral state', 'P1_HOMEOS_SHADOW_STATE');
  }
  let state = clone(validateState(initialState));
  let inner = await neutral.createCore({ initialState: state.neutralState });
  await inner.start();

  async function syncInner() {
    state.neutralState = await inner.snapshot();
  }

  return Object.freeze({
    async start() { state = clone(validateState(state)); },
    async handle(event) {
      if (event?.topic === ACTIVATION_TOPIC) {
        const activation = normalizeActivation(event.payload, event);
        if (state.activation) {
          if (sha256(state.activation) !== sha256(activation)) {
            fail('HOMEOS shadow activation cannot change', 'P1_HOMEOS_SHADOW_ACTIVATION');
          }
          return;
        }
        if (
          activation.organismIdentityHash !== state.neutralState.runtimeBinding.identitySha256 ||
          activation.sourceCheckpointHash !== event.payload.sourceCheckpointHash
        ) fail('HOMEOS shadow activation lost neutral lineage', 'P1_HOMEOS_SHADOW_ACTIVATION');
        state.activation = clone(activation);
        return;
      }
      if (!state.activation && event?.topic !== 'runtime.organism.binding') {
        fail('HOMEOS cannot consume before shadow activation', 'P1_HOMEOS_SHADOW_UNACTIVATED');
      }
      await inner.handle(event);
      await syncInner();
    },
    async snapshot() { await syncInner(); return clone(validateState(state)); },
    async health() {
      await syncInner();
      const verified = validateState(state);
      const innerHealth = await inner.health();
      return Object.freeze({
        ...innerHealth,
        ok: verified.activation !== null,
        mode: 'SHADOW',
        authorityOwned: false,
        activated: verified.activation !== null,
        biologicalOutputs: 0,
        outputPolicy: OUTPUT_POLICY
      });
    },
    async stop() { await inner.stop(); }
  });
}

async function migrateState({ state, fromSchema, toSchema }) {
  if (fromSchema === 1 && toSchema === 2) return clone(createShadowStagingState(state));
  if (fromSchema === 2 && toSchema === 2) return clone(validateState(state));
  fail(`unsupported HOMEOS shadow migration ${fromSchema}->${toSchema}`, 'P1_HOMEOS_SHADOW_MIGRATION');
}

module.exports = Object.freeze({
  ACTIVATION_TOPIC,
  CORE_ID,
  OUTPUT_POLICY,
  RESIDENCY_ID,
  STAGE,
  VERSION,
  createCore,
  createShadowStagingState,
  manifest,
  migrateState,
  normalizeActivationPayload,
  applyExactR146PrunedOutboxPair,
  repairExactR146RouteBoundaryState,
  R146_ROUTE_BOUNDARY,
  validateState
});
}
};
const __bundleCache = new Map();
function __bundleRequire(id) {
  if (__bundleCache.has(id)) return __bundleCache.get(id).exports;
  const factory = __bundleModules[id];
  if (!factory) throw new Error('unknown bundled P1-R0 module: ' + id);
  const module = { exports: {} };
  __bundleCache.set(id, module);
  factory(module, module.exports, __bundleRequire);
  return module.exports;
}
module.exports = __bundleRequire("runtime/p1-r0/residents/homeos-shadow.js");
