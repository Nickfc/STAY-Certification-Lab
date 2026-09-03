'use strict';

// Deterministic P1-R0 resident bundle. Source seal: sha256:893b887e16dd039fe99ecf19c775d06423c32fa10ad7bb68df45934f11f0952d
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
"runtime/p1-r0/deterministic-noise.js": function(module, exports, __bundleRequire) {
'use strict';

const MASK_64 = (1n << 64n) - 1n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const SPLITMIX_GAMMA = 0x9e3779b97f4a7c15n;
const MIX_1 = 0xbf58476d1ce4e5b9n;
const MIX_2 = 0x94d049bb133111ebn;
const HEX_64 = /^[0-9a-f]{16}$/;

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function hex64(value) {
  return (value & MASK_64).toString(16).padStart(16, '0');
}

function parseHex64(value) {
  if (typeof value !== 'string' || !HEX_64.test(value)) {
    fail('noise key must be 16 lowercase hexadecimal characters', 'P1_NOISE_KEY');
  }
  return BigInt(`0x${value}`);
}

function fnv1a64(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 256) {
    fail('noise channel id is invalid', 'P1_NOISE_CHANNEL');
  }
  let hash = FNV_OFFSET;
  for (const byte of Buffer.from(value, 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

function splitmix64(value) {
  let mixed = (value + SPLITMIX_GAMMA) & MASK_64;
  mixed = ((mixed ^ (mixed >> 30n)) * MIX_1) & MASK_64;
  mixed = ((mixed ^ (mixed >> 27n)) * MIX_2) & MASK_64;
  return (mixed ^ (mixed >> 31n)) & MASK_64;
}

function frame64(frameIndex) {
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
    fail('noise frame index must be a non-negative safe integer', 'P1_NOISE_FRAME');
  }
  return BigInt(frameIndex) & MASK_64;
}

function triangularQ0_48({ noiseKeyHex, channelId, frameIndex }) {
  const z0 = parseHex64(noiseKeyHex) ^ fnv1a64(channelId) ^ frame64(frameIndex);
  const z1 = z0 ^ SPLITMIX_GAMMA;
  const mixed0 = splitmix64(z0);
  const mixed1 = splitmix64(z1);
  const u0 = mixed0 >> 16n;
  const u1 = mixed1 >> 16n;
  return Object.freeze({
    z0Hex: hex64(z0),
    z1Hex: hex64(z1),
    splitmix0Hex: hex64(mixed0),
    splitmix1Hex: hex64(mixed1),
    u0Q0_48Raw: u0.toString(),
    u1Q0_48Raw: u1.toString(),
    differenceQ0_48Raw: (u0 - u1).toString()
  });
}

module.exports = Object.freeze({
  MASK_64,
  SPLITMIX_GAMMA,
  parseHex64,
  fnv1a64,
  splitmix64,
  triangularQ0_48
});
},
"runtime/p1-r0/intero-contract.js": function(module, exports, __bundleRequire) {
'use strict';

const { stableStringify } = __bundleRequire("runtime/kernel/canonical-json.js");
const q48 = __bundleRequire("runtime/p1-r0/q16-48.js");
const { validateCausalFrame } = __bundleRequire("runtime/p1-r0/causal-frame.js");
const contract = __bundleRequire("runtime/p1-r0/intero-contract.json");

const PROFILE_FIELDS = new Set([
  'profileId', 'noiseKeyHex', 'transformVersion', 'channels', 'axes',
  'minimumConfidenceQ48', 'adaptationConfidenceQ48', 'adaptationMinimumFrames',
  'maxAdaptationPer24hQ48', 'maxLifetimeAdaptationQ48', 'numericPolicy', 'frameMs'
]);
const CHANNEL_FIELDS = new Set([
  'channelId', 'required', 'source', 'sourceLowQ48', 'sourceHighQ48', 'delayFrames',
  'resolutionQ48', 'imperfectionAmplitudeQ48', 'alphaQ48', 'trendWindowFrames',
  'trendMaxQ48', 'baselinePolicy', 'founderBaselineQ48', 'lifetimeDriftMaxQ48',
  'persistenceLoadQ48', 'persistenceReliefQ48', 'salienceWeights', 'freshnessMs'
]);
const SOURCE_FIELDS = new Set(['producerCoreId', 'topic', 'schemaId', 'unit', 'mode']);
const SALIENCE_FIELDS = new Set(['deviationQ48', 'trendQ48', 'persistenceQ48']);
const AXIS_FIELDS = new Set(['axisId', 'requiredCoverageQ48', 'weights']);
const AXIS_WEIGHT_FIELDS = new Set(['channelId', 'levelQ48', 'trendQ48', 'persistenceQ48']);
const SOURCE_BY_ROUTE = new Map(contract.sources.map(source => [source.routeId, Object.freeze(source)]));
const SOURCE_BY_CHANNEL = new Map(contract.sources.map(source => [source.channelId, Object.freeze(source)]));
const SCARCITY = new Set(['ABUNDANT', 'BALANCED', 'CONSERVING', 'DEPLETED', 'UNRESOLVED', 'PROTECTED']);
const HOMEOS_STATE = new Set(['INITIALIZING', 'STABLE', 'STRAINED', 'UNRESOLVED', 'PROTECTED', 'RECOVERING']);
const HEX_64 = /^[0-9a-f]{16}$/;

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function exact(value, fields, label, code = 'P1_INTERO_CONTRACT_SCHEMA') {
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

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} is invalid`, 'P1_INTERO_CONTRACT_RANGE');
  }
  return value;
}

function raw(value, label, minimum = q48.MIN_RAW, maximum = q48.MAX_RAW) {
  const parsed = q48.parseRaw(value);
  if (parsed < minimum || parsed > maximum) fail(`${label} is outside its range`, 'P1_INTERO_CONTRACT_RANGE');
  return parsed;
}

function unit(value, label) {
  return raw(value, label, 0n, q48.SCALE);
}

function validatePayload(source, frame) {
  exact(frame.payload, new Set(source.payloadFields), `${source.key} payload`, 'P1_INTERO_INPUT_SCHEMA');
  if (source.key === 'availability') {
    unit(frame.payload.availabilityQ48, 'INTERO availability');
    raw(frame.payload.debtQ48, 'INTERO metabolic debt', 0n);
    unit(frame.payload.confidenceQ48, 'INTERO availability confidence');
    unit(frame.payload.coverageQ48, 'INTERO availability coverage');
    if (!SCARCITY.has(frame.payload.scarcityState)) fail('INTERO scarcity state is invalid', 'P1_INTERO_INPUT_SCHEMA');
    if (
      frame.payload.confidenceQ48 !== frame.quality.confidenceQ48 ||
      frame.payload.coverageQ48 !== frame.quality.coverageQ48
    ) fail('INTERO availability quality disagrees with its frame', 'P1_INTERO_INPUT_QUALITY');
  } else if (source.key === 'reserve') {
    raw(frame.payload.reserveQ48, 'INTERO reserve', 0n);
    unit(frame.payload.reserveFractionQ48, 'INTERO reserve fraction');
    raw(frame.payload.trendQ48PerSecond, 'INTERO reserve trend');
    raw(frame.payload.cumulativeChargeQ48, 'INTERO cumulative reserve charge', 0n);
    raw(frame.payload.cumulativeDischargeQ48, 'INTERO cumulative reserve discharge', 0n);
    unit(frame.payload.confidenceQ48, 'INTERO reserve confidence');
    if (frame.payload.confidenceQ48 !== frame.quality.confidenceQ48) {
      fail('INTERO reserve quality disagrees with its frame', 'P1_INTERO_INPUT_QUALITY');
    }
  } else {
    unit(frame.payload.stabilityLoadQ48, 'INTERO stability load');
    integer(frame.payload.activePressureCount, 'INTERO active pressure count');
    unit(frame.payload.confidenceQ48, 'INTERO stability confidence');
    unit(frame.payload.coverageQ48, 'INTERO stability coverage');
    if (!HOMEOS_STATE.has(frame.payload.state)) fail('INTERO HOMEOS state is invalid', 'P1_INTERO_INPUT_SCHEMA');
    if (
      frame.payload.confidenceQ48 !== frame.quality.confidenceQ48 ||
      frame.payload.coverageQ48 !== frame.quality.coverageQ48
    ) fail('INTERO stability quality disagrees with its frame', 'P1_INTERO_INPUT_QUALITY');
  }
}

function validateInteroInputFrame(input, consumerFrame) {
  integer(consumerFrame, 'INTERO consumer frame');
  const frame = validateCausalFrame(input);
  const source = SOURCE_BY_ROUTE.get(frame.route.routeId);
  if (!source) fail('frame is not a reviewed INTERO input', 'P1_INTERO_INPUT_ROUTE');
  if (
    frame.producer.coreId.toUpperCase().replaceAll('-', '_') !== source.producer ||
    frame.producer.mode !== source.producerMode ||
    frame.producer.authorityEpoch !== '0' ||
    frame.route.consumerCoreId.toUpperCase().replaceAll('-', '_') !== contract.consumer ||
    frame.topic.name !== source.topic ||
    frame.topic.class !== source.topicClass ||
    frame.topic.schemaId !== source.schemaId ||
    frame.topic.schemaVersion !== '1' ||
    frame.topic.unit !== source.unit ||
    frame.topic.scale !== 'Q16.48'
  ) fail('INTERO input identity does not match its frozen source', 'P1_INTERO_INPUT_IDENTITY');
  if (frame.quality.status !== 'ACCEPT') fail('INTERO cannot consume unresolved evidence', 'P1_INTERO_INPUT_UNKNOWN');
  if (consumerFrame < frame.visibleFromFrame || consumerFrame < frame.committedFrame + source.delayFrames) {
    fail('INTERO founder delay is not satisfied', 'P1_INTERO_INPUT_DELAY');
  }
  validatePayload(source, frame);
  return deepFreeze({ source: source.key, channelId: source.channelId, frame });
}

function sameProducer(left, right) {
  return ['coreId', 'residencyId', 'coreVersion', 'authorityEpoch', 'mode']
    .every(field => left.producer[field] === right.producer[field]);
}

function validateCoherence(bySource) {
  const availability = bySource.get('availability');
  const reserve = bySource.get('reserve');
  const stability = bySource.get('stability');
  if ([reserve, stability].some(frame => frame.organismId !== availability.organismId)) {
    fail('INTERO evidence crosses organism identity', 'P1_INTERO_INPUT_COHERENCE');
  }
  if (
    reserve.founderLineageId !== availability.founderLineageId ||
    reserve.committedFrame !== availability.committedFrame ||
    !sameProducer(availability, reserve)
  ) fail('INTERO METAB evidence is not producer-coherent', 'P1_INTERO_INPUT_COHERENCE');
  if (stability.committedFrame !== availability.committedFrame + 1) {
    fail('INTERO HOMEOS evidence is not descended from the METAB frame', 'P1_INTERO_INPUT_COHERENCE');
  }
  if (stability.causalSpan.latestFrame !== availability.committedFrame) {
    fail('INTERO HOMEOS causal frontier does not match METAB', 'P1_INTERO_INPUT_COHERENCE');
  }
  const metabAncestors = stability.causalSpan.ancestors.filter(ancestor => ancestor.producerCoreId === 'METAB');
  for (const topic of ['metab.energy.availability.v1', 'metab.energy.reserve.v1']) {
    const ancestor = metabAncestors.find(candidate => candidate.topic === topic);
    if (
      !ancestor ||
      ancestor.residencyId !== availability.producer.residencyId ||
      ancestor.mode !== 'SHADOW' ||
      ancestor.shadowAncestry !== true ||
      ancestor.sourceWindow.startFrame !== availability.sourceWindow.startFrame ||
      ancestor.sourceWindow.endFrame !== availability.sourceWindow.endFrame
    ) fail('INTERO HOMEOS ancestry does not bind the common METAB frame', 'P1_INTERO_INPUT_COHERENCE');
  }
}

function collectInteroInputs(inputs, consumerFrame) {
  if (!Array.isArray(inputs) || inputs.length !== contract.sources.length) {
    fail('INTERO requires exactly one frame for each founder channel', 'P1_INTERO_INPUT_COVERAGE');
  }
  const validated = inputs.map(input => validateInteroInputFrame(input, consumerFrame));
  const bySource = new Map();
  for (const item of validated) {
    if (bySource.has(item.source)) fail('INTERO received duplicate canonical evidence', 'P1_INTERO_INPUT_CONFLICT');
    bySource.set(item.source, item.frame);
  }
  if (contract.sources.some(source => !bySource.has(source.key))) {
    fail('INTERO source coverage is incomplete', 'P1_INTERO_INPUT_COVERAGE');
  }
  validateCoherence(bySource);
  return deepFreeze({
    consumerFrame,
    organismId: bySource.get('availability').organismId,
    channels: contract.sources.map(source => ({
      channelId: source.channelId,
      valueQ48: bySource.get(source.key).payload[source.valueField],
      frame: clone(bySource.get(source.key))
    }))
  });
}

function validateInteroFounderProfile(input) {
  exact(input, PROFILE_FIELDS, 'INTERO founder profile');
  if (
    input.frameMs !== 250 ||
    input.numericPolicy !== 'Q16.48-half-even-saturating-v1' ||
    input.transformVersion !== 'splitmix64-fnv1a64-q0.48-triangular-v1' ||
    !HEX_64.test(input.noiseKeyHex) ||
    integer(input.adaptationMinimumFrames, 'INTERO adaptation minimum', 172800) !== input.adaptationMinimumFrames
  ) fail('INTERO founder policy is invalid', 'P1_INTERO_PROFILE');
  for (const field of ['minimumConfidenceQ48', 'adaptationConfidenceQ48', 'maxAdaptationPer24hQ48', 'maxLifetimeAdaptationQ48']) {
    unit(input[field], `INTERO ${field}`);
  }
  if (!Array.isArray(input.channels) || input.channels.length !== contract.sources.length) {
    fail('INTERO must have exactly the reviewed channels', 'P1_INTERO_PROFILE');
  }
  const channelIds = new Set();
  for (const channel of input.channels) {
    exact(channel, CHANNEL_FIELDS, 'INTERO channel');
    exact(channel.source, SOURCE_FIELDS, 'INTERO channel source');
    exact(channel.salienceWeights, SALIENCE_FIELDS, 'INTERO salience weights');
    const source = SOURCE_BY_CHANNEL.get(channel.channelId);
    if (
      !source || channelIds.has(channel.channelId) || channel.required !== true ||
      channel.source.producerCoreId !== source.producer ||
      channel.source.topic !== source.topic ||
      channel.source.schemaId !== source.schemaId ||
      channel.source.unit !== source.unit ||
      channel.source.mode !== source.producerMode ||
      channel.delayFrames !== source.delayFrames
    ) fail('INTERO channel lacks one canonical frozen source', 'P1_INTERO_PROFILE_SOURCE');
    channelIds.add(channel.channelId);
    integer(channel.delayFrames, 'INTERO channel delay', 1, 20);
    integer(channel.trendWindowFrames, 'INTERO trend window', 1, 240);
    integer(channel.freshnessMs, 'INTERO freshness', 250, 2000);
    const low = raw(channel.sourceLowQ48, 'INTERO source low');
    const high = raw(channel.sourceHighQ48, 'INTERO source high');
    if (high <= low) fail('INTERO source range is invalid', 'P1_INTERO_PROFILE');
    raw(channel.founderBaselineQ48, 'INTERO founder baseline', low, high);
    for (const field of ['resolutionQ48', 'imperfectionAmplitudeQ48', 'alphaQ48', 'lifetimeDriftMaxQ48', 'persistenceLoadQ48', 'persistenceReliefQ48', 'trendMaxQ48']) {
      unit(channel[field], `INTERO ${field}`);
    }
    for (const field of SALIENCE_FIELDS) unit(channel.salienceWeights[field], `INTERO salience ${field}`);
    if (!['FIXED', 'PHASED', 'SLOW_ADAPT'].includes(channel.baselinePolicy)) {
      fail('INTERO baseline policy is invalid', 'P1_INTERO_PROFILE');
    }
  }
  if (!Array.isArray(input.axes) || input.axes.length < 1 || input.axes.length > 16) {
    fail('INTERO axes are invalid', 'P1_INTERO_PROFILE');
  }
  const axisIds = new Set();
  for (const axis of input.axes) {
    exact(axis, AXIS_FIELDS, 'INTERO axis');
    if (typeof axis.axisId !== 'string' || axis.axisId.length === 0 || axisIds.has(axis.axisId)) {
      fail('INTERO axis identity is invalid', 'P1_INTERO_PROFILE');
    }
    axisIds.add(axis.axisId);
    unit(axis.requiredCoverageQ48, 'INTERO axis required coverage');
    if (!Array.isArray(axis.weights) || axis.weights.length < 1 || axis.weights.length > 32) {
      fail('INTERO axis weights are invalid', 'P1_INTERO_PROFILE');
    }
    const weightedChannels = new Set();
    for (const weight of axis.weights) {
      exact(weight, AXIS_WEIGHT_FIELDS, 'INTERO axis weight');
      if (!channelIds.has(weight.channelId) || weightedChannels.has(weight.channelId)) {
        fail('INTERO axis has an invalid channel binding', 'P1_INTERO_PROFILE_SOURCE');
      }
      weightedChannels.add(weight.channelId);
      for (const field of ['levelQ48', 'trendQ48', 'persistenceQ48']) unit(weight[field], `INTERO axis ${field}`);
    }
  }
  return deepFreeze(clone(input));
}

module.exports = Object.freeze({
  contract: deepFreeze(clone(contract)),
  validateInteroInputFrame,
  collectInteroInputs,
  validateInteroFounderProfile
});
},
"runtime/p1-r0/intero-contract.json": function(module, exports, __bundleRequire) {
module.exports = {"coherence":["same organism","one canonical frame per channel","coherent METAB producer identity and committed frame","HOMEOS stability descends from the same METAB committed frame","founder-declared channel delay satisfied"],"consumer":"INTERO","contractVersion":"P1-R0-INTERO-DELAYED-INPUT-v1","forbiddenInputFields":["viewerId","viewerCount","payment","owner","chipState"],"forbiddenInteroSemantics":["emotion","fear","pain","hunger","diagnosis","cause","self","action"],"laboratoryOnly":true,"routeStage":"ABSENT","sources":[{"channelId":"energy.availability","delayFrames":2,"key":"availability","payloadFields":["availabilityQ48","confidenceQ48","coverageQ48","debtQ48","scarcityState"],"producer":"METAB","producerMode":"SHADOW","routeId":"p1r0.metab-availability.intero","schemaId":"urn:stay:p1-r0:schema:metab-energy-availability-payload:v1","topic":"metab.energy.availability.v1","topicClass":"SUMMARY","unit":"ratio","valueField":"availabilityQ48"},{"channelId":"energy.reserve","delayFrames":3,"key":"reserve","payloadFields":["confidenceQ48","cumulativeChargeQ48","cumulativeDischargeQ48","reserveFractionQ48","reserveQ48","trendQ48PerSecond"],"producer":"METAB","producerMode":"SHADOW","routeId":"p1r0.metab-reserve.intero","schemaId":"urn:stay:p1-r0:schema:metab-energy-reserve-payload:v1","topic":"metab.energy.reserve.v1","topicClass":"SUMMARY","unit":"ratio","valueField":"reserveFractionQ48"},{"channelId":"regulatory.stability","delayFrames":2,"key":"stability","payloadFields":["activePressureCount","confidenceQ48","coverageQ48","stabilityLoadQ48","state"],"producer":"HOMEOS","producerMode":"SHADOW","routeId":"p1r0.homeos-stability.intero","schemaId":"urn:stay:p1-r0:schema:homeos-stability-summary-payload:v1","topic":"homeos.stability.summary.v1","topicClass":"SUMMARY","unit":"ratio","valueField":"stabilityLoadQ48"}]};
},
"runtime/p1-r0/intero-engine.js": function(module, exports, __bundleRequire) {
'use strict';

const crypto = require('node:crypto');
const { stableStringify } = __bundleRequire("runtime/kernel/canonical-json.js");
const q48 = __bundleRequire("runtime/p1-r0/q16-48.js");
const { triangularQ0_48 } = __bundleRequire("runtime/p1-r0/deterministic-noise.js");
const { contract, collectInteroInputs, validateInteroFounderProfile } = __bundleRequire("runtime/p1-r0/intero-contract.js");

const OPTION_FIELDS = new Set(['profile', 'identity']);
const IDENTITY_FIELDS = new Set([
  'organismId', 'founderLineageId', 'residencyId', 'coreVersion', 'authorityEpoch', 'mode'
]);
const ADVANCE_FIELDS = new Set(['frameIndex', 'inputs']);
const STATE_FIELDS = new Set([
  'frameIndex', 'counterFrontier', 'channels', 'lifecycle', 'inputCursors', 'outputSequence'
]);
const CHANNEL_STATE_FIELDS = new Set([
  'channelId', 'delayRingHash', 'delayIndex', 'filteredQ48', 'trendQ48', 'baselineQ48',
  'lifetimeDriftQ48', 'persistenceQ48', 'salienceQ48', 'saturated', 'quality', 'sourceSequence'
]);
const QUALITY = new Set(['ACCEPT', 'HOLD', 'UNKNOWN', 'QUARANTINE']);
const LIFECYCLE = new Set([
  'UNFOUNDED', 'INITIALIZING', 'SENSING', 'PARTIAL', 'SATURATED',
  'UNRESOLVED', 'PROTECTED', 'RECOVERING'
]);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function exact(value, fields, label, code = 'P1_INTERO_ENGINE_SCHEMA') {
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
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`, 'P1_INTERO_ENGINE_SCHEMA');
  return value;
}

