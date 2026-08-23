'use strict';

const {
  stableStringify
} = require('./canonical-json');

const {
  AUTHORITY_MODE,
  SIGNAL_CLASS,
  DURABILITY_CLASS,
  MAX_PAYLOAD_BYTES
} = require('./biological-envelope');

const BSF_PROTOCOL =
  'stay-biological-signalling-fabric-v1';

const EVIDENCE_ROLE =
  Object.freeze({
    PRIMARY_PHYSIOLOGICAL_INPUT:
      'PRIMARY_PHYSIOLOGICAL_INPUT',

    DERIVED_SUPPORTING_FACT:
      'DERIVED_SUPPORTING_FACT',

    DIAGNOSTIC_CROSSCHECK:
      'DIAGNOSTIC_CROSSCHECK',

    OBSERVER_ONLY:
      'OBSERVER_ONLY'
  });

const REQUIRED_ORDERING =
  Object.freeze({
    CANONICAL:
      'CANONICAL'
  });

const DELIVERY_MODE =
  Object.freeze({
    LIVE:
      'LIVE',

    RECOVERY_REPLAY:
      'RECOVERY_REPLAY'
  });

const DELIVERY_STATUS =
  Object.freeze({
    DELIVER:
      'DELIVER',

    DELIVER_CLIPPED:
      'DELIVER_CLIPPED',

    OBSERVE_ONLY:
      'OBSERVE_ONLY',

    REJECTED:
      'REJECTED',

    RATE_LIMITED:
      'RATE_LIMITED',

    DEGRADED:
      'DEGRADED'
  });

const DURABILITY_RANK =
  new Map([
    [
      DURABILITY_CLASS.EPHEMERAL_REPLAYABLE,
      1
    ],
    [
      DURABILITY_CLASS.CHECKPOINT_CRITICAL,
      2
    ],
    [
      DURABILITY_CLASS.DURABLE_TRANSITION,
      3
    ]
  ]);

const EXPIRING_SIGNAL_CLASSES =
  new Set([
    SIGNAL_CLASS.CHEMICAL_MODULATION,
    SIGNAL_CLASS.REGULATORY_EFFERENT
  ]);

const FORBIDDEN_FIRST_GENERATION_PAIRS =
  new Set([
    'sntss->pulse',
    'pulse->sntss',
    'chronobiology->kernel'
  ]);

const MAX_CAPABILITIES_PER_CORE = 64;
const MAX_ROUTES_PER_CORE = 128;
const MAX_SCHEMA_VERSIONS = 16;
const MAX_STREAM_IDS = 32;
const MAX_PRODUCER_IDS = 16;
const MAX_RATE_EVENTS = 100_000;
const MAX_RATE_INTERVAL_US = 86_400_000_000;
const MAX_LAG_BUDGET_US = 86_400_000_000;
const MAX_VALIDITY_US = 86_400_000_000;
const MAX_OBSERVER_CAPACITY = 4096;


function fail(
  message,
  code = 'BIOLOGICAL_BSF_INVALID'
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
      `${label} must be an object`,
      'BIOLOGICAL_BSF_MANIFEST'
    );
  }

  return value;
}


function boundedText(
  value,
  label,
  maximumBytes = 160
) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    Buffer.byteLength(
      value,
      'utf8'
    ) > maximumBytes
  ) {
    fail(
      `${label} is invalid`,
      'BIOLOGICAL_BSF_MANIFEST'
    );
  }

  return value;
}


function exactFields(
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
    if (!allowed.has(key)) {
      fail(
        `${label} contains unknown field ${key}`,
        'BIOLOGICAL_BSF_MANIFEST'
      );
    }
  }
}


function boundedInteger(
  value,
  label,
  {
    minimum = 0,
    maximum = Number.MAX_SAFE_INTEGER
  } = {}
) {
  const number =
    Number(value);

  if (
    !Number.isSafeInteger(number) ||
    number < minimum ||
    number > maximum
  ) {
    fail(
      `${label} is invalid`,
      'BIOLOGICAL_BSF_MANIFEST'
    );
  }

  return number;
}


function uniqueSortedStrings(
  value,
  label,
  {
    minimum = 1,
    maximum = 32,
    maximumBytes = 160
  } = {}
) {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    fail(
      `${label} is invalid`,
      'BIOLOGICAL_BSF_MANIFEST'
    );
  }

  const normalized =
    value.map(
      (entry, index) =>
        boundedText(
          entry,
          `${label}[${index}]`,
          maximumBytes
        )
    );

  if (
    new Set(normalized).size !==
      normalized.length
  ) {
    fail(
      `${label} contains duplicates`,
      'BIOLOGICAL_BSF_MANIFEST'
    );
  }

  return Object.freeze(
    normalized.sort()
  );
}


function uniqueSortedIntegers(
  value,
  label
) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length >
      MAX_SCHEMA_VERSIONS
  ) {
    fail(
      `${label} is invalid`,
      'BIOLOGICAL_BSF_MANIFEST'
    );
  }

  const normalized =
    value.map(
      (entry, index) =>
        boundedInteger(
          entry,
          `${label}[${index}]`,
          {
            minimum: 1,
            maximum: 65_535
          }
        )
    );

  if (
    new Set(normalized).size !==
      normalized.length
  ) {
    fail(
      `${label} contains duplicates`,
      'BIOLOGICAL_BSF_MANIFEST'
    );
  }

  return Object.freeze(
    normalized.sort(
      (a, b) => a - b
    )
  );
}


function authorityModes(
  value,
  label
) {
  const modes =
    uniqueSortedStrings(
      value,
      label,
      {
        maximum:
          Object.values(
            AUTHORITY_MODE
          ).length,

        maximumBytes:
          32
      }
    );

  for (
    const mode of
      modes
  ) {
    if (
      !Object.values(
        AUTHORITY_MODE
      ).includes(mode)
    ) {
      fail(
        `${label} contains invalid authority mode ${mode}`,
        'BIOLOGICAL_BSF_MANIFEST'
      );
    }
  }

  return modes;
}


