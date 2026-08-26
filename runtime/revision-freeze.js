'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FORMAT = 'stay-runtime-revision-freeze-v1';
const DEFAULT_DIRECTORY = '/var/lib/stay/evidence/runtime-freezes';
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return 'sha256:' + crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function normalizeRevision(revision) {
  const value = Number(revision);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function labelForRevision(revision, frozen = false) {
  const value = normalizeRevision(revision);
  return value == null ? 'R?' : `R${value}${frozen ? 'F' : ''}`;
}

function sealRevisionFreeze(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('revision freeze body is invalid'), { code: 'REVISION_FREEZE_BODY' });
  }
  if (Object.prototype.hasOwnProperty.call(body, 'recordSha256')) {
    throw Object.assign(new Error('revision freeze body already contains a digest'), { code: 'REVISION_FREEZE_DIGEST_PRESENT' });
  }
  return { ...body, recordSha256: digest(body) };
}

function validateRevisionFreeze(record, expectedRevision) {
  const revision = normalizeRevision(expectedRevision);
  if (revision == null || !record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (record.format !== FORMAT || record.result !== 'PASS' || record.acceptance !== 'ACCEPTED') return false;
  if (typeof record.freezeType !== 'string' || !record.freezeType.length) return false;
  if (record.runtime?.revision !== revision || record.runtime?.revisionLabel !== labelForRevision(revision, true)) return false;
  if (!SHA256.test(String(record.recordSha256 || ''))) return false;
  const { recordSha256, ...body } = record;
  return digest(body) === recordSha256;
}

function freezeFileForRevision(revision, directory = process.env.STAY_RUNTIME_FREEZE_DIR || DEFAULT_DIRECTORY) {
  const value = normalizeRevision(revision);
  if (value == null) return null;
  return path.join(path.resolve(directory), `R${value}.json`);
}

function readRevisionFreeze(revision, options = {}) {
  const value = normalizeRevision(revision);
  const unfrozen = {
    frozen: false,
    revision: value,
    label: labelForRevision(value, false),
    recordSha256: null
  };
  if (value == null) return unfrozen;
  const file = freezeFileForRevision(value, options.directory);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) return unfrozen;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!validateRevisionFreeze(record, value)) return unfrozen;
    return {
      frozen: true,
      revision: value,
      label: labelForRevision(value, true),
      recordSha256: record.recordSha256
    };
  } catch {
    return unfrozen;
  }
}

module.exports = {
  DEFAULT_DIRECTORY,
  FORMAT,
  digest,
  freezeFileForRevision,
  labelForRevision,
  readRevisionFreeze,
  sealRevisionFreeze,
  stableStringify,
  validateRevisionFreeze
};