function raw(value, label, minimum = q48.MIN_RAW, maximum = q48.MAX_RAW) {
  const parsed = q48.parseRaw(value);
  if (parsed < minimum || parsed > maximum) fail(`${label} is outside its range`, 'P1_INTERO_ENGINE_RANGE');
  return parsed;
}

function unit(value, label) {
  return raw(value, label, 0n, q48.SCALE);
}

function minimum(left, right) {
  return left < right ? left : right;
}

function absolute(value) {
  return value < 0n ? -value : value;
}

function validateIdentity(input) {
  exact(input, IDENTITY_FIELDS, 'INTERO identity', 'P1_INTERO_IDENTITY');
  for (const field of ['organismId', 'founderLineageId', 'residencyId', 'coreVersion']) {
    if (typeof input[field] !== 'string' || !SAFE_ID.test(input[field])) fail(`INTERO ${field} is invalid`, 'P1_INTERO_IDENTITY');
  }
  if (input.authorityEpoch !== '0') fail('laboratory INTERO must own zero authority', 'P1_INTERO_AUTHORITY');
  if (!['NEUTRAL', 'SHADOW'].includes(input.mode)) fail('laboratory INTERO mode is invalid', 'P1_INTERO_AUTHORITY');
  return deepFreeze(clone(input));
}