function signalClass(
  value,
  label
) {
  if (
    !Object.values(
      SIGNAL_CLASS
    ).includes(value)
  ) {
    fail(
      `${label} is invalid`,
      'BIOLOGICAL_BSF_MANIFEST'
    );
  }

  return value;
}


function durabilityClass(
  value,
  label
) {
  if (
    !Object.values(
      DURABILITY_CLASS
    ).includes(value)
  ) {
    fail(
      `${label} is invalid`,
      'BIOLOGICAL_BSF_MANIFEST'
    );
  }

  return value;
}


function topicSelector(
  value,
  label
) {
  const hasTopic =
    value.topic != null;

  const hasPrefix =
    value.topicPrefix != null;

  if (
    hasTopic === hasPrefix
  ) {
    fail(
      `${label} must declare exactly one of topic or topicPrefix`,
      'BIOLOGICAL_BSF_MANIFEST'
    );
  }

  if (hasTopic) {
    const topic =
      boundedText(
        value.topic,
        `${label}.topic`,
        96
      );

    if (topic.includes('*')) {
      fail(
        `${label}.topic may not contain wildcard syntax`,
        'BIOLOGICAL_BSF_WILDCARD'
      );
    }

    return Object.freeze({
      type:
        'EXACT',

      value:
        topic
    });
  }

  const prefix =
    boundedText(
      value.topicPrefix,
      `${label}.topicPrefix`,
      96
    );

  if (
    prefix.includes('*') ||
    prefix === '.' ||
    !prefix.includes('.') ||
    !prefix.endsWith('.')
  ) {
    fail(
      `${label}.topicPrefix must be one bounded namespace ending in a dot`,
      'BIOLOGICAL_BSF_WILDCARD'
    );
  }

  return Object.freeze({
    type:
      'PREFIX',

    value:
      prefix
  });
}


function canonicalSelectorInput(
  selector,
  label
) {
  exactFields(
    selector,
    new Set([
      'type',
      'value'
    ]),
    `${label}.selector`
  );

  if (
    selector.type !== 'EXACT' &&
    selector.type !== 'PREFIX'
  ) {
    fail(
      `${label}.selector.type is invalid`,
      'BIOLOGICAL_BSF_MANIFEST'
    );
  }

  return selector.type === 'EXACT'
    ? { topic: selector.value }
    : { topicPrefix: selector.value };
}


function selectorMatches(
  selector,
  topic
) {
  if (
    selector.type ===
      'EXACT'
  ) {
    return topic ===
      selector.value;
  }

  return topic.startsWith(
    selector.value
  );
}


function selectorsOverlap(
  left,
  right
) {
  if (
    left.type === 'EXACT' &&
    right.type === 'EXACT'
  ) {
    return left.value ===
      right.value;
  }

  if (
    left.type === 'PREFIX' &&
    right.type === 'PREFIX'
  ) {
    return (
      left.value.startsWith(
        right.value
      ) ||
      right.value.startsWith(
        left.value
      )
    );
  }

  const exact =
    left.type === 'EXACT'
      ? left
      : right;

  const prefix =
    left.type === 'PREFIX'
      ? left
      : right;

  return exact.value.startsWith(
    prefix.value
  );
}


function arraysIntersect(
  left,
  right
) {
  const set =
    new Set(left);

  return right.some(
    entry => set.has(entry)
  );
}


function epochRangesOverlap(
  left,
  right
) {
  return (
    left.minimum <= right.maximum &&
    right.minimum <= left.maximum
  );
}


function normalizeRate(
  value,
  label
) {
  exactFields(
    value,
    new Set([
      'events',
      'intervalUs'
    ]),
    label
  );

  return Object.freeze({
    events:
      boundedInteger(
        value.events,
        `${label}.events`,
        {
          minimum: 1,
          maximum:
            MAX_RATE_EVENTS
        }
      ),

    intervalUs:
      boundedInteger(
        value.intervalUs,
        `${label}.intervalUs`,
        {
          minimum: 1,
          maximum:
            MAX_RATE_INTERVAL_US
        }
      )
  });
}


function normalizeProducerCapability(
  value,
  coreId,
  index
) {
  const label =
    `biology.producerCapabilities[${index}]`;

  if (
    value &&
    (value.coreId != null || value.selector != null)
  ) {
    exactFields(
      value,
      new Set([
        'id',
        'coreId',
        'selector',
        'signalClass',
        'schemaVersions',
        'producerStreamIds',
        'maxRate',
        'maxPayloadBytes',
        'maxValidityUs',
        'allowedAuthorityModes'
      ]),
      label
    );

    if (
      boundedText(
        value.coreId,
        `${label}.coreId`,
        128
      ) !== coreId
    ) {
      fail(
        `${label}.coreId differs from manifest coreId`,
        'BIOLOGICAL_BSF_MANIFEST'
      );
    }

    value = {
      id: value.id,
      ...canonicalSelectorInput(
        value.selector,
        label
      ),
      signalClass: value.signalClass,
      schemaVersions: value.schemaVersions,
      producerStreamIds: value.producerStreamIds,
      maxRate: value.maxRate,
      maxPayloadBytes: value.maxPayloadBytes,
      maxValidityUs: value.maxValidityUs,
      allowedAuthorityModes: value.allowedAuthorityModes
    };
  }

  exactFields(
    value,
    new Set([
      'id',
      'topic',
      'topicPrefix',
      'signalClass',
      'schemaVersions',
      'producerStreamIds',
      'maxRate',
      'maxPayloadBytes',
      'maxValidityUs',
      'allowedAuthorityModes'
    ]),
    label
  );

  const selector =
    topicSelector(
      value,
      label
    );

  const maxPayloadBytes =
    boundedInteger(
      value.maxPayloadBytes,
      `${label}.maxPayloadBytes`,
      {
        minimum: 1,
        maximum:
          MAX_PAYLOAD_BYTES
      }
    );

  const maxValidityUs =
    value.maxValidityUs == null
      ? null
      : boundedInteger(
          value.maxValidityUs,
          `${label}.maxValidityUs`,
          {
            minimum: 1,
            maximum:
              MAX_VALIDITY_US
          }
        );

  return Object.freeze({
    id:
      boundedText(
        value.id,
        `${label}.id`,
        96
      ),

    coreId,
    selector,

    signalClass:
      signalClass(
        value.signalClass,
        `${label}.signalClass`
      ),

    schemaVersions:
      uniqueSortedIntegers(
        value.schemaVersions,
        `${label}.schemaVersions`
      ),

    producerStreamIds:
      uniqueSortedStrings(
        value.producerStreamIds,
        `${label}.producerStreamIds`,
        {
          maximum:
            MAX_STREAM_IDS,

          maximumBytes:
            200
        }
      ),

    maxRate:
      normalizeRate(
        value.maxRate,
        `${label}.maxRate`
      ),

    maxPayloadBytes,
    maxValidityUs,

    allowedAuthorityModes:
      authorityModes(
        value.allowedAuthorityModes,
        `${label}.allowedAuthorityModes`
      )
  });
}


