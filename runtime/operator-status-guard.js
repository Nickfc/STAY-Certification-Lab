'use strict';

const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');

const STATUS_PATH = '/runtime/status';
const PATCH_MARKER = Symbol.for('stay.operator-status-guard.v1');
const MIN_TOKEN_BYTES = 32;
const MAX_TOKEN_BYTES = 512;

function readCredentialDigest(filePath) {
  if (!filePath) return { available: false, reason: 'not-configured', digest: null };
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const token = raw.trim();
    const bytes = Buffer.byteLength(token, 'utf8');
    if (bytes < MIN_TOKEN_BYTES || bytes > MAX_TOKEN_BYTES || /\s/.test(token)) {
      return { available: false, reason: 'invalid-credential', digest: null };
    }
    return {
      available: true,
      reason: null,
      digest: crypto.createHash('sha256').update(token, 'utf8').digest()
    };
  } catch {
    return { available: false, reason: 'unreadable-credential', digest: null };
  }
}

function presentedBearer(req) {
  const header = req && req.headers ? req.headers.authorization : null;
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match ? match[1] : null;
}

function bearerMatches(expectedDigest, presented) {
  if (!Buffer.isBuffer(expectedDigest) || expectedDigest.length !== 32 || typeof presented !== 'string') return false;
  const candidate = crypto.createHash('sha256').update(presented, 'utf8').digest();
  return crypto.timingSafeEqual(expectedDigest, candidate);
}

function sendJson(res, statusCode, payload, authenticate = false) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('pragma', 'no-cache');
  if (authenticate) res.setHeader('www-authenticate', 'Bearer realm="stay-operator"');
  res.end(JSON.stringify(payload));
}

function createOperatorStatusGuard(options = {}) {
  const credential = options.credential || readCredentialDigest(options.tokenFile || process.env.STAY_OPERATOR_STATUS_TOKEN_FILE);
  return function guardOperatorStatus(req, res) {
    const pathname = String(req && req.url || '').split('?')[0];
    if (pathname !== STATUS_PATH) return false;

    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return true;
    }

    if (!credential.available) {
      sendJson(res, 503, { ok: false, error: 'operator credential unavailable' });
      return true;
    }

    const presented = presentedBearer(req);
    if (!bearerMatches(credential.digest, presented)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' }, true);
      return true;
    }

    res.setHeader('cache-control', 'no-store');
    res.setHeader('pragma', 'no-cache');
    return false;
  };
}

function installOperatorStatusGuard(options = {}) {
  if (http.Server.prototype[PATCH_MARKER]) return http.Server.prototype[PATCH_MARKER];
  const guard = createOperatorStatusGuard(options);
  const originalEmit = http.Server.prototype.emit;

  Object.defineProperty(http.Server.prototype, PATCH_MARKER, {
    value: { installed: true, statusPath: STATUS_PATH },
    configurable: false,
    enumerable: false,
    writable: false
  });

  http.Server.prototype.emit = function guardedServerEmit(event, ...args) {
    if (event === 'request' && guard(args[0], args[1])) return true;
    return originalEmit.call(this, event, ...args);
  };

  return http.Server.prototype[PATCH_MARKER];
}

module.exports = {
  STATUS_PATH,
  readCredentialDigest,
  bearerMatches,
  createOperatorStatusGuard,
  installOperatorStatusGuard
};