function initialState(profile) {
  return {
    frameIndex: 0,
    counterFrontier: 0,
    channels: profile.channels.map(channel => ({
      channelId: channel.channelId,
      delayRingHash: sha256([]),
      delayIndex: 0,
      filteredQ48: channel.founderBaselineQ48,
      trendQ48: '0',
      baselineQ48: channel.founderBaselineQ48,
      lifetimeDriftQ48: '0',
      persistenceQ48: '0',
      salienceQ48: '0',
      saturated: false,
      quality: 'UNKNOWN',
      sourceSequence: '0'
    })),
    lifecycle: 'INITIALIZING',
    inputCursors: Object.fromEntries(contract.sources.map(source => [source.routeId, '0'])),
    outputSequence: '0'
  };
}

function validateState(input, profile) {
  exact(input, STATE_FIELDS, 'INTERO state', 'P1_INTERO_STATE');
  integer(input.frameIndex, 'INTERO state frame');
  integer(input.counterFrontier, 'INTERO counter frontier');
  if (!LIFECYCLE.has(input.lifecycle)) fail('INTERO lifecycle is invalid', 'P1_INTERO_STATE');
  if (!Array.isArray(input.channels) || input.channels.length !== profile.channels.length) {
    fail('INTERO state channels are invalid', 'P1_INTERO_STATE');
  }
  for (let index = 0; index < input.channels.length; index += 1) {
    const channel = input.channels[index];
    exact(channel, CHANNEL_STATE_FIELDS, 'INTERO channel state', 'P1_INTERO_STATE');
    if (
      channel.channelId !== profile.channels[index].channelId ||
      !/^sha256:[0-9a-f]{64}$/.test(channel.delayRingHash) ||
      !QUALITY.has(channel.quality) ||
      typeof channel.saturated !== 'boolean' ||
      !/^(0|[1-9][0-9]*)$/.test(channel.sourceSequence)
    ) fail('INTERO channel state identity is invalid', 'P1_INTERO_STATE');
    integer(channel.delayIndex, 'INTERO delay index');
    raw(channel.filteredQ48, 'INTERO filtered state');
    raw(channel.trendQ48, 'INTERO trend state');
    raw(channel.baselineQ48, 'INTERO baseline state');
    raw(channel.lifetimeDriftQ48, 'INTERO lifetime drift');
    unit(channel.persistenceQ48, 'INTERO persistence');
    unit(channel.salienceQ48, 'INTERO salience');
  }
  if (!input.inputCursors || typeof input.inputCursors !== 'object' || Array.isArray(input.inputCursors)) {
    fail('INTERO input cursors are invalid', 'P1_INTERO_STATE');
  }
  const cursorKeys = Object.keys(input.inputCursors).sort();
  const expectedCursorKeys = contract.sources.map(source => source.routeId).sort();
  if (
    cursorKeys.length !== expectedCursorKeys.length ||
    cursorKeys.some((key, index) => key !== expectedCursorKeys[index])
  ) fail('INTERO input cursor routes are invalid', 'P1_INTERO_STATE');
  for (const cursor of Object.values(input.inputCursors)) {
    if (!/^(0|[1-9][0-9]*)$/.test(cursor)) fail('INTERO input cursor is invalid', 'P1_INTERO_STATE');
  }
  if (!/^(0|[1-9][0-9]*)$/.test(input.outputSequence)) fail('INTERO output sequence is invalid', 'P1_INTERO_STATE');
  return clone(input);
}