function normalizeEpochRange(
  value,
  label
) {
  exactFields(
    value,
    new Set([
      'minimum',
      'maximum'
    ]),
    label
  );

  const minimum =
    boundedInteger(
      value.minimum,
      `${label}.minimum`,
      { minimum: 1 }
    );

  const maximum =
    boundedInteger(
      value.maximum,
      `${label}.maximum`,
      { minimum: minimum }
    );

  return Object.freeze({
    minimum,
    maximum
  });
}


function normalizeRouteLease(
  value,
  coreId,
  index
) {
  const label =
    `biology.consumerRouteLeases[${index}]`;

  if (
    value &&
    value.selector != null
  ) {
    exactFields(
      value,
      new Set([
        'id',
        'consumerCoreId',
        'acceptedProducerCoreIds',
        'producerStreamIds',
        'selector',
        'signalClass',
        'schemaVersions',
        'requiredDurability',
        'requiredOrdering',
        'evidenceRole',
        'lagBudgetUs',
        'activeAuthorityEpochRange',
        'required'
      ]),
      label
    );

    value = {
      id: value.id,
      consumerCoreId: value.consumerCoreId,
      acceptedProducerCoreIds: value.acceptedProducerCoreIds,
      producerStreamIds: value.producerStreamIds,
      ...canonicalSelectorInput(
        value.selector,
        label
      ),
      signalClass: value.signalClass,
      schemaVersions: value.schemaVersions,
      requiredDurability: value.requiredDurability,
      requiredOrdering: value.requiredOrdering,
      evidenceRole: value.evidenceRole,
      lagBudgetUs: value.lagBudgetUs,
      activeAuthorityEpochRange: value.activeAuthorityEpochRange,
      required: value.required
    };
  }

  exactFields(
    value,
    new Set([
      'id',
      'consumerCoreId',
      'acceptedProducerCoreIds',
      'producerStreamIds',
      'topic',
      'topicPrefix',
      'signalClass',
      'schemaVersions',
      'requiredDurability',
      'requiredOrdering',
      'evidenceRole',
      'lagBudgetUs',
      'activeAuthorityEpochRange',
      'required'
    ]),
    label
  );

  const consumerCoreId =
    boundedText(
      value.consumerCoreId,
      `${label}.consumerCoreId`,
      128
    );

  if (
    consumerCoreId !==
      coreId
  ) {
    fail(
      `${label}.consumerCoreId must equal manifest coreId`,
      'BIOLOGICAL_BSF_MANIFEST'
    );
  }

  const acceptedProducerCoreIds =
    uniqueSortedStrings(
      value.acceptedProducerCoreIds,
      `${label}.acceptedProducerCoreIds`,
      {
        maximum:
          MAX_PRODUCER_IDS,

        maximumBytes:
          128
      }
    );

  for (
    const producerCoreId of
      acceptedProducerCoreIds
  ) {
    if (
      FORBIDDEN_FIRST_GENERATION_PAIRS.has(
        `${producerCoreId}->${consumerCoreId}`
      )
    ) {
      fail(
        `forbidden first-generation anatomy ${producerCoreId}->${consumerCoreId}`,
        'BIOLOGICAL_BSF_FORBIDDEN_ANATOMY'
      );
    }
  }

  if (
    consumerCoreId ===
      'kernel'
  ) {
    fail(
      'Living Kernel cannot be a biological consumer route target',
      'BIOLOGICAL_BSF_FORBIDDEN_ANATOMY'
    );
  }

  if (
    typeof value.required !==
      'boolean'
  ) {
    fail(
      `${label}.required must be boolean`,
      'BIOLOGICAL_BSF_MANIFEST'
    );
  }

  if (
    value.requiredOrdering !==
      REQUIRED_ORDERING.CANONICAL
  ) {
    fail(
      `${label}.requiredOrdering must be CANONICAL`,
      'BIOLOGICAL_BSF_MANIFEST'
    );
  }

  if (
    !Object.values(
      EVIDENCE_ROLE
    ).includes(
      value.evidenceRole
    )
  ) {
    fail(
      `${label}.evidenceRole is invalid`,
      'BIOLOGICAL_BSF_MANIFEST'
    );
  }

  return Object.freeze({
    id:
      boundedText(
        value.id,
        `${label}.id`,
        96
      ),

    consumerCoreId,
    acceptedProducerCoreIds,

    producerStreamIds:
      uniqueSortedStrings(
        value.producerStreamIds,
        `${label}.producerStreamIds`,
        {
          maximum:
            MAX_STREAM_IDS,

          maximumBytes:
            200
        }
      ),

    selector:
      topicSelector(
        value,
        label
      ),

    signalClass:
      signalClass(
        value.signalClass,
        `${label}.signalClass`
      ),

    schemaVersions:
      uniqueSortedIntegers(
        value.schemaVersions,
        `${label}.schemaVersions`
      ),

    requiredDurability:
      durabilityClass(
        value.requiredDurability,
        `${label}.requiredDurability`
      ),

    requiredOrdering:
      REQUIRED_ORDERING.CANONICAL,

    evidenceRole:
      value.evidenceRole,

    lagBudgetUs:
      boundedInteger(
        value.lagBudgetUs,
        `${label}.lagBudgetUs`,
        {
          minimum: 0,
          maximum:
            MAX_LAG_BUDGET_US
        }
      ),

    activeAuthorityEpochRange:
      normalizeEpochRange(
        value.activeAuthorityEpochRange,
        `${label}.activeAuthorityEpochRange`
      ),

    required:
      value.required
  });
}


