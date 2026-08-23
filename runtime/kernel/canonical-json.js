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