function boundedNoise(profile, descriptor, frameIndex) {
  const vector = triangularQ0_48({
    noiseKeyHex: profile.noiseKeyHex,
    channelId: descriptor.channelId,
    frameIndex
  });
  return q48.mul(
    unit(descriptor.imperfectionAmplitudeQ48, 'INTERO imperfection amplitude'),
    q48.parseRaw(vector.differenceQ0_48Raw)
  );
}

function adaptation(previous, descriptor, filtered, confidence, counterFrontier, profile) {
  let baseline = raw(previous.baselineQ48, 'INTERO prior baseline');
  let drift = raw(previous.lifetimeDriftQ48, 'INTERO prior lifetime drift');
  const persistence = unit(previous.persistenceQ48, 'INTERO prior persistence');
  const eligible =
    descriptor.baselinePolicy === 'SLOW_ADAPT' &&
    counterFrontier >= profile.adaptationMinimumFrames &&
    confidence >= unit(profile.adaptationConfidenceQ48, 'INTERO adaptation confidence') &&
    persistence <= unit(descriptor.resolutionQ48, 'INTERO adaptation protection threshold');
  if (!eligible) return { baseline, drift };
  const framesPer24h = Math.floor(86_400_000 / profile.frameMs);
  const maximumStep = q48.roundHalfEven(
    unit(profile.maxAdaptationPer24hQ48, 'INTERO daily adaptation'),
    BigInt(framesPer24h)
  );
  const desired = filtered - baseline;
  const step = q48.clamp(desired, -maximumStep, maximumStep);
  const descriptorLimit = unit(descriptor.lifetimeDriftMaxQ48, 'INTERO channel drift limit');
  const profileLimit = unit(profile.maxLifetimeAdaptationQ48, 'INTERO profile drift limit');
  const limit = minimum(descriptorLimit, profileLimit);
  const nextDrift = q48.clamp(drift + step, -limit, limit);
  baseline = q48.add(baseline, nextDrift - drift);
  drift = nextDrift;
  return { baseline, drift };
}