function assertUniqueIds(
  values,
  label
) {
  const ids =
    values.map(
      value => value.id
    );

  if (
    new Set(ids).size !==
      ids.length
  ) {
    fail(
      `${label} contains duplicate ids`,
      'BIOLOGICAL_BSF_MANIFEST'
    );
  }
}


function assertCapabilitiesUnambiguous(
  capabilities
) {
  for (
    let leftIndex = 0;
    leftIndex < capabilities.length;
    leftIndex += 1
  ) {
    const left =
      capabilities[leftIndex];

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < capabilities.length;
      rightIndex += 1
    ) {
      const right =
        capabilities[rightIndex];

      if (
        left.signalClass ===
          right.signalClass &&
        selectorsOverlap(
          left.selector,
          right.selector
        ) &&
        arraysIntersect(
          left.schemaVersions,
          right.schemaVersions
        ) &&
        arraysIntersect(
          left.producerStreamIds,
          right.producerStreamIds
        ) &&
        arraysIntersect(
          left.allowedAuthorityModes,
          right.allowedAuthorityModes
        )
      ) {
        fail(
          `producer capabilities ${left.id} and ${right.id} overlap`,
          'BIOLOGICAL_BSF_AMBIGUOUS_CAPABILITY'
        );
      }
    }
  }
}


function assertRoutesUnambiguous(
  routes
) {
  for (
    let leftIndex = 0;
    leftIndex < routes.length;
    leftIndex += 1
  ) {
    const left =
      routes[leftIndex];

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < routes.length;
      rightIndex += 1
    ) {
      const right =
        routes[rightIndex];

      if (
        left.signalClass ===
          right.signalClass &&
        selectorsOverlap(
          left.selector,
          right.selector
        ) &&
        arraysIntersect(
          left.schemaVersions,
          right.schemaVersions
        ) &&
        arraysIntersect(
          left.producerStreamIds,
          right.producerStreamIds
        ) &&
        arraysIntersect(
          left.acceptedProducerCoreIds,
          right.acceptedProducerCoreIds
        ) &&
        epochRangesOverlap(
          left.activeAuthorityEpochRange,
          right.activeAuthorityEpochRange
        )
      ) {
        fail(
          `consumer routes ${left.id} and ${right.id} overlap`,
          'BIOLOGICAL_BSF_AMBIGUOUS_ROUTE'
        );
      }
    }
  }
}


function normalizeBiologyManifest(
  value,
  coreId
) {
  if (value == null) {
    return null;
  }

  boundedText(
    coreId,
    'manifest.coreId',
    128
  );

  exactFields(
    value,
    new Set([
      'protocol',
      'producerCapabilities',
      'consumerRouteLeases'
    ]),
    'manifest.biology'
  );

  if (
    value.protocol !==
      BSF_PROTOCOL
  ) {
    fail(
      'manifest.biology.protocol is unsupported',
      'BIOLOGICAL_BSF_PROTOCOL'
    );
  }

  const producerCapabilities =
    value.producerCapabilities == null
      ? []
      : value.producerCapabilities;

  const consumerRouteLeases =
    value.consumerRouteLeases == null
      ? []
      : value.consumerRouteLeases;

  if (
    !Array.isArray(
      producerCapabilities
    ) ||
    producerCapabilities.length >
      MAX_CAPABILITIES_PER_CORE ||
    !Array.isArray(
      consumerRouteLeases
    ) ||
    consumerRouteLeases.length >
      MAX_ROUTES_PER_CORE
  ) {
    fail(
      'manifest biological capability/route bounds exceeded',
      'BIOLOGICAL_BSF_MANIFEST'
    );
  }

  const capabilities =
    Object.freeze(
      producerCapabilities.map(
        (entry, index) =>
          normalizeProducerCapability(
            entry,
            coreId,
            index
          )
      )
    );

  const routes =
    Object.freeze(
      consumerRouteLeases.map(
        (entry, index) =>
          normalizeRouteLease(
            entry,
            coreId,
            index
          )
      )
    );

  assertUniqueIds(
    capabilities,
    'producer capabilities'
  );

  assertUniqueIds(
    routes,
    'consumer route leases'
  );

  assertCapabilitiesUnambiguous(
    capabilities
  );

  assertRoutesUnambiguous(
    routes
  );

  return Object.freeze({
    protocol:
      BSF_PROTOCOL,

    producerCapabilities:
      capabilities,

    consumerRouteLeases:
      routes
  });
}


function payloadBytes(
  payload
) {
  let serialized;

  try {
    serialized =
      stableStringify(payload);
  } catch {
    fail(
      'biological payload is not canonical JSON',
      'BIOLOGICAL_BSF_PAYLOAD'
    );
  }

  return Buffer.byteLength(
    serialized,
    'utf8'
  );
}


