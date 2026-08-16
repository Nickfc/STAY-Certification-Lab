'use strict';

const net = require('node:net');
const path = require('node:path');
const { verifySegmentManifest } = require('./sntss-observability');

const DEFAULT_SOCKET_PATH = '/run/stay-forensic-anchor/anchor.sock';
const MAX_MESSAGE_BYTES = 4096;

function fail(message, code = 'SNTSS_EXTERNAL_ANCHOR_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function assertExternalAnchorSocketPath(socketPath, dataDir = '/var/lib/stay/data') {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) fail('forensic anchor socket path must be absolute');
  const resolved = path.resolve(socketPath);
  const state = path.resolve(dataDir);
  if (resolved === state || resolved.startsWith(state + path.sep)) fail('forensic anchor socket cannot live inside the StateStore');
  if (resolved === '/opt/stay' || resolved.startsWith('/opt/stay/')) fail('forensic anchor socket cannot live inside mutable release paths');
  return resolved;
}

function createUnixForensicAnchorSink({ socketPath = DEFAULT_SOCKET_PATH, timeoutMs = 1000, dataDir = '/var/lib/stay/data' } = {}) {
  const target = assertExternalAnchorSocketPath(socketPath, dataDir);
  const timeout = Math.max(100, Math.min(10000, Number(timeoutMs) || 1000));

  return function externalAnchorSink(manifest) {
    if (!verifySegmentManifest(manifest)) return Promise.reject(Object.assign(new Error('forensic segment manifest is invalid'), { code: 'SNTSS_EXTERNAL_ANCHOR_MANIFEST' }));
    const message = JSON.stringify(manifest) + '\n';
    if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) return Promise.reject(Object.assign(new Error('forensic anchor message exceeds bound'), { code: 'SNTSS_EXTERNAL_ANCHOR_BOUND' }));

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(target);
      let settled = false;
      let response = '';
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      socket.setTimeout(timeout, () => finish(Object.assign(new Error('forensic anchor acknowledgement timed out'), { code: 'SNTSS_EXTERNAL_ANCHOR_TIMEOUT' })));
      socket.once('error', error => finish(Object.assign(error, { code: error.code || 'SNTSS_EXTERNAL_ANCHOR_IO' })));
      socket.once('connect', () => socket.write(message));
      socket.on('data', chunk => {
        response += String(chunk);
        if (Buffer.byteLength(response) > MAX_MESSAGE_BYTES) return finish(Object.assign(new Error('forensic anchor response exceeds bound'), { code: 'SNTSS_EXTERNAL_ANCHOR_BOUND' }));
        const newline = response.indexOf('\n');
        if (newline < 0) return;
        let ack;
        try { ack = JSON.parse(response.slice(0, newline)); }
        catch { return finish(Object.assign(new Error('forensic anchor acknowledgement is malformed'), { code: 'SNTSS_EXTERNAL_ANCHOR_ACK' })); }
        if (ack?.ok !== true || ack?.manifestHash !== manifest.manifestHash || typeof ack?.receiptHash !== 'string') {
          return finish(Object.assign(new Error('forensic anchor acknowledgement does not match manifest'), { code: 'SNTSS_EXTERNAL_ANCHOR_ACK' }));
        }
        finish(null, Object.freeze({ manifestHash: ack.manifestHash, receiptHash: ack.receiptHash, receiptSequence: Number(ack.receiptSequence) }));
      });
    });
  };
}

module.exports = {
  DEFAULT_SOCKET_PATH,
  MAX_MESSAGE_BYTES,
  assertExternalAnchorSocketPath,
  createUnixForensicAnchorSink
};