function updateChannel(previous, descriptor, evidence, frameIndex, counterFrontier, profile) {
  const low = raw(descriptor.sourceLowQ48, 'INTERO source low');
  const high = raw(descriptor.sourceHighQ48, 'INTERO source high');
  const resolution = unit(descriptor.resolutionQ48, 'INTERO resolution');
  const sample = raw(evidence.valueQ48, `INTERO ${descriptor.channelId} sample`, low, high);
  const perceived = q48.clamp(q48.quantize(q48.saturatingAdd(sample, boundedNoise(profile, descriptor, frameIndex)), resolution), low, high);
  const oldFiltered = raw(previous.filteredQ48, 'INTERO prior filtered state');
  const alpha = unit(descriptor.alphaQ48, 'INTERO filter alpha');
  const filtered = q48.add(oldFiltered, q48.mul(alpha, perceived - oldFiltered));
  const instantTrend = q48.div(filtered - oldFiltered, q48.fromDecimal('0.25'));
  const trendMaximum = unit(descriptor.trendMaxQ48, 'INTERO trend maximum');
  const boundedTrend = q48.clamp(instantTrend, -trendMaximum, trendMaximum);
  const trendAlpha = q48.roundHalfEven(q48.SCALE, BigInt(descriptor.trendWindowFrames));
  const oldTrend = raw(previous.trendQ48, 'INTERO prior trend');
  const trend = q48.add(oldTrend, q48.mul(trendAlpha, boundedTrend - oldTrend));
  const confidence = unit(evidence.frame.quality.confidenceQ48, 'INTERO source confidence');
  const adapted = adaptation(previous, descriptor, filtered, confidence, counterFrontier, profile);
  const deviation = absolute(filtered - adapted.baseline);
  let persistence = unit(previous.persistenceQ48, 'INTERO prior persistence');
  if (deviation > resolution) {
    const load = q48.mul(
      q48.mul(unit(descriptor.persistenceLoadQ48, 'INTERO persistence load'), deviation),
      q48.fromDecimal('0.25')
    );
    persistence = q48.clamp(q48.saturatingAdd(persistence, load), 0n, q48.SCALE);
  } else {
    const relief = q48.mul(unit(descriptor.persistenceReliefQ48, 'INTERO persistence relief'), q48.fromDecimal('0.25'));
    persistence = persistence > relief ? persistence - relief : 0n;
  }
  const weights = descriptor.salienceWeights;
  const totalWeight = unit(weights.deviationQ48, 'INTERO deviation weight') +
    unit(weights.trendQ48, 'INTERO trend weight') +
    unit(weights.persistenceQ48, 'INTERO persistence weight');
  const weighted = q48.mul(deviation, unit(weights.deviationQ48, 'INTERO deviation weight')) +
    q48.mul(absolute(trend), unit(weights.trendQ48, 'INTERO trend weight')) +
    q48.mul(persistence, unit(weights.persistenceQ48, 'INTERO persistence weight'));
  const salience = totalWeight === 0n ? 0n : q48.clamp(q48.div(weighted, totalWeight), 0n, q48.SCALE);
  const saturated = perceived === low || perceived === high;
  const next = {
    channelId: descriptor.channelId,
    delayRingHash: sha256({ previous: previous.delayRingHash, frameId: evidence.frame.frameId, delayFrames: descriptor.delayFrames }),
    delayIndex: (previous.delayIndex + 1) % descriptor.trendWindowFrames,
    filteredQ48: filtered.toString(),
    trendQ48: trend.toString(),
    baselineQ48: adapted.baseline.toString(),
    lifetimeDriftQ48: adapted.drift.toString(),
    persistenceQ48: persistence.toString(),
    salienceQ48: salience.toString(),
    saturated,
    quality: 'ACCEPT',
    sourceSequence: evidence.frame.producerSequence
  };
  return {
    state: next,
    coverageQ48: evidence.frame.quality.coverageQ48,
    payload: {
      channelId: descriptor.channelId,
      levelQ48: next.filteredQ48,
      trendQ48: next.trendQ48,
      baselineDeltaQ48: (filtered - adapted.baseline).toString(),
      persistenceQ48: next.persistenceQ48,
      salienceQ48: next.salienceQ48,
      confidenceQ48: evidence.frame.quality.confidenceQ48,
      validity: 'VALID',
      saturated,
      sourceWindow: clone(evidence.frame.sourceWindow)
    }
  };
}