function proposalMatchesCapability(
  proposal,
  producer,
  capability
) {
  return (
    capability.coreId ===
      producer.coreId &&
    capability.signalClass ===
      proposal.signal_class &&
    selectorMatches(
      capability.selector,
      proposal.topic
    ) &&
    capability.schemaVersions.includes(
      proposal.schema_version
    ) &&
    capability.producerStreamIds.includes(
      proposal.producer_stream_id
    ) &&
    capability.allowedAuthorityModes.includes(
      producer.authorityMode
    )
  );
}


function envelopeMatchesRoute(
  envelope,
  route
) {
  return (
    route.consumerCoreId &&
    route.acceptedProducerCoreIds.includes(
      envelope.producer_core_id
    ) &&
    route.producerStreamIds.includes(
      envelope.producer_stream_id
    ) &&
    selectorMatches(
      route.selector,
      envelope.topic
    ) &&
    route.signalClass ===
      envelope.signal_class &&
    route.schemaVersions.includes(
      envelope.schema_version
    ) &&
    (
      DURABILITY_RANK.get(
        envelope.durability_class
      ) || 0
    ) >=
      (
        DURABILITY_RANK.get(
          route.requiredDurability
        ) || Number.MAX_SAFE_INTEGER
      ) &&
    envelope.authority_epoch >=
      route.activeAuthorityEpochRange.minimum &&
    envelope.authority_epoch <=
      route.activeAuthorityEpochRange.maximum
  );
}


function canonicalDeliveryOrder(
  envelopes
) {
  if (!Array.isArray(envelopes)) {
    fail(
      'canonical delivery ordering requires an envelope array',
      'BIOLOGICAL_BSF_ORDERING'
    );
  }

  const seen =
    new Set();

  const ordered =
    [...envelopes];

  for (
    const envelope of
      ordered
  ) {
    if (
      !envelope ||
      typeof envelope.signal_id !== 'string' ||
      !Number.isSafeInteger(
        envelope.order_time_us
      ) ||
      !Number.isSafeInteger(
        envelope.fabric_sequence
      )
    ) {
      fail(
        'canonical delivery ordering received an invalid accepted envelope',
        'BIOLOGICAL_BSF_ORDERING'
      );
    }

    if (
      seen.has(
        envelope.signal_id
      )
    ) {
      fail(
        'canonical delivery ordering received duplicate signal identity',
        'BIOLOGICAL_BSF_ORDERING'
      );
    }

    seen.add(
      envelope.signal_id
    );
  }

  ordered.sort(
    (left, right) =>
      left.order_time_us -
        right.order_time_us ||
      left.fabric_sequence -
        right.fabric_sequence
  );

  return Object.freeze(
    ordered
  );
}


function makeDecision({
  status,
  reason = null,
  route = null,
  envelope,
  effectEligible = false,
  effectiveValidFromUs = null,
  effectiveExpiresAtUs = null,
  deliveryMode,
  degraded = false
}) {
  return Object.freeze({
    protocol:
      BSF_PROTOCOL,

    status,
    reason,

    signalId:
      envelope.signal_id,

    producerCoreId:
      envelope.producer_core_id,

    producerStreamId:
      envelope.producer_stream_id,

    authorityEpoch:
      envelope.authority_epoch,

    authorityMode:
      envelope.authority_mode,

    routeId:
      route?.id || null,

    consumerCoreId:
      route?.consumerCoreId || null,

    evidenceRole:
      route?.evidenceRole || null,

    effectEligible:
      Boolean(effectEligible),

    effectiveValidFromUs,
    effectiveExpiresAtUs,
    deliveryMode,
    degraded:
      Boolean(degraded)
  });
}


class BiologicalSignallingFabric {
  constructor({
    stateStore = null,
    observerCapacity = 128
  } = {}) {
    const capacity =
      boundedInteger(
        observerCapacity,
        'observerCapacity',
        {
          minimum: 1,
          maximum:
            MAX_OBSERVER_CAPACITY
        }
      );

    this.stateStore =
      stateStore;

    this.manifests =
      new Map();

    this.producerCapabilities =
      new Map();

    this.consumerRoutes =
      new Map();

    this.rateBuckets =
      new Map();

    this.observerCapacity =
      capacity;

    this.observerQueue =
      [];

    this.observers =
      new Set();

    this.observerFlushScheduled =
      false;

    this.counters = {
      proposalsValidated:
        0,

      proposalsRejected:
        0,

      deliveriesEvaluated:
        0,

      deliveriesAllowed:
        0,

      effectEligible:
        0,

      observerOnly:
        0,

      liveClipped:
        0,

      expiredLive:
        0,

      replayBehindCommit:
        0,

      rateLimited:
        0,

      routeRejected:
        0,

      lagDegraded:
        0,

      observerDropped:
        0,

      observerErrors:
        0
    };
  }


  installManifest(
    manifest
  ) {
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      typeof manifest.coreId !==
        'string'
    ) {
      fail(
        'validated core manifest is required',
        'BIOLOGICAL_BSF_MANIFEST'
      );
    }

    const candidateBiology =
      manifest.biology;

    const alreadyNormalized =
      candidateBiology &&
      candidateBiology.protocol ===
        BSF_PROTOCOL &&
      Array.isArray(
        candidateBiology.producerCapabilities
      ) &&
      Array.isArray(
        candidateBiology.consumerRouteLeases
      ) &&
      candidateBiology.producerCapabilities.every(
        entry =>
          entry &&
          entry.coreId ===
            manifest.coreId &&
          entry.selector &&
          typeof entry.selector.type ===
            'string'
      ) &&
      candidateBiology.consumerRouteLeases.every(
        entry =>
          entry &&
          entry.consumerCoreId ===
            manifest.coreId &&
          entry.selector &&
          typeof entry.selector.type ===
            'string'
      );

    const biology =
      candidateBiology == null
        ? null
        : alreadyNormalized
          ? candidateBiology
          : normalizeBiologyManifest(
              candidateBiology,
              manifest.coreId
            );