function buildAxes(profile, channelPayloads) {
  const byChannel = new Map(channelPayloads.map(channel => [channel.channelId, channel]));
  return profile.axes.map(axis => {
    let numerator = 0n;
    let denominator = 0n;
    let confidence = q48.SCALE;
    for (const weight of axis.weights) {
      const channel = byChannel.get(weight.channelId);
      const levelWeight = unit(weight.levelQ48, 'INTERO axis level weight');
      const trendWeight = unit(weight.trendQ48, 'INTERO axis trend weight');
      const persistenceWeight = unit(weight.persistenceQ48, 'INTERO axis persistence weight');
      numerator += q48.mul(unit(channel.levelQ48, 'INTERO axis level'), levelWeight);
      numerator += q48.mul(absolute(raw(channel.trendQ48, 'INTERO axis trend')), trendWeight);
      numerator += q48.mul(unit(channel.persistenceQ48, 'INTERO axis persistence'), persistenceWeight);
      denominator += levelWeight + trendWeight + persistenceWeight;
      confidence = minimum(confidence, unit(channel.confidenceQ48, 'INTERO axis confidence'));
    }
    const value = denominator === 0n ? 0n : q48.clamp(q48.div(numerator, denominator), 0n, q48.SCALE);
    return {
      axisId: axis.axisId,
      valueQ48: value.toString(),
      confidenceQ48: confidence.toString(),
      requiredCoverageQ48: axis.requiredCoverageQ48,
      channelIds: axis.weights.map(weight => weight.channelId)
    };
  });
}

function band(value) {
  const low = q48.roundHalfEven(q48.SCALE, 3n);
  const high = q48.roundHalfEven(q48.SCALE * 2n, 3n);
  return value < low ? 'LOW' : value > high ? 'HIGH' : 'MID';
}

function buildProjection(profile, state, updates) {
  const channels = updates.map(update => update.payload);
  const axes = buildAxes(profile, channels);
  const confidence = channels.reduce(
    (value, channel) => minimum(value, unit(channel.confidenceQ48, 'INTERO body confidence')),
    q48.SCALE
  );
  const coverage = updates.reduce(
    (value, update) => minimum(value, unit(update.coverageQ48, 'INTERO body coverage')),
    q48.SCALE
  );
  const bodyFrame = {
    frameFrontier: state.frameIndex,
    frameIndex: state.frameIndex,
    channels,
    axes,
    profileHash: sha256(profile),
    transformVersion: profile.transformVersion,
    requiredCoverageQ48: axes.reduce(
      (value, axis) => minimum(value, unit(axis.requiredCoverageQ48, 'INTERO required coverage')),
      q48.SCALE
    ).toString()
  };
  const bodySummary = {
    axisBands: Object.fromEntries(axes.map(axis => [axis.axisId, band(unit(axis.valueQ48, 'INTERO axis value'))])),
    coverageQ48: coverage.toString(),
    confidenceQ48: confidence.toString(),
    validChannelCount: channels.length
  };
  return deepFreeze({ bodyFrame, bodySummary });
}

function createInteroEngine(options = {}) {
  exact(options, OPTION_FIELDS, 'INTERO engine options', 'P1_INTERO_OPTIONS');
  const profile = validateInteroFounderProfile(options.profile);
  const identity = validateIdentity(options.identity);
  let state = initialState(profile);
  const seen = new Map();
  const sourceSequences = new Map();

  function snapshot() {
    return deepFreeze(clone(state));
  }

  function restore(input) {
    const next = validateState(input, profile);
    if (
      next.frameIndex < state.frameIndex ||
      next.counterFrontier < state.counterFrontier ||
      BigInt(next.outputSequence) < BigInt(state.outputSequence) ||
      next.channels.some((channel, index) => BigInt(channel.sourceSequence) < BigInt(state.channels[index].sourceSequence))
    ) fail('INTERO restore would rewind acquired perception', 'P1_INTERO_REWIND');
    state = next;
    return snapshot();
  }

  function advance(input) {
    exact(input, ADVANCE_FIELDS, 'INTERO advance input');
    const frameIndex = integer(input.frameIndex, 'INTERO frame index', 1);
    if (input.inputs !== null && !Array.isArray(input.inputs)) fail('INTERO inputs are invalid', 'P1_INTERO_ENGINE_SCHEMA');
    const inputHash = input.inputs === null ? null : sha256(input.inputs);
    if (inputHash && seen.has(inputHash)) {
      return deepFreeze({ state: snapshot(), projection: null, outputs: [], duplicate: true });
    }
    if (state.frameIndex !== 0 && frameIndex !== state.frameIndex + 1) {
      fail('INTERO frame progression is not contiguous', 'P1_INTERO_FRAME_SEQUENCE');
    }

    if (input.inputs === null) {
      state = {
        ...state,
        frameIndex,
        channels: state.channels.map(channel => ({ ...channel, quality: 'UNKNOWN' })),
        lifecycle: 'UNRESOLVED'
      };
      return deepFreeze({ state: snapshot(), projection: null, outputs: [], duplicate: false });
    }

    const collected = collectInteroInputs(input.inputs, frameIndex);
    if (collected.organismId !== identity.organismId) fail('INTERO cannot cross organism identity', 'P1_INTERO_INPUT_IDENTITY');
    const minimumConfidence = unit(profile.minimumConfidenceQ48, 'INTERO minimum confidence');
    for (const evidence of collected.channels) {
      if (unit(evidence.frame.quality.confidenceQ48, 'INTERO source confidence') < minimumConfidence) {
        fail('INTERO source confidence is below its founder minimum', 'P1_INTERO_INPUT_CONFIDENCE');
      }
      const cursorKey = `${evidence.frame.route.routeId}:${evidence.frame.producerSequence}`;
      const previousFrameId = sourceSequences.get(cursorKey);
      if (previousFrameId && previousFrameId !== evidence.frame.frameId) {
        fail('INTERO source sequence was replayed with conflicting content', 'P1_INTERO_REPLAY_CONFLICT');
      }
      const currentCursor = BigInt(state.inputCursors[evidence.frame.route.routeId]);
      if (BigInt(evidence.frame.producerSequence) <= currentCursor) {
        fail('INTERO source sequence does not advance its committed cursor', 'P1_INTERO_REPLAY_CONFLICT');
      }
    }
    seen.set(inputHash, true);
    for (const evidence of collected.channels) {
      sourceSequences.set(`${evidence.frame.route.routeId}:${evidence.frame.producerSequence}`, evidence.frame.frameId);
    }
    const byChannel = new Map(collected.channels.map(channel => [channel.channelId, channel]));
    const counterFrontier = state.counterFrontier + 1;
    const updates = profile.channels.map((descriptor, index) =>
      updateChannel(state.channels[index], descriptor, byChannel.get(descriptor.channelId), frameIndex, counterFrontier, profile)
    );
    const lifecycle = updates.some(update => update.state.saturated)
      ? 'SATURATED'
      : state.lifecycle === 'UNRESOLVED' ? 'RECOVERING' : 'SENSING';
    state = {
      frameIndex,
      counterFrontier,
      channels: updates.map(update => update.state),
      lifecycle,
      inputCursors: Object.fromEntries(collected.channels.map(evidence => [
        evidence.frame.route.routeId, evidence.frame.producerSequence
      ]).sort(([left], [right]) => left.localeCompare(right))),
      outputSequence: state.outputSequence
    };
    const projection = buildProjection(profile, state, updates);

    // The single INTERO->SNTSS route remains ABSENT in this tranche. A contained
    // projection is returned for laboratory qualification but no routed frame exists.
    return deepFreeze({ state: snapshot(), projection, outputs: [], duplicate: false });
  }

  return Object.freeze({ advance, snapshot, restore });
}