    if (!biology) {
      this.uninstallCore(
        manifest.coreId
      );

      return null;
    }

    this.uninstallCore(
      manifest.coreId
    );

    this.manifests.set(
      manifest.coreId,
      biology
    );

    this.producerCapabilities.set(
      manifest.coreId,
      biology.producerCapabilities
    );

    this.consumerRoutes.set(
      manifest.coreId,
      biology.consumerRouteLeases
    );

    return biology;
  }


  uninstallCore(
    coreId
  ) {
    this.manifests.delete(
      coreId
    );

    this.producerCapabilities.delete(
      coreId
    );

    this.consumerRoutes.delete(
      coreId
    );

    for (
      const key of
        [...this.rateBuckets.keys()]
    ) {
      if (
        key.startsWith(
          `${coreId}:`
        )
      ) {
        this.rateBuckets.delete(
          key
        );
      }
    }
  }


  getManifest(
    coreId
  ) {
    return this.manifests.get(
      coreId
    ) || null;
  }


  findCapability({
    producer,
    proposal
  }) {
    const capabilities =
      this.producerCapabilities.get(
        producer.coreId
      ) || [];

    const matching =
      capabilities.filter(
        capability =>
          proposalMatchesCapability(
            proposal,
            producer,
            capability
          )
      );

    if (
      matching.length !== 1
    ) {
      fail(
        matching.length > 1
          ? 'biological producer proposal matched ambiguous capabilities'
          : 'biological producer proposal has no manifested capability',
        matching.length > 1
          ? 'BIOLOGICAL_BSF_AMBIGUOUS_CAPABILITY'
          : 'BIOLOGICAL_BSF_CAPABILITY'
      );
    }

    return matching[0];
  }


  validateProposal({
    producer,
    proposal
  }) {
    try {
      if (
        !producer ||
        typeof producer !== 'object' ||
        typeof producer.coreId !==
          'string' ||
        !producer.coreId ||
        !proposal ||
        typeof proposal !== 'object' ||
        Array.isArray(proposal)
      ) {
        fail(
          'BSF proposal validation context is invalid',
          'BIOLOGICAL_BSF_PROPOSAL'
        );
      }

      const capability =
        this.findCapability({
          producer,
          proposal
        });

      const bytes =
        payloadBytes(
          proposal.payload
        );

      if (
        bytes >
          capability.maxPayloadBytes
      ) {
        fail(
          'biological payload exceeds manifested capability bound',
          'BIOLOGICAL_BSF_PAYLOAD'
        );
      }

      const validFrom =
        proposal.valid_from_us == null
          ? null
          : Number(
              proposal.valid_from_us
            );

      const expiresAt =
        proposal.expires_at_us == null
          ? null
          : Number(
              proposal.expires_at_us
            );

      if (
        EXPIRING_SIGNAL_CLASSES.has(
          proposal.signal_class
        ) &&
        (
          !Number.isSafeInteger(
            validFrom
          ) ||
          !Number.isSafeInteger(
            expiresAt
          )
        )
      ) {
        fail(
          'external biological modulation must carry explicit validity bounds',
          'BIOLOGICAL_BSF_VALIDITY'
        );
      }

      if (
        capability.maxValidityUs != null &&
        validFrom != null &&
        expiresAt != null &&
        (
          !Number.isSafeInteger(
            validFrom
          ) ||
          !Number.isSafeInteger(
            expiresAt
          ) ||
          expiresAt < validFrom ||
          expiresAt - validFrom >
            capability.maxValidityUs
        )
      ) {
        fail(
          'biological validity exceeds manifested capability bound',
          'BIOLOGICAL_BSF_VALIDITY'
        );
      }

      this.counters.proposalsValidated +=
        1;

      this.enqueueObserver({
        type:
          'proposal.validated',

        coreId:
          producer.coreId,

        capabilityId:
          capability.id,

        topic:
          proposal.topic,

        authorityMode:
          producer.authorityMode
      });

      return Object.freeze({
        protocol:
          BSF_PROTOCOL,

        capabilityId:
          capability.id,

        maxPayloadBytes:
          capability.maxPayloadBytes,

        maxRate:
          capability.maxRate
      });
    } catch (error) {
      this.counters.proposalsRejected +=
        1;

      throw error;
    }
  }


  validateStreamProgress({
    producer,
    progress
  }) {
    if (
      !producer ||
      typeof producer.coreId !==
        'string' ||
      !progress ||
      typeof progress.producer_stream_id !==
        'string'
    ) {
      fail(
        'BSF stream progress validation context is invalid',
        'BIOLOGICAL_BSF_STREAM_PROGRESS'
      );
    }

    const capabilities =
      this.producerCapabilities.get(
        producer.coreId
      ) || [];

    const manifested =
      capabilities.some(
        capability =>
          capability.producerStreamIds.includes(
            progress.producer_stream_id
          ) &&
          capability.allowedAuthorityModes.includes(
            producer.authorityMode
          )
      );

    if (!manifested) {
      fail(
        'stream progress references an unmanifested biological producer stream',
        'BIOLOGICAL_BSF_STREAM_PROGRESS'
      );
    }

    return true;
  }


  resolveRoute({
    consumerCoreId,
    envelope
  }) {
    const routes =
      this.consumerRoutes.get(
        consumerCoreId
      ) || [];

    const matching =
      routes.filter(
        route =>
          envelopeMatchesRoute(
            envelope,
            route
          )
      );

    if (
      matching.length !== 1
    ) {
      return {
        route:
          null,

        ambiguous:
          matching.length > 1
      };
    }

    return {
      route:
        matching[0],

      ambiguous:
        false
    };
  }


  consumeRateBudget(
    capability,
    envelope,
    nowUs
  ) {
    const windowIndex =
      Math.floor(
        nowUs /
        capability.maxRate.intervalUs
      );

    const key =
      `${capability.coreId}:${capability.id}:${envelope.authority_mode}`;

    let bucket =
      this.rateBuckets.get(key);

    if (
      !bucket ||
      bucket.windowIndex !==
        windowIndex
    ) {
      bucket = {
        windowIndex,
        count:
          0,
        signalIds:
          new Set()
      };

      this.rateBuckets.set(
        key,
        bucket
      );
    }

    if (
      bucket.signalIds.has(
        envelope.signal_id
      )
    ) {
      return true;
    }

    if (
      bucket.count >=
        capability.maxRate.events
    ) {
      return false;
    }

    bucket.count +=
      1;

    bucket.signalIds.add(
      envelope.signal_id
    );

    return true;
  }


  evaluateDelivery({
    consumerCoreId,
    envelope,
    nowUs,
    deliveryMode =
      DELIVERY_MODE.LIVE,
    committedThroughUs = null
  }) {
    this.counters.deliveriesEvaluated +=
      1;

    if (
      !Object.values(
        DELIVERY_MODE
      ).includes(
        deliveryMode
      )
    ) {
      fail(
        'BSF delivery mode is invalid',
        'BIOLOGICAL_BSF_DELIVERY'
      );
    }

    const now =
      Number(nowUs);

    if (
      !Number.isSafeInteger(now) ||
      now < 0
    ) {
      fail(
        'BSF delivery requires trusted integer nowUs',
        'BIOLOGICAL_BSF_DELIVERY'
      );
    }

    const {
      route,
      ambiguous
    } =
      this.resolveRoute({
        consumerCoreId,
        envelope
      });

    if (
      ambiguous ||
      !route
    ) {
      this.counters.routeRejected +=
        1;

      return makeDecision({
        status:
          DELIVERY_STATUS.REJECTED,

        reason:
          ambiguous
            ? 'AMBIGUOUS_ROUTE'
            : 'NO_ROUTE',

        envelope,
        deliveryMode
      });
    }

    const capability =
      this.findCapability({
        producer: {
          coreId:
            envelope.producer_core_id,

          authorityMode:
            envelope.authority_mode
        },

        proposal: {
          topic:
            envelope.topic,

          signal_class:
            envelope.signal_class,

          schema_version:
            envelope.schema_version,

          producer_stream_id:
            envelope.producer_stream_id
        }
      });

    if (
      !this.consumeRateBudget(
        capability,
        envelope,
        now
      )
    ) {
      this.counters.rateLimited +=
        1;

      return makeDecision({
        status:
          DELIVERY_STATUS.RATE_LIMITED,

        reason:
          'PRODUCER_RATE_LIMIT',

        route,
        envelope,
        deliveryMode,
        degraded:
          true
      });
    }

    const lag =
      Math.max(
        0,
        now -
          Number(
            envelope.accepted_time_us ||
            envelope.order_time_us ||
            now
          )
      );

    if (
      lag >
        route.lagBudgetUs
    ) {
      this.counters.lagDegraded +=
        1;

      return makeDecision({
        status:
          DELIVERY_STATUS.DEGRADED,

        reason:
          'ROUTE_LAG_BUDGET_EXCEEDED',

        route,
        envelope,
        deliveryMode,
        degraded:
          true
      });
    }

    const authoritativeEffect =
      envelope.authority_mode ===
        AUTHORITY_MODE.AUTHORITATIVE &&
      route.evidenceRole !==
        EVIDENCE_ROLE.OBSERVER_ONLY;

    let effectiveValidFromUs =
      envelope.valid_from_us;

    const effectiveExpiresAtUs =
      envelope.expires_at_us;

    if (
      deliveryMode ===
        DELIVERY_MODE.LIVE
    ) {
      if (
        effectiveExpiresAtUs != null &&
        now >
          effectiveExpiresAtUs
      ) {
        this.counters.expiredLive +=
          1;

        return makeDecision({
          status:
            DELIVERY_STATUS.REJECTED,

          reason:
            'EXPIRED_LIVE_INFLUENCE',

          route,
          envelope,
          deliveryMode,
          effectiveValidFromUs,
          effectiveExpiresAtUs
        });
      }

      if (
        effectiveValidFromUs != null &&
        now >
          effectiveValidFromUs
      ) {
        effectiveValidFromUs =
          now;

        this.counters.liveClipped +=
          1;
      }
    } else {
      const committed =
        Number(
          committedThroughUs
        );

      if (
        !Number.isSafeInteger(
          committed
        ) ||
        committed < 0
      ) {
        fail(
          'recovery replay requires committedThroughUs',
          'BIOLOGICAL_BSF_REPLAY'
        );
      }

      if (
        effectiveValidFromUs != null &&
        effectiveExpiresAtUs != null
      ) {
        if (
          effectiveExpiresAtUs <=
            committed
        ) {
          this.counters.replayBehindCommit +=
            1;

          return makeDecision({
            status:
              DELIVERY_STATUS.REJECTED,

            reason:
              'REPLAY_BEHIND_COMMITTED_FRONTIER',

            route,
            envelope,
            deliveryMode,
            effectiveValidFromUs,
            effectiveExpiresAtUs
          });
        }

        effectiveValidFromUs =
          Math.max(
            effectiveValidFromUs,
            committed + 1
          );
      } else if (
        envelope.order_time_us <=
          committed
      ) {
        this.counters.replayBehindCommit +=
          1;

        return makeDecision({
          status:
            DELIVERY_STATUS.REJECTED,

          reason:
            'REPLAY_BEHIND_COMMITTED_FRONTIER',

          route,
          envelope,
          deliveryMode,
          effectiveValidFromUs,
          effectiveExpiresAtUs
        });
      }
    }

    const observerOnly =
      route.evidenceRole ===
        EVIDENCE_ROLE.OBSERVER_ONLY;

    const clipped =
      effectiveValidFromUs !==
        envelope.valid_from_us;

    const status =
      observerOnly
        ? DELIVERY_STATUS.OBSERVE_ONLY
        : clipped
          ? DELIVERY_STATUS.DELIVER_CLIPPED
          : DELIVERY_STATUS.DELIVER;

    if (observerOnly) {
      this.counters.observerOnly +=
        1;
    } else {
      this.counters.deliveriesAllowed +=
        1;
    }

    if (authoritativeEffect) {
      this.counters.effectEligible +=
        1;
    }

    const decision =
      makeDecision({
        status,
        route,
        envelope,
        effectEligible:
          authoritativeEffect,
        effectiveValidFromUs,
        effectiveExpiresAtUs,
        deliveryMode
      });

    this.enqueueObserver({
      type:
        'delivery.decision',

      status:
        decision.status,

      signalId:
        decision.signalId,

      routeId:
        decision.routeId,

      effectEligible:
        decision.effectEligible
    });

    return decision;
  }


  bindRequiredRoutes({
    consumerCoreId,
    consumerId,
    organismId,
    authorityEpochByProducer,
    activeFromUs = 0,
    reason =
      'bsf.manifest.bound'
  }) {
    if (
      !this.stateStore ||
      typeof this.stateStore
        .registerBiologicalRoute !==
        'function'
    ) {
      fail(
        'BSF route binding requires a StateStore route registry',
        'BIOLOGICAL_BSF_ROUTE_BINDING'
      );
    }

    const routes =
      this.consumerRoutes.get(
        consumerCoreId
      ) || [];

    const bound =
      [];

    for (
      const route of routes
    ) {
      for (
        const producerCoreId of
          route.acceptedProducerCoreIds
      ) {
        const epoch =
          Number(
            authorityEpochByProducer?.[
              producerCoreId
            ]
          );

        if (
          !Number.isSafeInteger(
            epoch
          ) ||
          epoch <
            route.activeAuthorityEpochRange.minimum ||
          epoch >
            route.activeAuthorityEpochRange.maximum
        ) {
          fail(
            `route ${route.id} has no eligible producer authority epoch`,
            'BIOLOGICAL_BSF_ROUTE_BINDING'
          );
        }

        for (
          const producerStreamId of
            route.producerStreamIds
        ) {
          const suffix =
            Buffer.from(
              `${producerCoreId}\n${producerStreamId}`,
              'utf8'
            )
              .toString('base64url')
              .slice(0, 40);

          bound.push(
            this.stateStore
              .registerBiologicalRoute({
                routeId:
                  `bsf:${route.id}:${suffix}`,

                organismId,
                consumerId,
                producerCoreId,
                producerStreamId,
                authorityEpoch:
                  epoch,
                required:
                  route.required,
                activeFromUs,
                reason
              })
          );
        }
      }
    }

    return Object.freeze(
      bound
    );
  }


  evaluateCompleteness({
    consumerId
  }) {
    if (
      !this.stateStore ||
      typeof this.stateStore
        .computeBiologicalSafeCompletenessFrontier !==
        'function'
    ) {
      fail(
        'BSF completeness requires StateStore route progress',
        'BIOLOGICAL_BSF_COMPLETENESS'
      );
    }

    return this.stateStore
      .computeBiologicalSafeCompletenessFrontier({
        consumerId
      });
  }


  subscribeObserver(
    handler
  ) {
    if (
      typeof handler !==
        'function'
    ) {
      fail(
        'BSF observer handler must be a function',
        'BIOLOGICAL_BSF_OBSERVER'
      );
    }

    this.observers.add(
      handler
    );

    return () => {
      this.observers.delete(
        handler
      );
    };
  }


  enqueueObserver(
    record
  ) {
    const frozen =
      Object.freeze({
        protocol:
          BSF_PROTOCOL,

        ...record
      });

    if (
      this.observerQueue.length >=
        this.observerCapacity
    ) {
      this.counters.observerDropped +=
        1;

      return false;
    }

    this.observerQueue.push(
      frozen
    );

    if (
      !this.observerFlushScheduled
    ) {
      this.observerFlushScheduled =
        true;

      queueMicrotask(
        () =>
          this.flushObservers()
      );
    }

    return true;
  }


  flushObservers() {
    this.observerFlushScheduled =
      false;

    const batch =
      this.observerQueue.splice(
        0,
        this.observerCapacity
      );

    for (
      const record of
        batch
    ) {
      for (
        const handler of
          this.observers
      ) {
        try {
          const result =
            handler(record);

          if (
            result &&
            typeof result.then ===
              'function'
          ) {
            result.catch(
              () => {
                this.counters.observerErrors +=
                  1;
              }
            );
          }
        } catch {
          this.counters.observerErrors +=
            1;
        }
      }
    }

    if (
      this.observerQueue.length > 0 &&
      !this.observerFlushScheduled
    ) {
      this.observerFlushScheduled =
        true;

      queueMicrotask(
        () =>
          this.flushObservers()
      );
    }
  }


  telemetry() {
    return Object.freeze({
      protocol:
        BSF_PROTOCOL,

      ...this.counters,

      installedCoreCount:
        this.manifests.size,

      producerCapabilityCount:
        [...this.producerCapabilities.values()]
          .reduce(
            (sum, entries) =>
              sum + entries.length,
            0
          ),

      consumerRouteCount:
        [...this.consumerRoutes.values()]
          .reduce(
            (sum, entries) =>
              sum + entries.length,
            0
          ),

      rateBucketCount:
        this.rateBuckets.size,

      observerQueueDepth:
        this.observerQueue.length,

      observerCount:
        this.observers.size
    });
  }
}


module.exports = {
  BSF_PROTOCOL,
  EVIDENCE_ROLE,
  REQUIRED_ORDERING,
  DELIVERY_MODE,
  DELIVERY_STATUS,
  normalizeBiologyManifest,
  canonicalDeliveryOrder,
  BiologicalSignallingFabric
};