module.exports = Object.freeze({ createInteroEngine });
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
"runtime/p1-r0/residents/intero-neutral.js": function(module, exports, __bundleRequire) {
'use strict';

const { stableStringify } = __bundleRequire("runtime/kernel/canonical-json.js");
const { createInteroEngine } = __bundleRequire("runtime/p1-r0/intero-engine.js");
const {
  RESOURCES, clone, deepFreeze, exact, fail, normalizeRuntimeBinding, sha256
} = __bundleRequire("runtime/p1-r0/resident-support.js");

const CORE_ID = 'INTERO';
const RESIDENCY_ID = 'resident:intero';
const VERSION = '0.1.0-p1r0-neutral.1';
const STAGE = 'p1-r0-production-neutral-r147';
const FOUNDER_FIELDS = new Set([
  'recordVersion', 'coreId', 'organismId', 'organismIdentityHash',
  'founderId', 'lineageId', 'residencyId', 'profileId', 'profileHash',
  'profile', 'mode', 'authorityEpoch'
]);
const STATE_FIELDS = new Set([
  'schema', 'runtimeBinding', 'founder', 'engineState', 'lastProjection',
  'handledEvents'
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
  inputs: Object.freeze(['runtime.organism.binding']),
  outputs: Object.freeze([]),
  biology: Object.freeze({
    protocol: 'stay-biological-signalling-fabric-v1',
    producerCapabilities: Object.freeze([]),
    consumerRouteLeases: Object.freeze([])
  }),
  resources: RESOURCES
});

function normalizeNeutralFounder(payload, runtimeBinding) {
  exact(payload, FOUNDER_FIELDS, 'INTERO neutral founder binding', 'P1_INTERO_NEUTRAL_FOUNDER');
  if (
    payload.recordVersion !== 'P1ResidentFounderBindingV1' ||
    payload.coreId !== CORE_ID || payload.residencyId !== RESIDENCY_ID ||
    payload.mode !== 'NEUTRAL' || payload.authorityEpoch !== '0' ||
    !runtimeBinding || payload.organismIdentityHash !== runtimeBinding.identitySha256
  ) fail('INTERO neutral founder identity is invalid', 'P1_INTERO_NEUTRAL_FOUNDER');
  for (const field of ['organismId', 'founderId', 'lineageId', 'residencyId', 'profileId']) {
    if (typeof payload[field] !== 'string' || !SAFE_ID.test(payload[field])) {
      fail(`INTERO neutral founder ${field} is invalid`, 'P1_INTERO_NEUTRAL_FOUNDER');
    }
  }
  if (
    !HASH.test(String(payload.organismIdentityHash || '')) ||
    !HASH.test(String(payload.profileHash || '')) ||
    !payload.profile || typeof payload.profile !== 'object' || Array.isArray(payload.profile) ||
    payload.profile.profileId !== payload.profileId || sha256(payload.profile) !== payload.profileHash
  ) fail('INTERO neutral founder profile binding is invalid', 'P1_INTERO_NEUTRAL_FOUNDER');
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

function createNeutralInteroInitialState({ binding, founder } = {}) {
  const runtimeBinding = normalizeRuntimeBinding(binding);
  const normalizedFounder = normalizeNeutralFounder(founder, runtimeBinding);
  const engine = createInteroEngine({
    profile: normalizedFounder.profile,
    identity: engineIdentity(normalizedFounder)
  });
  return deepFreeze({
    schema: 'stay-p1-r0-resident/intero-neutral-state-v1',
    runtimeBinding: clone(runtimeBinding),
    founder: clone(normalizedFounder),
    engineState: clone(engine.snapshot()),
    lastProjection: null,
    handledEvents: 0
  });
}

function validateState(input) {
  exact(input, STATE_FIELDS, 'INTERO neutral state', 'P1_INTERO_NEUTRAL_STATE');
  if (
    input.schema !== 'stay-p1-r0-resident/intero-neutral-state-v1' ||
    input.lastProjection !== null || input.handledEvents !== 0
  ) fail('INTERO neutral state is invalid', 'P1_INTERO_NEUTRAL_STATE');
  const runtimeBinding = normalizeRuntimeBinding(input.runtimeBinding);
  const founder = normalizeNeutralFounder(input.founder, runtimeBinding);
  const engine = createInteroEngine({ profile: founder.profile, identity: engineIdentity(founder) });
  engine.restore(input.engineState);
  if (engine.snapshot().frameIndex !== 0 || engine.snapshot().outputSequence !== '0') {
    fail('INTERO neutral state contains perception or output', 'P1_INTERO_NEUTRAL_OUTPUT');
  }
  return deepFreeze({
    schema: input.schema,
    runtimeBinding: clone(runtimeBinding),
    founder: clone(founder),
    engineState: clone(engine.snapshot()),
    lastProjection: null,
    handledEvents: 0
  });
}

async function createCore({ manifest: activeManifest = manifest, initialState, emit = async () => null } = {}) {
  if (
    activeManifest.coreId !== CORE_ID || activeManifest.version !== VERSION ||
    activeManifest.stateSchema !== 1 ||
    stableStringify(activeManifest.inputs) !== stableStringify(manifest.inputs) ||
    stableStringify(activeManifest.outputs) !== stableStringify([]) || typeof emit !== 'function'
  ) fail('INTERO neutral manifest mismatch', 'P1_INTERO_NEUTRAL_MANIFEST');
  if (!initialState || Object.keys(initialState).length === 0) {
    fail('INTERO neutral requires a precommitted founder', 'P1_INTERO_NEUTRAL_FOUNDER_REQUIRED');
  }
  let state = clone(validateState(initialState));
  return Object.freeze({
    async start() { state = clone(validateState(state)); },
    async handle(event) {
      if (event?.topic !== 'runtime.organism.binding') {
        fail('INTERO neutral input is forbidden', 'P1_INTERO_NEUTRAL_INPUT');
      }
      const next = normalizeRuntimeBinding(event.payload);
      if (sha256(next) !== sha256(state.runtimeBinding)) {
        fail('INTERO neutral runtime identity cannot change', 'P1_INTERO_NEUTRAL_IDENTITY');
      }
    },
    async snapshot() { return clone(validateState(state)); },
    async health() {
      validateState(state);
      return Object.freeze({
        ok: true,
        mode: 'NEUTRAL',
        authorityOwned: false,
        foundered: true,
        lifecycle: 'INITIALIZING',
        frameIndex: 0,
        projectionAvailable: false,
        biologicalOutputs: 0,
        physiologicalInputs: 0,
        receptorRoute: 'ABSENT',
        outputPolicy: 'PERCEPTION_ONLY_NO_OUTPUT'
      });
    },
    async stop() {}
  });
}

async function migrateState({ state, fromSchema, toSchema }) {
  if (fromSchema !== 1 || toSchema !== 1) {
    fail(`unsupported INTERO neutral migration ${fromSchema}->${toSchema}`, 'P1_INTERO_NEUTRAL_MIGRATION');
  }
  return clone(validateState(state));
}

module.exports = Object.freeze({
  CORE_ID,
  RESIDENCY_ID,
  STAGE,
  VERSION,
  createCore,
  createNeutralInteroInitialState,
  manifest,
  migrateState,
  normalizeNeutralFounder,
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
module.exports = __bundleRequire("runtime/p1-r0/residents/intero-neutral.js");
